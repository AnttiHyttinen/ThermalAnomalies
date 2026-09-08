const NOMINAL_VIIRS_PIXEL_KM = 0.375;

export function pixelAreaKm2(point) {
  const scanKm = positiveNumber(point?.scanKm) ?? NOMINAL_VIIRS_PIXEL_KM;
  const trackKm = positiveNumber(point?.trackKm) ?? NOMINAL_VIIRS_PIXEL_KM;
  return scanKm * trackKm;
}

export function classifyEventBehavior(event) {
  const metrics = behaviorMetrics(event);

  if (event.kind === "source-unknown") return assessment({
    id: "persistent-unknown", label: "Pysyvä lähde · tila tuntematon",
    candidate: "Valitun päivän normaalitasoa tai poikkeamaa ei voida arvioida",
    confidence: confidence("low"), supports: compact([persistenceReason(event)]),
    cautions: commonSiteCautions(["Puuttuva havainto tai vertailuryhmä ei ole normaali lämpötaso"]), metrics,
  });

  if (event.kind === "source-fire") {
    return assessment({
      id: "persistent-site-fire",
      label: "Paloepäily pysyvän lämpölähteen ympärillä",
      candidate: "Paloepäily pysyvän lämpölähteen yhteydessä; kohteen käyttötarkoitus tuntematon",
      confidence: event.reliability,
      supports: compact([
        persistenceReason(event),
        event.confirmingPassCount >= 2
          ? `${event.confirmingPassCount} poikkeavaa ylilentoa laajeni normaalijalanjäljen ulkopuolelle`
          : null,
        event.currentOutsideCorePixels >= 2
          ? `${event.currentOutsideCorePixels} D0-pikseliä normaalijalanjäljen ulkopuolella`
          : null,
        event.changePoint
          ? `14 vuorokauden sarjassa havaittiin pysyvä muutoskohta ${event.changePoint.date}`
          : null,
      ]),
      cautions: commonSiteCautions([
        "Signaali ei kerro, onko kohde jalostamo, tehdas, varasto vai luonnollinen lämpölähde",
      ]),
      metrics,
    });
  }

  if (event.kind === "source-anomaly") {
    return assessment({
      id: "persistent-site-anomaly",
      label: "Poikkeava pysyvä lämpölähde",
      candidate: "Prosessilämmön muutos tai paikallinen palo ovat mahdollisia",
      confidence: event.reliability,
      supports: compact([
        persistenceReason(event),
        Number.isFinite(event.maxIntensityScore)
          ? `intensiteettipoikkeama ${formatNumber(event.maxIntensityScore)}`
          : null,
        Number.isFinite(event.maxExtentScore)
          ? `laajuuspoikkeama ${formatNumber(event.maxExtentScore)}`
          : null,
        event.changePoint
          ? `14 vuorokauden sarjassa havaittiin muutoskohta ${event.changePoint.date}`
          : null,
      ]),
      cautions: commonSiteCautions([
        "Spatiaalinen näyttö ei riitä erottamaan paloa normaalin toiminnan muutoksesta",
      ]),
      metrics,
    });
  }

  if (event.kind === "persistent-source") {
    return assessment({
      id: "persistent-thermal-source",
      label: "Pysyvä lämpölähde · havaittu taso normaali",
      candidate: "Vakaa prosessi-, soihtu- tai muu pistemäinen lämpölähde on mahdollinen",
      confidence: event.reliability,
      supports: compact([
        persistenceReason(event),
        event.persistenceLevelStable ? "lämpötaso ja paikallinen jalanjälki eivät poikkea normaalista" : null,
        metrics.centroidJitterKm <= 0.5
          ? `ylilentojen keskipistehajonta on pieni (${formatNumber(metrics.centroidJitterKm)} km)`
          : null,
      ]),
      cautions: commonSiteCautions([
        "Pysyvyys kuvaa lämpökäyttäytymistä, ei kohteen toimialaa",
      ]),
      metrics,
    });
  }

  if (metrics.analysisActiveDays >= 4 && metrics.maxRadius95Km <= 0.5 && metrics.maxCentroidStepKm <= 0.75 && event.footprintKm2 <= 0.35) {
    return assessment({
      id: "recurrent-uncertain",
      label: "Toistuva lämpökohde — tyyppi epäselvä",
      candidate: "Ajoittainen prosessilämpö, avopoltto tai monipäiväinen palo ovat mahdollisia",
      confidence: confidence(metrics.passCount >= 3 ? "medium" : "low"),
      supports: compact([
        `havaintoja ${metrics.analysisActiveDays} päivänä 14 vuorokaudesta`,
        metrics.passCount > 0 ? `${metrics.passCount} erillistä ylilentoa` : null,
        "9/13-pysyvyysraja ei täyty",
      ]),
      cautions: commonSiteCautions([
        "Toistuvuus estää kohteen automaattisen nimeämisen maastopaloksi",
      ]),
      metrics,
    });
  }

  const compactTransient = (
    metrics.analysisActiveDays <= 2 &&
    metrics.maxPassPixelCount <= 3 &&
    metrics.maxRadius95Km <= 0.5 &&
    event.distinctSpatialCells <= 3 &&
    event.footprintKm2 <= 0.35
  );
  if (compactTransient) {
    const level = metrics.passCount >= 2 && metrics.satelliteCount >= 2 ? "medium" : "low";
    return assessment({
      id: "compact-transient",
      label: "Kompakti kertaluonteinen lämpötapahtuma",
      candidate: "Pieni paikallinen palo tai muu lämpölähde; ympäristö arvioidaan erikseen",
      confidence: confidence(level),
      supports: compact([
        `enintään ${metrics.maxPassPixelCount} lämpöpikseliä samalla ylilennolla`,
        `suurin r95-säde ${formatNumber(metrics.maxRadius95Km)} km`,
        `${metrics.analysisActiveDays} havaintopäivää 14 vuorokaudesta`,
        metrics.maxFrpDensityMwKm2 >= 120
          ? `lämpöteho on keskittynyt pienelle havaintopikselialalle (${formatNumber(metrics.maxFrpDensityMwKm2)} MW/km²)`
          : null,
      ]),
      cautions: commonSiteCautions([
        "Rakennuspaloa ei voi erottaa pienestä maasto- tai teollisuuspalosta ilman maanpeite- tai kohdetietoa",
      ]),
      metrics,
    });
  }

  const spatiallyBroad = (
    event.distinctSpatialCells >= 4 &&
    (event.footprintKm2 >= 0.6 || metrics.maxRadius95Km >= 0.55 || metrics.maxPassPixelCount >= 5)
  );
  const movingFront = (
    metrics.analysisActiveDays >= 2 &&
    metrics.passCount >= 2 &&
    metrics.maxCentroidStepKm >= 0.75
  );
  if (spatiallyBroad || movingFront) {
    const level = (
      metrics.analysisActiveDays >= 2 &&
      metrics.passCount >= 3 &&
      metrics.satelliteCount >= 2 &&
      (movingFront || event.footprintKm2 >= 1)
    ) ? "high" : metrics.passCount >= 2 ? "medium" : "low";
    return assessment({
      id: "wildland-like",
      label: "Laaja tai siirtyvä lämpötapahtuma",
      candidate: "Palomainen geometria; maastoa ja rakennettua ympäristöä ei eroteta pistekuviosta",
      confidence: confidence(level === "high" ? "medium" : level),
      supports: compact([
        `${event.distinctSpatialCells} erillistä 500 metrin lämpösolua`,
        event.footprintKm2 >= 0.6
          ? `ryppään geometrinen jalanjälki ${formatNumber(event.footprintKm2)} km²`
          : null,
        metrics.maxPassPixelCount >= 5
          ? `samalla ylilennolla enimmillään ${metrics.maxPassPixelCount} lämpöpikseliä`
          : null,
        movingFront
          ? `päivittäinen lämpökeskipiste siirtyi enimmillään ${formatNumber(metrics.maxCentroidStepKm)} km`
          : null,
        metrics.satelliteCount >= 2
          ? `havainto vahvistui ${metrics.satelliteCount} VIIRS-satelliitilla`
          : null,
      ]),
      cautions: commonSiteCautions([
        "FIRMS ei yksin erottele metsää, ruohikkoa, pensastoa ja viljelysmaata",
        "Laaja rakennus- tai teollisuuspalo voi tuottaa samanlaisen monipikselisen kuvion",
      ]),
      metrics,
    });
  }

  return assessment({
    id: "unresolved-fire",
    label: "Lämpötapahtuma · ympäristö tuntematon",
    candidate: "Maasto-, rakennus- tai teollisuuspalo ovat kaikki mahdollisia",
    confidence: confidence("low"),
    supports: compact([
      `${event.distinctSpatialCells} lämpösolua`,
      `${metrics.passCount} erillistä ylilentoa`,
      "kohde ei täytä 9/13-pysyvyysehtoa",
    ]),
    cautions: commonSiteCautions([
      "Geometria ei ole riittävän kompakti eikä riittävän leviävä tarkempaan käyttäytymisluokkaan",
    ]),
    metrics,
  });
}

