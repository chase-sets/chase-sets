import { forwardRef } from "react";
import { NativeSelect } from "./select";

export interface ProductSelectionFieldOption {
  value: string;
  label: string;
}

export interface ProductSelectionField {
  dimensionId: string;
  label: string;
  value: string;
  options: readonly ProductSelectionFieldOption[];
}

export interface ProductSelectionFieldsProps {
  /** Ready-to-render fields, one per active product-schema dimension, already ordered. */
  fields: readonly ProductSelectionField[];
  /** Fires with the raw (dimensionId, optionId) pair a control just committed. */
  onFieldChange: (dimensionId: string, optionId: string) => void;
  /** Builds the form `name` for a dimension's control (omit to leave the control unnamed). */
  fieldName?: (dimensionId: string) => string;
}

/**
 * Renders one `NativeSelect` per active product-schema dimension - the "choose condition,
 * grading company, grade, ..." step of a catalog-item picker. Purely presentational: the
 * caller computes which dimensions are active/ordered and owns selection-state normalization
 * (see `@chase-sets/product-selection`), this component only renders the resulting fields.
 */
export const ProductSelectionFields = forwardRef<HTMLSelectElement, ProductSelectionFieldsProps>(
  function ProductSelectionFields({ fields, onFieldChange, fieldName }, ref) {
    return (
      <>
        {fields.map((field, index) => (
          <NativeSelect
            key={field.dimensionId}
            ref={index === 0 ? ref : undefined}
            label={field.label}
            name={fieldName?.(field.dimensionId)}
            value={field.value}
            onChange={(event) => onFieldChange(field.dimensionId, event.target.value)}
            items={[...field.options]}
          />
        ))}
      </>
    );
  },
);
ProductSelectionFields.displayName = "ProductSelectionFields";
