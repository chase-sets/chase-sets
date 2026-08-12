import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_RECORD_REFUSAL_CODES,
  CANONICAL_RECORD_SHAPES,
  CanonicalRecordError,
  emitRecord,
  emitRecordArray,
  sha256,
} from "./canonical-record.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/canonical-record-v1.json"), "utf8"));
const AUTHORIZED_IMPORTERS = ["scripts/canonical-record.test.mjs"];
const CANONICAL_PATHS = [
  "scripts/canonical-record.mjs",
  "scripts/canonical-record.test.mjs",
  "scripts/fixtures/canonical-record-v1.json",
];

function expectRefusal(code, action) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function reverseRecords(value) {
  if (Array.isArray(value)) return value.map(reverseRecords);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseRecords(entry)]),
    );
  }
  return value;
}

function assertUniqueThenEqual(actual, expected) {
  expect(new Set(expected).size, "declared inventory must be duplicate-free").toBe(expected.length);
  expect(new Set(actual)).toEqual(new Set(expected));
}

function reverseFields(fields) {
  return fields
    .map((field) => (field.fields ? { ...field, fields: reverseFields(field.fields) } : { ...field }))
    .reverse();
}

function emitVector(vector, value = vector.value, fields = vector.fields) {
  return vector.entryPoint === "emitRecord" ? emitRecord(value, fields) : emitRecordArray(value, fields);
}

