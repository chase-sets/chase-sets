import { formatMoney, t } from "@chase-sets/localization";
import { Badge, LinkText, Stack, Text } from "@chase-sets/design-system";
import type { SupportRequestListItem } from "./contracts";
import type { CustomerRemedyRole } from "./customer-remedy-status";

function statusPresentation(labelStatus: string, status: string) {
  if (labelStatus === "failed") {
    return { tone: "danger" as const, label: t("support.features.supportRequests.ui.returnShipping.failed") };
  }
  if (labelStatus === "voided") {
    return { tone: "neutral" as const, label: t("support.features.supportRequests.ui.returnShipping.voided") };
  }
  if (labelStatus === "ready") {
    return {
      tone: status === "delivered" ? ("success" as const) : ("info" as const),
      label:
        status === "delivered"
          ? t("support.features.supportRequests.ui.returnShipping.delivered")
          : t("support.features.supportRequests.ui.returnShipping.ready"),
    };
  }
  return { tone: "neutral" as const, label: t("support.features.supportRequests.ui.returnShipping.pending") };
}

export function ReturnShippingStatus({
  request,
  role,
}: Readonly<{ request: SupportRequestListItem; role: CustomerRemedyRole }>) {
  const shipping = request.return_shipping;
  if (!shipping) return null;
  const presentation = statusPresentation(shipping.label_status, shipping.status);
  const amount =
    shipping.postage_amount_cents === null
      ? null
      : formatMoney((shipping.postage_amount_cents / 100).toFixed(2), shipping.postage_currency ?? "USD");
  const payer =
    shipping.cost_payer === "buyer"
      ? t("support.features.supportRequests.ui.returnShipping.buyerPays", { amount: amount ?? "" })
      : t("support.features.supportRequests.ui.returnShipping.sellerPays", { amount: amount ?? "" });

  return (
    <Stack gap={1}>
      <Text size="sm" weight="semibold">
        {t("support.features.supportRequests.ui.returnShipping.title")}
      </Text>
      <Badge tone={presentation.tone}>{presentation.label}</Badge>
      {shipping.label_status === "failed" ? (
        <Text size="sm" tone="danger">
          {t("support.features.supportRequests.ui.returnShipping.fallback")}
        </Text>
      ) : null}
      {role === "buyer" && shipping.label_status === "ready" && shipping.label_document_url ? (
        <LinkText href={shipping.label_document_url}>
          {t("support.features.supportRequests.ui.returnShipping.openLabel")}
        </LinkText>
      ) : null}
      {shipping.tracking_identifier ? (
        <Text size="sm">
          {t("support.features.supportRequests.ui.returnShipping.tracking", {
            tracking: shipping.tracking_identifier,
          })}
        </Text>
      ) : null}
      <Text size="sm" tone="secondary">
        {payer}
      </Text>
    </Stack>
  );
}
