import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  hashProviderScopeObservation,
  upsertProviderScopeObservations,
  type ProviderScopeObservationInput,
} from "./refresh-schedule-store";

const observation: ProviderScopeObservationInput = {
  providerKey: "TCGDEX",
  unitKey: "Pokemon/Card/Import",
  scopeKind: "expansion",
  sourceQueryKind: "expansions",
  languageCode: "EN",
  externalId: "sv04.5",
  label: "Paldean Fates",
  parents: ["sv"],
  imageUrl: null,
  metadata: {
    abbreviation: "PAF",
    releaseDate: "2024-01-26",
    provider: { source: "sets", revision: 1 },
  },
};

describe("Provider Scope Observation hash", () => {
  it("is stable across key and parent ordering differences", () => {
    expect(hashProviderScopeObservation(observation)).toBe(
      hashProviderScopeObservation({
        ...observation,
        parents: ["sv", "sv"],
        metadata: {
          releaseDate: "2024-01-26",
          abbreviation: "PAF",
          provider: { revision: 1, source: "sets" },
        },
      }),
    );
  });

  it("changes when provider evidence changes", () => {
    expect(hashProviderScopeObservation(observation)).not.toBe(
      hashProviderScopeObservation({
        ...observation,
        metadata: { ...observation.metadata, releaseDate: "2024-02-09" },
      }),
    );
  });
});

describe("Provider Scope Observation writer identity", () => {
  const padded: ProviderScopeObservationInput = {
    ...observation,
    externalId: "﻿ sv04.5 ",
    label: " Paldean Fates ",
    parents: [" sv ", "sv", ""],
    imageUrl: " https://images.example.test/paf.png ",
  };

  async function write(preserveRawIdentity?: boolean) {
    const inserts: (readonly unknown[])[] = [];
    const db = {
      async query(_sql: string, params: readonly unknown[] = []) {
        inserts.push(params);
        return { rows: [{ first_observed_at: new Date(0), inserted: true, changed: true }] };
      },
    } as unknown as PgQueryable;
    const [record] = await upsertProviderScopeObservations(db, {
      scanId: "job_writer_identity",
      scannedAt: new Date(0),
      observations: [padded],
      ...(preserveRawIdentity === undefined ? {} : { preserveRawIdentity }),
    });
    return { record: record!, params: inserts[0]! };
  }

  it("keeps default normalization for existing producers", async () => {
    for (const { record, params } of [await write(), await write(false)]) {
      expect(record).toMatchObject({
        providerKey: "tcgdex",
        unitKey: "pokemon/card/import",
        languageCode: "en",
        externalId: "sv04.5",
        label: "Paldean Fates",
        parents: ["sv"],
        imageUrl: "https://images.example.test/paf.png",
      });
      expect(params.slice(5, 9)).toEqual(["sv04.5", "Paldean Fates", '["sv"]', "https://images.example.test/paf.png"]);
      expect(record.observationHash).toBe(hashProviderScopeObservation(padded));
    }
  });

  it("writes provider text unchanged only when raw identity is requested", async () => {
    const { record, params } = await write(true);
    expect(record).toMatchObject({
      providerKey: "tcgdex",
      unitKey: "pokemon/card/import",
      languageCode: "en",
      externalId: "﻿ sv04.5 ",
      label: " Paldean Fates ",
      parents: [" sv ", "sv", ""],
      imageUrl: " https://images.example.test/paf.png ",
    });
    expect(params.slice(5, 9)).toEqual([
      "﻿ sv04.5 ",
      " Paldean Fates ",
      '[" sv ","sv",""]',
      " https://images.example.test/paf.png ",
    ]);
    expect(record.observationHash).not.toBe(hashProviderScopeObservation(padded));
  });
});
