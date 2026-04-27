import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { type Tone, softToneClasses, toneToIconTone } from "./shared";

export interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  children?: ReactNode;
  tone?: Tone;
}

export function Badge({
  children,
  tone = "neutral",
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1 rounded-tokenMd border px-2.5 py-1 text-xs font-semibold shadow-tokenSm",
        softToneClasses[tone]
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

export function Tag({
  children,
  tone = "neutral",
  onRemove,
  ...rest
}: TagProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-2 rounded-tokenMd border px-3 py-1 text-xs font-semibold shadow-tokenSm",
        softToneClasses[tone]
      )}
    >
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="focus-ring rounded-full"
          onClick={onRemove}
          aria-label={`Remove ${typeof children === "string" ? children : "tag"}`}
        >
          <Icon name="close" size="sm" tone={toneToIconTone(tone)} />
        </button>
      ) : null}
    </span>
  );
}
