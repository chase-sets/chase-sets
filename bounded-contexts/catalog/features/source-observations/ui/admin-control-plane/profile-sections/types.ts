import type { ComponentType } from "react";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileEditableSection,
  CatalogProviderProfileEditableSectionKey,
  CatalogProviderProfileVersionReview,
} from "../../contracts";

export type CatalogProviderProfileSectionArea = "identity" | "transport" | "mapping" | "governance";

export type CatalogProviderProfileSectionEditorProps = Readonly<{
  section: CatalogProviderProfileEditableSectionKey;
  profile: CatalogProviderProfileVersionReview;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
}>;

export type CatalogProviderProfileSectionEditorModule = Readonly<{
  default: ComponentType<CatalogProviderProfileSectionEditorProps>;
}>;

export type CatalogProviderProfileSectionModule = Readonly<{
  section: CatalogProviderProfileEditableSectionKey;
  label: string;
  area: CatalogProviderProfileSectionArea;
  formStateKey: string | null;
  commandSection: CatalogProviderProfileEditableSectionKey;
  loadEditor: () => Promise<CatalogProviderProfileSectionEditorModule>;
}>;

export type CatalogProviderProfileSectionRegistryItem = Readonly<{
  module: CatalogProviderProfileSectionModule;
  editableSection: CatalogProviderProfileEditableSection | null;
}>;
