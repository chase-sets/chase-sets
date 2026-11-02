import {
  getOptionLabel,
  isDimensionActive,
  selectionEntriesToRecord,
  summarizeSelectedOptions,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "./versioning";

const FORM_DIMENSION = "Form";
const GRADED_OPTION = "Graded";
const GRADING_COMPANY_DIMENSION = "Grading Company";
const GRADE_DIMENSION = "Grade";

export type InventoryGradedClassification =
  | Readonly<{ kind: "raw" }>
  | Readonly<{ kind: "graded"; gradingCompany: string | null; grade: string | null }>
  /** Matches the retired "Form: Graded" summary substring without selecting an exact Form/Graded option. */
  | Readonly<{ kind: "unsupported" }>;

/** Option identities that make a product Graded: a dimension named exactly Form with an option labeled exactly Graded. */
export function inventoryGradedSelections(schema: InventoryProductSchema | null): InventorySelectedOptionEntry[] {
  return (schema?.dimensions ?? [])
    .filter((dimension) => dimension.dimensionName === FORM_DIMENSION)
    .flatMap((dimension) =>
      dimension.allowedOptions
        .filter((option) => getOptionLabel(option) === GRADED_OPTION)
        .map((option) => ({ dimensionId: dimension.dimensionId, optionId: option.optionId })),
    );
}

/**
 * Classifies a selection already validated against `schema` by `createInventoryProductDescriptor`.
 * Graded carries the selected Grading Company and Grade labels, each null when absent or blank.
 */
export function classifyInventoryGradedSelection(
  schema: InventoryProductSchema | null,
  selection: readonly InventorySelectedOptionEntry[],
): InventoryGradedClassification {
  if (!schema || selection.length === 0) {
    return { kind: "raw" };
  }

  const selections = selectionEntriesToRecord(selection);
  const activeDimensions = schema.dimensions.filter((dimension) => isDimensionActive(dimension, selections));
  const selectedLabel = (dimensionName: string) => {
    for (const dimension of activeDimensions) {
      if (dimension.dimensionName !== dimensionName) continue;
      const option = dimension.allowedOptions.find(
        (candidate) => candidate.optionId === selections[dimension.dimensionId],
      );
      if (option) return getOptionLabel(option).trim() || null;
    }
    return null;
  };
  const graded = inventoryGradedSelections(schema).some(
    (pair) =>
      selections[pair.dimensionId] === pair.optionId &&
      activeDimensions.some((dimension) => dimension.dimensionId === pair.dimensionId),
  );

  if (graded) {
    return {
      kind: "graded",
      gradingCompany: selectedLabel(GRADING_COMPANY_DIMENSION),
      grade: selectedLabel(GRADE_DIMENSION),
    };
  }

  return summarizeSelectedOptions(schema, selection).includes(`${FORM_DIMENSION}: ${GRADED_OPTION}`)
    ? { kind: "unsupported" }
    : { kind: "raw" };
}
