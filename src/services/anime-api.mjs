// Anime rows come from our own anime API (a deployment of the PacaHub service)
// instead of a feed baked into the build: the page asks for the source's recent
// and popular lists when it opens, and nothing about that content lives in this
// repository. Only metadata is read here — an id, a title, a poster, a duration.
// A click still opens the source's own embed player inside our frame; no media
// URL is copied and nothing is proxied through this site.
export const ANIME_API_BASE = "https://pacahub-34nd.onrender.com";

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WATCH_ID = /^[A-Za-z0-9_-]{1,200}$/;
const THUMBNAIL = /^https:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?$/i;
const MAX_TITLE = 140;
const MAX_CARDS = 24;

function httpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// The source links a video as `…/video/<slug>-<id>.html`, and the API hands that
// last path segment back as the id in its list endpoints. The embed player only
// wants the real id, so it is taken from the end of the slug — never guessed.
export function animeIdFromSlug(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.trim().split("-");
  const last = parts[parts.length - 1];
  return VIDEO_ID.test(last) && /[0-9]/.test(last) ? last : null;
}

export function animeEmbedUrl(id) {
  return VIDEO_ID.test(id ?? "") ? `https://www.hentaicity.com/embed/${id}` : null;
}

function cleanTitle(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_TITLE) : "";
}

// Their cards print "HD07:03"; the card wants the duration only.
function cleanDuration(value) {
  return String(value ?? "").match(/(\d{1,3}:[0-5]\d)/)?.[1] ?? "";
}

const SLUG = /^[A-Za-z0-9_-][A-Za-z0-9_-]*(?:-[A-Za-z0-9_-]+)*$/;
// A stored account id: the same alphabet and length the account API accepts.
const ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

// The API's own id is the whole slug (`…-girls-6-1JdXN6yeMdN`), and its watch
// route needs it whole. The short tail is kept as `code`, for the embed URL and
// the thumbnail video id only — asking the watch route with just the tail is what
// returned `Failed to scrape HentaiCity watch: Request failed with status code 404`.
function cardFromResult(result) {
  if (!result || typeof result !== "object") return null;
  const raw = typeof result.id === "string" ? result.id : typeof result.slug === "string" ? result.slug : "";
  const slug = raw.trim();
  const code = animeIdFromSlug(slug);
  const id = code && slug.length <= 200 && SLUG.test(slug) ? slug : null;
  if (!id) return null;
  const title = cleanTitle(result.title ?? result.name);
  const thumbnail = httpsUrl(result.thumbnail ?? result.poster ?? result.image);
  if (!title || !thumbnail || !THUMBNAIL.test(thumbnail)) return null;
  return { id, code, title, thumbnail, duration: cleanDuration(result.duration ?? result.length), embedUrl: animeEmbedUrl(code) };
}

// The service answers `{ ok, data: { results: [...] } }`; some deployments wrap it
// one level less. Both are read, and anything else is simply no cards.
export function parseAnimeResults(payload, { limit = MAX_CARDS } = {}) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.results) ? payload.results
      : Array.isArray(payload?.data?.results) ? payload.data.results
        : Array.isArray(payload?.data?.data?.results) ? payload.data.data.results
          : Array.isArray(payload?.data) ? payload.data
            : null;
  if (!list) return [];
  const cards = [];
  const seen = new Set();
  for (const result of list) {
    const card = cardFromResult(result);
    // One title, once: the source may print the same video under two slugs.
    if (!card || seen.has(card.code)) continue;
    seen.add(card.code);
    cards.push(card);
    if (cards.length >= limit) break;
  }
  return cards;
}

