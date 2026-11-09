export const LIKE_COUNT_BATCH_SIZE = 20;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const unavailable = () => new Error("Content is temporarily unavailable");
const counter = (value) => Number.isSafeInteger(value) && value >= 0;

export function likeCountKey(backend, id) {
  return `${backend}\n${id}`;
}

// A version is mandatory: delayed polls must not overwrite a newer result.
export function readLikeCount(id, value) {
  if (typeof id !== "string" || !ID.test(id) || !value || typeof value !== "object" || Array.isArray(value)
    || !counter(value.likes) || !counter(value.version)) return null;
  return { id, likes: value.likes, version: value.version };
}

export function parseLikeCounts(data, requestedIds) {
  if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > LIKE_COUNT_BATCH_SIZE
    || requestedIds.some((id) => typeof id !== "string" || !ID.test(id))
    || new Set(requestedIds).size !== requestedIds.length
    || !data || !Array.isArray(data.counts) || data.counts.length > requestedIds.length) throw unavailable();
  const requested = new Set(requestedIds);
  const seen = new Set();
  return data.counts.map((item) => {
    const stat = item && readLikeCount(item.id, item);
    if (!stat || !requested.has(stat.id) || seen.has(stat.id)) throw unavailable();
    seen.add(stat.id);
    return stat;
  });
}

export function mergeLikeCounts(previous, backend, records) {
  let next = previous;
  for (const input of records) {
    const stat = readLikeCount(input?.id, input);
    if (!stat) continue;
    const key = likeCountKey(backend, stat.id);
    const old = next.get(key);
    if (old && stat.version <= old.version) continue;
    if (next === previous) next = new Map(previous);
    next.set(key, stat);
  }
  return next;
}
