// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MappingExpressionEditor,
  defaultExpression,
  validateMappingExpression,
  type MappingExpressionValue,
} from "./mapping-expression-editor";

describe("MappingExpressionEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("summary callers preserve Catalog validation and preview message-only alerts without automatic focus", () => {
    const onChange = vi.fn();
    const view = (value: MappingExpressionValue) => (
      <MappingExpressionEditor label="Mapping expression" value={value} onChange={onChange} previewPayload={{}} />
    );
    const { rerender } = render(view(expression({ kind: "constant", value: "valid" })));
    expect(screen.queryByRole("alert")).toBeNull();
    const control = screen.getByRole("combobox", { name: "Selector kind" });
    control.focus();
    rerender(
      view({ ...expression({ kind: "path", path: "missing", required: true, nullPolicy: "diagnostic" }), uses: [] }),
    );
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0].textContent).toContain("Evidence uses must include at least one use.");
    expect(alerts[1].textContent).toContain("Preview path 'missing' was not found.");
    expect(within(alerts[0]).getByRole("heading").textContent).toBe("Mapping expression");
    expect(within(alerts[1]).getByRole("heading").textContent).toBe("Fixture Preview");
    for (const alert of alerts) {
      expect(alert.getAttribute("aria-live")).toBe("assertive");
      expect(alert.getAttribute("tabindex")).toBe("-1");
      expect(within(alert).queryByRole("link")).toBeNull();
    }
    expect(document.activeElement).toBe(control);
    expect(onChange).not.toHaveBeenCalled();
    rerender(view(expression({ kind: "constant", value: "valid" })));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("validates every selector and transform variant", () => {
    const expressions: MappingExpressionValue[] = [
      expression({ kind: "path", path: "name", required: true, nullPolicy: "diagnostic" }),
      expression({ kind: "constant", value: "pokemon" }),
      expression({
        kind: "coalesce",
        required: true,
        selectors: [{ kind: "path", path: "printedName", required: false, nullPolicy: "omit" }],
      }),
      expression({
        kind: "template",
        template: "product:{productId}",
        required: true,
        values: {
          productId: expression({ kind: "path", path: "product.id", required: true, nullPolicy: "diagnostic" }),
        },
      }),
      expression({ kind: "array", items: [expression({ kind: "constant", value: "foil" })] }),
      expression({ kind: "object", fields: { languageCode: expression({ kind: "constant", value: "en" }) } }),
      expression({
        kind: "array-map",
        path: "skus",
        emptyPolicy: "diagnostic",
        item: expression({ kind: "path", path: "skuId", required: true, nullPolicy: "diagnostic" }),
      }),
      expression({
        kind: "named-runtime-selector",
        functionKey: "tcgplayer-sku-selected-option-resolver",
        reason: "Resolve SKU selected options.",
      }),
      {
        ...expression({ kind: "path", path: "sku", required: true, nullPolicy: "diagnostic" }),
        transforms: [
          { kind: "named-transform", functionKey: "tcgplayer-product-form", reason: "Normalize product form." },
          { kind: "coerce", to: "string" },
          { kind: "string", operation: "slug" },
          { kind: "lookup", tableKey: "catalog-language", unknownPolicy: "diagnostic" },
        ],
      },
    ];

    for (const candidate of expressions) {
      expect(validateMappingExpression(candidate)).toEqual([]);
    }
  });

  it("reports required path, unresolved template, lookup, and evidence-use diagnostics", () => {
    const diagnostics = validateMappingExpression({
      ...expression({
        kind: "template",
        template: "product:{productId}:{missing}",
        required: true,
        values: {
          productId: expression({ kind: "path", path: "", required: true, nullPolicy: "diagnostic" }),
        },
      }),
      uses: [],
      transforms: [{ kind: "lookup", tableKey: "", unknownPolicy: "diagnostic" }],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        "selector: template value 'missing' is unresolved.",
        "selector.values.productId: required path is missing.",
        "transforms.0: lookup transform requires a table key.",
        "Evidence uses must include at least one use.",
      ]),
    );
  });

  it("edits nested array-map expressions without JSON", () => {
    const onChange = vi.fn();
    render(
      <StatefulEditor
        initialValue={expression({
          kind: "array-map",
          path: "skus",
          emptyPolicy: "allow-empty",
          item: expression({ kind: "path", path: "skuId", required: true, nullPolicy: "diagnostic" }),
        })}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Array path"), { target: { value: "variants" } });
    fireEvent.change(screen.getAllByLabelText("Path")[0], { target: { value: "variantId" } });

    const latest = onChange.mock.calls.at(-1)?.[0] as MappingExpressionValue;
    expect(latest.selector).toMatchObject({
      kind: "array-map",
      path: "variants",
      item: { selector: { kind: "path", path: "variantId" } },
    });
  });

  it("edits transform rows and evidence metadata", () => {
    const onChange = vi.fn();
    render(
      <StatefulEditor
        initialValue={{
          ...defaultExpression(),
          selector: { kind: "path", path: "name", required: true, nullPolicy: "diagnostic" },
          transforms: [{ kind: "lookup", tableKey: "language", unknownPolicy: "diagnostic" }],
        }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Lookup table"), { target: { value: "catalog-language" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "hash-material" }));

    const latest = onChange.mock.calls.at(-1)?.[0] as MappingExpressionValue;
    expect(latest.transforms).toEqual([{ kind: "lookup", tableKey: "catalog-language", unknownPolicy: "diagnostic" }]);
    expect(latest.uses).toEqual(expect.arrayContaining(["source-payload", "hash-material"]));
  });

  it("previews expression output against a fixture payload", () => {
    render(
      <MappingExpressionEditor
        label="Previewed expression"
        value={{
          ...expression({
            kind: "template",
            template: "product:{productId}",
            required: true,
            values: {
              productId: expression({ kind: "path", path: "product.id", required: true, nullPolicy: "diagnostic" }),
            },
          }),
          transforms: [{ kind: "string", operation: "uppercase" }],
        }}
        onChange={vi.fn()}
        previewPayload={{ product: { id: 14240 } }}
      />,
    );

    expect(screen.getByText("Fixture Preview")).toBeTruthy();
    expect(screen.getByText("PRODUCT:14240")).toBeTruthy();
  });

  it("shows preview diagnostics for server-context expressions", () => {
    render(
      <MappingExpressionEditor
        label="Runtime expression"
        value={expression({
          kind: "named-runtime-selector",
          functionKey: "tcgplayer-sku-selected-option-resolver",
          reason: "Resolve selected options.",
        })}
        onChange={vi.fn()}
        previewPayload={{ skuId: 1 }}
      />,
    );

    expect(
      screen.getByText(
        "Preview for runtime selector 'tcgplayer-sku-selected-option-resolver' requires server dry-run context.",
      ),
    ).toBeTruthy();
  });
});

function StatefulEditor({
  initialValue,
  onChange,
}: Readonly<{
  initialValue: MappingExpressionValue;
  onChange: (value: MappingExpressionValue) => void;
}>) {
  const [value, setValue] = useState(initialValue);
  return (
    <MappingExpressionEditor
      label="Mapping expression"
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
    />
  );
}

function expression(selector: MappingExpressionValue["selector"]): MappingExpressionValue {
  return {
    selector,
    owner: "operations",
    uses: ["source-payload"],
    redaction: "none",
  };
}
