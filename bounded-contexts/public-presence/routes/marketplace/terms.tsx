import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.terms.meta.title") },
  { name: "description", content: t("publicPresence.routes.terms.meta.description") },
];

export default function TermsRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.terms.eyebrow"),
        title: t("publicPresence.info.terms.title"),
        description: t("publicPresence.info.terms.description"),
        sections: [
          { title: t("publicPresence.info.terms.prelaunch.title"), body: [t("publicPresence.info.terms.prelaunch.body")] },
          { title: t("publicPresence.info.terms.accounts.title"), body: [t("publicPresence.info.terms.accounts.body")] },
          { title: t("publicPresence.info.terms.marketplace.title"), body: [t("publicPresence.info.terms.marketplace.body")] },
          { title: t("publicPresence.info.terms.contact.title"), body: [t("publicPresence.info.terms.contact.body")] },
        ],
      }}
    />
  );
}
