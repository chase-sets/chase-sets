import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// The candidate fixture is the single value authority for the Ink & Foil
// replacement graph: the Connect probe reads it, and the value cutover ships
// exactly it. Every claim this file makes about coverage is derived from the
// bytes that actually ship -- the appearance factory source and styles.css --
// because the defect that sank the previous attempt was a hand-written
// inventory that silently stopped tracking its own source.

function repositoryRoot() {
  let candidate = process.cwd();
  while (!existsSync(join(candidate, "pnpm-workspace.yaml"))) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${process.cwd()}`);
    }
    candidate = parent;
  }
  return candidate;
}

const designSystemSrc = join(repositoryRoot(), "packages", "design-system", "src");
const fixturesDir = join(designSystemSrc, "theme", "__fixtures__");
const stylesPath = join(designSystemSrc, "styles", "styles.css");

const fixturePath = join(fixturesDir, "ink-foil-candidate-tokens.json");
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const tokenSchema = JSON.parse(readFileSync(join(fixturesDir, "ink-foil-candidate-tokens.schema.json"), "utf8"));
const receiptSchema = JSON.parse(
  readFileSync(join(fixturesDir, "stripe-appearance-acceptance-receipt.schema.json"), "utf8"),
);
const discoverySchema = JSON.parse(readFileSync(join(fixturesDir, "stripe-connect-discovery.schema.json"), "utf8"));
const appearanceSource = readFileSync(join(designSystemSrc, "theme", "stripe-appearance.ts"), "utf8");

// Ratified by Todd on 2026-07-23 and transcribed from the tracking body's
// "Ratified anchors" paragraph. These are the values no lane may derive,
// round, or re-tune; everything else in the fixture is implementer-derived
// within them.
const ratifiedAnchors = {
  light: {
    "--background": "#f7f5f1",
    "--card": "#ffffff",
    "--surface-3": "#efece5",
    "--foreground": "#211d33",
    "--text-secondary": "#4d4763",
    "--text-muted": "#7d7791",
    "--border": "#e6e2d9",
    "--border-strong": "#d4cfc2",
    "--primary": "#4845c6",
    "--primary-hover": "#3b38ad",
    "--primary-active": "#312e94",
    "--primary-soft": "#e6e5fb",
    "--chase-logo-start": "#8a682a",
    "--chase-logo-mid": "#c9a44e",
    "--chase-logo-end": "#a87e2f",
  },
  dark: {
    "--background": "#0e0c15",
    "--surface-2": "#14111c",
    "--card": "#1a1626",
    "--elevated": "#211c30",
    "--popover": "#211c30",
    "--border": "rgba(242, 239, 250, 0.08)",
    "--border-strong": "#4a4363",
    "--foreground": "#f2effa",
    "--text-secondary": "#b6b0c9",
    "--text-muted": "#857e9c",
    "--text-disabled": "#5c5675",
    "--primary": "#8a97ff",
    "--primary-foreground": "#14102a",
    "--primary-hover": "#a1acff",
    "--primary-active": "#b8c1ff",
    "--primary-soft": "#232048",
    "--ring": "#b8c1ff",
    "--chase-logo-start": "#b9863b",
    "--chase-logo-mid": "#edd28d",
    "--chase-logo-end": "#d4a94e",
  },
} as const;

// ---------------------------------------------------------------------------
// A JSON Schema validator over the keyword subset these two schemas use. The
// schemas are recursively closed, so validation is the gate that keeps a
// fabricated or drifted artifact out -- it runs in ordinary CI, which is why a
// hand-edited receipt is a red test rather than a review judgement.
// ---------------------------------------------------------------------------

const supportedKeywords = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "minimum",
  "maximum",
  "pattern",
  "oneOf",
]);

type SchemaNode = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Every schema-bearing position must hold a plain object. JSON Schema boolean
// subschemas (`true` and `false`) read as constraints while binding nothing
// this validator implements, so they are refused with a named path rather than
// coerced to the empty schema -- the settled r2 F2 policy: reject everywhere,
// never implement. `additionalProperties` alone may be exactly `false`, and
// that exception lives at its call sites, never here.
function requireSchemaNode(value: unknown, path: string): SchemaNode {
  if (typeof value === "boolean") {
    throw new Error(`${path}: boolean subschema is not a closed object node`);
  }
  const node = asRecord(value);
  if (!node) {
    throw new Error(
      `${path}: schema-bearing position holds ${Array.isArray(value) ? "an array" : `a ${typeof value}`}, not a closed object node`,
    );
  }
  return node;
}

// The values under a keyword map are subschemas; the map itself must still be
// a plain object for those positions to exist at all.
function requireKeywordMap(value: unknown, path: string): Record<string, unknown> {
  const map = asRecord(value);
  if (!map) {
    throw new Error(
      `${path}: must be an object map of subschemas, got ${Array.isArray(value) ? "an array" : typeof value}`,
    );
  }
  return map;
}

function resolveRef(root: SchemaNode, ref: string): SchemaNode {
  expect(ref.startsWith("#/"), `only local refs are supported, got ${ref}`).toBe(true);
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    node = asRecord(node)?.[segment];
  }
  return requireSchemaNode(node, `$ref ${ref}`);
}

// ---------------------------------------------------------------------------
// (r4 F2) The validator's own independent recursive schema preflight. Before
// any data traversal, validate() walks the schema itself over every supported
// schema-bearing position -- the values under `properties`,
// `patternProperties`, and `$defs`; `items`; `propertyNames`; object-form
// `additionalProperties`; every locally resolvable `$ref` target -- and
// throws, naming the path, on any non-object schema node and any keyword
// outside the supported set. That rejects every unsupported applicator and
// unknown keyword regardless of whether candidate data ever reaches the node.
// It is deliberately a separate code path from assertRecursivelyClosed,
// sharing neither its helpers nor its keyword set, so closure and validation
// refuse independently and weakening either layer alone is caught by the
// other layer's half of the mutation battery. Data-reachable refusals during
// traversal (the r2 policy) remain in place beneath it.
// ---------------------------------------------------------------------------

const validatorSupportedKeywords = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "minimum",
  "maximum",
  "pattern",
  "oneOf",
]);

function preflightSupportedSchema(root: unknown, candidate: unknown, path: string, visited: Set<object>): void {
  if (typeof candidate === "boolean") {
    throw new Error(`${path}: boolean subschema is not a closed object node`);
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(
      `${path}: schema-bearing position holds ${Array.isArray(candidate) ? "an array" : `a ${typeof candidate}`}, not a closed object node`,
    );
  }
  const node = candidate as Record<string, unknown>;
  if (visited.has(node)) return;
  visited.add(node);

  for (const keyword of Object.keys(node)) {
    if (!validatorSupportedKeywords.has(keyword)) {
      throw new Error(`${path}: unsupported schema keyword ${keyword}`);
    }
  }

  if (typeof node.$ref === "string") {
    if (!node.$ref.startsWith("#/")) {
      throw new Error(`${path}.$ref: only local refs are supported, got ${node.$ref}`);
    }
    let target: unknown = root;
    for (const segment of node.$ref.slice(2).split("/")) {
      target =
        typeof target === "object" && target !== null && !Array.isArray(target)
          ? (target as Record<string, unknown>)[segment]
          : undefined;
    }
    preflightSupportedSchema(root, target, `${path}.$ref(${node.$ref})`, visited);
  }

  for (const keyword of ["properties", "patternProperties", "$defs"] as const) {
    if (node[keyword] === undefined) continue;
    const map = node[keyword];
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      throw new Error(
        `${path}.${keyword}: must be an object map of subschemas, got ${Array.isArray(map) ? "an array" : typeof map}`,
      );
    }
    for (const [key, child] of Object.entries(map as Record<string, unknown>)) {
      preflightSupportedSchema(root, child, `${path}.${keyword}.${key}`, visited);
    }
  }
  for (const keyword of ["items", "propertyNames"] as const) {
    if (node[keyword] !== undefined) preflightSupportedSchema(root, node[keyword], `${path}.${keyword}`, visited);
  }
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
      throw new Error(`${path}.oneOf: must be a non-empty array of subschemas`);
    }
    node.oneOf.forEach((child, index) => preflightSupportedSchema(root, child, `${path}.oneOf[${index}]`, visited));
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    preflightSupportedSchema(root, node.additionalProperties, `${path}.additionalProperties`, visited);
  }
}

function validate(root: SchemaNode, candidate: unknown, value: unknown, path = "$", errors: string[] = []): string[] {
  // (r4 F2) The independent preflight runs once, at entry, before any data
  // traversal -- so an unreachable or unsupported subschema is refused even
  // when no candidate data ever travels to it.
  if (path === "$") {
    preflightSupportedSchema(root, candidate, "$", new Set());
  }
  // A boolean or otherwise non-object schema node throws here instead of
  // coercing to the empty schema, so the validator refuses independently of
  // the closure walk and a direct reopening cannot validate as unconstrained.
  const schema = requireSchemaNode(candidate, path);
  if (typeof schema.$ref === "string") {
    return validate(root, resolveRef(root, schema.$ref), value, path, errors);
  }

  const fail = (message: string) => errors.push(`${path}: ${message}`);
  const numberKeyword = (name: string) => (typeof schema[name] === "number" ? (schema[name] as number) : undefined);

  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new Error(`${path}.oneOf: must be a non-empty array of subschemas`);
    }
    const branchErrors = schema.oneOf.map((branch, index) => {
      const candidateErrors: string[] = [];
      validate(root, branch, value, `${path}.oneOf[${index}]`, candidateErrors);
      return candidateErrors;
    });
    const matching = branchErrors.filter((branch) => branch.length === 0).length;
    if (matching !== 1) {
      fail(
        `expected exactly one oneOf branch to match, got ${matching}; ` +
          branchErrors.map((branch, index) => `branch ${index}: ${branch.join("; ") || "matched"}`).join(" | "),
      );
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    fail(`expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  const declaredType =
    schema.type ??
    (schema.properties !== undefined || schema.patternProperties !== undefined || schema.propertyNames !== undefined
      ? "object"
      : schema.items !== undefined
        ? "array"
        : undefined);

  if (declaredType === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
      return errors;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const name of required) {
      if (!(name in (value as object))) fail(`missing required property ${name}`);
    }
    const minProperties = numberKeyword("minProperties");
    if (minProperties !== undefined && entries.length < minProperties) {
      fail(`expected at least ${minProperties} properties, got ${entries.length}`);
    }
    // Every schema-bearing position is refused fail-closed when it holds
    // anything but a plain object; only `additionalProperties` may be exactly
    // `false`. Absent optional positions stay absent -- they are never coerced.
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      requireSchemaNode(schema.additionalProperties, `${path}.additionalProperties`);
    }
    const propertyNames =
      schema.propertyNames !== undefined ? requireSchemaNode(schema.propertyNames, `${path}.propertyNames`) : null;
    const properties =
      schema.properties !== undefined ? requireKeywordMap(schema.properties, `${path}.properties`) : null;
    const patternProperties =
      schema.patternProperties !== undefined
        ? requireKeywordMap(schema.patternProperties, `${path}.patternProperties`)
        : null;
    for (const [key, child] of entries) {
      const childPath = `${path}.${key}`;
      if (propertyNames && !new RegExp(String(propertyNames.pattern)).test(key)) {
        fail(`property name ${key} does not match ${String(propertyNames.pattern)}`);
      }
      const direct = properties?.[key];
      const patternKey = Object.keys(patternProperties ?? {}).find((candidate) => new RegExp(candidate).test(key));
      if (direct !== undefined) {
        validate(root, direct, child, childPath, errors);
      } else if (patternKey) {
        validate(root, patternProperties![patternKey], child, childPath, errors);
      } else if (schema.additionalProperties === false) {
        fail(`unexpected additional property ${key}`);
      }
    }
    return errors;
  }

  if (declaredType === "array") {
    if (!Array.isArray(value)) {
      fail(`expected array, got ${typeof value}`);
      return errors;
    }
    const minItems = numberKeyword("minItems");
    if (minItems !== undefined && value.length < minItems) {
      fail(`expected at least ${minItems} items, got ${value.length}`);
    }
    const maxItems = numberKeyword("maxItems");
    if (maxItems !== undefined && value.length > maxItems) {
      fail(`expected at most ${maxItems} items, got ${value.length}`);
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      fail("expected unique items");
    }
    if (schema.items !== undefined) {
      // Checked before iterating, so a boolean `items` node is refused even
      // for an empty array; an absent `items` stays an absent optional
      // position, never a coerced empty schema.
      const itemsSchema = requireSchemaNode(schema.items, `${path}.items`);
      value.forEach((item, index) => validate(root, itemsSchema, item, `${path}[${index}]`, errors));
    }
    return errors;
  }

  if (declaredType === "string") {
    if (typeof value !== "string") {
      fail(`expected string, got ${typeof value}`);
      return errors;
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      fail(`${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    const minLength = numberKeyword("minLength");
    if (minLength !== undefined && value.length < minLength) {
      fail(`expected at least ${minLength} characters`);
    }
    return errors;
  }

  if (declaredType === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      fail(`expected integer, got ${JSON.stringify(value)}`);
      return errors;
    }
    const minimum = numberKeyword("minimum");
    if (minimum !== undefined && value < minimum) {
      fail(`expected >= ${minimum}, got ${value}`);
    }
    const maximum = numberKeyword("maximum");
    if (maximum !== undefined && value > maximum) {
      fail(`expected <= ${maximum}, got ${value}`);
    }
    return errors;
  }

  if (declaredType === "boolean" && typeof value !== "boolean") {
    fail(`expected boolean, got ${typeof value}`);
  }

  return errors;
}

// A schema is recursively closed when every object node either forbids
// additional properties outright or constrains them through
// patternProperties plus propertyNames, and every node -- however deeply
// nested -- uses only the keyword subset this validator implements. An
// unimplemented keyword is not "ignored", it is unenforced: a `maxLength` on a
// nested string reads as a constraint while binding nothing.
//
// Traversal is structural, not path-string based. Suppressing the keyword
// check for any path under `properties` or `$defs` -- which is every
// interesting node in both of these schemas -- let a nested unsupported
// keyword escape entirely. Schema-bearing positions are named explicitly here
// instead, so a *property named* `pattern` is never mistaken for the `pattern`
// keyword and a keyword is never mistaken for a property name.
const schemaMapKeywords = ["properties", "patternProperties", "$defs"] as const;
const schemaValueKeywords = ["items", "propertyNames", "additionalProperties"] as const;

function assertRecursivelyClosed(candidate: unknown, path: string) {
  // The node itself is a schema-bearing position: a boolean or otherwise
  // non-object candidate is refused with its named path, never skipped.
  const node = requireSchemaNode(candidate, path);

  for (const keyword of Object.keys(node)) {
    if (!supportedKeywords.has(keyword)) {
      throw new Error(`${path}: unsupported schema keyword ${keyword}`);
    }
  }

  // Schema-bearing positions are refused before the closure expectation, so a
  // `propertyNames: true` names the boolean subschema instead of counting as
  // the gate of the patternProperties/propertyNames closure form.
  for (const keyword of schemaMapKeywords) {
    if (node[keyword] === undefined) continue;
    const map = requireKeywordMap(node[keyword], `${path}.${keyword}`);
    for (const [key, child] of Object.entries(map)) {
      assertRecursivelyClosed(child, `${path}.${keyword}.${key}`);
    }
  }
  for (const keyword of schemaValueKeywords) {
    if (node[keyword] === undefined) continue;
    if (keyword === "additionalProperties" && node[keyword] === false) continue;
    assertRecursivelyClosed(node[keyword], `${path}.${keyword}`);
  }
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
      throw new Error(`${path}.oneOf: must be a non-empty array of subschemas`);
    }
    node.oneOf.forEach((child, index) => assertRecursivelyClosed(child, `${path}.oneOf[${index}]`));
  }

  const isObjectNode =
    node.type === "object" ||
    node.properties !== undefined ||
    node.patternProperties !== undefined ||
    node.propertyNames !== undefined;
  if (isObjectNode) {
    const closed = node.additionalProperties === false;
    const gated = Boolean(node.patternProperties && node.propertyNames);
    expect(closed || gated, `${path} is an object node that does not close additional properties`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Derivation: both consumption seams, parsed from the shipped factory source.
// ---------------------------------------------------------------------------

export function deriveHelperCallTokenNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:pxToken|token)\(\s*"(--[\w-]+)"/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

export function deriveSnapshotTokenNames(source: string): string[] {
  const block = source.match(/const appearanceSnapshotTokens = \[([\s\S]*?)\] as const;/);
  if (!block) {
    throw new Error("appearanceSnapshotTokens array not found in stripe-appearance.ts -- the derivation seam moved");
  }
  const names = new Set<string>();
  for (const match of block[1]!.matchAll(/"(--[\w-]+)"/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

export function deriveConsumedTokenNames(source: string): string[] {
  return [...new Set([...deriveHelperCallTokenNames(source), ...deriveSnapshotTokenNames(source)])].sort();
}

// ---------------------------------------------------------------------------
// The shipped half of the fixture, re-derived from styles.css so it can never
// become a transcription that quietly disagrees with what ships.
// ---------------------------------------------------------------------------

function parseAuthoredDeclarations(css: string) {
  const light = new Map<string, string>();
  const darkLiterals = new Map<string, string>();
  const shared = new Map<string, string>();
  const darkAliasNames = new Set<string>();

  let selector: string | null = null;
  let depth = 0;
  let pending = "";

  for (const raw of css.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.endsWith("{")) {
      depth += 1;
      selector = `${pending} ${line.slice(0, -1)}`.trim().replace(/\s+/g, " ");
      pending = "";
      continue;
    }
    if (line === "}") {
      depth -= 1;
      if (depth <= 0) selector = null;
      continue;
    }
    if (line.endsWith(",")) {
      pending = `${pending} ${line}`.trim();
      continue;
    }

    const declaration = line.match(/^(--[\w-]+)\s*:\s*(.+?);$/);
    if (!declaration || !selector) continue;
    const [, name, value] = declaration as unknown as [string, string, string];

    if (name.startsWith("--dark-")) {
      darkLiterals.set(`--${name.slice("--dark-".length)}`, value);
    } else if (selector.includes('[data-color-mode="dark"]') || selector.includes(':root:not([data-theme="light"])')) {
      darkAliasNames.add(name);
    } else if (selector.includes('[data-color-mode="light"]')) {
      if (!light.has(name)) light.set(name, value);
    } else if (!light.has(name) && !shared.has(name)) {
      shared.set(name, value);
    }
  }

  return { light, darkLiterals, shared, darkAliasNames };
}

function shippedValues(css: string, mode: "light" | "dark") {
  const parsed = parseAuthoredDeclarations(css);
  const base = new Map<string, string>([...parsed.shared, ...parsed.light]);
  for (const [name, value] of parsed.darkLiterals) base.set(`--dark-${name.slice(2)}`, value);
  if (mode === "dark") {
    for (const name of parsed.darkAliasNames) {
      const darkName = `--dark-${name.slice(2)}`;
      if (base.has(darkName)) base.set(name, `var(${darkName})`);
    }
  }

  const resolve = (value: string, seen = new Set<string>()): string => {
    const match = value.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
    if (!match) return value.trim();
    if (seen.has(match[1]!)) return match[2]?.trim() ?? "";
    seen.add(match[1]!);
    const next = base.get(match[1]!);
    return next === undefined ? (match[2]?.trim() ?? "") : resolve(next, seen);
  };

  const resolved = new Map<string, string>();
  for (const [name, value] of base) {
    if (name.startsWith("--dark-")) continue;
    resolved.set(name, resolve(value));
  }
  return resolved;
}

const modes = ["light", "dark"] as const;

describe("Ink & Foil candidate token fixture", () => {
  it("validates against its recursively closed schema", () => {
    assertRecursivelyClosed(tokenSchema, "tokenSchema");
    expect(validate(tokenSchema, tokenSchema, fixture)).toEqual([]);
  });

  it("carries every ratified anchor character-for-character", () => {
    const mismatches: string[] = [];
    for (const mode of modes) {
      for (const [name, anchor] of Object.entries(ratifiedAnchors[mode])) {
        const actual = fixture[mode][name]?.candidate;
        if (actual !== anchor) {
          mismatches.push(`${mode} ${name}: expected ${anchor}, fixture has ${JSON.stringify(actual)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("covers the consumed-input union derived from the appearance factory at run time", () => {
    const helperNames = deriveHelperCallTokenNames(appearanceSource);
    const snapshotNames = deriveSnapshotTokenNames(appearanceSource);
    const consumed = deriveConsumedTokenNames(appearanceSource);

    console.log(
      [
        `helper-call names (${helperNames.length}): ${helperNames.join(" ")}`,
        `snapshot-array names (${snapshotNames.length}): ${snapshotNames.join(" ")}`,
        `consumed union (${consumed.length}): ${consumed.join(" ")}`,
      ].join("\n"),
    );

    const missing = consumed.filter((name) => !modes.every((mode) => fixture[mode][name]?.candidate));
    expect(missing, `consumed names absent from the fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("tracks both consumption seams, so an upstream edit through either fails by construction", () => {
    const base = deriveConsumedTokenNames(appearanceSource);

    const withScratchCall = deriveConsumedTokenNames(
      appearanceSource.replace(
        'const primary = token("--primary"',
        'const scratch = token("--scratch-probe", "#000", scope);\n  const primary = token("--primary"',
      ),
    );
    const withScratchSnapshot = deriveConsumedTokenNames(
      appearanceSource.replace('  "--background",\n', '  "--background",\n  "--scratch-snapshot",\n'),
    );

    expect(withScratchCall).toContain("--scratch-probe");
    expect(withScratchCall.length).toBe(base.length + 1);
    expect(withScratchSnapshot).toContain("--scratch-snapshot");
    expect(withScratchSnapshot.length).toBe(base.length + 1);

    // Neither scratch name is in the fixture, so the coverage case above would
    // demand it -- the snapshot array is a derivation input, not an escape
    // hatch.
    for (const scratch of ["--scratch-probe", "--scratch-snapshot"]) {
      expect(fixture.light[scratch]).toBeUndefined();
      expect(fixture.dark[scratch]).toBeUndefined();
    }
  });

  it("covers every custom property the cutover changes, and states today's shipped values correctly", () => {
    const css = readFileSync(stylesPath, "utf8");
    const shipped = { light: shippedValues(css, "light"), dark: shippedValues(css, "dark") };

    const drifted: string[] = [];
    for (const mode of modes) {
      for (const [name, entry] of Object.entries(fixture[mode] as Record<string, { shipped: string }>)) {
        const actual = shipped[mode].get(name);
        if (actual !== undefined && actual !== entry.shipped) {
          drifted.push(`${mode} ${name}: styles.css resolves ${actual}, fixture records ${entry.shipped}`);
        }
      }
    }
    expect(drifted, "fixture shipped values disagree with styles.css").toEqual([]);

    // Every fixture key must be a custom property styles.css actually authors.
    // A phantom or misspelled name would otherwise carry a candidate value that
    // the cutover could never ship and the probe could never resolve.
    const phantom = Object.keys(fixture.light).filter((name) => !shipped.light.has(name) && !shipped.dark.has(name));
    expect(phantom, "fixture names that styles.css does not author").toEqual([]);

    // Every consumed name must be present regardless of whether it changes;
    // the cutover set is the rest.
    const consumed = deriveConsumedTokenNames(appearanceSource);
    expect(consumed.filter((name) => !(name in fixture.light))).toEqual([]);

    const changed = Object.keys(fixture.light).filter((name) =>
      modes.some((mode) => fixture[mode][name].shipped !== fixture[mode][name].candidate),
    );
    const unchangedConsumed = consumed.filter((name) => !changed.includes(name));
    console.log(
      `fixture properties: ${Object.keys(fixture.light).length}; changed by the cutover: ${changed.length}; ` +
        `consumed but unchanged: ${unchangedConsumed.length} (${unchangedConsumed.join(" ")})`,
    );
    expect(changed.length).toBeGreaterThan(0);
  });

  it("keys light and dark identically and records the pre-authorised anchor substitution", () => {
    expect(Object.keys(fixture.light)).toEqual(Object.keys(fixture.dark));
    expect(fixture.preAuthorisedSubstitutions).toEqual([
      {
        property: "--border",
        mode: "dark",
        ratified: "rgba(242, 239, 250, 0.08)",
        opaqueEquivalent: "#3a3450",
        applied: false,
      },
    ]);
    // The ratified alpha border is still the shipping candidate; if the probe
    // forces the opaque equivalent, both this flag and the candidate value move
    // together and every receipt pinned to the old bytes stales.
    expect(fixture.dark["--border"].candidate).toBe("rgba(242, 239, 250, 0.08)");
  });
});

// ---------------------------------------------------------------------------
// Receipt validation. Runs in ordinary CI so a stale, hand-edited, or
// fabricated receipt is a red test rather than a review judgement.
// ---------------------------------------------------------------------------

const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
// (r4 F5) The elements receipt carries both real Elements-consuming surfaces:
// the variables-only Checkout moments and the full-rules setup moments.
type ReceiptSurface = "elements" | "connect";

const requiredMoments: Record<ReceiptSurface, readonly string[]> = {
  elements: ["elements-mount-complete", "elements-update-complete", "setup-mount-complete", "setup-update-complete"],
  connect: ["connect-mount-complete", "connect-update-complete"],
} as const;

// Which deployed origin can mint acceptance evidence for a surface. A lane
// sandbox falls back to fake providers and can never mount a real Element, so
// an unqualified host is a disqualified run, not a weaker one.
const qualifyingHosts = {
  elements: ["https://marketplace.staging.chasesets.com"],
  connect: ["https://marketplace.staging.chasesets.com"],
} as const;

// Committing the receipt moves the head the receipt would have to name, and
// everything that lands after it -- this validator's own repair, the merge
// commit, unrelated work on main -- moves HEAD further. The staleness rule is
// therefore scoped to what the probe actually authorised: the digest-bound
// source paths may not differ between the probed head and the validating
// head. Together with the digest comparison against the committed bytes below,
// that anchors the receipt's digests to the immutable probed commit -- a
// receipt whose digests were re-minted alongside an edited source is refused
// by the tree delta even though its digests match the current bytes -- while
// commits that leave the governed bytes untouched keep the receipt valid.

// Shape-level leak detection, mirroring the probe spec's own retention guard.
// The spec compares retained bytes against the run's actual configured values;
// this side cannot see those values, so it enforces the shapes that are a leak
// regardless of configuration -- including the buyer/session/order/payment
// markers a Stripe-key-and-email pattern set walks straight past.
const leakPatterns = [
  /\b(?:sk|pk|rk|cs)_(?:test|live)_[A-Za-z0-9]{4,}/,
  /\bwhsec_[A-Za-z0-9]{4,}/,
  /\b(?:password|passwd|secret|api[-_]?key|apikey|bearer)\b\s*[=:]\s*\S+/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b(?:pi|seti|pm|cus|acct|ch|py|src|sub|in)_[A-Za-z0-9]{6,}/,
  // (r4 F4) Provider events, provider requests, and payment-method tokens at
  // their real granularity: no test/live mode infix, tok_visa-length suffixes
  // included -- mirroring the probe spec's own retention guard.
  /\b(?:evt|req)_[A-Za-z0-9]{4,}/,
  /\btok_[A-Za-z0-9][A-Za-z0-9_]{3,}/,
  /\b(?:order|buyer)[-_](?:account[-_])?id\b\s*[=:]\s*\S+/i,
  /\b(?:session|sid|sess|csrf|xsrf)[-_]?(?:id|token)?\b\s*[=:]\s*\S+/i,
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
];

// ---------------------------------------------------------------------------
// Derivation: the probe contract, parsed from the probe spec's own source.
//
// Every exact value the receipt is bound to -- the evidence command, the
// environment-name set, the two collected test titles, the mandatory
// observation contract, the painted surface, the digest-bound source paths --
// is read from the bytes that actually run. Transcribing any of them here
// would recreate the defect class that sank the hand-written inventory: a
// contract that silently stops tracking its own source.
// ---------------------------------------------------------------------------

const probeSpecRelativePath = "deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts";
const probeSpecSource = readFileSync(join(repositoryRoot(), probeSpecRelativePath), "utf8");
const connectProbeSpecRelativePath = "deployables/marketplace/e2e/payout-connect-appearance.uat.spec.ts";
const connectProbeSpecSource = readFileSync(join(repositoryRoot(), connectProbeSpecRelativePath), "utf8");
const discoveryArtifactRelativePath = "packages/design-system/src/theme/__fixtures__/stripe-connect-discovery.json";

const surfaceRegistry = {
  elements: {
    probeSpecRelativePath,
    probeSpecSource,
    tag: "@stripe-embed-uat",
    requiredMoments: requiredMoments.elements,
    qualifyingHosts: qualifyingHosts.elements,
  },
  connect: {
    probeSpecRelativePath: connectProbeSpecRelativePath,
    probeSpecSource: connectProbeSpecSource,
    tag: "@connect-appearance-uat",
    requiredMoments: requiredMoments.connect,
    qualifyingHosts: qualifyingHosts.connect,
  },
} as const;

function requireSpecMatch(source: string, pattern: RegExp, what: string): RegExpMatchArray {
  const matched = source.match(pattern);
  if (!matched) {
    throw new Error(`${what} not found in ${probeSpecRelativePath} -- the derivation seam moved`);
  }
  return matched;
}

export function deriveEvidenceCommand(source: string): string {
  return requireSpecMatch(source, /const evidenceCommand =\s*"([^"]+)";/, "evidenceCommand")[1]!;
}

export function deriveRequiredEnvironmentVariableNames(source: string): string[] {
  const block = requireSpecMatch(
    source,
    /const probeEnvironmentVariableNames = \[([\s\S]*?)\];/,
    "probeEnvironmentVariableNames",
  );
  return [...block[1]!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1]!);
}

export function deriveTaggedTestTitles(source: string, tag = "@stripe-embed-uat"): string[] {
  return [...source.matchAll(/^\s*test\(\s*"((?:[^"\\]|\\.)*)"/gm)]
    .map((match) => match[1]!)
    .filter((title) => title.includes(tag));
}

export type DeclaredObservable = { observable: string; sourceToken: string; cssProperty: string };

function deriveObservableBlock(source: string, declaration: string): DeclaredObservable[] {
  const block = requireSpecMatch(
    source,
    new RegExp(`const ${declaration} = \\[([\\s\\S]*?)\\] as const;`),
    declaration,
  );
  return [
    ...block[1]!.matchAll(
      /\{\s*observable:\s*"([^"]+)",\s*sourceToken:\s*"(--[\w-]+)",\s*cssProperty:\s*"([^"]+)"\s*\}/g,
    ),
  ].map((match) => ({ observable: match[1]!, sourceToken: match[2]!, cssProperty: match[3]! }));
}

export function deriveCheckoutMandatoryObservables(source: string): DeclaredObservable[] {
  return deriveObservableBlock(source, "checkoutMandatoryObservables");
}

export function deriveSetupMandatoryObservables(source: string): DeclaredObservable[] {
  return deriveObservableBlock(source, "setupMandatoryObservables");
}

export function deriveConditionalObservables(source: string): DeclaredObservable[] {
  return deriveObservableBlock(source, "conditionalObservables");
}

// (r4 F5) Which observation contract governs a lifecycle moment: the Checkout
// (`cs_`) moments bind only the variables-backed observables production sends
// there; the setup and Connect moments bind the full-rules contract with the
// conditional `.Block` border.
function momentObservationContract(momentName: string) {
  const checkout = momentName.startsWith("elements-");
  return {
    mandatory: checkout
      ? deriveCheckoutMandatoryObservables(probeSpecSource)
      : deriveSetupMandatoryObservables(probeSpecSource),
    conditional: checkout ? [] : deriveConditionalObservables(probeSpecSource),
  };
}

function connectMomentObservationContract(discovery: ConnectDiscoveryArtifact | null): {
  mandatory: DeclaredObservable[];
  conditional: DeclaredObservable[];
} {
  if (!discovery) return { mandatory: [], conditional: [] };
  const separator = deriveConnectObservableNameSeparator(connectProbeSpecSource);
  const mandatory = Object.entries(discovery.groups).flatMap(([sourceToken, group]) =>
    group.elements.flatMap((element) =>
      group.variables.map((variable) => ({
        observable: [variable, element.selectorPath, element.cssProperty].join(separator),
        sourceToken,
        cssProperty: element.cssProperty,
      })),
    ),
  );
  return { mandatory, conditional: [] };
}

export function derivePaintedSurfaceSourceToken(source: string): string {
  return requireSpecMatch(source, /const paintedSurfaceSourceToken = "(--[\w-]+)";/, "paintedSurfaceSourceToken")[1]!;
}

export function deriveReceiptSourceDigestPaths(source: string): string[] {
  const block = requireSpecMatch(
    source,
    /const receiptSourceDigestPaths = \[([\s\S]*?)\] as const;/,
    "receiptSourceDigestPaths",
  );
  return [...block[1]!.matchAll(/([A-Za-z_$][\w$]*)/g)].map((match) => {
    const identifier = match[1]!;
    return requireSpecMatch(source, new RegExp(`const ${identifier} = "([^"]+)";`), `${identifier} declaration`)[1]!;
  });
}

type ConnectSourcePropertyGroup = {
  sourceToken: string;
  cssProperty: string;
  minimum: boolean;
  sentinelColor: string;
  variables: string[];
};

export function deriveConnectSourcePropertyGroups(source: string): ConnectSourcePropertyGroup[] {
  const block = requireSpecMatch(
    source,
    /const connectSourcePropertyGroups = \[([\s\S]*?)\] as const;/,
    "connectSourcePropertyGroups",
  );
  return [
    ...block[1]!.matchAll(
      /\{\s*sourceToken:\s*"(--[\w-]+)",\s*cssProperty:\s*"([^"]+)",\s*minimum:\s*(true|false),\s*sentinelColor:\s*"(#[0-9a-f]{6})",\s*variables:\s*\[([\s\S]*?)\],\s*\}/g,
    ),
  ].map((match) => ({
    sourceToken: match[1]!,
    cssProperty: match[2]!,
    minimum: match[3] === "true",
    sentinelColor: match[4]!,
    variables: [...match[5]!.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((variable) => variable[1]!),
  }));
}

export function deriveConnectObservableNameSeparator(source: string): string {
  return requireSpecMatch(
    source,
    /const connectObservableNameSeparator = "([^"]+)";/,
    "connectObservableNameSeparator",
  )[1]!;
}

// ---------------------------------------------------------------------------
// Colour derivation. A translucent border is only meaningful composited over
// the surface the same factory paints beneath it, so the expected rendered
// colour is computed from two fixture values rather than transcribed.
// ---------------------------------------------------------------------------

type ParsedColor = { r: number; g: number; b: number; a: number };

export function parseCssColor(value: string): ParsedColor | null {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const int = Number.parseInt(hex[1]!, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }
  const fn = value.trim().match(/^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/i);
  if (!fn) return null;
  return {
    r: Number.parseFloat(fn[1]!),
    g: Number.parseFloat(fn[2]!),
    b: Number.parseFloat(fn[3]!),
    a: fn[4] === undefined ? 1 : Number.parseFloat(fn[4]),
  };
}

export function compositeOverOpaque(foreground: string, backdrop: string): string | null {
  const top = parseCssColor(foreground);
  const bottom = parseCssColor(backdrop);
  if (!top || !bottom) return null;
  const channel = (over: number, under: number) => Math.round(over * top.a + under * (1 - top.a));
  const toHex = (component: number) => component.toString(16).padStart(2, "0");
  return `#${toHex(channel(top.r, bottom.r))}${toHex(channel(top.g, bottom.g))}${toHex(channel(top.b, bottom.b))}`;
}

// The receipt's colours are whatever the browser serialised; the fixture's are
// authored hex or rgba. Comparing parsed components binds the value without
// binding a serialisation the validator does not own.
function sameCssColor(left: string, right: string) {
  const a = parseCssColor(left);
  const b = parseCssColor(right);
  if (!a || !b) return normaliseCssValue(left) === normaliseCssValue(right);
  return a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 1e-6;
}

// ---------------------------------------------------------------------------
// Provenance. The receipt cannot name the commit that contains it, so the head
// it names must be a reachable commit after which no digest-bound source path
// changed, and the bytes that determine what the provider was sent are bound
// by digest independently of any commit at all.
// ---------------------------------------------------------------------------

type ProvenanceContext = {
  resolveCommit: (sha: string) => boolean;
  pathsChangedSince: (sha: string) => string[] | null;
  sourceDigests: (surface: ReceiptSurface) => Record<string, string>;
  readDiscoveryArtifact: () => { bytes: Buffer; artifact: unknown } | null;
};

function committedSourceDigests(source = probeSpecSource): Record<string, string> {
  return Object.fromEntries(
    deriveReceiptSourceDigestPaths(source).map((relativePath) => [
      relativePath,
      createHash("sha256")
        .update(readFileSync(join(repositoryRoot(), relativePath)))
        .digest("hex"),
    ]),
  );
}

// A committed receipt legitimately names the commit immediately before the
// commit that added it, and a depth-limited checkout (hosted CI fetches depth
// 1) does not carry that head. Resolution therefore gets one bounded network
// assist -- the same exact-sha idiom the parity probe below uses: a fetch
// pinned to the exact 40-character sha at depth 1, never a branch, a range,
// or unbounded history. A full-history checkout resolves locally and never
// touches the network; a shallow checkout fetches exactly one commit; offline,
// without an origin remote, or against a fabricated head the fetch fails and
// resolution stays false -- the receipt is refused, never skipped. The stale
// check downstream needs only the two trees, which the exact-sha fetch
// carries, so `git diff <sha> HEAD` works across the shallow boundary.
function gitProvenanceAt(root: string): Pick<ProvenanceContext, "resolveCommit" | "pathsChangedSince"> {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const resolvesLocally = (sha: string) => git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) !== null;

  return {
    resolveCommit: (sha) => {
      if (!/^[0-9a-f]{40}$/.test(sha)) return false;
      if (resolvesLocally(sha)) return true;
      git(["fetch", "--quiet", "--depth=1", "origin", sha]);
      return resolvesLocally(sha);
    },
    pathsChangedSince: (sha) => {
      const output = git(["diff", "--name-only", sha, "HEAD"]);
      return output === null
        ? null
        : output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    },
  };
}

