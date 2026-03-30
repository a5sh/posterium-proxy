// /home/claude/posterium-proxy/src/index.ts

export interface Env {
  PROXY_CONFIGS: KVNamespace;
  ASSETS: Fetcher;
}

// ─── Stremio protocol constants ───────────────────────────────────────────────

const VALID_RESOURCES    = new Set(["catalog", "meta", "stream", "subtitles", "addon_catalog"]);
const VALID_TYPES        = new Set(["movie", "series", "channel", "tv"]);
const VALID_POSTER_SHAPES = new Set(["", "square", "poster", "landscape"]);
const MANIFEST_MAX_BYTES  = 8192;

// ─── Data model ───────────────────────────────────────────────────────────────

interface ProxyConfig {
  id: string;
  upstreamBaseUrl: string;

  // Image overrides — use {id}, {type}, {season}, {episode} as template vars
  posterUrl: string;
  logoUrl: string;
  backgroundUrl: string;
  bannerUrl: string;
  thumbnailUrl: string;          // for video objects (episodes, channel uploads)
  posterShape: "" | "square" | "poster" | "landscape";

  // Text overrides
  namePrefix: string;
  nameSuffix: string;
  descriptionPrefix: string;
  descriptionSuffix: string;

  // Feature toggles
  enableCatalog: boolean;
  enableMeta: boolean;
  enableStreams: boolean;
  enableSubtitles: boolean;
  enableSearch: boolean;         // strips search extra from catalog definitions

  // Content filters
  allowedTypes: string[];        // empty = all
  forceHttpsStreams: boolean;    // rewrite http:// stream URLs to https://
  stripTorrents: boolean;        // remove infoHash-based streams
  stripMagnetStreams: boolean;   // remove magnet: URLs
  stripAdultFlag: boolean;       // remove manifest.behaviorHints.adult
  stripP2PFlag: boolean;         // remove manifest.behaviorHints.p2p

  // Subtitle language whitelist (ISO 639-2, empty = all)
  subtitleLanguages: string[];

  // Cache TTL overrides (seconds; 0 = no custom Cache-Control added)
  catalogCacheTtl: number;
  metaCacheTtl: number;
  streamCacheTtl: number;
  subtitleCacheTtl: number;

  createdAt: number;
}

// ─── Stremio types (minimal) ──────────────────────────────────────────────────

interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types: string[];
  catalogs: StremioManifestCatalog[];
  idPrefixes?: string[];
  addonCatalogs?: StremioManifestCatalog[];
  behaviorHints?: {
    adult?: boolean;
    p2p?: boolean;
    configurable?: boolean;
    configurationRequired?: boolean;
    [k: string]: unknown;
  };
  background?: string;
  logo?: string;
  contactEmail?: string;
  [k: string]: unknown;
}

interface StremioManifestCatalog {
  type: string;
  id: string;
  name?: string;
  extra?: { name: string; isRequired?: boolean; options?: string[]; optionsLimit?: number }[];
  [k: string]: unknown;
}

interface StremioMeta {
  id: string;
  type: string;
  name?: string;
  poster?: string;
  posterShape?: string;
  logo?: string;
  background?: string;
  banner?: string;
  description?: string;
  videos?: StremioVideo[];
  [k: string]: unknown;
}

interface StremioVideo {
  id: string;
  title?: string;
  thumbnail?: string;
  released?: string;
  season?: number;
  episode?: number;
  [k: string]: unknown;
}

interface StremioStream {
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  ytId?: string;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: { notWebReady?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

// ─── Manifest validation ──────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: StremioManifest;
  resources: string[];
  types: string[];
  hasCatalog: boolean;
  hasMeta: boolean;
  hasStream: boolean;
  hasSubtitles: boolean;
}

/**
 * Strict validator mirroring stremio-addon-linter rules + PosteriumProxy abuse guards.
 * All rules documented inline.
 */
function validateManifest(raw: unknown): ValidationResult {
  const result: ValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    resources: [],
    types: [],
    hasCatalog: false,
    hasMeta: false,
    hasStream: false,
    hasSubtitles: false,
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    result.errors.push("Manifest must be a JSON object");
    return result;
  }

  const m = raw as Record<string, unknown>;

