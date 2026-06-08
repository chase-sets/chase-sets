import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { PlatformFeedbackAdminDetailPage } from "../../features/platform-feedback/ui/admin-pages";
import { createExperienceRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  return {
    feedback: await api.getPlatformFeedback(params.id ?? ""),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  const feedbackId = params.id ?? "";
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "review") {
    await api.markReviewed(feedbackId);
  }

  if (intent === "archive") {
    await api.archive(feedbackId);
  }

  throw redirect(`/support/platform-feedback/${feedbackId}`);
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
  const { feedback } = useLoaderData<typeof loader>();
  return <PlatformFeedbackAdminDetailPage feedback={feedback} />;
}
