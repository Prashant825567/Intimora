# Intimora

Intimora is a React + Vite frontend that loads its catalog and media from the real Intimora API. At runtime it asks the Worker discovery endpoint which API server to use; the production build does not pin the API base to a fixed host.

## Deploy as a Render Static Site

This repository is configured for a Render **Static Site** in `render.yaml`.

1. Push the project to GitHub on the `master` branch.
2. In Render, select **New → Blueprint**, connect the repository, and apply `render.yaml`.
3. Render builds the app and publishes the `dist` directory. New commits to `master` trigger another deploy.
4. Ensure the API backend allows the exact Render origin that Render assigns to the site. If you add a custom domain, allow that origin too.

### Render settings (if creating the service manually)

- **Service type:** Static Site
- **Build Command:** `npm ci && npm run build`
- **Publish Directory:** `dist`
- **Start Command:** none (static sites do not run a start process)
- **Environment variable:**
  - `VITE_API_DISCOVERY_URL` = `https://intimora.tmc78lxnu.workers.dev/api/get-server`

This is the discovery endpoint, not a fixed API base. The browser reads `data.server` from its response and uses that URL for catalog, search, thumbnails, and video requests. The environment value is public, not a secret.

The API must allow the Render origin through CORS, and its media routes must allow cross-origin resource loading while preserving byte ranges (`206`, `Content-Range`, `Accept-Ranges`).

## Local development

```bash
npm ci
npm run dev
```

Vite discovers the current API host from the same Worker and uses a development proxy. The production static build instead uses the Worker discovery response directly in the browser.