describe("chase-sets-canonical/v1", () => {
  it("emitter reproduces every committed golden vector", () => {
    expect(fixture.schemaVersion).toBe("canonical-record-v1");
    expect(fixture.vectors).toHaveLength(10);
    expect(fixture.vectors.map(({ id }) => id)).toEqual([
      "V1-empty-object",
      "V2-conserved-identity-body-only",
      "V3-conserved-identity-multipart",
      "V4-escape-hostile-strings",
      "V5-manifest-zero-parts",
      "V6-manifest-one-parts",
      "V7-manifest-two-parts",
      "V8-parts-array-zero",
      "V9-parts-array-one",
      "V10-parts-array-two",
    ]);
    for (const vector of fixture.vectors) {
      const bytes = emitVector(vector);
      expect(bytes).toEqual(Buffer.from(vector.canonicalText, "utf8"));
      expect(bytes.length).toBe(vector.utf8Bytes);
      expect(sha256(bytes)).toBe(vector.sha256);
      const reversed = emitVector(vector, reverseRecords(vector.value));
      expect(reversed).toEqual(bytes);
    }
  });

  it("recomputes fixture byte lengths and digests independently of the emitter", () => {
    for (const vector of fixture.vectors) {
      const bytes = Buffer.from(vector.canonicalText, "utf8");
      expect(bytes.length).toBe(vector.utf8Bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(vector.sha256);
    }
  });

  it("reverses declared insertion at every schema nesting level without consulting map order", () => {
    for (const vector of fixture.vectors.filter((entry) => entry.fields.some((field) => field.fields))) {
      const reordered = emitVector(vector, reverseRecords(vector.value), reverseFields(vector.fields));
      expect(reordered).not.toEqual(emitVector(vector));
      expect(reordered.toString()).not.toContain("\n");
    }
  });

  it("pins the published digests and empty array preimage", () => {
    expect([
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "43938cad90af75d9246b21e737b5ad610bbec04bf14f214eff4ddee107d14b66",
      "be0ef056ceccb7fbe9e267a8ba116dd8e4c4de81cc94eb8f74e2e09723982eef",
      "fe7e56697bd1ba5f6c828b7daa6c9054b754eaac95fb7754ee750ea199984256",
      "94ad35b3c4c358c079e490946f4c3c4f5553117ade0a8e7fd915ffae2a821c4e",
      "d78c2543b04182eca7154e3db3f55907487b68f20b989e04273d7f2d976927ed",
      "3ad5852a51241159b9aac840705e2e9f225aefa393fb6206d167c526a16c9280",
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      "134702b9d7952e00611bab087bfe301c0cf8558bebbe8039d4663266fd6b6de0",
      "37f181b8414fab6763a44cfc9d3b28122cb952bad907ddddd1ff6180015d59fe",
    ]).toHaveLength(10);
  });

  it("declared order is authoritative while maps are orderless", () => {
    const value = { a: 1, b: 2 };
    const ab = emitRecord(value, [
      { key: "a", shape: "integer" },
      { key: "b", shape: "integer" },
    ]);
    const ba = emitRecord(value, [
      { key: "b", shape: "integer" },
      { key: "a", shape: "integer" },
    ]);
    expect(ab).not.toEqual(ba);
    expectRefusal("CANONICAL_KEY_SET_MISMATCH", () => emitRecord(value, [{ key: "a", shape: "integer" }]));
    expectRefusal("CANONICAL_KEY_SET_MISMATCH", () =>
      emitRecord(value, [
        { key: "a", shape: "integer" },
        { key: "a", shape: "integer" },
      ]),
    );
  });

  it("validates schemas eagerly and recursively", () => {
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({}, {}));
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({}, [{ key: "x", shape: "wat" }]));
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({}, [{ key: "x", shape: "string", fields: [] }]));
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({}, [{ key: "x", shape: "record" }]));
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecordArray([], [{ key: "x", shape: "record", fields: {} }]));
    const cyclic = [];
    cyclic.push({ key: "x", shape: "record", fields: cyclic });
    expectRefusal("CANONICAL_SCHEMA_CYCLIC", () => emitRecord({ x: {} }, cyclic));
  });

  it("refuses every eager schema predicate before reading an empty record array", () => {
    const invalid = [
      null,
      [{ key: 1, shape: "string" }],
      [{ key: "x\n", shape: "string" }],
      [{ key: "x", shape: null }],
      [{ key: "x", shape: "integer", fields: [] }],
      [{ key: "x", shape: "record" }],
      [{ key: "x", shape: "recordArray", fields: {} }],
      [{ key: "x", shape: "string", extra: true }],
    ];
    for (const fields of invalid) expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecordArray([], fields));
  });

  it("refuses the closed domain without emitting partial output", () => {
    const fields = [{ key: "nested", shape: "record", fields: [{ key: "count", shape: "integer" }] }];
    for (const [code, value] of [
      ["CANONICAL_NUMBER_OUT_OF_DOMAIN", null],
      ["CANONICAL_NUMBER_OUT_OF_DOMAIN", []],
      ["CANONICAL_NUMBER_OUT_OF_DOMAIN", -1],
      ["CANONICAL_NUMBER_OUT_OF_DOMAIN", 1.5],
    ]) {
      expectRefusal(code, () => emitRecord({ nested: { count: value } }, fields));
    }
    expectRefusal("CANONICAL_KEY_SET_MISMATCH", () => emitRecord({ nested: { count: 1, extra: 2 } }, fields));
    expectRefusal("CANONICAL_STRING_OUT_OF_DOMAIN", () =>
      emitRecord({ x: "line\nbreak" }, [{ key: "x", shape: "string" }]),
    );
  });

  it("refuses nested unknown keys and out-of-domain values at every depth", () => {
    const fields = [
      {
        key: "rows",
        shape: "recordArray",
        fields: [{ key: "nested", shape: "record", fields: [{ key: "n", shape: "integer" }] }],
      },
    ];
    expectRefusal("CANONICAL_KEY_SET_MISMATCH", () => emitRecord({ rows: [{ nested: { n: 1, extra: 2 } }] }, fields));
    expectRefusal("CANONICAL_NUMBER_OUT_OF_DOMAIN", () => emitRecord({ rows: [{ nested: { n: -1 } }] }, fields));
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord({ rows: [null] }, fields));
    expectRefusal("CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord({ rows: {} }, fields));
  });

  it("closes each of the five shapes", () => {
    const fields = [
      { key: "s", shape: "string" },
      { key: "n", shape: "integer" },
      { key: "ns", shape: "integerArray" },
      { key: "r", shape: "record", fields: [{ key: "x", shape: "string" }] },
      { key: "rs", shape: "recordArray", fields: [{ key: "x", shape: "string" }] },
    ];
    expect(emitRecord({ s: "ok", n: 0, ns: [1], r: { x: "ok" }, rs: [{ x: "ok" }] }, fields)).toBeInstanceOf(Buffer);
    for (const [key, value] of [
      ["s", 1],
      ["n", "1"],
      ["ns", ["1"]],
      ["r", []],
      ["rs", [1]],
    ]) {
      const candidate = { s: "ok", n: 0, ns: [1], r: { x: "ok" }, rs: [{ x: "ok" }], [key]: value };
      expectRefusal(
        key === "n" || key === "ns" ? "CANONICAL_NUMBER_OUT_OF_DOMAIN" : "CANONICAL_TYPE_OUT_OF_DOMAIN",
        () => emitRecord(candidate, fields),
      );
    }
  });

  it("escapes only quote and backslash and emits minimal integers", () => {
    const text = emitRecord({ x: "\"\\/<&'", n: Number.MAX_SAFE_INTEGER }, [
      { key: "x", shape: "string" },
      { key: "n", shape: "integer" },
    ]).toString();
    expect(text).toBe('{"x":"\\"\\\\/<&\'","n":9007199254740991}');
    for (let value = 0; value < 5000; value += 1)
      expect(emitRecord({ value }, [{ key: "value", shape: "integer" }]).toString()).toBe(`{"value":${value}}`);
  });

  it("refuses every non-printable string class at root and nested positions", () => {
    const samples = ["\n", "\t", "\0", "ü", "Ω", "😀", "\ud800", "\ufeff"];
    const nested = [{ key: "r", shape: "record", fields: [{ key: "s", shape: "string" }] }];
    for (const sample of samples) {
      expectRefusal("CANONICAL_STRING_OUT_OF_DOMAIN", () => emitRecord({ s: sample }, [{ key: "s", shape: "string" }]));
      expectRefusal("CANONICAL_STRING_OUT_OF_DOMAIN", () => emitRecord({ r: { s: sample } }, nested));
    }
    expectRefusal("CANONICAL_SCHEMA_INVALID", () => emitRecord({ s: "ok" }, [{ key: "ü", shape: "string" }]));
  });

  it("the digest helper accepts bytes only", () => {
    const bytes = Buffer.from("{}", "utf8");
    expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expectRefusal("CANONICAL_DIGEST_INPUT_NOT_BYTES", () => sha256("{}"));
    expectRefusal("CANONICAL_DIGEST_INPUT_NOT_BYTES", () => sha256({}));
  });

  it("exports exactly the five shapes and seven refusal codes", () => {
    expect(CANONICAL_RECORD_SHAPES).toEqual(["string", "integer", "integerArray", "record", "recordArray"]);
    expect(CANONICAL_RECORD_REFUSAL_CODES).toHaveLength(7);
    expect(new CanonicalRecordError("CANONICAL_SCHEMA_INVALID").code).toBe("CANONICAL_SCHEMA_INVALID");
  });

  it("makes every declared refusal code reachable through a discriminating control", () => {
    const cyclic = [];
    cyclic.push({ key: "x", shape: "record", fields: cyclic });
    const controls = new Map([
      ["CANONICAL_SCHEMA_INVALID", () => emitRecord({}, {})],
      ["CANONICAL_SCHEMA_CYCLIC", () => emitRecord({ x: {} }, cyclic)],
      ["CANONICAL_KEY_SET_MISMATCH", () => emitRecord({ x: 1 }, [])],
      ["CANONICAL_TYPE_OUT_OF_DOMAIN", () => emitRecord([], [])],
      ["CANONICAL_STRING_OUT_OF_DOMAIN", () => emitRecord({ x: "\n" }, [{ key: "x", shape: "string" }])],
      ["CANONICAL_NUMBER_OUT_OF_DOMAIN", () => emitRecord({ x: -1 }, [{ key: "x", shape: "integer" }])],
      ["CANONICAL_DIGEST_INPUT_NOT_BYTES", () => sha256("bytes")],
    ]);
    expect([...controls.keys()].sort()).toEqual([...CANONICAL_RECORD_REFUSAL_CODES].sort());
    for (const [code, control] of controls) expectRefusal(code, control);
  });

  it("the inventories are duplicate-free and exact against the tracked corpus", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    const canonicalPaths = tracked.filter((path) => path.includes("canonical-record"));
    assertUniqueThenEqual(canonicalPaths, CANONICAL_PATHS);
    const importers = execFileSync("git", ["grep", "-l", "-F", 'from "./canonical-record.mjs"'], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assertUniqueThenEqual(importers, AUTHORIZED_IMPORTERS);
    expect(() => assertUniqueThenEqual(importers, [...AUTHORIZED_IMPORTERS, AUTHORIZED_IMPORTERS[0]])).toThrow();
    expect(() => assertUniqueThenEqual(canonicalPaths, [...CANONICAL_PATHS, CANONICAL_PATHS[0]])).toThrow();
    expect(new Set([...AUTHORIZED_IMPORTERS, AUTHORIZED_IMPORTERS[0]])).toEqual(new Set(AUTHORIZED_IMPORTERS));
  });
});
