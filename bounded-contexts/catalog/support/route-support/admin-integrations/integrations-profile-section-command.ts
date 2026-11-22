import { ApiError as CatalogApiError } from "../../shell-support/api/client";
import {
  catalogProviderProfileSectionFieldKeys,
  type CatalogProviderProfileEditableSectionKey,
  type CatalogProviderProfileSectionEdit,
} from "../../../features/source-observations/ui/contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";

/**
 * The section edit a form posted: each of the section's fields it sent, by name. A field the form
 * left out (disabled, or a checkbox not checked) is not sent; Catalog keeps the stored value, or
 * reads the checkbox as unchecked, and applies its own defaults and fixed values.
 */
export function profileSectionEditFromFormData(
  sectionKey: CatalogProviderProfileEditableSectionKey,
  formData: FormData,
): CatalogProviderProfileSectionEdit {
  const fields: Record<string, string> = {};
  for (const key of catalogProviderProfileSectionFieldKeys[sectionKey]) {
    const value = formData.get(key);
    if (typeof value === "string") {
      fields[key] = value;
    }
  }
  return { section: sectionKey, fields };
}

export function editableProfileSectionKey(value: string | null): CatalogProviderProfileEditableSectionKey | null {
  switch (value) {
    case "basics":
    case "provider-options":
    case "connector":
    case "catalog-field-mapping":
    case "source-contract":
    case "fixtures":
    case "source-observation":
    case "normalized-observation":
    case "external-references":
    case "selected-options":
    case "reference-hierarchy":
    case "duplicate-prevention":
    case "promotion-plan":
    case "retirement-plan":
    case "migration-evidence":
      return value;
    default:
      return null;
  }
}

export function profileSectionFailureResult(
  error: unknown,
): Extract<
  CatalogPrimaryWorkbenchCommandFeedback["result"],
  "section-conflict" | "section-invalid" | "command-failed"
> {
  if (error instanceof CatalogApiError) {
    // 428: the form carried no section revision, so it was drawn before revisions were sent.
    if (error.status === 409 || error.status === 428) {
      return "section-conflict";
    }
    if (error.status === 400) {
      return "section-invalid";
    }
  }

  return "command-failed";
}
