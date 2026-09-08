import { fromCustomClient } from "geotiff";
import { summarizeLandcover } from "../public/assessment.js";

const ROOT = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/";
const resultsCache = new Map();
const imageCache = new Map();
const MAX_POINTS = 48;

export function tileFor(latitude, longitude) {
  const lat = Math.floor(Math.min(89.999999, latitude) / 3) * 3;
  const lon = Math.floor((((longitude + 180) % 360 + 360) % 360 - 180) / 3) * 3;
  const code = `${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}`;
  return { code, url: `${ROOT}ESA_WorldCover_10m_2021_v200_${code}_Map.tif` };
}

export function validateContextRequest(body) {
  if (!Array.isArray(body?.events) || body.events.length > 6) throw Object.assign(new Error("Maanpeitehaku hyväksyy enintään kuusi kohdetta kerrallaan."), { status: 400 });
  return body.events.map((event) => {
    if (typeof event?.id !== "string" || event.id.length > 120 || !Array.isArray(event.points) || event.points.length < 1 || event.points.length > MAX_POINTS || !Number.isInteger(event.totalPoints) || event.totalPoints < event.points.length || event.totalPoints > 1000000) throw Object.assign(new Error("Virheelliset maanpeitehaun kohdetiedot."), { status: 400 });
    const points = event.points.map((p) => {
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 85 || Math.abs(p.longitude) > 180) throw Object.assign(new Error("Virheellinen koordinaatti."), { status: 400 });
      return { latitude: p.latitude, longitude: p.longitude, scanKm: Number.isFinite(p.scanKm) && p.scanKm > 0 ? Math.min(p.scanKm, 3) : 0.375, trackKm: Number.isFinite(p.trackKm) && p.trackKm > 0 ? Math.min(p.trackKm, 3) : 0.375 };
    });
    return { id: event.id, points, totalPoints: event.totalPoints };
  });
}

export function sampleSupport(points) {
  const samples = [];
  for (const p of points) {
    // 5 × 5 samples over a buffered pixel support. Orientation is unknown in FIRMS CSV.
    const radius = Math.min(1.2, Math.max(0.35, Math.hypot(p.scanKm || 0.375, p.trackKm || 0.375) / 2 + 0.15));
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      const latitude = p.latitude + y / 2 * radius / 111.32;
      const longitude = p.longitude + x / 2 * radius / (111.32 * Math.max(0.01, Math.cos(p.latitude * Math.PI / 180)));
      samples.push({ latitude, longitude: ((longitude + 180) % 360 + 360) % 360 - 180, zone: "buffer" });
      // Dense inner grid is separate from the localisation buffer. Pixel orientation is unavailable.
      const innerLatitude = p.latitude + y / 2 * (p.trackKm || 0.375) / 2 / 111.32;
      const innerLongitude = p.longitude + x / 2 * (p.scanKm || 0.375) / 2 / (111.32 * Math.max(0.01, Math.cos(p.latitude * Math.PI / 180)));
      samples.push({ latitude: innerLatitude, longitude: ((innerLongitude + 180) % 360 + 360) % 360 - 180, zone: "pixel" });
    }
  }
  return samples;
}

async function openImage(tile, signal) {
  // Bound compressed block caches and avoid caching aborted in-flight requests.
  if (imageCache.has(tile.code)) return imageCache.get(tile.code);
  const client = {
    async request({ headers, signal: requestSignal } = {}) {
      const timeout = AbortSignal.timeout(8000);
      const response = await fetch(tile.url, { headers, signal: requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout });
      return { status: response.status, ok: response.ok, getHeader: (name) => response.headers.get(name), getData: () => response.arrayBuffer() };
    },
  };
  const tiff = await fromCustomClient(client, { allowFullFile: false, blockSize: 65536, cacheSize: 32 }, signal);
  const image = await tiff.getImage();
  imageCache.set(tile.code, image);
  while (imageCache.size > 6) imageCache.delete(imageCache.keys().next().value);
  return image;
}

export async function readCategoricalSamples(samples, { signal, imageProvider = openImage } = {}) {
  const values = new Array(samples.length).fill(0);
  const tiles = new Map();
  samples.forEach((sample, index) => {
    const tile = tileFor(sample.latitude, sample.longitude);
    const group = tiles.get(tile.code) || { tile, entries: [] };
    group.entries.push({ ...sample, index });
    tiles.set(tile.code, group);
  });
  for (const { tile, entries } of tiles.values()) {
    signal?.throwIfAborted();
    const image = await imageProvider(tile, signal);
    const [ox, oy] = image.getOrigin();
    const [sx, sy] = image.getResolution();
    const width = image.getWidth();
    const height = image.getHeight();
    if (!(sx > 0 && sy < 0) || width > 100000 || height > 100000) throw new Error("Tuntematon maanpeiterasterin geometria.");
    // Read bounded native raster windows; never a whole 3-degree image or RGB map tile.
    const blocks = new Map();
    for (const entry of entries) {
      const x = Math.floor((entry.longitude - ox) / sx);
      const y = Math.floor((entry.latitude - oy) / sy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const key = `${Math.floor(x / 512)}:${Math.floor(y / 512)}`;
      const block = blocks.get(key) || [];
      block.push({ x, y, index: entry.index });
      blocks.set(key, block);
    }
    for (const block of blocks.values()) {
      signal?.throwIfAborted();
      const left = Math.min(...block.map((p) => p.x));
      const top = Math.min(...block.map((p) => p.y));
      const right = Math.max(...block.map((p) => p.x)) + 1;
      const bottom = Math.max(...block.map((p) => p.y)) + 1;
      const raster = await image.readRasters({ window: [left, top, right, bottom], samples: [0], interleave: true, signal });
      for (const p of block) values[p.index] = raster[(p.y - top) * (right - left) + p.x - left];
    }
  }
  return values;
}

export async function assessLandcover(event, { signal, reader = readCategoricalSamples } = {}) {
  const key = JSON.stringify([2, event.totalPoints, event.points]);
  const cached = resultsCache.get(key);
  if (cached && Date.now() - cached.at < 86400000) return { id: event.id, environment: cached.environment };
  try {
    const deadline = AbortSignal.timeout(60000);
    const samples = sampleSupport(event.points);
    const values = await reader(samples, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    const environment = summarizeLandcover(values.filter((_, i) => samples[i].zone === "buffer"), {
      totalPoints: event.totalPoints, sampledPoints: event.points.length,
      pixelValues: values.filter((_, i) => samples[i].zone === "pixel"),
    });
    resultsCache.set(key, { at: Date.now(), environment });
    while (resultsCache.size > 500) resultsCache.delete(resultsCache.keys().next().value);
    return { id: event.id, environment };
  } catch {
    return { id: event.id, environment: { id: "unknown", status: "error", label: "Maanpeiteaineistoa ei saatu", source: "ESA WorldCover 2021 v200", year: 2021 } };
  }
}
