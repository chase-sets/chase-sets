import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useChaseMotion } from "../theme/provider";
import type { MotionPreset, ViewTransitionPreset } from "./config";

export interface RevealProps {
  preset?: MotionPreset;
  delayMs?: number;
  layout?: boolean;
  children: ReactNode;
}

export function Reveal({ preset = "fade", delayMs = 0, layout = false, children }: RevealProps) {
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
        delay: motionSettings.reducedMotion ? 0 : delayMs / 1000,
      }}
    >
      {children}
    </motion.div>
  );
}

export type StaggerTrigger = "mount" | "in-view";

export interface StaggerProps {
  preset?: Exclude<MotionPreset, "slideRight">;
  staggerMs?: number;
  /**
   * When the sequence starts. `"mount"` (default) plays as soon as the group
   * mounts and server-renders the hidden state. `"in-view"` server-renders the
   * visible state and plays once, the first time the group scrolls into view.
   * Read on mount; later changes are ignored.
   */
  trigger?: StaggerTrigger;
  children: ReactNode;
}

/** Share of an armed in-view group that must be intersecting before it plays. */
const inViewPlayRatio = 0.4;

/**
 * Lifecycle of an in-view group. `visible` is the server, hydration and
 * pre-check state; `armed` is the hidden, waiting state; `done` is terminal.
 * Playing is the `armed → done` transition: Motion staggers the children to
 * visible when `animate` flips, and nothing here depends on it finishing.
 */
type InViewPhase = "visible" | "armed" | "done";

/**
 * Reveals its children in sequence through the Motion runtime `ChaseRoot` configures, on mount or once the group scrolls into view.
 *
 * With `trigger="in-view"` the group plays once: server markup and the first
 * client render show every child at the preset's visible state, so content reads
 * without JavaScript and hydration matches. One `IntersectionObserver` check runs
 * after mount. A group already intersecting the viewport (top of page, `#hash`
 * target), under reduced motion, or without `IntersectionObserver` support stays
 * visible and is done. Only a group entirely off-screen arms: its children jump
 * to the preset's hidden state with no transition. The first intersection at a
 * ratio of `0.4` or more plays the children to visible in order using
 * `staggerMs`, the observer disconnects, and later intersections, scrolling and
 * re-renders never replay or re-hide. A reduced-motion setting that resolves
 * after mount while the group is armed shows the children immediately.
 */
export function Stagger({ preset = "lift", staggerMs = 70, trigger = "mount", children }: StaggerProps) {
  const motionSettings = useChaseMotion();
  const nodes = Children.toArray(children);
  const staggerDelay = motionSettings.reducedMotion ? 0 : staggerMs / 1000;
  const definition = motionSettings.presets[preset];
  const inView = trigger === "in-view";
  const reducedMotion = motionSettings.reducedMotion;
  const groupRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(false);
  const [phase, setPhase] = useState<InViewPhase>("visible");

  useEffect(() => {
    if (!inView || settledRef.current) {
      return;
    }

    const settle = () => {
      settledRef.current = true;
      setPhase("done");
    };

    if (reducedMotion || typeof IntersectionObserver === "undefined" || groupRef.current === null) {
      settle();
      return;
    }

    let armed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (settledRef.current) {
            return;
          }

          if (!armed) {
            if (entry.isIntersecting || entry.intersectionRatio > 0) {
              observer.disconnect();
              settle();
              return;
            }

            armed = true;
            setPhase("armed");
            continue;
          }

          if (entry.intersectionRatio >= inViewPlayRatio) {
            observer.disconnect();
            settle();
            return;
          }
        }
      },
      { threshold: [0, inViewPlayRatio] },
    );

    observer.observe(groupRef.current);

    return () => observer.disconnect();
  }, [inView, reducedMotion]);

  return (
    <motion.div
      ref={groupRef}
      initial={inView ? "visible" : "hidden"}
      animate={inView && phase === "armed" ? "hidden" : "visible"}
      variants={{
        hidden: {},
        visible: {
          transition: {
            staggerChildren: staggerDelay,
            delayChildren: 0,
          },
        },
      }}
    >
      {nodes.map((child, index) => (
        <motion.div
          key={(child as { key?: string | number | null })?.key ?? index}
          variants={{
            hidden: inView ? { ...definition.initial, transition: { duration: 0 } } : definition.initial,
            visible: {
              ...definition.animate,
              transition: definition.transition,
            },
          }}
        >
          {child}
        </motion.div>
      ))}
    </motion.div>
  );
}

export interface ViewTransitionProps {
  transitionKey: string;
  preset?: ViewTransitionPreset;
  mode?: "wait" | "sync";
  children: ReactNode;
}

export function ViewTransition({ transitionKey, preset = "page", mode = "wait", children }: ViewTransitionProps) {
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
