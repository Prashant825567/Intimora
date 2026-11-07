// Hide the retired tier label in the UI without changing or filtering videos.
export const isPremiumLabel = (value: string): boolean =>
  value.trim().replace(/^#+\s*/, "").toLowerCase() === "premium";
