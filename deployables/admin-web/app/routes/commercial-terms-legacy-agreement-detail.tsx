import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function loader({ params }: LoaderFunctionArgs) {
  throw redirect(`/commercial/terms/agreements/${params.id}`);
}

export default function CommercialTermsLegacyAgreementDetailRoute() {
  return null;
}
