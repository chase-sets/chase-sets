import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([".js", ".json", ".mjs", ".tf", ".ts", ".tsx", ".yaml", ".yml"]);
const skippedDirectories = new Set([
  ".cache",
  ".react-router",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

function extensionOf(file) {
  const match = /\.[^.\\/]+$/.exec(file);
  return match?.[0] ?? "";
}

function collectTextFiles(root) {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root)
    .flatMap((entry) => {
      const absolute = join(root, entry);
      const stats = statSync(absolute);

      if (stats.isDirectory()) {
        if (skippedDirectories.has(entry)) {
          return [];
        }

        return collectTextFiles(absolute);
      }

      return textExtensions.has(extensionOf(entry)) ? [absolute] : [];
    })
    .sort();
}

function readText(file) {
  return readFileSync(file, "utf8");
}

function repoRelative(file) {
  return relative(repoRoot, file).replace(/\\/g, "/");
}

function assertNoPatterns(files, patterns) {
  const failures = files.flatMap((file) => {
    const text = readText(file);

    return patterns
      .filter(({ pattern }) => pattern.test(text))
      .map(({ label }) => `${repoRelative(file)} contains ${label}`);
  });

  expect(failures).toEqual([]);
}

describe("post-launch scaffolding teardown", () => {
  it("keeps launch-only proof scripts and workflows removed", () => {
    const removedPaths = [
      ".github/workflows/marketplace-launch-readiness-audit.yml",
      "scripts/marketplace-production-proof-readiness.mjs",
      "scripts/marketplace-production-proof-readiness.test.mjs",
      "deployables/marketplace/app/proof-access.server.ts",
    ];

    expect(removedPaths.filter((file) => existsSync(join(repoRoot, file)))).toEqual([]);

    const commandSurfaces = ["package.json", "scripts/ops.mjs"].map((file) => join(repoRoot, file));
    assertNoPatterns(commandSurfaces, [
      { label: "production proof readiness command", pattern: /marketplace:production-proof-readiness/ },
      { label: "production proof readiness script", pattern: /marketplace-production-proof-readiness/ },
    ]);
  });

  it("keeps live app, workflow, and Terraform surfaces free of production proof scaffolding", () => {
    const guardedFiles = [
      ...collectTextFiles(join(repoRoot, ".github", "workflows")),
      ...collectTextFiles(join(repoRoot, "deployables")),
      ...collectTextFiles(join(repoRoot, "bounded-contexts")),
      ...collectTextFiles(join(repoRoot, "contracts")),
      ...collectTextFiles(join(repoRoot, "packages")),
      ...collectTextFiles(join(repoRoot, "infrastructure", "digitalocean", "platform")),
    ].filter((file) => !/(\.test\.|__tests__)/.test(repoRelative(file)));

    assertNoPatterns(guardedFiles, [
      { label: "marketplace proof access helper", pattern: /\brequireMarketplaceProofAccess\b/ },
      { label: "marketplace proof access module", pattern: /proof-access\.server/ },
      { label: "marketplace proof access env var", pattern: /\bCHASE_SETS_MARKETPLACE_PROOF_ACCESS_/ },
      { label: "production proof GitHub variable", pattern: /\bPRODUCTION_MARKETPLACE_PROOF_(ENABLED|REFERENCE)\b/ },
      { label: "production proof Terraform variable", pattern: /\bproduction_marketplace_proof_(enabled|reference)\b/ },
      { label: "production proof Terraform check", pattern: /production_marketplace_proof/ },
      { label: "proof API ingress local", pattern: /\bproof_(api|admin_api|web)_ingress_routes\b/ },
      { label: "proof API route local", pattern: /\bproof_(api|admin_api|web)_route_/ },
      { label: "proof web enablement local", pattern: /\bproduction_proof_web_enabled\b/ },
      { label: "proof/public combined platform local", pattern: /\bmarketplace_platform_enabled\b/ },
      { label: "proof/public combined web local", pattern: /\bmarketplace_web_enabled\b/ },
      { label: "production proof freshness probe step", pattern: /Production proof-mode Buy Now freshness probe/ },
      {
        label: "production proof settlement probe artifact",
        pattern: /production-settlement-provider-health-probe\.json/,
      },
      { label: "production proof freshness probe artifact", pattern: /production-proof-buy-now-freshness-probe\.json/ },
    ]);
  });
});
