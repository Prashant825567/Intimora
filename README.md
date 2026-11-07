# Intimora

Intimora is a React + Vite frontend with a Node server. The browser uses only same-origin `/_api` routes; the server discovers and contacts the upstream API privately. Catalog responses are reduced to the fields used by the UI, media URLs and pagination cursors are encrypted into short-lived opaque tokens, and errors never forward upstream details. Media byte ranges are preserved.

## Configuration

Copy `.env.example` to `.env` for local development and set **one** of these server-only variables:

- `API_DISCOVERY_URL`: the HTTPS discovery endpoint that returns `{ "ok": true, "data": { "server": "https://…" } }`.
- `API_PROXY_UPSTREAM`: an optional fixed HTTPS API base, used instead of discovery when set.

With discovery enabled, the Node server reads `data.server` separately for each new browser-tab session and appends the permitted `/api/...` routes. An encrypted, opaque selection is cached in that tab for at most 60 seconds; the next API request after expiry performs discovery again. Other visitors do not share this cache, although the discovery service may choose the same backend for multiple visitors. Previously issued media and pagination links remain pinned to the backend that produced them so playback and scrolling continue across a refresh. The browser calls the same-origin `/_api/...` routes and does not contact discovery or the upstream directly.

This is a browser-tab session, not an authenticated identity. The opaque selection uses session storage with an in-memory fallback if storage is blocked. Reloading the same tab can reuse its unexpired choice; closing or clearing the session causes a new discovery. Some browsers copy session storage when duplicating a tab or opening one from another tab.

For per-visitor discovery on Render, set `API_DISCOVERY_URL` privately and leave `API_PROXY_UPSTREAM` unset; the fixed upstream takes precedence and bypasses discovery if both are set.

Keep these values and all credentials on the server. Never use a `VITE_` or `INTIMORA_PUBLIC_` prefix for secrets, put secrets in `public/`, or commit `.env` files, private keys or credentials. `.gitignore` prevents newly added local env files from being tracked; it cannot remove anything already committed in Git history.

Additional settings:

- `API_ALLOWED_HOSTS` (recommended): comma-separated, exact API hostnames permitted from discovery. Update this list when legitimate upstream hosts change. Wildcards are not accepted.
- `API_MEDIA_ALLOWED_HOSTS`: comma-separated, exact external media CDN hostnames. Media on the API origin works automatically; other hosts and redirects are blocked unless explicitly allowed. If an external media URL is not allowed, the standard `/api/videos/:id/thumbnail` or `/stream` API route is used instead.
- `PROXY_TOKEN_SECRET`: at least 32 random characters, shared by all running instances. Render can generate this automatically. Without it, a random per-process key is used and visitor selections or pagination/media tokens stop working after a restart or when requests reach another instance. Visitor selections last up to 60 seconds; media and cursor tokens expire after 24 hours.
- `API_ALLOW_LOOPBACK=1`: **development only**, for testing against a local HTTP API. Production rejects private and loopback network targets.

The proxy permits only the catalog, search, video, thumbnail, stream, like and share routes. It does not proxy admin endpoints, cookies, browser authorization headers, arbitrary destination URLs, or raw upstream error responses. Public upstreams must use HTTPS on its standard port. Production adds a restrictive Content Security Policy and other security headers. Upstream image and video content types and redirects are restricted; configure the media host allowlist when needed.

## Local development

```bash
cp .env.example .env  # add the discovery URL or fixed upstream privately
npm ci
npm run dev           # http://localhost:5173
npm test
npm run typecheck
```

The development server can start even if discovery is unavailable; visitors see a generic retry message rather than a server address or error details.

The mobile layout regression test runs when Chromium is available. Install it once with `npx playwright-core install chromium`, or set `CHROMIUM_PATH` to an existing Chromium executable before running `npm test`. Without a browser the layout test is skipped; the other tests still run.

To run the production server locally:

```bash
npm run build
PORT=5173 npm start
```

For an embedded development preview only, `ALLOW_PREVIEW_EMBED=1` disables the production framing restriction. Do not set it on the public deployment.

## Deploy on Render

The Blueprint in `render.yaml` now creates a **Node Web Service**, not a Static Site: a server is necessary to keep upstream configuration and response details out of the browser.

1. Create or update a Render Blueprint from this repository. An existing Static Site may need to be replaced by a new Web Service; configure its custom domain and deployment branch as appropriate.
2. Set `API_DISCOVERY_URL` privately in Render's environment settings. Alternatively, configure `API_PROXY_UPSTREAM` and leave discovery unset. Set the host allowlists when applicable. If migrating from the old Static Site, copy the value of its `VITE_API_DISCOVERY_URL` into the new Web Service's private `API_DISCOVERY_URL` setting; do not add the old `VITE_` variable to the new service or commit the value.
3. Render runs `npm ci --include=dev && npm run build`, then `npm start`. `PROXY_TOKEN_SECRET` is generated by the Blueprint and must be the same across instances.
4. Confirm that your upstream permits server-to-server requests and that its media routes support `Range`, `206`, `Content-Range` and `Accept-Ranges`. If media redirects to a CDN, add that exact hostname to `API_MEDIA_ALLOWED_HOSTS`.
5. Verify catalog, search, and playback on the deployed site. If the catalog is unavailable, check the private environment settings and outbound network access without exposing the upstream address or credentials in browser output.

## Security boundaries

A URL is not an authentication secret, and hiding it is not access control. The previous client and public discovery endpoint already exposed the API address; anyone who recorded it or can query that existing endpoint may still know it. Restrict or replace that discovery endpoint and protect the upstream API itself with appropriate authentication, authorization, rate limiting and network controls. Rotate any actual credentials that were ever exposed or committed. The client-side 18+ confirmation is not identity or age verification. No frontend or proxy can guarantee that future secrets are never leaked; review upstream responses, deployment configuration and access controls as well.