function repositoryProvenanceContext(): ProvenanceContext {
  return {
    ...gitProvenanceAt(repositoryRoot()),
    sourceDigests: (surface) => committedSourceDigests(surfaceRegistry[surface].probeSpecSource),
    readDiscoveryArtifact: () => {
      const path = join(repositoryRoot(), discoveryArtifactRelativePath);
      if (!existsSync(path)) return null;
      const bytes = readFileSync(path);
      return { bytes, artifact: JSON.parse(bytes.toString("utf8")) };
    },
  };
}

// The sample head is deterministic so the mutation battery exercises every
// binding rule without depending on the repository's history depth; the
// repository context itself is exercised by its own case below and by every
// committed receipt.
const sampleImplementationHead = "1".repeat(40);

function fixedProvenanceContext(overrides: Partial<ProvenanceContext> = {}): ProvenanceContext {
  return {
    resolveCommit: (sha) => sha === sampleImplementationHead,
    pathsChangedSince: () => [],
    sourceDigests: (surface) => committedSourceDigests(surfaceRegistry[surface].probeSpecSource),
    readDiscoveryArtifact: () => null,
    ...overrides,
  };
}

type ReceiptPaintedOver = { sourceToken: string; expected: string; compositedExpected: string };
type ReceiptObservation = {
  observable: string;
  sourceToken: string;
  cssProperty: string;
  expected: string;
  computed: string;
  matched: boolean;
  mandatory: boolean;
  paintedOver?: ReceiptPaintedOver;
};
type ReceiptMoment = {
  moment: string;
  colorMode: "light" | "dark";
  resolvedTokens: Record<string, string>;
  observations: ReceiptObservation[];
  consoleMessages: { type: string; text: string }[];
  screenshotSha256: string;
  screenshotClip: string;
  screenshotMaskedRegions: number;
};
type AcceptanceReceipt = {
  schemaVersion: string;
  surface: string;
  stripeMode: string;
  implementationHead: string;
  fixturePath: string;
  fixtureSha256: string;
  sourceDigests: Record<string, string>;
  capturedAt: string;
  host: string;
  environmentVariableNames: string[];
  runSummary: {
    command: string;
    workers: number;
    collected: number;
    passed: number;
    failed: number;
    skipped: number;
    testTitles: string[];
  };
  retentionScan: {
    textualArtifacts: number;
    imageArtifacts: number;
    redactionsApplied: number;
    forbiddenMarkerHits: number;
  };
  moments: ReceiptMoment[];
  substitutionsApplied: { property: string; mode: string; from: string; to: string; reason: string }[];
  componentMode?: "account-onboarding" | "account-management";
  discoveryArtifact?: { path: string; sha256: string; sessionNonce: string };
} & Record<string, unknown>;

