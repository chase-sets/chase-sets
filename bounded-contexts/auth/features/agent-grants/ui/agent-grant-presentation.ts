import { t } from "@chase-sets/localization";
import { formatMoney } from "@chase-sets/localization";
import { centsToMoneyAmount } from "@chase-sets/primitives/money";
import type { AgentGrant, AgentGrantActivityRecord, AgentGrantPaymentRail } from "./contracts";

export function agentGrantStatusTone(status: string): "success" | "danger" | "neutral" {
  if (status === "active") {
    return "success";
  }
  if (status === "revoked") {
    return "danger";
  }
  return "neutral";
}

export function agentGrantActivityOutcomeTone(
  outcome: AgentGrantActivityRecord["outcome"],
): "success" | "danger" | "warning" {
  if (outcome === "allowed") {
    return "success";
  }
  if (outcome === "denied") {
    return "warning";
  }
  return "danger";
}

function formatCentsOrUnlimited(cents: number | null | undefined) {
  return cents === null || cents === undefined
    ? t("auth.features.agentGrants.ui.agentGrantPresentation.no.cap")
    : formatMoney(centsToMoneyAmount(cents), "USD");
}

// A one-line spend summary for the list page: "$12.50 / $50.00 daily".
export function agentGrantSpendSummary(grant: AgentGrant) {
  if (!grant.spending_mandate || !grant.spend) {
    return t("auth.features.agentGrants.ui.agentGrantPresentation.no.spend.data");
  }

  const dailySpent = formatMoney(centsToMoneyAmount(grant.spend.daily_cents), "USD");
  const dailyCap = formatCentsOrUnlimited(grant.spending_mandate.daily_cap_cents);
  return t("auth.features.agentGrants.ui.agentGrantPresentation.daily.spend.summary", {
    spent: dailySpent,
    cap: dailyCap,
  });
}

export function agentGrantMandateCapLabel(cents: number | null) {
  return formatCentsOrUnlimited(cents);
}

const PAYMENT_RAIL_LABEL_KEYS: Readonly<Record<AgentGrantPaymentRail, string>> = {
  "handoff-only": "auth.features.agentGrants.ui.agentGrantPresentation.rail.handoff.only",
  "stored-pm": "auth.features.agentGrants.ui.agentGrantPresentation.rail.stored.pm",
  ap2: "auth.features.agentGrants.ui.agentGrantPresentation.rail.ap2",
};

export function agentGrantPaymentRailLabel(rail: AgentGrantPaymentRail) {
  return t(PAYMENT_RAIL_LABEL_KEYS[rail]);
}
