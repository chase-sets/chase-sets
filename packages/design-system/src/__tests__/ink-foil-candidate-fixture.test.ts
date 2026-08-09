import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
  "uniqueItems",
  "minLength",
  "minimum",
  "pattern",
]);

type SchemaNode = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asSchema(value: unknown): SchemaNode {
  return asRecord(value) ?? {};
}

function resolveRef(root: SchemaNode, ref: string): SchemaNode {
  expect(ref.startsWith("#/"), `only local refs are supported, got ${ref}`).toBe(true);
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    node = asRecord(node)?.[segment];
  }
  return asSchema(node);
}

function validate(root: SchemaNode, schema: SchemaNode, value: unknown, path = "$", errors: string[] = []): string[] {
  if (typeof schema.$ref === "string") {
    return validate(root, resolveRef(root, schema.$ref), value, path, errors);
  }

  const fail = (message: string) => errors.push(`${path}: ${message}`);
  const numberKeyword = (name: string) => (typeof schema[name] === "number" ? (schema[name] as number) : undefined);

  if (schema.const !== undefined && value !== schema.const) {
    fail(`expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  const declaredType =
    schema.type ??
    (schema.properties || schema.patternProperties || schema.propertyNames
      ? "object"
      : schema.items
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
    const propertyNames = asRecord(schema.propertyNames);
    const properties = asRecord(schema.properties);
    const patternProperties = asRecord(schema.patternProperties);
    for (const [key, child] of entries) {
      const childPath = `${path}.${key}`;
      if (propertyNames && !new RegExp(String(propertyNames.pattern)).test(key)) {
        fail(`property name ${key} does not match ${String(propertyNames.pattern)}`);
      }
      const direct = properties?.[key];
      const patternKey = Object.keys(patternProperties ?? {}).find((candidate) => new RegExp(candidate).test(key));
      if (direct) {
        validate(root, asSchema(direct), child, childPath, errors);
      } else if (patternKey) {
        validate(root, asSchema(patternProperties![patternKey]), child, childPath, errors);
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
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      fail("expected unique items");
    }
    value.forEach((item, index) => validate(root, asSchema(schema.items), item, `${path}[${index}]`, errors));
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
  const node = asRecord(candidate);
  if (!node) return;

  for (const keyword of Object.keys(node)) {
    if (!supportedKeywords.has(keyword)) {
      throw new Error(`${path}: unsupported schema keyword ${keyword}`);
    }
  }

  const isObjectNode =
    node.type === "object" || node.properties || node.patternProperties || node.propertyNames !== undefined;
  if (isObjectNode) {
    const closed = node.additionalProperties === false;
    const gated = Boolean(node.patternProperties && node.propertyNames);
    expect(closed || gated, `${path} is an object node that does not close additional properties`).toBe(true);
  }

  for (const keyword of schemaMapKeywords) {
    const map = asRecord(node[keyword]);
    if (!map) continue;
    for (const [key, child] of Object.entries(map)) {
      assertRecursivelyClosed(child, `${path}.${keyword}.${key}`);
    }
  }
  for (const keyword of schemaValueKeywords) {
    if (asRecord(node[keyword])) assertRecursivelyClosed(node[keyword], `${path}.${keyword}`);
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
const requiredMoments = {
  elements: ["elements-mount-complete", "elements-update-complete"],
  connect: ["connect-mount-complete", "connect-update-complete"],
} as const;

// Which deployed origin can mint acceptance evidence for a surface. A lane
// sandbox falls back to fake providers and can never mount a real Element, so
// an unqualified host is a disqualified run, not a weaker one.
const qualifyingHosts = {
  elements: ["https://marketplace.staging.chasesets.com"],
  connect: ["https://marketplace.staging.chasesets.com", "https://admin.staging.chasesets.com"],
} as const;

// Committing the receipt moves the head the receipt would have to name, so the
// only commit delta the validator tolerates between the probed head and the
// validating head is the receipt artifact itself.
const receiptArtifactPaths = [
  "packages/design-system/src/theme/__fixtures__/stripe-elements-acceptance-receipt.json",
  "packages/design-system/src/theme/__fixtures__/stripe-connect-acceptance-receipt.json",
];

// Shape-level leak detection, mirroring the probe spec's own retention guard.
// The spec compares retained bytes against the run's actual configured values;
// this side cannot see those values, so it enforces the shapes that are a leak
// regardless of configuration -- including the buyer/session/order/payment
// markers a Stripe-key-and-email pattern set walks straight past.
const leakPatterns = [
  /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{4,}/,
  /\bwhsec_[A-Za-z0-9]{4,}/,
  /\b(?:password|passwd|secret|api[-_]?key|apikey|bearer)\b\s*[=:]\s*\S+/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b(?:pi|seti|pm|cus|acct|ch|py|src|sub)_[A-Za-z0-9]{6,}/,
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

function requireSpecMatch(source: string, pattern: RegExp, what: string): RegExpMatchArray {
  const matched = source.match(pattern);
  if (!matched) {
    throw new Error(`${what} not found in ${probeSpecRelativePath} -- the derivation seam moved`);
  }
  return matched;
}

export function deriveEvidenceCommand(source: string): string {
  return requireSpecMatch(source, /const evidenceCommand = "([^"]+)";/, "evidenceCommand")[1]!;
}

export function deriveRequiredEnvironmentVariableNames(source: string): string[] {
  const block = requireSpecMatch(
    source,
    /const probeEnvironmentVariableNames = \[([\s\S]*?)\];/,
    "probeEnvironmentVariableNames",
  );
  return [...block[1]!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1]!);
}

export function deriveTaggedTestTitles(source: string): string[] {
  return [...source.matchAll(/^\s*test\(\s*"((?:[^"\\]|\\.)*)"/gm)]
    .map((match) => match[1]!)
    .filter((title) => title.includes("@stripe-embed-uat"));
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

export function deriveMandatoryObservables(source: string): DeclaredObservable[] {
  return deriveObservableBlock(source, "mandatoryObservables");
}

export function deriveConditionalObservables(source: string): DeclaredObservable[] {
  return deriveObservableBlock(source, "conditionalObservables");
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
// it names must be a reachable commit whose only delta to the validating head
// is the receipt artifact, and the bytes that determine what the provider was
// sent are bound by digest independently of any commit at all.
// ---------------------------------------------------------------------------

type ProvenanceContext = {
  resolveCommit: (sha: string) => boolean;
  pathsChangedSince: (sha: string) => string[] | null;
  sourceDigests: Record<string, string>;
};

function committedSourceDigests(): Record<string, string> {
  return Object.fromEntries(
    deriveReceiptSourceDigestPaths(probeSpecSource).map((relativePath) => [
      relativePath,
      createHash("sha256")
        .update(readFileSync(join(repositoryRoot(), relativePath)))
        .digest("hex"),
    ]),
  );
}

function repositoryProvenanceContext(): ProvenanceContext {
  const root = repositoryRoot();
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };

  return {
    resolveCommit: (sha) => git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) !== null,
    pathsChangedSince: (sha) => {
      const output = git(["diff", "--name-only", sha, "HEAD"]);
      return output === null
        ? null
        : output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    },
    sourceDigests: committedSourceDigests(),
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
    sourceDigests: committedSourceDigests(),
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
} & Record<string, unknown>;

function bindingViolations(receipt: AcceptanceReceipt, context: ProvenanceContext): string[] {
  const problems: string[] = [];
  const schemaErrors = validate(receiptSchema, receiptSchema, receipt);
  problems.push(...schemaErrors);
  if (schemaErrors.length > 0) return problems;

  // --- provenance ---------------------------------------------------------
  if (!context.resolveCommit(receipt.implementationHead)) {
    problems.push(`implementationHead ${receipt.implementationHead} does not resolve to a reachable commit`);
  } else {
    const changed = context.pathsChangedSince(receipt.implementationHead);
    if (changed === null) {
      problems.push(`the delta between implementationHead ${receipt.implementationHead} and HEAD is unknowable`);
    } else {
      const unauthorised = changed.filter((path) => !receiptArtifactPaths.includes(path));
      if (unauthorised.length > 0) {
        problems.push(
          `implementationHead ${receipt.implementationHead} is stale: ${unauthorised.join(", ")} changed since it, ` +
            "and only the receipt artifact itself may differ",
        );
      }
    }
  }

  const expectedDigests = context.sourceDigests;
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
  const evidenceCommand = deriveEvidenceCommand(probeSpecSource);
  if (summary.command !== evidenceCommand) {
    problems.push(`runSummary.command must be exactly ${evidenceCommand}, got ${summary.command}`);
  }
  const expectedTitles = deriveTaggedTestTitles(probeSpecSource);
  if ([...summary.testTitles].sort().join("|") !== [...expectedTitles].sort().join("|")) {
    problems.push(
      `runSummary.testTitles must be exactly the ${expectedTitles.length} tagged tests declared by the probe spec`,
    );
  }
  if (summary.testTitles.length !== summary.collected) {
    problems.push(`runSummary.testTitles lists ${summary.testTitles.length} of ${summary.collected} collected tests`);
  }

  const qualifyingForSurface: readonly string[] = qualifyingHosts[receipt.surface as keyof typeof qualifyingHosts];
  if (!qualifyingForSurface.includes(receipt.host)) {
    problems.push(`host ${receipt.host} is not a qualifying deployed host for the ${receipt.surface} surface`);
  }

  const expectedEnvironmentNames = deriveRequiredEnvironmentVariableNames(probeSpecSource);
  if ([...receipt.environmentVariableNames].sort().join("|") !== [...expectedEnvironmentNames].sort().join("|")) {
    problems.push(`environmentVariableNames must be exactly ${expectedEnvironmentNames.sort().join(", ")}`);
  }

  if (receipt.fixtureSha256 !== fixtureSha256) {
    problems.push(`fixtureSha256 ${receipt.fixtureSha256} does not match the committed fixture ${fixtureSha256}`);
  }

  // --- lifecycle set ------------------------------------------------------
  const seen = receipt.moments.map((moment) => moment.moment);
  const required = requiredMoments[receipt.surface as keyof typeof requiredMoments];
  if ([...seen].sort().join("|") !== [...required].sort().join("|")) {
    problems.push(`moments must be exactly ${[...required].join(", ")}, got ${seen.join(", ")}`);
  }
  if (new Set(seen).size !== seen.length) problems.push(`duplicate lifecycle moments: ${seen.join(", ")}`);

  const mountMoment = receipt.moments.find((moment) => moment.moment.endsWith("-mount-complete"));
  const updateMoment = receipt.moments.find((moment) => moment.moment.endsWith("-update-complete"));
  if (mountMoment && mountMoment.colorMode !== "light") {
    problems.push(`mount moment must be captured in light mode, got ${mountMoment.colorMode}`);
  }
  if (updateMoment && updateMoment.colorMode !== "dark") {
    problems.push(`update moment must be captured in dark mode, got ${updateMoment.colorMode}`);
  }

  // --- observation contract ----------------------------------------------
  const consumed = deriveConsumedTokenNames(appearanceSource);
  const mandatory = deriveMandatoryObservables(probeSpecSource);
  const conditional = deriveConditionalObservables(probeSpecSource);
  const declaredByName = new Map([...mandatory, ...conditional].map((entry) => [entry.observable, entry]));
  const paintedSurfaceToken = derivePaintedSurfaceSourceToken(probeSpecSource);

  for (const moment of receipt.moments) {
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
    for (const entry of mandatory) {
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
        const surfaceValue = fixture[moment.colorMode][paintedSurfaceToken]?.candidate;
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

  // The update moment must actually differ from the mount moment wherever the
  // fixture's dark candidate differs from its light candidate; a mount-only
  // capture replayed twice cannot satisfy this.
  if (mountMoment && updateMoment) {
    const shouldDiffer = Object.keys(fixture.light).filter(
      (name) => name in mountMoment.resolvedTokens && fixture.light[name].candidate !== fixture.dark[name].candidate,
    );
    const unchanged = shouldDiffer.filter(
      (name) => mountMoment.resolvedTokens[name] === updateMoment.resolvedTokens[name],
    );
    if (unchanged.length > 0) {
      problems.push(`update moment did not move dark-differing tokens: ${unchanged.join(", ")}`);
    }
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
  const mandatory = deriveMandatoryObservables(probeSpecSource);
  const moment = (name: string, colorMode: "light" | "dark"): ReceiptMoment => ({
    moment: name,
    colorMode,
    resolvedTokens: Object.fromEntries(consumed.map((token) => [token, fixture[colorMode][token].candidate])),
    observations: mandatory.map((entry) => sampleObservation(entry, colorMode)),
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
      collected: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      testTitles: deriveTaggedTestTitles(probeSpecSource),
    },
    retentionScan: { textualArtifacts: 4, imageArtifacts: 2, redactionsApplied: 0, forbiddenMarkerHits: 0 },
    moments: [moment("elements-mount-complete", "light"), moment("elements-update-complete", "dark")],
    substitutionsApplied: [],
  };
}

describe("Stripe appearance acceptance receipts", () => {
  it("uses a recursively closed schema", () => {
    assertRecursivelyClosed(receiptSchema, "receiptSchema");
  });

  it.each([
    ["directly under properties", ["properties", "host"]],
    ["under a $defs property", ["$defs", "observation", "properties", "expected"]],
    ["under a nested $defs object node", ["$defs", "moment", "properties", "resolvedTokens"]],
  ])("refuses an unsupported schema keyword nested %s", (_label, path) => {
    const mutated = JSON.parse(JSON.stringify(receiptSchema)) as Record<string, unknown>;
    let node = mutated;
    for (const segment of path) node = node[segment] as Record<string, unknown>;
    node.maxLength = 5;
    expect(() => assertRecursivelyClosed(mutated, "receiptSchema")).toThrow(/unsupported schema keyword maxLength/);
  });

  it("derives the probe contract from the spec source rather than transcribing it", () => {
    const mandatory = deriveMandatoryObservables(probeSpecSource);
    const conditional = deriveConditionalObservables(probeSpecSource);
    const titles = deriveTaggedTestTitles(probeSpecSource);

    console.log(
      [
        `evidence command: ${deriveEvidenceCommand(probeSpecSource)}`,
        `environment names (${deriveRequiredEnvironmentVariableNames(probeSpecSource).length}): ${deriveRequiredEnvironmentVariableNames(probeSpecSource).join(" ")}`,
        `tagged test titles (${titles.length})`,
        `mandatory observables (${mandatory.length}): ${mandatory.map((entry) => `${entry.observable}<-${entry.sourceToken}`).join(" ")}`,
        `conditional observables (${conditional.length}): ${conditional.map((entry) => `${entry.observable}<-${entry.sourceToken}`).join(" ")}`,
        `painted surface: ${derivePaintedSurfaceSourceToken(probeSpecSource)}`,
        `digest-bound sources: ${deriveReceiptSourceDigestPaths(probeSpecSource).join(" ")}`,
      ].join("\n"),
    );

    expect(titles).toHaveLength(2);
    // The border observable is the reason this probe exists; losing it from the
    // mandatory set must fail here rather than quietly weakening every receipt.
    expect(mandatory.map((entry) => entry.sourceToken)).toContain("--border");
    expect(deriveReceiptSourceDigestPaths(probeSpecSource)).toContain(probeSpecRelativePath);
  });

  it("accepts a well-formed receipt bound to the committed fixture", () => {
    expect(bindingViolations(validReceiptSample(), fixedProvenanceContext())).toEqual([]);
  });

  it("accepts the conditional .Block border observation when the provider rendered one", () => {
    const receipt = validReceiptSample();
    for (const moment of receipt.moments) {
      for (const entry of deriveConditionalObservables(probeSpecSource)) {
        moment.observations.push(sampleObservation(entry, moment.colorMode));
      }
    }
    expect(bindingViolations(receipt, fixedProvenanceContext())).toEqual([]);
  });

  it("resolves its own head through the repository provenance context", () => {
    const context = repositoryProvenanceContext();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot(), encoding: "utf8" }).trim();
    expect(context.resolveCommit(head), "HEAD must resolve; without git the receipt has no provenance").toBe(true);
    expect(context.resolveCommit("0".repeat(39) + "1")).toBe(false);
    expect(context.pathsChangedSince(head)).toEqual([]);
  });

  const borderObservable = () => deriveMandatoryObservables(probeSpecSource).find((e) => e.sourceToken === "--border")!;
  const borderIndex = (receipt: AcceptanceReceipt) =>
    receipt.moments[0].observations.findIndex((o) => o.observable === borderObservable().observable);

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
    ["a credential value in place of a name", (r) => r.environmentVariableNames.push("sk_test_51ABCdefGHI"), {}],
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
      "a reachable head whose delta exceeds the receipt artifact",
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
      (r) => ((r.runSummary.collected = 3), (r.runSummary.passed = 3), r.runSummary.testTitles.push("a third test")),
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

    // F3: the translucent border observable.
    ["a missing border observation", (r) => r.moments[0].observations.splice(borderIndex(r), 1), {}],
    [
      "a duplicated border observation",
      (r) => r.moments[0].observations.push({ ...r.moments[0].observations[borderIndex(r)] }),
      {},
    ],
    ["a mismatched border observation", (r) => (r.moments[0].observations[borderIndex(r)].computed = "#000000"), {}],
    ["an optional border observation", (r) => (r.moments[0].observations[borderIndex(r)].mandatory = false), {}],
    [
      "a border observation with no painted surface",
      (r) => delete r.moments[0].observations[borderIndex(r)].paintedOver,
      {},
    ],
    [
      "a border composite not derived from the fixture",
      (r) => (r.moments[0].observations[borderIndex(r)].paintedOver!.compositedExpected = "#abcdef"),
      {},
    ],
    [
      "a border composited over the wrong surface",
      (r) => (r.moments[0].observations[borderIndex(r)].paintedOver!.sourceToken = "--card"),
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
    expect(committed.every((name) => name.endsWith("-acceptance-receipt.json"))).toBe(true);
  });
});
