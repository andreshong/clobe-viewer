// clobe returns dates as [year, month, day] and datetimes as
// [year, month, day, hour, minute, second] arrays (Java LocalDate/LocalDateTime
// serialization), not ISO strings. These convert them to Postgres-friendly
// "yyyy-MM-dd" / ISO datetime strings.

export function dateArrToISODate(arr: number[] | null | undefined): string | null {
  if (!arr || arr.length < 3) return null;
  const [y, m, d] = arr;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Builds the ISO string directly from the array's digits (tagged as "Z")
// instead of going through `new Date(y,m-1,d,...)`, which would interpret
// the digits in the Edge Function runtime's local timezone (not Korea's) and
// silently shift the stored instant. clobe's arrays are Korean wall-clock
// digits with no timezone info attached -- we preserve them verbatim and
// keep timezone-naive on both write (here) and read (frontend formats by
// string-slicing the ISO value, never via local Date getters).
export function dateTimeArrToISO(arr: number[] | null | undefined): string | null {
  if (!arr || arr.length < 3) return null;
  const [y, m, d, h = 0, mi = 0, s = 0] = arr;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p2(m)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}.000Z`;
}
