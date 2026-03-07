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
    elevatedSurface: string;
    border: string;
    mutedBorder: string;
    textPrimary: string;
    textSecondary: string;
    textInverse: string;
    accent: string;
    accentContrast: string;
    success: string;
    warning: string;
    danger: string;
    info: string;
    focusRing: string;
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
    background: "#f5f7fb",
    surface: "#ffffff",
    elevatedSurface: "#fcfdff",
    border: "#d7e0ea",
    mutedBorder: "#e7edf5",
    textPrimary: "#0f172a",
    textSecondary: "#475569",
    textInverse: "#f8fafc",
    accent: "#0f766e",
    accentContrast: "#f0fdfa",
    success: "#15803d",
    warning: "#b45309",
    danger: "#be123c",
    info: "#1d4ed8",
    focusRing: "#14b8a6"
  },
  typography: {
    display: "Fraunces",
    heading: "Fraunces",
    body: "Plus Jakarta Sans",
    mono: "IBM Plex Mono"
  },
  radius: {
    sm: "0.5rem",
    md: "0.875rem",
    lg: "1.25rem",
    xl: "1.75rem"
  },
  shadows: {
    sm: "0 10px 30px -18px rgba(15, 23, 42, 0.14)",
    md: "0 20px 40px -22px rgba(15, 23, 42, 0.18)",
    lg: "0 28px 60px -24px rgba(15, 23, 42, 0.22)",
    overlay: "0 36px 90px -28px rgba(15, 23, 42, 0.32)"
  },
  zIndex: {
    sticky: "20",
    dropdown: "30",
    popover: "40",
    drawer: "50",
    modal: "60",
    toast: "70"
  },
  motion: {
    fast: "120ms",
    base: "180ms",
    slow: "260ms",
    ease: "cubic-bezier(0.16, 1, 0.3, 1)"
  },
  breakpoints: {
    base: "0px",
    sm: "480px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1536px"
  }
};

export const chaseDarkTheme: ThemeTokens = {
  colors: {
    background: "#08111f",
    surface: "#0f1b2d",
    elevatedSurface: "#13233a",
    border: "#20324d",
    mutedBorder: "#2b415f",
    textPrimary: "#e5eef8",
    textSecondary: "#94a3b8",
    textInverse: "#08111f",
    accent: "#2dd4bf",
    accentContrast: "#042f2e",
    success: "#4ade80",
    warning: "#f59e0b",
    danger: "#fb7185",
    info: "#60a5fa",
    focusRing: "#5eead4"
  },
  typography: chaseTheme.typography,
  radius: chaseTheme.radius,
  shadows: {
    sm: "0 14px 32px -22px rgba(2, 6, 23, 0.6)",
    md: "0 24px 50px -24px rgba(2, 6, 23, 0.68)",
    lg: "0 32px 70px -26px rgba(2, 6, 23, 0.72)",
    overlay: "0 42px 110px -24px rgba(2, 6, 23, 0.82)"
  },
  zIndex: chaseTheme.zIndex,
  motion: chaseTheme.motion,
  breakpoints: chaseTheme.breakpoints
};

export function resolveTheme(
  theme?: ThemeOverrides,
  baseTheme: ThemeTokens = chaseTheme
): ThemeTokens {
  if (!theme) {
    return baseTheme;
  }

  return {
    colors: {
      ...baseTheme.colors,
      ...theme.colors
    },
    typography: {
      ...baseTheme.typography,
      ...theme.typography
    },
    radius: {
      ...baseTheme.radius,
      ...theme.radius
    },
    shadows: {
      ...baseTheme.shadows,
      ...theme.shadows
    },
    zIndex: {
      ...baseTheme.zIndex,
      ...theme.zIndex
    },
    motion: {
      ...baseTheme.motion,
      ...theme.motion
    },
    breakpoints: baseTheme.breakpoints
  };
}

const tokenMap: [string, (theme: ThemeTokens | ThemeOverrides) => string | undefined][] = [
  ["--color-background", (t) => t.colors?.background],
  ["--color-surface", (t) => t.colors?.surface],
  ["--color-elevated-surface", (t) => t.colors?.elevatedSurface],
  ["--color-border", (t) => t.colors?.border],
  ["--color-muted-border", (t) => t.colors?.mutedBorder],
  ["--color-text-primary", (t) => t.colors?.textPrimary],
  ["--color-text-secondary", (t) => t.colors?.textSecondary],
  ["--color-text-inverse", (t) => t.colors?.textInverse],
  ["--color-accent", (t) => t.colors?.accent],
  ["--color-accent-contrast", (t) => t.colors?.accentContrast],
  ["--color-success", (t) => t.colors?.success],
  ["--color-warning", (t) => t.colors?.warning],
  ["--color-danger", (t) => t.colors?.danger],
  ["--color-info", (t) => t.colors?.info],
  ["--color-focus-ring", (t) => t.colors?.focusRing],
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

function applyThemeStyle(
  target: CSSProperties,
  theme: ThemeTokens | ThemeOverrides
): CSSProperties {
  const record = target as Record<string, string>;
  for (const [cssVar, accessor] of tokenMap) {
    const value = accessor(theme);
    if (value !== undefined) {
      record[cssVar] = value;
    }
  }
  return target;
}

export function resolveThemeStyle(
  theme?: ThemeOverrides,
  baseTheme: ThemeTokens = chaseTheme
): CSSProperties {
  const resolved = resolveTheme(theme, baseTheme);

  return applyThemeStyle({}, resolved);
}

export function resolveThemeOverrideStyle(
  theme?: ThemeOverrides
): CSSProperties | undefined {
  if (!theme) {
    return undefined;
  }

  const style = applyThemeStyle({}, theme);

  return Object.keys(style).length > 0 ? style : undefined;
}
