import { t } from "@chase-sets/localization";
import {
  Avatar,
  Badge,
  Banner,
  Box,
  Caption,
  Cluster,
  Container,
  Divider,
  FlexItem,
  Heading,
  Inline,
  LinkButton,
  LinkText,
  MediaFrame,
  Pagination,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
  Thumbnail,
  VisuallyHidden,
} from "@chase-sets/design-system";
import {
  formatSavedListAsOf,
  formatSavedListEstimatedValue,
  formatSavedListTrackedQuantity,
} from "../../../support/ui-support";
import type {
  SavedListPreview,
  SavedListPreviewContent,
  SavedListPreviewLine,
  SavedListPreviewUnavailableReason,
} from "./preview-contract";
import { buildSavedListPreviewMetadata } from "./preview-metadata";

export type SavedListPreviewPageProps = Readonly<{
  preview: SavedListPreview;
  saveCopyHref?: string;
  onPageChange?: (page: number) => void;
}>;

export function SavedListPreviewPage({ preview, saveCopyHref, onPageChange }: SavedListPreviewPageProps) {
  if (preview.status === "unavailable") {
    return <SavedListPreviewUnavailable reason={preview.reason} />;
  }

  return (
    <SavedListPreviewAvailable content={preview.content} saveCopyHref={saveCopyHref} onPageChange={onPageChange} />
  );
}

function SavedListPreviewAvailable({
  content,
  saveCopyHref,
  onPageChange,
}: Readonly<{
  content: SavedListPreviewContent;
  saveCopyHref?: string;
  onPageChange?: (page: number) => void;
}>) {
  const jsonLd = buildSavedListPreviewMetadata(content, { title: content.title }).jsonLd;
  const visibilityLabel =
    content.visibility === "public"
      ? t("collections.features.savedLists.web.preview.eyebrow.public")
      : t("collections.features.savedLists.web.preview.eyebrow.unlisted");

  return (
    <Container width="content">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Stack gap={6}>
        <Stack gap={3}>
          <Inline gap={2}>
            <Badge tone={content.visibility === "public" ? "info" : "neutral"} variant="soft">
              {visibilityLabel}
            </Badge>
          </Inline>
          <Heading level={1}>{content.title}</Heading>
          <SavedListPreviewOwnerReference content={content} />
          {content.description ? <Text tone="secondary">{content.description}</Text> : null}
        </Stack>

        {content.coverImageUrl ? (
          <Thumbnail
            src={content.coverImageUrl}
            alt={t("collections.features.savedLists.web.preview.coverAlt")}
            ratio={16 / 9}
          />
        ) : null}

        {content.valuation ? <SavedListPreviewValuationPanel content={content} /> : null}

        {content.canSaveCopy && saveCopyHref ? (
          <Surface tone="neutral" padding={4}>
            <Stack
              direction={{ base: "column", sm: "row" }}
              align={{ base: "stretch", sm: "center" }}
              justify="between"
              gap={3}
            >
              <Stack gap={1}>
                <Text weight="medium">{t("collections.features.savedLists.web.preview.saveCopy")}</Text>
                <Caption>{t("collections.features.savedLists.web.preview.saveCopy.description")}</Caption>
              </Stack>
              <LinkButton href={saveCopyHref} tone="primary">
                {t("collections.features.savedLists.web.preview.saveCopy")}
              </LinkButton>
            </Stack>
          </Surface>
        ) : null}

        <Divider />

        <SavedListPreviewItems content={content} onPageChange={onPageChange} />
      </Stack>
    </Container>
  );
}

function SavedListPreviewOwnerReference({ content }: Readonly<{ content: SavedListPreviewContent }>) {
  const { owner } = content;
  const label = t("collections.features.savedLists.web.preview.ownerPrefix");

  return (
    <Inline gap={2}>
      <Avatar name={owner.displayName} src={owner.avatarUrl ?? undefined} size="sm" />
      <Text tone="secondary" size="sm">
        {label}{" "}
        {owner.profileHref ? (
          <LinkText href={owner.profileHref}>{owner.displayName}</LinkText>
        ) : (
          <Text as="span" weight="medium">
            {owner.displayName}
          </Text>
        )}
      </Text>
    </Inline>
  );
}

function SavedListPreviewValuationPanel({ content }: Readonly<{ content: SavedListPreviewContent }>) {
  const valuation = content.valuation;
  if (!valuation) return null;

  const totalValue = valuation.totalEstimatedValue
    ? formatSavedListEstimatedValue(valuation.totalEstimatedValue)
    : t("collections.features.savedLists.web.preview.line.noEstimate");

  return (
    <StatGrid columns={{ base: 1, sm: 3 }}>
      <Stat label={t("collections.features.savedLists.web.preview.value.total")} value={totalValue} icon="wallet" />
      <Stat
        label={t("collections.features.savedLists.web.preview.value.coverageLabel")}
        value={t("collections.features.savedLists.web.preview.value.coverage", {
          valued: valuation.valuedLineCount,
          total: valuation.totalLineCount,
        })}
      />
      {valuation.asOf ? (
        <Stat
          label={t("collections.features.savedLists.web.preview.value.asOfLabel")}
          value={formatSavedListAsOf(valuation.asOf)}
        />
      ) : null}
    </StatGrid>
  );
}

