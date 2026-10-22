// Runs `fn` over `items` with at most `limit` in flight and returns results in
// input order. On the first failure no new items are started, in-flight items
// are awaited (so nothing keeps running after the caller sees the error), and
// that first error is thrown. An aborted signal is treated the same way.
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // An array rather than a `let` so closure assignments are visible to the
  // type checker's control-flow analysis.
  const errors: unknown[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (errors.length === 0) {
      const index = next++;
      if (index >= items.length) return;
      if (signal?.aborted) {
        errors.push(signal.reason ?? new Error("aborted"));
        return;
      }
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        errors.push(error);
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length > 0) throw errors[0];
  return results;
}
