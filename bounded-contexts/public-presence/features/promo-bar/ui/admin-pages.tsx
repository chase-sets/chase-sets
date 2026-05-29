import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Grid,
  Inline,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  PromoBar,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@chase-sets/design-system";
import type { PromoBarMessage } from "../api/contracts";

const toneItems = [
  { value: "info", label: t("publicPresence.promoBar.tone.info") },
  { value: "success", label: t("publicPresence.promoBar.tone.success") },
  { value: "warning", label: t("publicPresence.promoBar.tone.warning") },
];

function dateTimeValue(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

function messageStatus(message: PromoBarMessage) {
  if (!message.is_active) {
    return t("publicPresence.promoBar.status.inactive");
  }

  const now = Date.now();
  if (message.starts_at && new Date(message.starts_at).getTime() > now) {
    return t("publicPresence.promoBar.status.scheduled");
  }

  if (message.ends_at && new Date(message.ends_at).getTime() <= now) {
    return t("publicPresence.promoBar.status.expired");
  }

  return t("publicPresence.promoBar.status.active");
}

function PromoBarMessageFields({ message }: { message?: PromoBarMessage }) {
  return (
    <Grid columns={{ base: 1, md: 2, xl: 4 }} gap={3}>
      <TextInput
        label={t("publicPresence.promoBar.field.title")}
        name="title"
        defaultValue={message?.title ?? ""}
        required
      />
      <TextInput
        label={t("publicPresence.promoBar.field.href")}
        name="href"
        defaultValue={message?.href ?? ""}
        placeholder="/sales-fees"
      />
      <TextInput
        label={t("publicPresence.promoBar.field.linkLabel")}
        name="linkLabel"
        defaultValue={message?.link_label ?? ""}
      />
      <NativeSelect
        label={t("publicPresence.promoBar.field.tone")}
        name="tone"
        defaultValue={message?.tone ?? "info"}
        items={toneItems}
      />
      <Textarea
        label={t("publicPresence.promoBar.field.description")}
        name="description"
        defaultValue={message?.description ?? ""}
      />
      <TextInput
        label={t("publicPresence.promoBar.field.displayOrder")}
        name="displayOrder"
        type="number"
        defaultValue={String(message?.display_order ?? 100)}
      />
      <TextInput
        label={t("publicPresence.promoBar.field.startsAt")}
        name="startsAt"
        type="datetime-local"
        defaultValue={dateTimeValue(message?.starts_at ?? null)}
      />
      <TextInput
        label={t("publicPresence.promoBar.field.endsAt")}
        name="endsAt"
        type="datetime-local"
        defaultValue={dateTimeValue(message?.ends_at ?? null)}
      />
      <Checkbox
        label={t("publicPresence.promoBar.field.active")}
        name="isActive"
        value="true"
        defaultChecked={message?.is_active ?? true}
      />
    </Grid>
  );
}

export function PromoBarAdminPage({
  messages,
  actionMessage,
}: {
  messages: readonly PromoBarMessage[];
  actionMessage?: string | null;
}) {
  const activeMessages = messages.filter(
    (message) => messageStatus(message) === t("publicPresence.promoBar.status.active"),
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("publicPresence.promoBar.admin.eyebrow")}
        title={t("publicPresence.promoBar.admin.title")}
        description={t("publicPresence.promoBar.admin.description")}
      />
      {actionMessage ? (
        <Text size="sm" tone="secondary">
          {actionMessage}
        </Text>
      ) : null}
      <PageSection
        title={t("publicPresence.promoBar.preview.title")}
        description={t("publicPresence.promoBar.preview.description")}
      >
        <PromoBar
          messages={activeMessages.map((message) => ({
            id: message.id,
            title: message.title,
            description: message.description,
            href: message.href,
            linkLabel: message.link_label,
            tone: message.tone,
          }))}
        />
      </PageSection>
      <PageSection title={t("publicPresence.promoBar.create.title")}>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="create" />
            <PromoBarMessageFields />
            <Inline>
              <Button type="submit" leadingIcon="plus">
                {t("publicPresence.promoBar.create.action")}
              </Button>
            </Inline>
          </Stack>
        </form>
      </PageSection>
      <PageSection title={t("publicPresence.promoBar.messages.title")}>
        <DataTable<PromoBarMessage>
          rows={[...messages]}
          getRowId={(message) => message.id}
          emptyTitle={t("publicPresence.promoBar.empty.title")}
          emptyDescription={t("publicPresence.promoBar.empty.description")}
          columns={[
            {
              key: "status",
              header: t("publicPresence.promoBar.column.status"),
              cell: (message) => (
                <Badge tone={message.is_active ? "success" : "neutral"}>{messageStatus(message)}</Badge>
              ),
            },
            {
              key: "title",
              header: t("publicPresence.promoBar.column.message"),
              cell: (message) => (
                <Stack gap={1}>
                  <Text weight="semibold">{message.title}</Text>
                  {message.description ? (
                    <Text size="sm" tone="secondary">
                      {message.description}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "order",
              header: t("publicPresence.promoBar.column.order"),
              cell: (message) => message.display_order,
            },
            {
              key: "edit",
              header: t("publicPresence.promoBar.column.edit"),
              cell: (message) => (
                <form method="post">
                  <Stack gap={3}>
                    <input type="hidden" name="id" value={message.id} />
                    <PromoBarMessageFields message={message} />
                    <Inline gap={2}>
                      <Button type="submit" name="intent" value="update" size="sm" leadingIcon="check">
                        {t("publicPresence.promoBar.update.action")}
                      </Button>
                      <Button
                        type="submit"
                        name="intent"
                        value={message.is_active ? "deactivate" : "activate"}
                        size="sm"
                        tone="secondary"
                        leadingIcon={message.is_active ? "pause" : "play"}
                      >
                        {message.is_active
                          ? t("publicPresence.promoBar.deactivate.action")
                          : t("publicPresence.promoBar.activate.action")}
                      </Button>
                      <Button type="submit" name="intent" value="delete" size="sm" tone="danger" leadingIcon="trash">
                        {t("publicPresence.promoBar.delete.action")}
                      </Button>
                    </Inline>
                  </Stack>
                </form>
              ),
            },
          ]}
        />
      </PageSection>
    </Page>
  );
}
