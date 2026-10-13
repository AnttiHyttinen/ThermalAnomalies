import { buildDetailAnalysis, detailBounds, exportEvolutionCsv } from "./evolution.js?v=20261013.1";
import { renderEvolution, renderSpatial } from "./detail-view.js?v=20261013.1";
import { createTileRenderer } from "./tiles.js?v=20261013.1";
import { migrateMapKey, readMapKey, saveMapKey, removeMapKey, canSendMapKey, MAP_KEY_STORAGE, MAP_FETCH_DELAY_MS, createDebouncedAction } from "./preferences.js?v=20261013.1";
import { dailyCounts, findLargeFireEvents } from "./anomaly.js?v=20261013.1";
import { formatDate, shortWeekday, periodFrpPeak } from "./format.js?v=20261013.1";

import { environmentalContext, observationEvidence, priorityFor, visibleEvents, shiftDay, selectionDate, exportEventsCsv, LANDCOVER_CLASSES } from "./assessment.js?v=20261013.1";
import { REASONING_HTML } from "./reasoning.js?v=20261013.1";
document.querySelector("#reasoning-content").innerHTML = REASONING_HTML;

const TILE_SIZE = 256;
const MIN_ZOOM = 5;
const MAX_ZOOM = 13;
const INITIAL_VIEW = { longitude: 34.2, latitude: 45.3, zoom: 8 };
const DAY_COLORS = ["#7f6b53", "#90734f", "#a77c4c", "#bd8445", "#d88a3d", "#ee8240", "#ff5f38"];
const MAP_STYLES = new Set(["dark", "light", "grayscale"]);

