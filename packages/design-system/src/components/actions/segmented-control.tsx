import type { HTMLAttributes, KeyboardEvent } from "react";
import { useId } from "react";
import { LayoutGroup } from "motion/react";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../control-sizing";
import { renderActivePill } from "./shared";

export interface SegmentedControlItem {
  value: string;
  label: string;
  icon?: IconName;
}

export interface SegmentedControlProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "onChange"
> {
  items: SegmentedControlItem[];
  value: string;
  label?: string;
  fullWidth?: boolean;
  onValueChange?: (value: string) => void;
}

export function SegmentedControl({
  items,
  value,
  label,
  fullWidth = false,
  onValueChange,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...rest
}: SegmentedControlProps) {
  const groupId = useId();

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % items.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next >= 0) {
      event.preventDefault();
      onValueChange?.(items[next].value);
      const container = event.currentTarget.parentElement;
      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      buttons?.[next]?.focus();
    }
  }

  return (
    <LayoutGroup id={groupId}>
      <div
        {...rest}
        role="radiogroup"
        aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : label)}
        aria-labelledby={ariaLabelledBy}
        className={cx(
          "rounded-tokenLg border border-muted bg-background p-1",
          fullWidth ? "grid w-full grid-cols-2 sm:grid-flow-col sm:auto-cols-fr" : "inline-flex flex-wrap",
        )}
      >
        {items.map((item, index) => {
          const active = item.value === value;

          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              className={cx(
                "focus-ring relative inline-flex min-w-0 items-center gap-2 overflow-hidden rounded-tokenMd font-semibold transition",
                controlHeightClasses.md,
                controlPaddingClasses.md,
                controlTextClasses.md,
                fullWidth && "justify-center",
                active ? "text-accent" : "text-secondary hover:text-foreground",
              )}
              onClick={() => onValueChange?.(item.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {active ? renderActivePill(groupId, "accent") : null}
              <span className="relative z-10 inline-flex min-w-0 items-center gap-2">
                {item.icon ? <Icon name={item.icon} size="sm" tone="inherit" /> : null}
                <span className="min-w-0">{item.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
