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
// This change's base on main: every Offer caller there still lacks an attempt identity.
const mainBase = "c61c2cd5bcb27b88813e81790efd756ba9972924";
describe("offer attempt caller partition", () => {
  it("is red on main's actual Discovery-to-Checkout submit boundary", () => {
    const file = "bounded-contexts/checkout/support/request-support/checkout-confirmation.ts";
    const source = execFileSync("git", ["show", `${mainBase}:${file}`], {
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
  it.each([
    ['request.post("/api/marketplace/account/offers/submitted", { data: {} });', "http-submit-offer"],
    [
      "request.patch(`/api/marketplace/account/offers/submitted/${id}/price`, { data: {} });",
      "http-update-offer-price",
    ],
    ["page.request.post(`/api/marketplace/account/offers/matches/${id}/accept`, { data: {} });", "http-accept-offer"],
    ["page.request.post(`/api/marketplace/account/offers/matches/${id}/decline`, { data: {} });", "http-decline-offer"],
    [
      "request.post(`/api/marketplace/account/offer-policies/${id}/commands`, { data: {} });",
      "http-offer-policy-command",
    ],
  ])("rejects a planted HTTP transport caller in a test file: %s", (call, method) => {
    const source = `import { test } from "@playwright/test"; ${call}`;
    const callers = enumerateMarketplaceAttemptCallers([{ path: "odd/banana.spec.ts", source }]);
    expect(callers.map((caller) => caller.method)).toEqual([method]);
    expect(unpartitionedMarketplaceOfferCallers(callers)).toHaveLength(1);
  });
  it("partitions an HTTP caller only by the attempt field in its own request options", () => {
    const path = "deployables/marketplace/e2e/accepted-offer-sales-handoff.spec.ts";
    const callers = (data: string) =>
      enumerateMarketplaceAttemptCallers([
        {
          path,
          source: `page.request.post(\`/api/marketplace/account/offers/matches/\${id}/accept\`, { data: ${data} });`,
        },
      ]);
    expect(unpartitionedMarketplaceOfferCallers(callers("{ sourceActionKey: randomUUID() }"))).toEqual([]);
    expect(unpartitionedMarketplaceOfferCallers(callers("{ attemptId: randomUUID() }"))).toHaveLength(1);
  });
  it.each([
    'app.post("/offers/submitted", async (c) => c.json({}));',
    'request.get("/api/marketplace/account/offers/submitted", { headers: {} });',
    'request.post("/api/marketplace/account/offers/submitted/bulk", { data: {} });',
    "request.post(`/api/marketplace/account/offers/submitted/${id}/pause`, { data: {} });",
  ])("does not enumerate a route registration, read or lifecycle request: %s", (source) => {
    expect(enumerateMarketplaceAttemptCallers([{ path: "odd/banana.ts", source }])).toEqual([]);
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
  it.each(["attemptId", "requestHash"])("rejects test-file MCP callers missing %s", (missing) => {
    const path = "deployables/platform-api/__tests__/mcp-sdk-agent-journey.e2e.test.ts";
    const source =
      'import { it } from "vitest"; client.callTool({ name: "marketplace.submit-offer", arguments: { attemptId: "sdk_submit_attempt_12345", requestHash: "hash" } });';
    const callers = (text: string) => enumerateMarketplaceAttemptCallers([{ path, source: text }]);
    expect(callers(source)).toHaveLength(1);
    expect(unpartitionedMarketplaceOfferCallers(callers(source))).toEqual([]);
    expect(
      unpartitionedMarketplaceOfferCallers(callers(source.replace(new RegExp(`${missing}: "[^"]+",?`), ""))),
    ).toHaveLength(1);
  });
  it("rejects form producers missing attemptId, including test-file producers", () => {
    const path = "bounded-contexts/marketplace/features/offers/ui/offer-match-list-page.tsx";
    const source =
      'import { it } from "vitest"; const form = <RouterForm><HiddenInput name="intent" value="decline-offer" /><HiddenInput name="attemptId" value={attemptId} /></RouterForm>;';
    const callers = (text: string) => enumerateMarketplaceAttemptCallers([{ path, source: text }]);
    expect(callers(source)).toHaveLength(1);
    expect(unpartitionedMarketplaceOfferCallers(callers(source))).toEqual([]);
    expect(
      unpartitionedMarketplaceOfferCallers(
        callers(source.replace('<HiddenInput name="attemptId" value={attemptId} />', "")),
      ),
    ).toHaveLength(1);
  });
  it.each([
    "deployables/platform-api/__tests__/mcp-sdk-agent-journey.e2e.test.ts",
    "deployables/platform-api/__tests__/seller-desk-journey.e2e.test.ts",
    "bounded-contexts/marketplace/features/offers/ui/offer-match-list-page.tsx",
    "deployables/marketplace/e2e/accepted-offer-sales-handoff.spec.ts",
    "deployables/marketplace/e2e/market-following-offers.spec.ts",
  ])("rejects main's missing-attempt caller: %s", (path) => {
    const source = execFileSync("git", ["show", `${mainBase}:${path}`], {
      cwd: root,
      encoding: "utf8",
    });
    expect(
      unpartitionedMarketplaceOfferCallers(enumerateMarketplaceAttemptCallers([{ path, source }])).length,
    ).toBeGreaterThan(0);
  });
});
