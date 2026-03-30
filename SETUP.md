# PosteriumProxy — Deployment Guide

## Prerequisites

- Node.js 18+
- A Cloudflare account (free tier works)
- `wrangler` CLI authenticated: `npx wrangler login`

---

## Step 1 — Install dependencies

```bash
npm install
```

---

## Step 2 — Create the KV namespace

```bash
npm run kv:create
```

This outputs two IDs — one for production, one for preview. Copy both.

Example output:
```
✨ Success! Created KV namespace "PROXY_CONFIGS" with id "abc123..."
✨ Success! Created KV namespace "PROXY_CONFIGS_preview" with id "def456..."
```

---

## Step 3 — Update wrangler.jsonc

Open `wrangler.jsonc` and replace the placeholder IDs:

```jsonc
"kv_namespaces": [
  {
    "binding": "PROXY_CONFIGS",
    "id": "abc123...",          // ← production ID from step 2
    "preview_id": "def456..."   // ← preview ID from step 2
  }
]
```

---

## Step 4 — Deploy

```bash
npm run deploy
```

Wrangler will print your worker URL, e.g.:
```
https://posterium-proxy.<your-subdomain>.workers.dev
```

Open that URL in your browser — the configure UI will appear.

---

## Step 5 — Local development (optional)

```bash
npm run dev
```

Runs at `http://localhost:8787`.

---

## Usage

1. Open the worker URL in a browser.
2. Paste any Stremio addon's `manifest.json` URL into the **Upstream Addon** field.
3. Set poster/logo/background URL templates. Use `{id}` for the item ID and `{type}` for `movie`/`series`.
4. Toggle features (Catalog, Streams, Search, Library) as needed.
5. Click **Generate Proxy Addon** — a manifest URL is produced.
6. Click **Install in Stremio** or paste the manifest URL directly into Stremio → Add-ons → Community → Paste URL.

### URL Template examples

| Template | Result for `tt0111161` (movie) |
|---|---|
| `https://api.posterium.com/poster/{id}` | `.../poster/tt0111161` |
| `https://api.posterium.com/{type}/{id}/poster` | `.../movie/tt0111161/poster` |
| `https://cdn.example.com/static/poster.jpg` | Same URL for every item |

---

## Architecture

```
Browser → Worker (posterium-proxy)
               │
               ├── GET /                 → static frontend (Workers Assets)
               ├── POST /api/create      → validate upstream, store config in KV, return proxy URL
               ├── GET /api/config/:id   → retrieve stored config
               │
               ├── GET /:id/manifest.json          → proxy + patch manifest
               ├── GET /:id/catalog/:type/:id.json → proxy + replace posters in catalog
               ├── GET /:id/meta/:type/:id.json    → proxy + replace poster/logo/background
               ├── GET /:id/stream/:type/:id.json  → transparent proxy
               └── GET /:id/addon_catalog/...      → transparent proxy
```

Configs are stored in KV with a 1-year TTL.  
Each proxy instance gets a UUID — the ID is stable as long as the KV entry exists.
