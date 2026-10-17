import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import {
  centsToMoneyAmount,
  compareMoneyAmounts,
  isCanonicalMoneyAmount,
  sumMoneyAmounts,
  trySignedMoneyToCents,
} from "@chase-sets/primitives/money";
import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  HiddenInput,
  Form,
  Badge,
  OrderProtectionModule,
  Button,
  CheckoutLayout,
  Divider,
  Grid,
  ImageGallery,
  Inset,
  LinkButton,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createPaymentsRequestApiClient,
  normalizeRequestedBalanceCreditAmount,
  type PaymentsAccountOrderInput,
} from "../../support/request-support/api-client";

function parseOrderIds(value: string | null) {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatMoney(amount: string) {
  return formatMoneyDisplay(amount, "USD");
}

function sumOrderAmounts(amounts: readonly string[]) {
  if (amounts.some((amount) => !isCanonicalMoneyAmount(amount))) {
    throw new Error("Order amounts must be canonical money amounts.");
  }
  return sumMoneyAmounts(amounts);
}

function calculateBalanceCredit(totalAmount: string, availableBalance: FormDataEntryValue | null) {
  const totalCents = trySignedMoneyToCents(totalAmount) ?? 0n;
  const availableBalanceCents = trySignedMoneyToCents(String(availableBalance ?? "0.00")) ?? 0n;
  const nonNegativeTotal = totalCents > 0n ? totalCents : 0n;
  const nonNegativeAvailable = availableBalanceCents > 0n ? availableBalanceCents : 0n;
  const creditCents = nonNegativeTotal < nonNegativeAvailable ? nonNegativeTotal : nonNegativeAvailable;
  return {
    availableBalanceCents,
    maxBalanceCreditAmount: centsToMoneyAmount(creditCents),
    externalAfterMaxAmount: centsToMoneyAmount(nonNegativeTotal - creditCents),
  };
}

function paymentMethodLabel(method: string) {
  if (method === "bank-account") {
    return t("payments.routes.marketplace.accountPaymentNew.bank.account");
  }
  if (method === "platform-credit") {
    return t("payments.routes.marketplace.accountPaymentNew.platform.credit");
  }
  return t("payments.routes.marketplace.accountPaymentNew.card");
}

function requestedBalanceCreditFromForm(formData: FormData) {
  const mode = String(formData.get("balanceCreditMode") ?? "none");
  if (mode === "none") {
    return null;
  }
  if (mode === "max") {
    return calculateBalanceCredit(String(formData.get("totalAmount") ?? "0.00"), formData.get("availableBalance"))
      .maxBalanceCreditAmount;
  }

  return normalizeRequestedBalanceCreditAmount(formData.get("requestedBalanceCreditAmount"));
}

async function loadWalletBalance(request: Request) {
  const response = await createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "settlement" })(
    `${resolveRequestApiBaseUrl(request, "/api/settlement")}/wallet`,
  );

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<{
    available_balance_amount: string;
    currency_code: string;
  }>;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "orders.manage",
  });
  const url = new URL(request.url);
  const orderIds = parseOrderIds(url.searchParams.get("orderIds"));

  if (orderIds.length === 0) {
    throw redirect("/account/purchases");
  }

  const paymentsApi = createPaymentsRequestApiClient(request);

  try {
    const { orders } = await paymentsApi.listAccountOrderInputs({ orderIds });
    const wallet = await loadWalletBalance(request);
    const totalAmount = sumOrderAmounts(orders.map((order) => order.total_amount));
    const { maxBalanceCreditAmount: requestedBalanceCreditAmount } = calculateBalanceCredit(
      totalAmount,
      wallet?.available_balance_amount ?? null,
    );
    const checkoutStatus = await paymentsApi.getCheckoutStatus({
      orderIds,
      requestedBalanceCreditAmount,
      paymentMethodCategory: "card",
    });
    return {
      orderIds,
      orders,
      autostart: url.searchParams.get("autostart") === "1",
      wallet,
      checkoutStatus,
    };
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) {
      throw new Response(t("payments.routes.marketplace.accountPaymentNew.purchase.not.found"), { status: 404 });
    }

    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "orders.manage",
  });
  const formData = await request.formData();
  const orderIds = parseOrderIds(String(formData.get("orderIds") ?? ""));
  if (orderIds.length === 0) {
    return { error: t("payments.routes.marketplace.accountPaymentNew.choose.at.least.one.order.to") };
  }

  const paymentsApi = createPaymentsRequestApiClient(request);

  try {
    const requestedBalanceCreditAmount = normalizeRequestedBalanceCreditAmount(
      requestedBalanceCreditFromForm(formData),
    );
    const paymentMethodCategory = String(formData.get("paymentMethodCategory") ?? "card");
    const checkoutStatus = await paymentsApi.getCheckoutStatus({
      orderIds,
      requestedBalanceCreditAmount,
      paymentMethodCategory,
    });
    const payment = await paymentsApi.createAccountPayment({
      orderIds,
      requestedBalanceCreditAmount,
      paymentMethodCategory,
      marketplaceCheckoutFeeQuoteFingerprint: checkoutStatus.marketplace_checkout_fee.quote_fingerprint,
    });
    return redirect(
      await navigateAfterWriteWithPlatformPostWriteToken(payment, `/account/payments/${payment.payment_id}`),
    );
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : t("payments.routes.marketplace.accountPaymentNew.payment.could.not.be.started"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("payments.routes.marketplace.accountPaymentNew.start.payment.marketplace") });

export default function MarketplaceAccountPaymentNewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement | null>(null);
  const hasAutoSubmittedRef = useRef(false);

  useEffect(() => {
    if (
      !data.autostart ||
      actionData?.error ||
      hasAutoSubmittedRef.current ||
      navigation.state !== "idle" ||
      !formRef.current
    ) {
      return;
    }

    hasAutoSubmittedRef.current = true;
    submit(formRef.current, { method: "post" });
  }, [actionData?.error, data.autostart, navigation.state, submit]);

  const totalAmount = sumOrderAmounts(data.orders.map((order) => order.total_amount));
  const marketplaceSalesFeeAmount = sumOrderAmounts(data.orders.map((order) => order.marketplace_sales_fee_amount));
  const sellerPayoutAmount = sumOrderAmounts(data.orders.map((order) => order.seller_payout_amount));
  const salesTaxAmount = sumOrderAmounts(data.orders.map((order) => order.sales_tax_amount ?? "0.00"));
  const selectedCheckoutFee = data.checkoutStatus.marketplace_checkout_fee;
  const { availableBalanceCents, maxBalanceCreditAmount, externalAfterMaxAmount } = calculateBalanceCredit(
    totalAmount,
    data.wallet?.available_balance_amount ?? null,
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("payments.routes.marketplace.accountPaymentNew.secure.checkout")}
        title={t("payments.routes.marketplace.accountPaymentNew.start.payment")}
        description={t("payments.routes.marketplace.accountPaymentNew.review.the.purchases.created.by.checkout")}
        actions={
          <LinkButton href="/account/purchases" tone="secondary">
            {t("payments.routes.marketplace.accountPaymentNew.back.to.purchases")}
          </LinkButton>
        }
      />

      <CheckoutLayout
        summaryLabel="Payment summary"
        summary={
          <Stack gap={3}>
            <PriceBreakdown
              lines={[
                { label: t("payments.routes.marketplace.accountPaymentNew.purchases"), value: data.orders.length },
                {
                  label: t("payments.routes.marketplace.accountPaymentNew.marketplace.sales.fee"),
                  value: formatMoney(marketplaceSalesFeeAmount),
                },
                {
                  label: t("payments.routes.marketplace.accountPaymentNew.seller.payout"),
                  value: formatMoney(sellerPayoutAmount),
                },
                {
                  label: t("payments.routes.marketplace.accountPaymentNew.sales.tax"),
                  value: formatMoney(salesTaxAmount),
                },
                {
                  label: t("payments.routes.marketplace.accountPaymentNew.marketplace.checkout.fee"),
                  value: formatMoney(selectedCheckoutFee.marketplace_checkout_fee_amount),
                },
                ...(data.wallet
                  ? [
                      {
                        label: t("payments.routes.marketplace.accountPaymentNew.available.balance"),
                        value: `${data.wallet.available_balance_amount} ${data.wallet.currency_code.toUpperCase()}`,
                      },
                    ]
                  : []),
                {
                  label: t("payments.routes.marketplace.accountPaymentNew.payment.method.charge", {
                    method: paymentMethodLabel(selectedCheckoutFee.payment_method_category),
                  }),
                  value: formatMoney(selectedCheckoutFee.processor_amount),
                },
              ]}
              total={formatMoney(selectedCheckoutFee.total_amount)}
              totalLabel={t("payments.routes.marketplace.accountPaymentNew.total.due")}
              reassurance={
                <SecurePaymentIndicator label={t("payments.routes.marketplace.accountPaymentNew.secure.payment")} />
              }
            />
            <OrderProtectionModule
              title={t("payments.routes.marketplace.accountPaymentNew.checkout.confidence")}
              items={[
                {
                  title: t("payments.routes.marketplace.accountPaymentNew.secure.payment"),
                  description: t("payments.routes.marketplace.accountPaymentNew.payment.details.are.collected.by.the"),
                },
                {
                  title: t("payments.routes.marketplace.accountPaymentNew.buyer.protection"),
                  description: t("payments.routes.marketplace.accountPaymentNew.the.secure.form.can.use.wallets"),
                },
                {
                  title: t("payments.routes.marketplace.accountPaymentNew.payment.setup"),
                  description: t("payments.routes.marketplace.accountPaymentNew.the.next.step.initializes.a.managed"),
                },
              ]}
            />
            {data.orders.some((order) => (order.listing_evidence ?? []).length > 0) ? (
              <PageSection title={t("payments.routes.marketplace.accountPaymentNew.seller.evidence.at.acceptance")}>
                <Stack gap={3}>
                  {data.orders.flatMap((order) =>
                    (order.listing_evidence ?? []).map((evidence) => {
                      const images = evidence.gallery.flatMap((image) => {
                        const asset =
                          image.assets.find((candidate) => candidate.role === "catalog-detail") ??
                          image.assets.find((candidate) => candidate.role === "search-card") ??
                          image.assets[0];
                        return asset
                          ? [{ src: asset.publicUrl, alt: image.altText ?? `${evidence.item_title} evidence` }]
                          : [];
                      });
                      return (
                        <Surface key={`${order.order_id}:${evidence.line_id}`} elevation="outlined">
                          <Stack gap={2}>
                            <Text weight="semibold">{evidence.item_title}</Text>
                            <ImageGallery images={images} aspectRatio="3/4" thumbnailPlacement="left" />
                            <Text size="sm" tone="secondary">
                              {t(
                                "payments.routes.marketplace.accountPaymentNew.seller.evidence.at.acceptance.description",
                              )}
                            </Text>
                          </Stack>
                        </Surface>
                      );
                    }),
                  )}
                </Stack>
              </PageSection>
            ) : null}
          </Stack>
        }
      >
        <Stack gap={4}>
          <MarketplaceNotice
            tone="info"
            title={t("payments.routes.marketplace.accountPaymentNew.transparent.totals")}
            description={t("payments.routes.marketplace.accountPaymentNew.transparent.totals.description")}
          />
          <Surface elevation="elevated" glow>
            <Stack gap={4}>
              <Stack gap={2}>
                <Badge tone="accent">{t("payments.routes.marketplace.accountPaymentNew.payment.setup.2")}</Badge>
                <Text weight="semibold">
                  {t("payments.routes.marketplace.accountPaymentNew.ready.to.initialize.payment")}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("payments.routes.marketplace.accountPaymentNew.payment.covers.purchases", {
                    count: data.orders.length,
                    purchaseLabel: t(
                      data.orders.length === 1
                        ? "payments.routes.marketplace.accountPaymentNew.purchase.singular"
                        : "payments.routes.marketplace.accountPaymentNew.purchase.plural",
                    ),
                  })}
                </Text>
              </Stack>
              {actionData?.error ? (
                <Inset>
                  <Text>{actionData.error}</Text>
                </Inset>
              ) : null}
              <RouterForm id="payment-start-form" method="post" ref={formRef} spacing="none">
                <Stack gap={3}>
                  <HiddenInput type="hidden" name="orderIds" value={data.orderIds.join(",")} />
                  <HiddenInput type="hidden" name="totalAmount" value={totalAmount} />
                  <HiddenInput
                    type="hidden"
                    name="availableBalance"
                    value={data.wallet?.available_balance_amount ?? "0.00"}
                  />
                  <NativeSelect
                    label={t("payments.routes.marketplace.accountPaymentNew.payment.method")}
                    name="paymentMethodCategory"
                    defaultValue="card"
                    items={[
                      { value: "card", label: t("payments.routes.marketplace.accountPaymentNew.card") },
                      { value: "bank-account", label: t("payments.routes.marketplace.accountPaymentNew.bank.account") },
                      {
                        value: "platform-credit",
                        label: t("payments.routes.marketplace.accountPaymentNew.platform.credit.only"),
                        disabled: compareMoneyAmounts(externalAfterMaxAmount, "0.00") > 0,
                      },
                    ]}
                    description={t(
                      "payments.routes.marketplace.accountPaymentNew.marketplace.checkout.fee.description",
                    )}
                  />
                  <NativeSelect
                    label={t("payments.routes.marketplace.accountPaymentNew.wallet.balance")}
                    name="balanceCreditMode"
                    defaultValue={availableBalanceCents > 0n ? "max" : "none"}
                    items={[
                      { value: "none", label: t("payments.routes.marketplace.accountPaymentNew.do.not.use.balance") },
                      {
                        value: "max",
                        label: t("payments.routes.marketplace.accountPaymentNew.use.up.to.amount", {
                          amount: formatMoney(maxBalanceCreditAmount),
                        }),
                        disabled: availableBalanceCents <= 0n,
                      },
                      {
                        value: "custom",
                        label: t("payments.routes.marketplace.accountPaymentNew.use.a.custom.amount"),
                      },
                    ]}
                    description={
                      data.wallet
                        ? t("payments.routes.marketplace.accountPaymentNew.maximum.leaves.external.payment", {
                            amount: formatMoney(externalAfterMaxAmount),
                          })
                        : t("payments.routes.marketplace.accountPaymentNew.no.wallet.balance.is.available.for")
                    }
                  />
                  <TextInput
                    label={t("payments.routes.marketplace.accountPaymentNew.custom.wallet.amount")}
                    name="requestedBalanceCreditAmount"
                    placeholder="0.00"
                    inputMode="decimal"
                    description={
                      data.wallet
                        ? t("payments.routes.marketplace.accountPaymentNew.wallet.available.custom.description", {
                            amount: data.wallet.available_balance_amount,
                            currency: data.wallet.currency_code.toUpperCase(),
                          })
                        : t("payments.routes.marketplace.accountPaymentNew.apply.available.wallet.balance.to.this")
                    }
                  />
                  <Button type="submit" size="lg" leadingIcon="lock">
                    {navigation.state === "submitting"
                      ? t("payments.routes.marketplace.accountPaymentNew.starting.payment")
                      : t("payments.routes.marketplace.accountPaymentNew.continue.to.payment")}
                  </Button>
                </Stack>
              </RouterForm>
            </Stack>
          </Surface>

          <PageSection title={t("payments.routes.marketplace.accountPaymentNew.payment.method.fee.preview")}>
            <Grid columns={{ base: 1, md: 3 }} gap={3}>
              {data.checkoutStatus.payment_method_quotes.map((quote) => (
                <Surface key={quote.payment_method_category} elevation="outlined">
                  <Stack gap={2}>
                    <Badge tone={quote.payment_method_category === "card" ? "accent" : "success"}>
                      {paymentMethodLabel(quote.payment_method_category)}
                    </Badge>
                    <Text weight="semibold">
                      {t("payments.routes.marketplace.accountPaymentNew.marketplace.checkout.fee.amount", {
                        amount: formatMoney(quote.marketplace_checkout_fee_amount),
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {compareMoneyAmounts(quote.marketplace_checkout_fee_reduction_amount, "0.00") > 0
                        ? t("payments.routes.marketplace.accountPaymentNew.reduction.from.card", {
                            amount: formatMoney(quote.marketplace_checkout_fee_reduction_amount),
                          })
                        : t("payments.routes.marketplace.accountPaymentNew.base.card.checkout.fee")}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("payments.routes.marketplace.accountPaymentNew.final.payment", {
                        amount: formatMoney(quote.total_amount),
                      })}
                    </Text>
                  </Stack>
                </Surface>
              ))}
            </Grid>
          </PageSection>

          <PageSection title={t("payments.routes.marketplace.accountPaymentNew.purchases.2")}>
            <Stack gap={3}>
              {data.orders.map((order: PaymentsAccountOrderInput) => (
                <Surface key={order.order_id} elevation="outlined">
                  <Stack gap={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Text weight="semibold">
                          {t("payments.routes.marketplace.accountPaymentNew.purchase")}
                          {order.order_id}
                        </Text>
                        <Badge tone="accent">{order.status}</Badge>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("payments.routes.marketplace.accountPaymentNew.total")}
                        </Text>
                        <Text weight="semibold">{formatMoney(order.total_amount)}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("payments.routes.marketplace.accountPaymentNew.seller.payout")}
                        </Text>
                        <Text>{formatMoney(order.seller_payout_amount)}</Text>
                      </Stack>
                    </Grid>
                    <Divider />
                    <LinkButton href={`/account/purchases/${order.order_id}`} tone="secondary">
                      {t("payments.routes.marketplace.accountPaymentNew.open.purchase")}
                    </LinkButton>
                  </Stack>
                </Surface>
              ))}
            </Stack>
          </PageSection>

          <StickyCtaBar
            total={formatMoney(selectedCheckoutFee.total_amount)}
            context={t("payments.routes.marketplace.accountPaymentNew.final.totals.before.payment")}
            primaryAction={
              <Button
                type="submit"
                form="payment-start-form"
                leadingIcon="lock"
                loading={navigation.state === "submitting"}
              >
                {navigation.state === "submitting"
                  ? t("payments.routes.marketplace.accountPaymentNew.starting.payment")
                  : t("payments.routes.marketplace.accountPaymentNew.continue.to.payment")}
              </Button>
            }
            secondaryAction={
              <LinkButton href="/account/purchases" tone="secondary">
                {t("payments.routes.marketplace.accountPaymentNew.back.to.purchases")}
              </LinkButton>
            }
          />
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
