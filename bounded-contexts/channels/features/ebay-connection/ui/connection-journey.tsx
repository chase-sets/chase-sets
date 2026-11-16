import { t } from "@chase-sets/localization";
import {
  Button,
  Card,
  HiddenInput,
  LinkButton,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";

export type EbayJourneyState =
  | "connect"
  | "consent"
  | "awaiting-callback"
  | "declined"
  | "failed"
  | "pending-setup"
  | "connected"
  | "reauthorize"
  | "disconnected";
export function EbayConnectionJourney({
  state,
  scopes,
  connectionId,
  publication = false,
  authorizationAvailable = true,
}: {
  state: EbayJourneyState;
  scopes: readonly string[];
  connectionId: string | null;
  publication?: boolean;
  authorizationAvailable?: boolean;
}) {
  const live = connectionId !== null && state !== "disconnected";
  return (
    <Page>
      <PageHeader title={t("channels.ebay.title")} description={t("channels.ebay.description")} />
      <PageSection title={t(`channels.ebay.state.${state}`)}>
        <Stack gap={4}>
          {state === "failed" || state === "declined" ? (
            <MarketplaceNotice
              tone="warning"
              title={t(`channels.ebay.state.${state}`)}
              description={t("channels.ebay.tryAgain")}
            />
          ) : null}
          {state === "disconnected" ? (
            <MarketplaceNotice
              tone="warning"
              title={t("channels.ebay.state.disconnected")}
              description={t("channels.ebay.unconfirmed")}
            />
          ) : null}
          {state === "pending-setup" ? <Text>{t("channels.ebay.setupRequired")}</Text> : null}
          {authorizationAvailable && state !== "awaiting-callback" ? (
            <Card elevation="tinted" data-elevation-role="furniture">
              <Stack gap={3}>
                <Text>{t("channels.ebay.consent")}</Text>
                {scopes.map((scope) => (
                  <Text key={scope}>{scope}</Text>
                ))}
                <RouterForm method="post">
                  <HiddenInput name="intent" value="authorize" />
                  <HiddenInput name="connectionId" value={live ? connectionId : ""} />
                  <HiddenInput name="publication" value={publication ? "true" : "false"} />
                  <Button type="submit">{t(live ? "channels.ebay.reauthorize" : "channels.ebay.connect")}</Button>
                </RouterForm>
              </Stack>
            </Card>
          ) : state === "awaiting-callback" ? (
            <Text>{t("channels.ebay.awaiting")}</Text>
          ) : null}
          {live ? (
            <RouterForm method="post">
              <HiddenInput name="intent" value="disconnect" />
              <HiddenInput name="connectionId" value={connectionId} />
              <Button type="submit" tone="secondary">
                {t("channels.ebay.disconnect")}
              </Button>
            </RouterForm>
          ) : null}
          <LinkButton href="/account/channels" tone="secondary">
            {t("channels.ebay.back")}
          </LinkButton>
        </Stack>
      </PageSection>
    </Page>
  );
}
