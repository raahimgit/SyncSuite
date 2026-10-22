// Describes a value's type without ever including the value itself. Error
// messages built from this are safe to persist and log.
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value;
}
