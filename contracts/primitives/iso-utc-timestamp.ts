import type { Branded } from "./brand";

export type IsoUtcTimestamp = Branded<string, "IsoUtcTimestamp">;

// Accepts: 2026-02-23T21:26:00.123Z  (or without fractional seconds if you want)
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function parseIsoUtcTimestamp(s: string): IsoUtcTimestamp {
  if (!ISO_UTC_RE.test(s)) throw new Error("Not ISO-8601 UTC (Z) format");
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error("Invalid date");
  return s as IsoUtcTimestamp;
}

// Safe constructors
export function nowIsoUtcTimestamp(): IsoUtcTimestamp {
  return new Date().toISOString() as IsoUtcTimestamp; // always canonical UTC ISO
}

export function isoUtcFromDate(d: Date): IsoUtcTimestamp {
  return d.toISOString() as IsoUtcTimestamp;
}
