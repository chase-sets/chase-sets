import {
  Button,
  Checkbox,
  CheckoutFlowShell,
  CheckoutFormSection,
  CheckoutMobileSummaryDisclosure,
  CheckoutReadinessPrompt,
  CheckoutStateNotice,
  CheckoutStickyActionBar,
  CheckoutSummaryPanel,
  DesktopActionBar,
  Form,
  Grid,
  HiddenInput,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  ProductOptions,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListReadinessSnapshot } from "../domain/readiness";
import { CheckoutPolicyLinks } from "../../sessions/ui/checkout-policy-links";

export type GuestSellCheckoutRecoveryKind =
  | "missing-sell-list"
  | "empty-sell-list"
  | "readiness-required"
  | "readiness-stale"
  | "readiness-blocked";

export type GuestSellCheckoutRecovery = Readonly<{
  kind: GuestSellCheckoutRecoveryKind;
  detail?: string | null;
}>;

export type GuestSellCheckoutFormValues = Readonly<{
  sellerName: string;
  email: string;
  phone: string;
  shipFromName: string;
  company: string;
  shipFromLine1: string;
  shipFromLine2: string;
  shipFromCity: string;
  shipFromState: string;
  shipFromPostalCode: string;
  shipFromCountry: string;
  payoutHandoff: string;
  labelPreference: string;
  termsAccepted: boolean;
  payoutState: string;
  payoutEstimateState: string;
  riskState: string;
  labelState: string;
}>;

export type GuestSellCheckoutFieldErrors = Partial<Record<keyof GuestSellCheckoutFormValues | "form", string>>;

export type GuestSellCheckoutActionState =
  | Readonly<{
      status: "idle";
    }>
  | Readonly<{
      status: "error";
      values: GuestSellCheckoutFormValues;
      fieldErrors: GuestSellCheckoutFieldErrors;
      recovery?: GuestSellCheckoutRecovery | null;
    }>;

export type GuestSellCheckoutPageProps = Readonly<{
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: GuestSellCheckoutRecovery | null;
  defaultValues: GuestSellCheckoutFormValues;
  actionState?: GuestSellCheckoutActionState | null;
}>;

export const guestSellCheckoutDefaultValues: GuestSellCheckoutFormValues = {
  sellerName: "",
  email: "",
  phone: "",
  shipFromName: "",
  company: "",
  shipFromLine1: "",
  shipFromLine2: "",
  shipFromCity: "",
  shipFromState: "",
  shipFromPostalCode: "",
  shipFromCountry: "US",
  payoutHandoff: "create-account",
  labelPreference: "prepaid-label",
  termsAccepted: false,
  payoutState: "ready",
  payoutEstimateState: "current",
  riskState: "clear",
  labelState: "ready",
};

