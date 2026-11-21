import { t } from "@chase-sets/localization";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useMatches } from "react-router";
import {
  createPolicyConsoleRevision,
  loadPolicyConsoleDocument,
  loadPolicyConsoleOverview,
  PolicyConsoleValidationError,
} from "../../support/request-support/policy-console-client";
import { PolicyConsoleDetailPage } from "../../features/policy-console/ui/policy-console-detail-page";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.overview.policyKey ?? t("platformOperations.policyConsole.metaTitle") },
];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const policyKey = params.policyKey ?? "";
  const overview = await loadPolicyConsoleOverview(request, policyKey);
  const history = overview.current.documentId
    ? (await loadPolicyConsoleDocument(request, policyKey, overview.current.documentId)).history
    : [];

  return { overview, history };
}

// The form sends each effective time as the instant the browser read in the
// operator's zone (`LocalDateTimeInput`), with the typed text in `<name>Local`.
// A blank field is `null`; a time that is not an instant is refused rather
// than read in this server's zone.
function effectiveTime(formData: FormData, name: string): { ok: true; value: string | null } | { ok: false } {
  const instant = String(formData.get(name) ?? "").trim();
  const typed = String(formData.get(`${name}Local`) ?? "").trim();
  if (!instant && !typed) {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: parseIsoUtcTimestamp(instant) };
  } catch {
    return { ok: false };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const policyKey = params.policyKey ?? "";
  const formData = await request.formData();

  let value: unknown;
  try {
    value = JSON.parse(String(formData.get("value") ?? "null"));
  } catch {
    return { error: t("platformOperations.policyConsole.detail.invalidJson") };
  }

  const status = formData.get("status") === "inactive" ? "inactive" : "active";
  const from = effectiveTime(formData, "effectiveFrom");
  const until = effectiveTime(formData, "effectiveUntil");
  if (!from.ok || !until.ok) {
    return { error: t("platformOperations.policyConsole.detail.invalidEffectiveTime") };
  }
  const effectiveFrom = from.value ?? new Date().toISOString();
  const effectiveUntil = until.value;

  try {
    await createPolicyConsoleRevision(request, policyKey, {
      value: value as never,
      status,
      effectiveFrom,
      effectiveUntil,
    });
  } catch (error) {
    if (error instanceof PolicyConsoleValidationError) {
      return { error: error.message };
    }
    throw error;
  }

  return redirect(`/platform/policy-console/${encodeURIComponent(policyKey)}`);
}

export default function PolicyConsoleDetailRoute() {
  const { overview, history } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const canManage = useAdminActorPermissions().includes("platform-policy.manage");

  return (
    <PolicyConsoleDetailPage
      overview={overview}
      history={history}
      canManage={canManage}
      submitError={actionData?.error ?? null}
    />
  );
}

function useAdminActorPermissions() {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }

  return [];
}
