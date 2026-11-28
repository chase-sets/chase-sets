import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyChanges } from "./change-scope.mjs";
import { e2eNoSuiteExclusionForChangedFile } from "./e2e-suites.mjs";
import stripeEmbedUatGlobalSetup, { assertStripeEmbedUatTarget } from "./stripe-embed-uat-gates.mjs";

const repo = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, repo), "utf8");
const spec = "deployables/corten-pilot/e2e/account-payment-stripe-embed.uat.spec.ts";
const manualConfig = "playwright.stripe-embed-uat.config.ts";
const gates = "scripts/stripe-embed-uat-gates.mjs";
const staging = "https://marketplace.staging.chasesets.com";
const key = (mode) => ["pk", mode, "synthetic"].join("_");
const testKey = key("test");
const productionHosts = JSON.parse(read("scripts/environment-hosts.json"))
  .hosts.filter(({ environment }) => environment === "production")
  .map(({ host }) => host);

describe("manual Stripe embed UAT money gates", () => {
  it("accepts the test publishable key and refuses live, missing, and unknown keys without echoing them", () => {
    expect(assertStripeEmbedUatTarget(staging, testKey)).toBe(staging);
    for (const value of [key("live"), "", "unknown-key"]) {
      expect(() => assertStripeEmbedUatTarget(staging, value)).toThrow(
        "Stripe embed UAT refused: STRIPE_PUBLISHABLE_KEY must be a Stripe test-mode publishable key.",
      );
    }
  });

  it.each(productionHosts)("refuses the production host %s exactly, regardless of case", (host) => {
    for (const name of [host, host.toUpperCase(), `${host}.`]) {
      expect(() => assertStripeEmbedUatTarget(`https://${name}`, testKey)).toThrow(
        "MARKETPLACE_WEB_URL names a production host.",
      );
    }
  });

  it("accepts the staging marketplace origins and rejects lookalikes as non-staging, not as production", () => {
    expect(assertStripeEmbedUatTarget("https://MARKETPLACE.STAGING.CHASESETS.COM/", testKey)).toBe(staging);
    expect(assertStripeEmbedUatTarget("https://marketplace-corten.staging.chasesets.com", testKey)).toBe(
      "https://marketplace-corten.staging.chasesets.com",
    );
    for (const url of [
      "https://chasesets.com.evil.test",
      "https://marketplace.chasesets.com.evil.test",
      "https://marketplace.staging.chasesets.com.evil.test",
      "http://marketplace.staging.chasesets.com",
      `${staging}/account`,
      `${staging}:443`,
      `${staging}/account/..`,
      `${staging}?`,
      `${staging}#`,
      "https://user:pass@marketplace.staging.chasesets.com",
    ]) {
      expect(() => assertStripeEmbedUatTarget(url, testKey)).toThrow(
        "MARKETPLACE_WEB_URL must be a staging marketplace HTTPS origin.",
      );
    }
    expect(() => assertStripeEmbedUatTarget("not a URL", testKey)).toThrow(
      "MARKETPLACE_WEB_URL must be a valid HTTPS origin.",
    );
  });
});

describe("manual Stripe embed UAT global setup", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_EMBED_UAT", "true");
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", testKey);
    vi.stubEnv("MARKETPLACE_WEB_URL", staging);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("does nothing without the opt-in, even with the required variables missing", () => {
    vi.stubEnv("STRIPE_EMBED_UAT", undefined);
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", undefined);
    vi.stubEnv("MARKETPLACE_WEB_URL", undefined);
    expect(stripeEmbedUatGlobalSetup()).toBeUndefined();
  });

  it("refuses a live-mode key", () => {
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", key("live"));
    expect(stripeEmbedUatGlobalSetup).toThrow(
      "Stripe embed UAT refused: STRIPE_PUBLISHABLE_KEY must be a Stripe test-mode publishable key.",
    );
  });

  it("refuses a production host", () => {
    vi.stubEnv("MARKETPLACE_WEB_URL", "https://marketplace.chasesets.com");
    expect(stripeEmbedUatGlobalSetup).toThrow("Stripe embed UAT refused: MARKETPLACE_WEB_URL names a production host.");
  });

  it.each(["STRIPE_PUBLISHABLE_KEY", "MARKETPLACE_WEB_URL"])("names missing variable %s", (name) => {
    vi.stubEnv(name, undefined);
    expect(stripeEmbedUatGlobalSetup).toThrow(`Stripe embed UAT requires ${name}.`);
  });

  it("wires the manual config by path and keeps both config and spec free of scripts imports", () => {
    expect(read(manualConfig)).toContain(`globalSetup: "./${gates}"`);
    for (const file of [manualConfig, spec]) {
      expect(read(file), file).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\bscripts\//);
    }
    expect(read(spec)).toContain('testInfo.project.name !== "stripe-embed-uat"');
  });
});

describe("manual Stripe embed UAT selection", () => {
  it("does not select a browser, Catalog synthetic, or Corten check gate for a UAT-only change", () => {
    expect(e2eNoSuiteExclusionForChangedFile(spec)?.reason).toContain("Manual staging Stripe test-mode UAT");
    for (const path of [spec, gates, manualConfig, "scripts/stripe-embed-uat.test.mjs"]) {
      expect(classifyChanges({ changedFiles: [path], workspaces: [] }), path).toMatchObject({
        e2eSuiteIds: [],
        e2eTestsRequired: false,
        catalogUatSyntheticRequired: false,
        cortenMarketplaceBrowserRequired: false,
        cortenAdminBrowserRequired: false,
        cortenPublicBrowserRequired: false,
        cortenPilotCheckRequired: false,
      });
    }
    expect(
      classifyChanges({
        changedFiles: ["deployables/corten-pilot/e2e/critical-flows.spec.ts"],
        workspaces: [],
      }).cortenMarketplaceBrowserRequired,
    ).toBe(true);
  });

  it("excludes the spec from shared Playwright discovery and keeps the manual config out of every workflow and local CI plan", () => {
    expect(read("playwright.config.ts")).toContain(`testIgnore: "${spec}"`);
    expect(read(manualConfig)).toContain('testMatch: "**/account-payment-stripe-embed.uat.spec.ts"');
    expect(read(spec)).toContain('test.skip(process.env.STRIPE_EMBED_UAT !== "true"');
    const workflows = readdirSync(new URL(".github/workflows/", repo)).filter((name) => /\.ya?ml$/.test(name));
    for (const file of [...workflows.map((name) => `.github/workflows/${name}`), "scripts/verify-ci-local.mjs"]) {
      const source = read(file);
      expect(source, file).not.toContain("account-payment-stripe-embed.uat.spec.ts");
      expect(source, file).not.toContain("stripe-embed-uat");
      expect(source, file).not.toContain("STRIPE_EMBED_UAT");
    }
  });
});
