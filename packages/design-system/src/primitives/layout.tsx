import {
  forwardRef,
  type ComponentProps,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type Ref,
} from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import type { ResponsiveValue } from "../theme/tokens";
import { cx } from "../utils/cx";
import {
  resolveAlignClass,
  resolveColumnsClass,
  resolveDirectionClass,
  resolveJustifyClass,
  resolveResponsiveClass,
  resolveSpaceClass,
  resolveSystemProps,
  type AlignValue,
  type ColumnCount,
  type DirectionValue,
  type JustifyValue,
  type SpaceToken,
  type SystemProps,
} from "../utils/system";
import type { PolymorphicPrimitive, PolymorphicProps } from "./polymorphic";

type BoxElement = "div" | "section" | "article" | "aside" | "header" | "footer" | "main" | "nav" | "span";

type FrameProps = Omit<HTMLAttributes<HTMLElement>, "className" | "style">;

/**
 * Named minimum-width tokens shared by layout primitives.
 * - `0`: allow flex/grid children to shrink past their content size (`min-w-0`).
 * - `action`: reserve a comfortable minimum for an action column (`min-w-40`).
 */
export type MinWidthToken = "0" | "action";

const minWidthClasses: Record<MinWidthToken, string> = {
  0: "min-w-0",
  action: "min-w-40",
};

function resolveMinWidthClass(value?: MinWidthToken): string {
  return value ? minWidthClasses[value] : "";
}

export interface BoxOwnProps extends PropsWithChildren, SystemProps {
  element?: BoxElement;
  minWidth?: MinWidthToken;
}

export type BoxProps<TTarget extends ElementType = "div"> = PolymorphicProps<TTarget, BoxOwnProps>;

export const Box = forwardRef(function Box(
  {
    as,
    render,
    element = "div",
    children,
    padding,
    paddingX,
    paddingY,
    gap,
    textAlign,
    minWidth,
    ...rest
  }: BoxProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        resolveMinWidthClass(minWidth),
        resolveSystemProps({
          padding,
          paddingX,
          paddingY,
          gap,
          textAlign,
        }),
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<BoxOwnProps, "div">;

export interface ContainerProps extends PropsWithChildren, FrameProps, SystemProps {
  width?: LayoutWidth;
}

export type LayoutWidth = "narrow" | "content" | "wide" | "expanded" | "full";

export const layoutWidthClasses: Record<LayoutWidth, string> = {
  narrow: "max-w-3xl",
  content: "max-w-5xl",
  wide: "max-w-7xl",
  expanded: "max-w-screen-2xl",
  full: "max-w-none",
};

/**
 * Named sidebar widths for use in grid layouts.
 * - nav: primary navigation sidebar (admin side nav)
 * - filter: secondary filter/browse sidebar (marketplace)
 * - detail: auxiliary detail/info panel
 * - summary: checkout order summary panel
 */
export const sidebarWidthClasses = {
  nav: "16rem",
  filter: "18rem",
  detail: "22rem",
  summary: "24rem",
} as const;

export type SidebarWidth = keyof typeof sidebarWidthClasses;

export function Container({
  children,
  width = "full",
  padding,
  paddingX = 4,
  paddingY,
  gap,
  textAlign,
  ...rest
}: ContainerProps) {
  return (
    <div {...rest} className={cx("w-full", resolveSystemProps({ padding, paddingX, paddingY, gap, textAlign }))}>
      <div className={cx("mx-auto w-full", layoutWidthClasses[width])}>{children}</div>
    </div>
  );
}

export interface StackOwnProps extends PropsWithChildren {
  element?: BoxElement;
  direction?: ResponsiveValue<DirectionValue>;
  align?: ResponsiveValue<AlignValue>;
  justify?: ResponsiveValue<JustifyValue>;
  gap?: ResponsiveValue<SpaceToken>;
  minWidth?: MinWidthToken;
}

export type StackProps<TTarget extends ElementType = "div"> = PolymorphicProps<TTarget, StackOwnProps>;

export const Stack = forwardRef(function Stack(
  {
    children,
    as,
    render,
    element = "div",
    direction = "column",
    align,
    justify,
    gap = 4,
    minWidth,
    ...rest
  }: StackProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        "flex",
        resolveDirectionClass(direction),
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveMinWidthClass(minWidth),
        resolveSystemProps({ gap }),
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<StackOwnProps, "div">;

export interface InlineProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  gap?: ResponsiveValue<SpaceToken>;
  align?: ResponsiveValue<AlignValue>;
  wrap?: boolean;
}

export function Inline({ children, gap = 3, align = "center", wrap = true, ...rest }: InlineProps) {
  return (
    <div {...rest} className={cx("flex", wrap && "flex-wrap", resolveAlignClass(align), resolveSystemProps({ gap }))}>
      {children}
    </div>
  );
}

export interface ClusterProps extends InlineProps {
  justify?: ResponsiveValue<JustifyValue>;
}

export function Cluster({ children, justify = "between", gap = 3, align = "center", ...rest }: ClusterProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex w-full flex-wrap",
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSystemProps({ gap }),
      )}
    >
      {children}
    </div>
  );
}

