import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useEffect, useState } from "react";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useParams, useRevalidator } from "react-router";
import type { ChannelPublicationConnectionDetail, ChannelPublicationSettings } from "../../../../index";
import { t } from "../localization/translator";
import { ChannelPublicationDetailPage } from "../publication-pages";
import type { action, loader } from "./account-channels-publication-connection.server";

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
  const [submittedMapping, setSubmittedMapping] = useState<{
    dimension: string;
    sourceKey: string;
    targetKey: string | null;
  } | null>(null);
  if (latchConnectionId !== connectionId) {
    setLatchConnectionId(connectionId);
    setExpectedStreamVersion(null);
    setSubmittedSettings(null);
    setSubmittedMapping(null);
    setRefreshAttempts(0);
  } else {
    const appliedStreamVersion = actionData?.kind === "applied" ? actionData.streamVersion : null;
    if (appliedStreamVersion !== null && appliedStreamVersion !== expectedStreamVersion) {
      setExpectedStreamVersion(appliedStreamVersion);
      setSubmittedSettings(actionData?.kind === "applied" && "settings" in actionData ? actionData.settings : null);
      setSubmittedMapping(actionData?.kind === "applied" && "mapping" in actionData ? actionData.mapping : null);
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
  const retainedDetail = (): ChannelPublicationConnectionDetail => ({
    ...data.detail,
    settings: freshnessPending ? (submittedSettings ?? data.detail.settings) : data.detail.settings,
    mappingReview: {
      ...data.detail.mappingReview,
      items: data.detail.mappingReview.items.map((item) =>
        freshnessPending &&
        submittedMapping?.dimension === item.dimension &&
        submittedMapping.sourceKey === item.sourceKey
          ? { ...item, targetKey: submittedMapping.targetKey }
          : item,
      ),
    },
  });
  if (actionData?.kind === "stale-version-conflict")
    return (
      <ChannelPublicationDetailPage
        appliedVersion={expectedStreamVersion}
        state={{ kind: "stale-version-conflict", detail: retainedDetail(), freshnessPending }}
      />
    );
  if (actionData?.kind === "command-error")
    return (
      <ChannelPublicationDetailPage
        appliedVersion={expectedStreamVersion}
        state={{
          kind: "command-error",
          message: actionData.message ?? t("channels.publication.action.failed"),
          detail: retainedDetail(),
          freshnessPending,
        }}
      />
    );
  if (freshnessExhausted)
    return (
      <ChannelPublicationDetailPage
        appliedVersion={expectedStreamVersion}
        state={{
          kind: "freshness-exhausted",
          detail: retainedDetail(),
          onRefresh: () => {
            setRefreshAttempts(0);
            void revalidator.revalidate();
          },
        }}
      />
    );
  if (freshnessPending)
    return (
      <ChannelPublicationDetailPage
        appliedVersion={expectedStreamVersion}
        state={{ kind: "freshness-pending", detail: retainedDetail() }}
      />
    );
  return (
    <ChannelPublicationDetailPage
      appliedVersion={expectedStreamVersion}
      state={{ kind: "ready", detail: data.detail }}
    />
  );
}
