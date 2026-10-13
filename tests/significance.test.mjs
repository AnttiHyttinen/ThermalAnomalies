// Calibration fixtures: synthetic archetypes of typical FIRMS patterns. They pin down the intended
// ordering of the heuristic score rather than claim real-world accuracy.
import test from "node:test";
import assert from "node:assert/strict";
import { assessSignificance, estimateEnergyGj, sizeClass, summarizeDetail } from "../public/significance.js";
import { buildAreaReport, findPreviousReport, loadReports, saveReport, reportToCsv, reportToGeoJson, reportToKml, rankAreaCandidates } from "../public/area-analysis.js";
import { visibleEvents, hiddenBySignificance } from "../public/assessment.js";

const TODAY = "2026-08-30";
const day = (offset) => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const pass = (offset, time, daynight, totalFrp, extra = {}) => ({ date: day(offset), time, satellite: extra.satellite || "N20", daynight, totalFrp, maxFrp: extra.maxFrp ?? totalFrp, pixelCount: extra.pixelCount ?? 1, radius95Km: 0.2, ...extra });
const profile = (passes) => Array.from({ length: 14 }, (_, i) => { const date = day(i - 13); const values = passes.filter((p) => p.date === date).map((p) => p.totalFrp); return { date, peakPassFrp: values.length ? Math.max(...values) : null, passCount: values.length }; });
const env = (id, dominantCode = null, pixelCounts = {}) => ({ id, status: "ready", label: id, dominantCode, pixelCounts });
const make = (id, { kind = "fire", passes, cells = 1, footprintKm2 = 0, environment = null, siteContext = null, ...rest }) => ({
  id, kind, latitude: 45 + Math.random(), longitude: 34 + Math.random(), overpasses: passes, frpProfile: profile(passes), distinctSpatialCells: cells, footprintKm2,
  environment, siteContext, activeDates: [...new Set(passes.filter((p) => p.date >= day(-6)).map((p) => p.date))], activeToday: passes.some((p) => p.date === TODAY),
  firstDate: passes[0]?.date, lastDate: passes.at(-1)?.date, anomalyDates: [], hotspotTypes: [], ...rest,
});

const refinery = () => make("refinery", { passes: [pass(-1, "23:40", "N", 350, { maxFrp: 300, pixelCount: 3 }), pass(0, "10:30", "D", 420, { maxFrp: 330, pixelCount: 4, satellite: "N21" }), pass(0, "23:10", "N", 260, { pixelCount: 3 })], cells: 4, footprintKm2: 0.5, environment: env("built"), siteContext: { status: "ready", categories: { oilGas: 5, storage: 12 }, nearestKm: { oilGas: 0.3 } } });
const wildfire = () => make("wildfire", { passes: [-4, -3, -2, -1, 0].flatMap((o, i) => [pass(o, "10:40", "D", 200 + i * 150, { pixelCount: 20 }), pass(o, "00:50", "N", 120 + i * 80, { pixelCount: 12, satellite: "N21" })]), cells: 40, footprintKm2: 12, environment: env("vegetation", 10), behavior: { id: "wildland-like" } });
const agri = () => make("agri", { passes: [pass(0, "10:50", "D", 6)], environment: env("vegetation", 40) });
const grass = () => make("grass", { passes: [pass(0, "10:20", "D", 15, { pixelCount: 2 }), pass(0, "11:55", "D", 12, { satellite: "N21" })], cells: 2, environment: env("vegetation", 30) });
const normalSource = () => make("normal", { kind: "persistent-source", passes: [pass(0, "01:00", "N", 30)], baselineMedianPassFrp: 28, siteContext: { status: "ready", categories: { oilGas: 2 } } });
const sourceAnomaly = () => make("source", { kind: "source-anomaly", passes: [pass(-2, "01:00", "N", 20), pass(0, "01:10", "N", 150, { maxFrp: 90, pixelCount: 4 })], baselineMedianPassFrp: 20, anomalyDates: [TODAY], cells: 3 });
const pulse = () => make("pulse", { passes: [pass(0, "00:30", "N", 120, { maxFrp: 100, pixelCount: 2 }), pass(0, "01:20", "N", 90, { maxFrp: 80, satellite: "N21" })], cells: 2 });

