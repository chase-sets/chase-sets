import type { CSSProperties } from "react";

export type BreakpointKey = "base" | "sm" | "md" | "lg" | "xl" | "2xl";
export type ColorMode = "system" | "light" | "dark";
const spacingTokens = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type SpaceToken = (typeof spacingTokens)[number];
export type FontSizeToken = "3xs" | "2xs" | "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl";
export type LineHeightToken =
  | FontSizeToken
  | "none"
  | "tight"
  | "snug"
  | "normal"
  | "relaxed"
  | "display"
  | "hero"
  | "badge";
export type LetterSpacingToken = "none" | "normal" | "wide" | "label";

export type ResponsiveValue<T> =
  | T
  | {
      base: T;
      sm?: T;
      md?: T;
      lg?: T;
      xl?: T;
      "2xl"?: T;
    };

export type DensityMode = "comfortable" | "compact";
export type DensityModeAlias = "default" | "regular";
export type DensityInput = DensityMode | DensityModeAlias;

export function resolveDensityMode(density: DensityInput): DensityMode {
  return density === "compact" ? "compact" : "comfortable";
}

export interface ThemeTokens {
  colors: {
    background: string;
    foreground: string;
    surface: string;
    surface2: string;
    surface3: string;
    elevatedSurface: string;
    cardForeground: string;
    popover: string;
    popoverForeground: string;
    border: string;
    borderStrong: string;
    muted: string;
    mutedForeground: string;
    mutedBorder: string;
    input: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
    textMuted: string;
    textDisabled: string;
    textInverse: string;
    disabledBackground: string;
    primary: string;
    primaryForeground: string;
    primaryHover: string;
    primaryActive: string;
    primarySoft: string;
    overlay: string;
    secondary: string;
    secondaryForeground: string;
    accent: string;
    accentForeground: string;
    accent2: string;
    accentSoft: string;
    accentContrast: string;
    accentHover: string;
    accentActive: string;
    brandPrimary: string;
    brandSecondary: string;
    success: string;
    successSoft: string;
    successHover: string;
    successActive: string;
    successContrast: string;
    warning: string;
    warningSoft: string;
    warningHover: string;
    warningActive: string;
    warningContrast: string;
    danger: string;
    dangerSoft: string;
    dangerHover: string;
    dangerActive: string;
    dangerContrast: string;
    destructiveForeground: string;
    info: string;
    infoSoft: string;
    infoHover: string;
    infoActive: string;
    infoContrast: string;
    focusRing: string;
    trust: string;
    trustSoft: string;
    deal: string;
    dealSoft: string;
    rating: string;
    ratingSoft: string;
    chaseLogoStart: string;
    chaseLogoMid: string;
    chaseLogoEnd: string;
    pageSpotlightA: string;
    pageSpotlightB: string;
    surfaceLine: string;
    surfaceDepth: string;
  };
  typography: {
    display: string;
    heading: string;
    body: string;
    mono: string;
    fontSize: Record<FontSizeToken, string>;
    lineHeight: Record<LineHeightToken, string>;
    letterSpacing: Record<LetterSpacingToken, string>;
  };
  radius: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
    full: string;
  };
  borderWidth: {
    none: string;
    sm: string;
    md: string;
    lg: string;
  };
  opacity: {
    disabled: string;
    overlay: string;
  };
  spacing: Record<SpaceToken, string>;
  shadows: {
    sm: string;
    md: string;
    lg: string;
    overlay: string;
  };
  zIndex: {
    sticky: string;
    dropdown: string;
    popover: string;
    drawer: string;
    modal: string;
    toast: string;
  };
  motion: {
    fast: string;
    base: string;
    slow: string;
    ease: string;
  };
  breakpoints: Record<BreakpointKey, string>;
}

