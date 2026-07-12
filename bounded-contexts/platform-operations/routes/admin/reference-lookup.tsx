import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { SupportReferenceLookupPage } from "../../features/support-reference-lookup/ui/support-reference-lookup-page";
import { lookupSupportReference } from "../../support/request-support/support-reference-lookup-client";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.routes.admin.supportReferenceLookup.request.failed");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("reference") ?? "").trim();

  if (!query) {
    return { query: "", result: null, searched: false, error: null };
  }

  try {
    const result = await lookupSupportReference(request, query);
    return { query, result, searched: true, error: null };
  } catch (error) {
    return { query, result: null, searched: true, error: errorMessage(error) };
  }
}

export const meta: MetaFunction = () => [{ title: t("support.routes.admin.supportReferenceLookup.meta.title") }];

export default function SupportReferenceLookupRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <SupportReferenceLookupPage query={data.query} result={data.result} searched={data.searched} error={data.error} />
  );
}
