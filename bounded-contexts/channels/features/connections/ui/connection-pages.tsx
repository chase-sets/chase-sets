import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  Form,
  HiddenInput,
  LinkButton,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ChannelConnectionStatus, PublicChannelConnection } from "../domain/contracts";

const listFilters: readonly Readonly<{ status: ChannelConnectionStatus | "default"; labelKey: string }>[] = [
  { status: "default", labelKey: "channels.connections.filter.default" },
  { status: "pending-setup", labelKey: "channels.connections.filter.pendingSetup" },
  { status: "active", labelKey: "channels.connections.filter.active" },
  { status: "paused", labelKey: "channels.connections.filter.paused" },
  { status: "disconnected", labelKey: "channels.connections.filter.disconnected" },
];

const statusLabelKeys: Readonly<Record<ChannelConnectionStatus, string>> = {
  "pending-setup": "channels.connections.status.pendingSetup",
  active: "channels.connections.status.active",
  paused: "channels.connections.status.paused",
  disconnected: "channels.connections.status.disconnected",
};

const statusTones: Readonly<Record<ChannelConnectionStatus, "success" | "warning" | "neutral">> = {
  "pending-setup": "warning",
  active: "success",
  paused: "warning",
  disconnected: "neutral",
};

function connectionHref(connectionId: string): string {
  return `/account/channels/${encodeURIComponent(connectionId)}`;
}

function filterHref(status: ChannelConnectionStatus | "default"): string {
  return status === "default" ? "/account/channels" : `/account/channels?status=${status}`;
}

function nextPageHref(status: ChannelConnectionStatus | "default", cursor: string): string {
  const params = new URLSearchParams();
  if (status !== "default") params.set("status", status);
  params.set("cursor", cursor);
  return `/account/channels?${params.toString()}`;
}

export type ChannelConnectionListPageState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{
      kind: "ready";
      connections: readonly PublicChannelConnection[];
      statusFilter: ChannelConnectionStatus | "default";
      nextCursor?: string;
    }>;

export function ChannelConnectionListPage({ state }: { state: ChannelConnectionListPageState }) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("channels.connections.eyebrow")}
        title={t("channels.connections.title")}
        description={t("channels.connections.description")}
      />
      <PageSection title={t("channels.connections.section.title")}>
        {state.kind === "ready" ? (
          <Stack direction="row" gap={2}>
            {listFilters.map((filter) => (
              <LinkButton
                key={filter.status}
                href={filterHref(filter.status)}
                tone={state.statusFilter === filter.status ? "primary" : "secondary"}
                size="sm"
              >
                {t(filter.labelKey)}
              </LinkButton>
            ))}
          </Stack>
        ) : null}
        {renderListState(state)}
      </PageSection>
    </Page>
  );
}

function renderListState(state: ChannelConnectionListPageState) {
  switch (state.kind) {
    case "loading":
      return <Text>{t("channels.connections.loading")}</Text>;
    case "error":
      return (
        <MarketplaceNotice tone="danger" title={t("channels.connections.error.title")} description={state.message} />
      );
    case "ready":
      if (state.connections.length === 0) {
        return (
          <MarketplaceNotice
            tone="info"
            title={t("channels.connections.empty.title")}
            description={t("channels.connections.empty.description")}
          />
        );
      }
      return (
        <Stack gap={3}>
          {state.connections.map((connection) => (
            <Card key={connection.connectionId} elevation="elevated" data-elevation-role="entity">
              <Stack gap={2}>
                <Text weight="semibold">{connection.providerKey}</Text>
                <Stack direction="row" gap={2}>
                  <Badge tone={statusTones[connection.status]}>{t(statusLabelKeys[connection.status])}</Badge>
                  <Badge tone="neutral">{connection.environment}</Badge>
                </Stack>
                <LinkButton href={connectionHref(connection.connectionId)} tone="secondary">
                  {t("channels.connections.open")}
                </LinkButton>
              </Stack>
            </Card>
          ))}
          {state.nextCursor ? (
            <LinkButton href={nextPageHref(state.statusFilter, state.nextCursor)} tone="secondary">
              {t("channels.connections.next")}
            </LinkButton>
          ) : null}
        </Stack>
      );
  }
}

