import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { SavedListPreviewPage, buildSavedListPreviewMetadata } from "../features/saved-lists/ui";
import type { SavedListPreview } from "../features/saved-lists/ui";

// Public/unlisted Saved List route. The privacy-safe projection loader — token
// resolution, authorization, redaction, and cache isolation — is owned by the
// Saved List visibility lane and wires its `loader`/`headers` into this module
// at composition time. This module owns only the deployable-facing rendering
// and metadata: it reads the resolved projection and renders the single Saved
// List view surface, and its `meta` keeps unlisted and unpostured public lists
// noindex so redaction can never be undone by markup.

export const meta: MetaFunction = ({ data }) => {
  const preview = (data ?? null) as SavedListPreview | null;

  if (!preview || preview.status !== "available") {
    return [
      { title: t("collections.features.savedLists.web.preview.unavailable.notFound.title") },
      { name: "robots", content: "noindex, nofollow" },
    ];
  }

  return [...buildSavedListPreviewMetadata(preview.content, { title: preview.content.title }).descriptors];
};

export default function SharedSavedListRoute() {
  const preview = useLoaderData() as SavedListPreview;
  const saveCopyHref = preview.status === "available" ? `/lists/${preview.content.listId}/save-a-copy` : undefined;

  return <SavedListPreviewPage preview={preview} saveCopyHref={saveCopyHref} />;
}
