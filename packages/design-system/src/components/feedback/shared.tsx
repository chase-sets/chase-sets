import { useState } from "react";
import type { IconName } from "../../icons";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export const toneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-accent text-accent-contrast",
  success: "border-success bg-success text-inverse",
  warning: "border-warning bg-warning text-inverse",
  danger: "border-danger bg-danger text-inverse",
  info: "border-info bg-info text-inverse"
};

export const softToneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-background text-accent",
  success: "border-success bg-background text-success",
  warning: "border-warning bg-background text-warning",
  danger: "border-danger bg-background text-danger",
  info: "border-info bg-background text-info"
};

export function toneIcon(tone: Tone): IconName {
  switch (tone) {
    case "success":
      return "check";
    case "warning":
      return "warning";
    case "danger":
      return "warning";
    case "info":
      return "info";
    case "accent":
      return "spark";
    default:
      return "info";
  }
}

export function toneToIconTone(tone: Tone) {
  return tone === "neutral" ? "secondary" : tone;
}

export function useControllableOpen(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange?: (open: boolean) => void
) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const resolvedOpen = open ?? internalOpen;

  function handleOpenChange(nextOpen: boolean) {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }

  return [resolvedOpen, handleOpenChange] as const;
}
