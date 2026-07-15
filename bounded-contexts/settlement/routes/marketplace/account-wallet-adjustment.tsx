import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function loader({ params }: LoaderFunctionArgs) {
  const reference = encodeURIComponent(params.reference!);
  return redirect(`/account/desk/money?drawer=wallet-adjustment&entity=${reference}`);
}

export default function LegacyWalletAdjustmentRedirect() {
  return null;
}
