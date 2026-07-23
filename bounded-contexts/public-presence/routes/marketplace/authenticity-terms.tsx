import {
  authenticityTermsMeta,
  AuthenticityTermsRouteAdapter,
} from "../../features/policies/ui/policy-artifact-route-adapter";

export const meta = authenticityTermsMeta;

export default function AuthenticityTermsRoute() {
  return <AuthenticityTermsRouteAdapter />;
}
