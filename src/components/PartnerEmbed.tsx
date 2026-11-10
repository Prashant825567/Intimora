import React from "react";

// The partner campaign supplies this iframe. It is loaded lazily after the age
// gate, without a referrer, and only from the validated campaign URL.
const PartnerEmbed: React.FC<{ url: string }> = ({ url }) => (
  <section aria-label="Sponsored partner videos" className="mt-14">
    <div className="flex items-center gap-3 mb-4">
      <span
        className="text-[10px] font-bold tracking-[0.2em] uppercase px-2 py-1 rounded"
        style={{ background: "#1a1a1a", color: "#c9a84c", border: "1px solid #2a2a2a" }}
      >
        Sponsored
      </span>
      <h2 className="text-white font-bold text-lg">More videos from our partner</h2>
    </div>
    <div
      className="w-full rounded-xl overflow-hidden partner-embed__frame"
      style={{ aspectRatio: "16 / 9", border: "1px solid #1e1e1e", background: "#000" }}
    >
      <iframe
        src={url}
        title="Sponsored partner videos"
        className="w-full h-full block"
        loading="lazy"
        referrerPolicy="no-referrer"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
      />
    </div>
  </section>
);

export default PartnerEmbed;
