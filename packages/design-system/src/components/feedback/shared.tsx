import type { IconName } from "../../icons";
import type { SurfaceSemanticTone } from "../../primitives/layout";
import type { ToneIconTone } from "../../primitives/tone-icon";
import { useControllableValue } from "../controllable";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/**
 * Commerce-facing accents that extend the semantic status {@link Tone} set for label-style
 * primitives (Badge/StatusPill/Tag). They map to the `--trust`/`--deal`/`--rating`
 * tokens and exist only as label accents — they are intentionally NOT part of {@link Tone},
 * which stays the canonical semantic set for banners, toasts, notices, and disclosures.
 */
export type CommerceAccentTone = "trust" | "deal" | "rating";

/** Tone set accepted by label primitives: every semantic {@link Tone} plus the commerce accents. */
export type BadgeTone = Tone | CommerceAccentTone;

export const toneClasses: Record<BadgeTone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-accent text-accent-contrast",
  success: "border-success bg-success text-success-contrast",
  warning: "border-warning bg-warning text-warning-contrast",
  danger: "border-danger bg-danger text-danger-contrast",
  info: "border-info bg-info text-info-contrast",
  trust: "border-trust bg-trust text-inverse",
  deal: "border-deal bg-deal text-inverse",
  rating: "border-rating bg-rating text-inverse",
};

export const softToneClasses: Record<BadgeTone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent-soft bg-accent-soft text-accent",
  success: "border-success-soft bg-success-soft text-success",
  warning: "border-warning-soft bg-warning-soft text-warning",
  danger: "border-danger-soft bg-danger-soft text-danger",
  info: "border-info-soft bg-info-soft text-info",
  trust: "border-trust-soft bg-trust-soft text-trust",
  deal: "border-deal-soft bg-deal-soft text-deal",
  rating: "border-rating-soft bg-rating-soft text-rating",
};

export const outlineToneClasses: Record<BadgeTone, string> = {
  neutral: "border-muted bg-transparent text-secondary",
  accent: "border-accent bg-transparent text-accent",
  success: "border-success bg-transparent text-success",
  warning: "border-warning bg-transparent text-warning",
  danger: "border-danger bg-transparent text-danger",
  info: "border-info bg-transparent text-info",
  trust: "border-trust bg-transparent text-trust",
  deal: "border-deal bg-transparent text-deal",
  rating: "border-rating bg-transparent text-rating",
};

export function toneIcon(tone: BadgeTone): IconName {
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
    case "trust":
      return "shield";
    case "deal":
      return "tag";
    case "rating":
      return "star";
    default:
      return "info";
  }
}

export function toneToIconTone(tone: BadgeTone) {
  return tone === "neutral" ? "secondary" : tone;
}

/**
 * Maps the semantic feedback {@link Tone} set onto the shared
 * {@link SurfaceSemanticTone}/{@link ToneIconTone} vocabulary used by tonal
 * `Surface` and `ToneIcon` primitives. `accent` resolves to the canonical
 * `primary` brand tone (they share the `--primary-soft` surface token).
 */
export function toneToSemantic(tone: Tone): SurfaceSemanticTone & ToneIconTone {
  return tone === "accent" ? "primary" : tone;
}

export function useControllableOpen(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange?: (open: boolean) => void,
) {
  return useControllableValue(open, defaultOpen ?? false, onOpenChange);
}
