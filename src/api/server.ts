import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { createCliContext, type CliContext } from "../cli/config.js";
import { parseJobSpec } from "../core/job-spec.js";
import { DuplicateJobError, JobBusyError, JobDisabledError, JobNotFoundError } from "../core/errors.js";
import { getOpenApiSpec } from "./openapi.js";
import type {
  ApiErrorResponse,
  ApiServerOptions,
  HealthResponse,
  StopRunResponse,
} from "./types.js";
import type { RunResult } from "../core/runner.js";
import { defaultMetrics } from "../core/metrics.js";

export interface RunningApiServer {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<RunningApiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const bearerToken = options.bearerToken;

  const ctx: CliContext = await createCliContext({
    dbUrl: options.dbUrl,
    schema: options.schema,
  });

  const startTime = Date.now();
  const activeRuns = new Map<string, { controller: AbortController; jobName: string }>();

  function sendJson(res: ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body, (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      return value;
    });
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    res.end(payload);
  }

  function sendError(res: ServerResponse, status: number, message: string, details?: unknown) {
    const errBody: ApiErrorResponse = { error: message, ...(details ? { details } : {}) };
    sendJson(res, status, errBody);
  }

  async function parseBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({} as T);
          return;
        }
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error("Malformed JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  function isAuthorized(req: IncomingMessage): boolean {
    if (!bearerToken) return true;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
    const provided = authHeader.slice(7).trim();
    if (provided.length !== bearerToken.length) return false;
    try {
      return timingSafeEqual(Buffer.from(provided), Buffer.from(bearerToken));
    } catch {
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const method = (req.method ?? "GET").toUpperCase();
      const pathname = url.pathname;

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        });
        res.end();
        return;
      }

      // Public endpoints
      if (pathname === "/health" && method === "GET") {
        try {
          await ctx.pool.query("SELECT 1");
          const health: HealthResponse = {
            status: "ok",
            database: "connected",
            version: "0.0.0",
            uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
          };
          sendJson(res, 200, health);
        } catch {
          const unhealthy: HealthResponse = {
            status: "error",
            database: "disconnected",
            version: "0.0.0",
            uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
          };
          sendJson(res, 503, unhealthy);
        }
        return;
      }

      if (pathname === "/openapi.json" && method === "GET") {
        sendJson(res, 200, getOpenApiSpec());
        return;
      }

      if (pathname === "/openapi.yaml" && method === "GET") {
        const yamlStr = stringifyYaml(getOpenApiSpec());
        res.writeHead(200, {
          "Content-Type": "application/yaml",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(yamlStr);
        return;
      }

      if (pathname === "/metrics" && method === "GET") {
        const prometheus = defaultMetrics.toPrometheus();
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(prometheus);
        return;
      }

      if (pathname === "/metrics.json" && method === "GET") {
        sendJson(res, 200, defaultMetrics.getSnapshot());
        return;
      }

      // Check Bearer Token Auth for protected endpoints
      if (!isAuthorized(req)) {
        sendError(res, 401, "Unauthorized: missing or invalid bearer token");
        return;
      }

      // 1. GET /jobs - list all jobs
      if (pathname === "/jobs" && method === "GET") {
        const jobs = await ctx.store.listJobs();
        sendJson(res, 200, jobs);
        return;
      }

      // 2. POST /jobs - create a job
      if (pathname === "/jobs" && method === "POST") {
        const body = await parseBody<{ spec: unknown }>(req);
        if (!body.spec) {
          sendError(res, 400, "Missing 'spec' in request body");
          return;
        }

        let parsedSpec;
        try {
          parsedSpec = parseJobSpec(body.spec);
        } catch (err: unknown) {
          sendError(res, 400, "Job specification schema validation failed", err);
          return;
        }

        try {
          const job = await ctx.store.createJob(parsedSpec);
          sendJson(res, 201, job);
        } catch (err) {
          if (err instanceof DuplicateJobError) {
            sendError(res, 409, err.message);
          } else {
            throw err;
          }
        }
        return;
      }

      // Match /jobs/:idOrName routes
      const jobRouteMatch = pathname.match(/^\/jobs\/([^/]+)$/);
      if (jobRouteMatch) {
        const idOrName = decodeURIComponent(jobRouteMatch[1]!);

        if (method === "GET") {
          const job = await ctx.store.getJobByIdOrName(idOrName);
          if (!job) {
            sendError(res, 404, `Job '${idOrName}' not found`);
            return;
          }
          sendJson(res, 200, job);
          return;
        }

        if (method === "PUT") {
          const body = await parseBody<{ spec: unknown }>(req);
          if (!body.spec) {
            sendError(res, 400, "Missing 'spec' in request body");
            return;
          }

          let parsedSpec;
          try {
            parsedSpec = parseJobSpec(body.spec);
          } catch (err) {
            sendError(res, 400, "Job specification schema validation failed", err);
            return;
          }

          const upserted = await ctx.store.upsertJob(parsedSpec);
          sendJson(res, 200, upserted.job);
          return;
        }

        if (method === "DELETE") {
          const deleted = await ctx.store.deleteJob(idOrName);
          if (!deleted) {
            sendError(res, 404, `Job '${idOrName}' not found`);
            return;
          }
          res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
          res.end();
          return;
        }
      }

      // Match /jobs/:idOrName/runs
      const jobRunsMatch = pathname.match(/^\/jobs\/([^/]+)\/runs$/);
      if (jobRunsMatch) {
        const idOrName = decodeURIComponent(jobRunsMatch[1]!);
        const job = await ctx.store.getJobByIdOrName(idOrName);
        if (!job) {
          sendError(res, 404, `Job '${idOrName}' not found`);
          return;
        }

        if (method === "GET") {
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam ? Number(limitParam) : 50;
          const runs = await ctx.store.listRuns(job.id, limit);
          sendJson(res, 200, runs);
          return;
        }

        if (method === "POST") {
          const body = await parseBody<{
            trigger?: "manual" | "schedule" | "retry";
            dryRun?: boolean;
            maxRecords?: number;
            queued?: boolean;
          }>(req);

          const trigger = body.trigger ?? "manual";
          const dryRun = body.dryRun ?? false;
          const maxRecords = body.maxRecords;

          if (body.queued) {
            // Queue as pending run
            const pendingRun = await ctx.store.createRun(job.id, null, {
              trigger,
              dryRun,
              state: "pending",
            });
            sendJson(res, 202, pendingRun);
            return;
          }

          // Execute run
          const controller = new AbortController();
          try {
            const runPromise = ctx.runner.run(job.name, {
              trigger,
              dryRun,
              maxRecords,
              signal: controller.signal,
            });

            // Store active controller once run starts
            // We wait for the run to complete in default HTTP request cycle
            defaultMetrics.recordRunStarted();
            const startTime = Date.now();
            const result: RunResult = await runPromise;
            const durationMs = Date.now() - startTime;
            defaultMetrics.recordRunFinished(
              result.state === "partial" ? "failed" : (result.state as "succeeded" | "failed" | "interrupted" | "cancelled"),
            );
            defaultMetrics.recordRunMetrics(job.name, {
              discovered: result.counters.discovered,
              processed: result.counters.processed,
              succeeded: result.counters.succeeded,
              unchanged: result.counters.unchanged,
              failed: result.counters.failed,
              durationMs,
              runState: result.state,
            });
            sendJson(res, 200, result);
          } catch (err) {
            if (err instanceof JobNotFoundError) sendError(res, 404, err.message);
            else if (err instanceof JobDisabledError) sendError(res, 400, err.message);
            else if (err instanceof JobBusyError) sendError(res, 409, err.message);
            else throw err;
          }
          return;
        }
      }

      // Match /runs/:id
      const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
      if (runMatch && method === "GET") {
        const runId = decodeURIComponent(runMatch[1]!);
        const run = await ctx.store.getRun(runId);
        if (!run) {
          sendError(res, 404, `Run '${runId}' not found`);
          return;
        }
        sendJson(res, 200, run);
        return;
      }

      // Match /runs/:id/stop
      const stopRunMatch = pathname.match(/^\/runs\/([^/]+)\/stop$/);
      if (stopRunMatch && method === "POST") {
        const runId = decodeURIComponent(stopRunMatch[1]!);
        const active = activeRuns.get(runId);
        if (active) {
          active.controller.abort(new Error("Stopped via API"));
          const resp: StopRunResponse = {
            runId,
            stopped: true,
            message: "Cancellation signal delivered to active run worker",
          };
          sendJson(res, 200, resp);
        } else {
          // If not in activeRuns, check database run state
          const run = await ctx.store.getRun(runId);
          if (!run) {
            sendError(res, 404, `Run '${runId}' not found`);
            return;
          }
          if (run.state === "running") {
            // Interrupted directly in state store
            await ctx.store.finishRun(runId, "cancelled", run.counters, {
              kind: "cancelled",
              message: "Stopped by administrator via API",
            });
            sendJson(res, 200, { runId, stopped: true, message: "Run marked as cancelled in store" });
          } else {
            sendJson(res, 200, {
              runId,
              stopped: false,
              message: `Run is already in terminal state '${run.state}'`,
            });
          }
        }
        return;
      }

      // Match /runs/:id/events
      const runEventsMatch = pathname.match(/^\/runs\/([^/]+)\/events$/);
      if (runEventsMatch && method === "GET") {
        const runId = decodeURIComponent(runEventsMatch[1]!);
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 500;
        const events = await ctx.store.listEvents(runId, limit);
        sendJson(res, 200, events);
        return;
      }

      // Match /jobs/:idOrName/dead-letters
      const jobDeadLettersMatch = pathname.match(/^\/jobs\/([^/]+)\/dead-letters$/);
      if (jobDeadLettersMatch && method === "GET") {
        const idOrName = decodeURIComponent(jobDeadLettersMatch[1]!);
        const job = await ctx.store.getJobByIdOrName(idOrName);
        if (!job) {
          sendError(res, 404, `Job '${idOrName}' not found`);
          return;
        }

        const stateParam = url.searchParams.get("state") as "open" | "retrying" | "resolved" | null;
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 100;

        const dls = await ctx.store.listDeadLetters(job.id, {
          state: stateParam ?? undefined,
          limit,
        });
        sendJson(res, 200, dls);
        return;
      }

      // Match /dead-letters/:id
      const dlMatch = pathname.match(/^\/dead-letters\/([^/]+)$/);
      if (dlMatch && method === "GET") {
        const dlId = decodeURIComponent(dlMatch[1]!);
        const dl = await ctx.store.getDeadLetter(dlId);
        if (!dl) {
          sendError(res, 404, `Dead letter '${dlId}' not found`);
          return;
        }
        sendJson(res, 200, dl);
        return;
      }

      // Match /jobs/:idOrName/retry
      const retryMatch = pathname.match(/^\/jobs\/([^/]+)\/retry$/);
      if (retryMatch && method === "POST") {
        const idOrName = decodeURIComponent(retryMatch[1]!);
        const job = await ctx.store.getJobByIdOrName(idOrName);
        if (!job) {
          sendError(res, 404, `Job '${idOrName}' not found`);
          return;
        }

        const body = await parseBody<{ ids?: string[]; limit?: number }>(req);
        const retryResult = await ctx.runner.retry(job.name, {
          ids: body.ids,
          limit: body.limit,
        });
        sendJson(res, 200, retryResult);
        return;
      }

      sendError(res, 404, `Endpoint not found: ${method} ${pathname}`);
    } catch (err) {
      sendError(res, 500, `Internal server error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        host,
        close: async () => {
          await new Promise<void>((res) => server.close(() => res()));
          await ctx.close().catch(() => {});
        },
      });
    });
    server.on("error", reject);
  });
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<RunningApiServer> {
  return createApiServer(options);
}
