import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/account/desk/payouts/${encodeURIComponent(params.payoutId!)}${url.search}`);
}

export default function LegacyAccountPayoutRedirect() {
  return null;
}
