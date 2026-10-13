// DOM integration only: no browser, tile downloads or live NASA calls.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { addUtcDays } from "../src/firms.mjs";

const flush=async()=>{for(let i=0;i<20;i++) await new Promise((resolve)=>setImmediate(resolve));};

test("UI switches day, clears stale results, opens FRP details and handles racing requests",async(t)=>{
  const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  const {window,document}=parseHTML(html);
  // Supply browser APIs that LinkeDOM deliberately leaves out.
  for(const select of document.querySelectorAll("select")) Object.defineProperty(select,"value",{get(){return this.querySelector("option[selected]")?.getAttribute("value") || this.querySelector("option")?.getAttribute("value");},set(value){for(const option of this.querySelectorAll("option")) option.toggleAttribute("selected",option.getAttribute("value")===String(value));}});
  for(const dialog of document.querySelectorAll("dialog")){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;this.dispatchEvent(new window.Event("close"));};}
  const drawing=new Proxy({}, {get:()=>()=>{}});
  document.querySelector("canvas").getContext=()=>drawing;
  const saved=new Map();
  const set=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});};
  const pendingTimers=new Map(); let clock=0, timerId=0;
  const tick=async(ms)=>{clock+=ms;for(const [id,timer] of [...pendingTimers])if(timer.at<=clock){pendingTimers.delete(id);timer.callback();}await flush();};
  const storage=new Map(); const persistentStorage=new Map([["firms-map-key","test-user-key-00000000000"]]); let observer;
  set("localStorage",{getItem:(k)=>persistentStorage.get(k)??null,setItem:(k,v)=>persistentStorage.set(k,v),removeItem:(k)=>persistentStorage.delete(k)});
  set("document",document);set("window",window);set("sessionStorage",{getItem:(k)=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:(k)=>storage.delete(k)});
  set("ResizeObserver",class{constructor(callback){observer=callback;}observe(){}});
  set("setInterval",()=>0);
  set("setTimeout",function(callback,delay){
    if(this!==undefined && this!==globalThis)throw new TypeError("Illegal invocation");
    if(delay>10000)return 0;
    pendingTimers.set(++timerId,{callback,at:clock+delay});return timerId;
  });
  set("clearTimeout",function(id){
    if(this!==undefined && this!==globalThis)throw new TypeError("Illegal invocation");
    pendingTimers.delete(id);
  });
  const detailRequests=[];
  const requests=[]; const requestAreas=[]; const requestKeys=[]; const deferred=[]; let racing=false; let historical=false;
  const response=(date)=>new Response(JSON.stringify({generatedAt:`${date}T12:00:00Z`,range:{start:addUtcDays(date,-6),end:date,days:7},analysisRange:{start:addUtcDays(date,-13),end:date,days:14},coverageComplete:true,warnings:[],detections:(historical ? [{date:addUtcDays(date,-2),frp:80},{date:addUtcDays(date,-10),frp:140}] : [{date,frp:80}]).map((p)=>({latitude:60,longitude:25,time:"00:10",confidence:"n",satellite:"N20",source:"VIIRS_NOAA20_NRT",daynight:"N",...p}))}));
  set("fetch",async(url,options)=>{
    if(String(url).startsWith("/api/landcover")) return new Response(JSON.stringify({results:JSON.parse(options.body).events.map((event)=>({id:event.id,environment:{id:"built",label:"Rakennettua lämpöpikselien ympärillä",status:"ready",counts:{50:25},sampleCount:25,known:25,totalPoints:1,sampledPoints:1,builtFraction:1,vegetationFraction:0}}))}));
    if(String(url).startsWith("/api/event-data")) {
      detailRequests.push({url,options});
      const date=new URL(url,"http://localhost").searchParams.get("date");
      const payload=await response(date).json();payload.analysisRange={start:addUtcDays(date,-27),end:date,days:28};
      return new Response(JSON.stringify(payload));
    }
    const date=new URL(url,"http://localhost").searchParams.get("date"); requests.push(date); requestAreas.push(new URL(url,"http://localhost").search); requestKeys.push(options.headers["X-FIRMS-MAP-Key"]);
    if(!options.headers["X-FIRMS-MAP-Key"]) return new Response(JSON.stringify({error:{code:"MAP_KEY_REQUIRED",message:"Syötä avain."}}),{status:401});
    if(racing) return await new Promise((resolve)=>deferred.push({date,resolve}));
    return response(date);
  });
  t.after(()=>{pendingTimers.clear();for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  await import("../public/app.js");
  const today=new Date().toISOString().slice(0,10);
  assert.equal(document.querySelector("#selected-date").value,today);
  observer([{contentRect:{width:900,height:600}}]);await flush();
  assert.equal(requests[0],today); assert.equal(requestKeys[0],"test-user-key-00000000000"); assert.equal(document.querySelector("#loading").hidden,true);
  assert.equal(document.querySelectorAll(".event-card").length,1);
  // Use the actual map handlers and the default timer adapter, with a fake
  // browser clock: no NASA request before four quiet seconds.
  const map=document.querySelector("#map");map.setPointerCapture=()=>{};
  const pointer=(type,x,y)=>{const event=new window.Event(type);Object.assign(event,{button:0,pointerId:1,clientX:x,clientY:y});map.dispatchEvent(event);};
  const beforeZoom=requests.length;
  document.querySelector("#zoom-in").click();await tick(2500);
  assert.equal(requests.length,beforeZoom);
  document.querySelector("#zoom-out").click();await tick(3999);
  assert.equal(requests.length,beforeZoom);
  await tick(1);assert.equal(requests.length,beforeZoom+1);
  const beforeDrag=requests.length, oldArea=requestAreas.at(-1);
  pointer("pointerdown",300,300);pointer("pointermove",400,350);
  await tick(5000);assert.equal(requests.length,beforeDrag);
  pointer("pointerup",400,350);await tick(3999);assert.equal(requests.length,beforeDrag);
  await tick(1);assert.equal(requests.length,beforeDrag+1);
  assert.notEqual(requestAreas.at(-1),oldArea);
  // A new drag pauses an existing zoom timer and starts a new delay on release.
  const beforePause=requests.length;
  document.querySelector("#zoom-in").click();await tick(2000);
  pointer("pointerdown",300,300);pointer("pointermove",350,350);
  await tick(5000);assert.equal(requests.length,beforePause);
  pointer("pointerup",350,350);await tick(4000);assert.equal(requests.length,beforePause+1);
  const beforeArrow=requests.length;
  const arrow=new window.Event("keydown");Object.assign(arrow,{key:"ArrowRight",shiftKey:false});map.dispatchEvent(arrow);
  await tick(3999);assert.equal(requests.length,beforeArrow);
  await tick(1);assert.equal(requests.length,beforeArrow+1);
  // Refresh is immediate and consumes the pending map request.
  const beforeRefresh=requests.length;
  document.querySelector("#zoom-out").click();document.querySelector("#refresh-button").click();await flush();
  assert.equal(requests.length,beforeRefresh+1);
  await tick(4000);assert.equal(requests.length,beforeRefresh+1);
  const repeatedOnly=document.querySelector("#repeated-only");
  repeatedOnly.checked=true;repeatedOnly.dispatchEvent(new window.Event("change"));
  assert.equal(document.querySelectorAll(".event-card").length,0);
  repeatedOnly.checked=false;repeatedOnly.dispatchEvent(new window.Event("change"));
  assert.equal(document.querySelectorAll(".event-card").length,1);
  const sort=document.querySelector("#event-sort");sort.value="ratio";sort.dispatchEvent(new window.Event("change"));
  document.querySelector('[data-action="map"]').click();
  assert.ok(document.querySelector("#map-tooltip").textContent.includes("D0 FRP-huippu 80 MW"));
  assert.ok(document.querySelector("#map-tooltip .period-frp-peak").textContent.includes("14 vrk FRP-huippu 80 MW ("));
  document.querySelector('[data-action="details"]').click();
  assert.equal(document.querySelector("#event-dialog").open,true);
  await flush();
  assert.equal(detailRequests.length,1);assert.equal(detailRequests[0].options.headers["X-FIRMS-MAP-Key"],"test-user-key-00000000000");
  assert.ok(document.querySelector("#deep-analysis").textContent.includes("Kohteen kehitys"));
  assert.ok(document.querySelector("#detail-spatial svg"));
  assert.ok(document.querySelector(".evidence-summary").textContent.includes("Mitä kohteesta voidaan päätellä"));
  assert.equal(document.querySelectorAll(".frp-profile-day").length,14);
  assert.equal(document.querySelector(".frp-profile-day:last-child .frp-profile-bar").style.height,"100%");
  document.querySelector("#reasoning-button").click();assert.equal(document.querySelector("#reasoning-dialog").open,true);document.querySelector("#reasoning-close").click();
  const selector=document.querySelector("#selected-date");selector.value="2026-08-29";selector.dispatchEvent(new window.Event("change"));await flush();
  assert.equal(requests.at(-1),"2026-08-29");assert.ok(document.querySelector("#range-title").textContent.includes("29.8.2026"));
  document.querySelector('[data-action="details"]').click();assert.ok(document.querySelector("#event-dialog-content").textContent.includes("29.8."));document.querySelector("#event-dialog-close").click();
  historical=true;
  const history=document.querySelector("#include-history");history.checked=true;history.dispatchEvent(new window.Event("change"));
  selector.value="2026-08-30";selector.dispatchEvent(new window.Event("change"));await flush();
  document.querySelector('[data-action="map"]').click();
  assert.ok(document.querySelector("#map-tooltip").textContent.includes("D0 FRP-huippu — MW"));
  assert.equal(document.querySelector("#map-tooltip .period-frp-peak").textContent,"14 vrk FRP-huippu 140 MW (20.8.)");
  historical=false;
  document.querySelector("#key-settings").click();
  assert.equal(document.querySelector("#key-panel").hidden,false);
  const beforeForget=requests.length;
  document.querySelector("#forget-key").click();await flush();
  assert.equal(persistentStorage.has("firms-map-key"),false);
  // Without an own key the server's optional shared key is tried; no shared key -> prompt for own key.
  assert.equal(requests.length,beforeForget+1);assert.equal(requestKeys.at(-1),undefined);
  assert.equal(document.querySelector("#key-panel").hidden,false);
  assert.equal(document.querySelector("#data-status").textContent,"Oma avain tarvitaan");
  assert.equal(document.querySelectorAll(".event-card").length,0);
  document.querySelector("#remember-key").checked=true;
  document.querySelector("#map-key").value="second-user-key-00000000";
  document.querySelector("#key-form").dispatchEvent(new window.Event("submit"));await flush();
  assert.equal(persistentStorage.get("firms-map-key"),"second-user-key-00000000");
  assert.equal(requestKeys.at(-1),"second-user-key-00000000");
  assert.equal(document.querySelectorAll(".event-card").length,1);
  racing=true;
  for(const date of ["2026-08-27","2026-08-28"]){selector.value=date;selector.dispatchEvent(new window.Event("change"));}
  assert.equal(document.querySelectorAll(".event-card").length,0);
  deferred[1].resolve(response(deferred[1].date));await flush();
  assert.ok(document.querySelector("#range-title").textContent.includes("28.8.2026"));
  deferred[0].resolve(response(deferred[0].date));await flush();
  assert.ok(document.querySelector("#range-title").textContent.includes("28.8.2026"));assert.equal(document.querySelector("#loading").hidden,true);
});
