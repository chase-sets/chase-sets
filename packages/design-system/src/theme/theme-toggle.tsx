import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ColorMode } from "./tokens";
import { cx } from "../utils/cx";

export type ThemePreference = ColorMode;
type ResolvedTheme = "light" | "dark";

const themeStorageKey = "chase-sets-theme";

const options: Array<{
  value: ColorMode;
  icon: typeof Monitor;
}> = [
  { value: "system", icon: Monitor },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
];

export interface ThemePreferenceControlProps {
  className?: string;
  darkLabel?: string;
  label?: string;
  lightLabel?: string;
  name?: string;
  onValueChange: (preference: ColorMode) => void;
  systemLabel?: string;
  value: ColorMode;
}

export interface ThemeToggleProps extends Omit<ThemePreferenceControlProps, "onValueChange" | "value"> {
  defaultValue?: ThemePreference;
  onValueChange?: (preference: ThemePreference) => void;
  value?: ThemePreference;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  const stored =
    typeof window.localStorage?.getItem === "function"
      ? (() => {
          try {
            return window.localStorage.getItem(themeStorageKey);
          } catch {
            return null;
          }
        })()
      : null;

  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function storeThemePreference(preference: ThemePreference) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  try {
    window.localStorage.setItem(themeStorageKey, preference);
  } catch {
    // Theme changes should still apply when storage is unavailable.
  }
}

function applyThemePreference(preference: ThemePreference) {
  if (typeof document === "undefined") {
    return;
  }

  const resolvedTheme = preference === "system" ? getSystemTheme() : preference;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
}

export function ThemePreferenceControl({
  className,
  darkLabel = "Dark",
  label = "Color theme",
  lightLabel = "Light",
  name,
  onValueChange,
  systemLabel = "System",
  value,
}: ThemePreferenceControlProps) {
  const generatedName = useId();
  const labels: Record<ColorMode, string> = {
    dark: darkLabel,
    light: lightLabel,
    system: systemLabel,
  };

  return (
    <fieldset
      className={cx("inline-flex rounded-tokenLg border border-muted bg-surface p-1 shadow-tokenSm", className)}
      aria-label={label}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const Icon = option.icon;

        return (
          <label key={option.value} className="relative cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name={name ?? `color-theme-${generatedName}`}
              value={option.value}
              data-theme-choice={option.value}
              checked={value === option.value}
              onChange={() => onValueChange(option.value)}
            />
            <span className="ds-focus inline-flex h-9 items-center gap-1.5 rounded-tokenMd px-2.5 text-xs font-semibold text-secondary transition-colors hover:bg-surface-2 hover:text-foreground peer-checked:bg-accent peer-checked:text-accent-contrast motion-reduce:transition-none">
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {labels[option.value]}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function ThemeToggle({
  className,
  defaultValue = "system",
  onValueChange,
  value,
  ...controlProps
}: ThemeToggleProps) {
  const controlled = value !== undefined;
  const [uncontrolledPreference, setUncontrolledPreference] = useState<ThemePreference>(defaultValue);
  const preference = value ?? uncontrolledPreference;

  useEffect(() => {
    if (controlled) {
      return;
    }

    const storedPreference = readStoredThemePreference();
    setUncontrolledPreference(storedPreference);
    applyThemePreference(storedPreference);
  }, [controlled]);

  useEffect(() => {
    if (controlled) {
      return undefined;
    }

    applyThemePreference(preference);

    if (preference !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyThemePreference("system");

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
    }

    mediaQuery.addListener(handleSystemThemeChange);
    return () => mediaQuery.removeListener(handleSystemThemeChange);
  }, [controlled, preference]);

  function selectThemePreference(nextPreference: ThemePreference) {
    onValueChange?.(nextPreference);

    if (controlled) {
      return;
    }

    storeThemePreference(nextPreference);
    setUncontrolledPreference(nextPreference);
    applyThemePreference(nextPreference);
  }

  return (
    <ThemePreferenceControl
      {...controlProps}
      className={className}
      value={preference}
      onValueChange={selectThemePreference}
    />
  );
}
