import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enumerateListingAttemptCallers,
  readTrackedMarketplaceCallerSources,
  unpartitionedListingAttemptCallers,
} from "../../../../../scripts/check-structure/marketplace-attempt-callers.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
describe("listing attempt caller partition", () => {
  it("partitions all tracked callers, including fixtures, composition and E2E", () => {
    const callers = enumerateListingAttemptCallers(readTrackedMarketplaceCallerSources(root));
    expect(callers.length).toBeGreaterThan(200);
    expect(unpartitionedListingAttemptCallers(callers)).toEqual([]);
  });
  it.each([
    "api.createListing({});",
    'import { createListing as send } from "./owner"; send({});',
    "const { publishListing: send } = api; send(id, {});",
    "const send = api.pauseListing; send(id);",
    'api["withdrawListing"](id);',
    "api.publishListing!(id, {});",
    'api.setListingCertificationNumber(id, { certificationNumber: "123" });',
    'request.post("/api/marketplace/account/listings/lst_1/certification-number", { data: {} });',
    'request.post("/api/marketplace/account/listings", { data: {} });',
    "const target = `/api/marketplace/account/listings/${id}`; request.post(`${target}/publish`, { data: {} });",
    'client.callTool({ name: "marketplace.create-listing", arguments: {} });',
  ])("rejects an arbitrary tracked code-shape caller: %s", (source) => {
    expect(
      unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: "odd/banana.ts", source }])),
    ).toHaveLength(1);
  });
  it("requires a stable attempt on the real-host channel target fixture", () => {
    const file = "deployables/platform-api/__tests__/listing-channel-activation-composition.db.test.ts";
    const source = readFileSync(path.join(root, file), "utf8");
    const callers = enumerateListingAttemptCallers([{ path: file, source }]);
    expect(callers.map(({ method }) => method)).toEqual(["createListingFromInventorySnapshot", "withdrawListing"]);
    expect(unpartitionedListingAttemptCallers(callers)).toEqual([]);
    for (const [method, key] of [
      ["createListingFromInventorySnapshot", "synthetic-listing-create-attempt"],
      ["withdrawListing", "synthetic-pricing-withdraw"],
    ]) {
      const mutant = source.replace(`idempotencyKey: "${key}",`, "");
      expect(mutant).not.toBe(source);
      const rejected = unpartitionedListingAttemptCallers(
        enumerateListingAttemptCallers([{ path: file, source: mutant }]),
      );
      expect(rejected.map((caller) => caller.method)).toEqual([method]);
    }
  });
  it("rejects the historical Checkout keyless caller and a current key-removal mutant", () => {
    const historicalFile =
      "bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts";
    const baseline = execFileSync("git", ["show", `a53a07070be4c8d184ceb38af963f426ab174208:${historicalFile}`], {
      cwd: root,
      encoding: "utf8",
    });
    expect(
      unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: historicalFile, source: baseline }])),
    ).toHaveLength(2);
    const file = "bounded-contexts/checkout/features/sell-list/api/marketplace-handoff.ts";
    const source = readFileSync(path.join(root, file), "utf8");
    expect(unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: file, source }]))).toEqual([]);
    const mutant = source.replaceAll("idempotencyKey:", "removedAttemptIdentity:");
    expect(mutant).not.toBe(source);
    expect(mutant).not.toContain("idempotencyKey:");
    expect(
      unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: file, source: mutant }])),
    ).toHaveLength(2);
  });
  it("rejects an MCP forwarding mutant", () => {
    const file = "bounded-contexts/marketplace/features/listings/api/mcp.ts";
    const source = readFileSync(path.join(root, file), "utf8").replaceAll("...readListingAttempt(args),", "");
    expect(unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: file, source }]))).toHaveLength(
      4,
    );
  });
  it("enumerates identical clean/built trees and exposes a working-tree-walk mutant", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "listing-caller-partition-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
    try {
      git("init");
      writeFileSync(path.join(fixture, ".gitignore"), ".react-router/\n");
      writeFileSync(path.join(fixture, "banana.ts"), "api.createListing({});");
      git("add", ".");
      const clean = enumerateListingAttemptCallers(readTrackedMarketplaceCallerSources(fixture));
      mkdirSync(path.join(fixture, ".react-router/types"), { recursive: true });
      const generated = { path: ".react-router/types/generated.ts", source: "api.createListing({});" };
      writeFileSync(path.join(fixture, generated.path), generated.source);
      git("add", "-f", generated.path);
      writeFileSync(path.join(fixture, "untracked.ts"), "api.publishListing(id, {});");
      expect(enumerateListingAttemptCallers(readTrackedMarketplaceCallerSources(fixture))).toEqual(clean);
      expect(
        enumerateListingAttemptCallers([{ path: "banana.ts", source: "api.createListing({});" }, generated]),
      ).not.toEqual(clean);
      expect(unpartitionedListingAttemptCallers(clean)).toHaveLength(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
