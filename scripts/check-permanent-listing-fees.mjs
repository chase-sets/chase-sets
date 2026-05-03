#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const checkedExtensions = new Set([".json", ".md", ".ts", ".tsx"]);
const skippedDirectories = new Set([
  ".git",
  ".react-router",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...await collectFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && checkedExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

const violations = [];

function toPascalCase(value) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const commercialTermsFiles = await collectFiles(
  path.join(root, "bounded-contexts", "commercial-terms"),
);
const commercialTermsForbidden = [
  "marketplace_checkout_fee_percentage_bps",
  "marketplace_checkout_fee_fixed_amount",
  "seller_marketplace_checkout_fee",
  "sellerMarketplaceCheckoutFee",
];

for (const filePath of commercialTermsFiles) {
  const contents = await readFile(filePath, "utf8");
  for (const pattern of commercialTermsForbidden) {
    if (contents.includes(pattern)) {
      violations.push({
        filePath,
        message: `Commercial Terms must not carry seller marketplace checkout fee field ${JSON.stringify(pattern)}.`,
      });
    }
  }
}

const orderingFiles = await collectFiles(path.join(root, "bounded-contexts", "ordering"));
const orderingForbidden = [
  "@chase-sets/commercial-terms",
  "commercialTermsResolver",
  "createCommercialTermsResolver",
  "resolveListingTerms",
  "resolveOrderTerms",
];

for (const filePath of orderingFiles) {
  const contents = await readFile(filePath, "utf8");
  for (const pattern of orderingForbidden) {
    if (contents.includes(pattern)) {
      violations.push({
        filePath,
        message: `Ordering must consume Marketplace sales fee snapshots instead of Commercial Terms dependency ${JSON.stringify(pattern)}.`,
      });
    }
  }
}

const contextRoot = path.join(root, "bounded-contexts");
const contextEntries = await readdir(contextRoot, { withFileTypes: true });
const contexts = [];

for (const entry of contextEntries) {
  if (!entry.isDirectory()) {
    continue;
  }

  const contextJsonPath = path.join(contextRoot, entry.name, "context.json");
  const manifest = JSON.parse(await readFile(contextJsonPath, "utf8"));
  contexts.push({
    directoryName: entry.name,
    contextName: String(manifest.contextName ?? entry.name),
    packageName: String(manifest.packageName ?? ""),
    declaresCommercialTermsResolver: Array.isArray(manifest.hostPorts)
      ? manifest.hostPorts.some((port) => port?.portName === "commercialTermsResolver")
      : false,
  });
}

const commercialTermsResolverConsumers = contexts
  .filter((context) => context.declaresCommercialTermsResolver)
  .map((context) => context.contextName);

if (!commercialTermsResolverConsumers.includes("marketplace")) {
  violations.push({
    filePath: path.join(contextRoot, "marketplace", "context.json"),
    message: "Marketplace must declare the commercialTermsResolver host port before receiving fee policy wiring.",
  });
}

const nonCommercialTermsResolverConsumers = contexts.filter(
  (context) =>
    !context.declaresCommercialTermsResolver &&
    context.contextName !== "commercial-terms",
);
const deployableFiles = await collectFiles(path.join(root, "deployables"));

for (const filePath of deployableFiles) {
  const contents = await readFile(filePath, "utf8");
  if (!contents.includes("commercialTermsResolver")) {
    continue;
  }

  const lines = contents.split(/\r?\n/g);
  lines.forEach((line, index) => {
    if (!line.includes("commercialTermsResolver")) {
      return;
    }

    const window = lines
      .slice(Math.max(0, index - 6), Math.min(lines.length, index + 7))
      .join("\n");

    for (const context of nonCommercialTermsResolverConsumers) {
      const pascalName = toPascalCase(context.contextName);
      const patterns = [
        new RegExp(`\\bcreate${pascalName}(Runtime|Services|Api)?\\b`, "i"),
      ];

      if (patterns.some((pattern) => pattern.test(window))) {
        violations.push({
          filePath,
          message: `Deployable wiring appears to pass commercialTermsResolver near ${context.contextName}, but that context does not declare the host port.`,
        });
      }
    }
  });
}

const docsToRequire = [
  path.join(root, "docs", "PERMANENT-LISTING-FEES.md"),
  path.join(root, "docs", "api", "marketplace-api.md"),
  path.join(root, "docs", "api", "marketplace.openapi.json"),
];

for (const filePath of docsToRequire) {
  const contents = await readFile(filePath, "utf8");
  for (const pattern of ["fee_quote_stale", "feeQuoteFingerprint"]) {
    if (!contents.includes(pattern)) {
      violations.push({
        filePath,
        message: `Permanent listing fee docs must include ${JSON.stringify(pattern)}.`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("Permanent listing fee guard failed.");
  for (const violation of violations) {
    console.error(`- ${path.relative(root, violation.filePath)}: ${violation.message}`);
  }
  process.exit(1);
}

console.log("Permanent listing fee guard passed.");
