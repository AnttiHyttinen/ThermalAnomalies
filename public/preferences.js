export const MAP_KEY_STORAGE = "firms-map-key";

export function readMapKey() {
  try { return localStorage.getItem(MAP_KEY_STORAGE) || ""; }
  catch { return ""; }
}

export function saveMapKey(value, remember = true) {
  try { sessionStorage.removeItem(MAP_KEY_STORAGE); } catch {}
  if (!remember) {
    try { localStorage.removeItem(MAP_KEY_STORAGE); } catch { return false; }
    try { sessionStorage.setItem(MAP_KEY_STORAGE, value); return true; } catch { return false; }
  }
  try { localStorage.setItem(MAP_KEY_STORAGE, value); return true; }
  catch { return false; }
}

export function removeMapKey() {
  let removed = true;
  try { localStorage.removeItem(MAP_KEY_STORAGE); } catch { removed = false; }
  try { sessionStorage.removeItem(MAP_KEY_STORAGE); } catch { removed = false; }
  return removed;
}

export function migrateMapKey() {
  const current = readMapKey();
  let legacy = "";
  try { legacy = sessionStorage.getItem(MAP_KEY_STORAGE) || ""; } catch {}
  // Session-only keys must never silently become persistent.
  return current || legacy;
}

export const MAP_FETCH_DELAY_MS = 4000;

// Browser timer methods require the Window/global receiver. Do not call the
// native functions as methods of the injected timers object.
export function createDebouncedAction(action, delay = MAP_FETCH_DELAY_MS, timers = {
  set: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clear: (id) => globalThis.clearTimeout(id),
}) {
  let timer = null;
  const cancel = () => { if (timer !== null) timers.clear(timer); timer = null; };
  return {
    get pending() { return timer !== null; },
    cancel,
    schedule() { cancel(); timer = timers.set(() => { timer = null; action(); }, delay); },
  };
}

export function canSendMapKey(location = globalThis.location) {
  return !location || location.protocol === "https:" || (location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
}
