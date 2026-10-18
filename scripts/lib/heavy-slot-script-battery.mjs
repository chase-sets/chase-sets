import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHeavySlot, acquireVitestHeavySlot } from "./heavy-slot.mjs";

export const heavySlotScriptBatteryGlobalSetupPath = fileURLToPath(import.meta.url);
export const inheritedOwnerScriptTests = Object.freeze([
  "scripts/verify-ci-local.test.mjs",
  "scripts/managed-postgres-authority-guard.test.mjs",
  "scripts/managed-postgres-authority-sources.test.mjs",
  "scripts/typescript-resolver-caller-parity.test.mjs",
]);

const explicitTestFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function isInheritedOwnerScriptTest(filter, root) {
  const withoutLine = filter.replace(/:\d+$/, "");
  if (!explicitTestFilePattern.test(withoutLine)) return false;
  const candidate = path.isAbsolute(withoutLine) ? withoutLine : path.resolve(root, withoutLine);
  if (!existsSync(candidate)) return false;
  return inheritedOwnerScriptTests.some((relativePath) => path.resolve(root, relativePath) === candidate);
}

export default function setupScriptBatteryHeavySlot(project, options = {}) {
  const filters = project?.vitest?.filenamePattern;
  const root = project?.config?.root;
  if (
    Array.isArray(filters) &&
    typeof root === "string" &&
    filters.some((filter) => typeof filter === "string" && isInheritedOwnerScriptTest(filter, root))
  ) {
    acquireHeavySlot("script-battery", options);
    return;
  }
  acquireVitestHeavySlot(project, "script-battery", options);
}
