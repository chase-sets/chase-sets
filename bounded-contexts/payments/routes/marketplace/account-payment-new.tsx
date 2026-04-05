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
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import {
  createOrderingBuyerGateway,
} from "@chase-sets/ordering/integration";
import { createPaymentsRequestApiClient } from "../../request-api-client";

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

  const orderingApi = createOrderingBuyerGateway(request);

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

  return (
    <Page>
      <PageHeader
        eyebrow="Buyer"
        title="Start payment"
        description="Review the orders created by checkout, then initialize the Stripe payment flow."
        actions={
          <LinkButton href="/account/orders" tone="secondary">
            Back to orders
          </LinkButton>
        }
      />

      <PageSection title="Checkout summary">
        <Card>
          <Stack gap={2}>
            <Text weight="semibold">Orders: {data.orderIds.join(", ")}</Text>
            <Text>Total due: {formatMoney(totalAmount)}</Text>
            <Text size="sm" tone="secondary">
              Payment covers {data.orders.length} seller-specific order
              {data.orders.length === 1 ? "" : "s"} created by checkout.
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Payment setup">
        <Card>
          <Stack gap={3}>
            {actionData?.error ? <Text>{actionData.error}</Text> : null}
            <Form method="post" ref={formRef}>
              <input type="hidden" name="orderIds" value={data.orderIds.join(",")} />
              <Button type="submit">
                {navigation.state === "submitting" ? "Starting payment..." : "Continue to payment"}
              </Button>
            </Form>
            <Text size="sm" tone="secondary">
              Orders remain pending payment until Stripe confirms capture.
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Orders">
        <Stack gap={3}>
          {data.orders.map((order) => (
            <Card key={order.order_id}>
              <Stack gap={1}>
                <Text weight="semibold">Order {order.order_id}</Text>
                <Text size="sm" tone="secondary">
                  Status: {order.status}
                </Text>
                <Text>Total: {formatMoney(order.total_amount)}</Text>
                <LinkButton href={`/account/orders/${order.order_id}`} tone="secondary">
                  Open order
                </LinkButton>
              </Stack>
            </Card>
          ))}
        </Stack>
      </PageSection>
    </Page>
  );
}
