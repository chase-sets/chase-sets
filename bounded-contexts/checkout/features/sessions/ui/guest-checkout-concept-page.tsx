import {
  Button,
  CheckoutConfirmationPanel,
  CheckoutExpressActions,
  CheckoutFlowShell,
  CheckoutFormSection,
  CheckoutMobileSummaryDisclosure,
  CheckoutReadinessPrompt,
  CheckoutSavedInfoGroup,
  CheckoutSavedInfoRow,
  CheckoutStateNotice,
  CheckoutStickyActionBar,
  CheckoutSummaryPanel,
  Form,
  Grid,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";

const lineItems = [
  {
    id: "line-youth-tee",
    title: t("checkout.features.sessions.ui.guestCheckoutConcept.youth.tee.title"),
    subtitle: t("checkout.features.sessions.ui.guestCheckoutConcept.youth.tee.subtitle"),
    facts: ["Ready to ship"],
    quantity: "1",
    price: "$26.90",
    image: { src: "/fake-cdn/assets/pokemon-card-back.png", alt: "Youth LS Tee" },
  },
  {
    id: "line-play-mat",
    title: t("checkout.features.sessions.ui.guestCheckoutConcept.play.mat.title"),
    subtitle: '18" x 16"',
    facts: ["Ready to ship"],
    quantity: "1",
    price: "$12.95",
    image: { src: "/fake-cdn/assets/pokemon-card-back.png", alt: "Play Mat" },
  },
  {
    id: "line-stickers",
    title: t("checkout.features.sessions.ui.guestCheckoutConcept.stickers.title"),
    subtitle: '3" x 3"',
    facts: ["Ready to ship"],
    quantity: "1",
    price: "$3.20",
    image: { src: "/fake-cdn/assets/pokemon-card-back.png", alt: "Bubble-free stickers" },
  },
  {
    id: "line-adult-tee",
    title: t("checkout.features.sessions.ui.guestCheckoutConcept.adult.tee.title"),
    subtitle: t("checkout.features.sessions.ui.guestCheckoutConcept.adult.tee.subtitle"),
    facts: ["Ready to ship"],
    quantity: "1",
    price: "$17.55",
    image: { src: "/fake-cdn/assets/pokemon-card-back.png", alt: "Adult Tee" },
  },
];

const totals = [
  { label: t("checkout.features.sessions.ui.guestCheckoutConcept.subtotal.four.items"), value: "$60.60" },
  {
    label: t("checkout.features.sessions.ui.guestCheckoutConcept.shipping"),
    value: t("checkout.features.sessions.ui.guestCheckoutConcept.enter.shipping.address"),
    muted: true,
  },
  { label: t("checkout.features.sessions.ui.guestCheckoutConcept.marketplace.checkout.fee"), value: "$1.10" },
  { label: t("checkout.features.sessions.ui.guestCheckoutConcept.wallet.credit"), value: "-$0.00", muted: true },
];

function SummaryPanel() {
  return (
    <CheckoutSummaryPanel
      title={t("checkout.features.sessions.ui.guestCheckoutConcept.order.summary")}
      subtitle="4 items"
      status="Ready"
      statusTone="success"
      items={lineItems}
      totals={totals}
      totalLabel={t("checkout.features.sessions.ui.guestCheckoutConcept.total")}
      total="$60.60"
      currency="USD"
      reassurance={t("checkout.features.sessions.ui.guestCheckoutConcept.final.totals.before.payment")}
      actions={
        <Button block leadingIcon="lock">
          {t("checkout.features.sessions.ui.guestCheckoutConcept.pay.now")}
        </Button>
      }
    />
  );
}

export function GuestCheckoutConceptPage() {
  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.sessions.ui.guestCheckoutConcept.fresh.state.checkout.concept")}
        title={t("checkout.features.sessions.ui.guestCheckoutConcept.checkout")}
        description={t("checkout.features.sessions.ui.guestCheckoutConcept.fresh.state.description")}
        actions={
          <>
            <LinkButton href="/guest-checkout/exit" tone="secondary" leadingIcon="logOut">
              {t("checkout.features.sessions.ui.guestCheckoutConcept.exit.guest.checkout")}
            </LinkButton>
            <LinkButton href="/account/cart" tone="secondary" leadingIcon="cart">
              {t("checkout.features.sessions.ui.guestCheckoutConcept.buy.cart")}
            </LinkButton>
          </>
        }
      />
      <CheckoutFlowShell
        summaryLabel="Desktop order summary"
        mobileSummary={
          <CheckoutMobileSummaryDisclosure
            label={t("checkout.features.sessions.ui.guestCheckoutConcept.order.summary")}
            collapsedSummary="4 items"
            total="$60.60"
          >
            <SummaryPanel />
          </CheckoutMobileSummaryDisclosure>
        }
        desktopSummary={<SummaryPanel />}
        stickyAction={
          <CheckoutStickyActionBar
            totalLabel={t("checkout.features.sessions.ui.guestCheckoutConcept.total")}
            total="$60.60"
            context="4 items"
            secondaryAction={
              <LinkButton href="/account/cart" tone="secondary">
                {t("checkout.features.sessions.ui.guestCheckoutConcept.back.to.buy.cart")}
              </LinkButton>
            }
            primaryAction={
              <Button leadingIcon="lock">{t("checkout.features.sessions.ui.guestCheckoutConcept.pay.now")}</Button>
            }
          />
        }
        main={
          <Stack gap={6}>
            <CheckoutReadinessPrompt
              tone="success"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.fulfillment.assigned.before.checkout")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.fulfillment.assigned.description")}
              facts={[
                {
                  label: t("checkout.features.sessions.ui.guestCheckoutConcept.readiness.snapshot"),
                  value: t("checkout.features.sessions.ui.guestCheckoutConcept.validated.from.cart"),
                },
                {
                  label: t("checkout.features.sessions.ui.guestCheckoutConcept.optimization"),
                  value: t("checkout.features.sessions.ui.guestCheckoutConcept.no.required.change"),
                },
              ]}
            />
            <CheckoutReadinessPrompt
              tone="info"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.optimization.savings.title")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.optimization.savings.description")}
              facts={[
                {
                  label: t("checkout.features.sessions.ui.guestCheckoutConcept.current.allocation"),
                  value: t("checkout.features.sessions.ui.guestCheckoutConcept.valid"),
                },
                { label: t("checkout.features.sessions.ui.guestCheckoutConcept.potential.savings"), value: "$4.20" },
              ]}
              action={<Button>{t("checkout.features.sessions.ui.guestCheckoutConcept.use.savings")}</Button>}
              secondaryAction={
                <Button tone="secondary">{t("checkout.features.sessions.ui.guestCheckoutConcept.keep.current")}</Button>
              }
            />
            <CheckoutExpressActions
              label={t("checkout.features.sessions.ui.guestCheckoutConcept.express.checkout")}
              actions={
                <>
                  <Button>{t("checkout.features.sessions.ui.guestCheckoutConcept.shop.pay")}</Button>
                  <Button tone="secondary">{t("checkout.features.sessions.ui.guestCheckoutConcept.google.pay")}</Button>
                </>
              }
            />
            <Form id="guest-checkout-concept" method="post">
              <Stack gap={6}>
                <CheckoutFormSection title={t("checkout.features.sessions.ui.guestCheckoutConcept.contact")}>
                  <TextInput
                    label={t("checkout.features.sessions.ui.guestCheckoutConcept.email.or.mobile")}
                    name="contact"
                    type="email"
                    required
                  />
                </CheckoutFormSection>
                <CheckoutFormSection title={t("checkout.features.sessions.ui.guestCheckoutConcept.delivery")}>
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.first.name")}
                      name="first_name"
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.last.name")}
                      name="last_name"
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.address")}
                      name="address_line_1"
                      required
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.apartment.suite")}
                      name="address_line_2"
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.city")}
                      name="city"
                      required
                    />
                    <NativeSelect
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.state")}
                      name="state"
                      defaultValue="KS"
                      items={[{ value: "KS", label: t("checkout.features.sessions.ui.guestCheckoutConcept.kansas") }]}
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.zip.code")}
                      name="postal_code"
                      required
                    />
                  </Grid>
                </CheckoutFormSection>
                <CheckoutFormSection
                  title={t("checkout.features.sessions.ui.guestCheckoutConcept.shipping.method")}
                  description={t("checkout.features.sessions.ui.guestCheckoutConcept.shipping.method.description")}
                >
                  <CheckoutStateNotice
                    tone="neutral"
                    title={t("checkout.features.sessions.ui.guestCheckoutConcept.shipping.updates.title")}
                    description={t("checkout.features.sessions.ui.guestCheckoutConcept.shipping.updates.description")}
                  />
                </CheckoutFormSection>
                <CheckoutFormSection
                  title={t("checkout.features.sessions.ui.guestCheckoutConcept.payment")}
                  description={t("checkout.features.sessions.ui.guestCheckoutConcept.payment.description")}
                >
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.card.number")}
                      name="card_number"
                      inputMode="numeric"
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.expiration.date")}
                      name="expiration"
                      placeholder={t("checkout.features.sessions.ui.guestCheckoutConcept.expiration.placeholder")}
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.security.code")}
                      name="security_code"
                      inputMode="numeric"
                    />
                    <TextInput
                      label={t("checkout.features.sessions.ui.guestCheckoutConcept.name.on.card")}
                      name="name_on_card"
                    />
                  </Grid>
                </CheckoutFormSection>
                <Button type="submit" leadingIcon="lock">
                  {t("checkout.features.sessions.ui.guestCheckoutConcept.pay.now")}
                </Button>
              </Stack>
            </Form>
            <CheckoutSavedInfoGroup
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.signed.in.saved.details")}
            >
              <CheckoutSavedInfoRow
                icon="home"
                label={t("checkout.features.sessions.ui.guestCheckoutConcept.ship.to")}
                value="Todd Skelton"
                supportingText="3354 Brush Creek Court, Wichita KS 67205"
                action={<Button tone="ghost">{t("checkout.features.sessions.ui.guestCheckoutConcept.edit")}</Button>}
              />
              <CheckoutSavedInfoRow
                icon="truck"
                label={t("checkout.features.sessions.ui.guestCheckoutConcept.shipping")}
                value="US Flat Rate - $19.03"
                action={<Button tone="ghost">{t("checkout.features.sessions.ui.guestCheckoutConcept.edit")}</Button>}
              />
              <CheckoutSavedInfoRow
                icon="creditCard"
                label={t("checkout.features.sessions.ui.guestCheckoutConcept.payment")}
                value="Mastercard ... 2738"
                status="Ready"
                statusTone="success"
              />
            </CheckoutSavedInfoGroup>
            <CheckoutStateNotice
              tone="warning"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.address.needs.attention")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.address.needs.attention.description")}
            />
            <CheckoutStateNotice
              tone="info"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.totals.changed")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.totals.changed.description")}
            />
            <CheckoutStateNotice
              tone="danger"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.risk.hold")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.risk.hold.description")}
            />
            <CheckoutStateNotice
              tone="warning"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.reconciliation.pending")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.reconciliation.pending.description")}
            />
            <CheckoutStateNotice
              tone="neutral"
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.session.expired")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.session.expired.description")}
            />
            <CheckoutConfirmationPanel
              title={t("checkout.features.sessions.ui.guestCheckoutConcept.order.received")}
              description={t("checkout.features.sessions.ui.guestCheckoutConcept.order.received.description")}
              referenceLabel={t("checkout.features.sessions.ui.guestCheckoutConcept.order")}
              referenceValue="ORD-1001"
              totalLabel={t("checkout.features.sessions.ui.guestCheckoutConcept.total")}
              total="$60.60"
              nextSteps={[
                {
                  title: t("checkout.features.sessions.ui.guestCheckoutConcept.receipt"),
                  description: t("checkout.features.sessions.ui.guestCheckoutConcept.receipt.description"),
                  icon: "book",
                },
                {
                  title: t("checkout.features.sessions.ui.guestCheckoutConcept.history"),
                  description: t("checkout.features.sessions.ui.guestCheckoutConcept.history.description"),
                  icon: "user",
                },
                {
                  title: t("checkout.features.sessions.ui.guestCheckoutConcept.support"),
                  description: t("checkout.features.sessions.ui.guestCheckoutConcept.support.description"),
                  icon: "help",
                },
              ]}
              actions={<Button>{t("checkout.features.sessions.ui.guestCheckoutConcept.view.order")}</Button>}
            />
          </Stack>
        }
      />
    </Page>
  );
}