function moneyNumber(value: string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function formatMoney(value: number) {
  return formatMoneyDisplay(value.toFixed(2), "USD");
}

function lineValue(line: CheckoutSellListLineRow) {
  return moneyNumber(line.offer_price_amount ?? line.minimum_listing_price_amount) * line.quantity;
}

function totalLineValue(lines: readonly CheckoutSellListLineRow[]) {
  return lines.reduce((sum, line) => sum + lineValue(line), 0);
}

function productOptions(line: CheckoutSellListLineRow) {
  return line.selected_options.map((selection) => ({
    dimensionLabel: selection.dimensionId,
    optionLabel: selection.optionId,
  }));
}

function productOptionsSummary(line: CheckoutSellListLineRow) {
  return (
    line.selected_options.map((selection) => `${selection.dimensionId}: ${selection.optionId}`).join(", ") ||
    line.product_summary ||
    t("checkout.features.sellList.ui.guestSellCheckoutPage.standard")
  );
}

function recoveryTitle(kind: GuestSellCheckoutRecoveryKind) {
  switch (kind) {
    case "missing-sell-list":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.missing.sell.list");
    case "empty-sell-list":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.empty.sell.list");
    case "readiness-required":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.required");
    case "readiness-stale":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.stale");
    case "readiness-blocked":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.blocked");
  }
}

function recoveryDescription(recovery: GuestSellCheckoutRecovery) {
  if (recovery.detail) {
    return recovery.detail;
  }

  switch (recovery.kind) {
    case "missing-sell-list":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.missing.sell.list.description");
    case "empty-sell-list":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.empty.sell.list.description");
    case "readiness-required":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.required.description");
    case "readiness-stale":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.stale.description");
    case "readiness-blocked":
      return t("checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.blocked.description");
  }
}

function SummaryPanel({
  lines,
  readiness,
  total,
}: {
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  total: string;
}) {
  const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <CheckoutSummaryPanel
      title={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.title")}
      subtitle={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.subtitle", {
        count: lines.length,
      })}
      status={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.status")}
      statusTone="success"
      items={lines.map((line) => ({
        id: line.line_id,
        title: line.item_title,
        subtitle: line.item_subtitle ?? line.product_summary ?? undefined,
        quantity: line.quantity,
        price: formatMoney(lineValue(line)),
        facts: [
          line.line_type === "selected-offer"
            ? t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.selected.offer")
            : t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.product.line"),
          productOptionsSummary(line),
        ],
      }))}
      totals={[
        {
          label: t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.items"),
          value: quantity,
        },
        {
          label: t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.lines"),
          value: lines.length,
        },
        {
          label: t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.readiness"),
          value:
            readiness?.status === "ready"
              ? t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.ready")
              : t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.needs.review"),
        },
      ]}
      totalLabel={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.estimated.payout")}
      total={total}
      currency="USD"
      reassurance={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.reassurance")}
    />
  );
}

function hiddenCheckoutState(defaultValues: GuestSellCheckoutFormValues) {
  return (
    <>
      <HiddenInput type="hidden" name="payoutState" value={defaultValues.payoutState} />
      <HiddenInput type="hidden" name="payoutEstimateState" value={defaultValues.payoutEstimateState} />
      <HiddenInput type="hidden" name="riskState" value={defaultValues.riskState} />
      <HiddenInput type="hidden" name="labelState" value={defaultValues.labelState} />
    </>
  );
}

export function GuestSellCheckoutPage({
  sessionId,
  lines,
  readiness,
  recovery,
  defaultValues,
  actionState = { status: "idle" },
}: GuestSellCheckoutPageProps) {
  const values = actionState?.status === "error" ? actionState.values : defaultValues;
  const fieldErrors = actionState?.status === "error" ? actionState.fieldErrors : {};
  const activeRecovery = actionState?.status === "error" && actionState.recovery ? actionState.recovery : recovery;
  const estimatedTotal = formatMoney(totalLineValue(lines));
  const formId = "guest-sell-checkout-form";
  const primaryAction = (
    <Button type="submit" form={formId} leadingIcon="check" disabled={Boolean(activeRecovery)}>
      {t("checkout.features.sellList.ui.guestSellCheckoutPage.review.sale")}
    </Button>
  );

  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          eyebrow={t("checkout.features.sellList.ui.guestSellCheckoutPage.eyebrow")}
          title={t("checkout.features.sellList.ui.guestSellCheckoutPage.title")}
          description={t("checkout.features.sellList.ui.guestSellCheckoutPage.description")}
          actions={
            <LinkButton href="/account/sell-list" tone="secondary">
              {t("checkout.features.sellList.ui.guestSellCheckoutPage.back.to.sell.list")}
            </LinkButton>
          }
        />

        {activeRecovery ? (
          <CheckoutReadinessPrompt
            tone="warning"
            title={recoveryTitle(activeRecovery.kind)}
            description={recoveryDescription(activeRecovery)}
            action={
              <LinkButton href="/account/sell-list">
                {t("checkout.features.sellList.ui.guestSellCheckoutPage.review.sell.list")}
              </LinkButton>
            }
          />
        ) : null}

        <CheckoutFlowShell
          summaryLabel={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.title")}
          mobileSummary={
            <CheckoutMobileSummaryDisclosure
              label={t("checkout.features.sellList.ui.guestSellCheckoutPage.mobile.summary")}
              collapsedSummary={t("checkout.features.sellList.ui.guestSellCheckoutPage.mobile.summary.collapsed", {
                count: lines.length,
              })}
              total={estimatedTotal}
            >
              <SummaryPanel lines={lines} readiness={readiness} total={estimatedTotal} />
            </CheckoutMobileSummaryDisclosure>
          }
          stickyAction={
            <CheckoutStickyActionBar
              totalLabel={t("checkout.features.sellList.ui.guestSellCheckoutPage.summary.estimated.payout")}
              total={estimatedTotal}
              context={t("checkout.features.sellList.ui.guestSellCheckoutPage.sticky.context")}
              primaryAction={primaryAction}
              secondaryAction={
                <LinkButton href="/account/sell-list" tone="secondary">
                  {t("checkout.features.sellList.ui.guestSellCheckoutPage.back")}
                </LinkButton>
              }
            />
          }
          desktopSummary={<SummaryPanel lines={lines} readiness={readiness} total={estimatedTotal} />}
          main={
            <Form id={formId} method="post" spacing="lg">
              <HiddenInput type="hidden" name="sessionId" value={sessionId} />
              <HiddenInput type="hidden" name="readinessSnapshotId" value={readiness?.snapshotId ?? ""} />
              <HiddenInput type="hidden" name="readinessSourceRevision" value={readiness?.sourceRevision ?? ""} />
              {hiddenCheckoutState(values)}

              {fieldErrors.form ? (
                <CheckoutStateNotice
                  tone="danger"
                  title={t("checkout.features.sellList.ui.guestSellCheckoutPage.fix.details")}
                  description={fieldErrors.form}
                />
              ) : null}

              <CheckoutFormSection
                title={t("checkout.features.sellList.ui.guestSellCheckoutPage.contact.title")}
                description={t("checkout.features.sellList.ui.guestSellCheckoutPage.contact.description")}
              >
                <Grid columns={{ base: 1, md: 2 }} gap={3}>
                  <TextInput
                    name="sellerName"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.seller.name")}
                    defaultValue={values.sellerName}
                    error={fieldErrors.sellerName}
                    autoComplete="name"
                    required
                  />
                  <TextInput
                    name="email"
                    type="email"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.email")}
                    defaultValue={values.email}
                    error={fieldErrors.email}
                    autoComplete="email"
                    required
                  />
                  <TextInput
                    name="phone"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.phone")}
                    defaultValue={values.phone}
                    error={fieldErrors.phone}
                    autoComplete="tel"
                  />
                </Grid>
              </CheckoutFormSection>

              <CheckoutFormSection
                title={t("checkout.features.sellList.ui.guestSellCheckoutPage.ship.from.title")}
                description={t("checkout.features.sellList.ui.guestSellCheckoutPage.ship.from.description")}
              >
                <Grid columns={{ base: 1, md: 2 }} gap={3}>
                  <TextInput
                    name="shipFromName"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.ship.from.name")}
                    defaultValue={values.shipFromName}
                    error={fieldErrors.shipFromName}
                    autoComplete="name"
                    required
                  />
                  <TextInput
                    name="company"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.company")}
                    defaultValue={values.company}
                    error={fieldErrors.company}
                    autoComplete="organization"
                  />
                  <TextInput
                    name="shipFromLine1"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.address.line1")}
                    defaultValue={values.shipFromLine1}
                    error={fieldErrors.shipFromLine1}
                    autoComplete="address-line1"
                    required
                  />
                  <TextInput
                    name="shipFromLine2"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.address.line2")}
                    defaultValue={values.shipFromLine2}
                    error={fieldErrors.shipFromLine2}
                    autoComplete="address-line2"
                  />
                  <TextInput
                    name="shipFromCity"
                    label={t("checkout.features.sellList.ui.guestSellCheckoutPage.city")}
                    defaultValue={values.shipFromCity}
                    error={fieldErrors.shipFromCity}
                    autoComplete="address-level2"
                    required
                  />
                  <Grid columns={{ base: 1, md: 3 }} gap={3}>
                    <TextInput
                      name="shipFromState"
                      label={t("checkout.features.sellList.ui.guestSellCheckoutPage.state")}
                      defaultValue={values.shipFromState}
                      error={fieldErrors.shipFromState}
                      autoComplete="address-level1"
                      required
                    />
                    <TextInput
                      name="shipFromPostalCode"
                      label={t("checkout.features.sellList.ui.guestSellCheckoutPage.postal.code")}
                      defaultValue={values.shipFromPostalCode}
                      error={fieldErrors.shipFromPostalCode}
                      autoComplete="postal-code"
                      required
                    />
                    <TextInput
                      name="shipFromCountry"
                      label={t("checkout.features.sellList.ui.guestSellCheckoutPage.country")}
                      defaultValue={values.shipFromCountry}
                      error={fieldErrors.shipFromCountry}
                      autoComplete="country"
                      required
                    />
                  </Grid>
                </Grid>
              </CheckoutFormSection>

              <CheckoutFormSection
                title={t("checkout.features.sellList.ui.guestSellCheckoutPage.payout.title")}
                description={t("checkout.features.sellList.ui.guestSellCheckoutPage.payout.description")}
              >
                <NativeSelect
                  name="payoutHandoff"
                  label={t("checkout.features.sellList.ui.guestSellCheckoutPage.payout.method")}
                  defaultValue={values.payoutHandoff}
                  error={fieldErrors.payoutHandoff}
                  items={[
                    {
                      value: "create-account",
                      label: t("checkout.features.sellList.ui.guestSellCheckoutPage.payout.create.account"),
                    },
                  ]}
                  required
                />
              </CheckoutFormSection>

              <CheckoutFormSection
                title={t("checkout.features.sellList.ui.guestSellCheckoutPage.label.title")}
                description={t("checkout.features.sellList.ui.guestSellCheckoutPage.label.description")}
              >
                <NativeSelect
                  name="labelPreference"
                  label={t("checkout.features.sellList.ui.guestSellCheckoutPage.label.preference")}
                  defaultValue={values.labelPreference}
                  error={fieldErrors.labelPreference}
                  items={[
                    {
                      value: "prepaid-label",
                      label: t("checkout.features.sellList.ui.guestSellCheckoutPage.label.prepaid"),
                    },
                    {
                      value: "seller-label-later",
                      label: t("checkout.features.sellList.ui.guestSellCheckoutPage.label.later"),
                    },
                  ]}
                  required
                />
              </CheckoutFormSection>

              <CheckoutFormSection
                title={t("checkout.features.sellList.ui.guestSellCheckoutPage.terms.title")}
                description={t("checkout.features.sellList.ui.guestSellCheckoutPage.terms.description")}
              >
                <Checkbox
                  name="termsAccepted"
                  value="accepted"
                  defaultChecked={values.termsAccepted}
                  error={fieldErrors.termsAccepted}
                  label={t("checkout.features.sellList.ui.guestSellCheckoutPage.terms.accept")}
                  description={t("checkout.features.sellList.ui.guestSellCheckoutPage.terms.accept.description")}
                  required
                />
                <Text size="sm" tone="secondary">
                  {t("checkout.features.sellList.ui.guestSellCheckoutPage.side.effect.boundary")}
                </Text>
              </CheckoutFormSection>

              <CheckoutPolicyLinks
                guestDataDescription={t("checkout.features.sellList.ui.guestSellCheckoutPage.guest.data.description")}
              />

              <DesktopActionBar data-primary-action-count="1">
                {primaryAction}
                <LinkButton href="/account/sell-list" tone="secondary">
                  {t("checkout.features.sellList.ui.guestSellCheckoutPage.back.to.sell.list")}
                </LinkButton>
              </DesktopActionBar>
            </Form>
          }
        />
      </Stack>
    </Page>
  );
}
