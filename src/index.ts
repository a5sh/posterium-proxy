// src/index.ts  — PosteriumProxy v3

export interface Env {
  PROXY_CONFIGS: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;   // default: "admin123"
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_ADMIN_PW     = "admin123";
const VALID_RESOURCES      = new Set(["catalog", "meta", "stream", "subtitles", "addon_catalog"]);
const VALID_TYPES          = new Set(["movie", "series", "channel", "tv"]);
const VALID_POSTER_SHAPES  = new Set(["", "square", "poster", "landscape"]);
const MANIFEST_MAX_BYTES   = 8192;

// Default edge-cache TTLs when config TTL = 0  (seconds)
const DEF_CATALOG_TTL  = 1800;   // 30 min
const DEF_META_TTL     = 86400;  // 24 hr
const DEF_STREAM_TTL   = 300;    // 5 min
const DEF_SUBTITLE_TTL = 3600;   // 1 hr

// ─── Data model ────────────────────────────────────────────────────────────────

interface ProxyConfig {
  id:               string;
  password:         string;   // user-set, required to edit/delete
  upstreamBaseUrl:  string;
  cacheGeneration:  number;   // increment = flush edge cache

  // ── Artwork overrides ──────────────────────────────────────────────────────
  posterUrl:     string;
  logoUrl:       string;
  backgroundUrl: string;
  bannerUrl:     string;
  thumbnailUrl:  string;   // episode/video thumbnails
  posterShape:   "" | "square" | "poster" | "landscape";

  // ── Text overrides ─────────────────────────────────────────────────────────
  namePrefix:        string;
  nameSuffix:        string;
  descriptionPrefix: string;
  descriptionSuffix: string;

  // ── Resource toggles ───────────────────────────────────────────────────────
  enableCatalog:   boolean;
  enableMeta:      boolean;
  enableStreams:   boolean;
  enableSubtitles: boolean;
  enableSearch:    boolean;

  // ── Content filters ────────────────────────────────────────────────────────
  allowedTypes:      string[];
  forceHttpsStreams:  boolean;
  stripTorrents:      boolean;
  stripMagnetStreams: boolean;
  stripAdultFlag:     boolean;
  stripP2PFlag:       boolean;
  offlineCache:       boolean;
  removeTrailers:     boolean;
  removeHeavyArtwork: boolean;

  // ── Stream transforms (NEW) ────────────────────────────────────────────────
  idPrefixFilter:        string[];   // only proxy IDs with these prefixes, empty=all
  maxStreams:            number;     // 0 = unlimited
  streamSortBy:         "none" | "quality_desc" | "name_asc";
  streamNamePrefix:     string;
  streamNameSuffix:     string;
  removeDuplicateStreams: boolean;

  // ── Metadata filters (NEW) ─────────────────────────────────────────────────
  minImdbRating: number;    // 0 = no filter; filters catalog metas
  allowedGenres: string[];  // empty = all genres

  // ── Subtitles ──────────────────────────────────────────────────────────────
  subtitleLanguages: string[];

  // ── Cache TTL overrides (0 = use defaults above) ──────────────────────────
  catalogCacheTtl:  number;
  metaCacheTtl:     number;
  streamCacheTtl:   number;
  subtitleCacheTtl: number;

