import type { CSSProperties } from "react";

export type BreakpointKey = "base" | "sm" | "md" | "lg" | "xl" | "2xl";
export type ColorMode = "system" | "light" | "dark";
const spacingTokens = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type SpaceToken = (typeof spacingTokens)[number];

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
    secondary: string;
    secondaryForeground: string;
    accent: string;
    accentForeground: string;
    accent2: string;
    accentContrast: string;
    accentHover: string;
    brandPrimary: string;
    brandSecondary: string;
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    danger: string;
    dangerSoft: string;
    dangerHover: string;
    destructiveForeground: string;
    info: string;
    infoSoft: string;
    focusRing: string;
    trust: string;
    trustSoft: string;
    deal: string;
    dealSoft: string;
    rating: string;
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
  };
  radius: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
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
  typography?: Partial<ThemeTokens["typography"]>;
  radius?: Partial<ThemeTokens["radius"]>;
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
    secondary: "var(--secondary)",
    secondaryForeground: "var(--secondary-foreground)",
    accent: "var(--primary)",
    accentForeground: "var(--accent-foreground)",
    accent2: "var(--trust)",
    accentContrast: "var(--primary-foreground)",
    accentHover: "var(--primary-hover)",
    brandPrimary: "var(--primary)",
    brandSecondary: "var(--trust)",
    success: "var(--success)",
    successSoft: "var(--success-soft)",
    warning: "var(--warning)",
    warningSoft: "var(--warning-soft)",
    danger: "var(--destructive)",
    dangerSoft: "var(--error-soft)",
    dangerHover: "var(--color-danger-hover)",
    destructiveForeground: "var(--destructive-foreground)",
    info: "var(--info)",
    infoSoft: "var(--info-soft)",
    focusRing: "var(--ring)",
    trust: "var(--trust)",
    trustSoft: "var(--trust-soft)",
    deal: "var(--deal)",
    dealSoft: "var(--deal-soft)",
    rating: "var(--rating)",
    chaseLogoStart: "var(--chase-logo-start)",
    chaseLogoMid: "var(--chase-logo-mid)",
    chaseLogoEnd: "var(--chase-logo-end)",
    pageSpotlightA: "var(--page-spotlight-a)",
    pageSpotlightB: "var(--page-spotlight-b)",
    surfaceLine: "var(--surface-line)",
    surfaceDepth: "var(--surface-depth)",
  },
  typography: {
    display: 'var(--display-font, "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)',
    heading: 'var(--font-heading, "IBM Plex Sans")',
    body: 'var(--body-font, "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif)',
    mono: 'var(--mono-font, "IBM Plex Mono", ui-monospace, monospace)',
  },
  radius: {
    sm: "var(--radius-sm, 0.375rem)",
    md: "var(--radius, 0.5rem)",
    lg: "var(--radius-lg, 0.75rem)",
    xl: "var(--radius-xl, 1rem)",
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
    sm: "480px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1536px",
  },
};

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
    },
    radius: {
      ...baseTheme.radius,
      ...theme.radius,
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
  ["--secondary", (t) => t.colors?.secondary],
  ["--secondary-foreground", (t) => t.colors?.secondaryForeground],
  ["--accent", (t) => t.colors?.accent],
  ["--accent-foreground", (t) => t.colors?.accentForeground],
  ["--color-accent", (t) => t.colors?.accent],
  ["--color-accent-2", (t) => t.colors?.accent2],
  ["--color-accent-contrast", (t) => t.colors?.accentContrast],
  ["--color-accent-hover", (t) => t.colors?.accentHover],
  ["--color-brand-primary", (t) => t.colors?.brandPrimary],
  ["--color-brand-secondary", (t) => t.colors?.brandSecondary],
  ["--success", (t) => t.colors?.success],
  ["--color-success", (t) => t.colors?.success],
  ["--success-soft", (t) => t.colors?.successSoft],
  ["--warning", (t) => t.colors?.warning],
  ["--color-warning", (t) => t.colors?.warning],
  ["--warning-soft", (t) => t.colors?.warningSoft],
  ["--destructive", (t) => t.colors?.danger],
  ["--color-danger", (t) => t.colors?.danger],
  ["--error-soft", (t) => t.colors?.dangerSoft],
  ["--color-danger-hover", (t) => t.colors?.dangerHover],
  ["--destructive-foreground", (t) => t.colors?.destructiveForeground],
  ["--info", (t) => t.colors?.info],
  ["--color-info", (t) => t.colors?.info],
  ["--info-soft", (t) => t.colors?.infoSoft],
  ["--ring", (t) => t.colors?.focusRing],
  ["--color-focus-ring", (t) => t.colors?.focusRing],
  ["--trust", (t) => t.colors?.trust],
  ["--trust-soft", (t) => t.colors?.trustSoft],
  ["--deal", (t) => t.colors?.deal],
  ["--deal-soft", (t) => t.colors?.dealSoft],
  ["--rating", (t) => t.colors?.rating],
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
  ["--radius-sm", (t) => t.radius?.sm],
  ["--radius", (t) => t.radius?.md],
  ["--radius-md", (t) => t.radius?.md],
  ["--radius-lg", (t) => t.radius?.lg],
  ["--radius-xl", (t) => t.radius?.xl],
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
