import { t } from "@chase-sets/localization";
import { useActionData, useLoaderData, type MetaFunction } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Page, PageSection, Text, LinkButton } from "@chase-sets/design-system";
import { GuestClaimPrompt } from "../../features/registration/ui/guest-payment-claim-prompt";
import type {
  GuestClaimActionData,
  GuestPaymentClaimLoaderData,
} from "../../features/registration/ui/guest-payment-claim-contracts";
export { GuestPaymentClaimErrorBoundary as ErrorBoundary } from "../../features/registration/ui/guest-payment-claim-error-boundary";
export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("auth.routes.marketplace.guestPaymentClaim.save.this.order") });
export default function GuestPaymentClaimRoute() {
  const data = useLoaderData<GuestPaymentClaimLoaderData>();
  const actionData = useActionData<GuestClaimActionData | null>();
  return (
    <Page>
      {data.guestClaimContext ? (
        <GuestClaimPrompt actionData={actionData ?? undefined} claimContext={data.guestClaimContext} />
      ) : (
        <PageSection title={t("auth.routes.marketplace.guestPaymentClaim.save.this.order")}>
          <Text>{t("auth.routes.marketplace.guestPaymentClaim.you.can.save.this.order.after.payment")}</Text>
          <LinkButton href={`/checkout/payments/${data.paymentId}`}>
            {t("auth.routes.marketplace.guestPaymentClaim.payment.marketplace")}
          </LinkButton>
        </PageSection>
      )}
    </Page>
  );
}
