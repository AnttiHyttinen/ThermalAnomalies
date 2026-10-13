// OpenStreetMap site context via the public Overpass API. Only a handful of top candidates are
// queried per request, so the shared public service is not stressed; results are cached briefly.

const OVERPASS_URLS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const ENDPOINT_TIMEOUT_MS = 25_000;
const RADIUS_M = 1500;
const MAX_POINTS = 15;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const FILTERS = [
  '["landuse"~"^(industrial|military|port|railway|depot)$"]',
  '["man_made"~"^(storage_tank|petroleum_well|works|silo|flare|gasometer|oil_gas_separator|pumping_station)$"]',
  '["industrial"]',
  '["power"~"^(plant|generator|substation)$"]',
  '["military"]',
  '["amenity"="fuel"]',
  '["building"~"^(industrial|warehouse|hangar|storage_tank|depot)$"]',
  '["aeroway"~"^(aerodrome|runway)$"]',
  '["pipeline"]',
];

export function validateSiteRequest(body) {
  const points = Array.isArray(body?.points) ? body.points : null;
  if (!points || points.length === 0) throw Object.assign(new Error("Kohdepisteet puuttuvat."), { status: 400, code: "INVALID_REQUEST" });
  if (points.length > MAX_POINTS) throw Object.assign(new Error(`Kohdetietohaku hyväksyy enintään ${MAX_POINTS} kohdetta kerrallaan.`), { status: 400, code: "INVALID_REQUEST" });
  return points.map((point) => {
    const latitude = Number(point.latitude), longitude = Number(point.longitude);
    if (typeof point.id !== "string" || point.id.length > 120 || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 85 || Math.abs(longitude) > 180) {
      throw Object.assign(new Error("Virheellinen kohdepiste."), { status: 400, code: "INVALID_REQUEST" });
    }
    return { id: point.id, latitude, longitude };
  });
}

export function buildOverpassQuery(points) {
  const statements = points.flatMap((p) => FILTERS.map((filter) => `nwr(around:${RADIUS_M},${p.latitude.toFixed(5)},${p.longitude.toFixed(5)})${filter};`));
  return `[out:json][timeout:25];(${statements.join("")});out tags center 400;`;
}

export function categorize(tags = {}) {
  const value = (key) => String(tags[key] || "").toLowerCase();
  const text = ["industrial", "product", "substance", "content", "name", "operator", "plant:source"].map(value).join(" ");
  const oilWords = /\b(oil|petrol\w*|petroleum|refiner\w*|gas|fuel|diesel|lng|lpg|tank farm)\b|нефт|нпз|топлив|азс/;
  const categories = new Set();
  if (oilWords.test(text) || ["petroleum_well", "flare", "oil_gas_separator", "gasometer"].includes(value("man_made")) || value("amenity") === "fuel" || tags.pipeline || value("landuse") === "depot" && /fuel|oil/.test(text)) categories.add("oilGas");
  if (["storage_tank", "silo"].includes(value("man_made")) || ["warehouse", "storage_tank", "depot"].includes(value("building")) || value("landuse") === "depot") categories.add("storage");
  if (value("landuse") === "industrial" || tags.industrial || ["works"].includes(value("man_made")) || value("building") === "industrial") categories.add("industrial");
  if (["plant", "generator", "substation"].includes(value("power"))) categories.add("power");
  if (value("landuse") === "military" || tags.military || value("building") === "hangar") categories.add("military");
  if (["port", "railway"].includes(value("landuse")) || ["aerodrome", "runway"].includes(value("aeroway"))) categories.add("transport");
  return [...categories];
}

export function summarizeSite(point, elements) {
  const categories = {}, nearest = {}, names = new Set();
  for (const element of elements) {
    const lat = element.lat ?? element.center?.lat, lon = element.lon ?? element.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceKm = haversineKm(point, { latitude: lat, longitude: lon });
    if (distanceKm > RADIUS_M / 1000) continue;
    const found = categorize(element.tags);
    for (const category of found) {
      categories[category] = (categories[category] || 0) + 1;
      nearest[category] = Math.min(nearest[category] ?? Infinity, distanceKm);
    }
    if (found.length && element.tags?.name && names.size < 4) names.add(String(element.tags.name).slice(0, 80));
  }
  return { status: "ready", radiusKm: RADIUS_M / 1000, categories, nearestKm: nearest, names: [...names], source: "OpenStreetMap / Overpass" };
}

export async function assessSites(points, { signal, fetchImpl = fetch } = {}) {
  const now = Date.now();
  const results = new Map();
  const missing = [];
  for (const point of points) {
    const hit = cache.get(cacheKey(point));
    if (hit && now - hit.at < CACHE_TTL_MS) results.set(point.id, hit.value);
    else missing.push(point);
  }
  if (missing.length) {
    let elements;
    try {
      elements = await queryOverpass(buildOverpassQuery(missing), signal, fetchImpl);
    } catch (error) {
      signal?.throwIfAborted();
      for (const point of missing) results.set(point.id, { status: "error", label: "Kohdetietoja ei saatu OpenStreetMapista" });
      elements = null;
    }
    if (elements) {
      for (const point of missing) {
        const value = summarizeSite(point, elements);
        cache.set(cacheKey(point), { at: now, value });
        results.set(point.id, value);
      }
      while (cache.size > 500) cache.delete(cache.keys().next().value);
    }
  }
  return points.map((point) => ({ id: point.id, siteContext: results.get(point.id) }));
}

async function queryOverpass(query, signal, fetchImpl) {
  let lastError;
  for (const url of OVERPASS_URLS) {
    try {
      const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "lampopoikkeamat/1.7 (thermal anomaly viewer)" },
        body: new URLSearchParams({ data: query }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      return (await response.json()).elements || [];
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    }
  }
  throw lastError;
}

function cacheKey(point) { return `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`; }

function haversineKm(left, right) {
  const r = (d) => d * Math.PI / 180;
  const a = Math.sin(r(right.latitude - left.latitude) / 2) ** 2 + Math.cos(r(left.latitude)) * Math.cos(r(right.latitude)) * Math.sin(r(right.longitude - left.longitude) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}
