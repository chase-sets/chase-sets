import fsPromises from "node:fs/promises";
import path from "node:path";
import { validateCallInputs } from "./admission-path-syntax.mjs";
import {
  COVERED_OBJECT_CLASS_MATRIX,
  OBJECT_CLASSES_OUTSIDE_GUARANTEE,
  classifyStatedObject,
} from "./admission-object-class.mjs";

/**
 * admission-contained-path/v1 is the Contained Path Outcome authority for
 * Canonical Containment, Reparse Traversal, and Both-Sided Canonicalization.
 *
 * The base is assumed to be a lane-owned, single-writer tree. This decision
 * answers stable filesystem indirection for the object classes covered by the
 * delegated classifier. It does not answer a privileged concurrent adversary,
 * grant read authority, return a handle, or make any coverage claim for a
 * class that the classifier publishes outside its guarantee.
 *
 * escapes-base is defense in depth. No supported real construct at this base
 * independently reaches it after the component classifier accepts every
 * prefix; its only portable control is explicitly synthetic.
 */

export const ADMISSION_CONTAINED_PATH_VERSION = "admission-contained-path/v1";

export const ADMISSION_CONTAINED_PATH_OUTCOMES = Object.freeze([
  "contained",
  "input-not-a-string",
  "path-syntax-invalid",
  "options-invalid",
  "reparse-point-in-path",
  "component-not-a-directory",
  "target-not-a-regular-file",
  "target-multiply-linked",
  "base-unresolvable",
  "target-absent",
  "escapes-base",
  "filesystem-unavailable",
]);

export { COVERED_OBJECT_CLASS_MATRIX, OBJECT_CLASSES_OUTSIDE_GUARANTEE };

function frozenRecord(outcome, additionalMembers = {}) {
  return Object.freeze({
    version: ADMISSION_CONTAINED_PATH_VERSION,
    outcome,
    ...additionalMembers,
  });
}

function syntaxRefusal(validation) {
  return frozenRecord(
    validation.outcome,
    validation.outcome === "path-syntax-invalid" ? { rule: validation.rule } : {},
  );
}

function componentRefusal(outcome, componentIndex) {
  return frozenRecord(outcome, { componentIndex });
}

function readErrorCode(error) {
  try {
    return Reflect.get(Object(error), "code");
  } catch {
    return undefined;
  }
}

function mapComponentError(error, componentIndex) {
  const code = readErrorCode(error);
  if (code === "ENOENT") return componentRefusal("target-absent", componentIndex);
  if (code === "ENOTDIR") return componentRefusal("component-not-a-directory", componentIndex);
  return componentRefusal("filesystem-unavailable", componentIndex);
}

async function callFilesystem(filesystem, method, args) {
  const operation = Reflect.get(filesystem, method);
  return Reflect.apply(operation, filesystem, args);
}

function isAbsoluteString(value) {
  return typeof value === "string" && path.isAbsolute(value);
}

function isContained(canonicalBase, canonicalCandidate) {
  const relative = path.relative(canonicalBase, canonicalCandidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readBigintIdentity(stats) {
  try {
    const device = Reflect.get(stats, "dev");
    const index = Reflect.get(stats, "ino");
    if (typeof device !== "bigint" || typeof index !== "bigint" || device < 0n || index < 0n) return null;
    return Object.freeze({ device: device.toString(10), index: index.toString(10) });
  } catch {
    return null;
  }
}

export async function resolveContainedPath(baseDirectory, relativePath, options) {
  const validation = validateCallInputs(baseDirectory, relativePath, options);
  if (validation.outcome !== "accepted") return syntaxRefusal(validation);

  const filesystem = validation.filesystem ?? fsPromises;
  let canonicalBase;
  try {
    canonicalBase = await callFilesystem(filesystem, "realpath", [baseDirectory]);
    if (!isAbsoluteString(canonicalBase)) return frozenRecord("base-unresolvable");
  } catch {
    return frozenRecord("base-unresolvable");
  }

  let candidatePath;
  try {
    candidatePath = path.resolve(baseDirectory, ...validation.segments);
  } catch {
    return frozenRecord("base-unresolvable");
  }

  let finalStats;
  for (let componentIndex = 0; componentIndex < validation.segments.length; componentIndex += 1) {
    const componentPath = path.resolve(baseDirectory, ...validation.segments.slice(0, componentIndex + 1));
    let stats;
    try {
      stats = await callFilesystem(filesystem, "lstat", [componentPath, { bigint: true }]);
    } catch (error) {
      return mapComponentError(error, componentIndex);
    }

    const position = componentIndex === validation.segments.length - 1 ? "final" : "intermediate";
    const classification = classifyStatedObject(stats, position);
    if (classification.classification !== "admissible") {
      return componentRefusal(classification.classification, componentIndex);
    }
    if (position === "final") finalStats = stats;
  }

  const objectIdentity = readBigintIdentity(finalStats);
  if (objectIdentity === null) {
    return componentRefusal("filesystem-unavailable", validation.segments.length - 1);
  }

  let canonicalPath;
  try {
    canonicalPath = await callFilesystem(filesystem, "realpath", [candidatePath]);
    if (!isAbsoluteString(canonicalPath)) return frozenRecord("filesystem-unavailable");
    if (!isContained(canonicalBase, canonicalPath)) return frozenRecord("escapes-base");
  } catch {
    return frozenRecord("filesystem-unavailable");
  }

  return frozenRecord("contained", { canonicalPath, objectIdentity });
}
