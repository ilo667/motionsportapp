// A training day is a date, not a moment: format noon UTC in UTC so every browser time zone shows the same day
const noon = (localDate: string) => new Date(`${localDate}T12:00:00Z`);

// 'YYYY-MM-DD' in Kyiv whatever the browser's zone; compare training days with it as strings
export const kyivToday = (now = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

// "27.10" from 'YYYY-MM-DD' or an ISO time
export const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

// "понеділок, 27 жовтня"
export function longDay(localDate: string) {
  return new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    noon(localDate),
  );
}

// "27 жовт."
export function shortDay(localDate: string) {
  return new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", timeZone: "UTC" }).format(noon(localDate));
}

// "20 жовт., 15:02" in Kyiv time, for a moment from the API
export function kyivDateTime(iso: string) {
  return new Intl.DateTimeFormat("uk-UA", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Kyiv",
  }).format(new Date(iso));
}
