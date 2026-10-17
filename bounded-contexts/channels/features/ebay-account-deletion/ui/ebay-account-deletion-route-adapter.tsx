import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { decodeEbayReceiptMatches, decodeEbaySubjectDataCount } from "../domain/responses";
import { EbayAccountDeletionLookupPage } from "./ebay-account-deletion-lookup-page";

const path = "/api/channels/staff/ebay-account-deletion";
export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "support.manage" });
  try {
    const response = await fetch(resolveRequestApiBaseUrl(request, `${path}/subject-data-count`), {
      headers: createForwardedAuthHeaders(request),
    });
    if (!response.ok) throw new Error();
    return { counts: decodeEbaySubjectDataCount(await response.json()), error: false };
  } catch {
    return { counts: null, error: true };
  }
}
export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "support.manage" });
  try {
    const form = await request.formData();
    const headers = new Headers(createForwardedAuthHeaders(request));
    headers.set("Content-Type", "application/json");
    const response = await fetch(resolveRequestApiBaseUrl(request, `${path}/lookup`), {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: form.get("userId") }),
    });
    if (!response.ok) throw new Error();
    return { matches: decodeEbayReceiptMatches(await response.json()), error: false };
  } catch {
    return { matches: null, error: true };
  }
}
export const meta = () => [{ title: t("channels.ebayDeletion.title") }];
export default function EbayDeletionRoute() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <EbayAccountDeletionLookupPage
      counts={data.counts}
      matches={result?.matches ?? null}
      error={data.error || (result?.error ?? false)}
      pending={navigation.state !== "idle"}
    />
  );
}
