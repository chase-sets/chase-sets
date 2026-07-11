// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductSelectionFields, type ProductSelectionField } from "../components/forms/product-selection-fields";

afterEach(() => {
  cleanup();
});

const fields: ProductSelectionField[] = [
  {
    dimensionId: "form",
    label: "Form",
    value: "raw",
    options: [
      { value: "graded", label: "Graded" },
      { value: "raw", label: "Raw" },
    ],
  },
  {
    dimensionId: "condition",
    label: "Condition",
    value: "",
    options: [
      { value: "damaged", label: "Damaged" },
      { value: "near_mint", label: "Near Mint" },
    ],
  },
];

describe("ProductSelectionFields", () => {
  it("renders one select per field, labeled and valued from the field description", () => {
    render(<ProductSelectionFields fields={fields} onFieldChange={vi.fn()} />);

    const formSelect = screen.getByLabelText("Form") as HTMLSelectElement;
    expect(formSelect.value).toBe("raw");
    expect(screen.getByRole("option", { name: "Graded" })).toBeTruthy();

    // No `value=""` option was supplied, so the underlying <select> falls back to its first
    // option - this asserts the component passes `field.value` through rather than any
    // particular fallback behavior.
    const conditionSelect = screen.getByLabelText("Condition") as HTMLSelectElement;
    expect(conditionSelect.value).toBe("damaged");
  });

  it("renders nothing for an empty field list", () => {
    const { container } = render(<ProductSelectionFields fields={[]} onFieldChange={vi.fn()} />);
    expect(container.querySelectorAll("select")).toHaveLength(0);
  });

  it("reports the raw (dimensionId, optionId) pair when a control changes", () => {
    const onFieldChange = vi.fn();
    render(<ProductSelectionFields fields={fields} onFieldChange={onFieldChange} />);

    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "near_mint" } });

    expect(onFieldChange).toHaveBeenCalledWith("condition", "near_mint");
  });

  it("names each control's underlying input via fieldName", () => {
    render(
      <ProductSelectionFields
        fields={fields}
        onFieldChange={vi.fn()}
        fieldName={(dimensionId) => `selectedOptions:${dimensionId}`}
      />,
    );

    const formSelect = screen.getByLabelText("Form") as HTMLSelectElement;
    expect(formSelect.name).toBe("selectedOptions:form");
  });
});