  // ── Required string fields (SDK rule: must be present and non-empty) ────────
  for (const field of ["id", "name", "version"] as const) {
    if (typeof m[field] !== "string" || !(m[field] as string).trim()) {
      result.errors.push(`manifest.${field} must be a non-empty string`);
    }
  }

  // ── ID: dot-separated alphanumeric (linter: manifest.id must be a string) ──
  if (typeof m.id === "string") {
    if (!/^[a-zA-Z0-9._-]+$/.test(m.id)) {
      result.errors.push(
        `manifest.id "${m.id}" must only contain alphanumerics, dots, dashes, underscores`,
      );
    }
    if (m.id.length > 128) {
      result.errors.push("manifest.id is suspiciously long (>128 chars) — possible abuse");
    }
  }

  // ── Version: must look like semver (linter requirement) ────────────────────
  if (typeof m.version === "string" && !/^\d+\.\d+\.\d+/.test(m.version)) {
    result.warnings.push(`manifest.version "${m.version}" should follow semver (e.g. 1.0.0)`);
  }

  // ── description: required by Stremio protocol (warn, not error) ────────────
  if (typeof m.description !== "string" || !m.description.trim()) {
    result.warnings.push("manifest.description is missing or empty");
  }

  // ── resources: must be non-empty array of valid resource names ──────────────
  if (!Array.isArray(m.resources) || m.resources.length === 0) {
    result.errors.push("manifest.resources must be a non-empty array");
  } else {
    for (const r of m.resources) {
      const name =
        typeof r === "string" ? r : (typeof r === "object" && r !== null ? (r as Record<string, unknown>).name : undefined);
      if (typeof name !== "string" || !VALID_RESOURCES.has(name)) {
        result.errors.push(
          `manifest.resources contains invalid resource "${name}". Valid: ${[...VALID_RESOURCES].join(", ")}`,
        );
      } else {
        result.resources.push(name);
      }
    }
    result.hasCatalog   = result.resources.includes("catalog");
    result.hasMeta      = result.resources.includes("meta");
    result.hasStream    = result.resources.includes("stream");
    result.hasSubtitles = result.resources.includes("subtitles");
  }

  // ── types: must be non-empty array of valid content types ──────────────────
  if (!Array.isArray(m.types) || m.types.length === 0) {
    result.errors.push("manifest.types must be a non-empty array");
  } else {
    for (const t of m.types) {
      if (!VALID_TYPES.has(t as string)) {
        result.errors.push(
          `manifest.types contains unknown type "${t}". Valid: ${[...VALID_TYPES].join(", ")}`,
        );
      } else {
        result.types.push(t as string);
      }
    }
  }

  // ── catalogs: must be an array; each entry needs type + id ─────────────────
  if (!Array.isArray(m.catalogs)) {
    result.errors.push("manifest.catalogs must be an array (use [] if you have none)");
  } else {
    for (let i = 0; i < m.catalogs.length; i++) {
      const cat = m.catalogs[i] as Record<string, unknown>;
      if (typeof cat.type !== "string" || !cat.type)
        result.errors.push(`catalogs[${i}].type is required (string)`);
      if (typeof cat.id !== "string" || !cat.id)
        result.errors.push(`catalogs[${i}].id is required (string)`);
    }
    if (result.hasCatalog && m.catalogs.length === 0) {
      result.warnings.push('"catalog" is in resources but catalogs array is empty');
    }
    // Abuse guard: too many catalogs
    if (m.catalogs.length > 50) {
      result.errors.push(`Too many catalogs (${m.catalogs.length}). Maximum allowed: 50`);
    }
  }

  // ── Size check (SDK: manifest must be <8192 bytes) ─────────────────────────
  const sizeBytes = new TextEncoder().encode(JSON.stringify(m)).length;
  if (sizeBytes > MANIFEST_MAX_BYTES) {
    result.errors.push(`Manifest is ${sizeBytes} bytes — exceeds the ${MANIFEST_MAX_BYTES}-byte SDK limit`);
  }

  // ── XSS / injection guard on all string fields ─────────────────────────────
  const textFields = ["id", "name", "description", "version", "contactEmail"] as const;
  for (const field of textFields) {
    const v = m[field];
    if (typeof v === "string" && (/<script/i.test(v) || /javascript:/i.test(v) || /data:/i.test(v))) {
      result.errors.push(`manifest.${field} contains potentially unsafe content`);
    }
  }

