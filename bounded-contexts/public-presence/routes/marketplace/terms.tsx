import {
  termsOfServiceMeta,
  TermsOfServiceRouteAdapter,
} from "../../features/policies/ui/terms-of-service-route-adapter";

export const meta = termsOfServiceMeta;

export default function TermsRoute() {
  return <TermsOfServiceRouteAdapter />;
}
