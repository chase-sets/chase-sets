import type { ReactNode } from "react";
import { formatDateTime, t } from "@chase-sets/localization";
import {
  AlertDialog,
  Badge,
  Banner,
  Button,
  KeyValueList,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
} from "@chase-sets/design-system";
import type { RepricingActivityFilter } from "../../repricing-engine/api/activity";
import type { RepricingHaltState } from "../domain/halt";
import type { RepricingPolicyState } from "../domain/domain";
import { PricingRepricingActivityPanel, type RepricingActivityPanelPage } from "./policy-activity-panel";
import {
  formatRepricingCount,
  repricingBudgetLabel,
  repricingScopeLabel,
  repricingStatusBadge,
  summarizeRepricingRule,
} from "./policy-copy";
import { RepricingCatchingUpBanner, RepricingHaltControl, RepricingLifecycleButton } from "./policy-list-page";

export const REPRICING_POLICY_LIST_HREF = "/account/desk/repricing";

// Shown instead of the policy while a just-saved change is still reaching it.
export function PricingRepricingPolicyCatchingUpPage({ refreshHref }: Readonly<{ refreshHref: string }>) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("pricing.features.repricingPolicies.ui.policyDetail.eyebrow")}
        title={t("pricing.features.repricingPolicies.ui.shared.catchingUp.title")}
        actions={
          <LinkButton href={REPRICING_POLICY_LIST_HREF} tone="ghost">
            {t("pricing.features.repricingPolicies.ui.policyDetail.back")}
          </LinkButton>
        }
      />
      <RepricingCatchingUpBanner
        href={refreshHref}
        description={t("pricing.features.repricingPolicies.ui.policyDetail.catchingUp.description")}
      />
    </Page>
  );
}

// The folded policy, read-only. `editAction` is the reserved header slot the
// policy editor (#7915) fills; this page renders no editing affordance itself.
export function PricingRepricingPolicyDetailPage({
  policy,
  halt,
  changesUsedToday,
  activity,
  activityFilter,
  loading = false,
  activityLoading = false,
  activityLoadFailed = false,
  errorMessage = null,
  busy = false,
  editAction,
  onHaltChange,
  onPause,
  onResume,
  onDelete,
  onActivityFilterChange,
  onActivityNext,
}: {
  policy: RepricingPolicyState;
  halt: RepricingHaltState;
  changesUsedToday: number;
  activity: RepricingActivityPanelPage | null;
  activityFilter: RepricingActivityFilter | null;
  loading?: boolean;
  activityLoading?: boolean;
  activityLoadFailed?: boolean;
  errorMessage?: string | null;
  busy?: boolean;
  editAction?: ReactNode;
  onHaltChange: (engaged: boolean) => void;
  onPause: (policyId: string) => void;
  onResume: (policyId: string) => void;
  onDelete: (policyId: string) => void;
  onActivityFilterChange: (filter: RepricingActivityFilter | null) => void;
  onActivityNext: (cursor: string) => void;
}) {
  const policyId = policy.policyId ?? "";
  const badge = repricingStatusBadge(policy.status, halt.engaged);
  const deletable = policy.status !== "deleted";

  return (
    <Page>
      <PageHeader
        eyebrow={t("pricing.features.repricingPolicies.ui.policyDetail.eyebrow")}
        title={policy.name ?? t("pricing.features.repricingPolicies.ui.policyList.unnamed")}
        description={<Badge tone={badge.tone}>{badge.label}</Badge>}
        actions={
          <>
            <LinkButton href={REPRICING_POLICY_LIST_HREF} tone="ghost">
              {t("pricing.features.repricingPolicies.ui.policyDetail.back")}
            </LinkButton>
            {editAction}
            <RepricingLifecycleButton
              policyId={policyId}
              status={policy.status}
              busy={busy}
              onPause={onPause}
              onResume={onResume}
            />
            {deletable ? (
              <AlertDialog
                tone="danger"
                trigger={
                  <Button tone="danger" size="sm" disabled={busy}>
                    {t("pricing.features.repricingPolicies.ui.policyDetail.delete")}
                  </Button>
                }
                title={t("pricing.features.repricingPolicies.ui.policyDetail.delete.title")}
                description={t("pricing.features.repricingPolicies.ui.policyDetail.delete.description")}
                confirmLabel={t("pricing.features.repricingPolicies.ui.policyDetail.delete.confirm")}
                cancelLabel={t("pricing.features.repricingPolicies.ui.shared.cancel")}
                onConfirm={() => onDelete(policyId)}
              />
            ) : null}
          </>
        }
      />
      <Stack gap={6}>
        {errorMessage ? (
          <Banner
            tone="danger"
            role="alert"
            title={t("pricing.features.repricingPolicies.ui.shared.actionError.title")}
            description={errorMessage}
          />
        ) : null}
        <RepricingHaltControl halt={halt} disabled={loading || busy} onHaltChange={onHaltChange} />
        <PageSection
          title={t("pricing.features.repricingPolicies.ui.policyDetail.settings.title")}
          description={t("pricing.features.repricingPolicies.ui.policyDetail.settings.description")}
        >
          <KeyValueList
            data-testid="repricing-policy-settings"
            aria-busy={loading || undefined}
            layout="split"
            variant="surface"
            items={[
              { key: t("pricing.features.repricingPolicies.ui.policyDetail.field.status"), value: badge.label },
              {
                key: t("pricing.features.repricingPolicies.ui.policyDetail.field.scope"),
                value: repricingScopeLabel(policy.scope),
              },
              {
                key: t("pricing.features.repricingPolicies.ui.policyDetail.field.exclusions"),
                value: formatRepricingCount(policy.excludedListingIds.length),
              },
              {
                key: t("pricing.features.repricingPolicies.ui.policyDetail.field.cap"),
                value:
                  policy.maxChangesPerDay === null
                    ? t("pricing.features.repricingPolicies.ui.policyDetail.field.cap.none")
                    : formatRepricingCount(policy.maxChangesPerDay),
              },
              {
                key: t("pricing.features.repricingPolicies.ui.policyDetail.field.budget"),
                value: repricingBudgetLabel(changesUsedToday, policy.maxChangesPerDay),
              },
              {
                key: t("pricing.features.repricingPolicies.ui.policyDetail.field.updated"),
                value: policy.updatedAt ? formatDateTime(policy.updatedAt) : "",
              },
            ]}
          />
        </PageSection>
        <PageSection
          title={t("pricing.features.repricingPolicies.ui.policyDetail.rules.title")}
          description={t("pricing.features.repricingPolicies.ui.policyDetail.rules.description")}
        >
          <Stack gap={4} data-testid="repricing-policy-rules">
            {policy.rules.map((rule, index) => {
              const summary = summarizeRepricingRule(rule, index);
              return (
                <Stack key={index} gap={2}>
                  <Badge tone="neutral" variant="outline">
                    {summary.title}
                  </Badge>
                  <KeyValueList layout="split" variant="surface" items={[...summary.items]} />
                </Stack>
              );
            })}
          </Stack>
        </PageSection>
        <PricingRepricingActivityPanel
          page={activity}
          selectedFilter={activityFilter}
          ruleCurrencies={policy.rules.map((rule) => rule.directive.currencyCode)}
          loading={activityLoading}
          loadFailed={activityLoadFailed}
          onFilterChange={onActivityFilterChange}
          onNext={onActivityNext}
        />
      </Stack>
    </Page>
  );
}
