import type { IconName } from "../../icons";
import { useControllableValue } from "../controllable";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export const toneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-accent text-accent-contrast",
  success: "border-success bg-success text-success-contrast",
  warning: "border-warning bg-warning text-warning-contrast",
  danger: "border-danger bg-danger text-danger-contrast",
  info: "border-info bg-info text-info-contrast",
};

export const softToneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent-soft bg-accent-soft text-accent",
  success: "border-success-soft bg-success-soft text-success",
  warning: "border-warning-soft bg-warning-soft text-warning",
  danger: "border-danger-soft bg-danger-soft text-danger",
  info: "border-info-soft bg-info-soft text-info",
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
  onOpenChange?: (open: boolean) => void,
) {
  return useControllableValue(open, defaultOpen ?? false, onOpenChange);
}
