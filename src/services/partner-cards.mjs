// Sponsored cards come from the campaign feed the build published. They are
// rendered with the site's own card design so they read as part of the
// catalogue, and they are mixed into the browse grids as "four of ours, then one
// sponsored". Everything here is pure so the mixing rules can be tested.
import { partnerEmbedUrl } from "./partner-embed.mjs";
import { PARTNER_PREVIEW_LIMIT } from "./partner-feed.mjs";

export const SPONSORED_EVERY = 4;
// The build reads exactly this many embed pages for titles and posters, so the
// grid never asks for a card that has no preview to show.
const MAX_CARDS = PARTNER_PREVIEW_LIMIT;
const MAX_TEXT = 2048;
const MAX_TITLE = 120;

function httpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Accepts both the current payload (objects) and the older one (bare URLs).
export function sponsoredCards(payload, { limit = MAX_CARDS } = {}) {
  const raw = payload?.items;
  if (!Array.isArray(raw)) return [];
  const cards = [];
  const seen = new Set();
  for (const item of raw) {
    const value = typeof item === "string" ? { embedUrl: item } : item;
    if (!value || typeof value !== "object") continue;
    const embedUrl = partnerEmbedUrl(value.embedUrl, { requireVideoPath: true });
    if (!embedUrl || seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    const title = typeof value.title === "string" ? value.title.trim().slice(0, MAX_TITLE) : "";
    cards.push({
      id: `sponsored:${embedUrl}`,
      embedUrl,
      title,
      thumbnail: httpsUrl(value.thumbnail),
    });
    if (cards.length >= limit) break;
  }
  return cards;
}

// "four of ours, then one of theirs": every `every`-th slot becomes sponsored.
// The result keeps the order of the catalogue and never ends on a sponsored card.
export function interleaveSponsored(videos, cards, { every = SPONSORED_EVERY } = {}) {
  const list = Array.isArray(videos) ? videos : [];
  const sponsored = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (!sponsored.length || !Number.isInteger(every) || every < 1) {
    return list.map((video) => ({ kind: "video", video }));
  }
  const merged = [];
  let next = 0;
  for (let index = 0; index < list.length; index += 1) {
    merged.push({ kind: "video", video: list[index] });
    const isSlot = (index + 1) % every === 0;
    if (isSlot && next < sponsored.length && index + 1 < list.length) {
      merged.push({ kind: "sponsored", card: sponsored[next] });
      next += 1;
    }
  }
  return merged;
}