export interface IconRowProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /** Leading icon (or other fixed-size adornment). Pinned with `shrink-0`. */
  icon: ReactNode;
  /** Cross-axis alignment of the icon against the content. Defaults to `start`. */
  align?: "start" | "center";
  /** Horizontal gap token between the icon and the content. */
  gap?: ResponsiveValue<SpaceToken>;
  /**
   * Nudge the icon down a hair so it optically aligns with the first text line
   * when `align="start"`. Ignored when `align="center"`. Defaults to `true`.
   */
  nudge?: boolean;
}

const iconRowAlignClasses: Record<NonNullable<IconRowProps["align"]>, string> = {
  start: "items-start",
  center: "items-center",
};

/**
 * Icon-beside-text row: a fixed-size icon slot (`shrink-0`, optional top-nudge)
 * next to a `min-w-0` content slot that wraps and truncates cleanly. Replaces the
 * hand-rolled `flex` + `shrink-0` + `min-w-0` trio repeated across the HOC layer.
 */
export function IconRow({ children, icon, align = "start", gap = 2, nudge = true, ...rest }: IconRowProps) {
  return (
    <div {...rest} className={cx("flex", iconRowAlignClasses[align], resolveSystemProps({ gap }))}>
      <span className={cx("shrink-0", align === "start" && nudge && "mt-0.5")} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export interface GridProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /**
   * Inline style hook. The primitive owns `grid-template-columns` (via
   * `templateColumns`) but merges any consumer style on top, so callers keep
   * passing layout data without reaching for a raw host element.
   */
  style?: CSSProperties;
  columns?: ResponsiveValue<ColumnCount>;
  /**
   * Explicit `grid-template-columns` track definition, applied via inline style
   * and merged with any incoming `style`. Keeps slice-specific track lists in the
   * consumer as plain data instead of a named variant baked into this primitive.
   * Takes precedence over `columns` when set. Pair with `stackUntil` to keep a
   * single stacked column below a breakpoint and only resolve the tracks above it.
   */
  templateColumns?: string;
  /**
   * Breakpoint below which `templateColumns` is suppressed (the grid renders as a
   * single stacked column) and only applies from that breakpoint up. Mirrors the
   * mobile-stack → desktop-tracks behavior line rows rely on.
   */
  stackUntil?: "sm" | "md" | "lg";
  gap?: ResponsiveValue<SpaceToken>;
  align?: ResponsiveValue<AlignValue>;
  justify?: ResponsiveValue<JustifyValue>;
}

const gridStackAlignClasses: Record<NonNullable<GridProps["stackUntil"]>, string> = {
  sm: "min-w-0 sm:items-start",
  md: "min-w-0 md:items-start",
  lg: "min-w-0 lg:items-start",
};

export function Grid({
  children,
  columns = { base: 1, md: 2, xl: 3 },
  templateColumns,
  stackUntil,
  gap = 4,
  align,
  justify,
  style,
  ...rest
}: GridProps) {
  // When stacking below a breakpoint, the explicit tracks only apply at and above
  // it; below it the grid keeps its implicit single column. Otherwise the tracks
  // apply at every width.
  const trackStyle: CSSProperties | undefined = templateColumns
    ? stackUntil
      ? ({ [`--grid-template-columns-${stackUntil}`]: templateColumns } as CSSProperties)
      : { gridTemplateColumns: templateColumns }
    : undefined;

  return (
    <div
      {...rest}
      style={trackStyle ? { ...trackStyle, ...style } : style}
      className={cx(
        "grid",
        templateColumns ? (stackUntil ? gridStackAlignClasses[stackUntil] : undefined) : resolveColumnsClass(columns),
        stackUntil === "sm" && "sm:[grid-template-columns:var(--grid-template-columns-sm)]",
        stackUntil === "md" && "md:[grid-template-columns:var(--grid-template-columns-md)]",
        stackUntil === "lg" && "lg:[grid-template-columns:var(--grid-template-columns-lg)]",
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSystemProps({ gap }),
      )}
    >
      {children}
    </div>
  );
}

export interface FormRowProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /**
   * Number of side-by-side field columns. Stacks to a single column on narrow
   * viewports and resolves to `columns` from `sm` up. Defaults to `2` — the
   * common first-name / last-name pairing.
   */
  columns?: 2 | 3 | 4;
  /** Gap token between fields. Defaults to `4`, matching field stacking rhythm. */
  gap?: ResponsiveValue<SpaceToken>;
  /** Cross-axis alignment of the fields. Defaults to `start` so labels and help text line up. */
  align?: ResponsiveValue<AlignValue>;
}

