import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { OfferEconomicsAdminPage } from "../../features/offer-economics/ui/offer-economics-page";
import { loadOfferEconomicsSummary } from "../../features/offer-economics/api/offer-economics-client";

function daysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ?? daysAgoUtc(59);

  const { snapshot } = await loadOfferEconomicsSummary(request, { from, to });

  return { snapshot };
}

export const meta: MetaFunction = () => [{ title: t("platformOperations.offerEconomics.metaTitle") }];

export default function OfferEconomicsRoute() {
  const data = useLoaderData<typeof loader>();
  return <OfferEconomicsAdminPage snapshot={data.snapshot} />;
}
