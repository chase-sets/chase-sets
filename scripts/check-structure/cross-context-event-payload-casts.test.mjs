import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH,
  collectCrossContextEventPayloadCasts,
  formatCrossContextEventPayloadCastInventory,
  validateCrossContextEventPayloadCasts,
  writeCrossContextEventPayloadCastsBaseline,
} from "./cross-context-event-payload-casts.mjs";

const tempRoots = [];

const mixedProjection = "bounded-contexts/checkout/features/sell-list/read-model/projection.ts";
const foreignProjection = "bounded-contexts/checkout/features/cart/integrations/marketplace/projection.ts";
const keylessHelper = "bounded-contexts/checkout/features/cart/integrations/marketplace/offer-row.ts";
const ownProjection = "bounded-contexts/checkout/features/cart/read-model/projection.ts";

function createFixture(files, { baseline } = {}) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "cs-event-payload-casts-"));
  tempRoots.push(repoRoot);
  for (const [relativeFile, content] of Object.entries(files)) {
    writeSource(repoRoot, relativeFile, content);
  }
  if (baseline !== undefined) {
    writeSource(repoRoot, CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  } else {
    mkdirSync(path.join(repoRoot, path.dirname(CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH)), { recursive: true });
  }
  return {
    repoRoot,
    contextManifests: contextManifests(),
    listTrackedFiles: () => Object.keys(files),
  };
}

