import { type ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface ProductOptionDisplayValue {
  dimensionLabel?: ReactNode;
  optionLabel: ReactNode;
}

export type ProductOptionsVariant = "inline" | "chips" | "compact";

function textFromNode(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  return "";
}

export function productOptionsFromSummary(summary: string | null | undefined): ProductOptionDisplayValue[] {
  if (!summary) {
    return [];
  }

  return summary
    .split(/\s*(?:\||\/|,|•)\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [label, ...valueParts] = segment.split(":");
      const value = valueParts.join(":").trim();

      return value ? { dimensionLabel: label.trim(), optionLabel: value } : { optionLabel: segment };
    })
    .filter((selection) => Boolean(textFromNode(selection.optionLabel)));
}

export function formatProductOptionsText(options: readonly ProductOptionDisplayValue[], separator = " • "): string {
  return options
    .map((option) => textFromNode(option.optionLabel))
    .filter(Boolean)
    .join(separator);
}

export function formatProductOptionsAriaLabel(
  options: readonly ProductOptionDisplayValue[],
  fallback = "No product options selected",
): string {
  if (options.length === 0) {
    return fallback;
  }

  const parts = options
    .map((option) => {
      const dimension = textFromNode(option.dimensionLabel);
      const value = textFromNode(option.optionLabel);

      return dimension ? `${dimension} ${value}` : value;
    })
    .filter(Boolean);

  return parts.length > 0 ? `Product options: ${parts.join(", ")}` : fallback;
}

export function formatProductImageAltText({
  title,
  options,
  fallback = "Product image",
}: {
  title?: string | null;
  options?: readonly ProductOptionDisplayValue[];
  fallback?: string;
}): string {
  const optionText = options ? formatProductOptionsText(options, ", ") : "";
  const titleText = title?.trim();

  if (titleText && optionText) {
    return `${titleText}, ${optionText}`;
  }

  return titleText || optionText || fallback;
}

export interface ProductOptionsProps {
  options?: readonly ProductOptionDisplayValue[];
  emptyLabel?: ReactNode;
  variant?: ProductOptionsVariant;
  size?: "xs" | "sm";
  truncate?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function ProductOptions({
  options = [],
  emptyLabel = "No product options selected",
  variant = "inline",
  size,
  truncate = false,
  className,
  "aria-label": ariaLabel,
}: ProductOptionsProps) {
  const label = ariaLabel ?? formatProductOptionsAriaLabel(options, textFromNode(emptyLabel));

  if (options.length === 0) {
    return (
      <span className={cx("text-[var(--text-secondary)]", className)} aria-label={label}>
        {emptyLabel}
      </span>
    );
  }

  if (variant === "chips") {
    return (
      <span className={cx("inline-flex flex-wrap items-center gap-1.5", className)} aria-label={label}>
        {options.map((option, index) => (
          <span
            key={`${textFromNode(option.dimensionLabel)}-${textFromNode(option.optionLabel)}-${index}`}
            aria-hidden="true"
            className="inline-flex min-h-7 max-w-full items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold leading-4 text-[var(--foreground)]"
          >
            <span className="truncate">{option.optionLabel}</span>
          </span>
        ))}
      </span>
    );
  }

  return (
    <span
      className={cx(
        variant === "compact"
          ? cx(
              "inline min-w-0 font-semibold text-[var(--foreground)]",
              size === "sm" ? "text-sm leading-5" : "text-xs leading-4",
            )
          : "inline min-w-0 text-sm font-semibold leading-5 text-[var(--foreground)]",
        truncate && "block max-w-full truncate",
        className,
      )}
      aria-label={label}
    >
      {options.map((option, index) => (
        <span key={`${textFromNode(option.dimensionLabel)}-${textFromNode(option.optionLabel)}-${index}`}>
          {index > 0 ? <span aria-hidden="true"> • </span> : null}
          <span aria-hidden="true">{option.optionLabel}</span>
        </span>
      ))}
    </span>
  );
}
