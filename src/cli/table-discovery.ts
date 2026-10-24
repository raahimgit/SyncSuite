import { createPool } from "../db/pool.js";

export interface DiscoveredColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
}

export interface DiscoveredTable {
  name: string;
  schema: string;
  columns: DiscoveredColumn[];
  primaryKeyColumn: string;
  cursorColumn: string | null;
}

const SYSTEM_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "synckit",
  "auth",
  "storage",
  "graphql",
  "graphql_public",
  "vault",
  "realtime",
  "extensions",
  "pgbouncer",
]);

const IGNORED_TABLE_NAMES = new Set([
  "schema_migrations",
  "_prisma_migrations",
  "knex_migrations",
  "knex_migrations_lock",
  "typeorm_metadata",
  "drizzle_migrations",
  "flyway_schema_history",
  "spatial_ref_sys",
]);

const CURSOR_CANDIDATE_NAMES = [
  "updated_at",
  "modified_at",
  "updated_at_utc",
  "last_modified",
  "edited_at",
  "timestamp",
  "created_at",
  "created_at_utc",
];

/**
 * Connects to the database at dbUrl and inspects the public schema to discover
 * application tables, their primary keys, and potential cursor columns.
 * Returns an array of candidate tables, sorted by best fit for replication.
 */
export async function discoverDatabaseTables(
  dbUrl: string,
  timeoutMs = 6000,
): Promise<{ tables: DiscoveredTable[]; allTableNames: string[] }> {
  const pool = createPool({
    config: dbUrl,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: timeoutMs,
  });

  try {
    // 1. Fetch user base tables from public schema
    const tablesRes = await pool.query<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema = 'public'
      ORDER BY table_name ASC
    `);

    const rawTables = tablesRes.rows.filter(
      (r) => !SYSTEM_SCHEMAS.has(r.table_schema) && !IGNORED_TABLE_NAMES.has(r.table_name) && !r.table_name.endsWith("_replica"),
    );

    const allTableNames = rawTables.map((r) => r.table_name);
    if (allTableNames.length === 0) {
      return { tables: [], allTableNames: [] };
    }

    // 2. Fetch primary key constraints
    const pkRes = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'PRIMARY KEY'
    `);

    const pkMap = new Map<string, string>();
    for (const row of pkRes.rows) {
      if (!pkMap.has(row.table_name)) {
        pkMap.set(row.table_name, row.column_name);
      }
    }

    // 3. Fetch columns for candidate tables
    const colRes = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const tableColumns = new Map<string, DiscoveredColumn[]>();
    for (const col of colRes.rows) {
      if (!tableColumns.has(col.table_name)) {
        tableColumns.set(col.table_name, []);
      }
      const pk = pkMap.get(col.table_name);
      const isPk = pk ? pk === col.column_name : col.column_name === "id";
      tableColumns.get(col.table_name)!.push({
        name: col.column_name,
        dataType: col.data_type,
        isNullable: col.is_nullable === "YES",
        isPrimaryKey: isPk,
      });
    }

    // 4. Construct DiscoveredTable objects
    const tables: DiscoveredTable[] = [];
    for (const t of rawTables) {
      const cols = tableColumns.get(t.table_name) ?? [];
      if (cols.length === 0) continue;

      const pkCol = pkMap.get(t.table_name) ?? cols.find((c) => c.name === "id")?.name ?? cols[0]?.name ?? "id";

      // Detect cursor column (favor updated_at, then timestamp/date types)
      let cursorCol: string | null = null;
      for (const candidate of CURSOR_CANDIDATE_NAMES) {
        if (cols.some((c) => c.name === candidate)) {
          cursorCol = candidate;
          break;
        }
      }
      if (!cursorCol) {
        const timestampCol = cols.find(
          (c) =>
            c.dataType.includes("timestamp") ||
            c.dataType.includes("date") ||
            c.name.includes("time") ||
            c.name.includes("date"),
        );
        if (timestampCol) {
          cursorCol = timestampCol.name;
        }
      }

      tables.push({
        name: t.table_name,
        schema: t.table_schema,
        columns: cols,
        primaryKeyColumn: pkCol,
        cursorColumn: cursorCol,
      });
    }

    // Sort tables: prioritize tables with both PK and cursor column, then alphabetical
    tables.sort((a, b) => {
      const aScore = (a.primaryKeyColumn ? 2 : 0) + (a.cursorColumn ? 2 : 0);
      const bScore = (b.primaryKeyColumn ? 2 : 0) + (b.cursorColumn ? 2 : 0);
      if (bScore !== aScore) return bScore - aScore;
      return a.name.localeCompare(b.name);
    });

    return { tables, allTableNames };
  } catch {
    // If table inspection fails (e.g. permission restriction), return empty safely
    return { tables: [], allTableNames: [] };
  } finally {
    await pool.end().catch(() => {});
  }
}