function writeSource(repoRoot, relativeFile, content) {
  const absolute = path.join(repoRoot, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function readBaselineText(repoRoot) {
  return readFileSync(path.join(repoRoot, CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH), "utf8");
}

function contextManifests() {
  return new Map(
    ["checkout", "marketplace"].map((contextName) => [
      `bounded-contexts/${contextName}`,
      {
        root: `bounded-contexts/${contextName}`,
        manifest: { contextName, packageName: `@chase-sets/${contextName}`, streamPrefix: `${contextName}.` },
        packageName: `@chase-sets/${contextName}`,
      },
    ]),
  );
}

function handlerMap(handlers) {
  const entries = Object.entries(handlers).map(
    ([eventType, body]) => `    "${eventType}": async (event) => {\n      ${body}\n    },`,
  );
  return `export function buildHandlers(db) {\n  return {\n${entries.join("\n")}\n  };\n}\n`;
}

const cast = "const data = event.data as { offerId: string };";

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("cross-context event payload cast ceiling", () => {
  it("passes when every counted file holds exactly its baseline count", () => {
    const fixture = createFixture(
      {
        [mixedProjection]: handlerMap({ "checkout.sell-list.line-added": cast, "marketplace.offer.accepted": cast }),
        [keylessHelper]: `export function offerRow(event) {\n  return event.data as { offerId: string };\n}\n`,
      },
      { baseline: { [mixedProjection]: 2, [keylessHelper]: 1 } },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect([...result.casts]).toEqual([
      [keylessHelper, 1],
      [mixedProjection, 2],
    ]);
  });

  it("fails when a cast on the file's own event is added to a file that also handles foreign events", () => {
    const fixture = createFixture(
      {
        [mixedProjection]: handlerMap({
          "checkout.sell-list.line-added": cast,
          "checkout.sell-list.line-removed": cast,
          "marketplace.offer.accepted": cast,
        }),
      },
      { baseline: { [mixedProjection]: 2 } },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(`${mixedProjection}: 3 '<identifier>.data as' cast(s)`);
    expect(result.violations[0]).toContain(`${CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH} allows 2`);
    expect(result.violations[0]).toContain("defineProjectorHandlers");
    expect(result.violations[0]).toContain("including casts on its own context's events");
  });

  it("fails for a cast with no baseline entry in a file that has a foreign handler key", () => {
    const fixture = createFixture(
      { [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast }) },
      { baseline: {} },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(`${foreignProjection}: 1 '<identifier>.data as' cast(s) and no entry`);
    expect(result.violations[0]).toContain("(allowed 0)");
    expect(result.violations[0]).toContain("defineProjectorHandlers");
  });

  it("fails for a cast with no baseline entry in a helper that has no handler key", () => {
    const fixture = createFixture(
      { [keylessHelper]: `export function offerRow(event) {\n  return event.data as { offerId: string };\n}\n` },
      { baseline: {} },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(`${keylessHelper}: 1 '<identifier>.data as' cast(s) and no entry`);
  });

  it("counts a cast written on a renamed parameter", () => {
    const fixture = createFixture(
      {
        [keylessHelper]:
          "export function offerRow(sourceEvent, envelope) {\n" +
          "  const offer = sourceEvent.data as { offerId: string };\n" +
          "  const wrapped = (envelope.inner.data as unknown) as { offerId: string };\n" +
          "  return [offer, wrapped];\n" +
          "}\n",
      },
      { baseline: { [keylessHelper]: 1 } },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect([...result.casts]).toEqual([[keylessHelper, 2]]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(`${keylessHelper}: 2 '<identifier>.data as' cast(s)`);
    expect(result.violations[0]).toContain("allows 1");
  });

  it("treats a missing baseline file as an empty baseline", () => {
    const fixture = createFixture({ [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast }) });

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("and no entry");
  });
});

describe("cross-context event payload cast exemption", () => {
  it("exempts a file whose handler keys are all its own context's or under an unregistered prefix", () => {
    const fixture = createFixture(
      {
        [ownProjection]:
          handlerMap({
            "checkout.cart.line-added": cast,
            "support.support-request.resolved": cast,
            "experience.session.started": cast,
            "platform-policy.value.changed": cast,
          }) +
          `export function register(handlers) {\n` +
          `  handlers["checkout.cart.cleared"] = async (event) => {\n    ${cast}\n  };\n}\n`,
      },
      { baseline: {} },
    );

    const collected = collectCrossContextEventPayloadCasts(fixture);
    const result = validateCrossContextEventPayloadCasts(fixture);

    expect([...collected.exemptFiles]).toEqual([ownProjection]);
    expect(collected.casts.size).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("exempts a file whose own handler keys share one line", () => {
    const fixture = createFixture(
      {
        [ownProjection]:
          "export function buildHandlers() {\n" +
          `  const handler = async (event) => event.data as { lineId: string };\n` +
          `  return { "checkout.cart.line-added": handler, "checkout.cart.cleared": handler };\n` +
          "}\n",
      },
      { baseline: {} },
    );

    expect(validateCrossContextEventPayloadCasts(fixture).violations).toEqual([]);
    expect([...collectCrossContextEventPayloadCasts(fixture).exemptFiles]).toEqual([ownProjection]);
  });

  it("counts a file when one handler key among its own is another context's", () => {
    const inlineKeys =
      "export function buildHandlers(handler) {\n" +
      `  const read = (event) => event.data as { offerId: string };\n` +
      "  return {\n" +
      `    "checkout.cart.line-added": handler,\n` +
      `    ...{ "checkout.cart.cleared": handler, "marketplace.offer.accepted": (event) => handler(read(event)) },\n` +
      "  };\n" +
      "}\n";
    const assignedKey =
      "export function register(handlers) {\n" +
      `  handlers["checkout.cart.cleared"] = async (event) => {\n    ${cast}\n  };\n` +
      `  handlers["marketplace.offer.accepted"] = async (event) => {\n    ${cast}\n  };\n` +
      "}\n";
    const fixture = createFixture({ [ownProjection]: inlineKeys, [foreignProjection]: assignedKey }, { baseline: {} });

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect([...result.casts]).toEqual([
      [foreignProjection, 2],
      [ownProjection, 1],
    ]);
    expect(result.violations).toHaveLength(2);
  });

  it("does not let a file without a handler key claim the exemption", () => {
    const fixture = createFixture(
      {
        [keylessHelper]:
          "export function describe(event) {\n" +
          "  switch (event.type) {\n" +
          `    case "checkout.cart.line-added":\n` +
          "      return event.data as { lineId: string };\n" +
          "    default:\n" +
          `      return event.type === "checkout.cart.cleared" ? "checkout.cart.cleared" : null;\n` +
          "  }\n" +
          "}\n",
      },
      { baseline: {} },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect([...result.casts]).toEqual([[keylessHelper, 1]]);
    expect(result.violations).toHaveLength(1);
  });

  it("does not scan test files, declaration files, other extensions or files outside a context", () => {
    const foreign = handlerMap({ "marketplace.offer.accepted": cast });
    const fixture = createFixture(
      {
        "bounded-contexts/checkout/features/cart/read-model/projection.test.ts": foreign,
        "bounded-contexts/checkout/features/cart/read-model/projection.spec.tsx": foreign,
        "bounded-contexts/checkout/features/cart/read-model/projection.d.ts": foreign,
        "bounded-contexts/checkout/tests/support/projection.ts": foreign,
        "bounded-contexts/checkout/features/cart/__tests__/projection.ts": foreign,
        "bounded-contexts/checkout/support/test-support/projection.ts": foreign,
        "bounded-contexts/checkout/features/cart/fixtures/projection.ts": foreign,
        "bounded-contexts/checkout/features/cart/read-model/projection.mjs": foreign,
        "bounded-contexts/projection.ts": foreign,
        "deployables/api/projection.ts": foreign,
        "bounded-contexts/checkout/features/cart/ui/cache.tsx": `export const read = (entry) => entry.data as string;\n`,
      },
      { baseline: {} },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect([...result.casts]).toEqual([["bounded-contexts/checkout/features/cart/ui/cache.tsx", 1]]);
  });

  it("scans tracked files only", () => {
    const fixture = createFixture(
      {
        [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast }),
        [keylessHelper]: `export const offerRow = (event) => event.data as { offerId: string };\n`,
      },
      { baseline: { [foreignProjection]: 1 } },
    );
    const git = (...args) => execFileSync("git", args, { cwd: fixture.repoRoot, stdio: "ignore" });
    git("init", "--quiet");
    git("add", "--", foreignProjection);

    const result = validateCrossContextEventPayloadCasts({
      repoRoot: fixture.repoRoot,
      contextManifests: fixture.contextManifests,
    });

    expect([...result.casts]).toEqual([[foreignProjection, 1]]);
    expect(result.violations).toEqual([]);
  });
});

describe("cross-context event payload cast baseline", () => {
  it("fails when an entry is higher than the file's count", () => {
    const fixture = createFixture(
      { [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast }) },
      { baseline: { [foreignProjection]: 3 } },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations).toEqual([
      `${CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH}: stale entry for ${foreignProjection} allows 3 cast(s) ` +
        "but the file holds 1; lower it with `node scripts/check-structure/cross-context-event-payload-casts.mjs --write`.",
    ]);
  });

  it("fails when an entry names an exempt file, a missing file or a file without casts", () => {
    const withoutCasts = "bounded-contexts/checkout/features/cart/integrations/marketplace/typed-projection.ts";
    const missing = "bounded-contexts/checkout/features/cart/integrations/marketplace/removed-projection.ts";
    const fixture = createFixture(
      {
        [ownProjection]: handlerMap({ "checkout.cart.line-added": cast }),
        [withoutCasts]: handlerMap({ "marketplace.offer.accepted": "return event.data.offerId;" }),
      },
      { baseline: { [ownProjection]: 1, [withoutCasts]: 1, [missing]: 2 } },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations).toHaveLength(3);
    expect(result.violations.join("\n")).toContain(
      `stale entry for ${ownProjection} allows 1 cast(s) but the file is exempt`,
    );
    expect(result.violations.join("\n")).toContain(
      `stale entry for ${withoutCasts} allows 1 cast(s) but the file holds no counted cast`,
    );
    expect(result.violations.join("\n")).toContain(`stale entry for ${missing} allows 2 cast(s) but the file is gone`);
  });

  it("rejects entries that are not forward-slash paths mapped to positive integers", () => {
    const fixture = createFixture(
      { [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast }) },
      { baseline: { [foreignProjection.replaceAll("/", "\\")]: 1, [keylessHelper]: 0 } },
    );

    const result = validateCrossContextEventPayloadCasts(fixture);

    expect(result.violations.join("\n")).toContain("must be a normalized repository path with forward slashes");
    expect(result.violations.join("\n")).toContain(`entry '${keylessHelper}' must be a positive integer cast count`);
    expect(result.violations.join("\n")).toContain(
      `${foreignProjection}: 1 '<identifier>.data as' cast(s) and no entry`,
    );
  });

  it("creates the baseline when the file is absent", () => {
    const fixture = createFixture({
      [mixedProjection]: handlerMap({ "checkout.sell-list.line-added": cast, "marketplace.offer.accepted": cast }),
      [keylessHelper]: `export const offerRow = (event) => event.data as { offerId: string };\n`,
      [ownProjection]: handlerMap({ "checkout.cart.line-added": cast }),
    });

    const outcome = writeCrossContextEventPayloadCastsBaseline(fixture);

    expect(outcome).toEqual({ created: true, lowered: [], removed: [], refused: [] });
    expect(readBaselineText(fixture.repoRoot)).toBe(
      `${JSON.stringify({ [keylessHelper]: 1, [mixedProjection]: 2 }, null, 2)}\n`,
    );
    expect(validateCrossContextEventPayloadCasts(fixture).violations).toEqual([]);
  });

  it("lowers and removes entries in an existing baseline and never adds or raises one", () => {
    const removed = "bounded-contexts/checkout/features/cart/integrations/marketplace/removed-projection.ts";
    const fixture = createFixture(
      {
        [mixedProjection]: handlerMap({ "checkout.sell-list.line-added": cast, "marketplace.offer.accepted": cast }),
        [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast, "marketplace.offer.paused": cast }),
        [keylessHelper]: `export const offerRow = (event) => event.data as { offerId: string };\n`,
        [ownProjection]: handlerMap({ "checkout.cart.line-added": cast }),
      },
      { baseline: { [mixedProjection]: 5, [foreignProjection]: 1, [ownProjection]: 1, [removed]: 4 } },
    );

    const outcome = writeCrossContextEventPayloadCastsBaseline(fixture);

    expect(outcome).toEqual({
      created: false,
      lowered: [{ file: mixedProjection, from: 5, to: 2 }],
      removed: [
        { file: ownProjection, from: 1 },
        { file: removed, from: 4 },
      ],
      refused: [
        { file: foreignProjection, count: 2, allowed: 1 },
        { file: keylessHelper, count: 1, allowed: 0 },
      ],
    });
    expect(readBaselineText(fixture.repoRoot)).toBe(
      `${JSON.stringify({ [foreignProjection]: 1, [mixedProjection]: 2 }, null, 2)}\n`,
    );

    const result = validateCrossContextEventPayloadCasts(fixture);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.join("\n")).toContain(`${foreignProjection}: 2 '<identifier>.data as' cast(s) but`);
    expect(result.violations.join("\n")).toContain(`${keylessHelper}: 1 '<identifier>.data as' cast(s) and no entry`);
  });

  it("leaves an existing baseline untouched when it could only add or raise entries", () => {
    const fixture = createFixture(
      {
        [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast, "marketplace.offer.paused": cast }),
        [keylessHelper]: `export const offerRow = (event) => event.data as { offerId: string };\n`,
      },
      { baseline: { [foreignProjection]: 1 } },
    );
    const before = readBaselineText(fixture.repoRoot);

    const outcome = writeCrossContextEventPayloadCastsBaseline(fixture);

    expect(outcome.lowered).toEqual([]);
    expect(outcome.removed).toEqual([]);
    expect(outcome.refused).toHaveLength(2);
    expect(readBaselineText(fixture.repoRoot)).toBe(before);
  });

  it("refuses to rewrite a baseline it cannot read", () => {
    const fixture = createFixture({ [foreignProjection]: handlerMap({ "marketplace.offer.accepted": cast }) });
    writeSource(fixture.repoRoot, CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH, "[]\n");

    expect(() => writeCrossContextEventPayloadCastsBaseline(fixture)).toThrow(/baseline must be an object/);
    expect(readBaselineText(fixture.repoRoot)).toBe("[]\n");
    expect(existsSync(path.join(fixture.repoRoot, CROSS_CONTEXT_EVENT_PAYLOAD_CASTS_BASELINE_PATH))).toBe(true);
  });

  it("prints each counted file with its count and the totals", () => {
    expect(
      formatCrossContextEventPayloadCastInventory(
        new Map([
          [foreignProjection, 12],
          [keylessHelper, 1],
        ]),
      ),
    ).toBe(`12  ${foreignProjection}\n 1  ${keylessHelper}\n2 file(s), 13 cast(s)`);
  });
});
