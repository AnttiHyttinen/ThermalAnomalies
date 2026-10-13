import { haversineKm, summarizeOverpasses } from "./anomaly.js?v=20261013.2";

const stamp = (p) => `${p.date}T${p.time}:00Z`;
const dated = (p) => /^\d{2}:\d{2}$/.test(p.time || "") && Number.isFinite(Date.parse(stamp(p)));
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((a,b) => a-b); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.ceil((a.length-1)/2)]) / 2 : null; };
const maximum = (passes, field) => passes.filter((p) => Number.isFinite(p[field])).reduce((best,p) => !best || p[field] > best[field] ? p : best, null);
const group = (p) => `${p.satellite}|${p.daynight}`;
const hours = (a,b) => (Date.parse(stamp(a))-Date.parse(stamp(b)))/3600000;
const knownGroup = (p) => p.satellite && p.satellite !== "?" && ["D","N"].includes(p.daynight);

export function detailBounds(event, radiusKm) {
  const dy = radiusKm / 111.32, dx = dy / Math.max(0.087, Math.cos(event.latitude * Math.PI / 180));
  return { west: Math.max(-180,event.longitude-dx), east: Math.min(180,event.longitude+dx), south: Math.max(-85,event.latitude-dy), north: Math.min(85,event.latitude+dy) };
}

export function analyzeEvolution(input, { coverageComplete = true } = {}) {
  const passes = input.filter(dated).map((p) => ({...p, at:stamp(p)})).sort((a,b) => a.at.localeCompare(b.at));
  const changes = [], history = new Map();
  let onset = null;
  for (const pass of passes) {
    const previous = knownGroup(pass) ? history.get(group(pass)) || [] : [];
    const comparable = previous.filter((p) => Number.isFinite(p.totalFrp));
    const last = comparable.at(-1);
    const base = comparable.filter((p) => p.date < pass.date).slice(-12);
    const baseMedian = median(base.map((p) => p.totalFrp));
    if (!onset && Number.isFinite(pass.totalFrp) && base.length >= 3 && new Set(base.map((p) => p.date)).size >= 2 && pass.totalFrp >= Math.max(3 * baseMedian, baseMedian + 20)) {
      const confirmation = passes.find((p) => p.at > pass.at && hours(p,pass) <= 36 && group(p) === group(pass) && Number.isFinite(p.totalFrp) && p.totalFrp >= Math.max(2*baseMedian, baseMedian+15));
      onset = { pass, previous:last, median:baseMedian, count:base.length, confirmed:Boolean(confirmation), confirmation };
    }
    const labels = [];
    let ratio = null, deltaHours = null, geometryComparable = false;
    if (last && Number.isFinite(pass.totalFrp) && hours(pass,last) <= 72) {
      deltaHours = hours(pass,last);
      ratio = last.totalFrp > 0 ? pass.totalFrp / last.totalFrp : null;
      if (pass.totalFrp >= Math.max(1.8*last.totalFrp,last.totalFrp+20)) labels.push("Voimistuminen");
      if (pass.totalFrp <= last.totalFrp*0.55 && last.totalFrp-pass.totalFrp >= 20) labels.push("Heikkeneminen");
      const pixelAreaRatio = (pass.observedPixelAreaKm2 / pass.pixelCount) / (last.observedPixelAreaKm2 / last.pixelCount);
      geometryComparable = pass.measuredPixelArea === true && last.measuredPixelArea === true && pixelAreaRatio >= 0.67 && pixelAreaRatio <= 1.5;
      if (pass.pixelCount >= Math.max(1.5*last.pixelCount,last.pixelCount+2) && pass.radius95Km >= last.radius95Km+0.35) labels.push(geometryComparable ? "Lämpöjalanjälki laajenee" : "Mahdollinen laajeneminen; pikseligeometria epävarma");
      if (pass.pixelCount <= last.pixelCount*0.6 && pass.radius95Km <= last.radius95Km-0.35) labels.push(geometryComparable ? "Lämpöjalanjälki supistuu" : "Mahdollinen supistuminen; pikseligeometria epävarma");
    }
    const share = pass.totalFrp > 0 && Number.isFinite(pass.maxFrp) ? pass.maxFrp/pass.totalFrp : null;
    if (share >= 0.65 && (pass.pixelCount <= 3 || pass.radius95Km <= 0.5)) labels.push("Teho keskittyy yhteen pikseliin");
    const next = passes.find((p) => p.at > pass.at && group(p) === group(pass) && Number.isFinite(p.totalFrp));
    const pulse = ratio >= 3 && last && pass.totalFrp-last.totalFrp >= 20 && deltaHours <= 36 && next && hours(next,pass) <= 36 && next.totalFrp <= pass.totalFrp*0.5;
    if (pulse) labels.push("Havaittu lämpöpiikki; todellinen kesto tuntematon");
    changes.push({pass, previous:last, ratio, deltaHours, share, geometryComparable, labels});
    if (knownGroup(pass)) history.set(group(pass), [...previous,pass]);
  }
  const gaps = passes.slice(1).map((p,i) => ({start:passes[i],end:p,hours:hours(p,passes[i])})).filter((g) => g.hours > 18);
  return {passes, changes, onset, gaps, peak:maximum(passes,"totalFrp"), pointPeak:maximum(passes,"maxFrp"), widest:maximum(passes,"radius95Km"), first:passes[0] || null, last:passes.at(-1) || null, unTimed:input.length-passes.length, coverageComplete};
}

export function buildDetailAnalysis(payload, event, radiusKm) {
  const nearby = payload.detections.filter((p) => p.date >= payload.analysisRange.start && p.date <= payload.analysisRange.end && haversineKm(event,p) <= radiusKm);
  const viirs = nearby.filter((p) => (p.instrument === "VIIRS" || p.source?.startsWith("VIIRS")) && ["n","h"].includes(p.confidence));
  const modis = nearby.filter((p) => (p.instrument === "MODIS" || p.source?.startsWith("MODIS")) && Number(p.confidence) >= 30);
  const passes = summarizeOverpasses(viirs);
  const support = summarizeOverpasses(modis);
  const analysis = analyzeEvolution(passes, {coverageComplete:payload.coverageComplete});
  return {...analysis, support, points:viirs, radiusKm, excluded:nearby.length-viirs.length-modis.length,
    clipped:viirs.some((p) => haversineKm(event,p) > radiusKm-0.5),
    range:payload.analysisRange, warnings:payload.warnings || [], sourceCoverage:payload.sourceCoverage || [], generatedAt:payload.generatedAt};
}

export function exportEvolutionCsv(analysis) {
  const rows = [["Aika UTC","Satelliitti","D/N","FRP MW","Max MW","Pikselit","r95 km","Havaintopikselien ala km2 (ei paloala)","FRP-suhde edelliseen saman ryhman havaintoon","Muutos"]];
  for (const row of analysis.changes) { const p=row.pass; rows.push([p.at,p.satellite,p.daynight,p.totalFrp,p.maxFrp,p.pixelCount,p.radius95Km,p.observedPixelAreaKm2,row.ratio,row.labels.join("; ")]); }
  return "\ufeff"+rows.map((row) => row.map((x) => `"${String(x ?? "").replaceAll('"','""')}"`).join(",")).join("\r\n");
}
