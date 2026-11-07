// Production scripts are external files so the CSP can forbid inline scripts.
// React's existing inline style attributes still require unsafe-inline for styles.
export function applySecurityHeaders(res, { development = false, allowPreviewEmbed = false } = {}) {
  const policy = [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
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
