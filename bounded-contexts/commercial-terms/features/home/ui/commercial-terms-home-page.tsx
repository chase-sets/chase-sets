import { useState } from "react";
import { useNavigate } from "react-router";
import { formatBpsPercent, formatMoney, t } from "@chase-sets/localization";
import {
  AutoGrid,
  Badge,
  Banner,
  Button,
  Card,
  ComparisonModule,
  HiddenInput,
  KeyValueList,
  LinkButton,
  NativeSelect,
  NumberField,
  Page,
  PageHeader,
  PageSection,
  ResponsiveEditSheet,
  Stack,
  Text,
  TextInput,
  Timeline,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import type {
  CommercialAgreement,
  CommercialTermsAccountOption,
  CommercialTermsHistoryItem,
  CommercialTermsSchedule,
  PublishedMarketplaceSalesFeeSchedule,
} from "../integrations/admin-api-client";
import type { CommercialTermsHome, CommercialTermsHomeTerm, CommercialTermsStartingTerms } from "../api/home-read";

export type CommercialTermsCreateKind = "schedule" | "agreement";

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function accountLabel(agreement: CommercialAgreement) {
  const name = agreement.account_name?.trim();
  const displayName = agreement.account_display_name?.trim();
  return name && displayName ? `${name} (${displayName})` : name || displayName || agreement.account_id;
}

function policySource(schedule: PublishedMarketplaceSalesFeeSchedule) {
  return schedule.source === "policy"
    ? t("commercialTerms.features.home.publishedPolicy")
    : t("commercialTerms.features.home.fallbackPolicy");
}

function PublishedScheduleCard({ schedule }: Readonly<{ schedule: PublishedMarketplaceSalesFeeSchedule }>) {
  const { value } = schedule;
  return (
    <Card data-published-schedule elevation="elevated">
      <Card.Header>
        <Stack gap={1}>
          <Badge tone={schedule.source === "policy" ? "success" : "warning"}>{policySource(schedule)}</Badge>
          <Card.Title>{value.label}</Card.Title>
        </Stack>
      </Card.Header>
      <Card.Body>
        <KeyValueList
          items={[
            {
              key: t("commercialTerms.features.home.marketplaceFee"),
              value: `${formatBpsPercent(value.marketplaceSalesFeePercentageBps)} + ${formatMoney(value.marketplaceSalesFeeFixedAmount, "USD")}`,
            },
            {
              key: t("commercialTerms.features.home.marketplaceFeeCap"),
              value: formatMoney(value.marketplaceSalesFeeCapAmount, "USD"),
            },
            {
              key: t("commercialTerms.features.home.shippingAllowance"),
              value: formatBpsPercent(value.shippingAllowancePercentageBps),
            },
            {
              key: t("commercialTerms.features.home.effectiveFrom"),
              value: schedule.effectiveFrom
                ? dateOnly(schedule.effectiveFrom)
                : t("commercialTerms.features.home.none"),
            },
          ]}
        />
      </Card.Body>
    </Card>
  );
}

function termAttention(term: CommercialTermsHomeTerm) {
  const date = dateOnly(term.phaseAt);
  if (term.phase === "scheduled") return t("commercialTerms.features.home.effective", { date });
  if (term.phase === "expiring") return t("commercialTerms.features.home.overrideExpires", { date });
  return t("commercialTerms.features.home.effectiveSince", { date });
}

function CommercialTermCardView({ term }: Readonly<{ term: CommercialTermsHomeTerm }>) {
  const item = term.item;
  const href =
    term.kind === "schedule"
      ? `/commerce/terms?schedule=${encodeURIComponent(term.id)}`
      : `/commerce/terms?agreement=${encodeURIComponent(term.id)}`;
  const subtitle =
    term.kind === "schedule"
      ? t("commercialTerms.features.home.scheduleFor", { accountType: item.account_type })
      : accountLabel(term.item);

  return (
    <Card data-commercial-term-id={term.id} elevation="elevated">
      <Card.Header>
        <Stack gap={1}>
          <Badge tone={term.phase === "scheduled" ? "warning" : "success"}>{item.status}</Badge>
          <Card.Title>{item.label}</Card.Title>
          <Card.Description>{subtitle}</Card.Description>
          {term.kind === "agreement" ? (
            <Text size="sm" tone="secondary">
              {term.item.account_id}
            </Text>
          ) : null}
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap={2}>
          <Text weight="semibold">{termAttention(term)}</Text>
          <Text size="sm" tone="secondary">
            {formatBpsPercent(item.marketplace_sales_fee_percentage_bps)} +{" "}
            {formatMoney(item.marketplace_sales_fee_fixed_amount, "USD")}
          </Text>
          <LinkButton href={href} tone="secondary" size="sm">
            {t("commercialTerms.features.home.review")}
          </LinkButton>
        </Stack>
      </Card.Body>
    </Card>
  );
}

function RevisionHistory({ history }: Readonly<{ history?: readonly CommercialTermsHistoryItem[] }>) {
  return (
    <Stack gap={2}>
      <Text weight="semibold">{t("commercialTerms.features.home.revisionHistory")}</Text>
      {history?.length ? (
        <Timeline
          items={history.map((item) => ({
            title: t("commercialTerms.features.home.historyEventStatus", {
              eventType: item.event_type,
              status: item.status,
            }),
            description: t("commercialTerms.features.home.historyActor", { actor: item.actor_user_id }),
            timestamp: item.recorded_at,
          }))}
        />
      ) : (
        <Text tone="secondary">{t("commercialTerms.features.home.noRevisionHistory")}</Text>
      )}
    </Stack>
  );
}

function TermsFields({
  item,
  submitLabel,
}: Readonly<{
  item: Readonly<{
    label: string;
    marketplace_sales_fee_percentage_bps: number;
    marketplace_sales_fee_fixed_amount: string;
    shipping_allowance_percentage_bps: number;
    status: string;
    effective_from: string;
    effective_until: string | null;
  }>;
  submitLabel: string;
}>) {
  return (
    <Stack gap={3}>
      <TextInput label={t("commercialTerms.features.home.label")} name="label" defaultValue={item.label} required />
      <NumberField
        label={t("commercialTerms.features.home.marketplaceFeeBps")}
        name="marketplaceSalesFeePercentageBps"
        min={0}
        max={10000}
        defaultValue={item.marketplace_sales_fee_percentage_bps}
        required
      />
      <TextInput
        label={t("commercialTerms.features.home.marketplaceFixedAmount")}
        name="marketplaceSalesFeeFixedAmount"
        inputMode="decimal"
        defaultValue={item.marketplace_sales_fee_fixed_amount}
        required
      />
      <NumberField
        label={t("commercialTerms.features.home.shippingAllowanceBps")}
        name="shippingAllowancePercentageBps"
        min={0}
        max={10000}
        defaultValue={item.shipping_allowance_percentage_bps}
        required
      />
      <NativeSelect
        label={t("commercialTerms.features.home.status")}
        name="status"
        defaultValue={item.status}
        items={[
          { value: "active", label: t("commercialTerms.features.home.active") },
          { value: "inactive", label: t("commercialTerms.features.home.inactive") },
        ]}
        required
      />
      <TextInput
        label={t("commercialTerms.features.home.effectiveFrom")}
        name="effectiveFrom"
        defaultValue={item.effective_from}
        required
      />
      <TextInput
        label={t("commercialTerms.features.home.effectiveUntil")}
        name="effectiveUntil"
        defaultValue={item.effective_until ?? ""}
      />
      <Button type="submit">{submitLabel}</Button>
    </Stack>
  );
}

function comparisonRows(
  active: Readonly<{
    label: string;
    marketplace_sales_fee_percentage_bps: number;
    marketplace_sales_fee_fixed_amount: string;
    shipping_allowance_percentage_bps: number;
    effective_from: string;
    effective_until: string | null;
  }> | null,
  candidate: Readonly<{
    label: string;
    marketplace_sales_fee_percentage_bps: number;
    marketplace_sales_fee_fixed_amount: string;
    shipping_allowance_percentage_bps: number;
    effective_from: string;
    effective_until: string | null;
  }>,
) {
  const none = t("commercialTerms.features.home.none");
  return [
    { label: t("commercialTerms.features.home.label"), values: [active?.label ?? none, candidate.label] },
    {
      label: t("commercialTerms.features.home.marketplaceFee"),
      values: [
        active
          ? `${formatBpsPercent(active.marketplace_sales_fee_percentage_bps)} + ${formatMoney(active.marketplace_sales_fee_fixed_amount, "USD")}`
          : none,
        `${formatBpsPercent(candidate.marketplace_sales_fee_percentage_bps)} + ${formatMoney(candidate.marketplace_sales_fee_fixed_amount, "USD")}`,
      ],
    },
    {
      label: t("commercialTerms.features.home.shippingAllowance"),
      values: [
        active ? formatBpsPercent(active.shipping_allowance_percentage_bps) : none,
        formatBpsPercent(candidate.shipping_allowance_percentage_bps),
      ],
    },
    {
      label: t("commercialTerms.features.home.effectiveWindow"),
      values: [
        active
          ? `${dateOnly(active.effective_from)} – ${active.effective_until ? dateOnly(active.effective_until) : none}`
          : none,
        `${dateOnly(candidate.effective_from)} – ${candidate.effective_until ? dateOnly(candidate.effective_until) : none}`,
      ],
    },
  ];
}

function ScheduleSheet({
  schedule,
  activeSchedule,
  onClose,
}: Readonly<{
  schedule: CommercialTermsSchedule;
  activeSchedule: CommercialTermsHome["scheduleComparison"];
  onClose: () => void;
}>) {
  return (
    <ResponsiveEditSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={schedule.label}
      description={t("commercialTerms.features.home.scheduleSheetDescription")}
      closeLabel={t("commercialTerms.features.home.closeSchedule")}
      desktopWidth="lg"
    >
      <Stack gap={5}>
        <KeyValueList
          variant="surface"
          items={[
            { key: t("commercialTerms.features.home.status"), value: <Badge>{schedule.status}</Badge> },
            { key: t("commercialTerms.features.home.accountType"), value: schedule.account_type },
            { key: t("commercialTerms.features.home.effectiveFrom"), value: schedule.effective_from },
            {
              key: t("commercialTerms.features.home.effectiveUntil"),
              value: schedule.effective_until ?? t("commercialTerms.features.home.openEnded"),
            },
          ]}
        />
        <ComparisonModule
          title={t("commercialTerms.features.home.compareActiveSchedule")}
          columns={[
            t("commercialTerms.features.home.activeSchedule"),
            t("commercialTerms.features.home.selectedRevision"),
          ]}
          signalLabel={t("commercialTerms.features.home.term")}
          rows={comparisonRows(activeSchedule, schedule)}
        />
        <RevisionHistory history={schedule.history} />
        <Stack gap={2}>
          <Text weight="semibold">{t("commercialTerms.features.home.reviseSchedule")}</Text>
          <RouterForm method="post" spacing="none">
            <HiddenInput name="intent" value="revise-schedule" readOnly />
            <HiddenInput name="id" value={schedule.schedule_id} readOnly />
            <TermsFields item={schedule} submitLabel={t("commercialTerms.features.home.saveScheduleRevision")} />
          </RouterForm>
        </Stack>
      </Stack>
    </ResponsiveEditSheet>
  );
}

function AgreementSheet({
  agreement,
  publishedSchedule,
  onClose,
}: Readonly<{
  agreement: CommercialAgreement;
  publishedSchedule: PublishedMarketplaceSalesFeeSchedule | null;
  onClose: () => void;
}>) {
  return (
    <ResponsiveEditSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={agreement.label}
      description={t("commercialTerms.features.home.agreementSheetDescription")}
      closeLabel={t("commercialTerms.features.home.closeAgreement")}
      desktopWidth="lg"
    >
      <Stack gap={5}>
        <KeyValueList
          variant="surface"
          items={[
            {
              key: t("commercialTerms.features.home.account"),
              value: (
                <Stack gap={1}>
                  <Text>{accountLabel(agreement)}</Text>
                  <Text size="sm" tone="secondary">
                    {agreement.account_id}
                  </Text>
                </Stack>
              ),
            },
            { key: t("commercialTerms.features.home.status"), value: <Badge>{agreement.status}</Badge> },
            { key: t("commercialTerms.features.home.effectiveFrom"), value: agreement.effective_from },
            {
              key: t("commercialTerms.features.home.effectiveUntil"),
              value: agreement.effective_until ?? t("commercialTerms.features.home.openEnded"),
            },
          ]}
        />
        {publishedSchedule ? (
          <ComparisonModule
            title={t("commercialTerms.features.home.comparePublishedSchedule")}
            columns={[policySource(publishedSchedule), t("commercialTerms.features.home.accountOverride")]}
            signalLabel={t("commercialTerms.features.home.term")}
            rows={[
              {
                label: t("commercialTerms.features.home.label"),
                values: [publishedSchedule.value.label, agreement.label],
              },
              {
                label: t("commercialTerms.features.home.marketplaceFee"),
                values: [
                  `${formatBpsPercent(publishedSchedule.value.marketplaceSalesFeePercentageBps)} + ${formatMoney(publishedSchedule.value.marketplaceSalesFeeFixedAmount, "USD")}`,
                  `${formatBpsPercent(agreement.marketplace_sales_fee_percentage_bps)} + ${formatMoney(agreement.marketplace_sales_fee_fixed_amount, "USD")}`,
                ],
              },
              {
                label: t("commercialTerms.features.home.shippingAllowance"),
                values: [
                  formatBpsPercent(publishedSchedule.value.shippingAllowancePercentageBps),
                  formatBpsPercent(agreement.shipping_allowance_percentage_bps),
                ],
              },
              {
                label: t("commercialTerms.features.home.marketplaceFeeCap"),
                values: [
                  formatMoney(publishedSchedule.value.marketplaceSalesFeeCapAmount, "USD"),
                  t("commercialTerms.features.home.none"),
                ],
              },
              {
                label: t("commercialTerms.features.home.effectiveFrom"),
                values: [
                  publishedSchedule.effectiveFrom
                    ? dateOnly(publishedSchedule.effectiveFrom)
                    : t("commercialTerms.features.home.none"),
                  dateOnly(agreement.effective_from),
                ],
              },
            ]}
          />
        ) : null}
        <RevisionHistory history={agreement.history} />
        <Stack gap={2}>
          <Text weight="semibold">{t("commercialTerms.features.home.reviseOverride")}</Text>
          <RouterForm method="post" spacing="none">
            <HiddenInput name="intent" value="revise-agreement" readOnly />
            <HiddenInput name="id" value={agreement.agreement_id} readOnly />
            <TermsFields item={agreement} submitLabel={t("commercialTerms.features.home.saveAccountOverride")} />
          </RouterForm>
        </Stack>
      </Stack>
    </ResponsiveEditSheet>
  );
}

function CreateScheduleSheet({
  startingTerms,
  onClose,
}: Readonly<{ startingTerms: CommercialTermsStartingTerms; onClose: () => void }>) {
  const seed = { ...startingTerms, label: startingTerms.label ?? t("commercialTerms.features.home.newSchedule") };
  return (
    <ResponsiveEditSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("commercialTerms.features.home.createSchedule")}
      closeLabel={t("commercialTerms.features.home.closeCreateSchedule")}
    >
      <RouterForm method="post" spacing="none">
        <Stack gap={3}>
          <HiddenInput name="intent" value="create-schedule" readOnly />
          <NativeSelect
            label={t("commercialTerms.features.home.accountType")}
            name="accountType"
            defaultValue="business"
            items={[
              { value: "personal", label: t("commercialTerms.features.home.personal") },
              { value: "business", label: t("commercialTerms.features.home.business") },
              { value: "enterprise", label: t("commercialTerms.features.home.enterprise") },
            ]}
            required
          />
          <TermsFields item={seed} submitLabel={t("commercialTerms.features.home.saveSchedule")} />
        </Stack>
      </RouterForm>
    </ResponsiveEditSheet>
  );
}

