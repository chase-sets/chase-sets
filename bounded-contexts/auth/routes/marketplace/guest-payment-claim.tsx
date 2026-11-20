import { t } from "@chase-sets/localization";
import { useActionData, useLoaderData, type MetaFunction } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Banner, Page, PageSection, Stack, Text, LinkButton } from "@chase-sets/design-system";
import { GuestClaimPrompt } from "../../features/registration/ui/guest-payment-claim-prompt";
import type {
  GuestClaimActionData,
  GuestPaymentClaimLoaderData,
} from "../../features/registration/ui/guest-payment-claim-contracts";
export { GuestPaymentClaimErrorBoundary as ErrorBoundary } from "../../features/registration/ui/guest-payment-claim-error-boundary";
export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.routes.marketplace.guestPaymentClaim.account.options") });
export default function GuestPaymentClaimRoute() {
  const data = useLoaderData<GuestPaymentClaimLoaderData>();
  const actionData = useActionData<GuestClaimActionData | null>();
  if (data.guestClaimContact) {
    return (
      <Page>
        <GuestClaimPrompt actionData={actionData ?? undefined} claimContact={data.guestClaimContact} />
      </Page>
    );
  }
  // No contact to claim with: offer nothing, but still say how the last request went, since Auth can
  // refuse the read after a request it accepted.
  return (
    <Page>
      <PageSection title={t("auth.routes.marketplace.guestPaymentClaim.account.options")}>
        <Stack gap={3}>
          {actionData && "error" in actionData && actionData.scope === "claim" ? (
            <Banner
              title={t("auth.routes.marketplace.guestPaymentClaim.could.not.save.order")}
              description={actionData.error}
              tone="danger"
            />
          ) : null}
          {actionData && "status" in actionData ? (
            <Banner
              title={t("auth.routes.marketplace.guestPaymentClaim.claim.link.sent.title")}
              description={t("auth.routes.marketplace.guestPaymentClaim.claim.link.sent.to.contact")}
              tone="success"
            />
          ) : null}
          <Text>
            {data.claimable
              ? t("auth.routes.marketplace.guestPaymentClaim.claim.unavailable")
              : t("auth.routes.marketplace.guestPaymentClaim.you.can.save.this.order.after.payment")}
          </Text>
          <LinkButton href={`/checkout/payments/${data.paymentId}`}>
            {t("auth.routes.marketplace.guestPaymentClaim.payment.marketplace")}
          </LinkButton>
        </Stack>
      </PageSection>
    </Page>
  );
}
