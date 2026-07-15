import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  return redirect(`/commerce/terms?create=agreement&account=${encodeURIComponent(params.accountId ?? "")}`);
}

export default function CommercialTermsAccountAgreementNewRedirect() {
  return null;
}