function overrideStartingTerms(
  startingTerms: CommercialTermsHome["startingTerms"]["override"],
  accountType: string | undefined,
) {
  return accountType === "personal" || accountType === "business" || accountType === "enterprise"
    ? startingTerms[accountType]
    : startingTerms.default;
}

function CreateAgreementSheet({
  startingTerms,
  accounts,
  initialAccountId,
  onClose,
}: Readonly<{
  startingTerms: CommercialTermsHome["startingTerms"]["override"];
  accounts: readonly CommercialTermsAccountOption[];
  initialAccountId?: string | null;
  onClose: () => void;
}>) {
  const firstAccountId = accounts.some((item) => item.accountId === initialAccountId)
    ? (initialAccountId ?? "")
    : (accounts[0]?.accountId ?? "");
  const [accountId, setAccountId] = useState(firstAccountId);
  const account = accounts.find((item) => item.accountId === accountId);
  const accountStartingTerms = overrideStartingTerms(startingTerms, account?.accountType);
  const seed = {
    ...accountStartingTerms,
    label: accountStartingTerms.label ?? t("commercialTerms.features.home.newOverride"),
  };

  return (
    <ResponsiveEditSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("commercialTerms.features.home.createAccountOverride")}
      description={t("commercialTerms.features.home.createAccountOverrideDescription")}
      closeLabel={t("commercialTerms.features.home.closeCreateOverride")}
      desktopWidth="lg"
    >
      <RouterForm method="post" spacing="none">
        <Stack gap={3}>
          <HiddenInput name="intent" value="create-agreement" readOnly />
          <NativeSelect
            label={t("commercialTerms.features.home.account")}
            name="accountId"
            value={accountId}
            onChange={(event) => setAccountId(event.currentTarget.value)}
            items={accounts.map((item) => ({
              value: item.accountId,
              label: t("commercialTerms.features.home.accountOption", {
                displayName: item.displayName,
                accountType: item.accountType,
              }),
            }))}
            required
          />
          <Stack key={accountId} gap={3}>
            <TermsFields item={seed} submitLabel={t("commercialTerms.features.home.saveAccountOverride")} />
          </Stack>
        </Stack>
      </RouterForm>
    </ResponsiveEditSheet>
  );
}

