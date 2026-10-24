import pg from "pg";
import { SyncError } from "../core/types.js";
import type { Cursor, ReadBatch, SourceConnector, SourceRecord } from "../core/types.js";
import { resolveSecret } from "./secrets.js";
import { classifyPgError, quoteIdentifier } from "./sql-utils.js";
import { createPool } from "../db/pool.js";

export interface PostgresSourceConfig {
  connectionString: unknown;
  table: string;
  cursorColumn?: string;
  keyColumn?: string;
  columns?: string[];
  safetyLagMs?: number;
  where?: string;
}

function serializeCursorValue(val: unknown): string | number | boolean | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") return val;
  return JSON.stringify(val);
}

export class PostgresSource implements SourceConnector {
  readonly type = "postgres";
  private readonly config: PostgresSourceConfig;
  private readonly cursorCol: string;
  private readonly keyCol: string;
  private readonly safetyLagMs: number;
  private pool: pg.Pool | null = null;

  constructor(rawConfig: Record<string, unknown>) {
    if (!rawConfig.connectionString) {
      throw new SyncError("fatal", "postgres source: missing required 'connectionString'");
    }
    if (!rawConfig.table || typeof rawConfig.table !== "string") {
      throw new SyncError("fatal", "postgres source: missing required string 'table'");
    }

    this.config = rawConfig as unknown as PostgresSourceConfig;
    this.cursorCol = this.config.cursorColumn ?? "updated_at";
    this.keyCol = this.config.keyColumn ?? "id";
    this.safetyLagMs = typeof this.config.safetyLagMs === "number" ? this.config.safetyLagMs : 5000;
  }

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before open");
    }

    const connectionString = resolveSecret(this.config.connectionString, "connectionString");
    this.pool = createPool({
      config: connectionString,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });

    try {
      const client = await this.pool.connect();
      client.release();
    } catch (err) {
      await this.close();
      throw classifyPgError(err, "postgres source open");
    }
  }

  async readBatch(from: Cursor | null, limit: number, signal: AbortSignal): Promise<ReadBatch> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before readBatch");
    }
    if (!this.pool) {
      throw new SyncError("fatal", "postgres source: connector is not open");
    }

    const quotedTable = quoteIdentifier(this.config.table);
    const quotedCursor = quoteIdentifier(this.cursorCol);
    const quotedKey = quoteIdentifier(this.keyCol);

    let selectCols = "*";
    if (this.config.columns && this.config.columns.length > 0) {
      selectCols = this.config.columns.map(quoteIdentifier).join(", ");
    }

    // Keyset pagination using tuple comparison:
    // (cursorCol, keyCol) > ($cursor, $key)
    // combined with safety lag evaluated on database clock:
    // cursorCol <= (CURRENT_TIMESTAMP - ($lag * interval '1 millisecond'))
    const params: unknown[] = [this.safetyLagMs];
    let whereClause = `${quotedCursor} <= (CURRENT_TIMESTAMP - ($1 * interval '1 millisecond'))`;

    if (from && from.cursor !== undefined && from.key !== undefined) {
      params.push(from.cursor, from.key);
      const cursorIdx = params.length - 1;
      const keyIdx = params.length;
      whereClause = `(${quotedCursor}, ${quotedKey}) > ($${cursorIdx}, $${keyIdx}) AND ${whereClause}`;
    }

    if (this.config.where && this.config.where.trim()) {
      whereClause = `(${this.config.where.trim()}) AND (${whereClause})`;
    }

    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      SELECT ${selectCols}, ${quotedCursor}::text AS __syncsuite_cursor_raw
      FROM ${quotedTable}
      WHERE ${whereClause}
      ORDER BY ${quotedCursor} ASC, ${quotedKey} ASC
      LIMIT $${limitIdx}
    `;

    let rows: Record<string, unknown>[];
    try {
      const res = await this.pool.query({
        text: sql,
        values: params,
      });
      rows = res.rows;
    } catch (err) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("query cancelled by signal");
      }
      throw classifyPgError(err, "postgres source readBatch");
    }

    if (rows.length === 0) {
      return { records: [], nextCursor: null };
    }

    const records: SourceRecord[] = rows.map((row) => {
      const keyValue = row[this.keyCol];
      if (keyValue === undefined || keyValue === null) {
        throw new SyncError(
          "permanent",
          `postgres source: row missing key column '${this.keyCol}'`,
        );
      }
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== "__syncsuite_cursor_raw") {
          data[k] = v;
        }
      }
      return {
        key: String(keyValue),
        data,
      };
    });

    const lastRow = rows[rows.length - 1]!;
    const rawCursor = lastRow.__syncsuite_cursor_raw;
    const nextCursorVal = typeof rawCursor === "string" ? rawCursor : serializeCursorValue(lastRow[this.cursorCol]);
    const nextKeyVal = serializeCursorValue(lastRow[this.keyCol]);

    const nextCursor: Cursor = {
      cursor: nextCursorVal,
      key: nextKeyVal,
    };


    return { records, nextCursor };
  }

  async close(): Promise<void> {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.end().catch(() => {});
    }
  }
}
