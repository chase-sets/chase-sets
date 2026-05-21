import { type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, type FieldFrameProps } from "./shared";

export interface FieldProps extends FieldFrameProps {}

export function Field(props: FieldProps) {
  return <FieldChrome {...props} />;
}

export interface HelperTextProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  tone?: "default" | "danger" | "success";
}

export function HelperText({ children, tone = "default", ...rest }: HelperTextProps) {
  return (
    <div
      {...rest}
      className={cx(
        "text-xs",
        tone === "default" && "text-secondary",
        tone === "danger" && "text-danger",
        tone === "success" && "text-success",
      )}
    >
      {children}
    </div>
  );
}

export interface InlineMessageProps extends HelperTextProps {
  icon?: "info" | "warning" | "check";
}

export function InlineMessage({ children, icon = "info", tone = "default", ...rest }: InlineMessageProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex items-start gap-2 rounded-tokenMd border px-3 py-2 text-sm",
        tone === "default" && "border-info bg-background text-info",
        tone === "danger" && "border-danger bg-background text-danger",
        tone === "success" && "border-success bg-background text-success",
      )}
    >
      <Icon name={icon} size="sm" tone={tone === "default" ? "info" : tone} />
      <span>{children}</span>
    </div>
  );
}