/**
 * Side-by-side form fields. A thin {@link Grid} wrapper that stacks to a single
 * column on mobile and resolves to `columns` tracks from `sm` up, so forms place
 * paired fields (first/last name, city/postcode) without hand-rolling grid
 * utilities or breakpoints.
 */
export function FormRow({ children, columns = 2, gap = 4, align = "start", ...rest }: FormRowProps) {
  return (
    <Grid {...rest} columns={{ base: 1, sm: columns }} gap={gap} align={align}>
      {children}
    </Grid>
  );
}

export type AutoGridMinItemWidth = "sm" | "md" | "lg";

export interface AutoGridProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  minItemWidth?: ResponsiveValue<AutoGridMinItemWidth>;
  gap?: ResponsiveValue<SpaceToken>;
}

const autoGridWidthClasses: Record<AutoGridMinItemWidth, Record<"base" | "sm" | "md" | "lg" | "xl" | "2xl", string>> = {
  sm: {
    base: "grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
    sm: "sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
    md: "md:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
    lg: "lg:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
    xl: "xl:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
    "2xl": "2xl:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
  },
  md: {
    base: "grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
    sm: "sm:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
    md: "md:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
    lg: "lg:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
    xl: "xl:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
    "2xl": "2xl:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]",
  },
  lg: {
    base: "grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
    sm: "sm:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
    md: "md:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
    lg: "lg:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
    xl: "xl:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
    "2xl": "2xl:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]",
  },
};

function resolveAutoGridWidthClass(value: ResponsiveValue<AutoGridMinItemWidth>): string {
  return resolveResponsiveClass(value, autoGridWidthClasses);
}

export function AutoGrid({ children, minItemWidth = "md", gap = 4, ...rest }: AutoGridProps) {
  return (
    <div {...rest} className={cx("grid", resolveAutoGridWidthClass(minItemWidth), resolveSystemProps({ gap }))}>
      {children}
    </div>
  );
}

export type FlexItemMinWidth = "control" | "none" | "0";

export interface FlexItemProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  minWidth?: ResponsiveValue<FlexItemMinWidth>;
  grow?: boolean;
}

const flexItemMinWidthClasses: Record<FlexItemMinWidth, Record<"base" | "sm" | "md" | "lg" | "xl" | "2xl", string>> = {
  control: {
    base: "min-w-[14rem]",
    sm: "sm:min-w-[14rem]",
    md: "md:min-w-[14rem]",
    lg: "lg:min-w-[14rem]",
    xl: "xl:min-w-[14rem]",
    "2xl": "2xl:min-w-[14rem]",
  },
  none: {
    base: "",
    sm: "",
    md: "",
    lg: "",
    xl: "",
    "2xl": "",
  },
  /** Allow the flex item to shrink past its content size instead of overflowing — needed for a truncating child. */
  "0": {
    base: "min-w-0",
    sm: "sm:min-w-0",
    md: "md:min-w-0",
    lg: "lg:min-w-0",
    xl: "xl:min-w-0",
    "2xl": "2xl:min-w-0",
  },
};

function resolveFlexItemMinWidthClass(value: ResponsiveValue<FlexItemMinWidth>): string {
  return resolveResponsiveClass(value, flexItemMinWidthClasses);
}

export function FlexItem({ children, minWidth = "none", grow = false, ...rest }: FlexItemProps) {
  return (
    <div {...rest} className={cx("max-w-full", grow && "flex-1", resolveFlexItemMinWidthClass(minWidth))}>
      {children}
    </div>
  );
}

export interface SpacerProps extends Omit<FrameProps, "children"> {
  axis?: "vertical" | "horizontal";
  size?: SpaceToken;
  flexible?: boolean;
}

export function Spacer({ axis = "vertical", size = 4, flexible = false, ...rest }: SpacerProps) {
  return (
    <div
      {...rest}
      aria-hidden="true"
      className={cx(
        flexible && "flex-1",
        axis === "vertical" ? resolveSpaceClass("my", size) : resolveSpaceClass("mx", size),
      )}
    />
  );
}

export type InsetProps<TTarget extends ElementType = "div"> = BoxProps<TTarget>;

