import type { TargetAndTransition, Transition } from "motion/react";
import type { ChaseMotionSettings } from "../../motion/config";

export interface OverlayMotionProps {
  initial: false | TargetAndTransition;
  animate: undefined | TargetAndTransition;
  transition: Transition | undefined;
}

export function resolveOverlayMotion(
  settings: ChaseMotionSettings,
  open: boolean,
  enterValues: TargetAndTransition,
  exitValues: TargetAndTransition,
  initialValues?: TargetAndTransition,
  speed: "fast" | "base" | "slow" = "fast",
): OverlayMotionProps {
  if (settings.reducedMotion) {
    return { initial: false, animate: undefined, transition: undefined };
  }

  return {
    initial: initialValues ?? exitValues,
    animate: open ? enterValues : exitValues,
    transition: { duration: settings.durations[speed], ease: settings.easing },
  };
}

export function resolveOverlayFade(
  settings: ChaseMotionSettings,
  open: boolean,
  speed: "fast" | "base" | "slow" = "base",
): OverlayMotionProps {
  return {
    initial: false,
    animate: settings.reducedMotion ? undefined : open ? { opacity: 1 } : { opacity: 0 },
    transition: settings.reducedMotion ? undefined : { duration: settings.durations[speed], ease: settings.easing },
  };
}
