import { classifyEventBehavior, pixelAreaKm2 } from "./event-type.js?v=20260908.2";

const EARTH_RADIUS_KM = 6371.0088;
const STATIC_HOTSPOT_TYPES = new Set([1, 2, 3]);
const ROBUST_SCALE = 1.4826;
const ROBUST_EPSILON = 0.05;

export function haversineKm(left, right) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const value = (
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  );
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(value));
}

export function dateRange(start, end) {
  const dates = [];
  const current = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function findLargeFireEvents(detections, today, options = {}) {
  const settings = {
    clusterRadiusKm: options.clusterRadiusKm ?? 2.5,
    spatialCellKm: options.spatialCellKm ?? 0.5,
    coreBufferKm: options.coreBufferKm ?? 0.75,
    persistentAssignmentKm: options.persistentAssignmentKm ?? 3,
    minPoints: options.minPoints ?? 6,
    minDistinctCells: options.minDistinctCells ?? 4,
    minPassFrp: options.minPassFrp ?? options.minTotalFrp ?? 60,
    minFootprintKm2: options.minFootprintKm2 ?? 0.6,
    highFrp: options.highFrp ?? 80,
    displayStart: options.displayStart ?? shiftDate(today, -6),
    persistenceWindowDays: options.persistenceWindowDays ?? 14,
    persistenceMinActiveDays: options.persistenceMinActiveDays ?? 9,
    coreMinActiveDays: options.coreMinActiveDays ?? 3,
    minRobustBaselinePasses: options.minRobustBaselinePasses ?? 6,
    dataCoverageComplete: options.dataCoverageComplete ?? true,
  };
  const analysisStart = shiftDate(today, -(settings.persistenceWindowDays - 1));
  const baselineEnd = shiftDate(today, -1);
  const analysisDates = dateRange(analysisStart, today);
  const eligible = detections.filter((detection) => (
    ["n", "h"].includes(detection.confidence) &&
    detection.date >= analysisStart &&
    detection.date <= today &&
    (!detection.source || detection.source.startsWith("VIIRS_"))
  ));

  if (eligible.length === 0) return emptyResult();

  const baselinePoints = eligible.filter((point) => point.date < today);
  const projectionPoints = baselinePoints.length ? baselinePoints : eligible;
  const referenceLatitude = projectionPoints.reduce((sumValue, point) => sumValue + point.latitude, 0) / projectionPoints.length;
  const project = localProjection(referenceLatitude);
  const candidates = buildPersistentCandidates(baselinePoints, project, settings);
  const candidateIndex = createPersistentCandidateIndex(candidates, project, settings.spatialCellKm);
  const assignments = candidates.map(() => []);
  const assignedPoints = new Set();

  for (const point of eligible) {
    const match = nearestPersistentCandidate(point, candidateIndex, project, settings.persistentAssignmentKm);
    if (match) {
      assignments[match.index].push(point);
      assignedPoints.add(point);
    }
  }

  const persistentEvents = candidates
    .map((candidate, index) => buildPersistentEvent({
      candidate,
      points: assignments[index],
      index,
      today,
      analysisDates,
      analysisStart,
      baselineEnd,
      project,
      settings,
    }))
    .filter((event) => event.activeDates.length > 0)
    .map(withBehaviorAssessment);

  const freeRecentPoints = eligible.filter((point) => (
    point.date >= settings.displayStart && !assignedPoints.has(point)
  ));
  const freeAnalysisPoints = eligible.filter((point) => !assignedPoints.has(point));
  const fireGroups = clusterPoints(freeRecentPoints, settings.clusterRadiusKm, project);
  const fireGroupIndex = createPointGroupIndex(fireGroups, project, settings.clusterRadiusKm);
  const fireAssignments = fireGroups.map(() => []);
  for (const point of freeAnalysisPoints) {
    const match = nearestPointGroup(point, fireGroupIndex, project, settings.clusterRadiusKm);
    if (match) fireAssignments[match.index].push(point);
  }
  const fireEvents = fireGroups
    .map((points, index) => buildFireEvent({
      points,
      analysisPoints: fireAssignments[index],
      index,
      today,
      analysisDates,
      project,
      settings,
    }))
    // Every nominal/high-confidence event remains inspectable, including one-pixel fires.
    .map(withBehaviorAssessment);

  const fires = fireEvents.sort((left, right) => right.score - left.score);
  const sourceFires = persistentEvents
    .filter((event) => event.kind === "source-fire")
    .sort((left, right) => right.score - left.score);
  const sourceAnomalies = persistentEvents
    .filter((event) => event.kind === "source-anomaly")
    .sort((left, right) => right.score - left.score);
  const persistentSources = persistentEvents
    .filter((event) => event.kind === "persistent-source")
    .sort((left, right) => right.score - left.score);
  const unknownSources = persistentEvents.filter((event) => event.kind === "source-unknown");
  const events = [...sourceFires, ...sourceAnomalies, ...fires, ...unknownSources, ...persistentSources];

  return {
    fires,
    sourceFires,
    persistentSources,
    unknownSources,
    sourceAnomalies,
    events,
    clusters: [...persistentEvents, ...fireEvents],
    activeTodayCount: fires.filter((fire) => fire.activeToday).length,
    activeSourceFireCount: sourceFires.filter((source) => source.activeToday).length,
    activeSourceAnomalyCount: sourceAnomalies.filter((source) => source.anomalyToday).length,
    eligibleDetectionCount: eligible.length,
  };
}

export function dailyCounts(detections, start, end) {
  const counts = new Map(dateRange(start, end).map((date) => [date, 0]));
  for (const detection of detections) {
    if (counts.has(detection.date)) counts.set(detection.date, counts.get(detection.date) + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count }));
}