export const Inset = forwardRef(function Inset(
  {
    children,
    as,
    render,
    element = "div",
    padding = 4,
    paddingX,
    paddingY,
    gap,
    textAlign,
    ...rest
  }: InsetProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;

  return (
    <Component
      {...rest}
      ref={ref}
      className={cx(
        "inset-surface min-w-0 max-w-full rounded-tokenMd border",
        resolveSystemProps({ padding, paddingX, paddingY, gap, textAlign }),
      )}
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<BoxOwnProps, "div">;

export interface CenterProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  inline?: boolean;
  /** Which axes to center on. Defaults to both. */
  axis?: "both" | "horizontal" | "vertical";
}

const centerAxisClasses: Record<NonNullable<CenterProps["axis"]>, string> = {
  both: "items-center justify-center",
  horizontal: "justify-center",
  vertical: "items-center",
};

export function Center({ children, inline = false, axis = "both", ...rest }: CenterProps) {
  return (
    <div {...rest} className={cx(inline ? "inline-flex" : "flex", centerAxisClasses[axis])}>
      {children}
    </div>
  );
}

export interface StickyBarProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /** Edge the bar pins to. Defaults to `bottom`. */
  position?: "top" | "bottom";
  /** Hide the bar from this breakpoint up (e.g. a mobile-only action bar). */
  hideFrom?: ShowBreakpoint;
  /** Frosted translucent chrome with a blurred backdrop. Defaults to `true`. */
  backdrop?: boolean;
}

const stickyBarPositionClasses: Record<NonNullable<StickyBarProps["position"]>, string> = {
  // Bottom bars reserve safe-area inset padding so actions clear the home bar.
  bottom: "bottom-0 border-t pb-[max(0.5rem,env(safe-area-inset-bottom))]",
  top: "top-0 border-b pt-[max(0.5rem,env(safe-area-inset-top))]",
};

const stickyBarHideFromClasses: Record<ShowBreakpoint, string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
  xl: "xl:hidden",
};

/**
 * Position-agnostic sticky action bar pinned to the top or bottom edge. Owns the
 * fixed positioning, safe-area inset, border, elevation, and optional frosted
 * backdrop so callers never reach for route-local `fixed`/`inset` utilities. Pass
 * `hideFrom` to scope it to a breakpoint range (a mobile-only bar uses
 * `hideFrom="md"`). Pass-through props let callers attach contract attributes
 * like `data-primary-action-count` without a raw host element.
 */
export function StickyBar({ children, position = "bottom", hideFrom, backdrop = true, ...rest }: StickyBarProps) {
  return (
    <div
      {...rest}
      className={cx(
        "fixed inset-x-0 z-sticky border-muted px-3 py-2 shadow-tokenLg",
        stickyBarPositionClasses[position],
        backdrop ? "bg-background/overlay backdrop-blur-xl" : "bg-background",
        hideFrom && stickyBarHideFromClasses[hideFrom],
      )}
    >
      {children}
    </div>
  );
}

export interface MobileStickyBarProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  visibleFrom?: "mobile" | "all";
}

/**
 * Mobile-only bottom sticky bar. Thin alias over {@link StickyBar} preserved for
 * existing call sites; new bars should use `StickyBar` directly.
 */
export function MobileStickyBar({ children, visibleFrom = "mobile", ...rest }: MobileStickyBarProps) {
  return (
    <StickyBar position="bottom" hideFrom={visibleFrom === "mobile" ? "md" : undefined} {...rest}>
      {children}
    </StickyBar>
  );
}

export interface MobileStickyInsetProps extends PropsWithChildren, Omit<FrameProps, "children"> {}

export function MobileStickyInset({ children, ...rest }: MobileStickyInsetProps) {
  return (
    <div {...rest} className="pb-24 md:pb-0">
      {children}
    </div>
  );
}

export interface DesktopActionBarProps extends PropsWithChildren, Omit<FrameProps, "children"> {}

/**
 * Desktop-only inline action row. Distinct from {@link StickyBar}: this is an
 * in-flow, non-fixed flex row hidden on mobile (where a `StickyBar`/
 * `MobileStickyBar` carries the same actions) and shown from `md` up. The two
 * compose rather than overlap — `StickyBar` owns edge-pinned chrome, this owns
 * the inline desktop layout. Pass-through props let callers attach contract
 * attributes like `data-primary-action-count` without a raw host element.
 */
export function DesktopActionBar({ children, ...rest }: DesktopActionBarProps) {
  return (
    <div {...rest} className="hidden md:flex md:items-center md:gap-2">
      {children}
    </div>
  );
}

export type ShowBreakpoint = "sm" | "md" | "lg" | "xl";

export interface ShowProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /** Render only from this breakpoint up (hidden below it). Alias of `from`. */
  above?: ShowBreakpoint;
  /** Render only below this breakpoint (hidden from it up). Alias of `until`. */
  below?: ShowBreakpoint;
  /** Render only from this breakpoint up (hidden below it). */
  from?: ShowBreakpoint;
  /** Render only below this breakpoint (hidden from it up). */
  until?: ShowBreakpoint;
  /** Display mode applied when the content is visible. Defaults to `block`. */
  display?: "block" | "flex";
  minWidth?: MinWidthToken;
}