  createdAt: number;
  updatedAt: number;
}

// ─── Stremio types ─────────────────────────────────────────────────────────────

interface StremioManifest {
  id: string; version: string; name: string; description?: string;
  resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types: string[]; catalogs: StremioManifestCatalog[];
  idPrefixes?: string[];
  addonCatalogs?: StremioManifestCatalog[];
  behaviorHints?: { adult?: boolean; p2p?: boolean; configurable?: boolean; configurationRequired?: boolean; [k: string]: unknown };
  background?: string; logo?: string; contactEmail?: string;
  [k: string]: unknown;
}

interface StremioManifestCatalog {
  type: string; id: string; name?: string;
  extra?: { name: string; isRequired?: boolean; options?: string[]; optionsLimit?: number }[];
  [k: string]: unknown;
}

interface StremioMeta {
  id: string; type: string; name?: string;
  poster?: string; posterShape?: string; logo?: string; background?: string; banner?: string;
  description?: string; imdbRating?: string; genres?: string[];
  videos?: StremioVideo[]; trailers?: unknown;
  [k: string]: unknown;
}

interface StremioVideo {
  id: string; title?: string; thumbnail?: string;
  released?: string; season?: number; episode?: number;
  trailers?: unknown; trailer?: unknown;
  [k: string]: unknown;
}

interface StremioStream {
  url?: string; infoHash?: string; fileIdx?: number;
  ytId?: string; externalUrl?: string;
  name?: string; title?: string; description?: string;
  behaviorHints?: { notWebReady?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

interface StremioSubtitle { id: string; url: string; lang: string; }

// ─── Validation ────────────────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean; errors: string[]; warnings: string[];
  manifest?: StremioManifest;
  resources: string[]; types: string[];
  hasCatalog: boolean; hasMeta: boolean; hasStream: boolean; hasSubtitles: boolean;
}

function validateManifest(raw: unknown): ValidationResult {
  const result: ValidationResult = { valid: false, errors: [], warnings: [], resources: [], types: [], hasCatalog: false, hasMeta: false, hasStream: false, hasSubtitles: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { result.errors.push("Manifest must be a JSON object"); return result; }
  const m = raw as Record<string, unknown>;
  for (const f of ["id", "name", "version"] as const)
    if (typeof m[f] !== "string" || !(m[f] as string).trim()) result.errors.push(`manifest.${f} must be a non-empty string`);
  if (typeof m.id === "string") {
    if (!/^[a-zA-Z0-9._-]+$/.test(m.id)) result.errors.push(`manifest.id "${m.id}" must only contain alphanumerics, dots, dashes, underscores`);
    if (m.id.length > 128) result.errors.push("manifest.id is suspiciously long (>128 chars)");
  }
  if (typeof m.version === "string" && !/^\d+\.\d+\.\d+/.test(m.version))
    result.warnings.push(`manifest.version "${m.version}" should follow semver`);
  if (typeof m.description !== "string" || !m.description.trim())
    result.warnings.push("manifest.description is missing or empty");
  if (!Array.isArray(m.resources) || m.resources.length === 0) {
    result.errors.push("manifest.resources must be a non-empty array");
  } else {
    for (const r of m.resources) {
      const name = typeof r === "string" ? r : (typeof r === "object" && r !== null ? (r as Record<string, unknown>).name : undefined);
      if (typeof name !== "string" || !name) { result.errors.push("manifest.resources contains an invalid resource format"); continue; }
      if (!VALID_RESOURCES.has(name)) result.warnings.push(`manifest.resources contains unknown resource "${name}"`);
      result.resources.push(name);
    }
    result.hasCatalog   = result.resources.includes("catalog");
    result.hasMeta      = result.resources.includes("meta");
    result.hasStream    = result.resources.includes("stream");
    result.hasSubtitles = result.resources.includes("subtitles");
  }
  if (!Array.isArray(m.types) || m.types.length === 0) {
    result.errors.push("manifest.types must be a non-empty array");
  } else {
    for (const t of m.types) {
      if (!VALID_TYPES.has(t as string)) result.warnings.push(`manifest.types contains unknown type "${t}"`);
      result.types.push(t as string);
    }
  }
  if (!Array.isArray(m.catalogs)) {
    result.errors.push("manifest.catalogs must be an array (use [] if you have none)");
  } else {
    for (let i = 0; i < m.catalogs.length; i++) {
      const cat = m.catalogs[i] as Record<string, unknown>;
      if (typeof cat.type !== "string" || !cat.type) result.errors.push(`catalogs[${i}].type is required`);
      if (typeof cat.id !== "string" || !cat.id) result.errors.push(`catalogs[${i}].id is required`);
    }
    if (result.hasCatalog && m.catalogs.length === 0) result.warnings.push('"catalog" in resources but catalogs array is empty');
    if (m.catalogs.length > 50) result.errors.push(`Too many catalogs (${m.catalogs.length}). Max 50.`);
  }
  const sizeBytes = new TextEncoder().encode(JSON.stringify(m)).length;
  if (sizeBytes > MANIFEST_MAX_BYTES) result.errors.push(`Manifest is ${sizeBytes} bytes — exceeds ${MANIFEST_MAX_BYTES}-byte limit`);
  for (const field of ["id", "name", "description", "version", "contactEmail"] as const) {
    const v = m[field];
    if (typeof v === "string" && (/<script/i.test(v) || /javascript:/i.test(v) || /data:/i.test(v)))
      result.errors.push(`manifest.${field} contains potentially unsafe content`);
  }
  result.valid = result.errors.length === 0;
  if (result.valid) result.manifest = m as StremioManifest;
  return result;
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const err = (msg: string, status = 400, details?: unknown) =>
  json({ error: msg, ...(details ? { details } : {}) }, status);

// Send to Stremio with no-store (always fresh for Stremio)
// but we serve from our internal edge cache for speed
function jsonToStremio(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ─── Auth helpers ───────────────────────────────────────────────────────────────

function getAdminPassword(env: Env): string {
  return env.ADMIN_PASSWORD || DEFAULT_ADMIN_PW;
}

function checkBasicAuth(header: string, env: Env): boolean {
  try {
    const [, b64] = header.split(" ");
    const [, pw] = atob(b64).split(":");
    return pw === getAdminPassword(env);
  } catch { return false; }
}

function getBearerToken(request: Request): string {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// ─── Edge-cache helpers (Cloudflare Cache API) ──────────────────────────────────

const CACHE_HOST = "https://pp-cache.internal";

function edgeCacheKey(cfg: ProxyConfig, resource: string, type: string, id: string): string {
  return `${CACHE_HOST}/${cfg.id}/v${cfg.cacheGeneration}/${resource}/${type}/${encodeURIComponent(id)}`;
}

async function getCached(key: string): Promise<unknown | null> {
  try {
    const c = await caches.default.match(new Request(key));
    return c ? c.json() : null;
  } catch { return null; }
}

async function setCached(key: string, data: unknown, ttl: number): Promise<void> {
  if (ttl <= 0) return;
  try {
    await caches.default.put(
      new Request(key),
      new Response(JSON.stringify(data), { headers: { "Cache-Control": `max-age=${ttl}, public` } }),
    );
  } catch { /* non-fatal */ }
}

// Flush = increment generation; old keys become unreachable and expire naturally
async function flushProxyCache(cfg: ProxyConfig, env: Env): Promise<void> {
  cfg.cacheGeneration = (cfg.cacheGeneration || 0) + 1;
  cfg.updatedAt = Date.now();
  await putConfig(cfg, env);
}

// ─── Config helpers ─────────────────────────────────────────────────────────────

async function getConfig(id: string, env: Env): Promise<ProxyConfig | null> {
  const raw = await env.PROXY_CONFIGS.get(`proxy:${id}`);
  return raw ? (JSON.parse(raw) as ProxyConfig) : null;
}

async function putConfig(cfg: ProxyConfig, env: Env): Promise<void> {
  await env.PROXY_CONFIGS.put(`proxy:${cfg.id}`, JSON.stringify(cfg), { expirationTtl: 60 * 60 * 24 * 365 });
}

// ─── URL helpers ────────────────────────────────────────────────────────────────

function applyTemplate(template: string | undefined, vars: Record<string, string | number>): string | undefined {
  if (!template) return undefined;
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k]; return v !== undefined ? encodeURIComponent(String(v)) : `{${k}}`;
  });
}

function normalizeBase(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith("/manifest.json")) url = url.slice(0, -"/manifest.json".length);
  return url;
}

async function proxyFetch(url: string, timeoutMs = 9000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "PosteriumProxy/3.0 (Stremio Addon Proxy)" },
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(t); }
}

