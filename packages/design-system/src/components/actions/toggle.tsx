import type { ReactNode } from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../utils/cx";
import type { ButtonSize } from "./shared";
import { buttonBaseClass, buttonSizeClasses } from "./shared";

export interface ToggleProps {
  children?: ReactNode;
  value?: string;
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  disabled?: boolean;
  size?: ButtonSize;
  icon?: IconName;
  "aria-label"?: string;
}

export function Toggle({
  children,
  value,
  pressed,
  defaultPressed,
  onPressedChange,
  disabled = false,
  size = "md",
  icon,
  "aria-label": ariaLabel,
}: ToggleProps) {
  return (
    <TogglePrimitive
      type="button"
      value={value}
      pressed={pressed}
      defaultPressed={defaultPressed}
      onPressedChange={(nextPressed) => onPressedChange?.(nextPressed)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={(state) =>
        cx(
          buttonBaseClass,
          buttonSizeClasses[size],
          state.pressed
            ? "border-accent bg-accent text-accent-contrast"
            : "border-border bg-surface-2 text-secondary hover:border-accent hover:text-accent",
          state.disabled && "cursor-not-allowed opacity-disabled shadow-none",
        )
      }
    >
      {icon ? <Icon name={icon} size="sm" tone="inherit" /> : null}
      {children ? <span>{children}</span> : null}
    </TogglePrimitive>
  );
}

export interface ToggleGroupItem {
  value: string;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
}

export interface ToggleGroupProps {
  items: ToggleGroupItem[];
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[]) => void;
  multiple?: boolean;
  orientation?: "horizontal" | "vertical";
  disabled?: boolean;
  label?: string;
  size?: ButtonSize;
}

export function ToggleGroup({
  items,
  value,
  defaultValue,
  onValueChange,
  multiple = false,
  orientation = "horizontal",
  disabled = false,
  label,
  size = "sm",
}: ToggleGroupProps) {
  return (
    <ToggleGroupPrimitive
      value={value}
      defaultValue={defaultValue}
      onValueChange={(nextValue) => onValueChange?.(nextValue)}
      multiple={multiple}
      orientation={orientation}
      disabled={disabled}
      aria-label={label}
      className={cx("inline-flex gap-2 rounded-tokenLg bg-surface-2 p-1", orientation === "vertical" && "flex-col")}
    >
      {items.map((item) => (
        <TogglePrimitive
          key={item.value}
          type="button"
          value={item.value}
          disabled={item.disabled}
          className={(state) =>
            cx(
              buttonBaseClass,
              buttonSizeClasses[size],
              state.pressed
                ? "border-accent bg-elevated text-accent shadow-tokenSm"
                : "border-transparent bg-transparent text-secondary shadow-none hover:bg-elevated hover:text-foreground",
              state.disabled && "cursor-not-allowed opacity-disabled",
            )
          }
        >
          {item.icon ? <Icon name={item.icon} size="sm" tone="inherit" /> : null}
          <span>{item.label}</span>
        </TogglePrimitive>
      ))}
    </ToggleGroupPrimitive>
  );
}
