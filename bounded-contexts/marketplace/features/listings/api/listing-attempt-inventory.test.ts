import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  enumerateListingAttemptCallers,
  listingCallerPattern,
  marketplaceAttemptInventoryIgnoreRules,
  readTrackedMarketplaceCallerSources,
  unpartitionedListingCallers,
} from "../../../../../scripts/check-structure/marketplace-attempt-callers.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
// This change's base on main: only bulk price updates carried a Listing attempt there.
const mainBase = "7970edaf9821a82259d20090065b4bc3c53be375";
const mainSource = (file: string) =>
  execFileSync("git", ["show", `${mainBase}:${file}`], { cwd: root, encoding: "utf8" });

describe("listing attempt caller partition", () => {
  it("partitions every tracked Listing caller by import/code shape, not a directory vocabulary", () => {
    const callers = enumerateListingAttemptCallers(readTrackedMarketplaceCallerSources(root, listingCallerPattern));
    expect(callers.length).toBeGreaterThan(80);
    expect(unpartitionedListingCallers(callers)).toEqual([]);
    expect(marketplaceAttemptInventoryIgnoreRules).toContain(".gitignore");
  });

  it.each([
    ["bounded-contexts/discovery/support/route-support/item-detail/action.ts", "createListing"],
    ["bounded-contexts/discovery/support/route-support/item-detail/action.ts", "publishListing"],
    ["bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts", "createListing"],
    [
      "bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts",
      "publishListing",
    ],
    ["bounded-contexts/marketplace/support/runtime-support/seed.ts", "withdrawListing"],
    ["bounded-contexts/marketplace/support/runtime-support/seed.ts", "createListing"],
    ["bounded-contexts/marketplace/features/listings/api/mcp.ts", "pauseListing"],
    ["bounded-contexts/marketplace/routes/account-listings.tsx", "pauseListing"],
  ])("is red on main's %s %s omission", (file, method) => {
    const callers = enumerateListingAttemptCallers([{ path: file, source: mainSource(file) }]);
    expect(unpartitionedListingCallers(callers).some((caller) => caller.method === method)).toBe(true);
  });

  it.each([
    'import { marketplaceApi } from "@chase-sets/marketplace"; marketplaceApi.publishListing("lst_1", {});',
    'import { withdrawListing as drop } from "./api"; drop("lst_1");',
    "const { pauseListing: stop } = api; stop({ listingId });",
    "const send = api.updateListingPrice; send(id, { priceAmount });",
    "marketplace.listings!.createListing!({ accountId }, context);",
    'listings.commandHandler({ streamId, command: { type: "PauseListing" }, context });',
  ])("rejects a planted Listing caller at an arbitrary tracked path: %s", (source) => {
    expect(
      unpartitionedListingCallers(enumerateListingAttemptCallers([{ path: "odd/banana.ts", source }])),
    ).toHaveLength(1);
  });

  it.each([
    ['request.post("/api/marketplace/account/listings", { data: {} });', "http-create-listing"],
    ["request.post(`/api/marketplace/account/listings/${id}/publish`, { data: {} });", "http-listing-command"],
    ['request.post("/api/marketplace/account/listings/prices/bulk", { data: {} });', "http-bulk-listing-prices"],
    ['request.delete("/api/marketplace/account/order-capacity", { headers: {} });', "http-seller-order-capacity"],
  ])("rejects a planted HTTP transport caller in a test file: %s", (call, method) => {
    const source = `import { test } from "@playwright/test"; ${call}`;
    const callers = enumerateListingAttemptCallers([{ path: "odd/banana.spec.ts", source }]);
    expect(callers.map((caller) => caller.method)).toEqual([method]);
    expect(unpartitionedListingCallers(callers)).toHaveLength(1);
  });

  it("partitions a known caller only by the carrier in its own call text", () => {
    const file = "bounded-contexts/discovery/support/route-support/item-detail/action.ts";
    const callers = (call: string) => enumerateListingAttemptCallers([{ path: file, source: call }]);
    expect(unpartitionedListingCallers(callers("marketplaceApi.publishListing(id, { idempotencyKey });"))).toEqual([]);
    expect(
      unpartitionedListingCallers(callers("marketplaceApi.publishListing(id, { feeQuoteFingerprint });")),
    ).toHaveLength(1);
  });

  it("rejects a Listing command form without its attempt field", () => {
    const file = "bounded-contexts/marketplace/features/listings/ui/listing-detail-page.tsx";
    const form = (fields: string) =>
      enumerateListingAttemptCallers([
        { path: file, source: `const form = <Form><HiddenInput name="intent" value="pause" />${fields}</Form>;` },
      ]);
    expect(unpartitionedListingCallers(form('<HiddenInput name="attemptId" value={attemptId} />'))).toEqual([]);
    expect(unpartitionedListingCallers(form(""))).toHaveLength(1);
  });

  it("does not enumerate route registrations, reads or Listing photo commands", () => {
    for (const source of [
      'app.post("/listings/:id/publish", async (c) => c.json({}));',
      'request.get("/api/marketplace/account/listings", { headers: {} });',
      "request.post(`/api/marketplace/account/listings/${id}/photos`, { data: {} });",
    ])
      expect(enumerateListingAttemptCallers([{ path: "odd/banana.ts", source }])).toEqual([]);
  });

  it("is identical with built output and rejects a working-tree-walk mutant", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "listing-caller-inventory-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
    try {
      git("init");
      writeFileSync(path.join(fixture, ".gitignore"), "build/\n");
      writeFileSync(path.join(fixture, "banana.ts"), "api.withdrawListing(id);");
      git("add", ".");
      const read = () =>
        enumerateListingAttemptCallers(readTrackedMarketplaceCallerSources(fixture, listingCallerPattern));
      const clean = read();
      expect(unpartitionedListingCallers(clean)).toHaveLength(1);
      mkdirSync(path.join(fixture, "build/server"), { recursive: true });
      const generated = { path: "build/server/index.js", source: "api.withdrawListing(id);" };
      writeFileSync(path.join(fixture, generated.path), generated.source);
      git("add", "-f", generated.path);
      expect(read()).toEqual(clean);
      expect(
        enumerateListingAttemptCallers([{ path: "banana.ts", source: "api.withdrawListing(id);" }, generated]),
      ).not.toEqual(clean);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
