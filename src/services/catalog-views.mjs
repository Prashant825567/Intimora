// These selections use the original numeric metadata, not formatted labels such
// as "1.2M" or "3 days ago". The visitor's local calendar defines today.
const newestFirst = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id);

export function selectTrending(videos) {
  return [...videos].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0) || newestFirst(a, b));
}

export function selectNewReleases(videos, now = Date.now()) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) return [];
  const todayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const yesterdayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1).getTime();
  const today = videos.filter((video) => Number.isFinite(video.createdAt)
    && video.createdAt >= todayStart && video.createdAt <= now);
  const selected = today.length ? today : videos.filter((video) => Number.isFinite(video.createdAt)
    && video.createdAt >= yesterdayStart && video.createdAt < todayStart);
  return selected.sort(newestFirst);
}

export function selectExclusive(videos) {
  return videos.filter((video) => video.isExclusive === true).sort(newestFirst);
}
