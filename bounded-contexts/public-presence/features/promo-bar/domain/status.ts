import type { PromoBarMessage } from "../api/contracts";

export type PromoBarMessageStatus = "active" | "expired" | "inactive" | "scheduled";

function instantMillis(value: Date | string): number {
  return typeof value === "string" ? new Date(value).getTime() : value.getTime();
}

function optionalInstantMillis(value: string | null): number | null {
  return value ? new Date(value).getTime() : null;
}

export function promoBarMessageStatusAt(
  message: Pick<PromoBarMessage, "ends_at" | "is_active" | "starts_at">,
  now: Date | string = new Date(),
): PromoBarMessageStatus {
  if (!message.is_active) {
    return "inactive";
  }

  const currentTime = instantMillis(now);
  const startsAt = optionalInstantMillis(message.starts_at);
  if (startsAt !== null && startsAt > currentTime) {
    return "scheduled";
  }

  const endsAt = optionalInstantMillis(message.ends_at);
  if (endsAt !== null && endsAt <= currentTime) {
    return "expired";
  }

  return "active";
}

export function isPromoBarMessageLiveAt(
  message: Pick<PromoBarMessage, "ends_at" | "is_active" | "starts_at">,
  now: Date | string = new Date(),
): boolean {
  return promoBarMessageStatusAt(message, now) === "active";
}
