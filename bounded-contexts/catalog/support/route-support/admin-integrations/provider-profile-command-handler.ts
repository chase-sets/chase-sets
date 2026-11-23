import type { CatalogProviderProfileVersionReview } from "../../client-support/contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";
import {
  lifecycleFailureResult,
  lifecycleSuccessResult,
  runProviderProfileLifecycleCommand,
} from "./integrations-command-context";
import {
  editableProfileSectionKey,
  profileSectionEditFromFormData,
  profileSectionFailureResult,
} from "./integrations-profile-section-command";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The provider-setup surface owns profile authoring and validation readiness:
// cloning a draft, activating a profile, and editing profile sections. A result
// names no page: the invoking page's route action (Provider detail) keeps it, and
// a section edit reports the edited section as `commandSection` feedback.
export type ProviderProfileCommandIntent =
  | "provider-profile.clone"
  | "provider-profile.edit-section"
  | "provider-profile.activate"
  | "provider-profile.rollback"
  | "provider-profile.deprecate"
  | "provider-profile.retire";

const PROVIDER_PROFILE_COMMAND_INTENTS = new Set<string>([
  "provider-profile.clone",
  "provider-profile.edit-section",
  "provider-profile.activate",
  "provider-profile.rollback",
  "provider-profile.deprecate",
  "provider-profile.retire",
] satisfies ProviderProfileCommandIntent[]);

export function isProviderProfileCommandIntent(intent: string): intent is ProviderProfileCommandIntent {
  return PROVIDER_PROFILE_COMMAND_INTENTS.has(intent);
}

export async function handleProviderProfileCommand(input: {
  api: Api;
  intent: ProviderProfileCommandIntent;
  context: RouteContext;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;

  switch (intent) {
    case "provider-profile.clone":
      return cloneProviderProfile(api, context, formData, selectedObservationIds);
    case "provider-profile.activate":
      return activateProviderProfile(api, context, formData, selectedObservationIds);
    case "provider-profile.edit-section":
      return updateProviderProfileSection(api, context, formData, selectedObservationIds);
    case "provider-profile.rollback":
    case "provider-profile.deprecate":
    case "provider-profile.retire":
      return transitionProviderProfile(api, intent, context, formData, selectedObservationIds);
  }
}

async function cloneProviderProfile(
  api: Api,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const sourceProviderKey = stringValue(formData.get("sourceProviderKey")) ?? context.providerKey;
  const sourceProfileVersion = stringValue(formData.get("sourceProfileVersion")) ?? context.profileVersion;
  const targetProfileVersion = stringValue(formData.get("targetProfileVersion"));
  const targetLifecycle = stringValue(formData.get("targetLifecycle")) ?? "draft";
  if (!sourceProviderKey || !sourceProfileVersion || !targetProfileVersion || targetLifecycle !== "draft") {
    return profileResult("provider-profile.clone", "error", "invalid-intent", {
      ...context,
      section: "profile-authoring",
      selectedObservationIds,
    });
  }

  const profile = await api.cloneSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
    sourceProviderKey,
    sourceProfileVersion,
    { targetProfileVersion, lifecycle: "draft" },
  );

  return profileResult("provider-profile.clone", "success", "draft-created", {
    ...context,
    section: "profile-authoring",
    providerKey: profile.providerKey,
    profileVersion: profile.profileVersion,
    selectedObservationIds,
    promotionPreviewId: null,
  });
}

async function activateProviderProfile(
  api: Api,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
  const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
  if (!providerKey || !profileVersion) {
    return profileResult("provider-profile.activate", "error", "invalid-intent", {
      ...context,
      section: "validation-readiness",
      selectedObservationIds,
    });
  }

  const profile = await api.activateSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
    providerKey,
    profileVersion,
  );

  return profileResult("provider-profile.activate", "success", "profile-activated", {
    ...context,
    section: "validation-readiness",
    providerKey: profile.providerKey,
    profileVersion: profile.profileVersion,
    selectedObservationIds,
    promotionPreviewId: null,
  });
}

async function updateProviderProfileSection(
  api: Api,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
  const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
  const sectionKey = editableProfileSectionKey(stringValue(formData.get("sectionKey")));
  // Migration-evidence saves made from validation readiness stay in validation
  // readiness; every other section edit belongs to profile authoring.
  const returnSection =
    sectionKey === "migration-evidence" && context.section === "validation-readiness"
      ? "validation-readiness"
      : "profile-authoring";
  if (!providerKey || !profileVersion || !sectionKey) {
    return profileResult(
      "provider-profile.edit-section",
      "error",
      "invalid-intent",
      { ...context, section: returnSection, selectedObservationIds },
      sectionKey ?? undefined,
    );
  }

  try {
    const edit = profileSectionEditFromFormData(sectionKey, formData);
    const profile = await api.updateSourceObservationProviderProfileSection<CatalogProviderProfileVersionReview>(
      providerKey,
      profileVersion,
      sectionKey,
      edit.fields,
      stringValue(formData.get("sectionFingerprint")) ?? "",
    );

    return profileResult(
      "provider-profile.edit-section",
      "success",
      "section-saved",
      {
        ...context,
        section: returnSection,
        providerKey: profile.providerKey,
        profileVersion: profile.profileVersion,
        selectedObservationIds,
        promotionPreviewId: null,
      },
      sectionKey,
    );
  } catch (error) {
    return profileResult(
      "provider-profile.edit-section",
      "error",
      profileSectionFailureResult(error),
      { ...context, section: returnSection, providerKey, profileVersion, selectedObservationIds },
      sectionKey,
    );
  }
}

async function transitionProviderProfile(
  api: Api,
  intent: Extract<
    ProviderProfileCommandIntent,
    "provider-profile.rollback" | "provider-profile.deprecate" | "provider-profile.retire"
  >,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
  const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
  if (!providerKey || !profileVersion) {
    return profileResult(intent, "error", "invalid-intent", {
      ...context,
      selectedObservationIds,
    });
  }
  try {
    const confirmation = formData.get("lifecycleConfirmation");
    const profile = await runProviderProfileLifecycleCommand(
      api,
      intent,
      providerKey,
      profileVersion,
      typeof confirmation === "string" ? confirmation : null,
    );
    return profileResult(intent, "success", lifecycleSuccessResult(intent), {
      ...context,
      providerKey: profile.providerKey,
      profileVersion: profile.profileVersion,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  } catch (error) {
    return profileResult(intent, "error", lifecycleFailureResult(error), {
      ...context,
      providerKey,
      profileVersion,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  }
}

function profileResult(
  intent: ProviderProfileCommandIntent,
  status: CatalogPrimaryWorkbenchCommandFeedback["status"],
  result: CatalogPrimaryWorkbenchCommandFeedback["result"],
  context: RouteContext,
  commandSection?: string,
): CatalogIntegrationsCommandResult {
  return {
    feedback: { status, intent, result },
    context,
    commandSection,
  };
}
