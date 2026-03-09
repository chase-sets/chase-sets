import { Children, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useChaseMotion } from "../theme/provider";
import type { MotionPreset, ViewTransitionPreset } from "./config";

export interface RevealProps {
  preset?: MotionPreset;
  delayMs?: number;
  layout?: boolean;
  children: ReactNode;
}

export function Reveal({
  preset = "fade",
  delayMs = 0,
  layout = false,
  children
}: RevealProps) {
  const motionSettings = useChaseMotion();
  const definition = motionSettings.presets[preset];

  return (
    <motion.div
      layout={layout}
      initial={definition.initial}
      animate={definition.animate}
      exit={definition.exit}
      transition={{
        ...definition.transition,
        delay: motionSettings.reducedMotion ? 0 : delayMs / 1000
      }}
    >
      {children}
    </motion.div>
  );
}

export interface StaggerProps {
  preset?: Exclude<MotionPreset, "slideRight">;
  staggerMs?: number;
  children: ReactNode;
}

export function Stagger({
  preset = "lift",
  staggerMs = 70,
  children
}: StaggerProps) {
  const motionSettings = useChaseMotion();
  const nodes = Children.toArray(children);
  const staggerDelay = motionSettings.reducedMotion ? 0 : staggerMs / 1000;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: {
          transition: {
            staggerChildren: staggerDelay,
            delayChildren: 0
          }
        }
      }}
    >
      {nodes.map((child, index) => {
        const definition = motionSettings.presets[preset];

        return (
          <motion.div
            key={(child as { key?: string | number | null })?.key ?? index}
            variants={{
              hidden: definition.initial,
              visible: {
                ...definition.animate,
                transition: definition.transition
              }
            }}
          >
            {child}
          </motion.div>
        );
      })}
    </motion.div>
  );
}

export interface ViewTransitionProps {
  transitionKey: string;
  preset?: ViewTransitionPreset;
  mode?: "wait" | "sync";
  children: ReactNode;
}

export function ViewTransition({
  transitionKey,
  preset = "page",
  mode = "wait",
  children
}: ViewTransitionProps) {
  const motionSettings = useChaseMotion();
  const definition = motionSettings.viewPresets[preset];

  return (
    <AnimatePresence initial={false} mode={mode}>
      <motion.div
        key={transitionKey}
        initial={definition.initial}
        animate={definition.animate}
        exit={definition.exit}
        transition={definition.transition}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
