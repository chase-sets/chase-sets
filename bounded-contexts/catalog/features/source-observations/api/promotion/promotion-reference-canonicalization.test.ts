import { describe, expect, it } from "vitest";
import type { CatalogItemId } from "../../../../ids";
import { normalizedObservation } from "../../../../support/test-support/source-observation-fixtures";
import { decideCatalogItem, evolveCatalogItem, initialCatalogItemState } from "../../../catalog-items/domain/domain";
import {
  decideSourceObservation,
  initialSourceObservationState,
  normalizeSourceObservationNaturalKeys,
  sourceObservationLinkExternalKey,
} from "../../domain/domain";
import { SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES } from "../../domain/source-observation-payload-chunks";
import {
  canonicalPromotionReferencePairs,
  canonicalPromotionReferenceText as canonical,
  canonicalPromotionSourceLinkText,
  promotionReferenceCasingDataHash,
  promotionReferenceFunctionMarker,
  promotionReferenceFunctionStatements,
  promotionReferenceFunctions,
  promotionReferenceParityCorpus,
  promotionReferenceTrimCharacters,
  promotionReferenceUnicodeVersion,
  requirePromotionReferenceRuntime,
} from "./promotion-reference-canonicalization";
import {
  promotionCaseIgnorableRanges,
  promotionCasedRanges,
  promotionLowercaseRanges,
} from "./promotion-reference-casing-data";
import {
  catalogPromotionReferenceAccessPathMigrations,
  promotionReferenceExpressions,
  promotionReferenceIndexes,
  promotionReferenceKeyBoundedQueries,
} from "./promotion-target-indexes";

const recordCommand = {
  type: "RecordSourceObservation",
  observationId: "tcgdex_en_swsh3_136",
  providerKey: " TCGdex ",
  externalKey: " SWSH3-136 ",
  sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
  languageCode: "EN-us",
  sourceRecordHash: "hash",
  sourceUpdatedAt: null,
  observedAt: "2026-05-15T00:00:00.000Z",
  sourceProfileKey: "pokemon-tcg",
  sourceProfileVersion: "2026.06.03",
  sourceMappingFingerprint: "mapping-fingerprint",
  normalized: normalizedObservation({
    externalCatalogItemReferences: [{ providerKey: " TCGdex ", externalKey: " SWSH3-136 " }],
    externalProductReferences: [
      { providerKey: "TCGplayer", externalKey: "İΣ Product ", selectedOptions: [] },
      { providerKey: "scrydex", externalKey: "﻿Same-Key﻿" },
    ],
  }),
  sourcePayload: { id: "swsh3-136" },
} as const;

