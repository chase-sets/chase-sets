import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { loadPolicyConsoleRegistry } from "../../support/request-support/policy-console-client";
import { PolicyConsolePage } from "../../features/policy-console/ui/policy-console-page";

export const meta: MetaFunction = () => [{ title: t("platformOperations.policyConsole.metaTitle") }];

export async function loader({ request }: LoaderFunctionArgs) {
  return loadPolicyConsoleRegistry(request);
}

export default function PolicyConsoleRoute() {
  const { items, commercialTermsSchedulesHref } = useLoaderData<typeof loader>();
  return <PolicyConsolePage items={items} commercialTermsSchedulesHref={commercialTermsSchedulesHref} />;
}
