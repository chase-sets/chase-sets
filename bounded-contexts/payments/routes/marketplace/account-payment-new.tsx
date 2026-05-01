import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import {
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  Grid,
  LinkButton,
  NativeSelect,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createPaymentsRequestApiClient,
  normalizeRequestedBalanceCreditAmount,
} from "../../support/request-support/api-client";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";

function parseOrderIds(value: string | null) {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatMoney(amount: string) {
  return `$${amount}`;
}

function parseMoneyAmount(value: FormDataEntryValue | null) {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalMoney(value: number) {
  return Math.max(0, value).toFixed(2);
}

function requestedBalanceCreditFromForm(formData: FormData) {
  const mode = String(formData.get("balanceCreditMode") ?? "none");
  if (mode === "none") {
    return null;
  }
  if (mode === "max") {
    const total = parseMoneyAmount(formData.get("totalAmount"));
    const available = parseMoneyAmount(formData.get("availableBalance"));
    return decimalMoney(Math.min(total, available));
  }

  return normalizeRequestedBalanceCreditAmount(
    formData.get("requestedBalanceCreditAmount"),
  );
}

async function loadWalletBalance(request: Request) {
  const response = await createForwardedAuthFetch(request)(
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

  const orderingApi = createOrderingRequestApiClient(request);

  try {
    const orders = await Promise.all(orderIds.map((orderId) => orderingApi.getPurchase(orderId)));
    const wallet = await loadWalletBalance(request);
    return {
      orderIds,
      orders,
      autostart: url.searchParams.get("autostart") === "1",
      wallet,
    };
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) {
      throw new Response("Purchase not found.", { status: 404 });
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
    return { error: "Choose at least one order to pay." };
  }

  const paymentsApi = createPaymentsRequestApiClient(request);

  try {
    const payment = await paymentsApi.createAccountPayment({
      orderIds,
      requestedBalanceCreditAmount: normalizeRequestedBalanceCreditAmount(
        requestedBalanceCreditFromForm(formData),
      ),
    });
    return redirect(`/account/payments/${payment.payment_id}`);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Payment could not be started.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Start Payment | Marketplace" });

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

  const totalAmount = data.orders
    .reduce((sum, order) => sum + Number.parseFloat(order.total_amount), 0)
    .toFixed(2);
  const marketplaceFeeAmount = data.orders
    .reduce((sum, order) => sum + Number.parseFloat(order.marketplace_fee_amount), 0)
    .toFixed(2);
  const paymentFeeAmount = data.orders
    .reduce((sum, order) => sum + Number.parseFloat(order.payment_fee_amount), 0)
    .toFixed(2);
  const sellerNetAmount = data.orders
    .reduce((sum, order) => sum + Number.parseFloat(order.seller_net_amount), 0)
    .toFixed(2);
  const availableBalanceAmount = Number.parseFloat(data.wallet?.available_balance_amount ?? "0.00");
  const maxBalanceCreditAmount = decimalMoney(Math.min(Number.parseFloat(totalAmount), availableBalanceAmount));
  const externalAfterMaxAmount = decimalMoney(Number.parseFloat(totalAmount) - Number.parseFloat(maxBalanceCreditAmount));

  return (
    <Page>
      <PageHeader
        eyebrow="Secure Checkout"
        title="Start payment"
        description="Review the purchases created by checkout, then initialize the secure payment flow."
        actions={
          <LinkButton href="/account/purchases" tone="secondary">
            Back to purchases
          </LinkButton>
        }
      />

      <CheckoutLayout
        summary={
          <Stack gap={3}>
            <OrderSummary
              title="Checkout Summary"
              lines={[
                { label: "Purchases", value: data.orders.length },
                { label: "Marketplace fees", value: formatMoney(marketplaceFeeAmount) },
                { label: "Payment fees", value: formatMoney(paymentFeeAmount) },
                { label: "Seller net", value: formatMoney(sellerNetAmount) },
                ...(data.wallet
                  ? [
                      {
                        label: "Available balance",
                        value: `${data.wallet.available_balance_amount} ${data.wallet.currency_code.toUpperCase()}`,
                      },
                    ]
                  : []),
              ]}
              total={formatMoney(totalAmount)}
            />
            <CheckoutTrustPanel
              items={[
                {
                  icon: "lock",
                  title: "Secure Payment",
                  description: "Payment details are collected by the secure processor so marketplace servers never handle card numbers.",
                },
                {
                  icon: "shield",
                  title: "Buyer Protection",
                  description: "The secure form can use wallets, dynamic payment methods, and extra verification when needed.",
                },
                {
                  icon: "creditCard",
                  title: "Payment Setup",
                  description: "The next step initializes a managed payment form tied to this checkout.",
                },
              ]}
            />
          </Stack>
        }
      >
        <Stack gap={4}>
          <Surface elevated glow>
            <Stack gap={4}>
              <Stack gap={2}>
                <Badge tone="accent">Payment setup</Badge>
                <Text weight="semibold">Ready to initialize payment</Text>
                <Text size="sm" tone="secondary">
                  Payment covers {data.orders.length} purchase
                  {data.orders.length === 1 ? "" : "s"} created by checkout. The secure payment form appears on the next screen.
                </Text>
              </Stack>
              {actionData?.error ? (
                <Surface tone="subtle">
                  <Text>{actionData.error}</Text>
                </Surface>
              ) : null}
              <Form method="post" ref={formRef}>
                <Stack gap={3}>
                  <input type="hidden" name="orderIds" value={data.orderIds.join(",")} />
                  <input type="hidden" name="totalAmount" value={totalAmount} />
                  <input
                    type="hidden"
                    name="availableBalance"
                    value={data.wallet?.available_balance_amount ?? "0.00"}
                  />
                  <NativeSelect
                    label="Wallet balance"
                    name="balanceCreditMode"
                    defaultValue={availableBalanceAmount > 0 ? "max" : "none"}
                    items={[
                      { value: "none", label: "Do not use balance" },
                      {
                        value: "max",
                        label: `Use up to ${formatMoney(maxBalanceCreditAmount)}`,
                        disabled: availableBalanceAmount <= 0,
                      },
                      { value: "custom", label: "Use a custom amount" },
                    ]}
                    description={
                      data.wallet
                        ? `Using the maximum leaves ${formatMoney(externalAfterMaxAmount)} for secure external payment.`
                        : "No wallet balance is available for this checkout."
                    }
                  />
                  <TextInput
                    label="Custom wallet amount"
                    name="requestedBalanceCreditAmount"
                    placeholder="0.00"
                    inputMode="decimal"
                    description={
                      data.wallet
                        ? `${data.wallet.available_balance_amount} ${data.wallet.currency_code.toUpperCase()} available; choose custom only when you want less than the maximum.`
                        : "Apply available wallet balance to this payment."
                    }
                  />
                  <Button type="submit" size="lg" leadingIcon="lock">
                    {navigation.state === "submitting" ? "Starting payment..." : "Continue to payment"}
                  </Button>
                </Stack>
              </Form>
            </Stack>
          </Surface>

          <PageSection title="Purchases">
            <Stack gap={3}>
              {data.orders.map((order) => (
                <Surface key={order.order_id} elevated>
                  <Stack gap={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Text weight="semibold">Purchase {order.order_id}</Text>
                        <Badge tone="accent">{order.status}</Badge>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">Total</Text>
                        <Text weight="semibold">{formatMoney(order.total_amount)}</Text>
                      </Stack>
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">Seller net</Text>
                        <Text>{formatMoney(order.seller_net_amount)}</Text>
                      </Stack>
                    </Grid>
                    <Divider />
                    <LinkButton href={`/account/purchases/${order.order_id}`} tone="secondary">
                      Open purchase
                    </LinkButton>
                  </Stack>
                </Surface>
              ))}
            </Stack>
          </PageSection>
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}
