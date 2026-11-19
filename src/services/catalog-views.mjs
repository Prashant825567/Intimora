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

// Home's filter bar. A video is "anime" when its category or one of its tags
// says so; "desi" is simply everything that is not anime, because the catalogue
// also carries uploads from other countries and a country name would be wrong
// for them. "Sponsored" is a separate source handled by the grid, so it yields
// no catalogue rows here. An unknown value falls back to the whole catalogue.
export const HOME_FILTERS = ["all", "desi", "anime", "sponsored"];

const ANIME_LABEL = /(^|[^a-z])anime([^a-z]|$)/i;

function labelsOf(video) {
  const labels = [];
  if (typeof video?.category === "string") labels.push(video.category);
  if (Array.isArray(video?.tags)) {
    for (const tag of video.tags) if (typeof tag === "string") labels.push(tag);
  }
  return labels.map((label) => label.trim()).filter(Boolean);
}

export function isAnimeVideo(video) {
  return labelsOf(video).some((label) => ANIME_LABEL.test(label));
}

export function selectHomeFilter(videos, filter = "all") {
  const list = Array.isArray(videos) ? videos : [];
  if (filter === "sponsored") return [];
  if (filter === "anime") return list.filter(isAnimeVideo);
  if (filter === "desi") return list.filter((video) => !isAnimeVideo(video));
  return list;
}
