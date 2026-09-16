import { Button, Card, HiddenInput, MarketplaceNotice, Stack, Text } from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { t } from "@chase-sets/localization";
import type { ConnectorPairingDetail, GeneratedPairingCode } from "../domain/contracts";
export type { GeneratedPairingCode } from "../domain/contracts";

export type PairingPanelState =
  | Readonly<{ kind: "loaded"; data: ConnectorPairingDetail }>
  | Readonly<{ kind: "read-error" }>;

export function ConnectorPairingPanel({
  state,
  generated,
  pending = false,
  available = true,
}: {
  state: PairingPanelState;
  generated?: GeneratedPairingCode;
  pending?: boolean;
  available?: boolean;
}) {
  const pairing = state.kind === "loaded" ? state.data : null;
  const currentCode =
    generated && pairing?.state === "code" && pairing.pairingId === generated.pairingId ? generated : null;
  return (
    <Card elevation="tinted" data-elevation-role="furniture">
      <Stack gap={3}>
        <Text weight="semibold">{t("channels.connector.title")}</Text>
        {state.kind === "read-error" ? (
          <MarketplaceNotice
            tone="danger"
            title={t("channels.connector.error")}
            description={t("channels.connector.retry")}
          />
        ) : null}
        {pairing ? <Text>{t(`channels.connector.state.${pairing.state}`)}</Text> : null}
        {currentCode ? (
          <Stack gap={2}>
            <Text>{currentCode.code}</Text>
            <Text>{t("channels.connector.expires", { at: currentCode.expiresAt })}</Text>
          </Stack>
        ) : null}
        {pairing?.state === "code" && !currentCode ? <Text>{t("channels.connector.codeHidden")}</Text> : null}
        {pairing?.state === "paired" ? (
          <Text>
            {pairing.lastSeenAt
              ? t("channels.connector.lastSeen", { at: pairing.lastSeenAt })
              : t("channels.connector.notSeen")}
          </Text>
        ) : null}
        {available ? (
          <RouterForm method="post" spacing="none">
            <HiddenInput type="hidden" name="intent" value="connector-code" />
            <Button type="submit" tone="secondary" disabled={pending}>
              {t("channels.connector.generate")}
            </Button>
          </RouterForm>
        ) : (
          <Text>{t("channels.connector.unavailable")}</Text>
        )}
        {pairing && (pairing.state === "code" || pairing.state === "paired") ? (
          <RouterForm method="post" spacing="none">
            <HiddenInput type="hidden" name="intent" value="connector-unpair" />
            <HiddenInput type="hidden" name="pairingId" value={pairing.pairingId ?? ""} />
            <HiddenInput type="hidden" name="revision" value={String(pairing.revision)} />
            <Button type="submit" tone="danger" disabled={pending}>
              {t("channels.connector.unpair")}
            </Button>
          </RouterForm>
        ) : null}
        {pending ? <Text>{t("channels.connector.pending")}</Text> : null}
      </Stack>
    </Card>
  );
}
