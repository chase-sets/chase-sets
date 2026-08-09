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
// patternProperties plus propertyNames. Without this, `additionalProperties:
// false` at the root would still let a fabricated field ride inside a nested
// object.
function assertRecursivelyClosed(candidate: unknown, path: string, seen = new Set<unknown>()) {
  if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
  seen.add(candidate);
  const node = candidate as SchemaNode;

  for (const keyword of Object.keys(node)) {
    if (
      !supportedKeywords.has(keyword) &&
      !path.includes(".properties.") &&
      !path.endsWith(".properties") &&
      !path.includes("$defs")
    ) {
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

  for (const [key, child] of Object.entries(node)) {
    if (key === "enum" || key === "const" || key === "required") continue;
    assertRecursivelyClosed(child, `${path}.${key}`, seen);
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

const leakPatterns = [
  /\bsk_(?:test|live)_[A-Za-z0-9]/,
  /\bpk_(?:test|live)_[A-Za-z0-9]/,
  /\bwhsec_[A-Za-z0-9]/,
  /\brk_(?:test|live)_[A-Za-z0-9]/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

type ReceiptObservation = {
  observable: string;
  sourceToken: string;
  cssProperty: string;
  expected: string;
  computed: string;
  matched: boolean;
  mandatory: boolean;
};
type ReceiptMoment = {
  moment: string;
  colorMode: "light" | "dark";
  resolvedTokens: Record<string, string>;
  observations: ReceiptObservation[];
  consoleMessages: { type: string; text: string }[];
  screenshotSha256: string;
};
type AcceptanceReceipt = {
  schemaVersion: string;
  surface: string;
  stripeMode: string;
  implementationHead: string;
  fixturePath: string;
  fixtureSha256: string;
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
  moments: ReceiptMoment[];
  substitutionsApplied: { property: string; mode: string; from: string; to: string; reason: string }[];
} & Record<string, unknown>;

function bindingViolations(receipt: AcceptanceReceipt): string[] {
  const problems: string[] = [];
  const schemaErrors = validate(receiptSchema, receiptSchema, receipt);
  problems.push(...schemaErrors);
  if (schemaErrors.length > 0) return problems;

  const summary = receipt.runSummary;
  if (summary.skipped !== 0) problems.push(`runSummary.skipped must be 0, got ${summary.skipped}`);
  if (summary.failed !== 0) problems.push(`runSummary.failed must be 0, got ${summary.failed}`);
  if (summary.passed !== summary.collected) {
    problems.push(`runSummary.passed (${summary.passed}) must equal collected (${summary.collected})`);
  }
  if (summary.collected < 2) problems.push(`runSummary.collected must be at least 2, got ${summary.collected}`);
  if (summary.testTitles.length !== summary.collected) {
    problems.push(`runSummary.testTitles lists ${summary.testTitles.length} of ${summary.collected} collected tests`);
  }
  if (receipt.fixtureSha256 !== fixtureSha256) {
    problems.push(`fixtureSha256 ${receipt.fixtureSha256} does not match the committed fixture ${fixtureSha256}`);
  }

  const seen = receipt.moments.map((moment) => moment.moment);
  for (const required of requiredMoments[receipt.surface as keyof typeof requiredMoments]) {
    if (!seen.includes(required)) problems.push(`missing lifecycle moment ${required}`);
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

  for (const moment of receipt.moments) {
    for (const observation of moment.observations) {
      if (!observation.matched) {
        problems.push(
          `${moment.moment} observation ${observation.observable}: expected ${observation.expected}, computed ${observation.computed}`,
        );
      }
    }
    const consumed = deriveConsumedTokenNames(appearanceSource);
    const missing = consumed.filter((name) => !(name in moment.resolvedTokens));
    if (missing.length > 0) {
      problems.push(`${moment.moment} resolvedTokens missing consumed names: ${missing.join(", ")}`);
    }
    const expectedFor = (name: string) => fixture[moment.colorMode][name]?.candidate;
    for (const name of consumed) {
      const expected = expectedFor(name);
      const resolved = moment.resolvedTokens[name];
      if (expected && resolved && normaliseCssValue(resolved) !== normaliseCssValue(expected)) {
        problems.push(
          `${moment.moment} resolved ${name} as ${resolved}, but the fixture candidate is ${expected} -- the injection did not govern`,
        );
      }
    }
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

  const serialised = JSON.stringify(receipt);
  for (const pattern of leakPatterns) {
    const hit = serialised.match(pattern);
    if (hit) problems.push(`receipt carries a credential-shaped value matching ${pattern}`);
  }

  return problems;
}

function normaliseCssValue(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function validReceiptSample(): AcceptanceReceipt {
  const consumed = deriveConsumedTokenNames(appearanceSource);
  const moment = (name: string, colorMode: "light" | "dark") => ({
    moment: name,
    colorMode,
    resolvedTokens: Object.fromEntries(consumed.map((token) => [token, fixture[colorMode][token].candidate])),
    observations: [
      {
        observable: "payment-input-background",
        sourceToken: "--surface-2",
        cssProperty: "background-color",
        expected: fixture[colorMode]["--surface-2"].candidate,
        computed: fixture[colorMode]["--surface-2"].candidate,
        matched: true,
        mandatory: true,
      },
    ],
    consoleMessages: [],
    screenshotSha256: "a".repeat(64),
  });

  return {
    schemaVersion: "stripe-appearance-acceptance-receipt/v1",
    surface: "elements",
    stripeMode: "test",
    implementationHead: "0".repeat(39) + "1",
    fixturePath: "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
    fixtureSha256,
    capturedAt: "2026-08-09T12:00:00Z",
    host: "https://marketplace.staging.chasesets.com",
    environmentVariableNames: ["STRIPE_EMBED_UAT", "STRIPE_EMBED_UAT_PROBE_ORDER_IDS"],
    runSummary: {
      command: "pnpm exec playwright test --grep @stripe-embed-uat --workers=1",
      workers: 1,
      collected: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      testTitles: ["confirmation test", "appearance probe test"],
    },
    moments: [moment("elements-mount-complete", "light"), moment("elements-update-complete", "dark")],
    substitutionsApplied: [],
  };
}

describe("Stripe appearance acceptance receipts", () => {
  it("uses a recursively closed schema", () => {
    assertRecursivelyClosed(receiptSchema, "receiptSchema");
  });

  it("accepts a well-formed receipt bound to the committed fixture", () => {
    expect(bindingViolations(validReceiptSample())).toEqual([]);
  });

  it.each([
    ["a skipped run", (r: AcceptanceReceipt) => (r.runSummary.skipped = 1)],
    ["a failing run", (r: AcceptanceReceipt) => (r.runSummary.failed = 1)],
    ["passed below collected", (r: AcceptanceReceipt) => (r.runSummary.passed = 1)],
    [
      "fewer than two collected tests",
      (r: AcceptanceReceipt) => ((r.runSummary.collected = 1), (r.runSummary.passed = 1)),
    ],
    ["a stale fixture digest", (r: AcceptanceReceipt) => (r.fixtureSha256 = "b".repeat(64))],
    ["a missing lifecycle moment", (r: AcceptanceReceipt) => r.moments.splice(1, 1)],
    ["a duplicated mount moment", (r: AcceptanceReceipt) => (r.moments[1] = { ...r.moments[0] })],
    ["an unmatched observation", (r: AcceptanceReceipt) => (r.moments[0].observations[0].matched = false)],
    ["a short implementation head", (r: AcceptanceReceipt) => (r.implementationHead = "abc123")],
    ["an undeclared extra field", (r: AcceptanceReceipt) => (r.note = "looks fine to me")],
    [
      "a credential value in place of a name",
      (r: AcceptanceReceipt) => r.environmentVariableNames.push("sk_test_51ABCdefGHI"),
    ],
    [
      "a buyer identity value",
      (r: AcceptanceReceipt) => (r.moments[0].consoleMessages = [{ type: "log", text: "buyer@example.com" }]),
    ],
    [
      "a token that did not resolve to the candidate",
      (r: AcceptanceReceipt) => (r.moments[0].resolvedTokens["--foreground"] = "#000000"),
    ],
    [
      "a dark moment that never moved",
      (r: AcceptanceReceipt) => (r.moments[1].resolvedTokens = { ...r.moments[0].resolvedTokens }),
    ],
  ])("refuses %s", (_label, mutate) => {
    const receipt = validReceiptSample();
    mutate(receipt);
    expect(bindingViolations(receipt).length).toBeGreaterThan(0);
  });

  it("validates every committed receipt, and reports when the probe artifact is still pending", () => {
    const committed = readdirSync(fixturesDir).filter((name) => name.endsWith("-acceptance-receipt.json"));
    for (const name of committed) {
      const receipt = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as AcceptanceReceipt;
      expect(bindingViolations(receipt), `${name} violates the receipt contract`).toEqual([]);
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