const showAboveClasses: Record<ShowBreakpoint, Record<NonNullable<ShowProps["display"]>, string>> = {
  sm: { block: "hidden sm:block", flex: "hidden sm:flex" },
  md: { block: "hidden md:block", flex: "hidden md:flex" },
  lg: { block: "hidden lg:block", flex: "hidden lg:flex" },
  xl: { block: "hidden xl:block", flex: "hidden xl:flex" },
};

const showBelowClasses: Record<ShowBreakpoint, string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
  xl: "xl:hidden",
};

/**
 * Responsive visibility wrapper. Use `above`/`from` to reveal content from a
 * breakpoint up (hidden below) or `below`/`until` to show it only below a
 * breakpoint. Keeps responsive show/hide logic inside the design system instead
 * of route-local utility classes.
 */
export function Show({ children, above, below, from, until, display = "block", minWidth, ...rest }: ShowProps) {
  const aboveBreakpoint = above ?? from;
  const belowBreakpoint = below ?? until;

  return (
    <div
      {...rest}
      className={cx(
        aboveBreakpoint ? showAboveClasses[aboveBreakpoint][display] : display === "flex" ? "flex" : undefined,
        belowBreakpoint && showBelowClasses[belowBreakpoint],
        resolveMinWidthClass(minWidth),
      )}
    >
      {children}
    </div>
  );
}

export interface MediaFrameProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /** Fixed responsive frame size on a generic `sm | md | lg` scale. */
  size?: "sm" | "md" | "lg";
}

const mediaFrameSizeClasses: Record<NonNullable<MediaFrameProps["size"]>, string> = {
  sm: "h-16 w-14 sm:h-20 sm:w-16",
  md: "h-24 w-20 sm:h-28 sm:w-24",
  lg: "h-32 w-28 sm:h-36 sm:w-32",
};

/**
 * Fixed-size, bordered, rounded media container for thumbnails that must not
 * grow or shrink within a flex/grid row. Wrap an `Image` (or other media) so the
 * frame owns sizing, clipping, and chrome instead of route-local utilities.
 */
export function MediaFrame({ children, size = "md", ...rest }: MediaFrameProps) {
  return (
    <div
      {...rest}
      className={cx(
        "relative shrink-0 overflow-hidden rounded-tokenMd border border-muted bg-surface-2 shadow-tokenSm",
        mediaFrameSizeClasses[size],
      )}
    >
      {children}
    </div>
  );
}

export interface EmbeddedProviderSurfaceProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /** Stable minimum viewport for third-party embedded account, payment, or verification flows. */
  minHeight?: "md" | "lg";
}

const embeddedProviderSurfaceMinHeightClasses: Record<
  NonNullable<EmbeddedProviderSurfaceProps["minHeight"]>,
  string
> = {
  md: cx(
    "min-h-[36rem] md:min-h-[44rem]",
    "[&_iframe]:min-h-[36rem] md:[&_iframe]:min-h-[44rem]",
    "[&>stripe-connect-account-management]:min-h-[36rem] md:[&>stripe-connect-account-management]:min-h-[44rem]",
    "[&>stripe-connect-account-onboarding]:min-h-[36rem] md:[&>stripe-connect-account-onboarding]:min-h-[44rem]",
  ),
  lg: cx(
    "min-h-[44rem] md:min-h-[52rem]",
    "[&_iframe]:min-h-[44rem] md:[&_iframe]:min-h-[52rem]",
    "[&>stripe-connect-account-management]:min-h-[44rem] md:[&>stripe-connect-account-management]:min-h-[52rem]",
    "[&>stripe-connect-account-onboarding]:min-h-[44rem] md:[&>stripe-connect-account-onboarding]:min-h-[52rem]",
  ),
};

/**
 * Full-width host for provider-managed embedded flows whose iframe dimensions
 * are controlled by a vendor runtime. Keeps the app-side viewport stable even
 * when the provider starts its iframe at a tiny loading height.
 */
export const EmbeddedProviderSurface = forwardRef(function EmbeddedProviderSurface(
  { children, minHeight = "md", ...rest }: EmbeddedProviderSurfaceProps,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <div
      {...rest}
      ref={ref}
      className={cx(
        "block w-full min-w-0 overflow-visible [&>*]:w-full [&_iframe]:block [&_iframe]:w-full",
        "[&>stripe-connect-account-management]:block [&>stripe-connect-account-onboarding]:block",
        embeddedProviderSurfaceMinHeightClasses[minHeight],
      )}
    >
      {children}
    </div>
  );
});

export interface AspectRatioProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  ratio?: number;
  /** Object-fit applied to media children (`<img>`/`<video>`) that fill the frame. */
  fit?: "cover" | "contain" | "fill" | "none";
  /** Clip overflow to the ratio box. Defaults to `true` so media never escapes the frame. */
  clip?: boolean;
}

