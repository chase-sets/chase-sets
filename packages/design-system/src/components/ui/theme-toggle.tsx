import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const themeStorageKey = "chase-sets-theme";

const options: Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export interface ThemeToggleProps {
  className?: string;
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

export function ThemeToggle({ className }: ThemeToggleProps) {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const storedPreference = readStoredThemePreference();
    setPreference(storedPreference);
    applyThemePreference(storedPreference);
  }, []);

  useEffect(() => {
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
  }, [preference]);

  function selectThemePreference(nextPreference: ThemePreference) {
    storeThemePreference(nextPreference);
    setPreference(nextPreference);
    applyThemePreference(nextPreference);
  }

  return (
    <fieldset
      className={cn(
        "inline-flex rounded-[var(--radius-lg)] border border-[var(--muted)] bg-[var(--card)] p-1 shadow-[var(--shadow-sm)]",
        className,
      )}
      aria-label="Color theme"
    >
      <legend className="sr-only">Color theme</legend>
      {options.map((option) => {
        const Icon = option.icon;

        return (
          <label key={option.value} className="relative cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name="color-theme"
              value={option.value}
              data-theme-choice={option.value}
              checked={preference === option.value}
              onChange={() => selectThemePreference(option.value)}
            />
            <span className="ds-focus inline-flex h-9 items-center gap-1.5 rounded-[var(--radius)] px-2.5 text-xs font-semibold text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] peer-checked:bg-[var(--primary)] peer-checked:text-[var(--primary-foreground)]">
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {option.label}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