function behaviorMetrics(event) {
  const passes = [...(event.overpasses || [])].sort((left, right) => (
    `${left.date}T${left.time}`.localeCompare(`${right.date}T${right.time}`)
  ));
  const center = passes.length > 0 ? {
    latitude: passes.reduce((total, pass) => total + pass.latitude, 0) / passes.length,
    longitude: passes.reduce((total, pass) => total + pass.longitude, 0) / passes.length,
  } : { latitude: event.latitude ?? 0, longitude: event.longitude ?? 0 };
  const dailyPasses = new Map();
  for (const pass of passes) {
    const entries = dailyPasses.get(pass.date) || [];
    entries.push(pass);
    dailyPasses.set(pass.date, entries);
  }
  let maxCentroidStepKm = 0;
  const previousBySensor = new Map();
  for (const pass of passes) {
    const key = `${pass.satellite}/${pass.daynight}`;
    const previous = previousBySensor.get(key);
    if (previous && previous.date !== pass.date) maxCentroidStepKm = Math.max(maxCentroidStepKm, haversineKm(previous, pass));
    previousBySensor.set(key, pass);
  }
  const centroidDistances = passes.map((pass) => haversineKm(center, pass));
  return {
    analysisActiveDays: new Set(event.analysisActiveDates || event.activeDates || []).size,
    passCount: passes.length,
    satelliteCount: new Set(passes.map((pass) => pass.satellite).filter(Boolean)).size,
    maxPassPixelCount: maximum(passes.map((pass) => pass.pixelCount)),
    maxRadius95Km: maximum(passes.map((pass) => pass.radius95Km)),
    maxObservedPixelAreaKm2: maximum(passes.map((pass) => pass.observedPixelAreaKm2)),
    maxFrpDensityMwKm2: maximum(passes.map((pass) => pass.frpDensityMwKm2)),
    maxCentroidStepKm,
    centroidJitterKm: median(centroidDistances),
  };
}

