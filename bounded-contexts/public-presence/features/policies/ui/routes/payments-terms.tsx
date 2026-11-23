import { paymentsTermsMeta, PaymentsTermsRouteAdapter } from "../policy-artifact-route-adapter";

export const meta = paymentsTermsMeta;

export default function PaymentsTermsRoute() {
  return <PaymentsTermsRouteAdapter />;
}