  result.valid = result.errors.length === 0;
  if (result.valid) result.manifest = m as StremioManifest;
  return result;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400, details?: unknown): Response {
  return json({ error: msg, ...(details ? { details } : {}) }, status);
}

function jsonWithCache(data: unknown, ttl: number): Response {
  const res = json(data);
  if (ttl <= 0) return res;
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", `max-age=${ttl}, public`);
  return new Response(res.body, { status: 200, headers });
}

// ─── Template / URL helpers ───────────────────────────────────────────────────

function applyTemplate(
  template: string | undefined,
  vars: Record<string, string | number>,
): string | undefined {
  if (!template) return undefined;
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v !== undefined ? encodeURIComponent(String(v)) : `{${k}}`;
  });
}

function normalizeUpstreamBase(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url.endsWith("/manifest.json")) url = url.slice(0, -"/manifest.json".length);
  return url;
}

async function proxyFetch(url: string, timeoutMs = 9000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "PosteriumProxy/2.0 (Stremio Addon Proxy)" },
      signal: controller.signal,
      cf: { cacheTtl: 30, cacheEverything: false },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getConfig(id: string, env: Env): Promise<ProxyConfig | null> {
  const raw = await env.PROXY_CONFIGS.get(`proxy:${id}`);
  return raw ? (JSON.parse(raw) as ProxyConfig) : null;
}

async function putConfig(cfg: ProxyConfig, env: Env): Promise<void> {
  await env.PROXY_CONFIGS.put(`proxy:${cfg.id}`, JSON.stringify(cfg), {
    expirationTtl: 60 * 60 * 24 * 365,
  });
}

// ─── Content transformers ─────────────────────────────────────────────────────

function patchMeta(meta: StremioMeta, cfg: ProxyConfig): StremioMeta {
  const vars = { id: meta.id, type: meta.type };
  const out  = { ...meta };

  // Image fields
  const poster     = applyTemplate(cfg.posterUrl,     vars);
  const logo       = applyTemplate(cfg.logoUrl,       vars);
  const background = applyTemplate(cfg.backgroundUrl, vars);
  const banner     = applyTemplate(cfg.bannerUrl,     vars);
  if (poster)     out.poster     = poster;
  if (logo)       out.logo       = logo;
  if (background) out.background = background;
  if (banner)     out.banner     = banner;

  // posterShape (square | poster | landscape)
  if (cfg.posterShape && VALID_POSTER_SHAPES.has(cfg.posterShape)) {
    out.posterShape = cfg.posterShape;
  }

  // Description overlay
  if (cfg.descriptionPrefix || cfg.descriptionSuffix) {
    out.description = `${cfg.descriptionPrefix}${out.description ?? ""}${cfg.descriptionSuffix}`.trim();
  }

  // Video thumbnails — covers series episodes, channel uploads
  if (Array.isArray(out.videos) && cfg.thumbnailUrl) {
    out.videos = (out.videos as StremioVideo[]).map((v) => {
      const thumb = applyTemplate(cfg.thumbnailUrl, {
        id: v.id,
        type: meta.type,
        season:  v.season  ?? "",
        episode: v.episode ?? "",
      });
      return thumb ? { ...v, thumbnail: thumb } : v;
    });
  }

  return out;
}

