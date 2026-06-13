import type { ResponsiveValue, SpaceToken as ThemeSpaceToken } from "../theme/tokens";
import { cx } from "./cx";

export type { SpaceToken } from "../theme/tokens";

export type AlignValue = "start" | "center" | "end" | "stretch";
export type JustifyValue = "start" | "center" | "end" | "between" | "around";
export type TextAlignValue = "left" | "center" | "right";
export type DirectionValue = "row" | "column";

type BreakpointKey = "base" | "sm" | "md" | "lg" | "xl" | "2xl";
type BreakpointClassMap<T extends string | number> = Record<`${T}`, Record<BreakpointKey, string>>;

export interface SystemProps {
  padding?: ThemeSpaceToken;
  paddingX?: ThemeSpaceToken;
  paddingY?: ThemeSpaceToken;
  gap?: ThemeSpaceToken;
  textAlign?: TextAlignValue;
}

const breakpoints: BreakpointKey[] = ["base", "sm", "md", "lg", "xl", "2xl"];

const textAlignClasses: Record<TextAlignValue, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/* ------------------------------------------------------------------
 * Tailwind scans source files statically for class names. Every
 * responsive class MUST appear as a full literal string — never
 * assembled via interpolation — or the CSS will not be generated.
 * ----------------------------------------------------------------*/

const directionClasses: BreakpointClassMap<DirectionValue> = {
  row: {
    base: "flex-row",
    sm: "sm:flex-row",
    md: "md:flex-row",
    lg: "lg:flex-row",
    xl: "xl:flex-row",
    "2xl": "2xl:flex-row",
  },
  column: {
    base: "flex-col",
    sm: "sm:flex-col",
    md: "md:flex-col",
    lg: "lg:flex-col",
    xl: "xl:flex-col",
    "2xl": "2xl:flex-col",
  },
};

const alignClasses: BreakpointClassMap<AlignValue> = {
  start: {
    base: "items-start",
    sm: "sm:items-start",
    md: "md:items-start",
    lg: "lg:items-start",
    xl: "xl:items-start",
    "2xl": "2xl:items-start",
  },
  center: {
    base: "items-center",
    sm: "sm:items-center",
    md: "md:items-center",
    lg: "lg:items-center",
    xl: "xl:items-center",
    "2xl": "2xl:items-center",
  },
  end: {
    base: "items-end",
    sm: "sm:items-end",
    md: "md:items-end",
    lg: "lg:items-end",
    xl: "xl:items-end",
    "2xl": "2xl:items-end",
  },
  stretch: {
    base: "items-stretch",
    sm: "sm:items-stretch",
    md: "md:items-stretch",
    lg: "lg:items-stretch",
    xl: "xl:items-stretch",
    "2xl": "2xl:items-stretch",
  },
};

const justifyClasses: BreakpointClassMap<JustifyValue> = {
  start: {
    base: "justify-start",
    sm: "sm:justify-start",
    md: "md:justify-start",
    lg: "lg:justify-start",
    xl: "xl:justify-start",
    "2xl": "2xl:justify-start",
  },
  center: {
    base: "justify-center",
    sm: "sm:justify-center",
    md: "md:justify-center",
    lg: "lg:justify-center",
    xl: "xl:justify-center",
    "2xl": "2xl:justify-center",
  },
  end: {
    base: "justify-end",
    sm: "sm:justify-end",
    md: "md:justify-end",
    lg: "lg:justify-end",
    xl: "xl:justify-end",
    "2xl": "2xl:justify-end",
  },
  between: {
    base: "justify-between",
    sm: "sm:justify-between",
    md: "md:justify-between",
    lg: "lg:justify-between",
    xl: "xl:justify-between",
    "2xl": "2xl:justify-between",
  },
  around: {
    base: "justify-around",
    sm: "sm:justify-around",
    md: "md:justify-around",
    lg: "lg:justify-around",
    xl: "xl:justify-around",
    "2xl": "2xl:justify-around",
  },
};

export type ColumnCount = 1 | 2 | 3 | 4 | 5;

const columnsClasses: BreakpointClassMap<ColumnCount> = {
  1: {
    base: "grid-cols-1",
    sm: "sm:grid-cols-1",
    md: "md:grid-cols-1",
    lg: "lg:grid-cols-1",
    xl: "xl:grid-cols-1",
    "2xl": "2xl:grid-cols-1",
  },
  2: {
    base: "grid-cols-2",
    sm: "sm:grid-cols-2",
    md: "md:grid-cols-2",
    lg: "lg:grid-cols-2",
    xl: "xl:grid-cols-2",
    "2xl": "2xl:grid-cols-2",
  },
  3: {
    base: "grid-cols-3",
    sm: "sm:grid-cols-3",
    md: "md:grid-cols-3",
    lg: "lg:grid-cols-3",
    xl: "xl:grid-cols-3",
    "2xl": "2xl:grid-cols-3",
  },
  4: {
    base: "grid-cols-4",
    sm: "sm:grid-cols-4",
    md: "md:grid-cols-4",
    lg: "lg:grid-cols-4",
    xl: "xl:grid-cols-4",
    "2xl": "2xl:grid-cols-4",
  },
  5: {
    base: "grid-cols-5",
    sm: "sm:grid-cols-5",
    md: "md:grid-cols-5",
    lg: "lg:grid-cols-5",
    xl: "xl:grid-cols-5",
    "2xl": "2xl:grid-cols-5",
  },
};

