import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.refunds.meta.title") },
  { name: "description", content: t("publicPresence.routes.refunds.meta.description") },
];

export default function RefundsAndReturnsRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.refunds.eyebrow"),
        title: t("publicPresence.info.refunds.title"),
        description: t("publicPresence.info.refunds.description"),
        sections: [
          { title: t("publicPresence.info.refunds.prelaunch.title"), body: [t("publicPresence.info.refunds.prelaunch.body")] },
          { title: t("publicPresence.info.refunds.future.title"), body: [t("publicPresence.info.refunds.future.body")] },
          { title: t("publicPresence.info.refunds.support.title"), body: [t("publicPresence.info.refunds.support.body")] },
        ],
      }}
    />
  );
}
