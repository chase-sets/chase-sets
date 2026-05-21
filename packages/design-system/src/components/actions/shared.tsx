import { motion } from "motion/react";
import { cx } from "../../utils/cx";

export type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonToneClasses: Record<ButtonTone, string> = {
  primary:
    "border-transparent bg-accent text-accent-contrast shadow-[0_0_22px_-12px_var(--glow-accent)] hover:bg-accent-hover hover:shadow-[0_0_30px_-12px_var(--glow-accent)]",
  secondary: "border-border bg-surface-2 text-foreground hover:border-accent hover:text-accent",
  ghost:
    "border-transparent bg-transparent text-secondary hover:border-border hover:bg-surface-2 hover:text-foreground",
  danger: "border-transparent bg-danger text-inverse hover:bg-danger-hover",
};

export const buttonSizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3 text-xs",
  md: "min-h-10 px-4 text-sm",
  lg: "min-h-12 px-5 text-base",
};

export const buttonCompactSizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-7 px-2.5 text-xs",
  md: "min-h-8 px-3 text-sm",
  lg: "min-h-10 px-4 text-sm",
};

export const buttonBaseClass =
  "focus-ring relative inline-flex min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden whitespace-normal text-center rounded-tokenMd border font-semibold leading-snug shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";

export function resolveInteractiveMotion(reducedMotion: boolean, scale: number, lift: number) {
  if (reducedMotion) {
    return undefined;
  }

  return {
    whileHover: { y: lift, scale },
    whileTap: { y: 0, scale: 0.985 },
    transition: { duration: 0.18 },
  };
}

export function renderActivePill(groupId: string, tone: "default" | "accent" = "default") {
  return (
    <motion.span
      layoutId={`${groupId}-active-pill`}
      className={cx(
        "absolute inset-0 rounded-tokenMd",
        tone === "accent" ? "bg-surface-2 shadow-tokenSm" : "bg-surface-2 shadow-tokenSm",
      )}
      transition={{ duration: 0.18 }}
    />
  );
}
