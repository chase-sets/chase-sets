/**
 * Admissible Call Inputs are the three values accepted before any filesystem
 * operation. The Ordered Syntax Rule Table gives every invalid path one stable
 * first-match identity. A Guarded Seam Read captures the optional filesystem
 * capability once so later code never has to read the caller's record again.
 */
const ADMISSION_PATH_SYNTAX_VERSION = "admission-path-syntax/v1";

export const ADMISSION_PATH_SYNTAX_OUTCOMES = Object.freeze([
  "accepted",
  "input-not-a-string",
  "path-syntax-invalid",
  "options-invalid",
]);

export const ADMISSION_PATH_SYNTAX_RULE_ORDER = Object.freeze([
  "length",
  "empty-segment",
  "segment-charset",
  "dot-segment",
  "dots-only-segment",
  "reserved-device-stem",
  "trailing-dot-segment",
]);

const SEGMENT_CHARACTERS = /^[A-Za-z0-9._-]+$/;
const DOTS_ONLY = /^\.+$/;
const RESERVED_DEVICE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const syntaxRulePredicates = Object.freeze({
  length: (relativePath) => relativePath.length < 1 || relativePath.length > 300,
  "empty-segment": (_relativePath, segments) => segments.some((segment) => segment.length === 0),
  "segment-charset": (_relativePath, segments) =>
    segments.some((segment) => segment.length > 0 && !SEGMENT_CHARACTERS.test(segment)),
  "dot-segment": (_relativePath, segments) => segments.some((segment) => segment === "." || segment === ".."),
  "dots-only-segment": (_relativePath, segments) =>
    segments.some((segment) => segment.length > 0 && DOTS_ONLY.test(segment)),
  "reserved-device-stem": (_relativePath, segments) =>
    segments.some((segment) => RESERVED_DEVICE_STEM.test(segment.split(".", 1)[0])),
  "trailing-dot-segment": (_relativePath, segments) =>
    segments.some((segment) => segment.length > 0 && segment.endsWith(".")),
});

function inputNotAString() {
  return Object.freeze({
    version: ADMISSION_PATH_SYNTAX_VERSION,
    outcome: "input-not-a-string",
  });
}

function optionsInvalid() {
  return Object.freeze({
    version: ADMISSION_PATH_SYNTAX_VERSION,
    outcome: "options-invalid",
  });
}

function pathSyntaxInvalid(rule) {
  return Object.freeze({
    version: ADMISSION_PATH_SYNTAX_VERSION,
    outcome: "path-syntax-invalid",
    rule,
  });
}

function accepted(segments, filesystem) {
  return Object.freeze({
    version: ADMISSION_PATH_SYNTAX_VERSION,
    outcome: "accepted",
    segments: Object.freeze(segments),
    filesystem,
  });
}

function isNonArrayObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function captureFilesystem(options) {
  if (options === undefined || options === null) {
    return { accepted: true, filesystem: null };
  }
  if (!isNonArrayObject(options)) {
    return { accepted: false, filesystem: null };
  }

  let filesystem;
  try {
    Reflect.has(options, "filesystem");
    filesystem = Reflect.get(options, "filesystem");
  } catch {
    return { accepted: false, filesystem: null };
  }

  if (filesystem === undefined) {
    return { accepted: true, filesystem: null };
  }
  if (!isNonArrayObject(filesystem)) {
    return { accepted: false, filesystem: null };
  }

  try {
    if (typeof Reflect.get(filesystem, "lstat") !== "function") {
      return { accepted: false, filesystem: null };
    }
    if (typeof Reflect.get(filesystem, "realpath") !== "function") {
      return { accepted: false, filesystem: null };
    }
  } catch {
    return { accepted: false, filesystem: null };
  }

  return { accepted: true, filesystem };
}

function firstMatchingRule(relativePath, segments) {
  for (const rule of ADMISSION_PATH_SYNTAX_RULE_ORDER) {
    const predicate = syntaxRulePredicates[rule];
    if (typeof predicate !== "function" || predicate(relativePath, segments)) {
      return rule;
    }
  }
  return null;
}

export function validateCallInputs(baseDirectory, relativePath, options) {
  if (typeof baseDirectory !== "string") {
    return inputNotAString();
  }
  if (typeof relativePath !== "string") {
    return inputNotAString();
  }

  const captured = captureFilesystem(options);
  if (!captured.accepted) {
    return optionsInvalid();
  }

  const segments = relativePath.split("/");
  const rule = firstMatchingRule(relativePath, segments);
  if (rule !== null) {
    return pathSyntaxInvalid(rule);
  }

  return accepted(segments, captured.filesystem);
}
