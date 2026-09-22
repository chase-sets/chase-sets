import { t } from "@chase-sets/localization";
import { defineApiErrorAdapter, defineFormAction, defineResourceRoute } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useEffect, useState } from "react";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useParams, useRevalidator } from "react-router";
import { contextManifest, type ChannelPublicationSettings } from "../../index";
import { ChannelPublicationDetailPage } from "../../features/listing-composition/ui/publication-pages";
import {
  ChannelsPublicationApiError,
  createChannelsPublicationRequestApiClient,
} from "../../support/request-support/api-client";

const channelsPublicationApiErrorAdapter = defineApiErrorAdapter<ChannelsPublicationApiError>({
  isError: (error): error is ChannelsPublicationApiError => error instanceof ChannelsPublicationApiError,
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "channels-publication-connection",
  authorization: { permission: "channels.view" },
  errorAdapter: channelsPublicationApiErrorAdapter,
  load: ({ request, params }) =>
    createChannelsPublicationRequestApiClient(request).getConnection(
      required(params.connectionId),
      new URL(request.url).searchParams.get("cursor"),
    ),
  map: (detail) => ({ kind: "ready" as const, detail }),
  onPending: () => ({ kind: "loading" as const }),
  onPermanentFailure: (result) => {
    if ("error" in result) {
      if (result.error instanceof ChannelsPublicationApiError && result.error.status === 404) {
        return { kind: "foreign-account" as const };
      }
      throw result.error;
    }
    throw new Response(t("channels.publication.action.failed"), { status: 500 });
  },
});

export const action = defineFormAction({
  authorization: { permission: "channels.manage" },
  intents: {
    "replace-settings": async ({ request, formData }) => {
      const settings: ChannelPublicationSettings = {
        titlePrefix: text(formData, "titlePrefix"),
        titleSuffix: text(formData, "titleSuffix"),
        descriptionFooter: text(formData, "descriptionFooter"),
        categoryAllowlist: lines(formData, "categoryAllowlist"),
        excludedListingIds: lines(formData, "excludedListingIds"),
      };
      const result = await createChannelsPublicationRequestApiClient(request).replaceSettings(
        connectionId(request),
        settings,
        integer(formData, "expectedStreamVersion"),
      );
      if (result.kind === "refused")
        return result.code === "stream-version-conflict"
          ? { kind: "stale-version-conflict" as const }
          : { kind: "command-error" as const, message: result.code };
      return { kind: "applied" as const, message: null, streamVersion: result.streamVersion, settings };
    },
    "decide-mapping": async ({ request, formData }) => {
      const result = await createChannelsPublicationRequestApiClient(request).decideMapping({
        connectionId: connectionId(request),
        dimension: text(formData, "dimension"),
        sourceKey: text(formData, "sourceKey"),
        decision: text(formData, "decision"),
        targetKey: optionalText(formData, "targetKey"),
        expectedStreamVersion: integer(formData, "expectedStreamVersion"),
      });
      if (result.kind === "refused")
        return result.code === "stream-version-conflict"
          ? { kind: "stale-version-conflict" as const }
          : { kind: "command-error" as const, message: result.code };
      return { kind: "applied" as const, message: null, streamVersion: result.streamVersion };
    },
  },
  onUnknownIntent: () => ({ kind: "command-error" as const, message: t("channels.publication.action.unknown") }),
  onError: (error) => ({
    kind: "command-error" as const,
    message: error instanceof Error ? error.message : t("channels.publication.action.failed"),
  }),
});

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: t("channels.publication.connection.meta.title") });

const FRESHNESS_REVALIDATION_CAP = 15;
const FRESHNESS_REVALIDATION_INTERVAL_MS = 2_000;

export default function AccountChannelsPublicationConnectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const connectionId = useParams<{ connectionId: string }>().connectionId ?? null;
  const [latchConnectionId, setLatchConnectionId] = useState(connectionId);
  const [refreshAttempts, setRefreshAttempts] = useState(0);
  const [expectedStreamVersion, setExpectedStreamVersion] = useState<number | null>(null);
  const [submittedSettings, setSubmittedSettings] = useState<ChannelPublicationSettings | null>(null);
  if (latchConnectionId !== connectionId) {
    setLatchConnectionId(connectionId);
    setExpectedStreamVersion(null);
    setSubmittedSettings(null);
    setRefreshAttempts(0);
  } else {
    const appliedStreamVersion = actionData?.kind === "applied" ? actionData.streamVersion : null;
    if (appliedStreamVersion !== null && appliedStreamVersion !== expectedStreamVersion) {
      setExpectedStreamVersion(appliedStreamVersion);
      setSubmittedSettings(actionData?.kind === "applied" && "settings" in actionData ? actionData.settings : null);
      setRefreshAttempts(0);
    }
  }
  const freshnessPending =
    data.kind === "ready" &&
    expectedStreamVersion !== null &&
    data.detail.configurationStreamVersion < expectedStreamVersion;
  const freshnessExhausted = freshnessPending && refreshAttempts >= FRESHNESS_REVALIDATION_CAP;
  useEffect(() => {
    if (
      !freshnessPending ||
      navigation.state !== "idle" ||
      revalidator.state !== "idle" ||
      refreshAttempts >= FRESHNESS_REVALIDATION_CAP
    )
      return;
    const timer = setTimeout(() => {
      setRefreshAttempts((attempts) => attempts + 1);
      void revalidator.revalidate();
    }, FRESHNESS_REVALIDATION_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [freshnessPending, navigation.state, revalidator, refreshAttempts]);
  if (data.kind === "loading") return <ChannelPublicationDetailPage state={{ kind: "loading" }} />;
  if (data.kind === "foreign-account") return <ChannelPublicationDetailPage state={{ kind: "foreign-account" }} />;
  if (actionData?.kind === "stale-version-conflict")
    return <ChannelPublicationDetailPage state={{ kind: "stale-version-conflict", detail: data.detail }} />;
  if (actionData?.kind === "command-error")
    return (
      <ChannelPublicationDetailPage
        state={{
          kind: "command-error",
          message: actionData.message ?? t("channels.publication.action.failed"),
          detail: data.detail,
        }}
      />
    );
  if (freshnessExhausted)
    return (
      <ChannelPublicationDetailPage
        state={{
          kind: "freshness-exhausted",
          detail: { ...data.detail, settings: submittedSettings ?? data.detail.settings },
          onRefresh: () => {
            setRefreshAttempts(0);
            void revalidator.revalidate();
          },
        }}
      />
    );
  if (freshnessPending) return <ChannelPublicationDetailPage state={{ kind: "loading" }} />;
  return <ChannelPublicationDetailPage state={{ kind: "ready", detail: data.detail }} />;
}

function required(value: string | undefined): string {
  if (!value) throw new Response("Not found", { status: 404 });
  return value;
}
function connectionId(request: Request): string {
  return required(new URL(request.url).pathname.split("/").filter(Boolean).at(-1));
}
function text(data: FormData, key: string): string {
  return String(data.get(key) ?? "");
}
function optionalText(data: FormData, key: string): string | null {
  const value = text(data, key).trim();
  return value || null;
}
function integer(data: FormData, key: string): number {
  const value = Number(data.get(key));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid-version");
  return value;
}
function lines(data: FormData, key: string): readonly string[] {
  return [
    ...new Set(
      text(data, key)
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
