import type { HTMLAttributes } from "react";
import { useId } from "react";
import { LayoutGroup } from "motion/react";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
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
  fullWidth?: boolean;
  onValueChange?: (value: string) => void;
}

export function SegmentedControl({ items, value, fullWidth = false, onValueChange, ...rest }: SegmentedControlProps) {
  const groupId = useId();

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
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
      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[next]?.focus();
    }
  }

  return (
    <LayoutGroup id={groupId}>
      <div
        {...rest}
        role="tablist"
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
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cx(
                "focus-ring relative inline-flex min-h-10 min-w-0 items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-semibold transition",
                fullWidth && "justify-center",
                active ? "text-accent" : "text-secondary hover:text-foreground",
              )}
              onClick={() => onValueChange?.(item.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {active ? renderActivePill(groupId, "accent") : null}
              {item.icon ? <Icon name={item.icon} size="sm" /> : null}
              <span className="relative z-10 min-w-0">{item.label}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
