// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisplayTemplateListPage } from "./display-template-list-page";
import type { DisplayTemplate } from "./contracts";

const { mockCreateDisplayTemplate, mockUseNavigation, mockUseRevalidator, mockUseSearchParams } = vi.hoisted(() => ({
  mockCreateDisplayTemplate: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseRevalidator: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/catalog/display-templates", search: "", hash: "", state: null, key: "test" }),
  useNavigation: mockUseNavigation,
  useRevalidator: mockUseRevalidator,
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-display-templates", () => ({
  createDisplayTemplate: mockCreateDisplayTemplate,
  localizedTextMapFromEnglish: (value: string) => ({ defaultLocale: "en", values: value ? { en: value } : {} }),
  requiredFieldKeysFromInput: (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
}));

const displayTemplate: DisplayTemplate = {
  display_template_id: "dtp_1",
  key: "pokemon-single-card-default",
  name_i18n: null,
  name: "Pokemon single card",
  description_i18n: null,
  description: "",
  target_kind: "blueprint",
  target_id: "bpr_pokemon_card",
  priority: 10,
  title_template: "{field.card-name} {field.card-number}",
  subtitle_template: "{reference.expansion.name}",
  required_field_keys: ["card-name", "card-number", "expansion"],
  status: "active",
  updated_at: "2026-05-27T00:00:00.000Z",
};

describe("DisplayTemplateListPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("creates Display Templates from the admin list form", async () => {
    const user = userEvent.setup();
    const revalidate = vi.fn();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockCreateDisplayTemplate.mockResolvedValue({ id: "dtp_1", version: 1, status: "draft" });

    render(
      <DisplayTemplateListPage
        data={{ items: [displayTemplate], total: 1, count: 1 }}
        query={
          {
            search: "",
            status: "",
            language: "",
            source: "",
            setId: "",
            typeKey: "",
            targetKind: "",
            page: 0,
            pageSize: 50,
          } as never
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "New Display Template" }));
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "pokemon-card-title" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pokemon card title" } });
    fireEvent.change(screen.getByLabelText("Target ID"), { target: { value: "bpr_pokemon_card" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Title Template"), {
      target: { value: "{field.card-name} {field.card-number}" },
    });
    fireEvent.change(screen.getByLabelText("Subtitle Template"), {
      target: { value: "{reference.expansion.name}" },
    });
    fireEvent.change(screen.getByLabelText("Required Field Keys"), {
      target: { value: "card-number, card-name, expansion" },
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateDisplayTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "pokemon-card-title",
          name: { defaultLocale: "en", values: { en: "Pokemon card title" } },
          target: { kind: "blueprint", id: "bpr_pokemon_card" },
          priority: 25,
          titleTemplate: "{field.card-name} {field.card-number}",
          subtitleTemplate: "{reference.expansion.name}",
          requiredFieldKeys: ["card-name", "card-number", "expansion"],
        }),
      );
      expect(revalidate).toHaveBeenCalled();
    });
  });
});
