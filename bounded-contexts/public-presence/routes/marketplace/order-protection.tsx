import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";

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
            title: t("publicPresence.info.buyerProtection.help.title"),
            body: [t("publicPresence.info.buyerProtection.help.body")],
          },
        ],
      }}
    />
  );
}
