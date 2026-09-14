import { useState } from "react";
import { useFetcher, useLocation, useNavigate, useRevalidator } from "react-router";
import { Badge, Button, Card, HiddenInput, MarketplaceNotice, Stack, Text } from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import type {
  AcceptChannelDrift,
  ChannelDriftDecision,
  ChannelDriftDetail,
  ChannelDriftDetailRow,
  RepushChannelListing,
} from "../domain/contracts";

export type DriftSubmission =
  | Readonly<{ intent: "accept-drift"; input: AcceptChannelDrift }>
  | Readonly<{ intent: "repush-drift"; input: RepushChannelListing }>;
export type DriftActionResult = Readonly<{
  kind: "drift-result";
  outcome: "committed" | "conflict" | "refused" | "uncertain";
  submission: DriftSubmission;
  decision?: ChannelDriftDecision;
}>;
const fetcherKey = "channel-drift-decision";
const classifications = {
  "in-sync": "channels.drift.in-sync",
  repairable: "channels.drift.repairable",
  "foreign-edit": "channels.drift.foreign-edit",
  structural: "channels.drift.structural",
  "source-unavailable": "channels.drift.source-unavailable",
} as const;

export function ChannelDriftPanel({
  detail,
  canManage,
  loadIdentity,
  loading,
}: Readonly<{
  detail: ChannelDriftDetail;
  canManage: boolean;
  loadIdentity: string;
  loading: boolean;
}>) {
  const fetcher = useFetcher<DriftActionResult>({ key: fetcherKey });
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const location = useLocation();
  const [dismissed, setDismissed] = useState<DriftActionResult>();
  const result = fetcher.data?.kind === "drift-result" && fetcher.data !== dismissed ? fetcher.data : undefined;
  const pending = loading || fetcher.state !== "idle" || revalidator.state !== "idle";
  const blocked = pending || result?.outcome === "uncertain" || result?.outcome === "conflict";
  function page(cursor?: string) {
    const query = new URLSearchParams(location.search);
    if (cursor) query.set("driftCursor", cursor);
    else query.delete("driftCursor");
    navigate(`${location.pathname}?${query}`);
  }
  return (
    <Card data-testid="channel-drift-panel" data-load-identity={loadIdentity}>
      <Stack gap={3}>
        <Text>{t("channels.drift.title")}</Text>
        <Text>{t("channels.drift.disclaimer")}</Text>
        {pending ? <Text>{t("channels.drift.loading")}</Text> : null}
        {result ? (
          <MarketplaceNotice
            tone={result.outcome === "committed" ? "info" : "warning"}
            title={t(
              result.outcome === "committed"
                ? result.submission.intent === "accept-drift"
                  ? "channels.drift.accepted"
                  : "channels.drift.requested"
                : result.outcome === "conflict"
                  ? "channels.drift.conflict"
                  : result.outcome === "uncertain"
                    ? "channels.drift.uncertain"
                    : "channels.drift.refused",
            )}
            description={t("channels.drift.disclaimer")}
          />
        ) : null}
        {result?.outcome === "uncertain" && canManage ? (
          <DecisionForm submission={result.submission} disabled={pending} label={t("channels.drift.retry")} />
        ) : null}
        {detail.kind !== "loaded" ? (
          <MarketplaceNotice
            tone={detail.kind === "unavailable" ? "danger" : "info"}
            title={t(
              detail.kind === "not-yet-observed"
                ? "channels.drift.unobserved"
                : detail.kind === "stale-page"
                  ? "channels.drift.stale-page"
                  : "channels.drift.unavailable",
            )}
            description={t("channels.drift.disclaimer")}
          />
        ) : (
          <>
            {detail.runState !== "completed" ? <Text>{t("channels.drift.retained")}</Text> : null}
            {detail.rows.length === 0 ? <Text>{t("channels.drift.empty")}</Text> : null}
            {detail.rows.map((row) => (
              <Stack key={`${row.rowKind}:${row.rowIdentity}`} gap={2}>
                {row.rowKind === "finding" ? (
                  <Badge tone="warning">{t("channels.drift.unmapped")}</Badge>
                ) : (
                  <>
                    <Text>{row.channelListingId}</Text>
                    <Badge tone={row.classification === "foreign-edit" ? "warning" : "info"}>
                      {t(classifications[row.classification])}
                    </Badge>
                    {row.decision.accepted ? <Text>{t("channels.drift.accepted")}</Text> : null}
                    {row.decision.repushRequested ? <Text>{t("channels.drift.requested")}</Text> : null}
                    {canManage &&
                    row.actionable &&
                    row.classification === "foreign-edit" &&
                    /^[a-f0-9]{64}$/.test(row.observedFingerprint ?? "") &&
                    /^[a-f0-9]{64}$/.test(row.expectedMaterialFingerprint ?? "") ? (
                      <RowDecisions
                        key={`${row.decision.revision}:${row.observedFingerprint}:${row.expectedMaterialFingerprint}`}
                        row={row}
                        disabled={blocked}
                      />
                    ) : null}
                  </>
                )}
              </Stack>
            ))}
            {detail.hasMore === 1 && detail.cursor ? (
              <Button disabled={blocked} onClick={() => page(detail.cursor!)}>
                {t("channels.drift.next")}
              </Button>
            ) : null}
          </>
        )}
        <Button
          disabled={pending}
          onClick={() => {
            if (result?.outcome !== "uncertain") setDismissed(fetcher.data);
            if (new URLSearchParams(location.search).has("driftCursor")) page();
            else void revalidator.revalidate();
          }}
        >
          {t("channels.drift.refresh")}
        </Button>
      </Stack>
    </Card>
  );
}

function RowDecisions({
  row,
  disabled,
}: Readonly<{ row: Extract<ChannelDriftDetailRow, { rowKind: "listing" }>; disabled: boolean }>) {
  const [ids] = useState(() => ({ accept: crypto.randomUUID(), repush: crypto.randomUUID() }));
  const base = {
    connectionId: row.decision.connectionId,
    channelListingId: row.channelListingId,
    expectedDecisionRevision: row.decision.revision,
  };
  return (
    <Stack gap={2}>
      <DecisionForm
        disabled={disabled}
        label={t("channels.drift.accept")}
        submission={{
          intent: "accept-drift",
          input: {
            ...base,
            operationId: ids.accept,
            observedFingerprint: row.observedFingerprint!,
            expectedMaterialFingerprint: row.expectedMaterialFingerprint!,
          },
        }}
      />
      <DecisionForm
        disabled={disabled}
        label={t("channels.drift.repush")}
        submission={{ intent: "repush-drift", input: { ...base, operationId: ids.repush } }}
      />
    </Stack>
  );
}

function DecisionForm({
  submission,
  disabled,
  label,
}: Readonly<{ submission: DriftSubmission; disabled: boolean; label: string }>) {
  return (
    <RouterForm method="post" navigate={false} fetcherKey={fetcherKey} disabled={disabled}>
      <HiddenInput name="intent" value={submission.intent} />
      {Object.entries(submission.input)
        .filter(([key]) => key !== "connectionId")
        .map(([key, value]) => (
          <HiddenInput key={key} name={key} value={String(value)} />
        ))}
      <Button type="submit" disabled={disabled}>
        {label}
      </Button>
    </RouterForm>
  );
}
