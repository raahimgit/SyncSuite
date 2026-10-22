import { SyncError } from "./types.js";
import type { DestinationConnector, SourceConnector } from "./types.js";

// Factories receive the raw `config` block from the job spec and must validate
// it themselves, throwing SyncError("fatal") on invalid configuration. Secret
// references ({ $env }) are also resolved by the connector, never the engine.
export type SourceFactory = (config: Record<string, unknown>) => SourceConnector;
export type DestinationFactory = (config: Record<string, unknown>) => DestinationConnector;

export class ConnectorRegistry {
  private readonly sources = new Map<string, SourceFactory>();
  private readonly destinations = new Map<string, DestinationFactory>();

  registerSource(type: string, factory: SourceFactory): void {
    if (this.sources.has(type)) throw new Error(`source connector '${type}' is already registered`);
    this.sources.set(type, factory);
  }

  registerDestination(type: string, factory: DestinationFactory): void {
    if (this.destinations.has(type)) throw new Error(`destination connector '${type}' is already registered`);
    this.destinations.set(type, factory);
  }

  createSource(type: string, config: Record<string, unknown>): SourceConnector {
    const factory = this.sources.get(type);
    if (!factory) throw new SyncError("fatal", `unknown source connector type '${type}'`);
    return factory(config);
  }

  createDestination(type: string, config: Record<string, unknown>): DestinationConnector {
    const factory = this.destinations.get(type);
    if (!factory) throw new SyncError("fatal", `unknown destination connector type '${type}'`);
    return factory(config);
  }
}