describe("pinned promotion reference identity", () => {
  it("pins the supported runtime's Unicode version", () => {
    expect(process.versions.unicode).toBe(promotionReferenceUnicodeVersion);
    expect(() => requirePromotionReferenceRuntime()).not.toThrow();
    expect(() => requirePromotionReferenceRuntime("16.0")).toThrow("promotion-reference-casing-runtime-drift");
    expect(promotionReferenceFunctionMarker).toContain(`unicode ${promotionReferenceUnicodeVersion}`);
    expect(promotionReferenceFunctionMarker).toContain(promotionReferenceCasingDataHash);
    expect(promotionReferenceCasingDataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the runtime's complete scalar casing and context-property corpus", () => {
    const mapped = new Map<number, string>();
    for (const [first, last, stride, delta] of promotionLowercaseRanges)
      for (let point = first; point <= last; point += stride) mapped.set(point, String.fromCodePoint(point + delta));
    mapped.set(0x130, "i̇");
    const cased = new Set<number>();
    const ignorable = new Set<number>();
    for (const [first, last] of promotionCasedRanges) for (let point = first; point <= last; point++) cased.add(point);
    for (const [first, last] of promotionCaseIgnorableRanges)
      for (let point = first; point <= last; point++) ignorable.add(point);
    for (let point = 1; point <= 0x10ffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const value = String.fromCodePoint(point);
      if (
        value.toLowerCase() !== (mapped.get(point) ?? value) ||
        /\p{Cased}/u.test(value) !== cased.has(point) ||
        /\p{Case_Ignorable}/u.test(value) !== ignorable.has(point)
      )
        throw new Error(`promotion-reference-corpus-drift:U+${point.toString(16)}`);
    }
    for (const character of promotionReferenceTrimCharacters) {
      expect(`${character}x${character}`.trim()).toBe("x");
    }
    expect("᠎x​".trim()).toBe("᠎x​");
  });

  it.each(promotionReferenceParityCorpus)("canonicalizes $label byte-for-byte", ({ value, canonical: expected }) => {
    expect(canonical(value)).toBe(expected);
    expect(canonical(value)).toBe(value.trim().toLowerCase());
    expect(canonical(expected)).toBe(expected);
    expect(Buffer.from(canonical(value), "utf8").equals(Buffer.from(expected, "utf8"))).toBe(true);
  });

  it.each(promotionReferenceParityCorpus)("matches both item-domain reference levels for $label", ({ value }) => {
    const created = decideCatalogItem(initialCatalogItemState, {
      type: "CreateCatalogItem",
      itemId: "cat_identity_control" as CatalogItemId,
      languageCode: "en",
      title: { defaultLocale: "en", values: { en: "Synthetic identity control" } },
    });
    const initial = created.reduce(evolveCatalogItem, initialCatalogItemState);
    for (const type of ["LinkExternalCatalogItemReference", "LinkExternalProductReference"] as const) {
      const events = decideCatalogItem(initial, { type, providerKey: " MixedProvider ", externalKey: value });
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        providerKey: canonical(" MixedProvider "),
        externalKey: canonical(value),
      });
    }
  });

  it("keeps level and pairing over mapper-derived source headers, inline and chunked", () => {
    const expected = {
      externalCatalogItemReferences: [{ providerKey: "tcgdex", externalKey: "swsh3-136" }],
      externalProductReferences: [
        { providerKey: "tcgplayer", externalKey: "i̇ς product" },
        { providerKey: "scrydex", externalKey: "same-key" },
      ],
    };
    expect(canonicalPromotionReferencePairs(recordCommand.normalized)).toEqual(expected);
    expect(canonicalPromotionReferencePairs(normalizeSourceObservationNaturalKeys(recordCommand.normalized))).toEqual(
      expected,
    );
    const inline = decideSourceObservation(initialSourceObservationState, recordCommand);
    expect(inline).toHaveLength(1);
    const chunked = decideSourceObservation(initialSourceObservationState, {
      ...recordCommand,
      sourcePayload: { id: "swsh3-136", blob: "x".repeat(SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES + 1) },
    });
    expect(chunked.length).toBeGreaterThan(1);
    expect(chunked[0].type).toBe("catalog.source-observation.recorded");
    for (const header of [inline[0], chunked[0]]) {
      const data = header.data as {
        normalized: unknown;
        providerKey: string;
        externalKey: string;
        languageCode: string;
      };
      expect(canonicalPromotionReferencePairs(data.normalized)).toEqual(expected);
      expect(data.normalized).toMatchObject({
        externalProductReferences: [{ externalKey: "İΣ Product" }, { externalKey: "Same-Key" }],
      });
      expect(canonicalPromotionSourceLinkText(data.languageCode, data.externalKey)).toBe("en-us:swsh3-136");
      expect(canonicalPromotionSourceLinkText(data.languageCode, data.externalKey)).toBe(
        canonical(sourceObservationLinkExternalKey(data.languageCode, data.externalKey)),
      );
    }
    expect(
      canonicalPromotionReferencePairs({ externalCatalogItemReferences: [{ providerKey: 1, externalKey: "x" }, "y"] }),
    ).toEqual({
      externalCatalogItemReferences: [],
      externalProductReferences: [],
    });
    expect(canonicalPromotionReferencePairs("[]")).toEqual({
      externalCatalogItemReferences: [],
      externalProductReferences: [],
    });
    expect(canonical("İ").repeat(2)).not.toBe(canonical("i"));
    expect(canonical("ß")).not.toBe(canonical("ss"));
    expect(canonical("É")).not.toBe(canonical("É"));
  });

  it("ships functions before concurrent indexes in one restartable ledger entry", () => {
    expect(catalogPromotionReferenceAccessPathMigrations).toHaveLength(1);
    const [migration] = catalogPromotionReferenceAccessPathMigrations;
    expect(migration.migrationId).toBe("20261010_catalog_promotion_reference_access_paths_v1");
    expect(migration.statements[0]).toMatch(/^SET lock_timeout = '5s';$/);
    const functionEnd = 1 + promotionReferenceFunctionStatements.length;
    expect(migration.statements.slice(1, functionEnd)).toEqual(promotionReferenceFunctionStatements);
    expect(promotionReferenceFunctionStatements.join("\n")).not.toMatch(/CREATE OR REPLACE/i);
    for (const fn of promotionReferenceFunctions) {
      expect(fn.body).not.toMatch(/\blower\s*\(/i);
      expect(fn.body).not.toMatch(/\bcollate\b/i);
      expect(promotionReferenceFunctionStatements.join("\n")).toContain(`'${fn.name}(${fn.input})'`);
    }
    const indexStatements = migration.statements.slice(functionEnd);
    expect(indexStatements).toHaveLength(promotionReferenceIndexes.length * 3);
    for (const [offset, index] of promotionReferenceIndexes.entries()) {
      const [repair, create, verify] = indexStatements.slice(offset * 3, offset * 3 + 3);
      expect(repair).toContain("NOT i.indisvalid");
      expect(repair).toContain(`DROP INDEX ${index.name}`);
      expect(create).toMatch(new RegExp(`^CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name}\\n`));
      expect(create).toContain(`USING ${index.method} ${index.columns}`);
      expect(create).toContain(`WHERE ${index.predicate}`);
      expect(create).not.toMatch(/UNIQUE/);
      expect(verify).toContain("i.indisvalid AND i.indisready");
      expect(verify).toContain(`catalog-promotion-reference-index-conflict:${index.name}`);
      expect(index.definition).toMatch(/^USING (btree|gin) \(/);
      expect(index.name).toMatch(/_v1_idx$/);
    }
    expect(promotionReferenceIndexes.map((index) => index.family)).toEqual([
      "item-reference",
      "product-reference",
      "source-header",
      "source-link",
    ]);
    for (const level of ["item", "product"] as const) {
      const query = promotionReferenceKeyBoundedQueries.itemReference(level);
      expect(query).toContain(promotionReferenceIndexes[level === "item" ? 0 : 1].predicate);
      expect(query).toContain(`${promotionReferenceExpressions.providerKey} = $1`);
      expect(query).toContain(`${promotionReferenceExpressions.externalKey} = $2`);
    }
    expect(promotionReferenceKeyBoundedQueries.sourceHeader).toContain(
      `${promotionReferenceExpressions.sourcePairs} @> $1::jsonb`,
    );
    expect(promotionReferenceKeyBoundedQueries.sourceLink).toContain(
      `${promotionReferenceExpressions.sourceLink} = $2`,
    );
    expect(promotionReferenceExpressions.sourceLink).toContain(
      `btrim(payload->>'externalKey', '${promotionReferenceTrimCharacters}')`,
    );
  });
});
