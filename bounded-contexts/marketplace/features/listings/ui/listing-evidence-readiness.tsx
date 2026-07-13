import { t } from "@chase-sets/localization";
import { useEffect } from "react";
import {
  Badge,
  Button,
  Card,
  FileDropzone,
  Form,
  Grid,
  HiddenInput,
  ImageGallery,
  Inline,
  MarketplaceNotice,
  NativeSelect,
  Stack,
  Text,
  TextInput,
  WorkflowReadinessChecklist,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingDetail,
  MarketplaceListingEvidenceReadiness,
  MarketplaceListingPublicGalleryImage,
} from "./contracts";
import { evidenceCoverageCodeLocaleKey } from "../domain/evidence-coverage";
import { trackListingEvidenceEvent } from "./listing-evidence-analytics";

function galleryImage(image: MarketplaceListingPublicGalleryImage, fallbackAlt: string) {
  const primary =
    image.assets.find((asset) => asset.role === "catalog-detail" && asset.density === 1) ?? image.assets[0];
  if (!primary) return null;
  const srcSet = image.assets
    .filter((asset) => asset.role === primary.role)
    .map((asset) => `${asset.publicUrl} ${asset.width}w`)
    .join(", ");
  return {
    src: primary.publicUrl,
    srcSet: srcSet || undefined,
    sizes: "(min-width: 768px) 480px, min(100vw, 276px)",
    width: primary.width,
    height: primary.height,
    alt: image.altText ?? fallbackAlt,
  };
}

