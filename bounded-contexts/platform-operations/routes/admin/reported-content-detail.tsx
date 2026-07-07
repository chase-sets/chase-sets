import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { ReportedContentModerationAction } from "../../features/reported-content/api/contracts";
import { ReportedContentAdminDetailPage } from "../../features/reported-content/ui/admin-pages";
import { createReportedContentRequestApiClient } from "../../support/request-support/reported-content-client";

export function resolveReportedContentMarketplaceOrigin() {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  return configured || null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createReportedContentRequestApiClient(request);
  return {
    item: await api.getReportedContentQueueItem(params.targetType ?? "", params.targetId ?? ""),
    marketplaceOrigin: resolveReportedContentMarketplaceOrigin(),
  };
}

function normalizeAction(value: FormDataEntryValue | null): ReportedContentModerationAction {
  if (
    value === "dismiss" ||
    value === "contact-seller" ||
    value === "unlist" ||
    value === "escalate-account-suspension"
  ) {
    return value;
  }

  throw new Response("Invalid reported content action.", { status: 400 });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const targetType = params.targetType ?? "";
  const targetId = params.targetId ?? "";
  const note = String(formData.get("note") ?? "").trim() || null;
  await createReportedContentRequestApiClient(request).recordReportedContentAction(
    targetType,
    targetId,
    normalizeAction(formData.get("action")),
    note,
  );
  return redirect(`/reported-content/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`);
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.item
      ? t("platformOperations.reportedContent.detailMetaTitle", {
          targetType: data.item.target_type,
          targetId: data.item.target_id,
        })
      : t("platformOperations.reportedContent.metaTitle"),
  },
];

export default function ReportedContentDetailRoute() {
  const { item, marketplaceOrigin } = useLoaderData<typeof loader>();
  return <ReportedContentAdminDetailPage item={item} marketplaceOrigin={marketplaceOrigin} />;
}