function filterStream(stream: StremioStream, cfg: ProxyConfig): StremioStream | null {
  if (cfg.stripTorrents && stream.infoHash) return null;
  if (cfg.stripMagnetStreams && typeof stream.url === "string" && stream.url.startsWith("magnet:")) return null;
  if (cfg.forceHttpsStreams && typeof stream.url === "string" && stream.url.startsWith("http://")) {
    // Also must mark notWebReady=false since we're fixing the URL
    return { ...stream, url: stream.url.replace(/^http:\/\//, "https://") };
  }
  return stream;
}

function patchManifest(manifest: StremioManifest, cfg: ProxyConfig): StremioManifest {
  const out = { ...manifest };

  // Unique addon ID so Stremio treats proxy as a distinct addon
  out.id = `com.posteriumproxy.${cfg.id}`;

  // Name
  const origName = manifest.name ?? "";
  out.name = `${cfg.namePrefix}${origName}${cfg.nameSuffix}`.trim() || origName;

  // Description
  if (cfg.descriptionPrefix || cfg.descriptionSuffix) {
    out.description = `${cfg.descriptionPrefix}${manifest.description ?? ""}${cfg.descriptionSuffix}`.trim();
  }
  out.description = `[PosteriumProxy] ${out.description ?? ""}`.trim();

  // Behavior hints
  const bh = { ...(manifest.behaviorHints ?? {}) };
  if (cfg.stripAdultFlag) delete bh.adult;
  if (cfg.stripP2PFlag)   delete bh.p2p;
  // Disable reconfiguration since our proxy has its own config
  bh.configurable = false;
  bh.configurationRequired = false;
  out.behaviorHints = bh;

  // Filter resources by toggles
  out.resources = manifest.resources.filter((r) => {
    const name = typeof r === "string" ? r : r.name;
    if (name === "catalog"   && !cfg.enableCatalog)   return false;
    if (name === "meta"      && !cfg.enableMeta)       return false;
    if (name === "stream"    && !cfg.enableStreams)     return false;
    if (name === "subtitles" && !cfg.enableSubtitles)  return false;
    return true;
  });

  // Filter types
  if (cfg.allowedTypes.length > 0) {
    out.types = manifest.types.filter((t) => cfg.allowedTypes.includes(t));
    // Also filter per-resource type lists
    out.resources = out.resources.map((r) => {
      if (typeof r === "string") return r;
      const types = (r.types ?? []).filter((t) => cfg.allowedTypes.includes(t));
      return { ...r, types };
    }).filter((r) => typeof r === "string" || !r.types || r.types.length > 0);
  }

  // Catalogs: strip search if disabled, filter by allowed types
  if (Array.isArray(out.catalogs)) {
    let cats = out.catalogs as StremioManifestCatalog[];
    if (cfg.allowedTypes.length > 0) {
      cats = cats.filter((c) => cfg.allowedTypes.includes(c.type));
    }
    if (!cfg.enableSearch) {
      cats = cats.map((c) => ({
        ...c,
        extra: (c.extra ?? []).filter((e) => e.name !== "search"),
      }));
    }
    out.catalogs = cats;
  }

  return out;
}

// ─── API handlers ─────────────────────────────────────────────────────────────

async function handlePreview(req: Request): Promise<Response> {
  let body: { upstreamManifestUrl?: string };
  try { body = await req.json(); }
  catch { return err("Invalid JSON body"); }

  const rawUrl = body.upstreamManifestUrl ?? "";
  if (!rawUrl) return err("upstreamManifestUrl is required");

  let base: string;
  try {
    base = normalizeUpstreamBase(rawUrl);
    new URL(`${base}/manifest.json`); // throws if invalid
  } catch { return err("upstreamManifestUrl is not a valid URL", 422); }

  let raw: unknown;
  try { raw = await proxyFetch(`${base}/manifest.json`); }
  catch (e) { return err(`Cannot reach upstream: ${(e as Error).message}`, 422); }

  const validation = validateManifest(raw);
  return json({ upstreamBaseUrl: base, validation, raw: validation.manifest ?? raw });
}

async function handleCreate(req: Request, env: Env, workerUrl: string): Promise<Response> {
  let body: Partial<ProxyConfig> & { upstreamManifestUrl?: string };
  try { body = await req.json(); }
  catch { return err("Invalid JSON body"); }

  const rawUrl = body.upstreamManifestUrl ?? body.upstreamBaseUrl ?? "";
  if (!rawUrl) return err("upstreamManifestUrl is required");

  let upstreamBaseUrl: string;
  try {
    upstreamBaseUrl = normalizeUpstreamBase(rawUrl);
    new URL(`${upstreamBaseUrl}/manifest.json`);
  } catch { return err("upstreamManifestUrl is not a valid URL", 422); }

  let raw: unknown;
  try { raw = await proxyFetch(`${upstreamBaseUrl}/manifest.json`); }
  catch (e) { return err(`Cannot reach upstream addon: ${(e as Error).message}`, 422); }

  const validation = validateManifest(raw);
  if (!validation.valid) {
    return err("Upstream manifest failed validation", 422, validation.errors);
  }

  // Validate posterShape
  const posterShape = (body.posterShape ?? "") as ProxyConfig["posterShape"];
  if (!VALID_POSTER_SHAPES.has(posterShape)) {
    return err(`posterShape must be one of: ${[...VALID_POSTER_SHAPES].filter(Boolean).join(", ")}`);
  }

  // Allowed types must be a subset of what the upstream offers
  const allowedTypes = (body.allowedTypes ?? []).filter(
    (t) => VALID_TYPES.has(t) && validation.types.includes(t),
  );

  // Subtitle language codes: basic sanity (2-3 chars)
  const subtitleLanguages = (body.subtitleLanguages ?? []).filter(
    (l) => typeof l === "string" && /^[a-z]{2,3}$/.test(l),
  );

  const id = crypto.randomUUID();
  const cfg: ProxyConfig = {
    id,
    upstreamBaseUrl,

    posterUrl:     body.posterUrl     ?? "",
    logoUrl:       body.logoUrl       ?? "",
    backgroundUrl: body.backgroundUrl ?? "",
    bannerUrl:     body.bannerUrl     ?? "",
    thumbnailUrl:  body.thumbnailUrl  ?? "",
    posterShape,

    namePrefix:        body.namePrefix        ?? "",
    nameSuffix:        body.nameSuffix        ?? "",
    descriptionPrefix: body.descriptionPrefix ?? "",
    descriptionSuffix: body.descriptionSuffix ?? "",

    enableCatalog:   body.enableCatalog   ?? true,
    enableMeta:      body.enableMeta      ?? true,
    enableStreams:    body.enableStreams   ?? true,
    enableSubtitles: body.enableSubtitles ?? true,
    enableSearch:    body.enableSearch    ?? true,

    allowedTypes,
    forceHttpsStreams:  body.forceHttpsStreams  ?? false,
    stripTorrents:      body.stripTorrents      ?? false,
    stripMagnetStreams: body.stripMagnetStreams  ?? false,
    stripAdultFlag:     body.stripAdultFlag     ?? false,
    stripP2PFlag:       body.stripP2PFlag       ?? false,

    subtitleLanguages,

    catalogCacheTtl:  Math.max(0, Number(body.catalogCacheTtl  ?? 0)),
    metaCacheTtl:     Math.max(0, Number(body.metaCacheTtl     ?? 0)),
    streamCacheTtl:   Math.max(0, Number(body.streamCacheTtl   ?? 0)),
    subtitleCacheTtl: Math.max(0, Number(body.subtitleCacheTtl ?? 0)),

    createdAt: Date.now(),
  };

  await putConfig(cfg, env);

  const manifestUrl = `${workerUrl}/${id}/manifest.json`;
  const stremioUrl  = `stremio://${new URL(manifestUrl).host}/${id}/manifest.json`;

  return json({ id, manifestUrl, stremioUrl, config: cfg, upstreamManifest: validation.manifest });
}

async function handleGetConfig(id: string, env: Env): Promise<Response> {
  const cfg = await getConfig(id, env);
  return cfg ? json(cfg) : err("Proxy not found", 404);
}

async function handleDeleteConfig(id: string, env: Env): Promise<Response> {
  await env.PROXY_CONFIGS.delete(`proxy:${id}`);
  return json({ deleted: true });
}

async function handleList(env: Env): Promise<Response> {
  const list = await env.PROXY_CONFIGS.list({ prefix: "proxy:" });
  const items = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.PROXY_CONFIGS.get(k.name);
      if (!raw) return null;
      const { id, upstreamBaseUrl, namePrefix, nameSuffix, createdAt } = JSON.parse(raw) as ProxyConfig;
      return { id, upstreamBaseUrl, namePrefix, nameSuffix, createdAt };
    }),
  );
  return json({ proxies: items.filter(Boolean) });
}

