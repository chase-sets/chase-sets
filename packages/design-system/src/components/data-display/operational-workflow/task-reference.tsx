import { type HTMLAttributes, type ReactNode } from "react";
import { CopyButton } from "../../actions/copy-button";

export interface TaskReferenceProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label: ReactNode;
  value: string;
  displayValue?: ReactNode;
  copyLabel?: string;
  copiedLabel?: string;
}

/**
 * Task reference chip: a compact inline pill that surfaces an identifier (order
 * line, profile, SKU) with a copy control, used to tie a workstation row back
 * to its source record.
 */
export function TaskReference({
  label,
  value,
  displayValue,
  copyLabel = "Copy",
  copiedLabel = "Copied",
  ...rest
}: TaskReferenceProps) {
  return (
    <div {...rest} className="inline-flex min-w-0 items-center gap-1.5 rounded-tokenSm bg-background px-2 py-1">
      <span className="text-2xs font-medium uppercase text-tertiary">{label}</span>
      <span className="min-w-0 font-mono text-xs text-secondary">{displayValue ?? value}</span>
      <CopyButton value={value} label={copyLabel} copiedLabel={copiedLabel} size="sm" tone="ghost" />
    </div>
  );
}
