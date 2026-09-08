import test from "node:test";
import assert from "node:assert/strict";
import { classifyEventBehavior, pixelAreaKm2 } from "../public/event-type.js";

function pass(overrides = {}) {
  return {
    date: "2026-08-29",
    time: "00:10",
    satellite: "N20",
    latitude: 60,
    longitude: 25,
    pixelCount: 6,
    radius95Km: 0.7,
    observedPixelAreaKm2: 0.85,
    frpDensityMwKm2: 140,
    ...overrides,
  };
}

function fire(overrides = {}) {
  return {
    kind: "fire",
    latitude: 60,
    longitude: 25,
    activeDates: ["2026-08-29", "2026-08-30"],
    analysisActiveDates: ["2026-08-29", "2026-08-30"],
    distinctSpatialCells: 7,
    footprintKm2: 1.4,
    overpasses: [
      pass(),
      pass({
        date: "2026-08-30",
        satellite: "N21",
        latitude: 60.01,
        longitude: 25.01,
        pixelCount: 8,
        radius95Km: 0.9,
      }),
      pass({ date: "2026-08-30", time: "01:10", satellite: "N20", latitude: 60.011, longitude: 25.012 }),
    ],
    ...overrides,
  };
}

test("pikseliala käyttää scan- ja track-mittoja ja nimellistä varalukua", () => {
  assert.equal(pixelAreaKm2({ scanKm: 0.5, trackKm: 0.4 }), 0.2);
  assert.equal(pixelAreaKm2({}), 0.375 * 0.375);
});

test("laaja geometria kuvaa levittäytymistä, mutta ei väitä maanpeitettä", () => {
  const result = classifyEventBehavior(fire());

  assert.equal(result.id, "wildland-like");
  assert.equal(result.confidence.level, "medium");
  assert.ok(result.label.includes("lämpötapahtuma"));
  assert.equal(result.usesSiteRegistry, false);
  assert.ok(result.supports.some((reason) => reason.includes("lämpösolua")));
  assert.ok(result.cautions.some((reason) => reason.includes("metsää")));
});

test("lyhyt ja pieni korkean intensiteetin rypäs jää kompaktiksi tapahtumaksi", () => {
  const result = classifyEventBehavior(fire({
    activeDates: ["2026-08-30"],
    analysisActiveDates: ["2026-08-30"],
    distinctSpatialCells: 3,
    footprintKm2: 0.08,
    overpasses: [pass({
      date: "2026-08-30",
      pixelCount: 3,
      radius95Km: 0.18,
      observedPixelAreaKm2: 0.42,
      frpDensityMwKm2: 320,
    })],
  }));

  assert.equal(result.id, "compact-transient");
  assert.equal(result.confidence.level, "low");
  assert.ok(result.candidate.includes("ympäristö arvioidaan erikseen"));
  assert.ok(result.cautions.some((reason) => reason.includes("ei voi erottaa")));
});

test("neljän päivän liikkuva kohde säilyttää laajan geometrian", () => {
  const result = classifyEventBehavior(fire({
    analysisActiveDates: ["2026-08-24", "2026-08-26", "2026-08-28", "2026-08-30"],
  }));

  assert.equal(result.id, "wildland-like");
  assert.ok(result.candidate.includes("ei eroteta pistekuviosta"));
});

test("pysyvä lähde luokitellaan käyttäytymisestä eikä kohderekisteristä", () => {
  const result = classifyEventBehavior({
    ...fire(),
    kind: "persistent-source",
    persistenceActiveDayCount: 12,
    persistenceWindowDays: 13,
    persistenceLevelStable: true,
    reliability: { level: "high", label: "vahva", reasons: [] },
  });

  assert.equal(result.id, "persistent-thermal-source");
  assert.equal(result.usesSiteRegistry, false);
  assert.ok(result.supports.some((reason) => reason.includes("12/13")));
  assert.ok(result.cautions.some((reason) => reason.includes("toimialaa")));
});

test("pysyvän lähteen paloepäily ei väitä kohteen käyttötarkoitusta", () => {
  const result = classifyEventBehavior({
    ...fire(),
    kind: "source-fire",
    persistenceActiveDayCount: 13,
    persistenceWindowDays: 13,
    confirmingPassCount: 2,
    currentOutsideCorePixels: 5,
    reliability: { level: "high", label: "vahva", reasons: [] },
  });

  assert.equal(result.id, "persistent-site-fire");
  assert.ok(result.cautions.some((reason) => reason.includes("jalostamo")));
  assert.ok(result.cautions.some((reason) => reason.includes("Räjähdettä")));
});
