import type { MetaFunction } from "react-router";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import { termsOfServicePolicyArtifact, type TermsOfServicePolicyArtifact } from "../domain/terms-of-service";
import { buildPolicyArtifactMeta } from "./policy-artifact-route-adapter";
import { TermsOfServicePage } from "./terms-of-service-page";

export const termsOfServiceMeta: MetaFunction = () =>
  buildPolicyArtifactMeta(
    termsOfServicePolicyArtifact,
    {
      title: t("publicPresence.routes.terms.meta.title"),
      description: t("publicPresence.routes.terms.meta.description"),
    },
    { noindexWhilePending: false },
  );

export function TermsOfServiceRouteAdapter({
  artifact = termsOfServicePolicyArtifact,
}: Readonly<{ artifact?: TermsOfServicePolicyArtifact }> = {}) {
  return <TermsOfServicePage artifact={artifact} />;
}
