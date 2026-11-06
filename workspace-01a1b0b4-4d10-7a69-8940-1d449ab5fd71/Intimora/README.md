# Intimora

Intimora is a React + Vite frontend that loads its catalog and media from the real Intimora API. The frontend uses the Worker discovery endpoint to find the current API server; it does not substitute mock/demo catalog data.

## Deploy as a Render Static Site

This repository is configured for a Render **Static Site** in `render.yaml`.

1. Push the project to GitHub on the `master` branch.
2. In Render, select **New → Blueprint**, connect the repository, and apply `render.yaml`.
3. Render builds the app and publishes the `dist` directory. The `render.yaml` environment values can be changed in the Render Dashboard if the API discovery or fallback URL changes.
4. Copy the actual `onrender.com` origin Render assigns to the site and ensure the API backend allows that exact origin. If you use a custom domain, allow that origin too.

### Render settings (if creating the service manually)

- **Service type:** Static Site
- **Build Command:** `npm ci && npm run build`
- **Publish Directory:** `dist`
- **Start Command:** none (static sites do not run a start process)
- **Environment variables:**
  - `VITE_API_DISCOVERY_URL` = `https://intimora.tmc78lxnu.workers.dev/api/get-server`
  - `VITE_API_BASE_URL` = `https://api-intimora.vercel.app`

These Vite variables are injected at build time and are public values, not secrets. The browser requests the API and media directly, so the API must send the correct CORS headers and the media endpoints must allow cross-origin resource loading. The video stream must continue to honor byte ranges (`206`, `Content-Range`, `Accept-Ranges`).

## Local development

```bash
npm ci
npm run dev
```

Vite runs on port 5173. In development, API requests use the Vite proxy; in the production static build, they use the API URL discovered by the Worker.
