// src/index.ts — PosteriumProxy v4 (FIXED)
// Adds: Multi-profile aggregator addon, /test static test profiles,
//       unified /{uuid} routing (proxy + profileset), full stream/meta aggregation

export interface Env {
  PROXY_CONFIGS: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_ADMIN_PW    = "admin123";
const VALID_RESOURCES     = new Set(["catalog","meta","stream","subtitles","addon_catalog"]);
const VALID_TYPES         = new Set(["movie","series","channel","tv"]);
const VALID_POSTER_SHAPES = new Set(["","square","poster","landscape"]);
const MANIFEST_MAX_BYTES  = 8192;
const MAX_AGG_STREAMS     = 100;

const DEF_CATALOG_TTL  = 1800;
const DEF_META_TTL     = 86400;
const DEF_STREAM_TTL   = 300;
const DEF_SUBTITLE_TTL = 3600;

// ─── ProfileSet types ────────────────────────────────────────────────────────────

interface CachedManifest {
  name?:        string;
  id?:          string;
  version?:     string;
  types?:       string[];
  resources?:   string[];
  resourceObjs?: Array<{ name: string; types?: string[]; idPrefixes?: string[] }>;
  catalogs?:    Array<{ type: string; id: string; name?: string; extra?: unknown }>;
  idPrefixes?:  string[];
}

interface AddonEntry {
  manifestUrl:     string;
  label?:          string;
  cachedManifest?: CachedManifest;
}

interface Profile {
  id:     string;
  name:   string;
  color:  string;
  icon:   string;
  addons: AddonEntry[];
}

interface ProfileSet {
  id:              string;
  password:        string;
  name:            string;
  profiles:        Profile[];
  activeProfileId: string;
  cacheGeneration: number;
  createdAt:       number;
  updatedAt:       number;
}

// ─── Proxy types ─────────────────────────────────────────────────────────────────

interface ProxyConfig {
  id:               string;
  password:         string;
  upstreamBaseUrl:  string;
  cacheGeneration:  number;

  posterUrl:     string;
  logoUrl:       string;
  backgroundUrl: string;
  bannerUrl:     string;
  thumbnailUrl:  string;
  posterShape:   "" | "square" | "poster" | "landscape";

  namePrefix:        string;
  nameSuffix:        string;
  descriptionPrefix: string;
  descriptionSuffix: string;

  enableCatalog:   boolean;
  enableMeta:      boolean;
  enableStreams:   boolean;
  enableSubtitles: boolean;
  enableSearch:    boolean;

  allowedTypes:       string[];
  forceHttpsStreams:   boolean;
  stripTorrents:       boolean;
  stripMagnetStreams:  boolean;
  stripAdultFlag:      boolean;
  stripP2PFlag:        boolean;
  offlineCache:        boolean;
  removeTrailers:      boolean;
  removeHeavyArtwork:  boolean;

  idPrefixFilter:         string[];
  maxStreams:             number;
  streamSortBy:           "none" | "quality_desc" | "name_asc";
  streamNamePrefix:       string;
  streamNameSuffix:       string;
  removeDuplicateStreams:  boolean;

  minImdbRating: number;
  allowedGenres: string[];

  subtitleLanguages: string[];

  catalogCacheTtl:  number;
  metaCacheTtl:     number;
  streamCacheTtl:   number;
  subtitleCacheTtl: number;

  createdAt: number;
  updatedAt: number;
}

// ─── Stremio types ────────────────────────────────────────────────────────────────

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
  behaviorHints?: { defaultVideoId?: string; [k: string]: unknown };
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

// ─── Validation ──────────────────────────────────────────────────────────────────

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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const err = (msg: string, status = 400, details?: unknown) =>
  json({ error: msg, ...(details ? { details } : {}) }, status);

function jsonToStremio(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function jsonToManifest(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
  });
}