const elements = {
  selectedDate: document.querySelector("#selected-date"),
  previousDay: document.querySelector("#previous-day"),
  nextDay: document.querySelector("#next-day"),
  todayButton: document.querySelector("#today-button"),
  dateMode: document.querySelector("#date-mode"),
  eventFilter: document.querySelector("#event-filter"),
  eventSort: document.querySelector("#event-sort"),
  repeatedOnly: document.querySelector("#repeated-only"),
  includeHistory: document.querySelector("#include-history"),
  showPoints: document.querySelector("#show-points"),
  minFrp: document.querySelector("#min-frp"),
  filterNote: document.querySelector("#filter-note"),
  coverageNote: document.querySelector("#coverage-note"),
  landcoverStatus: document.querySelector("#landcover-status"),
  moreLandcover: document.querySelector("#more-landcover"),
  exportCsv: document.querySelector("#export-csv"),
  locationForm: document.querySelector("#location-form"),
  coordinates: document.querySelector("#coordinates"),
  eventDialog: document.querySelector("#event-dialog"),
  eventDialogClose: document.querySelector("#event-dialog-close"),
  eventDialogTitle: document.querySelector("#event-dialog-title"),
  eventDialogContent: document.querySelector("#event-dialog-content"),
  map: document.querySelector("#map"),
  tiles: document.querySelector("#tile-layer"),
  canvas: document.querySelector("#heat-canvas"),
  tooltip: document.querySelector("#map-tooltip"),
  loading: document.querySelector("#loading"),
  empty: document.querySelector("#empty-state"),
  keyPanel: document.querySelector("#key-panel"),
  keyForm: document.querySelector("#key-form"),
  keyInput: document.querySelector("#map-key"),
  keySettings: document.querySelector("#key-settings"),
  forgetKey: document.querySelector("#forget-key"),
  refresh: document.querySelector("#refresh-button"),
  reasoningButton: document.querySelector("#reasoning-button"),
  reasoningDialog: document.querySelector("#reasoning-dialog"),
  reasoningClose: document.querySelector("#reasoning-close"),
  reasoningCloseFooter: document.querySelector("#reasoning-close-footer"),
  mapStyle: document.querySelector("#map-style-select"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
  status: document.querySelector("#data-status"),
  rangeTitle: document.querySelector("#range-title"),
  fireCount: document.querySelector("#fire-count"),
  todayCount: document.querySelector("#today-count"),
  sourceCount: document.querySelector("#source-count"),
  allCount: document.querySelector("#all-count"),
  dailyBars: document.querySelector("#daily-bars"),
  fireList: document.querySelector("#fire-list"),
  lastUpdated: document.querySelector("#last-updated"),
  toast: document.querySelector("#toast"),
};

const context = elements.canvas.getContext("2d");
const updateTiles = createTileRenderer(elements.tiles);
const state = {
  center: { longitude: INITIAL_VIEW.longitude, latitude: INITIAL_VIEW.latitude },
  zoom: INITIAL_VIEW.zoom,
  width: 0,
  height: 0,
  data: null,
  analysis: {
    fires: [],
    sourceFires: [],
    persistentSources: [],
    sourceAnomalies: [],
    events: [],
    clusters: [],
    activeTodayCount: 0,
    activeSourceFireCount: 0,
    activeSourceAnomalyCount: 0,
  },
  selection: { mode: "live", date: null },
  requestVersion: 0,
  contextController: null,
  contextBusy: false,
  currentEventId: null,
  detail: null,
  detailController: null,
  tooltipEventId: null,
  counts: [],
  filter: "attention",
  sort: "priority",
  repeatedOnly: false,
  includeHistory: false,
  showPoints: false,
  minFrp: 0,
  dateIndex: new Map(),
  drag: null,
  abortController: null,
  rolloverTimer: null,
  toastTimer: null,
  mapKey: migrateMapKey(),
  mapStyle: normalizeMapStyle(storedMapStyle()),
  reasoningReturnFocus: null,
};

const mapFetch = createDebouncedAction(() => fetchData());

const timeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const numberFormatter = new Intl.NumberFormat("fi-FI", { maximumFractionDigits: 1 });

setMapStyle(state.mapStyle, { persist: false });
updateDateControls();
elements.selectedDate.addEventListener("change", () => selectDay(elements.selectedDate.value));
elements.previousDay.addEventListener("click", () => selectDay(shiftDay(selectionDate(state.selection), -1)));
elements.nextDay.addEventListener("click", () => selectDay(shiftDay(selectionDate(state.selection), 1)));
elements.todayButton.addEventListener("click", () => selectDay(new Date().toISOString().slice(0, 10), true));
for (const element of [elements.eventFilter, elements.eventSort, elements.repeatedOnly, elements.includeHistory, elements.showPoints, elements.minFrp]) element.addEventListener("change", () => {
  state.filter = elements.eventFilter.value;
  state.sort = elements.eventSort.value;
  state.repeatedOnly = elements.repeatedOnly.checked;
  state.includeHistory = elements.includeHistory.checked;
  state.showPoints = elements.showPoints.checked;
  state.minFrp = Math.max(0, Number(elements.minFrp.value) || 0);
  elements.minFrp.value = state.minFrp;
  elements.tooltip.hidden = true;
  if (state.data) renderSummary();
  drawHeatLayer();
});
elements.moreLandcover.addEventListener("click", () => enrichContexts(state.requestVersion));
elements.eventDialogClose.addEventListener("click", () => elements.eventDialog.close());
elements.eventDialog.addEventListener("close", () => { state.currentEventId = null; state.detailController?.abort(); state.detail = null; });
elements.exportCsv.addEventListener("click", () => {
  if (!state.data) return;
  const blob = new Blob([exportEventsCsv(currentEvents(), state.data.range.end)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `lampokohteet-${state.data.range.end}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
elements.locationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = elements.coordinates.value.trim().split(/[,;\s]+/).map(Number);
  if (values.length !== 2 || values.some((v) => !Number.isFinite(v)) || Math.abs(values[0]) > 85 || Math.abs(values[1]) > 180) return showToast("Anna leveysaste ja pituusaste, esimerkiksi 60.3, 25.5.");
  state.center = { latitude: values[0], longitude: values[1] }; state.zoom = Math.max(8, state.zoom); renderMap(); scheduleFetch();
});

new ResizeObserver(([entry]) => {
  const wasReady = state.width > 0 && state.height > 0;
  const box = entry.contentRect;
  state.width = Math.max(1, Math.round(box.width));
  state.height = Math.max(1, Math.round(box.height));
  renderMap();
  if (!wasReady) fetchData();
}).observe(elements.map);

elements.keyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canSendMapKey()) return showToast("Avaa sovellus HTTPS-osoitteella ennen avaimen syöttämistä. Paikallinen localhost on sallittu.");
  const value = elements.keyInput.value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    showToast("MAP_KEY ei ole oikeassa muodossa.");
    return;
  }
  state.mapKey = value;
  const remembered = saveMapKey(value, document.querySelector("#remember-key").checked);
  elements.keyInput.value = "";
  elements.keyPanel.hidden = true;
  fetchData({ announce: true });
  if (!remembered) showToast("Selain esti avaimen tallentamisen. Avain toimii tämän sivun avaamisen ajan.");
});

elements.keySettings.addEventListener("click", () => {
  elements.keyPanel.hidden = !elements.keyPanel.hidden;
  document.querySelector("#key-state").textContent = state.mapKey ? (readMapKey() ? "Avain on tallennettu tähän selaimeen. Uusi avain korvaa sen." : "Avain on käytössä vain tässä välilehdessä.") : state.data ? "Omaa avainta ei ole tallennettu. Haut käyttävät palvelimen yhteistä avainta." : "Avainta ei ole tallennettu.";
  document.querySelector("#remember-key").checked = Boolean(readMapKey());
  elements.forgetKey.disabled = !state.mapKey;
  if (!elements.keyPanel.hidden) elements.keyInput.focus();
});
elements.forgetKey.addEventListener("click", () => {
  const removed = removeMapKey(); state.mapKey = ""; elements.keyInput.value = "";
  document.querySelector("#key-state").textContent = removed ? "Avain poistettu." : "Tyhjennä sivuston tiedot selaimesta.";
  fetchData(); showToast(removed ? "API-avain poistettu tämän sivuston selainmuistista." : "Selain esti avaimen poistamisen. Tyhjennä sivuston tallennustiedot selaimen asetuksista.");
});
window.addEventListener("storage", (event) => {
  if (event.key !== MAP_KEY_STORAGE && event.key !== null) return;
  state.mapKey = event.newValue || "";
  fetchData();
});

elements.refresh.addEventListener("click", () => fetchData({ announce: true, force: true }));
elements.reasoningButton.addEventListener("click", openReasoningDialog);
elements.reasoningClose.addEventListener("click", () => elements.reasoningDialog.close());
elements.reasoningCloseFooter.addEventListener("click", () => elements.reasoningDialog.close());
elements.reasoningDialog.addEventListener("close", () => {
  state.reasoningReturnFocus?.focus();
  state.reasoningReturnFocus = null;
});
elements.reasoningDialog.addEventListener("click", (event) => {
  if (event.target !== elements.reasoningDialog) return;
  const bounds = elements.reasoningDialog.getBoundingClientRect();
  const inside = (
    event.clientX >= bounds.left && event.clientX <= bounds.right &&
    event.clientY >= bounds.top && event.clientY <= bounds.bottom
  );
  if (!inside) elements.reasoningDialog.close();
});
elements.mapStyle.addEventListener("change", () => setMapStyle(elements.mapStyle.value));
elements.zoomIn.addEventListener("click", () => changeZoom(1));
elements.zoomOut.addEventListener("click", () => changeZoom(-1));

elements.map.addEventListener("wheel", (event) => {
  if (event.target.closest(".map-style-control, .map-caption, .map-tooltip")) return;
  event.preventDefault();
  changeZoom(event.deltaY < 0 ? 1 : -1);
}, { passive: false });

elements.map.addEventListener("keydown", (event) => {
  if (event.target !== elements.map) return;
  const amount = event.shiftKey ? 180 : 80;
  if (event.key === "+" || event.key === "=") {
    changeZoom(1);
  } else if (event.key === "-") {
    changeZoom(-1);
  } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const center = projectWorld(state.center, state.zoom);
    if (event.key === "ArrowLeft") center.x -= amount;
    if (event.key === "ArrowRight") center.x += amount;
    if (event.key === "ArrowUp") center.y -= amount;
    if (event.key === "ArrowDown") center.y += amount;
    state.center = unprojectWorld(center, state.zoom);
    renderMap();
    scheduleFetch();
  }
});

elements.map.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button, input, select, label, a, details, .map-tooltip")) return;
  const fetchPending = mapFetch.pending;
  mapFetch.cancel();
  elements.map.setPointerCapture(event.pointerId);
  state.drag = {
    fetchPending,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    center: projectWorld(state.center, state.zoom),
    moved: false,
  };
  elements.map.dataset.dragging = "true";
  elements.tooltip.hidden = true;
});

elements.map.addEventListener("pointermove", (event) => {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - state.drag.startX;
  const deltaY = event.clientY - state.drag.startY;
  state.drag.moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 5;
  state.center = unprojectWorld({
    x: state.drag.center.x - deltaX,
    y: state.drag.center.y - deltaY,
  }, state.zoom);
  renderMap();
});

elements.map.addEventListener("pointerup", (event) => {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const moved = state.drag.moved;
  const fetchPending = state.drag.fetchPending;
  state.drag = null;
  elements.map.dataset.dragging = "false";
  if (moved || fetchPending) {
    scheduleFetch();
  } else {
    showNearestEvent(event);
  }
});

elements.map.addEventListener("pointercancel", () => {
  const needsFetch = state.drag?.moved || state.drag?.fetchPending;
  if (needsFetch) scheduleFetch();
  state.drag = null;
  elements.map.dataset.dragging = "false";
});

function openReasoningDialog() {
  if (elements.reasoningDialog.open) return;
  state.reasoningReturnFocus = document.activeElement;
  elements.reasoningDialog.showModal();
  elements.reasoningClose.focus();
}

function setMapStyle(value, { persist = true } = {}) {
  const style = normalizeMapStyle(value);
  state.mapStyle = style;
  elements.map.dataset.mapStyle = style;
  elements.mapStyle.value = style;
  if (persist) { try { sessionStorage.setItem("map-style", style); } catch {} }
}

function storedMapStyle() {
  try { return sessionStorage.getItem("map-style"); } catch { return "dark"; }
}

function normalizeMapStyle(value) {
  return MAP_STYLES.has(value) ? value : "dark";
}

function changeZoom(amount) {
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom + amount));
  if (next === state.zoom) return;
  state.zoom = next;
  elements.tooltip.hidden = true;
  renderMap();
  scheduleFetch();
}

function scheduleFetch() {
  mapFetch.schedule();
  if (state.mapKey) setStatus(`Haku ${MAP_FETCH_DELAY_MS / 1000} s kuluttua`, "idle");
}

function scheduleUtcRollover() {
  clearTimeout(state.rolloverTimer);
  const now = new Date();
  const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  state.rolloverTimer = setTimeout(() => {
    updateDateControls();
    if (state.selection.mode === "live" && !state.drag && !mapFetch.pending) fetchData({ force: true });
    scheduleUtcRollover();
  }, Math.max(1000, nextUtcDay - now.getTime() + 1000));
}

function updateDateControls() {
  const today = new Date().toISOString().slice(0, 10);
  const date = selectionDate(state.selection);
  elements.selectedDate.value = date;
  elements.selectedDate.max = today;
  elements.selectedDate.min = "2012-01-20";
  elements.nextDay.disabled = date >= today;
  elements.previousDay.disabled = date <= "2012-01-20";
  elements.dateMode.textContent = state.selection.mode === "live" ? "Kuluva päivä · päivittyy automaattisesti" : "Valittu päivä pysyy samana";
}

function selectDay(date, live = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today || date < "2012-01-20") {
    showToast("Valitse kelvollinen päivä, enintään tänään (UTC)."); updateDateControls(); return;
  }
  state.selection = { mode: live ? "live" : "history", date };
  elements.eventDialog.close();
  updateDateControls();
  fetchData();
}

async function fetchData({ announce = false, force = false } = {}) {
  if (!state.width || !state.height) return;
  mapFetch.cancel();
  state.abortController?.abort(); state.contextController?.abort(); state.detailController?.abort();
  const version = ++state.requestVersion;
  const abortController = new AbortController();
  state.abortController = abortController;
  state.data = null; state.analysis.events = []; state.contextBusy = false; state.counts = [];
  elements.tooltip.hidden = true; elements.empty.hidden = true; elements.exportCsv.disabled = true;
  elements.eventDialog.close();
  elements.fireList.innerHTML = '<p class="list-placeholder">Haetaan valitun päivän havaintoja ja 13 päivän vertailua…</p>';
  for (const element of [elements.fireCount, elements.todayCount, elements.sourceCount, elements.allCount]) element.textContent = "—";
  elements.dailyBars.replaceChildren(); elements.moreLandcover.hidden = true; elements.landcoverStatus.textContent = "";
  elements.lastUpdated.textContent = "";
  const selectedDate = selectionDate(state.selection);
  elements.rangeTitle.textContent = `${formatDate(selectedDate)}${selectedDate.slice(0, 4)} · UTC`;
  elements.coverageNote.textContent = "Haetaan aineistoa. Edellisen haun tuloksia ei näytetä uuden päivän tuloksina.";
  drawHeatLayer(); setLoading(true); setStatus("Haetaan", "idle");
  // Without an own key the server may still use an optional shared key; otherwise it answers MAP_KEY_REQUIRED.
  if (state.mapKey && !canSendMapKey()) {
    setLoading(false); setStatus("HTTPS tarvitaan", "error"); elements.keyPanel.hidden = false;
    elements.coverageNote.textContent = "Avainta ei lähetetty. Avaa sovellus HTTPS-yhteydellä; localhost on sallittu.";
    return;
  }
  elements.forgetKey.disabled = !state.mapKey;
  try {
    const params = new URLSearchParams(Object.fromEntries(Object.entries(getViewportArea()).map(([key, value]) => [key, value.toFixed(4)])));
    params.set("date", selectedDate);
    if (force) params.set("refresh", String(Date.now()));
    const response = await fetch(`/api/hotspots?${params}`, { headers: state.mapKey ? { "X-FIRMS-MAP-Key": state.mapKey } : {}, signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(130000)]) });
    const payload = await response.json();
    if (version !== state.requestVersion || abortController.signal.aborted) return;
    if (!response.ok) throw Object.assign(new Error(payload.error?.message || "Havaintojen haku epäonnistui."), { code: payload.error?.code });
    state.data = payload;
    state.analysis = findLargeFireEvents(payload.detections, selectedDate, { displayStart: payload.range.start, dataCoverageComplete: payload.coverageComplete !== false });
    state.counts = dailyCounts(payload.detections.filter((p) => ["n", "h"].includes(p.confidence)), payload.analysisRange.start, selectedDate);
    state.dateIndex = new Map(state.counts.map((entry, index) => [entry.date, index]));
    elements.keyPanel.hidden = true;
    renderSummary(); renderMap();
    setStatus(payload.coverageComplete === false ? "Osittainen" : "Haettu", payload.coverageComplete === false ? "idle" : "live");
    if (announce) showToast("Havainnot päivitetty.");
    void enrichContexts(version);
  } catch (error) {
    if (version !== state.requestVersion || abortController.signal.aborted) return;
    if (error.code === "MAP_KEY_REQUIRED") {
      promptForMapKey();
      return;
    }
    if (error.code === "INVALID_MAP_KEY") {
      if (state.mapKey) { state.mapKey = ""; removeMapKey(); }
      elements.keyPanel.hidden = false; elements.forgetKey.disabled = true; elements.keyInput.focus();
      setStatus("Avain puuttuu", "error");
    } else setStatus("Hakuvirhe", "error");
    const message = error.name === "TimeoutError" ? "NASA-haku aikakatkaistiin. Yritä pienempää aluetta tai päivitä uudelleen." : error.message;
    elements.coverageNote.textContent = message; elements.coverageNote.dataset.warning = "true";
    elements.fireList.innerHTML = '<p class="list-placeholder">Tuloksia ei saatu. Päivitä haku virheen korjauduttua.</p>';
    showToast(message);
  } finally {
    if (version === state.requestVersion) { state.abortController = null; setLoading(false); }
  }
}

function promptForMapKey() {
  setStatus("Oma avain tarvitaan", "idle");
  elements.keyPanel.hidden = false; elements.forgetKey.disabled = true;
  document.querySelector("#key-state").textContent = "Palvelimella ei ole yhteistä avainta. Syötä oma NASA FIRMS MAP_KEY.";
  elements.coverageNote.textContent = "Syötä oma NASA FIRMS MAP_KEY.";
  elements.fireList.innerHTML = '<p class="list-placeholder">Haku alkaa, kun olet syöttänyt oman API-avaimesi.</p>';
  elements.keyInput.focus();
}

function currentEvents() { return visibleEvents(state.analysis.events, state); }

async function enrichContexts(version) {
  if (!state.data || state.contextBusy || version !== state.requestVersion) return;
  state.contextBusy = true;
  const controller = new AbortController(); state.contextController = controller;
  const candidates = visibleEvents(state.analysis.events, { filter: "all", includeHistory: true });
  const pending = candidates.filter((event) => event.contextPoints?.length && event.environment?.status !== "ready").sort((a,b) => Number(a.environment?.status === "error") - Number(b.environment?.status === "error")).slice(0, 60);
  updateLandcoverStatus();
  try {
    for (let i = 0; i < pending.length; i += 6) {
      if (version !== state.requestVersion) return;
      const batch = pending.slice(i, i + 6);
      const events = batch.map((event) => {
        const all = event.contextPoints;
        const points = all.length <= 48 ? all : Array.from({length:48},(_,j) => all[Math.floor(j * all.length / 48)]);
        return { id:event.id, points, totalPoints:all.length };
      });
      const response = await fetch("/api/landcover", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ events }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(190000)]) });
      if (!response.ok) throw new Error("Maanpeitehaku ei onnistunut.");
      const data = await response.json();
      if (version !== state.requestVersion || controller.signal.aborted) return;
      for (const item of data.results) { const event = batch.find((e) => e.id === item.id); if (event) event.environment = item.environment; }
      renderSummary(); drawHeatLayer(); updateLandcoverStatus();
      if (!elements.tooltip.hidden) {
        const shown = currentEvents().find((e) => e.id === state.tooltipEventId);
        if (shown) showTooltipFor(shown); else elements.tooltip.hidden = true;
      }
      if (state.currentEventId) renderOpenEvent();
      if (data.results.every((item) => item.environment.status === "error")) break;
    }
  } catch (error) {
    if (version !== state.requestVersion || controller.signal.aborted) return;
    for (const event of pending) if (!event.environment) event.environment = { id: "unknown", status: "error", label: "Maanpeitehaku epäonnistui" };
    renderSummary(); drawHeatLayer();
  } finally {
    if (version === state.requestVersion) { state.contextBusy = false; updateLandcoverStatus(); }
  }
}

function updateLandcoverStatus() {
  const events = state.analysis.events;
  const ready = events.filter((event) => event.environment?.status === "ready").length;
  const errors = events.filter((event) => event.environment?.status === "error").length;
  elements.landcoverStatus.textContent = events.length ? `${state.contextBusy ? "Arvioidaan ympäristöjä" : "Ympäristöarvio"}: ${ready}/${events.length} · WorldCover 2021.${errors ? ` ${errors} hakua epäonnistui; nämä säilyvät tuntemattomina.` : ""}` : "";
  elements.moreLandcover.hidden = ready === events.length || state.contextBusy;
  elements.moreLandcover.textContent = errors ? "Arvioi puuttuvat / yritä uudelleen" : "Arvioi lisää ympäristöjä";
}

function renderSummary() {
  if (!state.data) return;
  const { data, analysis, counts } = state;
  const events = currentEvents();
  const selectedDate = data.range.end;
  elements.rangeTitle.textContent = `${formatDate(selectedDate)}${selectedDate.slice(0,4)} · UTC`;
  elements.fireCount.textContent = events.length;
  elements.todayCount.textContent = analysis.events.filter((e) => ["source-fire", "source-anomaly"].includes(e.kind)).length;
  elements.sourceCount.textContent = analysis.persistentSources.length;
  elements.allCount.textContent = counts.find((e) => e.date === selectedDate)?.count ?? 0;
  const currentDay = selectedDate === new Date().toISOString().slice(0,10);
  const warning = data.coverageComplete === false;
  elements.coverageNote.dataset.warning = String(warning);
  elements.coverageNote.textContent = `${currentDay ? "Kuluva UTC-päivä on kesken. " : "Historiallinen UTC-päivä. "}Vertailu ${formatDate(data.analysisRange.start)}–${formatDate(shiftDay(selectedDate,-1))}. ${warning ? "Osa aineistosta puuttuu; normaalitasoa ei vahvisteta." : "Datapyynnöt onnistuivat. Pilvien ja ylitysten kattavuutta ei tunneta."}${data.warnings?.length ? "\n" + data.warnings.join("\n") : ""}`;
  elements.lastUpdated.textContent = `Haettu ${formatDate(data.generatedAt.slice(0,10))} ${timeFormatter.format(new Date(data.generatedAt))} UTC · versio 2026.10.13.1`;
  const maximum = Math.max(...counts.map((e) => e.count), 1);
  elements.dailyBars.replaceChildren(...counts.map((entry) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "day-bar"; button.dataset.selected = String(entry.date === selectedDate);
    button.title = `${formatDate(entry.date)}: ${entry.count} VIIRS-havaintoa. Valitse päivä.`;
    button.setAttribute("aria-label",button.title);
    const track = document.createElement("span"); track.className = "day-bar-track";
    const fill = document.createElement("span"); fill.className = "day-bar-fill"; fill.style.height = `${entry.count / maximum * 100}%`; track.append(fill);
    const label = document.createElement("small"); label.textContent = entry.date.slice(8); button.append(track,label);
    button.addEventListener("click",()=>selectDay(entry.date)); return button;
  }));
  const total = visibleEvents(analysis.events, {filter:"all",includeHistory:state.includeHistory}).length;
  elements.filterNote.textContent = `Näkyvissä ${events.length}/${total}. ${state.filter === "attention" ? "Normaalit pysyvät lähteet ja usealla ylilennolla havaitut kasvillisuustapahtumat on piilotettu. Yksittäiset ja epäselvät havainnot säilyvät mukana." : "Maanpeite kuvaa ympäristöä, ei palavaa materiaalia."}${state.minFrp ? ` Tehoraja ${state.minFrp} MW poistaa myös kohteet, joilta FRP puuttuu.` : ""}`;
  elements.exportCsv.disabled = events.length === 0;
  const shown = events.slice(0, 150);
  elements.fireList.replaceChildren(...shown.map((event, index) => {
    const card = document.createElement("article"); card.className = "event-card";
    card.style.setProperty("--event-color",`rgb(${eventRingStyle(event).color})`);
    const priority = priorityFor(event), env = environmentalContext(event), evidence = observationEvidence(event);
    const frp = state.includeHistory && !event.activeToday ? event.displayPeakPassFrp : event.currentPeakPassFrp;
    card.innerHTML = `<h3>${index + 1}. ${escapeHtml(priority.label)}</h3><p>${event.latitude.toFixed(4)}, ${event.longitude.toFixed(4)}</p><p>${escapeHtml(env.label)}</p><p class="event-stats"><strong>${formatScore(frp)}</strong> MW · ${event.currentPassCount} ylilentoa D0</p><p class="meta">${event.activeToday ? "Lämpöhavainto " + formatDate(selectedDate) : "Ei lämpöhavaintoa " + formatDate(selectedDate)} · ${evidence.repeated ? "useita ylilentoja" : "rajallinen havaintotuki"}</p><p class="meta">${evidence.latest ? "Viimeisin " + formatDate(evidence.date) + " " + evidence.latest.slice(11) + " UTC" : "Havaintoaika puuttuu"}${Number.isFinite(evidence.ratio) ? " · FRP enintään " + formatScore(evidence.ratio) + "× vertailumediaani" : ""}</p><div class="event-actions"><button type="button" data-action="details">Tiedot ja FRP</button><button type="button" data-action="map">Kartalle</button></div>`;
    card.querySelector('[data-action="details"]').addEventListener("click",()=>openEvent(event));
    card.querySelector('[data-action="map"]').addEventListener("click",()=>focusEvent(event));
    return card;
  }));
  if (!events.length) elements.fireList.innerHTML = '<p class="list-placeholder">Ei kohteita valitulla suodattimella. Kokeile “Kaikki lämpötapahtumat” tai näytä edelliset kuusi päivää. Tämä ei tarkoita, ettei alueella pala.</p>';
  if (events.length > shown.length) { const note = document.createElement("p"); note.className="meta"; note.textContent=`Listalla ensimmäiset ${shown.length}; kaikki ${events.length} näkyvät kartalla ja CSV-viennissä. Rajaa karttaa tai suodatinta.`; elements.fireList.append(note); }
  elements.empty.hidden = events.length > 0;
}

function formatScore(value) { return Number.isFinite(value) ? numberFormatter.format(value) : "—"; }
function eventTitle(event) { return priorityFor(event).label; }
function eventStatus(event) { return priorityFor(event).reason; }

function openEvent(event) {
  mapFetch.cancel();
  state.detailController?.abort();
  state.detail = { status: "loading", radiusKm: Math.min(20, Math.max(2, Math.ceil((event.extentKm || 0) + 1))), days: 28 };
  state.currentEventId = event.id;
  renderOpenEvent();
  if (!elements.eventDialog.open) elements.eventDialog.showModal();
  elements.eventDialogClose.focus();
  void fetchEventDetail(event);
}

function renderOpenEvent() {
  const event = state.analysis.events.find((e) => e.id === state.currentEventId);
  if (!event || !state.data) return;
  elements.eventDialogTitle.textContent = eventTitle(event);
  const env = environmentalContext(event), selectedDate = state.data.range.end, evidence = observationEvidence(event);
  const comparisons = new Map((event.comparisons || []).map((entry) => [entry.pass.id,entry]));
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)} %` : "—";
  const envDetails = env.status === "ready" ? `Havaintopikselin sisäosa: rakennettua ${percent(env.pixelBuiltFraction)}, kasvillisuutta ${percent(env.pixelVegetationFraction)}. Paikannuspuskuri: rakennettua ${percent(env.builtFraction)}, kasvillisuutta ${percent(env.vegetationFraction)}. Tunnettuja näytteitä ${env.known}/${env.sampleCount}. Näytteistetyt lämpösolut ${env.sampledPoints}/${env.totalPoints}.` : "Puuttuva ympäristötieto säilyy tuntemattomana; se ei vähennä paloepäilyn näkyvyyttä.";
  const rows = event.overpasses.map((pass) => {
    const entry = comparisons.get(pass.id);
    const method = entry?.method === "mad" ? "MAD" : entry?.method === "ratio" ? "Suhde" : entry ? "Ei riitä" : "Vertailu / historia";
    return `<tr data-selected="${pass.date===selectedDate}" data-anomaly="${Boolean(entry?.isAnomalous)}"><td>${formatDate(pass.date)} ${escapeHtml(pass.time)}</td><td>${escapeHtml(pass.satellite)} / ${escapeHtml(pass.daynight)}</td><td class="number">${formatScore(pass.totalFrp)}</td><td class="number">${formatScore(pass.maxFrp)}</td><td>${pass.pixelCount}</td><td>${formatScore(pass.radius95Km)}</td><td>${event.kind === "fire" ? "—" : pass.outsideCorePixels}</td><td>${entry ? `${entry.baselinePassCount} / ${entry.baselineDays} vrk` : "—"}</td><td>${entry ? formatScore(entry.metrics.totalFrp.median) : "—"}</td><td>${entry ? formatScore(entry.metrics.totalFrp.ratio) : "—"}</td><td>${method}</td></tr>`;
  }).join("");
  const detailedComparisons = (event.comparisons || []).filter((entry)=>entry.pass.date===selectedDate).map((entry)=>`<tr><td>${escapeHtml(entry.pass.satellite)} ${escapeHtml(entry.pass.time)} / ${escapeHtml(entry.pass.daynight)}</td><td>${entry.fullyComparable ? "Kyllä" : "Ei"}</td><td>${formatScore(entry.intensityScore)}</td><td>${formatScore(entry.extentScore)}</td><td>${formatScore(entry.metrics.pixelCount.median)}</td><td>${formatScore(entry.metrics.radius95.median)}</td><td>${entry.isAnomalous ? "Poikkeama" : entry.fullyComparable ? "Rajoissa" : "Riittämätön vertailu"}</td></tr>`).join("");
  elements.eventDialogContent.innerHTML = `
    <section id="deep-analysis" class="deep-analysis"></section>
    <p class="details-meta">${event.latitude.toFixed(5)}, ${event.longitude.toFixed(5)} · D0 ${formatDate(selectedDate)}${selectedDate.slice(0,4)} · UTC</p>
    <section class="detail-box evidence-summary"><h3>Mitä kohteesta voidaan päätellä?</h3><p><strong>${escapeHtml(priorityFor(event).label)}</strong></p><p>${escapeHtml(priorityFor(event).reason)}</p><p>${evidence.date ? formatDate(evidence.date) : "—"}: ${evidence.passCount} ajoitettua ylilentoa, ${evidence.satellites} satelliittia. ${evidence.repeated ? "Useat havainnot tukevat lämpötapahtuman olemassaoloa; ne eivät varmista palavaa materiaalia." : "Yksittäistä tai puutteellisesti ajoitettua havaintoa ei pidetä vahvana tyyppinäyttönä."}</p><p>Viimeisin ajoitettu havainto: ${evidence.latest ? formatDate(evidence.date) + " " + evidence.latest.slice(11) + " UTC" : "—"}. FRP suhteessa oman vertailuryhmän mediaaniin: ${Number.isFinite(evidence.ratio) ? formatScore(evidence.ratio) + "× (päivän suurin suhde)" : "ei riittävää vertailua"}.</p><p class="meta">Rakennuspaloa, jalostamoa tai räjähdevarastoa ei nimetä ilman niitä erottavaa havaintonäyttöä.</p></section>
    <div class="detail-grid"><section class="detail-box"><h3>Lämpötilanne</h3><p>${escapeHtml(priorityFor(event).reason)}</p><p>Havaintopäivät: ${event.activeDates.map(formatDate).join(", ") || "—"}.</p><p>${event.kind === "fire" ? `${event.currentPassCount} ylilentoa D0:lla. Pieni pistemäärä ei sulje pois paloa.` : `Pysyvyys ${event.persistenceActiveDayCount}/13 vertailupäivää. ${event.comparableCurrentPasses}/${event.currentPassCount} täysin vertailukelpoista ylilentoa D0:lla.`}</p><p>Näyttö: ${escapeHtml(event.reliability.label)}. ${escapeHtml((event.reliability.reasons||[]).join("; "))}</p>${event.changePoint ? `<p>Muutoskohta ${formatDate(event.changePoint.date)}: ${escapeHtml(event.changePoint.group)} · FRP ${formatScore(event.changePoint.frpRatio)}×. Vertailu päättyy ${formatDate(event.baselinePeriod.end)}. Historiallinen muutos ei yksin vahvista nykyistä paloa.</p>` : ""}</section><section class="detail-box"><h3>${escapeHtml(env.label)}</h3><p>${escapeHtml(envDetails)}</p><p>ESA WorldCover 2021: näytteet kuvaavat ympäristöä, eivät palavaa rakennusta tai materiaalia. Vuoden 2021 jälkeen muuttunut maanpeite voi johtaa virheeseen.</p><p>${escapeHtml(event.behavior?.label || "")}. ${escapeHtml(event.behavior?.candidate || "")}</p></section></div>
    <h3>FRP 14 vuorokaudelta</h3><p>Jokainen pylväs on päivän voimakkain ylilento, MW. Taulukossa ovat kaikki ylilennot erikseen. Puuttuva arvo ei ole 0 MW. Pylvään valinta vaihtaa tarkastelupäivän.</p>${renderFrpProfile(event,selectedDate)}
    <h3>Ylilentojen havainnot ja paikallinen vertailu</h3><p class="details-meta">Mediaani ja suhde koskevat saman satelliitin ja päivä/yö-luokan FRP-summaa. Pisteet ulkona = 750 m:n puskurilla laajennetun normaalijalanjäljen ulkopuolella. Pikselimäärä ja r95 eivät ole palanut pinta-ala.</p><div class="table-scroll"><table><thead><tr><th>Aika UTC</th><th>Satelliitti / D–N</th><th>FRP MW</th><th>Max MW</th><th>Pikselit</th><th>r95 km</th><th>Ulkona</th><th>Vertailun ylilennot</th><th>Mediaani MW</th><th>FRP-suhde</th><th>Menetelmä</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${detailedComparisons ? `<h3>D0-poikkeamat ryhmittäin</h3><p class="details-meta">MAD-menetelmässä piste on robusti Z-arvo; suhdevertailussa se on suhde mediaaniin. Menetelmiä ei verrata suoraan keskenään.</p><div class="table-scroll"><table><thead><tr><th>Ylilento</th><th>Täysi vertailu</th><th>Intensiteetti</th><th>Laajuus</th><th>Pikselimediaani</th><th>r95-mediaani km</th><th>Tulkinta</th></tr></thead><tbody>${detailedComparisons}</tbody></table></div>` : ""}
    <details><summary>Geometrian perustelut ja rajat</summary><ul>${[...(event.behavior?.supports||[]),...(event.behavior?.cautions||[])].map((text)=>`<li>${escapeHtml(text)}</li>`).join("")}</ul></details>
    ${env.counts ? `<h3>Maanpeitenäytteiden jakauma</h3><div class="table-scroll"><table><thead><tr><th>Luokka</th><th>Näytteitä</th></tr></thead><tbody>${Object.entries(env.counts).map(([code,n])=>`<tr><td>${escapeHtml(LANDCOVER_CLASSES[code] || code)}</td><td>${n}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <p class="details-meta">© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. CC BY 4.0. Tapahtuman käyttöpaikkaa ei haeta kohdeluettelosta.</p>`;
  renderDetailSection(event);
  for (const button of elements.eventDialogContent.querySelectorAll("[data-select-date]")) button.addEventListener("click",()=>selectDay(button.dataset.selectDate));
  for (const bar of elements.eventDialogContent.querySelectorAll("[data-frp-height]")) bar.style.height = `${bar.dataset.frpHeight}%`;
}


async function fetchEventDetail(event, force = false) {
  state.detailController?.abort();
  const controller = new AbortController();
  state.detailController = controller;
  const detail = state.detail;
  if (!detail || !state.data) return;
  detail.status = "loading"; detail.analysis = null;
  renderDetailSection(event);
  const params = new URLSearchParams({...detailBounds(event, detail.radiusKm), date:state.data.range.end, days:detail.days});
  if (force) params.set("refresh", "1");
  try {
    const response = await fetch(`/api/event-data?${params}`, {headers:state.mapKey ? {"X-FIRMS-MAP-Key":state.mapKey} : {}, signal:AbortSignal.any([controller.signal,AbortSignal.timeout(150000)])});
    const payload = await response.json();
    if (controller.signal.aborted || state.detail !== detail || state.currentEventId !== event.id) return;
    if (!response.ok) throw new Error(payload.error?.message || "Kohdehaku epäonnistui.");
    detail.analysis = buildDetailAnalysis(payload,event,detail.radiusKm);
    detail.status = "ready";
  } catch (error) {
    if (controller.signal.aborted || state.detail !== detail) return;
    detail.status = "error"; detail.error = error.name === "TimeoutError" ? "Kohdehaku aikakatkaistiin. Yritä 14 päivän jaksoa tai päivitä uudelleen." : error.message;
  }
  if (state.detail === detail && state.currentEventId === event.id) renderDetailSection(event);
}

function renderDetailSection(event) {
  const root = document.querySelector("#deep-analysis"), detail = state.detail;
  if (!root || !detail) return;
  root.innerHTML = `<div class="detail-controls"><label>Jakso <select id="detail-days"><option value="14"${detail.days===14 ? " selected" : ""}>14 vrk</option><option value="28"${detail.days===28 ? " selected" : ""}>28 vrk</option></select></label><label>Hakualueen säde (km) <input id="detail-radius" type="number" min="1" max="20" step="0.5" value="${detail.radiusKm}"></label><button id="detail-refresh" type="button">Hae kohde uudelleen</button><span role="status">${detail.status === "loading" ? "Haetaan kohteen tarkkaa VIIRS- ja MODIS-aineistoa…" : detail.status === "error" ? escapeHtml(detail.error) : "Kohdeaineisto haettu"}</span></div>${detail.analysis ? renderEvolution(detail.analysis) : '<p>Alla karttahaun aiemmat 14 vuorokauden tiedot. Tarkempi analyysi täydentyy oman haun valmistuttua.</p>'}`;
  root.querySelector("#detail-refresh").addEventListener("click", () => {
    const radius = Number(root.querySelector("#detail-radius").value);
    if (!Number.isFinite(radius) || radius < 1 || radius > 20) return showToast("Valitse säde väliltä 1–20 km.");
    detail.radiusKm = radius; detail.days = Number(root.querySelector("#detail-days").value);
    void fetchEventDetail(event,true);
  });
  if (!detail.analysis) return;
  const a = detail.analysis, select = root.querySelector("#detail-pass");
  const spatial = () => {root.querySelector("#detail-spatial").innerHTML=renderSpatial(a,event,Number(select.value));};
  select.addEventListener("change",spatial); spatial();
  root.querySelector("#detail-export").addEventListener("click", () => {
    const url=URL.createObjectURL(new Blob([exportEvolutionCsv(a)],{type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a"); link.href=url; link.download=`kohde-${event.latitude.toFixed(4)}-${event.longitude.toFixed(4)}-${a.range.end}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  });
}

function renderFrpProfile(event, today) {
  const profile = event.frpProfile || [], maximum = Math.max(...profile.map((entry)=>entry.peakPassFrp || 0),1);
  return `<div class="frp-profile-grid">${profile.map((entry)=>`<button type="button" class="frp-profile-day" data-select-date="${entry.date}" data-selected="${entry.date===today}" data-alert="${event.anomalyDates.includes(entry.date)}" title="${formatDate(entry.date)}: ${formatScore(entry.peakPassFrp)} MW, ${entry.passCount} ylilentoa. Valitse päivä."><span class="frp-value">${formatScore(entry.peakPassFrp)}</span><span class="frp-profile-track"><span class="frp-profile-bar" data-frp-height="${(entry.peakPassFrp || 0)/maximum*100}"></span></span><small>${formatDate(entry.date)}</small></button>`).join("")}</div>`;
}

function focusEvent(event) {
  state.center = { longitude: event.longitude, latitude: event.latitude };
  state.zoom = Math.max(state.zoom, 10);
  renderMap();
  showTooltipFor(event);

}

function renderMap() {
  if (!state.width || !state.height) return;
  renderTiles();
  drawHeatLayer();
}

function renderTiles() {
  updateTiles({ center: projectWorld(state.center, state.zoom), zoom: state.zoom, width: state.width, height: state.height });
}

function drawHeatLayer() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(state.width * ratio);
  const pixelHeight = Math.round(state.height * ratio);
  if (elements.canvas.width !== pixelWidth || elements.canvas.height !== pixelHeight) {
    elements.canvas.width = pixelWidth;
    elements.canvas.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, state.width, state.height);

  if (!state.data) return;
  context.globalCompositeOperation = "lighter";
  for (const detection of state.data.detections) {
    if (!state.showPoints || !state.dateIndex.has(detection.date) || !["n", "h"].includes(detection.confidence)) continue;
    if (!state.includeHistory && detection.date !== state.data.range.end) continue;
    if (state.includeHistory && detection.date < state.data.range.start) continue;
    const point = screenPoint(detection);
    if (!isOnScreen(point, 12)) continue;
    const day = state.dateIndex.get(detection.date) ?? 0;
    const isToday = detection.date === state.data.range.end;
    const radius = isToday ? 3.4 : 2.4;
    context.beginPath();
    context.fillStyle = withAlpha(DAY_COLORS[day] || DAY_COLORS[0], isToday ? 0.88 : 0.42);
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.globalCompositeOperation = "source-over";
  for (const event of currentEvents()) {
    const point = screenPoint(event);
    if (!isOnScreen(point, 50)) continue;
    const radius = Math.max(13, Math.min(42, eventRadiusPixels(event)));
    const ring = eventRingStyle(event);
    context.beginPath();
    context.strokeStyle = `rgba(${ring.color}, 0.98)`;
    context.lineWidth = ring.lineWidth;
    context.setLineDash(ring.dash);
    context.shadowColor = `rgba(${ring.color}, 0.65)`;
    context.shadowBlur = 11;
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.stroke();
    context.shadowBlur = 0;
    context.setLineDash([]);
    context.beginPath();
    context.fillStyle = "rgba(255, 255, 255, 0.96)";
    context.arc(point.x, point.y, 1.6, 0, Math.PI * 2);
    context.fill();
  }
}

function eventRingStyle(event) {
  const colors = { "source-fire":"255, 78, 81", "source-anomaly":"255, 159, 67", "persistent-source":"189, 145, 255", "source-unknown":"182, 192, 203" };
  const environmentColors = { built:"109, 184, 255", mixed:"255, 209, 102", vegetation:"118, 247, 210", unknown:"182, 192, 203", other:"255, 209, 102" };
  return { color:colors[event.kind] || environmentColors[environmentalContext(event).id] || environmentColors.unknown, dash:event.activeToday ? [] : [5,4], lineWidth:event.kind === "source-fire" ? 3.4 : 2.8 };
}

function eventRadiusPixels(event) {
  const latitudeRadians = event.latitude * Math.PI / 180;
  const metersPerPixel = 156543.03392 * Math.cos(latitudeRadians) / 2 ** state.zoom;
  return event.radiusMeters / Math.max(metersPerPixel, 0.1);
}

function showNearestEvent(event) {
  const bounds = elements.map.getBoundingClientRect();
  const click = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  let closest = null;
  let distance = Infinity;
  for (const candidate of currentEvents()) {
    const point = screenPoint(candidate);
    const candidateDistance = Math.hypot(click.x - point.x, click.y - point.y);
    if (candidateDistance < distance && candidateDistance <= Math.max(20, Math.min(42, eventRadiusPixels(candidate)) + 7)) {
      closest = candidate;
      distance = candidateDistance;
    }
  }
  if (closest) openEvent(closest);
}

function showTooltipFor(event) {
  state.tooltipEventId = event.id;
  const point = screenPoint(event);
  const peak = periodFrpPeak(event.frpProfile, state.data.analysisRange.start, state.data.analysisRange.end);
  const periodPeak = peak ? `${formatScore(peak.frp)} MW (${formatDate(peak.date)})` : "— MW (ei laskettavaa arvoa)";
  elements.tooltip.innerHTML = `<strong>${escapeHtml(eventTitle(event))}</strong>${event.latitude.toFixed(4)}, ${event.longitude.toFixed(4)}<br />${escapeHtml(environmentalContext(event).label)}<br />D0 FRP-huippu ${formatScore(event.currentPeakPassFrp)} MW<br /><span class="period-frp-peak">14 vrk FRP-huippu ${periodPeak}</span><br />Havaintopäivät: ${event.activeDates.map(formatDate).join(", ")}<br /><button type="button">Avaa tiedot ja FRP</button>`;
  elements.tooltip.querySelector("button").addEventListener("click",()=>openEvent(event));
  elements.tooltip.hidden = false;
  const width = elements.tooltip.offsetWidth, height = elements.tooltip.offsetHeight;
  elements.tooltip.style.left = `${Math.max(8,Math.min(state.width-width-8,point.x+16))}px`;
  elements.tooltip.style.top = `${Math.max(8,Math.min(state.height-height-8,point.y-18))}px`;
}

function getViewportArea() {
  const center = projectWorld(state.center, state.zoom);
  const padding = 0.08;
  const leftTop = unprojectWorld({
    x: center.x - state.width * (0.5 + padding),
    y: center.y - state.height * (0.5 + padding),
  }, state.zoom);
  const rightBottom = unprojectWorld({
    x: center.x + state.width * (0.5 + padding),
    y: center.y + state.height * (0.5 + padding),
  }, state.zoom);
  return {
    west: Math.max(-180, leftTop.longitude),
    south: Math.max(-85, rightBottom.latitude),
    east: Math.min(180, rightBottom.longitude),
    north: Math.min(85, leftTop.latitude),
  };
}

function projectWorld(point, zoom) {
  const world = TILE_SIZE * 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude));
  const radians = latitude * Math.PI / 180;
  return {
    x: (point.longitude + 180) / 360 * world,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * world,
  };
}

function unprojectWorld(point, zoom) {
  const world = TILE_SIZE * 2 ** zoom;
  const longitude = point.x / world * 360 - 180;
  const n = Math.PI - 2 * Math.PI * point.y / world;
  const latitude = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return {
    longitude: wrapLongitude(longitude),
    latitude: Math.max(-85.05112878, Math.min(85.05112878, latitude)),
  };
}

function screenPoint(point) {
  const center = projectWorld(state.center, state.zoom);
  const projected = projectWorld({ longitude: point.longitude, latitude: point.latitude }, state.zoom);
  let deltaX = projected.x - center.x;
  const world = TILE_SIZE * 2 ** state.zoom;
  if (deltaX > world / 2) deltaX -= world;
  if (deltaX < -world / 2) deltaX += world;
  return {
    x: state.width / 2 + deltaX,
    y: state.height / 2 + projected.y - center.y,
  };
}

function isOnScreen(point, margin = 0) {
  return point.x >= -margin && point.x <= state.width + margin && point.y >= -margin && point.y <= state.height + margin;
}

function wrapLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function withAlpha(hex, alpha) {
  const number = Number.parseInt(hex.slice(1), 16);
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function setLoading(loading) {
  elements.loading.hidden = !loading;
  elements.refresh.disabled = loading;
}

function setStatus(label, status) {
  elements.status.textContent = label;
  elements.status.dataset.state = status;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 4400);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

scheduleUtcRollover();
setInterval(() => {
  if ((state.data || state.mapKey) && !state.drag && !mapFetch.pending) {
    fetchData({ force: true });
  }
}, 15 * 60 * 1000);