export type ChannelConnectionAllowedAction = "pause" | "resume" | "disconnect";

export function allowedChannelConnectionActions(
  status: ChannelConnectionStatus,
): readonly ChannelConnectionAllowedAction[] {
  switch (status) {
    case "pending-setup":
      return ["disconnect"];
    case "active":
      return ["pause", "disconnect"];
    case "paused":
      return ["resume", "disconnect"];
    case "disconnected":
      return [];
  }
}

export type ChannelConnectionDetailPageState =
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "command-error"; message: string; connection: PublicChannelConnection }>
  | Readonly<{ kind: "ready"; connection: PublicChannelConnection }>;

export function ChannelConnectionDetailPage({
  state,
  pendingIntent = null,
}: {
  state: ChannelConnectionDetailPageState;
  pendingIntent?: ChannelConnectionAllowedAction | null;
}) {
  const connection = state.kind === "not-found" ? null : state.connection;
  return (
    <Page>
      <PageHeader
        eyebrow={t("channels.connections.eyebrow")}
        title={connection?.providerKey ?? t("channels.connections.connection.title")}
        description={t("channels.connections.connection.description")}
        actions={
          <Stack direction="row" gap={2}>
            {connection ? (
              <LinkButton
                href={`/account/channels/publication/${encodeURIComponent(connection.connectionId)}`}
                tone="ghost"
              >
                {t("channels.publication.manage")}
              </LinkButton>
            ) : null}
            <LinkButton href="/account/channels" tone="secondary">
              {t("channels.connections.back")}
            </LinkButton>
          </Stack>
        }
      />
      {state.kind === "not-found" ? (
        <MarketplaceNotice
          tone="info"
          title={t("channels.connections.missing.title")}
          description={t("channels.connections.missing.description")}
        />
      ) : null}
      {state.kind === "command-error" ? (
        <MarketplaceNotice tone="danger" title={t("channels.connections.error.title")} description={state.message} />
      ) : null}
      {connection ? <ConnectionDetailSections connection={connection} pendingIntent={pendingIntent} /> : null}
    </Page>
  );
}

const actionLabelKeys: Readonly<Record<ChannelConnectionAllowedAction, string>> = {
  pause: "channels.connections.actions.pause",
  resume: "channels.connections.actions.resume",
  disconnect: "channels.connections.actions.disconnect",
};

function ConnectionDetailSections({
  connection,
  pendingIntent,
}: {
  connection: PublicChannelConnection;
  pendingIntent: ChannelConnectionAllowedAction | null;
}) {
  const allowedActions = allowedChannelConnectionActions(connection.status);
  return (
    <PageSection title={t("channels.connections.status.title")}>
      <Card elevation="tinted" data-elevation-role="furniture">
        <Stack gap={3}>
          <Stack direction="row" gap={2}>
            <Badge tone={statusTones[connection.status]}>{t(statusLabelKeys[connection.status])}</Badge>
            <Badge tone="neutral">{connection.environment}</Badge>
          </Stack>
          {allowedActions.length === 0 ? (
            <Text tone="secondary">{t("channels.connections.actions.none")}</Text>
          ) : (
            <Stack direction="row" gap={2}>
              {allowedActions.map((action) => (
                <Form key={action} method="post" spacing="none">
                  <HiddenInput type="hidden" name="intent" value={action} />
                  <Button type="submit" tone={action === "disconnect" ? "danger" : "secondary"} disabled={pendingIntent !== null}>
                    {t(actionLabelKeys[action])}
                  </Button>
                </Form>
              ))}
              {pendingIntent !== null ? <Text tone="secondary">{t("channels.connections.actions.pending")}</Text> : null}
            </Stack>
          )}
        </Stack>
      </Card>
    </PageSection>
  );
}
