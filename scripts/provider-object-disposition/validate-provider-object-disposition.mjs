import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeResultDigest } from "./canonicalize-provider-object-disposition.mjs";

// This schema is bound to the Option B six-class disposition model. The six
// class rows live only in the fixture — "no local duplicate table" is a
// contract invariant — this module reads them, it never redeclares them.
const FIXTURE_PATH = fileURLToPath(new URL("./provider-object-disposition-option-b.fixture.json", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

export const OPTION_B_CLASS_TABLE = Object.freeze(FIXTURE.classTable.map((row) => Object.freeze({ ...row })));
export const CLASS_ORDER = Object.freeze(OPTION_B_CLASS_TABLE.map((row) => row.class));
export const SCENARIO_FIXTURES = FIXTURE.scenarios;

export const REFUSAL_CODES = new Set([
  "invalid-input",
  "production-environment",
  "authority-unavailable",
  "journal-unavailable",
]);

export const FAILURE_CODES = new Set([
  "transport-failure",
  "provider-rejected",
  "provider-response-invalid",
  "correlation-discrepancy",
  "enumeration-incomplete",
  "budget-exceeded",
  "cleanup-incomplete",
]);

export const DEPLOYMENT_ENVIRONMENTS = new Set(["dev", "test", "staging"]);
export const CORRELATION_SOURCES = new Set([
  "creation-time-record",
  "creation-time-record-plus-provider-cross-check",
  "not-applicable",
]);

const COMMON_REQUIRED_KEYS = Object.freeze([
  "version",
  "variant",
  "emittedBy",
  "startedAt",
  "finishedAt",
  "deploymentEnvironment",
  "providerMode",
  "windowId",
  "classes",
  "resultDigest",
]);

const VARIANT_KEY_RULES = Object.freeze({
  success: { required: [], forbidden: ["refusal", "failure", "lastCompletedPrecedenceOrdinal"] },
  "pre-network-refusal": { required: ["refusal"], forbidden: ["failure", "lastCompletedPrecedenceOrdinal"] },
  "post-network-failure": { required: ["failure", "lastCompletedPrecedenceOrdinal"], forbidden: ["refusal"] },
  "cleanup-failure": { required: ["failure"], forbidden: ["refusal", "lastCompletedPrecedenceOrdinal"] },
});

const CLASS_ENTRY_REQUIRED_KEYS = Object.freeze([
  "class",
  "state",
  "declaredBudget",
  "budgetScope",
  "observedCount",
  "enumerationComplete",
  "correlationSource",
  "precedenceOrdinal",
  "dispositionStartedAt",
  "dispositionCompletedAt",
]);

// Account Session residue authority is creation-time only. Pointer:
// infrastructure/stripe-connect/index.ts:907 creates the object; no
// list/cancel surface exists to cross-check it against later.
export const ACCOUNT_SESSION_CLASS = "stripe-account-session";
export const ACCOUNT_SESSION_AUTHORITY_POINTER = "infrastructure/stripe-connect/index.ts:907";

// providerMode is a closed const, never inferred. It is derived from an
// authoritative Stripe test-mode observation, never from
// deploymentEnvironment, key text, or a caller assertion.
export const PROVIDER_MODE_AUTHORITY_NOTE =
  'providerMode must be the literal value "test"; it is derived from #6726/#6734 authoritative ' +
  "Stripe observation and must never be inferred from deploymentEnvironment, key text, or caller assertion.";

const PROVIDER_ID_PATTERN = /\b(?:pi|seti|cs|cus|acct)_[A-Za-z0-9]+/;
const DIAGNOSTIC_PATTERN = /(client_secret|exception|stack trace|traceback|bearer\s+sk_|error:)/i;

export function containsForbiddenProviderMarker(text) {
  if (typeof text !== "string") return false;
  return PROVIDER_ID_PATTERN.test(text) || DIAGNOSTIC_PATTERN.test(text);
}

function scanForForbiddenMarkers(value, path, errors) {
  if (typeof value === "string") {
    if (containsForbiddenProviderMarker(value)) {
      errors.push({ code: "FORBIDDEN_PROVIDER_MARKER", path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForForbiddenMarkers(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanForForbiddenMarkers(entry, `${path}.${key}`, errors);
    }
  }
}

// --- Raw-byte parsing: BOM, trailing newline, and duplicate keys are all
// detected from the literal bytes, ahead of/alongside a hand-rolled parse
// that never lets a duplicate key silently overwrite (JSON.parse is
// last-wins and cannot be used here). ---

export class DuplicateKeyOrMalformedJsonError extends Error {
  constructor(message, position) {
    super(message);
    this.name = "DuplicateKeyOrMalformedJsonError";
    this.position = position;
  }
}

export function parseJsonNoDuplicateKeys(text) {
  let i = 0;
  const n = text.length;

  const fail = (message) => {
    throw new DuplicateKeyOrMalformedJsonError(message, i);
  };

  const skipWhitespace = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };

  const parseLiteral = (literal, value) => {
    if (text.slice(i, i + literal.length) !== literal) fail(`expected literal ${literal}`);
    i += literal.length;
    return value;
  };

  const parseString = () => {
    i++; // opening quote
    let result = "";
    while (true) {
      if (i >= n) fail("unterminated string");
      const ch = text[i];
      if (ch === '"') {
        i++;
        break;
      }
      if (ch === "\\") {
        i++;
        const esc = text[i];
        if (esc === '"') result += '"';
        else if (esc === "\\") result += "\\";
        else if (esc === "/") result += "/";
        else if (esc === "b") result += "\b";
        else if (esc === "f") result += "\f";
        else if (esc === "n") result += "\n";
        else if (esc === "r") result += "\r";
        else if (esc === "t") result += "\t";
        else if (esc === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid unicode escape");
          result += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail(`invalid escape \\${esc}`);
        i++;
      } else {
        // RFC 8259: control characters (U+0000-U+001F) are illegal unescaped inside a JSON string.
        if (ch.charCodeAt(0) <= 0x1f) fail("unescaped control character in string");
        result += ch;
        i++;
      }
    }
    return result;
  };

  const parseNumber = () => {
    const start = i;
    if (text[i] === "-") i++;
    if (!(text[i] >= "0" && text[i] <= "9")) fail("invalid number");
    // RFC 8259: no leading zeros — "0" and "0.5" are legal, "007" is not.
    if (text[i] === "0" && text[i + 1] >= "0" && text[i + 1] <= "9") fail("leading zero not permitted");
    while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === ".") {
      i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    return Number(text.slice(start, i));
  };

  const parseObject = () => {
    i++; // {
    // Null-prototype target with an own-property definition per key: a
    // "__proto__" key must become an ordinary own key, not invoke the
    // inherited Object.prototype accessor via `result[key] = value`, which
    // would silently vanish the key from every downstream Object.keys/
    // Object.entries closure check.
    const result = Object.create(null);
    const seenKeys = new Set();
    skipWhitespace();
    if (text[i] === "}") {
      i++;
      return result;
    }
    while (true) {
      skipWhitespace();
      if (text[i] !== '"') fail("expected string key");
      const key = parseString();
      if (seenKeys.has(key)) fail(`duplicate key "${key}"`);
      seenKeys.add(key);
      skipWhitespace();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      const value = parseValue();
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      fail("expected ',' or '}'");
    }
    return result;
  };

  const parseArray = () => {
    i++; // [
    const result = [];
    skipWhitespace();
    if (text[i] === "]") {
      i++;
      return result;
    }
    while (true) {
      result.push(parseValue());
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        break;
      }
      fail("expected ',' or ']'");
    }
    return result;
  };

  function parseValue() {
    skipWhitespace();
    const ch = text[i];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "t") return parseLiteral("true", true);
    if (ch === "f") return parseLiteral("false", false);
    if (ch === "n") return parseLiteral("null", null);
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    fail(`unexpected character '${ch}'`);
    return undefined;
  }

  skipWhitespace();
  const value = parseValue();
  skipWhitespace();
  if (i !== n) fail("unexpected trailing content");
  return value;
}

export function parseRawDocumentBytes(buffer) {
  const errors = [];
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  if (hasBom) errors.push({ code: "BOM_PRESENT", path: "$" });
  const bytesForParsing = hasBom ? buffer.subarray(3) : buffer;
  const text = bytesForParsing.toString("utf8");
  if (text.endsWith("\n") || text.endsWith("\r")) {
    errors.push({ code: "TRAILING_NEWLINE", path: "$" });
  }
  let value;
  try {
    value = parseJsonNoDuplicateKeys(text);
  } catch (error) {
    errors.push({ code: "MALFORMED_JSON_OR_DUPLICATE_KEY", path: "$", message: error.message });
    return { ok: false, errors, value: undefined };
  }
  return { ok: errors.length === 0, errors, value };
}

// --- Strict RFC 3339 instant parsing (mandatory offset, real calendar
// validity — unlike `Date.parse`, which silently rolls over e.g. Feb 30). ---

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function parseStrictRfc3339(value) {
  if (typeof value !== "string") return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fractionStr, offsetStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  if (month < 1 || month > 12) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;
  let offsetMinutes = 0;
  if (offsetStr !== "Z") {
    const offsetHour = Number(offsetStr.slice(1, 3));
    const offsetMinute = Number(offsetStr.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetStr[0] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  const fraction = fractionStr ? Number(`0.${fractionStr}`) : 0;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) + fraction * 1000 - offsetMinutes * 60000;
  return { ok: true, ms };
}

function checkNestedInstantBounds(instantString, document, path, errors) {
  const instant = parseStrictRfc3339(instantString);
  const windowStart = parseStrictRfc3339(document.startedAt);
  const windowEnd = parseStrictRfc3339(document.finishedAt);
  if (!instant || !windowStart || !windowEnd) return;
  if (instant.ms < windowStart.ms || instant.ms > windowEnd.ms) {
    errors.push({ code: "NESTED_INSTANT_OUT_OF_WINDOW", path });
  }
}

function decidedCorrelationSourcesFor(className) {
  return className === ACCOUNT_SESSION_CLASS
    ? new Set(["creation-time-record"])
    : new Set(["creation-time-record", "creation-time-record-plus-provider-cross-check"]);
}

function validateClassEntry(entry, index, row, document, errors) {
  const path = `$.classes[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push({ code: "CLASS_ENTRY_NOT_OBJECT", path, class: row.class });
    return;
  }

  let keyShapeOk = true;
  for (const key of CLASS_ENTRY_REQUIRED_KEYS) {
    if (!(key in entry)) {
      errors.push({ code: "CLASS_ENTRY_KEY_MISSING", path: `${path}.${key}`, class: row.class });
      keyShapeOk = false;
    }
  }
  for (const key of Object.keys(entry)) {
    if (!CLASS_ENTRY_REQUIRED_KEYS.includes(key)) {
      errors.push({ code: "CLASS_ENTRY_KEY_UNKNOWN", path: `${path}.${key}`, class: row.class });
      keyShapeOk = false;
    }
  }
  if (!keyShapeOk) return;

  if (entry.class !== row.class) {
    errors.push({ code: "CLASS_IDENTITY_MISMATCH", path: `${path}.class`, class: row.class });
  }
  if (entry.declaredBudget !== row.declaredBudget) {
    errors.push({ code: "B4_BUDGET_TABLE_OVERRIDE", path: `${path}.declaredBudget`, class: row.class });
  }
  if (entry.budgetScope !== row.budgetScope) {
    errors.push({ code: "B4_BUDGET_SCOPE_OVERRIDE", path: `${path}.budgetScope`, class: row.class });
  }
  if (entry.precedenceOrdinal !== row.precedenceOrdinal) {
    errors.push({ code: "B4_PRECEDENCE_TABLE_OVERRIDE", path: `${path}.precedenceOrdinal`, class: row.class });
  }

  const permittedStates = new Set(["unknown", "not-attempted", ...row.permittedStates]);
  if (typeof entry.state !== "string" || !permittedStates.has(entry.state)) {
    errors.push({ code: "STATE_NOT_PERMITTED_FOR_CLASS", path: `${path}.state`, class: row.class });
    return;
  }

  const decidedCorrelationSources = decidedCorrelationSourcesFor(row.class);
  const check = (condition, code) => {
    if (!condition) errors.push({ code, path, class: row.class });
  };

  if (entry.state === "not-attempted") {
    check(entry.observedCount === null, "NOT_ATTEMPTED_COUNT_NOT_NULL");
    check(entry.enumerationComplete === false, "NOT_ATTEMPTED_ENUMERATION_NOT_FALSE");
    check(entry.correlationSource === "not-applicable", "NOT_ATTEMPTED_CORRELATION_NOT_APPLICABLE");
    check(entry.dispositionStartedAt === null, "NOT_ATTEMPTED_START_NOT_NULL");
    check(entry.dispositionCompletedAt === null, "NOT_ATTEMPTED_COMPLETED_NOT_NULL");
    return;
  }

  if (entry.state === "unknown") {
    check(entry.observedCount === null, "UNKNOWN_COUNT_NOT_NULL");
    check(entry.enumerationComplete === false, "UNKNOWN_ENUMERATION_NOT_FALSE");
    check(entry.dispositionCompletedAt === null, "UNKNOWN_COMPLETED_NOT_NULL");
    if (entry.dispositionStartedAt === null) {
      check(entry.correlationSource === "not-applicable", "UNKNOWN_PRECALL_CORRELATION_INVALID");
    } else {
      check(decidedCorrelationSources.has(entry.correlationSource), "UNKNOWN_ATTEMPTED_CORRELATION_INVALID");
      const started = parseStrictRfc3339(entry.dispositionStartedAt);
      check(started !== null, "DISPOSITION_STARTED_AT_INVALID");
      if (started)
        checkNestedInstantBounds(entry.dispositionStartedAt, document, `${path}.dispositionStartedAt`, errors);
    }
    return;
  }

  if (entry.state === "not-created") {
    check(entry.observedCount === 0, "NOT_CREATED_COUNT_NOT_ZERO");
    check(entry.enumerationComplete === true, "NOT_CREATED_ENUMERATION_NOT_TRUE");
    check(decidedCorrelationSources.has(entry.correlationSource), "NOT_CREATED_CORRELATION_INVALID");
    check(entry.dispositionStartedAt === null, "NOT_CREATED_START_NOT_NULL");
    check(entry.dispositionCompletedAt === null, "NOT_CREATED_COMPLETED_NOT_NULL");
    return;
  }

  // Remaining decided states: budgeted-residue, remedy-requested, cancelled,
  // already-terminal, disposition-failed, retained-reused.
  check(
    Number.isInteger(entry.observedCount) && entry.observedCount >= 0 && entry.observedCount <= 10000,
    "DECIDED_COUNT_OUT_OF_RANGE",
  );
  check(entry.enumerationComplete === true, "DECIDED_ENUMERATION_NOT_TRUE");
  check(decidedCorrelationSources.has(entry.correlationSource), "DECIDED_CORRELATION_INVALID");
  const started = parseStrictRfc3339(entry.dispositionStartedAt);
  check(started !== null, "DISPOSITION_STARTED_AT_INVALID");
  const completed = parseStrictRfc3339(entry.dispositionCompletedAt);
  check(completed !== null, "DISPOSITION_COMPLETED_AT_INVALID");
  if (started && completed) {
    check(completed.ms >= started.ms, "DISPOSITION_COMPLETED_BEFORE_START");
  }
  if (started) checkNestedInstantBounds(entry.dispositionStartedAt, document, `${path}.dispositionStartedAt`, errors);
  if (completed)
    checkNestedInstantBounds(entry.dispositionCompletedAt, document, `${path}.dispositionCompletedAt`, errors);
}

function applySemanticInvariants(document, variant, errors) {
  const entries = document.classes.map((entry, index) => ({ entry, row: OPTION_B_CLASS_TABLE[index] }));

  if (variant === "success") {
    for (const { entry, row } of entries) {
      if (entry.observedCount !== null && entry.observedCount > row.declaredBudget) {
        errors.push({ code: "B1_BUDGET_EXCEEDED_IN_SUCCESS", path: "$.classes", class: row.class });
      }
      if (!row.successStates.includes(entry.state)) {
        errors.push({ code: "B3_NON_SUCCESS_STATE_IN_SUCCESS_VARIANT", path: "$.classes", class: row.class });
      }
    }
  }

  const completed = entries
    .filter(({ entry }) => entry.dispositionCompletedAt !== null)
    .map(({ entry, row }) => ({
      ordinal: row.precedenceOrdinal,
      ms: parseStrictRfc3339(entry.dispositionCompletedAt)?.ms,
      class: row.class,
    }))
    .filter(({ ms }) => typeof ms === "number")
    .sort((a, b) => a.ordinal - b.ordinal);
  for (let i = 1; i < completed.length; i++) {
    if (completed[i].ms < completed[i - 1].ms) {
      errors.push({ code: "P1_PRECEDENCE_ORDER_VIOLATION", path: "$.classes", class: completed[i].class });
    }
  }

  if (variant === "pre-network-refusal") {
    for (const { entry, row } of entries) {
      if (entry.state !== "not-attempted") {
        errors.push({ code: "R1_ATTEMPT_BEGAN_BEFORE_REFUSAL", path: "$.classes", class: row.class });
      }
    }
  }

  if (variant === "post-network-failure") {
    const attempted = entries.some(({ entry }) => entry.state !== "not-attempted");
    if (!attempted) errors.push({ code: "N1_NO_ATTEMPTED_CLASS", path: "$.classes" });

    const expectedLast = completed.length > 0 ? Math.max(...completed.map((c) => c.ordinal)) : null;
    if (document.lastCompletedPrecedenceOrdinal !== expectedLast) {
      errors.push({ code: "N1_LAST_COMPLETED_PRECEDENCE_ORDINAL_MISMATCH", path: "$.lastCompletedPrecedenceOrdinal" });
    }
    if (expectedLast !== null) {
      for (const { entry, row } of entries) {
        if (row.precedenceOrdinal < expectedLast && entry.state === "not-attempted") {
          errors.push({ code: "N1_NOT_ATTEMPTED_GAP_BELOW_LAST_COMPLETED", path: "$.classes", class: row.class });
        }
      }
    }
  }

  if (variant === "cleanup-failure") {
    const qualifyingState = entries.some(({ entry }) =>
      ["disposition-failed", "unknown", "not-attempted"].includes(entry.state),
    );
    const overage = entries.some(
      ({ entry, row }) =>
        entry.enumerationComplete === true && entry.observedCount !== null && entry.observedCount > row.declaredBudget,
    );
    if (!qualifyingState && !overage) {
      errors.push({ code: "K1_CLEANUP_FAILURE_NOT_QUALIFIED", path: "$.classes" });
    }
    if (overage && document.failure !== "budget-exceeded") {
      errors.push({ code: "K1_OVERAGE_REQUIRES_BUDGET_EXCEEDED_FAILURE", path: "$.failure" });
    }
    if (!overage && document.failure === "budget-exceeded") {
      errors.push({ code: "K1_BUDGET_EXCEEDED_WITHOUT_OVERAGE", path: "$.failure" });
    }
  }
}

/**
 * Validates an already-parsed provider-object-disposition/v1 candidate
 * document. Structural closure (required/forbidden keys, enums, patterns) is
 * hand-checked field by field; B1-B4/P1/R1/N1/K1 and the digest are then
 * checked against the fixture-sourced Option B table.
 */
export function validateProviderObjectDisposition(document) {
  const errors = [];
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, errors: [{ code: "DOCUMENT_NOT_OBJECT", path: "$" }] };
  }

  for (const key of COMMON_REQUIRED_KEYS) {
    if (!(key in document)) errors.push({ code: "TOP_LEVEL_KEY_MISSING", path: `$.${key}` });
  }

  // Own-property-only lookup: VARIANT_KEY_RULES is a frozen object literal
  // and inherits Object.prototype, so an unguarded index (`constructor`,
  // `toString`, `hasOwnProperty`, `valueOf`, `__proto__`, ...) would resolve
  // to an inherited value instead of falling through to VARIANT_INVALID.
  const variantRule = Object.hasOwn(VARIANT_KEY_RULES, document.variant)
    ? VARIANT_KEY_RULES[document.variant]
    : undefined;
  const allowedTopKeys = new Set([...COMMON_REQUIRED_KEYS, ...(variantRule ? variantRule.required : [])]);
  for (const key of Object.keys(document)) {
    if (!allowedTopKeys.has(key)) errors.push({ code: "TOP_LEVEL_KEY_UNKNOWN", path: `$.${key}` });
  }
  if (variantRule) {
    for (const key of variantRule.required) {
      if (!(key in document)) errors.push({ code: "VARIANT_KEY_MISSING", path: `$.${key}` });
    }
    for (const key of variantRule.forbidden) {
      if (key in document) errors.push({ code: "VARIANT_KEY_FORBIDDEN", path: `$.${key}` });
    }
  } else {
    errors.push({ code: "VARIANT_INVALID", path: "$.variant" });
  }

  if (document.version !== "provider-object-disposition/v1")
    errors.push({ code: "VERSION_CONST_MISMATCH", path: "$.version" });
  if (document.emittedBy !== "executor") errors.push({ code: "EMITTED_BY_CONST_MISMATCH", path: "$.emittedBy" });
  if (!DEPLOYMENT_ENVIRONMENTS.has(document.deploymentEnvironment)) {
    errors.push({ code: "DEPLOYMENT_ENVIRONMENT_INVALID", path: "$.deploymentEnvironment" });
  }
  if (document.providerMode !== "test")
    errors.push({ code: "PROVIDER_MODE_NOT_AUTHORITATIVE_TEST", path: "$.providerMode" });
  if (typeof document.windowId !== "string" || !/^[0-9a-f]{32}$/.test(document.windowId)) {
    errors.push({ code: "WINDOW_ID_INVALID", path: "$.windowId" });
  }
  if (typeof document.resultDigest !== "string" || !/^[0-9a-f]{64}$/.test(document.resultDigest)) {
    errors.push({ code: "RESULT_DIGEST_SHAPE_INVALID", path: "$.resultDigest" });
  }

  const startedAt = parseStrictRfc3339(document.startedAt);
  const finishedAt = parseStrictRfc3339(document.finishedAt);
  if (!startedAt) errors.push({ code: "STARTED_AT_INVALID", path: "$.startedAt" });
  if (!finishedAt) errors.push({ code: "FINISHED_AT_INVALID", path: "$.finishedAt" });
  if (startedAt && finishedAt) {
    if (finishedAt.ms < startedAt.ms) errors.push({ code: "FINISHED_BEFORE_STARTED", path: "$.finishedAt" });
    else if ((finishedAt.ms - startedAt.ms) / 1000 > 86400) {
      errors.push({ code: "WINDOW_ELAPSED_EXCEEDS_MAX", path: "$.finishedAt" });
    }
  }

  const classesWellFormed =
    Array.isArray(document.classes) &&
    document.classes.length === 6 &&
    document.classes.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  if (!Array.isArray(document.classes) || document.classes.length !== 6) {
    errors.push({ code: "CLASSES_LENGTH_INVALID", path: "$.classes" });
  }
  if (Array.isArray(document.classes)) {
    document.classes.forEach((entry, index) => {
      if (index < OPTION_B_CLASS_TABLE.length)
        validateClassEntry(entry, index, OPTION_B_CLASS_TABLE[index], document, errors);
    });
  }

  if ("refusal" in document && !REFUSAL_CODES.has(document.refusal)) {
    errors.push({ code: "REFUSAL_CODE_INVALID", path: "$.refusal" });
  }
  if ("failure" in document && !FAILURE_CODES.has(document.failure)) {
    errors.push({ code: "FAILURE_CODE_INVALID", path: "$.failure" });
  }
  if ("lastCompletedPrecedenceOrdinal" in document) {
    const value = document.lastCompletedPrecedenceOrdinal;
    if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 6)) {
      errors.push({ code: "LAST_COMPLETED_PRECEDENCE_ORDINAL_INVALID", path: "$.lastCompletedPrecedenceOrdinal" });
    }
  }

  if (classesWellFormed && variantRule) {
    applySemanticInvariants(document, document.variant, errors);
  }

  scanForForbiddenMarkers(document, "$", errors);

  if (typeof document.resultDigest === "string" && /^[0-9a-f]{64}$/.test(document.resultDigest)) {
    const recomputed = computeResultDigest(document);
    if (recomputed !== document.resultDigest) {
      errors.push({ code: "RESULT_DIGEST_MISMATCH", path: "$.resultDigest" });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Raw-byte entrypoint: BOM/trailing-newline/duplicate-key checks first, then structural+semantic validation. */
export function validateProviderObjectDispositionBytes(buffer) {
  const parsed = parseRawDocumentBytes(buffer);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return validateProviderObjectDisposition(parsed.value);
}

/**
 * AC-12: a payload qualifies for publication only when it exists, is
 * non-empty, and passes the full raw-byte-through-digest validation chain.
 * A schema file alone (no payload bytes) can never qualify.
 */
export function qualifiesForPublicationV1(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, errors: [{ code: "PAYLOAD_MISSING", path: "$" }] };
  }
  return validateProviderObjectDispositionBytes(buffer);
}
