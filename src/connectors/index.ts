import { ConnectorRegistry } from "../core/registry.js";
import { PostgresDestination } from "./postgres-destination.js";
import { PostgresSource } from "./postgres-source.js";
import { RestDestination } from "./rest-destination.js";
import { RestSource } from "./rest-source.js";

import { S3Destination } from "./s3-destination.js";

export * from "./secrets.js";
export * from "./ssrf.js";
export * from "./sql-utils.js";
export * from "./http-utils.js";
export * from "./postgres-source.js";
export * from "./postgres-destination.js";
export * from "./rest-source.js";
export * from "./rest-destination.js";
export * from "./s3-destination.js";

/**
 * Registers standard built-in connectors ('postgres', 'rest', 's3') into the given registry.
 */
export function registerDefaultConnectors(registry: ConnectorRegistry): void {
  registry.registerSource("postgres", (config) => new PostgresSource(config));
  registry.registerDestination("postgres", (config) => new PostgresDestination(config));
  registry.registerSource("rest", (config) => new RestSource(config));
  registry.registerDestination("rest", (config) => new RestDestination(config));
  registry.registerDestination("s3", (config) => new S3Destination(config));
}

/**
 * Creates a ConnectorRegistry with default connectors already registered.
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registerDefaultConnectors(registry);
  return registry;
}
