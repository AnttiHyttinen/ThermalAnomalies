import test from "node:test";
import assert from "node:assert/strict";
import { createDebouncedAction, readMapKey, saveMapKey, removeMapKey, migrateMapKey, canSendMapKey } from "../public/preferences.js";

test("map requests wait for four quiet seconds, reset on movement and support cancel", () => {
  let now = 0, id = 0, calls = 0;
  const pending = new Map();
  const timers = { set: (fn, delay) => { pending.set(++id, { fn, at: now + delay }); return id; }, clear: (timer) => pending.delete(timer) };
  const tick = (ms) => { now += ms; for (const [key, item] of [...pending]) if (item.at <= now) { pending.delete(key); item.fn(); } };
  const request = createDebouncedAction(() => calls++, 4000, timers);
  request.schedule(); tick(3999); assert.equal(calls, 0);
  request.schedule(); tick(3999); assert.equal(calls, 0);
  tick(1); assert.equal(calls, 1); assert.equal(request.pending, false);
  request.schedule(); request.cancel(); tick(4000); assert.equal(calls, 1);
  request.schedule(); tick(4000); assert.equal(calls, 2);
});

test("a personal key survives reload, replaces the old key, migrates and can be forgotten", (t) => {
  const previousLocal=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  const previousSession=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  const local=new Map(),session=new Map([["firms-map-key","legacy-personal-key"]]);
  const storage=(map)=>({getItem:(key)=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:(key)=>map.delete(key)});
  Object.defineProperty(globalThis,"localStorage",{value:storage(local),configurable:true});
  Object.defineProperty(globalThis,"sessionStorage",{value:storage(session),configurable:true});
  t.after(()=>{for(const [key,descriptor] of [["localStorage",previousLocal],["sessionStorage",previousSession]]) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  assert.equal(migrateMapKey(),"legacy-personal-key");assert.equal(session.size,1);
  assert.equal(readMapKey(),"");
  assert.equal(saveMapKey("new-personal-key"),true);assert.equal(migrateMapKey(),"new-personal-key");
  assert.equal(saveMapKey("session-only",false),true);assert.equal(readMapKey(),"");assert.equal(migrateMapKey(),"session-only");assert.equal(local.size,0);
  removeMapKey();assert.equal(readMapKey(),"");assert.equal(migrateMapKey(),"");
  Object.defineProperty(globalThis,"localStorage",{get(){throw new Error("storage blocked");},configurable:true});
  assert.equal(readMapKey(),"");assert.equal(saveMapKey("key"),false);assert.doesNotThrow(()=>removeMapKey());
});

test("default timers retain the browser global receiver when scheduling and cancelling", (t) => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.after(() => { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; });
  let callback, delay, cancelled = 0, calls = 0;
  globalThis.setTimeout = function (fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    callback = fn; delay = ms; return 1;
  };
  globalThis.clearTimeout = function () {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    cancelled++;
  };
  const request = createDebouncedAction(() => calls++);
  request.schedule(); assert.equal(delay, 4000);
  request.schedule(); assert.equal(cancelled, 1);
  callback(); assert.equal(calls, 1); assert.equal(request.pending, false);
  request.schedule(); request.cancel(); assert.equal(cancelled, 2);
});

test("keys only travel over HTTPS or local development loopback", () => {
 assert.equal(canSendMapKey({protocol:"http:",hostname:"example.com"}),false);
 assert.equal(canSendMapKey({protocol:"https:",hostname:"example.com"}),true);
 assert.equal(canSendMapKey({protocol:"http:",hostname:"localhost"}),true);
 assert.equal(canSendMapKey({protocol:"http:",hostname:"localhost.example.com"}),false);
});