// ─── Addon proxy handlers ──────────────────────────────────────────────────────

async function handleManifest(id: string, env: Env, workerUrl: string): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);

  let upstream: StremioManifest;
  try {
    const raw = await proxyFetch(`${cfg.upstreamBaseUrl}/manifest.json`);
    const val = validateManifest(raw);
    if (!val.valid) throw new Error(val.errors[0]);
    upstream = val.manifest!;
  } catch (e) {
    return err(`Upstream error: ${(e as Error).message}`, 502);
  }

  return json(patchManifest(upstream, cfg));
}

async function handleCatalog(
  id: string, type: string, catalogId: string, extraPath: string, env: Env,
): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableCatalog) return json({ metas: [] });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return json({ metas: [] });

  const url = `${cfg.upstreamBaseUrl}/catalog/${type}/${catalogId}${extraPath ? `/${extraPath}` : ""}.json`;
  let upstream: { metas?: StremioMeta[] };
  try { upstream = (await proxyFetch(url)) as { metas?: StremioMeta[] }; }
  catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }

  const metas = (upstream.metas ?? []).map((m) => patchMeta(m, cfg));
  return jsonWithCache({ metas }, cfg.catalogCacheTtl);
}

async function handleMeta(
  id: string, type: string, itemId: string, env: Env,
): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableMeta) return json({ meta: null });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return json({ meta: null });

  const url = `${cfg.upstreamBaseUrl}/meta/${type}/${itemId}.json`;
  let upstream: { meta?: StremioMeta };
  try { upstream = (await proxyFetch(url)) as { meta?: StremioMeta }; }
  catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }

  const meta = upstream.meta ? patchMeta(upstream.meta, cfg) : null;
  return jsonWithCache({ meta }, cfg.metaCacheTtl);
}

