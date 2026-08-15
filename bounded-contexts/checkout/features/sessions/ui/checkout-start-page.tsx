import { t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Banner,
  Button,
  CheckoutFlowShell,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { checkoutStartHeaderCopy } from "./checkout-start-copy";
import {
  CheckoutStartMobileSummary,
  CheckoutStartSourceFields,
  CheckoutStartSourceSummary,
  CheckoutStartSummary,
} from "./checkout-start-summary";
import type {
  CheckoutStartActionData,
  CheckoutStartCartReadinessSummary,
  CheckoutStartPageData,
} from "./checkout-start-page-types";

function checkoutStatusLabel(status: CheckoutStartCartReadinessSummary["status"] | null) {
  if (status === "ready" || status === null) {
    return t("checkout.routes.checkoutStart.ready");
  }

  return t("checkout.routes.checkoutStart.needs.review");
}

function cartCheckoutCanContinue(summary: CheckoutStartCartReadinessSummary | null) {
  return summary === null || summary.status === "ready";
}

/** The checkout entry page: sign in, continue with the account, or start a
 * guest checkout for the arriving cart / buy-now / offer-intent source. */
export function CheckoutStartPage({
  data,
  actionData,
}: {
  data: CheckoutStartPageData;
  actionData: CheckoutStartActionData | undefined;
}) {
  const source = data.source;
  const isOfferIntent = source?.type === "offer-intent";
  const cartReadiness = source ? null : data.cartReadiness;
  const cartCanContinue = cartCheckoutCanContinue(cartReadiness);
  const checkoutStatus = checkoutStatusLabel(cartReadiness?.status ?? null);
  const headerCopy = checkoutStartHeaderCopy({
    isSignedIn: data.isSignedIn,
    isOfferIntent,
  });
  const signInReturnTo =
    new URLSearchParams(data.signInPath.split("?")[1] ?? "").get("returnTo") ?? "/checkout/buy/readiness";
  const registerPath = `/register?returnTo=${encodeURIComponent(signInReturnTo)}`;
  const emailExistsError = actionData && "emailExistsError" in actionData ? actionData.emailExistsError : null;
  const emailExistsSignInPath =
    actionData && "emailExistsError" in actionData ? actionData.signInPath : data.signInPath;
  const sourceFields = <CheckoutStartSourceFields source={source} entryAttemptKey={data.entryAttemptKey} />;
  const summaryProps = {
    source,
    cartCount: data.cartCount,
    isSignedIn: data.isSignedIn,
    isGuestBuyer: data.isGuestBuyer,
    isOfferIntent,
    checkoutStatus,
  };

  const checkoutMain = (
    <Stack gap={4}>
      {source ? <CheckoutStartSourceSummary source={source} /> : null}
      {data.isSignedIn && !source && !cartCanContinue ? (
        <Banner
          title={t("checkout.routes.checkoutStart.cart.needs.review")}
          description={
            cartReadiness?.customerSafeFacts[0] ?? t("checkout.routes.checkoutStart.cart.needs.review.description")
          }
          tone="warning"
          actions={
            <LinkButton href="/account/cart" leadingIcon="cart" tone="secondary">
              {t("checkout.routes.checkoutStart.review.buy.cart")}
            </LinkButton>
          }
        />
      ) : null}

      {actionData && "recovery" in actionData ? (
        <Banner
          title={actionData.recovery.title}
          description={actionData.recovery.description}
          tone="warning"
          actions={
            <>
              <LinkButton
                href={actionData.recovery.primaryAction.href}
                leadingIcon={actionData.recovery.primaryAction.leadingIcon}
                tone={actionData.recovery.primaryAction.tone}
              >
                {actionData.recovery.primaryAction.label}
              </LinkButton>
              {actionData.recovery.secondaryAction ? (
                <LinkButton
                  href={actionData.recovery.secondaryAction.href}
                  leadingIcon={actionData.recovery.secondaryAction.leadingIcon}
                  tone={actionData.recovery.secondaryAction.tone}
                >
                  {actionData.recovery.secondaryAction.label}
                </LinkButton>
              ) : null}
            </>
          }
        />
      ) : null}

      {actionData && "error" in actionData ? (
        <Banner
          title={t("checkout.routes.checkoutStart.sign.in.required")}
          description={actionData.error}
          tone="warning"
          actions={
            <LinkButton href={actionData.signInPath} tone="secondary">
              {t("checkout.routes.checkoutStart.sign.in")}
            </LinkButton>
          }
        />
      ) : null}

      {(data.isSignedIn || data.isGuestBuyer) && (source || cartCanContinue) ? (
        <PageSection
          title={
            data.isGuestBuyer
              ? t("checkout.routes.checkoutStart.guest.checkout.active")
              : t("checkout.routes.checkoutStart.account.checkout")
          }
        >
          <Surface elevation="tinted">
            <RouterForm method="post" spacing="none">
              <Stack gap={3}>
                <Text tone="secondary">
                  {data.isGuestBuyer
                    ? t("checkout.routes.checkoutStart.continue.with.guest.checkout")
                    : t("checkout.routes.checkoutStart.continue.with.your.account.any.saved.guest")}
                </Text>
                {sourceFields}
                <Button type="submit" size="lg" leadingIcon="lock">
                  {t("checkout.routes.checkoutStart.continue.to.checkout")}
                </Button>
              </Stack>
            </RouterForm>
          </Surface>
        </PageSection>
      ) : isOfferIntent ? (
        <>
          <PageSection title={t("checkout.routes.checkoutStart.register.to.place.purchase.intent")}>
            <Surface elevation="tinted">
              <Stack gap={3}>
                <Text tone="secondary">{t("checkout.routes.checkoutStart.registration.purchase.intent.copy")}</Text>
                <LinkButton href={registerPath} size="lg" leadingIcon="shield">
                  {t("checkout.routes.checkoutStart.register.with.passkey")}
                </LinkButton>
                <LinkButton href={data.signInPath} tone="secondary" size="lg" leadingIcon="lock">
                  {t("checkout.routes.checkoutStart.sign.in")}
                </LinkButton>
              </Stack>
            </Surface>
          </PageSection>
        </>
      ) : (
        <>
          <PageSection title={t("checkout.routes.checkoutStart.guest.checkout")}>
            <Surface elevation="tinted">
              <RouterForm method="post" spacing="none">
                <Stack gap={3}>
                  <Text tone="secondary">{t("checkout.routes.checkoutStart.continue.as.guest.fast.path")}</Text>
                  {emailExistsError ? (
                    <Banner
                      title={t("checkout.routes.checkoutStart.sign.in.required")}
                      description={emailExistsError}
                      tone="warning"
                      actions={
                        <LinkButton href={emailExistsSignInPath} tone="secondary">
                          {t("checkout.routes.checkoutStart.sign.in")}
                        </LinkButton>
                      }
                    />
                  ) : null}
                  <TextInput label={t("checkout.routes.checkoutStart.contact.name")} name="contactName" required />
                  <TextInput
                    label={t("checkout.routes.checkoutStart.email")}
                    name="email"
                    type="email"
                    required
                    error={emailExistsError ?? undefined}
                  />
                  {sourceFields}
                  <Button type="submit" size="lg" leadingIcon="lock">
                    {t("checkout.routes.checkoutStart.continue.as.guest")}
                  </Button>
                </Stack>
              </RouterForm>
            </Surface>
          </PageSection>
          <PageSection title={t("checkout.routes.checkoutStart.account")}>
            <Surface elevation="tinted">
              <Stack gap={3}>
                <Text tone="secondary">{t("checkout.routes.checkoutStart.sign.in.to.keep.purchases.payments")}</Text>
                <LinkButton href={data.signInPath} tone="secondary" size="lg" leadingIcon="lock">
                  {t("checkout.routes.checkoutStart.sign.in")}
                </LinkButton>
              </Stack>
            </Surface>
          </PageSection>
        </>
      )}
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.routes.checkoutStart.secure.checkout")}
        title={headerCopy.title}
        description={headerCopy.description}
      />
      <CheckoutFlowShell
        summaryLabel={t("checkout.routes.checkoutStart.checkout.summary")}
        main={checkoutMain}
        desktopSummary={<CheckoutStartSummary {...summaryProps} />}
        mobileSummary={<CheckoutStartMobileSummary {...summaryProps} />}
      />
    </Page>
  );
}
