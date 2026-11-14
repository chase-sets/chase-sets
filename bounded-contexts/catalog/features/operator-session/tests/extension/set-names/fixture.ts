import type { TcgplayerSetNameEntry } from "../../../domain/extension/set-names/contract";
import type { SetNamesRequestResult } from "../../../domain/extension/set-names/probe";

export const observedAt = "2026-10-28T13:42:00.953Z";
export const entry = (overrides: Partial<TcgplayerSetNameEntry> = {}): TcgplayerSetNameEntry => ({
  setNameId: 1,
  categoryId: 3,
  name: "Synthetic Pokemon",
  cleanSetName: "Synthetic Pokemon",
  urlName: "synthetic-pokemon",
  abbreviation: null,
  releaseDate: "2024-02-29T23:59:59",
  isSupplemental: false,
  active: true,
  ...overrides,
});
export const response = (
  body: unknown = { errors: [], results: [entry()] },
  overrides: Partial<SetNamesRequestResult> = {},
): SetNamesRequestResult => ({
  ok: true,
  status: 200,
  contentClass: "json",
  bytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
  body,
  ...overrides,
});
export const post = () => ({ contractVersion: 1 as const, productLineId: 3, observedAt, sets: [entry()] });
export const counts = { observationCount: 1, newObservationCount: 1, mappingsProposed: 0 };

export function largestPostSets() {
  return Array.from({ length: 5_000 }, (_, index) =>
    entry({ setNameId: index + 1, name: "a".repeat(128), cleanSetName: `synthetic-${index}`, urlName: "u".repeat(32) }),
  );
}
