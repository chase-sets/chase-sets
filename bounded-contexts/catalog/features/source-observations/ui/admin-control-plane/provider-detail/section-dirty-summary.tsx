import { useCallback, useRef, useState, type ReactNode } from "react";
import { Box, Button, OperationalStatusBanner } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";

const SECTION_FORM_SELECTOR = '[data-catalog-primary-workbench-command="provider-profile.edit-section"]';

// Aggregate dirty-state summary + save-all affordance over the section-level
// forms rendered inside `children` (ProfileSectionWorkspaces). Each section
// keeps its own atomic save (a separate `provider-profile.edit-section`
// command per section, unchanged) — this only adds a page-level "N sections
// have unsaved changes" banner and a "Save all" action that submits every dirty
// section's form in turn without a full-page reload between saves, then
// revalidates once every save has landed ("section editing ... gains a
// dirty-state summary and save-all affordance").
export function SectionDirtySummary({ children }: Readonly<{ children: ReactNode }>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dirtySectionKeys, setDirtySectionKeys] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleChange = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const dirty = new Set<string>();
    for (const form of container.querySelectorAll<HTMLFormElement>(SECTION_FORM_SELECTOR)) {
      const panel = form.closest<HTMLElement>("[data-catalog-profile-section-workspace]");
      const sectionKey = panel?.dataset.catalogProfileSectionWorkspace;
      if (sectionKey && formIsDirty(form)) {
        dirty.add(sectionKey);
      }
    }
    setDirtySectionKeys([...dirty]);
  }, []);

  const handleSaveAll = useCallback(async () => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      for (const form of container.querySelectorAll<HTMLFormElement>(SECTION_FORM_SELECTOR)) {
        const panel = form.closest<HTMLElement>("[data-catalog-profile-section-workspace]");
        const sectionKey = panel?.dataset.catalogProfileSectionWorkspace;
        if (!sectionKey || !dirtySectionKeys.includes(sectionKey)) {
          continue;
        }
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          credentials: "same-origin",
          redirect: "manual",
        });
        // A redirect (opaqueredirect under redirect:"manual", or a 3xx if the
        // server ever answers same-origin without the manual override) is the
        // section save succeeding — the action always redirects back to this
        // page. Anything else is treated as a failed save.
        if (response.type !== "opaqueredirect" && !(response.status >= 300 && response.status < 400)) {
          throw new Error(`Section ${sectionKey} did not save (status ${response.status}).`);
        }
      }
      window.location.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  }, [dirtySectionKeys]);

  return (
    <Box ref={containerRef} onChangeCapture={handleChange}>
      {dirtySectionKeys.length > 0 ? (
        <OperationalStatusBanner
          tone={saveError ? "danger" : "warning"}
          title={
            saveError
              ? t("catalog.features.sourceObservations.ui.providerDetail.sections.saveAll.errorTitle")
              : t("catalog.features.sourceObservations.ui.providerDetail.sections.dirty.title", {
                  count: String(dirtySectionKeys.length),
                })
          }
          description={
            saveError ?? t("catalog.features.sourceObservations.ui.providerDetail.sections.dirty.description")
          }
          action={
            <Button size="sm" leadingIcon="check" disabled={saving} onClick={() => void handleSaveAll()}>
              {saving
                ? t("catalog.features.sourceObservations.ui.providerDetail.sections.saveAll.saving")
                : t("catalog.features.sourceObservations.ui.providerDetail.sections.saveAll.submit")}
            </Button>
          }
        />
      ) : null}
      {children}
    </Box>
  );
}

function formIsDirty(form: HTMLFormElement): boolean {
  for (const element of form.elements) {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
    ) {
      continue;
    }
    if (element.type === "hidden" || element.type === "submit" || element.disabled) {
      continue;
    }
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      if (element.checked !== element.defaultChecked) {
        return true;
      }
      continue;
    }
    if (element instanceof HTMLSelectElement) {
      for (const option of element.options) {
        if (option.selected !== option.defaultSelected) {
          return true;
        }
      }
      continue;
    }
    if (element.value !== element.defaultValue) {
      return true;
    }
  }
  return false;
}