async function readJson(url, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`anime api answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// Recent first, then popular — the order the anime page shows them in. A row that
// fails is dropped instead of failing the page, and an empty result is a row the
// page simply does not draw.
export async function fetchAnimeRows({
  base = ANIME_API_BASE,
  fetchImpl = (...args) => fetch(...args),
  signal,
  timeoutMs = 15_000,
  limit = MAX_CARDS,
} = {}) {
  const wanted = [
    { id: "recent", title: "Recent", path: "/api/hen/city/recent" },
    { id: "popular", title: "Popular", path: "/api/hen/city/popular/1" },
  ];
  const rows = [];
  for (const row of wanted) {
    try {
      const payload = await readJson(`${base}${row.path}`, { fetchImpl, signal, timeoutMs });
      const cards = parseAnimeResults(payload, { limit });
      if (cards.length) rows.push({ id: row.id, title: row.title, cards });
    } catch { /* A row that will not load costs its own row, nothing else. */ }
  }
  return rows;
}

const MEDIA_FILE = /\.(?:mp4|m4v|webm|mov)$/i;
// The service's watch route answers with an HLS playlist for the same title
// (`source[].src`, `formate: "hls"`), not with a file. Both are playable, so both
// count as a link; the player handles whichever shape it is given.
const HLS_FILE = /\.m3u8$/i;

const LINK_KEYS = ["url", "file", "videoUrl", "streamUrl", "src", "link", "playUrl", "media", "sources", "source", "data", "video", "result"];

// The first link in the answer that a browser can really play: a plain https URL
// (no credentials, no fragment) that ends in a media file or an HLS playlist.
// Nothing is rebuilt, proxied or pulled out of a page — a page URL or a download
// host stays "no stream", which the player then reports instead of guessing.
export function animeStreamFrom(payload) {
  const seen = [];
  const walk = (value, depth) => {
    if (!value || depth > 4) return;
    if (typeof value === "string") { seen.push(value.trim()); return; }
    if (Array.isArray(value)) { for (const item of value.slice(0, 20)) walk(item, depth + 1); return; }
    if (typeof value !== "object") return;
    for (const key of LINK_KEYS) {
      if (key in value) walk(value[key], depth + 1);
    }
  };
  walk(payload, 0);
  for (const raw of seen) {
    if (!raw || raw.length > 2048) continue;
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    if (!MEDIA_FILE.test(url.pathname) && !HLS_FILE.test(url.pathname)) continue;
    return url.href;
  }
  return null;
}

// A playlist can be readable while its segments refuse the browser (the source
// checks the referrer and the page origin). That is not a link we can play, so the
// player asks us first and is told plainly instead of showing a stuck spinner.
export async function hlsPlayable(url, { fetchImpl = (...args) => fetch(...args), signal, timeoutMs = 8_000 } = {}) {
  let target;
  try { target = new URL(url); } catch { return false; }
  if (target.protocol !== "https:" || !HLS_FILE.test(target.pathname)) return false;
  let timer;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(target.href, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      // The source is an ordinary website: it answers a browser-shaped request.
      // A 200 with a playlist body is all this check needs.
      headers: { Accept: "*/*" },
      signal: controller.signal,
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    return response.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// Which kind of link the player was handed, so it can pick a playback path.
export const isHlsLink = (url) => typeof url === "string" && HLS_FILE.test((() => {
  try { return new URL(url).pathname; } catch { return ""; }
})());
export async function fetchAnimeStream(id, { base = ANIME_API_BASE, fetchImpl = (...args) => fetch(...args), signal, timeoutMs = 15_000 } = {}) {
  if (!WATCH_ID.test(id ?? "")) return null;
  try {
    const payload = await readJson(`${base}/api/hen/city/watch/${encodeURIComponent(id)}`, { fetchImpl, signal, timeoutMs });
    return animeStreamFrom(payload);
  } catch {
    return null;
  }
}

// Search runs on what this page already loaded — the source's own /search/ is not
// called, so no query leaves our origin.
export function animeSearch(cards, query, { limit = 24 } = {}) {
  const text = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!text || !Array.isArray(cards)) return [];
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = [];
  for (const card of cards) {
    const haystack = `${card?.title ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    matches.push(card);
    if (matches.length >= limit) break;
  }
  return matches;
}

// An anime title has no record in our own catalogue, so a like/save on its card
// has nothing to write to the backend — and an external id is never sent to our
// API as if it were ours. Instead the card itself is stored: the id is namespaced
// (`anime-…`) and a couple of `anime-…` metadata keys describe it, so the account's
// existing `likedVideos` / `savedVideos` lists hold it next to our own videos with
// no new endpoint and no catalogue record. The prefix keeps the two apart on both
// sides: the backend can tell an external title from a catalogue id by that alone.
export const ANIME_ID_PREFIX = "anime-";

// The API's own slug already reads as `title-words-<code>`; keeping the words makes
// a stored id recognisable and the slug's own `-<code>` tail survives, so an id can
// be read back into a title. Only `[A-Za-z0-9_-]` reaches the API and a stored id,
// which is the same alphabet the account's id list accepts.
export function animeAccountId(card) {
  if (!card || typeof card !== "object") return null;
  const slug = typeof card.id === "string" ? card.id.trim() : "";
  if (slug.length <= 200 && SLUG.test(slug)) {
    const full = `${ANIME_ID_PREFIX}${slug}`;
    if (ID_SAFE.test(full)) return full;
  }
  const code = typeof card.code === "string" && VIDEO_ID.test(card.code) ? card.code : null;
  return code ? `${ANIME_ID_PREFIX}${code}` : null;
}

// The two metadata keys the account's own backend keeps beside an entry.
export function animeAccountMeta(card) {
  if (!card || typeof card !== "object") return {};
  const meta = {};
  const title = cleanTitle(card.title);
  const thumbnail = httpsUrl(card.thumbnail);
  if (title) meta["anime-title"] = title;
  if (thumbnail) meta["anime-thumbnail"] = thumbnail;
  return meta;
}

// A stored account entry drawn back as a card: the dashboard lists what the
// account holds even when the source's own rows no longer carry the title. Only
// the id, the title and the poster come from the entry; playback still asks the
// source for the stream on click, exactly like a fresh card.
export function animeCardFromSaved(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id.startsWith(ANIME_ID_PREFIX)) return null;
  const slug = id.slice(ANIME_ID_PREFIX.length);
  if (slug.length > 200 || !SLUG.test(slug)) return null;
  const title = cleanTitle(entry.title);
  const thumbnail = httpsUrl(entry.thumbnail);
  if (!title || !thumbnail || !THUMBNAIL.test(thumbnail)) return null;
  const code = animeIdFromSlug(slug);
  return { id: slug, code, title, thumbnail, duration: "", embedUrl: animeEmbedUrl(code) };
}
