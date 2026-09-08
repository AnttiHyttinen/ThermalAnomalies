import test from "node:test";
import assert from "node:assert/strict";
import { findLargeFireEvents, dateRange, summarizeOverpasses, compareOverpass } from "../public/anomaly.js";
import { normalizeDetection, validateSelectedDate, deduplicateDetections, validateArea } from "../src/firms.mjs";
import { visibleEvents, summarizeLandcover, priorityFor, selectionDate, exportEventsCsv } from "../public/assessment.js";
import { readCategoricalSamples, tileFor, validateContextRequest, assessLandcover } from "../src/landcover.mjs";

const today = "2026-08-30";
const dates = dateRange("2026-08-17", "2026-08-29");
const point = (date, options = {}) => ({latitude:60,longitude:25,date,time:"00:10",satellite:"N20",source:"VIIRS_NOAA20_NRT",daynight:"N",confidence:"n",frp:20,...options});
const sourcePass = (date, options = {}) => [point(date,options),point(date,{latitude:60.001,longitude:25.001,...options})];
const normal = () => dates.flatMap((date) => sourcePass(date));
const expanded = (time = "00:10") => [...sourcePass(today,{frp:100,time}),point(today,{latitude:60.018,frp:150,time}),point(today,{latitude:60.016,longitude:25.004,frp:150,time})];

test("blank numeric fields are missing and invalid dates/coordinates do not become observations",()=>{
  const row = {latitude:"60",longitude:"25",acq_date:today,acq_time:"",frp:"",scan:"",track:""};
  const p=normalizeDetection(row,"VIIRS_NOAA20_NRT");
  assert.equal(p.frp,null); assert.equal(p.scanKm,null); assert.equal(p.time,null);
  assert.equal(normalizeDetection({...row,latitude:""},"VIIRS_NOAA20_NRT"),null);
  assert.equal(normalizeDetection({...row,acq_date:"2026-02-30"},"VIIRS_NOAA20_NRT"),null);
  assert.doesNotThrow(()=>deduplicateDetections([p,{...p,id:"second",time:"00:20"}]));
  assert.throws(()=>validateArea(new URLSearchParams({south:"1",east:"2",north:"3"})),{code:"INVALID_AREA"});
});

test("a selected day is valid, defaults to UTC today and rejects overflow/future dates",()=>{
  assert.equal(validateSelectedDate(null,today),today);
  assert.equal(validateSelectedDate("2024-02-29",today),"2024-02-29");
  for(const date of ["2026-02-30","2026-09-01","", "2026-2-1"]) assert.throws(()=>validateSelectedDate(date,today),{code:"INVALID_DATE"});
  assert.equal(selectionDate({mode:"history",date:today},new Date("2026-08-31T00:01:00Z")),today);
  assert.equal(selectionDate({mode:"live"},new Date("2026-08-31T00:01:00Z")),"2026-08-31");
});

test("a single small VIIRS event survives and carries limited evidence",()=>{
  const events=findLargeFireEvents([point(today,{frp:80})],today).events;
  assert.equal(events.length,1); assert.equal(events[0].pointCount,1); assert.equal(events[0].isLargeFire,false);
  assert.equal(events[0].reliability.level,"low");
  assert.equal(visibleEvents(events).length,1);
});

test("steady high heat is observed normal; no D0, missing FRP and partial retrieval are unknown",()=>{
  const stable=[...normal(),...sourcePass(today)];
  assert.equal(findLargeFireEvents(stable,today).events[0].kind,"persistent-source");
  assert.equal(findLargeFireEvents(stable.map((p)=>({...p,frp:2000})),today).events[0].kind,"persistent-source");
  assert.equal(findLargeFireEvents(normal(),today).events[0].kind,"source-unknown");
  assert.equal(findLargeFireEvents([...normal(),...sourcePass(today,{frp:null})],today).events[0].kind,"source-unknown");
  assert.equal(findLargeFireEvents(stable,today,{dataCoverageComplete:false}).events[0].kind,"source-unknown");
});

test("a new sensor or day/night group does not compare against a fabricated zero baseline",()=>{
  for(const options of [{satellite:"N21",source:"VIIRS_NOAA21_NRT"},{daynight:"D"},{time:null}]){
    const event=findLargeFireEvents([...normal(),...sourcePass(today,{frp:1000,...options})],today).events[0];
    assert.equal(event.kind,"source-unknown"); assert.equal(event.comparisonMethod,"insufficient");
  }
});

test("six same-day passes do not substitute for independent baseline days",()=>{
  const pass=summarizeOverpasses(sourcePass(today))[0];
  const comparisons=compareOverpass(pass,Array.from({length:6},(_,i)=>({...pass,date:"2026-08-29",time:`0${i}:00`})));
  assert.equal(comparisons.assessable,false); assert.equal(comparisons.isAnomalous,false);
});

test("a clock boundary and duplicate rows cannot create two fire confirmations",()=>{
  const first=expanded("00:29"),second=expanded("00:31");
  const passes=summarizeOverpasses([...first,...first,...second]);
  assert.equal(passes.length,1); assert.equal(passes[0].pixelCount,4);
  const event=findLargeFireEvents([...normal(),...first,...second],today).events[0];
  assert.equal(event.kind,"source-anomaly"); assert.equal(event.confirmingPassCount,1);
});

