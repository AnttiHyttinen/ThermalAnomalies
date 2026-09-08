// Land cover describes the surroundings. It never determines a fire's fuel or a site's purpose.
export const LANDCOVER_CLASSES = {
  10: "Puut", 20: "Pensaat", 30: "Ruohikko", 40: "Viljelysmaa", 50: "Rakennettu",
  60: "Paljas maa", 70: "Lumi / jää", 80: "Vesi", 90: "Kosteikko", 95: "Mangrove", 100: "Sammal / jäkälä",
};
const VEGETATION = new Set([10, 20, 30, 40, 90, 95, 100]);

export function summarizeLandcover(values, { totalPoints = values.length, sampledPoints = values.length, pixelValues = values } = {}) {
  const count = (items) => {
    const counts = {};
    for (const value of items) if (LANDCOVER_CLASSES[value]) counts[value] = (counts[value] || 0) + 1;
    const known = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const fraction = (codes) => codes.reduce((sum, code) => sum + (counts[code] || 0), 0) / Math.max(1, known);
    return { counts, known, coverage: known / Math.max(1, items.length), built: fraction([50]), vegetation: fraction([...VEGETATION]) };
  };
  const outer = count(values), pixel = count(pixelValues);
  const representative = totalPoints > 0 && sampledPoints === totalPoints;
  let id = "unknown";
  if (outer.coverage >= 0.8 && pixel.coverage >= 0.8 && outer.known >= 9 && pixel.known >= 9) {
    if (pixel.built >= 0.2) id = "built";
    else if (outer.built > 0 || pixel.built > 0) id = "mixed";
    else if (outer.vegetation >= 0.85 && pixel.vegetation >= 0.85 && representative) id = "vegetation";
    else if (representative) id = "other";
  }
  const dominant = Object.entries(pixel.counts).sort((a, b) => b[1] - a[1])[0];
  const dominantCode = dominant && dominant[1] / Math.max(1, pixel.known) >= 0.6 ? Number(dominant[0]) : null;
  const labels = { built: "Rakennettua havaintopikselin alueella", mixed: "Rakennetun ja muun maanpeitteen rajalla", vegetation: "Kasvillisuusvaltainen ympäristö", other: "Muu maanpeite / sekaympäristö", unknown: "Ympäristöstä ei riittävää tietoa" };
  return { id, label: labels[id], counts: outer.counts, coverage: outer.coverage, builtFraction: outer.built, vegetationFraction: outer.vegetation, known: outer.known, sampleCount: values.length, pixelCounts: pixel.counts, pixelKnown: pixel.known, pixelSampleCount: pixelValues.length, pixelBuiltFraction: pixel.built, pixelVegetationFraction: pixel.vegetation, dominantCode, sampledPoints, totalPoints, representative, source: "ESA WorldCover 2021 v200", year: 2021, status: "ready" };
}

// Evidence is tied to the sampled observation day, never inflated by older passes.
export function observationEvidence(event) {
  const passes = event.overpasses || [];
  const date = event.contextPoints?.[0]?.date || passes.map((p) => p.date).sort().at(-1) || null;
  const onDay = passes.filter((p) => p.date === date && /^\d{2}:\d{2}$/.test(p.time || "") && p.satellite && ["D", "N"].includes(p.daynight));
  const passCount = new Set(onDay.map((p) => `${p.satellite}/${p.daynight}/${p.time}`)).size;
  const satellites = new Set(onDay.map((p) => p.satellite)).size;
  const latest = onDay.map((p) => `${p.date}T${p.time}`).sort().at(-1) || null;
  const ratios = (event.comparisons || []).filter((e) => e.pass.date === date && e.fullyComparable).map((e) => e.metrics?.totalFrp?.ratio).filter(Number.isFinite);
  return { date, passCount, satellites, latest, repeated: passCount >= 2, ratio: ratios.length ? Math.max(...ratios) : null };
}

export function likelyVegetation(event) {
  return event.kind === "fire" && environmentalContext(event).id === "vegetation" && observationEvidence(event).repeated && event.behavior?.id !== "recurrent-uncertain";
}

export function environmentalContext(event) {
  return event.environment || { id: "unknown", label: "Ympäristöä ei ole vielä arvioitu", status: "pending" };
}

