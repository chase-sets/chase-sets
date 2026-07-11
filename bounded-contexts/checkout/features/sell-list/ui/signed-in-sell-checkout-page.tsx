import { useState } from "react";
import {
  Button,
  Checkbox,
  CheckoutFlowShell,
  CheckoutFormSection,
  CheckoutMobileSummaryDisclosure,
  CheckoutReadinessPrompt,
  CheckoutSavedInfoGroup,
  CheckoutSavedInfoRow,
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
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListReadinessSnapshot } from "../domain/readiness";
import { CheckoutPolicyLinks } from "../../sessions/ui/checkout-policy-links";

export type SignedInSellCheckoutRecoveryKind =
  | "access-required"
  | "missing-sell-list"
  | "empty-sell-list"
  | "readiness-required"
  | "readiness-stale"
  | "readiness-blocked";

export type SignedInSellCheckoutRecovery = Readonly<{
  kind: SignedInSellCheckoutRecoveryKind;
  detail?: string | null;
}>;

export type SignedInSellCheckoutShipFromAddress = Readonly<{
  shippingAddressId: string;
  label: string;
  name: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  isDefault: boolean;
}>;

export type SignedInSellCheckoutPayoutSummary = Readonly<{
  status: "not-started" | "pending" | "ready" | "restricted" | "unavailable";
  displayLabel: string;
  supportingText: string;
  missingRequirements: readonly string[];
}>;

export type SignedInSellCheckoutFormValues = Readonly<{
  sellerName: string;
  email: string;
  phone: string;
  shipFromAddressId: string;
  shipFromName: string;
  company: string;
  shipFromLine1: string;
  shipFromLine2: string;
  shipFromCity: string;
  shipFromState: string;
  shipFromPostalCode: string;
  shipFromCountry: string;
  payoutMethod: string;
  labelPreference: string;
  termsAccepted: boolean;
  payoutState: string;
  payoutEstimateState: string;
  riskState: string;
  labelState: string;
  sellerReadinessState: string;
}>;

export type SignedInSellCheckoutFieldErrors = Partial<Record<keyof SignedInSellCheckoutFormValues | "form", string>>;

export type SignedInSellCheckoutActionState =
  | Readonly<{
      status: "idle";
    }>
  | Readonly<{
      status: "error";
      values: SignedInSellCheckoutFormValues;
      fieldErrors: SignedInSellCheckoutFieldErrors;
      recovery?: SignedInSellCheckoutRecovery | null;
    }>;

export type SignedInSellCheckoutEditSection = "contact" | "ship-from" | "payout" | "label";

export type SignedInSellCheckoutPageProps = Readonly<{
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: SignedInSellCheckoutRecovery | null;
  defaultValues: SignedInSellCheckoutFormValues;
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[];
  payoutSummary: SignedInSellCheckoutPayoutSummary | null;
  readinessDecisions: string;
  sellListReviewPlan: string;
  actionState?: SignedInSellCheckoutActionState | null;
  initialEditSection?: SignedInSellCheckoutEditSection | null;
}>;