// ─── Stream quality parser (for sorting) ───────────────────────────────────────

const QUALITY_MAP: Record<string, number> = {
  "4k": 4, "2160p": 4, "uhd": 4,
  "1080p": 3, "fhd": 3,
  "720p": 2, "hd": 2,
  "480p": 1, "sd": 1,
};

function qualityScore(stream: StremioStream): number {
  const text = ((stream.name || "") + " " + (stream.description || "") + " " + (stream.title || "")).toLowerCase();
  for (const [key, score] of Object.entries(QUALITY_MAP)) if (text.includes(key)) return score;
  return 0;
}

// ─── Content transformers ───────────────────────────────────────────────────────

function patchMeta(meta: StremioMeta, cfg: ProxyConfig): StremioMeta {
  const vars = { id: meta.id, type: meta.type };
  const out = { ...meta };

  const poster     = applyTemplate(cfg.posterUrl,     vars);
  const logo       = applyTemplate(cfg.logoUrl,       vars);
  const background = applyTemplate(cfg.backgroundUrl, vars);
  const banner     = applyTemplate(cfg.bannerUrl,     vars);
  if (poster)     out.poster     = poster;
  if (logo)       out.logo       = logo;
  if (background) out.background = background;
  if (banner)     out.banner     = banner;

  if (cfg.removeHeavyArtwork) { delete out.background; delete out.banner; }
  if (cfg.removeTrailers)     { delete out.trailers; }

  if (cfg.posterShape && VALID_POSTER_SHAPES.has(cfg.posterShape)) out.posterShape = cfg.posterShape;

  if (cfg.descriptionPrefix || cfg.descriptionSuffix)
    out.description = `${cfg.descriptionPrefix}${out.description ?? ""}${cfg.descriptionSuffix}`.trim();

  if (Array.isArray(out.videos)) {
    out.videos = (out.videos as StremioVideo[]).map((v) => {
      const vOut = { ...v };
      if (cfg.thumbnailUrl) {
        const thumb = applyTemplate(cfg.thumbnailUrl, { id: v.id, type: meta.type, season: v.season ?? "", episode: v.episode ?? "" });
        if (thumb) vOut.thumbnail = thumb;
      }
      if (cfg.removeTrailers) { delete vOut.trailers; delete vOut.trailer; }
      return vOut;
    });
  }
  return out;
}

