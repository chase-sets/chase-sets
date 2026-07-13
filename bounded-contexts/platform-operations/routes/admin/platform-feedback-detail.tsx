import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useMatches } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { PlatformFeedbackAdminDetailPage } from "../../features/platform-feedback/ui/admin-pages";
import { createExperienceRequestApiClient } from "../../support/request-support/api-client";

export function resolvePlatformFeedbackMarketplaceOrigin() {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  return configured || null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  return {
    feedback: await api.getPlatformFeedback(params.id ?? ""),
    marketplaceOrigin: resolvePlatformFeedbackMarketplaceOrigin(),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  const feedbackId = params.id ?? "";
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  let result: unknown = null;

  if (intent === "review") {
    result = await api.markReviewed(feedbackId);
  }

  if (intent === "archive") {
    result = await api.archive(feedbackId);
  }

  if (intent === "record-note") {
    result = await api.recordOperatorNote(feedbackId, {
      body: String(formData.get("body") ?? ""),
    });
  }

  throw redirect(navigateAfterWrite(result, `/support/platform-feedback/${feedbackId}`));
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.feedback
      ? t("experience.routes.admin.platformFeedbackDetail.platform.feedback.detail", {
          feedbackId: data.feedback.feedback_id,
        })
      : t("experience.routes.admin.platformFeedbackDetail.platform.feedback.experience.admin"),
  },
];

export default function PlatformFeedbackDetailRoute() {
  const { feedback, marketplaceOrigin } = useLoaderData<typeof loader>();
  const canManage = useAdminActorPermissions().includes("platform-feedback.manage");
  return (
    <PlatformFeedbackAdminDetailPage feedback={feedback} marketplaceOrigin={marketplaceOrigin} canManage={canManage} />
  );
}

function useAdminActorPermissions(): readonly string[] {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }

  return [];
}
