import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function loader({ params }: LoaderFunctionArgs) {
  throw redirect(`/commercial/terms/schedules/${params.id}`);
}

export default function CommercialTermsLegacyScheduleDetailRoute() {
  return null;
}
