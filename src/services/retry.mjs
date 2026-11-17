// A tiny retry helper for reads that a transient hiccup can fail: the catalogue
// page, a shared link's detail, a search. It never retries a value that arrived
// and was judged unusable — that is the caller's decision, expressed by throwing.
//
// Cancellation is the caller's job: pass a function that throws for a stale
// request, and the loop stops like any other failure.
export const CATALOG_RETRY_DELAYS_MS = [1_200, 2_600];
export const UNLOCK_RETRY_DELAYS_MS = [1_000, 2_500, 4_000];
export const SHARED_LINK_RETRY_DELAYS_MS = [1_200];
export const SEARCH_RETRY_DELAYS_MS = [900];

export async function retryWithDelays(task, {
  delays = [],
  shouldRetry = () => true,
  sleep,
} = {}) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const budget = Array.isArray(delays) ? delays : [];
  let lastError;
  for (let attempt = 0; attempt <= budget.length; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= budget.length) break;
      if (!shouldRetry(error, attempt)) break;
      await wait(budget[attempt]);
    }
  }
  throw lastError;
}
