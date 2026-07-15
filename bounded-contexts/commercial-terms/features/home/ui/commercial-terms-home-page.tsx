import { useMemo, useState } from "react";
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
} from "../integrations/admin-api-client";

type CommercialTermCard =
  | Readonly<{ kind: "schedule"; id: string; effectiveFrom: string; item: CommercialTermsSchedule }>
  | Readonly<{ kind: "agreement"; id: string; effectiveFrom: string; item: CommercialAgreement }>;

export type CommercialTermsCreateKind = "schedule" | "agreement";

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function isActiveWindow(
  item: Readonly<{ status: string; effective_from: string; effective_until: string | null }>,
  now: string,
) {
  return (
    item.status === "active" &&
    item.effective_from <= now &&
    (item.effective_until === null || item.effective_until > now)
  );
}

function activeScheduleFor(schedules: readonly CommercialTermsSchedule[], accountType: string | null, now: string) {
  return schedules
    .filter((item) => item.account_type === accountType && isActiveWindow(item, now))
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0];
}

function orderedCards(
  schedules: readonly CommercialTermsSchedule[],
  agreements: readonly CommercialAgreement[],
  now: string,
): readonly CommercialTermCard[] {
  return [
    ...schedules.map(
      (item): CommercialTermCard => ({
        kind: "schedule",
        id: item.schedule_id,
        effectiveFrom: item.effective_from,
        item,
      }),
    ),
    ...agreements.map(
      (item): CommercialTermCard => ({
        kind: "agreement",
        id: item.agreement_id,
        effectiveFrom: item.effective_from,
        item,
      }),
    ),
  ]
    .filter(({ item }) => item.status === "active" && (item.effective_until === null || item.effective_until > now))
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom) || left.id.localeCompare(right.id));
}

function cardAttention(card: CommercialTermCard, now: string) {
  if (card.effectiveFrom > now) {
    return t("commercialTerms.features.home.effective", { date: dateOnly(card.effectiveFrom) });
  }
  if (card.kind === "agreement" && card.item.effective_until && card.item.effective_until > now) {
    return t("commercialTerms.features.home.overrideExpires", { date: dateOnly(card.item.effective_until) });
  }
  return t("commercialTerms.features.home.effectiveSince", { date: dateOnly(card.effectiveFrom) });
}

function statusTone(status: string, effectiveFrom: string, now: string): "success" | "warning" | "neutral" {
  if (status !== "active") return "neutral";
  return effectiveFrom > now ? "warning" : "success";
}

