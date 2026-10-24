import { describe, it, expect, vi } from "vitest";
import { buildDynamicPgToPgYaml } from "../../src/cli/commands/init.js";

describe("Dynamic Job Generation", () => {
  it("generates a tailored job YAML from discovered table info", () => {
    const yaml = buildDynamicPgToPgYaml({
      table: "companies",
      keyColumn: "id",
      cursorColumn: "updated_at",
      dbVarName: "DATABASE_URL",
    });

    expect(yaml).toContain("name: sync-companies-replica");
    expect(yaml).toContain("table: companies");
    expect(yaml).toContain("table: companies_replica");
    expect(yaml).toContain("keyColumn: id");
    expect(yaml).toContain("cursorColumn: updated_at");
    expect(yaml).toContain("$env: DATABASE_URL");
    // Verify no hardcoded orders placeholder is present
    expect(yaml).not.toContain("orders");
  });

  it("falls back to sensible defaults when optional fields are omitted", () => {
    const yaml = buildDynamicPgToPgYaml({
      table: "events",
    });

    expect(yaml).toContain("name: sync-events-replica");
    expect(yaml).toContain("table: events");
    expect(yaml).toContain("table: events_replica");
    expect(yaml).toContain("keyColumn: id");
    expect(yaml).toContain("cursorColumn: updated_at");
  });
});
