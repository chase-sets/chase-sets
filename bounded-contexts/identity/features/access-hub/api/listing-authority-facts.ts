import type { ListingAuthorityReservation } from "@chase-sets/event-core/listing-authority";
import { accountBadgeKeys, type AccountBadgeKey } from "../../accounts/domain/domain";
import type { AccountType } from "../../../support/runtime-support/common";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function account(reservation: ListingAuthorityReservation) {
  const value = reservation.value;
  if (
    reservation.participant.owner !== "identity" ||
    reservation.participant.purpose !== "manage-listing" ||
    reservation.status !== "reserved" ||
    value.accountId !== reservation.operation.accountId ||
    !["personal", "business", "enterprise"].includes(String(value.accountType)) ||
    !Array.isArray(value.badges) ||
    value.badges.some((badge) => !accountBadgeKeys.includes(badge as AccountBadgeKey))
  )
    throw new Error("Invalid Identity account authority facts.");
  const window = value.foundersWindow;
  if (
    window !== null &&
    (!isRecord(window) ||
      typeof window.startedAt !== "string" ||
      typeof window.endsAt !== "string" ||
      !Number.isFinite(Date.parse(window.startedAt)) ||
      !(Date.parse(window.endsAt) > Date.parse(window.startedAt)))
  )
    throw new Error("Invalid Identity founder window authority facts.");
  return {
    accountId: reservation.operation.accountId,
    accountType: value.accountType as AccountType,
    badgeKeys: value.badges as AccountBadgeKey[],
    foundersWindow: window as { startedAt: string; endsAt: string } | null,
  };
}

/** Decode only facts from the Identity promise retained by the final consumer. */
export function decodeListingSellerFacts(reservation: ListingAuthorityReservation) {
  return { badgeKeys: account(reservation).badgeKeys };
}

export function decodeListingAccountFacts(reservation: ListingAuthorityReservation) {
  const facts = account(reservation);
  return {
    account_id: facts.accountId,
    account_type: facts.accountType,
    status: "active",
    founders_window_started_at: facts.foundersWindow?.startedAt ?? null,
    founders_window_ends_at: facts.foundersWindow?.endsAt ?? null,
  };
}