export function priorityFor(event) {
  const environment = environmentalContext(event);
  if (event.kind === "source-fire") return { rank: 0, label: "Leviävä paloepäily", reason: "Pysyvän lähteen poikkeava lämpö ulottuu normaalialueen ulkopuolelle usealla ylilennolla." };
  if (event.kind === "source-anomaly") return { rank: 1, label: "Pysyvän lähteen poikkeama", reason: "Lämpö tai jalanjälki poikkeaa. Syy voi olla prosessimuutos tai palo." };
  if (event.kind === "persistent-source") return { rank: 6, label: "Havaittu taso normaali", reason: "Valitun päivän vertailukelpoiset ylilennot pysyvät rajoissa. Tämä ei sulje pois samassa pikselissä olevaa paloa." };
  if (event.kind === "source-unknown") return { rank: 4, label: "Pysyvän lähteen tila avoin", reason: event.currentPassCount ? "Havainto on olemassa, mutta riittävää vertailua ei ole." : "Valitulta päivältä ei ole kohteen lämpöhavaintoa." };
  if (environment.id === "built") return { rank: 2, label: "Lämpötapahtuma rakennetulla alueella", reason: "Vähintään 20 % havaintopikselin sisäosan maanpeitenäytteistä on rakennettuja. Tämä paikantaa ympäristön, mutta ei vahvista rakennuspaloa tai teollisuutta." };
  if (environment.id === "mixed") return { rank: 3, label: "Lämpötapahtuma rakennetun lähellä", reason: "Rakennettua maanpeitettä löytyi, mutta yhteys palavaan kohteeseen jää epäselväksi. Myös lähistön maastopalo on mahdollinen." };
  if (event.behavior?.id === "recurrent-uncertain") return { rank: 3, label: "Toistuva lämpökohde · syy avoin", reason: "Paikallaan toistuva lämpö voi olla ajoittaista prosessia, avopolttoa tai pitkäkestoinen palo. Ympäristö ei ratkaise syytä." };
  if (environment.id === "vegetation") {
    const labels = { 10: "Puustoinen ympäristö", 20: "Pensasympäristö", 30: "Ruohikkoympäristö", 40: "Viljelysmaa", 90: "Kosteikkoympäristö" };
    const repeated = observationEvidence(event).repeated;
    return { rank: repeated ? 5 : 3, label: `${labels[environment.dominantCode] || "Kasvillisuusympäristö"} · ${repeated ? "lämpötapahtuma" : "yksittäinen havainto"}`, reason: "Sekä pikselin että puskurin näytteistä vähintään 85 % on kasvillisuutta eikä rakennettua löytynyt. Viljelysmaan tuli voi olla avopolttoa; yksittäinen havainto jää oletusnäkymään tarkistettavaksi." };
  }
  return { rank: 3, label: "Paikallinen lämpötapahtuma", reason: "Maastopaloa tai muuta paloa ei voi vielä erottaa. Kohde säilyy tarkistettavissa." };
}

export function visibleEvents(events, { filter = "attention", includeHistory = false, minFrp = 0, sort = "priority", repeatedOnly = false } = {}) {
  return events.filter((event) => {
    if (!includeHistory && !event.activeToday && event.kind !== "source-unknown") return false;
    if (repeatedOnly && !observationEvidence(event).repeated) return false;
    const frp = includeHistory ? event.displayPeakPassFrp : event.currentPeakPassFrp;
    if (minFrp > 0 && (!Number.isFinite(frp) || frp < minFrp)) return false;
    const env = environmentalContext(event).id;
    if (filter === "attention") return event.kind !== "persistent-source" && !likelyVegetation(event);
    if (filter === "built") return ["built", "mixed"].includes(env);
    if (filter === "sources") return event.kind !== "fire";
    if (filter === "anomalies") return ["source-fire", "source-anomaly"].includes(event.kind);
    if (filter === "vegetation") return event.kind === "fire" && env === "vegetation";
    if (filter === "unknown") return env === "unknown" || event.kind === "source-unknown";
    return true;
  }).sort((a, b) => {
    const frp = (e) => (includeHistory ? e.displayPeakPassFrp : e.currentPeakPassFrp) ?? -1;
    if (sort === "frp" && frp(a) !== frp(b)) return frp(b) - frp(a);
    if (sort === "latest") { const difference = (observationEvidence(b).latest || "").localeCompare(observationEvidence(a).latest || ""); if (difference) return difference; }
    if (sort === "ratio") { const difference = (observationEvidence(b).ratio ?? -1) - (observationEvidence(a).ratio ?? -1); if (difference) return difference; }
    return priorityFor(a).rank - priorityFor(b).rank || Number(b.activeToday) - Number(a.activeToday) || frp(b) - frp(a);
  });
}

export function shiftDay(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function selectionDate(selection, now = new Date()) {
  return selection.mode === "live" ? now.toISOString().slice(0, 10) : selection.date;
}

export function exportEventsCsv(events, selectedDate) {
  const rows = [["Päivä UTC", "Leveysaste", "Pituusaste", "Lämpötilanne", "Ympäristö", "D0 FRP huippu MW", "D0 ylilennot", "Vertailupäivät", "Havaintopäivät", "Näytön rajat", "Havaintopäivän ajoitetut ylilennot", "FRP suhteessa mediaaniin", "Rakennettu osuus pikselissä", "Rakennettu osuus puskurissa"]];
  for (const e of events) rows.push([selectedDate, e.latitude, e.longitude, priorityFor(e).label, environmentalContext(e).label, e.currentPeakPassFrp, e.currentPassCount, e.persistenceActiveDayCount, e.activeDates.join(" "), priorityFor(e).reason, observationEvidence(e).passCount, observationEvidence(e).ratio, environmentalContext(e).pixelBuiltFraction, environmentalContext(e).builtFraction]);
  const quote = (value) => `"${(typeof value === "string" ? value.replace(/^[=+@-]/, "'$&") : String(value ?? "")).replaceAll('"', '""')}"`;
  return "\uFEFF" + rows.map((row) => row.map(quote).join(";")).join("\r\n");
}