function transformStreams(streams: StremioStream[], cfg: ProxyConfig): StremioStream[] {
  let out: StremioStream[] = [];

  for (const stream of streams) {
    // Strip filters
    if (cfg.stripTorrents && stream.infoHash) continue;
    if (cfg.stripMagnetStreams && typeof stream.url === "string" && stream.url.startsWith("magnet:")) continue;

    const s = { ...stream };

    // HTTPS rewrite
    if (cfg.forceHttpsStreams && typeof s.url === "string" && s.url.startsWith("http://"))
      s.url = s.url.replace(/^http:\/\//, "https://");

    // Name transforms
    if (cfg.streamNamePrefix || cfg.streamNameSuffix) {
      const base = s.name || s.description || "";
      s.name = `${cfg.streamNamePrefix}${base}${cfg.streamNameSuffix}`.trim() || s.name;
    }

    out.push(s);
  }

  // Deduplicate by URL / infoHash
  if (cfg.removeDuplicateStreams) {
    const seen = new Set<string>();
    out = out.filter((s) => {
      const key = s.url || s.infoHash || s.ytId || JSON.stringify(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Sort
  if (cfg.streamSortBy === "quality_desc") out.sort((a, b) => qualityScore(b) - qualityScore(a));
  else if (cfg.streamSortBy === "name_asc") out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  // Limit
  if (cfg.maxStreams > 0 && out.length > cfg.maxStreams) out = out.slice(0, cfg.maxStreams);

  return out;
}

function filterMetas(metas: StremioMeta[], cfg: ProxyConfig): StremioMeta[] {
  return metas.filter((m) => {
    if (cfg.minImdbRating > 0 && m.imdbRating) {
      const r = parseFloat(m.imdbRating);
      if (!isNaN(r) && r < cfg.minImdbRating) return false;
    }
    if (cfg.allowedGenres.length > 0 && Array.isArray(m.genres) && m.genres.length > 0) {
      const hasMatch = m.genres.some((g) => cfg.allowedGenres.includes(g.toLowerCase()));
      if (!hasMatch) return false;
    }
    return true;
  });
}

function patchManifest(manifest: StremioManifest, cfg: ProxyConfig, workerUrl: string): StremioManifest {
  const out = { ...manifest };
  out.id = `com.posteriumproxy.${cfg.id}`;

  const origName = manifest.name ?? "";
  out.name = `${cfg.namePrefix}${origName}${cfg.nameSuffix}`.trim() || origName;

  if (cfg.descriptionPrefix || cfg.descriptionSuffix)
    out.description = `${cfg.descriptionPrefix}${manifest.description ?? ""}${cfg.descriptionSuffix}`.trim();
  out.description = `[PosteriumProxy] ${out.description ?? ""}`.trim();

  const bh = { ...(manifest.behaviorHints ?? {}) };
  if (cfg.stripAdultFlag) delete bh.adult;
  if (cfg.stripP2PFlag)   delete bh.p2p;
  bh.configurable = true;   // allow user to reconfigure via /:id/configure
  bh.configurationRequired = false;
  out.behaviorHints = bh;

  // Add configure URL in description for discoverability
  out.description += ` — Configure: ${workerUrl}/${cfg.id}/configure`;

  out.resources = manifest.resources.filter((r) => {
    const name = typeof r === "string" ? r : r.name;
    if (name === "catalog"   && !cfg.enableCatalog)   return false;
    if (name === "meta"      && !cfg.enableMeta)       return false;
    if (name === "stream"    && !cfg.enableStreams)     return false;
    if (name === "subtitles" && !cfg.enableSubtitles)  return false;
    return true;
  });

  if (cfg.allowedTypes.length > 0) {
    out.types = manifest.types.filter((t) => cfg.allowedTypes.includes(t));
    out.resources = out.resources.map((r) => {
      if (typeof r === "string") return r;
      const types = (r.types ?? []).filter((t) => cfg.allowedTypes.includes(t));
      return { ...r, types };
    }).filter((r) => typeof r === "string" || !r.types || r.types.length > 0);
  }

  if (cfg.idPrefixFilter.length > 0) {
    // Override idPrefixes to limit which IDs we proxy
    out.idPrefixes = cfg.idPrefixFilter;
  }

  if (Array.isArray(out.catalogs)) {
    let cats = out.catalogs as StremioManifestCatalog[];
    if (cfg.allowedTypes.length > 0) cats = cats.filter((c) => cfg.allowedTypes.includes(c.type));
    if (!cfg.enableSearch) cats = cats.map((c) => ({ ...c, extra: (c.extra ?? []).filter((e) => e.name !== "search") }));
    out.catalogs = cats;
  }

  return out;
}

// ─── Proxy fetch with edge cache ────────────────────────────────────────────────

async function fetchWithCache(
  cfg: ProxyConfig, resource: string, type: string, id: string,
  upstreamUrl: string, defaultTtl: number, configTtl: number,
): Promise<unknown> {
  const ttl = configTtl > 0 ? configTtl : defaultTtl;
  const key = edgeCacheKey(cfg, resource, type, id);
  const cached = await getCached(key);
  if (cached !== null) return cached;
  const data = await proxyFetch(upstreamUrl);
  await setCached(key, data, ttl);
  return data;
}

// ─── API handlers ───────────────────────────────────────────────────────────────

async function handlePreview(req: Request): Promise<Response> {
  let body: { upstreamManifestUrl?: string };
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }
  const rawUrl = body.upstreamManifestUrl ?? "";
  if (!rawUrl) return err("upstreamManifestUrl is required");
  let base: string;
  try { base = normalizeBase(rawUrl); new URL(`${base}/manifest.json`); } catch { return err("upstreamManifestUrl is not a valid URL", 422); }
  let raw: unknown;
  try { raw = await proxyFetch(`${base}/manifest.json`); } catch (e) { return err(`Cannot reach upstream: ${(e as Error).message}`, 422); }
  const validation = validateManifest(raw);
  return json({ upstreamBaseUrl: base, validation, raw: validation.manifest ?? raw });
}

function buildConfig(body: Partial<ProxyConfig> & { upstreamManifestUrl?: string; upstreamBaseUrl?: string }, validatedTypes: string[], id?: string): ProxyConfig {
  const posterShape = (body.posterShape ?? "") as ProxyConfig["posterShape"];
  const allowedTypes = (body.allowedTypes ?? []).filter((t) => validatedTypes.includes(t));
  const subtitleLanguages = (body.subtitleLanguages ?? []).filter((l) => typeof l === "string" && /^[a-z]{2,3}$/.test(l));
  const idPrefixFilter = (body.idPrefixFilter ?? []).filter((p) => typeof p === "string" && p.length > 0);
  const allowedGenres = (body.allowedGenres ?? []).map((g: string) => g.toLowerCase().trim()).filter(Boolean);

  return {
    id: id || body.id || crypto.randomUUID(),
    password:        body.password        ?? "",
    upstreamBaseUrl: body.upstreamBaseUrl ?? "",
    cacheGeneration: body.cacheGeneration ?? 0,

    posterUrl:     body.posterUrl     ?? "",
    logoUrl:       body.logoUrl       ?? "",
    backgroundUrl: body.backgroundUrl ?? "",
    bannerUrl:     body.bannerUrl     ?? "",
    thumbnailUrl:  body.thumbnailUrl  ?? "",
    posterShape:   VALID_POSTER_SHAPES.has(posterShape) ? posterShape : "",

    namePrefix:        body.namePrefix        ?? "",
    nameSuffix:        body.nameSuffix        ?? "",
    descriptionPrefix: body.descriptionPrefix ?? "",
    descriptionSuffix: body.descriptionSuffix ?? "",

    enableCatalog:   body.enableCatalog   ?? true,
    enableMeta:      body.enableMeta      ?? true,
    enableStreams:   body.enableStreams   ?? true,
    enableSubtitles: body.enableSubtitles ?? true,
    enableSearch:    body.enableSearch    ?? true,

    allowedTypes,
    forceHttpsStreams:  body.forceHttpsStreams  ?? false,
    stripTorrents:      body.stripTorrents      ?? false,
    stripMagnetStreams: body.stripMagnetStreams ?? false,
    stripAdultFlag:     body.stripAdultFlag     ?? false,
    stripP2PFlag:       body.stripP2PFlag       ?? false,
    offlineCache:       body.offlineCache       ?? false,
    removeTrailers:     body.removeTrailers     ?? false,
    removeHeavyArtwork: body.removeHeavyArtwork ?? false,

    idPrefixFilter,
    maxStreams:             Math.max(0, Number(body.maxStreams     ?? 0)),
    streamSortBy:          body.streamSortBy          ?? "none",
    streamNamePrefix:      body.streamNamePrefix      ?? "",
    streamNameSuffix:      body.streamNameSuffix      ?? "",
    removeDuplicateStreams: body.removeDuplicateStreams ?? false,

    minImdbRating: Math.max(0, Number(body.minImdbRating ?? 0)),
    allowedGenres,

    subtitleLanguages,
    catalogCacheTtl:  Math.max(0, Number(body.catalogCacheTtl  ?? 0)),
    metaCacheTtl:     Math.max(0, Number(body.metaCacheTtl     ?? 0)),
    streamCacheTtl:   Math.max(0, Number(body.streamCacheTtl   ?? 0)),
    subtitleCacheTtl: Math.max(0, Number(body.subtitleCacheTtl ?? 0)),

    createdAt: body.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

async function handleCreate(req: Request, env: Env, workerUrl: string): Promise<Response> {
  let body: Partial<ProxyConfig> & { upstreamManifestUrl?: string };
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  if (!body.password || body.password.trim().length < 4) return err("password is required and must be at least 4 characters");

  const rawUrl = body.upstreamManifestUrl ?? body.upstreamBaseUrl ?? "";
  if (!rawUrl) return err("upstreamManifestUrl is required");
  let upstreamBaseUrl: string;
  try { upstreamBaseUrl = normalizeBase(rawUrl); new URL(`${upstreamBaseUrl}/manifest.json`); } catch { return err("upstreamManifestUrl is not a valid URL", 422); }

  let raw: unknown;
  try { raw = await proxyFetch(`${upstreamBaseUrl}/manifest.json`); } catch (e) { return err(`Cannot reach upstream addon: ${(e as Error).message}`, 422); }

  const validation = validateManifest(raw);
  if (!validation.valid) return err("Upstream manifest failed validation", 422, validation.errors);

  body.upstreamBaseUrl = upstreamBaseUrl;
  const id = crypto.randomUUID();
  const cfg = buildConfig(body, validation.types, id);

  await putConfig(cfg, env);
  const manifestUrl = `${workerUrl}/${id}/manifest.json`;
  const stremioUrl  = `stremio://${new URL(manifestUrl).host}/${id}/manifest.json`;
  const configureUrl = `${workerUrl}/${id}/configure`;
  return json({ id, manifestUrl, stremioUrl, configureUrl, config: cfg, upstreamManifest: validation.manifest });
}

async function handleUpdate(req: Request, id: string, env: Env, workerUrl: string): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== cfg.password) return err("Invalid password", 401);

  let body: Partial<ProxyConfig>;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  // Re-validate upstream if URL changed
  const newBase = body.upstreamBaseUrl ? normalizeBase(body.upstreamBaseUrl) : cfg.upstreamBaseUrl;
  let validation: ValidationResult | null = null;
  if (newBase !== cfg.upstreamBaseUrl) {
    let raw: unknown;
    try { raw = await proxyFetch(`${newBase}/manifest.json`); } catch (e) { return err(`Cannot reach upstream: ${(e as Error).message}`, 422); }
    validation = validateManifest(raw);
    if (!validation.valid) return err("Upstream manifest failed validation", 422, validation.errors);
  }

  body.upstreamBaseUrl = newBase;
  body.id = id;
  body.password = cfg.password;       // can't change password via update
  body.createdAt = cfg.createdAt;
  body.cacheGeneration = cfg.cacheGeneration; // preserve

  const validatedTypes = validation?.types ?? [];
  const updated = buildConfig(body, validatedTypes.length ? validatedTypes : body.allowedTypes ?? [], id);
  updated.cacheGeneration = cfg.cacheGeneration + 1; // auto-flush on update
  await putConfig(updated, env);

  const manifestUrl  = `${workerUrl}/${id}/manifest.json`;
  const stremioUrl   = `stremio://${new URL(manifestUrl).host}/${id}/manifest.json`;
  const configureUrl = `${workerUrl}/${id}/configure`;
  return json({ id, manifestUrl, stremioUrl, configureUrl, updated: true });
}

async function handleGetConfig(id: string, req: Request, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== cfg.password) return err("Invalid password", 401);
  return json(cfg);
}

async function handleDeleteConfig(id: string, req: Request, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== cfg.password) return err("Invalid password", 401);
  await env.PROXY_CONFIGS.delete(`proxy:${id}`);
  return json({ deleted: true });
}

async function handleFlushCache(id: string, req: Request, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== cfg.password) return err("Invalid password", 401);
  await flushProxyCache(cfg, env);
  return json({ flushed: true, generation: cfg.cacheGeneration });
}

async function handleList(env: Env): Promise<Response> {
  const list = await env.PROXY_CONFIGS.list({ prefix: "proxy:" });
  const items = await Promise.all(list.keys.map(async (k) => {
    const raw = await env.PROXY_CONFIGS.get(k.name);
    if (!raw) return null;
    const { id, upstreamBaseUrl, namePrefix, nameSuffix, createdAt, updatedAt, cacheGeneration } = JSON.parse(raw) as ProxyConfig;
    return { id, upstreamBaseUrl, namePrefix, nameSuffix, createdAt, updatedAt, cacheGeneration };
  }));
  return json({ proxies: items.filter(Boolean) });
}

// Admin-only list (includes more data)
async function handleAdminList(env: Env): Promise<Response> {
  const list = await env.PROXY_CONFIGS.list({ prefix: "proxy:" });
  const items = await Promise.all(list.keys.map(async (k) => {
    const raw = await env.PROXY_CONFIGS.get(k.name);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as ProxyConfig;
    // Mask password
    return { ...cfg, password: "***" };
  }));
  return json({ proxies: items.filter(Boolean) });
}

async function handleAdminDelete(id: string, env: Env): Promise<Response> {
  await env.PROXY_CONFIGS.delete(`proxy:${id}`);
  return json({ deleted: true });
}

async function handleAdminFlush(id: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  await flushProxyCache(cfg, env);
  return json({ flushed: true });
}

// ─── Addon proxy handlers ────────────────────────────────────────────────────────

async function handleManifest(id: string, env: Env, workerUrl: string): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  let upstream: StremioManifest;
  try {
    const raw = await proxyFetch(`${cfg.upstreamBaseUrl}/manifest.json`);
    const val = validateManifest(raw);
    if (!val.valid) throw new Error(val.errors[0]);
    upstream = val.manifest!;
  } catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }
  return jsonToStremio(patchManifest(upstream, cfg, workerUrl));
}

