import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { Icon, type IconName } from "../../icons";
import { cx } from "../../utils/cx";
import { compactControlPaddingClasses, controlHeightClasses, controlTextClasses } from "../control-sizing";

export interface ToolbarProps {
  children?: ReactNode;
  label?: string;
  orientation?: "horizontal" | "vertical";
}

export function Toolbar({ children, label, orientation = "horizontal" }: ToolbarProps) {
  return (
    <ToolbarPrimitive.Root
      aria-label={label}
      orientation={orientation}
      className={cx(
        "inline-flex items-center gap-1 rounded-tokenLg border border-muted bg-surface-2 p-1",
        orientation === "vertical" && "flex-col items-stretch",
      )}
    >
      {children}
    </ToolbarPrimitive.Root>
  );
}

export interface ToolbarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  icon?: IconName;
}

export function ToolbarButton({ children, icon, type = "button", ...rest }: ToolbarButtonProps) {
  return (
    <ToolbarPrimitive.Button
      {...rest}
      type={type}
      className={cx(
        "focus-ring inline-flex items-center justify-center gap-2 rounded-tokenMd font-semibold text-secondary transition hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-disabled",
        controlHeightClasses.md,
        compactControlPaddingClasses.md,
        controlTextClasses.md,
      )}
    >
      {icon ? <Icon name={icon} size="sm" tone="secondary" /> : null}
      {children ? <span>{children}</span> : null}
    </ToolbarPrimitive.Button>
  );
}

export interface ToolbarInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style"> {}

export function ToolbarInput(props: ToolbarInputProps) {
  return (
    <ToolbarPrimitive.Input
      {...props}
      className={cx(
        "focus-ring w-44 rounded-tokenMd border border-muted bg-elevated text-foreground placeholder:text-secondary",
        controlHeightClasses.md,
        compactControlPaddingClasses.md,
        controlTextClasses.md,
      )}
    />
  );
}

export function ToolbarSeparator() {
  return <ToolbarPrimitive.Separator className="mx-1 h-5 w-px bg-muted" />;
}
