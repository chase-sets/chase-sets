import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import type { CatalogProviderProfileVersionReview } from "../../../client";
import {
  commandTelemetryEvents,
  recordCatalogControlPlaneEvents,
  type CatalogControlPlaneTelemetryApi,
} from "../../../features/source-observations/ui/primary-workbench-telemetry";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/ui/primary-workbench-route-context";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-page";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  commandContextFromFormData,
  confirmsFreshPromotionPreview,
  integrationScopeFromContext,
  lifecycleConfirmationAccepted,
  lifecycleFailureResult,
  lifecycleSuccessResult,
  observationIdsFromFormData,
  previewPromotionForContext,
  promotionPreviewIdFor,
  promotionScopeFromContext,
  reapplyScopeFromContext,
  runProviderProfileLifecycleCommand,
  type CatalogCommandJobResponse,
  type CatalogPrimaryWorkbenchFormIntent,
} from "./integrations-command-context";
import { stringValue } from "./integrations-form-values";
import {
  editableProfileSectionKey,
  profileSectionCommandFromFormData,
  profileSectionFailureResult,
} from "./integrations-profile-section-command";

export async function action({ request }: ActionFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "") as CatalogPrimaryWorkbenchFormIntent;
  const context = commandContextFromFormData(request.url, formData);
  const selectedObservationIds = observationIdsFromFormData(formData, context.selectedObservationIds);

  try {
    switch (intent) {
      case "start-provider-import": {
        const job = await api.enqueueSourceObservationIntegrationJob<CatalogCommandJobResponse>(
          "import",
          integrationScopeFromContext(context),
        );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "retry-import-job":
      case "resume-import-job":
      case "cancel-import-job": {
        if (!context.jobId) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, selectedObservationIds },
            intent,
            status: "error",
            result: "job-required",
          });
        }

        const job =
          intent === "retry-import-job"
            ? await api.retrySourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
            : intent === "resume-import-job"
              ? await api.resumeSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
              : await api.cancelSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId);

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: intent === "cancel-import-job" ? "job-cancelled" : "job-queued",
        });
      }
      case "preview-promotion": {
        const preview = await previewPromotionForContext(api, context, selectedObservationIds);

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            promotionPreviewId: promotionPreviewIdFor(preview, context, selectedObservationIds),
          },
          intent,
          status: "success",
          result: "preview-ready",
        });
      }
      case "clone-provider-profile": {
        const sourceProviderKey = stringValue(formData.get("sourceProviderKey")) ?? context.providerKey;
        const sourceProfileVersion = stringValue(formData.get("sourceProfileVersion")) ?? context.profileVersion;
        const targetProfileVersion = stringValue(formData.get("targetProfileVersion"));
        const targetLifecycle = stringValue(formData.get("targetLifecycle")) ?? "draft";
        if (!sourceProviderKey || !sourceProfileVersion || !targetProfileVersion || targetLifecycle !== "draft") {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: "profile-authoring", selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
          });
        }

        const profile = await api.cloneSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
          sourceProviderKey,
          sourceProfileVersion,
          {
            targetProfileVersion,
            lifecycle: "draft",
          },
        );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            section: "profile-authoring",
            providerKey: profile.providerKey,
            profileVersion: profile.profileVersion,
            selectedObservationIds,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "draft-created",
        });
      }
      case "activate-provider-profile": {
        const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
        const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
        if (!providerKey || !profileVersion) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: "validation-readiness", selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
          });
        }

        const profile = await api.activateSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
          providerKey,
          profileVersion,
        );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            section: "validation-readiness",
            providerKey: profile.providerKey,
            profileVersion: profile.profileVersion,
            selectedObservationIds,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "profile-activated",
        });
      }
      case "rollback-provider-profile":
      case "deprecate-provider-profile":
      case "retire-provider-profile": {
        const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
        const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
        if (!providerKey || !profileVersion) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: "lifecycle-recovery", selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
          });
        }
        if (!lifecycleConfirmationAccepted(formData, intent, providerKey, profileVersion)) {
          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              section: "lifecycle-recovery",
              providerKey,
              profileVersion,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "error",
            result: "confirmation-required",
          });
        }

        try {
          const profile = await runProviderProfileLifecycleCommand(api, intent, providerKey, profileVersion);

          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              section: "lifecycle-recovery",
              providerKey: profile.providerKey,
              profileVersion: profile.profileVersion,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "success",
            result: lifecycleSuccessResult(intent),
          });
        } catch (error) {
          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              section: "lifecycle-recovery",
              providerKey,
              profileVersion,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "error",
            result: lifecycleFailureResult(error),
          });
        }
      }
      case "update-provider-profile-section": {
        const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
        const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;
        const sectionKey = editableProfileSectionKey(stringValue(formData.get("sectionKey")));
        const returnSection =
          sectionKey === "migration-evidence" && context.section === "validation-readiness"
            ? "validation-readiness"
            : "profile-authoring";
        if (!providerKey || !profileVersion || !sectionKey) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: returnSection, selectedObservationIds },
            intent,
            status: "error",
            result: "invalid-intent",
            commandSection: sectionKey ?? undefined,
          });
        }

        try {
          const command = await profileSectionCommandFromFormData(api, {
            providerKey,
            profileVersion,
            sectionKey,
            formData,
          });
          const profile = await api.updateSourceObservationProviderProfileSection<CatalogProviderProfileVersionReview>(
            providerKey,
            profileVersion,
            sectionKey,
            command,
          );

          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              section: returnSection,
              providerKey: profile.providerKey,
              profileVersion: profile.profileVersion,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "success",
            result: "section-saved",
            commandSection: sectionKey,
          });
        } catch (error) {
          const result = profileSectionFailureResult(error);

          return commandRedirectWithTelemetry(api, {
            context: { ...context, section: returnSection, providerKey, profileVersion, selectedObservationIds },
            intent,
            status: "error",
            result,
            commandSection: sectionKey,
          });
        }
      }
      case "execute-promotion": {
        if (
          !context.promotionPreviewId ||
          !(await confirmsFreshPromotionPreview(api, context, selectedObservationIds))
        ) {
          return commandRedirectWithTelemetry(api, {
            context: {
              ...context,
              selectedObservationIds,
              promotionPreviewId: null,
            },
            intent,
            status: "error",
            result: "preview-required",
          });
        }

        const job =
          selectedObservationIds.length > 0
            ? await api.bulkPromoteSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.bulkPromoteSourceObservationsByScope<CatalogCommandJobResponse>(
                promotionScopeFromContext(context),
              );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "reject-source-observations": {
        const reason = String(formData.get("reason") ?? "").trim();
        if (!reason) {
          return commandRedirectWithTelemetry(api, {
            context: { ...context, selectedObservationIds },
            intent,
            status: "error",
            result: "reason-required",
          });
        }

        const job =
          selectedObservationIds.length > 0
            ? await api.bulkRejectSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
            : await api.bulkRejectSourceObservationsByScope<CatalogCommandJobResponse>(
                promotionScopeFromContext(context),
                reason,
              );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "start-reapply": {
        const result =
          selectedObservationIds.length > 0
            ? await api.reapplySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.reapplySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(result.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "defer-source-observations": {
        const reason = String(formData.get("reason") ?? "").trim() || "Deferred from the primary workbench.";
        const job =
          selectedObservationIds.length > 0
            ? await api.deferSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
            : await api.deferSourceObservationsByScope<CatalogCommandJobResponse>(
                promotionScopeFromContext(context),
                reason,
              );

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds: [],
            jobId: stringValue(job.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      case "start-replay": {
        const result =
          selectedObservationIds.length > 0
            ? await api.replaySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.replaySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));

        return commandRedirectWithTelemetry(api, {
          context: {
            ...context,
            selectedObservationIds,
            jobId: stringValue(result.jobId) ?? context.jobId,
            promotionPreviewId: null,
          },
          intent,
          status: "success",
          result: "job-queued",
        });
      }
      default:
        return commandRedirectWithTelemetry(api, {
          context,
          intent,
          status: "error",
          result: "invalid-intent",
        });
    }
  } catch {
    return commandRedirectWithTelemetry(api, {
      context: { ...context, selectedObservationIds },
      intent,
      status: "error",
      result: "command-failed",
    });
  }
}

function commandRedirect(input: {
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;
  intent: string;
  status: CatalogPrimaryWorkbenchCommandFeedback["status"];
  result: CatalogPrimaryWorkbenchCommandFeedback["result"];
  commandSection?: string;
}) {
  const redirectSection =
    input.intent === "activate-provider-profile" ||
    (input.intent === "update-provider-profile-section" &&
      input.commandSection === "migration-evidence" &&
      input.context.section === "validation-readiness")
      ? "validation-readiness"
      : input.intent === "rollback-provider-profile" ||
          input.intent === "deprecate-provider-profile" ||
          input.intent === "retire-provider-profile"
        ? "lifecycle-recovery"
        : input.intent === "clone-provider-profile" || input.intent === "update-provider-profile-section"
          ? "profile-authoring"
          : "import-to-promotion";
  const url = new URL(catalogPrimaryWorkbenchHref(input.context, redirectSection), "https://admin.example");
  url.searchParams.set("commandStatus", input.status);
  url.searchParams.set("commandIntent", input.intent);
  url.searchParams.set("commandResult", input.result);
  if (input.commandSection) {
    url.searchParams.set("commandSection", input.commandSection);
  }

  return redirect(`${url.pathname}${url.search}`);
}

async function commandRedirectWithTelemetry(
  api: CatalogControlPlaneTelemetryApi,
  input: {
    context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;
    intent: string;
    status: CatalogPrimaryWorkbenchCommandFeedback["status"];
    result: CatalogPrimaryWorkbenchCommandFeedback["result"];
    commandSection?: string;
  },
) {
  await recordCatalogControlPlaneEvents(api, commandTelemetryEvents(input));
  return commandRedirect(input);
}
