export const FIRMS_SOURCES = [
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_NRT",
];

export function utcDateString(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

export function addUtcDays(dateString, amount) {
  const value = new Date(`${dateString}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return utcDateString(value);
}

export function validateSelectedDate(value, today = utcDateString()) {
  if (value === null || value === undefined) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || utcDateString(`${value}T00:00:00Z`) !== value || value > today || value < "2012-01-20") {
    throw Object.assign(new Error("Valitse kelvollinen päivä väliltä 20.1.2012–tänään (UTC). Aineiston saatavuus vaihtelee satelliiteittain."), { code: "INVALID_DATE", status: 400 });
  }
  return value;
}

export function sevenDaySegments(today = utcDateString()) {
  return observationSegments(today, 7);
}

export function fourteenDaySegments(today = utcDateString()) {
  return observationSegments(today, 14);
}

export function observationSegments(today, totalDays) {
  if (!Number.isInteger(totalDays) || totalDays < 1) {
    throw new RangeError("Havaintojakson pituuden pitää olla positiivinen kokonaisluku.");
  }
  const start = addUtcDays(today, -(totalDays - 1));
  const segments = [];
  let offset = 0;
  while (offset < totalDays) {
    const days = Math.min(5, totalDays - offset);
    segments.push({ start: addUtcDays(start, offset), days });
    offset += days;
  }
  return segments;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      value = "";
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
    } else {
      value += character;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => Object.fromEntries(
    headers.map((header, index) => [header, (cells[index] ?? "").trim()]),
  ));
}

export function validateArea(searchParams) {
  const names = ["west", "south", "east", "north"];
  const values = Object.fromEntries(names.map((name) => [name, Number(searchParams.get(name))]));

  if (names.some((name) => !searchParams.get(name)?.trim() || !Number.isFinite(values[name]))) {
    throw Object.assign(new Error("Kartta-alue puuttuu tai on virheellinen."), {
      code: "INVALID_AREA",
      status: 400,
    });
  }

  const { west, south, east, north } = values;
  if (
    west < -180 || east > 180 || south < -85 || north > 85 ||
    west >= east || south >= north
  ) {
    throw Object.assign(new Error("Kartta-alue ei ole sallituissa rajoissa."), {
      code: "INVALID_AREA",
      status: 400,
    });
  }

  if (east - west > 30 || north - south > 22) {
    throw Object.assign(new Error("Lähennä karttaa ennen havaintojen hakua."), {
      code: "AREA_TOO_LARGE",
      status: 400,
    });
  }

  return { west, south, east, north };
}

export function areaKey(area) {
  return [area.west, area.south, area.east, area.north]
    .map((value) => Number(value).toFixed(4))
    .join(",");
}

export function normalizeDetection(row, source) {
  const latitude = finiteOrNull(row.latitude);
  const longitude = finiteOrNull(row.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !/^\d{4}-\d{2}-\d{2}$/.test(row.acq_date || "") || !Number.isFinite(Date.parse(row.acq_date)) || utcDateString(row.acq_date) !== row.acq_date) {
    return null;
  }

  const rawTime = String(row.acq_time ?? "").trim().padStart(4, "0");
  const timeValid = row.acq_time !== undefined && String(row.acq_time).trim() !== "" && /^\d{4}$/.test(rawTime) && Number(rawTime.slice(0, 2)) < 24 && Number(rawTime.slice(2)) < 60;
  return {
    id: [
      source,
      row.acq_date,
      rawTime,
      latitude.toFixed(5),
      longitude.toFixed(5),
    ].join(":"),
    latitude,
    longitude,
    date: row.acq_date,
    time: timeValid ? `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}` : null,
    satellite: row.satellite || source.replace("VIIRS_", "").replace("_NRT", ""),
    confidence: String(row.confidence || "").toLowerCase(),
    frp: finiteOrNull(row.frp) >= 0 ? finiteOrNull(row.frp) : null,
    brightness: finiteOrNull(row.bright_ti4 ?? row.brightness),
    brightnessChannel: source.startsWith("MODIS") ? "MODIS 21/22" : "VIIRS I4",
    instrument: source.startsWith("MODIS") ? "MODIS" : "VIIRS",
    scanKm: finiteOrNull(row.scan),
    trackKm: finiteOrNull(row.track),
    hotspotType: hotspotTypeOrNull(row.type),
    daynight: row.daynight ? String(row.daynight).toUpperCase() : null,
    source,
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hotspotTypeOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 3 ? number : null;
}

export function deduplicateDetections(detections) {
  const unique = new Map();
  for (const detection of detections) {
    if (!detection) {
      continue;
    }
    unique.set(detection.id, detection);
  }
  return [...unique.values()].sort((left, right) => (
    left.date.localeCompare(right.date) || String(left.time || "").localeCompare(String(right.time || ""))
  ));
}

export function buildFirmsUrl({ mapKey, source, area, start, days }) {
  const coordinates = [area.west, area.south, area.east, area.north]
    .map((value) => Number(value).toFixed(4))
    .join(",");
  return [
    "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
    encodeURIComponent(mapKey),
    source,
    coordinates,
    String(days),
    start,
  ].join("/");
}

export function isLikelyMapKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.trim());
}
