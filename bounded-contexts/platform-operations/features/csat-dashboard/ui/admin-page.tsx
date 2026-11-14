import { formatDateTime, t } from "@chase-sets/localization";
import { useRef, useState } from "react";
import { useMatches } from "react-router";
import {
  ActionBar,
  Badge,
  Button,
  DataTable,
  DateInput,
  HiddenInput,
  FilterBar,
  Form,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Text,
} from "@chase-sets/design-system";
import type {
  CsatAdminQueueItem,
  CsatAdminQueueFilters,
  CsatAdminQueuePage,
  CsatAnalyticsSnapshot,
} from "../../../support/request-support/customer-feedback-csat";
import { createExperienceApiClient } from "../../../support/request-support/platform-feedback-client";

type DashboardData = Readonly<{
  analytics: CsatAnalyticsSnapshot;
  queue: CsatAdminQueuePage;
  filters: CsatAdminQueueFilters;
}>;

const allItem = [{ value: "", label: t("experience.csatAdmin.all") }];
const stateItems = [
  ...allItem,
  { value: "eligible", label: t("experience.csatAdmin.eligible") },
  { value: "issued", label: t("experience.csatAdmin.issued") },
  { value: "presented", label: t("experience.csatAdmin.presented") },
  { value: "submitted", label: t("experience.csatAdmin.submitted") },
  { value: "dismissed", label: t("experience.csatAdmin.dismissed") },
  { value: "expired", label: t("experience.csatAdmin.expired") },
];
const ratingItems = [...allItem, ...[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))];
const roleItems = [
  ...allItem,
  { value: "buyer", label: t("experience.csatAdmin.buyer") },
  { value: "seller", label: t("experience.csatAdmin.seller") },
  { value: "account", label: t("experience.csatAdmin.accountRole") },
  { value: "visitor", label: t("experience.csatAdmin.visitor") },
];
const consentItems = [
  ...allItem,
  { value: "granted", label: t("experience.csatAdmin.granted") },
  { value: "not-granted", label: t("experience.csatAdmin.notGranted") },
];
const surveyItems = [...allItem, { value: "csat.v1", label: t("experience.csatAdmin.versionV1") }];
const outcomeItems = [
  ...allItem,
  { value: "checkout.completed", label: t("experience.csatAdmin.outcome.checkoutCompleted") },
  { value: "checkout.recovered", label: t("experience.csatAdmin.outcome.checkoutRecovered") },
  { value: "order.delivered", label: t("experience.csatAdmin.outcome.orderDelivered") },
  { value: "return.resolved", label: t("experience.csatAdmin.outcome.returnResolved") },
  { value: "support.request-resolved", label: t("experience.csatAdmin.outcome.supportResolved") },
  { value: "reputation.review-received", label: t("experience.csatAdmin.outcome.reviewReceived") },
  { value: "listing.published", label: t("experience.csatAdmin.outcome.listingPublished") },
  { value: "offer.accepted", label: t("experience.csatAdmin.outcome.offerAccepted") },
  { value: "inventory.item-adjusted", label: t("experience.csatAdmin.outcome.inventoryAdjusted") },
  { value: "payout.completed", label: t("experience.csatAdmin.outcome.payoutCompleted") },
  { value: "discovery.search-completed", label: t("experience.csatAdmin.outcome.discoveryCompleted") },
  { value: "registration.completed", label: t("experience.csatAdmin.outcome.registrationCompleted") },
  { value: "authentication.completed", label: t("experience.csatAdmin.outcome.authenticationCompleted") },
  { value: "onboarding.completed", label: t("experience.csatAdmin.outcome.onboardingCompleted") },
];
const stateLabels = Object.fromEntries(stateItems.map((item) => [item.value, item.label]));
const outcomeLabels = Object.fromEntries(outcomeItems.map((item) => [item.value, item.label]));

function actorHasPermission(matches: readonly unknown[], permission: string) {
  return matches.some((match) => {
    const data = match && typeof match === "object" && "data" in match ? match.data : null;
    const actor = data && typeof data === "object" && "actor" in data ? data.actor : null;
    return actor && typeof actor === "object" && "permissions" in actor && Array.isArray(actor.permissions)
      ? actor.permissions.includes(permission)
      : false;
  });
}

function metricValue(value: number | null, availability: string) {
  if (value === null) {
    const key =
      availability === "insufficient-sample"
        ? "insufficientSample"
        : availability === "zero-denominator"
          ? "zeroDenominator"
          : availability;
    return t(`experience.csatAdmin.${key}`);
  }
  return `${Math.round(value * 100)}%`;
}

function queryWith(data: DashboardData, values: Record<string, string | null>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(data.filters)) {
    if (typeof value === "string" && value) query.set(key, value);
    if (Array.isArray(value) && value.length > 0) query.set(key, value.join(","));
    if (key === "surveyVersion" && value && typeof value === "object" && "surveyVersion" in value) {
      query.set("surveyVersion", String(value.surveyVersion));
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
    else query.delete(key);
  }
  return `?${query.toString()}`;
}

