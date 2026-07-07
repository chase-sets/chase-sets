import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultCheckedPaths = [
  "contracts/localization/locales/en.ts",
  "contracts/localization/locales/en",
  "bounded-contexts",
  "deployables/marketplace/app",
];

const localizationOnlyPatterns = [
  {
    label: "purchase-intent copy",
    pattern: /\bpurchase intent\b/i,
    guidance: "Use offer language in buyer-facing copy.",
  },
  {
    label: "cart-intent copy",
    pattern: /\bcart intent\b/i,
    guidance: "Use Buy Cart language in buyer-facing copy.",
  },
  {
    label: "qualified-hold copy",
    pattern: /\bqualified holds?\b/i,
    guidance: "Use the qualified owning term or a customer-safe status.",
  },
  {
    label: "on-hold sale review copy",
    pattern: /\bon hold\b/i,
    guidance: "Use customer-safe review or support-review language.",
  },
];

const publicBoundaryPatterns = [
  {
    label: "anonymous rail rate-limit code",
    pattern: /\banonymous_rail_rate_limited\b/,
    guidance: "Use anonymous_request_rate_limited for public API errors.",
  },
  {
    label: "anonymous rail locale key",
    pattern: /\banonymous\.rail\.rate\.limited\b/,
    guidance: "Use anonymous.request.rate.limited for user-facing locale keys.",
  },
];

export function findBuyerSellerJargonViolations({ rootDir = process.cwd(), files } = {}) {
  const candidates = files ?? listCandidateFiles(rootDir);
  const violations = [];

  for (const relativeFile of candidates) {
    const absoluteFile = path.join(rootDir, relativeFile);
    if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
      continue;
    }

    const text = fs.readFileSync(absoluteFile, "utf8");
    const patterns = isEnglishLocalizationFile(relativeFile)
      ? [...localizationOnlyPatterns, ...publicBoundaryPatterns]
      : publicBoundaryPatterns;

    for (const rule of patterns) {
      for (const match of text.matchAll(
        new RegExp(
          rule.pattern.source,
          rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
        ),
      )) {
        const { line, column } = lineColumnFor(text, match.index ?? 0);
        violations.push(`${relativeFile}:${line}:${column} ${rule.label}: ${rule.guidance}`);
      }
    }
  }

  return violations;
}

function listCandidateFiles(rootDir) {
  const gitFiles = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  return gitFiles.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return defaultCheckedPaths.some(
      (checkedPath) => normalized === checkedPath || normalized.startsWith(`${checkedPath}/`),
    );
  });
}

function isEnglishLocalizationFile(relativeFile) {
  const normalized = relativeFile.replaceAll("\\", "/");
  return (
    normalized === "contracts/localization/locales/en.ts" || normalized.startsWith("contracts/localization/locales/en/")
  );
}

function lineColumnFor(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = findBuyerSellerJargonViolations();

  if (violations.length > 0) {
    console.error("Buyer/seller jargon check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Buyer/seller jargon check passed.");
}
