import type { ReactNode } from "react";
import { LayoutGroup, motion } from "motion/react";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../control-sizing";
import { cx } from "../../utils/cx";

export type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonToneClasses: Record<ButtonTone, string> = {
  primary:
    "border-transparent bg-accent text-accent-contrast shadow-tokenSm hover:bg-accent-hover hover:shadow-tokenMd",
  secondary: "border-border bg-surface-2 text-foreground hover:border-accent hover:text-accent",
  ghost:
    "border-transparent bg-transparent text-secondary hover:border-border hover:bg-surface-2 hover:text-foreground",
  danger: "border-transparent bg-danger text-danger-contrast hover:bg-danger-hover",
};

export const buttonSizeClasses: Record<ButtonSize, string> = {
  sm: cx(controlHeightClasses.sm, controlPaddingClasses.sm, controlTextClasses.sm),
  md: cx(controlHeightClasses.md, controlPaddingClasses.md, controlTextClasses.md),
  lg: cx(controlHeightClasses.lg, controlPaddingClasses.lg, controlTextClasses.lg),
};

export const buttonBaseClass =
  "focus-ring relative inline-flex min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden whitespace-normal text-center rounded-tokenMd border font-semibold leading-snug shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-disabled disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:opacity-disabled aria-disabled:shadow-none";

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

export function renderActivePillGroup(id: string, reducedMotion: boolean, children: ReactNode) {
  if (reducedMotion) {
    return <>{children}</>;
  }

  return <LayoutGroup id={id}>{children}</LayoutGroup>;
}

export function renderActivePill(groupId: string, tone: "default" | "accent" = "default", reducedMotion = false) {
  const className = cx(
    "absolute inset-0 rounded-tokenMd",
    tone === "accent" ? "bg-surface-2 shadow-tokenSm" : "bg-surface-2 shadow-tokenSm",
  );

  if (reducedMotion) {
    return <motion.span aria-hidden="true" className={className} />;
  }

  return <motion.span layoutId={`${groupId}-active-pill`} className={className} transition={{ duration: 0.18 }} />;
}
