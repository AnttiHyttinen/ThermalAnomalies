import test from "node:test";
import assert from "node:assert/strict";
import { summarizeLandcover, priorityFor, visibleEvents, observationEvidence } from "../public/assessment.js";
import { assessLandcover } from "../src/landcover.mjs";

const date = "2026-09-08";
const pass = (time = "00:10", overrides = {}) => ({ date, time, satellite: "N20", daynight: "N", ...overrides });
const fire = (overrides = {}) => ({ id: "test", kind: "fire", activeToday: true, currentPeakPassFrp: 40, overpasses: [pass()], ...overrides });

test("buildings in the buffer cannot masquerade as buildings inside the thermal pixel", async () => {
  const result = await assessLandcover({ id: "dual-grid", points: [{ latitude: 40, longitude: 20, scanKm: 0.375, trackKm: 0.375 }], totalPoints: 1 }, {
    reader: async (samples) => { assert.equal(samples.length, 50); return samples.map((s) => s.zone === "pixel" ? 30 : 50); },
  });
  assert.equal(result.environment.id, "mixed");
  assert.equal(result.environment.pixelBuiltFraction, 0);
  assert.equal(result.environment.builtFraction, 1);
  assert.match(priorityFor(fire({ environment: result.environment })).label, /lähellä/);
});

test("sparse built samples and incomplete raster data do not produce a built classification", () => {
  assert.equal(summarizeLandcover(Array(25).fill(50), { pixelValues: [...Array(24).fill(30), 50] }).id, "mixed");
  assert.equal(summarizeLandcover(Array(25).fill(50), { pixelValues: Array(25).fill(0) }).id, "unknown");
  const env = summarizeLandcover(Array(25).fill(30), { pixelValues: [...Array(20).fill(30), ...Array(5).fill(50)] });
  assert.equal(env.id, "built");
  assert.ok(!priorityFor(fire({ environment: env })).label.includes("palo"));
});

test("single vegetation observations stay visible; corroborated vegetation can be hidden", () => {
  const env = summarizeLandcover(Array(25).fill(40));
  assert.equal(env.dominantCode, 40);
  const single = fire({ id: "single", environment: env });
  const repeated = fire({ id: "repeated", environment: env, overpasses: [pass(), pass("01:30")] });
  const recurring = { ...repeated, id: "recurring", behavior: { id: "recurrent-uncertain" } };
  assert.deepEqual(visibleEvents([single, repeated, recurring]).map((e) => e.id), ["single", "recurring"]);
  assert.match(priorityFor(single).label, /Viljelysmaa/);
  assert.deepEqual(visibleEvents([single, repeated], { filter: "all", repeatedOnly: true }).map((e) => e.id), ["repeated"]);
});

test("old passes, duplicates and unknown times do not inflate observation-day evidence", () => {
  const e = fire({ overpasses: [pass(), pass(), pass(null), pass("02:00", { date: "2026-09-07" }), pass("03:00", { daynight: "?" })] });
  assert.equal(observationEvidence(e).passCount, 1);
  assert.equal(observationEvidence(e).repeated, false);
});

test("sorting by FRP, time and comparable ratio keeps missing values last", () => {
  const a = fire({ id: "a", currentPeakPassFrp: 100 });
  const b = fire({ id: "b", currentPeakPassFrp: 30, overpasses: [pass("02:00")], comparisons: [{ pass: pass("02:00"), fullyComparable: true, metrics: { totalFrp: { ratio: 4 } } }] });
  const missing = fire({ id: "missing", currentPeakPassFrp: null, overpasses: [], comparisons: [{ pass: pass(), fullyComparable: false, metrics: { totalFrp: { ratio: 99 } } }] });
  for (const [sort, first] of [["frp", "a"], ["latest", "b"], ["ratio", "b"]]) {
    const sorted = visibleEvents([missing, a, b], { filter: "all", sort });
    assert.equal(sorted[0].id, first); assert.equal(sorted.at(-1).id, "missing");
  }
});

test("vegetation never suppresses an anomaly at a persistent source", () => {
  const e = fire({ kind: "source-anomaly", environment: summarizeLandcover(Array(25).fill(10)), overpasses: [pass(), pass("02:00")] });
  assert.equal(visibleEvents([e]).length, 1);
  assert.equal(priorityFor(e).rank, 1);
});
