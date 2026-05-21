import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.sellerFees.meta.title") },
  { name: "description", content: t("publicPresence.routes.sellerFees.meta.description") },
];

export default function SalesFeesRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.sellerFees.eyebrow"),
        title: t("publicPresence.info.sellerFees.title"),
        description: t("publicPresence.info.sellerFees.description"),
        sections: [
          {
            title: t("publicPresence.info.sellerFees.predictable.title"),
            body: [t("publicPresence.info.sellerFees.predictable.body")],
          },
          {
            title: t("publicPresence.info.sellerFees.lowValue.title"),
            body: [t("publicPresence.info.sellerFees.lowValue.body")],
          },
          {
            title: t("publicPresence.info.sellerFees.prelaunch.title"),
            body: [t("publicPresence.info.sellerFees.prelaunch.body")],
          },
        ],
      }}
    />
  );
}
