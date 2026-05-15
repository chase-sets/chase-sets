import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  ProgressiveDisclosure,
  SpecificationList,
  Stack,
  Text,
  UiInline,
  UiSurface,
  type Tone,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import { buildPayoutSetupProgress } from "../domain/setup-progress";

function readinessTone(status: SettlementPayoutReadinessRow["status"]): Tone {
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

function progressTone(status: string): Tone {
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
  const canReceivePayouts = payoutReadiness.status === "ready";
  const setupDetailSummary = missingRequirementGroups.length > 0
    ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.requirement.group.needs.attention", {
        group: missingRequirementGroups[0]?.[0],
      })
    : canReceivePayouts
      ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.ready")
      : setupStatusLabel(payoutReadiness.onboarding_status);

  return (
    <Stack gap={4}>
      <Stack gap={3}>
        <Stack gap={2}>
          <Badge tone={readinessTone(payoutReadiness.status)}>
            {readinessLabel(payoutReadiness.status)}
          </Badge>
          <Stack gap={1}>
            <Text weight="semibold">{readinessTitle(payoutReadiness.status)}</Text>
            <Text size="sm" tone="secondary">
              {readinessDescription(payoutReadiness.status, readyDescription)}
            </Text>
          </Stack>
        </Stack>
        <Text size="sm" tone="secondary">
          {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.last.checked")}{checkedAtLabel(payoutReadiness.updated_at)}
        </Text>
      </Stack>

      <Stack gap={3}>
        {progress.steps.map((step) => (
          <UiSurface key={step.id}>
            <Stack gap={1}>
              <Badge tone={progressTone(step.status)}>
                {progressLabel(step.status)}
              </Badge>
              <Text size="sm" weight="semibold">{step.label}</Text>
              <Text size="sm" tone="secondary">{step.detail}</Text>
            </Stack>
          </UiSurface>
        ))}
      </Stack>

      <ProgressiveDisclosure
        title={t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.what.needs.attention")}
        summary={setupDetailSummary}
        tone={missingRequirementGroups.length > 0 ? "warning" : "info"}
        defaultOpen={payoutReadiness.status === "restricted"}
      >
        <Stack gap={3}>
          <SpecificationList
            specs={[
              {
                label: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.onboarding"),
                value: setupStatusLabel(payoutReadiness.onboarding_status),
              },
              {
                label: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.transfers"),
                value: setupStatusLabel(payoutReadiness.transfer_capability_status),
              },
              {
                label: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payouts"),
                value: setupStatusLabel(payoutReadiness.payout_capability_status),
              },
              {
                label: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.destination"),
                value: setupStatusLabel(payoutReadiness.payout_destination_status),
              },
            ]}
          />

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
        </Stack>
      </ProgressiveDisclosure>
      {canReceivePayouts ? (
        <Text size="sm" tone="secondary">
          {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.eligible.seller.balances")}
        </Text>
      ) : null}
      {showActions ? (
        <UiInline>
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
        </UiInline>
      ) : null}
    </Stack>
  );
}
