import { type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../../../utils/cx";
import { Stack } from "../../../primitives/layout";
import { Caption } from "../../../primitives/typography";
import { IconButton } from "../../actions/button";
import { controlHeightClasses } from "../../control-sizing";

export interface QuantityChecklistControlProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "onChange"
> {
  value: number;
  total: number;
  valueLabel?: ReactNode;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  onChange?: (value: number) => void;
}

/**
 * Quantity checklist stepper: a bounded increment/decrement control showing a
 * packed-of-total count that turns success-toned on completion, used to track
 * partial fulfillment of a line item.
 */
export function QuantityChecklistControl({
  value,
  total,
  valueLabel,
  decreaseLabel,
  increaseLabel,
  disabled = false,
  onChange,
  ...rest
}: QuantityChecklistControlProps) {
  const resolvedValue = Math.max(0, Math.min(total, value));
  const isComplete = total > 0 && resolvedValue >= total;

  return (
    <Stack {...rest} gap={2} align="end">
      <div
        className={cx(
          "inline-flex items-center gap-2 rounded-tokenMd border border-muted bg-background p-1",
          controlHeightClasses.md,
          isComplete && "border-success",
        )}
      >
        <IconButton
          label={decreaseLabel}
          icon="minus"
          tone="secondary"
          size="sm"
          disabled={disabled || resolvedValue <= 0}
          onClick={() => onChange?.(resolvedValue - 1)}
        />
        <span className="min-w-14 text-center text-sm font-semibold tabular-nums text-foreground">
          {resolvedValue}/{total}
        </span>
        <IconButton
          label={increaseLabel}
          icon="plus"
          tone="secondary"
          size="sm"
          disabled={disabled || resolvedValue >= total}
          onClick={() => onChange?.(resolvedValue + 1)}
        />
      </div>
      {valueLabel ? (
        <Caption element="div" tone="secondary">
          {valueLabel}
        </Caption>
      ) : null}
    </Stack>
  );
}
