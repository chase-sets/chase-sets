import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  return redirect(`/commerce/terms?agreement=${encodeURIComponent(params.id ?? "")}`);
}

export default function CommercialTermsAgreementDetailRedirect() {
  return null;
}