async function handleCatalog(id: string, type: string, catalogId: string, extraPath: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableCatalog) return jsonToStremio({ metas: [] });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return jsonToStremio({ metas: [] });
  if (cfg.idPrefixFilter.length > 0 && extraPath.includes("search=")) {
    // Let search pass through regardless of idPrefixFilter
  }

  const upstreamUrl = `${cfg.upstreamBaseUrl}/catalog/${type}/${catalogId}${extraPath ? `/${extraPath}` : ""}.json`;
  let upstream: { metas?: StremioMeta[] };
  try {
    upstream = (await fetchWithCache(cfg, "catalog", type, `${catalogId}/${extraPath}`, upstreamUrl, DEF_CATALOG_TTL, cfg.catalogCacheTtl)) as { metas?: StremioMeta[] };
  } catch (e) {
    if (cfg.offlineCache) return jsonToStremio({ metas: [] });
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }

  let metas = (upstream.metas ?? []).map((m) => patchMeta(m, cfg));
  metas = filterMetas(metas, cfg);
  return jsonToStremio({ metas });
}

async function handleMeta(id: string, type: string, itemId: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableMeta) return jsonToStremio({ meta: null });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return jsonToStremio({ meta: null });
  if (cfg.idPrefixFilter.length > 0 && !cfg.idPrefixFilter.some((p) => itemId.startsWith(p))) return jsonToStremio({ meta: null });

  const upstreamUrl = `${cfg.upstreamBaseUrl}/meta/${type}/${itemId}.json`;
  let upstream: { meta?: StremioMeta };
  try {
    upstream = (await fetchWithCache(cfg, "meta", type, itemId, upstreamUrl, DEF_META_TTL, cfg.metaCacheTtl)) as { meta?: StremioMeta };
  } catch (e) {
    if (cfg.offlineCache) return jsonToStremio({ meta: null });
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }

  const meta = upstream.meta ? patchMeta(upstream.meta, cfg) : null;
  return jsonToStremio({ meta });
}

