import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalWriter = "scripts/stripe-webhook-events.mjs";
const sourceExtensions = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".yml", ".yaml"]);
const ignoredDirectoryNames = new Set([".git", "node_modules", "artifacts", "dist"]);

function modulePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectoryNames.has(entry.name) ? [] : modulePaths(entryPath);
    }
    return [entryPath];
  });
}

function repositorySources() {
  return modulePaths(rootDir)
    .filter((filePath) => sourceExtensions.has(path.extname(filePath)) && !filePath.includes(".test."))
    .map((filePath) => ({
      path: path.relative(rootDir, filePath).replaceAll("\\", "/"),
      source: readFileSync(filePath, "utf8"),
    }))
    .filter(({ source }) => source.includes("enabled_events") || source.includes("appendStripeEnabledEvents"));
}

function enabledEventConsumerViolations(sources) {
  return sources.flatMap((entry) => {
    const violations = [];
    if (entry.path !== canonicalWriter && /["']enabled_events\[\]["']/u.test(entry.source)) {
      violations.push(`${entry.path} writes enabled_events[] outside ${canonicalWriter}`);
    }
    if (/appendStripeEnabledEvents\s*\([^,]+,\s*\[/u.test(entry.source)) {
      violations.push(`${entry.path} passes an inline event list to appendStripeEnabledEvents`);
    }
    return violations;
  });
}

describe("Stripe enabled_events consumers", () => {
  it("routes every payload writer through the shared encoder and ratified payment-event constant", () => {
    const sources = repositorySources();
    expect(enabledEventConsumerViolations(sources)).toEqual([]);

    for (const relativePath of ["scripts/stripe-webhook-endpoint.mjs", "scripts/provider-webhook-lifecycle.mjs"]) {
      const consumer = sources.find((entry) => entry.path === relativePath)?.source;
      expect(consumer).toContain("STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS");
      expect(consumer).toContain("appendStripeEnabledEvents");
    }
  });

  it("rejects an inline literal enabled_events list as a negative control", () => {
    const fixtureDirectory = mkdtempSync(path.join(rootDir, "contracts", "stripe-webhook-enabled-events-"));
    const fixturePath = path.join(fixtureDirectory, "payment-processing-webhook.mjs");
    const fixtureRelativePath = path.relative(rootDir, fixturePath).replaceAll("\\", "/");
    writeFileSync(
      fixturePath,
      'for (const event of ["payment_intent.succeeded"]) body.append("enabled_events[]", event);',
    );

    try {
      expect(enabledEventConsumerViolations(repositorySources())).toContain(
        `${fixtureRelativePath} writes enabled_events[] outside ${canonicalWriter}`,
      );
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