export interface ThemeOverrides {
  colors?: Partial<ThemeTokens["colors"]>;
  typography?: Partial<Omit<ThemeTokens["typography"], "fontSize" | "lineHeight" | "letterSpacing">> & {
    fontSize?: Partial<ThemeTokens["typography"]["fontSize"]>;
    lineHeight?: Partial<ThemeTokens["typography"]["lineHeight"]>;
    letterSpacing?: Partial<ThemeTokens["typography"]["letterSpacing"]>;
  };
  radius?: Partial<ThemeTokens["radius"]>;
  borderWidth?: Partial<ThemeTokens["borderWidth"]>;
  opacity?: Partial<ThemeTokens["opacity"]>;
  spacing?: Partial<ThemeTokens["spacing"]>;
  shadows?: Partial<ThemeTokens["shadows"]>;
  zIndex?: Partial<ThemeTokens["zIndex"]>;
  motion?: Partial<ThemeTokens["motion"]>;
}

export const chaseTheme: ThemeTokens = {
  colors: {
    background: "var(--background)",
    foreground: "var(--foreground)",
    surface: "var(--card)",
    surface2: "var(--surface-2)",
    surface3: "var(--surface-3)",
    elevatedSurface: "var(--elevated)",
    cardForeground: "var(--card-foreground)",
    popover: "var(--popover)",
    popoverForeground: "var(--popover-foreground)",
    border: "var(--border)",
    borderStrong: "var(--border-strong)",
    muted: "var(--muted)",
    mutedForeground: "var(--muted-foreground)",
    mutedBorder: "var(--muted)",
    input: "var(--input)",
    textPrimary: "var(--foreground)",
    textSecondary: "var(--text-secondary)",
    textTertiary: "var(--text-muted)",
    textMuted: "var(--text-muted)",
    textDisabled: "var(--text-disabled)",
    textInverse: "var(--primary-foreground)",
    disabledBackground: "var(--disabled-bg)",
    primary: "var(--primary)",
    primaryForeground: "var(--primary-foreground)",
    primaryHover: "var(--primary-hover)",
    primaryActive: "var(--primary-active)",
    primarySoft: "var(--primary-soft)",
    overlay: "var(--overlay)",
    secondary: "var(--secondary)",
    secondaryForeground: "var(--secondary-foreground)",
    accent: "var(--primary)",
    accentForeground: "var(--accent-foreground)",
    accent2: "var(--trust)",
    accentSoft: "var(--primary-soft)",
    accentContrast: "var(--primary-foreground)",
    accentHover: "var(--primary-hover)",
    accentActive: "var(--primary-active)",
    brandPrimary: "var(--primary)",
    brandSecondary: "var(--trust)",
    success: "var(--success)",
    successSoft: "var(--success-soft)",
    successHover: "var(--success-hover)",
    successActive: "var(--success-active)",
    successContrast: "var(--success-contrast)",
    warning: "var(--warning)",
    warningSoft: "var(--warning-soft)",
    warningHover: "var(--warning-hover)",
    warningActive: "var(--warning-active)",
    warningContrast: "var(--warning-contrast)",
    danger: "var(--danger)",
    dangerSoft: "var(--danger-soft)",
    dangerHover: "var(--danger-hover)",
    dangerActive: "var(--danger-active)",
    dangerContrast: "var(--danger-contrast)",
    destructiveForeground: "var(--destructive-foreground)",
    info: "var(--info)",
    infoSoft: "var(--info-soft)",
    infoHover: "var(--info-hover)",
    infoActive: "var(--info-active)",
    infoContrast: "var(--info-contrast)",
    focusRing: "var(--ring)",
    trust: "var(--trust)",
    trustSoft: "var(--trust-soft)",
    deal: "var(--deal)",
    dealSoft: "var(--deal-soft)",
    rating: "var(--rating)",
    ratingSoft: "var(--rating-soft)",
    chaseLogoStart: "var(--chase-logo-start)",
    chaseLogoMid: "var(--chase-logo-mid)",
    chaseLogoEnd: "var(--chase-logo-end)",
    pageSpotlightA: "var(--page-spotlight-a)",
    pageSpotlightB: "var(--page-spotlight-b)",
    surfaceLine: "var(--surface-line)",
    surfaceDepth: "var(--surface-depth)",
  },
  typography: {
    display: 'var(--display-font, "Space Grotesk", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)',
    heading: 'var(--font-heading, "Space Grotesk")',
    body: 'var(--body-font, "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)',
    mono: 'var(--mono-font, "IBM Plex Mono", ui-monospace, monospace)',
    fontSize: {
      "3xs": "var(--font-size-3xs, 0.625rem)",
      "2xs": "var(--font-size-2xs, 0.6875rem)",
      xs: "var(--font-size-xs, 0.75rem)",
      sm: "var(--font-size-sm, 0.875rem)",
      base: "var(--font-size-base, 1rem)",
      lg: "var(--font-size-lg, 1.125rem)",
      xl: "var(--font-size-xl, 1.25rem)",
      "2xl": "var(--font-size-2xl, 1.5rem)",
      "3xl": "var(--font-size-3xl, 1.875rem)",
      "4xl": "var(--font-size-4xl, 2.25rem)",
      "5xl": "var(--font-size-5xl, 3rem)",
    },
    lineHeight: {
      "3xs": "var(--line-height-3xs, 1)",
      "2xs": "var(--line-height-2xs, 1rem)",
      xs: "var(--line-height-xs, 1rem)",
      sm: "var(--line-height-sm, 1.25rem)",
      base: "var(--line-height-base, 1.5rem)",
      lg: "var(--line-height-lg, 1.75rem)",
      xl: "var(--line-height-xl, 1.75rem)",
      "2xl": "var(--line-height-2xl, 2rem)",
      "3xl": "var(--line-height-3xl, 2.25rem)",
      "4xl": "var(--line-height-4xl, 2.5rem)",
      "5xl": "var(--line-height-5xl, 1)",
      none: "var(--line-height-none, 1)",
      tight: "var(--line-height-tight, 1.25)",
      snug: "var(--line-height-snug, 1.375)",
      normal: "var(--line-height-normal, 1.5)",
      relaxed: "var(--line-height-relaxed, 1.625)",
      display: "var(--line-height-display, 1.15)",
      hero: "var(--line-height-hero, 1.08)",
      badge: "var(--line-height-badge, 1rem)",
    },
    letterSpacing: {
      none: "var(--letter-spacing-none, 0)",
      normal: "var(--letter-spacing-normal, 0)",
      wide: "var(--letter-spacing-wide, 0.025em)",
      label: "var(--letter-spacing-label, 0)",
    },
  },
  radius: {
    sm: "var(--radius-sm, 0.375rem)",
    md: "var(--radius, 0.5rem)",
    lg: "var(--radius-lg, 0.75rem)",
    xl: "var(--radius-xl, 1rem)",
    full: "var(--radius-full, 9999px)",
  },
  borderWidth: {
    none: "var(--border-width-0, 0)",
    sm: "var(--border-width-sm, 1px)",
    md: "var(--border-width-md, 2px)",
    lg: "var(--border-width-lg, 4px)",
  },
  opacity: {
    disabled: "var(--opacity-disabled, 0.5)",
    overlay: "var(--opacity-overlay, 0.88)",
  },
  spacing: {
    0: "var(--space-0)",
    1: "var(--space-1)",
    2: "var(--space-2)",
    3: "var(--space-3)",
    4: "var(--space-4)",
    5: "var(--space-5)",
    6: "var(--space-6)",
    7: "var(--space-7)",
    8: "var(--space-8)",
    9: "var(--space-9)",
    10: "var(--space-10)",
    11: "var(--space-11)",
    12: "var(--space-12)",
  },
  shadows: {
    sm: "var(--shadow-sm)",
    md: "var(--shadow-md)",
    lg: "var(--shadow-lg)",
    overlay: "var(--shadow-overlay)",
  },
  zIndex: {
    sticky: "20",
    dropdown: "65",
    popover: "70",
    drawer: "50",
    modal: "60",
    toast: "80",
  },
  motion: {
    fast: "var(--motion-fast, 120ms)",
    base: "var(--motion-base, 150ms)",
    slow: "var(--motion-slow, 240ms)",
    ease: "var(--motion-ease, cubic-bezier(0.16, 1, 0.3, 1))",
  },
  breakpoints: {
    base: "0px",
    sm: "640px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1536px",
  },
};

