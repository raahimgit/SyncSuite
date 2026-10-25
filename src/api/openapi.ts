import { VERSION } from "../version.js";

export function getOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "SyncSuite API",
      version: VERSION,
      description:
        "HTTP API for managing and executing incremental data synchronization jobs in SyncSuite.",
    },
    servers: [
      {
        url: "/",
        description: "Current SyncSuite Daemon",
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Token",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            details: {},
          },
        },
        Health: {
          type: "object",
          required: ["status", "database", "version", "uptimeSeconds"],
          properties: {
            status: { type: "string", enum: ["ok", "error"] },
            database: { type: "string", enum: ["connected", "disconnected"] },
            version: { type: "string" },
            uptimeSeconds: { type: "number" },
          },
        },
        Job: {
          type: "object",
          required: ["id", "name", "spec", "specVersion", "enabled", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            spec: { type: "object" },
            specVersion: { type: "integer" },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Run: {
          type: "object",
          required: ["id", "jobId", "state", "trigger", "dryRun", "startedAt", "counters"],
          properties: {
            id: { type: "string", format: "uuid" },
            jobId: { type: "string", format: "uuid" },
            state: {
              type: "string",
              enum: ["pending", "running", "succeeded", "partial", "failed", "cancelled", "interrupted"],
            },
            trigger: { type: "string", enum: ["manual", "schedule", "retry"] },
            dryRun: { type: "boolean" },
            startedAt: { type: "string", format: "date-time" },
            finishedAt: { type: ["string", "null"], format: "date-time" },
            counters: { type: "object" },
            error: { type: ["object", "null"] },
          },
        },
        DeadLetter: {
          type: "object",
          required: ["id", "jobId", "recordKey", "payload", "errorKind", "error", "attempts", "state", "firstFailedAt", "lastAttemptAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            jobId: { type: "string", format: "uuid" },
            runId: { type: ["string", "null"], format: "uuid" },
            recordKey: { type: "string" },
            payload: {},
            errorKind: { type: "string" },
            error: {},
            attempts: { type: "integer" },
            state: { type: "string", enum: ["open", "retrying", "resolved"] },
            firstFailedAt: { type: "string", format: "date-time" },
            lastAttemptAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          summary: "Health Check",
          security: [],
          responses: {
            "200": {
              description: "Service is healthy",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
            },
            "503": {
              description: "Service or database is unhealthy",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
            },
          },
        },
      },
      "/metrics": {
        get: {
          summary: "Prometheus Metrics Endpoint",
          security: [],
          responses: {
            "200": {
              description: "Prometheus formatted metrics text",
              content: { "text/plain": {} },
            },
          },
        },
      },
      "/metrics.json": {
        get: {
          summary: "JSON Metrics Snapshot",
          security: [],
          responses: {
            "200": {
              description: "Structured snapshot of instance metrics and totals",
              content: { "application/json": {} },
            },
          },
        },
      },
      "/jobs": {
        get: {
          summary: "List all jobs",
          responses: {
            "200": {
              description: "Array of registered jobs",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Job" } },
                },
              },
            },
          },
        },
        post: {
          summary: "Create a new job",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["spec"], properties: { spec: { type: "object" } } },
              },
            },
          },
          responses: {
            "201": {
              description: "Job created successfully",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
            },
            "400": {
              description: "Invalid job specification",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "409": {
              description: "Duplicate job name",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/jobs/{idOrName}": {
        get: {
          summary: "Get job details by ID or Name",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Job details with checkpoint",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
            },
            "404": {
              description: "Job not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
        put: {
          summary: "Upsert or update job specification",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["spec"], properties: { spec: { type: "object" } } },
              },
            },
          },
          responses: {
            "200": {
              description: "Job updated successfully",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } },
            },
            "400": {
              description: "Invalid job specification",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
        delete: {
          summary: "Delete job by ID or Name",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "204": { description: "Job deleted" },
            "404": {
              description: "Job not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/jobs/{idOrName}/runs": {
        get: {
          summary: "List execution runs for a job",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50 } },
          ],
          responses: {
            "200": {
              description: "List of runs",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Run" } },
                },
              },
            },
          },
        },
        post: {
          summary: "Trigger a run for a job",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    trigger: { type: "string", enum: ["manual", "schedule", "retry"], default: "manual" },
                    dryRun: { type: "boolean", default: false },
                    maxRecords: { type: "integer" },
                    queued: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Run executed and completed",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } },
            },
            "202": {
              description: "Run queued (pending)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } },
            },
            "404": {
              description: "Job not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "409": {
              description: "Job already has an active run",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/runs/{id}": {
        get: {
          summary: "Get run by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "Run details",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } },
            },
            "404": {
              description: "Run not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/runs/{id}/stop": {
        post: {
          summary: "Stop an active run",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "Stop signal delivered",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["runId", "stopped", "message"],
                    properties: {
                      runId: { type: "string" },
                      stopped: { type: "boolean" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/runs/{id}/events": {
        get: {
          summary: "Get event logs for a run",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 500 } },
          ],
          responses: {
            "200": {
              description: "List of events",
              content: { "application/json": { schema: { type: "array", items: { type: "object" } } } },
            },
          },
        },
      },
      "/jobs/{idOrName}/dead-letters": {
        get: {
          summary: "List dead letters for a job",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
            { name: "state", in: "query", schema: { type: "string", enum: ["open", "retrying", "resolved"] } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
          ],
          responses: {
            "200": {
              description: "List of dead letters",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/DeadLetter" } },
                },
              },
            },
          },
        },
      },
      "/dead-letters/{id}": {
        get: {
          summary: "Get specific dead letter by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "Dead letter record",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DeadLetter" } } },
            },
            "404": {
              description: "Dead letter not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/jobs/{idOrName}/retry": {
        post: {
          summary: "Re-drive dead letters for a job",
          parameters: [{ name: "idOrName", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ids: { type: "array", items: { type: "string" } },
                    limit: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Re-drive summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["processed", "resolved", "failed"],
                    properties: {
                      processed: { type: "integer" },
                      resolved: { type: "integer" },
                      failed: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
