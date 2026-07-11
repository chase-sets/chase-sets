import { t } from "@chase-sets/localization";
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

function toIsoTimestamp(value: FormDataEntryValue | null): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
  const effectiveFrom = toIsoTimestamp(formData.get("effectiveFrom")) ?? new Date().toISOString();
  const effectiveUntil = toIsoTimestamp(formData.get("effectiveUntil"));

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