function escSvg(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function escHtml(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ─── Auth helpers ──────────────────────────────────────────────────────────────────

function getAdminPassword(env: Env): string { return env.ADMIN_PASSWORD || DEFAULT_ADMIN_PW; }

function checkBasicAuth(header: string, env: Env): boolean {
  try { const [, b64] = header.split(" "); const [, pw] = atob(b64).split(":"); return pw === getAdminPassword(env); }
  catch { return false; }
}

function getBearerToken(request: Request): string {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// ─── Edge-cache helpers ────────────────────────────────────────────────────────────

const CACHE_HOST = "https://pp-cache.internal";

function edgeCacheKey(cfg: ProxyConfig, resource: string, type: string, id: string): string {
  return `${CACHE_HOST}/${cfg.id}/v${cfg.cacheGeneration}/${resource}/${type}/${encodeURIComponent(id)}`;
}

async function getCached(key: string): Promise<unknown | null> {
  try { const c = await caches.default.match(new Request(key)); return c ? c.json() : null; }
  catch { return null; }
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

async function flushProxyCacheGen(cfg: ProxyConfig, env: Env): Promise<void> {
  cfg.cacheGeneration = (cfg.cacheGeneration || 0) + 1;
  cfg.updatedAt = Date.now();
  await putConfig(cfg, env);
}

// ─── Proxy KV helpers ──────────────────────────────────────────────────────────────

async function getConfig(id: string, env: Env): Promise<ProxyConfig | null> {
  const raw = await env.PROXY_CONFIGS.get(`proxy:${id}`);
  return raw ? (JSON.parse(raw) as ProxyConfig) : null;
}

async function putConfig(cfg: ProxyConfig, env: Env): Promise<void> {
  await env.PROXY_CONFIGS.put(`proxy:${cfg.id}`, JSON.stringify(cfg), { expirationTtl: 60 * 60 * 24 * 365 });
}

// ─── ProfileSet KV helpers ─────────────────────────────────────────────────────────

async function getProfileSet(id: string, env: Env): Promise<ProfileSet | null> {
  const raw = await env.PROXY_CONFIGS.get(`profileset:${id}`);
  return raw ? (JSON.parse(raw) as ProfileSet) : null;
}

async function putProfileSet(ps: ProfileSet, env: Env): Promise<void> {
  await env.PROXY_CONFIGS.put(`profileset:${ps.id}`, JSON.stringify(ps), { expirationTtl: 60 * 60 * 24 * 365 });
}

// ─── ProfileSet helpers ────────────────────────────────────────────────────────────

function generateShortId(): string {
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => alpha[b % 36]).join("");
}

function getActiveProfile(ps: ProfileSet): Profile | undefined {
  return ps.profiles.find(p => p.id === ps.activeProfileId) ?? ps.profiles[0];
}

function addonSupports(addon: AddonEntry, resource: string, type?: string): boolean {
  const m = addon.cachedManifest;
  if (!m) return false;
  if (m.resourceObjs?.length) {
    return m.resourceObjs.some(r => {
      if (r.name !== resource) return false;
      if (!type || !r.types?.length) return true;
      return r.types.includes(type);
    });
  }
  return (m.resources ?? []).includes(resource);
}

async function fetchAndCacheAddonManifest(manifestUrl: string): Promise<CachedManifest | null> {
  try {
    const base = normalizeBase(manifestUrl);
    const raw = await proxyFetch(`${base}/manifest.json`);
    const val = validateManifest(raw);
    if (!val.valid || !val.manifest) return null;
    const m = val.manifest;
    return {
      name: m.name, id: m.id, version: m.version, types: m.types,
      resources: m.resources.map(r => typeof r === "string" ? r : r.name),
      resourceObjs: m.resources.map(r =>
        typeof r === "string" ? { name: r } : { name: r.name, types: r.types, idPrefixes: r.idPrefixes }
      ),
      catalogs: (m.catalogs ?? []).map(c => ({ type: c.type, id: c.id, name: c.name, extra: c.extra })),
      idPrefixes: m.idPrefixes,
    };
  } catch { return null; }
}

function parsePPCatalogId(id: string): { profileId: string; addonIdx: number; origCatalogId: string } | null {
  if (!id.startsWith("pp-") || id === "pp-profiles") return null;
  const body = id.slice(3);
  const i1 = body.indexOf("-");
  if (i1 === -1) return null;
  const profileId = body.slice(0, i1);
  const rest = body.slice(i1 + 1);
  const i2 = rest.indexOf("-");
  if (i2 === -1) return null;
  const addonIdxStr = rest.slice(0, i2);
  const origCatalogId = rest.slice(i2 + 1);
  if (!origCatalogId || !profileId) return null;
  const addonIdx = parseInt(addonIdxStr, 10);
  if (isNaN(addonIdx)) return null;
  return { profileId, addonIdx, origCatalogId };
}

// ─── SVG Poster for profiles ───────────────────────────────────────────────────────

function buildProfileSvg(name: string, color: string, icon: string, isActive: boolean): string {
  const c = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#e8a428";
  const label = escSvg((icon || name.charAt(0) || "?").slice(0, 2));
  const display = escSvg(name.slice(0, 15));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="${c}" opacity="0.12"/>
  <circle cx="100" cy="90" r="72" fill="${c}" opacity="0.9"/>
  <text x="100" y="90" text-anchor="middle" dominant-baseline="central" font-size="64"
        font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">${label}</text>
  <text x="100" y="164" text-anchor="middle" dominant-baseline="central" font-size="17"
        font-weight="600" font-family="sans-serif" fill="#ffffff" opacity="0.95">${display}</text>
  ${isActive ? `<circle cx="164" cy="36" r="18" fill="#27ae60"/>
  <text x="164" y="36" text-anchor="middle" dominant-baseline="central" font-size="16"
        font-family="sans-serif" fill="#fff">✓</text>` : ""}
</svg>`;
}

// ─── URL / fetch helpers ─────────────────────────────────────────────────────────────

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
      headers: { "User-Agent": "PosteriumProxy/4.0 (Stremio Addon Proxy)" },
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(t); }
}

// ─── Stream quality sorter ──────────────────────────────────────────────────────────

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

// ─── Proxy content transformers ────────────────────────────────────────────────────

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
    if (cfg.stripTorrents && stream.infoHash) continue;
    if (cfg.stripMagnetStreams && typeof stream.url === "string" && stream.url.startsWith("magnet:")) continue;
    const s = { ...stream };
    if (cfg.forceHttpsStreams && typeof s.url === "string" && s.url.startsWith("http://"))
      s.url = s.url.replace(/^http:\/\//, "https://");
    if (cfg.streamNamePrefix || cfg.streamNameSuffix) {
      const base = s.name || s.description || "";
      s.name = `${cfg.streamNamePrefix}${base}${cfg.streamNameSuffix}`.trim() || s.name;
    }
    out.push(s);
  }
  if (cfg.removeDuplicateStreams) {
    const seen = new Set<string>();
    out = out.filter((s) => {
      const key = s.url || s.infoHash || s.ytId || JSON.stringify(s);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  if (cfg.streamSortBy === "quality_desc") out.sort((a, b) => qualityScore(b) - qualityScore(a));
  else if (cfg.streamSortBy === "name_asc") out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
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
  bh.configurable = true;
  bh.configurationRequired = false;
  out.behaviorHints = bh;
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
  if (cfg.idPrefixFilter.length > 0) out.idPrefixes = cfg.idPrefixFilter;
  if (Array.isArray(out.catalogs)) {
    let cats = out.catalogs as StremioManifestCatalog[];
    if (cfg.allowedTypes.length > 0) cats = cats.filter((c) => cfg.allowedTypes.includes(c.type));
    if (!cfg.enableSearch) cats = cats.map((c) => ({ ...c, extra: (c.extra ?? []).filter((e) => e.name !== "search") }));
    out.catalogs = cats;
  }
  return out;
}

// ─── Proxy fetch with edge cache ──────────────────────────────────────────────────

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

// ─── Test Proxy (Completely Static — no KV) ────────────────────────────────────────

const TEST_MANIFEST: StremioManifest = {
  id: "com.posteriumproxy.test",
  name: "PosteriumProxy Test",
  version: "1.0.0",
  description: "Static test addon — 4 catalog rows, 2 types. Verifies routing, rendering, and stream playback.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie",  id: "pp-test-alpha",    name: "🔴 Test Movies — Alpha" },
    { type: "movie",  id: "pp-test-beta",     name: "🔵 Test Movies — Beta" },
    { type: "series", id: "pp-test-series",   name: "🟢 Test Series" },
    { type: "movie",  id: "pp-test-featured", name: "🟡 Featured Mix" },
  ],
  behaviorHints: { adult: false, p2p: false },
};

type TestItem = StremioMeta & { _seed: string };

function mkTest(id: string, type: string, name: string, desc: string, seed: string, genre: string, rating: string): TestItem {
  return {
    id, type, name,
    poster: `https://picsum.photos/seed/${seed}/300/450`,
    posterShape: "poster",
    description: desc,
    genres: [genre],
    imdbRating: rating,
    _seed: seed,
  };
}

const TEST_ALPHA: TestItem[] = [
  mkTest("pptest:a1","movie","Alpha Prime",    "🔴 Alpha · item 1 — if you see this, catalog Alpha is rendering ✓","ppta1","Action","7.5"),
  mkTest("pptest:a2","movie","Alpha Horizon",  "🔴 Alpha · item 2","ppta2","Sci-Fi","8.1"),
  mkTest("pptest:a3","movie","Alpha Legacy",   "🔴 Alpha · item 3","ppta3","Drama","6.9"),
  mkTest("pptest:a4","movie","Alpha Storm",    "🔴 Alpha · item 4","ppta4","Thriller","7.2"),
];
const TEST_BETA: TestItem[] = [
  mkTest("pptest:b1","movie","Beta Rising",    "🔵 Beta · item 1 — if you see this, catalog Beta is rendering ✓","pptb1","Comedy","7.8"),
  mkTest("pptest:b2","movie","Beta Protocol",  "🔵 Beta · item 2","pptb2","Action","8.3"),
  mkTest("pptest:b3","movie","Beta Sequence",  "🔵 Beta · item 3","pptb3","Sci-Fi","7.1"),
  mkTest("pptest:b4","movie","Beta Paradox",   "🔵 Beta · item 4","pptb4","Mystery","6.8"),
];
const TEST_SERIES_DATA: TestItem[] = [
  mkTest("pptest:s1","series","Test Show Alpha","🟢 Series · item 1 — if you see this, series catalog is rendering ✓","ppts1","Drama","8.5"),
  mkTest("pptest:s2","series","Test Show Beta", "🟢 Series · item 2","ppts2","Comedy","7.9"),
  mkTest("pptest:s3","series","Test Show Gamma","🟢 Series · item 3","ppts3","Thriller","8.2"),
  mkTest("pptest:s4","series","Test Show Delta","🟢 Series · item 4","ppts4","Sci-Fi","7.6"),
];
const TEST_FEATURED: TestItem[] = [
  TEST_ALPHA[0], TEST_BETA[0], TEST_SERIES_DATA[0],
  TEST_ALPHA[1], TEST_BETA[1], TEST_SERIES_DATA[1],
];
const TEST_ALL = [...TEST_ALPHA, ...TEST_BETA, ...TEST_SERIES_DATA];
const TEST_CATALOG_MAP: Record<string, TestItem[]> = {
  "pp-test-alpha":    TEST_ALPHA,
  "pp-test-beta":     TEST_BETA,
  "pp-test-series":   TEST_SERIES_DATA,
  "pp-test-featured": TEST_FEATURED,
};

function handleTestManifest(): Response { return jsonToStremio(TEST_MANIFEST); }

function handleTestCatalog(catalogId: string): Response {
  return jsonToStremio({ metas: TEST_CATALOG_MAP[catalogId] ?? [] });
}

function handleTestMeta(type: string, itemId: string): Response {
  const meta = TEST_ALL.find(m => m.id === itemId && m.type === type) ?? null;
  return jsonToStremio({ meta });
}

function handleTestStream(type: string, itemId: string): Response {
  const item = TEST_ALL.find(m => m.id === itemId);
  if (!item) return jsonToStremio({ streams: [] });
  return jsonToStremio({
    streams: [{
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      name: "Test Stream ✓",
      title: `${item.name} — PosteriumProxy Test`,
      description: "Big Buck Bunny (public domain). If this plays, streams are working correctly ✓",
    }, {
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
      name: "Test Stream 2 ✓",
      title: `${item.name} — Alternate Test`,
      description: "Elephants Dream (public domain). Second stream to verify multi-stream display ✓",
    }],
  });
}

// ─── Test ProfileSet (Hardcoded — no KV required) ──────────────────────────────

const TEST_PROFILESET_ID = "test-switch-me";

function buildTestProfileSet(workerUrl: string): ProfileSet {
  const now = Date.now();
  const testAddonUrl = `${workerUrl}/proxy/test/manifest.json`;
  
  return {
    id: TEST_PROFILESET_ID,
    password: "test",
    name: "🔬 Test Profiles (Switch Me!)",
    profiles: [
      {
        id: "test-alpha",
        name: "🔴 Alpha",
        icon: "α",
        color: "#e8a428",
        addons: [
          {
            manifestUrl: testAddonUrl,
            label: "Test Addon Alpha",
            cachedManifest: {
              name: "Test Addon Alpha",
              id: "test.addon.alpha",
              types: ["movie", "series"],
              resources: ["catalog", "meta", "stream"],
              catalogs: [
                { type: "movie", id: "pp-test-alpha", name: "🔴 Alpha Movies" },
                { type: "series", id: "pp-test-series", name: "🟢 Alpha Series" },
              ],
            } as CachedManifest,
          },
        ],
      },
      {
        id: "test-beta",
        name: "🔵 Beta",
        icon: "β",
        color: "#2980b9",
        addons: [
          {
            manifestUrl: testAddonUrl,
            label: "Test Addon Beta",
            cachedManifest: {
              name: "Test Addon Beta",
              id: "test.addon.beta",
              types: ["movie", "series"],
              resources: ["catalog", "meta", "stream"],
              catalogs: [
                { type: "movie", id: "pp-test-beta", name: "🔵 Beta Movies" },
                { type: "series", id: "pp-test-series", name: "🟢 Beta Series" },
              ],
            } as CachedManifest,
          },
        ],
      },
      {
        id: "test-all",
        name: "✅ All Together",
        icon: "✓",
        color: "#27ae60",
        addons: [
          {
            manifestUrl: testAddonUrl,
            label: "Test Addon Alpha",
            cachedManifest: {
              name: "Test Addon Alpha",
              id: "test.addon.alpha",
              types: ["movie", "series"],
              resources: ["catalog", "meta", "stream"],
              catalogs: [
                { type: "movie", id: "pp-test-alpha", name: "🔴 Alpha Movies" },
                { type: "series", id: "pp-test-series", name: "🟢 Alpha Series" },
              ],
            } as CachedManifest,
          },
          {
            manifestUrl: testAddonUrl,
            label: "Test Addon Beta",
            cachedManifest: {
              name: "Test Addon Beta",
              id: "test.addon.beta",
              types: ["movie", "series"],
              resources: ["catalog", "meta", "stream"],
              catalogs: [
                { type: "movie", id: "pp-test-beta", name: "🔵 Beta Movies" },
                { type: "series", id: "pp-test-series", name: "🟢 Beta Series" },
              ],
            } as CachedManifest,
          },
        ],
      },
    ],
    activeProfileId: "test-alpha",
    cacheGeneration: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── ProfileSet addon handlers ─────────────────────────────────────────────────────

function handlePSManifest(ps: ProfileSet, workerUrl: string): Response {
  const active = getActiveProfile(ps);
  const contentTypes = new Set<string>();
  const allIdPrefixes = new Set<string>(["profile:"]);
  let hasUnrestrictedIds = false;

  const catalogs: StremioManifestCatalog[] = [
    { type: "movie", id: "pp-profiles", name: "👤 Profiles" },
  ];

  if (active) {
    for (const [addonIdx, addon] of active.addons.entries()) {
      const m = addon.cachedManifest;
      if (!m) continue;
      (m.types ?? []).forEach(t => contentTypes.add(t));
      if (!m.idPrefixes?.length) hasUnrestrictedIds = true;
      else m.idPrefixes.forEach(p => allIdPrefixes.add(p));
      for (const cat of m.catalogs ?? []) {
        catalogs.push({
          type: cat.type,
          id: `pp-${active.id}-${addonIdx}-${cat.id}`,
          name: `${active.name} — ${cat.name ?? cat.id}`,
          extra: cat.extra as StremioManifestCatalog["extra"],
        });
      }
    }
  }

  const allTypes = ["movie", ...contentTypes].filter((v, i, a) => a.indexOf(v) === i);
  const idPrefixesForResource = hasUnrestrictedIds ? undefined : [...allIdPrefixes];

  const manifest: StremioManifest = {
    id: `com.posteriumproxy.ps.${ps.id}`,
    name: ps.name,
    version: "1.0.0",
    description: `${ps.profiles.length} profile${ps.profiles.length !== 1 ? "s" : ""} · Active: ${active?.name ?? "None"} · PosteriumProxy`,
    resources: [
      "catalog",
      { name: "meta",   types: allTypes, ...(idPrefixesForResource ? { idPrefixes: idPrefixesForResource } : {}) },
      { name: "stream", types: allTypes, ...(idPrefixesForResource ? { idPrefixes: idPrefixesForResource } : {}) },
    ],
    types: allTypes,
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };

  return jsonToManifest(manifest);
}

function handlePSPoster(ps: ProfileSet, posterType: string): Response {
  const profile = ps.profiles.find(p => p.id === posterType);
  const name  = profile?.name ?? "?";
  const color = profile?.color ?? "#e8a428";
  const icon  = profile?.icon ?? "";
  const isActive = profile ? profile.id === ps.activeProfileId : false;
  const svg = buildProfileSvg(name, color, icon, isActive);
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=60", ...CORS },
  });
}

async function handlePSCatalog(
  ps: ProfileSet, type: string, catalogId: string, extra: string, workerUrl: string,
): Promise<Response> {
  if (catalogId === "pp-profiles") {
    const metas: StremioMeta[] = ps.profiles.map(profile => {
      const isActive = profile.id === ps.activeProfileId;
      return {
        id: `profile:${profile.id}`,
        type: "movie",
        name: isActive ? `${profile.name} ✓` : profile.name,
        poster: `${workerUrl}/${ps.id}/poster/${profile.id}.svg`,
        posterShape: "square",
        description: `${profile.addons.length} addon${profile.addons.length !== 1 ? "s" : ""}${isActive ? " · Active" : ""}`,
        behaviorHints: { defaultVideoId: `profile:${profile.id}` },
      };
    });
    return jsonToStremio({ metas });
  }

  const parsed = parsePPCatalogId(catalogId);
  if (!parsed) return jsonToStremio({ metas: [] });

  const { profileId, addonIdx, origCatalogId } = parsed;
  if (profileId !== ps.activeProfileId) return jsonToStremio({ metas: [] });

  const active = getActiveProfile(ps);
  const addon = active?.addons[addonIdx];
  if (!addon) return jsonToStremio({ metas: [] });

  const base = normalizeBase(addon.manifestUrl);
  const upstreamUrl = `${base}/catalog/${type}/${origCatalogId}${extra ? `/${extra}` : ""}.json`;

  try {
    const data = await proxyFetch(upstreamUrl);
    return jsonToStremio(data);
  } catch {
    return jsonToStremio({ metas: [] });
  }
}

async function handlePSMeta(
  ps: ProfileSet, type: string, itemId: string, _env: Env, workerUrl: string,
): Promise<Response> {
  if (itemId.startsWith("profile:")) {
    const profileId = itemId.slice(8);
    const profile = ps.profiles.find(p => p.id === profileId);
    if (!profile) return jsonToStremio({ meta: null });
    const isActive = profile.id === ps.activeProfileId;
    return jsonToStremio({
      meta: {
        id: itemId,
        type: "movie",
        name: profile.name,
        poster: `${workerUrl}/${ps.id}/poster/${profile.id}.svg`,
        posterShape: "square",
        description: `${profile.addons.length} addon${profile.addons.length !== 1 ? "s" : ""}` +
                     (isActive ? " · Currently active" : " · Tap to switch"),
        videos: [{
          id: `profile:${profile.id}`,
          title: isActive ? "✅ Active — tap to confirm" : "▶ Tap to activate this profile",
          released: new Date(ps.createdAt).toISOString(),
        }],
        behaviorHints: { defaultVideoId: `profile:${profile.id}` },
      }
    });
  }

  const active = getActiveProfile(ps);
  if (!active) return jsonToStremio({ meta: null });

  const eligible = active.addons.filter(a => addonSupports(a, "meta", type));
  for (const addon of eligible) {
    try {
      const base = normalizeBase(addon.manifestUrl);
      const data = await proxyFetch(`${base}/meta/${type}/${itemId}.json`) as { meta?: unknown };
      if (data?.meta) return jsonToStremio(data);
    } catch { /* try next */ }
  }
  return jsonToStremio({ meta: null });
}

async function handlePSStream(
  ps: ProfileSet, type: string, itemId: string, env: Env, _workerUrl: string,
): Promise<Response> {
  if (itemId.startsWith("profile:")) {
    const profileId = itemId.slice(8);
    const profile = ps.profiles.find(p => p.id === profileId);
    if (!profile) return jsonToStremio({ streams: [] });

    if (ps.activeProfileId !== profileId) {
      ps.activeProfileId = profileId;
      ps.cacheGeneration = (ps.cacheGeneration || 0) + 1;
      ps.updatedAt = Date.now();
      await putProfileSet(ps, env);
    }

    return jsonToStremio({ streams: [] });
  }

  const active = getActiveProfile(ps);
  if (!active) return jsonToStremio({ streams: [] });

  const eligible = active.addons.filter(a => addonSupports(a, "stream", type));
  if (eligible.length === 0) return jsonToStremio({ streams: [] });

  const results = await Promise.allSettled(
    eligible.map(async addon => {
      const base = normalizeBase(addon.manifestUrl);
      const data = await proxyFetch(`${base}/stream/${type}/${itemId}.json`) as { streams?: StremioStream[] };
      return (data?.streams ?? []) as StremioStream[];
    })
  );

  const streams = results
    .flatMap(r => r.status === "fulfilled" ? r.value : [])
    .slice(0, MAX_AGG_STREAMS);

  return jsonToStremio({ streams });
}

async function handlePSSubtitles(
  ps: ProfileSet, type: string, itemId: string, _env: Env,
): Promise<Response> {
  const active = getActiveProfile(ps);
  if (!active) return jsonToStremio({ subtitles: [] });

  const eligible = active.addons.filter(a => addonSupports(a, "subtitles", type));
  if (eligible.length === 0) return jsonToStremio({ subtitles: [] });

  const results = await Promise.allSettled(
    eligible.map(async addon => {
      const base = normalizeBase(addon.manifestUrl);
      const data = await proxyFetch(`${base}/subtitles/${type}/${itemId}.json`) as { subtitles?: StremioSubtitle[] };
      return data?.subtitles ?? [];
    })
  );

  const subtitles = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  return jsonToStremio({ subtitles });
}

// ─── ProfileSet API handlers ───────────────────────────────────────────────────────

async function handleCreatePS(req: Request, env: Env, workerUrl: string): Promise<Response> {
  let body: {
    name?: string; password?: string;
    profiles?: Array<{
      name?: string; color?: string; icon?: string;
      addons?: Array<{ url?: string; label?: string }>;
    }>;
  };
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  if (!body.name?.trim()) return err("name is required");
  if (!body.password || body.password.trim().length < 4) return err("password must be ≥ 4 characters");
  if (!Array.isArray(body.profiles) || body.profiles.length === 0) return err("at least one profile is required");

  const id  = crypto.randomUUID();
  const now = Date.now();

  type FetchTask = { pi: number; ai: number; url: string };
  const fetchTasks: FetchTask[] = [];

  const profiles: Profile[] = body.profiles.map((p, pi) => {
    const addons: AddonEntry[] = (p.addons ?? [])
      .filter(a => a.url?.trim())
      .map((a, ai) => {
        fetchTasks.push({ pi, ai, url: a.url!.trim() });
        return { manifestUrl: a.url!.trim(), label: a.label?.trim() || undefined };
      });
    return {
      id:    generateShortId(),
      name:  (p.name ?? "Profile").slice(0, 50).trim() || "Profile",
      color: /^#[0-9a-fA-F]{6}$/.test(p.color ?? "") ? p.color! : "#e8a428",
      icon:  (p.icon ?? "⭐").slice(0, 2) || "⭐",
      addons,
    };
  });

  const fetched = await Promise.allSettled(
    fetchTasks.map(async t => ({ ...t, manifest: await fetchAndCacheAddonManifest(t.url) }))
  );
  for (const r of fetched) {
    if (r.status === "fulfilled" && r.value.manifest) {
      const { pi, ai, manifest } = r.value;
      if (profiles[pi]?.addons[ai]) profiles[pi].addons[ai].cachedManifest = manifest;
    }
  }

  const ps: ProfileSet = {
    id, password: body.password.trim(), name: body.name.trim().slice(0, 100),
    profiles, activeProfileId: profiles[0]?.id ?? "",
    cacheGeneration: 0, createdAt: now, updatedAt: now,
  };

  await putProfileSet(ps, env);

  return json({
    id,
    manifestUrl:  `${workerUrl}/${id}/manifest.json`,
    stremioUrl:   `stremio://${new URL(workerUrl).host}/${id}/manifest.json`,
    configureUrl: `${workerUrl}/${id}/configure`,
  });
}

async function handleGetPS(id: string, req: Request, env: Env): Promise<Response> {
  const ps = await getProfileSet(id, env);
  if (!ps) return err("Profile set not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== ps.password) return err("Invalid password", 401);
  return json({ ...ps, password: undefined });
}

async function handleUpdatePS(id: string, req: Request, env: Env, workerUrl: string): Promise<Response> {
  const ps = await getProfileSet(id, env);
  if (!ps) return err("Profile set not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== ps.password) return err("Invalid password", 401);

  let body: { name?: string; profiles?: unknown[] };
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  if (body.name) ps.name = body.name.trim().slice(0, 100);

  if (Array.isArray(body.profiles)) {
    type FetchTask = { pi: number; ai: number; url: string };
    const fetchTasks: FetchTask[] = [];

    ps.profiles = (body.profiles as Array<Record<string, unknown>>).map((p, pi) => {
      const rawAddons = Array.isArray(p.addons) ? p.addons as Array<Record<string, unknown>> : [];
      const addons: AddonEntry[] = rawAddons
        .filter(a => typeof a.url === "string" && a.url.trim())
        .map((a, ai) => {
          fetchTasks.push({ pi, ai, url: (a.url as string).trim() });
          return { manifestUrl: (a.url as string).trim(), label: typeof a.label === "string" ? a.label.trim() || undefined : undefined };
        });
      return {
        id:    typeof p.id === "string" ? p.id : generateShortId(),
        name:  (typeof p.name === "string" ? p.name : "Profile").slice(0, 50).trim() || "Profile",
        color: /^#[0-9a-fA-F]{6}$/.test(typeof p.color === "string" ? p.color : "") ? (p.color as string) : "#e8a428",
        icon:  (typeof p.icon === "string" ? p.icon : "⭐").slice(0, 2) || "⭐",
        addons,
      };
    });

    const fetched = await Promise.allSettled(
      fetchTasks.map(async t => ({ ...t, manifest: await fetchAndCacheAddonManifest(t.url) }))
    );
    for (const r of fetched) {
      if (r.status === "fulfilled" && r.value.manifest) {
        const { pi, ai, manifest } = r.value;
        if (ps.profiles[pi]?.addons[ai]) ps.profiles[pi].addons[ai].cachedManifest = manifest;
      }
    }

    if (!ps.profiles.find(p => p.id === ps.activeProfileId))
      ps.activeProfileId = ps.profiles[0]?.id ?? "";
  }

  ps.cacheGeneration++;
  ps.updatedAt = Date.now();
  await putProfileSet(ps, env);

  return json({
    id,
    manifestUrl: `${workerUrl}/${id}/manifest.json`,
    stremioUrl:  `stremio://${new URL(workerUrl).host}/${id}/manifest.json`,
    updated: true,
  });
}

async function handleDeletePS(id: string, req: Request, env: Env): Promise<Response> {
  const ps = await getProfileSet(id, env);
  if (!ps) return err("Profile set not found", 404);
  const pw = getBearerToken(req);
  if (!pw || pw !== ps.password) return err("Invalid password", 401);
  await env.PROXY_CONFIGS.delete(`profileset:${id}`);
  return json({ deleted: true });
}

// ─── Proxy API handlers ────────────────────────────────────────────────────────────

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

function buildConfig(
  body: Partial<ProxyConfig> & { upstreamManifestUrl?: string; upstreamBaseUrl?: string },
  validatedTypes: string[], id?: string,
): ProxyConfig {
  const posterShape = (body.posterShape ?? "") as ProxyConfig["posterShape"];
  const allowedTypes = validatedTypes.length > 0
    ? (body.allowedTypes ?? []).filter(t => validatedTypes.includes(t))
    : (body.allowedTypes ?? []);
  const subtitleLanguages = (body.subtitleLanguages ?? []).filter(l => typeof l === "string" && /^[a-z]{2,3}$/.test(l));
  const idPrefixFilter    = (body.idPrefixFilter ?? []).filter(p => typeof p === "string" && p.length > 0);
  const allowedGenres     = (body.allowedGenres ?? []).map((g: string) => g.toLowerCase().trim()).filter(Boolean);

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
    forceHttpsStreams:   body.forceHttpsStreams   ?? false,
    stripTorrents:       body.stripTorrents       ?? false,
    stripMagnetStreams:  body.stripMagnetStreams   ?? false,
    stripAdultFlag:      body.stripAdultFlag       ?? false,
    stripP2PFlag:        body.stripP2PFlag         ?? false,
    offlineCache:        body.offlineCache         ?? false,
    removeTrailers:      body.removeTrailers       ?? false,
    removeHeavyArtwork:  body.removeHeavyArtwork   ?? false,
    idPrefixFilter,
    maxStreams:             Math.max(0, Number(body.maxStreams     ?? 0)),
    streamSortBy:           body.streamSortBy       ?? "none",
    streamNamePrefix:       body.streamNamePrefix   ?? "",
    streamNameSuffix:       body.streamNameSuffix   ?? "",
    removeDuplicateStreams:  body.removeDuplicateStreams ?? false,
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
  if (!body.password || body.password.trim().length < 4) return err("password is required and must be ≥ 4 characters");
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
  const manifestUrl  = `${workerUrl}/${id}/manifest.json`;
  const stremioUrl   = `stremio://${new URL(manifestUrl).host}/${id}/manifest.json`;
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
  const newBase = body.upstreamBaseUrl ? normalizeBase(body.upstreamBaseUrl) : cfg.upstreamBaseUrl;
  let validation: ValidationResult | null = null;
  if (newBase !== cfg.upstreamBaseUrl) {
    let raw: unknown;
    try { raw = await proxyFetch(`${newBase}/manifest.json`); } catch (e) { return err(`Cannot reach upstream: ${(e as Error).message}`, 422); }
    validation = validateManifest(raw);
    if (!validation.valid) return err("Upstream manifest failed validation", 422, validation.errors);
  }
  body.upstreamBaseUrl = newBase;
  body.id = id; body.password = cfg.password; body.createdAt = cfg.createdAt;
  body.cacheGeneration = cfg.cacheGeneration;
  const updated = buildConfig(body, validation ? validation.types : body.allowedTypes ?? [], id);
  updated.cacheGeneration = cfg.cacheGeneration + 1;
  await putConfig(updated, env);
  const manifestUrl  = `${workerUrl}/${id}/manifest.json`;
  const stremioUrl   = `stremio://${new URL(manifestUrl).host}/${id}/manifest.json`;
  return json({ id, manifestUrl, stremioUrl, configureUrl: `${workerUrl}/${id}/configure`, updated: true });
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
  await flushProxyCacheGen(cfg, env);
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

// ─── Proxy addon route handlers ────────────────────────────────────────────────────

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
  const upstreamUrl = `${cfg.upstreamBaseUrl}/catalog/${type}/${catalogId}${extraPath ? `/${extraPath}` : ""}.json`;
  let upstream: { metas?: StremioMeta[] };
  try {
    upstream = (await fetchWithCache(cfg, "catalog", type, `${catalogId}/${extraPath}`, upstreamUrl, DEF_CATALOG_TTL, cfg.catalogCacheTtl)) as { metas?: StremioMeta[] };
  } catch (e) {
    if (cfg.offlineCache) return jsonToStremio({ metas: [] });
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }
  let metas = (upstream.metas ?? []).map(m => patchMeta(m, cfg));
  metas = filterMetas(metas, cfg);
  return jsonToStremio({ metas });
}

async function handleMeta(id: string, type: string, itemId: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableMeta) return jsonToStremio({ meta: null });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return jsonToStremio({ meta: null });
  if (cfg.idPrefixFilter.length > 0 && !cfg.idPrefixFilter.some(p => itemId.startsWith(p))) return jsonToStremio({ meta: null });
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
  if (cfg.idPrefixFilter.length > 0 && !cfg.idPrefixFilter.some(p => itemId.startsWith(p))) return jsonToStremio({ streams: [] });
  const upstreamUrl = `${cfg.upstreamBaseUrl}/stream/${type}/${itemId}.json`;
  let upstream: { streams?: StremioStream[] };
  try {
    upstream = (await fetchWithCache(cfg, "stream", type, itemId, upstreamUrl, DEF_STREAM_TTL, cfg.streamCacheTtl)) as { streams?: StremioStream[] };
  } catch (e) {
    if (cfg.offlineCache) return jsonToStremio({ streams: [] });
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }
  return jsonToStremio({ streams: transformStreams(upstream.streams ?? [], cfg) });
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
  if (cfg.subtitleLanguages.length > 0) subtitles = subtitles.filter(s => cfg.subtitleLanguages.includes(s.lang));
  return jsonToStremio({ subtitles });
}

async function handleAddonCatalog(id: string, type: string, catalogId: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const url = `${cfg.upstreamBaseUrl}/addon_catalog/${type}/${catalogId}.json`;
  try { return jsonToStremio(await proxyFetch(url)); } catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }
}

// ─── Admin handlers ────────────────────────────────────────────────────────────────

async function handleAdminList(env: Env): Promise<Response> {
  const [pList, psList] = await Promise.all([
    env.PROXY_CONFIGS.list({ prefix: "proxy:" }),
    env.PROXY_CONFIGS.list({ prefix: "profileset:" }),
  ]);
  const proxies = await Promise.all(pList.keys.map(async k => {
    const raw = await env.PROXY_CONFIGS.get(k.name);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as ProxyConfig;
    return { type: "proxy", id: cfg.id, upstreamBaseUrl: cfg.upstreamBaseUrl, createdAt: cfg.createdAt, updatedAt: cfg.updatedAt, cacheGeneration: cfg.cacheGeneration };
  }));
  const profilesets = await Promise.all(psList.keys.map(async k => {
    const raw = await env.PROXY_CONFIGS.get(k.name);
    if (!raw) return null;
    const ps = JSON.parse(raw) as ProfileSet;
    return { type: "profileset", id: ps.id, name: ps.name, profileCount: ps.profiles.length, activeProfileId: ps.activeProfileId, createdAt: ps.createdAt, updatedAt: ps.updatedAt, cacheGeneration: ps.cacheGeneration };
  }));
  return json({ proxies: proxies.filter(Boolean), profilesets: profilesets.filter(Boolean) });
}

async function handleAdminDelete(id: string, env: Env): Promise<Response> {
  await env.PROXY_CONFIGS.delete(`proxy:${id}`);
  await env.PROXY_CONFIGS.delete(`profileset:${id}`);
  return json({ deleted: true });
}

async function handleAdminFlush(id: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (cfg) { await flushProxyCacheGen(cfg, env); return json({ flushed: true }); }
  const ps = await getProfileSet(id, env);
  if (ps) { ps.cacheGeneration++; ps.updatedAt = Date.now(); await putProfileSet(ps, env); return json({ flushed: true }); }
  return err("Not found", 404);
}

// ─── Admin page HTML ─────────────────────────────────────────────────────────────────

function adminPageHtml(workerUrl: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PosteriumProxy — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
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
.btn:hover{border-color:var(--amber);color:var(--amber)}.btn.danger:hover{border-color:var(--red);color:#e74c3c}
.badge{padding:2px 7px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:10px;background:rgba(232,164,40,.1);color:var(--amber);border:1px solid rgba(232,164,40,.25)}
.badge-ps{background:rgba(41,128,185,.1);color:#5dade2;border-color:rgba(41,128,185,.25)}
.stats{display:flex;gap:20px;margin-bottom:24px}
.stat{background:var(--dark);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px}
.stat-num{font-family:'Bebas Neue',sans-serif;font-size:28px;color:var(--amber)}
.stat-label{font-size:11px;color:var(--silver);letter-spacing:.1em;text-transform:uppercase}
#msg{padding:10px 14px;border-radius:var(--radius);margin-bottom:16px;font-size:12px;display:none}
#msg.ok{background:rgba(39,174,96,.1);border:1px solid rgba(39,174,96,.3);color:var(--green)}
#msg.err{background:rgba(192,57,43,.1);border:1px solid rgba(192,57,43,.3);color:#e74c3c}
.empty{text-align:center;padding:40px;color:var(--muted)}
h2{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:.1em;color:var(--amber);margin:28px 0 12px}
</style></head><body>
<h1>Posterium<span>Proxy</span> — Admin</h1>
<p class="subtitle">Administrative panel · All configs</p>
<div id="msg"></div>
<div class="stats"><div class="stat"><div class="stat-num" id="proxyCount">—</div><div class="stat-label">Proxies</div></div><div class="stat"><div class="stat-num" id="psCount">—</div><div class="stat-label">Profile Sets</div></div></div>
<h2>Proxies</h2><div id="proxy-wrap"><p class="empty">Loading…</p></div>
<h2>Profile Sets</h2><div id="ps-wrap"><p class="empty">Loading…</p></div>
<input id="_auth" type="hidden">
<script>
const W='${escHtml(workerUrl)}';
let proxies=[],profilesets=[];
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function showMsg(t,ok){const m=document.getElementById('msg');m.textContent=t;m.className=ok?'ok':'err';m.style.display='block';setTimeout(()=>m.style.display='none',3000);}
function renderProxies(){const w=document.getElementById('proxy-wrap');if(!proxies.length){w.innerHTML='<p class="empty">No proxies.</p>';return;}w.innerHTML='<table><thead><tr><th>ID</th><th>Upstream</th><th>Cache Gen</th><th>Created</th><th>Actions</th></tr></thead><tbody>'+proxies.map(p=>'<tr><td class="mono">'+esc(p.id.slice(0,8))+'…</td><td class="mono" title="'+esc(p.upstreamBaseUrl)+'">'+esc((p.upstreamBaseUrl||'').slice(0,45))+'</td><td><span class="badge">v'+p.cacheGeneration+'</span></td><td>'+new Date(p.createdAt).toLocaleDateString()+'</td><td style="display:flex;gap:6px"><button class="btn" onclick="copyUrl(\''+p.id+'\')">Copy URL</button><button class="btn" onclick="flush(\''+p.id+'\')">Flush</button><button class="btn danger" onclick="del(\''+p.id+'\')">Delete</button></td></tr>').join('')+'</tbody></table>';}
function renderPS(){const w=document.getElementById('ps-wrap');if(!profilesets.length){w.innerHTML='<p class="empty">No profile sets.</p>';return;}w.innerHTML='<table><thead><tr><th>ID</th><th>Name</th><th>Profiles</th><th>Active</th><th>Cache Gen</th><th>Actions</th></tr></thead><tbody>'+profilesets.map(ps=>'<tr><td class="mono">'+esc(ps.id.slice(0,8))+'…</td><td>'+esc(ps.name||'—')+'</td><td>'+ps.profileCount+'</td><td class="mono">'+esc((ps.activeProfileId||'').slice(0,8))+'</td><td><span class="badge badge-ps">v'+ps.cacheGeneration+'</span></td><td style="display:flex;gap:6px"><button class="btn" onclick="copyUrl(\''+ps.id+'\')">Copy URL</button><button class="btn" onclick="flush(\''+ps.id+'\')">Flush</button><button class="btn danger" onclick="del(\''+ps.id+'\')">Delete</button></td></tr>').join('')+'</tbody></table>';}
function copyUrl(id){navigator.clipboard.writeText(W+'/'+id+'/manifest.json').then(()=>showMsg('Copied!',true));}
async function flush(id){const r=await fetch(W+'/api/admin/flush/'+id,{method:'POST',headers:{Authorization:document.getElementById('_auth').value}});showMsg(r.ok?'Flushed!':'Error',r.ok);}
async function del(id){if(!confirm('Delete '+id+'?'))return;const r=await fetch(W+'/api/admin/'+id,{method:'DELETE',headers:{Authorization:document.getElementById('_auth').value}});if(r.ok){proxies=proxies.filter(p=>p.id!==id);profilesets=profilesets.filter(p=>p.id!==id);renderProxies();renderPS();showMsg('Deleted.',true);}else showMsg('Error',false);}
(async()=>{const pw=prompt('Admin password:')||'';document.getElementById('_auth').value='Basic '+btoa(':'+pw);const r=await fetch(W+'/api/admin/list',{headers:{Authorization:'Basic '+btoa(':'+pw)}});if(r.status===401){document.body.innerHTML='<p style="color:#e74c3c;padding:32px">Wrong password.</p>';return;}const d=await r.json();proxies=d.proxies||[];profilesets=d.profilesets||[];document.getElementById('proxyCount').textContent=proxies.length;document.getElementById('psCount').textContent=profilesets.length;renderProxies();renderPS();})();
</script></body></html>`;
}

// ─── Main router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url       = new URL(request.url);
    const workerUrl = `${url.protocol}//${url.host}`;
    const segments  = url.pathname.replace(/^\//, "").split("/").filter(Boolean);
    const [s0, s1, s2, s3] = segments;

    // ── /manage ───────────────────────────────────────────────────────────────
    if (s0 === "manage") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !checkBasicAuth(authHeader, env))
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="PosteriumProxy Admin"' } });
      return new Response(adminPageHtml(workerUrl), { headers: { "Content-Type": "text/html" } });
    }

    // ── /test/* (test profile switching — hardcoded, no KV) ───────────────────
    if (s0 === "test") {
      const ps = buildTestProfileSet(workerUrl);
      const resource = s1;
      if (!resource || resource === "manifest.json") return handlePSManifest(ps, workerUrl);

      if (resource === "poster") {
        const posterType = s2?.replace(/\.svg$/, "");
        if (posterType) return handlePSPoster(ps, posterType);
      }

      if (resource === "catalog" && segments.length >= 2) {
        const [, type, ...parts] = segments;
        const raw = parts.join("/").replace(/\.json$/, "");
        const si  = raw.indexOf("/");
        const catId = si === -1 ? raw : raw.slice(0, si);
        const extra = si === -1 ? "" : raw.slice(si + 1);
        return handlePSCatalog(ps, type, catId, extra, workerUrl);
      }

      if (resource === "meta" && segments.length >= 3) {
        const [, type, ...parts] = segments;
        const itemId = decodeURIComponent(parts.join("/").replace(/\.json$/, ""));
        return handlePSMeta(ps, type, itemId, env, workerUrl);
      }

      if (resource === "stream" && segments.length >= 3) {
        const [, type, ...parts] = segments;
        const itemId = decodeURIComponent(parts.join("/").replace(/\.json$/, ""));
        return handlePSStream(ps, type, itemId, env, workerUrl);
      }

      if (resource === "subtitles" && segments.length >= 3) {
        const [, type, ...parts] = segments;
        const itemId = decodeURIComponent(parts.join("/").replace(/\.json$/, ""));
        return handlePSSubtitles(ps, type, itemId, env);
      }

      return err("Not found in /test", 404);
    }

    // ── /proxy/test/* (static test addon — no KV) ─────────────────────────────
    if (s0 === "proxy" && s1 === "test") {
      const resource = s2;
      const rest = segments.slice(3);
      if (!resource || resource === "manifest.json") return handleTestManifest();
      if (resource === "catalog" && rest.length >= 1) {
        const catId = rest.join("/").replace(/\.json$/, "").split("/")[0];
        return handleTestCatalog(catId);
      }
      if (resource === "meta" && rest.length >= 2)
        return handleTestMeta(rest[0], rest.slice(1).join("/").replace(/\.json$/, ""));
      if (resource === "stream" && rest.length >= 2)
        return handleTestStream(rest[0], rest.slice(1).join("/").replace(/\.json$/, ""));
      return err("Not found", 404);
    }

    // ── /api/* ────────────────────────────────────────────────────────────────
    if (s0 === "api") {
      if (s1 === "preview" && request.method === "POST") return handlePreview(request);
      if (s1 === "create"  && request.method === "POST") return handleCreate(request, env, workerUrl);
      if (s1 === "list"    && request.method === "GET")  return handleList(env);

      if (s1 === "config" && s2) {
        if (request.method === "GET")    return handleGetConfig(s2, request, env);
        if (request.method === "PUT")    return handleUpdate(request, s2, env, workerUrl);
        if (request.method === "DELETE") return handleDeleteConfig(s2, request, env);
      }
      if (s1 === "flush" && s2 && request.method === "POST") return handleFlushCache(s2, request, env);

      // ProfileSet API
      if (s1 === "profilesets") {
        if (s2 === "create" && request.method === "POST") return handleCreatePS(request, env, workerUrl);
        if (s2 && !s3) {
          if (request.method === "GET")    return handleGetPS(s2, request, env);
          if (request.method === "PUT")    return handleUpdatePS(s2, request, env, workerUrl);
          if (request.method === "DELETE") return handleDeletePS(s2, request, env);
        }
      }

      // Admin API
      if (s1 === "admin") {
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !checkBasicAuth(authHeader, env)) return err("Unauthorized", 401);
        if (s2 === "list"  && request.method === "GET")  return handleAdminList(env);
        if (s2 === "flush" && s3 && request.method === "POST") return handleAdminFlush(s3, env);
        if (s2 && request.method === "DELETE") return handleAdminDelete(s2, env);
      }

      return err("Not found", 404);
    }

    // ── /:uuid/* — proxy or profileset ────────────────────────────────────────
    if (segments.length >= 2 && /^[0-9a-f-]{36}$/i.test(s0)) {
      const [addonId, resource, ...rest] = segments;

      if (resource === "configure") return env.ASSETS.fetch(request);

      const cfg = await getConfig(addonId, env);
      if (cfg) {
        if (resource === "manifest.json") return handleManifest(addonId, env, workerUrl);
        if (resource === "catalog" && rest.length >= 2) {
          const [type, ...parts] = rest;
          const raw = parts.join("/").replace(/\.json$/, "");
          const si  = raw.indexOf("/");
          const catId = si === -1 ? raw : raw.slice(0, si);
          const extra = si === -1 ? "" : raw.slice(si + 1);
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
        return env.ASSETS.fetch(request);
      }

      const ps = await getProfileSet(addonId, env);
      if (ps) {
        if (resource === "manifest.json") return handlePSManifest(ps, workerUrl);

        if (resource === "poster") {
          const posterType = rest.join("/").replace(/\.svg$/, "");
          return handlePSPoster(ps, posterType);
        }

        if (resource === "catalog" && rest.length >= 1) {
          const [type, ...parts] = rest;
          const raw = parts.join("/").replace(/\.json$/, "");
          const si  = raw.indexOf("/");
          const catId = si === -1 ? raw : raw.slice(0, si);
          const extra = si === -1 ? "" : raw.slice(si + 1);
          return handlePSCatalog(ps, type, catId, extra, workerUrl);
        }

        if (resource === "meta" && rest.length >= 2) {
          const [type, ...parts] = rest;
          const itemId = decodeURIComponent(parts.join("/").replace(/\.json$/, ""));
          return handlePSMeta(ps, type, itemId, env, workerUrl);
        }

        if (resource === "stream" && rest.length >= 2) {
          const [type, ...parts] = rest;
          const itemId = decodeURIComponent(parts.join("/").replace(/\.json$/, ""));
          return handlePSStream(ps, type, itemId, env, workerUrl);
        }

        if (resource === "subtitles" && rest.length >= 2) {
          const [type, ...parts] = rest;
          const itemId = decodeURIComponent(parts.join("/").replace(/\.json$/, ""));
          return handlePSSubtitles(ps, type, itemId, env);
        }

        return env.ASSETS.fetch(request);
      }

      return err("Not found", 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
