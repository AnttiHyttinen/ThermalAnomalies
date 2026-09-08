const dateFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "numeric",
  month: "numeric",
  timeZone: "UTC",
});

const weekdayFormatter = new Intl.DateTimeFormat("fi-FI", {
  weekday: "short",
  timeZone: "UTC",
});

export function formatDate(date) {
  return dateFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

export function shortWeekday(date) {
  return weekdayFormatter
    .format(new Date(`${date}T00:00:00.000Z`))
    .replace(/\.$/, "");
}

export function periodFrpPeak(profile, start, end) {
  let peak = null;
  for (const entry of profile || []) {
    if (entry.date < start || entry.date > end || !Number.isFinite(entry.peakPassFrp)) continue;
    if (!peak || entry.peakPassFrp > peak.frp || (entry.peakPassFrp === peak.frp && entry.date > peak.date)) {
      peak = { frp: entry.peakPassFrp, date: entry.date };
    }
  }
  return peak;
}
