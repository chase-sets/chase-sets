import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import { termsOfServicePolicyArtifact } from "../domain/terms-of-service";
import { PolicyArtifactPage } from "./policy-artifact-page";

export function TermsOfServicePage() {
  const { metadata } = termsOfServicePolicyArtifact;

  return (
    <PolicyArtifactPage
      artifact={termsOfServicePolicyArtifact}
      copy={{
        eyebrow: t("publicPresence.info.terms.eyebrow"),
        printLabel: t("publicPresence.info.terms.print"),
        counselPendingTitle: t("publicPresence.info.terms.counselPending.title"),
        counselPendingDescription: t("publicPresence.info.terms.counselPending.description"),
        metadataLabel: t("publicPresence.info.terms.metadata.label"),
        metadataTitle: t("publicPresence.info.terms.metadata.title"),
        versionText: t("publicPresence.info.terms.metadata.version", { version: metadata.version }),
        effectiveText: t("publicPresence.info.terms.metadata.effectivePending"),
        localeText: t("publicPresence.info.terms.metadata.locale", { locale: metadata.locale }),
        tocLabel: t("publicPresence.info.terms.toc.label"),
        tocTitle: t("publicPresence.info.terms.toc.title"),
        counselRequiredBadge: t("publicPresence.info.terms.section.counselRequired"),
      }}
    />
  );
}
