import { formatDateTime, t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
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
import { createPaymentsRequestApiClient } from "../../support/request-support/api-client";
import {
  classifySavedPaymentMethodAttemptFailure,
  type SavedPaymentMethodAttemptFailureState,
} from "../../support/request-support/saved-payment-method-attempt";
import type { SavedPaymentMethodAttempt } from "../../client";
import { StripeSetupCard } from "../../features/payments/ui/account-payment/stripe-setup-card";

type PaymentsRequestApiClient = ReturnType<typeof createPaymentsRequestApiClient>;
type PaymentMethodSnapshot = Awaited<ReturnType<PaymentsRequestApiClient["listPaymentMethods"]>>["items"][number];
type AttemptState = "succeeded" | SavedPaymentMethodAttemptFailureState;
/** The outcome of one methods-page form's attempt; `formKey` is `add`, `default:<id>` or `remove:<id>`. */
type AttemptResult = Readonly<{ formKey: string; attemptId: string; state: AttemptState; code: string | null }>;
type PaymentMethodsActionData = Readonly<{
  error?: string;
  attempt?: AttemptResult;
  paymentMethods?: readonly PaymentMethodSnapshot[];
  setup?: Awaited<ReturnType<PaymentsRequestApiClient["createSavedPaymentSetupSession"]>>;
}>;

const CANONICAL_ATTEMPT_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Only a definitive outcome lets the form mint a fresh id; every other state keeps or reloads it. */
const FRESH_ID_STATES: ReadonlySet<AttemptState> = new Set(["succeeded", "refused"]);
const RELOAD_STATES: ReadonlySet<AttemptState> = new Set(["conflict", "account-changed", "reauth-required"]);

function attemptFormKey(intent: string, instrumentId: string) {
  return intent === "add" ? "add" : `${intent}:${instrumentId}`;
}

/** One fresh attempt id per form, minted in the loader so server and client render the same id. */
function mintAttemptIds(paymentMethods: readonly PaymentMethodSnapshot[]) {
  return Object.fromEntries([
    ["add", globalThis.crypto.randomUUID()],
    ...paymentMethods.flatMap((method) =>
      ["default", "remove"].map((intent) => [
        attemptFormKey(intent, method.instrument_id),
        globalThis.crypto.randomUUID(),
      ]),
    ),
  ]) as Readonly<Record<string, string>>;
}

/**
 * Sends one form's attempt. A malformed id, missing target or an account that no longer matches
 * the loader's refuses before any command; a send failure is classified, never echoed.
 */
async function submitAttempt<T>(
  context: Readonly<{ request: Request; formData: FormData; intent: string; actor: { accountId: string } | null }>,
  send: (api: PaymentsRequestApiClient, attempt: SavedPaymentMethodAttempt, instrumentId: string) => Promise<T>,
): Promise<Readonly<{ attempt: AttemptResult; value?: T; paymentMethods?: readonly PaymentMethodSnapshot[] }>> {
  const attemptId = String(context.formData.get("attemptId") ?? "");
  const accountId = String(context.formData.get("accountId") ?? "");
  const instrumentId = String(context.formData.get("instrumentId") ?? "");
  const formKey = attemptFormKey(context.intent, instrumentId);
  const outcome = (state: AttemptState, code: string | null = null): AttemptResult => ({
    formKey,
    attemptId,
    state,
    code,
  });
  if (context.actor && accountId !== context.actor.accountId) return { attempt: outcome("account-changed") };
  if (!CANONICAL_ATTEMPT_UUID_V4.test(attemptId) || !accountId || (context.intent !== "add" && !instrumentId)) {
    return { attempt: outcome("refused") };
  }
  const paymentsApi = createPaymentsRequestApiClient(context.request);
  let value: T;
  try {
    value = await send(paymentsApi, { accountId, attemptId }, instrumentId);
  } catch (error) {
    const failure = classifySavedPaymentMethodAttemptFailure(error);
    return { attempt: outcome(failure.state, failure.code) };
  }
  const paymentMethods = await loadPaymentMethodSnapshot(paymentsApi).catch(() => undefined);
  return { attempt: outcome("succeeded"), value, ...(paymentMethods ? { paymentMethods } : {}) };
}

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

  const paymentMethods = (await paymentsApi.listPaymentMethods()).items;
  return {
    accountId: actor.accountId,
    setupResult,
    paymentMethods,
    attemptIds: mintAttemptIds(paymentMethods),
  };
}

