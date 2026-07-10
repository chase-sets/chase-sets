import { describe, expect, it } from "vitest";
import type { ReferenceRecordRef } from "../../../support/item-support/reference-records";
import { extractStructuredCardNumber, extractStructuredSetCode } from "./natural-key-extraction";

function referenceRecord(overrides: Partial<ReferenceRecordRef>): ReferenceRecordRef {
  return {
    referenceId: "ref_1",
    typeKey: "set",
    key: "some-key",
    name: "Some Set",
    attributes: {},
    relationships: [],
    status: "active",
    ...overrides,
  };
}

describe("extractStructuredCardNumber", () => {
  it("reads the field whose definition key is card-number, normalized", () => {
    const cardNumber = extractStructuredCardNumber(
      [
        { fieldId: "fld_rarity", value: "Rare" },
        { fieldId: "fld_card_number", value: "0136" },
      ],
      new Map([
        ["fld_rarity", { key: "rarity" }],
        ["fld_card_number", { key: "card-number" }],
      ]),
    );

    expect(cardNumber).toBe("136");
  });

  it("returns null when no field maps to the card-number key", () => {
    const cardNumber = extractStructuredCardNumber(
      [{ fieldId: "fld_rarity", value: "Rare" }],
      new Map([["fld_rarity", { key: "rarity" }]]),
    );

    expect(cardNumber).toBeNull();
  });

  it("returns null when the field is unresolved (not a filterable field definition)", () => {
    const cardNumber = extractStructuredCardNumber([{ fieldId: "fld_card_number", value: "12" }], new Map());

    expect(cardNumber).toBeNull();
  });
});

describe("extractStructuredSetCode", () => {
  it("reads the mtgjson-set-code attribute off a 'set' typed reference", () => {
    const setCode = extractStructuredSetCode(
      [{ fieldId: "fld_set", value: { referenceId: "ref_tsp" } }],
      new Map([
        [
          "ref_tsp",
          referenceRecord({
            referenceId: "ref_tsp",
            typeKey: "set",
            attributes: { "mtgjson-set-code": "TSP", "mtgjson-set-name": "Time Spiral" },
          }),
        ],
      ]),
    );

    expect(setCode).toBe("tsp");
  });

  it("reads the abbreviation attribute off an 'expansion' typed reference (Pokemon)", () => {
    const setCode = extractStructuredSetCode(
      [{ fieldId: "fld_expansion", value: { referenceId: "ref_sv04" } }],
      new Map([
        [
          "ref_sv04",
          referenceRecord({
            referenceId: "ref_sv04",
            typeKey: "expansion",
            attributes: { abbreviation: "SV04", "tcgdex-set-id": "sv04" },
          }),
        ],
      ]),
    );

    expect(setCode).toBe("sv04");
  });

  it("ignores references whose type is not set-like", () => {
    const setCode = extractStructuredSetCode(
      [{ fieldId: "fld_publisher", value: { referenceId: "ref_wotc" } }],
      new Map([
        [
          "ref_wotc",
          referenceRecord({ referenceId: "ref_wotc", typeKey: "manufacturer", attributes: { "homepage-url": "x" } }),
        ],
      ]),
    );

    expect(setCode).toBeNull();
  });

  it("returns null when the set-like reference has no set-code-shaped attribute (for example TCGplayer name-only sets)", () => {
    const setCode = extractStructuredSetCode(
      [{ fieldId: "fld_set", value: { referenceId: "ref_name_only" } }],
      new Map([
        [
          "ref_name_only",
          referenceRecord({
            referenceId: "ref_name_only",
            typeKey: "set",
            attributes: { "tcgplayer-set-name": "Time Spiral" },
          }),
        ],
      ]),
    );

    expect(setCode).toBeNull();
  });

  it("returns null when the field value is not a reference", () => {
    const setCode = extractStructuredSetCode([{ fieldId: "fld_rarity", value: "Rare" }], new Map());

    expect(setCode).toBeNull();
  });
});