export function summarizeOverpasses(points, options = {}) {
  const referenceLatitude = points.length > 0
    ? points.reduce((sumValue, point) => sumValue + point.latitude, 0) / points.length
    : 0;
  const project = options.project ?? localProjection(referenceLatitude);
  const spatialCellKm = options.spatialCellKm ?? 0.5;
  const coreCellKeys = options.coreCellKeys ?? new Set();
  const coreBufferKm = options.coreBufferKm ?? 0.75;
  const groups = new Map();

  const latest = new Map();
  const unique = new Map(points.map((point) => [
    `${point.source}|${point.satellite}|${point.daynight}|${point.date}|${point.time}|${point.latitude}|${point.longitude}`, point,
  ]));
  for (const point of [...unique.values()].sort((a, b) => `${a.date}|${a.time}`.localeCompare(`${b.date}|${b.time}`))) {
    const satellite = point.satellite || "?";
    const daynight = String(point.daynight || "?").toUpperCase();
    const groupKey = `${point.date}|${satellite}|${daynight}`;
    const minutes = timeMinutes(point.time);
    let start = latest.get(groupKey);
    // A rolling 20-minute window avoids splitting one overpass at a clock boundary.
    if (!start || minutes === null || minutes - start.minutes > 20) {
      start = { minutes, time: point.time || "??:??" };
      latest.set(groupKey, start);
    }
    const key = `${groupKey}|${start.time}`;
    const group = groups.get(key) || [];
    group.push(point);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, passPoints]) => {
    // Overlapping granules can repeat the same pixel minutes apart in one overpass.
    const pixels = new Map();
    for (const point of passPoints) {
      const pixel = `${point.latitude.toFixed(5)}:${point.longitude.toFixed(5)}`;
      if (!pixels.has(pixel) || (point.frp ?? -1) > (pixels.get(pixel).frp ?? -1)) pixels.set(pixel, point);
    }
    passPoints = [...pixels.values()];
    const [date, satellite, daynight, time] = key.split("|");
    const centroid = {
      latitude: passPoints.reduce((sumValue, point) => sumValue + point.latitude, 0) / passPoints.length,
      longitude: passPoints.reduce((sumValue, point) => sumValue + point.longitude, 0) / passPoints.length,
    };
    const distances = passPoints
      .map((point) => haversineKm(centroid, point))
      .sort((left, right) => left - right);
    const frpValues = passPoints.map((point) => point.frp).filter(Number.isFinite);
    const outsideCorePixels = coreCellKeys.size === 0
      ? 0
      : passPoints.filter((point) => !isInsideCore(point, coreCellKeys, project, spatialCellKm, coreBufferKm)).length;
    const observedPixelAreaKm2 = sum(passPoints.map(pixelAreaKm2));
    const totalFrp = frpValues.length === passPoints.length ? sum(frpValues) : null;
    return {
      id: key,
      date,
      time,
      satellite,
      daynight,
      latitude: centroid.latitude,
      longitude: centroid.longitude,
      pixelCount: passPoints.length,
      totalFrp,
      frpObservedPixels: frpValues.length,
      frpComplete: frpValues.length === passPoints.length,
      measuredPixelArea: passPoints.every((point) => point.scanKm > 0 && point.trackKm > 0),
      maxFrp: maxFinite(frpValues),
      radius95Km: percentile(distances, 0.95) ?? 0,
      distinctSpatialCells: countSpatialCells(passPoints, project, spatialCellKm),
      outsideCorePixels,
      observedPixelAreaKm2,
      frpDensityMwKm2: totalFrp === null ? null : totalFrp / Math.max(observedPixelAreaKm2, 0.01),
    };
  }).sort((left, right) => (
    left.date.localeCompare(right.date) ||
    left.time.localeCompare(right.time) ||
    left.satellite.localeCompare(right.satellite)
  ));
}

function withBehaviorAssessment(event) {
  return { ...event, behavior: classifyEventBehavior(event) };
}

function emptyResult() {
  return {
    fires: [],
    sourceFires: [],
    persistentSources: [],
    unknownSources: [],
    sourceAnomalies: [],
    events: [],
    clusters: [],
    activeTodayCount: 0,
    activeSourceFireCount: 0,
    activeSourceAnomalyCount: 0,
    eligibleDetectionCount: 0,
  };
}

function buildPersistentCandidates(points, project, settings) {
  if (points.length === 0) return [];
  const cells = groupPointsByCell(points, project, settings.spatialCellKm);
  const recurringKeys = new Set();
  const localActiveDays = new Map();
  for (const cell of cells.values()) {
    const nearbyDates = new Set();
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const neighbor = cells.get(`${cell.cellX + xOffset}:${cell.cellY + yOffset}`);
        for (const date of neighbor?.dates || []) nearbyDates.add(date);
      }
    }
    localActiveDays.set(cell.key, nearbyDates.size);
    if (nearbyDates.size >= settings.coreMinActiveDays) recurringKeys.add(cell.key);
  }

  const components = connectedCellComponents(recurringKeys, cells);
  return components.map((keys, index) => {
    const componentPoints = keys.flatMap((key) => cells.get(key)?.points || []);
    const activeDates = [...new Set(componentPoints.map((point) => point.date))].sort();
    const latitude = componentPoints.reduce((sumValue, point) => sumValue + point.latitude, 0) / componentPoints.length;
    const longitude = componentPoints.reduce((sumValue, point) => sumValue + point.longitude, 0) / componentPoints.length;
    const hotspotTypes = componentPoints
      .map((point) => point.hotspotType)
      .filter((value) => Number.isInteger(value));
    return {
      id: `persistent-${index}-${latitude.toFixed(4)}-${longitude.toFixed(4)}`,
      latitude,
      longitude,
      seedPoints: componentPoints,
      cellKeys: new Set(keys),
      activeDates,
      activeDayCount: activeDates.length,
      maxLocalActiveDayCount: Math.max(...keys.map((key) => localActiveDays.get(key) || 0), 0),
      hotspotTypes,
      dominantHotspotType: mostCommon(hotspotTypes),
      isStaticByType: hotspotTypes.some((value) => STATIC_HOTSPOT_TYPES.has(value)),
    };
  }).filter((candidate) => (
    candidate.activeDayCount >= settings.persistenceMinActiveDays &&
    candidate.maxLocalActiveDayCount >= settings.persistenceMinActiveDays
  ));
}