async function loadPaymentMethodSnapshot(paymentsApi: PaymentsRequestApiClient) {
  return (await paymentsApi.listPaymentMethods()).items;
}

export const action = defineFormAction({
  authorization: ({ request }) => requireActorFromAuthApi({ request }),
  intents: {
    add: async (context) => {
      const { value: setup, ...result } = await submitAttempt(context, (paymentsApi, attempt) =>
        paymentsApi.createSavedPaymentSetupSession({ ...attempt, returnUrlPath: "/account/payment-methods" }),
      );
      return setup ? { ...result, setup } : result;
    },
    default: async (context) => {
      const { value: _instrument, ...result } = await submitAttempt(context, (paymentsApi, attempt, instrumentId) =>
        paymentsApi.setDefaultPaymentMethod(instrumentId, attempt),
      );
      return result;
    },
    remove: async (context) => {
      const { value: _instrument, ...result } = await submitAttempt(context, (paymentsApi, attempt, instrumentId) =>
        paymentsApi.removePaymentMethod(instrumentId, attempt),
      );
      return result;
    },
    reconcile: async ({ request }) => {
      const result = await createPaymentsRequestApiClient(request).reconcilePaymentMethods();
      return { paymentMethods: result.items };
    },
  },
  onUnknownIntent: () => ({
    error: t("payments.routes.marketplace.accountPaymentMethods.choose.payment.method.action"),
  }),
  onError: () => ({
    error: t("payments.routes.marketplace.accountPaymentMethods.payment.method.update.failed"),
  }),
});

type AttemptFormProps = Readonly<{
  intent: "add" | "default" | "remove";
  instrumentId?: string;
  label: string;
  tone?: "secondary" | "danger";
  leadingIcon?: "plus";
  accountId: string;
  attemptId: string | undefined;
  attempt: AttemptResult | undefined;
  submitting: boolean;
  onReload: (formKey: string) => void;
}>;

/**
 * One attempt-producing form: `unconfirmed` re-submits the same id as "Check again";
 * `conflict`, `account-changed` and `reauth-required` only reload, which mints a fresh id.
 */
function AttemptForm(props: AttemptFormProps) {
  const formKey = attemptFormKey(props.intent, props.instrumentId ?? "");
  if (props.attempt && RELOAD_STATES.has(props.attempt.state)) {
    return (
      <Button type="button" tone="secondary" disabled={props.submitting} onClick={() => props.onReload(formKey)}>
        {t("payments.routes.marketplace.accountPaymentMethods.reload")}
      </Button>
    );
  }
  return (
    <RouterForm method="post" spacing="none">
      <HiddenInput type="hidden" name="accountId" value={props.accountId} />
      <HiddenInput type="hidden" name="attemptId" value={props.attemptId ?? ""} />
      {props.instrumentId ? <HiddenInput type="hidden" name="instrumentId" value={props.instrumentId} /> : null}
      <Button
        type="submit"
        name="intent"
        value={props.intent}
        tone={props.tone}
        leadingIcon={props.leadingIcon}
        disabled={props.submitting || !props.attemptId}
      >
        {props.attempt?.state === "unconfirmed"
          ? t("payments.routes.marketplace.accountPaymentMethods.check.again")
          : props.label}
      </Button>
    </RouterForm>
  );
}

function AttemptStatus({ state }: Readonly<{ state: AttemptState | "submitting" | undefined }>) {
  if (!state) return null;
  const message = {
    submitting: t("payments.routes.marketplace.accountPaymentMethods.attempt.submitting"),
    succeeded: t("payments.routes.marketplace.accountPaymentMethods.attempt.succeeded"),
    refused: t("payments.routes.marketplace.accountPaymentMethods.attempt.refused"),
    unconfirmed: t("payments.routes.marketplace.accountPaymentMethods.attempt.unconfirmed"),
    conflict: t("payments.routes.marketplace.accountPaymentMethods.attempt.conflict"),
    "account-changed": t("payments.routes.marketplace.accountPaymentMethods.attempt.account.changed"),
    "reauth-required": t("payments.routes.marketplace.accountPaymentMethods.attempt.reauth.required"),
  }[state];
  return (
    <Text role="status" tone={state === "succeeded" || state === "submitting" ? "secondary" : "danger"}>
      {message}
    </Text>
  );
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("payments.routes.marketplace.accountPaymentMethods.saved.payment.methods") });

