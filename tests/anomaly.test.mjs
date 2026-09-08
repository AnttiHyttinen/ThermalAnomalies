import test from "node:test";
import assert from "node:assert/strict";
import {
  dailyCounts,
  dateRange,
  findLargeFireEvents,
  haversineKm,
  summarizeOverpasses,
} from "../public/anomaly.js";

const today = "2026-08-27";
const baselineDates = dateRange("2026-08-14", "2026-08-26");

function point(latitude, longitude, date, overrides = {}) {
  return {
    latitude,
    longitude,
    date,
    time: "00:10",
    confidence: "n",
    frp: 8,
    brightness: 340,
    satellite: "N20",
    daynight: "N",
    hotspotType: 0,
    source: "VIIRS_NOAA20_NRT",
    ...overrides,
  };
}

function sourcePass(date, satellite, options = {}) {
  const isN21 = satellite === "N21";
  const source = isN21 ? "VIIRS_NOAA21_NRT" : "VIIRS_NOAA20_NRT";
  const time = isN21 ? "01:10" : "00:10";
  const frp = options.frp ?? 10;
  return [
    point(60, 25, date, { satellite, source, time, frp }),
    point(60.001, 25.001, date, { satellite, source, time, frp: frp + 2 }),
  ];
}

function expandedPass(date, satellite, options = {}) {
  const base = sourcePass(date, satellite, { frp: options.baseFrp ?? 30 });
  const source = satellite === "N21" ? "VIIRS_NOAA21_NRT" : "VIIRS_NOAA20_NRT";
  const time = satellite === "N21" ? "01:10" : "00:10";
  return [
    ...base,
    point(60.012, 25, date, { satellite, source, time, frp: options.frp ?? 80 }),
    point(60.014, 25.004, date, { satellite, source, time, frp: options.frp ?? 80 }),
    point(60.016, 25.008, date, { satellite, source, time, frp: options.frp ?? 80 }),
  ];
}

test("haversineKm antaa uskottavan etäisyyden", () => {
  const distance = haversineKm(
    { latitude: 60.1699, longitude: 24.9384 },
    { latitude: 60.2055, longitude: 24.6559 },
  );
  assert.ok(distance > 15 && distance < 17);
});

test("ylilennot erotellaan ajan, satelliitin ja päivä-yö-luokan mukaan", () => {
  const detections = [
    point(60, 25, today, { time: "00:05", frp: 10 }),
    point(60.001, 25.001, today, { time: "00:15", frp: 12 }),
    point(60, 25, today, { time: "00:40", frp: 15 }),
    point(60, 25, today, { time: "00:05", daynight: "D", frp: 18 }),
    point(60, 25, today, {
      time: "01:05",
      satellite: "N21",
      source: "VIIRS_NOAA21_NRT",
      frp: 20,
    }),
  ];

  const passes = summarizeOverpasses(detections);

  assert.equal(passes.length, 4);
  assert.equal(passes[0].pixelCount, 2);
  assert.equal(passes[0].totalFrp, 22);
  assert.equal(passes[0].observedPixelAreaKm2, 2 * 0.375 * 0.375);
  assert.ok(passes[0].frpDensityMwKm2 > 78 && passes[0].frpDensityMwKm2 < 79);
  assert.deepEqual(new Set(passes.map((pass) => pass.daynight)), new Set(["N", "D"]));
  assert.deepEqual(new Set(passes.map((pass) => pass.satellite)), new Set(["N20", "N21"]));
});

