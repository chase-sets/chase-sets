import {
  Badge,
  Button,
  Card,
  Form,
  HiddenInput,
  MarketplaceNotice,
  NativeSelect,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { channelAttentionResolutions, type ChannelConnectionAttention } from "../domain/contracts";

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
    <Card data-testid="channel-health-panel">
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
            {state.data.health.length === 0 ? (
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
          </>
        )}
      </Stack>
    </Card>
  );
}