export function minWidthQuery(breakpoint: BreakpointKey): string {
  return `(min-width: ${chaseTheme.breakpoints[breakpoint]})`;
}

export const chaseDarkTheme: ThemeTokens = chaseTheme;

export function resolveTheme(theme?: ThemeOverrides, baseTheme: ThemeTokens = chaseTheme): ThemeTokens {
  if (!theme) {
    return baseTheme;
  }

  return {
    colors: {
      ...baseTheme.colors,
      ...theme.colors,
    },
    typography: {
      ...baseTheme.typography,
      ...theme.typography,
      fontSize: {
        ...baseTheme.typography.fontSize,
        ...theme.typography?.fontSize,
      },
      lineHeight: {
        ...baseTheme.typography.lineHeight,
        ...theme.typography?.lineHeight,
      },
      letterSpacing: {
        ...baseTheme.typography.letterSpacing,
        ...theme.typography?.letterSpacing,
      },
    },
    radius: {
      ...baseTheme.radius,
      ...theme.radius,
    },
    borderWidth: {
      ...baseTheme.borderWidth,
      ...theme.borderWidth,
    },
    opacity: {
      ...baseTheme.opacity,
      ...theme.opacity,
    },
    spacing: {
      ...baseTheme.spacing,
      ...theme.spacing,
    },
    shadows: {
      ...baseTheme.shadows,
      ...theme.shadows,
    },
    zIndex: {
      ...baseTheme.zIndex,
      ...theme.zIndex,
    },
    motion: {
      ...baseTheme.motion,
      ...theme.motion,
    },
    breakpoints: baseTheme.breakpoints,
  };
}

