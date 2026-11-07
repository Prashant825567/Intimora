# Intimora

Intimora is a React + Vite frontend designed to run as a **Render Static Site**. The browser calls the public discovery Worker, reads `data.server` from `{ "ok": true, "data": { "server": "https://…" } }`, and calls that backend directly, appending routes such as `/api/videos`. No proxy is required by the static site.

## Discovery and routing

The existing public Worker is the default. To use a different public endpoint, set `INTIMORA_PUBLIC_API_DISCOVERY_URL` at **build time** (see `.env.example`). It must be an HTTPS URL without credentials, a query string, or a fragment. The build rejects invalid values without printing them. The variable and Worker URL are public, not secrets.

Discovery starts on arrival, including while the age gate is open. Each new browser tab/navigation starts its own discovery; concurrent requests in that tab share it. The selection is cached for at most 60 seconds from the start of discovery, using session storage with an in-memory fallback. Reloading the same tab may reuse its own unexpired selection. A new navigation does not reuse an entry copied from another tab. When it expires, the next request refreshes discovery; videos and pagination cursors already loaded remain pinned to their original backend. Media elements contact that backend directly and support its byte-range responses. Likes and share tracking also use the video's original backend.

Shared `/watch/<id>` links do not contain a backend address. A recipient discovers their own backend and opens that ID there. The backends therefore need to serve the same video IDs for links to work across visitors. A missing video or failed request shows a generic message without a server address.

## Security and CORS

Direct access means the discovery response, selected backend URL, API responses and network requests are visible in browser developer tools. **Do not send secrets, tokens, signed URLs, private error details, or other confidential data in public Worker/backend responses or public build variables.** The frontend can filter displayed fields, but it cannot hide a response that the browser has already received. Secrets belong in backend-only environment variables and must not be committed. Public URLs and CORS are not authentication: protect sensitive backend routes with proper authentication, authorization and rate limits. The age gate is not age or identity verification.

Every selectable backend and the Worker must allow the deployed site's exact origin in CORS (or `*` for public, credential-free access). Allow `GET`, `POST`, `HEAD` and `OPTIONS`; permit `Content-Type` and `Range` on preflight requests. Thumbnail and stream responses must also allow the origin, including byte-range responses. A stream should support `Range`, `206 Partial Content`, `Content-Range` and `Accept-Ranges`. The client omits credentials and referrers; it does not follow API redirects. It accepts only public HTTPS discovery/backend URLs without credentials or query strings and uses the standard video media routes instead of arbitrary third-party media URLs.

The static site's CSP permits HTTPS connections, images and media because discovery can select different public hosts, while keeping scripts restricted to the site. If all legitimate backend and Worker hosts are known and stable, narrow those HTTPS sources in Render's Content Security Policy. Other security headers and a `no-referrer` policy are included in the Blueprint. CORS is enforced by browsers, not by curl or other servers.

## Local development

```bash
npm ci
npm run dev           # listens on port 5173
npm test
npm run typecheck
npm run build
```

Ensure the Worker and backends allow the **actual browser origin** in CORS, including a remote development-preview origin if used. `http://localhost:5173` and a proxied preview URL are different origins. There is no development API proxy. If the backend does not allow the preview origin, the preview will show the generic unavailable state until that CORS setting is updated. The development server remains available even when discovery fails.

Browser tests run when Chromium is installed (`npx playwright-core install chromium`) or `CHROMIUM_PATH` points to an existing executable; otherwise browser tests are skipped. The legacy Node server and its proxy regression tests remain in the repository for compatibility, but the static frontend does not use those routes.

## Deploy to the existing Render Static Site

1. Keep the existing Static Site and point it at the deployment branch containing these changes. Set the build command to `npm ci --include=dev && npm run build` and the publish directory to `dist`. Node 20.19+ or a supported Node 22 release is required. No Node start command or proxy secret is needed.
2. The existing public Worker is the default. Only if changing it, set `INTIMORA_PUBLIC_API_DISCOVERY_URL` in Render's build environment and redeploy. This value is deliberately bundled into browser code; never put a secret in it.
3. Add a **Rewrite** from `/watch/*` to `/index.html` for shared links. Apply the security headers shown in `render.yaml`, adjusting the CSP sources if appropriate. The Blueprint describes a Static Site; if the existing site was configured manually rather than through this Blueprint, add the rewrite and headers in the Render dashboard. Changing `render.yaml` alone does not update an unlinked site.
4. Confirm CORS for the production origin on the Worker and every selected backend, including media/range and POST/OPTIONS responses. Then check the catalog, search, playback, likes, sharing and pagination in a real browser. A generic unavailable message can mean discovery, CORS, backend availability, or network configuration failed; inspect deployment and backend logs privately.

Local changes and tests do not configure or deploy the existing Render service. Rotate any credentials that were previously exposed or committed and review the backend's public responses before deployment.
