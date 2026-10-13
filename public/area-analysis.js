import { assessSignificance, TREND_LABELS, SITE_CATEGORIES } from "./significance.js?v=20261013.2";

export const AREA_REPORTS_STORAGE = "area-reports-v1";
const MATCH_KM = 3;

// Candidates for the deeper area pass: everything but normal persistent sources, best first.
export function rankAreaCandidates(events, { minScore = 15, limit = 15 } = {}) {
  return events
    .filter((event) => event.kind !== "persistent-source")
    .map((event) => ({ event, score: assessSignificance(event).score }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.event);
}

export function buildAreaReport({ events, area, date, generatedAt = new Date().toISOString(), minSignificance = 30, previous = null, coverageComplete = true }) {
  const assessed = events.map((event) => ({ event, s: assessSignificance(event) }));
  const significant = assessed.filter(({ s }) => s.score >= minSignificance).sort((a, b) => b.s.score - a.s.score);
  const rows = significant.map(({ event, s }) => toRow(event, s));
  const hidden = { "normal-source": 0, agricultural: 0, "small-vegetation": 0, minor: 0 };
  for (const { event, s } of assessed) {
    if (s.score >= minSignificance) continue;
    const reason = event.kind === "persistent-source" ? "normal-source" : hidden[s.filterReason] !== undefined ? s.filterReason : "minor";
    hidden[reason] += 1;
  }
  const byType = {};
  for (const row of rows) byType[row.type] = (byType[row.type] || 0) + 1;
  const report = { version: 1, area, date, generatedAt, minSignificance, coverageComplete, rows, hidden, byType, totalEvents: events.length };
  report.comparison = compareReports(report, previous);
  return report;
}

function toRow(event, s) {
  const f = s.features;
  const site = f.site;
  const siteText = site ? Object.entries(site.categories || {}).map(([key, n]) => `${SITE_CATEGORIES[key] || key} (${n}, ${formatKm(site.nearestKm?.[key])})`).join("; ") || "Ei teollisuus- tai infrakohteita 1,5 km:n säteellä" : event.siteContext?.status === "error" ? "Haku epäonnistui" : "Ei haettu";
  return {
    id: event.id,
    latitude: round(event.latitude, 5),
    longitude: round(event.longitude, 5),
    score: s.score,
    level: s.level.label,
    type: s.type.label,
    typeId: s.type.id,
    typeReason: s.type.reason,
    size: s.size.label,
    peakMw: round(f.peakMw, 1),
    energyGj: Math.round(f.energyGj),
    activeDays: f.activeDays,
    passCount: f.passCount,
    nightPasses: f.nightPasses,
    cells: f.cells,
    trend: TREND_LABELS[f.trend] || "—",
    firstDate: event.firstDate,
    lastDate: event.lastDate,
    environment: event.environment?.label || "Ei arvioitu",
    site: siteText,
    siteNames: site?.names || [],
    onset: f.detail?.onsetAt || null,
    onsetConfirmed: Boolean(f.detail?.onsetConfirmed),
    pulses: f.detail?.pulses || 0,
    intensifications: f.detail?.intensifications || 0,
    status: "Uusi",
  };
}

export function compareReports(report, previous) {
  if (!previous) return null;
  const matched = new Set();
  for (const row of report.rows) {
    const index = previous.rows.findIndex((old, i) => !matched.has(i) && haversineKm(old, row) <= MATCH_KM);
    if (index >= 0) { matched.add(index); row.status = "Jatkuu"; row.previousScore = previous.rows[index].score; }
  }
  const ended = previous.rows.filter((_, i) => !matched.has(i)).map((old) => ({ latitude: old.latitude, longitude: old.longitude, type: old.type, score: old.score }));
  return { previousDate: previous.date, previousGeneratedAt: previous.generatedAt, newCount: report.rows.filter((r) => r.status === "Uusi").length, continuing: matched.size, ended };
}

export function loadReports(storage) {
  try { const value = JSON.parse(storage?.getItem(AREA_REPORTS_STORAGE) || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

export function saveReport(storage, report) {
  const compact = { ...report, rows: report.rows.map(({ id, latitude, longitude, score, type, typeId, peakMw, lastDate }) => ({ id, latitude, longitude, score, type, typeId, peakMw, lastDate })), comparison: null };
  const reports = [compact, ...loadReports(storage)].slice(0, 10);
  try { storage?.setItem(AREA_REPORTS_STORAGE, JSON.stringify(reports)); return true; } catch { return false; }
}

// The most recent earlier report covering mostly the same area.
export function findPreviousReport(reports, area, before) {
  return reports.find((report) => report.generatedAt < before && overlap(report.area, area) >= 0.5) || null;
}

function overlap(a, b) {
  if (!a || !b) return 0;
  const w = Math.max(0, Math.min(a.east, b.east) - Math.max(a.west, b.west));
  const h = Math.max(0, Math.min(a.north, b.north) - Math.max(a.south, b.south));
  const inter = w * h, union = (a.east - a.west) * (a.north - a.south) + (b.east - b.west) * (b.north - b.south) - inter;
  return union > 0 ? inter / union : 0;
}

const CSV_HEADERS = ["Sijoitus", "Merkittävyys", "Taso", "Tyyppi (arvio)", "Kokoluokka", "Huippu MW", "Energia GJ (arvio)", "Havaintopäivät", "Ylilennot", "Yöhavainnot", "Lämpösolut", "Kehitys", "Ensimmäinen päivä", "Viimeisin päivä", "Leveysaste", "Pituusaste", "Ympäristö", "OSM-kohteet 1,5 km", "Vahvistettu nousu", "Tila edelliseen raporttiin"];

export function reportToCsv(report) {
  const rows = [CSV_HEADERS, ...report.rows.map((r, i) => [i + 1, r.score, r.level, r.type, r.size, r.peakMw, r.energyGj, r.activeDays, r.passCount, r.nightPasses, r.cells, r.trend, r.firstDate, r.lastDate, r.latitude, r.longitude, r.environment, r.site, r.onset ? `${r.onset}${r.onsetConfirmed ? " (vahvistettu)" : ""}` : "", report.comparison ? r.status : ""])];
  const quote = (value) => `"${(typeof value === "string" ? value.replace(/^[=+@-]/, "'$&") : String(value ?? "")).replaceAll('"', '""')}"`;
  return "\uFEFF" + rows.map((row) => row.map(quote).join(";")).join("\r\n");
}

export function reportToGeoJson(report) {
  return JSON.stringify({
    type: "FeatureCollection",
    properties: { date: report.date, generatedAt: report.generatedAt, area: report.area, source: "NASA FIRMS VIIRS NRT; arvio, ei vahvistettu tapahtuma" },
    features: report.rows.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r.longitude, r.latitude] }, properties: { rank: i + 1, ...r } })),
  }, null, 2);
}

export function reportToKml(report) {
  const x = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const placemarks = report.rows.map((r, i) => `<Placemark><name>${x(`${i + 1}. ${r.type} (${r.score})`)}</name><description>${x(`${r.level} · ${r.size} · huippu ${r.peakMw ?? "—"} MW · energia ~${r.energyGj} GJ · ${r.activeDays} pv · yöhavaintoja ${r.nightPasses} · ${r.trend} · ${r.environment} · ${r.site}`)}</description><Point><coordinates>${r.longitude},${r.latitude},0</coordinates></Point></Placemark>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(`Lämpöpoikkeamat ${report.date}`)}</name>${placemarks}</Document></kml>`;
}

function formatKm(value) { return Number.isFinite(value) ? `${value.toFixed(1).replace(".", ",")} km` : "—"; }
function round(value, digits) { return Number.isFinite(value) ? Number(value.toFixed(digits)) : null; }

function haversineKm(left, right) {
  const r = (d) => d * Math.PI / 180;
  const a = Math.sin(r(right.latitude - left.latitude) / 2) ** 2 + Math.cos(r(left.latitude)) * Math.cos(r(right.latitude)) * Math.sin(r(right.longitude - left.longitude) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}
