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
  Badge,
  Button,
  CheckoutLayout,
  CheckoutTrustPanel,
  Divider,
  Grid,
  LinkButton,
  OrderSummary,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createPaymentsRequestApiClient } from "../../support/request-support/api-client";
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

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "orders.manage",
  });
  const url = new URL(request.url);
  const orderIds = parseOrderIds(url.searchParams.get("orderIds"));

  if (orderIds.length === 0) {
    throw redirect("/account/orders");
  }

  const orderingApi = createOrderingRequestApiClient(request);

  try {
    const orders = await Promise.all(orderIds.map((orderId) => orderingApi.getBuyerOrder(orderId)));
    return {
      orderIds,
      orders,
      autostart: url.searchParams.get("autostart") === "1",
    };
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) {
      throw new Response("Order not found.", { status: 404 });
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
    const payment = await paymentsApi.createBuyerPayment({ orderIds });
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

  return (
    <Page>
      <PageHeader
        eyebrow="Secure Checkout"
        title="Start payment"
        description="Review the seller-specific orders created by checkout, then initialize the secure payment flow."
        actions={
          <LinkButton href="/account/orders" tone="secondary">
            Back to orders
          </LinkButton>
        }
      />

      <CheckoutLayout
        summary={
          <Stack gap={3}>
            <OrderSummary
              title="Checkout Summary"
              lines={[
                { label: "Orders", value: data.orders.length },
                { label: "Marketplace fees", value: formatMoney(marketplaceFeeAmount) },
                { label: "Payment fees", value: formatMoney(paymentFeeAmount) },
                { label: "Seller net", value: formatMoney(sellerNetAmount) },
              ]}
              total={formatMoney(totalAmount)}
            />
            <CheckoutTrustPanel
              items={[
                {
                  icon: "lock",
                  title: "Secure Payment",
                  description: "Orders remain pending payment until Stripe confirms capture.",
                },
                {
                  icon: "shield",
                  title: "Buyer Protection",
                  description: "Checkout preserves seller splits and marketplace fees.",
                },
                {
                  icon: "creditCard",
                  title: "Payment Setup",
                  description: "The next step initializes the external processor flow.",
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
                  Payment covers {data.orders.length} seller-specific order
                  {data.orders.length === 1 ? "" : "s"} created by checkout.
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
                  <Button type="submit" size="lg" leadingIcon="lock">
                    {navigation.state === "submitting" ? "Starting payment..." : "Continue to payment"}
                  </Button>
                </Stack>
              </Form>
            </Stack>
          </Surface>

          <PageSection title="Orders">
            <Stack gap={3}>
              {data.orders.map((order) => (
                <Surface key={order.order_id} elevated>
                  <Stack gap={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Text weight="semibold">Order {order.order_id}</Text>
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
                    <LinkButton href={`/account/orders/${order.order_id}`} tone="secondary">
                      Open order
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
