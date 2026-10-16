import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  enumerateMarketplaceAttemptCallers,
  readTrackedMarketplaceCallerSources,
  unpartitionedMarketplaceOfferCallers,
  marketplaceAttemptInventoryIgnoreRules,
} from "../../../../../scripts/check-structure/marketplace-attempt-callers.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
describe("offer attempt caller partition", () => {
  it("is red on the pinned baseline's actual Discovery-to-Checkout submit boundary", () => {
    const file = "bounded-contexts/checkout/support/request-support/checkout-confirmation.ts";
    const source = execFileSync("git", ["show", `94a04608e97e1c98659ae4e39e6ea1538754be24:${file}`], {
      cwd: root,
      encoding: "utf8",
    });
    expect(
      unpartitionedMarketplaceOfferCallers(enumerateMarketplaceAttemptCallers([{ path: file, source }])).some(
        (caller) => caller.method === "createSubmittedOffer",
      ),
    ).toBe(true);
  });
  it("partitions every tracked caller by import/code shape, not a directory vocabulary", () => {
    const callers = enumerateMarketplaceAttemptCallers(readTrackedMarketplaceCallerSources(root));
    expect(callers.length).toBeGreaterThan(15);
    expect(unpartitionedMarketplaceOfferCallers(callers)).toEqual([]);
    expect(marketplaceAttemptInventoryIgnoreRules).toContain(".gitignore");
  });
  it.each([
    'import { marketplaceApi } from "@chase-sets/marketplace"; marketplaceApi.createSubmittedOffer({});',
    'import { submitOffer as send } from "./api"; send({});',
    "const { submitOffer: send } = api; send({});",
    "const send = api.submitOffer; send({});",
  ])("rejects a planted caller at an arbitrary tracked path: %s", (source) => {
    expect(
      unpartitionedMarketplaceOfferCallers(enumerateMarketplaceAttemptCallers([{ path: "odd/banana.ts", source }])),
    ).toHaveLength(1);
  });
  it("is identical with built output and rejects a working-tree-walk mutant", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "marketplace-caller-inventory-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
    try {
      git("init");
      writeFileSync(path.join(fixture, ".gitignore"), ".react-router/\n");
      writeFileSync(path.join(fixture, "banana.ts"), "api.submitOffer({});");
      git("add", ".");
      const clean = enumerateMarketplaceAttemptCallers(readTrackedMarketplaceCallerSources(fixture));
      expect(unpartitionedMarketplaceOfferCallers(clean)).toHaveLength(1);
      mkdirSync(path.join(fixture, ".react-router/types"), { recursive: true });
      const generated = { path: ".react-router/types/generated.ts", source: "api.submitOffer({});" };
      writeFileSync(path.join(fixture, generated.path), generated.source);
      git("add", "-f", generated.path);
      expect(enumerateMarketplaceAttemptCallers(readTrackedMarketplaceCallerSources(fixture))).toEqual(clean);
      expect(
        enumerateMarketplaceAttemptCallers([{ path: "banana.ts", source: "api.submitOffer({});" }, generated]),
      ).not.toEqual(clean);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
