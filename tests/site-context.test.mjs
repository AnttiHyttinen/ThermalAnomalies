import test from "node:test";
import assert from "node:assert/strict";
import { assessSites, buildOverpassQuery, categorize, summarizeSite, validateSiteRequest } from "../src/site-context.mjs";

test("OSM tags map to site categories without matching unrelated words", () => {
  assert.deepEqual(categorize({ landuse: "industrial", industrial: "refinery" }).sort(), ["industrial", "oilGas"]);
  assert.deepEqual(categorize({ man_made: "storage_tank", content: "oil" }).sort(), ["oilGas", "storage"]);
  assert.deepEqual(categorize({ name: "Las Vegas Mall" }), []);
  assert.deepEqual(categorize({ name: "Магазин" }), []);
  assert.deepEqual(categorize({ name: "Нефтебаза", landuse: "industrial" }).sort(), ["industrial", "oilGas"]);
  assert.deepEqual(categorize({ power: "plant" }), ["power"]);
  assert.deepEqual(categorize({ landuse: "military" }), ["military"]);
  assert.deepEqual(categorize({ aeroway: "aerodrome" }), ["transport"]);
});

test("site summary keeps only features within 1.5 km", () => {
  const point = { id: "a", latitude: 45, longitude: 34 };
  const summary = summarizeSite(point, [
    { lat: 45.001, lon: 34, tags: { man_made: "storage_tank", name: "Tank 1" } },
    { center: { lat: 45.005, lon: 34 }, tags: { landuse: "industrial" } },
    { lat: 45.1, lon: 34, tags: { power: "plant" } },
  ]);
  assert.deepEqual(summary.categories, { storage: 1, industrial: 1 });
  assert.deepEqual(summary.names, ["Tank 1"]);
  assert.ok(summary.nearestKm.storage < 0.2);
});

test("site request validation and Overpass query", () => {
  assert.throws(() => validateSiteRequest({ points: [] }), /puuttuvat/);
  assert.throws(() => validateSiteRequest({ points: Array.from({ length: 16 }, (_, i) => ({ id: String(i), latitude: 1, longitude: 1 })) }), /enintään 15/);
  assert.throws(() => validateSiteRequest({ points: [{ id: "x", latitude: 95, longitude: 1 }] }), /Virheellinen/);
  const points = validateSiteRequest({ points: [{ id: "x", latitude: 45.12345678, longitude: 34.5 }] });
  const query = buildOverpassQuery(points);
  assert.match(query, /^\[out:json\]/); assert.match(query, /around:1500,45\.12346,34\.50000/); assert.match(query, /out tags center/);
});

test("assessSites reports errors per point and caches successful lookups", async () => {
  let calls = 0;
  const failing = async () => { calls += 1; return new Response("busy", { status: 429 }); };
  const [failed] = await assessSites([{ id: "e", latitude: 10.5, longitude: 20.5 }], { fetchImpl: failing });
  assert.equal(failed.siteContext.status, "error");
  const ok = async () => { calls += 1; return new Response(JSON.stringify({ elements: [{ lat: 10.001, lon: 20, tags: { power: "plant" } }] })); };
  const [first] = await assessSites([{ id: "p", latitude: 10, longitude: 20 }], { fetchImpl: ok });
  const [second] = await assessSites([{ id: "p2", latitude: 10, longitude: 20 }], { fetchImpl: ok });
  assert.deepEqual(first.siteContext.categories, { power: 1 }); assert.equal(second.siteContext.categories.power, 1);
  assert.equal(calls, 3, "failing lookup tries both Overpass endpoints, cached lookup is not refetched");
});