function SavedListPreviewItems({
  content,
  onPageChange,
}: Readonly<{ content: SavedListPreviewContent; onPageChange?: (page: number) => void }>) {
  const itemCountLabel =
    content.lineCount === 1
      ? t("collections.features.savedLists.web.preview.itemCount.one")
      : t("collections.features.savedLists.web.preview.itemCount.other", { count: content.lineCount });

  return (
    <Stack gap={4}>
      <Stack direction="row" align="center" justify="between" gap={3}>
        <Heading level={2}>{t("collections.features.savedLists.web.preview.itemsHeading")}</Heading>
        <Caption>{itemCountLabel}</Caption>
      </Stack>

      {content.lineCount === 0 ? (
        <Banner
          tone="info"
          title={t("collections.features.savedLists.web.preview.empty.title")}
          description={t("collections.features.savedLists.web.preview.empty.description")}
        />
      ) : (
        <Stack as="ul" gap={3}>
          {content.lines.map((line) => (
            <SavedListPreviewLineRow key={line.lineId} line={line} disclosure={content.disclosure} />
          ))}
        </Stack>
      )}

      {content.pagination.totalPages > 1 ? (
        <Cluster justify="center">
          <Pagination
            page={content.pagination.page}
            totalPages={content.pagination.totalPages}
            onPageChange={onPageChange}
            previousLabel={t("collections.features.savedLists.web.preview.pagination.previous")}
            nextLabel={t("collections.features.savedLists.web.preview.pagination.next")}
          />
        </Cluster>
      ) : null}
    </Stack>
  );
}

function SavedListPreviewLineRow({
  line,
  disclosure,
}: Readonly<{ line: SavedListPreviewLine; disclosure: SavedListPreviewContent["disclosure"] }>) {
  const isRemoved = line.availability === "removed";
  const isRetired = line.availability === "retired";

  return (
    <Box as="li">
      <Surface padding={3} tone={isRemoved ? "muted" : "neutral"}>
        <Stack direction={{ base: "column", sm: "row" }} align={{ base: "stretch", sm: "center" }} gap={4}>
          <MediaFrame size="sm">
            <Thumbnail src={line.imageUrl ?? undefined} alt={line.productName} ratio={1} />
          </MediaFrame>

          <FlexItem grow>
            <Stack gap={2}>
              {line.productHref && !isRemoved ? (
                <LinkText href={line.productHref}>{line.productName}</LinkText>
              ) : (
                <Text weight="medium">{line.productName}</Text>
              )}

              {line.optionLabels.length > 0 ? (
                <Inline gap={2}>
                  <VisuallyHidden>{t("collections.features.savedLists.web.preview.optionsLabel")}</VisuallyHidden>
                  {line.optionLabels.map((option) => (
                    <Badge key={option} tone="neutral" variant="outline">
                      {option}
                    </Badge>
                  ))}
                </Inline>
              ) : null}

              {isRetired ? (
                <Inline gap={2}>
                  <Badge tone="warning" variant="soft">
                    {t("collections.features.savedLists.web.preview.line.retired")}
                  </Badge>
                </Inline>
              ) : null}
              {isRemoved ? (
                <Inline gap={2}>
                  <Badge tone="neutral" variant="soft">
                    {t("collections.features.savedLists.web.preview.line.removed")}
                  </Badge>
                </Inline>
              ) : null}
            </Stack>
          </FlexItem>

          {disclosure.showTrackedQuantities ? (
            <Box textAlign="right">
              <Caption>{t("collections.features.savedLists.web.preview.column.quantity")}</Caption>
              <Text weight="medium">
                {line.trackedQuantity === null ? "—" : formatSavedListTrackedQuantity(line.trackedQuantity)}
              </Text>
            </Box>
          ) : null}

          {disclosure.showEstimatedValue ? (
            <Box textAlign="right">
              <Caption>{t("collections.features.savedLists.web.preview.column.value")}</Caption>
              <Text weight="medium">
                {line.estimatedValue === null
                  ? t("collections.features.savedLists.web.preview.line.noEstimate")
                  : formatSavedListEstimatedValue(line.estimatedValue)}
              </Text>
            </Box>
          ) : null}
        </Stack>
      </Surface>
    </Box>
  );
}

function SavedListPreviewUnavailable({ reason }: Readonly<{ reason: SavedListPreviewUnavailableReason }>) {
  const copy = unavailableCopy(reason);

  return (
    <Container width="narrow">
      <Banner tone="warning" title={copy.title} description={copy.description} role="alert" />
    </Container>
  );
}

function unavailableCopy(reason: SavedListPreviewUnavailableReason): Readonly<{ title: string; description: string }> {
  switch (reason) {
    case "revoked":
      return {
        title: t("collections.features.savedLists.web.preview.unavailable.revoked.title"),
        description: t("collections.features.savedLists.web.preview.unavailable.revoked.description"),
      };
    case "archived":
      return {
        title: t("collections.features.savedLists.web.preview.unavailable.archived.title"),
        description: t("collections.features.savedLists.web.preview.unavailable.archived.description"),
      };
    case "not-found":
    default:
      return {
        title: t("collections.features.savedLists.web.preview.unavailable.notFound.title"),
        description: t("collections.features.savedLists.web.preview.unavailable.notFound.description"),
      };
  }
}
