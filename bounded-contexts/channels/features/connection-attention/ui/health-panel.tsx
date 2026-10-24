import {
  Badge,
  Button,
  Card,
  Form,
  HiddenInput,
  LinkButton,
  MarketplaceNotice,
  NativeSelect,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  channelAttentionResolutions,
  connectorAttentionKinds,
  type ChannelConnectionAttention,
  type ConnectorAttentionContribution,
  type ConnectorUnknownOutcome,
} from "../domain/contracts";

export type ChannelHealthPanelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "read-error" }>
  | Readonly<{ kind: "loaded"; data: ChannelConnectionAttention }>;
const reasonKeys = {
  credential: "channels.attention.reason.credential",
  "seller-setup": "channels.attention.reason.seller-setup",
  subscription: "channels.attention.reason.subscription",
  polling: "channels.attention.reason.polling",
  drift: "channels.attention.reason.drift",
  "provider-rate": "channels.attention.reason.provider-rate",
  "provider-availability": "channels.attention.reason.provider-availability",
  "sale-follow-up": "channels.attention.reason.sale-follow-up",
  "connector-liveness": "channels.attention.reason.connector-liveness",
} as const;
const stateKeys = {
  unknown: "channels.attention.state.unknown",
  healthy: "channels.attention.state.healthy",
  degraded: "channels.attention.state.degraded",
  failing: "channels.attention.state.failing",
} as const;
const resolutionKeys = {
  "handled-on-channel": "channels.attention.resolution.handled-on-channel",
  reconnected: "channels.attention.resolution.reconnected",
  "reselected-setup": "channels.attention.resolution.reselected-setup",
  "recovered-automatically": "channels.attention.resolution.recovered-automatically",
  "inventory-adjusted-separately": "channels.attention.resolution.inventory-adjusted-separately",
  "no-action-required": "channels.attention.resolution.no-action-required",
} as const;

export function ChannelConnectionHealthPanel({
  state,
  pending = false,
}: Readonly<{ state: ChannelHealthPanelState; pending?: boolean }>) {
  return (
    <Card data-testid="channel-health-panel" elevation="flush">
      <Stack gap={3}>
        <Text>{t("channels.attention.title")}</Text>
        {state.kind === "loading" ? (
          <Text>{t("channels.attention.loading")}</Text>
        ) : state.kind === "read-error" ? (
          <MarketplaceNotice
            tone="danger"
            title={t("channels.attention.unavailable")}
            description={t("channels.attention.unavailable.description")}
          />
        ) : (
          <>
            <Badge
              tone={
                state.data.healthState === "failing"
                  ? "danger"
                  : state.data.healthState === "degraded"
                    ? "warning"
                    : "info"
              }
            >
              {t(stateKeys[state.data.healthState])}
            </Badge>
            {state.data.health.length === 0 && !state.data.orders?.count ? (
              <MarketplaceNotice
                tone="info"
                title={t("channels.attention.healthy")}
                description={t("channels.attention.healthy.description")}
              />
            ) : null}
            {state.data.health.map((reason) => (
              <Stack key={`${reason.reasonCode}:${reason.generation}`} gap={2}>
                <Text>{t(reasonKeys[reason.reasonCode])}</Text>
                <Form method="post">
                  <HiddenInput name="intent" value="resolve-attention" />
                  <HiddenInput name="reasonCode" value={reason.reasonCode} />
                  <HiddenInput name="generation" value={String(reason.generation)} />
                  <NativeSelect
                    name="resolutionReason"
                    label={t("channels.attention.resolution")}
                    items={channelAttentionResolutions
                      .filter((value) => value !== "recovered-automatically")
                      .map((value) => ({ value, label: t(resolutionKeys[value]) }))}
                    required
                    disabled={pending}
                  />
                  <Button type="submit" disabled={pending}>
                    {t("channels.attention.resolve")}
                  </Button>
                </Form>
              </Stack>
            ))}
            {state.data.orders?.items.map((order) => (
              <Stack key={`${order.externalOrderReference}:${order.reason}:${order.generation}`} gap={2}>
                <Text>{t("channels.attention.orderReference", { reference: order.externalOrderReference })}</Text>
                <Text>{t(orderReasonKeys[order.reason])}</Text>
              </Stack>
            ))}
            {state.data.orders && state.data.orders.count > 0 && state.data.orders.items.length === 0 ? (
              <LinkButton href="?">{t("channels.attention.firstOrders")}</LinkButton>
            ) : null}
            {state.data.orders?.nextCursor ? (
              <LinkButton href={`?${new URLSearchParams({ orderCursor: state.data.orders.nextCursor })}`}>
                {t("channels.attention.moreOrders")}
              </LinkButton>
            ) : null}
            {state.data.connector ? <ConnectorSection connector={state.data.connector} /> : null}
          </>
        )}
      </Stack>
    </Card>
  );
}

