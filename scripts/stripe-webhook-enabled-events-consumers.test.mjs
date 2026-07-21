import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalWriter = "scripts/stripe-webhook-events.mjs";
const sourceRoots = ["scripts", "infrastructure", "deployables", "bounded-contexts", "packages", ".github"];
const sourceExtensions = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".yml", ".yaml"]);

function modulePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? modulePaths(entryPath) : [entryPath];
  });
}

function repositorySources() {
  return sourceRoots
    .flatMap((relativePath) => modulePaths(path.join(rootDir, relativePath)))
    .filter((filePath) => sourceExtensions.has(path.extname(filePath)) && !filePath.includes(".test."))
    .map((filePath) => ({
      path: path.relative(rootDir, filePath).replaceAll("\\", "/"),
      source: readFileSync(filePath, "utf8"),
    }));
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
    const fixture = {
      path: "scripts/inline-literal-fixture.mjs",
      source: 'for (const event of ["payment_intent.succeeded"]) body.append("enabled_events[]", event);',
    };

    expect(enabledEventConsumerViolations([fixture])).toEqual([
      `scripts/inline-literal-fixture.mjs writes enabled_events[] outside ${canonicalWriter}`,
    ]);
  });
});
