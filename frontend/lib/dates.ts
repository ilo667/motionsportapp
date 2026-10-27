// A training day ('YYYY-MM-DD') is a date, not a moment: noon UTC formatted in UTC, so the date is the same in any
// browser (local noon formatted in Kyiv time is the next day in a browser at UTC−10)
const noon = (localDate: string) => new Date(`${localDate}T12:00:00Z`);

// «27.10» from 'YYYY-MM-DD' (or an ISO time starting with it)
export const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

// «понеділок, 27 жовтня»
export function longDay(localDate: string) {
  return new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    noon(localDate),
  );
}

// «27 жовт.»
export function shortDay(localDate: string) {
  return new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", timeZone: "UTC" }).format(noon(localDate));
}

// «20 жовт., 15:02» in Kyiv time, for a moment from the API (when it was paid, changed, cancelled)
export function kyivDateTime(iso: string) {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Kyiv",
  }).format(new Date(iso));
}
