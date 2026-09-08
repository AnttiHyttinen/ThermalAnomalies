import test from "node:test";
import assert from "node:assert/strict";
import { formatDate, shortWeekday, periodFrpPeak } from "../public/format.js";

test("formatDate säilyttää suomalaisen päivämäärän pisteet", () => {
  assert.equal(formatDate("2026-08-29"), "29.8.");
});

test("shortWeekday ei jätä lyhenteen loppupistettä", () => {
  assert.equal(shortWeekday("2026-08-29"), "la");
});

test("jakson huippu löytyy myös ilman D0-havaintoa ja yli seitsemän päivän takaa", () => {
  const profile = [
    { date: "2026-08-16", peakPassFrp: 999 },
    { date: "2026-08-20", peakPassFrp: 120 },
    { date: "2026-08-28", peakPassFrp: 40 },
    { date: "2026-08-30", peakPassFrp: null },
    { date: "2026-08-31", peakPassFrp: 999 },
  ];
  assert.deepEqual(periodFrpPeak(profile, "2026-08-17", "2026-08-30"), { frp: 120, date: "2026-08-20" });
});

test("tasahuipun viimeisin päivä, mitattu nolla ja puuttuva FRP erotetaan", () => {
  assert.deepEqual(periodFrpPeak([
    { date: "2026-08-29", peakPassFrp: 120 },
    { date: "2026-08-28", peakPassFrp: 120 },
  ], "2026-08-17", "2026-08-30"), { frp: 120, date: "2026-08-29" });
  assert.deepEqual(periodFrpPeak([{ date: "2026-08-30", peakPassFrp: 0 }], "2026-08-17", "2026-08-30"), { frp: 0, date: "2026-08-30" });
  assert.equal(periodFrpPeak([{ date: "2026-08-30", peakPassFrp: null }], "2026-08-17", "2026-08-30"), null);
});