// Unknown outcomes are an instruction only: Chase Sets never retries them, so no row carries a control.
function ConnectorSection({ connector }: Readonly<{ connector: ConnectorAttentionContribution }>) {
  const active = connectorAttentionKinds.filter((kind) => {
    const activity = connector.activity[kind];
    return activity.lastSucceededAt !== null || activity.queued > 0 || activity.inFlightSince !== null;
  });
  return (
    <Stack gap={2} data-testid="channel-connector-attention">
      <Text weight="semibold">{t("channels.attention.connector.title")}</Text>
      {connector.signInNeeded ? (
        <MarketplaceNotice
          tone="warning"
          title={t("channels.attention.connector.signIn")}
          description={t("channels.attention.connector.signIn.description")}
        />
      ) : null}
      {connector.unknownOutcomes.length > 0 ? (
        <MarketplaceNotice
          tone="warning"
          title={t("channels.attention.connector.unknown")}
          description={t("channels.attention.connector.unknown.description")}
        />
      ) : null}
      {connector.unknownOutcomes.map((outcome) => (
        <Stack key={outcome.kind} gap={1}>
          <Badge tone="warning">{t(connectorKindKeys[outcome.kind])}</Badge>
          <Text>
            {t("channels.attention.connector.unknown.reference", { idSuffix: outcome.idSuffix, at: outcome.at })}
          </Text>
          <Text>{t(connectorReasonKeys[outcome.reason])}</Text>
        </Stack>
      ))}
      {active.length === 0 ? <Text>{t("channels.attention.connector.idle")}</Text> : null}
      {active.map((kind) => {
        const activity = connector.activity[kind];
        return (
          <Stack key={kind} gap={1}>
            <Text weight="semibold">{t(connectorKindKeys[kind])}</Text>
            <Text>
              {activity.lastSucceededAt
                ? t("channels.attention.connector.lastSucceeded", { at: activity.lastSucceededAt })
                : t("channels.attention.connector.notSucceeded")}
            </Text>
            <Text>{t("channels.attention.connector.queued", { count: String(activity.queued) })}</Text>
            {activity.inFlightSince ? (
              <Text>{t("channels.attention.connector.inFlight", { at: activity.inFlightSince })}</Text>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

const connectorKindKeys = {
  "live-export": "channels.attention.connector.kind.live-export",
  "order-pull": "channels.attention.connector.kind.order-pull",
  "staged-import-batch": "channels.attention.connector.kind.staged-import-batch",
} as const;
const connectorReasonKeys = {
  "authority-unavailable": "channels.attention.connector.reason.authority-unavailable",
  "session-lost": "channels.attention.connector.reason.session-lost",
  "download-unproven": "channels.attention.connector.reason.download-unproven",
  "raw-unreadable": "channels.attention.connector.reason.raw-unreadable",
  "parse-refused": "channels.attention.connector.reason.parse-refused",
  "cap-exceeded": "channels.attention.connector.reason.cap-exceeded",
  "admission-ambiguous": "channels.attention.connector.reason.admission-ambiguous",
  "budget-exceeded": "channels.attention.connector.reason.budget-exceeded",
  "completeness-unproven": "channels.attention.connector.reason.completeness-unproven",
  "recovery-content-changed": "channels.attention.connector.reason.recovery-content-changed",
  "application-unknown": "channels.attention.connector.reason.application-unknown",
} as const satisfies Record<ConnectorUnknownOutcome["reason"], string>;

const orderReasonKeys = {
  "channel-order-unmapped": "channels.attention.orderUnmapped",
  "channel-order-sale-absent": "channels.attention.orderRecordingRefused",
  "tcgplayer-order-unmapped": "channels.attention.orderUnmapped",
  "tcgplayer-order-identity-ambiguous": "channels.attention.orderIdentityAmbiguous",
  "tcgplayer-order-recording-refused": "channels.attention.orderRecordingRefused",
  "tcgplayer-order-cancelled": "channels.attention.orderCancelled",
  "backdated-sale": "channels.attention.orderBackdated",
} as const;
