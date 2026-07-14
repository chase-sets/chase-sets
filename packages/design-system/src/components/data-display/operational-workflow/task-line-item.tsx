import { type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "../../../icons";
import { Grid, Inline, Stack } from "../../../primitives/layout";
import { Text } from "../../../primitives/typography";
import { cx } from "../../../utils/cx";
import { controlSquareSizeClasses } from "../../control-sizing";

export interface TaskLineItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  quantity: ReactNode;
  quantityLabel?: ReactNode;
  quantityDetail?: ReactNode;
  quantityControl?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  meta?: ReactNode;
  reference?: ReactNode;
  media?: ReactNode;
  status?: "idle" | "saving" | "saved" | "error" | "matched";
  statusLabel?: ReactNode;
  checkboxLabel: string;
  onCheckedChange?: (checked: boolean) => void;
}

const statusLabelToneClass: Record<NonNullable<TaskLineItemProps["status"]>, string> = {
  idle: "text-tertiary",
  saving: "text-info",
  saved: "text-success",
  error: "text-danger",
  matched: "text-accent",
};

/**
 * Task line item: a checkable fulfillment row pairing a packed toggle, media
 * thumbnail, item detail, and a quantity readout or stepper, tone-coded by save
 * status, used inside a packing checklist.
 */
export function TaskLineItem({
  title,
  subtitle,
  description,
  quantity,
  quantityLabel = "Qty",
  quantityDetail,
  quantityControl,
  checked,
  disabled = false,
  meta,
  reference,
  media,
  status = "idle",
  statusLabel,
  checkboxLabel,
  onCheckedChange,
  ...rest
}: TaskLineItemProps) {
  return (
    <div
      {...rest}
      className={cx(
        "grid cursor-pointer gap-3 rounded-tokenMd border border-muted bg-elevated p-3 transition-colors md:grid-cols-[auto_minmax(0,1fr)_auto]",
        checked && "border-success",
        status === "saving" && "border-info",
        status === "error" && "border-danger",
        status === "matched" && "border-accent",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <button
        type="button"
        className={cx(
          "focus-ring inline-flex shrink-0 items-center justify-center rounded-tokenFull border border-border bg-background transition-shadow",
          controlSquareSizeClasses.md,
          checked && "border-success bg-success text-success-contrast",
          !onCheckedChange && "pointer-events-none",
        )}
        aria-pressed={checked}
        disabled={disabled}
        aria-label={checkboxLabel}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {checked ? <Icon name="check" size="sm" tone="inverse" /> : <Icon name="package" size="sm" tone="secondary" />}
      </button>
      <Grid templateColumns="auto minmax(0,1fr)" stackUntil="md" gap={2}>
        <div className="flex h-16 w-12 items-center justify-center overflow-hidden rounded-tokenSm border border-muted bg-background text-secondary">
          {media ?? <Icon name="package" size="md" tone="secondary" />}
        </div>
        <Stack gap={1} minWidth="0">
          <Text size="md" weight="semibold">
            {title}
          </Text>
          {subtitle ? (
            <Text size="sm" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
          {description ? (
            <Text size="sm" tone="secondary">
              {description}
            </Text>
          ) : null}
          {meta ? <Inline gap={2}>{meta}</Inline> : null}
          {reference ? <Inline gap={2}>{reference}</Inline> : null}
          {statusLabel ? (
            <span className={cx("pt-1 text-xs font-medium", statusLabelToneClass[status])}>{statusLabel}</span>
          ) : null}
        </Stack>
      </Grid>
      <div className="flex items-center justify-between gap-3 md:flex-col md:items-end md:justify-center">
        {quantityControl ? (
          quantityControl
        ) : (
          <>
            <span className="text-xs font-medium uppercase text-tertiary">{quantityLabel}</span>
            <span className="text-2xl font-bold leading-none text-foreground">{quantity}</span>
          </>
        )}
        {quantityDetail ? <span className="text-xs leading-5 text-tertiary">{quantityDetail}</span> : null}
      </div>
    </div>
  );
}
