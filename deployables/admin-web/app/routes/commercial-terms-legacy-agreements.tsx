import { redirect } from "react-router";

export function loader() {
  throw redirect("/commercial/terms/agreements");
}

export default function CommercialTermsLegacyAgreementsRoute() {
  return null;
}
