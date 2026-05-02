import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { buildPayoutSetupProgress } from "../domain/setup-progress";

function readinessTone(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return "success";
    case "restricted":
      return "danger";
    case "not-started":
      return "neutral";
    default:
      return "warning";
  }
}

function readinessTitle(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payouts.are.ready");
    case "restricted":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.setup.needs.attention");
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.set.up.payouts");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.finish.setup.to.receive.payouts");
  }
}

function readinessDescription(
  status: SettlementPayoutReadinessRow["status"],
  readyDescription: string,
) {
  switch (status) {
    case "ready":
      return readyDescription;
    case "restricted":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.some.payout.details.need.to.be");
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.add.a.payout.account.using.the");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.continue.the.hosted.setup.flow.before");
  }
}

function readinessLabel(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "ready":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.ready");
    case "restricted":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.needs.attention");
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.not.started");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.in.progress");
  }
}

function primaryActionLabel(status: SettlementPayoutReadinessRow["status"]) {
  switch (status) {
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.start.payout.setup");
    case "restricted":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.fix.payout.setup");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.continue.payout.setup");
  }
}

function setupStatusLabel(value: string) {
  switch (value) {
    case "not-started":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.not.started.2");
    case "pending":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.needs.attention.2");
    case "complete":
    case "active":
    case "ready":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.ready.2");
    case "inactive":
    case "missing":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.missing");
    default:
      return value.replaceAll("_", " ").replaceAll(".", " ");
  }
}

function requirementLabel(value: string) {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function requirementGroup(value: string) {
  const normalized = value.toLowerCase();
  if (
    normalized.includes("external_account") ||
    normalized.includes("bank") ||
    normalized.includes("payout")
  ) {
    return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.account");
  }
  if (
    normalized.includes("individual") ||
    normalized.includes("representative") ||
    normalized.includes("owner") ||
    normalized.includes("person") ||
    normalized.includes("identity")
  ) {
    return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.identity.details");
  }
  if (
    normalized.includes("business") ||
    normalized.includes("company") ||
    normalized.includes("profile") ||
    normalized.includes("mcc") ||
    normalized.includes("url")
  ) {
    return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.business.profile");
  }
  if (normalized.includes("tos") || normalized.includes("terms")) {
    return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.account.agreement");
  }
  return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.verification.review");
}

function groupedRequirements(requirements: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const requirement of requirements) {
    const group = requirementGroup(requirement);
    groups.set(group, [...(groups.get(group) ?? []), requirementLabel(requirement)]);
  }
  return [...groups.entries()];
}

function checkedAtLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.not.checked.yet");
}

function progressTone(status: string) {
  switch (status) {
    case "ready":
      return "success";
    case "needs-attention":
      return "warning";
    case "pending":
      return "accent";
    default:
      return "neutral";
  }
}

function progressLabel(status: string) {
  switch (status) {
    case "ready":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.ready.3");
    case "needs-attention":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.needs.attention.3");
    case "pending":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.in.review");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.not.started.3");
  }
}

export function PayoutReadinessPanel({
  payoutReadiness,
  readyDescription = t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.setup.is.complete"),
  showActions = false,
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  readyDescription?: string;
  showActions?: boolean;
}) {
  const hasProviderAccount = Boolean(payoutReadiness.provider_reference);
  const missingRequirementGroups = groupedRequirements(
    payoutReadiness.missing_requirements,
  );
  const progress = buildPayoutSetupProgress(payoutReadiness);

  return (
    <Stack gap={2}>
      <Badge tone={readinessTone(payoutReadiness.status) as any}>
        {readinessLabel(payoutReadiness.status)}
      </Badge>
      <Text weight="semibold">{readinessTitle(payoutReadiness.status)}</Text>
      <Text size="sm" tone="secondary">
        {readinessDescription(payoutReadiness.status, readyDescription)}
      </Text>
      <Text size="sm" tone="secondary">
        {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.last.checked")}{checkedAtLabel(payoutReadiness.updated_at)}
      </Text>
      <Stack gap={1}>
        {progress.steps.map((step) => (
          <Stack key={step.id} gap={1}>
            <Badge tone={progressTone(step.status) as any}>
              {progressLabel(step.status)}
            </Badge>
            <Text size="sm" weight="semibold">{step.label}</Text>
            <Text size="sm" tone="secondary">{step.detail}</Text>
          </Stack>
        ))}
      </Stack>
      <Text size="sm" tone="secondary">
        {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.onboarding")}{setupStatusLabel(payoutReadiness.onboarding_status)}
      </Text>
      <Text size="sm" tone="secondary">
        {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.transfers")}{setupStatusLabel(payoutReadiness.transfer_capability_status)}
      </Text>
      <Text size="sm" tone="secondary">
        {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payouts")}{setupStatusLabel(payoutReadiness.payout_capability_status)}
      </Text>
      <Text size="sm" tone="secondary">
        {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.destination")}{setupStatusLabel(payoutReadiness.payout_destination_status)}
      </Text>
      {missingRequirementGroups.length > 0 ? (
        <Stack gap={1}>
          <Text size="sm" weight="semibold">{t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.what.needs.attention")}</Text>
          {missingRequirementGroups.map(([group, requirements]) => (
            <Text key={group} size="sm" tone="secondary">
              {group}: {requirements.join(", ")}
            </Text>
          ))}
        </Stack>
      ) : null}
      {showActions ? (
        <Stack gap={2}>
          {payoutReadiness.status === "ready" ? null : (
            <form method="post">
              <input type="hidden" name="intent" value="start-payout-setup" />
              <Button type="submit">{primaryActionLabel(payoutReadiness.status)}</Button>
            </form>
          )}
          {hasProviderAccount ? (
            <form method="post">
              <input type="hidden" name="intent" value="manage-payout-account" />
              <Button type="submit" tone="secondary">
                {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.manage.payout.account")}</Button>
            </form>
          ) : null}
          <form method="post">
            <input type="hidden" name="intent" value="refresh-payout-setup" />
            <Button type="submit" tone="secondary">
              {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.check.setup.status")}</Button>
          </form>
        </Stack>
      ) : null}
    </Stack>
  );
}
