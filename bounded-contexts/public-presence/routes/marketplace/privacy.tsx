import { PrivacyPolicyRouteAdapter, privacyPolicyMeta } from "../../features/policies/ui/policy-artifact-route-adapter";

export const meta = privacyPolicyMeta;

export default function PrivacyRoute() {
  return <PrivacyPolicyRouteAdapter />;
}