async function handleStream(id: string, type: string, itemId: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableStreams) return jsonToStremio({ streams: [] });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return jsonToStremio({ streams: [] });
  if (cfg.idPrefixFilter.length > 0 && !cfg.idPrefixFilter.some((p) => itemId.startsWith(p))) return jsonToStremio({ streams: [] });

  const upstreamUrl = `${cfg.upstreamBaseUrl}/stream/${type}/${itemId}.json`;
  let upstream: { streams?: StremioStream[] };
  try {
    upstream = (await fetchWithCache(cfg, "stream", type, itemId, upstreamUrl, DEF_STREAM_TTL, cfg.streamCacheTtl)) as { streams?: StremioStream[] };
  } catch (e) {
    if (cfg.offlineCache) return jsonToStremio({ streams: [] });
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }

  const streams = transformStreams(upstream.streams ?? [], cfg);
  return jsonToStremio({ streams });
}

async function handleSubtitles(id: string, type: string, itemId: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableSubtitles) return jsonToStremio({ subtitles: [] });

  const upstreamUrl = `${cfg.upstreamBaseUrl}/subtitles/${type}/${itemId}.json`;
  let upstream: { subtitles?: StremioSubtitle[] };
  try {
    upstream = (await fetchWithCache(cfg, "subtitles", type, itemId, upstreamUrl, DEF_SUBTITLE_TTL, cfg.subtitleCacheTtl)) as { subtitles?: StremioSubtitle[] };
  } catch (e) {
    if (cfg.offlineCache) return jsonToStremio({ subtitles: [] });
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }

  let subtitles = upstream.subtitles ?? [];
  if (cfg.subtitleLanguages.length > 0) subtitles = subtitles.filter((s) => cfg.subtitleLanguages.includes(s.lang));
  return jsonToStremio({ subtitles });
}