test("findLargeFireEvents löytää suuren palon ylilentokohtaisella FRP:llä", () => {
  const active = [
    point(60, 25, today, { frp: 20, satellite: "N21", source: "VIIRS_NOAA21_NRT" }),
    point(60.004, 25.004, today, { frp: 20, satellite: "N21", source: "VIIRS_NOAA21_NRT" }),
    point(60.008, 25, today, { frp: 20, satellite: "N21", source: "VIIRS_NOAA21_NRT" }),
    point(60.004, 25.012, today, { frp: 20, satellite: "N21", source: "VIIRS_NOAA21_NRT" }),
    point(60.010, 25.012, today, { frp: 20, satellite: "N21", source: "VIIRS_NOAA21_NRT" }),
    point(60.012, 25.006, today, { frp: 20, satellite: "N21", source: "VIIRS_NOAA21_NRT" }),
  ];
  const earlier = active.map((entry) => ({
    ...entry,
    id: undefined,
    latitude: entry.latitude + 1,
    longitude: entry.longitude + 1,
    date: "2026-08-25",
    satellite: "N20",
    source: "VIIRS_NOAA20_NRT",
  }));

  const result = findLargeFireEvents([...active, ...earlier], today, { displayStart: "2026-08-21" });

  assert.equal(result.fires.length, 2);
  assert.equal(result.activeTodayCount, 1);
  assert.equal(result.fires.find((fire) => fire.activeToday).peakPassFrp, 120);
  assert.equal(result.fires[0].frpProfile.length, 14);
  assert.equal(result.fires.find((fire) => fire.activeToday).behavior.id, "wildland-like");
  assert.equal(result.fires.find((fire) => fire.activeToday).behavior.usesSiteRegistry, false);
});

test("D0 jää normaalitason ulkopuolelle ja poikkeama käyttää mediaania sekä MAD-arvoa", () => {
  const normal = baselineDates.flatMap((date) => sourcePass(date, "N20"));
  const exceptional = [
    point(60, 25, today, { frp: 100 }),
    point(60.001, 25.001, today, { frp: 120 }),
  ];

  const result = findLargeFireEvents([...normal, ...exceptional], today, { displayStart: "2026-08-21" });
  const source = result.sourceAnomalies[0];

  assert.equal(result.sourceAnomalies.length, 1);
  assert.equal(result.sourceFires.length, 0);
  assert.equal(source.persistenceActiveDayCount, 13);
  assert.equal(source.baselinePassCount, 13);
  assert.equal(source.baselineMedianPassFrp, 22);
  assert.equal(source.currentPeakPassFrp, 220);
  assert.equal(source.comparisonMethod, "mad");
  assert.deepEqual(source.anomalyDates, [today]);
});

test("todennäköinen palo pysyvässä kohteessa vaatii kaksi spatiaalista vahvistusta", () => {
  const normal = baselineDates.flatMap((date) => [
    ...sourcePass(date, "N20"),
    ...sourcePass(date, "N21"),
  ]);
  const exceptional = [
    ...expandedPass(today, "N20"),
    ...expandedPass(today, "N21"),
  ];

  const result = findLargeFireEvents([...normal, ...exceptional], today, { displayStart: "2026-08-21" });
  const source = result.sourceFires[0];

  assert.equal(result.sourceFires.length, 1);
  assert.equal(result.sourceAnomalies.length, 0);
  assert.equal(source.kind, "source-fire");
  assert.equal(source.confirmingPassCount, 2);
  assert.deepEqual(source.confirmingSatellites, ["N20", "N21"]);
  assert.ok(source.currentOutsideCorePixels >= 4);
  assert.equal(source.reliability.level, "high");
});

test("yksi laajentunut ylilento jää syy tuntematon -poikkeamaksi", () => {
  const normal = baselineDates.flatMap((date) => sourcePass(date, "N20"));
  const result = findLargeFireEvents([
    ...normal,
    ...expandedPass(today, "N20"),
  ], today, { displayStart: "2026-08-21" });
  const source = result.sourceAnomalies[0];

  assert.equal(result.sourceFires.length, 0);
  assert.equal(result.sourceAnomalies.length, 1);
  assert.equal(source.confirmingPassCount, 1);
  assert.ok(source.currentOutsideCorePixels >= 2);
});