export function CommercialTermsHomePage({
  publishedSchedule,
  home,
  accounts,
  selectedSchedule,
  selectedAgreement,
  createKind,
  initialAccountId,
  errorMessage,
  loadErrorMessage,
}: Readonly<{
  publishedSchedule: PublishedMarketplaceSalesFeeSchedule | null;
  home: CommercialTermsHome | null;
  accounts: readonly CommercialTermsAccountOption[];
  selectedSchedule?: CommercialTermsSchedule | null;
  selectedAgreement?: CommercialAgreement | null;
  createKind?: CommercialTermsCreateKind | null;
  initialAccountId?: string | null;
  errorMessage?: string | null;
  loadErrorMessage?: string | null;
}>) {
  const navigate = useNavigate();
  const closeSheet = () => navigate("/commerce/terms");

  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.home.eyebrow")}
        title={t("commercialTerms.features.home.title")}
        description={t("commercialTerms.features.home.description")}
        actions={
          <Stack direction="row" gap={2}>
            <LinkButton href="/commerce/terms?create=schedule" tone="secondary">
              {t("commercialTerms.features.home.createSchedule")}
            </LinkButton>
            <LinkButton href="/commerce/terms?create=agreement">
              {t("commercialTerms.features.home.createAccountOverride")}
            </LinkButton>
          </Stack>
        }
      />
      <Banner
        tone="warning"
        title={t("commercialTerms.features.home.feeLockTitle")}
        description={t("commercialTerms.features.home.feeLockDescription")}
      />
      {loadErrorMessage ? (
        <Banner tone="danger" title={t("commercialTerms.features.home.unavailable")} description={loadErrorMessage} />
      ) : null}
      {errorMessage ? (
        <Banner tone="danger" title={t("commercialTerms.features.home.changeRejected")} description={errorMessage} />
      ) : null}
      {publishedSchedule ? <PublishedScheduleCard schedule={publishedSchedule} /> : null}
      <PageSection title={t("commercialTerms.features.home.activeAndScheduled")}>
        <AutoGrid minItemWidth="md" gap={3}>
          {(home?.activeTerms ?? []).map((term) => (
            <CommercialTermCardView key={`${term.kind}:${term.id}`} term={term} />
          ))}
        </AutoGrid>
      </PageSection>

      {selectedSchedule ? (
        <ScheduleSheet
          schedule={selectedSchedule}
          activeSchedule={home?.scheduleComparison ?? null}
          onClose={closeSheet}
        />
      ) : null}
      {selectedAgreement ? (
        <AgreementSheet agreement={selectedAgreement} publishedSchedule={publishedSchedule} onClose={closeSheet} />
      ) : null}
      {createKind === "schedule" && home ? (
        <CreateScheduleSheet startingTerms={home.startingTerms.schedule} onClose={closeSheet} />
      ) : null}
      {createKind === "agreement" && home ? (
        <CreateAgreementSheet
          startingTerms={home.startingTerms.override}
          accounts={accounts}
          initialAccountId={initialAccountId}
          onClose={closeSheet}
        />
      ) : null}
    </Page>
  );
}