async function handleAddonCatalog(id: string, type: string, catalogId: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const url = `${cfg.upstreamBaseUrl}/addon_catalog/${type}/${catalogId}.json`;
  try { return jsonToStremio(await proxyFetch(url)); } catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }
}

// ─── Admin page HTML ──────────────────────────────────────────────────────────────

function adminPageHtml(workerUrl: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PosteriumProxy — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--black:#080808;--dark:#111;--char:#1a1a1a;--border:#2a2a2a;--muted:#3d3d3d;--silver:#8a8a8a;--cream:#d4cfc7;--amber:#e8a428;--red:#c0392b;--green:#27ae60;--radius:6px}
body{background:var(--black);color:var(--cream);font-family:'DM Sans',sans-serif;font-weight:300;font-size:14px;line-height:1.6;min-height:100vh;padding:32px 24px}
h1{font-family:'Bebas Neue',sans-serif;font-size:36px;letter-spacing:.07em;color:#fff}h1 span{color:var(--amber)}
.subtitle{color:var(--silver);font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin-top:4px;margin-bottom:28px}
table{width:100%;border-collapse:collapse;margin-top:16px}
th{font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:.14em;color:var(--amber);padding:8px 12px;border-bottom:1px solid var(--border);text-align:left}
td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}
td.mono{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--silver)}
tr:hover td{background:var(--dark)}
.btn{padding:4px 10px;border-radius:3px;border:1px solid var(--border);background:var(--char);color:var(--silver);cursor:pointer;font-family:inherit;font-size:11px;transition:all .15s}
.btn:hover{border-color:var(--amber);color:var(--amber)}
.btn.danger:hover{border-color:var(--red);color:#e74c3c}
.badge{padding:2px 7px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:10px;background:rgba(232,164,40,.1);color:var(--amber);border:1px solid rgba(232,164,40,.25)}
.stats{display:flex;gap:20px;margin-bottom:24px}
.stat{background:var(--dark);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px}
.stat-num{font-family:'Bebas Neue',sans-serif;font-size:28px;color:var(--amber)}
.stat-label{font-size:11px;color:var(--silver);letter-spacing:.1em;text-transform:uppercase}
#msg{padding:10px 14px;border-radius:var(--radius);margin-bottom:16px;font-size:12px;display:none}
#msg.ok{background:rgba(39,174,96,.1);border:1px solid rgba(39,174,96,.3);color:var(--green)}
#msg.err{background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.3);color:#e74c3c}
.empty{text-align:center;padding:40px;color:var(--muted)}
</style></head><body>
<h1>Posterium<span>Proxy</span> — Admin</h1>
<p class="subtitle">Administrative panel · All proxy configurations</p>
<div id="msg"></div>
<div class="stats" id="stats"><div class="stat"><div class="stat-num" id="totalCount">—</div><div class="stat-label">Total Proxies</div></div></div>
<div id="table-wrap"><p class="empty">Loading…</p></div>
<script>
const W = '${workerUrl}';
let proxies = [];

async function load() {
  const r = await fetch(W+'/api/admin/list', { headers: { Authorization: 'Basic ' + btoa(':' + prompt('Admin password:')) } });
  if (r.status === 401) { alert('Wrong password'); return; }
  const d = await r.json();
  proxies = d.proxies || [];
  document.getElementById('totalCount').textContent = proxies.length;
  render();
}

function render() {
  const wrap = document.getElementById('table-wrap');
  if (!proxies.length) { wrap.innerHTML = '<p class="empty">No proxies yet.</p>'; return; }
  wrap.innerHTML = '<table><thead><tr><th>ID</th><th>Upstream</th><th>Name Override</th><th>Created</th><th>Cache Gen</th><th>Actions</th></tr></thead><tbody>'
    + proxies.map(p => {
      const d = new Date(p.createdAt).toLocaleDateString();
      const name = [p.namePrefix,p.nameSuffix].filter(Boolean).join('…') || '—';
      return '<tr>'
        + '<td class="mono">'+p.id.slice(0,8)+'…</td>'
        + '<td class="mono" title="'+escHtml(p.upstreamBaseUrl)+'">'+escHtml(p.upstreamBaseUrl.slice(0,40))+'…</td>'
        + '<td>'+escHtml(name)+'</td>'
        + '<td>'+d+'</td>'
        + '<td><span class="badge">v'+p.cacheGeneration+'</span></td>'
        + '<td style="display:flex;gap:6px;flex-wrap:wrap">'
        +   '<button class="btn" onclick="copyUrl(\''+p.id+'\')">Copy URL</button>'
        +   '<button class="btn" onclick="flushOne(\''+p.id+'\')">Flush Cache</button>'
        +   '<button class="btn danger" onclick="delOne(\''+p.id+'\')">Delete</button>'
        + '</td></tr>';
    }).join('')
    + '</tbody></table>';
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showMsg(t,ok){const m=document.getElementById('msg');m.textContent=t;m.className=ok?'ok':'err';m.style.display='block';setTimeout(()=>m.style.display='none',3000);}

function copyUrl(id) {
  navigator.clipboard.writeText(W+'/'+id+'/manifest.json').then(()=>showMsg('Copied manifest URL!',true));
}

async function flushOne(id) {
  const r = await fetch(W+'/api/admin/flush/'+id, { method:'POST', headers:{'Authorization': document.getElementById('_auth').value} });
  showMsg(r.ok ? 'Cache flushed!' : 'Error flushing', r.ok);
}

async function delOne(id) {
  if (!confirm('Delete proxy '+id+'? This cannot be undone.')) return;
  const r = await fetch(W+'/api/admin/'+id, { method:'DELETE', headers:{'Authorization': document.getElementById('_auth').value} });
  if (r.ok) { proxies = proxies.filter(p=>p.id!==id); render(); showMsg('Deleted.',true); }
  else showMsg('Error deleting',false);
}

// Store auth for subsequent requests
document.body.insertAdjacentHTML('afterbegin','<input id="_auth" type="hidden">');

(async()=>{
  const pw = prompt('Admin password:') || '';
  document.getElementById('_auth').value = 'Basic ' + btoa(':' + pw);
  const r = await fetch(W+'/api/admin/list', { headers:{ Authorization: 'Basic ' + btoa(':' + pw) } });
  if (r.status === 401) { document.body.innerHTML='<p style="color:#e74c3c;padding:32px">Wrong password.</p>'; return; }
  const d = await r.json();
  proxies = d.proxies || [];
  document.getElementById('totalCount').textContent = proxies.length;
  render();
})();
</script></body></html>`;
}

// ─── Main fetch handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url      = new URL(request.url);
    const workerUrl = `${url.protocol}//${url.host}`;
    const segments  = url.pathname.replace(/^\//, "").split("/").filter(Boolean);

    // ── /manage  (admin-only, Basic Auth) ─────────────────────────────────────
    if (segments[0] === "manage") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !checkBasicAuth(authHeader, env)) {
        return new Response("Unauthorized — enter any username and your admin password", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="PosteriumProxy Admin"' },
        });
      }
      // POST /manage (reserved for future use)
      return new Response(adminPageHtml(workerUrl), { headers: { "Content-Type": "text/html" } });
    }

    // ── /api/* ─────────────────────────────────────────────────────────────────
    if (segments[0] === "api") {
      const [, seg1, seg2, seg3] = segments;

      if (seg1 === "preview" && request.method === "POST") return handlePreview(request);
      if (seg1 === "create"  && request.method === "POST") return handleCreate(request, env, workerUrl);
      if (seg1 === "list"    && request.method === "GET")  return handleList(env);

      // User config endpoints (require proxy password via Bearer)
      if (seg1 === "config" && seg2) {
        if (request.method === "GET")    return handleGetConfig(seg2, request, env);
        if (request.method === "PUT")    return handleUpdate(request, seg2, env, workerUrl);
        if (request.method === "DELETE") return handleDeleteConfig(seg2, request, env);
      }

      if (seg1 === "flush" && seg2 && request.method === "POST") return handleFlushCache(seg2, request, env);

      // Admin endpoints (require Basic Auth)
      if (seg1 === "admin") {
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !checkBasicAuth(authHeader, env)) return err("Unauthorized", 401);
        if (seg2 === "list"  && request.method === "GET")  return handleAdminList(env);
        if (seg2 === "flush" && seg3 && request.method === "POST") return handleAdminFlush(seg3, env);
        if (seg2 && request.method === "DELETE") return handleAdminDelete(seg2, env);
      }

      return err("Not found", 404);
    }

    // ── /:addonId/* proxy routes ───────────────────────────────────────────────
    if (segments.length >= 2 && /^[0-9a-f-]{36}$/.test(segments[0])) {
      const [addonId, resource, ...rest] = segments;

      // /:id/configure → fall through to SPA (index.html handles it)
      if (resource === "configure") return env.ASSETS.fetch(request);

      if (resource === "manifest.json") return handleManifest(addonId, env, workerUrl);

      if (resource === "catalog" && rest.length >= 2) {
        const [type, ...parts] = rest;
        const rawPath = parts.join("/").replace(/\.json$/, "");
        const slash   = rawPath.indexOf("/");
        const catId   = slash === -1 ? rawPath : rawPath.slice(0, slash);
        const extra   = slash === -1 ? "" : rawPath.slice(slash + 1);
        return handleCatalog(addonId, type, catId, extra, env);
      }

      if (resource === "meta" && rest.length >= 2) {
        const [type, ...parts] = rest;
        return handleMeta(addonId, type, parts.join("/").replace(/\.json$/, ""), env);
      }

      if (resource === "stream" && rest.length >= 2) {
        const [type, ...parts] = rest;
        return handleStream(addonId, type, parts.join("/").replace(/\.json$/, ""), env);
      }

      if (resource === "subtitles" && rest.length >= 2) {
        const [type, ...parts] = rest;
        return handleSubtitles(addonId, type, parts.join("/").replace(/\.json$/, ""), env);
      }

      if (resource === "addon_catalog" && rest.length >= 2) {
        const [type, ...parts] = rest;
        return handleAddonCatalog(addonId, type, parts.join("/").replace(/\.json$/, ""), env);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;