import { motion } from "motion/react";
import { cx } from "../../utils/cx";

export type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonToneClasses: Record<ButtonTone, string> = {
  primary:
    "border-transparent bg-accent text-accent-contrast hover:bg-accent-hover",
  secondary:
    "border-border bg-elevated text-foreground hover:border-accent hover:text-accent",
  ghost:
    "border-transparent bg-transparent text-secondary hover:border-border hover:bg-background hover:text-foreground",
  danger:
    "border-transparent bg-danger text-inverse hover:bg-danger-hover"
};

export const buttonSizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3 text-xs",
  md: "min-h-10 px-4 text-sm",
  lg: "min-h-12 px-5 text-base"
};

export const buttonCompactSizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-7 px-2.5 text-xs",
  md: "min-h-8 px-3 text-sm",
  lg: "min-h-10 px-4 text-sm"
};

export const buttonBaseClass =
  "focus-ring relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-tokenMd border font-semibold shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none";

export function resolveInteractiveMotion(reducedMotion: boolean, scale: number, lift: number) {
  if (reducedMotion) {
    return undefined;
  }

  return {
    whileHover: { y: lift, scale },
    whileTap: { y: 0, scale: 0.985 },
    transition: { duration: 0.18 }
  };
}

export function renderActivePill(groupId: string, tone: "default" | "accent" = "default") {
  return (
    <motion.span
      layoutId={`${groupId}-active-pill`}
      className={cx(
        "absolute inset-0 rounded-tokenMd",
        tone === "accent" ? "bg-elevated shadow-tokenSm" : "bg-background shadow-tokenSm"
      )}
      transition={{ duration: 0.18 }}
    />
  );
}
