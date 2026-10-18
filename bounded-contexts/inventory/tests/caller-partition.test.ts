import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { discoverInventoryCallers, partitionInventoryCallers, trackedInventorySources } from "./caller-partition.mjs";

describe("issue-7169-ac1-caller-partition", () => {
  it.each([
    "services.restockDecisions[method]({}, context);",
    "const mutate = services.restockDecisions[method]; mutate({}, context);",
    'services["restockDecisions"][method]({}, context);',
    'const mutate = services["restockDecisions"][method]; mutate({}, context);',
    "services['restockDecisions'][method]({}, context);",
    "const mutate = services['restockDecisions'][method]; mutate({}, context);",
  ])("rejects unresolved restock access at an arbitrary path: %s", (source) => {
    expect(() =>
      discoverInventoryCallers([{ path: "bounded-contexts/arbitrary/api/dynamic-restock.ts", source }]),
    ).toThrow("Unresolved Inventory call");
  });
  it.each([
    ["bare dot call", "services.$F[method]({}, context);", true, true],
    ["bare dot extraction", "const m = services.$F[method]; m({}, context);", true, true],
    ["parenthesized dot call", "(services.$F)[method]({}, context);", true, true],
    ["parenthesized dot extraction", "const m = (services.$F)[method]; m({}, context);", true, true],
    ["non-null dot call", "services.$F![method]({}, context);", true, true],
    ["non-null dot extraction", "const m = services.$F![method]; m({}, context);", true, true],
    ["asserted dot call", "(services.$F as T)[method]({}, context);", true, true],
    ["asserted dot extraction", "const m = (services.$F as T)[method]; m({}, context);", true, true],
    ["bare bracket call", 'services["$F"][method]({}, context);', false, true],
    ["bare bracket extraction", 'const m = services["$F"][method]; m({}, context);', false, true],
    ["parenthesized bracket call", '(services["$F"])[method]({}, context);', false, false],
    ["parenthesized bracket extraction", 'const m = (services["$F"])[method]; m({}, context);', false, false],
    ["non-null bracket call", 'services["$F"]![method]({}, context);', false, false],
    ["non-null bracket extraction", 'const m = services["$F"]![method]; m({}, context);', false, false],
    ["asserted bracket call", '(services["$F"] as T)[method]({}, context);', false, false],
    ["asserted bracket extraction", 'const m = (services["$F"] as T)[method]; m({}, context);', false, false],
  ])("freezes M16 C1 parity and g7 gains: %s", (_shape, template, rejectsHolds, rejectsRestock) => {
    for (const [family, rejected] of [
      ["holds", rejectsHolds],
      ["importBatches", rejectsHolds],
      ["restockDecisions", rejectsRestock],
    ] as const) {
      const scan = () =>
        partitionInventoryCallers(
          discoverInventoryCallers([
            {
              path: "bounded-contexts/arbitrary/api/dynamic-parity.ts",
              source: template.replaceAll("$F", family),
            },
          ]),
          {},
        );
      if (rejected) expect(scan).toThrow("Unresolved Inventory call");
      else expect(scan).not.toThrow();
    }
  });
  it("discovers restock service aliases, HTTP clients and direct decision commands", () => {
    const discovery = discoverInventoryCallers([
      {
        path: "bounded-contexts/arbitrary/features/restock/api/new.ts",
        source: `const { recordDecision: record } = services.restockDecisions;
        record({}, context); client.recordRestockDecision(id, {});
        services.restockDecisions.commandHandler({command: {type: "RecordRestockDecision"}});`,
      },
    ]);
    expect(discovery.callers.map((caller: { family: string }) => caller.family)).toEqual(
      Array(3).fill("restock-record"),
    );
    expect(() => partitionInventoryCallers(discovery, {})).toThrow("Unclassified Inventory caller");
  });
  it("discovers the complete tracked repository corpus", () => {
    const discovery = discoverInventoryCallers(trackedInventorySources());
    if (process.env.CHASE_SETS_C1_CENSUS_EVIDENCE)
      writeFileSync(process.env.CHASE_SETS_C1_CENSUS_EVIDENCE, JSON.stringify(discovery, null, 2));
    expect(discovery.callers.length).toBeGreaterThan(30);
    expect(discovery.scanned + discovery.ignored.length).toBe(discovery.total);
    const registry = JSON.parse(readFileSync(new URL("./caller-partition.json", import.meta.url), "utf8"));
    const partition = partitionInventoryCallers(discovery, registry);
    expect(partition.callers).toHaveLength(discovery.callers.length);
    expect(new Set(partition.callers.map((caller: { status: string }) => caller.status))).toEqual(
      new Set(["unrelated", "retained-reader", "pending", "cutover", "retained-family"]),
    );
  });

  it("discovers an arbitrary tracked path and ignores real built output without changing the clean partition", () => {
    const scratch = path.resolve(import.meta.dirname, "../../../artifacts/c1-census");
    mkdirSync(scratch, { recursive: true });
    const fixture = mkdtempSync(path.join(scratch, "tracked-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      const file = "bounded-contexts/arbitrary/features/not-on-a-list/api/unexpected.ts";
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), "const { createHold: reserve } = inventory.holds; reserve({}, context);");
      execFileSync("git", ["add", "--", file], { cwd: fixture });
      const clean = discoverInventoryCallers(trackedInventorySources(fixture));
      expect(clean.callers).toHaveLength(1);
      expect(() => partitionInventoryCallers(clean, {})).toThrow("Unclassified Inventory caller");
      mkdirSync(path.join(fixture, "bounded-contexts/arbitrary/dist"), { recursive: true });
      writeFileSync(
        path.join(fixture, "bounded-contexts/arbitrary/dist/unexpected.js"),
        "inventory.holds.createHold({}, context);",
      );
      execFileSync("git", ["add", "--", "bounded-contexts/arbitrary/dist/unexpected.js"], { cwd: fixture });
      const built = discoverInventoryCallers(trackedInventorySources(fixture));
      expect(built.callers).toEqual(clean.callers);
      expect(built.scanned + built.ignored.length).toBe(built.total);
      expect(built.ignored).toEqual(["bounded-contexts/arbitrary/dist/unexpected.js"]);
    } finally {
      if (!fixture.startsWith(scratch + path.sep)) throw new Error("Census fixture escaped its scratch directory");
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("discovers direct, bracket, destructured, assigned and bound aliases as one family", () => {
    const discovery = discoverInventoryCallers([
      {
        path: "bounded-contexts/example/support/new-path.ts",
        source: `
        const { createHold: reserve } = services.holds;
        const again = reserve;
        const bound = services.holds.createHold.bind(services.holds);
        services.holds.createHold({}, context);
        services.holds["createHold"]({}, context);
        reserve({}, context); again({}, context); bound({}, context);
        services.holds.commandHandler({command: {type: "PlaceInventoryHold"}});
      `,
      },
    ]);
    expect(discovery.callers.map((caller: { family: string }) => caller.family)).toEqual(Array(6).fill("hold-create"));
    expect(discovery.scanned).toBe(1);
    expect(discovery.total).toBe(1);
  });

  it("fails closed for an unknown caller at an arbitrary path", () => {
    const discovery = discoverInventoryCallers([
      {
        path: "bounded-contexts/unexpected/features/surprise/api/new.ts",
        source: `
        const { reduceItem: mutate } = inventory.holdCollisions;
        mutate({}, context);
      `,
      },
    ]);
    expect(() => partitionInventoryCallers(discovery, {})).toThrow("Unclassified Inventory caller");
  });

  it("reconciles all inputs and has identical clean and built discovery", () => {
    const production = { path: "bounded-contexts/example/api/runtime.ts", source: "api.createItem({});" };
    const ignored = [
      { path: "bounded-contexts/example/api/runtime.test.ts", source: "api.createItem({});" },
      { path: "bounded-contexts/example/tests/harness.ts", source: "api.createItem({});" },
      { path: "docs/example.ts", source: "api.createItem({});" },
      { path: "bounded-contexts/example/dist/runtime.js", source: "api.createItem({});" },
      { path: "bounded-contexts/example/generated/runtime.ts", source: "api.createItem({});" },
    ];
    const clean = discoverInventoryCallers([production]);
    const built = discoverInventoryCallers([production, ...ignored]);
    expect(clean.callers).toEqual(built.callers);
    expect(clean.callers).toHaveLength(1);
    expect(built.scanned + built.ignored.length).toBe(built.total);
    expect(built.scanned).toBe(1);
    expect(built.total).toBe(6);
  });

  it("rejects dynamic executable shapes rather than silently dropping them", () => {
    expect(() =>
      discoverInventoryCallers([
        { path: "bounded-contexts/example/api/dynamic.ts", source: "inventory.holds[method]({}, context);" },
      ]),
    ).toThrow("Unresolved Inventory call");
    expect(() =>
      discoverInventoryCallers([
        {
          path: "bounded-contexts/example/api/exposed-alias.ts",
          source: "const mutate = inventory.holds[method]; mutate({}, context);",
        },
      ]),
    ).toThrow("Unresolved Inventory call");
    expect(() =>
      discoverInventoryCallers([
        { path: "bounded-contexts/example/api/invalid-syntax.ts", source: "inventory.holds.createHold({" },
      ]),
    ).toThrow("invalid syntax");
  });
});
