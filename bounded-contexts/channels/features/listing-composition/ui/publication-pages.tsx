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
  TextInput,
  Textarea,
} from "@chase-sets/design-system";
import type { ChannelPublicationConnectionDetail, ChannelPublicationConnectionSummary } from "../domain/contracts";

export type ChannelPublicationListPageState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "authorization-forbidden" }>
  | Readonly<{ kind: "command-error"; message: string }>
  | Readonly<{ kind: "ready"; connections: readonly ChannelPublicationConnectionSummary[] }>;

export function ChannelPublicationListPage({ state }: { state: ChannelPublicationListPageState }) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("channels.publication.eyebrow")}
        title={t("channels.publication.title")}
        description={t("channels.publication.description")}
      />
      <PageSection title={t("channels.publication.connections")}>{renderListState(state)}</PageSection>
    </Page>
  );
}

function renderListState(state: ChannelPublicationListPageState) {
  switch (state.kind) {
    case "loading":
      return <Text>{t("channels.publication.loading")}</Text>;
    case "authorization-forbidden":
      return (
        <MarketplaceNotice
          tone="danger"
          title={t("channels.publication.forbidden.title")}
          description={t("channels.publication.forbidden.description")}
        />
      );
    case "command-error":
      return (
        <MarketplaceNotice tone="danger" title={t("channels.publication.error.title")} description={state.message} />
      );
    case "ready":
      if (state.connections.length === 0) {
        return (
          <MarketplaceNotice
            tone="info"
            title={t("channels.publication.empty.title")}
            description={t("channels.publication.empty.description")}
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
                  <Badge tone={connection.connectionStatus === "active" ? "success" : "warning"}>
                    {connection.connectionStatus}
                  </Badge>
                  <Badge tone={connection.settingsState === "configured" ? "success" : "warning"}>
                    {connection.settingsState}
                  </Badge>
                  <Badge tone={connection.reviewCount === 0 ? "neutral" : "info"}>
                    {t("channels.publication.review.count", { count: connection.reviewCount })}
                  </Badge>
                </Stack>
                <LinkButton
                  href={`/account/channels/publication/${encodeURIComponent(connection.connectionId)}`}
                  tone="secondary"
                >
                  {t("channels.publication.manage")}
                </LinkButton>
              </Stack>
            </Card>
          ))}
        </Stack>
      );
  }
}

export type ChannelPublicationDetailPageState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "authorization-forbidden" }>
  | Readonly<{ kind: "foreign-account" }>
  | Readonly<{ kind: "command-error"; message: string; detail: ChannelPublicationConnectionDetail | null }>
  | Readonly<{ kind: "stale-version-conflict"; detail: ChannelPublicationConnectionDetail }>
  | Readonly<{ kind: "ready"; detail: ChannelPublicationConnectionDetail }>;

export function ChannelPublicationDetailPage({ state }: { state: ChannelPublicationDetailPageState }) {
  const detail =
    state.kind === "ready" || state.kind === "stale-version-conflict"
      ? state.detail
      : state.kind === "command-error"
        ? state.detail
        : null;
  return (
    <Page>
      <PageHeader
        eyebrow={t("channels.publication.eyebrow")}
        title={detail?.connection.providerKey ?? t("channels.publication.connection.title")}
        description={t("channels.publication.connection.description")}
        actions={
          <LinkButton href="/account/channels/publication" tone="secondary">
            {t("channels.publication.back")}
          </LinkButton>
        }
      />
      {state.kind === "loading" ? <Text>{t("channels.publication.loading")}</Text> : null}
      {state.kind === "authorization-forbidden" ? (
        <MarketplaceNotice
          tone="danger"
          title={t("channels.publication.forbidden.title")}
          description={t("channels.publication.forbidden.description")}
        />
      ) : null}
      {state.kind === "foreign-account" ? (
        <MarketplaceNotice
          tone="info"
          title={t("channels.publication.missing.title")}
          description={t("channels.publication.missing.description")}
        />
      ) : null}
      {state.kind === "command-error" ? (
        <MarketplaceNotice tone="danger" title={t("channels.publication.error.title")} description={state.message} />
      ) : null}
      {state.kind === "stale-version-conflict" ? (
        <MarketplaceNotice
          tone="warning"
          title={t("channels.publication.conflict.title")}
          description={t("channels.publication.conflict.description")}
        />
      ) : null}
      {detail ? <DetailSections detail={detail} /> : null}
    </Page>
  );
}

