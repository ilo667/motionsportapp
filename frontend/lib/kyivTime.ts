// "14:00" in Kyiv time for an ISO moment from the API
export function kyivTime(iso: string): string {
  return new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}
