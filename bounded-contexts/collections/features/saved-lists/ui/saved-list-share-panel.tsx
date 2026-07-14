import { t } from "@chase-sets/localization";
import {
  Banner,
  Button,
  Caption,
  Cluster,
  CopyButton,
  Divider,
  Heading,
  Inline,
  LinkText,
  RadioGroup,
  Stack,
  Surface,
  Switch,
  Text,
} from "@chase-sets/design-system";
import type { SavedListVisibility } from "../domain/contracts";
import type { SavedListPreviewDisclosure } from "./preview-contract";

export type SavedListShareState = Readonly<{
  visibility: SavedListVisibility;
  disclosure: SavedListPreviewDisclosure;
  // Present only when the list is unlisted or public and a live link exists.
  shareUrl: string | null;
  previewHref: string | null;
}>;

export type SavedListSharePanelProps = Readonly<{
  state: SavedListShareState;
  onVisibilityChange?: (visibility: SavedListVisibility) => void;
  onDisclosureChange?: (disclosure: SavedListPreviewDisclosure) => void;
  onRotateLink?: () => void;
  onRevokeLink?: () => void;
  busy?: boolean;
}>;

const VISIBILITY_ORDER: readonly SavedListVisibility[] = ["private", "unlisted", "public"];

export function SavedListSharePanel({
  state,
  onVisibilityChange,
  onDisclosureChange,
  onRotateLink,
  onRevokeLink,
  busy = false,
}: SavedListSharePanelProps) {
  const visibilityItems = VISIBILITY_ORDER.map((visibility) => ({
    value: visibility,
    label: visibilityLabel(visibility),
    description: visibilityDescription(visibility),
  }));

  const isShared = state.visibility !== "private";

  return (
    <Surface tone="default" padding={5}>
      <Stack gap={5}>
        <Stack gap={1}>
          <Heading level={3}>{t("collections.features.savedLists.web.share.title")}</Heading>
          <Caption>{t("collections.features.savedLists.web.share.description")}</Caption>
        </Stack>

        <RadioGroup
          label={t("collections.features.savedLists.web.share.visibility.label")}
          items={visibilityItems}
          value={state.visibility}
          onValueChange={(value) => onVisibilityChange?.(value as SavedListVisibility)}
          disabled={busy}
        />

        {state.visibility === "private" ? (
          <Banner tone="info" title={t("collections.features.savedLists.web.share.privateNotice")} role="status" />
        ) : null}

        {isShared ? (
          <>
            <Divider />
            <Stack gap={3}>
              <Heading level={4}>{t("collections.features.savedLists.web.share.disclosure.heading")}</Heading>
              <Switch
                label={t("collections.features.savedLists.web.share.disclosure.quantities")}
                description={t("collections.features.savedLists.web.share.disclosure.quantities.description")}
                checked={state.disclosure.showTrackedQuantities}
                disabled={busy}
                onCheckedChange={(checked) =>
                  onDisclosureChange?.({ ...state.disclosure, showTrackedQuantities: checked })
                }
              />
              <Switch
                label={t("collections.features.savedLists.web.share.disclosure.value")}
                description={t("collections.features.savedLists.web.share.disclosure.value.description")}
                checked={state.disclosure.showEstimatedValue}
                disabled={busy}
                onCheckedChange={(checked) =>
                  onDisclosureChange?.({ ...state.disclosure, showEstimatedValue: checked })
                }
              />
            </Stack>

            <Divider />
            <Stack gap={3}>
              <Heading level={4}>{t("collections.features.savedLists.web.share.link.label")}</Heading>
              {state.shareUrl ? (
                <>
                  <Surface tone="muted" padding={3}>
                    <Text size="sm" wrap="anywhere">
                      {state.shareUrl}
                    </Text>
                  </Surface>
                  <Inline gap={2}>
                    <CopyButton
                      value={state.shareUrl}
                      label={t("collections.features.savedLists.web.share.link.copy")}
                      copiedLabel={t("collections.features.savedLists.web.share.link.copied")}
                    />
                    {state.visibility === "unlisted" ? (
                      <Button tone="secondary" size="sm" disabled={busy} onClick={() => onRotateLink?.()}>
                        {t("collections.features.savedLists.web.share.link.rotate")}
                      </Button>
                    ) : null}
                    <Button tone="danger" size="sm" disabled={busy} onClick={() => onRevokeLink?.()}>
                      {t("collections.features.savedLists.web.share.link.revoke")}
                    </Button>
                  </Inline>
                </>
              ) : (
                <Caption>{t("collections.features.savedLists.web.share.link.none")}</Caption>
              )}

              {state.previewHref ? (
                <Cluster justify="start">
                  <LinkText href={state.previewHref}>
                    {t("collections.features.savedLists.web.share.preview.open")}
                  </LinkText>
                </Cluster>
              ) : null}
            </Stack>
          </>
        ) : null}
      </Stack>
    </Surface>
  );
}

function visibilityLabel(visibility: SavedListVisibility): string {
  switch (visibility) {
    case "public":
      return t("collections.features.savedLists.web.share.visibility.public");
    case "unlisted":
      return t("collections.features.savedLists.web.share.visibility.unlisted");
    case "private":
    default:
      return t("collections.features.savedLists.web.share.visibility.private");
  }
}

function visibilityDescription(visibility: SavedListVisibility): string {
  switch (visibility) {
    case "public":
      return t("collections.features.savedLists.web.share.visibility.public.description");
    case "unlisted":
      return t("collections.features.savedLists.web.share.visibility.unlisted.description");
    case "private":
    default:
      return t("collections.features.savedLists.web.share.visibility.private.description");
  }
}