function queueState(item: CsatAdminQueueItem) {
  return stateLabels[item.state] ?? item.state;
}

function queueOutcome(item: CsatAdminQueueItem) {
  return outcomeLabels[item.outcomeCode] ?? item.outcomeCode;
}

function queueSurveyVersion(item: CsatAdminQueueItem) {
  return item.surveyVersion.surveyVersion === "csat.v1"
    ? t("experience.csatAdmin.versionV1")
    : item.surveyVersion.surveyVersion;
}

export function CsatAdminPage({ data }: { data: DashboardData }) {
  const matches = useMatches();
  const canExport = actorHasPermission(matches, "customer-feedback.privacy.export-sensitive-feedback");
  const [reason, setReason] = useState("");
  const [exportState, setExportState] = useState<"idle" | "pending" | "completed" | "failed">("idle");
  const exportPending = useRef(false);
  const seven = data.analytics.windows["trailing-7d"];
  const thirty = data.analytics.windows["trailing-30d"];
  const distribution = Object.entries(thirty.ratingDistribution).map(([rating, count]) => ({ rating, count }));
  async function exportCsv() {
    if (!reason || exportPending.current) return;
    exportPending.current = true;
    setExportState("pending");
    try {
      const api = createExperienceApiClient();
      const created = await api.createCsatExport(queryWith(data, { reason }).slice(1));
      const csv = await api.downloadCsatExport(created.exportId);
      const href = URL.createObjectURL(csv);
      try {
        const link = document.createElement("a");
        link.href = href;
        link.download = "customer-feedback-export.csv";
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(href);
      }
      setExportState("completed");
    } catch {
      setExportState("failed");
    } finally {
      exportPending.current = false;
    }
  }

  return (
    <Page>
      <PageHeader
        eyebrow={t("experience.csatAdmin.eyebrow")}
        title={t("experience.csatAdmin.title")}
        description={t("experience.csatAdmin.description")}
      />
      <StatGrid columns={{ base: 1, sm: 2, xl: 4 }}>
        <Stat label={t("experience.csatAdmin.csat7")} value={metricValue(seven.csat, seven.csatAvailability)} />
        <Stat label={t("experience.csatAdmin.csat30")} value={metricValue(thirty.csat, thirty.csatAvailability)} />
        <Stat
          label={t("experience.csatAdmin.response7")}
          value={metricValue(seven.responseRate, seven.responseRateAvailability)}
        />
        <Stat
          label={t("experience.csatAdmin.response30")}
          value={metricValue(thirty.responseRate, thirty.responseRateAvailability)}
        />
      </StatGrid>
      <StatGrid columns={{ base: 1, sm: 2 }}>
        <Stat label={t("experience.csatAdmin.submitted")} value={thirty.volume.submitted} />
        <Stat label={t("experience.csatAdmin.presented")} value={thirty.volume.presented} />
      </StatGrid>

      <PageSection title={t("experience.csatAdmin.filters")}>
        <Form method="get" spacing="none">
          <Stack gap={3}>
            <FilterBar sticky={false}>
              <HiddenInput type="hidden" name="asOf" value={data.analytics.asOf} readOnly />
              <DateInput
                label={t("experience.csatAdmin.from")}
                name="from"
                defaultValue={data.filters.from?.slice(0, 10)}
              />
              <DateInput label={t("experience.csatAdmin.to")} name="to" defaultValue={data.filters.to?.slice(0, 10)} />
              <NativeSelect
                label={t("experience.csatAdmin.surveyVersion")}
                name="surveyVersion"
                items={surveyItems}
                defaultValue={data.filters.surveyVersion?.surveyVersion ?? ""}
              />
              <NativeSelect
                label={t("experience.csatAdmin.outcome")}
                name="outcomeCodes"
                items={outcomeItems}
                defaultValue={data.filters.outcomeCodes?.[0] ?? ""}
              />
              <NativeSelect
                label={t("experience.csatAdmin.role")}
                name="customerRoles"
                items={roleItems}
                defaultValue={data.filters.customerRoles?.[0] ?? ""}
              />
              <NativeSelect
                label={t("experience.csatAdmin.state")}
                name="states"
                items={stateItems}
                defaultValue={data.filters.states?.[0] ?? ""}
              />
              <NativeSelect
                label={t("experience.csatAdmin.rating")}
                name="ratings"
                items={ratingItems}
                defaultValue={data.filters.ratings?.[0] ? String(data.filters.ratings[0]) : ""}
              />
              <NativeSelect
                label={t("experience.csatAdmin.consent")}
                name="followUpConsent"
                items={consentItems}
                defaultValue={data.filters.followUpConsent ?? ""}
              />
            </FilterBar>
            <ActionBar>
              <Button type="submit" leadingIcon="filter">
                {t("experience.csatAdmin.apply")}
              </Button>
            </ActionBar>
          </Stack>
        </Form>
        {canExport ? (
          <Stack gap={3}>
            <NativeSelect
              label={t("experience.csatAdmin.exportReason")}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              disabled={exportState === "pending"}
              items={[
                { value: "", label: t("experience.csatAdmin.chooseExportReason") },
                { value: "case-review", label: t("experience.csatAdmin.caseReview") },
                { value: "quality-review", label: t("experience.csatAdmin.qualityReview") },
              ]}
            />
            <ActionBar>
              <Button
                type="button"
                tone="secondary"
                leadingIcon="externalLink"
                disabled={!reason || exportState === "pending"}
                onClick={() => void exportCsv()}
              >
                {t("experience.csatAdmin.export")}
              </Button>
              <Text role="status" aria-label={t("experience.csatAdmin.export")} aria-live="polite">
                {exportState === "idle" ? "" : t(`experience.csatAdmin.exportState.${exportState}`)}
              </Text>
            </ActionBar>
          </Stack>
        ) : null}
      </PageSection>

      <PageSection title={t("experience.csatAdmin.trend")}>
        <DataTable
          rows={[...data.analytics.trend.items]}
          columns={[
            { key: "bucket", header: t("experience.csatAdmin.bucket"), cell: (row) => formatDateTime(row.bucketStart) },
            {
              key: "csat",
              header: t("experience.csatAdmin.csat"),
              cell: (row) => metricValue(row.csat, row.csatAvailability),
            },
            {
              key: "response",
              header: t("experience.csatAdmin.responseRate"),
              cell: (row) => metricValue(row.responseRate, row.responseRateAvailability),
            },
            { key: "submitted", header: t("experience.csatAdmin.submitted"), cell: (row) => row.volume.submitted },
          ]}
          getRowId={(row) => row.bucketStart}
          emptyTitle={t("experience.csatAdmin.emptyTitle")}
          emptyDescription={t("experience.csatAdmin.emptyDescription")}
        />
      </PageSection>

      <PageSection title={t("experience.csatAdmin.distribution")}>
        <DataTable
          rows={distribution}
          columns={[
            { key: "rating", header: t("experience.csatAdmin.rating"), cell: (row) => row.rating },
            { key: "count", header: t("experience.csatAdmin.count"), cell: (row) => row.count },
          ]}
          getRowId={(row) => row.rating}
        />
      </PageSection>

      <PageSection title={t("experience.csatAdmin.queue")}>
        <DataTable
          rows={[...data.queue.items]}
          columns={[
            { key: "invitation", header: t("experience.csatAdmin.invitation"), cell: (row) => row.invitationId },
            {
              key: "state",
              header: t("experience.csatAdmin.state"),
              cell: (row) => <Badge tone="neutral">{queueState(row)}</Badge>,
            },
            {
              key: "version",
              header: t("experience.csatAdmin.version"),
              cell: queueSurveyVersion,
            },
            { key: "outcome", header: t("experience.csatAdmin.outcome"), cell: queueOutcome },
            {
              key: "rating",
              header: t("experience.csatAdmin.rating"),
              cell: (row) => row.rating ?? t("experience.csatAdmin.notAvailable"),
            },
            {
              key: "submitted",
              header: t("experience.csatAdmin.submission"),
              cell: (row) =>
                row.submittedAt ? formatDateTime(row.submittedAt) : t("experience.csatAdmin.notAvailable"),
            },
          ]}
          getRowId={(row) => row.invitationId}
          emptyTitle={t("experience.csatAdmin.emptyTitle")}
          emptyDescription={t("experience.csatAdmin.emptyDescription")}
        />
        <ActionBar>
          {data.queue.previousCursor ? (
            <LinkButton
              href={queryWith(data, { cursor: data.queue.previousCursor, direction: "previous" })}
              tone="secondary"
            >
              {t("experience.csatAdmin.previous")}
            </LinkButton>
          ) : null}
          {data.queue.nextCursor ? (
            <LinkButton href={queryWith(data, { cursor: data.queue.nextCursor, direction: "next" })}>
              {t("experience.csatAdmin.next")}
            </LinkButton>
          ) : null}
        </ActionBar>
      </PageSection>

      <PageSection title={t("experience.csatAdmin.dataQuality")}>
        <Text tone="secondary">
          {t("experience.csatAdmin.lastProjected")}:{" "}
          {data.analytics.health.lastProjectedAt
            ? formatDateTime(data.analytics.health.lastProjectedAt)
            : t("experience.csatAdmin.incomplete")}
        </Text>
        <Text tone="secondary">{t("experience.csatAdmin.safeExport")}</Text>
      </PageSection>
    </Page>
  );
}
