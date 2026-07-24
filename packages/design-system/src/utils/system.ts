import type { ResponsiveValue, SpaceToken as ThemeSpaceToken } from "../theme/tokens";
import { cx } from "./cx";

export type { SpaceToken } from "../theme/tokens";

export type AlignValue = "start" | "center" | "end" | "stretch";
export type JustifyValue = "start" | "center" | "end" | "between" | "around";
export type TextAlignValue = "left" | "center" | "right";
export type DirectionValue = "row" | "column";

type BreakpointKey = "base" | "sm" | "md" | "lg" | "xl" | "2xl";
type BreakpointClassMap<T extends string | number> = Record<`${T}`, Record<BreakpointKey, string>>;
type ResponsiveSpaceToken = ResponsiveValue<ThemeSpaceToken>;

export interface SystemProps {
  padding?: ResponsiveSpaceToken;
  paddingX?: ResponsiveSpaceToken;
  paddingY?: ResponsiveSpaceToken;
  gap?: ResponsiveSpaceToken;
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

type ResponsiveSpacePrefix = "p" | "px" | "py" | "gap";
type SpacePrefix = ResponsiveSpacePrefix | "mx" | "my" | "-mx" | "-my";

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

const responsiveSpaceClasses: Record<ResponsiveSpacePrefix, BreakpointClassMap<ThemeSpaceToken>> = {
  p: {
    0: {
      base: "p-0",
      sm: "sm:p-0",
      md: "md:p-0",
      lg: "lg:p-0",
      xl: "xl:p-0",
      "2xl": "2xl:p-0",
    },
    1: {
      base: "p-1",
      sm: "sm:p-1",
      md: "md:p-1",
      lg: "lg:p-1",
      xl: "xl:p-1",
      "2xl": "2xl:p-1",
    },
    2: {
      base: "p-2",
      sm: "sm:p-2",
      md: "md:p-2",
      lg: "lg:p-2",
      xl: "xl:p-2",
      "2xl": "2xl:p-2",
    },
    3: {
      base: "p-3",
      sm: "sm:p-3",
      md: "md:p-3",
      lg: "lg:p-3",
      xl: "xl:p-3",
      "2xl": "2xl:p-3",
    },
    4: {
      base: "p-4",
      sm: "sm:p-4",
      md: "md:p-4",
      lg: "lg:p-4",
      xl: "xl:p-4",
      "2xl": "2xl:p-4",
    },
    5: {
      base: "p-5",
      sm: "sm:p-5",
      md: "md:p-5",
      lg: "lg:p-5",
      xl: "xl:p-5",
      "2xl": "2xl:p-5",
    },
    6: {
      base: "p-6",
      sm: "sm:p-6",
      md: "md:p-6",
      lg: "lg:p-6",
      xl: "xl:p-6",
      "2xl": "2xl:p-6",
    },
    7: {
      base: "p-7",
      sm: "sm:p-7",
      md: "md:p-7",
      lg: "lg:p-7",
      xl: "xl:p-7",
      "2xl": "2xl:p-7",
    },
    8: {
      base: "p-8",
      sm: "sm:p-8",
      md: "md:p-8",
      lg: "lg:p-8",
      xl: "xl:p-8",
      "2xl": "2xl:p-8",
    },
    9: {
      base: "p-9",
      sm: "sm:p-9",
      md: "md:p-9",
      lg: "lg:p-9",
      xl: "xl:p-9",
      "2xl": "2xl:p-9",
    },
    10: {
      base: "p-10",
      sm: "sm:p-10",
      md: "md:p-10",
      lg: "lg:p-10",
      xl: "xl:p-10",
      "2xl": "2xl:p-10",
    },
    11: {
      base: "p-11",
      sm: "sm:p-11",
      md: "md:p-11",
      lg: "lg:p-11",
      xl: "xl:p-11",
      "2xl": "2xl:p-11",
    },
    12: {
      base: "p-12",
      sm: "sm:p-12",
      md: "md:p-12",
      lg: "lg:p-12",
      xl: "xl:p-12",
      "2xl": "2xl:p-12",
    },
  },
  px: {
    0: {
      base: "px-0",
      sm: "sm:px-0",
      md: "md:px-0",
      lg: "lg:px-0",
      xl: "xl:px-0",
      "2xl": "2xl:px-0",
    },
    1: {
      base: "px-1",
      sm: "sm:px-1",
      md: "md:px-1",
      lg: "lg:px-1",
      xl: "xl:px-1",
      "2xl": "2xl:px-1",
    },
    2: {
      base: "px-2",
      sm: "sm:px-2",
      md: "md:px-2",
      lg: "lg:px-2",
      xl: "xl:px-2",
      "2xl": "2xl:px-2",
    },
    3: {
      base: "px-3",
      sm: "sm:px-3",
      md: "md:px-3",
      lg: "lg:px-3",
      xl: "xl:px-3",
      "2xl": "2xl:px-3",
    },
    4: {
      base: "px-4",
      sm: "sm:px-4",
      md: "md:px-4",
      lg: "lg:px-4",
      xl: "xl:px-4",
      "2xl": "2xl:px-4",
    },
    5: {
      base: "px-5",
      sm: "sm:px-5",
      md: "md:px-5",
      lg: "lg:px-5",
      xl: "xl:px-5",
      "2xl": "2xl:px-5",
    },
    6: {
      base: "px-6",
      sm: "sm:px-6",
      md: "md:px-6",
      lg: "lg:px-6",
      xl: "xl:px-6",
      "2xl": "2xl:px-6",
    },
    7: {
      base: "px-7",
      sm: "sm:px-7",
      md: "md:px-7",
      lg: "lg:px-7",
      xl: "xl:px-7",
      "2xl": "2xl:px-7",
    },
    8: {
      base: "px-8",
      sm: "sm:px-8",
      md: "md:px-8",
      lg: "lg:px-8",
      xl: "xl:px-8",
      "2xl": "2xl:px-8",
    },
    9: {
      base: "px-9",
      sm: "sm:px-9",
      md: "md:px-9",
      lg: "lg:px-9",
      xl: "xl:px-9",
      "2xl": "2xl:px-9",
    },
    10: {
      base: "px-10",
      sm: "sm:px-10",
      md: "md:px-10",
      lg: "lg:px-10",
      xl: "xl:px-10",
      "2xl": "2xl:px-10",
    },
    11: {
      base: "px-11",
      sm: "sm:px-11",
      md: "md:px-11",
      lg: "lg:px-11",
      xl: "xl:px-11",
      "2xl": "2xl:px-11",
    },
    12: {
      base: "px-12",
      sm: "sm:px-12",
      md: "md:px-12",
      lg: "lg:px-12",
      xl: "xl:px-12",
      "2xl": "2xl:px-12",
    },
  },
  py: {
    0: {
      base: "py-0",
      sm: "sm:py-0",
      md: "md:py-0",
      lg: "lg:py-0",
      xl: "xl:py-0",
      "2xl": "2xl:py-0",
    },
    1: {
      base: "py-1",
      sm: "sm:py-1",
      md: "md:py-1",
      lg: "lg:py-1",
      xl: "xl:py-1",
      "2xl": "2xl:py-1",
    },
    2: {
      base: "py-2",
      sm: "sm:py-2",
      md: "md:py-2",
      lg: "lg:py-2",
      xl: "xl:py-2",
      "2xl": "2xl:py-2",
    },
    3: {
      base: "py-3",
      sm: "sm:py-3",
      md: "md:py-3",
      lg: "lg:py-3",
      xl: "xl:py-3",
      "2xl": "2xl:py-3",
    },
    4: {
      base: "py-4",
      sm: "sm:py-4",
      md: "md:py-4",
      lg: "lg:py-4",
      xl: "xl:py-4",
      "2xl": "2xl:py-4",
    },
    5: {
      base: "py-5",
      sm: "sm:py-5",
      md: "md:py-5",
      lg: "lg:py-5",
      xl: "xl:py-5",
      "2xl": "2xl:py-5",
    },
    6: {
      base: "py-6",
      sm: "sm:py-6",
      md: "md:py-6",
      lg: "lg:py-6",
      xl: "xl:py-6",
      "2xl": "2xl:py-6",
    },
    7: {
      base: "py-7",
      sm: "sm:py-7",
      md: "md:py-7",
      lg: "lg:py-7",
      xl: "xl:py-7",
      "2xl": "2xl:py-7",
    },
    8: {
      base: "py-8",
      sm: "sm:py-8",
      md: "md:py-8",
      lg: "lg:py-8",
      xl: "xl:py-8",
      "2xl": "2xl:py-8",
    },
    9: {
      base: "py-9",
      sm: "sm:py-9",
      md: "md:py-9",
      lg: "lg:py-9",
      xl: "xl:py-9",
      "2xl": "2xl:py-9",
    },
    10: {
      base: "py-10",
      sm: "sm:py-10",
      md: "md:py-10",
      lg: "lg:py-10",
      xl: "xl:py-10",
      "2xl": "2xl:py-10",
    },
    11: {
      base: "py-11",
      sm: "sm:py-11",
      md: "md:py-11",
      lg: "lg:py-11",
      xl: "xl:py-11",
      "2xl": "2xl:py-11",
    },
    12: {
      base: "py-12",
      sm: "sm:py-12",
      md: "md:py-12",
      lg: "lg:py-12",
      xl: "xl:py-12",
      "2xl": "2xl:py-12",
    },
  },
  gap: {
    0: {
      base: "gap-0",
      sm: "sm:gap-0",
      md: "md:gap-0",
      lg: "lg:gap-0",
      xl: "xl:gap-0",
      "2xl": "2xl:gap-0",
    },
    1: {
      base: "gap-1",
      sm: "sm:gap-1",
      md: "md:gap-1",
      lg: "lg:gap-1",
      xl: "xl:gap-1",
      "2xl": "2xl:gap-1",
    },
    2: {
      base: "gap-2",
      sm: "sm:gap-2",
      md: "md:gap-2",
      lg: "lg:gap-2",
      xl: "xl:gap-2",
      "2xl": "2xl:gap-2",
    },
    3: {
      base: "gap-3",
      sm: "sm:gap-3",
      md: "md:gap-3",
      lg: "lg:gap-3",
      xl: "xl:gap-3",
      "2xl": "2xl:gap-3",
    },
    4: {
      base: "gap-4",
      sm: "sm:gap-4",
      md: "md:gap-4",
      lg: "lg:gap-4",
      xl: "xl:gap-4",
      "2xl": "2xl:gap-4",
    },
    5: {
      base: "gap-5",
      sm: "sm:gap-5",
      md: "md:gap-5",
      lg: "lg:gap-5",
      xl: "xl:gap-5",
      "2xl": "2xl:gap-5",
    },
    6: {
      base: "gap-6",
      sm: "sm:gap-6",
      md: "md:gap-6",
      lg: "lg:gap-6",
      xl: "xl:gap-6",
      "2xl": "2xl:gap-6",
    },
    7: {
      base: "gap-7",
      sm: "sm:gap-7",
      md: "md:gap-7",
      lg: "lg:gap-7",
      xl: "xl:gap-7",
      "2xl": "2xl:gap-7",
    },
    8: {
      base: "gap-8",
      sm: "sm:gap-8",
      md: "md:gap-8",
      lg: "lg:gap-8",
      xl: "xl:gap-8",
      "2xl": "2xl:gap-8",
    },
    9: {
      base: "gap-9",
      sm: "sm:gap-9",
      md: "md:gap-9",
      lg: "lg:gap-9",
      xl: "xl:gap-9",
      "2xl": "2xl:gap-9",
    },
    10: {
      base: "gap-10",
      sm: "sm:gap-10",
      md: "md:gap-10",
      lg: "lg:gap-10",
      xl: "xl:gap-10",
      "2xl": "2xl:gap-10",
    },
    11: {
      base: "gap-11",
      sm: "sm:gap-11",
      md: "md:gap-11",
      lg: "lg:gap-11",
      xl: "xl:gap-11",
      "2xl": "2xl:gap-11",
    },
    12: {
      base: "gap-12",
      sm: "sm:gap-12",
      md: "md:gap-12",
      lg: "lg:gap-12",
      xl: "xl:gap-12",
      "2xl": "2xl:gap-12",
    },
  },
};

export function resolveSpaceClass(prefix: SpacePrefix, value?: ThemeSpaceToken): string {
  if (value === undefined) {
    return "";
  }

  return spaceClasses[prefix][value];
}

function resolveResponsiveSpaceClass(prefix: ResponsiveSpacePrefix, value?: ResponsiveSpaceToken): string {
  return resolveResponsiveClass(value, responsiveSpaceClasses[prefix]);
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

const truncateOnClasses: Record<BreakpointKey, string> = {
  base: "truncate",
  sm: "sm:truncate",
  md: "md:truncate",
  lg: "lg:truncate",
  xl: "xl:truncate",
  "2xl": "2xl:truncate",
};

const truncateOffClasses: Record<BreakpointKey, string> = {
  base: "overflow-visible text-clip whitespace-normal",
  sm: "sm:overflow-visible sm:text-clip sm:whitespace-normal",
  md: "md:overflow-visible md:text-clip md:whitespace-normal",
  lg: "lg:overflow-visible lg:text-clip lg:whitespace-normal",
  xl: "xl:overflow-visible xl:text-clip xl:whitespace-normal",
  "2xl": "2xl:overflow-visible 2xl:text-clip 2xl:whitespace-normal",
};

/**
 * Unlike the other responsive resolvers, truncation is binary per breakpoint
 * (on/off) rather than a value lookup, so it needs its own resolver: turning
 * truncation off at a breakpoint requires explicitly undoing all three
 * `truncate` utility properties, not just omitting a class.
 */
export function resolveTruncateClass(value?: ResponsiveValue<boolean>): string {
  if (value === undefined || value === false) {
    return "";
  }

  if (value === true) {
    return truncateOnClasses.base;
  }

  const output: string[] = [];

  for (const key of breakpoints) {
    const resolved = value[key];

    if (resolved !== undefined) {
      output.push(resolved ? truncateOnClasses[key] : truncateOffClasses[key]);
    }
  }

  return output.join(" ");
}

export function resolveSystemProps(props: SystemProps): string {
  return cx(
    resolveResponsiveSpaceClass("p", props.padding),
    resolveResponsiveSpaceClass("px", props.paddingX),
    resolveResponsiveSpaceClass("py", props.paddingY),
    resolveResponsiveSpaceClass("gap", props.gap),
    resolveTextAlignClass(props.textAlign),
  );
}
