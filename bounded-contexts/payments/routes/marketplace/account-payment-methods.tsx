import { formatDateTime, t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  HiddenInput,
  AutoGrid,
  Form,
  Badge,
  Banner,
  Button,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { createPaymentsRequestApiClient, PaymentsApiError } from "../../support/request-support/api-client";
import { StripeSetupCard } from "../../features/payments/ui/account-payment/stripe-setup-card";

type PaymentsRequestApiClient = ReturnType<typeof createPaymentsRequestApiClient>;
type PaymentMethodSnapshot = Awaited<ReturnType<PaymentsRequestApiClient["listPaymentMethods"]>>["items"][number];
type PaymentMethodsActionData = Readonly<{
  error?: string;
  paymentMethods?: readonly PaymentMethodSnapshot[];
  setup?: Awaited<ReturnType<PaymentsRequestApiClient["createSavedPaymentSetupSession"]>>;
}>;

function paymentMethodCategoryLabel(value: string) {
  return value === "bank-account"
    ? t("payments.routes.marketplace.accountPaymentMethods.bank.account")
    : value === "platform-credit"
      ? t("payments.routes.marketplace.accountPaymentMethods.platform.credit")
      : t("payments.routes.marketplace.accountPaymentMethods.card");
}

function readinessTone(value: string): "success" | "warning" | "danger" | "neutral" {
  if (value === "ready") {
    return "success";
  }
  if (value === "removed") {
    return "danger";
  }
  if (value === "setup-required") {
    return "warning";
  }
  return "neutral";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({ request });
  const paymentsApi = createPaymentsRequestApiClient(request);
  const setupReferenceId = new URL(request.url).searchParams.get("setupReferenceId");
  let setupResult: "saved" | "pending" | null = null;
  if (setupReferenceId) {
    const result = await paymentsApi.reconcileSavedPaymentSetupSession(setupReferenceId);
    setupResult = result.instrument ? "saved" : "pending";
  }

  return {
    accountId: actor.accountId,
    setupResult,
    paymentMethods: (await paymentsApi.listPaymentMethods()).items,
  };
}

async function loadPaymentMethodSnapshot(paymentsApi: PaymentsRequestApiClient) {
  return (await paymentsApi.listPaymentMethods()).items;
}

export async function action({ request }: ActionFunctionArgs): Promise<PaymentMethodsActionData> {
  await requireActorFromAuthApi({ request });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const paymentsApi = createPaymentsRequestApiClient(request);

  try {
    if (intent === "add") {
      const setup = await paymentsApi.createSavedPaymentSetupSession({
        returnUrlPath: "/account/payment-methods",
      });
      return { setup, paymentMethods: await loadPaymentMethodSnapshot(paymentsApi) };
    }
    if (intent === "default") {
      await paymentsApi.setDefaultPaymentMethod(String(formData.get("instrumentId") ?? ""));
      return { paymentMethods: await loadPaymentMethodSnapshot(paymentsApi) };
    }
    if (intent === "remove") {
      await paymentsApi.removePaymentMethod(String(formData.get("instrumentId") ?? ""));
      return { paymentMethods: await loadPaymentMethodSnapshot(paymentsApi) };
    }
    if (intent === "reconcile") {
      const result = await paymentsApi.reconcilePaymentMethods();
      return { paymentMethods: result.items };
    }
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    return {
      error:
        error instanceof PaymentsApiError || error instanceof Error
          ? error.message
          : t("payments.routes.marketplace.accountPaymentMethods.payment.method.update.failed"),
    };
  }

  return { error: t("payments.routes.marketplace.accountPaymentMethods.choose.payment.method.action") };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("payments.routes.marketplace.accountPaymentMethods.saved.payment.methods") });

