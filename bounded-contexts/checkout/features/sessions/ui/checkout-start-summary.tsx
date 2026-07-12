import { formatMoney, t } from "@chase-sets/localization";
import {
  CheckoutMobileSummaryDisclosure,
  HiddenInput,
  OrderIntentSummary,
  OrderProtectionModule,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
  formatMarketplaceNumber,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import { checkoutStartBuyerProtectionItems } from "./checkout-start-copy";
import type { CheckoutStartSource } from "./checkout-start-page-types";

/** Hidden inputs mirroring the checkout entry (buy-now listing, offer-intent,
 * or cart) into both the account-continue and guest-contact forms. */
export function CheckoutStartSourceFields({
  source,
  entryAttemptKey,
}: {
  source: CheckoutStartSource | null;
  entryAttemptKey: string;
}) {
  if (!source) {
    return (
      <>
        <HiddenInput type="hidden" name="entryAttemptKey" value={entryAttemptKey} />
        <HiddenInput type="hidden" name="source" value="cart" />
      </>
    );
  }

  return (
    <>
      <HiddenInput type="hidden" name="entryAttemptKey" value={entryAttemptKey} />
      <HiddenInput type="hidden" name="source" value={source.type} />
      {"listingId" in source ? <HiddenInput type="hidden" name="listingId" value={source.listingId} /> : null}
      {"fulfillmentMode" in source ? (
        <HiddenInput type="hidden" name="fulfillmentMode" value={source.fulfillmentMode} />
      ) : null}
      {"lockedListingId" in source ? (
        <HiddenInput type="hidden" name="lockedListingId" value={source.lockedListingId ?? ""} />
      ) : null}
      <HiddenInput type="hidden" name="catalogItemId" value={source.catalogItemId} />
      <HiddenInput type="hidden" name="productId" value={source.productId} />
      <HiddenInput type="hidden" name="itemTitle" value={source.itemTitle} />
      <HiddenInput type="hidden" name="itemSubtitle" value={source.itemSubtitle ?? ""} />
      <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(source.selectedOptions)} />
      <HiddenInput type="hidden" name="productSummary" value={source.productSummary ?? ""} />
      <HiddenInput type="hidden" name="quantity" value={source.quantity} />
      {"offerPriceAmount" in source ? (
        <HiddenInput type="hidden" name="offerPriceAmount" value={source.offerPriceAmount} />
      ) : null}
      {"priceAmount" in source ? (
        <HiddenInput type="hidden" name="priceAmount" value={source.priceAmount ?? ""} />
      ) : null}
      {"sellerName" in source ? <HiddenInput type="hidden" name="sellerName" value={source.sellerName ?? ""} /> : null}
      {"availability" in source ? (
        <HiddenInput type="hidden" name="availability" value={source.availability ?? ""} />
      ) : null}
      {"fulfillment" in source ? (
        <HiddenInput type="hidden" name="fulfillment" value={source.fulfillment ?? ""} />
      ) : null}
    </>
  );
}

export function CheckoutStartSourceSummary({ source }: { source: CheckoutStartSource }) {
  return (
    <OrderIntentSummary
      title={source.itemTitle || t("checkout.routes.checkoutStart.buy.now")}
      subtitle={
        source.itemSubtitle ??
        (source.productSummary ? (
          <ProductOptions options={productOptionsFromSummary(source.productSummary)} variant="compact" />
        ) : null)
      }
      price={
        source.type === "offer-intent"
          ? formatMoney(source.offerPriceAmount, "USD")
          : source.priceAmount
            ? formatMoney(source.priceAmount, "USD")
            : t("checkout.routes.checkoutStart.price.confirmed.before.payment")
      }
      quantity={formatMarketplaceNumber(
        source.quantity,
        t("checkout.routes.checkoutStart.quantity.confirmed.before.payment"),
      )}
      seller={
        source.type === "buy-now"
          ? (source.sellerName ?? t("checkout.routes.checkoutStart.marketplace.seller"))
          : t("checkout.routes.checkoutStart.marketplace.seller")
      }
      availability={
        source.type === "buy-now"
          ? (source.availability ?? t("checkout.routes.checkoutStart.availability.confirmed.before.payment"))
          : t("checkout.routes.checkoutStart.waiting.for.seller.acceptance")
      }
      fulfillment={
        source.type === "buy-now"
          ? (source.fulfillment ?? t("checkout.routes.checkoutStart.fulfillment.confirmed.before.payment"))
          : t("checkout.routes.checkoutStart.offer.submitted.after.registration")
      }
      protection={t("checkout.routes.checkoutStart.buyer.protection.included")}
      paymentStatus={
        source.type === "offer-intent"
          ? t("checkout.routes.checkoutStart.no.payment.today")
          : t("checkout.routes.checkoutStart.not.charged.yet")
      }
    />
  );
}

