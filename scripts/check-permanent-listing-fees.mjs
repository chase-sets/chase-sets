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

const commercialTermsFiles = await collectFiles(
  path.join(root, "bounded-contexts", "commercial-terms"),
);
const commercialTermsForbidden = [
  "payment_fee_percentage_bps",
  "payment_fee_fixed_amount",
  "seller_payment_fee",
  "sellerPaymentFee",
];

for (const filePath of commercialTermsFiles) {
  const contents = await readFile(filePath, "utf8");
  for (const pattern of commercialTermsForbidden) {
    if (contents.includes(pattern)) {
      violations.push({
        filePath,
        message: `Commercial Terms must not carry seller payment fee field ${JSON.stringify(pattern)}.`,
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
        message: `Ordering must consume Marketplace fee snapshots instead of Commercial Terms dependency ${JSON.stringify(pattern)}.`,
      });
    }
  }
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
