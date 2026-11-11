import React, { useEffect, useState } from "react";

// The partner campaign supplies these frames. The feed is read at build time and
// published as same-origin JSON, so only the (validated) embed pages are ever
// contacted — lazily, after the age gate, and without a referrer.
const MAX_FEED_FRAMES = 9;

const useFeedEmbeds = (enabled: boolean): string[] | null => {
  const [embeds, setEmbeds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    fetch("/partner-feed.json", {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller?.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (!active) return;
        const items = Array.isArray((payload as { items?: unknown })?.items) ? (payload as { items: unknown[] }).items : [];
        setEmbeds(
          items
            .filter((item): item is string => typeof item === "string" && item.startsWith("https://"))
            .slice(0, MAX_FEED_FRAMES),
        );
      })
      .catch(() => {
        if (active) setEmbeds([]);
      });
    return () => {
      active = false;
      controller?.abort();
    };
  }, [enabled]);
  return embeds;
};

const Header: React.FC<{ title: string }> = ({ title }) => (
  <div className="flex items-center gap-3 mb-4">
    <span
      className="text-[10px] font-bold tracking-[0.2em] uppercase px-2 py-1 rounded"
      style={{ background: "#1a1a1a", color: "#c9a84c", border: "1px solid #2a2a2a" }}
    >
      Sponsored
    </span>
    <h2 className="text-white font-bold text-lg">{title}</h2>
  </div>
);

const Frame: React.FC<{ src: string; title: string }> = ({ src, title }) => (
  <div
    className="w-full rounded-xl overflow-hidden partner-embed__frame"
    style={{ aspectRatio: "16 / 9", border: "1px solid #1e1e1e", background: "#000" }}
  >
    <iframe
      src={src}
      title={title}
      className="w-full h-full block"
      loading="lazy"
      referrerPolicy="no-referrer"
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowFullScreen
    />
  </div>
);

interface PartnerEmbedProps {
  // "feed" reads the published campaign grid, "embed" renders one iframe.
  mode?: "feed" | "embed";
  url?: string;
}

const PartnerEmbed: React.FC<PartnerEmbedProps> = ({ mode = "embed", url = "" }) => {
  const isFeed = mode === "feed";
  const feedEmbeds = useFeedEmbeds(isFeed);

  if (!isFeed) {
    if (!url) return null;
    return (
      <section aria-label="Sponsored partner videos" className="mt-14">
        <Header title="More videos from our partner" />
        <Frame src={url} title="Sponsored partner videos" />
      </section>
    );
  }

  // An empty or unreadable feed simply omits the section instead of showing an
  // empty shell or a broken frame.
  if (!feedEmbeds || feedEmbeds.length === 0) return null;
  return (
    <section aria-label="Sponsored partner videos" className="mt-14">
      <Header title="More videos from our partner" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {feedEmbeds.map((src, index) => (
          <Frame key={src} src={src} title={`Sponsored partner video ${index + 1}`} />
        ))}
      </div>
    </section>
  );
};

export default PartnerEmbed;
