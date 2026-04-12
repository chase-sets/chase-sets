import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./bounded-contexts/**/*.{ts,tsx}",
    "./packages/design-system/src/**/*.{ts,tsx}",
    "./deployables/admin-web/app/**/*.{ts,tsx}",
    "./deployables/admin-web/src/**/*.{ts,tsx}",
    "./deployables/design-system-showcase/app/**/*.{ts,tsx}",
    "./deployables/design-system-showcase/src/**/*.{ts,tsx}",
    "./deployables/design-system-showcase/index.html",
    "./deployables/marketplace/app/**/*.{ts,tsx}",
    "./deployables/marketplace/src/**/*.{ts,tsx}",
    "./deployables/marketplace/index.html",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--color-background)",
        surface: "var(--color-surface)",
        elevated: "var(--color-elevated-surface)",
        border: "var(--color-border)",
        muted: "var(--color-muted-border)",
        foreground: "var(--color-text-primary)",
        secondary: "var(--color-text-secondary)",
        inverse: "var(--color-text-inverse)",
        accent: "var(--color-accent)",
        "accent-contrast": "var(--color-accent-contrast)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)",
        info: "var(--color-info)",
        focus: "var(--color-focus-ring)",
        "accent-hover": "var(--color-accent-hover)",
        "danger-hover": "var(--color-danger-hover)"
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui"],
        heading: ["var(--font-heading)", "ui-sans-serif", "system-ui"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"]
      },
      boxShadow: {
        tokenSm: "var(--shadow-sm)",
        tokenMd: "var(--shadow-md)",
        tokenLg: "var(--shadow-lg)",
        overlay: "var(--shadow-overlay)"
      },
      borderRadius: {
        tokenSm: "var(--radius-sm)",
        tokenMd: "var(--radius-md)",
        tokenLg: "var(--radius-lg)",
        tokenXl: "var(--radius-xl)"
      },
      zIndex: {
        sticky: "var(--z-sticky)",
        dropdown: "var(--z-dropdown)",
        popover: "var(--z-popover)",
        drawer: "var(--z-drawer)",
        modal: "var(--z-modal)",
        toast: "var(--z-toast)"
      }
    }
  }
};

export default config;
