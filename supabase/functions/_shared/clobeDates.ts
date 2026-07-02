// clobe returns dates as [year, month, day] and datetimes as
// [year, month, day, hour, minute, second] arrays (Java LocalDate/LocalDateTime
// serialization), not ISO strings. These convert them to Postgres-friendly
// "yyyy-MM-dd" / ISO datetime strings.

export function dateArrToISODate(arr: number[] | null | undefined): string | null {
  if (!arr || arr.length < 3) return null;
  const [y, m, d] = arr;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function dateTimeArrToISO(arr: number[] | null | undefined): string | null {
  if (!arr || arr.length < 3) return null;
  const [y, m, d, h = 0, mi = 0, s = 0] = arr;
  return new Date(y, m - 1, d, h, mi, s).toISOString();
}