export type CheckoutStartSummaryProps = Readonly<{
  source: CheckoutStartSource | null;
  cartCount: number;
  isSignedIn: boolean;
  isGuestBuyer: boolean;
  isOfferIntent: boolean;
  checkoutStatus: string;
}>;

function cartCountLine(cartCount: number) {
  return t("checkout.routes.checkoutStart.item.count", {
    count: cartCount,
    itemLabel: cartCount === 1 ? t("checkout.routes.checkoutStart.item") : t("checkout.routes.checkoutStart.items"),
  });
}

export function CheckoutStartSummary({
  source,
  cartCount,
  isSignedIn,
  isGuestBuyer,
  isOfferIntent,
  checkoutStatus,
}: CheckoutStartSummaryProps) {
  return (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          {
            label: source ? t("checkout.routes.checkoutStart.source") : t("checkout.routes.checkoutStart.cart"),
            value: source ? source.itemTitle || t("checkout.routes.checkoutStart.buy.now") : cartCountLine(cartCount),
          },
          ...(source
            ? [
                {
                  label: t("checkout.routes.checkoutStart.seller"),
                  value:
                    source.type === "buy-now"
                      ? (source.sellerName ?? t("checkout.routes.checkoutStart.marketplace.seller"))
                      : t("checkout.routes.checkoutStart.marketplace.seller"),
                },
                {
                  label: t("checkout.routes.checkoutStart.price"),
                  value:
                    source.type === "offer-intent"
                      ? formatMoney(source.offerPriceAmount, "USD")
                      : source.priceAmount
                        ? formatMoney(source.priceAmount, "USD")
                        : t("checkout.routes.checkoutStart.price.confirmed.before.payment"),
                },
                {
                  label: t("checkout.routes.checkoutStart.quantity"),
                  value: formatMarketplaceNumber(
                    source.quantity,
                    t("checkout.routes.checkoutStart.quantity.confirmed.before.payment"),
                  ),
                },
              ]
            : []),
          {
            label: t("checkout.routes.checkoutStart.account.choice"),
            value: isGuestBuyer
              ? t("checkout.routes.checkoutStart.guest.checkout.active")
              : isSignedIn
                ? t("checkout.routes.checkoutStart.signed.in")
                : isOfferIntent
                  ? t("checkout.routes.checkoutStart.register.or.sign.in")
                  : t("checkout.routes.checkoutStart.sign.in.or.guest"),
          },
          {
            label: t("checkout.routes.checkoutStart.payment"),
            value: isOfferIntent
              ? t("checkout.routes.checkoutStart.no.payment.today")
              : t("checkout.routes.checkoutStart.not.charged.yet"),
          },
        ]}
        total={checkoutStatus}
        totalLabel={t("checkout.routes.checkoutStart.checkout.status")}
        reassurance={
          <SecurePaymentIndicator
            label={
              isOfferIntent
                ? t("checkout.routes.checkoutStart.no.payment.today")
                : t("checkout.routes.checkoutStart.secure.payment")
            }
          />
        }
      />
      <OrderProtectionModule items={checkoutStartBuyerProtectionItems(isOfferIntent)} />
    </Stack>
  );
}

export function CheckoutStartMobileSummary(props: CheckoutStartSummaryProps) {
  return (
    <CheckoutMobileSummaryDisclosure
      label={t("checkout.routes.checkoutStart.checkout.status")}
      collapsedSummary={
        props.source
          ? props.source.itemTitle || t("checkout.routes.checkoutStart.buy.now")
          : cartCountLine(props.cartCount)
      }
      total={props.checkoutStatus}
    >
      <CheckoutStartSummary {...props} />
    </CheckoutMobileSummaryDisclosure>
  );
}
