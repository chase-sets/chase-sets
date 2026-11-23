import { termsOfServiceMeta, TermsOfServiceRouteAdapter } from "../terms-of-service-route-adapter";

export const meta = termsOfServiceMeta;

export default function TermsRoute() {
  return <TermsOfServiceRouteAdapter />;
}
