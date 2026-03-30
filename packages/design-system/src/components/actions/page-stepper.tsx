import type { HTMLAttributes } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";

export interface PageStepperItem {
  label: string;
  description?: string;
  status: "complete" | "current" | "upcoming";
}

export interface PageStepperProps
  extends Omit<HTMLAttributes<HTMLOListElement>, "className" | "style"> {
  items: PageStepperItem[];
}

export function PageStepper({
  items,
  ...rest
}: PageStepperProps) {
  return (
    <ol
      {...rest}
      className="grid gap-3 md:grid-cols-3"
    >
      {items.map((item, index) => (
        <li
          key={`${item.label}-${index}`}
          className={cx(
            "rounded-tokenLg border p-4 shadow-tokenSm",
            item.status === "complete" && "border-success bg-elevated",
            item.status === "current" && "border-accent bg-elevated",
            item.status === "upcoming" && "border-muted bg-background"
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cx(
                "inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                item.status === "complete" && "bg-success text-inverse",
                item.status === "current" && "bg-accent text-accent-contrast",
                item.status === "upcoming" && "bg-muted text-secondary"
              )}
            >
              {item.status === "complete" ? <Icon name="check" size="sm" /> : index + 1}
            </span>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">{item.label}</div>
              {item.description ? (
                <div className="text-xs text-secondary">{item.description}</div>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