test("9/13 vertailupäivänä toistuva lähde tunnistetaan ilman kohdeluetteloa", () => {
  const dates = baselineDates.slice(0, 4).concat(baselineDates.slice(-5));
  const detections = dates.flatMap((date) => sourcePass(date, "N20"));

  const result = findLargeFireEvents(detections, today, { displayStart: "2026-08-21" });
  const source = result.unknownSources[0];

  assert.equal(result.unknownSources.length, 1);
  assert.equal(source.normalObserved, false);
  assert.equal(source.classificationBasis, "recurrence");
  assert.equal(source.persistenceActiveDayCount, 9);
  assert.equal(source.persistenceWindowDays, 13);
  assert.equal(source.hasSourceAnomaly, false);
});

test("liikkuva yhdeksän päivän lämpörintama ei muutu pysyväksi lähteeksi", () => {
  const detections = baselineDates.slice(0, 9).map((date, index) => point(
    60,
    25 + index * 0.009,
    date,
    { frp: 12 },
  ));

  const result = findLargeFireEvents(detections, today, { displayStart: "2026-08-21" });

  assert.equal(result.persistentSources.length, 0);
  assert.equal(result.sourceAnomalies.length, 0);
  assert.equal(result.sourceFires.length, 0);
});

test("8/13 vertailupäivää ei riitä pysyvään luokitukseen", () => {
  const dates = baselineDates.slice(-8);
  const detections = dates.flatMap((date) => sourcePass(date, "N20"));

  const result = findLargeFireEvents(detections, today, { displayStart: "2026-08-21" });

  assert.equal(result.persistentSources.length, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].isPersistentHeatSource, false);
});

test("FIRMSin staattinen tyyppi ei yksin muodosta pysyvää lähdettä", () => {
  const detections = [point(60, 25, today, { hotspotType: 2, frp: 20 })];
  const result = findLargeFireEvents(detections, today, { displayStart: "2026-08-21" });

  assert.equal(result.persistentSources.length, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "fire");
});

test("muutoskohta estää monipäiväisen palon sulautumisen normaalitasoon", () => {
  const stableDates = baselineDates.slice(0, 8);
  const changedDates = [...baselineDates.slice(8), today];
  const stable = stableDates.flatMap((date) => [
    ...sourcePass(date, "N20"),
    ...sourcePass(date, "N21"),
  ]);
  const changed = changedDates.flatMap((date) => [
    ...expandedPass(date, "N20"),
    ...expandedPass(date, "N21"),
  ]);

  const result = findLargeFireEvents([...stable, ...changed], today, { displayStart: "2026-08-21" });
  const source = result.sourceFires[0];

  assert.equal(result.sourceFires.length, 1);
  assert.equal(source.changePoint.date, baselineDates[8]);
  assert.equal(source.baselinePeriod.end, baselineDates[7]);
  assert.ok(source.changePoint.frpRatio > 3);
  assert.ok(source.confirmingPassCount >= 2);
});

test("seitsemää päivää vanhempi palo ei tule kartan palokohteeksi", () => {
  const detections = [
    point(60, 25, "2026-08-18", { frp: 80 }),
    point(60.004, 25.008, "2026-08-18", { frp: 80 }),
    point(60.008, 25.016, "2026-08-18", { frp: 80 }),
    point(60.012, 25.024, "2026-08-19", { frp: 80 }),
    point(60.016, 25.032, "2026-08-19", { frp: 80 }),
    point(60.020, 25.040, "2026-08-20", { frp: 80 }),
  ];

  const result = findLargeFireEvents(detections, today, { displayStart: "2026-08-21" });

  assert.equal(result.fires.length, 0);
  assert.equal(result.events.length, 0);
});

test("dailyCounts tuottaa myös nollapäivät", () => {
  const counts = dailyCounts([
    point(60, 25, "2026-08-21"),
    point(60, 25, "2026-08-23"),
    point(60, 25, "2026-08-23"),
  ], "2026-08-21", "2026-08-23");

  assert.deepEqual(counts, [
    { date: "2026-08-21", count: 1 },
    { date: "2026-08-22", count: 0 },
    { date: "2026-08-23", count: 2 },
  ]);
});