test("calibration archetypes rank significant events above routine heat", () => {
  const r = assessSignificance(refinery()), w = assessSignificance(wildfire()), a = assessSignificance(agri()), g = assessSignificance(grass());
  const n = assessSignificance(normalSource()), s = assessSignificance(sourceAnomaly()), p = assessSignificance(pulse());
  assert.equal(r.type.id, "site-fire"); assert.match(r.type.label, /Öljy/); assert.ok(r.score >= 60, `refinery ${r.score}`);
  assert.equal(w.type.id, "wildfire"); assert.ok(w.score >= 60, `wildfire ${w.score}`); assert.equal(w.features.trend, "growing");
  assert.equal(a.type.id, "agricultural"); assert.ok(a.score < 15, `agri ${a.score}`); assert.equal(a.filterReason, "agricultural");
  assert.equal(g.type.id, "agricultural"); assert.ok(g.score < 15, `grass ${g.score}`);
  assert.equal(n.score, 0); assert.equal(n.type.id, "flare"); assert.equal(n.filterReason, "normal-source");
  assert.equal(s.type.id, "source-anomaly"); assert.ok(s.score >= 30, `source ${s.score}`); assert.equal(s.features.peakMw, 130);
  assert.equal(p.type.id, "pulse"); assert.ok(p.score >= 30, `pulse ${p.score}`);
  assert.equal(r.size.id, "large"); assert.equal(w.size.id, "very-large"); assert.equal(a.size.id, "small");
});

test("energy estimate links passes up to 12 h apart and counts isolated passes as one hour", () => {
  assert.equal(Math.round(estimateEnergyGj([{ date: TODAY, time: "00:00", value: 100 }, { date: TODAY, time: "03:00", value: 50 }])), 810);
  assert.equal(Math.round(estimateEnergyGj([{ date: TODAY, time: "00:00", value: 10 }, { date: TODAY, time: "18:00", value: 10 }])), 72);
  assert.equal(sizeClass(null).id, "unknown"); assert.equal(sizeClass(600).id, "very-large");
});

test("significance score reacts to asynchronous context and detail analysis", () => {
  const event = make("ctx", { passes: [pass(0, "01:00", "N", 40, { pixelCount: 2 })], cells: 2 });
  const before = assessSignificance(event).score;
  event.environment = env("built");
  const built = assessSignificance(event).score;
  event.detailSummary = summarizeDetail({ changes: [{ labels: ["Voimistuminen"] }], onset: { pass: { at: `${TODAY}T01:00:00Z` }, confirmed: true }, last: null, peak: null });
  assert.ok(built > before); assert.ok(assessSignificance(event).score > built);
});

test("significant filter and sort hide routine heat and explain why", () => {
  const events = [agri(), grass(), normalSource(), refinery(), wildfire(), pulse()];
  assert.deepEqual(visibleEvents(events, { filter: "significant", sort: "significance" }).map((e) => e.id).slice(0, 2).sort(), ["refinery", "wildfire"]);
  assert.ok(!visibleEvents(events, { filter: "significant" }).some((e) => ["agri", "grass", "normal"].includes(e.id)));
  const hidden = hiddenBySignificance(events, {});
  assert.equal(hidden.agricultural, 2); assert.equal(hidden["normal-source"], 1);
  assert.deepEqual(rankAreaCandidates(events, { minScore: 15 }).map((e) => e.id).includes("normal"), false);
});

test("area report compares with an earlier report and exports CSV, GeoJSON and KML", () => {
  const storage = new Map(); const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const area = { west: 33, south: 44, east: 36, north: 47 };
  const first = buildAreaReport({ events: [refinery(), agri()], area, date: day(-1), generatedAt: "2026-08-29T10:00:00Z" });
  assert.equal(first.rows.length, 1); assert.equal(first.hidden.agricultural, 1); assert.equal(first.comparison, null);
  assert.ok(saveReport(store, first));
  const previous = findPreviousReport(loadReports(store), { west: 33.1, south: 44, east: 36, north: 47 }, "2026-08-30T10:00:00Z");
  assert.ok(previous);
  const moved = refinery(); moved.latitude = first.rows[0].latitude + 0.01; moved.longitude = first.rows[0].longitude;
  const second = buildAreaReport({ events: [moved, wildfire()], area, date: TODAY, generatedAt: "2026-08-30T10:00:00Z", previous });
  assert.equal(second.comparison.continuing, 1); assert.equal(second.comparison.newCount, 1);
  assert.deepEqual(second.rows.map((r) => r.status).sort(), ["Jatkuu", "Uusi"]);
  assert.equal(findPreviousReport(loadReports(store), { west: 10, south: 10, east: 11, north: 11 }, "2026-08-30T10:00:00Z"), null);
  const geo = JSON.parse(reportToGeoJson(second));
  assert.equal(geo.features.length, 2); assert.equal(geo.features[0].geometry.type, "Point");
  assert.match(reportToKml(second), /<Placemark>.*<coordinates>/);
  const csv = reportToCsv(second);
  assert.ok(csv.startsWith("\uFEFF\"Sijoitus\"")); assert.equal(csv.split("\r\n").length, 3);
});
