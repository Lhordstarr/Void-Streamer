# Void Streamer — Web Edition

Cloudflare Workers backend + static assets (copied from the Electron app).

## Deploy
```bash
cd web
npx wrangler login
npx wrangler deploy
```

## Local dev
```bash
cd web
npx wrangler dev
```

Notes: anime browser sources are not supported in the web edition (use TMDB search instead). Assets are served from `web/public/`.
