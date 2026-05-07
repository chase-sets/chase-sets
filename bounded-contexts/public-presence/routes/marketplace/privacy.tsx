import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.privacy.meta.title") },
  { name: "description", content: t("publicPresence.routes.privacy.meta.description") },
];

export default function PrivacyRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.privacy.eyebrow"),
        title: t("publicPresence.info.privacy.title"),
        description: t("publicPresence.info.privacy.description"),
        sections: [
          { title: t("publicPresence.info.privacy.collect.title"), body: [t("publicPresence.info.privacy.collect.body")] },
          { title: t("publicPresence.info.privacy.use.title"), body: [t("publicPresence.info.privacy.use.body")] },
          { title: t("publicPresence.info.privacy.control.title"), body: [t("publicPresence.info.privacy.control.body")] },
        ],
      }}
    />
  );
}
