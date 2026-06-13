import type { IconName } from "../../icons";
import { useControllableValue } from "../controllable";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export const toneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-accent text-accent-contrast",
  success: "border-success bg-success text-inverse",
  warning: "border-warning bg-warning text-inverse",
  danger: "border-danger bg-danger text-inverse",
  info: "border-info bg-info text-inverse",
};

export const softToneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent/40 bg-accent/8 text-accent",
  success: "border-success/40 bg-success/8 text-success",
  warning: "border-warning/40 bg-warning/8 text-warning",
  danger: "border-danger/40 bg-danger/8 text-danger",
  info: "border-info/40 bg-info/8 text-info",
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
