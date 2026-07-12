import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  confirmPublicDocReview,
  loadPolicyConsoleRegistry,
  loadPublicDocReviewQueue,
} from "../../support/request-support/policy-console-client";
import { PolicyConsolePage } from "../../features/policy-console/ui/policy-console-page";

export const meta: MetaFunction = () => [{ title: t("platformOperations.policyConsole.metaTitle") }];

export async function loader({ request }: LoaderFunctionArgs) {
  const [registry, reviewQueue] = await Promise.all([
    loadPolicyConsoleRegistry(request),
    loadPublicDocReviewQueue(request),
  ]);
  return { ...registry, reviewItems: reviewQueue.items };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  await confirmPublicDocReview(request, {
    locale: String(formData.get("locale") ?? ""),
    articleSlug: String(formData.get("articleSlug") ?? ""),
    policyKey: String(formData.get("policyKey") ?? ""),
  });
  return redirect("/platform/policy-console");
}

export default function PolicyConsoleRoute() {
  const { items, commercialTermsSchedulesHref, reviewItems } = useLoaderData<typeof loader>();
  return (
    <PolicyConsolePage
      items={items}
      reviewItems={reviewItems}
      commercialTermsSchedulesHref={commercialTermsSchedulesHref}
    />
  );
}
