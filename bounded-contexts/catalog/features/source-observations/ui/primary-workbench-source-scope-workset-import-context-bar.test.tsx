// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogImportContextBar } from "./admin-control-plane/import-to-promotion/import-context-bar";
import { CatalogSourceScopeWorksetModule } from "./admin-control-plane/import-to-promotion/source-scope-workset-module";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
} from "./primary-workbench-read-model";
import { controlPlaneOverview, profileReview } from "./primary-workbench-test-fixtures";

const submissions: FormData[] = [];
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useSubmit: () => (form: HTMLFormElement) => submissions.push(new FormData(form)),
  };
});

const unitKey = "lorcanajson:lorcana:single-card:reference-data";
const route = (id: string) =>
  `https://admin.example/catalog/integrations?providerKey=lorcanajson&unitKey=${unitKey}&importScope=en%3A${id}&languageCode=en&expansionId=${id}&expansionName=Rise+of+the+Floodborn`;

function readModel(
  requestUrl: string,
  setItems = [
    { value: "1", label: "The First Chapter" },
    { value: "2", label: "Rise of the Floodborn" },
  ],
) {
  const profile = profileReview({
    providerKey: "lorcanajson",
    profileKey: "lorcanajson-lorcana-card",
    ingestionUnitKey: unitKey,
    active: true,
    lifecycle: "active",
    profile: { providerKey: "lorcanajson", supportedScopes: ["set-name"] },
    supportedScopes: ["set-name"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ],
  });
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl,
    scopes: [],
    profiles: [profile],
    cacheOnly: true,
  });
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    controlPlaneOverview: controlPlaneOverview(),
    sourceOptionPages: requests.map((request) => ({
      request,
      response: {
        items: setItems.map((option) => ({
          ...option,
          providerKey: "lorcanajson",
          queryKind: "sets",
          description: null,
          parentValue: null,
          imageUrl: null,
          aliases: [],
          metadata: {},
        })),
        total: 2,
        count: 2,
        cache: {
          status: "fresh",
          source: "cache",
          cacheKey: "synthetic:lorcanajson:sets:en",
          fetchedAt: "2026-09-30T00:00:00.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z",
          staleUntil: "2026-10-02T00:00:00.000Z",
          cacheOnly: true,
          forceRefresh: false,
          degraded: false,
          diagnostics: [],
        },
      },
    })),
    canManageCatalog: true,
  });
}

function view(requestUrl: string, setItems?: { value: string; label: string }[]) {
  const model = readModel(requestUrl, setItems);
  return (
    <>
      <CatalogImportContextBar readModel={model} />
      <CatalogSourceScopeWorksetModule readModel={model} />
    </>
  );
}

function scopeForm() {
  return document.querySelector<HTMLFormElement>(
    `form[data-catalog-primary-workbench-command="scope.import"][data-catalog-source-scope-unit="${unitKey}"]`,
  )!;
}

afterEach(() => {
  cleanup();
  submissions.length = 0;
});

describe("LorcanaJSON atomic expansion route/form", () => {
  it("case b replaces the observed stale route label using loaded Set options", () => {
    render(view(route("1")));
    expect(screen.queryAllByText("lorcanajson / en / The First Chapter").length).toBeGreaterThan(0);
    expect(screen.queryByText("lorcanajson / en / Rise of the Floodborn")).toBeNull();
    expect(new FormData(scopeForm()).get("expansionName")).toBe("The First Chapter");
  });

  it("does not rewrite the observed stale route name when applying the guided context with loaded Set options", () => {
    render(view(route("1")));
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Set" });
    expect(select.value).toBe("1");
    expect(select.selectedOptions[0]?.textContent).toContain("The First Chapter");
    fireEvent.submit(select.form!);
    expect(submissions.at(-1)?.get("expansionId")).toBe("1");
    expect(submissions.at(-1)?.get("expansionName")).toBe("The First Chapter");
  });

  it("case a selects The First Chapter from the prior Rise route without writing a stale URL or form", () => {
    const { rerender } = render(view(route("2")));
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Set" }), { target: { value: "1" } });
    const submitted = submissions.at(-1)!;
    expect(submitted.get("expansionId")).toBe("1");
    expect(submitted.get("expansionName")).toBe("The First Chapter");
    const url = new URL(route("2"));
    url.search = new URLSearchParams(
      Array.from(submitted.entries(), ([key, value]) => [key, String(value)]),
    ).toString();
    expect(url.searchParams.get("expansionName")).toBe("The First Chapter");
    rerender(view(url.href));
    expect(screen.getAllByText("lorcanajson / en / The First Chapter").length).toBeGreaterThan(0);
    const command = new FormData(scopeForm());
    expect(command.get("expansionId")).toBe("1");
    expect(command.get("expansionName")).toBe("The First Chapter");
    expect(command.get("importScope")).toBe("en:1");
  });

  it.each([
    ["empty Set page", []],
    ["partial Set page", [{ value: "2", label: "Rise of the Floodborn" }]],
  ])("keeps the route label when the %s lacks the selected id", (_name, setItems) => {
    const correctRoute = route("1").replace("expansionName=Rise+of+the+Floodborn", "expansionName=The+First+Chapter");
    render(view(correctRoute, setItems));
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    fireEvent.submit(screen.getByRole<HTMLSelectElement>("combobox", { name: "Set" }).form!);
    expect(submissions.at(-1)?.get("expansionName")).toBe("The First Chapter");
  });

  it("keeps the optimistic label through a pending navigation rerender", () => {
    const { rerender } = render(view(route("2")));
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Set" }), { target: { value: "1" } });
    rerender(view(route("2")));
    fireEvent.click(screen.getByRole("button", { name: "Select source scope" }));
    expect(submissions.at(-1)?.get("expansionId")).toBe("1");
    expect(submissions.at(-1)?.get("expansionName")).toBe("The First Chapter");
  });
});