async function handleStream(
  id: string, type: string, itemId: string, env: Env,
): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableStreams) return json({ streams: [] });
  if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) return json({ streams: [] });

  const url = `${cfg.upstreamBaseUrl}/stream/${type}/${itemId}.json`;
  let upstream: { streams?: StremioStream[] };
  try { upstream = (await proxyFetch(url)) as { streams?: StremioStream[] }; }
  catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }

  const streams = (upstream.streams ?? [])
    .map((s) => filterStream(s, cfg))
    .filter((s): s is StremioStream => s !== null);

  return jsonWithCache({ streams }, cfg.streamCacheTtl);
}

async function handleSubtitles(
  id: string, type: string, itemId: string, env: Env,
): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  if (!cfg.enableSubtitles) return json({ subtitles: [] });

  const url = `${cfg.upstreamBaseUrl}/subtitles/${type}/${itemId}.json`;
  let upstream: { subtitles?: StremioSubtitle[] };
  try { upstream = (await proxyFetch(url)) as { subtitles?: StremioSubtitle[] }; }
  catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }

  let subtitles = upstream.subtitles ?? [];
  if (cfg.subtitleLanguages.length > 0) {
    subtitles = subtitles.filter((s) => cfg.subtitleLanguages.includes(s.lang));
  }
  return jsonWithCache({ subtitles }, cfg.subtitleCacheTtl);
}

async function handleAddonCatalog(
  id: string, type: string, catalogId: string, env: Env,
): Promise<Response> {
  const cfg = await getConfig(id, env);
  if (!cfg) return err("Proxy not found", 404);
  const url = `${cfg.upstreamBaseUrl}/addon_catalog/${type}/${catalogId}.json`;
  try { return json(await proxyFetch(url)); }
  catch (e) { return err(`Upstream error: ${(e as Error).message}`, 502); }
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url      = new URL(request.url);
    const workerUrl = `${url.protocol}//${url.host}`;
    const segments  = url.pathname.replace(/^\//, "").split("/");

    // ── API ──────────────────────────────────────────────────────────────────
    if (segments[0] === "api") {
      if (segments[1] === "preview" && request.method === "POST") return handlePreview(request);
      if (segments[1] === "create"  && request.method === "POST") return handleCreate(request, env, workerUrl);
      if (segments[1] === "list"    && request.method === "GET")  return handleList(env);
      if (segments[1] === "config"  && segments[2]) {
        if (request.method === "GET")    return handleGetConfig(segments[2], env);
        if (request.method === "DELETE") return handleDeleteConfig(segments[2], env);
      }
      return err("Not found", 404);
    }

    // ── Addon proxy ──────────────────────────────────────────────────────────
    if (segments.length >= 2 && /^[0-9a-f-]{36}$/.test(segments[0])) {
      const [addonId, resource, ...rest] = segments;

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
