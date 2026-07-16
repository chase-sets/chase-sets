import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/account/desk/money${url.search}`);
}

export default function LegacyAccountSettlementRedirect() {
  return null;
}
