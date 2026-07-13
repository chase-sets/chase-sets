import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ComparePage, buildCompareStructuredData, compareMeta } from "../../features/waitlist/ui/compare-page";
import { loadLandingFeePresentation } from "../../support/request-support/landing-fee-presentation";

const fallbackPublicOrigin = "https://chasesets.com";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const publicOrigin = process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || url.origin;
  const { feeSchedule } = await loadLandingFeePresentation(request);
  return { feeSchedule, publicOrigin };
}

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  compareMeta("ebay", data?.publicOrigin ?? fallbackPublicOrigin);

export const compareEbayJsonLd = (publicOrigin?: string) => buildCompareStructuredData("ebay", publicOrigin);

export default function CompareEbayRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildCompareStructuredData("ebay", data.publicOrigin)).replace(/</g, "\\u003c"),
        }}
      />
      <ComparePage competitor="ebay" feeSchedule={data.feeSchedule} />
    </>
  );
}