function connectedCellComponents(keys, cells) {
  const remaining = new Set(keys);
  const components = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value;
    const queue = [first];
    const component = [];
    remaining.delete(first);
    while (queue.length > 0) {
      const key = queue.pop();
      component.push(key);
      const cell = cells.get(key);
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
          const neighborKey = `${cell.cellX + xOffset}:${cell.cellY + yOffset}`;
          if (remaining.delete(neighborKey)) queue.push(neighborKey);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function createPersistentCandidateIndex(candidates, project, cellSizeKm) {
  const cells = new Map();
  candidates.forEach((candidate, index) => {
    for (const seedPoint of candidate.seedPoints) {
      const projected = project(seedPoint);
      const key = gridKey(projected.x, projected.y, cellSizeKm);
      const entries = cells.get(key) || [];
      entries.push({ index, x: projected.x, y: projected.y });
      cells.set(key, entries);
    }
  });
  return { cells, cellSizeKm };
}

function nearestPersistentCandidate(point, index, project, maxDistanceKm) {
  const projected = project(point);
  const cellX = Math.floor(projected.x / index.cellSizeKm);
  const cellY = Math.floor(projected.y / index.cellSizeKm);
  const reach = Math.ceil(maxDistanceKm / index.cellSizeKm);
  let nearest = null;
  for (let xOffset = -reach; xOffset <= reach; xOffset += 1) {
    for (let yOffset = -reach; yOffset <= reach; yOffset += 1) {
      const entries = index.cells.get(`${cellX + xOffset}:${cellY + yOffset}`) || [];
      for (const entry of entries) {
        const distanceKm = Math.hypot(projected.x - entry.x, projected.y - entry.y);
        if (distanceKm <= maxDistanceKm && (!nearest || distanceKm < nearest.distanceKm)) {
          nearest = { index: entry.index, distanceKm };
        }
      }
    }
  }
  return nearest;
}

function createPointGroupIndex(groups, project, cellSizeKm) {
  const cells = new Map();
  groups.forEach((points, index) => {
    for (const point of points) {
      const projected = project(point);
      const key = gridKey(projected.x, projected.y, cellSizeKm);
      const entries = cells.get(key) || [];
      entries.push({ index, x: projected.x, y: projected.y });
      cells.set(key, entries);
    }
  });
  return { cells, cellSizeKm };
}

function nearestPointGroup(point, index, project, maxDistanceKm) {
  const projected = project(point);
  const cellX = Math.floor(projected.x / index.cellSizeKm);
  const cellY = Math.floor(projected.y / index.cellSizeKm);
  const reach = Math.ceil(maxDistanceKm / index.cellSizeKm);
  let nearest = null;
  for (let xOffset = -reach; xOffset <= reach; xOffset += 1) {
    for (let yOffset = -reach; yOffset <= reach; yOffset += 1) {
      const entries = index.cells.get(`${cellX + xOffset}:${cellY + yOffset}`) || [];
      for (const entry of entries) {
        const distanceKm = Math.hypot(projected.x - entry.x, projected.y - entry.y);
        if (distanceKm <= maxDistanceKm && (!nearest || distanceKm < nearest.distanceKm)) {
          nearest = { index: entry.index, distanceKm };
        }
      }
    }
  }
  return nearest;
}

function buildPersistentEvent({
  candidate,
  points,
  index,
  today,
  analysisDates,
  analysisStart,
  baselineEnd,
  project,
  settings,
}) {
  const recentPoints = points.filter((point) => point.date >= settings.displayStart);
  const initialPasses = summarizeOverpasses(points, { project, spatialCellKm: settings.spatialCellKm });
  const changePoint = detectSourceChange(initialPasses, analysisDates);
  const referenceEnd = changePoint?.date ?? today;
  let referencePoints = points.filter((point) => point.date < referenceEnd && point.date < today);
  const referenceActiveDays = new Set(referencePoints.map((point) => point.date)).size;
  if (referenceActiveDays < 5) referencePoints = points.filter((point) => point.date < today);

  const core = buildNormalCore(referencePoints, project, settings.spatialCellKm, settings.coreMinActiveDays);
  const overpasses = summarizeOverpasses(points, {
    project,
    spatialCellKm: settings.spatialCellKm,
    coreCellKeys: core.keys,
    coreBufferKm: settings.coreBufferKm,
  });
  const frpProfile = buildFrpProfile(overpasses, analysisDates);
  const baselinePasses = overpasses.filter((pass) => pass.date < referenceEnd && pass.date < today);
  const comparisonPasses = overpasses.filter((pass) => (
    changePoint ? pass.date >= changePoint.date : pass.date === today
  ));
  const comparisons = comparisonPasses.map((pass) => compareOverpass(
    pass,
    baselinePasses.filter((baseline) => (
      baseline.satellite === pass.satellite && baseline.daynight === pass.daynight
    )),
    settings.minRobustBaselinePasses,
  ));
  const anomalousComparisons = comparisons.filter((entry) => entry.isAnomalous);
  const currentComparisons = comparisons.filter((entry) => entry.pass.date === today);
  const fireConfirmations = anomalousComparisons.filter((entry) => (
    entry.pass.outsideCorePixels >= 2 && entry.pass.date >= shiftDate(today, -2) && entry.assessable
  ));
  const confirmingSatellites = [...new Set(fireConfirmations.map((entry) => entry.pass.satellite))].sort();
  const currentExpansion = currentComparisons.some((entry) => entry.isAnomalous && entry.pass.outsideCorePixels >= 2);
  const isProbableFire = !core.fallback && currentExpansion && fireConfirmations.length >= 2;
  const hasSourceAnomaly = currentComparisons.some((entry) => entry.isAnomalous || entry.pass.outsideCorePixels >= 2);
  const normalObserved = currentComparisons.length > 0 && currentComparisons.every((entry) => entry.fullyComparable) && !hasSourceAnomaly && !core.fallback && settings.dataCoverageComplete;
  const kind = isProbableFire
    ? "source-fire"
    : hasSourceAnomaly
      ? "source-anomaly"
      : normalObserved ? "persistent-source" : "source-unknown";
  const activeDates = [...new Set(recentPoints.map((point) => point.date))].sort();
  const analysisActiveDates = [...new Set(points.filter((point) => point.date < today).map((point) => point.date))].sort();
  const dailyActivity = summarizeDailyActivity(points, project, settings.spatialCellKm);
  const selectedPoints = recentPoints.filter((point) => point.date === today);
  const centerPoints = selectedPoints.length ? selectedPoints : recentPoints.length > 0 ? recentPoints : candidate.seedPoints;
  const latitude = centerPoints.reduce((sumValue, point) => sumValue + point.latitude, 0) / centerPoints.length;
  const longitude = centerPoints.reduce((sumValue, point) => sumValue + point.longitude, 0) / centerPoints.length;
  const center = { latitude, longitude };
  const extentKm = Math.max(...recentPoints.map((point) => haversineKm(center, point)), 0);
  const footprintKm2 = convexHullAreaKm2(recentPoints, project);
  const currentPasses = overpasses.filter((pass) => pass.date === today);
  const eventPasses = comparisonPasses.length > 0 ? comparisonPasses : currentPasses;
  const baselineMedianPassFrp = median(baselinePasses.map((pass) => pass.totalFrp));
  const currentOutsideCorePixels = sum(currentPasses.map((pass) => pass.outsideCorePixels));
  const anomalyDates = [...new Set([
    ...anomalousComparisons.map((entry) => entry.pass.date),
    ...(changePoint ? [changePoint.date] : []),
  ])].sort();
  const maxIntensityScore = maxFinite(anomalousComparisons.map((entry) => entry.intensityScore));
  const maxExtentScore = maxFinite(anomalousComparisons.map((entry) => entry.extentScore));
  const reliability = sourceReliability({
    candidate,
    baselinePasses,
    currentPasses,
    comparisons,
    fireConfirmations,
    core,
    dataCoverageComplete: settings.dataCoverageComplete,
    kind,
  });
  const peakPass = maxBy(eventPasses, (pass) => pass.totalFrp) || maxBy(overpasses, (pass) => pass.totalFrp);
  const score = (
    (peakPass?.totalFrp ?? 0) +
    fireConfirmations.length * 80 +
    anomalousComparisons.length * 30 +
    footprintKm2 * 30 +
    candidate.activeDayCount * 3
  );

  return {
    id: `source-${index}-${latitude.toFixed(4)}-${longitude.toFixed(4)}`,
    latitude,
    longitude,
    pointCount: recentPoints.length,
    analysisPointCount: points.length,
    distinctSpatialCells: countSpatialCells(recentPoints, project, settings.spatialCellKm),
    analysisDistinctSpatialCells: countSpatialCells(points, project, settings.spatialCellKm),
    activeDates,
    analysisActiveDates,
    firstDate: activeDates[0],
    lastDate: activeDates.at(-1),
    activeToday: activeDates.includes(today),
    dailyActivity,
    frpProfile,
    overpasses,
    comparisons,
    contextPoints: contextPoints(recentPoints, today, project, settings.spatialCellKm),
    totalFrp: sum(recentPoints.map((point) => point.frp).filter(Number.isFinite)),
    peakPassFrp: maxFinite(overpasses.map((pass) => pass.totalFrp)),
    displayPeakPassFrp: peakPass?.totalFrp ?? 0,
    maxFrp: maxFinite(recentPoints.map((point) => point.frp)),
    meanFrp: mean(recentPoints.map((point) => point.frp)),
    maxBrightness: maxFinite(recentPoints.map((point) => point.brightness)),
    footprintKm2,
    extentKm,
    radiusMeters: Math.round(Math.max(1_300, (extentKm + 0.9) * 1_000)),
    satellites: [...new Set(points.map((point) => point.satellite).filter(Boolean))].sort(),
    hotspotTypes: [...new Set(candidate.hotspotTypes)].sort(),
    dominantHotspotType: candidate.dominantHotspotType,
    isStaticByType: candidate.isStaticByType,
    isPersistentCompactSource: true,
    isPersistentHeatSource: true,
    persistenceActiveDayCount: candidate.activeDayCount,
    persistenceWindowDays: settings.persistenceWindowDays - 1,
    persistenceMinActiveDays: settings.persistenceMinActiveDays,
    persistenceLevelStable: normalObserved,
    persistenceConfidence: candidate.activeDayCount >= 11 && !hasSourceAnomaly ? "high" : "probable",
    classificationBasis: "recurrence",
    anomalyDates,
    analysisAnomalyDates: anomalyDates,
    anomalyToday: anomalyDates.includes(today),
    anomalyPeakRatio: maxFinite(anomalousComparisons.map((entry) => entry.frpRatio)),
    baselineMedianPassFrp,
    baselinePassCount: baselinePasses.length,
    baselinePeriod: { start: analysisStart, end: changePoint ? shiftDate(changePoint.date, -1) : baselineEnd },
    currentPassCount: currentPasses.length,
    currentPeakPassFrp: maxFinite(currentPasses.map((pass) => pass.totalFrp)),
    currentOutsideCorePixels,
    confirmingPassCount: fireConfirmations.length,
    confirmingSatellites,
    maxIntensityScore,
    maxExtentScore,
    comparisonMethod: currentComparisons.some((entry) => entry.method === "mad") ? "mad" : currentComparisons.some((entry) => entry.method === "ratio") ? "ratio" : "insufficient",
    comparableCurrentPasses: currentComparisons.filter((entry) => entry.fullyComparable).length,
    normalObserved,
    normalCoreCellCount: core.keys.size,
    normalCoreFallback: core.fallback,
    changePoint,
    reliability,
    hasSourceAnomaly,
    kind,
    isLargeFire: kind === "source-fire",
    score,
  };
}

function buildFireEvent({ points, analysisPoints, index, today, analysisDates, project, settings }) {
  const selectedPoints = points.filter((point) => point.date === today);
  const centerPoints = selectedPoints.length ? selectedPoints : points;
  const latitude = centerPoints.reduce((sumValue, point) => sumValue + point.latitude, 0) / centerPoints.length;
  const longitude = centerPoints.reduce((sumValue, point) => sumValue + point.longitude, 0) / centerPoints.length;
  const center = { latitude, longitude };
  const activeDates = [...new Set(points.map((point) => point.date))].sort();
  const overpasses = summarizeOverpasses(analysisPoints, { project, spatialCellKm: settings.spatialCellKm });
  const recentPasses = overpasses.filter((pass) => pass.date >= settings.displayStart);
  const frpProfile = buildFrpProfile(overpasses, analysisDates);
  const footprintKm2 = convexHullAreaKm2(points, project);
  const distinctSpatialCells = countSpatialCells(points, project, settings.spatialCellKm);
  const extentKm = Math.max(...points.map((point) => haversineKm(center, point)), 0);
  const peakPass = maxBy(recentPasses, (pass) => pass.totalFrp);
  const largeByCoverage = (
    points.length >= settings.minPoints &&
    distinctSpatialCells >= settings.minDistinctCells &&
    ((peakPass?.totalFrp ?? 0) >= settings.minPassFrp || footprintKm2 >= settings.minFootprintKm2)
  );
  const largeByFootprint = distinctSpatialCells >= settings.minDistinctCells && footprintKm2 >= settings.minFootprintKm2;
  const largeByIntensity = recentPasses.some((pass) => (
    pass.pixelCount >= 3 &&
    pass.distinctSpatialCells >= 3 &&
    (pass.maxFrp ?? 0) >= settings.highFrp &&
    pass.totalFrp >= settings.minPassFrp
  ));
  const isLargeFire = largeByCoverage || largeByFootprint || largeByIntensity;
  const satellites = [...new Set(recentPasses.map((pass) => pass.satellite))].sort();
  const reliability = fireReliability({
    recentPasses,
    satellites,
    dataCoverageComplete: settings.dataCoverageComplete,
  });
  const score = (peakPass?.totalFrp ?? 0) + footprintKm2 * 30 + distinctSpatialCells * 4 + activeDates.length * 3;

  return {
    id: `fire-${index}-${latitude.toFixed(4)}-${longitude.toFixed(4)}`,
    latitude,
    longitude,
    pointCount: points.length,
    analysisPointCount: analysisPoints.length,
    distinctSpatialCells,
    analysisDistinctSpatialCells: countSpatialCells(analysisPoints, project, settings.spatialCellKm),
    activeDates,
    analysisActiveDates: [...new Set(analysisPoints.map((point) => point.date))].sort(),
    firstDate: activeDates[0],
    lastDate: activeDates.at(-1),
    activeToday: activeDates.includes(today),
    dailyActivity: summarizeDailyActivity(analysisPoints, project, settings.spatialCellKm),
    frpProfile,
    overpasses,
    contextPoints: contextPoints(points, today, project, settings.spatialCellKm),
    totalFrp: sum(points.map((point) => point.frp).filter(Number.isFinite)),
    peakPassFrp: peakPass?.totalFrp ?? null,
    displayPeakPassFrp: peakPass?.totalFrp ?? null,
    maxFrp: maxFinite(points.map((point) => point.frp)),
    meanFrp: mean(points.map((point) => point.frp)),
    maxBrightness: maxFinite(points.map((point) => point.brightness)),
    footprintKm2,
    extentKm,
    radiusMeters: Math.round(Math.max(1_300, (extentKm + 0.9) * 1_000)),
    satellites,
    hotspotTypes: [...new Set(points.map((point) => point.hotspotType).filter(Number.isInteger))].sort(),
    dominantHotspotType: null,
    isStaticByType: false,
    isPersistentCompactSource: false,
    isPersistentHeatSource: false,
    persistenceActiveDayCount: 0,
    persistenceWindowDays: settings.persistenceWindowDays - 1,
    persistenceMinActiveDays: settings.persistenceMinActiveDays,
    persistenceLevelStable: false,
    persistenceConfidence: null,
    classificationBasis: "fire-cluster",
    anomalyDates: [],
    analysisAnomalyDates: [],
    anomalyToday: false,
    anomalyPeakRatio: null,
    baselineMedianPassFrp: null,
    baselinePassCount: 0,
    currentPassCount: recentPasses.filter((pass) => pass.date === today).length,
    currentPeakPassFrp: maxFinite(recentPasses.filter((pass) => pass.date === today).map((pass) => pass.totalFrp)),
    currentOutsideCorePixels: null,
    confirmingPassCount: recentPasses.length,
    confirmingSatellites: satellites,
    maxIntensityScore: null,
    maxExtentScore: null,
    comparisonMethod: null,
    normalCoreCellCount: 0,
    normalCoreFallback: false,
    changePoint: null,
    reliability,
    hasSourceAnomaly: false,
    kind: "fire",
    isLargeFire,
    score,
  };
}

function buildNormalCore(points, project, cellSizeKm, minActiveDays) {
  const cells = groupPointsByCell(points, project, cellSizeKm);
  const selected = [...cells.values()].filter((cell) => cell.dates.size >= minActiveDays);
  if (selected.length > 0) return { keys: new Set(selected.map((cell) => cell.key)), fallback: false };
  const maximum = Math.max(...[...cells.values()].map((cell) => cell.dates.size), 0);
  const fallback = [...cells.values()].filter((cell) => cell.dates.size === maximum && maximum > 0);
  return { keys: new Set(fallback.map((cell) => cell.key)), fallback: true };
}

export function compareOverpass(pass, baselinePasses, minRobustBaselinePasses = 6) {
  baselinePasses = baselinePasses.filter((entry) => Number.isFinite(entry.totalFrp) && Number.isFinite(entry.maxFrp));
  const baselineDays = new Set(baselinePasses.map((entry) => entry.date)).size;
  const assessable = baselinePasses.length >= 3 && baselineDays >= 3 && ["D", "N"].includes(pass.daynight) && pass.satellite !== "?" && timeMinutes(pass.time) !== null;
  const useRobust = assessable && baselinePasses.length >= minRobustBaselinePasses && baselineDays >= 5;
  const totalFrp = metricComparison(pass.totalFrp, baselinePasses.map((entry) => entry.totalFrp), useRobust, true);
  const maxFrp = metricComparison(pass.maxFrp, baselinePasses.map((entry) => entry.maxFrp), useRobust, true);
  const pixelCount = metricComparison(pass.pixelCount, baselinePasses.map((entry) => entry.pixelCount), useRobust, true);
  const radius95 = metricComparison(pass.radius95Km, baselinePasses.map((entry) => entry.radius95Km), useRobust, false);
  const intensityScore = Math.max(totalFrp.score, maxFrp.score);
  const extentScore = Math.max(pixelCount.score, radius95.score);
  const intensityAnomaly = assessable && (useRobust
    ? intensityScore >= 3 && Math.max(totalFrp.ratio, maxFrp.ratio) >= 1.5
    : Math.max(totalFrp.ratio, maxFrp.ratio) >= 3);
  const extentAnomaly = assessable && (useRobust
    ? extentScore >= 3 && (pixelCount.ratio >= 1.5 || pass.radius95Km >= radius95.median + 0.25)
    : (pixelCount.ratio >= 3 || (radius95.ratio >= 3 && pass.radius95Km >= radius95.median + 0.35)));
  return {
    pass,
    baselinePassCount: baselinePasses.length,
    baselineDays,
    assessable,
    fullyComparable: assessable && Number.isFinite(pass.totalFrp) && totalFrp.available,
    method: !assessable ? "insufficient" : useRobust ? "mad" : "ratio",
    intensityScore: assessable ? intensityScore : null,
    extentScore: assessable ? extentScore : null,
    intensityAnomaly,
    extentAnomaly,
    isAnomalous: intensityAnomaly || extentAnomaly,
    frpRatio: Math.max(totalFrp.ratio, maxFrp.ratio),
    metrics: { totalFrp, maxFrp, pixelCount, radius95 },
  };
}

function metricComparison(current, baseline, robust, logTransform) {
  const values = baseline.filter(Number.isFinite);
  if (!Number.isFinite(current) || values.length < 3) return { available: false, score: null, ratio: null, median: values.length ? median(values) : null, mad: null, current };
  const baselineMedian = median(values);
  const ratio = current / Math.max(baselineMedian, logTransform ? 1 : 0.05);
  if (!robust) return { available: true, score: ratio, ratio, median: baselineMedian, mad: null, current };
  const transform = logTransform ? (value) => Math.log1p(Math.max(0, value)) : (value) => value;
  const transformed = values.map(transform);
  const transformedMedian = median(transformed);
  const mad = median(transformed.map((value) => Math.abs(value - transformedMedian)));
  const score = (transform(current) - transformedMedian) / (ROBUST_SCALE * mad + ROBUST_EPSILON);
  return { available: true, score, ratio, median: baselineMedian, mad, current };
}

function detectSourceChange(passes, dates) {
  const groups = new Map();
  for (const pass of passes) {
    if (!Number.isFinite(pass.totalFrp) || !["D", "N"].includes(pass.daynight) || pass.satellite === "?") continue;
    const key = `${pass.satellite}/${pass.daynight}`;
    const group = groups.get(key) || [];
    group.push(pass);
    groups.set(key, group);
  }
  return [...groups].map(([group, entries]) => {
    const change = detectChangePoint(buildFrpProfile(entries, dates));
    return change ? { ...change, group } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || b.score - a.score)[0] || null;
}

function contextPoints(points, today, project, size) {
  const date = points.some((point) => point.date === today) ? today : points.map((point) => point.date).sort().at(-1);
  const cells = groupPointsByCell(points.filter((point) => point.date === date), project, size);
  return [...cells.values()].map((cell) => {
    const point = cell.points[0];
    return { latitude: point.latitude, longitude: point.longitude, scanKm: point.scanKm, trackKm: point.trackKm, date };
  });
}

function detectChangePoint(profile) {
  if (profile.length < 8) return null;
  let best = null;
  const lastSplit = Math.min(10, profile.length - 3);
  for (let split = 3; split <= lastSplit; split += 1) {
    const before = profile.slice(0, split).filter((entry) => entry.passCount > 0);
    const after = profile.slice(split).filter((entry) => entry.passCount > 0);
    if (before.length < 5 || after.length < 3) continue;
    const beforeFrp = median(before.map((entry) => entry.peakPassFrp));
    const afterFrp = median(after.map((entry) => entry.peakPassFrp));
    const beforePixels = median(before.map((entry) => entry.peakPixelCount));
    const afterPixels = median(after.map((entry) => entry.peakPixelCount));
    const beforeRadius = median(before.map((entry) => entry.peakRadius95Km));
    const afterRadius = median(after.map((entry) => entry.peakRadius95Km));
    const frpRatio = afterFrp / Math.max(beforeFrp, 1);
    const pixelRatio = afterPixels / Math.max(beforePixels, 1);
    const radiusRatio = afterRadius / Math.max(beforeRadius, 0.05);
    const frpChanged = frpRatio >= 2.2 && afterFrp >= beforeFrp + 20;
    const pixelsChanged = pixelRatio >= 2 && afterPixels >= beforePixels + 2;
    const radiusChanged = radiusRatio >= 1.8 && afterRadius >= beforeRadius + 0.35;
    const changed = (frpChanged && (pixelsChanged || radiusChanged)) || (
      pixelsChanged && radiusChanged && frpRatio >= 1.5
    );
    const sustainedStart = after.slice(0, 2).every((entry) => (
      entry.peakPassFrp >= Math.max(beforeFrp * 1.8, beforeFrp + 15) &&
      (
        entry.peakPixelCount >= Math.max(beforePixels * 1.5, beforePixels + 2) ||
        entry.peakRadius95Km >= beforeRadius + 0.3
      )
    ));
    if (!changed || !sustainedStart) continue;
    const score = Math.log1p(frpRatio) + Math.log1p(pixelRatio) + Math.log1p(radiusRatio);
    if (!best || score > best.score) {
      best = {
        date: profile[split].date,
        score,
        beforeDays: before.length,
        afterDays: after.length,
        beforeMedianFrp: beforeFrp,
        afterMedianFrp: afterFrp,
        frpRatio,
        pixelRatio,
        radiusRatio,
      };
    }
  }
  return best;
}

function buildFrpProfile(overpasses, dates) {
  const byDate = new Map();
  for (const pass of overpasses) {
    const list = byDate.get(pass.date) || [];
    list.push(pass);
    byDate.set(pass.date, list);
  }
  return dates.map((date) => {
    const passes = byDate.get(date) || [];
    return {
      date,
      passCount: passes.length,
      passes,
      peakPassFrp: maxFinite(passes.map((pass) => pass.totalFrp)),
      medianPassFrp: passes.length > 0 ? median(passes.map((pass) => pass.totalFrp)) : null,
      peakPixelCount: maxFinite(passes.map((pass) => pass.pixelCount)),
      peakRadius95Km: maxFinite(passes.map((pass) => pass.radius95Km)),
      outsideCorePixels: sum(passes.map((pass) => pass.outsideCorePixels)),
    };
  });
}

function sourceReliability({
  candidate,
  baselinePasses,
  currentPasses,
  comparisons,
  fireConfirmations,
  core,
  dataCoverageComplete,
  kind,
}) {
  let score = candidate.activeDayCount >= 11 ? 2 : 1;
  const reasons = [];
  if (baselinePasses.length >= 12) score += 2;
  else if (baselinePasses.length >= 6) score += 1;
  if (!core.fallback) score += 1;
  else reasons.push("normaalijalanjälki perustuu harvaan soluaineistoon");
  if (!dataCoverageComplete) {
    score -= 1;
    reasons.push("osa satelliittiaineistosta puuttuu");
  }
  if (currentPasses.length === 0) reasons.push("D0-päivältä ei ole kohteen lämpöhavaintoa");
  if (kind === "source-fire" && fireConfirmations.length >= 2) score += 2;
  if (kind !== "source-fire" && comparisons.length > 0 && comparisons.every((entry) => entry.baselinePassCount < 6)) {
    reasons.push("vertailu käyttää vähäisen otoksen suhderajaa");
  }
  const level = score >= 5 ? "high" : score >= 3 ? "medium" : "low";
  if (kind === "source-unknown") return { level: "low", label: "riittämätön", reasons: [...reasons, "D0-tasoa ei voi vahvistaa: havainto, vertailuryhmä tai aineiston kattavuus on puutteellinen"] };
  return {
    level,
    label: level === "high" ? "vahva" : level === "medium" ? "kohtalainen" : "rajallinen",
    reasons,
  };
}

function fireReliability({ recentPasses, satellites, dataCoverageComplete }) {
  let score = recentPasses.length >= 3 ? 2 : recentPasses.length >= 2 ? 1 : 0;
  if (satellites.length >= 2) score += 2;
  if (!dataCoverageComplete) score -= 1;
  const level = score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  return {
    level,
    label: level === "high" ? "vahva" : level === "medium" ? "kohtalainen" : "rajallinen",
    reasons: dataCoverageComplete ? [] : ["osa satelliittiaineistosta puuttuu"],
  };
}

function summarizeDailyActivity(points, project, spatialCellKm) {
  const activity = new Map();
  for (const point of points) {
    const current = activity.get(point.date) || [];
    current.push(point);
    activity.set(point.date, current);
  }
  return [...activity.entries()].map(([date, dayPoints]) => {
    const frpValues = dayPoints.map((point) => point.frp).filter(Number.isFinite);
    return {
      date,
      latitude: dayPoints.reduce((sumValue, point) => sumValue + point.latitude, 0) / dayPoints.length,
      longitude: dayPoints.reduce((sumValue, point) => sumValue + point.longitude, 0) / dayPoints.length,
      pointCount: dayPoints.length,
      frp: sum(frpValues),
      maxFrp: maxFinite(frpValues),
      footprintKm2: convexHullAreaKm2(dayPoints, project),
      distinctSpatialCells: countSpatialCells(dayPoints, project, spatialCellKm),
    };
  }).sort((left, right) => left.date.localeCompare(right.date));
}

function clusterPoints(points, radiusKm, project) {
  if (points.length === 0) return [];
  const parents = points.map((_, index) => index);
  const index = createGridIndex(radiusKm);
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    for (const candidate of nearbyEntries(index, point, radiusKm, project)) {
      if (haversineKm(point, candidate.point) <= radiusKm) union(parents, pointIndex, candidate.index);
    }
    addToGrid(index, point, pointIndex, project);
  }
  const groups = new Map();
  points.forEach((point, pointIndex) => {
    const root = findRoot(parents, pointIndex);
    const group = groups.get(root) || [];
    group.push(point);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function createGridIndex(cellSizeKm) {
  return { cells: new Map(), cellSizeKm };
}

function addToGrid(index, point, pointIndex, project) {
  const { x, y } = project(point);
  const key = gridKey(x, y, index.cellSizeKm);
  const cell = index.cells.get(key) || [];
  cell.push({ point, index: pointIndex });
  index.cells.set(key, cell);
}

function nearbyEntries(index, point, radiusKm, project) {
  const { x, y } = project(point);
  const cellX = Math.floor(x / index.cellSizeKm);
  const cellY = Math.floor(y / index.cellSizeKm);
  const reach = Math.max(1, Math.ceil(radiusKm / index.cellSizeKm));
  const candidates = [];
  for (let xOffset = -reach; xOffset <= reach; xOffset += 1) {
    for (let yOffset = -reach; yOffset <= reach; yOffset += 1) {
      candidates.push(...(index.cells.get(`${cellX + xOffset}:${cellY + yOffset}`) || []));
    }
  }
  return candidates;
}

function groupPointsByCell(points, project, cellSizeKm) {
  const cells = new Map();
  for (const point of points) {
    const { x, y } = project(point);
    const cellX = Math.floor(x / cellSizeKm);
    const cellY = Math.floor(y / cellSizeKm);
    const key = `${cellX}:${cellY}`;
    const cell = cells.get(key) || { key, cellX, cellY, points: [], dates: new Set() };
    cell.points.push(point);
    cell.dates.add(point.date);
    cells.set(key, cell);
  }
  return cells;
}

function isInsideCore(point, coreKeys, project, cellSizeKm, bufferKm) {
  const { x, y } = project(point);
  const cellX = Math.floor(x / cellSizeKm);
  const cellY = Math.floor(y / cellSizeKm);
  const reach = Math.ceil((bufferKm + cellSizeKm) / cellSizeKm);
  for (let xOffset = -reach; xOffset <= reach; xOffset += 1) {
    for (let yOffset = -reach; yOffset <= reach; yOffset += 1) {
      const candidateX = cellX + xOffset;
      const candidateY = cellY + yOffset;
      if (!coreKeys.has(`${candidateX}:${candidateY}`)) continue;
      const centerX = (candidateX + 0.5) * cellSizeKm;
      const centerY = (candidateY + 0.5) * cellSizeKm;
      const cellHalfDiagonal = cellSizeKm * Math.SQRT2 / 2;
      if (Math.hypot(x - centerX, y - centerY) <= bufferKm + cellHalfDiagonal) return true;
    }
  }
  return false;
}

function countSpatialCells(points, project, cellSizeKm) {
  const cells = new Set();
  for (const point of points) {
    const { x, y } = project(point);
    cells.add(gridKey(x, y, cellSizeKm));
  }
  return cells.size;
}

function convexHullAreaKm2(points, project) {
  const projected = [...new Map(points.map((point) => {
    const value = project(point);
    return [`${value.x.toFixed(4)}:${value.y.toFixed(4)}`, value];
  })).values()];
  if (projected.length < 3) return 0;
  projected.sort((left, right) => left.x - right.x || left.y - right.y);
  const lower = [];
  for (const point of projected) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const point = projected[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let doubledArea = 0;
  for (let index = 0; index < hull.length; index += 1) {
    const current = hull[index];
    const next = hull[(index + 1) % hull.length];
    doubledArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(doubledArea) / 2;
}

function timeMinutes(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes;
}

function percentile(values, fraction) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = Math.max(0, Math.ceil(fraction * finite.length) - 1);
  return finite[index];
}

function cross(origin, left, right) {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

function localProjection(referenceLatitude) {
  const longitudeScale = 111.32 * Math.max(0.01, Math.cos(referenceLatitude * Math.PI / 180));
  return (point) => ({ x: point.longitude * longitudeScale, y: point.latitude * 110.574 });
}

function gridKey(x, y, cellSizeKm) {
  return `${Math.floor(x / cellSizeKm)}:${Math.floor(y / cellSizeKm)}`;
}

function findRoot(parents, index) {
  let current = index;
  while (parents[current] !== current) {
    parents[current] = parents[parents[current]];
    current = parents[current];
  }
  return current;
}

function union(parents, left, right) {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function maxFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? sum(finite) / finite.length : null;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function maxBy(values, selector) {
  let result = null;
  let maximum = -Infinity;
  for (const value of values) {
    const score = selector(value);
    if (Number.isFinite(score) && score > maximum) {
      maximum = score;
      result = value;
    }
  }
  return result;
}

function mostCommon(values) {
  if (values.length === 0) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
}

function shiftDate(date, amount) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
