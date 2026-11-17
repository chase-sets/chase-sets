import { t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow, SellListReadinessSnapshot } from "../../request-support/api-client";
import type { GuestSellCheckoutRecovery } from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type { SignedInSellCheckoutRecovery } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import { normalizeQueryText } from "./sell-checkout-form";

export function recoveryFromSearchParams(searchParams: URLSearchParams): GuestSellCheckoutRecovery | null {
  const recovery = normalizeQueryText(searchParams, "recovery");
  if (
    recovery === "missing-sell-list" ||
    recovery === "empty-sell-list" ||
    recovery === "readiness-required" ||
    recovery === "readiness-stale" ||
    recovery === "readiness-blocked"
  ) {
    return { kind: recovery };
  }

  return null;
}

export function signedInRecoveryFromSearchParams(searchParams: URLSearchParams): SignedInSellCheckoutRecovery | null {
  const recovery = normalizeQueryText(searchParams, "recovery");
  if (
    recovery === "access-required" ||
    recovery === "missing-sell-list" ||
    recovery === "empty-sell-list" ||
    recovery === "readiness-required" ||
    recovery === "readiness-stale" ||
    recovery === "readiness-blocked"
  ) {
    return { kind: recovery };
  }

  return null;
}

function stableKeyPart(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

export function confirmationIdForSession(sessionId: string) {
  return `slc_${stableKeyPart(sessionId)}`;
}

export function confirmationPathForSession(sessionId: string) {
  return `/checkout/sell/session/${stableKeyPart(sessionId)}/confirmation`;
}

export function filterIncludedLines(lines: readonly CheckoutSellListLineRow[], readiness: SellListReadinessSnapshot) {
  const includedLineIds = new Set(readiness.includedLineIds);
  return lines.filter((line) => includedLineIds.has(line.line_id));
}
