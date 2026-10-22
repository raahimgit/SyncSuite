// Test fixtures for exercising engine logic with controllable behavior.
// These are not product connectors and are not exported from the package.
import type {
  Cursor,
  DestinationConnector,
  PlannedWrite,
  ReadBatch,
  RecordData,
  SourceConnector,
  SourceRecord,
  WriteRequest,
  WriteResult,
} from "../../src/core/types.js";

export function makeRecords(count: number, offset = 0): SourceRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + offset;
    return { key: `r${n}`, data: { id: n, first_name: `F${n}`, last_name: `L${n}`, email: `u${n}@example.com` } };
  });
}

export class MemorySource implements SourceConnector {
  readonly type = "memory";
  readonly calls: Array<Cursor | null> = [];

  constructor(public records: SourceRecord[]) {}

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async readBatch(from: Cursor | null, limit: number, signal: AbortSignal): Promise<ReadBatch> {
    signal.throwIfAborted();
    this.calls.push(from);
    const pos = from && typeof from["pos"] === "number" ? from["pos"] : 0;
    const records = this.records.slice(pos, pos + limit);
    return { records, nextCursor: records.length > 0 ? { pos: pos + records.length } : null };
  }
}

export class MemoryDestination implements DestinationConnector {
  readonly type = "memory";
  readonly rows = new Map<string, RecordData>();
  readonly writes: WriteRequest[] = [];

  // onWrite runs before the write is applied; throw from it to simulate a
  // failure. `attempt` is the 1-based count of write calls so far.
  constructor(public onWrite?: (req: WriteRequest, attempt: number) => Promise<void> | void) {}

  private calls = 0;

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async write(req: WriteRequest, signal: AbortSignal): Promise<WriteResult> {
    signal.throwIfAborted();
    this.calls += 1;
    await this.onWrite?.(req, this.calls);
    this.writes.push(req);
    this.rows.set(req.key, req.data);
    return { status: "written" };
  }

  async plan(req: WriteRequest): Promise<PlannedWrite> {
    return { action: this.rows.has(req.key) ? "update" : "create", description: `upsert ${req.key}` };
  }
}
