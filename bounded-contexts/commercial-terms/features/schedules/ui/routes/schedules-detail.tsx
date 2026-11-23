import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({ params }: LoaderFunctionArgs) {
  return redirect(`/commerce/terms?schedule=${encodeURIComponent(params.id ?? "")}`);
}

export default function CommercialTermsScheduleDetailRedirect() {
  return null;
}
