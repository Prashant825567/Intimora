import React, { useState } from "react";
import { X, Copy, Check, MessageCircle, Link } from "lucide-react";
import type { Video } from "../data/mockVideos";
import { shareVideo } from "../services/api";

interface ShareModalProps {
  video: Video;
  onClose: () => void;
}

const ShareModal: React.FC<ShareModalProps> = ({ video, onClose }) => {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}/watch/${video.id}`;

  const trackShare = () => {
    shareVideo(video.id).catch(console.error);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      trackShare();
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const shareOptions = [
    {
      name: "Twitter / X",
      icon: <span className="text-lg font-bold">𝕏</span>,
      color: "#1DA1F2",
      action: () => {
        trackShare();
        window.open(`https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(video.title)}`, "_blank");
      },
    },
    {
      name: "Facebook",
      icon: <span className="text-lg font-bold">f</span>,
      color: "#1877F2",
      action: () => {
        trackShare();
        window.open(`https://facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`, "_blank");
      },
    },
    {
      name: "WhatsApp",
      icon: <MessageCircle className="w-5 h-5" />,
      color: "#25D366",
      action: () => {
        trackShare();
        window.open(`https://wa.me/?text=${encodeURIComponent(video.title + " " + shareUrl)}`, "_blank");
      },
    },
    {
      name: "Copy Link",
      icon: copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />,
      color: "#c9a84c",
      action: handleCopy,
    },
  ];

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80" onClick={onClose} style={{ backdropFilter: "blur(8px)" }}>
      <div
        className="relative w-full max-w-sm mx-4 rounded-2xl p-6 border border-yellow-900/30"
        style={{ background: "#0d0d0d", boxShadow: "0 0 40px rgba(0,0,0,0.9), 0 0 0 1px rgba(201,168,76,0.1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-white font-bold text-lg">Share Video</h3>
          <button onClick={onClose} className="p-2 rounded-full text-gray-500 hover:text-white hover:bg-gray-800 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Video preview */}
        <div className="flex items-center gap-3 p-3 bg-gray-900 rounded-xl mb-5">
          <img src={video.thumbnail} alt={video.title} className="w-16 h-10 object-cover rounded-lg" />
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-medium truncate">{video.title}</p>
            <p className="text-gray-500 text-xs">{video.creator}</p>
          </div>
        </div>

        {/* Share options */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          {shareOptions.map((opt) => (
            <button
              key={opt.name}
              onClick={opt.action}
              className="flex items-center gap-3 p-3 rounded-xl border border-gray-800 hover:border-gray-600 transition-all hover:scale-105"
              style={{ background: "#111" }}
            >
              <span style={{ color: opt.color }}>{opt.icon}</span>
              <span className="text-sm text-gray-300">{opt.name}</span>
            </button>
          ))}
        </div>

        {/* URL input */}
        <div className="flex items-center gap-2 p-3 bg-gray-900 rounded-xl border border-gray-800">
          <Link className="w-4 h-4 text-gray-500 flex-shrink-0" />
          <span className="text-gray-500 text-xs flex-1 truncate font-mono">{shareUrl}</span>
          <button
            onClick={handleCopy}
            className="px-3 py-1 rounded-lg text-xs font-bold transition-all"
            style={{ background: "linear-gradient(135deg, #c9a84c, #f0d080)", color: "#000" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareModal;
