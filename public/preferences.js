export const MAP_KEY_STORAGE = "firms-map-key";

export function readMapKey() {
  try { return localStorage.getItem(MAP_KEY_STORAGE) || ""; }
  catch { return ""; }
}

export function saveMapKey(value) {
  try { localStorage.setItem(MAP_KEY_STORAGE, value); return true; }
  catch { return false; }
}

export function removeMapKey() {
  let removed = true;
  try { localStorage.removeItem(MAP_KEY_STORAGE); } catch { removed = false; }
  try { sessionStorage.removeItem(MAP_KEY_STORAGE); } catch {}
  return removed;
}

export function migrateMapKey() {
  const current = readMapKey();
  let legacy = "";
  try { legacy = sessionStorage.getItem(MAP_KEY_STORAGE) || ""; } catch {}
  if (!current && legacy) saveMapKey(legacy);
  try { sessionStorage.removeItem(MAP_KEY_STORAGE); } catch {}
  return current || legacy;
}

export function createDebouncedAction(action, delay = 3000, timers = { set: setTimeout, clear: clearTimeout }) {
  let timer = null;
  const cancel = () => { if (timer !== null) timers.clear(timer); timer = null; };
  return {
    get pending() { return timer !== null; },
    cancel,
    schedule() { cancel(); timer = timers.set(() => { timer = null; action(); }, delay); },
  };
}