function DetailSections({ detail }: { detail: ChannelPublicationConnectionDetail }) {
  const settings = detail.settings;
  const review = detail.mappingReview;
  return (
    <>
      <PageSection title={t("channels.publication.settings.title")}>
        {!settings ? (
          <MarketplaceNotice
            tone="warning"
            title={t("channels.publication.settings.missing.title")}
            description={t("channels.publication.settings.missing.description")}
          />
        ) : null}
        <Card elevation="tinted" data-elevation-role="furniture">
          <Form key={`settings-${detail.configurationStreamVersion}`} method="post" spacing="none">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="replace-settings" />
              <HiddenInput
                type="hidden"
                name="expectedStreamVersion"
                value={String(detail.configurationStreamVersion)}
              />
              <TextInput
                label={t("channels.publication.settings.title.prefix")}
                name="titlePrefix"
                defaultValue={settings?.titlePrefix ?? ""}
              />
              <TextInput
                label={t("channels.publication.settings.title.suffix")}
                name="titleSuffix"
                defaultValue={settings?.titleSuffix ?? ""}
              />
              <Textarea
                label={t("channels.publication.settings.description.footer")}
                name="descriptionFooter"
                defaultValue={settings?.descriptionFooter ?? ""}
                rows={3}
              />
              <Textarea
                label={t("channels.publication.settings.category.allowlist")}
                name="categoryAllowlist"
                defaultValue={settings?.categoryAllowlist.join("\n") ?? ""}
                rows={4}
              />
              <Textarea
                label={t("channels.publication.settings.excluded.listings")}
                name="excludedListingIds"
                defaultValue={settings?.excludedListingIds.join("\n") ?? ""}
                rows={4}
              />
              <Button type="submit">{t("channels.publication.settings.save")}</Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>
      <PageSection title={t("channels.publication.mapping.title")}>
        {review.completeness.kind === "incomplete" ? (
          <MarketplaceNotice
            tone="warning"
            title={t("channels.publication.mapping.incomplete.title")}
            description={review.completeness.reason}
          />
        ) : null}
        {review.items.length === 0 ? (
          <MarketplaceNotice
            tone="info"
            title={t("channels.publication.mapping.empty.title")}
            description={t("channels.publication.mapping.empty.description")}
          />
        ) : (
          <Stack gap={3}>
            {review.items.map((item) => (
              <Card key={`${item.dimension}:${item.sourceKey}`} elevation="elevated" data-elevation-role="entity">
                <Stack gap={2}>
                  <Text weight="semibold">{item.sourceKey}</Text>
                  <Text tone="secondary">
                    {item.dimension} · {item.reviewStatus} · {item.confidenceTier}
                  </Text>
                  <Form
                    key={`mapping-${item.dimension}-${item.sourceKey}-${detail.configurationStreamVersion}`}
                    method="post"
                    spacing="none"
                  >
                    <HiddenInput type="hidden" name="intent" value="decide-mapping" />
                    <HiddenInput type="hidden" name="dimension" value={item.dimension} />
                    <HiddenInput type="hidden" name="sourceKey" value={item.sourceKey} />
                    <HiddenInput
                      type="hidden"
                      name="expectedStreamVersion"
                      value={String(detail.configurationStreamVersion)}
                    />
                    <Stack direction="row" gap={2}>
                      <TextInput
                        label={t("channels.publication.mapping.target")}
                        name="targetKey"
                        defaultValue={item.targetKey ?? ""}
                      />
                      <Button type="submit" name="decision" value="accept">
                        {t("channels.publication.mapping.accept")}
                      </Button>
                      <Button type="submit" name="decision" value="reject" tone="danger">
                        {t("channels.publication.mapping.reject")}
                      </Button>
                      {item.reviewStatus === "revoked" ? null : (
                        <Button type="submit" name="decision" value="revoke" tone="secondary">
                          {t("channels.publication.mapping.revoke")}
                        </Button>
                      )}
                    </Stack>
                  </Form>
                </Stack>
              </Card>
            ))}
            {review.nextCursor ? (
              <LinkButton href={`?cursor=${encodeURIComponent(review.nextCursor)}`} tone="secondary">
                {t("channels.publication.mapping.next")}
              </LinkButton>
            ) : null}
          </Stack>
        )}
      </PageSection>
    </>
  );
}
