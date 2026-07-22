import type { MetaFunction } from "react-router";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import { termsOfServicePolicyArtifact, type TermsOfServicePolicyArtifact } from "../domain/terms-of-service";
import { TermsOfServicePage } from "./terms-of-service-page";

export const termsOfServiceMeta: MetaFunction = () => {
  const { metadata } = termsOfServicePolicyArtifact;
  return [
    { title: t("publicPresence.routes.terms.meta.title") },
    { name: "description", content: t("publicPresence.routes.terms.meta.description") },
    { name: "chase-sets:policy-key", content: metadata.policyKey },
    { name: "chase-sets:policy-version", content: metadata.version },
    { name: "chase-sets:policy-publication-status", content: metadata.publicationStatus },
    ...(metadata.effectiveAt ? [{ name: "chase-sets:policy-effective-at", content: metadata.effectiveAt }] : []),
  ];
};

export function TermsOfServiceRouteAdapter({
  artifact = termsOfServicePolicyArtifact,
}: Readonly<{ artifact?: TermsOfServicePolicyArtifact }> = {}) {
  return <TermsOfServicePage artifact={artifact} />;
}
