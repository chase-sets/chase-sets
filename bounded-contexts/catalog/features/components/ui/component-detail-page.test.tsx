// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../support/shell-support/ui/toasts";
import { ComponentDetailPage } from "./component-detail-page";
import type { ComponentDetail } from "./contracts";
import { configureComponent, useComponent } from "./use-components";

vi.mock("./use-components", () => ({
  useComponent: vi.fn(),
  configureComponent: vi.fn(),
  activateComponent: vi.fn(),
  deprecateComponent: vi.fn(),
  archiveComponent: vi.fn(),
  addFieldRule: vi.fn(),
  removeFieldRule: vi.fn(),
  addDimensionRule: vi.fn(),
  removeDimensionRule: vi.fn(),
}));

const component: ComponentDetail = {
  component_id: "cmp_component",
  key: "component-v1",
  name_i18n: localizedTextMapFromEnglish("Component V1"),
  name: "Component V1",
  description_i18n: localizedTextMapFromEnglish("Original description"),
  description: "Original description",
  status: "draft",
  field_rules: [{ fieldId: "fld_name", fieldName: "Name", required: true }],
  dimension_rules: [
    {
      dimensionId: "dim_language",
      dimensionName: "Language",
      required: true,
      allowedOptions: [],
      appliesWhen: [],
    },
  ],
  updated_at: "2026-10-31T00:00:00.000Z",
};

describe("ComponentDetailPage metadata editing", () => {
  beforeEach(() => {
    vi.mocked(configureComponent).mockResolvedValue({} as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends only metadata fields, shows success, and refreshes the detail", async () => {
    const refresh = vi.fn();
    vi.mocked(useComponent).mockReturnValue({ data: component, loading: false, error: null, refresh });

    render(
      <ToastProvider>
        <ComponentDetailPage id={component.component_id} initialData={component} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Component" });
    fireEvent.change(within(dialog).getByLabelText("Key"), { target: { value: "component-v2" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Component V2" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Updated description" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configureComponent).toHaveBeenCalledTimes(1));
    const requestBody = vi.mocked(configureComponent).mock.calls[0]?.[1];
    expect(Object.keys(requestBody ?? {})).toEqual(["key", "name", "description"]);
    expect(requestBody).toEqual({
      key: "component-v2",
      name: localizedTextMapFromEnglish("Component V2"),
      description: localizedTextMapFromEnglish("Updated description"),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Component updated")).toBeTruthy();
  });
});
