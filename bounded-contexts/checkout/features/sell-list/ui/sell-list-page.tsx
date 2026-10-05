import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  CheckoutLayout,
  Form,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { CheckoutSellListConfirmationRow, CheckoutSellListLineRow } from "../read-model/queries";
import { SELLER_CHECKOUT_REGISTER_HREF, SELLER_CHECKOUT_SIGN_IN_HREF } from "./registration-return";
import { LatestSellListConfirmationPanel } from "./sell-list-confirmation-panel";
import { formatMoney } from "./sell-list-formatting";
import { SellListReviewGrid } from "./sell-list-review-grid";
import { useSellListPageModel } from "./use-sell-list-page-model";
import type {
  PayoutReadiness,
  SellListInventoryItem,
  SellListOfferReview,
  SellListProductOfferReview,
  SellListRecoveryState,
} from "./sell-list-page-types";

export type {
  PayoutReadiness,
  SellListInventoryItem,
  SellListOfferReview,
  SellListProductOfferReview,
  SellListRecoveryState,
} from "./sell-list-page-types";

export function CheckoutSellListPage({
  sellListLines,
  isSignedIn = true,
  offerReviews = [],
  productOfferReviews = [],
  inventoryItems = [],
  payoutReadiness = null,
  latestConfirmation = null,
  registrationReturn = null,
  mergedLineCount = 0,
  mergeError = null,
  sellerCheckoutRegisterHref = SELLER_CHECKOUT_REGISTER_HREF,
  sellerCheckoutSignInHref = SELLER_CHECKOUT_SIGN_IN_HREF,
  errorMessage = null,
  recoveryMessage = null,
  recoveryState = null,
  sellListPath = "/account/sell-list",
}: {
  sellListLines: readonly CheckoutSellListLineRow[];
  isSignedIn?: boolean;
  offerReviews?: readonly SellListOfferReview[];
  productOfferReviews?: readonly SellListProductOfferReview[];
  inventoryItems?: readonly SellListInventoryItem[];
  payoutReadiness?: PayoutReadiness | null;
  latestConfirmation?: CheckoutSellListConfirmationRow | null;
  registrationReturn?: "seller-checkout" | null;
  mergedLineCount?: number;
  mergeError?: string | null;
  sellerCheckoutRegisterHref?: string;
  sellerCheckoutSignInHref?: string;
  errorMessage?: string | null;
  recoveryMessage?: string | null;
  recoveryState?: SellListRecoveryState | null;
  sellListPath?: string;
}) {
  const model = useSellListPageModel({
    sellListLines,
    isSignedIn,
    offerReviews,
    productOfferReviews,
    inventoryItems,
    payoutReadiness,
    sellListPath,
  });
  const expectedPayout =
    model.expectedSellerPayout === null
      ? t("checkout.features.sellList.ui.sellListPage.not.quoted.yet")
      : formatMoney(model.expectedSellerPayout);
  const payoutRequirements = [
    ...new Set(
      (payoutReadiness?.missing_requirements ?? []).map((requirement) => {
        switch (requirement) {
          case "provider-onboarding":
            return t("checkout.features.sellList.ui.sellListPage.requirement.payout.setup");
          case "seller-agreement":
            return t("checkout.features.sellList.ui.sellListPage.requirement.seller.agreement");
          case "external_account":
          case "bank account":
            return t("checkout.features.sellList.ui.sellListPage.requirement.payout.account");
          default:
            return t("checkout.features.sellList.ui.sellListPage.requirement.review");
        }
      }),
    ),
  ];

  const summary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          { label: t("checkout.features.sellList.ui.sellListPage.items"), value: model.totalQuantity },
          { label: t("checkout.features.sellList.ui.sellListPage.sell.list.lines"), value: sellListLines.length },
          {
            label: t("checkout.features.sellList.ui.sellListPage.selected.offer.gross"),
            value: formatMoney(model.selectedOfferGross),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.expected.seller.payout"),
            value: expectedPayout,
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.future.listing.gross"),
            value: formatMoney(model.futureListingGross),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.estimated.sales.fees"),
            value:
              model.estimatedSalesFees === null
                ? t("checkout.features.sellList.ui.sellListPage.not.quoted.yet")
                : formatMoney(model.estimatedSalesFees),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.payout.readiness"),
            value: !isSignedIn
              ? t("checkout.features.sellList.ui.sellListPage.sign.in.required")
              : payoutReadiness?.status === "ready"
                ? t("checkout.features.sellList.ui.sellListPage.ready")
                : t("checkout.features.sellList.ui.sellListPage.setup.required"),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.line.readiness"),
            value: model.readinessSummary,
          },
        ]}
        total={expectedPayout}
        totalLabel={t("checkout.features.sellList.ui.sellListPage.expected.seller.payout")}
        reassurance={
          <SecurePaymentIndicator label={t("checkout.features.sellList.ui.sellListPage.no.commitment.until.review")} />
        }
      />
    </Stack>
  );

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader
          eyebrow={
            sellListPath === "/account/desk/offers"
              ? t("checkout.features.sellList.ui.sellListPage.seller.desk")
              : t("checkout.features.sellList.ui.sellListPage.checkout")
          }
          title={
            sellListPath === "/account/desk/offers"
              ? t("checkout.features.sellList.ui.sellListPage.offers.and.sell.list")
              : t("checkout.features.sellList.ui.sellListPage.sell.list")
          }
          description={t("checkout.features.sellList.ui.sellListPage.simple.review.description")}
        />

        {!isSignedIn ? (
          <Banner
            title={t("checkout.features.sellList.ui.sellListPage.account.gate.title")}
            description={t("checkout.features.sellList.ui.sellListPage.account.gate.description")}
            tone="info"
            actions={
              <Inline gap={2}>
                <LinkButton href={sellerCheckoutRegisterHref}>
                  {t("checkout.features.sellList.ui.sellListPage.create.account")}
                </LinkButton>
                <LinkButton href={sellerCheckoutSignInHref} tone="secondary">
                  {t("checkout.features.sellList.ui.sellListPage.sign.in")}
                </LinkButton>
              </Inline>
            }
          />
        ) : null}

        {isSignedIn && registrationReturn === "seller-checkout" ? (
          mergeError ? (
            <MarketplaceNotice
              tone="warning"
              title={t("checkout.features.sellList.ui.sellListPage.registration.return.merge.issue.title")}
              description={mergeError}
            />
          ) : mergedLineCount > 0 ? (
            <MarketplaceNotice
              tone="success"
              title={t("checkout.features.sellList.ui.sellListPage.registration.return.merged.title")}
              description={t("checkout.features.sellList.ui.sellListPage.registration.return.merged.description", {
                count: mergedLineCount,
              })}
            />
          ) : (
            <MarketplaceNotice
              tone="info"
              title={t("checkout.features.sellList.ui.sellListPage.registration.return.review.title")}
              description={t("checkout.features.sellList.ui.sellListPage.registration.return.review.description")}
            />
          )
        ) : null}

        {errorMessage ? (
          <MarketplaceNotice
            tone="warning"
            title={t("checkout.features.sellList.ui.sellListPage.checkout.issue")}
            description={errorMessage}
          />
        ) : null}

        {isSignedIn ? <LatestSellListConfirmationPanel confirmation={latestConfirmation} /> : null}

        {sellListLines.length === 0 && recoveryState?.kind === "pending-fresh-write" ? (
          <Surface tone="subtle" elevation="tinted">
            <Stack gap={3}>
              <Badge tone="neutral">
                {recoveryState.isAutoRevalidating
                  ? t("checkout.features.sellList.ui.sellListPage.sell.list.update.pending")
                  : t("checkout.features.sellList.ui.sellListPage.sell.list.update.refreshing")}
              </Badge>
              <Stack gap={1}>
                <Text weight="semibold">
                  {t("checkout.features.sellList.ui.sellListPage.sell.list.update.pending.title")}
                </Text>
                <Text tone="secondary">{recoveryState.message}</Text>
              </Stack>
              <LinkButton href={recoveryState.refreshHref} tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.refresh.sell.list")}
              </LinkButton>
            </Stack>
          </Surface>
        ) : sellListLines.length === 0 && recoveryState?.kind === "missing-after-fresh-write" ? (
          <MarketplaceEmptyState
            title={t("checkout.features.sellList.ui.sellListPage.sell.list.update.missing.title")}
            description={recoveryState.message}
            recoveryActions={
              <>
                <LinkButton href={recoveryState.refreshHref} tone="secondary">
                  {t("checkout.features.sellList.ui.sellListPage.refresh.sell.list")}
                </LinkButton>
                <LinkButton href="/search">
                  {t("checkout.features.sellList.ui.sellListPage.browse.products")}
                </LinkButton>
              </>
            }
          />
        ) : sellListLines.length === 0 && recoveryMessage ? (
          <MarketplaceNotice
            tone="info"
            title={t("checkout.features.sellList.ui.sellListPage.checkout")}
            description={recoveryMessage}
          />
        ) : sellListLines.length === 0 ? (
          <MarketplaceEmptyState
            title={t("checkout.features.sellList.ui.sellListPage.your.sell.list.is.empty")}
            description={t("checkout.features.sellList.ui.sellListPage.add.selected.offers.or.products")}
            recoveryActions={
              <LinkButton href="/search">{t("checkout.features.sellList.ui.sellListPage.browse.products")}</LinkButton>
            }
          />
        ) : (
          <CheckoutLayout
            summaryLabel={t("checkout.features.sellList.ui.sellListPage.sale.checkout.summary")}
            summary={summary}
          >
            <Stack gap={5}>
              <MarketplaceNotice
                tone={model.canContinue ? "success" : "warning"}
                title={
                  !model.canContinue
                    ? t("checkout.features.sellList.ui.sellListPage.some.items.need.action")
                    : t("checkout.features.sellList.ui.sellListPage.ready.for.seller.checkout")
                }
                description={
                  <Stack gap={2}>
                    {model.blockedLineCount > 0 ? (
                      <Text>
                        {t(
                          model.blockedLineCount === 1
                            ? "checkout.features.sellList.ui.sellListPage.resolve.one.before.seller.checkout"
                            : "checkout.features.sellList.ui.sellListPage.resolve.many.before.seller.checkout",
                          {
                            count: model.blockedLineCount,
                          },
                        )}
                      </Text>
                    ) : null}
                    <Text>
                      {t(
                        model.canContinue && isSignedIn
                          ? "checkout.features.sellList.ui.sellListPage.acceptance.ready"
                          : "checkout.features.sellList.ui.sellListPage.acceptance.blocked",
                      )}
                    </Text>
                  </Stack>
                }
              />

              {isSignedIn && payoutReadiness?.status !== "ready" ? (
                <MarketplaceNotice
                  tone="warning"
                  title={t("checkout.features.sellList.ui.sellListPage.payout.setup.required")}
                  description={
                    payoutReadiness
                      ? t("checkout.features.sellList.ui.sellListPage.payout.setup.required.description")
                      : t("checkout.features.sellList.ui.sellListPage.payout.readiness.unavailable.description")
                  }
                  action={
                    <Inline gap={2}>
                      {(payoutRequirements.length > 0
                        ? payoutRequirements
                        : [t("checkout.features.sellList.ui.sellListPage.requirement.review")]
                      ).map((requirement) => (
                        <LinkButton key={requirement} href={model.payoutSetupHref} tone="secondary" size="sm">
                          {requirement}
                        </LinkButton>
                      ))}
                    </Inline>
                  }
                />
              ) : null}

              <PageSection title={t("checkout.features.sellList.ui.sellListPage.review.items")}>
                <SellListReviewGrid
                  lines={sellListLines}
                  offerReviewsByLineId={model.offerReviewsByLineId}
                  productOfferReviewsByLineId={model.productOfferReviewsByLineId}
                  inventoryByProductId={model.inventoryByProductId}
                  canAccept={model.canContinue}
                />
              </PageSection>

              <Surface elevation="tinted">
                <Stack gap={3}>
                  <Text weight="semibold">
                    {t("checkout.features.sellList.ui.sellListPage.seller.checkout.readiness")}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("checkout.features.sellList.ui.sellListPage.seller.checkout.readiness.description")}
                  </Text>
                  <Inline gap={2}>
                    <Form spacing="none" id="sell-list-checkout-form" method="post">
                      <Button
                        type="submit"
                        name="intent"
                        value="review-sell-list-checkout"
                        leadingIcon="check"
                        disabled={!model.canContinue}
                      >
                        {model.primarySellerCheckoutLabel}
                      </Button>
                    </Form>
                    <LinkButton href={model.recoveryHref} tone="secondary">
                      {model.recoveryLabel}
                    </LinkButton>
                  </Inline>
                </Stack>
              </Surface>

              <StickyCtaBar
                price={expectedPayout}
                context={t("checkout.features.sellList.ui.sellListPage.expected.payout.before.checkout")}
                primaryAction={
                  <Button
                    type="submit"
                    form="sell-list-checkout-form"
                    name="intent"
                    value="review-sell-list-checkout"
                    leadingIcon="check"
                    disabled={!model.canContinue}
                  >
                    {model.primarySellerCheckoutLabel}
                  </Button>
                }
                secondaryAction={
                  <LinkButton href={model.recoveryHref} tone="secondary">
                    {model.recoveryLabel}
                  </LinkButton>
                }
              />
            </Stack>
          </CheckoutLayout>
        )}
      </Stack>
    </Page>
  );
}
