import type { CSSProperties } from "react";

export type BreakpointKey = "base" | "sm" | "md" | "lg" | "xl" | "2xl";
export type ColorMode = "system" | "light" | "dark";

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
    surface: string;
    surface2: string;
    surface3: string;
    elevatedSurface: string;
    border: string;
    mutedBorder: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
    textDisabled: string;
    textInverse: string;
    brandPrimary: string;
    brandSecondary: string;
    cyan: string;
    indigo: string;
    accent: string;
    accent2: string;
    accentContrast: string;
    success: string;
    warning: string;
    danger: string;
    info: string;
    focusRing: string;
    glowAccent: string;
    glowBlue: string;
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
  shadows?: Partial<ThemeTokens["shadows"]>;
  zIndex?: Partial<ThemeTokens["zIndex"]>;
  motion?: Partial<ThemeTokens["motion"]>;
}

export const chaseTheme: ThemeTokens = {
  colors: {
    background: "#f4f7ff",
    surface: "#ffffff",
    surface2: "#eef5ff",
    surface3: "#e2ebfb",
    elevatedSurface: "#ffffff",
    border: "#b9c9e6",
    mutedBorder: "#d8e3f5",
    textPrimary: "#07111f",
    textSecondary: "#3f4e64",
    textTertiary: "#65738a",
    textDisabled: "#9aa7b8",
    textInverse: "#f8fbff",
    brandPrimary: "#3882f6",
    brandSecondary: "#8b5cf6",
    cyan: "#06b6d4",
    indigo: "#6366f1",
    accent: "#3882f6",
    accent2: "#8b5cf6",
    accentContrast: "#ffffff",
    success: "#16a34a",
    warning: "#d97706",
    danger: "#dc2626",
    info: "#2563eb",
    focusRing: "#38bdf8",
    glowAccent: "rgba(56, 130, 246, 0.34)",
    glowBlue: "rgba(139, 92, 246, 0.26)",
  },
  typography: {
    display: "Space Grotesk",
    heading: "Space Grotesk",
    body: "Space Grotesk",
    mono: "IBM Plex Mono",
  },
  radius: {
    sm: "0.375rem",
    md: "0.75rem",
    lg: "1rem",
    xl: "1.5rem",
  },
  shadows: {
    sm: "0 10px 30px -20px rgba(15, 23, 42, 0.24)",
    md: "0 18px 50px -26px rgba(30, 64, 175, 0.3)",
    lg: "0 28px 74px -34px rgba(37, 99, 235, 0.38)",
    overlay: "0 36px 104px -32px rgba(30, 64, 175, 0.44)",
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
    fast: "120ms",
    base: "180ms",
    slow: "260ms",
    ease: "cubic-bezier(0.16, 1, 0.3, 1)",
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

export const chaseDarkTheme: ThemeTokens = {
  colors: {
    background: "#05070c",
    surface: "#080f18",
    surface2: "#0b1524",
    surface3: "#121826",
    elevatedSurface: "#101b2d",
    border: "#232b3a",
    mutedBorder: "#171c2b",
    textPrimary: "#f5f7fa",
    textSecondary: "#a1a7b3",
    textTertiary: "#667280",
    textDisabled: "#3b4152",
    textInverse: "#05070c",
    brandPrimary: "#3882f6",
    brandSecondary: "#8b5cf6",
    cyan: "#06b6d4",
    indigo: "#6366f1",
    accent: "#3882f6",
    accent2: "#8b5cf6",
    accentContrast: "#ffffff",
    success: "#22c55e",
    warning: "#f59e0b",
    danger: "#ef4444",
    info: "#38bdf8",
    focusRing: "#38bdf8",
    glowAccent: "rgba(59, 130, 246, 0.56)",
    glowBlue: "rgba(139, 92, 246, 0.4)",
  },
  typography: chaseTheme.typography,
  radius: chaseTheme.radius,
  shadows: {
    sm: "0 8px 28px -18px rgba(0, 0, 0, 0.88)",
    md: "0 16px 52px -26px rgba(0, 0, 0, 0.9)",
    lg: "0 28px 90px -34px rgba(56, 130, 246, 0.42)",
    overlay: "0 42px 120px -28px rgba(0, 0, 0, 0.94)",
  },
  zIndex: chaseTheme.zIndex,
  motion: chaseTheme.motion,
  breakpoints: chaseTheme.breakpoints,
};

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
  ["--color-background", (t) => t.colors?.background],
  ["--color-surface", (t) => t.colors?.surface],
  ["--color-surface-2", (t) => t.colors?.surface2],
  ["--color-surface-3", (t) => t.colors?.surface3],
  ["--color-elevated-surface", (t) => t.colors?.elevatedSurface],
  ["--color-border", (t) => t.colors?.border],
  ["--color-muted-border", (t) => t.colors?.mutedBorder],
  ["--color-text-primary", (t) => t.colors?.textPrimary],
  ["--color-text-secondary", (t) => t.colors?.textSecondary],
  ["--color-text-tertiary", (t) => t.colors?.textTertiary],
  ["--color-text-disabled", (t) => t.colors?.textDisabled],
  ["--color-text-inverse", (t) => t.colors?.textInverse],
  ["--color-brand-primary", (t) => t.colors?.brandPrimary],
  ["--color-brand-secondary", (t) => t.colors?.brandSecondary],
  ["--color-cyan", (t) => t.colors?.cyan],
  ["--color-indigo", (t) => t.colors?.indigo],
  ["--color-accent", (t) => t.colors?.accent],
  ["--color-accent-2", (t) => t.colors?.accent2],
  ["--color-accent-contrast", (t) => t.colors?.accentContrast],
  ["--color-success", (t) => t.colors?.success],
  ["--color-warning", (t) => t.colors?.warning],
  ["--color-danger", (t) => t.colors?.danger],
  ["--color-info", (t) => t.colors?.info],
  ["--color-focus-ring", (t) => t.colors?.focusRing],
  ["--glow-accent", (t) => t.colors?.glowAccent],
  ["--glow-blue", (t) => t.colors?.glowBlue],
  ["--font-display", (t) => t.typography?.display],
  ["--font-heading", (t) => t.typography?.heading],
  ["--font-body", (t) => t.typography?.body],
  ["--font-mono", (t) => t.typography?.mono],
  ["--radius-sm", (t) => t.radius?.sm],
  ["--radius-md", (t) => t.radius?.md],
  ["--radius-lg", (t) => t.radius?.lg],
  ["--radius-xl", (t) => t.radius?.xl],
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

export function resolveThemeStyle(theme?: ThemeOverrides, baseTheme: ThemeTokens = chaseTheme): CSSProperties {
  const resolved = resolveTheme(theme, baseTheme);

  return applyThemeStyle({}, resolved);
}

export function resolveThemeOverrideStyle(theme?: ThemeOverrides): CSSProperties | undefined {
  if (!theme) {
    return undefined;
  }

  const style = applyThemeStyle({}, theme);

  return Object.keys(style).length > 0 ? style : undefined;
}
