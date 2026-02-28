import type { ResponsiveValue } from "../theme/tokens";
import { cx } from "./cx";

export type SpaceToken =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12;

export type AlignValue = "start" | "center" | "end" | "stretch";
export type JustifyValue =
  | "start"
  | "center"
  | "end"
  | "between"
  | "around";
export type TextAlignValue = "left" | "center" | "right";
export type DirectionValue = "row" | "column";

type BreakpointClassMap<T extends string | number> = Record<
  `${T}`,
  Record<"base" | "sm" | "md" | "lg" | "xl" | "2xl", string>
>;

export interface SystemProps {
  padding?: SpaceToken;
  paddingX?: SpaceToken;
  paddingY?: SpaceToken;
  gap?: SpaceToken;
  textAlign?: TextAlignValue;
}

const spaceClasses: Record<`${SpaceToken}`, string> = {
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  "10": "10",
  "11": "11",
  "12": "12"
};

const textAlignClasses: Record<TextAlignValue, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right"
};

const directionClasses: BreakpointClassMap<DirectionValue> = {
  row: {
    base: "flex-row",
    sm: "sm:flex-row",
    md: "md:flex-row",
    lg: "lg:flex-row",
    xl: "xl:flex-row",
    "2xl": "2xl:flex-row"
  },
  column: {
    base: "flex-col",
    sm: "sm:flex-col",
    md: "md:flex-col",
    lg: "lg:flex-col",
    xl: "xl:flex-col",
    "2xl": "2xl:flex-col"
  }
};

const alignClasses: BreakpointClassMap<AlignValue> = {
  start: {
    base: "items-start",
    sm: "sm:items-start",
    md: "md:items-start",
    lg: "lg:items-start",
    xl: "xl:items-start",
    "2xl": "2xl:items-start"
  },
  center: {
    base: "items-center",
    sm: "sm:items-center",
    md: "md:items-center",
    lg: "lg:items-center",
    xl: "xl:items-center",
    "2xl": "2xl:items-center"
  },
  end: {
    base: "items-end",
    sm: "sm:items-end",
    md: "md:items-end",
    lg: "lg:items-end",
    xl: "xl:items-end",
    "2xl": "2xl:items-end"
  },
  stretch: {
    base: "items-stretch",
    sm: "sm:items-stretch",
    md: "md:items-stretch",
    lg: "lg:items-stretch",
    xl: "xl:items-stretch",
    "2xl": "2xl:items-stretch"
  }
};

const justifyClasses: BreakpointClassMap<JustifyValue> = {
  start: {
    base: "justify-start",
    sm: "sm:justify-start",
    md: "md:justify-start",
    lg: "lg:justify-start",
    xl: "xl:justify-start",
    "2xl": "2xl:justify-start"
  },
  center: {
    base: "justify-center",
    sm: "sm:justify-center",
    md: "md:justify-center",
    lg: "lg:justify-center",
    xl: "xl:justify-center",
    "2xl": "2xl:justify-center"
  },
  end: {
    base: "justify-end",
    sm: "sm:justify-end",
    md: "md:justify-end",
    lg: "lg:justify-end",
    xl: "xl:justify-end",
    "2xl": "2xl:justify-end"
  },
  between: {
    base: "justify-between",
    sm: "sm:justify-between",
    md: "md:justify-between",
    lg: "lg:justify-between",
    xl: "xl:justify-between",
    "2xl": "2xl:justify-between"
  },
  around: {
    base: "justify-around",
    sm: "sm:justify-around",
    md: "md:justify-around",
    lg: "lg:justify-around",
    xl: "xl:justify-around",
    "2xl": "2xl:justify-around"
  }
};

const columnsClasses: BreakpointClassMap<1 | 2 | 3 | 4> = {
  1: {
    base: "grid-cols-1",
    sm: "sm:grid-cols-1",
    md: "md:grid-cols-1",
    lg: "lg:grid-cols-1",
    xl: "xl:grid-cols-1",
    "2xl": "2xl:grid-cols-1"
  },
  2: {
    base: "grid-cols-2",
    sm: "sm:grid-cols-2",
    md: "md:grid-cols-2",
    lg: "lg:grid-cols-2",
    xl: "xl:grid-cols-2",
    "2xl": "2xl:grid-cols-2"
  },
  3: {
    base: "grid-cols-3",
    sm: "sm:grid-cols-3",
    md: "md:grid-cols-3",
    lg: "lg:grid-cols-3",
    xl: "xl:grid-cols-3",
    "2xl": "2xl:grid-cols-3"
  },
  4: {
    base: "grid-cols-4",
    sm: "sm:grid-cols-4",
    md: "md:grid-cols-4",
    lg: "lg:grid-cols-4",
    xl: "xl:grid-cols-4",
    "2xl": "2xl:grid-cols-4"
  }
};

const responsiveOrder: Array<"base" | "sm" | "md" | "lg" | "xl" | "2xl"> = [
  "base",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl"
];

export function resolveSpaceClass(
  prefix: "p" | "px" | "py" | "m" | "mx" | "my" | "gap",
  value?: SpaceToken
): string {
  if (value === undefined) {
    return "";
  }

  return `${prefix}-${spaceClasses[String(value) as `${SpaceToken}`]}`;
}

export function resolveTextAlignClass(value?: TextAlignValue): string {
  return value ? textAlignClasses[value] : "";
}

export function resolveResponsiveClass<T extends string | number>(
  value: ResponsiveValue<T> | undefined,
  classes: BreakpointClassMap<T>
): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "object") {
    return classes[String(value) as `${T}`].base;
  }

  const output: string[] = [];

  for (const key of responsiveOrder) {
    const resolved = value[key];

    if (resolved !== undefined) {
      output.push(classes[String(resolved) as `${T}`][key]);
    }
  }

  return output.join(" ");
}

export function resolveDirectionClass(
  value?: ResponsiveValue<DirectionValue>
): string {
  return resolveResponsiveClass(value, directionClasses);
}

export function resolveAlignClass(
  value?: ResponsiveValue<AlignValue>
): string {
  return resolveResponsiveClass(value, alignClasses);
}

export function resolveJustifyClass(
  value?: ResponsiveValue<JustifyValue>
): string {
  return resolveResponsiveClass(value, justifyClasses);
}

export function resolveColumnsClass(
  value?: ResponsiveValue<1 | 2 | 3 | 4>
): string {
  return resolveResponsiveClass(value, columnsClasses);
}

export function resolveSystemProps(props: SystemProps): string {
  return cx(
    resolveSpaceClass("p", props.padding),
    resolveSpaceClass("px", props.paddingX),
    resolveSpaceClass("py", props.paddingY),
    resolveSpaceClass("gap", props.gap),
    resolveTextAlignClass(props.textAlign)
  );
}
