import { authenticityTermsMeta, AuthenticityTermsRouteAdapter } from "../policy-artifact-route-adapter";

export const meta = authenticityTermsMeta;

export default function AuthenticityTermsRoute() {
  return <AuthenticityTermsRouteAdapter />;
}
