// Significance and event-type heuristics. Everything is derived from the VIIRS observations,
// WorldCover context and optional OpenStreetMap site context; nothing is stored server-side.

export const SIGNIFICANCE_LEVELS = [
  { min: 60, id: "very-high", label: "Erittäin merkittävä" },
  { min: 30, id: "high", label: "Merkittävä" },
  { min: 15, id: "moderate", label: "Kohtalainen" },
  { min: 0, id: "minor", label: "Vähäinen" },
];
export const DEFAULT_MIN_SIGNIFICANCE = 30;

export const SIZE_CLASSES = [
  { min: 500, id: "very-large", label: "Erittäin suuri" },
  { min: 100, id: "large", label: "Suuri" },
  { min: 10, id: "medium", label: "Keskikokoinen" },
  { min: 0, id: "small", label: "Pieni" },
];

export const SITE_CATEGORIES = {
  oilGas: "Öljy-, kaasu- tai polttoainekohde",
  storage: "Säiliöt tai varastot",
  industrial: "Teollisuusalue",
  power: "Voimala tai sähköasema",
  military: "Sotilasalue",
  transport: "Satama-, rata- tai lentokenttäalue",
};

const VEGETATION_CODES = new Set([10, 20, 30, 40, 90, 95, 100]);
const OPEN_FUEL_CODES = new Set([30, 40]);
const MWH_TO_GJ = 3.6;
const LINK_HOURS = 12;
const ISOLATED_PASS_HOURS = 1;

export function sizeClass(peakMw) {
  if (!Number.isFinite(peakMw)) return { id: "unknown", label: "Koko tuntematon" };
  return SIZE_CLASSES.find((entry) => peakMw >= entry.min);
}

export function significanceLevel(score) {
  return SIGNIFICANCE_LEVELS.find((entry) => score >= entry.min);
}

// Cached per event; the key changes when asynchronous context arrives.
export function assessSignificance(event) {
  const key = `${event.environment?.status || "-"}:${event.environment?.id || "-"}:${event.siteContext?.status || "-"}:${event.detailSummary ? "d" : "-"}`;
  if (event._significance?.key === key) return event._significance.value;
  const value = computeSignificance(event);
  Object.defineProperty(event, "_significance", { value: { key, value }, configurable: true, writable: true, enumerable: false });
  return value;
}

export function eventFeatures(event) {
  const profile = event.frpProfile || [];
  const today = profile.at(-1)?.date || event.lastDate || null;
  const windowStart = today ? shiftDate(today, -6) : null;
  const isSource = event.kind !== "fire";
  const baseline = Number.isFinite(event.baselineMedianPassFrp) ? event.baselineMedianPassFrp : 0;
  const passes = (event.overpasses || [])
    .filter((pass) => !windowStart || (pass.date >= windowStart && pass.date <= today))
    .map((pass) => {
      const raw = Number.isFinite(pass.totalFrp) ? pass.totalFrp : Number.isFinite(pass.maxFrp) ? pass.maxFrp : null;
      return { ...pass, value: raw === null ? null : isSource ? Math.max(0, raw - baseline) : raw, raw };
    });
  const anomalous = new Set(event.anomalyDates || []);
  // For persistent sources only the excess over the source's own baseline on anomaly dates counts.
  const counted = isSource ? passes.filter((pass) => anomalous.has(pass.date)) : passes;
  const values = counted.map((pass) => pass.value).filter(Number.isFinite);
  const peakMw = values.length ? Math.max(...values) : null;
  const rawPeakMw = maxFinite(passes.map((pass) => pass.raw));
  const nightPasses = counted.filter((pass) => pass.daynight === "N" && (pass.value ?? 0) >= (isSource ? 10 : 1)).length;
  const dayPasses = counted.filter((pass) => pass.daynight === "D" && (pass.value ?? 0) > 0).length;
  const activeDays = new Set(counted.filter((pass) => (pass.value ?? 0) > 0 || !isSource).map((pass) => pass.date)).size;
  const satellites = new Set(counted.map((pass) => pass.satellite).filter((s) => s && s !== "?")).size;
  return {
    today,
    peakMw,
    rawPeakMw,
    energyGj: estimateEnergyGj(counted),
    nightPasses,
    nightPassesAll: passes.filter((pass) => pass.daynight === "N" && (pass.raw ?? 0) > 0).length,
    dayPasses,
    passCount: counted.length,
    activeDays,
    satellites,
    cells: event.distinctSpatialCells ?? 0,
    footprintKm2: event.footprintKm2 ?? 0,
    maxPassPixels: Math.max(0, ...counted.map((pass) => pass.pixelCount || 0)),
    concentration: concentration(counted),
    trend: trendOf(profile, isSource ? baseline : 0),
    environment: event.environment?.status === "ready" ? event.environment : null,
    site: event.siteContext?.status === "ready" ? event.siteContext : null,
    detail: event.detailSummary || null,
  };
}

