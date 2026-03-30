import type { TargetAndTransition, Transition } from "motion/react";
import { chaseTheme, resolveTheme, type ThemeOverrides } from "../theme/tokens";

export type ReducedMotionSetting = "user" | "always" | "never";
export type MotionPreset = "fade" | "lift" | "scale" | "slideUp" | "slideRight";
export type ViewTransitionPreset = "page" | "panel";

export interface MotionDurations {
  fast: number;
  base: number;
  slow: number;
}

export type MotionEase = [number, number, number, number];

export interface MotionPresetDefinition {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

export interface ChaseMotionSettings {
  reducedMotion: boolean;
  reducedMotionSetting: ReducedMotionSetting;
  durations: MotionDurations;
  easing: MotionEase;
  presets: Record<MotionPreset, MotionPresetDefinition>;
  viewPresets: Record<ViewTransitionPreset, MotionPresetDefinition>;
  interactiveScale: number;
  interactiveLift: number;
}

function parseDurationSeconds(value: string | undefined, fallbackMs: number): number {
  if (!value) {
    return fallbackMs / 1000;
  }

  const trimmed = value.trim();
  const number = Number.parseFloat(trimmed);

  if (!Number.isFinite(number)) {
    return fallbackMs / 1000;
  }

  if (trimmed.endsWith("ms")) {
    return number / 1000;
  }

  if (trimmed.endsWith("s")) {
    return number;
  }

  return number / 1000;
}

function parseEase(value: string | undefined): MotionEase {
  const match = value?.match(/cubic-bezier\(([^)]+)\)/i);

  if (!match) {
    return [0.16, 1, 0.3, 1];
  }

  const parsed = match[1]
    .split(",")
    .map((segment) => Number.parseFloat(segment.trim()))
    .filter((segment) => Number.isFinite(segment));

  if (parsed.length !== 4) {
    return [0.16, 1, 0.3, 1];
  }

  return parsed as MotionEase;
}

function buildPreset(
  initial: TargetAndTransition,
  animate: TargetAndTransition,
  exit: TargetAndTransition,
  transition: Transition
): MotionPresetDefinition {
  return { initial, animate, exit, transition };
}

export function resolveChaseMotion(
  theme?: ThemeOverrides,
  reducedMotionSetting: ReducedMotionSetting = "user",
  reducedMotion = false
): ChaseMotionSettings {
  const resolvedTheme = resolveTheme(theme, chaseTheme);
  const durations: MotionDurations = {
    fast: parseDurationSeconds(resolvedTheme.motion.fast, 120),
    base: parseDurationSeconds(resolvedTheme.motion.base, 180),
    slow: parseDurationSeconds(resolvedTheme.motion.slow, 260)
  };
  const easing = parseEase(resolvedTheme.motion.ease);
  const inertTransition: Transition = { duration: 0.01, ease: "linear" };

  if (reducedMotion) {
    const subtle = buildPreset(
      { opacity: 0 },
      { opacity: 1 },
      { opacity: 0 },
      inertTransition
    );

    return {
      reducedMotion,
      reducedMotionSetting,
      durations,
      easing,
      interactiveScale: 1,
      interactiveLift: 0,
      presets: {
        fade: subtle,
        lift: subtle,
        scale: subtle,
        slideUp: subtle,
        slideRight: subtle
      },
      viewPresets: {
        page: subtle,
        panel: subtle
      }
    };
  }

  const fastTween: Transition = { duration: durations.fast, ease: easing };
  const baseTween: Transition = { duration: durations.base, ease: easing };
  const slowTween: Transition = { duration: durations.slow, ease: easing };

  return {
    reducedMotion,
    reducedMotionSetting,
    durations,
    easing,
    interactiveScale: 1.015,
    interactiveLift: -4,
    presets: {
      fade: buildPreset({ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, fastTween),
      lift: buildPreset(
        { opacity: 0, y: 14, scale: 0.985 },
        { opacity: 1, y: 0, scale: 1 },
        { opacity: 0, y: 10, scale: 0.99 },
        baseTween
      ),
      scale: buildPreset(
        { opacity: 0, scale: 0.96 },
        { opacity: 1, scale: 1 },
        { opacity: 0, scale: 0.98 },
        baseTween
      ),
      slideUp: buildPreset(
        { opacity: 0, y: 22 },
        { opacity: 1, y: 0 },
        { opacity: 0, y: 18 },
        baseTween
      ),
      slideRight: buildPreset(
        { opacity: 0, x: 26 },
        { opacity: 1, x: 0 },
        { opacity: 0, x: 20 },
        slowTween
      )
    },
    viewPresets: {
      page: buildPreset(
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0 },
        { opacity: 0, y: 16 },
        slowTween
      ),
      panel: buildPreset(
        { opacity: 0, x: 20 },
        { opacity: 1, x: 0 },
        { opacity: 0, x: 12 },
        baseTween
      )
    }
  };
}