export default function AccountPaymentMethodsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [setup, setSetup] = useState<PaymentMethodsActionData["setup"] | null>(actionData?.setup ?? null);
  const [setupSaved, setSetupSaved] = useState(false);
  useEffect(() => {
    if (actionData?.setup) {
      setSetup(actionData.setup);
      setSetupSaved(false);
    }
  }, [actionData?.setup]);
  const paymentMethods = setupSaved
    ? data.paymentMethods
    : actionData && "paymentMethods" in actionData && actionData.paymentMethods
      ? actionData.paymentMethods
      : data.paymentMethods;
  const activeMethods = paymentMethods.filter((method) => method.readiness !== "removed");

  return (
    <Page>
      <PageHeader
        eyebrow={t("payments.routes.marketplace.accountPaymentMethods.payments")}
        title={t("payments.routes.marketplace.accountPaymentMethods.saved.payment.methods")}
        description={t("payments.routes.marketplace.accountPaymentMethods.manage.payment.methods")}
        actions={
          <Inline gap={2}>
            <RouterForm method="post" spacing="none">
              <Button type="submit" name="intent" value="reconcile" tone="secondary" leadingIcon="refreshCcw">
                {t("payments.routes.marketplace.accountPaymentMethods.refresh")}
              </Button>
            </RouterForm>
            <RouterForm method="post" spacing="none">
              <Button type="submit" name="intent" value="add" leadingIcon="plus">
                {t("payments.routes.marketplace.accountPaymentMethods.add")}
              </Button>
            </RouterForm>
          </Inline>
        }
      />
      <Stack gap={4}>
        {actionData?.error ? (
          <Banner
            tone="danger"
            title={t("payments.routes.marketplace.accountPaymentMethods.payment.method.update.failed")}
            description={actionData.error}
          />
        ) : null}
        {data.setupResult === "saved" ? (
          <Banner
            tone="success"
            title={t("payments.routes.marketplace.accountPaymentMethods.payment.method.saved")}
            description={t("payments.routes.marketplace.accountPaymentMethods.payment.method.saved.description")}
          />
        ) : null}
        {setupSaved ? (
          <Banner
            tone="success"
            title={t("payments.routes.marketplace.accountPaymentMethods.payment.method.saved")}
            description={t("payments.routes.marketplace.accountPaymentMethods.payment.method.saved.description")}
          />
        ) : null}
        {setup ? (
          <PageSection title={t("payments.routes.marketplace.accountPaymentMethods.add.payment.method")}>
            <StripeSetupCard
              setup={setup}
              onSaved={() => {
                setSetup(null);
                setSetupSaved(true);
              }}
            />
          </PageSection>
        ) : null}
        {data.setupResult === "pending" ? (
          <Banner
            tone="warning"
            title={t("payments.routes.marketplace.accountPaymentMethods.setup.pending")}
            description={t("payments.routes.marketplace.accountPaymentMethods.setup.pending.description")}
          />
        ) : null}
        {activeMethods.length === 0 ? (
          <MarketplaceEmptyState
            title={t("payments.routes.marketplace.accountPaymentMethods.no.saved.payment.methods")}
            description={t("payments.routes.marketplace.accountPaymentMethods.no.saved.payment.methods.description")}
            recoveryActions={
              <RouterForm method="post" spacing="none">
                <Button type="submit" name="intent" value="add" leadingIcon="plus">
                  {t("payments.routes.marketplace.accountPaymentMethods.add.payment.method")}
                </Button>
              </RouterForm>
            }
          />
        ) : (
          <AutoGrid minItemWidth="md" gap={4}>
            {paymentMethods.map((method) => (
              <Surface key={method.instrument_id} elevated>
                <Stack gap={3}>
                  <Inline gap={2} align="center">
                    <Badge tone={readinessTone(method.readiness)}>{method.readiness}</Badge>
                    {method.is_default ? (
                      <Badge tone="accent">{t("payments.routes.marketplace.accountPaymentMethods.default")}</Badge>
                    ) : null}
                  </Inline>
                  <Stack gap={1}>
                    <Text weight="semibold">{method.display_label}</Text>
                    <Text tone="secondary">{paymentMethodCategoryLabel(method.payment_method_category)}</Text>
                    <Text tone="secondary">
                      {t("payments.routes.marketplace.accountPaymentMethods.updated", {
                        date: formatDateTime(method.updated_at),
                      })}
                    </Text>
                  </Stack>
                  {method.readiness !== "removed" ? (
                    <Inline gap={2}>
                      {!method.is_default ? (
                        <RouterForm method="post" spacing="none">
                          <HiddenInput type="hidden" name="instrumentId" value={method.instrument_id} />
                          <Button type="submit" name="intent" value="default" tone="secondary">
                            {t("payments.routes.marketplace.accountPaymentMethods.set.default")}
                          </Button>
                        </RouterForm>
                      ) : null}
                      <RouterForm method="post" spacing="none">
                        <HiddenInput type="hidden" name="instrumentId" value={method.instrument_id} />
                        <Button type="submit" name="intent" value="remove" tone="danger">
                          {t("payments.routes.marketplace.accountPaymentMethods.remove")}
                        </Button>
                      </RouterForm>
                    </Inline>
                  ) : null}
                </Stack>
              </Surface>
            ))}
          </AutoGrid>
        )}
        <PageSection title={t("payments.routes.marketplace.accountPaymentMethods.checkout")}>
          <LinkButton href="/account/cart" tone="secondary">
            {t("payments.routes.marketplace.accountPaymentMethods.back.to.buy.cart")}
          </LinkButton>
        </PageSection>
      </Stack>
    </Page>
  );
}