const tokenMap: [string, (theme: ThemeTokens | ThemeOverrides) => string | undefined][] = [
  ["--background", (t) => t.colors?.background],
  ["--color-background", (t) => t.colors?.background],
  ["--foreground", (t) => t.colors?.foreground],
  ["--card", (t) => t.colors?.surface],
  ["--color-surface", (t) => t.colors?.surface],
  ["--surface-2", (t) => t.colors?.surface2],
  ["--color-surface-2", (t) => t.colors?.surface2],
  ["--surface-3", (t) => t.colors?.surface3],
  ["--color-surface-3", (t) => t.colors?.surface3],
  ["--elevated", (t) => t.colors?.elevatedSurface],
  ["--color-elevated-surface", (t) => t.colors?.elevatedSurface],
  ["--card-foreground", (t) => t.colors?.cardForeground],
  ["--popover", (t) => t.colors?.popover],
  ["--popover-foreground", (t) => t.colors?.popoverForeground],
  ["--border", (t) => t.colors?.border],
  ["--color-border", (t) => t.colors?.border],
  ["--border-strong", (t) => t.colors?.borderStrong],
  ["--muted", (t) => t.colors?.muted],
  ["--muted-foreground", (t) => t.colors?.mutedForeground],
  ["--color-muted-border", (t) => t.colors?.mutedBorder],
  ["--input", (t) => t.colors?.input],
  ["--text-primary", (t) => t.colors?.textPrimary],
  ["--color-text-primary", (t) => t.colors?.textPrimary],
  ["--text-secondary", (t) => t.colors?.textSecondary],
  ["--color-text-secondary", (t) => t.colors?.textSecondary],
  ["--text-muted", (t) => t.colors?.textTertiary],
  ["--color-text-tertiary", (t) => t.colors?.textTertiary],
  ["--color-text-disabled", (t) => t.colors?.textDisabled],
  ["--text-disabled", (t) => t.colors?.textDisabled],
  ["--color-text-inverse", (t) => t.colors?.textInverse],
  ["--disabled-bg", (t) => t.colors?.disabledBackground],
  ["--disabled-text", (t) => t.colors?.textDisabled],
  ["--primary", (t) => t.colors?.primary],
  ["--primary-foreground", (t) => t.colors?.primaryForeground],
  ["--primary-hover", (t) => t.colors?.primaryHover],
  ["--primary-active", (t) => t.colors?.primaryActive],
  ["--primary-soft", (t) => t.colors?.primarySoft],
  ["--overlay", (t) => t.colors?.overlay],
  ["--color-overlay", (t) => t.colors?.overlay],
  ["--secondary", (t) => t.colors?.secondary],
  ["--secondary-foreground", (t) => t.colors?.secondaryForeground],
  ["--accent", (t) => t.colors?.accent],
  ["--accent-foreground", (t) => t.colors?.accentForeground],
  ["--color-accent", (t) => t.colors?.accent],
  ["--color-accent-2", (t) => t.colors?.accent2],
  ["--color-accent-soft", (t) => t.colors?.accentSoft],
  ["--color-accent-contrast", (t) => t.colors?.accentContrast],
  ["--color-accent-hover", (t) => t.colors?.accentHover],
  ["--color-accent-active", (t) => t.colors?.accentActive],
  ["--color-brand-primary", (t) => t.colors?.brandPrimary],
  ["--color-brand-secondary", (t) => t.colors?.brandSecondary],
  ["--success", (t) => t.colors?.success],
  ["--color-success", (t) => t.colors?.success],
  ["--success-soft", (t) => t.colors?.successSoft],
  ["--color-success-soft", (t) => t.colors?.successSoft],
  ["--success-hover", (t) => t.colors?.successHover],
  ["--color-success-hover", (t) => t.colors?.successHover],
  ["--success-active", (t) => t.colors?.successActive],
  ["--color-success-active", (t) => t.colors?.successActive],
  ["--success-contrast", (t) => t.colors?.successContrast],
  ["--color-success-contrast", (t) => t.colors?.successContrast],
  ["--warning", (t) => t.colors?.warning],
  ["--color-warning", (t) => t.colors?.warning],
  ["--warning-soft", (t) => t.colors?.warningSoft],
  ["--color-warning-soft", (t) => t.colors?.warningSoft],
  ["--warning-hover", (t) => t.colors?.warningHover],
  ["--color-warning-hover", (t) => t.colors?.warningHover],
  ["--warning-active", (t) => t.colors?.warningActive],
  ["--color-warning-active", (t) => t.colors?.warningActive],
  ["--warning-contrast", (t) => t.colors?.warningContrast],
  ["--color-warning-contrast", (t) => t.colors?.warningContrast],
  ["--danger", (t) => t.colors?.danger],
  ["--destructive", (t) => t.colors?.danger],
  ["--color-danger", (t) => t.colors?.danger],
  ["--danger-soft", (t) => t.colors?.dangerSoft],
  ["--color-danger-soft", (t) => t.colors?.dangerSoft],
  ["--danger-hover", (t) => t.colors?.dangerHover],
  ["--color-danger-hover", (t) => t.colors?.dangerHover],
  ["--danger-active", (t) => t.colors?.dangerActive],
  ["--color-danger-active", (t) => t.colors?.dangerActive],
  ["--danger-contrast", (t) => t.colors?.dangerContrast],
  ["--color-danger-contrast", (t) => t.colors?.dangerContrast],
  ["--destructive-foreground", (t) => t.colors?.destructiveForeground],
  ["--info", (t) => t.colors?.info],
  ["--color-info", (t) => t.colors?.info],
  ["--info-soft", (t) => t.colors?.infoSoft],
  ["--color-info-soft", (t) => t.colors?.infoSoft],
  ["--info-hover", (t) => t.colors?.infoHover],
  ["--color-info-hover", (t) => t.colors?.infoHover],
  ["--info-active", (t) => t.colors?.infoActive],
  ["--color-info-active", (t) => t.colors?.infoActive],
  ["--info-contrast", (t) => t.colors?.infoContrast],
  ["--color-info-contrast", (t) => t.colors?.infoContrast],
  ["--ring", (t) => t.colors?.focusRing],
  ["--color-focus-ring", (t) => t.colors?.focusRing],
  ["--trust", (t) => t.colors?.trust],
  ["--color-trust", (t) => t.colors?.trust],
  ["--trust-soft", (t) => t.colors?.trustSoft],
  ["--color-trust-soft", (t) => t.colors?.trustSoft],
  ["--deal", (t) => t.colors?.deal],
  ["--color-deal", (t) => t.colors?.deal],
  ["--deal-soft", (t) => t.colors?.dealSoft],
  ["--color-deal-soft", (t) => t.colors?.dealSoft],
  ["--rating", (t) => t.colors?.rating],
  ["--color-rating", (t) => t.colors?.rating],
  ["--rating-soft", (t) => t.colors?.ratingSoft],
  ["--color-rating-soft", (t) => t.colors?.ratingSoft],
  ["--chase-logo-start", (t) => t.colors?.chaseLogoStart],
  ["--chase-logo-mid", (t) => t.colors?.chaseLogoMid],
  ["--chase-logo-end", (t) => t.colors?.chaseLogoEnd],
  ["--page-spotlight-a", (t) => t.colors?.pageSpotlightA],
  ["--page-spotlight-b", (t) => t.colors?.pageSpotlightB],
  ["--surface-line", (t) => t.colors?.surfaceLine],
  ["--surface-depth", (t) => t.colors?.surfaceDepth],
  ["--display-font", (t) => t.typography?.display],
  ["--font-display", (t) => t.typography?.display],
  ["--font-heading", (t) => t.typography?.heading],
  ["--body-font", (t) => t.typography?.body],
  ["--font-body", (t) => t.typography?.body],
  ["--mono-font", (t) => t.typography?.mono],
  ["--font-mono", (t) => t.typography?.mono],
  ["--font-size-3xs", (t) => t.typography?.fontSize?.["3xs"]],
  ["--font-size-2xs", (t) => t.typography?.fontSize?.["2xs"]],
  ["--font-size-xs", (t) => t.typography?.fontSize?.xs],
  ["--font-size-sm", (t) => t.typography?.fontSize?.sm],
  ["--font-size-base", (t) => t.typography?.fontSize?.base],
  ["--font-size-lg", (t) => t.typography?.fontSize?.lg],
  ["--font-size-xl", (t) => t.typography?.fontSize?.xl],
  ["--font-size-2xl", (t) => t.typography?.fontSize?.["2xl"]],
  ["--font-size-3xl", (t) => t.typography?.fontSize?.["3xl"]],
  ["--font-size-4xl", (t) => t.typography?.fontSize?.["4xl"]],
  ["--font-size-5xl", (t) => t.typography?.fontSize?.["5xl"]],
  ["--line-height-3xs", (t) => t.typography?.lineHeight?.["3xs"]],
  ["--line-height-2xs", (t) => t.typography?.lineHeight?.["2xs"]],
  ["--line-height-xs", (t) => t.typography?.lineHeight?.xs],
  ["--line-height-sm", (t) => t.typography?.lineHeight?.sm],
  ["--line-height-base", (t) => t.typography?.lineHeight?.base],
  ["--line-height-lg", (t) => t.typography?.lineHeight?.lg],
  ["--line-height-xl", (t) => t.typography?.lineHeight?.xl],
  ["--line-height-2xl", (t) => t.typography?.lineHeight?.["2xl"]],
  ["--line-height-3xl", (t) => t.typography?.lineHeight?.["3xl"]],
  ["--line-height-4xl", (t) => t.typography?.lineHeight?.["4xl"]],
  ["--line-height-5xl", (t) => t.typography?.lineHeight?.["5xl"]],
  ["--line-height-none", (t) => t.typography?.lineHeight?.none],
  ["--line-height-tight", (t) => t.typography?.lineHeight?.tight],
  ["--line-height-snug", (t) => t.typography?.lineHeight?.snug],
  ["--line-height-normal", (t) => t.typography?.lineHeight?.normal],
  ["--line-height-relaxed", (t) => t.typography?.lineHeight?.relaxed],
  ["--line-height-display", (t) => t.typography?.lineHeight?.display],
  ["--line-height-hero", (t) => t.typography?.lineHeight?.hero],
  ["--line-height-badge", (t) => t.typography?.lineHeight?.badge],
  ["--letter-spacing-none", (t) => t.typography?.letterSpacing?.none],
  ["--letter-spacing-normal", (t) => t.typography?.letterSpacing?.normal],
  ["--letter-spacing-wide", (t) => t.typography?.letterSpacing?.wide],
  ["--letter-spacing-label", (t) => t.typography?.letterSpacing?.label],
  ["--radius-sm", (t) => t.radius?.sm],
  ["--radius", (t) => t.radius?.md],
  ["--radius-md", (t) => t.radius?.md],
  ["--radius-lg", (t) => t.radius?.lg],
  ["--radius-xl", (t) => t.radius?.xl],
  ["--radius-full", (t) => t.radius?.full],
  ["--border-width-0", (t) => t.borderWidth?.none],
  ["--border-width-sm", (t) => t.borderWidth?.sm],
  ["--border-width-md", (t) => t.borderWidth?.md],
  ["--border-width-lg", (t) => t.borderWidth?.lg],
  ["--opacity-disabled", (t) => t.opacity?.disabled],
  ["--opacity-overlay", (t) => t.opacity?.overlay],
  ["--space-0", (t) => t.spacing?.[0]],
  ["--space-1", (t) => t.spacing?.[1]],
  ["--space-2", (t) => t.spacing?.[2]],
  ["--space-3", (t) => t.spacing?.[3]],
  ["--space-4", (t) => t.spacing?.[4]],
  ["--space-5", (t) => t.spacing?.[5]],
  ["--space-6", (t) => t.spacing?.[6]],
  ["--space-7", (t) => t.spacing?.[7]],
  ["--space-8", (t) => t.spacing?.[8]],
  ["--space-9", (t) => t.spacing?.[9]],
  ["--space-10", (t) => t.spacing?.[10]],
  ["--space-11", (t) => t.spacing?.[11]],
  ["--space-12", (t) => t.spacing?.[12]],
  ["--shadow-sm", (t) => t.shadows?.sm],
  ["--shadow-md", (t) => t.shadows?.md],
  ["--shadow-lg", (t) => t.shadows?.lg],
  ["--shadow-overlay", (t) => t.shadows?.overlay],
  ["--z-sticky", (t) => t.zIndex?.sticky],
  ["--z-dropdown", (t) => t.zIndex?.dropdown],
  ["--z-popover", (t) => t.zIndex?.popover],
  ["--z-drawer", (t) => t.zIndex?.drawer],
  ["--z-modal", (t) => t.zIndex?.modal],
  ["--z-toast", (t) => t.zIndex?.toast],
  ["--motion-fast", (t) => t.motion?.fast],
  ["--motion-base", (t) => t.motion?.base],
  ["--motion-slow", (t) => t.motion?.slow],
  ["--motion-ease", (t) => t.motion?.ease],
];

function applyThemeStyle(target: CSSProperties, theme: ThemeTokens | ThemeOverrides): CSSProperties {
  const record = target as Record<string, string>;
  for (const [cssVar, accessor] of tokenMap) {
    const value = accessor(theme);
    if (value !== undefined) {
      record[cssVar] = value;
    }
  }
  return target;
}

export function resolveThemeStyle(theme?: ThemeOverrides, baseTheme?: ThemeTokens): CSSProperties {
  if (!baseTheme) {
    return theme ? applyThemeStyle({}, theme) : {};
  }

  return applyThemeStyle({}, resolveTheme(theme, baseTheme));
}

export function resolveThemeOverrideStyle(theme?: ThemeOverrides): CSSProperties | undefined {
  if (!theme) {
    return undefined;
  }

  const style = applyThemeStyle({}, theme);

  return Object.keys(style).length > 0 ? style : undefined;
}
