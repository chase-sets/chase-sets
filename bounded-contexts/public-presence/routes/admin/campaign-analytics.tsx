import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CampaignAnalyticsPage } from "../../features/waitlist/ui/campaign-analytics-page";
import { createPublicPresenceRequestApiClient } from "../../support/request-support/api-client";

// Grafana dashboard covering the funnel half of campaign analytics (visit ->
// signup -> Discord CTA click-through -> referral share), grouped by UTM
// channel via the sanitized structured logs public-web already forwards.
// See infrastructure/observability/stack/grafana/dashboards/public-presence-waitlist.json
// and bounded-contexts/public-presence/docs/landing-page-analytics.md.
const FUNNEL_DASHBOARD_HREF = "/grafana/d/chase-sets-public-presence-waitlist/public-presence-waitlist-funnel";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createPublicPresenceRequestApiClient(request);
  const analytics = await api.getCampaignAnalytics();
  return { analytics };
}

export const meta: MetaFunction = () => [{ title: t("publicPresence.routes.admin.campaignAnalytics.meta.title") }];

export default function CampaignAnalyticsRoute() {
  const data = useLoaderData<typeof loader>();
  return <CampaignAnalyticsPage analytics={data.analytics} funnelDashboardHref={FUNNEL_DASHBOARD_HREF} />;
}
