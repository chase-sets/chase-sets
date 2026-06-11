import { t } from "@chase-sets/localization";
import { OperationalStatusBanner } from "@chase-sets/design-system";
import type { CatalogProviderProfileSectionEditorProps } from "./types";

export default function CatalogProviderProfileSectionEditorPlaceholder({
  section,
}: CatalogProviderProfileSectionEditorProps) {
  return (
    <OperationalStatusBanner
      tone="info"
      title={t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.editor.framework")}
      description={t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.editor.pending", {
        section,
      })}
    />
  );
}
