/**
 * Demo clock. "Today" is fixed to 2026-09-03 (a Thursday) so mock data and slot
 * logic are deterministic. Override with NOW=YYYY-MM-DD (or a full ISO string)
 * for tests and manual runs. All arithmetic is UTC-day based.
 *
 * Inputs: pass ISO strings ("2026-09-08", or a full timestamp with its zone) or Dates
 * built in UTC (today(), addDays, Date.UTC). A Date is read by its UTC parts, so one built
 * from local calendar parts (new Date(2026, 8, 8)) in a zone east of UTC labels the
 * previous day. Never pass such a Date; never pass new Date() for "now", use today().
 *
 * Labels take the session language: English by default, Turkish weekday and month names
 * for "tr" ("Cuma 4 Eylül 2026"), same word order in both.
 */
import { DEFAULT_LANG, type Lang } from "./lang";

export const DEFAULT_TODAY_ISO = "2026-09-03";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAYS_TR = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"] as const;
const MONTHS_TR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"] as const;

/** Weekday names per language, Sunday first (Date.getUTCDay order). */
export const WEEKDAY_NAMES: Record<Lang, readonly string[]> = { en: WEEKDAYS, tr: WEEKDAYS_TR };
/** Month names per language, January first. */
export const MONTH_NAMES: Record<Lang, readonly string[]> = { en: MONTHS, tr: MONTHS_TR };

const DAY_MS = 86_400_000;

export function parseIsoDate(value: string): Date | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** UTC midnight of the day the value falls on. A Date is read by its UTC parts (see the header). */
export function toDate(value: Date | string): Date {
  if (value instanceof Date) return startOfUtcDay(value);
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`Invalid date: ${value}`);
  return startOfUtcDay(parsed);
}

/** Returns "today" at UTC midnight. Reads NOW on every call so tests can override it. */
export function today(): Date {
  const override = process.env.NOW ? parseIsoDate(process.env.NOW) : undefined;
  return startOfUtcDay(override ?? new Date(`${DEFAULT_TODAY_ISO}T00:00:00.000Z`));
}

/** "2026-09-08" for the UTC day of the input (a Date is read in UTC, see the header). */
export function isoDate(d: Date | string): string {
  return toDate(d).toISOString().slice(0, 10);
}

export function addDays(d: Date | string, n: number): Date {
  const r = toDate(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: Date | string, to: Date | string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS);
}

/** English weekday name by default; the Turkish one ("Cuma") with lang "tr". */
export function weekdayName(d: Date | string): Weekday;
export function weekdayName(d: Date | string, lang: Lang): string;
export function weekdayName(d: Date | string, lang: Lang = DEFAULT_LANG): string {
  return WEEKDAY_NAMES[lang][toDate(d).getUTCDay()];
}

export function monthName(d: Date | string): (typeof MONTHS)[number];
export function monthName(d: Date | string, lang: Lang): string;
export function monthName(d: Date | string, lang: Lang = DEFAULT_LANG): string {
  return MONTH_NAMES[lang][toDate(d).getUTCMonth()];
}

/**
 * "Tuesday 8 September 2026", or "Salı 8 Eylül 2026" with lang "tr". The one place a spoken
 * date label is produced. Every tool result that carries a date also carries this label, so
 * the model reads weekdays instead of computing them (a model once said "Monday the 8th of
 * September" for a Tuesday).
 * A Date input is read by its UTC parts: pass ISO strings or UTC-built Dates only, never a
 * Date built from local calendar parts (see the header).
 */
export function humanDate(d: Date | string, lang: Lang = DEFAULT_LANG): string {
  const day = toDate(d);
  return `${WEEKDAY_NAMES[lang][day.getUTCDay()]} ${day.getUTCDate()} ${MONTH_NAMES[lang][day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

export function isSunday(d: Date | string): boolean {
  return toDate(d).getUTCDay() === 0;
}