export default function AccountPaymentMethodsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as PaymentMethodsActionData | undefined;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [setup, setSetup] = useState<PaymentMethodsActionData["setup"] | null>(actionData?.setup ?? null);
  const [setupSaved, setSetupSaved] = useState(false);
  // Each form keeps its last outcome across later actions and revalidations, so an unconfirmed
  // remove on one method still offers "Check again" with its id while another form proceeds.
  const [attempts, setAttempts] = useState<Readonly<Record<string, AttemptResult>>>(
    actionData?.attempt ? { [actionData.attempt.formKey]: actionData.attempt } : {},
  );
  useEffect(() => {
    if (actionData?.setup) {
      setSetup(actionData.setup);
      setSetupSaved(false);
    }
  }, [actionData?.setup]);
  useEffect(() => {
    const attempt = actionData?.attempt;
    if (attempt) setAttempts((current) => ({ ...current, [attempt.formKey]: attempt }));
  }, [actionData?.attempt]);
  const submitting = navigation.state === "submitting";
  const submittingKey =
    submitting && navigation.formData
      ? attemptFormKey(String(navigation.formData.get("intent")), String(navigation.formData.get("instrumentId") ?? ""))
      : null;
  const attemptIdFor = (formKey: string) => {
    const attempt = attempts[formKey];
    return attempt && !FRESH_ID_STATES.has(attempt.state) ? attempt.attemptId : data.attemptIds[formKey];
  };
  const reload = (formKey: string) => {
    setAttempts(({ [formKey]: _reloaded, ...rest }) => rest);
    revalidator.revalidate();
  };
  const statusFor = (formKey: string) => (submittingKey === formKey ? "submitting" : attempts[formKey]?.state);
  const attemptForm = (
    props: Omit<AttemptFormProps, "accountId" | "attemptId" | "attempt" | "submitting" | "onReload">,
  ) => {
    const formKey = attemptFormKey(props.intent, props.instrumentId ?? "");
    return (
      <AttemptForm
        {...props}
        accountId={data.accountId}
        attemptId={attemptIdFor(formKey)}
        attempt={attempts[formKey]}
        submitting={submitting}
        onReload={reload}
      />
    );
  };
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
              <Button
                type="submit"
                name="intent"
                value="reconcile"
                tone="secondary"
                leadingIcon="refreshCcw"
                disabled={submitting}
              >
                {t("payments.routes.marketplace.accountPaymentMethods.refresh")}
              </Button>
            </RouterForm>
            {attemptForm({
              intent: "add",
              label: t("payments.routes.marketplace.accountPaymentMethods.add"),
              leadingIcon: "plus",
            })}
          </Inline>
        }
      />
      <Stack gap={4}>
        <AttemptStatus state={statusFor("add")} />
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
            recoveryActions={attemptForm({
              intent: "add",
              label: t("payments.routes.marketplace.accountPaymentMethods.add.payment.method"),
              leadingIcon: "plus",
            })}
          />
        ) : (
          <AutoGrid minItemWidth="md" gap={4}>
            {paymentMethods.map((method) => (
              <Surface key={method.instrument_id} elevation="elevated">
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
                    <Stack gap={1}>
                      <Inline gap={2}>
                        {!method.is_default
                          ? attemptForm({
                              intent: "default",
                              instrumentId: method.instrument_id,
                              label: t("payments.routes.marketplace.accountPaymentMethods.set.default"),
                              tone: "secondary",
                            })
                          : null}
                        {attemptForm({
                          intent: "remove",
                          instrumentId: method.instrument_id,
                          label: t("payments.routes.marketplace.accountPaymentMethods.remove"),
                          tone: "danger",
                        })}
                      </Inline>
                      <AttemptStatus state={statusFor(attemptFormKey("default", method.instrument_id))} />
                      <AttemptStatus state={statusFor(attemptFormKey("remove", method.instrument_id))} />
                    </Stack>
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
