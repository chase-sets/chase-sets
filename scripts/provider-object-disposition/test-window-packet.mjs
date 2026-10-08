import {
  parseJsonNoDuplicateKeys,
  parseStrictRfc3339,
  validateProviderObjectDisposition,
} from "./validate-provider-object-disposition.mjs";

const mappers = [
  "customer",
  "setup-embedded",
  "payment-saved",
  "connect-setup",
  "connect-manage",
  "connect-notification",
];
const shape = (value, fields) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).length === Object.keys(fields).length &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.hasOwn(fields, key)) &&
  Object.entries(fields).every(([key, check]) => check(value[key]));
const member =
  (...values) =>
  (value) =>
    values.includes(value);
const hex = (length) => (value) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const integer = (maximum) => (value) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const boolean = (value) => typeof value === "boolean";
const utc = (value) => typeof value === "string" && value.endsWith("Z") && parseStrictRfc3339(value) !== null;
const nullable = (check) => (value) => value === null || check(value);

function utcDisposition(value, depth = 0) {
  if (depth > 16 || value === null || typeof value !== "object") return depth <= 16;
  return Object.entries(value).every(
    ([key, entry]) =>
      (["startedAt", "finishedAt", "dispositionStartedAt", "dispositionCompletedAt"].includes(key)
        ? nullable(utc)(entry)
        : true) && utcDisposition(entry, depth + 1),
  );
}

export function validateCapturePacket(value) {
  try {
    const manifest = Object.hasOwn(value, "manifestDigest") ? { manifestDigest: hex(64) } : {};
    if (
      shape(value, {
        version: member("provider-lifecycle-capture/v1"),
        classification: member("refused", "invalid"),
        code: member(
          "authority-unavailable",
          "production-environment",
          "journal-unavailable",
          "invalid-input",
          "cleanup-incomplete",
          "cleanup-obligation-retained",
          "child-interrupted",
          "packet-invalid",
        ),
        replayQualified: member(false),
        ...manifest,
      })
    )
      return true;
    if (
      !shape(value, {
        version: member("provider-lifecycle-capture/v1"),
        classification: member("observed", "unknown"),
        reviewedHead: hex(40),
        executedHead: hex(40),
        journalHead: hex(40),
        deployedHead: hex(40),
        apiVersion: (entry) => typeof entry === "string" && /^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(entry),
        configDigest: hex(64),
        providerMode: member("test"),
        plannedHttpAttempts: integer(646),
        actualHttpAttempts: integer(646),
        plannedObjects: integer(323),
        actualLogicalCreations: integer(323),
        retentionGuarantee: nullable((entry) =>
          shape(entry, {
            source: member("https://docs.stripe.com/api/idempotent_requests"),
            seconds: (seconds) => integer(86400)(seconds) && seconds > 0,
          }),
        ),
        observations: (entries) =>
          Array.isArray(entries) &&
          entries.length <= 6 &&
          entries.every((entry) =>
            shape(entry, {
              mapper: member(...mappers),
              classification: member("observed-equal", "unknown"),
              originalSentAt: nullable(utc),
              replaySentAt: nullable(utc),
              expiresAt: nullable(utc),
              elapsedSeconds: nullable((seconds) => Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600),
              equal: boolean,
              usability: member("not-applicable", "usable", "unknown"),
              repeatedSameSlot: nullable(boolean),
              twoTabs: nullable(boolean),
              intervalSupported: boolean,
            }),
          ),
        disposition: (entry) => validateProviderObjectDisposition(entry).ok && utcDisposition(entry),
        replayQualified: member(false),
        ...manifest,
      })
    )
      return false;
    if (
      value.reviewedHead !== value.executedHead ||
      value.plannedHttpAttempts < 1 ||
      value.plannedObjects < 1 ||
      value.actualHttpAttempts > value.plannedHttpAttempts ||
      value.actualLogicalCreations > value.plannedObjects ||
      new Set(value.observations.map((entry) => entry.mapper)).size !== value.observations.length
    )
      return false;
    if (
      value.classification === "observed" &&
      (value.observations.length !== 6 || value.observations.some((entry) => entry.classification !== "observed-equal"))
    )
      return false;
    return value.observations.every(
      (entry) =>
        entry.elapsedSeconds === null ||
        (entry.originalSentAt !== null &&
          entry.replaySentAt !== null &&
          (Date.parse(entry.replaySentAt) - Date.parse(entry.originalSentAt)) / 1000 === entry.elapsedSeconds),
    );
  } catch {
    return false;
  }
}

export function parseCapturePacket(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > 1048576) throw new Error();
    const packet = parseJsonNoDuplicateKeys(text);
    if (!validateCapturePacket(packet)) throw new Error();
    return packet;
  } catch {
    throw new Error("packet-invalid");
  }
}