function reordered(ids: readonly string[], index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function EvidenceReadinessChecklist({
  readiness,
  surface = "listing-detail",
}: {
  readiness: MarketplaceListingEvidenceReadiness;
  surface?: "listing-create" | "listing-detail";
}) {
  useEffect(() => {
    trackListingEvidenceEvent("requirement_shown", {
      surface,
      complete: readiness.ready,
      unmetCount: readiness.nextActions.length,
      slotCount: readiness.coverage.slots.length,
    });
  }, [readiness.coverage.slots.length, readiness.nextActions.length, readiness.ready, surface]);

  const slotById = new Map(readiness.requirements.requiredSlots.map((slot) => [slot.slotId, slot]));
  const items = [
    {
      key: "minimum-photo-count",
      label: t("marketplace.features.listings.ui.evidence.minimum.photo.count", {
        count: readiness.coverage.minimumPhotoCount,
      }),
      status: readiness.coverage.activePhotoCount >= readiness.coverage.minimumPhotoCount ? "passed" : "blocked",
      statusLabel:
        readiness.coverage.activePhotoCount >= readiness.coverage.minimumPhotoCount
          ? t("marketplace.features.listings.ui.evidence.complete")
          : t("marketplace.features.listings.ui.evidence.action.required"),
      description: t("marketplace.features.listings.ui.evidence.photo.count.progress", {
        present: readiness.coverage.activePhotoCount,
        required: readiness.coverage.minimumPhotoCount,
      }),
      action:
        readiness.coverage.activePhotoCount < readiness.coverage.minimumPhotoCount ? (
          <Text size="sm">
            {t(
              (readiness.nextActions.find((action) => action.code === "min-photo-count-unmet")?.localeKey ??
                evidenceCoverageCodeLocaleKey("min-photo-count-unmet")) as Parameters<typeof t>[0],
            )}
          </Text>
        ) : null,
    } as const,
    ...readiness.coverage.slots.map((slot) => ({
      key: slot.slotId,
      label: t("marketplace.features.listings.ui.evidence.required.view", { view: slot.viewKind }),
      status: slot.satisfied ? ("passed" as const) : ("blocked" as const),
      statusLabel: slot.satisfied
        ? t("marketplace.features.listings.ui.evidence.complete")
        : t("marketplace.features.listings.ui.evidence.action.required"),
      description: slot.unmetCode
        ? t(
            (readiness.nextActions.find((action) => action.code === slot.unmetCode)?.localeKey ??
              evidenceCoverageCodeLocaleKey(slot.unmetCode)) as Parameters<typeof t>[0],
          )
        : t("marketplace.features.listings.ui.evidence.view.ready"),
      meta: slotById.get(slot.slotId) ? (
        <Inline gap={1}>
          <Badge>{slot.slotId}</Badge>
          {slotById.get(slot.slotId)!.minimumWidthPixels && slotById.get(slot.slotId)!.minimumHeightPixels ? (
            <Badge>
              {t("marketplace.features.listings.ui.evidence.minimum.dimensions", {
                width: slotById.get(slot.slotId)!.minimumWidthPixels!,
                height: slotById.get(slot.slotId)!.minimumHeightPixels!,
              })}
            </Badge>
          ) : null}
        </Inline>
      ) : null,
    })),
  ];

  return (
    <Stack gap={3}>
      <MarketplaceNotice
        tone={readiness.ready ? "success" : "warning"}
        title={
          readiness.ready
            ? t("marketplace.features.listings.ui.evidence.ready.title")
            : t("marketplace.features.listings.ui.evidence.required.title")
        }
        description={
          readiness.ready
            ? t("marketplace.features.listings.ui.evidence.ready.description")
            : t("marketplace.features.listings.ui.evidence.required.description")
        }
      />
      <WorkflowReadinessChecklist items={items} />
    </Stack>
  );
}

export function ListingEvidenceReadiness({ listing }: { listing: MarketplaceListingDetail }) {
  const readiness = listing.evidence_readiness;
  const activePhotos = listing.evidence
    .filter((photo) => photo.status === "active")
    .sort((left, right) => left.sortOrder - right.sortOrder || left.photoId.localeCompare(right.photoId));
  const activeIds = activePhotos.map((photo) => photo.photoId);
  const gallery = readiness.publicGallery
    .map((image, index) =>
      galleryImage(image, t("marketplace.features.listings.ui.evidence.photo.fallback.alt", { index: index + 1 })),
    )
    .filter((image): image is NonNullable<typeof image> => image !== null);
  return (
    <Stack gap={4}>
      <EvidenceReadinessChecklist readiness={readiness} surface="listing-detail" />
      {gallery.length > 0 ? (
        <Stack gap={2}>
          <Text weight="semibold">{t("marketplace.features.listings.ui.evidence.seller.supplied")}</Text>
          <ImageGallery images={gallery} />
        </Stack>
      ) : null}
      {listing.status === "draft" ? (
        <Stack gap={3}>
          <Form
            method="post"
            encType="multipart/form-data"
            onSubmit={() => trackListingEvidenceEvent("upload_started", { surface: "listing-detail" })}
          >
            <HiddenInput type="hidden" name="intent" value="add-photos" />
            <FileDropzone
              label={t("marketplace.features.listings.ui.evidence.add.photos")}
              description={t("marketplace.features.listings.ui.evidence.add.photos.description")}
              name="evidence"
              accept="image/jpeg,image/png,image/webp"
              multiple
              capture="environment"
              dropLabel={t("marketplace.features.listings.ui.evidence.drop.photos")}
              browseLabel={t("marketplace.features.listings.ui.evidence.choose.photos")}
            />
            <Button type="submit">{t("marketplace.features.listings.ui.evidence.upload")}</Button>
          </Form>
          <Grid columns={{ base: 1, lg: 2 }} gap={3}>
            {activePhotos.map((photo, index) => (
              <Card key={photo.photoId}>
                <Stack gap={3}>
                  <Text weight="semibold">
                    {photo.altText ?? t("marketplace.features.listings.ui.evidence.photo.label", { index: index + 1 })}
                  </Text>
                  <Form method="post">
                    <HiddenInput type="hidden" name="intent" value="classify-photo" />
                    <HiddenInput type="hidden" name="photoId" value={photo.photoId} />
                    <NativeSelect
                      label={t("marketplace.features.listings.ui.evidence.assign.view")}
                      name="slotId"
                      defaultValue={photo.slotId ?? ""}
                      placeholder={t("marketplace.features.listings.ui.evidence.unclassified")}
                      items={readiness.requirements.requiredSlots.map((slot) => ({
                        value: slot.slotId,
                        label: slot.viewKind,
                      }))}
                    />
                    <TextInput
                      label={t("marketplace.features.listings.ui.evidence.alt.text")}
                      name="altText"
                      defaultValue={photo.altText ?? ""}
                    />
                    <Button type="submit" tone="secondary">
                      {t("marketplace.features.listings.ui.evidence.save.classification")}
                    </Button>
                  </Form>
                  <Form
                    method="post"
                    encType="multipart/form-data"
                    onSubmit={() => trackListingEvidenceEvent("upload_started", { surface: "listing-detail" })}
                  >
                    <HiddenInput type="hidden" name="intent" value="replace-photo" />
                    <HiddenInput type="hidden" name="photoId" value={photo.photoId} />
                    <HiddenInput type="hidden" name="slotId" value={photo.slotId ?? ""} />
                    <HiddenInput type="hidden" name="viewKind" value={photo.viewKind ?? ""} />
                    <FileDropzone
                      label={t("marketplace.features.listings.ui.evidence.replace.photo")}
                      name="listingPhoto"
                      accept="image/jpeg,image/png,image/webp"
                      capture="environment"
                      dropLabel={t("marketplace.features.listings.ui.evidence.drop.replacement")}
                      browseLabel={t("marketplace.features.listings.ui.evidence.choose.replacement")}
                    />
                    <Button type="submit" tone="secondary">
                      {t("marketplace.features.listings.ui.evidence.replace")}
                    </Button>
                  </Form>
                  <Inline gap={2}>
                    <Form method="post">
                      <HiddenInput type="hidden" name="intent" value="reorder-photos" />
                      <HiddenInput
                        type="hidden"
                        name="orderedPhotoIds"
                        value={JSON.stringify(reordered(activeIds, index, -1))}
                      />
                      <Button type="submit" tone="secondary" disabled={index === 0}>
                        {t("marketplace.features.listings.ui.evidence.move.earlier")}
                      </Button>
                    </Form>
                    <Form method="post">
                      <HiddenInput type="hidden" name="intent" value="reorder-photos" />
                      <HiddenInput
                        type="hidden"
                        name="orderedPhotoIds"
                        value={JSON.stringify(reordered(activeIds, index, 1))}
                      />
                      <Button type="submit" tone="secondary" disabled={index === activePhotos.length - 1}>
                        {t("marketplace.features.listings.ui.evidence.move.later")}
                      </Button>
                    </Form>
                    <Form method="post">
                      <HiddenInput type="hidden" name="intent" value="remove-photo" />
                      <HiddenInput type="hidden" name="photoId" value={photo.photoId} />
                      <Button type="submit" tone="danger">
                        {t("marketplace.features.listings.ui.evidence.remove")}
                      </Button>
                    </Form>
                  </Inline>
                </Stack>
              </Card>
            ))}
          </Grid>
        </Stack>
      ) : null}
    </Stack>
  );
}