// Rough fire radiative energy: trapezoids between passes at most 12 h apart, one hour for
// an isolated pass. Satellite sampling is sparse, so this is an order-of-magnitude figure.
export function estimateEnergyGj(passes) {
  const timed = passes
    .filter((pass) => Number.isFinite(pass.value) && /^\d{2}:\d{2}$/.test(pass.time || ""))
    .map((pass) => ({ value: pass.value, at: Date.parse(`${pass.date}T${pass.time}:00Z`) }))
    .filter((pass) => Number.isFinite(pass.at))
    .sort((a, b) => a.at - b.at);
  let mwh = 0;
  const linked = new Set();
  for (let i = 1; i < timed.length; i += 1) {
    const hours = (timed[i].at - timed[i - 1].at) / 3_600_000;
    if (hours > 0 && hours <= LINK_HOURS) {
      mwh += (timed[i].value + timed[i - 1].value) / 2 * hours;
      linked.add(i); linked.add(i - 1);
    }
  }
  timed.forEach((pass, index) => { if (!linked.has(index)) mwh += pass.value * ISOLATED_PASS_HOURS; });
  return mwh * MWH_TO_GJ;
}

function computeSignificance(event) {
  const f = eventFeatures(event);
  const type = classifyFireType(event, f);
  const parts = [];
  const add = (label, points) => { if (points) parts.push({ label, points: Math.round(points * 10) / 10 }); };

  if (event.kind === "persistent-source") {
    return finalize(event, f, type, 0, [{ label: "Pysyvä lähde normaalitasolla", points: 0 }], "normal-source");
  }

  const peak = f.peakMw ?? 0;
  add("Teho (suurin ylilento)", 30 * clamp(Math.log10(peak + 1) / 3));
  add("Arvioitu energia", 15 * clamp(Math.log10(f.energyGj + 1) / 4));
  add("Laajuus (500 m solut)", 15 * clamp(Math.log2(f.cells + 1) / Math.log2(65)));
  add("Kesto (havaintopäivät)", 10 * clamp((f.activeDays - 1) / 4));
  add("Yöhavainnot", 10 * clamp(f.nightPasses / 3));
  if (event.kind === "source-fire") add("Pysyvän lähteen leviävä poikkeama", 20);
  else if (event.kind === "source-anomaly") add("Pysyvän lähteen poikkeama", 12);
  if (f.trend === "growing" || f.trend === "new") add(f.trend === "new" ? "Uusi tapahtuma" : "Voimistuva", 5);
  if (f.detail?.onsetConfirmed) add("Vahvistettu nousu kohdeanalyysissä", 4);
  if (f.detail?.intensifications) add("Voimistumisia kohdeanalyysissä", 3);

  let context = 0;
  if (f.environment?.id === "built") context += 10;
  else if (f.environment?.id === "mixed") context += 5;
  if (f.site) {
    const c = f.site.categories || {};
    if (c.oilGas || c.military || c.power) context += 10;
    else if (c.storage || c.industrial) context += 7;
    else if (c.transport) context += 4;
  }
  add("Rakennettu tai teollinen ympäristö", Math.min(15, context));

  let score = parts.reduce((total, part) => total + part.points, 0);
  let filterReason = null;
  if (type.id === "agricultural") { score *= 0.4; parts.push({ label: "Pelto- tai ruohikkopoltolle tyypillinen", points: "×0,4" }); filterReason = "agricultural"; }
  else if (type.id === "small-vegetation") { score *= 0.5; parts.push({ label: "Pieni kasvillisuuspalo", points: "×0,5" }); filterReason = "small-vegetation"; }
  if (event.kind === "source-unknown" && !f.peakMw) { score = Math.min(score, 10); filterReason = "normal-source"; }
  if (f.passCount <= 1 && f.cells <= 1 && peak < 20) { score -= 5; parts.push({ label: "Yksi ylilento ja yksi pikseli", points: -5 }); }
  return finalize(event, f, type, score, parts, filterReason);
}

