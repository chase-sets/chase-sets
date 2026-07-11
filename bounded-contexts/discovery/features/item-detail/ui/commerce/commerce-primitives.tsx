import { formatMoney, t } from "@chase-sets/localization";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  ProductOptions,
  ReferenceInfoDialog,
  type ReferenceInfoSection,
  ReferenceInfoTrigger,
  Stack,
  Text,
  type AccordionSectionEdge,
} from "@chase-sets/design-system";
import type { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { trackItemDetailRailEvent } from "../item-detail-rail-analytics";

export type CommerceAccordionEdge = AccordionSectionEdge;

export type MarketplaceListingTermsPreview = Readonly<{
  account_type: string;
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  schedule_id?: string | null;
  agreement_id?: string | null;
  resolved_at: string;
  fee_quote_fingerprint?: string;
  source_kind?: "public-standard-seller-terms";
  source_label?: string;
  schedule_label?: string;
  source_updated_at?: string;
}>;

export type ProductSelectionDisplayDetail = Readonly<{
  label: ReactNode;
  value: ReactNode;
}>;

export type MarketSelectionSource = "explicit" | "implicit";

export function productOptionsFromSelectionDetails(selections: readonly ProductSelectionDisplayDetail[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.label,
    optionLabel: selection.value,
  }));
}

export function ProductQuantitySummary({
  availability,
  productSelectionDetails,
  productSummary,
  fallback,
}: {
  availability: ReactNode;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  productSummary: ReactNode;
  fallback: ReactNode;
}) {
  return (
    <Stack gap={1} minWidth="0">
      <ProductOptions
        options={productOptionsFromSelectionDetails(productSelectionDetails)}
        emptyLabel={productSummary ?? fallback}
        variant="compact"
        size="sm"
        truncate
      />
      <Text element="span" size="sm" tone="secondary" weight="medium">
        {availability}
      </Text>
    </Stack>
  );
}

export type AddToCartActionData = Readonly<{
  status: "added-to-cart";
  itemTitle: string;
  quantity: number;
  cartLine: {
    id: string;
    version: number;
    status: string;
  };
  viewCartHref: string;
}>;

export type ItemDetailActionData = AddToCartActionData | Readonly<{ error: string }> | null;

export function isAddToCartActionData(value: unknown): value is AddToCartActionData {
  return Boolean(
    value &&
    typeof value === "object" &&
    "status" in value &&
    (value as { status?: unknown }).status === "added-to-cart" &&
    typeof (value as { viewCartHref?: unknown }).viewCartHref === "string" &&
    Boolean((value as { viewCartHref?: string }).viewCartHref?.trim()),
  );
}

export function getActionErrorMessage(value: unknown) {
  return value && typeof value === "object" && "error" in value ? String(value.error ?? "") : null;
}

export function notifyCartCountChanged(quantity: number) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("chase-sets:cart-count-changed", {
      detail: { countDelta: quantity },
    }),
  );
}

export function submittedButtonValue(event: FormEvent<HTMLFormElement>) {
  const submitter = (event.nativeEvent as SubmitEvent).submitter;

  return submitter instanceof HTMLButtonElement ? submitter.value : "";
}

export function canUseAccountCheckoutCart(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

export function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

export function parseMoneyAmount(value: string | null | undefined): number | null {
  const amount = Number.parseFloat(String(value ?? ""));

  return Number.isFinite(amount) ? amount : null;
}

export function formatMoneyAmount(value: string | number | null | undefined) {
  const amount = typeof value === "number" ? value : parseMoneyAmount(value);

  return amount === null ? t("discovery.routes.itemDetail.unavailable") : formatMoney(amount.toFixed(2), "USD");
}

export function multiplyMoneyAmount(value: string, quantity: number) {
  const amount = parseMoneyAmount(value);

  return amount === null ? null : amount * quantity;
}

export function parseQuantity(value: number | null | undefined): number {
  const quantity = Number(value);

  return Number.isFinite(quantity) ? quantity : 0;
}

export function formatTermsSource(terms: MarketplaceListingTermsPreview) {
  if (terms.source_label) {
    return terms.source_label;
  }

  if (terms.agreement_id) {
    return t("discovery.routes.itemDetail.seller.specific.terms");
  }

  if (terms.schedule_id) {
    return t("discovery.routes.itemDetail.standard.seller.terms");
  }

  return t("discovery.routes.itemDetail.standard.terms");
}

function ReferenceInfoText({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <Stack gap={2}>
      {lines.map((line, index) => (
        <Text key={index} size="sm" tone="secondary">
          {line}
        </Text>
      ))}
    </Stack>
  );
}

export function RailReferenceInfo({
  triggerLabel,
  ariaLabel,
  title,
  description,
  summary,
  sections,
  lines,
  analyticsTopic,
}: {
  triggerLabel: string;
  ariaLabel: string;
  title: string;
  description?: string;
  summary?: ReactNode;
  sections?: readonly ReferenceInfoSection[];
  lines?: readonly ReactNode[];
  analyticsTopic?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ReferenceInfoTrigger
        tone="neutral"
        aria-label={ariaLabel}
        onClick={() => {
          setOpen(true);
          trackItemDetailRailEvent("reference_info_opened", {
            topic: analyticsTopic ?? "reference_info",
            outcome: "opened",
            surface: "reference_info",
          });
        }}
      >
        {triggerLabel}
      </ReferenceInfoTrigger>
      <ReferenceInfoDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        closeLabel={t("discovery.features.itemDetail.ui.itemDetailPage.close.reference.detail")}
        summary={summary}
        sections={sections ? [...sections] : undefined}
      >
        {lines?.length ? <ReferenceInfoText lines={lines} /> : null}
      </ReferenceInfoDialog>
    </>
  );
}
