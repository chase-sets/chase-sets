import { formatDateTime, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Badge,
  Banner,
  Button,
  LinkButton,
  Inline,
  ProgressiveDisclosure,
  SpecificationList,
  Stack,
  Surface,
  Text,
  type Tone,
} from "@chase-sets/design-system";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import {
  buildMissingRequirementGroups,
  buildPayoutSetupProgress,
  type MissingRequirementGroup,
} from "../domain/setup-progress";

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

function readinessDescription(status: SettlementPayoutReadinessRow["status"], readyDescription: string) {
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

function checkedAtLabel(value: string | null) {
  return value
    ? formatDateTime(value)
    : t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.not.checked.yet");
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

function localizedRequirementGroupLabel(group: MissingRequirementGroup) {
  switch (group.id) {
    case "payout-account":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.account");
    case "identity-and-business":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.identity.and.business.details");
    case "account-agreement":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.account.agreement");
    case "platform-review":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.platform.review");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.verification.review");
  }
}

function localizedRequirementGroupDetail(group: MissingRequirementGroup) {
  switch (group.id) {
    case "payout-account":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.add.or.confirm.the.payout.destination");
    case "identity-and-business":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.review.account.identity.or.business");
    case "account-agreement":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.review.and.accept.the.required.account");
    case "platform-review":
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.platform.review.description");
    default:
      return t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.review.the.remaining.verification.details");
  }
}

function recoveryGuidance(
  payoutReadiness: SettlementPayoutReadinessRow,
  missingRequirementGroups: readonly MissingRequirementGroup[],
) {
  if (payoutReadiness.status === "ready") {
    return null;
  }

  if (payoutReadiness.status === "restricted") {
    const disabledReason = payoutReadiness.disabled_reason?.toLowerCase() ?? "";
    const description = disabledReason.includes("past_due")
      ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.restricted.past.due")
      : disabledReason.includes("review") || disabledReason.includes("pending")
        ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.restricted.review")
        : disabledReason.includes("rejected") || disabledReason.includes("fraud")
          ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.restricted.rejected")
          : disabledReason.includes("paused") || disabledReason.includes("inactivity")
            ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.restricted.paused")
            : t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.setup.is.restricted.description");
    return {
      tone: "warning" as const,
      title: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.setup.is.restricted"),
      description,
      supportEscalationRecommended: true,
    };
  }

  if (missingRequirementGroups.length > 0) {
    if (missingRequirementGroups.every((group) => group.id === "platform-review")) {
      return {
        tone: "warning" as const,
        title: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.platform.review"),
        description: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.platform.review.description"),
        supportEscalationRecommended: true,
      };
    }
    const groupLabels = missingRequirementGroups.map(localizedRequirementGroupLabel).join(", ");
    return {
      tone: "warning" as const,
      title: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.setup.details.need.attention"),
      description: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.complete.requested.groups", {
        groups: groupLabels,
      }),
      supportEscalationRecommended: false,
    };
  }

  if (payoutReadiness.payout_destination_status === "missing") {
    return {
      tone: "warning" as const,
      title: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.add.a.payout.destination"),
      description: t(
        "settlement.features.payoutReadiness.ui.payoutReadinessPanel.add.a.payout.destination.description",
      ),
      supportEscalationRecommended: false,
    };
  }

  if (
    payoutReadiness.onboarding_status === "pending" ||
    payoutReadiness.transfer_capability_status === "pending" ||
    payoutReadiness.payout_capability_status === "pending" ||
    payoutReadiness.payout_destination_status === "pending"
  ) {
    return {
      tone: "info" as const,
      title: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.provider.review.in.progress"),
      description: t(
        "settlement.features.payoutReadiness.ui.payoutReadinessPanel.provider.review.in.progress.description",
      ),
      supportEscalationRecommended: false,
    };
  }

  return {
    tone: "info" as const,
    title: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.setup.can.continue"),
    description: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.setup.can.continue.description"),
    supportEscalationRecommended: false,
  };
}