function finalize(event, features, type, rawScore, parts, filterReason) {
  const score = Math.round(clamp(rawScore / 100) * 100);
  const level = significanceLevel(score);
  return {
    score,
    level,
    type,
    size: sizeClass(features.peakMw ?? (event.kind === "fire" ? features.rawPeakMw : null)),
    features,
    parts,
    filterReason: level.id === "minor" || level.id === "moderate" ? (filterReason || "minor") : null,
  };
}

export function classifyFireType(event, f = eventFeatures(event)) {
  const site = f.site?.categories || {};
  const env = f.environment;
  const builtish = env?.id === "built" || env?.id === "mixed";
  const vegetation = env?.id === "vegetation";
  const peak = f.peakMw ?? 0;
  const types = event.hotspotTypes || [];
  const siteLabel = siteCandidateLabel(site);

  if (types.includes(1)) return type("volcano", "Tulivuoritoiminta", "NASA:n arkistoluokitus merkitsee havainnon tulivuoreksi.");
  if (event.kind === "persistent-source") {
    const flareLike = f.nightPassesAll > 0 && (site.oilGas || types.includes(2));
    return flareLike
      ? type("flare", "Soihtu tai prosessilämpö", "Pysyvä, normaalitasolla oleva lähde, jolla on yöhavaintoja öljy- tai kaasukohteessa.")
      : type("normal-source", "Pysyvä lämmönlähde normaalitasolla", "Toistuva lähde ilman poikkeamaa omaan vertailutasoonsa.");
  }
  if (event.kind === "source-unknown") return type("source-open", "Pysyvä lähde, tila avoin", "Vertailu ei riitä normaalitason vahvistamiseen.");
  if (event.kind === "source-fire" || event.kind === "source-anomaly") {
    if (siteLabel) return type("site-incident", `${siteLabel} · poikkeava lämpö`, "Pysyvän lähteen poikkeama kohteessa, jonka lähellä on OpenStreetMapissa teollisuus- tai infrastruktuurikohde.");
    return type(event.kind === "source-fire" ? "source-spread" : "source-anomaly", event.kind === "source-fire" ? "Pysyvän lähteen leviävä palo (ehdokas)" : "Pysyvän lähteen poikkeama", "Lämpö poikkeaa saman lähteen omasta vertailutasosta.");
  }

  const compact = f.cells <= 6 && f.footprintKm2 <= 1.5;
  const pulse = peak >= 50 && f.activeDays <= 2 && f.passCount <= 3 && (f.concentration ?? 0) >= 0.5;
  if ((siteLabel || builtish) && peak >= 20 && compact) {
    return type("site-fire", `${siteLabel || "Rakennettu alue"} · palo (ehdokas)`, "Voimakas ja keskittynyt lämpö rakennetulla tai teollisella alueella. Sopii rakennus-, varasto- tai teollisuuspaloon; syytä ei voi todentaa.");
  }
  if (pulse) return type("pulse", "Lyhyt voimakas lämpöpiikki", "Hyvin korkea, keskittynyt teho 1–2 päivänä ja enintään kolmella ylilennolla.");
  const broad = f.cells >= 8 || f.footprintKm2 >= 2 || (event.behavior?.id === "wildland-like" && f.activeDays >= 2 && f.cells >= 4);
  if (broad && !builtish) return type("wildfire", vegetation ? "Laaja maastopalo" : "Laaja palo (maasto todennäköinen)", "Useita lämpösoluja, laaja tai siirtyvä jalanjälki ja/tai usean päivän kesto.");
  if (broad) return type("large-mixed", "Laaja palo rakennetun lähellä", "Laaja lämpöalue, jonka lähellä on rakennettua; maastopalo ja rakennuspalot voivat sekoittua.");
  const openFuel = vegetation && (OPEN_FUEL_CODES.has(env.dominantCode) || (env.pixelCounts && dominantShare(env.pixelCounts, OPEN_FUEL_CODES) >= 0.6));
  if (openFuel && peak < 30 && f.cells <= 3 && f.nightPasses === 0 && f.activeDays <= 2) {
    return type("agricultural", "Pelto- tai ruohikkopoltto (todennäköinen)", "Pieni päiväaikainen havainto viljelys- tai ruohikkoalueella.");
  }
  if (vegetation && peak < 10 && f.cells <= 2) return type("small-vegetation", "Pieni kasvillisuuspalo", "Pieni teho ja suppea alue kasvillisuusympäristössä.");
  if (vegetation) return type("vegetation-fire", "Kasvillisuuspalo", "Kasvillisuusympäristön lämpötapahtuma.");
  return type("local", "Paikallinen lämpötapahtuma", "Tyyppiä ei voi erottaa havainnoista.");
}

