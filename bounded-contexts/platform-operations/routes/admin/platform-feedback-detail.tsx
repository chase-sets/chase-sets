import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useMatches } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
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

const feedbackDestination = (id: string) => `/support/platform-feedback/${id}`;

export const action = defineFormAction({
  intents: {
    review: async ({ request, params }) =>
      formActionRedirect(
        await createExperienceRequestApiClient(request).markReviewed(params.id ?? ""),
        feedbackDestination(params.id ?? ""),
      ),
    archive: async ({ request, params }) =>
      formActionRedirect(
        await createExperienceRequestApiClient(request).archive(params.id ?? ""),
        feedbackDestination(params.id ?? ""),
      ),
    "record-note": async ({ request, params, formData }) =>
      formActionRedirect(
        await createExperienceRequestApiClient(request).recordOperatorNote(params.id ?? "", {
          body: String(formData.get("body") ?? ""),
        }),
        feedbackDestination(params.id ?? ""),
      ),
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, feedbackDestination(params.id ?? "")),
});

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