const aspectRatioFitClasses: Record<NonNullable<AspectRatioProps["fit"]>, string> = {
  cover: "[&>img]:h-full [&>img]:w-full [&>img]:object-cover [&>video]:h-full [&>video]:w-full [&>video]:object-cover",
  contain:
    "[&>img]:h-full [&>img]:w-full [&>img]:object-contain [&>video]:h-full [&>video]:w-full [&>video]:object-contain",
  fill: "[&>img]:h-full [&>img]:w-full [&>img]:object-fill [&>video]:h-full [&>video]:w-full [&>video]:object-fill",
  none: "",
};

export function AspectRatio({ children, ratio = 1, fit = "none", clip = true, ...rest }: AspectRatioProps) {
  return (
    <div
      {...rest}
      style={{ aspectRatio: ratio }}
      className={cx(clip && "overflow-hidden", fit !== "none" && aspectRatioFitClasses[fit])}
    >
      {children}
    </div>
  );
}

export interface BleedProps extends PropsWithChildren, Omit<FrameProps, "children"> {
  /** Spacing token to pull against on each chosen axis. Matches the padding of the enclosing container. */
  space?: SpaceToken;
  /** Which axes to bleed. Defaults to horizontal, the common edge-to-edge media case. */
  axis?: "horizontal" | "vertical" | "both";
}

/**
 * Negative-margin primitive that lets edge-to-edge media break out of a padded
 * `Container`/`Surface`/`Page`. Pass the same spacing token the parent pads with so
 * the child reaches the container edges, then `max-w-none` keeps it full width.
 */
export function Bleed({ children, space = 4, axis = "horizontal", ...rest }: BleedProps) {
  return (
    <div
      {...rest}
      className={cx(
        "max-w-none",
        (axis === "horizontal" || axis === "both") && resolveSpaceClass("-mx", space),
        (axis === "vertical" || axis === "both") && resolveSpaceClass("-my", space),
      )}
    >
      {children}
    </div>
  );
}

/**
 * Structural surface tones name a background family (the canonical card-shell
 * fill, recessed wells, the brand-gradient accent, and a flat subtle frame).
 * Surface chrome — glass, border, shadow — is owned by the orthogonal
 * `elevation` prop, not by the tone.
 */
type SurfaceStructuralTone = "default" | "muted" | "accent" | "subtle";

/**
 * Semantic status tones tint a surface with the canonical
 * `border-{tone}-soft bg-{tone}-soft text-{tone}` token triple so notice,
 * status, and confirmation surfaces read their meaning from the token layer
 * instead of duplicated lookup maps or `color-mix` border tints.
 */
export type SurfaceSemanticTone = "neutral" | "info" | "success" | "warning" | "danger" | "trust" | "primary";

export type SurfaceTone = SurfaceStructuralTone | SurfaceSemanticTone;

export interface SurfaceOwnProps extends PropsWithChildren, SystemProps {
  element?: BoxElement;
  tone?: SurfaceTone;
  elevation?: "flush" | "tinted" | "outlined" | "elevated";
  elevated?: boolean;
  glow?: boolean;
}

type SurfaceElevation = NonNullable<SurfaceOwnProps["elevation"]>;

export type SurfaceProps<TTarget extends ElementType = "div"> = PolymorphicProps<TTarget, SurfaceOwnProps>;

export const surfaceSemanticToneClasses: Record<SurfaceSemanticTone, string> = {
  neutral: "border-muted bg-surface-2 text-secondary",
  info: "border-info-soft bg-info-soft text-info",
  success: "border-success-soft bg-success-soft text-success",
  warning: "border-warning-soft bg-warning-soft text-warning",
  danger: "border-danger-soft bg-danger-soft text-danger",
  trust: "border-trust-soft bg-trust-soft text-trust",
  primary: "border-primary-soft bg-primary-soft text-primary",
};

const surfaceToneClasses: Record<SurfaceTone, string> = {
  default: "ds-glass bg-elevated",
  muted: "bg-surface-2",
  accent: "ds-brand-gradient text-accent-contrast",
  subtle: "bg-surface border-muted",
  ...surfaceSemanticToneClasses,
};

/**
 * Frozen tone treatments for the chrome-free elevations. Each tone's legacy
 * class string decomposes into fill, border tint, and text parts: `flush` keeps
 * only the text part (foreground, not chrome — except `accent`, whose contrast
 * text is legible only against its gradient fill), `tinted` renders the tone's
 * soft fill plus text with no chrome, and `outlined` renders a plain `border`
 * in the tone's border tint family plus today's fill and text. `surface-border`,
 * `ds-glass`, shadows, and `ds-glow` render only under unspecified legacy and
 * explicit `elevated`.
 */
