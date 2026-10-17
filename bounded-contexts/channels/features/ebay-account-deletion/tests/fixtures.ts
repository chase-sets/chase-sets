import { ebaySubjectRootKeyId } from "../domain/subject";

export const notice = {
  notificationId: "synthetic-notification",
  topic: "MARKETPLACE_ACCOUNT_DELETION" as const,
  eventDate: "2026-10-11T00:00:00Z",
  publishDate: "2026-10-11T00:01:00Z",
  publishAttemptCount: 1,
  userId: "synthetic-secret-subject-marker",
};
export function keyring(activeKeyId = "old-seal") {
  return {
    activeKeyId,
    keys: new Map([
      [ebaySubjectRootKeyId, Buffer.alloc(32, 1)],
      ["old-seal", Buffer.alloc(32, 2)],
      ["new-seal", Buffer.alloc(32, 3)],
    ]),
  };
}
