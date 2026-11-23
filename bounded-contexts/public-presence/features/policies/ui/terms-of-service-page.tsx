import { t } from "./localization/translator";
import { termsOfServicePolicyArtifact, type TermsOfServicePolicyArtifact } from "../domain/terms-of-service";
import { PolicyArtifactRouteAdapter } from "./policy-artifact-route-adapter";

export function TermsOfServicePage({
  artifact = termsOfServicePolicyArtifact,
}: Readonly<{ artifact?: TermsOfServicePolicyArtifact }> = {}) {
  return (
    <PolicyArtifactRouteAdapter
      artifact={artifact}
      eyebrow={t("publicPresence.info.terms.eyebrow")}
      copyProfile="terms-of-service"
    />
  );
}
