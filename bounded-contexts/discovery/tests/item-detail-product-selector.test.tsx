// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductSelector } from "../features/item-detail/ui/product-selector";
import type { ProductSchema } from "../support/client-support/contracts";

afterEach(() => cleanup());

describe("item detail product selector", () => {
  it("renders ordered dimension dropdown options by Catalog display order", async () => {
    const user = userEvent.setup();
    const schema: ProductSchema = {
      canonicalDimensionOrder: [{ dimensionId: "condition", dimensionName: "Condition" }],
      dimensions: [
        {
          dimensionId: "condition",
          dimensionName: "Condition",
          valueKind: "ordered",
          required: false,
          appliesWhen: [],
          allowedOptions: [
            { optionId: "damaged", code: "damaged", label: "Damaged", displayOrder: 6, numericValue: 1 },
            { optionId: "excellent", code: "excellent", label: "Excellent", displayOrder: 3, numericValue: 4 },
            { optionId: "good", code: "good", label: "Good", displayOrder: 4, numericValue: 3 },
            { optionId: "mint", code: "mint", label: "Mint", displayOrder: 1, numericValue: 6 },
            { optionId: "near_mint", code: "near-mint", label: "Near Mint", displayOrder: 2, numericValue: 5 },
            { optionId: "poor", code: "poor", label: "Poor", displayOrder: 5, numericValue: 2 },
            { optionId: "pristine", code: "pristine", label: "Pristine", displayOrder: 0, numericValue: 7 },
          ],
        },
      ],
    };

    render(
      <ProductSelector
        schema={schema}
        selections={{}}
        onSelectionChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Condition" }));

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Any",
      "Pristine",
      "Mint",
      "Near Mint",
      "Excellent",
      "Good",
      "Poor",
      "Damaged",
    ]);
  });
});
