import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  CheckoutLayout,
  Divider,
  Grid,
  Icon,
  Inset,
  Inline,
  LinkButton,
  NativeSelect,
  OrderProtectionModule,
  Page,
  PageHeader,
  PriceBreakdown,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";

type StepState = "complete" | "current" | "pending";

const reviewRows = [
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.product"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.acerolas.mischief.raw.damaged"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.seller"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.card.vault"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.quantity"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.quantity.one"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.fulfillment"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.locked.seller.ready"),
  },
];

const summaryRows = [
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.items"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.price.items"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.shipping"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.price.shipping"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.estimated.tax"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.price.zero"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.marketplace.checkout.fee"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.price.fee"),
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.wallet.credit"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.price.wallet.credit"),
  },
];

const progressSteps: Array<{ label: string; state: StepState; icon: "check" | "truck" | "creditCard" | "lock" }> = [
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.step.review"),
    state: "complete",
    icon: "check",
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.step.shipping"),
    state: "current",
    icon: "truck",
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.step.payment"),
    state: "current",
    icon: "creditCard",
  },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.step.place.order"),
    state: "pending",
    icon: "lock",
  },
];

export function GuestCheckoutConceptPage() {
  const summary = (
    <Stack gap={4}>
      <Surface elevated padding={4}>
        <Stack gap={4}>
          <Inline gap={2}>
            <Badge tone="success">{t("checkout.features.sessions.ui.guestCheckoutConcept.ready.to.place.order")}</Badge>
            <Badge tone="info">{t("checkout.features.sessions.ui.guestCheckoutConcept.guest.checkout")}</Badge>
          </Inline>
          <div>
            <Text size="sm" tone="secondary">
              {t("checkout.features.sessions.ui.guestCheckoutConcept.payable.total")}
            </Text>
            <Text size="lg" weight="bold">
              {t("checkout.features.sessions.ui.guestCheckoutConcept.price.total")}
            </Text>
          </div>
          <PriceBreakdown
            lines={summaryRows}
            total={t("checkout.features.sessions.ui.guestCheckoutConcept.price.total")}
            totalLabel={t("checkout.features.sessions.ui.guestCheckoutConcept.due.before.payment")}
            reassurance={
              <SecurePaymentIndicator
                label={t("checkout.features.sessions.ui.guestCheckoutConcept.payment.starts.after.review")}
              />
            }
          />
          <Button block leadingIcon="lock">
            {t("checkout.features.sessions.ui.guestCheckoutConcept.create.purchases.and.continue")}
          </Button>
        </Stack>
      </Surface>
      <OrderProtectionModule
        title={t("checkout.features.sessions.ui.guestCheckoutConcept.order.protection")}
        items={[
          {
            title: t("checkout.features.sessions.ui.guestCheckoutConcept.protected.checkout"),
            description: t("checkout.features.sessions.ui.guestCheckoutConcept.protected.checkout.description"),
          },
          {
            title: t("checkout.features.sessions.ui.guestCheckoutConcept.secure.payment"),
            description: t("checkout.features.sessions.ui.guestCheckoutConcept.secure.payment.description"),
          },
          {
            title: t("checkout.features.sessions.ui.guestCheckoutConcept.fulfillment.ready"),
            description: t("checkout.features.sessions.ui.guestCheckoutConcept.fulfillment.ready.description"),
          },
        ]}
      />
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.sessions.ui.guestCheckoutConcept.secure.checkout")}
        title={t("checkout.features.sessions.ui.guestCheckoutConcept.ready.to.place.order")}
        description={t("checkout.features.sessions.ui.guestCheckoutConcept.page.description")}
        actions={
          <Inline gap={2}>
            <LinkButton href="/guest-checkout/exit" tone="secondary" leadingIcon="logOut">
              {t("checkout.features.sessions.ui.guestCheckoutConcept.exit.guest.checkout")}
            </LinkButton>
            <LinkButton href="/account/cart" tone="secondary" leadingIcon="cart">
              {t("checkout.features.sessions.ui.guestCheckoutConcept.buy.cart")}
            </LinkButton>
          </Inline>
        }
      />
      <CheckoutLayout summary={summary} summaryLabel={t("checkout.features.sessions.ui.guestCheckoutConcept.summary")}>
        <Stack gap={4}>
          <Surface elevated padding={4}>
            <div className="grid gap-3 md:grid-cols-4">
              {progressSteps.map((step) => (
                <CheckoutStep key={step.label} icon={step.icon} label={step.label} state={step.state} />
              ))}
            </div>
          </Surface>
          <Surface elevated padding={4}>
            <Stack gap={4}>
              <Inline gap={2}>
                <Badge tone="info">{t("checkout.features.sessions.ui.guestCheckoutConcept.live.price.preview")}</Badge>
                <Badge tone="success">{t("checkout.features.sessions.ui.guestCheckoutConcept.locked.seller")}</Badge>
              </Inline>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <Stack gap={3}>
                  <Text size="lg" weight="bold">
                    {t("checkout.features.sessions.ui.guestCheckoutConcept.acerolas.mischief")}
                  </Text>
                  <Text tone="secondary">
                    {t("checkout.features.sessions.ui.guestCheckoutConcept.order.review.description")}
                  </Text>
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    {reviewRows.map((row) => (
                      <ReviewMetric key={row.label} label={row.label} value={row.value} />
                    ))}
                  </Grid>
                </Stack>
                <Inset padding={4}>
                  <Stack gap={3}>
                    <Inline gap={2}>
                      <Icon name="truck" tone="accent" size="sm" />
                      <Text weight="semibold">{t("checkout.features.sessions.ui.guestCheckoutConcept.ships.jun")}</Text>
                    </Inline>
                    <Text size="sm" tone="secondary">
                      {t("checkout.features.sessions.ui.guestCheckoutConcept.delivery.promise.description")}
                    </Text>
                    <Divider />
                    <Text size="sm" weight="semibold">
                      {t("checkout.features.sessions.ui.guestCheckoutConcept.one.package.letter")}
                    </Text>
                  </Stack>
                </Inset>
              </div>
            </Stack>
          </Surface>
          <Surface elevated padding={4}>
            <Stack gap={4}>
              <Inline gap={2}>
                <Icon name="home" tone="accent" size="sm" />
                <Text size="lg" weight="bold">
                  {t("checkout.features.sessions.ui.guestCheckoutConcept.shipping.address")}
                </Text>
              </Inline>
              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                <TextInput
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.recipient.name")}
                  defaultValue={t("checkout.features.sessions.ui.guestCheckoutConcept.jane.smith")}
                  required
                />
                <TextInput label={t("checkout.features.sessions.ui.guestCheckoutConcept.company")} />
                <TextInput
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.address.line.one")}
                  defaultValue={t("checkout.features.sessions.ui.guestCheckoutConcept.sample.address")}
                  required
                />
                <TextInput
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.city")}
                  defaultValue={t("checkout.features.sessions.ui.guestCheckoutConcept.sample.city")}
                  required
                />
                <TextInput
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.state")}
                  defaultValue={t("checkout.features.sessions.ui.guestCheckoutConcept.sample.state")}
                  required
                />
                <TextInput
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.postal.code")}
                  defaultValue={t("checkout.features.sessions.ui.guestCheckoutConcept.sample.postal.code")}
                  required
                />
              </Grid>
              <NativeSelect
                label={t("checkout.features.sessions.ui.guestCheckoutConcept.delivery.option")}
                defaultValue="standard-insured"
                items={[
                  {
                    value: "standard-insured",
                    label: t("checkout.features.sessions.ui.guestCheckoutConcept.standard.insured"),
                  },
                  {
                    value: "priority-insured",
                    label: t("checkout.features.sessions.ui.guestCheckoutConcept.priority.insured"),
                  },
                ]}
              />
            </Stack>
          </Surface>
          <Surface elevated padding={4}>
            <Stack gap={4}>
              <Inline gap={2}>
                <Icon name="creditCard" tone="accent" size="sm" />
                <Text size="lg" weight="bold">
                  {t("checkout.features.sessions.ui.guestCheckoutConcept.payment.method")}
                </Text>
                <Badge tone="success">{t("checkout.features.sessions.ui.guestCheckoutConcept.secure.payment")}</Badge>
              </Inline>
              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                <NativeSelect
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.payment.method")}
                  defaultValue="card"
                  items={[
                    { value: "card", label: t("checkout.features.sessions.ui.guestCheckoutConcept.card") },
                    {
                      value: "bank-account",
                      label: t("checkout.features.sessions.ui.guestCheckoutConcept.bank.account"),
                    },
                  ]}
                />
                <TextInput
                  label={t("checkout.features.sessions.ui.guestCheckoutConcept.email")}
                  defaultValue={t("checkout.features.sessions.ui.guestCheckoutConcept.sample.email")}
                  type="email"
                />
              </Grid>
              <Inset padding={3}>
                <Inline gap={2}>
                  <Icon name="shield" tone="success" size="sm" />
                  <Text size="sm" weight="semibold">
                    {t("checkout.features.sessions.ui.guestCheckoutConcept.final.totals.before.payment")}
                  </Text>
                </Inline>
              </Inset>
            </Stack>
          </Surface>
          <StickyCtaBar
            price={t("checkout.features.sessions.ui.guestCheckoutConcept.price.total")}
            context={t("checkout.features.sessions.ui.guestCheckoutConcept.sticky.context")}
            secondaryAction={
              <LinkButton href="/account/cart" tone="secondary">
                {t("checkout.features.sessions.ui.guestCheckoutConcept.back.to.buy.cart")}
              </LinkButton>
            }
            primaryAction={
              <Button leadingIcon="lock">
                {t("checkout.features.sessions.ui.guestCheckoutConcept.create.purchases.and.continue")}
              </Button>
            }
          />
        </Stack>
      </CheckoutLayout>
    </Page>
  );
}

function CheckoutStep({
  icon,
  label,
  state,
}: {
  icon: "check" | "truck" | "creditCard" | "lock";
  label: string;
  state: StepState;
}) {
  const tone = state === "pending" ? "secondary" : "accent";

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--primary)_36%,var(--border))] bg-[var(--card)]">
        <Icon name={icon} tone={tone} size="sm" />
      </span>
      <div className="min-w-0">
        <Text size="sm" weight="semibold">
          {label}
        </Text>
        <Text size="xs" tone="secondary">
          {state === "complete"
            ? t("checkout.features.sessions.ui.guestCheckoutConcept.step.complete")
            : state === "current"
              ? t("checkout.features.sessions.ui.guestCheckoutConcept.step.ready")
              : t("checkout.features.sessions.ui.guestCheckoutConcept.step.next")}
        </Text>
      </div>
    </div>
  );
}

function ReviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <Surface tone="muted" padding={3}>
      <Stack gap={1}>
        <Text size="xs" tone="secondary">
          {label}
        </Text>
        <Text size="sm" weight="semibold">
          {value}
        </Text>
      </Stack>
    </Surface>
  );
}
