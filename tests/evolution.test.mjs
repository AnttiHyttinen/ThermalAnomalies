import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeEvolution, buildDetailAnalysis, exportEvolutionCsv } from "../public/evolution.js";
import { renderEvolution } from "../public/detail-view.js";

test("Samara reference preserves measured peak and separates early changes from adequately baselined onset", async () => {
  // 52 measured overpasses from the user-provided Lämpötapahtumat.xlsx; no inferred pixel coordinates.
  const passes=JSON.parse(await readFile(new URL("./fixtures/samara-passes.json",import.meta.url),"utf8"));
  const a=analyzeEvolution(passes);
  assert.equal(a.passes.length,52);
  assert.equal(a.peak.totalFrp,451.9);assert.equal(a.peak.at,"2026-10-08T00:20:00Z");
  assert.equal(a.pointPeak.maxFrp,220);assert.equal(a.widest.radius95Km,1.8);
  assert.equal(a.onset.pass.date,"2026-10-07");assert.equal(a.onset.confirmed,true);
  assert.ok(a.changes.find((r)=>r.pass.at==="2026-10-07T08:48:00Z").labels.includes("Voimistuminen"));
  assert.ok(a.changes.find((r)=>r.pass.at==="2026-10-08T08:30:00Z").labels.includes("Heikkeneminen"));
  assert.ok(a.changes.some((r)=>r.labels.includes("Teho keskittyy yhteen pikseliin")));
  assert.ok(a.changes.every((r)=>!r.labels.includes("Lämpöjalanjälki laajenee"))); // no scan/track in workbook
});

const pass=(date,frp,extra={})=>({date,time:"10:00",satellite:"N20",daynight:"D",totalFrp:frp,maxFrp:frp,pixelCount:1,radius95Km:0,...extra});
test("no inter-sensor, day/night, missing-FRP or long-gap ratios; no invented ignition",()=>{
 const a=analyzeEvolution([pass("2026-10-01",10),pass("2026-10-02",100,{satellite:"N21"}),pass("2026-10-02",200,{daynight:"N"}),pass("2026-10-03",null),pass("2026-10-07",1000),pass("2026-10-07",20,{time:null})]);
 assert.equal(a.onset,null);assert.equal(a.unTimed,1);assert.ok(a.changes.every((r)=>r.ratio===null));assert.equal(a.passes[3].totalFrp,null);
 assert.ok(a.gaps.length>0);
});
test("measured geometry supports expansion and partial coverage stays explicit",()=>{
 const a=analyzeEvolution([pass("2026-10-01",10,{observedPixelAreaKm2:0.16,measuredPixelArea:true}),pass("2026-10-02",80,{pixelCount:4,radius95Km:0.8,observedPixelAreaKm2:0.64,measuredPixelArea:true})],{coverageComplete:false});
 assert.equal(a.coverageComplete,false);assert.ok(a.changes[1].labels.includes("Lämpöjalanjälki laajenee"));assert.equal(a.onset,null);
});
test("detail radius and selected day exclude unrelated data, MODIS stays separate, missing FRP stays missing",()=>{
 const p={latitude:53,longitude:50.5,date:"2026-10-10",time:"10:00",satellite:"N20",daynight:"D",confidence:"n",source:"VIIRS_NOAA20_NRT",frp:80,scanKm:.4,trackKm:.4};
 const payload={analysisRange:{start:"2026-09-14",end:"2026-10-11",days:28},coverageComplete:false,detections:[p,{...p,longitude:52},{...p,date:"2026-10-12"},{...p,confidence:"l"},{...p,date:"2026-10-11",frp:null},{...p,source:"MODIS_NRT",satellite:"Terra",confidence:"80",frp:900}]};
 const a=buildDetailAnalysis(payload,p,3);
 assert.equal(a.passes.length,2);assert.equal(a.peak.totalFrp,80);assert.equal(a.support[0].totalFrp,900);assert.equal(a.passes[1].totalFrp,null);assert.equal(a.excluded,1);
 assert.ok(renderEvolution(a).includes("Haku on osittainen"));assert.ok(exportEvolutionCsv(a).includes('"80"'));assert.ok(!exportEvolutionCsv(a).includes("900"));
});