const surfaceElevationToneClasses: Record<Exclude<SurfaceElevation, "elevated">, Record<SurfaceTone, string>> = {
  flush: {
    default: "",
    muted: "",
    accent: "",
    subtle: "",
    neutral: "text-secondary",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    trust: "text-trust",
    primary: "text-primary",
  },
  tinted: {
    default: "bg-surface-2",
    muted: "bg-surface-2",
    accent: "ds-brand-gradient text-accent-contrast",
    subtle: "bg-surface-2",
    neutral: "bg-surface-2 text-secondary",
    info: "bg-info-soft text-info",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    trust: "bg-trust-soft text-trust",
    primary: "bg-primary-soft text-primary",
  },
  outlined: {
    default: "border border-muted bg-elevated",
    muted: "border border-muted bg-surface-2",
    accent: "border border-muted ds-brand-gradient text-accent-contrast",
    subtle: "border border-muted bg-surface",
    neutral: "border border-muted bg-surface-2 text-secondary",
    info: "border border-info-soft bg-info-soft text-info",
    success: "border border-success-soft bg-success-soft text-success",
    warning: "border border-warning-soft bg-warning-soft text-warning",
    danger: "border border-danger-soft bg-danger-soft text-danger",
    trust: "border border-trust-soft bg-trust-soft text-trust",
    primary: "border border-primary-soft bg-primary-soft text-primary",
  },
};

/**
 * Canonical furniture surface with tone-driven fills and opt-in
 * `flush`/`tinted`/`outlined`/`elevated` elevation intents.
 *
 * `tone` names the background family wherever a fill exists; `elevation` owns
 * fill presence and the surface chrome (glass, border, shadow). An explicit
 * `elevation` value owns the complete treatment and the legacy `elevated`
 * boolean is ignored; omitting `elevation` renders the legacy recipe unchanged,
 * with `elevated` keeping its exact current shadow meaning.
 */
export const Surface = forwardRef(function Surface(
  {
    children,
    as,
    render,
    element = "div",
    tone = "default",
    elevation,
    elevated = false,
    glow = false,
    padding = 4,
    paddingX,
    paddingY,
    gap,
    textAlign,
    ...rest
  }: SurfaceProps<ElementType>,
  ref: Ref<unknown>,
) {
  const Component = (as ?? render ?? element) as ElementType;
  const systemClasses = resolveSystemProps({
    padding,
    paddingX,
    paddingY,
    gap,
    textAlign,
  });

  return (
    <Component
      {...rest}
      ref={ref}
      className={
        elevation === undefined || elevation === "elevated"
          ? cx(
              "surface-border min-w-0 max-w-full rounded-tokenLg",
              surfaceToneClasses[tone],
              systemClasses,
              elevation === "elevated" || elevated ? "shadow-tokenLg" : "shadow-tokenSm",
              glow && "ds-glow",
            )
          : cx("min-w-0 max-w-full rounded-tokenLg", surfaceElevationToneClasses[elevation][tone], systemClasses)
      }
    >
      {children}
    </Component>
  );
}) as PolymorphicPrimitive<SurfaceOwnProps, "div">;

/**
 * Solid fill tones for the determinate {@link ProgressTrack}, keyed by the same
 * semantic vocabulary as {@link SurfaceSemanticTone}. Unlike a surface's soft
 * tint, a progress fill needs the saturated `bg-{tone}` token so the bar reads
 * against its muted track.
 */
const progressTrackToneClasses: Record<SurfaceSemanticTone, string> = {
  neutral: "bg-secondary",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  trust: "bg-trust",
  primary: "bg-accent",
};

const progressTrackSizeClasses: Record<NonNullable<ProgressTrackProps["size"]>, string> = {
  sm: "h-1.5",
  md: "h-2",
  lg: "h-3",
};

export interface ProgressTrackProps extends Omit<FrameProps, "children"> {
  /** Completion as a percentage from 0–100. Values outside the range are clamped. */
  value: number;
  /** Semantic fill tone, drawn from the shared {@link SurfaceSemanticTone} set. Defaults to `primary`. */
  tone?: SurfaceSemanticTone;
  /** Track thickness. Defaults to `md`. */
  size?: "sm" | "md" | "lg";
  /** Accessible name for the bar when no visible label is wired up via `aria-labelledby`. */
  label?: string;
}

/**
 * Determinate progress track: a muted rail with a tone-tinted fill whose width
 * is the one legitimate dynamic inline style in the design system — it lives
 * here, inside the primitive, so feature UI never hand-rolls a `style={{ width }}`
 * fill. Exposes the full `progressbar` ARIA contract (`role`, `aria-valuemin`/
 * `max`/`now`) and clamps `value` to 0–100. Higher-level bars (e.g. `ProgressBar`)
 * compose this for the visual rail.
 */
