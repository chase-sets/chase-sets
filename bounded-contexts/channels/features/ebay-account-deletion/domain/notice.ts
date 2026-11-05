import { assertCredentialInstant } from "../../credentials/domain/codecs";
import { assertEbaySubject, EbayReceiptError } from "./subject";

export type EbayAccountDeletionNotice = Readonly<{
  notificationId: string;
  topic: "MARKETPLACE_ACCOUNT_DELETION";
  eventDate: string;
  publishDate: string;
  publishAttemptCount: number;
  userId: string;
}>;

function canonicalInstant(value: string) {
  assertCredentialInstant(value);
  const utc = new Date(value).toISOString();
  if (!/^\d{4}-/.test(utc) || utc.startsWith("0000-")) throw new Error();
  const fraction = /\.(\d+)/.exec(value)?.[1].replace(/0+$/, "") ?? "";
  return `${utc.slice(0, 19)}.${fraction.padEnd(3, "0")}Z`;
}

type EbayAccountDeletionCandidate = Omit<EbayAccountDeletionNotice, "topic"> & Readonly<{ topic: string }>;

export function parseEbayAccountDeletionPayload(value: unknown) {
  function closed(input: unknown, names: readonly string[]): Record<string, unknown> {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== names.length ||
      names.some((name) => !Object.hasOwn(input, name))
    )
      throw new EbayReceiptError("invalid-notice");
    return input as Record<string, unknown>;
  }
  const payload = closed(value, ["metadata", "notification"]);
  const metadata = closed(payload.metadata, ["topic", "schemaVersion", "deprecated"]);
  const notification = closed(payload.notification, [
    "notificationId",
    "eventDate",
    "publishDate",
    "publishAttemptCount",
    "data",
  ]);
  const data = closed(notification.data, ["username", "userId", "eiasToken"]);
  if (
    metadata.topic !== "MARKETPLACE_ACCOUNT_DELETION" ||
    typeof metadata.deprecated !== "boolean" ||
    typeof metadata.schemaVersion !== "string" ||
    !metadata.schemaVersion ||
    metadata.schemaVersion.length > 256 ||
    [data.username, data.eiasToken].some((field) => typeof field !== "string" || !field || field.length > 2048)
  )
    throw new EbayReceiptError("invalid-notice");
  return parseEbayAccountDeletionNotice({
    notificationId: notification.notificationId,
    topic: metadata.topic,
    eventDate: notification.eventDate,
    publishDate: notification.publishDate,
    publishAttemptCount: notification.publishAttemptCount,
    userId: data.userId,
  });
}

// New-topic admission follows the retained identity check, so a changed topic
// on an existing notification is a conflict rather than a new notice.
export function parseEbayAccountDeletionNotice(value: unknown): EbayAccountDeletionCandidate {
  try {
    const names = ["notificationId", "topic", "eventDate", "publishDate", "publishAttemptCount", "userId"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== names.length ||
      names.some((name) => !Object.hasOwn(value, name))
    )
      throw new Error();
    const notice = value as EbayAccountDeletionCandidate;
    assertEbaySubject(notice.notificationId);
    assertEbaySubject(notice.userId);
    assertEbaySubject(notice.topic);
    if (
      !Number.isSafeInteger(notice.publishAttemptCount) ||
      notice.publishAttemptCount < 1 ||
      notice.eventDate.length > 40 ||
      notice.publishDate.length > 40
    )
      throw new Error();
    return {
      ...notice,
      eventDate: canonicalInstant(notice.eventDate),
      publishDate: canonicalInstant(notice.publishDate),
    };
  } catch {
    throw new EbayReceiptError("invalid-notice");
  }
}
