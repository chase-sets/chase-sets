import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useMatches } from "react-router";
import { ListingEvidencePolicyPage } from "../../features/listing-evidence-policy/ui/listing-evidence-policy-page";
import {
  activateListingEvidencePolicyDraft,
  createListingEvidencePolicyDraft,
  createListingEvidencePolicyRollbackDraft,
  ListingEvidencePolicyRequestError,
  loadListingEvidencePolicyOverview,
  loadListingEvidencePolicySelectors,
  rejectListingEvidencePolicyDraft,
  validateListingEvidencePolicyDraft,
  type ListingEvidencePolicyRule,
} from "../../features/listing-evidence-policy/api/client";

export const meta: MetaFunction = () => [{ title: t("marketplace.features.listingEvidencePolicy.ui.meta.title") }];

export async function loader({ request }: LoaderFunctionArgs) {
  const [overview, selectorCatalog] = await Promise.all([
    loadListingEvidencePolicyOverview(request),
    loadListingEvidencePolicySelectors(request),
  ]);
  return { overview, selectorCatalog };
}

function isoTimestamp(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const policyId = String(formData.get("policyId") ?? "");

  try {
    if (intent === "create-draft") {
      const rules = JSON.parse(String(formData.get("rules") ?? "[]")) as ListingEvidencePolicyRule[];
      await createListingEvidencePolicyDraft(request, {
        policyName: String(formData.get("policyName") ?? "").trim(),
        rules,
      });
    } else if (intent === "validate") {
      const validation = await validateListingEvidencePolicyDraft(request, policyId);
      return { validation, error: null };
    } else if (intent === "reject") {
      await rejectListingEvidencePolicyDraft(request, policyId);
    } else if (intent === "rollback") {
      await createListingEvidencePolicyRollbackDraft(request, policyId);
    } else if (intent === "activate") {
      if (formData.get("impactAcknowledged") !== "yes") {
        return { validation: null, error: t("marketplace.features.listingEvidencePolicy.ui.impact.required") };
      }
      const effectiveFrom = isoTimestamp(formData.get("effectiveFrom"));
      if (!effectiveFrom) {
        return { validation: null, error: t("marketplace.features.listingEvidencePolicy.ui.effective.required") };
      }
      await activateListingEvidencePolicyDraft(request, policyId, {
        effectiveFrom,
        effectiveUntil: isoTimestamp(formData.get("effectiveUntil")),
        impactAcknowledgmentHash: String(formData.get("impactAcknowledgmentHash") ?? ""),
      });
    } else {
      return { validation: null, error: t("marketplace.features.listingEvidencePolicy.ui.intent.invalid") };
    }
  } catch (error) {
    if (error instanceof ListingEvidencePolicyRequestError || error instanceof SyntaxError) {
      return { validation: null, error: error.message };
    }
    throw error;
  }

  return redirect("/listing-evidence-policy");
}

export default function ListingEvidencePolicyRoute() {
  const { overview, selectorCatalog } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <ListingEvidencePolicyPage
      overview={overview}
      selectorCatalog={selectorCatalog}
      permissions={useAdminActorPermissions()}
      validation={actionData && "validation" in actionData ? actionData.validation : null}
      error={actionData && "error" in actionData ? actionData.error : null}
    />
  );
}

function useAdminActorPermissions() {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      return (match.data as { actor?: { permissions?: readonly string[] } }).actor?.permissions ?? [];
    }
  }
  return [];
}