type DiscoveryElement = {
  selectorPath: string;
  cssProperty: string;
  before: string;
  after: string;
};
type ConnectDiscoveryArtifact = {
  schemaVersion: string;
  sessionNonce: string;
  implementationHead: string;
  deployRunId: string;
  host: string;
  capturedAt: string;
  componentMode: string;
  frameSelector: string;
  environmentVariableNames: string[];
  fixtureSha256: string;
  sourceDigests: Record<string, string>;
  retentionScan: AcceptanceReceipt["retentionScan"];
  groups: Record<string, { variables: string[]; sentinelColor: string; elements: DiscoveryElement[] }>;
};

function bindingViolations(receipt: AcceptanceReceipt, context: ProvenanceContext): string[] {
  const problems: string[] = [];
  const schemaErrors = validate(receiptSchema, receiptSchema, receipt);
  problems.push(...schemaErrors);
  if (schemaErrors.length > 0) return problems;
  const surface = receipt.surface as ReceiptSurface;
  const surfaceContract = surfaceRegistry[surface];

  // --- provenance ---------------------------------------------------------
  if (!context.resolveCommit(receipt.implementationHead)) {
    problems.push(`implementationHead ${receipt.implementationHead} does not resolve to a reachable commit`);
  } else {
    const changed = context.pathsChangedSince(receipt.implementationHead);
    if (changed === null) {
      problems.push(`the delta between implementationHead ${receipt.implementationHead} and HEAD is unknowable`);
    } else {
      const governedPaths = deriveReceiptSourceDigestPaths(surfaceContract.probeSpecSource);
      const staleGoverned = changed.filter((path) => governedPaths.includes(path));
      if (staleGoverned.length > 0) {
        problems.push(
          `implementationHead ${receipt.implementationHead} is stale: ${staleGoverned.join(", ")} changed since it, ` +
            "so the probe's acceptance no longer covers the committed bytes",
        );
      }
    }
  }

  const expectedDigests = context.sourceDigests(surface);
  const declaredDigestPaths = Object.keys(receipt.sourceDigests).sort();
  if (declaredDigestPaths.join("|") !== Object.keys(expectedDigests).sort().join("|")) {
    problems.push(
      `sourceDigests must cover exactly ${Object.keys(expectedDigests).sort().join(", ")}, got ${declaredDigestPaths.join(", ")}`,
    );
  }
  for (const [path, digest] of Object.entries(expectedDigests)) {
    if (receipt.sourceDigests[path] !== digest) {
      problems.push(`sourceDigests[${path}] does not match the committed bytes -- the receipt is stale`);
    }
  }

  // --- run identity -------------------------------------------------------
  const summary = receipt.runSummary;
  const evidenceCommand = deriveEvidenceCommand(surfaceContract.probeSpecSource);
  if (summary.command !== evidenceCommand) {
    problems.push(`runSummary.command must be exactly ${evidenceCommand}, got ${summary.command}`);
  }
  const expectedTitles = deriveTaggedTestTitles(surfaceContract.probeSpecSource, surfaceContract.tag);
  if ([...summary.testTitles].sort().join("|") !== [...expectedTitles].sort().join("|")) {
    problems.push(
      `runSummary.testTitles must be exactly the ${expectedTitles.length} tagged tests declared by the probe spec`,
    );
  }
  if (summary.testTitles.length !== summary.collected) {
    problems.push(`runSummary.testTitles lists ${summary.testTitles.length} of ${summary.collected} collected tests`);
  }
  if (summary.passed !== summary.collected) {
    problems.push(`runSummary.passed (${summary.passed}) must equal runSummary.collected (${summary.collected})`);
  }
  if (receipt.surface === "elements" && summary.collected < 3) {
    problems.push(`runSummary.collected must be at least 3 for the elements surface, got ${summary.collected}`);
  }

  const qualifyingForSurface: readonly string[] = surfaceContract.qualifyingHosts;
  if (!qualifyingForSurface.includes(receipt.host)) {
    problems.push(`host ${receipt.host} is not a qualifying deployed host for the ${receipt.surface} surface`);
  }

  const expectedEnvironmentNames = deriveRequiredEnvironmentVariableNames(surfaceContract.probeSpecSource);
  if ([...receipt.environmentVariableNames].sort().join("|") !== [...expectedEnvironmentNames].sort().join("|")) {
    problems.push(`environmentVariableNames must be exactly ${expectedEnvironmentNames.sort().join(", ")}`);
  }

  if (receipt.fixtureSha256 !== fixtureSha256) {
    problems.push(`fixtureSha256 ${receipt.fixtureSha256} does not match the committed fixture ${fixtureSha256}`);
  }

  // --- lifecycle set ------------------------------------------------------
  const seen = receipt.moments.map((moment) => moment.moment);
  const required = surfaceContract.requiredMoments;
  if ([...seen].sort().join("|") !== [...required].sort().join("|")) {
    problems.push(`moments must be exactly ${[...required].join(", ")}, got ${seen.join(", ")}`);
  }
  if (new Set(seen).size !== seen.length) problems.push(`duplicate lifecycle moments: ${seen.join(", ")}`);

  // Each surface's mount/update pair binds light then dark, and the update
  // moment must actually differ from its mount wherever the fixture's dark
  // candidate differs from its light candidate; a mount-only capture replayed
  // twice cannot satisfy this on either surface.
  const momentByName = new Map(receipt.moments.map((moment) => [moment.moment, moment]));
  const momentPairs = [
    ["elements-mount-complete", "elements-update-complete"],
    ["setup-mount-complete", "setup-update-complete"],
    ["connect-mount-complete", "connect-update-complete"],
  ] as const;
  for (const [mountName, updateName] of momentPairs) {
    const mount = momentByName.get(mountName);
    const update = momentByName.get(updateName);
    if (mount && mount.colorMode !== "light") {
      problems.push(`${mountName} must be captured in light mode, got ${mount.colorMode}`);
    }
    if (update && update.colorMode !== "dark") {
      problems.push(`${updateName} must be captured in dark mode, got ${update.colorMode}`);
    }
    if (mount && update) {
      const shouldDiffer = Object.keys(fixture.light).filter(
        (name) => name in mount.resolvedTokens && fixture.light[name].candidate !== fixture.dark[name].candidate,
      );
      const unchanged = shouldDiffer.filter((name) => mount.resolvedTokens[name] === update.resolvedTokens[name]);
      if (unchanged.length > 0) {
        problems.push(`${updateName} did not move dark-differing tokens: ${unchanged.join(", ")}`);
      }
    }
  }

  let connectDiscovery: ConnectDiscoveryArtifact | null = null;
  if (surface === "connect") {
    const committed = context.readDiscoveryArtifact();
    if (!committed) {
      problems.push(`connect discovery artifact is missing at ${discoveryArtifactRelativePath}`);
    } else {
      const artifact = committed.artifact as ConnectDiscoveryArtifact;
      const discoverySchemaErrors = validate(discoverySchema, discoverySchema, artifact);
      problems.push(...discoverySchemaErrors.map((error) => `connect discovery schema: ${error}`));
      if (discoverySchemaErrors.length === 0) {
        connectDiscovery = artifact;
        const digest = createHash("sha256").update(committed.bytes).digest("hex");
        if (receipt.discoveryArtifact?.sha256 !== digest) {
          problems.push(`discoveryArtifact.sha256 does not match the committed discovery bytes`);
        }
        if (receipt.discoveryArtifact?.sessionNonce !== artifact.sessionNonce) {
          problems.push(`discoveryArtifact.sessionNonce does not match the committed discovery artifact`);
        }
        if (artifact.implementationHead !== receipt.implementationHead) {
          problems.push(`discovery implementationHead does not match the receipt`);
        }
        if (artifact.host !== receipt.host) problems.push(`discovery host does not match the receipt`);
        if (artifact.fixtureSha256 !== receipt.fixtureSha256) {
          problems.push(`discovery fixtureSha256 does not match the receipt`);
        }
        if (artifact.componentMode !== receipt.componentMode) {
          problems.push(`discovery componentMode does not match the receipt`);
        }
        if (Date.parse(artifact.capturedAt) > Date.parse(receipt.capturedAt)) {
          problems.push(`discovery capturedAt is newer than the receipt`);
        }
        const expectedEnvironmentNames = deriveRequiredEnvironmentVariableNames(connectProbeSpecSource);
        if (
          [...artifact.environmentVariableNames].sort().join("|") !== [...expectedEnvironmentNames].sort().join("|")
        ) {
          problems.push(`discovery environmentVariableNames do not match the Connect probe spec`);
        }
        const expectedDigests = context.sourceDigests("connect");
        if (
          Object.entries(artifact.sourceDigests)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([path, digestValue]) => `${path}:${digestValue}`)
            .join("|") !==
          Object.entries(expectedDigests)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([path, digestValue]) => `${path}:${digestValue}`)
            .join("|")
        ) {
          problems.push(`discovery sourceDigests do not match the Connect governed bytes`);
        }
        const declaredGroups = deriveConnectSourcePropertyGroups(connectProbeSpecSource);
        const declaredBySource = new Map(declaredGroups.map((group) => [group.sourceToken, group]));
        for (const [sourceToken, group] of Object.entries(artifact.groups)) {
          const declared = declaredBySource.get(sourceToken);
          if (!declared) {
            problems.push(`discovery records undeclared source group ${sourceToken}`);
            continue;
          }
          if ([...group.variables].sort().join("|") !== [...declared.variables].sort().join("|")) {
            problems.push(`discovery group ${sourceToken} variables do not match the Connect spec`);
          }
          if (group.sentinelColor !== declared.sentinelColor) {
            problems.push(`discovery group ${sourceToken} sentinel does not match the Connect spec`);
          }
          if (group.elements.some((element) => element.cssProperty !== declared.cssProperty)) {
            problems.push(`discovery group ${sourceToken} records the wrong CSS property`);
          }
        }
        for (const declared of declaredGroups.filter((group) => group.minimum)) {
          if (!artifact.groups[declared.sourceToken]) {
            problems.push(`discovery is missing minimum source group ${declared.sourceToken}`);
          }
        }
      }
    }
  }

  // --- observation contract ----------------------------------------------
  const consumed = deriveConsumedTokenNames(appearanceSource);
  const paintedSurfaceToken = surface === "elements" ? derivePaintedSurfaceSourceToken(probeSpecSource) : null;

  for (const moment of receipt.moments) {
    const contract =
      surface === "connect"
        ? connectMomentObservationContract(connectDiscovery)
        : momentObservationContract(moment.moment);
    const declaredByName = new Map(
      [...contract.mandatory, ...contract.conditional].map((entry) => [entry.observable, entry]),
    );
    const resolvedNames = Object.keys(moment.resolvedTokens).sort();
    if (resolvedNames.join("|") !== consumed.join("|")) {
      const missing = consumed.filter((name) => !(name in moment.resolvedTokens));
      const extra = resolvedNames.filter((name) => !consumed.includes(name));
      problems.push(
        `${moment.moment} resolvedTokens must be exactly the ${consumed.length} consumed names ` +
          `(missing: ${missing.join(", ") || "none"}; undeclared: ${extra.join(", ") || "none"})`,
      );
    }
    for (const name of consumed) {
      const expected = fixture[moment.colorMode][name]?.candidate;
      const resolved = moment.resolvedTokens[name];
      if (expected && resolved && normaliseCssValue(resolved) !== normaliseCssValue(expected)) {
        problems.push(
          `${moment.moment} resolved ${name} as ${resolved}, but the fixture candidate is ${expected} -- the injection did not govern`,
        );
      }
    }

    const observableNames = moment.observations.map((observation) => observation.observable);
    if (new Set(observableNames).size !== observableNames.length) {
      problems.push(`${moment.moment} repeats an observable: ${observableNames.join(", ")}`);
    }
    for (const entry of contract.mandatory) {
      if (!observableNames.includes(entry.observable)) {
        problems.push(`${moment.moment} is missing the mandatory observation ${entry.observable}`);
      }
    }

    for (const observation of moment.observations) {
      const declared = declaredByName.get(observation.observable);
      if (!declared) {
        problems.push(`${moment.moment} carries the undeclared observation ${observation.observable}`);
        continue;
      }
      if (!observation.mandatory) {
        problems.push(`${moment.moment} observation ${observation.observable} is marked optional`);
      }
      if (observation.sourceToken !== declared.sourceToken || observation.cssProperty !== declared.cssProperty) {
        problems.push(
          `${moment.moment} observation ${observation.observable} must read ${declared.cssProperty} from ${declared.sourceToken}`,
        );
      }
      const declaredValue = fixture[moment.colorMode][declared.sourceToken]?.candidate;
      if (!declaredValue || !sameCssColor(observation.expected, declaredValue)) {
        problems.push(
          `${moment.moment} observation ${observation.observable} expects ${observation.expected}, which is not the fixture candidate for ${declared.sourceToken}`,
        );
      }
      if (!sameCssColor(observation.computed, observation.expected)) {
        problems.push(
          `${moment.moment} observation ${observation.observable}: expected ${observation.expected}, computed ${observation.computed}`,
        );
      } else if (!observation.matched) {
        problems.push(
          `${moment.moment} observation ${observation.observable} is recorded as unmatched, so the run did not accept it`,
        );
      }

      // A translucent border is the value this probe exists to settle, so a
      // border observation must carry the surface it was painted over and the
      // composite the validator re-derives from the fixture; any other
      // observable carrying one is fabricating a derivation it never made.
      if (declared.cssProperty === "border-color") {
        const surfaceValue = paintedSurfaceToken
          ? fixture[moment.colorMode][paintedSurfaceToken]?.candidate
          : undefined;
        const composited = declaredValue && surfaceValue ? compositeOverOpaque(declaredValue, surfaceValue) : null;
        if (!observation.paintedOver) {
          problems.push(`${moment.moment} border observation ${observation.observable} records no painted surface`);
        } else if (
          observation.paintedOver.sourceToken !== paintedSurfaceToken ||
          !surfaceValue ||
          !sameCssColor(observation.paintedOver.expected, surfaceValue) ||
          !composited ||
          !sameCssColor(observation.paintedOver.compositedExpected, composited)
        ) {
          problems.push(
            `${moment.moment} border observation ${observation.observable} is not composited over the fixture-declared ${paintedSurfaceToken}`,
          );
        }
      } else if (observation.paintedOver) {
        problems.push(
          `${moment.moment} observation ${observation.observable} records a painted surface it never composited over`,
        );
      }
    }
  }

  // --- retained-artifact accounting ---------------------------------------
  if (receipt.retentionScan.imageArtifacts !== receipt.moments.length) {
    problems.push(
      `retentionScan.imageArtifacts (${receipt.retentionScan.imageArtifacts}) must equal the ${receipt.moments.length} retained moment screenshots`,
    );
  }

  // --- authorised substitutions only --------------------------------------
  const preAuthorised = (fixture.preAuthorisedSubstitutions ?? []) as {
    property: string;
    mode: string;
    ratified: string;
    opaqueEquivalent: string;
    applied: boolean;
  }[];
  for (const substitution of receipt.substitutionsApplied) {
    const authorised = preAuthorised.find(
      (entry) =>
        entry.property === substitution.property &&
        entry.mode === substitution.mode &&
        entry.ratified === substitution.from &&
        entry.opaqueEquivalent === substitution.to,
    );
    if (!authorised) {
      problems.push(
        `substitution of ${substitution.property} in ${substitution.mode} is not a pre-authorised anchor substitution`,
      );
    } else if (!authorised.applied) {
      problems.push(
        `substitution of ${substitution.property} in ${substitution.mode} is not recorded as applied in the fixture`,
      );
    }
  }

  const serialised = JSON.stringify(receipt);
  for (const pattern of leakPatterns) {
    if (pattern.test(serialised)) problems.push(`receipt carries a retained value matching ${pattern}`);
  }

  return problems;
}

