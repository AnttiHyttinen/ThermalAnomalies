import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRMS_SOURCES,
  addUtcDays,
  areaKey,
  buildFirmsUrl,
  deduplicateDetections,
  fourteenDaySegments,
  isLikelyMapKey,
  normalizeDetection,
  parseCsv,
  utcDateString,
  validateArea,
  validateSelectedDate,
} from "./src/firms.mjs";
import { assessLandcover, validateContextRequest } from "./src/landcover.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const port = Number(process.env.PORT || 4173);
const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url || "/", "http://localhost");

  try {
    if (url.pathname === "/api/hotspots") {
      await handleHotspots(request, response, url);
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, date: utcDateString() });
      return;
    }

    if (url.pathname === "/api/landcover") {
      await handleLandcover(request, response);
      return;
    }

    await serveStatic(request, response, url.pathname);
  } catch (error) {
    if (response.destroyed) return;
    const status = Number(error.status) || 500;
    const code = error.code || "INTERNAL_ERROR";
    const message = status >= 500
      ? "Havaintojen käsittely epäonnistui. Yritä hetken kuluttua uudelleen."
      : error.message;
    sendJson(response, status, { error: { code, message } });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(port, () => console.log(`Lämpöpoikkeamat: http://localhost:${port}`));
}

async function handleLandcover(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: { message: "Vain POST on sallittu." } });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 96000) throw Object.assign(new Error("Maanpeitepyyntö on liian suuri."), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Virheellinen JSON-pyyntö."), { status: 400 }); }
  const events = validateContextRequest(body);
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  const results = [];
  // Bound concurrent COG reads to two; failed enrichment leaves thermal results usable.
  for (let i = 0; i < events.length; i += 2) {
    controller.signal.throwIfAborted();
    results.push(...await Promise.all(events.slice(i, i + 2).map((event) => assessLandcover(event, { signal: controller.signal }))));
  }
  sendJson(response, 200, { results });
}

async function handleHotspots(request, response, url) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Vain GET on sallittu." } });
    return;
  }

  const area = validateArea(url.searchParams);
  const today = validateSelectedDate(url.searchParams.get("date"));
  // Only this request's user-supplied key is allowed. Never fall back to a shared server key.
  const mapKey = String(request.headers["x-firms-map-key"] || "").trim();

  if (!mapKey) {
    sendJson(response, 401, {
      error: {
        code: "MAP_KEY_REQUIRED",
        message: "Syötä maksuton NASA FIRMS MAP_KEY havaintojen hakemista varten.",
      },
    });
    return;
  }

  if (!isLikelyMapKey(mapKey)) {
    sendJson(response, 401, {
      error: { code: "INVALID_MAP_KEY", message: "MAP_KEY ei ole oikeassa muodossa." },
    });
    return;
  }

  const keyFingerprint = createHash("sha256").update(mapKey).digest("hex");
  const cacheKey = `${today}:${keyFingerprint}:${areaKey(area)}`;
  const cached = responseCache.get(cacheKey);
  const bypassCache = url.searchParams.has("refresh");
  if (!bypassCache && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Cache", "HIT");
    sendJson(response, 200, cached.payload);
    return;
  }

  const controller = new AbortController();
  response.once("close", () => controller.abort());
  const result = await fetchFourteenDays({ mapKey, area, today, signal: controller.signal });
  if (response.destroyed) return;
  responseCache.set(cacheKey, { createdAt: Date.now(), payload: result });
  pruneCache();
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Cache", "MISS");
  sendJson(response, 200, result);
}

