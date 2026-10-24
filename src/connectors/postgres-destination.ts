import pg from "pg";
import { SyncError } from "../core/types.js";
import type { DestinationConnector, PlannedWrite, WriteRequest, WriteResult } from "../core/types.js";
import { resolveSecret } from "./secrets.js";
import { classifyPgError, quoteIdentifier } from "./sql-utils.js";
import { createPool } from "../db/pool.js";

export interface PostgresDestinationConfig {
  connectionString: unknown;
  table: string;
  keyColumn?: string | string[];
  autoCreateTable?: boolean;
}

export class PostgresDestination implements DestinationConnector {
  readonly type = "postgres";
  private readonly config: PostgresDestinationConfig;
  private readonly keyCols: string[];
  private readonly autoCreateTable: boolean;
  private pool: pg.Pool | null = null;

  constructor(rawConfig: Record<string, unknown>) {
    if (!rawConfig.connectionString) {
      throw new SyncError("fatal", "postgres destination: missing required 'connectionString'");
    }
    if (!rawConfig.table || typeof rawConfig.table !== "string") {
      throw new SyncError("fatal", "postgres destination: missing required string 'table'");
    }

    this.config = rawConfig as unknown as PostgresDestinationConfig;
    const rawKey = this.config.keyColumn ?? "id";
    this.keyCols = Array.isArray(rawKey) ? rawKey : [rawKey];
    if (this.keyCols.length === 0) {
      throw new SyncError("fatal", "postgres destination: keyColumn cannot be empty");
    }
    this.autoCreateTable = (rawConfig.autoCreateTable as boolean | undefined) ?? true;
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
      throw classifyPgError(err, "postgres destination open");
    }
  }

  async write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before write");
    }
    if (!this.pool) {
      throw new SyncError("fatal", "postgres destination: connector is not open");
    }

    const data = req.data;
    const cols = Object.keys(data);
    if (cols.length === 0) {
      return { status: "unchanged" };
    }

    const quotedTable = quoteIdentifier(this.config.table);
    // For the WHERE clause of ON CONFLICT DO UPDATE, PostgreSQL only accepts the
    // unqualified table name — a schema-qualified reference like "schema"."table" is rejected.
    const unqualifiedTableName = this.config.table.split(".").at(-1)!;
    const quotedTableAlias = `"${unqualifiedTableName}"`;
    const quotedCols = cols.map(quoteIdentifier);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => data[c]);

    const quotedConflictTarget = this.keyCols.map(quoteIdentifier).join(", ");
    const updateCols = cols.filter((c) => !this.keyCols.includes(c));

    let sql: string;
    if (updateCols.length > 0) {
      const updateSet = updateCols
        .map((c) => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`)
        .join(", ");
      sql = `
        INSERT INTO ${quotedTable} (${quotedCols.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT (${quotedConflictTarget}) DO UPDATE
        SET ${updateSet}
        WHERE ${quotedTableAlias} IS DISTINCT FROM EXCLUDED
      `;
    } else {
      sql = `
        INSERT INTO ${quotedTable} (${quotedCols.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT (${quotedConflictTarget}) DO NOTHING
      `;
    }

    try {
      const res = await this.pool.query({
        text: sql,
        values,
      });

      // rowCount is 1 if inserted or updated; 0 if unchanged (IS DISTINCT FROM matched nothing)
      return (res.rowCount ?? 0) > 0 ? { status: "written" } : { status: "unchanged" };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === "42P01" && this.autoCreateTable) {
        await this.ensureDestinationTable(quotedTable, cols, data);
        const retryRes = await this.pool.query({ text: sql, values });
        return (retryRes.rowCount ?? 0) > 0 ? { status: "written" } : { status: "unchanged" };
      }
      if (pgErr?.code === "42703" && this.autoCreateTable) {
        await this.ensureDestinationColumns(quotedTable, cols, data);
        const retryRes = await this.pool.query({ text: sql, values });
        return (retryRes.rowCount ?? 0) > 0 ? { status: "written" } : { status: "unchanged" };
      }
      if (signal.aborted) {
        throw signal.reason ?? new Error("write cancelled by signal");
      }
      throw classifyPgError(err, "postgres destination write");
    }
  }

  async plan(req: WriteRequest, signal: AbortSignal): Promise<PlannedWrite> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("aborted before plan");
    }
    if (!this.pool) {
      throw new SyncError("fatal", "postgres destination: connector is not open");
    }

    const quotedTable = quoteIdentifier(this.config.table);
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    for (let i = 0; i < this.keyCols.length; i++) {
      const keyCol = this.keyCols[i]!;
      const val = req.data[keyCol] ?? (this.keyCols.length === 1 ? req.key : undefined);
      if (val === undefined) {
        return {
          action: "unknown",
          description: `Cannot plan write: missing key column '${keyCol}' in record`,
        };
      }
      values.push(val);
      whereClauses.push(`${quoteIdentifier(keyCol)} = $${i + 1}`);
    }

    const checkSql = `
      SELECT * FROM ${quotedTable}
      WHERE ${whereClauses.join(" AND ")}
      LIMIT 1
    `;

    try {
      const res = await this.pool.query({
        text: checkSql,
        values,
      });

      if (res.rows.length === 0) {
        return {
          action: "create",
          description: `Insert new row into ${this.config.table} (key: ${req.key})`,
        };
      }

      const existingRow = res.rows[0];
      const changedCols: string[] = [];

      for (const [k, v] of Object.entries(req.data)) {
        const existingVal = existingRow[k];
        // Normalize comparison for dates/json
        const currentStr = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
        const existingStr = existingVal instanceof Date ? existingVal.toISOString() : typeof existingVal === "object" ? JSON.stringify(existingVal) : String(existingVal ?? "");

        if (currentStr !== existingStr) {
          changedCols.push(k);
        }
      }

      if (changedCols.length > 0) {
        return {
          action: "update",
          description: `Update existing row in ${this.config.table} (key: ${req.key}, modified: ${changedCols.join(", ")})`,
        };
      }

      return {
        action: "unchanged",
        description: `Row in ${this.config.table} (key: ${req.key}) is identical`,
      };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === "42P01") {
        return {
          action: "create",
          description: `Destination table '${this.config.table}' will be auto-created and row inserted (key: ${req.key})`,
        };
      }
      return {
        action: "unknown",
        description: `Failed to inspect row in ${this.config.table}: ${classifyPgError(err, "plan").message}`,
      };
    }
  }

  private async ensureDestinationTable(
    quotedTable: string,
    cols: string[],
    sampleData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.pool) return;
    const colDefs: string[] = [];
    for (const col of cols) {
      const isPk = this.keyCols.includes(col);
      const val = sampleData[col];
      let type = "TEXT";
      if (typeof val === "boolean") {
        type = "BOOLEAN";
      } else if (typeof val === "number") {
        type = Number.isInteger(val) ? "BIGINT" : "DOUBLE PRECISION";
      } else if (val instanceof Date) {
        type = "TIMESTAMPTZ";
      } else if (typeof val === "object" && val !== null) {
        type = "JSONB";
      } else if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
        type = "TIMESTAMPTZ";
      }
      colDefs.push(`${quoteIdentifier(col)} ${type}${isPk ? " NOT NULL" : ""}`);
    }
    const pkConstraint = `, PRIMARY KEY (${this.keyCols.map(quoteIdentifier).join(", ")})`;
    const createSql = `CREATE TABLE IF NOT EXISTS ${quotedTable} (\n  ${colDefs.join(",\n  ")}${pkConstraint}\n);`;
    await this.pool.query(createSql);
  }

  private async ensureDestinationColumns(
    quotedTable: string,
    cols: string[],
    sampleData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.pool) return;
    for (const col of cols) {
      const val = sampleData[col];
      let type = "TEXT";
      if (typeof val === "boolean") {
        type = "BOOLEAN";
      } else if (typeof val === "number") {
        type = Number.isInteger(val) ? "BIGINT" : "DOUBLE PRECISION";
      } else if (val instanceof Date) {
        type = "TIMESTAMPTZ";
      } else if (typeof val === "object" && val !== null) {
        type = "JSONB";
      } else if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
        type = "TIMESTAMPTZ";
      }
      await this.pool.query(
        `ALTER TABLE ${quotedTable} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(col)} ${type};`,
      ).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.end().catch(() => {});
    }
  }
}