type SpacePrefix = "p" | "px" | "py" | "mx" | "my" | "-mx" | "-my" | "gap";

const spaceClasses: Record<SpacePrefix, Record<ThemeSpaceToken, string>> = {
  p: {
    0: "p-0",
    1: "p-1",
    2: "p-2",
    3: "p-3",
    4: "p-4",
    5: "p-5",
    6: "p-6",
    7: "p-7",
    8: "p-8",
    9: "p-9",
    10: "p-10",
    11: "p-11",
    12: "p-12",
  },
  px: {
    0: "px-0",
    1: "px-1",
    2: "px-2",
    3: "px-3",
    4: "px-4",
    5: "px-5",
    6: "px-6",
    7: "px-7",
    8: "px-8",
    9: "px-9",
    10: "px-10",
    11: "px-11",
    12: "px-12",
  },
  py: {
    0: "py-0",
    1: "py-1",
    2: "py-2",
    3: "py-3",
    4: "py-4",
    5: "py-5",
    6: "py-6",
    7: "py-7",
    8: "py-8",
    9: "py-9",
    10: "py-10",
    11: "py-11",
    12: "py-12",
  },
  // Positive margins are intentionally limited to Spacer. Layout primitives
  // should compose with gap/padding so spacing stays container-owned.
  mx: {
    0: "mx-0",
    1: "mx-1",
    2: "mx-2",
    3: "mx-3",
    4: "mx-4",
    5: "mx-5",
    6: "mx-6",
    7: "mx-7",
    8: "mx-8",
    9: "mx-9",
    10: "mx-10",
    11: "mx-11",
    12: "mx-12",
  },
  my: {
    0: "my-0",
    1: "my-1",
    2: "my-2",
    3: "my-3",
    4: "my-4",
    5: "my-5",
    6: "my-6",
    7: "my-7",
    8: "my-8",
    9: "my-9",
    10: "my-10",
    11: "my-11",
    12: "my-12",
  },
  "-mx": {
    0: "-mx-0",
    1: "-mx-1",
    2: "-mx-2",
    3: "-mx-3",
    4: "-mx-4",
    5: "-mx-5",
    6: "-mx-6",
    7: "-mx-7",
    8: "-mx-8",
    9: "-mx-9",
    10: "-mx-10",
    11: "-mx-11",
    12: "-mx-12",
  },
  "-my": {
    0: "-my-0",
    1: "-my-1",
    2: "-my-2",
    3: "-my-3",
    4: "-my-4",
    5: "-my-5",
    6: "-my-6",
    7: "-my-7",
    8: "-my-8",
    9: "-my-9",
    10: "-my-10",
    11: "-my-11",
    12: "-my-12",
  },
  gap: {
    0: "gap-0",
    1: "gap-1",
    2: "gap-2",
    3: "gap-3",
    4: "gap-4",
    5: "gap-5",
    6: "gap-6",
    7: "gap-7",
    8: "gap-8",
    9: "gap-9",
    10: "gap-10",
    11: "gap-11",
    12: "gap-12",
  },
};

export function resolveSpaceClass(prefix: SpacePrefix, value?: ThemeSpaceToken): string {
  if (value === undefined) {
    return "";
  }

  return spaceClasses[prefix][value];
}

export function resolveTextAlignClass(value?: TextAlignValue): string {
  return value ? textAlignClasses[value] : "";
}

export function resolveResponsiveClass<T extends string | number>(
  value: ResponsiveValue<T> | undefined,
  classes: BreakpointClassMap<T>,
): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "object") {
    return classes[String(value) as `${T}`].base;
  }

  const output: string[] = [];

  for (const key of breakpoints) {
    const resolved = value[key];

    if (resolved !== undefined) {
      output.push(classes[String(resolved) as `${T}`][key]);
    }
  }

  return output.join(" ");
}

export function resolveDirectionClass(value?: ResponsiveValue<DirectionValue>): string {
  return resolveResponsiveClass(value, directionClasses);
}

export function resolveAlignClass(value?: ResponsiveValue<AlignValue>): string {
  return resolveResponsiveClass(value, alignClasses);
}

export function resolveJustifyClass(value?: ResponsiveValue<JustifyValue>): string {
  return resolveResponsiveClass(value, justifyClasses);
}

export function resolveColumnsClass(value?: ResponsiveValue<ColumnCount>): string {
  return resolveResponsiveClass(value, columnsClasses);
}

export function resolveSystemProps(props: SystemProps): string {
  return cx(
    resolveSpaceClass("p", props.padding),
    resolveSpaceClass("px", props.paddingX),
    resolveSpaceClass("py", props.paddingY),
    resolveSpaceClass("gap", props.gap),
    resolveTextAlignClass(props.textAlign),
  );
}
