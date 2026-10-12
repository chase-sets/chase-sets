import { describe, expect, it } from "vitest";
import { savedListFingerprint, savedListCanonicalPreimage } from "./anonymous-owner";

const product: unknown[] = ["item_test", "product_test", []];
const intent: unknown[] = [
  "collections.anonymous-intent.v1",
  "intent_test",
  "owner_fp",
  product,
  "search",
  "cmd_test",
  "line_test",
];
const claim: unknown[] = [
  "collections.claim.v1",
  "intent_fp",
  "account_test",
  ["existing", "list_test"],
  product,
  1,
  "search",
];
const addition: unknown[] = [
  "collections.addition.v1",
  "account_test",
  "op_test",
  ["new", "list_test", "create_test", "Test List"],
  product,
  1,
  "search",
  "cmd_test",
  "line_test",
];

describe("saved-list-canonical-fingerprint-vectors", () => {
  it.each([
    {
      tuple: ["collections.anonymous-owner.v1", "anon_test-owner"],
      digest: "c4836ba7135273085b6c189cd0a13f621f888e2d3d2711aa709536055c77462d",
    },
    { tuple: intent, digest: "434ca84aefb99e76ae89b5c6220c7d18f41f7c69944d3448f6613253b6594fa0" },
    { tuple: claim, digest: "18565d2b7812d4241198b5286ca6a923c141aff58d234136561a0e2bdc29f3da" },
    { tuple: addition, digest: "aaaee26c6adfa0aa3d2982aa376f7b4495393ee55d7beab725c291adcc27c783" },
  ])("pins literal UTF-8 preimage and digest $digest", ({ tuple, digest }) => {
    expect(savedListCanonicalPreimage(tuple)).toBe(JSON.stringify(tuple));
    expect(savedListFingerprint(tuple)).toBe(`sha256:v1:${digest}`);
  });

  it("sorts Options by code units and trims titles without Unicode normalization", () => {
    const tuple = structuredClone(addition);
    tuple[3] = ["new", "list_test", "create_test", "  Café | []  "];
    tuple[4] = [
      "item_test",
      "product_test",
      [
        ["z", "ø"],
        ["a", "雪"],
      ],
    ];
    expect(savedListCanonicalPreimage(tuple)).toBe(
      '["collections.addition.v1","account_test","op_test",["new","list_test","create_test","Café | []"],["item_test","product_test",[["a","雪"],["z","ø"]]],1,"search","cmd_test","line_test"]',
    );
    expect(savedListFingerprint(tuple)).not.toBe(
      savedListFingerprint([
        ...tuple.slice(0, 3),
        ["new", "list_test", "create_test", "Cafe\u0301 | []"],
        ...tuple.slice(4),
      ]),
    );
  });

  it("changed-field mutant: every semantic member discriminates; delimiters cannot collide", () => {
    for (const tuple of [intent, claim, addition]) {
      const baseline = savedListFingerprint(tuple);
      const visit = (value: unknown[], path: number[] = []) => {
        value.forEach((member, index) => {
          const next = [...path, index];
          if (Array.isArray(member)) return visit(member, next);
          if (next.length === 1 && index === 0) return;
          const changed = structuredClone(tuple);
          let parent = changed;
          for (const part of next.slice(0, -1)) parent = parent[part] as unknown[];
          parent[index] =
            typeof member === "number" ? member + 1 : member === "search" ? "item-detail" : `${member}|changed`;
          if (member === "new" || member === "existing") return;
          expect(savedListFingerprint(changed)).not.toBe(baseline);
        });
      };
      visit(tuple);
    }
    expect(
      savedListFingerprint(["collections.anonymous-intent.v1", "a|b", "c", product, "search", "cmd_test", "line_test"]),
    ).not.toBe(
      savedListFingerprint(["collections.anonymous-intent.v1", "a", "b|c", product, "search", "cmd_test", "line_test"]),
    );
  });

  it("rejects null/undefined, holes, unknown fields, duplicate dimensions and unpaired surrogates", () => {
    for (const value of [null, undefined, "", " x ", "x\ud800", "x\udc00"]) {
      expect(() => savedListFingerprint(["collections.anonymous-owner.v1", value])).toThrow();
    }
    const malformed = [
      [...intent, 1],
      [
        ...intent.slice(0, 3),
        [
          "item_test",
          "product_test",
          [
            ["a", "b"],
            ["a", "c"],
          ],
        ],
        ...intent.slice(4),
      ],
      [...intent.slice(0, 3), ["item_test", "product_test", undefined], ...intent.slice(4)],
      [...claim.slice(0, 5), 1.5, "search"],
      [...addition.slice(0, 3), ["new", "list_test", "create_test", "x\ud800"], ...addition.slice(4)],
      ["collections.anonymous-owner.v1", ,],
      { kind: "collections.anonymous-owner.v1", owner: "anon_test" },
    ];
    malformed.forEach((tuple) => expect(() => savedListFingerprint(tuple)).toThrow());
    expect(savedListCanonicalPreimage(intent)).toContain("[]");
    expect(() => savedListFingerprint([...claim, { expectedVersion: 1 }])).toThrow();
  });
});
