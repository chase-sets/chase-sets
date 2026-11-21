import { t } from "@chase-sets/localization";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useMatches } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
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

// admin-web serves this page in its Platform section (context.json's route section).
const policyRedirect = (commandResult: unknown) =>
  formActionRedirect(commandResult, "/platform/listing-evidence-policy");

export const action = defineFormAction({
  intents: {
    "create-draft": async ({ request, formData }) => {
      const rules = JSON.parse(String(formData.get("rules") ?? "[]")) as ListingEvidencePolicyRule[];
      return policyRedirect(
        await createListingEvidencePolicyDraft(request, {
          policyName: String(formData.get("policyName") ?? "").trim(),
          rules,
        }),
      );
    },
    validate: async ({ request, formData }) => ({
      validation: await validateListingEvidencePolicyDraft(request, String(formData.get("policyId") ?? "")),
      error: null,
    }),
    reject: async ({ request, formData }) => {
      return policyRedirect(await rejectListingEvidencePolicyDraft(request, String(formData.get("policyId") ?? "")));
    },
    rollback: async ({ request, formData }) => {
      return policyRedirect(
        await createListingEvidencePolicyRollbackDraft(request, String(formData.get("policyId") ?? "")),
      );
    },
    activate: async ({ request, formData }) => {
      if (formData.get("impactAcknowledged") !== "yes") {
        return { validation: null, error: t("marketplace.features.listingEvidencePolicy.ui.impact.required") };
      }
      const from = effectiveTime(formData, "effectiveFrom");
      const until = effectiveTime(formData, "effectiveUntil");
      if (!from.ok || !until.ok) {
        return { validation: null, error: t("marketplace.features.listingEvidencePolicy.ui.effective.invalid") };
      }
      if (!from.value) {
        return { validation: null, error: t("marketplace.features.listingEvidencePolicy.ui.effective.required") };
      }
      return policyRedirect(
        await activateListingEvidencePolicyDraft(request, String(formData.get("policyId") ?? ""), {
          effectiveFrom: from.value,
          effectiveUntil: until.value,
          impactAcknowledgmentHash: String(formData.get("impactAcknowledgmentHash") ?? ""),
        }),
      );
    },
  },
  onUnknownIntent: () => ({
    validation: null,
    error: t("marketplace.features.listingEvidencePolicy.ui.intent.invalid"),
  }),
  onError: (error) => {
    if (error instanceof ListingEvidencePolicyRequestError || error instanceof SyntaxError) {
      return { validation: null, error: error.message };
    }
    throw error;
  },
});

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