test("different sensor coverage does not create a multi-day change point",()=>{
  const early=dates.slice(0,8).flatMap((d)=>sourcePass(d));
  const later=[...dates.slice(8),today].flatMap((date)=>sourcePass(date,{satellite:"N21",source:"VIIRS_NOAA21_NRT",frp:300}));
  const event=findLargeFireEvents([...early,...later],today).events[0];
  assert.equal(event.changePoint,null); assert.equal(event.kind,"persistent-source");
});

test("historical analysis ignores future events and recomputes its reference window",()=>{
  const historyDay="2026-08-27";
  const points=[...normal(),...expanded()];
  const a=findLargeFireEvents(points,historyDay).events[0];
  const b=findLargeFireEvents(points.filter((p)=>p.date<=historyDay),historyDay).events[0];
  assert.equal(a.kind,"persistent-source"); assert.deepEqual(a.comparisons,b.comparisons);
  assert.equal(a.baselinePeriod.end,"2026-08-26");
  assert.equal(findLargeFireEvents(points,today).events[0].kind,"source-anomaly");
});

test("partial FRP remains null and low confidence / MODIS do not participate",()=>{
  const passes=summarizeOverpasses([point(today),point(today,{longitude:25.001,frp:null})]);
  assert.equal(passes[0].totalFrp,null); assert.equal(passes[0].maxFrp,20);
  assert.equal(findLargeFireEvents([point(today,{confidence:"l"}),point(today,{source:"MODIS_NRT"})],today).events.length,0);
});

test("landcover distinguishes built and vegetation without hiding mixed or incomplete samples",()=>{
  assert.equal(summarizeLandcover(Array(25).fill(10)).id,"vegetation");
  assert.equal(summarizeLandcover([...Array(24).fill(10),50]).id,"mixed");
  assert.equal(summarizeLandcover([...Array(24).fill(10),50],{centerValues:[50]}).id,"mixed");
  assert.equal(summarizeLandcover(Array(25).fill(50)).id,"built");
  assert.equal(summarizeLandcover([...Array(19).fill(10),...Array(6).fill(0)]).id,"unknown");
  assert.equal(summarizeLandcover(Array(25).fill(10),{sampledPoints:1,totalPoints:2}).id,"unknown");
});

test("default priority keeps unresolved cases and source anomalies even in vegetation",()=>{
  const base={kind:"fire",activeToday:true,activeDates:[today],currentPeakPassFrp:40,overpasses:[{date:today,time:"00:10",satellite:"N20",daynight:"N"},{date:today,time:"01:30",satellite:"N21",daynight:"N"}]};
  const events=[{...base,id:"built",environment:{id:"built"}},{...base,id:"forest",environment:{id:"vegetation"}},{...base,id:"unknown"},{...base,id:"normal",kind:"persistent-source"},{...base,id:"anomaly",kind:"source-anomaly",environment:{id:"vegetation"}},{...base,id:"no-data",kind:"source-unknown",activeToday:false}];
  assert.deepEqual(visibleEvents(events).map((e)=>e.id),["anomaly","built","unknown","no-data"]);
  assert.equal(visibleEvents(events,{filter:"all"}).length,6);
  assert.equal(priorityFor(events[0]).label,"Lämpötapahtuma rakennetulla alueella");
});

test("COG tile arithmetic works across southern/western hemispheres and dateline",()=>{
  assert.equal(tileFor(-0.1,-0.1).code,"S03W003");
  assert.equal(tileFor(60.17,24.94).code,"N60E024");
  assert.equal(tileFor(0,180).code,"N00W180");
});

test("categorical sampling reads bounded native raster windows with correct axis direction",async()=>{
  const windows=[];
  const values=await readCategoricalSamples([{latitude:1.8,longitude:1.2},{latitude:1.8,longitude:2.2}],{imageProvider:async()=>({getOrigin:()=>[0,3],getResolution:()=>[1,-1],getWidth:()=>3,getHeight:()=>3,readRasters:async({window})=>{windows.push(window);return new Uint8Array([50,10]);}})});
  assert.deepEqual(values,[50,10]); assert.deepEqual(windows,[[1,1,3,2]]);
});

test("raster failure is explicit unknown, and untrusted raster URLs are never accepted",async()=>{
  const event={id:"missing-test",points:[{latitude:30,longitude:70}],totalPoints:1};
  const result=await assessLandcover(event,{reader:async()=>{throw new Error("offline");}});
  assert.equal(result.environment.id,"unknown"); assert.equal(result.environment.status,"error");
  assert.throws(()=>validateContextRequest({events:[{...event,points:[{latitude:null,longitude:70}]}]}),{status:400});
  assert.throws(()=>validateContextRequest({events:Array(7).fill(event)}),{status:400});
});

test("CSV keeps missing FRP empty and signed coordinates numeric",()=>{
  const csv=exportEventsCsv([{kind:"fire",latitude:-30,longitude:25,activeDates:[today],currentPeakPassFrp:null,currentPassCount:1}],today);
  assert.match(csv,/"-30"/); assert.match(csv,/"";"1"/); assert.ok(!csv.includes("undefined"));
});
