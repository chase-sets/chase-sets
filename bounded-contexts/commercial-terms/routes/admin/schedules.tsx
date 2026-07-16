import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const target = new URL("/commerce/terms", request.url);
  target.search = new URL(request.url).search;
  return redirect(`${target.pathname}${target.search}`);
}

export default function CommercialTermsSchedulesRedirect() {
  return null;
}