export async function fetchFourteenDays({ mapKey, area, today, signal }) {
  const segments = fourteenDaySegments(today);
  const sourceResults = await Promise.all(FIRMS_SOURCES.map(async (source) => {
    const detections = [];
    const successfulSegments = [];
    const failedSegments = [];
    for (const segment of segments) {
      signal?.throwIfAborted();
      const url = buildFirmsUrl({ mapKey, source, area, ...segment });
      try {
        const result = await fetchFirmsCsvWithRetry(url, source, 2, signal);
        detections.push(...result);
        successfulSegments.push(segment);
      } catch (error) {
        signal?.throwIfAborted();
        failedSegments.push({ segment, error });
      }
    }
    return { source, detections, successfulSegments, failedSegments };
  }));

  const failed = sourceResults.flatMap((result) => result.failedSegments.map((failure) => ({
    source: result.source,
    ...failure,
  })));
  const successful = sourceResults.filter((result) => result.successfulSegments.length > 0);

  if (successful.length === 0) {
    const invalidKey = failed.some(({ error }) => error.code === "INVALID_MAP_KEY");
    throw Object.assign(
      new Error(invalidKey ? "NASA FIRMS hylkäsi MAP_KEY-avaimen." : "NASA FIRMS -palveluun ei saatu yhteyttä."),
      { code: invalidKey ? "INVALID_MAP_KEY" : "UPSTREAM_ERROR", status: invalidKey ? 401 : 502 },
    );
  }

  if (failed.some(({ error }) => error.code === "INVALID_MAP_KEY")) {
    throw Object.assign(new Error("NASA FIRMS hylkäsi MAP_KEY-avaimen."), {
      code: "INVALID_MAP_KEY",
      status: 401,
    });
  }

  const detections = deduplicateDetections(successful.flatMap((result) => result.detections));
  const analysisStart = segments[0].start;
  const displayStart = addUtcDays(today, -6);
  return {
    generatedAt: new Date().toISOString(),
    range: { start: displayStart, end: today, days: 7, timezone: "UTC" },
    analysisRange: { start: analysisStart, end: today, days: 14, timezone: "UTC" },
    area,
    detections,
    sources: successful.map((result) => result.source),
    coverageComplete: failed.length === 0,
    sourceCoverage: sourceResults.map((result) => ({
      source: result.source,
      requestedSegments: segments.length,
      successfulSegments: result.successfulSegments.length,
      missing: result.failedSegments.map(({ segment }) => segment),
    })),
    warnings: failed.map(({ source, segment, error }) => (
      `${source} ${segment.start} (${segment.days} vrk): ${error.message}`
    )),
  };
}

async function fetchFirmsCsvWithRetry(url, source, attempts = 2, signal) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchFirmsCsv(url, source, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === "INVALID_MAP_KEY") throw error;
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError;
}

async function fetchFirmsCsv(url, source, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      headers: { Accept: "text/csv" },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    const text = await response.text();

    if (/invalid\s+(map[_ ]?key|key)/i.test(text)) {
      throw Object.assign(new Error("NASA FIRMS hylkäsi MAP_KEY-avaimen."), {
        code: "INVALID_MAP_KEY",
      });
    }

    if (!response.ok) {
      throw new Error(`NASA FIRMS vastasi tilakoodilla ${response.status}.`);
    }

    const firstLine = text.split(/\r?\n/, 1)[0].toLowerCase();
    if (!firstLine.includes("latitude") || !firstLine.includes("longitude")) {
      throw new Error("NASA ei palauttanut havaintotaulukkoa. Tarkista päivän NRT-aineiston saatavuus tai yritä uudelleen.");
    }

    return parseCsv(text)
      .map((row) => normalizeDetection(row, source))
      .filter(Boolean);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("NASA FIRMS -pyyntö aikakatkaistiin.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.writeHead(405).end();
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requestedPath);
  const safePath = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicRoot, safePath);

  if (!filePath.startsWith(publicRoot) || safePath.includes("/.")) {
    response.writeHead(404).end();
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404).end();
      return;
    }

    const extension = extname(filePath);
    response.setHeader("Content-Type", contentTypes[extension] || "application/octet-stream");
    response.setHeader(
      "Cache-Control",
      [".html", ".css", ".js"].includes(extension) ? "no-cache, must-revalidate" : "public, max-age=3600",
    );
    response.writeHead(200);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404).end();
      return;
    }
    throw error;
  }
}

function sendJson(response, status, payload) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status).end(JSON.stringify(payload));
}

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "connect-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function pruneCache() {
  const expiry = Date.now() - CACHE_TTL_MS;
  for (const [key, value] of responseCache) {
    if (value.createdAt < expiry) {
      responseCache.delete(key);
    }
  }
  while (responseCache.size > 60) responseCache.delete(responseCache.keys().next().value);
}
