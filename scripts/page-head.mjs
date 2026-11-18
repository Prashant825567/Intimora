// Every generated shell starts as a copy of the built index.html. Without this
// step all of them would share one <title>, one description and no canonical,
// which is exactly how Google decides that 500 watch pages are duplicates of
// each other. This module rewrites the per-page head and is the only place where
// catalogue text is allowed into the document — always escaped, always short.
import { BROWSE_PATHS } from "../src/services/page-routes.mjs";

export const SITE_ORIGIN = "https://intimora.new.tg";
export const SITE_NAME = "Intimora";
export const HOME_TITLE = "Intimora | 18+ Adult Video Streaming";
export const HOME_DESCRIPTION = "Intimora is an 18+ adult video streaming platform with a searchable catalog and online playback.";

const MAX_TITLE_CHARS = 70;
const MAX_DESCRIPTION_CHARS = 160;
const WATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;

const BROWSE_HEADS = {
  Trending: {
    title: "Trending Videos | Intimora",
    description: "The most viewed videos on Intimora, ranked by views.",
  },
  New: {
    title: "New Releases | Intimora",
    description: "Today's newest uploads on Intimora, 18+ only.",
  },
  Exclusive: {
    title: "Exclusive Videos | Intimora",
    description: "Videos marked exclusive in their metadata on Intimora.",
  },
  Categories: {
    title: "Categories | Intimora",
    description: "Browse Intimora by category.",
  },
};

const OTHER_HEADS = {
  "/search": { title: "Search Videos | Intimora", description: "Search the Intimora catalogue." },
  "/login": { title: "Sign In | Intimora", description: "Sign in to Intimora with Google." },
  "/profile": { title: "Your Profile | Intimora", description: "Your Intimora profile and saved videos." },
  "/referral": { title: "Referral Program | Intimora", description: "Invite friends to Intimora with your referral code." },
  "/dashboard": { title: "Account | Intimora", description: "Your Intimora account dashboard." },
};

// Catalogue text is untrusted: strip control characters, collapse whitespace,
// cap the length, and escape for an HTML attribute or a JSON string.
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cleanPhrase(value, max = MAX_TITLE_CHARS) {
  if (typeof value !== "string") return "";
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function canonicalFor(route) {
  if (typeof route !== "string" || !route.startsWith("/")) return `${SITE_ORIGIN}/`;
  const path = route === "/" ? "/" : route.replace(/\/+$/, "");
  return `${SITE_ORIGIN}${path}`;
}

// The head of one generated page. `videoTitle` is only used for watch routes
// and is escaped by the caller through `applyPageHead`.
export function pageMetaFor(route = "/", { videoTitle } = {}) {
  const watch = /^\/watch\/([^/]+)$/.exec(route);
  if (watch) {
    const id = watch[1];
    if (!WATCH_ID.test(id)) return pageMetaFor("/");
    const cleaned = cleanPhrase(videoTitle);
    const title = cleaned ? `${cleaned} | Intimora` : "Watch on Intimora | 18+ Adult Video Streaming";
    const description = cleaned
      ? `Watch “${cleaned}” on Intimora. 18+ only.`
      : "Watch this video on Intimora. 18+ only.";
    return {
      title: cleanPhrase(title, MAX_TITLE_CHARS + 12),
      description: cleanPhrase(description, MAX_DESCRIPTION_CHARS),
      canonical: canonicalFor(route),
      type: "video.other",
      page: {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: cleanPhrase(cleaned || "Watch on Intimora", MAX_TITLE_CHARS),
        url: canonicalFor(route),
        isFamilyFriendly: false,
        contentRating: "18+",
      },
    };
  }
  if (route === "/" || route === "") {
    return {
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
      canonical: `${SITE_ORIGIN}/`,
      type: "website",
      page: null,
    };
  }
  const browse = Object.values(BROWSE_PATHS).includes(route)
    ? Object.entries(BROWSE_PATHS).find(([, path]) => path === route)?.[0]
    : undefined;
  const head = (browse && BROWSE_HEADS[browse]) || OTHER_HEADS[route];
  if (!head) return pageMetaFor("/");
  return {
    title: head.title,
    description: head.description,
    canonical: canonicalFor(route),
    type: "website",
    page: null,
  };
}

function replaceContent(html, pattern, value) {
  return html.replace(pattern, (match) => match.replace(/content="[^"]*"/, `content="${escapeHtml(value)}"`));
}

// Rewrites title, description, canonical, og:url and adds the page's own
// structured data. Unknown tags are inserted before </head>, so a shell built
// from an older index.html still ends up with a canonical.
export function applyPageHead(html, meta, { noindex = false } = {}) {
  if (typeof html !== "string" || !meta) return html;
  let output = html;
  output = output.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);
  output = replaceContent(output, /<meta\s+name="description"[\s\S]*?>/i, meta.description);
  output = replaceContent(output, /<meta\s+property="og:title"[\s\S]*?>/i, meta.title);
  output = replaceContent(output, /<meta\s+property="og:description"[\s\S]*?>/i, meta.description);
  output = replaceContent(output, /<meta\s+property="og:url"[\s\S]*?>/i, meta.canonical);
  // The card previews repeat the same two strings for X/Twitter.
  output = replaceContent(output, /<meta\s+name="twitter:title"[\s\S]*?>/i, meta.title);
  output = replaceContent(output, /<meta\s+name="twitter:description"[\s\S]*?>/i, meta.description);
  // The 404 shell is a real file, not a page: it must never be indexed and must
  // not claim the home page's canonical.
  if (noindex) output = replaceContent(output, /<meta\s+name="robots"[\s\S]*?>/i, "noindex, follow");
  // A shell copied from index.html already carries the home page's canonical.
  output = output.replace(/[ \t]*<link\s+rel="canonical"[^>]*>\s*\n?/i, "");

  const lines = [];
  if (!noindex) lines.push(`    <link rel="canonical" href="${escapeHtml(meta.canonical)}" />`);
  if (!/property="og:url"/.test(output)) {
    lines.push(`    <meta property="og:url" content="${escapeHtml(meta.canonical)}" />`);
  }
  if (meta.type && meta.type !== "website") {
    lines.push(`    <meta property="og:type" content="${escapeHtml(meta.type)}" />`);
  }
  if (meta.page) {
    // Inside <script>, a raw "</script>" in catalogue text would end the block and
    // inject markup, so the usual JSON escaping of <, >, & and the JS line
    // separators is applied before the JSON is embedded.
    const json = JSON.stringify(meta.page)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    lines.push(`    <script type="application/ld+json">${json}</script>`);
  }
  const block = lines.join("\n");
  if (/<\/head>/i.test(output)) return output.replace(/<\/head>/i, `${block}\n  </head>`);
  return `${output}${block}`;
}
