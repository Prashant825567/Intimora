// Production scripts are external files so the CSP can forbid inline scripts.
// React's existing inline style attributes still require unsafe-inline for styles.
export function applySecurityHeaders(res, { development = false, allowPreviewEmbed = false } = {}) {
  const policy = [
    "default-src 'self'",
    `script-src 'self' https://apis.google.com${development ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Firebase's Google sign-in uses its hosted auth iframe and Google APIs.
    // The sponsored TubeCorporate campaign frames are the only partner frames.
    "frame-src 'self' https://intimora-app.firebaseapp.com https://accounts.google.com https://hdzog.com https://desi-porntube.com",
    // The static client contacts the public discovery service and its selected
    // HTTPS backend directly; the rest of the policy remains restrictive.
    "img-src 'self' data: https:",
    "media-src 'self' blob: https:",
    `connect-src 'self' https:${development ? " ws: wss:" : ""}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    ...(!development && !allowPreviewEmbed ? ["frame-ancestors 'none'"] : []),
  ].join("; ");

  res.setHeader("Content-Security-Policy", policy);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (!development && !allowPreviewEmbed) res.setHeader("X-Frame-Options", "DENY");
}