function assessment({ id, label, candidate, confidence: evidence, supports, cautions, metrics }) {
  return {
    id,
    label,
    candidate,
    confidence: evidence || confidence("low"),
    supports,
    cautions,
    metrics,
    basis: "VIIRS-aika–tila-käyttäytyminen",
    usesSiteRegistry: false,
  };
}

function persistenceReason(event) {
  return Number.isFinite(event.persistenceActiveDayCount)
    ? `sama paikallinen lämpöydin näkyi ${event.persistenceActiveDayCount}/${event.persistenceWindowDays} vertailupäivänä`
    : null;
}

function commonSiteCautions(extra = []) {
  return compact([
    ...extra,
    "Kohteen nimeä tai käyttötarkoitusta ei ole haettu mistään rekisteristä",
    "Räjähdettä tai räjähdevarastoa ei voi tunnistaa lämpöpisteistä",
  ]);
}

function confidence(level) {
  return {
    level,
    label: level === "high" ? "vahva" : level === "medium" ? "kohtalainen" : "rajallinen",
    reasons: [],
  };
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function compact(values) {
  return values.filter(Boolean);
}

function maximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : 0;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

function haversineKm(left, right) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const value = (
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  );
  return 2 * 6371.0088 * Math.asin(Math.sqrt(value));
}

function formatNumber(value) {
  return Number(value).toFixed(value >= 10 ? 0 : 1).replace(".", ",");
}
