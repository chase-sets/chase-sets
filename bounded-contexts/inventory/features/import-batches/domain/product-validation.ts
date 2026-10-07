import {
  createInventoryProductDescriptor,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import type { InventoryImportResolutionStatus } from "../read-model/queries";

export type ImportProductCatalogItem = Readonly<{ status: string; product_schema: InventoryProductSchema | null }>;
export type ImportProductValidation = Readonly<{
  productId: string | null;
  resolutionStatus: InventoryImportResolutionStatus;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  errors: readonly string[];
}>;

export function validateImportProduct(
  input: Readonly<{
    catalogItemId: string | null;
    catalogItem: ImportProductCatalogItem | null;
    selectedOptions: readonly InventorySelectedOptionEntry[];
    sourceProductId: string | null;
    authority: "native" | "resolved";
    requireExistingProduct?: boolean;
  }>,
): ImportProductValidation {
  const invalid = (message: string): ImportProductValidation => ({
    productId: null,
    resolutionStatus: "unresolved",
    selectedOptions: input.selectedOptions,
    errors: [message],
  });
  if (!input.catalogItemId) return invalid("Catalog item id is required.");
  if (!input.catalogItem) return invalid("Catalog item was not found.");
  if (input.catalogItem.status !== "active") return invalid("Catalog item must be active.");
  if (input.requireExistingProduct && !input.sourceProductId) {
    return invalid("Selected options require seller confirmation of the Product.");
  }
  try {
    const schema = input.catalogItem.product_schema;
    if (schema) {
      const ids = schema.dimensions.map((dimension) => dimension.dimensionId);
      const orderedIds = schema.canonicalDimensionOrder.map((dimension) => dimension.dimensionId);
      if (
        new Set(ids).size !== ids.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        ids.length !== orderedIds.length ||
        orderedIds.some((id) => !ids.includes(id)) ||
        schema.dimensions.some(
          (dimension) =>
            !dimension.dimensionId ||
            typeof dimension.required !== "boolean" ||
            new Set(dimension.allowedOptions.map((option) => option.optionId)).size !==
              dimension.allowedOptions.length ||
            dimension.appliesWhen.some((clause) => !ids.includes(clause.dimensionId)),
        )
      )
        return invalid("Selected options schema is invalid.");
    }
    const descriptor = createInventoryProductDescriptor({
      catalogItemId: input.catalogItemId,
      productSchema: schema,
      selection: input.selectedOptions,
    });
    if (input.sourceProductId && input.sourceProductId !== descriptor.productId) {
      return invalid("The source Product no longer matches the current Catalog selection.");
    }
    return {
      productId: descriptor.productId,
      resolutionStatus: input.authority,
      selectedOptions: descriptor.selection,
      errors: [],
    };
  } catch (error) {
    return invalid(
      error instanceof Error && error.message.startsWith("Selected options ")
        ? error.message
        : "Selected options schema is invalid.",
    );
  }
}

export function isImportProductError(message: string): boolean {
  return (
    message === "Catalog item was not found." ||
    message === "Catalog item must be active." ||
    message === "Catalog item id is required." ||
    message === "The source Product no longer matches the current Catalog selection." ||
    message.startsWith("Selected options ")
  );
}

export function replaceImportProductErrors(previous: readonly string[], next: readonly string[]): readonly string[] {
  const first = previous.findIndex(isImportProductError);
  const retained = previous.filter((message) => !isImportProductError(message));
  const index =
    first < 0 ? retained.length : previous.slice(0, first).filter((message) => !isImportProductError(message)).length;
  return [...retained.slice(0, index), ...next, ...retained.slice(index)];
}