function normaliseCssValue(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function sampleObservation(entry: DeclaredObservable, colorMode: "light" | "dark"): ReceiptObservation {
  const declared = fixture[colorMode][entry.sourceToken].candidate;
  const observation: ReceiptObservation = {
    observable: entry.observable,
    sourceToken: entry.sourceToken,
    cssProperty: entry.cssProperty,
    expected: declared,
    computed: declared,
    matched: true,
    mandatory: true,
  };
  if (entry.cssProperty !== "border-color") return observation;

  const paintedToken = derivePaintedSurfaceSourceToken(probeSpecSource);
  const surface = fixture[colorMode][paintedToken].candidate;
  return {
    ...observation,
    paintedOver: {
      sourceToken: paintedToken,
      expected: surface,
      compositedExpected: compositeOverOpaque(declared, surface)!,
    },
  };
}

function validReceiptSample(): AcceptanceReceipt {
  const consumed = deriveConsumedTokenNames(appearanceSource);
  const moment = (name: string, colorMode: "light" | "dark"): ReceiptMoment => ({
    moment: name,
    colorMode,
    resolvedTokens: Object.fromEntries(consumed.map((token) => [token, fixture[colorMode][token].candidate])),
    observations: momentObservationContract(name).mandatory.map((entry) => sampleObservation(entry, colorMode)),
    consoleMessages: [],
    screenshotSha256: "a".repeat(64),
    screenshotClip: "stripe-frame",
    screenshotMaskedRegions: 0,
  });

  return {
    schemaVersion: "stripe-appearance-acceptance-receipt/v1",
    surface: "elements",
    stripeMode: "test",
    implementationHead: sampleImplementationHead,
    fixturePath: "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
    fixtureSha256,
    sourceDigests: committedSourceDigests(),
    capturedAt: "2026-08-09T12:00:00Z",
    host: "https://marketplace.staging.chasesets.com",
    environmentVariableNames: deriveRequiredEnvironmentVariableNames(probeSpecSource),
    runSummary: {
      command: deriveEvidenceCommand(probeSpecSource),
      workers: 1,
      collected: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
      testTitles: deriveTaggedTestTitles(probeSpecSource),
    },
    retentionScan: { textualArtifacts: 4, imageArtifacts: 4, redactionsApplied: 0, forbiddenMarkerHits: 0 },
    moments: [
      moment("elements-mount-complete", "light"),
      moment("elements-update-complete", "dark"),
      moment("setup-mount-complete", "light"),
      moment("setup-update-complete", "dark"),
    ],
    substitutionsApplied: [],
  };
}

function validConnectSampleBundle() {
  const sourceGroups = deriveConnectSourcePropertyGroups(connectProbeSpecSource);
  const groups: ConnectDiscoveryArtifact["groups"] = Object.fromEntries(
    sourceGroups
      .filter((group) => group.minimum)
      .map((group, index) => [
        group.sourceToken,
        {
          variables: [...group.variables],
          sentinelColor: group.sentinelColor,
          elements: [
            {
              selectorPath: `body > synthetic-${index + 1}`,
              cssProperty: group.cssProperty,
              before: index === 0 ? "rgb(255, 255, 255)" : "rgb(15, 23, 42)",
              after: normaliseCssValue(group.sentinelColor),
            },
          ],
        },
      ]),
  );
  const discovery: ConnectDiscoveryArtifact = {
    schemaVersion: "stripe-connect-discovery/v1",
    sessionNonce: "a".repeat(32),
    implementationHead: sampleImplementationHead,
    deployRunId: "31383423018",
    host: "https://marketplace.staging.chasesets.com",
    capturedAt: "2026-08-10T11:00:00Z",
    componentMode: "account-management",
    frameSelector: '[data-testid="stripe-connect-embedded-component"] stripe-connect-account-management iframe',
    environmentVariableNames: deriveRequiredEnvironmentVariableNames(connectProbeSpecSource),
    fixtureSha256,
    sourceDigests: committedSourceDigests(connectProbeSpecSource),
    retentionScan: { textualArtifacts: 1, imageArtifacts: 0, redactionsApplied: 0, forbiddenMarkerHits: 0 },
    groups,
  };
  const discoveryBytes = Buffer.from(`${JSON.stringify(discovery, null, 2)}\n`);
  const contract = connectMomentObservationContract(discovery).mandatory;
  const consumed = deriveConsumedTokenNames(appearanceSource);
  const moment = (name: string, colorMode: "light" | "dark"): ReceiptMoment => ({
    moment: name,
    colorMode,
    resolvedTokens: Object.fromEntries(consumed.map((token) => [token, fixture[colorMode][token].candidate])),
    observations: contract.map((entry) => sampleObservation(entry, colorMode)),
    consoleMessages: [],
    screenshotSha256: "b".repeat(64),
    screenshotClip: "stripe-frame",
    screenshotMaskedRegions: 1,
  });
  const receipt: AcceptanceReceipt = {
    schemaVersion: "stripe-appearance-acceptance-receipt/v1",
    surface: "connect",
    stripeMode: "test",
    implementationHead: sampleImplementationHead,
    fixturePath: "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
    fixtureSha256,
    sourceDigests: committedSourceDigests(connectProbeSpecSource),
    capturedAt: "2026-08-10T12:00:00Z",
    host: "https://marketplace.staging.chasesets.com",
    environmentVariableNames: deriveRequiredEnvironmentVariableNames(connectProbeSpecSource),
    runSummary: {
      command: deriveEvidenceCommand(connectProbeSpecSource),
      workers: 1,
      collected: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      testTitles: deriveTaggedTestTitles(connectProbeSpecSource, "@connect-appearance-uat"),
    },
    retentionScan: { textualArtifacts: 2, imageArtifacts: 2, redactionsApplied: 2, forbiddenMarkerHits: 0 },
    moments: [moment("connect-mount-complete", "light"), moment("connect-update-complete", "dark")],
    substitutionsApplied: [],
    componentMode: "account-management",
    discoveryArtifact: {
      path: discoveryArtifactRelativePath,
      sha256: createHash("sha256").update(discoveryBytes).digest("hex"),
      sessionNonce: discovery.sessionNonce,
    },
  };
  return { receipt, discovery, discoveryBytes };
}

function fixedConnectProvenanceContext(bundle = validConnectSampleBundle()): ProvenanceContext {
  return fixedProvenanceContext({
    readDiscoveryArtifact: () => ({ bytes: bundle.discoveryBytes, artifact: bundle.discovery }),
  });
}

describe("Stripe appearance acceptance receipts", () => {
  it("uses recursively closed receipt and discovery schemas", () => {
    assertRecursivelyClosed(receiptSchema, "receiptSchema");
    assertRecursivelyClosed(discoverySchema, "discoverySchema");
    const connect = validConnectSampleBundle();
    expect(validate(discoverySchema, discoverySchema, connect.discovery)).toEqual([]);
  });

  it("uses the schema's surface branches to accept each honest shape and reject cross-surface fields", () => {
    const elements = validReceiptSample();
    const connect = validConnectSampleBundle().receipt;
    expect(validate(receiptSchema, receiptSchema, elements)).toEqual([]);
    expect(validate(receiptSchema, receiptSchema, connect)).toEqual([]);

    const elementsWithConnectFields = JSON.parse(JSON.stringify(elements)) as AcceptanceReceipt;
    elementsWithConnectFields.componentMode = "account-management";
    elementsWithConnectFields.discoveryArtifact = {
      path: discoveryArtifactRelativePath,
      sha256: "a".repeat(64),
      sessionNonce: "a".repeat(32),
    };
    expect(validate(receiptSchema, receiptSchema, elementsWithConnectFields)).not.toEqual([]);

    const connectWithoutDiscovery = JSON.parse(JSON.stringify(connect)) as AcceptanceReceipt;
    delete connectWithoutDiscovery.discoveryArtifact;
    expect(validate(receiptSchema, receiptSchema, connectWithoutDiscovery)).not.toEqual([]);
  });

  it("keeps the surface branch mutation red: dropping oneOf accepts the cross-surface forgery", () => {
    const forged = validConnectSampleBundle().receipt;
    forged.surface = "elements";
    const branchless = JSON.parse(JSON.stringify(receiptSchema)) as Record<string, unknown>;
    delete branchless.oneOf;

    expect(validate(branchless, branchless, forged)).toEqual([]);
    expect(validate(receiptSchema, receiptSchema, forged)).not.toEqual([]);
  });

  it.each([
    ["directly under properties", ["$defs", "elementsReceipt", "properties", "host"]],
    ["under a $defs property", ["$defs", "observation", "properties", "expected"]],
    ["under a nested $defs object node", ["$defs", "moment", "properties", "resolvedTokens"]],
  ])("refuses an unsupported schema keyword nested %s", (_label, path) => {
    const mutated = JSON.parse(JSON.stringify(receiptSchema)) as Record<string, unknown>;
    let node = mutated;
    for (const segment of path) node = node[segment] as Record<string, unknown>;
    node.maxLength = 5;
    expect(() => assertRecursivelyClosed(mutated, "receiptSchema")).toThrow(/unsupported schema keyword maxLength/);
  });

  // -------------------------------------------------------------------------
  // AC-08: boolean subschemas fail closed at every schema-bearing position.
  // A `true` node under properties, $defs, items, or propertyNames reads as a
  // constraint while binding nothing, and `false` silently forbids; both are
  // refused with a named path at the closure walk AND at the validator, so
  // neither layer can be reopened alone.
  // -------------------------------------------------------------------------

  const mutateReceiptSchema = (path: string[], value: unknown) => {
    const mutated = JSON.parse(JSON.stringify(receiptSchema)) as Record<string, unknown>;
    let node = mutated;
    for (const segment of path.slice(0, -1)) node = node[segment] as Record<string, unknown>;
    node[path[path.length - 1]!] = value;
    return mutated;
  };

  const booleanSubschemaPositions: [string, string[]][] = [
    // The three bypasses the r2 review executed.
    ["$defs.elementsReceipt.properties.capturedAt", ["$defs", "elementsReceipt", "properties", "capturedAt"]],
    ["$defs.consoleMessage.properties.text", ["$defs", "consoleMessage", "properties", "text"]],
    ["$defs.moment.properties.screenshotSha256", ["$defs", "moment", "properties", "screenshotSha256"]],
    // The items position.
    ["$defs.moment.properties.observations.items", ["$defs", "moment", "properties", "observations", "items"]],
    // The propertyNames position: the closure walk's gated
    // patternProperties-plus-propertyNames form must not accept a boolean as
    // its gate (planning-review N1).
    ["$defs.sourceDigests.propertyNames", ["$defs", "sourceDigests", "propertyNames"]],
    // The resolution target of a $ref.
    ["$defs.elementsRunSummary", ["$defs", "elementsRunSummary"]],
    // additionalProperties may be exactly false or a plain object node, never
    // true.
    ["$defs.elementsRunSummary.additionalProperties", ["$defs", "elementsRunSummary", "additionalProperties"]],
  ];

  it.each(
    booleanSubschemaPositions.flatMap(([label, path]): [string, boolean, string[]][] =>
      label.endsWith(".additionalProperties")
        ? [[label, true, path]]
        : [
            [label, true, path],
            [label, false, path],
          ],
    ),
  )("closure walk refuses a boolean subschema at %s (%s)", (label, booleanValue, path) => {
    const mutated = mutateReceiptSchema(path, booleanValue);
    expect(() => assertRecursivelyClosed(mutated, "receiptSchema")).toThrow(
      `receiptSchema.${label}: boolean subschema is not a closed object node`,
    );
  });

  it.each(booleanSubschemaPositions.filter(([label]) => !label.endsWith(".additionalProperties")))(
    "validator throws on a boolean subschema reached through %s instead of validating as unconstrained",
    (_label, path) => {
      const mutated = mutateReceiptSchema(path, true);
      const sample = validReceiptSample();
      // A retained console line makes the $defs.consoleMessage subtree
      // reachable, so the mutated position is actually exercised rather than
      // skipped behind an empty array.
      sample.moments[0].consoleMessages = [{ type: "log", text: "probe log line" }];
      expect(() => validate(mutated, mutated, sample)).toThrow(/boolean subschema is not a closed object node/);
    },
  );

  it("validator throws on additionalProperties: true instead of treating extra properties as unconstrained", () => {
    const mutated = mutateReceiptSchema(["$defs", "elementsRunSummary", "additionalProperties"], true);
    expect(() => validate(mutated, mutated, validReceiptSample())).toThrow(
      /additionalProperties: boolean subschema is not a closed object node/,
    );
  });

  it("validator throws on a directly reopened boolean schema node", () => {
    // The direct validate-layer case: with the coercion escape removed, a
    // boolean root schema throws rather than validating anything -- so the
    // closure walk and the validator refuse independently.
    expect(() => validate(receiptSchema, true, validReceiptSample())).toThrow(
      "$: boolean subschema is not a closed object node",
    );
    expect(() => validate(receiptSchema, false, validReceiptSample())).toThrow(
      "$: boolean subschema is not a closed object node",
    );
  });

  it("keeps ordinary boolean keyword values and exact-false additionalProperties working", () => {
    // uniqueItems: true is a keyword value, not a schema-bearing position, and
    // every additionalProperties: false in both committed schemas remains the
    // closure form -- the committed schemas keep validating unedited.
    assertRecursivelyClosed(receiptSchema, "receiptSchema");
    assertRecursivelyClosed(tokenSchema, "tokenSchema");
    expect(validate(receiptSchema, receiptSchema, validReceiptSample())).toEqual([]);
    expect(validate(tokenSchema, tokenSchema, fixture)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // AC-08 (r4 F2): unreachable schema positions. Each mutation lives where
  // conforming candidate data never travels -- an absent optional property, an
  // unmatched patternProperties entry, an unused $defs entry, and a nested
  // additionalProperties inside an unreached subtree -- and is refused by the
  // closure walk AND by validate()'s independent preflight, called directly
  // with a conforming receipt that never reaches the mutated node.
  // -------------------------------------------------------------------------

  const unreachableBooleanPositions: [string, string[]][] = [
    [
      "$defs.elementsReceipt.properties.parityAbsentOptional",
      ["$defs", "elementsReceipt", "properties", "parityAbsentOptional"],
    ],
    [
      "$defs.sourceDigests.patternProperties.^parity-never-matches-[0-9]+$",
      ["$defs", "sourceDigests", "patternProperties", "^parity-never-matches-[0-9]+$"],
    ],
    ["$defs.parityUnusedProbe", ["$defs", "parityUnusedProbe"]],
  ];

  it.each(
    unreachableBooleanPositions.flatMap(([label, path]): [string, boolean, string[]][] => [
      [label, true, path],
      [label, false, path],
    ]),
  )("closure walk refuses a boolean subschema at unreachable %s (%s)", (label, booleanValue, path) => {
    const mutated = mutateReceiptSchema(path, booleanValue);
    expect(() => assertRecursivelyClosed(mutated, "receiptSchema")).toThrow(
      `receiptSchema.${label}: boolean subschema is not a closed object node`,
    );
  });

  it.each(
    unreachableBooleanPositions.flatMap(([label, path]): [string, boolean, string[]][] => [
      [label, true, path],
      [label, false, path],
    ]),
  )(
    "validator preflight refuses a boolean subschema at unreachable %s (%s) before any data traversal",
    (_label, booleanValue, path) => {
      const mutated = mutateReceiptSchema(path, booleanValue);
      expect(() => validate(mutated, mutated, validReceiptSample())).toThrow(
        /boolean subschema is not a closed object node/,
      );
    },
  );

  it("refuses a boolean at a nested additionalProperties position inside an unreached subtree, at both layers", () => {
    const mutated = mutateReceiptSchema(["$defs", "parityNestedProbe"], { additionalProperties: true });
    expect(() => assertRecursivelyClosed(mutated, "receiptSchema")).toThrow(
      "receiptSchema.$defs.parityNestedProbe.additionalProperties: boolean subschema is not a closed object node",
    );
    expect(() => validate(mutated, mutated, validReceiptSample())).toThrow(
      /additionalProperties: boolean subschema is not a closed object node/,
    );
  });

  // The complete governing applicator list from the r3 review's executed
  // probe, each planted where no candidate data travels: the validator's
  // preflight refuses the keyword regardless of reachability, and the closure
  // walk refuses it independently.
  const unsupportedApplicators: [string, unknown][] = [
    ["allOf", [{}]],
    ["anyOf", [{}]],
    ["not", {}],
    ["if", {}],
    ["then", {}],
    ["else", {}],
    ["prefixItems", [{}]],
    ["contains", {}],
    ["dependentSchemas", {}],
    ["everyOf", [{}]],
  ];

  it.each(unsupportedApplicators)(
    "refuses the unsupported applicator %s at both layers, unreachable by data",
    (keyword, value) => {
      const mutated = mutateReceiptSchema(["$defs", "parityApplicatorProbe"], { [keyword]: value });
      expect(() => assertRecursivelyClosed(mutated, "receiptSchema")).toThrow(
        `receiptSchema.$defs.parityApplicatorProbe: unsupported schema keyword ${keyword}`,
      );
      expect(() => validate(mutated, mutated, validReceiptSample())).toThrow(
        new RegExp(`unsupported schema keyword ${keyword}`),
      );
    },
  );

  // -------------------------------------------------------------------------
  // AC-08 (r4 F2): executable predecessor/candidate parity. The predecessor
  // closure and validator implementations are extracted from the bytes git
  // records at the pre-repair head -- executed, never transcribed -- and run
  // in a child Node process over the identical mutation set and the identical
  // conforming sample. The recorded gap is the r3 finding: predecessor
  // validate() accepted every one of these schemas while the candidate
  // refuses each at both layers.
  // -------------------------------------------------------------------------

  // The rebased, remote-reachable equivalent of the r2-reviewed head
  // 3535cc612d59a53240bd20b1606d2546f30fc0a1: the fixture-test bytes are
  // identical at both (planning-review r4 N1), and only this head is
  // reachable from the pushed branch.
  const parityPredecessorHead = "4947eeab3a514fa39003e43577847bbaee0687e4";
  const parityPredecessorSha256 = "dc3dcbb565ff4a0d0305b0b0e37d21b165bb216247c4be9161b93cce05029c08";
  const parityPredecessorPath = "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts";

  function predecessorFixtureTestSource(): string {
    const root = repositoryRoot();
    const show = () =>
      execFileSync("git", ["show", `${parityPredecessorHead}:${parityPredecessorPath}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    let source: string;
    try {
      source = show();
    } catch {
      // A depth-limited checkout (hosted CI fetches depth 1) does not carry
      // the predecessor commit. It is reachable from the pushed branch, so an
      // exact-sha fetch restores it; if that also fails, this parity case
      // fails -- the predecessor implementation is required evidence, never
      // skippable.
      execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", parityPredecessorHead], {
        cwd: root,
        stdio: "ignore",
      });
      source = show();
    }
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    expect(
      digest,
      "the predecessor fixture-test bytes moved; the parity pin no longer names the r2-reviewed implementation",
    ).toBe(parityPredecessorSha256);
    return source;
  }

  function extractPredecessorValidatorSection(source: string): string {
    const start = source.indexOf("const supportedKeywords");
    const end = source.indexOf("export function deriveHelperCallTokenNames");
    expect(start, "predecessor validator section start marker missing").toBeGreaterThan(-1);
    expect(end, "predecessor validator section end marker missing").toBeGreaterThan(start);
    return source.slice(start, end);
  }

  type ParityRow = { label: string; closure: string | null; validate: string | null };

  function runPredecessorParityProbe(
    mutations: { label: string; schema: unknown }[],
    sample: AcceptanceReceipt,
  ): ParityRow[] {
    const section = extractPredecessorValidatorSection(predecessorFixtureTestSource());
    const workspace = mkdtempSync(join(tmpdir(), "ink-foil-parity-"));
    try {
      const modulePath = join(workspace, "predecessor-parity-probe.mts");
      const inputPath = join(workspace, "parity-input.json");
      writeFileSync(inputPath, JSON.stringify({ mutations, sample }));
      writeFileSync(
        modulePath,
        [
          'import { readFileSync } from "node:fs";',
          // The predecessor section calls vitest's expect(value, message).toBe;
          // this minimal shim preserves its throw-on-mismatch semantics so the
          // extracted functions run exactly as written.
          "const expect = (value: unknown, message?: string) => ({",
          "  toBe(expected: unknown) {",
          '    if (value !== expected) throw new Error(String(message ?? "expectation failed"));',
          "  },",
          "});",
          section,
          'const input = JSON.parse(readFileSync(process.argv[2] as string, "utf8"));',
          "const rows = input.mutations.map((mutation: { label: string; schema: unknown }) => {",
          "  const closure = (() => {",
          '    try { assertRecursivelyClosed(mutation.schema, "receiptSchema"); return null; }',
          "    catch (error) { return `threw: ${(error as Error).message}`; }",
          "  })();",
          "  const validated = (() => {",
          "    try {",
          "      const errors = validate(mutation.schema as never, mutation.schema as never, input.sample);",
          "      return errors.length === 0 ? null : `errors: ${errors[0]}`;",
          "    } catch (error) { return `threw: ${(error as Error).message}`; }",
          "  })();",
          "  return { label: mutation.label, closure, validate: validated };",
          "});",
          "process.stdout.write(JSON.stringify(rows));",
        ].join("\n"),
      );
      const stdout = execFileSync(process.execPath, [modulePath, inputPath], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse(stdout) as ParityRow[];
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("proves executable predecessor/candidate parity: predecessor validate() acceptances become candidate refusals", () => {
    const parityMutations: { label: string; schema: unknown; baseline?: boolean }[] = [
      { label: "unmutated committed schema (baseline)", schema: receiptSchema, baseline: true },
      { label: "root boolean schema", schema: true },
      {
        label: "boolean in an absent optional property (properties.parityAbsentOptional)",
        schema: mutateReceiptSchema(["$defs", "elementsReceipt", "properties", "parityAbsentOptional"], true),
      },
      {
        label: "boolean in an unmatched patternProperties entry",
        schema: mutateReceiptSchema(
          ["$defs", "sourceDigests", "patternProperties", "^parity-never-matches-[0-9]+$"],
          true,
        ),
      },
      {
        label: "boolean in an unused $defs entry",
        schema: mutateReceiptSchema(["$defs", "parityUnusedProbe"], true),
      },
      {
        label: "boolean at a nested additionalProperties in an unreached subtree",
        schema: mutateReceiptSchema(["$defs", "parityNestedProbe"], { additionalProperties: true }),
      },
      {
        label: "boolean under properties.capturedAt",
        schema: mutateReceiptSchema(["$defs", "elementsReceipt", "properties", "capturedAt"], true),
      },
      {
        label: "boolean at $defs.moment.properties.observations.items",
        schema: mutateReceiptSchema(["$defs", "moment", "properties", "observations", "items"], true),
      },
      ...unsupportedApplicators.map(([keyword, value]) => ({
        label: `unsupported applicator ${keyword} in an unreached $defs entry`,
        schema: mutateReceiptSchema(["$defs", "parityApplicatorProbe"], { [keyword]: value }) as unknown,
      })),
    ];
    const sample = validReceiptSample();

    const outcomeOf = (run: () => string | null): string => {
      try {
        return run() ?? "accepted";
      } catch (error) {
        return `threw: ${(error as Error).message}`;
      }
    };

    const candidateResults = parityMutations.map((mutation) => ({
      closure: outcomeOf(() => {
        assertRecursivelyClosed(mutation.schema, "receiptSchema");
        return null;
      }),
      validate: outcomeOf(() => {
        const errors = validate(mutation.schema as SchemaNode, mutation.schema, sample);
        return errors.length === 0 ? null : `errors: ${errors[0]}`;
      }),
    }));

    const predecessorResults = runPredecessorParityProbe(
      parityMutations.map(({ label, schema }) => ({ label, schema })),
      sample,
    );
    expect(predecessorResults).toHaveLength(parityMutations.length);

    for (const [index, mutation] of parityMutations.entries()) {
      const row = {
        label: mutation.label,
        predecessorClosure: predecessorResults[index]!.closure ?? "accepted",
        predecessorValidate: predecessorResults[index]!.validate ?? "accepted",
        candidateClosure: candidateResults[index]!.closure,
        candidateValidate: candidateResults[index]!.validate,
      };
      console.log(
        `parity | ${row.label} | predecessor closure=${row.predecessorClosure} validate=${row.predecessorValidate} | ` +
          `candidate closure=${row.candidateClosure} validate=${row.candidateValidate}`,
      );
      if (mutation.baseline) {
        // The predecessor closure predates the now-supported oneOf surface
        // contract, while its shallow validator ignores that applicator. The
        // candidate accepts and enforces it at both layers.
        expect(row.predecessorClosure, "predecessor baseline closure").toContain("unsupported schema keyword oneOf");
        expect(row.predecessorValidate, "predecessor baseline validate").toBe("accepted");
        expect(row.candidateClosure, "candidate baseline closure").toBe("accepted");
        expect(row.candidateValidate, "candidate baseline validate").toBe("accepted");
        continue;
      }
      expect(
        row.predecessorValidate,
        `predecessor validate() no longer accepts "${mutation.label}" -- the parity gap this battery records has moved`,
      ).toBe("accepted");
      expect(
        row.candidateValidate.startsWith("threw:"),
        `candidate validate() must refuse "${mutation.label}" through its preflight, got ${row.candidateValidate}`,
      ).toBe(true);
      expect(
        row.candidateClosure.startsWith("threw:"),
        `candidate closure must refuse "${mutation.label}", got ${row.candidateClosure}`,
      ).toBe(true);
    }
  });

  it("derives the probe contract from the spec source rather than transcribing it", () => {
    const checkoutMandatory = deriveCheckoutMandatoryObservables(probeSpecSource);
    const setupMandatory = deriveSetupMandatoryObservables(probeSpecSource);
    const conditional = deriveConditionalObservables(probeSpecSource);
    const titles = deriveTaggedTestTitles(probeSpecSource);

    console.log(
      [
        `evidence command: ${deriveEvidenceCommand(probeSpecSource)}`,
        `environment names (${deriveRequiredEnvironmentVariableNames(probeSpecSource).length}): ${deriveRequiredEnvironmentVariableNames(probeSpecSource).join(" ")}`,
        `tagged test titles (${titles.length})`,
        `checkout mandatory observables (${checkoutMandatory.length}): ${checkoutMandatory.map((entry) => `${entry.observable}<-${entry.sourceToken}`).join(" ")}`,
        `setup mandatory observables (${setupMandatory.length}): ${setupMandatory.map((entry) => `${entry.observable}<-${entry.sourceToken}`).join(" ")}`,
        `conditional observables (${conditional.length}): ${conditional.map((entry) => `${entry.observable}<-${entry.sourceToken}`).join(" ")}`,
        `painted surface: ${derivePaintedSurfaceSourceToken(probeSpecSource)}`,
        `digest-bound sources: ${deriveReceiptSourceDigestPaths(probeSpecSource).join(" ")}`,
      ].join("\n"),
    );

    expect(titles).toHaveLength(3);
    // The border observable is the reason this probe exists; it lives on the
    // rules-bearing setup surface (r4 F5), and losing it there must fail here
    // rather than quietly weakening every receipt.
    expect(setupMandatory.map((entry) => entry.sourceToken)).toContain("--border");
    // Production sends no rules to the Checkout surface (r4 F5), so no
    // rules-only token may enter its observation contract.
    const rulesOnlyTokens = ["--surface-2", "--border", "--ring", "--shadow-sm", "--control-md-py", "--control-md-px"];
    expect(checkoutMandatory.length).toBeGreaterThan(0);
    expect(checkoutMandatory.filter((entry) => rulesOnlyTokens.includes(entry.sourceToken))).toEqual([]);
    expect(deriveReceiptSourceDigestPaths(probeSpecSource)).toContain(probeSpecRelativePath);

    const connectTitles = deriveTaggedTestTitles(connectProbeSpecSource, "@connect-appearance-uat");
    const connectGroups = deriveConnectSourcePropertyGroups(connectProbeSpecSource);
    console.log(
      [
        `Connect evidence command: ${deriveEvidenceCommand(connectProbeSpecSource)}`,
        `Connect environment names: ${deriveRequiredEnvironmentVariableNames(connectProbeSpecSource).join(" ")}`,
        `Connect tagged test titles (${connectTitles.length}): ${connectTitles.join(" | ")}`,
        `Connect groups: ${connectGroups.map((group) => `${group.sourceToken}<-${group.variables.join(",")}`).join(" ")}`,
        `Connect digest-bound sources: ${deriveReceiptSourceDigestPaths(connectProbeSpecSource).join(" ")}`,
      ].join("\n"),
    );
    expect(connectTitles).toEqual([
      "proves the deployed Connect embedded surface accepts the candidate appearance at the completed initialisation and after the mode-change re-initialisation @connect-appearance-uat",
    ]);
    expect(connectGroups.map((group) => group.sourceToken)).toEqual([
      "--card",
      "--foreground",
      "--text-secondary",
      "--surface-2",
    ]);
    expect(connectGroups.filter((group) => group.minimum).map((group) => group.sourceToken)).toEqual([
      "--card",
      "--foreground",
    ]);
    expect(deriveReceiptSourceDigestPaths(connectProbeSpecSource)).toContain(connectProbeSpecRelativePath);
  });

  it.each([
    ["elements", probeSpecSource],
    ["connect", connectProbeSpecSource],
  ] as const)("binds committed %s source digests to exactly that surface's derived paths", (_surface, source) => {
    expect(Object.keys(committedSourceDigests(source)).sort()).toEqual(
      [...deriveReceiptSourceDigestPaths(source)].sort(),
    );
  });

  it("accepts a well-formed receipt bound to the committed fixture", () => {
    expect(bindingViolations(validReceiptSample(), fixedProvenanceContext())).toEqual([]);
    const connect = validConnectSampleBundle();
    expect(bindingViolations(connect.receipt, fixedConnectProvenanceContext(connect))).toEqual([]);
  });

  it("accepts a head that predates commits leaving the digest-bound sources untouched", () => {
    // The live topology after any repair or landing: the receipt artifact and
    // work that never touches the governed bytes sit between the probed head
    // and HEAD. The digest comparison still binds the governed bytes, so this
    // delta is not staleness.
    const context = fixedProvenanceContext({
      pathsChangedSince: () => [
        "packages/design-system/src/theme/__fixtures__/stripe-elements-acceptance-receipt.json",
        "packages/design-system/src/__tests__/ink-foil-candidate-fixture.test.ts",
        "README.md",
      ],
    });
    expect(bindingViolations(validReceiptSample(), context)).toEqual([]);
  });

  it("accepts the conditional .Block border observation when the provider rendered one", () => {
    const receipt = validReceiptSample();
    for (const moment of receipt.moments) {
      for (const entry of momentObservationContract(moment.moment).conditional) {
        moment.observations.push(sampleObservation(entry, moment.colorMode));
      }
    }
    expect(bindingViolations(receipt, fixedProvenanceContext())).toEqual([]);
  });

  it("refuses a rules-only observation smuggled onto a Checkout moment", () => {
    // (r4 F5) Border or rules evidence claimed from the variables-only
    // Checkout surface is the exact wrong-payload-on-wrong-surface failure the
    // r3 review blocked on; the per-moment contract refuses it as undeclared.
    const receipt = validReceiptSample();
    const setupBorder = deriveSetupMandatoryObservables(probeSpecSource).find(
      (entry) => entry.sourceToken === "--border",
    )!;
    receipt.moments[0].observations.push(sampleObservation(setupBorder, receipt.moments[0].colorMode));
    const violations = bindingViolations(receipt, fixedProvenanceContext());
    expect(
      violations.some((problem) => problem.includes("undeclared observation")),
      `no undeclared-observation violation named for the smuggled border: ${violations.join("; ")}`,
    ).toBe(true);
  });

  it("resolves its own head through the repository provenance context", () => {
    const context = repositoryProvenanceContext();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot(), encoding: "utf8" }).trim();
    expect(context.resolveCommit(head), "HEAD must resolve; without git the receipt has no provenance").toBe(true);
    expect(context.resolveCommit("0".repeat(39) + "1")).toBe(false);
    expect(context.resolveCommit("not-a-sha")).toBe(false);
    expect(context.pathsChangedSince(head)).toEqual([]);
  });

  // The hosted checkout is depth 1, and the committed elements receipt names
  // the commit immediately before the commit that added it, with later
  // non-governed work on top -- the legitimate topology the provenance rule
  // governs. This control rebuilds exactly that shape in a scratch origin and
  // a genuinely shallow file:// clone (a plain-path clone silently ignores
  // --depth), with the exact-sha upload-pack capability the hosted remote
  // serves, so it discriminates in both directions regardless of the
  // enclosing checkout's own history depth.
  it("resolves a one-commit-later receipt head in a depth-1 checkout, and still refuses a fabricated head and a stale digest", () => {
    const receiptArtifactPath = "packages/design-system/src/theme/__fixtures__/stripe-elements-acceptance-receipt.json";
    const workspace = mkdtempSync(join(tmpdir(), "ink-foil-shallow-"));
    try {
      const sourceRoot = join(workspace, "origin");
      const cloneRoot = join(workspace, "shallow");
      const gitIn = (cwd: string, args: string[]) =>
        execFileSync("git", ["-c", "user.name=shallow-control", "-c", "user.email=shallow-control@invalid", ...args], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();

      mkdirSync(sourceRoot);
      gitIn(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
      // The hosted remote serves exact-sha wants (verified against the real
      // origin); the scratch origin mirrors that capability explicitly.
      gitIn(sourceRoot, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
      gitIn(sourceRoot, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(sourceRoot, "implementation.txt"), "implementation bytes\n");
      gitIn(sourceRoot, ["add", "."]);
      gitIn(sourceRoot, ["commit", "--quiet", "-m", "implementation head"]);
      const probedHead = gitIn(sourceRoot, ["rev-parse", "HEAD"]);

      mkdirSync(join(sourceRoot, dirname(receiptArtifactPath)), { recursive: true });
      writeFileSync(join(sourceRoot, receiptArtifactPath), "{}\n");
      gitIn(sourceRoot, ["add", "."]);
      gitIn(sourceRoot, ["commit", "--quiet", "-m", "commit the receipt artifact"]);

      // The live topology: work that never touches the governed bytes lands
      // after the receipt too.
      writeFileSync(join(sourceRoot, "validator-repair.txt"), "a later non-governed commit\n");
      gitIn(sourceRoot, ["add", "."]);
      gitIn(sourceRoot, ["commit", "--quiet", "-m", "later non-governed work"]);

      const sourceUrl = `file:///${sourceRoot.replace(/\\/g, "/").replace(/^\/+/, "")}`;
      gitIn(workspace, ["clone", "--quiet", "--depth=1", sourceUrl, cloneRoot]);

      // The discriminating precondition: without the bounded fetch, this clone
      // reproduces the hosted failure -- the head is locally unresolvable.
      expect(() =>
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `${probedHead}^{commit}`], {
          cwd: cloneRoot,
          stdio: "ignore",
        }),
      ).toThrow();

      const provenance = gitProvenanceAt(cloneRoot);
      expect(
        provenance.resolveCommit(probedHead),
        "the bounded exact-sha fetch must resolve the probed head in a depth-1 checkout",
      ).toBe(true);
      expect(provenance.pathsChangedSince(probedHead)?.sort()).toEqual(
        [receiptArtifactPath, "validator-repair.txt"].sort(),
      );

      // A fabricated head neither resolves locally nor is served by the
      // remote: resolution fails closed and the receipt is refused, not
      // skipped or deferred.
      const fabricatedHead = "f".repeat(40);
      expect(provenance.resolveCommit(fabricatedHead)).toBe(false);

      const context: ProvenanceContext = {
        ...provenance,
        sourceDigests: (surface) => committedSourceDigests(surfaceRegistry[surface].probeSpecSource),
        readDiscoveryArtifact: () => null,
      };

      const accepted = validReceiptSample();
      accepted.implementationHead = probedHead;
      expect(bindingViolations(accepted, context)).toEqual([]);

      const fabricated = validReceiptSample();
      fabricated.implementationHead = fabricatedHead;
      expect(bindingViolations(fabricated, context)).toEqual([
        `implementationHead ${fabricatedHead} does not resolve to a reachable commit`,
      ]);

      // The digest binding is commit-independent, so a shallow checkout must
      // still refuse a receipt whose source digests disagree with the
      // committed bytes even when its head resolves.
      const stale = validReceiptSample();
      stale.implementationHead = probedHead;
      stale.sourceDigests[probeSpecRelativePath] = "c".repeat(64);
      expect(bindingViolations(stale, context)).toEqual([
        `sourceDigests[${probeSpecRelativePath}] does not match the committed bytes -- the receipt is stale`,
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  const borderObservable = () =>
    deriveSetupMandatoryObservables(probeSpecSource).find((e) => e.sourceToken === "--border")!;
  // The border contract lives on the rules-bearing setup surface (r4 F5), so
  // every border mutation targets the setup mount moment.
  const borderMoment = (receipt: AcceptanceReceipt) =>
    receipt.moments.find((moment) => moment.moment === "setup-mount-complete")!;
  const borderIndex = (receipt: AcceptanceReceipt) =>
    borderMoment(receipt).observations.findIndex((o) => o.observable === borderObservable().observable);

  it.each<[string, (receipt: AcceptanceReceipt) => void, Partial<ProvenanceContext>]>([
    // Preserved from the original battery.
    ["a skipped run", (r) => (r.runSummary.skipped = 1), {}],
    ["a failing run", (r) => (r.runSummary.failed = 1), {}],
    ["passed below collected", (r) => (r.runSummary.passed = 1), {}],
    ["a stale fixture digest", (r) => (r.fixtureSha256 = "b".repeat(64)), {}],
    ["a missing lifecycle moment", (r) => r.moments.splice(1, 1), {}],
    ["a duplicated mount moment", (r) => (r.moments[1] = { ...r.moments[0] }), {}],
    ["an unmatched observation", (r) => (r.moments[0].observations[0].matched = false), {}],
    ["a short implementation head", (r) => (r.implementationHead = "abc123"), {}],
    ["an undeclared extra field", (r) => (r.note = "looks fine to me"), {}],
    [
      // Assembled at run time: a committed literal in provider-key shape is
      // itself the hazard this battery exists to catch.
      "a credential value in place of a name",
      (r) => r.environmentVariableNames.push(["sk", "test", "51ABCdefGHI"].join("_")),
      {},
    ],
    [
      "a buyer identity value",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "buyer@example.com" }]),
      {},
    ],
    [
      "a token that did not resolve to the candidate",
      (r) => (r.moments[0].resolvedTokens["--foreground"] = "#000000"),
      {},
    ],
    ["a dark moment that never moved", (r) => (r.moments[1].resolvedTokens = { ...r.moments[0].resolvedTokens }), {}],

    // F2: the twelve executed bypasses, plus the provenance rules that close them.
    ["a stale but valid-length implementation head", (r) => (r.implementationHead = "0".repeat(39) + "1"), {}],
    [
      "a reachable head after which a digest-bound source changed",
      () => {},
      { pathsChangedSince: () => ["packages/design-system/src/theme/stripe-appearance.ts"] },
    ],
    ["an unknowable delta to the validating head", () => {}, { pathsChangedSince: () => null }],
    ["a tampered source digest", (r) => (r.sourceDigests[probeSpecRelativePath] = "c".repeat(64)), {}],
    ["a dropped source digest", (r) => delete r.sourceDigests[probeSpecRelativePath], {}],
    [
      "a wrong fixture path",
      (r) => (r.fixturePath = "packages/design-system/src/theme/__fixtures__/some-other-tokens.json"),
      {},
    ],
    ["an unqualified host", (r) => (r.host = "https://probe.example.invalid"), {}],
    ["a host qualifying for a different surface", (r) => (r.host = "https://admin.staging.chasesets.com"), {}],
    ["a fabricated command", (r) => (r.runSummary.command = "pnpm exec playwright test --workers=7"), {}],
    ["a worker count above one", (r) => (r.runSummary.workers = 7), {}],
    [
      "an extra collected test",
      (r) => ((r.runSummary.collected = 4), (r.runSummary.passed = 4), r.runSummary.testTitles.push("a fourth test")),
      {},
    ],
    [
      "a collected count below the three-test evidence run",
      (r) => ((r.runSummary.collected = 2), (r.runSummary.passed = 2), r.runSummary.testTitles.pop()),
      {},
    ],
    ["a fabricated test title", (r) => (r.runSummary.testTitles[0] = "some other test @stripe-embed-uat"), {}],
    ["a missing environment name", (r) => r.environmentVariableNames.pop(), {}],
    ["a missing mandatory observation", (r) => r.moments[0].observations.splice(0, 1), {}],
    ["an optional mandatory observation", (r) => (r.moments[0].observations[0].mandatory = false), {}],
    [
      "an expected value unrelated to the fixture source token",
      (r) => ((r.moments[0].observations[0].expected = "#123456"), (r.moments[0].observations[0].computed = "#123456")),
      {},
    ],
    ["an undeclared resolved token", (r) => (r.moments[0].resolvedTokens["--review-scratch-35"] = "#000000"), {}],
    [
      "an extra cross-surface lifecycle moment",
      (r) => r.moments.push({ ...r.moments[0], moment: "connect-mount-complete" }),
      {},
    ],
    [
      "arbitrary unshaped retained data",
      (r) => ((r.moments[0] as unknown as Record<string, unknown>).retained = { anything: "at all" }),
      {},
    ],

    // F3: the translucent border observable, on the rules-bearing setup
    // surface (r4 F5).
    ["a missing border observation", (r) => borderMoment(r).observations.splice(borderIndex(r), 1), {}],
    [
      "a duplicated border observation",
      (r) => borderMoment(r).observations.push({ ...borderMoment(r).observations[borderIndex(r)] }),
      {},
    ],
    ["a mismatched border observation", (r) => (borderMoment(r).observations[borderIndex(r)].computed = "#000000"), {}],
    ["an optional border observation", (r) => (borderMoment(r).observations[borderIndex(r)].mandatory = false), {}],
    [
      "a border observation with no painted surface",
      (r) => delete borderMoment(r).observations[borderIndex(r)].paintedOver,
      {},
    ],
    [
      "a border composite not derived from the fixture",
      (r) => (borderMoment(r).observations[borderIndex(r)].paintedOver!.compositedExpected = "#abcdef"),
      {},
    ],
    [
      "a border composited over the wrong surface",
      (r) => (borderMoment(r).observations[borderIndex(r)].paintedOver!.sourceToken = "--card"),
      {},
    ],
    [
      "a setup update moment whose dark tokens never moved",
      (r) => {
        const mount = r.moments.find((m) => m.moment === "setup-mount-complete")!;
        const update = r.moments.find((m) => m.moment === "setup-update-complete")!;
        update.resolvedTokens = { ...mount.resolvedTokens };
      },
      {},
    ],
    [
      "a non-border observation claiming a composite",
      (r) =>
        (r.moments[0].observations[0].paintedOver = {
          sourceToken: "--surface-2",
          expected: "#fff",
          compositedExpected: "#fff",
        }),
      {},
    ],
    [
      "an undeclared extra observable",
      (r) =>
        r.moments[0].observations.push({
          observable: "payment-input-shadow",
          sourceToken: "--shadow-sm",
          cssProperty: "box-shadow",
          expected: "#000000",
          computed: "#000000",
          matched: true,
          mandatory: true,
        }),
      {},
    ],

    // F4: retained-artifact markers, including the exact marker the review planted.
    [
      "the planted buyer and credential marker",
      (r) =>
        (r.moments[0].consoleMessages = [
          { type: "log", text: "buyer-account-id=acct_SYNTHETIC password=correct-horse-battery-staple" },
        ]),
      {},
    ],
    [
      "a payment identifier in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "pi_SYNTHETICPLANTED123" }]),
      {},
    ],
    // (r4 F4) The provider identifier classes at their real granularity.
    [
      "a provider event identifier in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "evt_SYNTHETICPLANTED123" }]),
      {},
    ],
    [
      "a provider request identifier in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "req_SYNTHETICPLANTED123" }]),
      {},
    ],
    [
      "a payment-method token at tok_visa granularity in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "card token tok_visa" }]),
      {},
    ],
    [
      // Assembled at run time: a committed literal in provider-key shape is
      // itself the hazard this battery exists to catch.
      "a checkout session client secret in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: ["cs", "test", "SYNTHETICPLANTED123"].join("_") }]),
      {},
    ],
    [
      "a session marker in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "session-token=synthetic-planted-value" }]),
      {},
    ],
    [
      "a card number in retained console traffic",
      (r) => (r.moments[0].consoleMessages = [{ type: "log", text: "pan 4242424242424242" }]),
      {},
    ],
    ["a retained-artifact scan hit", (r) => (r.retentionScan.forbiddenMarkerHits = 1), {}],
    ["fewer retained screenshots than moments", (r) => (r.retentionScan.imageArtifacts = 1), {}],
    [
      "an unauthorised anchor substitution",
      (r) =>
        r.substitutionsApplied.push({
          property: "--primary",
          mode: "dark",
          from: "#8a97ff",
          to: "#ffffff",
          reason: "looked better",
        }),
      {},
    ],
    [
      "a pre-authorised substitution the fixture does not record as applied",
      (r) =>
        r.substitutionsApplied.push({
          property: "--border",
          mode: "dark",
          from: "rgba(242, 239, 250, 0.08)",
          to: "#3a3450",
          reason: "Stripe rejected the alpha border",
        }),
      {},
    ],
  ])("refuses %s", (_label, mutate, contextOverrides) => {
    const receipt = validReceiptSample();
    mutate(receipt);
    const violations = bindingViolations(receipt, fixedProvenanceContext(contextOverrides));
    // The named reason is the evidence: a bypass that is refused only as an
    // unlabelled aggregate is indistinguishable from one refused by accident.
    console.log(`refused ${_label}: ${violations[0] ?? "NOTHING -- this bypass is open"}`);
    expect(violations.length, `no violation named for: ${_label}`).toBeGreaterThan(0);
  });

  function connectMutationViolations(
    mutateReceipt: (receipt: AcceptanceReceipt) => void = () => {},
    mutateDiscovery: (artifact: ConnectDiscoveryArtifact) => void = () => {},
    options: { missing?: boolean; preserveReceiptDigest?: boolean } = {},
  ) {
    const bundle = validConnectSampleBundle();
    mutateReceipt(bundle.receipt);
    mutateDiscovery(bundle.discovery);
    const bytes = Buffer.from(`${JSON.stringify(bundle.discovery, null, 2)}\n`);
    if (!options.preserveReceiptDigest && bundle.receipt.discoveryArtifact) {
      bundle.receipt.discoveryArtifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    const context = fixedProvenanceContext({
      readDiscoveryArtifact: () => (options.missing ? null : { bytes, artifact: bundle.discovery }),
    });
    return bindingViolations(bundle.receipt, context);
  }

  it.each<
    [
      string,
      (receipt: AcceptanceReceipt) => void,
      (artifact: ConnectDiscoveryArtifact) => void,
      { missing?: boolean; preserveReceiptDigest?: boolean },
      RegExp,
    ]
  >([
    ["missing discovery artifact", () => {}, () => {}, { missing: true }, /discovery artifact is missing/],
    [
      "stale discovery bytes",
      (receipt) => {
        receipt.discoveryArtifact!.sha256 = "c".repeat(64);
      },
      () => {},
      { preserveReceiptDigest: true },
      /sha256 does not match/,
    ],
    [
      "nonce mismatch",
      (receipt) => {
        receipt.discoveryArtifact!.sessionNonce = "b".repeat(32);
      },
      () => {},
      {},
      /sessionNonce does not match/,
    ],
    [
      "head mismatch",
      () => {},
      (artifact) => {
        artifact.implementationHead = "2".repeat(40);
      },
      {},
      /implementationHead does not match/,
    ],
    [
      "component-mode mismatch",
      () => {},
      (artifact) => {
        artifact.componentMode = "account-onboarding";
      },
      {},
      /componentMode does not match/,
    ],
    [
      "nested unknown discovery field",
      () => {},
      (artifact) => {
        (artifact.groups["--card"]!.elements[0] as unknown as Record<string, unknown>).unknown = true;
      },
      {},
      /unexpected additional property unknown/,
    ],
    [
      "date-only discovery timestamp",
      () => {},
      (artifact) => {
        artifact.capturedAt = "2026-08-10";
      },
      {},
      /does not match/,
    ],
    [
      "out-of-range discovery count",
      () => {},
      (artifact) => {
        artifact.retentionScan.imageArtifacts = -1;
      },
      {},
      /expected >= 0/,
    ],
    [
      "observation source outside its discovery group",
      (receipt) => {
        receipt.moments[0].observations[0].sourceToken = "--ring";
      },
      () => {},
      {},
      /must read .* from --card/,
    ],
    [
      "missing discovery-expanded observation",
      (receipt) => {
        receipt.moments[0].observations.splice(0, 1);
      },
      () => {},
      {},
      /missing the mandatory observation/,
    ],
  ])("refuses Connect mutation: %s", (label, mutateReceipt, mutateDiscovery, options, expected) => {
    const violations = connectMutationViolations(mutateReceipt, mutateDiscovery, options);
    console.log(`refused ${label}: ${violations.join("; ")}`);
    expect(violations.join("; ")).toMatch(expected);
  });

  it("refuses both swapped-surface receipt forgeries by schema branch", () => {
    const elements = validReceiptSample();
    elements.surface = "connect";
    const elementsViolations = bindingViolations(elements, fixedProvenanceContext());
    expect(elementsViolations.join("; ")).toMatch(/oneOf branch/);

    const connect = validConnectSampleBundle();
    connect.receipt.surface = "elements";
    const connectViolations = bindingViolations(connect.receipt, fixedConnectProvenanceContext(connect));
    expect(connectViolations.join("; ")).toMatch(/oneOf branch/);
  });

  it("validates every committed receipt, and reports when the probe artifact is still pending", () => {
    const context = repositoryProvenanceContext();
    const committed = readdirSync(fixturesDir).filter((name) => name.endsWith("-acceptance-receipt.json"));
    for (const name of committed) {
      const receipt = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as AcceptanceReceipt;
      expect(bindingViolations(receipt, context), `${name} violates the receipt contract`).toEqual([]);
    }

    const elementsReceipt = "stripe-elements-acceptance-receipt.json";
    if (!committed.includes(elementsReceipt)) {
      console.log(
        `${elementsReceipt} is not committed yet: it can only be produced by the configured Stripe test-mode probe session. ` +
          "The schema half of the receipt contract is green; the run half is an operator action.",
      );
    }
    const connectReceipt = "stripe-connect-acceptance-receipt.json";
    if (!committed.includes(connectReceipt)) {
      console.log(
        `${connectReceipt} is not committed yet: Phase B can only produce it after the Phase A merge commit is deployed and same-session discovery is captured.`,
      );
    }
    expect(committed.every((name) => name.endsWith("-acceptance-receipt.json"))).toBe(true);
  });
});
