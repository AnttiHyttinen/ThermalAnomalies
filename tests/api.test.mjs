import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { server, fetchFourteenDays } from "../server.mjs";

const key = "local-test-key-0000000000";
const header = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,daynight,scan,track\n";

test("API date reaches every NASA segment; cache separates selected dates and errors stay explicit", async(t)=>{
  const originalFetch = globalThis.fetch;
  const previousKey=process.env.NASA_FIRMS_MAP_KEY;
  process.env.NASA_FIRMS_MAP_KEY="forbidden-shared-key-00000";
  t.after(()=>{if(previousKey===undefined)delete process.env.NASA_FIRMS_MAP_KEY;else process.env.NASA_FIRMS_MAP_KEY=previousKey;});
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    if(!String(url).startsWith("https://firms.modaps.eosdis.nasa.gov/")) return originalFetch(url,options);
    const parts=new URL(url).pathname.split("/");
    calls.push({key:parts.at(-5),start:parts.at(-1),days:Number(parts.at(-2)),source:parts.at(-4)});
    return new Response(header+`60,25,${parts.at(-1)},0010,N20,n,20,N,.4,.4\n`,{status:200});
  };
  t.after(async()=>{globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise((resolve)=>server.close(resolve));});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=(date)=>originalFetch(`${origin}/api/hotspots?west=24&south=59&east=26&north=61&date=${date}`,{headers:{"X-FIRMS-MAP-Key":key}});
  const missing=await originalFetch(`${origin}/api/hotspots?west=24&south=59&east=26&north=61&date=2026-08-30`);
  assert.equal(missing.status,401);assert.equal((await missing.json()).error.code,"MAP_KEY_REQUIRED");assert.equal(calls.length,0);
  const first=await request("2026-08-30");
  assert.equal(first.status,200); assert.equal(first.headers.get("x-cache"),"MISS");
  const payload=await first.json(); assert.equal(payload.range.end,"2026-08-30"); assert.equal(payload.analysisRange.start,"2026-08-17");
  assert.equal(calls.length,9); assert.deepEqual([...new Set(calls.map((c)=>c.start))],["2026-08-17","2026-08-22","2026-08-27"]);
  for(const call of calls) assert.ok(new Date(`${call.start}T00:00:00Z`).getTime()+(call.days-1)*86400000 <= Date.parse("2026-08-30"));
  await (await request("2026-08-29")).json(); assert.equal(calls.length,18);
  const hit=await request("2026-08-30"); assert.equal(hit.headers.get("x-cache"),"HIT"); assert.equal(hit.headers.get("cache-control"),"no-store"); await hit.json(); assert.equal(calls.length,18);
  assert.ok(calls.every((call)=>call.key===key));
  const secondUserKey="another-test-user-0000000";
  const secondUser=await originalFetch(`${origin}/api/hotspots?west=24&south=59&east=26&north=61&date=2026-08-30`,{headers:{"X-FIRMS-MAP-Key":secondUserKey}});
  assert.equal(secondUser.headers.get("x-cache"),"MISS");await secondUser.json();
  assert.equal(calls.length,27);assert.ok(calls.slice(-9).every((call)=>call.key===secondUserKey));
  const invalid=await request("2026-02-30"); assert.equal(invalid.status,400); assert.equal((await invalid.json()).error.code,"INVALID_DATE");
  const css=await originalFetch(`${origin}/styles.css?v=20260905.1`); assert.match(css.headers.get("cache-control"),/no-cache/); await css.text();
  const method=await originalFetch(`${origin}/api/landcover`); assert.equal(method.status,405);
  const malformed=await originalFetch(`${origin}/api/landcover`,{method:"POST",body:"{"}); assert.equal(malformed.status,400);
});

test("a failed satellite segment is partial retrieval, never zero-complete coverage",async(t)=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url)=>String(url).includes("NOAA21") ? new Response("temporarily unavailable",{status:503}) : new Response(header,{status:200});
  t.after(()=>{globalThis.fetch=originalFetch;});
  const payload=await fetchFourteenDays({mapKey:key,area:{west:24,south:59,east:26,north:61},today:"2026-08-30"});
  assert.equal(payload.coverageComplete,false); assert.equal(payload.warnings.length,3); assert.equal(payload.detections.length,0);
  assert.equal(payload.sourceCoverage.find((s)=>s.source.includes("NOAA21")).missing.length,3);
});
