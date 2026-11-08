// Read each public catalog page from the backend selected for the first page.
// Some backends repeat the boundary item (or the final cursor); avoid duplicates
// and stop rather than issuing an infinite sequence of requests.
export async function collectCatalog({ firstPage, fetchPage, onPage, isCancelled = () => false, pageSize = 50, maxPages = 120, pauseMs = 75 }) {
  const seenIds = new Set();
  const seenCursors = new Set();
  const backend = firstPage.data.backend;
  let page = firstPage;
  let pages = 0;

  while (!isCancelled()) {
    if (page.data.backend !== backend) throw new Error("Content is temporarily unavailable");
    const fresh = [];
    for (const video of page.data.videos) {
      if (!seenIds.has(video.id)) {
        seenIds.add(video.id);
        fresh.push(video);
      }
    }
    onPage(fresh, backend);
    pages += 1;

    const next = page.data.nextCursor;
    if (!next || page.data.videos.length === 0) return { complete: true, cancelled: false, pages };
    const key = JSON.stringify([next.backend, String(next.value)]);
    if (seenCursors.has(key)) {
      // A short page containing only already-seen items is the legacy API's
      // normal end marker. A full repeated page can conceal more items with
      // the same timestamp, so report it as incomplete instead of guessing.
      const complete = fresh.length === 0 && page.data.videos.length < pageSize;
      return { complete, cancelled: false, pages };
    }
    seenCursors.add(key);
    if (pages >= maxPages) return { complete: false, cancelled: false, pages };
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (isCancelled()) break;
    page = await fetchPage(next);
  }
  return { complete: false, cancelled: true, pages };
}
