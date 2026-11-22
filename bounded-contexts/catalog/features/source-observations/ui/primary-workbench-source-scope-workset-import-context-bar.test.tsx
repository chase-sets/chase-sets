// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as renderUi, screen } from "@testing-library/react";
import type { ReactElement } from "react";
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
import { controlPlaneOverview, DailyCommandOwner, profileReview } from "./primary-workbench-test-fixtures";
import { CatalogIntegrationCommandActionProvider } from "./admin-control-plane/import-to-promotion/command-action-context";
import { CATALOG_SCOPE_RECORD_QUERY_KEYS } from "../api/admin/scope-detail-workbench-location";
import { CATALOG_SOURCE_OPTION_ACTION_PARAM } from "./primary-workbench-source-option-refresh";

const render = (ui: ReactElement) => renderUi(ui, { wrapper: DailyCommandOwner });

// Each submit records its data and the path it targets, resolved the way
// react-router does: an explicit `action` option, else the form's own action.
const submissions: FormData[] = [];
const submitPaths: Array<string | null> = [];
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useSubmit:
      () =>
      (target: HTMLFormElement | URLSearchParams, options: { action?: string } = {}) => {
        const data = target instanceof URLSearchParams ? new FormData() : new FormData(target);
        if (target instanceof URLSearchParams) target.forEach((value, key) => data.append(key, value));
        submissions.push(data);
        submitPaths.push(options.action ?? (target instanceof URLSearchParams ? null : target.getAttribute("action")));
      },
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
  submitPaths.length = 0;
});

// On Scope Detail the Scope Record owns product line, series and expansion; the
// provider, unit, profile and remaining coordinates are selections its address carries.
describe("Import context and workset on a selected Scope", () => {
  const scopePath = "/catalog/scopes/scope_lorcana_first_chapter";

  function renderOnScope(model: CatalogPrimaryWorkbenchReadModel) {
    return renderUi(
      <CatalogIntegrationCommandActionProvider actionPath={scopePath}>
        <CatalogImportContextBar readModel={model} recordOwnedFieldNames={CATALOG_SCOPE_RECORD_QUERY_KEYS} />
        <CatalogSourceScopeWorksetModule readModel={model} />
      </CatalogIntegrationCommandActionProvider>,
    );
  }

  function openImportContext() {
    fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
  }

  it("renders the Scope Record's expansion fixed and applies the selection on the Scope path", () => {
    const model = readModel(route("1"));
    renderOnScope(model);
    openImportContext();
    const expansion = model.sourceOptions.guidedFields?.find((field) => field.fieldName === "expansionId");
    const fixed = document.querySelector('[data-catalog-record-owned-scope-field="expansionId"]');
    expect(fixed?.textContent).toContain(expansion?.selectedLabel || expansion?.selectedValue);
    expect(screen.queryByRole("combobox", { name: "Set" })).toBeNull();
    const form = screen.getByRole<HTMLSelectElement>("combobox", { name: "Provider" }).form!;
    expect(form.getAttribute("action")).toBe(scopePath);
    for (const key of CATALOG_SCOPE_RECORD_QUERY_KEYS) expect(form.elements.namedItem(key)).toBeNull();

    fireEvent.submit(form);

    expect(submitPaths.at(-1)).toBe(scopePath);
    expect(submissions.at(-1)?.get("providerKey")).toBe("lorcanajson");
    expect(submissions.at(-1)?.get("unitKey")).toBe(unitKey);
    for (const key of CATALOG_SCOPE_RECORD_QUERY_KEYS) expect(submissions.at(-1)?.has(key)).toBe(false);
  });

  it.each([
    ["Provider", "providerKey", "synthetic-second-provider", ["unitKey", "profileVersion", "importScope"]],
    ["Unit", "unitKey", `${unitKey}:second`, ["profileVersion", "importScope"]],
  ] as const)("clears what a %s change makes stale and stays on the Scope path", (label, key, value, cleared) => {
    const base = readModel(route("1"));
    const provider = base.providerScope.providers[0]!;
    renderOnScope({
      ...base,
      providerScope: {
        ...base.providerScope,
        providers: [
          { ...provider, units: [...provider.units, { ...provider.units[0]!, unitKey: `${unitKey}:second` }] },
          { ...provider, providerKey: "synthetic-second-provider", displayName: "Synthetic second provider" },
        ],
      },
    });
    openImportContext();

    fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });

    expect(submitPaths.at(-1)).toBe(scopePath);
    expect(submissions.at(-1)?.get(key)).toBe(value);
    for (const stale of [...cleared, "languageCode", ...CATALOG_SCOPE_RECORD_QUERY_KEYS]) {
      expect(submissions.at(-1)?.has(stale)).toBe(false);
    }
  });

  it("refreshes source options on the Scope path", () => {
    renderOnScope(readModel(route("1")));
    openImportContext();

    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));

    expect(submitPaths.at(-1)).toBe(scopePath);
    expect(submissions.at(-1)?.get(CATALOG_SOURCE_OPTION_ACTION_PARAM)).toBeTruthy();
  });

  it("keeps workset commands and links on the Scope path with their unit context", () => {
    renderOnScope(readModel(route("1")));

    const command = new URL(scopeForm().action);
    expect(command.pathname).toBe(scopePath);
    expect(command.searchParams.get("unitKey")).toBe(unitKey);
    for (const link of screen.getAllByRole<HTMLAnchorElement>("link", { name: "Open source scope" })) {
      expect(new URL(link.href).pathname).toBe(scopePath);
    }
  });
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
