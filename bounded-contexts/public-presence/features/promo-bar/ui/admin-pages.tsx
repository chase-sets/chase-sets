import { t } from "@chase-sets/localization";
import { useRef, useState } from "react";
import {
  HiddenInput,
  Form,
  AlertDialog,
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  Grid,
  Inline,
  NativeSelect,
  NumberField,
  Page,
  PageHeader,
  PageSection,
  PromoBar,
  SideSheet,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@chase-sets/design-system";
import type { PromoBarMessage } from "../api/contracts";
import { isPromoBarMessageLiveAt, promoBarMessageStatusAt, type PromoBarMessageStatus } from "../domain/status";

const toneItems = [
  { value: "info", label: t("publicPresence.promoBar.tone.info") },
  { value: "success", label: t("publicPresence.promoBar.tone.success") },
  { value: "warning", label: t("publicPresence.promoBar.tone.warning") },
];

function dateTimeValue(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

function messageStatusLabel(status: PromoBarMessageStatus) {
  return t(`publicPresence.promoBar.status.${status}`);
}

function messageStatusTone(status: PromoBarMessageStatus) {
  if (status === "active") {
    return "success";
  }

  if (status === "scheduled") {
    return "info";
  }

  if (status === "expired") {
    return "warning";
  }

  return "neutral";
}

function resolveAdminPreviewHref(href: string | null, marketplaceOrigin: string | null) {
  if (!href || !href.startsWith("/")) {
    return href;
  }

  if (!marketplaceOrigin) {
    return null;
  }

  return new URL(href, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
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
      <NumberField
        label={t("publicPresence.promoBar.field.displayOrder")}
        name="displayOrder"
        defaultValue={message?.display_order ?? 100}
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

function PromoBarRowActions({
  message,
  onEdit,
}: {
  message: PromoBarMessage;
  onEdit: (message: PromoBarMessage) => void;
}) {
  const deleteFormRef = useRef<HTMLFormElement>(null);

  return (
    <Inline gap={2}>
      <Form spacing="none" method="post">
        <HiddenInput type="hidden" name="id" value={message.id} />
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
      </Form>
      <Button type="button" size="sm" tone="secondary" leadingIcon="edit" onClick={() => onEdit(message)}>
        {t("publicPresence.promoBar.edit.action")}
      </Button>
      <Form ref={deleteFormRef} spacing="none" method="post">
        <HiddenInput type="hidden" name="intent" value="delete" />
        <HiddenInput type="hidden" name="id" value={message.id} />
      </Form>
      <AlertDialog
        title={t("publicPresence.promoBar.delete.confirm.title")}
        description={t("publicPresence.promoBar.delete.confirm.description", { title: message.title })}
        confirmLabel={t("publicPresence.promoBar.delete.action")}
        cancelLabel={t("publicPresence.promoBar.cancel.action")}
        tone="danger"
        onConfirm={() => deleteFormRef.current?.requestSubmit()}
        trigger={
          <Button type="button" size="sm" tone="danger" leadingIcon="trash">
            {t("publicPresence.promoBar.delete.action")}
          </Button>
        }
      />
    </Inline>
  );
}

export function PromoBarAdminPage({
  messages,
  actionMessage,
  errorMessage,
  marketplaceOrigin,
  currentTime = new Date().toISOString(),
}: {
  messages: readonly PromoBarMessage[];
  actionMessage?: string | null;
  errorMessage?: string | null;
  marketplaceOrigin?: string | null;
  currentTime?: string;
}) {
  const activeMessages = messages.filter((message) => isPromoBarMessageLiveAt(message, currentTime));
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingMessage = messages.find((message) => message.id === editingId) ?? null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("publicPresence.promoBar.admin.eyebrow")}
        title={t("publicPresence.promoBar.admin.title")}
        description={t("publicPresence.promoBar.admin.description")}
      />
      {errorMessage ? (
        <Banner tone="danger" title={t("publicPresence.promoBar.action.failed")} description={errorMessage} />
      ) : actionMessage ? (
        <Banner tone="success" title={actionMessage} />
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
            href: resolveAdminPreviewHref(message.href, marketplaceOrigin ?? null),
            linkLabel: message.link_label,
            tone: message.tone,
          }))}
        />
      </PageSection>
      <PageSection title={t("publicPresence.promoBar.create.title")}>
        <Form spacing="none" method="post">
          <Stack gap={3}>
            <HiddenInput type="hidden" name="intent" value="create" />
            <PromoBarMessageFields />
            <Inline>
              <Button type="submit" leadingIcon="plus">
                {t("publicPresence.promoBar.create.action")}
              </Button>
            </Inline>
          </Stack>
        </Form>
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
              cell: (message) => {
                const status = promoBarMessageStatusAt(message, currentTime);
                return <Badge tone={messageStatusTone(status)}>{messageStatusLabel(status)}</Badge>;
              },
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
              key: "actions",
              header: t("publicPresence.promoBar.column.actions"),
              cell: (message) => <PromoBarRowActions message={message} onEdit={(edited) => setEditingId(edited.id)} />,
            },
          ]}
        />
      </PageSection>
      <SideSheet
        open={editingMessage !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingId(null);
          }
        }}
        title={t("publicPresence.promoBar.edit.title")}
        description={editingMessage?.title}
        width="lg"
      >
        {editingMessage ? (
          <Form spacing="none" method="post">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="update" />
              <HiddenInput type="hidden" name="id" value={editingMessage.id} />
              <PromoBarMessageFields message={editingMessage} />
              <Inline>
                <Button type="submit" leadingIcon="check">
                  {t("publicPresence.promoBar.update.action")}
                </Button>
              </Inline>
            </Stack>
          </Form>
        ) : null}
      </SideSheet>
    </Page>
  );
}
