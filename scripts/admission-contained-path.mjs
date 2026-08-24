import fsPromises from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { validateCallInputs } from "./admission-path-syntax.mjs";
import {
  COVERED_OBJECT_CLASS_MATRIX,
  OBJECT_CLASSES_OUTSIDE_GUARANTEE,
  classifyStatedObject,
} from "./admission-object-class.mjs";

/**
 * admission-contained-path/v1 is the Contained Path Outcome and Bound Read
 * Authority for Canonical Containment, Reparse Traversal, Both-Sided
 * Canonicalization, Admitted Object Identity, and Identity-Verified Open.
 *
 * The base is assumed to be a lane-owned, single-writer tree. This decision
 * answers stable filesystem indirection for the object classes covered by the
 * delegated classifier. A replacement occurring anyway is never read as if it
 * were contained: a bound read either yields bytes from the object the
 * decision admitted, or refuses. It does not answer a privileged concurrent
 * adversary or make any coverage claim for a class that the classifier
 * publishes outside its guarantee.
 *
 * A residual window remains between the decision's final stat and the open.
 * Node exposes no cross-platform component-relative open with which to remove
 * that window. Identity verification converts a replacement in that window
 * into a refusal; it does not prevent concurrent modification. On success,
 * openContainedFile transfers its open handle to the caller, which owns and
 * closes it. readContainedFile reads only through that verified handle and
 * closes it before returning, including after every post-open refusal.
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
  "target-identity-changed",
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

const containedDecisionMetadata = new WeakMap();
const boundHandleMetadata = new WeakMap();

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

  const decision = frozenRecord("contained", { canonicalPath, objectIdentity });
  containedDecisionMetadata.set(
    decision,
    Object.freeze({ filesystem, finalComponentIndex: validation.segments.length - 1 }),
  );
  return decision;
}

async function closeIgnoringFailure(handle) {
  try {
    await callFilesystem(handle, "close", []);
  } catch {
    // Closing is best-effort after the call's outcome is already determined.
  }
}

function verifyOpenedIdentity(stats, admittedIdentity) {
  const classification = classifyStatedObject(stats, "final");
  if (classification.classification === "filesystem-unavailable") return null;

  const openedIdentity = readBigintIdentity(stats);
  if (openedIdentity === null) return null;
  return (
    classification.classification === "admissible" &&
    openedIdentity.device === admittedIdentity.device &&
    openedIdentity.index === admittedIdentity.index
  );
}

export async function openContainedFile(baseDirectory, relativePath, options) {
  const decision = await resolveContainedPath(baseDirectory, relativePath, options);
  if (decision.outcome !== "contained") return decision;

  const metadata = containedDecisionMetadata.get(decision);
  if (metadata === undefined) return frozenRecord("filesystem-unavailable");

  let handle;
  try {
    handle = await callFilesystem(metadata.filesystem, "open", [decision.canonicalPath, "r"]);
  } catch {
    return componentRefusal("filesystem-unavailable", metadata.finalComponentIndex);
  }

  let verification;
  try {
    const stats = await callFilesystem(handle, "stat", [{ bigint: true }]);
    verification = verifyOpenedIdentity(stats, decision.objectIdentity);
  } catch {
    await closeIgnoringFailure(handle);
    return componentRefusal("filesystem-unavailable", metadata.finalComponentIndex);
  }

  if (verification === null) {
    await closeIgnoringFailure(handle);
    return componentRefusal("filesystem-unavailable", metadata.finalComponentIndex);
  }
  if (!verification) {
    await closeIgnoringFailure(handle);
    return componentRefusal("target-identity-changed", metadata.finalComponentIndex);
  }

  const result = frozenRecord("contained", {
    canonicalPath: decision.canonicalPath,
    objectIdentity: decision.objectIdentity,
    handle,
  });
  boundHandleMetadata.set(result, metadata);
  return result;
}

export async function readContainedFile(baseDirectory, relativePath, options) {
  const opened = await openContainedFile(baseDirectory, relativePath, options);
  if (opened.outcome !== "contained") return opened;

  const metadata = boundHandleMetadata.get(opened);
  let bytes;
  try {
    bytes = await callFilesystem(opened.handle, "readFile", []);
  } catch {
    await closeIgnoringFailure(opened.handle);
    return metadata === undefined
      ? frozenRecord("filesystem-unavailable")
      : componentRefusal("filesystem-unavailable", metadata.finalComponentIndex);
  }

  await closeIgnoringFailure(opened.handle);
  if (!Buffer.isBuffer(bytes)) {
    return metadata === undefined
      ? frozenRecord("filesystem-unavailable")
      : componentRefusal("filesystem-unavailable", metadata.finalComponentIndex);
  }
  return frozenRecord("contained", {
    canonicalPath: opened.canonicalPath,
    objectIdentity: opened.objectIdentity,
    bytes,
  });
}
