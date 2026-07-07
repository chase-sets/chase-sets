import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";
import { publicPresenceT as t } from "../../features/waitlist/ui/public-presence-translator";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.buyerProtection.meta.title") },
  { name: "description", content: t("publicPresence.routes.buyerProtection.meta.description") },
];

export default function OrderProtectionRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.buyerProtection.eyebrow"),
        title: t("publicPresence.info.buyerProtection.title"),
        description: t("publicPresence.info.buyerProtection.description"),
        sections: [
          {
            title: t("publicPresence.info.buyerProtection.payment.title"),
            body: [t("publicPresence.info.buyerProtection.payment.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.orders.title"),
            body: [t("publicPresence.info.buyerProtection.orders.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.fraud.title"),
            body: [t("publicPresence.info.buyerProtection.fraud.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.chargebacks.title"),
            body: [t("publicPresence.info.buyerProtection.chargebacks.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.disputeEvidence.title"),
            body: [t("publicPresence.info.buyerProtection.disputeEvidence.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.shippingEvidence.title"),
            body: [t("publicPresence.info.buyerProtection.shippingEvidence.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.returns.title"),
            body: [t("publicPresence.info.buyerProtection.returns.body")],
          },
          {
            title: t("publicPresence.info.buyerProtection.negativeBalance.title"),
            body: [t("publicPresence.info.buyerProtection.negativeBalance.body")],
          },
        ],
      }}
    />
  );
}
