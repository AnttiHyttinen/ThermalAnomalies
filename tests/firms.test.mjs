import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFirmsUrl,
  fourteenDaySegments,
  normalizeDetection,
  parseCsv,
  sevenDaySegments,
  validateArea,
} from "../src/firms.mjs";

test("sevenDaySegments jakaa seitsemän päivää FIRMSin viiden päivän rajaan", () => {
  assert.deepEqual(sevenDaySegments("2026-08-27"), [
    { start: "2026-08-21", days: 5 },
    { start: "2026-08-26", days: 2 },
  ]);
});

test("fourteenDaySegments jakaa 14 päivää FIRMSin viiden päivän osiin", () => {
  assert.deepEqual(fourteenDaySegments("2026-08-27"), [
    { start: "2026-08-14", days: 5 },
    { start: "2026-08-19", days: 5 },
    { start: "2026-08-24", days: 4 },
  ]);
});

test("parseCsv käsittelee lainatut pilkut ja rivinvaihdot", () => {
  const rows = parseCsv('latitude,longitude,note\r\n60.1,24.9,"nominal, night"\r\n');
  assert.deepEqual(rows, [{
    latitude: "60.1",
    longitude: "24.9",
    note: "nominal, night",
  }]);
});

test("normalizeDetection muodostaa käyttöliittymälle vakaan tietueen", () => {
  const detection = normalizeDetection({
    latitude: "60.1699",
    longitude: "24.9384",
    acq_date: "2026-08-27",
    acq_time: "37",
    satellite: "N20",
    confidence: "n",
    frp: "12.4",
    bright_ti4: "341.2",
    scan: "0.42",
    track: "0.38",
    type: "2",
    daynight: "n",
  }, "VIIRS_NOAA20_NRT");

  assert.equal(detection.time, "00:37");
  assert.equal(detection.frp, 12.4);
  assert.equal(detection.brightness, 341.2);
  assert.equal(detection.scanKm, 0.42);
  assert.equal(detection.trackKm, 0.38);
  assert.equal(detection.hotspotType, 2);
  assert.equal(detection.daynight, "N");
  assert.match(detection.id, /^VIIRS_NOAA20_NRT:/);
});

test("normalizeDetection jättää puuttuvan FIRMS-tyypin tuntemattomaksi", () => {
  const detection = normalizeDetection({
    latitude: "60.1699",
    longitude: "24.9384",
    acq_date: "2026-08-27",
    acq_time: "0037",
  }, "VIIRS_SNPP_NRT");

  assert.equal(detection.hotspotType, null);
});

test("validateArea hyväksyy rajatun kartta-alueen ja torjuu liian laajan", () => {
  const valid = new URLSearchParams({ west: "35", south: "54", east: "41", north: "57" });
  assert.deepEqual(validateArea(valid), { west: 35, south: 54, east: 41, north: 57 });

  const wide = new URLSearchParams({ west: "0", south: "40", east: "40", north: "60" });
  assert.throws(() => validateArea(wide), { code: "AREA_TOO_LARGE" });
});

test("buildFirmsUrl käyttää alue-, lähde- ja päivämääräparametreja", () => {
  const url = buildFirmsUrl({
    mapKey: "1234567890abcdef1234567890abcdef",
    source: "VIIRS_NOAA20_NRT",
    area: { west: 35, south: 54, east: 41, north: 57 },
    start: "2026-08-21",
    days: 5,
  });
  assert.equal(
    url,
    "https://firms.modaps.eosdis.nasa.gov/api/area/csv/1234567890abcdef1234567890abcdef/VIIRS_NOAA20_NRT/35.0000,54.0000,41.0000,57.0000/5/2026-08-21",
  );
});
