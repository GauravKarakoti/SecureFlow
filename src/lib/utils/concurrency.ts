/**
 * Map over `items` with at most `limit` calls to `fn` in flight at once.
 *
 * Results come back in input order, like `Promise.all(items.map(fn))`, and the
 * first rejection rejects the whole call — the same contract, with a ceiling on
 * how much of it runs at the same time. Once a call rejects, no further calls
 * are started.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function lane(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, lane));
  return results;
}
