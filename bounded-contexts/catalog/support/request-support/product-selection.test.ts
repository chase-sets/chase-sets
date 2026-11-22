import { describe, expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import type { CatalogItemId } from "../../ids";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { parseBlueprint, parseOptionApplicability, resolveCatalogProductSelection } from "./product-selection";

const rule = { dimensionId: "finish", required: true, allowedOptionIds: ["foil"] };

describe("stored Product Blueprint parser", () => {
  it("accepts domain rules, optional applicability and dimensionless Blueprints", () => {
    expect(parseBlueprint([rule], ["finish"])).toEqual({
      dimensionRules: [{ ...rule, appliesWhen: [] }],
      canonicalDimensionOrder: ["finish"],
    });
    expect(parseBlueprint([], [])).toEqual({ dimensionRules: [], canonicalDimensionOrder: [] });
    const conditional = { ...rule, appliesWhen: [{ dimensionId: "kind", optionIds: ["card"] }] };
    expect(parseBlueprint([conditional], ["finish"])?.dimensionRules).toEqual([conditional]);
  });

  it.each([
    [
      "admin named shape",
      [{ dimensionId: "finish", required: true, allowedOptions: [{ optionId: "foil" }] }],
      [{ dimensionId: "finish", dimensionName: "Finish" }],
    ],
    ["non-string order entry", [rule], [3]],
    ["missing allowedOptionIds", [{ dimensionId: "finish", required: true }], ["finish"]],
    ["non-array rules", {}, []],
    ["non-array order", [], null],
    ["empty dimension id", [{ ...rule, dimensionId: "" }], [""]],
    ["non-string dimension id", [{ ...rule, dimensionId: 3 }], ["finish"]],
    ["non-boolean required", [{ ...rule, required: "false" }], ["finish"]],
    ["non-array allowed options", [{ ...rule, allowedOptionIds: "foil" }], ["finish"]],
    ["non-string allowed option", [{ ...rule, allowedOptionIds: [3] }], ["finish"]],
    ["null rule", [null], ["finish"]],
    ["non-array applicability", [{ ...rule, appliesWhen: {} }], ["finish"]],
    ["null applicability clause", [{ ...rule, appliesWhen: [null] }], ["finish"]],
    ["non-string applicability dimension", [{ ...rule, appliesWhen: [{ dimensionId: 3, optionIds: [] }] }], ["finish"]],
    ["missing applicability options", [{ ...rule, appliesWhen: [{ dimensionId: "kind" }] }], ["finish"]],
    [
      "non-string applicability option",
      [{ ...rule, appliesWhen: [{ dimensionId: "kind", optionIds: [3] }] }],
      ["finish"],
    ],
    ["empty order id", [rule], [""]],
  ])("rejects %s", (_label, rules, order) => {
    expect(parseBlueprint(rules, order)).toBeNull();
  });
});

describe("stored Option applicability parser", () => {
  const row = { dimension_id: "grade", option_id: "black-label", applies_when: [clause("company", ["bgs"])] };

  function clause(dimensionId: unknown, optionIds: unknown) {
    return { dimensionId, optionIds };
  }

  it("accepts stored rows and no rows", () => {
    expect(parseOptionApplicability([row])).toEqual([
      { dimensionId: "grade", optionId: "black-label", appliesWhen: [clause("company", ["bgs"])] },
    ]);
    expect(parseOptionApplicability([])).toEqual([]);
  });

  it.each([
    ["non-array rows", {}],
    ["null row", [null]],
    ["empty dimension id", [{ ...row, dimension_id: "" }]],
    ["empty option id", [{ ...row, option_id: "" }]],
    ["non-array applicability", [{ ...row, applies_when: {} }]],
    ["null applicability clause", [{ ...row, applies_when: [null] }]],
    ["non-string applicability dimension", [{ ...row, applies_when: [clause(3, ["bgs"])] }]],
    ["missing applicability options", [{ ...row, applies_when: [{ dimensionId: "company" }] }]],
    ["non-string applicability option", [{ ...row, applies_when: [clause("company", [3])] }]],
  ])("rejects %s", (_label, rows) => {
    expect(parseOptionApplicability(rows)).toBeNull();
  });
});

describe("Catalog Product selection database failures", () => {
  it("propagates a failed Blueprint SELECT through the real resolver and queries", async () => {
    const sentinel = new Error("synthetic Blueprint SELECT failure for AC6");
    const queries: string[] = [];
    const db: PgQueryable = {
      async query<Row>(sql: string): Promise<PgQueryResult<Row>> {
        queries.push(sql);
        if (sql.includes("FROM catalog_admin_catalog_item_detail_pages")) {
          return { rows: [{ status: "active", blueprint_id: "blueprint" }] as Row[] };
        }
        if (/FROM catalog_(?:admin_blueprint_detail_pages|blueprints)\b/.test(sql)) throw sentinel;
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    await expect(
      resolveCatalogProductSelection(db, {
        catalogItemId: "item" as CatalogItemId,
        productId: "item::finish:foil" as ProductKey,
        selectedOptions: [{ dimensionId: "finish", optionId: "foil" }],
      }),
    ).rejects.toBe(sentinel);
    expect(queries).toHaveLength(2);
  });
});
