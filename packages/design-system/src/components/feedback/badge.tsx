import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { type BadgeTone, outlineToneClasses, softToneClasses, toneClasses, toneToIconTone } from "./shared";

export type BadgeVariant = "soft" | "solid" | "outline";

const variantToneClasses: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: softToneClasses,
  solid: toneClasses,
  outline: outlineToneClasses,
};

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  children?: ReactNode;
  tone?: BadgeTone;
  variant?: BadgeVariant;
}

export function Badge({ children, tone = "neutral", variant = "soft", ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1 rounded-tokenMd border px-2.5 py-1 text-xs font-semibold shadow-tokenSm",
        variantToneClasses[variant][tone],
      )}
    >
      {children}
    </span>
  );
}

export interface StatusPillProps extends BadgeProps {}

export function StatusPill(props: StatusPillProps) {
  return <Badge {...props} />;
}

export interface TagProps extends BadgeProps {
  onRemove?: () => void;
}

export function Tag({ children, tone = "neutral", variant = "soft", onRemove, ...rest }: TagProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-2 rounded-tokenMd border px-3 py-1 text-xs font-semibold shadow-tokenSm",
        variantToneClasses[variant][tone],
      )}
    >
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="focus-ring rounded-tokenFull"
          onClick={onRemove}
          aria-label={`Remove ${typeof children === "string" ? children : "tag"}`}
        >
          <Icon name="close" size="sm" tone={toneToIconTone(tone)} />
        </button>
      ) : null}
    </span>
  );
}
