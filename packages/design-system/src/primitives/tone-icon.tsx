import type { HTMLAttributes } from "react";
import { Icon, type IconName } from "../icons";
import { cx } from "../utils/cx";

/**
 * Tone vocabulary for tinted-circle icon badges. Mirrors the semantic half of
 * the `Surface` tone set so a status surface and its accompanying icon read the
 * same meaning from the token layer.
 */
export type ToneIconTone = "neutral" | "info" | "success" | "warning" | "danger" | "trust" | "primary";

export type ToneIconSize = "sm" | "md" | "lg";

/**
 * Tinted background + foreground token pair per tone. The wrapper carries
 * `text-{tone}` and the glyph inherits it (`tone="inherit"`), so the badge is
 * the canonical `bg-{tone}-soft text-{tone}` pair with no `color-mix` or hex.
 */
export const toneIconToneClasses: Record<ToneIconTone, string> = {
  neutral: "bg-surface-2 text-secondary",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  trust: "bg-trust-soft text-trust",
  primary: "bg-primary-soft text-primary",
};

export const toneIconSizeClasses: Record<ToneIconSize, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
  lg: "h-11 w-11",
};

const iconSize: Record<ToneIconSize, "sm" | "md" | "lg"> = {
  sm: "sm",
  md: "md",
  lg: "lg",
};

export interface ToneIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  name: IconName;
  tone?: ToneIconTone;
  size?: ToneIconSize;
  /** Accessible label for the icon. Omit for decorative badges. */
  label?: string;
}

/**
 * A tone-colored icon circle: a tinted-soft badge wrapping the design-system
 * `Icon`. Use it for status cues, protection callouts, and notice glyphs so the
 * tinted circle comes from one tokenized primitive instead of bespoke
 * `rounded-tokenFull bg-{tone}-soft` wrappers scattered across slices.
 */
export function ToneIcon({ name, tone = "neutral", size = "md", label, ...rest }: ToneIconProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-tokenFull",
        toneIconSizeClasses[size],
        toneIconToneClasses[tone],
      )}
    >
      <Icon name={name} size={iconSize[size]} tone="inherit" label={label} />
    </span>
  );
}