function CommercialTermCardView({ card, now }: Readonly<{ card: CommercialTermCard; now: string }>) {
  const item = card.item;
  const href =
    card.kind === "schedule"
      ? `/commerce/terms?schedule=${encodeURIComponent(card.id)}`
      : `/commerce/terms?agreement=${encodeURIComponent(card.id)}`;
  const subtitle =
    card.kind === "schedule"
      ? t("commercialTerms.features.home.scheduleFor", { accountType: item.account_type })
      : (card.item.account_display_name ?? card.item.account_id);

  return (
    <Card data-commercial-term-id={card.id}>
      <Card.Header>
        <Stack gap={1}>
          <Badge tone={statusTone(item.status, item.effective_from, now)}>{item.status}</Badge>
          <Card.Title>{item.label}</Card.Title>
          <Card.Description>{subtitle}</Card.Description>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap={2}>
          <Text weight="semibold">{cardAttention(card, now)}</Text>
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
  active:
    | Readonly<{
        label: string;
        marketplace_sales_fee_percentage_bps: number;
        marketplace_sales_fee_fixed_amount: string;
        shipping_allowance_percentage_bps: number;
        effective_from: string;
        effective_until: string | null;
      }>
    | undefined,
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
  activeSchedule?: CommercialTermsSchedule;
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
  activeSchedule,
  onClose,
}: Readonly<{
  agreement: CommercialAgreement;
  activeSchedule?: CommercialTermsSchedule;
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
              value: agreement.account_display_name ?? agreement.account_id,
            },
            { key: t("commercialTerms.features.home.status"), value: <Badge>{agreement.status}</Badge> },
            { key: t("commercialTerms.features.home.effectiveFrom"), value: agreement.effective_from },
            {
              key: t("commercialTerms.features.home.effectiveUntil"),
              value: agreement.effective_until ?? t("commercialTerms.features.home.openEnded"),
            },
          ]}
        />
        <ComparisonModule
          title={t("commercialTerms.features.home.compareActiveSchedule")}
          columns={[
            t("commercialTerms.features.home.activeSchedule"),
            t("commercialTerms.features.home.accountOverride"),
          ]}
          signalLabel={t("commercialTerms.features.home.term")}
          rows={comparisonRows(activeSchedule, agreement)}
        />
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
  schedules,
  now,
  onClose,
}: Readonly<{ schedules: readonly CommercialTermsSchedule[]; now: string; onClose: () => void }>) {
  const seed = activeScheduleFor(schedules, "business", now) ?? {
    label: t("commercialTerms.features.home.newSchedule"),
    marketplace_sales_fee_percentage_bps: 850,
    marketplace_sales_fee_fixed_amount: "0.10",
    shipping_allowance_percentage_bps: 500,
    status: "active",
    effective_from: now,
    effective_until: null,
  };
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

function CreateAgreementSheet({
  schedules,
  accounts,
  initialAccountId,
  now,
  onClose,
}: Readonly<{
  schedules: readonly CommercialTermsSchedule[];
  accounts: readonly CommercialTermsAccountOption[];
  initialAccountId?: string | null;
  now: string;
  onClose: () => void;
}>) {
  const firstAccountId = accounts.some((item) => item.accountId === initialAccountId)
    ? (initialAccountId ?? "")
    : (accounts[0]?.accountId ?? "");
  const [accountId, setAccountId] = useState(firstAccountId);
  const account = accounts.find((item) => item.accountId === accountId);
  const schedule = activeScheduleFor(schedules, account?.accountType ?? null, now);
  const seed = schedule ?? {
    label: t("commercialTerms.features.home.newOverride"),
    marketplace_sales_fee_percentage_bps: 850,
    marketplace_sales_fee_fixed_amount: "0.10",
    shipping_allowance_percentage_bps: 500,
    status: "active",
    effective_from: now,
    effective_until: null,
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
  schedules,
  agreements,
  accounts,
  selectedSchedule,
  selectedAgreement,
  createKind,
  initialAccountId,
  now = new Date().toISOString(),
  errorMessage,
  loadErrorMessage,
}: Readonly<{
  schedules: readonly CommercialTermsSchedule[];
  agreements: readonly CommercialAgreement[];
  accounts: readonly CommercialTermsAccountOption[];
  selectedSchedule?: CommercialTermsSchedule | null;
  selectedAgreement?: CommercialAgreement | null;
  createKind?: CommercialTermsCreateKind | null;
  initialAccountId?: string | null;
  now?: string;
  errorMessage?: string | null;
  loadErrorMessage?: string | null;
}>) {
  const navigate = useNavigate();
  const cards = useMemo(() => orderedCards(schedules, agreements, now), [agreements, now, schedules]);
  const closeSheet = () => navigate("/commerce/terms");
  const selectedActiveSchedule = selectedSchedule
    ? activeScheduleFor(
        schedules.filter((item) => item.schedule_id !== selectedSchedule.schedule_id),
        selectedSchedule.account_type,
        now,
      )
    : selectedAgreement
      ? activeScheduleFor(schedules, selectedAgreement.account_type, now)
      : undefined;

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
      <PageSection title={t("commercialTerms.features.home.activeAndScheduled")}>
        <AutoGrid minItemWidth="md" gap={3}>
          {cards.map((card) => (
            <CommercialTermCardView key={`${card.kind}:${card.id}`} card={card} now={now} />
          ))}
        </AutoGrid>
      </PageSection>

      {selectedSchedule ? (
        <ScheduleSheet schedule={selectedSchedule} activeSchedule={selectedActiveSchedule} onClose={closeSheet} />
      ) : null}
      {selectedAgreement ? (
        <AgreementSheet agreement={selectedAgreement} activeSchedule={selectedActiveSchedule} onClose={closeSheet} />
      ) : null}
      {createKind === "schedule" ? <CreateScheduleSheet schedules={schedules} now={now} onClose={closeSheet} /> : null}
      {createKind === "agreement" ? (
        <CreateAgreementSheet
          schedules={schedules}
          accounts={accounts}
          initialAccountId={initialAccountId}
          now={now}
          onClose={closeSheet}
        />
      ) : null}
    </Page>
  );
}
