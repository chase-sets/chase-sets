import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { FeedbackAttentionSurface, loadFeedbackAttentionRouteData } from "../../features/attention/ui/route-adapter";

export async function loader({ request }: LoaderFunctionArgs) {
  return loadFeedbackAttentionRouteData(request);
}

export const meta: MetaFunction = () => [{ title: t("customer-feedback.attention.title") }];

export default function CustomerFeedbackAttentionRoute() {
  const data = useLoaderData<typeof loader>();
  return <FeedbackAttentionSurface items={data.items} metrics={data.metrics} />;
}
