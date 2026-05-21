import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { PublicInfoPage } from "../../features/waitlist/ui/public-pages";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.contact.meta.title") },
  { name: "description", content: t("publicPresence.routes.contact.meta.description") },
];

export default function ContactRoute() {
  return (
    <PublicInfoPage
      content={{
        eyebrow: t("publicPresence.info.contact.eyebrow"),
        title: t("publicPresence.info.contact.title"),
        description: t("publicPresence.info.contact.description"),
        sections: [
          {
            title: t("publicPresence.info.contact.support.title"),
            body: [t("publicPresence.info.contact.support.body")],
          },
          {
            title: t("publicPresence.info.contact.status.title"),
            body: [t("publicPresence.info.contact.status.body")],
          },
        ],
      }}
    />
  );
}
