import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { ChannelPublicationDetailPage } from "../../features/listing-composition/ui/publication-pages";
import {
  ChannelsPublicationApiError,
  createChannelsPublicationRequestApiClient,
} from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  const connectionId = required(params.connectionId);
  try {
    return {
      kind: "ready" as const,
      detail: await createChannelsPublicationRequestApiClient(request).getConnection(
        connectionId,
        new URL(request.url).searchParams.get("cursor"),
      ),
    };
  } catch (error) {
    if (error instanceof ChannelsPublicationApiError && error.status === 404)
      return { kind: "foreign-account" as const };
    throw error;
  }
}

export const action = defineFormAction({
  authorization: { permission: "channels.manage" },
  intents: {
    "replace-settings": async ({ request, formData }) => {
      const result = await createChannelsPublicationRequestApiClient(request).replaceSettings(
        connectionId(request),
        {
          titlePrefix: text(formData, "titlePrefix"),
          titleSuffix: text(formData, "titleSuffix"),
          descriptionFooter: text(formData, "descriptionFooter"),
          categoryAllowlist: lines(formData, "categoryAllowlist"),
          excludedListingIds: lines(formData, "excludedListingIds"),
        },
        integer(formData, "expectedStreamVersion"),
      );
      return result.kind === "refused" && result.code === "stream-version-conflict"
        ? { kind: "stale-version-conflict" as const }
        : {
            kind: result.kind === "refused" ? ("command-error" as const) : ("applied" as const),
            message: result.kind === "refused" ? result.code : null,
          };
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
      return result.kind === "refused" && result.code === "stream-version-conflict"
        ? { kind: "stale-version-conflict" as const }
        : {
            kind: result.kind === "refused" ? ("command-error" as const) : ("applied" as const),
            message: result.kind === "refused" ? result.code : null,
          };
    },
  },
  onUnknownIntent: () => ({ kind: "command-error" as const, message: t("channels.publication.action.unknown") }),
  onError: (error) => ({
    kind: "command-error" as const,
    message: error instanceof Error ? error.message : t("channels.publication.action.failed"),
  }),
});

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: t("channels.publication.connection.meta.title") });

export default function AccountChannelsPublicationConnectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
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