function siteCandidateLabel(c) {
  if (c.oilGas) return "Öljy-, kaasu- tai polttoainekohde";
  if (c.military) return "Sotilasalue";
  if (c.power) return "Voimala-alue";
  if (c.storage) return "Varasto- tai säiliöalue";
  if (c.industrial) return "Teollisuusalue";
  if (c.transport) return "Satama- tai rata-alue";
  return null;
}

function type(id, label, reason) { return { id, label, reason }; }

function concentration(passes) {
  const shares = passes.filter((p) => Number.isFinite(p.maxFrp) && p.raw > 0).map((p) => p.maxFrp / p.raw);
  return shares.length ? Math.max(...shares) : null;
}

function trendOf(profile, baseline) {
  if (profile.length < 4) return "unknown";
  const value = (entry) => Math.max(0, (entry.peakPassFrp ?? 0) - baseline);
  const recent = profile.slice(-3).map(value), earlier = profile.slice(0, -3).map(value);
  const recentMax = Math.max(...recent), earlierMax = Math.max(0, ...earlier.slice(-4));
  const anyEarlier = earlier.some((v) => v > 0);
  if (recentMax > 0 && !anyEarlier) return "new";
  if (recentMax >= Math.max(2 * earlierMax, earlierMax + 10) && recentMax >= 20) return "growing";
  if (earlierMax > 0 && recentMax <= earlierMax * 0.5) return "declining";
  return "steady";
}

export const TREND_LABELS = { new: "Uusi", growing: "Voimistuva", declining: "Heikkenevä", steady: "Tasainen", unknown: "—" };

export function summarizeDetail(analysis) {
  if (!analysis) return null;
  const labels = analysis.changes.flatMap((change) => change.labels);
  return {
    onsetAt: analysis.onset?.pass?.at || null,
    onsetConfirmed: Boolean(analysis.onset?.confirmed),
    intensifications: labels.filter((label) => label === "Voimistuminen").length,
    expansions: labels.filter((label) => label.startsWith("Lämpöjalanjälki laajenee")).length,
    pulses: labels.filter((label) => label.startsWith("Havaittu lämpöpiikki")).length,
    lastAt: analysis.last?.at || null,
    peakMw: analysis.peak?.totalFrp ?? null,
  };
}

function dominantShare(counts, codes) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const inSet = Object.entries(counts).filter(([code]) => codes.has(Number(code))).reduce((s, [, n]) => s + n, 0);
  return total ? inSet / total : 0;
}

function maxFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function clamp(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }

function shiftDate(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
