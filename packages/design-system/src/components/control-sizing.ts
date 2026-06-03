export type ControlSize = "sm" | "md" | "lg";

export const controlHeightClasses: Record<ControlSize, string> = {
  sm: "min-h-[var(--control-sm-height)]",
  md: "min-h-[var(--control-md-height)]",
  lg: "min-h-[var(--control-lg-height)]",
};

export const controlSquareSizeClasses: Record<ControlSize, string> = {
  sm: "min-h-[var(--control-sm-height)] min-w-[var(--control-sm-height)]",
  md: "min-h-[var(--control-md-height)] min-w-[var(--control-md-height)]",
  lg: "min-h-[var(--control-lg-height)] min-w-[var(--control-lg-height)]",
};

export const controlPaddingClasses: Record<ControlSize, string> = {
  sm: "px-[var(--control-sm-px)] py-[var(--control-sm-py)]",
  md: "px-[var(--control-md-px)] py-[var(--control-md-py)]",
  lg: "px-[var(--control-lg-px)] py-[var(--control-lg-py)]",
};

export const controlTextClasses: Record<ControlSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

export const controlIconButtonSizeClasses: Record<ControlSize, string> = {
  sm: "h-[var(--control-sm-icon-size)] w-[var(--control-sm-icon-size)]",
  md: "h-[var(--control-md-icon-size)] w-[var(--control-md-icon-size)]",
  lg: "h-[var(--control-lg-icon-size)] w-[var(--control-lg-icon-size)]",
};

export const compactControlHeightClasses: Record<ControlSize, string> = {
  sm: "min-h-[var(--control-compact-sm-height)]",
  md: "min-h-[var(--control-compact-md-height)]",
  lg: "min-h-[var(--control-compact-lg-height)]",
};

export const compactControlPaddingClasses: Record<ControlSize, string> = {
  sm: "px-[var(--control-compact-sm-px)]",
  md: "px-[var(--control-compact-md-px)]",
  lg: "px-[var(--control-compact-lg-px)]",
};

export const compoundControlInsetClass = "p-[var(--control-compound-inset)]";
