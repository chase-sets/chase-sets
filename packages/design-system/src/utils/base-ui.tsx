import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { motion } from "motion/react";
import { cx } from "./cx";

type MotionDivProps = ComponentProps<typeof motion.div>;

interface MotionDivRenderOptions<State> {
  className?: string | ((baseClassName: string | undefined, state: State) => string | undefined);
  initial?: MotionDivProps["initial"];
  animate?: MotionDivProps["animate"];
  exit?: MotionDivProps["exit"];
  transition?: MotionDivProps["transition"];
}

export function renderMotionDiv<State = unknown>({
  className,
  initial,
  animate,
  exit,
  transition,
}: MotionDivRenderOptions<State>) {
  return function MotionDivRenderer(props: ComponentProps<"div"> & { ref?: MotionDivProps["ref"] }, state: State) {
    const resolvedClassName =
      typeof className === "function" ? className(props.className, state) : cx(className, props.className);

    return (
      <motion.div
        {...(props as MotionDivProps)}
        initial={initial}
        animate={animate}
        exit={exit}
        transition={transition}
        className={resolvedClassName}
      />
    );
  };
}

export function renderButtonTrigger(node: ReactNode): ReactElement {
  return isValidElement(node) ? node : <button type="button">{node}</button>;
}

export function renderInlineTrigger(node: ReactNode): ReactElement {
  return isValidElement(node) ? node : <span>{node}</span>;
}
