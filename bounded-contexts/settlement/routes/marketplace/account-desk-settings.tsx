import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/account/desk/settings${url.search}`);
}

export default function LegacyPayoutSetupRedirect() {
  return null;
}