export const signedInSellCheckoutDefaultValues: SignedInSellCheckoutFormValues = {
  sellerName: "",
  email: "",
  phone: "",
  shipFromAddressId: "__manual",
  shipFromName: "",
  company: "",
  shipFromLine1: "",
  shipFromLine2: "",
  shipFromCity: "",
  shipFromState: "",
  shipFromPostalCode: "",
  shipFromCountry: "US",
  payoutMethod: "saved-payout",
  labelPreference: "prepaid-label",
  termsAccepted: false,
  payoutState: "ready",
  payoutEstimateState: "current",
  riskState: "clear",
  labelState: "ready",
  sellerReadinessState: "ready",
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

function productOptionsSummary(line: CheckoutSellListLineRow) {
  return (
    line.selected_options.map((selection) => `${selection.dimensionId}: ${selection.optionId}`).join(", ") ||
    line.product_summary ||
    t("checkout.features.sellList.ui.signedInSellCheckoutPage.standard")
  );
}

function addressIsComplete(address: SignedInSellCheckoutFormValues) {
  return [
    address.shipFromName,
    address.shipFromLine1,
    address.shipFromCity,
    address.shipFromState,
    address.shipFromPostalCode,
    address.shipFromCountry,
  ].every((value) => value.trim().length > 0);
}

function addressSummary(values: SignedInSellCheckoutFormValues) {
  const region = [values.shipFromState, values.shipFromPostalCode].filter((value) => value.trim()).join(" ");
  const locality = [values.shipFromCity, region].filter((value) => value.trim()).join(", ");
  return [values.shipFromLine1, values.shipFromLine2, locality, values.shipFromCountry]
    .filter((value) => value.trim())
    .join(", ");
}

function contactSupportingText(phone: string) {
  return phone.trim()
    ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.contact.supporting.phone", { phone })
    : t("checkout.features.sellList.ui.signedInSellCheckoutPage.contact.supporting");
}

function recoveryTitle(kind: SignedInSellCheckoutRecoveryKind) {
  switch (kind) {
    case "access-required":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.access.required");
    case "missing-sell-list":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.missing.sell.list");
    case "empty-sell-list":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.empty.sell.list");
    case "readiness-required":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.required");
    case "readiness-stale":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.stale");
    case "readiness-blocked":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.blocked");
  }
}

function recoveryDescription(recovery: SignedInSellCheckoutRecovery) {
  if (recovery.detail) {
    return recovery.detail;
  }

  switch (recovery.kind) {
    case "access-required":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.access.required.description");
    case "missing-sell-list":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.missing.sell.list.description");
    case "empty-sell-list":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.empty.sell.list.description");
    case "readiness-required":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.required.description");
    case "readiness-stale":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.stale.description");
    case "readiness-blocked":
      return t("checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.blocked.description");
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
      title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.title")}
      subtitle={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.subtitle", {
        count: lines.length,
      })}
      status={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.status")}
      statusTone="success"
      items={lines.map((line) => ({
        id: line.line_id,
        title: line.item_title,
        subtitle: line.item_subtitle ?? line.product_summary ?? undefined,
        quantity: line.quantity,
        price: formatMoney(lineValue(line)),
        facts: [
          line.line_type === "selected-offer"
            ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.selected.offer")
            : t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.product.line"),
          productOptionsSummary(line),
        ],
      }))}
      totals={[
        {
          label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.items"),
          value: quantity,
        },
        {
          label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.lines"),
          value: lines.length,
        },
        {
          label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.readiness"),
          value:
            readiness?.status === "ready"
              ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.ready")
              : t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.needs.review"),
        },
      ]}
      totalLabel={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.estimated.payout")}
      total={total}
      currency="USD"
      reassurance={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.reassurance", { quantity })}
    />
  );
}

function editRowAction(section: SignedInSellCheckoutEditSection, label: string, onEdit: () => void) {
  return (
    <Button type="button" tone="secondary" size="sm" leadingIcon="edit" onClick={onEdit}>
      {label || t("checkout.features.sellList.ui.signedInSellCheckoutPage.edit.section", { section })}
    </Button>
  );
}

function hiddenCheckoutState(defaultValues: SignedInSellCheckoutFormValues) {
  return (
    <>
      <HiddenInput type="hidden" name="payoutState" value={defaultValues.payoutState} />
      <HiddenInput type="hidden" name="payoutEstimateState" value={defaultValues.payoutEstimateState} />
      <HiddenInput type="hidden" name="riskState" value={defaultValues.riskState} />
      <HiddenInput type="hidden" name="labelState" value={defaultValues.labelState} />
      <HiddenInput type="hidden" name="sellerReadinessState" value={defaultValues.sellerReadinessState} />
    </>
  );
}

function hiddenContact(values: SignedInSellCheckoutFormValues) {
  return (
    <>
      <HiddenInput type="hidden" name="sellerName" value={values.sellerName} />
      <HiddenInput type="hidden" name="email" value={values.email} />
      <HiddenInput type="hidden" name="phone" value={values.phone} />
    </>
  );
}

function hiddenShipFrom(values: SignedInSellCheckoutFormValues) {
  return (
    <>
      <HiddenInput type="hidden" name="shipFromAddressId" value={values.shipFromAddressId} />
      <HiddenInput type="hidden" name="shipFromName" value={values.shipFromName} />
      <HiddenInput type="hidden" name="company" value={values.company} />
      <HiddenInput type="hidden" name="shipFromLine1" value={values.shipFromLine1} />
      <HiddenInput type="hidden" name="shipFromLine2" value={values.shipFromLine2} />
      <HiddenInput type="hidden" name="shipFromCity" value={values.shipFromCity} />
      <HiddenInput type="hidden" name="shipFromState" value={values.shipFromState} />
      <HiddenInput type="hidden" name="shipFromPostalCode" value={values.shipFromPostalCode} />
      <HiddenInput type="hidden" name="shipFromCountry" value={values.shipFromCountry} />
    </>
  );
}

export function SignedInSellCheckoutPage({
  sessionId,
  lines,
  readiness,
  recovery,
  defaultValues,
  savedShipFromAddresses,
  payoutSummary,
  readinessDecisions,
  sellListReviewPlan,
  actionState = { status: "idle" },
  initialEditSection = null,
}: SignedInSellCheckoutPageProps) {
  const [editingSection, setEditingSection] = useState<SignedInSellCheckoutEditSection | null>(initialEditSection);
  const values = actionState?.status === "error" ? actionState.values : defaultValues;
  const fieldErrors = actionState?.status === "error" ? actionState.fieldErrors : {};
  const activeRecovery = actionState?.status === "error" && actionState.recovery ? actionState.recovery : recovery;
  const estimatedTotal = formatMoney(totalLineValue(lines));
  const formId = "signed-in-sell-checkout-form";
  const contactReady = values.sellerName.trim().length > 0 && values.email.trim().length > 0;
  const shipFromReady = addressIsComplete(values);
  const payoutReady = values.payoutState === "ready" && payoutSummary?.status === "ready";
  const sellerReadinessReady = values.sellerReadinessState === "ready";
  const labelReady = values.labelState === "ready";
  const showContactForm = !contactReady || editingSection === "contact";
  const showShipFromForm = !shipFromReady || editingSection === "ship-from";
  const showPayoutForm = !payoutReady || editingSection === "payout";
  const showLabelForm = !labelReady || editingSection === "label";
  const primaryAction = (
    <Button type="submit" form={formId} leadingIcon="check" disabled={Boolean(activeRecovery)}>
      {t("checkout.features.sellList.ui.signedInSellCheckoutPage.review.sale")}
    </Button>
  );

  return (
    <Page>
      <Stack gap={5}>
        <PageHeader
          eyebrow={t("checkout.features.sellList.ui.signedInSellCheckoutPage.eyebrow")}
          title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.title")}
          description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.description")}
          actions={
            <LinkButton href="/account/sell-list" tone="secondary">
              {t("checkout.features.sellList.ui.signedInSellCheckoutPage.back.to.sell.list")}
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
                {t("checkout.features.sellList.ui.signedInSellCheckoutPage.review.sell.list")}
              </LinkButton>
            }
          />
        ) : null}

        <CheckoutFlowShell
          summaryLabel={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.title")}
          mobileSummary={
            <CheckoutMobileSummaryDisclosure
              label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.mobile.summary")}
              collapsedSummary={t("checkout.features.sellList.ui.signedInSellCheckoutPage.mobile.summary.collapsed", {
                count: lines.length,
              })}
              total={estimatedTotal}
            >
              <SummaryPanel lines={lines} readiness={readiness} total={estimatedTotal} />
            </CheckoutMobileSummaryDisclosure>
          }
          stickyAction={
            <CheckoutStickyActionBar
              totalLabel={t("checkout.features.sellList.ui.signedInSellCheckoutPage.summary.estimated.payout")}
              total={estimatedTotal}
              context={t("checkout.features.sellList.ui.signedInSellCheckoutPage.sticky.context")}
              primaryAction={primaryAction}
              secondaryAction={
                <LinkButton href="/account/sell-list" tone="secondary">
                  {t("checkout.features.sellList.ui.signedInSellCheckoutPage.back")}
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
              <HiddenInput type="hidden" name="readinessDecisions" value={readinessDecisions} />
              <HiddenInput type="hidden" name="sellListReviewPlan" value={sellListReviewPlan} />
              {hiddenCheckoutState(values)}

              {fieldErrors.form ? (
                <CheckoutStateNotice
                  tone="danger"
                  title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.fix.details")}
                  description={fieldErrors.form}
                />
              ) : null}

              <CheckoutSavedInfoGroup title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.saved.title")}>
                {contactReady ? (
                  <CheckoutSavedInfoRow
                    icon="user"
                    label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.contact.title")}
                    value={values.email}
                    supportingText={contactSupportingText(values.phone)}
                    status={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ready")}
                    statusTone="success"
                    action={editRowAction(
                      "contact",
                      t("checkout.features.sellList.ui.signedInSellCheckoutPage.edit.contact"),
                      () => setEditingSection("contact"),
                    )}
                  />
                ) : null}
                {shipFromReady ? (
                  <CheckoutSavedInfoRow
                    icon="home"
                    label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.title")}
                    value={values.shipFromName}
                    supportingText={addressSummary(values)}
                    status={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ready")}
                    statusTone="success"
                    action={editRowAction(
                      "ship-from",
                      t("checkout.features.sellList.ui.signedInSellCheckoutPage.edit.ship.from"),
                      () => setEditingSection("ship-from"),
                    )}
                  />
                ) : null}
                {payoutReady ? (
                  <CheckoutSavedInfoRow
                    icon="wallet"
                    label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.title")}
                    value={payoutSummary.displayLabel}
                    supportingText={payoutSummary.supportingText}
                    status={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ready")}
                    statusTone="success"
                    action={editRowAction(
                      "payout",
                      t("checkout.features.sellList.ui.signedInSellCheckoutPage.edit.payout"),
                      () => setEditingSection("payout"),
                    )}
                  />
                ) : null}
                <CheckoutSavedInfoRow
                  icon="shield"
                  label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.title")}
                  value={
                    sellerReadinessReady
                      ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.ready")
                      : t("checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.needs.review")
                  }
                  supportingText={t("checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.detail")}
                  status={
                    sellerReadinessReady
                      ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.ready")
                      : t("checkout.features.sellList.ui.signedInSellCheckoutPage.review.required")
                  }
                  statusTone={sellerReadinessReady ? "success" : "warning"}
                />
                {labelReady ? (
                  <CheckoutSavedInfoRow
                    icon="truck"
                    label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.title")}
                    value={
                      values.labelPreference === "seller-label-later"
                        ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.later")
                        : t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.prepaid")
                    }
                    supportingText={t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.row.supporting")}
                    status={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ready")}
                    statusTone="success"
                    action={editRowAction(
                      "label",
                      t("checkout.features.sellList.ui.signedInSellCheckoutPage.edit.label"),
                      () => setEditingSection("label"),
                    )}
                  />
                ) : null}
              </CheckoutSavedInfoGroup>

              {!showContactForm ? hiddenContact(values) : null}
              {!showShipFromForm ? hiddenShipFrom(values) : null}
              {!showPayoutForm ? <HiddenInput type="hidden" name="payoutMethod" value={values.payoutMethod} /> : null}
              {!showLabelForm ? (
                <HiddenInput type="hidden" name="labelPreference" value={values.labelPreference} />
              ) : null}

              {showContactForm ? (
                <CheckoutFormSection
                  title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.contact.title")}
                  description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.contact.description")}
                >
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <TextInput
                      name="sellerName"
                      label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.seller.name")}
                      defaultValue={values.sellerName}
                      error={fieldErrors.sellerName}
                      autoComplete="name"
                      required
                    />
                    <TextInput
                      name="email"
                      type="email"
                      label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.email")}
                      defaultValue={values.email}
                      error={fieldErrors.email}
                      autoComplete="email"
                      required
                    />
                    <TextInput
                      name="phone"
                      label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.phone")}
                      defaultValue={values.phone}
                      error={fieldErrors.phone}
                      autoComplete="tel"
                    />
                  </Grid>
                </CheckoutFormSection>
              ) : null}

              {showShipFromForm ? (
                <CheckoutFormSection
                  title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.title")}
                  description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.description")}
                >
                  <Stack gap={3}>
                    {savedShipFromAddresses.length > 0 ? (
                      <NativeSelect
                        name="shipFromAddressId"
                        label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.saved.ship.from")}
                        defaultValue={values.shipFromAddressId}
                        items={[
                          {
                            value: "__manual",
                            label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.enter.new.ship.from"),
                          },
                          ...savedShipFromAddresses.map((address) => ({
                            value: address.shippingAddressId,
                            label: address.isDefault
                              ? t("checkout.features.sellList.ui.signedInSellCheckoutPage.default.ship.from.option", {
                                  label: address.label,
                                })
                              : address.label,
                          })),
                        ]}
                      />
                    ) : null}
                    <Grid columns={{ base: 1, md: 2 }} gap={3}>
                      <TextInput
                        name="shipFromName"
                        label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.name")}
                        defaultValue={values.shipFromName}
                        error={fieldErrors.shipFromName}
                        autoComplete="name"
                        required
                      />
                      <TextInput
                        name="company"
                        label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.company")}
                        defaultValue={values.company}
                        error={fieldErrors.company}
                        autoComplete="organization"
                      />
                      <TextInput
                        name="shipFromLine1"
                        label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.address.line1")}
                        defaultValue={values.shipFromLine1}
                        error={fieldErrors.shipFromLine1}
                        autoComplete="address-line1"
                        required
                      />
                      <TextInput
                        name="shipFromLine2"
                        label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.address.line2")}
                        defaultValue={values.shipFromLine2}
                        error={fieldErrors.shipFromLine2}
                        autoComplete="address-line2"
                      />
                      <TextInput
                        name="shipFromCity"
                        label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.city")}
                        defaultValue={values.shipFromCity}
                        error={fieldErrors.shipFromCity}
                        autoComplete="address-level2"
                        required
                      />
                      <Grid columns={{ base: 1, md: 3 }} gap={3}>
                        <TextInput
                          name="shipFromState"
                          label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.state")}
                          defaultValue={values.shipFromState}
                          error={fieldErrors.shipFromState}
                          autoComplete="address-level1"
                          required
                        />
                        <TextInput
                          name="shipFromPostalCode"
                          label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.postal.code")}
                          defaultValue={values.shipFromPostalCode}
                          error={fieldErrors.shipFromPostalCode}
                          autoComplete="postal-code"
                          required
                        />
                        <TextInput
                          name="shipFromCountry"
                          label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.country")}
                          defaultValue={values.shipFromCountry}
                          error={fieldErrors.shipFromCountry}
                          autoComplete="country"
                          required
                        />
                      </Grid>
                    </Grid>
                  </Stack>
                </CheckoutFormSection>
              ) : null}

              {showPayoutForm ? (
                <CheckoutFormSection
                  title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.title")}
                  description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.description")}
                >
                  <NativeSelect
                    name="payoutMethod"
                    label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.method")}
                    defaultValue={values.payoutMethod}
                    error={fieldErrors.payoutMethod}
                    items={[
                      {
                        value: "saved-payout",
                        label:
                          payoutSummary?.displayLabel ??
                          t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.saved"),
                      },
                      {
                        value: "setup-payout",
                        label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.payout.setup"),
                      },
                    ]}
                    required
                  />
                  {payoutSummary && payoutSummary.status !== "ready" ? (
                    <Text size="sm" tone="secondary">
                      {payoutSummary.supportingText}
                    </Text>
                  ) : null}
                </CheckoutFormSection>
              ) : null}

              {showLabelForm ? (
                <CheckoutFormSection
                  title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.title")}
                  description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.description")}
                >
                  <NativeSelect
                    name="labelPreference"
                    label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.preference")}
                    defaultValue={values.labelPreference}
                    error={fieldErrors.labelPreference}
                    items={[
                      {
                        value: "prepaid-label",
                        label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.prepaid"),
                      },
                      {
                        value: "seller-label-later",
                        label: t("checkout.features.sellList.ui.signedInSellCheckoutPage.label.later"),
                      },
                    ]}
                    required
                  />
                </CheckoutFormSection>
              ) : null}

              <CheckoutFormSection
                title={t("checkout.features.sellList.ui.signedInSellCheckoutPage.terms.title")}
                description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.terms.description")}
              >
                <Checkbox
                  name="termsAccepted"
                  value="accepted"
                  defaultChecked={values.termsAccepted}
                  error={fieldErrors.termsAccepted}
                  label={t("checkout.features.sellList.ui.signedInSellCheckoutPage.terms.accept")}
                  description={t("checkout.features.sellList.ui.signedInSellCheckoutPage.terms.accept.description")}
                  required
                />
                <Text size="sm" tone="secondary">
                  {t("checkout.features.sellList.ui.signedInSellCheckoutPage.side.effect.boundary")}
                </Text>
              </CheckoutFormSection>

              <CheckoutPolicyLinks />

              <DesktopActionBar data-primary-action-count="1">
                {primaryAction}
                <LinkButton href="/account/sell-list" tone="secondary">
                  {t("checkout.features.sellList.ui.signedInSellCheckoutPage.back.to.sell.list")}
                </LinkButton>
              </DesktopActionBar>
            </Form>
          }
        />
      </Stack>
    </Page>
  );
}
