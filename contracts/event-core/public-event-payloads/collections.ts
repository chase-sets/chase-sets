import { parseStrictTypedUlid, type AccountId } from "../../primitives/typed-ids";

export const collectionsSavedListReportReasons = ["spam", "prohibited-content", "harassment", "other"] as const;

export type CollectionsSavedListReportReason = (typeof collectionsSavedListReportReasons)[number];

type CollectionsSavedListReportSubmittedPayloadBase = Readonly<{
  reportId: string;
  targetType: "saved-list";
  targetId: string;
  targetOwnerAccountId: AccountId;
  reason: CollectionsSavedListReportReason;
  submittedAt: string;
}>;

export type CollectionsSavedListReportSubmittedPayload = CollectionsSavedListReportSubmittedPayloadBase &
  (
    | Readonly<{ reporterKind: "account"; reporterKey: AccountId; reporterAccountId: AccountId }>
    | Readonly<{ reporterKind: "visitor"; reporterKey: string; reporterAccountId: null }>
  );

export type CollectionsEventPayloads = Readonly<{
  "collections.saved-list.report-submitted": CollectionsSavedListReportSubmittedPayload;
}>;

const reportKeys = [
  "reportId",
  "targetType",
  "targetId",
  "targetOwnerAccountId",
  "reporterKind",
  "reporterKey",
  "reporterAccountId",
  "reason",
  "submittedAt",
] as const;

const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;
const visitorDigestPattern = /^[A-Za-z0-9_-]{43}$/;

export function parseCollectionsSavedListReportSubmittedPayload(
  value: unknown,
): CollectionsSavedListReportSubmittedPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Saved List report payload must be an object.");
  }

  const input = value as Readonly<Record<string, unknown>>;
  const ownKeys = Reflect.ownKeys(input);
  const unknownKeys = ownKeys.filter(
    (key) => typeof key !== "string" || !reportKeys.includes(key as (typeof reportKeys)[number]),
  );
  const missingKeys = reportKeys.filter((key) => !Object.hasOwn(input, key));
  if (unknownKeys.length > 0) {
    const key = typeof unknownKeys[0] === "string" ? unknownKeys[0] : "symbol";
    throw new Error(`Saved List report payload has unknown key ${key}.`);
  }
  if (missingKeys.length > 0) {
    throw new Error(`Saved List report payload is missing key ${missingKeys.join(", ")}.`);
  }

  if (!isNonEmptyTrimmedString(input.reportId) || !isNonEmptyTrimmedString(input.targetId)) {
    throw new Error("Saved List report payload IDs must be non-empty trimmed strings: reportId, targetId.");
  }
  if (input.targetType !== "saved-list") {
    throw new Error("Saved List report payload targetType must be saved-list.");
  }
  if (input.reporterKind !== "account" && input.reporterKind !== "visitor") {
    throw new Error("Saved List report payload reporterKind must be account or visitor.");
  }
  if (!isNonEmptyTrimmedString(input.reporterKey)) {
    throw new Error("Saved List report payload reporterKey must be a non-empty trimmed string.");
  }
  if (!collectionsSavedListReportReasons.includes(input.reason as CollectionsSavedListReportReason)) {
    throw new Error("Saved List report payload reason is invalid.");
  }
  if (typeof input.submittedAt !== "string" || !isValidInstant(input.submittedAt)) {
    throw new Error("Saved List report payload submittedAt must be a calendar-valid timezone instant.");
  }

  const targetOwnerAccountId = parseAccountId(input.targetOwnerAccountId, "targetOwnerAccountId");
  const reporterAccountId =
    input.reporterAccountId === null ? null : parseAccountId(input.reporterAccountId, "reporterAccountId");

  if (input.reporterKind === "account") {
    const reporterKey = parseAccountId(input.reporterKey, "reporterKey");
    if (reporterAccountId === null || reporterKey !== reporterAccountId) {
      throw new Error("Saved List report payload account reporter must match reporterKey and reporterAccountId.");
    }
    return {
      reportId: input.reportId,
      targetType: "saved-list",
      targetId: input.targetId,
      targetOwnerAccountId,
      reporterKind: "account",
      reporterKey,
      reporterAccountId,
      reason: input.reason as CollectionsSavedListReportReason,
      submittedAt: input.submittedAt,
    };
  }

  if (reporterAccountId !== null || !visitorDigestPattern.test(input.reporterKey)) {
    throw new Error("Saved List report payload visitor reporter must use a 43-character digest and null account.");
  }

  return {
    reportId: input.reportId,
    targetType: "saved-list",
    targetId: input.targetId,
    targetOwnerAccountId,
    reporterKind: "visitor",
    reporterKey: input.reporterKey,
    reporterAccountId,
    reason: input.reason as CollectionsSavedListReportReason,
    submittedAt: input.submittedAt,
  };
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function parseAccountId(value: unknown, key: string): AccountId {
  if (typeof value !== "string") {
    throw new Error(`Saved List report payload ${key} must be a canonical account ID.`);
  }
  try {
    return parseStrictTypedUlid(value, "acc");
  } catch {
    throw new Error(`Saved List report payload ${key} must be a canonical account ID.`);
  }
}

function isValidInstant(value: string): boolean {
  const match = instantPattern.exec(value);
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction,
    zone,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    (zone !== "Z" && offsetHour === 23 && offsetMinute > 59)
  ) {
    return false;
  }
  if (fraction && (fraction.length < 1 || fraction.length > 9)) return false;
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
