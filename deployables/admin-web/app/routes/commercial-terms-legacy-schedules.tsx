import { redirect } from "react-router";

export function loader() {
  throw redirect("/commercial/terms/schedules");
}

export default function CommercialTermsLegacySchedulesRoute() {
  return null;
}
