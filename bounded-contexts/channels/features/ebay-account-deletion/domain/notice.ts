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

export function parseEbayAccountDeletionNotice(value: unknown): EbayAccountDeletionNotice {
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
    const notice = value as EbayAccountDeletionNotice;
    assertEbaySubject(notice.notificationId);
    assertEbaySubject(notice.userId);
    if (
      notice.topic !== "MARKETPLACE_ACCOUNT_DELETION" ||
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
