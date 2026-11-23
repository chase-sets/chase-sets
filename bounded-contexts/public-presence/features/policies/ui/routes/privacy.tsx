import { PrivacyPolicyRouteAdapter, privacyPolicyMeta } from "../policy-artifact-route-adapter";

export const meta = privacyPolicyMeta;

export default function PrivacyRoute() {
  return <PrivacyPolicyRouteAdapter />;
}
