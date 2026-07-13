import { useState } from "react";
import { formatDateTime, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  ActionBar,
  DataTable,
  DetailPanel,
  Grid,
  Inset,
  Inline,
  KeyValueList,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  FilterBar,
  Rating,
  Stack,
  StatGrid,
  Stat,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type { PlatformFeedbackDetail, PlatformFeedbackListItem, PlatformFeedbackMetrics } from "../api/contracts";

type ListResponse<T> = Readonly<{
  items: readonly T[];
  total: number;
  count: number;
}>;

const statusItems = [
  { value: "all", label: t("experience.platformFeedbackAdmin.allStatuses") },
  { value: "new", label: t("experience.platformFeedbackAdmin.status.new") },
  { value: "reviewed", label: t("experience.platformFeedbackAdmin.status.reviewed") },
  { value: "archived", label: t("experience.platformFeedbackAdmin.status.archived") },
];

const topicItems = [
  { value: "all", label: t("experience.platformFeedbackAdmin.allTopics") },
  { value: "ease-of-use", label: t("experience.platformFeedback.topic.easeOfUse") },
  { value: "pricing-fees", label: t("experience.platformFeedback.topic.pricingFees") },
  { value: "product-data-search", label: t("experience.platformFeedback.topic.productDataSearch") },
  { value: "checkout-payment", label: t("experience.platformFeedback.topic.checkoutPayment") },
  { value: "selling-inventory", label: t("experience.platformFeedback.topic.sellingInventory") },
  { value: "performance-reliability", label: t("experience.platformFeedback.topic.performanceReliability") },
  { value: "other", label: t("experience.platformFeedback.topic.other") },
];

const workflowItems = [
  { value: "all", label: t("experience.platformFeedbackAdmin.allWorkflows") },
  { value: "checkout-payment", label: t("experience.platformFeedback.workflow.checkoutPayment") },
  { value: "listing-publish", label: t("experience.platformFeedback.workflow.listingPublish") },
  { value: "listing-update", label: t("experience.platformFeedback.workflow.listingUpdate") },
  { value: "offer-submit", label: t("experience.platformFeedback.workflow.offerSubmit") },
  { value: "offer-accept", label: t("experience.platformFeedback.workflow.offerAccept") },
  { value: "inventory-create", label: t("experience.platformFeedback.workflow.inventoryCreate") },
  { value: "inventory-adjust", label: t("experience.platformFeedback.workflow.inventoryAdjust") },
];

function topicLabel(value: string) {
  return topicItems.find((item) => item.value === value)?.label ?? value;
}

function workflowLabel(value: string) {
  return workflowItems.find((item) => item.value === value)?.label ?? value;
}

function statusTone(status: string) {
  switch (status) {
    case "new":
      return "accent" as const;
    case "reviewed":
      return "success" as const;
    case "archived":
      return "neutral" as const;
    default:
      return "neutral" as const;
  }
}

function statusLabel(status: string) {
  return statusItems.find((item) => item.value === status)?.label ?? status;
}

function accountRelativeRelatedEntityHref(entity: Readonly<{ type: string; id: string }>) {
  switch (entity.type) {
    case "payment":
      return `/account/payments/${entity.id}`;
    case "listing":
      return `/account/listings/${entity.id}`;
    case "offer":
      return `/account/offers/submitted/${entity.id}`;
    case "inventory-item":
      return `/account/inventory/items/${entity.id}`;
    default:
      return null;
  }
}

function resolveMarketplaceHref(pathname: string | null, marketplaceOrigin: string | null | undefined) {
  if (!pathname) {
    return null;
  }

  if (!marketplaceOrigin) {
    return null;
  }

  return new URL(pathname, `${marketplaceOrigin.replace(/\/+$/, "")}/`).toString();
}

function formatFeedbackDateTime(value: string | null) {
  return value ? formatDateTime(value) : t("experience.platformFeedbackAdmin.notSet");
}

function entityLabel(entity: Readonly<{ type: string; id: string }>) {
  return t("experience.platformFeedbackAdmin.relatedEntityLabel", {
    type: entity.type,
    id: entity.id,
  });
}

export function PlatformFeedbackAdminListPage({
  feedback,
  metrics,
  filters,
  exportHref,
  // Nav/action controls reflect capability state; server-side authz on
  // the platform API remains the authoritative gate. Default to true so
  // isolated component tests render the full surface.
  canExport = true,
  canManage = true,
}: {
  feedback: ListResponse<PlatformFeedbackListItem>;
  metrics: PlatformFeedbackMetrics;
  filters: Readonly<{ status: string; topic: string; workflow: string }>;
  exportHref: string;
  canExport?: boolean;
  canManage?: boolean;
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const selectedFeedbackIds = [...selectedKeys];

  return (
    <Page>
      <PageHeader
        eyebrow={t("experience.platformFeedbackAdmin.eyebrow")}
        title={t("experience.platformFeedbackAdmin.title")}
        description={t("experience.platformFeedbackAdmin.description")}
      />
      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label={t("experience.platformFeedbackAdmin.total")} value={metrics.total_count} />
        <Stat label={t("experience.platformFeedbackAdmin.new")} value={metrics.new_count} />
        <Stat label={t("experience.platformFeedbackAdmin.reviewed")} value={metrics.reviewed_count} />
        <Stat
          label={t("experience.platformFeedbackAdmin.averageRating")}
          value={metrics.average_rating ?? t("experience.platformFeedbackAdmin.notSet")}
        />
      </StatGrid>

      <PageSection title={t("experience.platformFeedbackAdmin.filters")}>
        <Form spacing="none" method="get">
          <Stack gap={3}>
            <FilterBar sticky={false}>
              <NativeSelect
                label={t("experience.platformFeedbackAdmin.status")}
                name="status"
                defaultValue={filters.status}
                items={statusItems}
              />
              <NativeSelect
                label={t("experience.platformFeedbackAdmin.topic")}
                name="topic"
                defaultValue={filters.topic}
                items={topicItems}
              />
              <NativeSelect
                label={t("experience.platformFeedbackAdmin.workflow")}
                name="workflow"
                defaultValue={filters.workflow}
                items={workflowItems}
              />
            </FilterBar>
            <ActionBar>
              <Button type="submit" leadingIcon="filter">
                {t("experience.platformFeedbackAdmin.applyFilters")}
              </Button>
              {canExport ? (
                <LinkButton href={exportHref} tone="secondary" leadingIcon="externalLink">
                  {t("experience.platformFeedbackAdmin.export")}
                </LinkButton>
              ) : null}
            </ActionBar>
          </Stack>
        </Form>
      </PageSection>

      <PageSection title={t("experience.platformFeedbackAdmin.reviewQueue")}>
        <Stack gap={3}>
          {canManage ? (
            <ActionBar>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="bulk-review" readOnly />
                {selectedFeedbackIds.map((feedbackId) => (
                  <HiddenInput key={feedbackId} type="hidden" name="feedbackIds" value={feedbackId} readOnly />
                ))}
                <Button type="submit" leadingIcon="check" disabled={selectedFeedbackIds.length === 0}>
                  {t("experience.platformFeedbackAdmin.bulkReview")}
                </Button>
              </Form>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="bulk-archive" readOnly />
                {selectedFeedbackIds.map((feedbackId) => (
                  <HiddenInput key={feedbackId} type="hidden" name="feedbackIds" value={feedbackId} readOnly />
                ))}
                <Button
                  type="submit"
                  tone="secondary"
                  leadingIcon="package"
                  disabled={selectedFeedbackIds.length === 0}
                >
                  {t("experience.platformFeedbackAdmin.bulkArchive")}
                </Button>
              </Form>
            </ActionBar>
          ) : null}
          <DataTable<PlatformFeedbackListItem>
            columns={[
              {
                key: "submitted_at",
                header: t("experience.platformFeedbackAdmin.submitted"),
                cell: (item) => formatFeedbackDateTime(item.submitted_at),
              },
              {
                key: "rating",
                header: t("experience.platformFeedbackAdmin.rating"),
                cell: (item) => <Rating value={item.rating} size="sm" />,
              },
              {
                key: "topic",
                header: t("experience.platformFeedbackAdmin.topic"),
                cell: (item) => topicLabel(item.topic),
              },
              {
                key: "workflow",
                header: t("experience.platformFeedbackAdmin.workflow"),
                cell: (item) => workflowLabel(item.workflow),
              },
              {
                key: "status",
                header: t("experience.platformFeedbackAdmin.status"),
                cell: (item) => <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>,
              },
              {
                key: "action",
                header: t("experience.platformFeedbackAdmin.action"),
                cell: (item) => (
                  <LinkButton href={`/support/platform-feedback/${item.feedback_id}`} size="sm">
                    {t("experience.platformFeedbackAdmin.open")}
                  </LinkButton>
                ),
              },
            ]}
            rows={[...feedback.items]}
            getRowId={(item) => item.feedback_id}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            emptyTitle={t("experience.platformFeedbackAdmin.emptyTitle")}
            emptyDescription={t("experience.platformFeedbackAdmin.emptyDescription")}
          />
        </Stack>
        <Text tone="secondary" size="sm">
          {t("experience.platformFeedbackAdmin.countSummary", {
            count: feedback.count,
            total: feedback.total,
          })}
        </Text>
      </PageSection>
    </Page>
  );
}

export function PlatformFeedbackAdminDetailPage({
  feedback,
  marketplaceOrigin,
  // Reflects platform-feedback.manage; server-side authz stays
  // authoritative. Defaults true for isolated component tests.
  canManage = true,
}: {
  feedback: PlatformFeedbackDetail;
  marketplaceOrigin?: string | null;
  canManage?: boolean;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("experience.platformFeedbackAdmin.eyebrow")}
        title={t("experience.platformFeedbackAdmin.detailTitle", {
          feedbackId: feedback.feedback_id,
        })}
        description={t("experience.platformFeedbackAdmin.detailDescription")}
      />
      <ActionBar>
        <LinkButton href="/support/platform-feedback" tone="secondary">
          {t("experience.platformFeedbackAdmin.back")}
        </LinkButton>
        {canManage && feedback.status === "new" ? (
          <Form spacing="none" method="post">
            <HiddenInput type="hidden" name="intent" value="review" readOnly />
            <Button type="submit" leadingIcon="check">
              {t("experience.platformFeedbackAdmin.markReviewed")}
            </Button>
          </Form>
        ) : null}
        {canManage && feedback.status !== "archived" ? (
          <Form spacing="none" method="post">
            <HiddenInput type="hidden" name="intent" value="archive" readOnly />
            <Button type="submit" tone="secondary" leadingIcon="package">
              {t("experience.platformFeedbackAdmin.archive")}
            </Button>
          </Form>
        ) : null}
      </ActionBar>
      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        <DetailPanel title={t("experience.platformFeedbackAdmin.feedback")}>
          <Stack gap={3}>
            <Inline gap={2}>
              <Badge tone={statusTone(feedback.status)}>{statusLabel(feedback.status)}</Badge>
              <Rating value={feedback.rating} />
            </Inline>
            <KeyValueList
              items={[
                { key: t("experience.platformFeedbackAdmin.topic"), value: topicLabel(feedback.topic) },
                { key: t("experience.platformFeedbackAdmin.workflow"), value: workflowLabel(feedback.workflow) },
                {
                  key: t("experience.platformFeedbackAdmin.followUp"),
                  value: feedback.follow_up_consent
                    ? t("experience.platformFeedbackAdmin.yes")
                    : t("experience.platformFeedbackAdmin.no"),
                },
                { key: t("experience.platformFeedbackAdmin.sourceRoute"), value: feedback.source_route_path },
                {
                  key: t("experience.platformFeedbackAdmin.submitted"),
                  value: formatFeedbackDateTime(feedback.submitted_at),
                },
              ]}
            />
            <Inset>
              <Text>{feedback.comment ?? t("experience.platformFeedbackAdmin.noComment")}</Text>
            </Inset>
          </Stack>
        </DetailPanel>
        <Stack gap={4}>
          <DetailPanel title={t("experience.platformFeedbackAdmin.operatorNotes")}>
            <Stack gap={3}>
              {canManage ? (
                <Form spacing="md" method="post">
                  <HiddenInput type="hidden" name="intent" value="record-note" readOnly />
                  <Textarea name="body" label={t("experience.platformFeedbackAdmin.operatorNote")} required rows={4} />
                  <Button type="submit" leadingIcon="message">
                    {t("experience.platformFeedbackAdmin.recordNote")}
                  </Button>
                </Form>
              ) : null}
              {feedback.operator_notes.length === 0 ? (
                <Text tone="secondary">{t("experience.platformFeedbackAdmin.noOperatorNotes")}</Text>
              ) : (
                <Stack gap={2}>
                  {feedback.operator_notes.map((note) => (
                    <Inset key={note.noteId}>
                      <Stack gap={2}>
                        <Text>{note.body}</Text>
                        <Text size="sm" tone="secondary">
                          {t("experience.platformFeedbackAdmin.operatorNoteAttribution", {
                            user: note.recordedByUserId,
                            timestamp: formatFeedbackDateTime(note.recordedAt),
                          })}
                        </Text>
                      </Stack>
                    </Inset>
                  ))}
                </Stack>
              )}
            </Stack>
          </DetailPanel>
          <DetailPanel title={t("experience.platformFeedbackAdmin.attribution")}>
            <KeyValueList
              items={[
                { key: t("experience.platformFeedbackAdmin.user"), value: feedback.user_id },
                { key: t("experience.platformFeedbackAdmin.account"), value: feedback.account_id },
                {
                  key: t("experience.platformFeedbackAdmin.updated"),
                  value: formatFeedbackDateTime(feedback.updated_at),
                },
                {
                  key: t("experience.platformFeedbackAdmin.reviewedBy"),
                  value: feedback.reviewed_by_user_id ?? t("experience.platformFeedbackAdmin.notSet"),
                },
                {
                  key: t("experience.platformFeedbackAdmin.archivedBy"),
                  value: feedback.archived_by_user_id ?? t("experience.platformFeedbackAdmin.notSet"),
                },
              ]}
            />
          </DetailPanel>
          <DetailPanel title={t("experience.platformFeedbackAdmin.relatedEntities")}>
            <Stack gap={2}>
              {feedback.related_entities.length === 0 ? (
                <Text tone="secondary">{t("experience.platformFeedbackAdmin.noRelatedEntities")}</Text>
              ) : (
                feedback.related_entities.map((entity) => {
                  const href = resolveMarketplaceHref(accountRelativeRelatedEntityHref(entity), marketplaceOrigin);
                  return href ? (
                    <LinkButton
                      key={`${entity.type}:${entity.id}`}
                      href={href}
                      tone="secondary"
                      target={marketplaceOrigin ? "_blank" : undefined}
                      rel={marketplaceOrigin ? "noreferrer" : undefined}
                      trailingIcon={marketplaceOrigin ? "externalLink" : undefined}
                    >
                      {entityLabel(entity)}
                    </LinkButton>
                  ) : (
                    <Text key={`${entity.type}:${entity.id}`}>{entityLabel(entity)}</Text>
                  );
                })
              )}
            </Stack>
          </DetailPanel>
        </Stack>
      </Grid>
    </Page>
  );
}