export function PayoutReadinessPanel({
  payoutReadiness,
  readyDescription = t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.payout.setup.is.complete"),
  showActions = false,
  showSupportEscalation = false,
}: {
  payoutReadiness: SettlementPayoutReadinessRow;
  readyDescription?: string;
  showActions?: boolean;
  showSupportEscalation?: boolean;
}) {
  const hasProviderAccount = Boolean(payoutReadiness.provider_reference);
  const missingRequirementGroups = buildMissingRequirementGroups(payoutReadiness.missing_requirements);
  const advisoryRequirementGroups = buildMissingRequirementGroups(payoutReadiness.advisory_requirements);
  const onlyPlatformReview =
    missingRequirementGroups.length > 0 && missingRequirementGroups.every((group) => group.id === "platform-review");
  const progress = buildPayoutSetupProgress(payoutReadiness);
  const recovery = recoveryGuidance(payoutReadiness, missingRequirementGroups);
  const canReceivePayouts = payoutReadiness.status === "ready";
  const firstMissingRequirementGroup = missingRequirementGroups[0];
  const setupDetailSummary = firstMissingRequirementGroup
    ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.requirement.group.needs.attention", {
        group: localizedRequirementGroupLabel(firstMissingRequirementGroup),
      })
    : canReceivePayouts
      ? t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.ready")
      : setupStatusLabel(payoutReadiness.onboarding_status);

  return (
    <Stack gap={4}>
      <Stack gap={3}>
        <Stack gap={2}>
          <Badge tone={readinessTone(payoutReadiness.status)}>{readinessLabel(payoutReadiness.status)}</Badge>
          <Stack gap={1}>
            <Text weight="semibold">{readinessTitle(payoutReadiness.status)}</Text>
            <Text size="sm" tone="secondary">
              {readinessDescription(payoutReadiness.status, readyDescription)}
            </Text>
          </Stack>
        </Stack>
        <Text size="sm" tone="secondary">
          {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.last.checked")}
          {checkedAtLabel(payoutReadiness.updated_at)}
        </Text>
      </Stack>

      {recovery ? (
        <Banner
          tone={recovery.tone}
          title={recovery.title}
          description={recovery.description}
          actions={
            showSupportEscalation || recovery.supportEscalationRecommended ? (
              <LinkButton href="/account/support" tone="secondary" size="sm">
                {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.contact.support")}
              </LinkButton>
            ) : null
          }
        />
      ) : null}

      {advisoryRequirementGroups.length > 0 ? (
        <Banner
          tone="info"
          title={t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.future.requirements")}
          description={t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.future.requirements.description")}
        />
      ) : null}

      <Stack gap={3}>
        {progress.steps.map((step) => (
          <Surface key={step.id}>
            <Stack gap={1}>
              <Badge tone={progressTone(step.status)}>{progressLabel(step.status)}</Badge>
              <Text size="sm" weight="semibold">
                {step.label}
              </Text>
              <Text size="sm" tone="secondary">
                {step.detail}
              </Text>
            </Stack>
          </Surface>
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
              ...(payoutReadiness.requirements_deadline
                ? [
                    {
                      label: t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.requirements.deadline"),
                      value: formatDateTime(payoutReadiness.requirements_deadline),
                    },
                  ]
                : []),
            ]}
          />

          {missingRequirementGroups.length > 0 ? (
            <Stack gap={1}>
              <Text size="sm" weight="semibold">
                {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.what.needs.attention")}
              </Text>
              {missingRequirementGroups.map((group) => (
                <Text key={group.id} size="sm" tone="secondary">
                  {localizedRequirementGroupLabel(group)}:{" "}
                  {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.requirement.group.count", {
                    count: String(group.count),
                  })}{" "}
                  {localizedRequirementGroupDetail(group)}
                </Text>
              ))}
            </Stack>
          ) : null}

          {advisoryRequirementGroups.length > 0 ? (
            <Stack gap={1}>
              <Text size="sm" weight="semibold">
                {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.upcoming.requirements")}
              </Text>
              {advisoryRequirementGroups.map((group) => (
                <Text key={group.id} size="sm" tone="secondary">
                  {localizedRequirementGroupLabel(group)}: {localizedRequirementGroupDetail(group)}
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
        <Inline>
          {payoutReadiness.status === "ready" || onlyPlatformReview ? null : (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="start-payout-setup" />
              <Button type="submit">{primaryActionLabel(payoutReadiness.status)}</Button>
            </Form>
          )}
          {hasProviderAccount ? (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="manage-payout-account" />
              <Button type="submit" tone="secondary">
                {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.manage.payout.account")}
              </Button>
            </Form>
          ) : null}
          <Form spacing="none" method="post">
            <HiddenInput type="hidden" name="intent" value="refresh-payout-setup" />
            <Button type="submit" tone="secondary">
              {t("settlement.features.payoutReadiness.ui.payoutReadinessPanel.check.setup.status")}
            </Button>
          </Form>
        </Inline>
      ) : null}
    </Stack>
  );
}
