import test from "node:test";
import assert from "node:assert/strict";
import { createDebouncedAction, readMapKey, saveMapKey, removeMapKey, migrateMapKey } from "../public/preferences.js";

test("map requests wait for three quiet seconds, reset on movement and support cancel", () => {
  let now = 0, id = 0, calls = 0;
  const pending = new Map();
  const timers = { set: (fn, delay) => { pending.set(++id, { fn, at: now + delay }); return id; }, clear: (timer) => pending.delete(timer) };
  const tick = (ms) => { now += ms; for (const [key, item] of [...pending]) if (item.at <= now) { pending.delete(key); item.fn(); } };
  const request = createDebouncedAction(() => calls++, 3000, timers);
  request.schedule(); tick(2999); assert.equal(calls, 0);
  request.schedule(); tick(2999); assert.equal(calls, 0);
  tick(1); assert.equal(calls, 1); assert.equal(request.pending, false);
  request.schedule(); request.cancel(); tick(3000); assert.equal(calls, 1);
  request.schedule(); tick(3000); assert.equal(calls, 2);
});

test("a personal key survives reload, replaces the old key, migrates and can be forgotten", (t) => {
  const previousLocal=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  const previousSession=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
  const local=new Map(),session=new Map([["firms-map-key","legacy-personal-key"]]);
  const storage=(map)=>({getItem:(key)=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:(key)=>map.delete(key)});
  Object.defineProperty(globalThis,"localStorage",{value:storage(local),configurable:true});
  Object.defineProperty(globalThis,"sessionStorage",{value:storage(session),configurable:true});
  t.after(()=>{for(const [key,descriptor] of [["localStorage",previousLocal],["sessionStorage",previousSession]]) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  assert.equal(migrateMapKey(),"legacy-personal-key");assert.equal(session.size,0);
  assert.equal(readMapKey(),"legacy-personal-key");
  assert.equal(saveMapKey("new-personal-key"),true);assert.equal(migrateMapKey(),"new-personal-key");
  removeMapKey();assert.equal(readMapKey(),"");assert.equal(migrateMapKey(),"");
  Object.defineProperty(globalThis,"localStorage",{get(){throw new Error("storage blocked");},configurable:true});
  assert.equal(readMapKey(),"");assert.equal(saveMapKey("key"),false);assert.doesNotThrow(()=>removeMapKey());
});
