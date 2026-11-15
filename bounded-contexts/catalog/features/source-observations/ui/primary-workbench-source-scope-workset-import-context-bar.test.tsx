// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogImportContextBar } from "./admin-control-plane/import-to-promotion/import-context-bar";
import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchGuidedScopeField,
} from "../api/primary-workbench-admin-contracts";
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

describe("API-owned import context controls", () => {
  function field(
    overrides: Partial<CatalogPrimaryWorkbenchGuidedScopeField> = {},
  ): CatalogPrimaryWorkbenchGuidedScopeField {
    return {
      queryKind: "synthetic-api",
      scope: "set-name",
      label: "Synthetic API field",
      fieldName: "expansionId",
      labelFieldName: "expansionName",
      selectedValue: "api-id",
      selectedLabel: "API selected name",
      options: [{ value: "api-id", label: "API option", description: null, parentValue: null }],
      parentMissing: false,
      parentScope: null,
      parentDiagnostic: null,
      ...overrides,
    };
  }

  function answer(
    overrides: Partial<CatalogPrimaryWorkbenchReadModel["sourceOptions"]> = {},
  ): CatalogPrimaryWorkbenchReadModel {
    const model = readModel(route("1"));
    return {
      ...model,
      sourceOptions: {
        ...model.sourceOptions,
        contextSummary: "Synthetic API summary",
        freeTextApplicable: false,
        guidedFields: [field()],
        ...overrides,
      },
    };
  }

  // Issue #11080: route/pages deliberately disagree with these wire answers.
  it("renders first-paint API answers and submits their atomic id/name without local rules", () => {
    render(<CatalogImportContextBar readModel={answer()} />);
    expect(screen.getByText(/Synthetic API summary/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Synthetic API field" });
    expect(select.value).toBe("api-id");
    expect(screen.queryByRole("combobox", { name: "Set" })).toBeNull();
    expect(document.querySelector('input[name="importScope"]')).toBeNull();
    fireEvent.submit(select.form!);
    expect(submissions.at(-1)?.get("expansionId")).toBe("api-id");
    expect(submissions.at(-1)?.get("expansionName")).toBe("API selected name");
  });

  it("uses the API free-text gate even when pages would imply a guided field", () => {
    const model = answer({ guidedFields: [], freeTextApplicable: true, contextSummary: null });
    render(<CatalogImportContextBar readModel={model} />);
    expect(document.querySelector('input[name="importScope"]')).not.toBeNull();
    expect(screen.queryByRole("combobox", { name: "Set" })).toBeNull();
  });

  it.each(["loading", "empty", "error", "success"])(
    "renders the %s API field state without rebuilding from pages",
    (state) => {
      const model = answer({
        guidedFields: [
          field({
            ...(state !== "success" ? { options: [] } : {}),
            ...(state === "error" ? { parentMissing: true, parentDiagnostic: "Synthetic API parent diagnostic" } : {}),
          }),
        ],
      });
      render(<CatalogImportContextBar readModel={model} />);
      fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
      const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Synthetic API field" });
      expect(select.disabled).toBe(state === "error");
      if (state === "error") expect(screen.getByText("Synthetic API parent diagnostic")).toBeTruthy();
    },
  );

  it("replaces skeleton fields with distinctive deferred API fields and controlled selection", async () => {
    const model = answer();
    let resolve!: (value: typeof model.sourceOptions) => void;
    const deferred = new Promise<typeof model.sourceOptions>((done) => {
      resolve = done;
    });
    const { rerender } = render(<CatalogImportContextBar readModel={model} deferredSourceOptions={deferred} />);
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Synthetic API field" }).value).toBe("api-id");
    const resolved = answer({
      guidedFields: [
        field({
          label: "Deferred API field",
          selectedValue: "deferred-id",
          options: [{ value: "deferred-id", label: "Deferred name", description: null, parentValue: null }],
        }),
      ],
    }).sourceOptions;
    await act(async () => {
      resolve(resolved);
    });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Deferred API field" }).value).toBe("deferred-id");
    const changed = answer({
      guidedFields: [
        field({
          selectedValue: "changed-id",
          options: [{ value: "changed-id", label: "Changed", description: null, parentValue: null }],
        }),
      ],
    });
    rerender(<CatalogImportContextBar readModel={changed} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Synthetic API field" }).value).toBe("changed-id");
  });

  it("retains skeleton API answers on deferred rejection", async () => {
    let reject!: (reason: Error) => void;
    const deferred = new Promise<ReturnType<typeof answer>["sourceOptions"]>((_resolve, fail) => {
      reject = fail;
    });
    render(<CatalogImportContextBar readModel={answer()} deferredSourceOptions={deferred} />);
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    await act(async () => {
      reject(new Error("Synthetic deferred failure"));
    });
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Synthetic API field" }).value).toBe("api-id");
  });

  it("clears a same-valued child when its parent identity changes, then submits the new atomic selection", () => {
    const fields = (parent: string, selectedValue: string) => [
      field({
        queryKind: "synthetic-parent",
        scope: "series",
        label: "API parent",
        fieldName: "seriesId",
        labelFieldName: "seriesName",
        selectedValue: parent,
        selectedLabel: parent,
        options: ["parent-a", "parent-b"].map((value) => ({
          value,
          label: value,
          description: null,
          parentValue: null,
        })),
      }),
      field({
        parentScope: "series",
        selectedValue,
        options: [{ value: "same-child", label: `Child of ${parent}`, description: null, parentValue: parent }],
      }),
    ];
    const { rerender } = render(
      <CatalogImportContextBar readModel={answer({ guidedFields: fields("parent-a", "same-child") })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "API parent" }), { target: { value: "parent-b" } });
    expect(submissions.at(-1)?.get("seriesId")).toBe("parent-b");
    expect(submissions.at(-1)?.get("expansionId")).toBe("");
    expect(submissions.at(-1)?.get("expansionName")).toBe("");
    rerender(<CatalogImportContextBar readModel={answer({ guidedFields: fields("parent-b", "") })} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Synthetic API field" }).value).toBe("");
    fireEvent.change(screen.getByRole("combobox", { name: "Synthetic API field" }), {
      target: { value: "same-child" },
    });
    expect(submissions.at(-1)?.get("seriesId")).toBe("parent-b");
    expect(submissions.at(-1)?.get("expansionId")).toBe("same-child");
    expect(submissions.at(-1)?.get("expansionName")).toBe("Child of parent-b");
  });
});