export function ProgressTrack({ value, tone = "primary", size = "md", label, ...rest }: ProgressTrackProps) {
  const percentage = Math.max(0, Math.min(100, value));

  return (
    <div
      {...rest}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
      aria-label={label}
      className={cx("w-full overflow-hidden rounded-tokenFull bg-muted", progressTrackSizeClasses[size])}
    >
      <div
        className={cx("h-full rounded-tokenFull transition-all", progressTrackToneClasses[tone])}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

export interface DividerProps extends Omit<ComponentProps<typeof SeparatorPrimitive>, "className" | "style"> {
  decorative?: boolean;
}

export function Divider({ orientation = "horizontal", decorative = true, ...rest }: DividerProps) {
  return (
    <SeparatorPrimitive
      {...rest}
      aria-hidden={decorative || undefined}
      orientation={orientation}
      className={cx("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px")}
    />
  );
}

export interface ScrollAreaProps
  extends PropsWithChildren, Omit<ComponentProps<typeof ScrollAreaPrimitive.Root>, "className" | "style" | "children"> {
  height?: "auto" | "sm" | "md" | "lg" | "full";
}

const scrollHeights: Record<NonNullable<ScrollAreaProps["height"]>, string> = {
  auto: "",
  sm: "max-h-48",
  md: "max-h-72",
  lg: "max-h-96",
  full: "h-full",
};

export function ScrollArea({ children, height = "auto", ...rest }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      {...rest}
      className={cx("modern-surface overflow-hidden rounded-tokenLg border border-muted", scrollHeights[height])}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full">{children}</ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2.5 touch-none select-none bg-transparent p-0.5"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-tokenFull bg-muted" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className="flex h-2.5 touch-none select-none bg-transparent p-0.5"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-tokenFull bg-muted" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="bg-muted" />
    </ScrollAreaPrimitive.Root>
  );
}

export interface VisuallyHiddenProps extends PropsWithChildren, Omit<FrameProps, "children"> {}

export function VisuallyHidden({ children, ...rest }: VisuallyHiddenProps) {
  return (
    <span {...rest} className="sr-only">
      {children}
    </span>
  );
}

export type LiveRegionPoliteness = "polite" | "assertive";

export interface LiveRegionProps extends PropsWithChildren, Omit<FrameProps, "children" | "role"> {
  politeness?: LiveRegionPoliteness;
  atomic?: boolean;
}

/**
 * Assistive-technology announcement region. `assertive` maps to `role="alert"`
 * for urgent validation or handoff failures; `polite` maps to `role="status"`
 * for non-blocking updates.
 */
export function LiveRegion({ children, politeness = "assertive", atomic = true, ...rest }: LiveRegionProps) {
  return (
    <div {...rest} role={politeness === "assertive" ? "alert" : "status"} aria-live={politeness} aria-atomic={atomic}>
      {children}
    </div>
  );
}

export type MountPointPurpose = "provider" | "observer" | "generic";

export interface MountPointProps
  extends PropsWithChildren, Omit<HTMLAttributes<HTMLDivElement>, "children" | "className" | "style"> {
  purpose?: MountPointPurpose;
  hiddenFromAssistiveTechnology?: boolean;
}

const mountPointPurposeClasses: Record<MountPointPurpose, string> = {
  provider: "block w-full min-w-0",
  observer: "h-px w-full overflow-hidden",
  generic: "block min-w-0",
};

/**
 * Sanctioned host node for imperative third-party mounts and behavior-only
 * observer sentinels. It intentionally exposes a ref while keeping local raw
 * structural elements out of feature UI.
 */
export const MountPoint = forwardRef(function MountPoint(
  { children, purpose = "generic", hiddenFromAssistiveTechnology, ...rest }: MountPointProps,
  ref: Ref<HTMLDivElement>,
) {
  const shouldHideFromAssistiveTechnology = hiddenFromAssistiveTechnology ?? purpose === "observer";

  return (
    <div
      {...rest}
      ref={ref}
      aria-hidden={shouldHideFromAssistiveTechnology || undefined}
      className={mountPointPurposeClasses[purpose]}
    >
      {children}
    </div>
  );
});

export type SlotProps = MountPointProps;

/** Semantic alias for behavior-only mount points such as observer sentinels. */
export const Slot = forwardRef(function Slot(props: SlotProps, ref: Ref<HTMLDivElement>) {
  return <MountPoint {...props} ref={ref} />;
});

export function renderOptionalNode(node?: ReactNode): ReactNode {
  return node ?? null;
}

export interface SkipLinkProps {
  targetId?: string;
  label?: string;
}

export function SkipLink({ targetId = "main-content", label = "Skip to main content" }: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-toast focus:rounded-tokenMd focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-contrast focus:shadow-overlay"
    >
      {label}
    </a>
  );
}
