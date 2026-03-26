import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter, UNSAFE_withComponentProps, Outlet, UNSAFE_withErrorBoundaryProps, useRouteError, isRouteErrorResponse, Links, Scripts, useLoaderData, useLocation, Meta, ScrollRestoration, redirect } from "react-router";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { createContext, useContext, useState, useSyncExternalStore, useMemo, forwardRef, useId, useCallback, useEffect } from "react";
import { MotionConfig, motion, LayoutGroup } from "motion/react";
import { createPortal } from "react-dom";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { ulid } from "ulid";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SelectPrimitive from "@radix-ui/react-select";
import { hc } from "hono/client";
const streamTimeout = 5e3;
function handleRequest(request, responseStatusCode, responseHeaders, routerContext, loadContext) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders
    });
  }
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");
    let readyOption = userAgent && isbot(userAgent) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";
    let timeoutId = setTimeout(
      () => abort(),
      streamTimeout + 1e3
    );
    const { pipe, abort } = renderToPipeableStream(
      /* @__PURE__ */ jsx(ServerRouter, { context: routerContext, url: request.url }),
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              timeoutId = void 0;
              callback();
            }
          });
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          pipe(body);
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode
            })
          );
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        }
      }
    );
  });
}
const entryServer = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: handleRequest,
  streamTimeout
}, Symbol.toStringTag, { value: "Module" }));
function loader$d({
  request
}) {
  return {
    origin: new URL(request.url).origin
  };
}
function Layout({
  children
}) {
  const {
    origin
  } = useLoaderData();
  const location = useLocation();
  const canonicalUrl = new URL(`${location.pathname}${location.search}`, origin).toString();
  return /* @__PURE__ */ jsxs("html", {
    lang: "en",
    children: [/* @__PURE__ */ jsxs("head", {
      children: [/* @__PURE__ */ jsx("meta", {
        charSet: "utf-8"
      }), /* @__PURE__ */ jsx("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1"
      }), /* @__PURE__ */ jsx(Meta, {}), /* @__PURE__ */ jsx("link", {
        rel: "canonical",
        href: canonicalUrl
      }), /* @__PURE__ */ jsx(Links, {})]
    }), /* @__PURE__ */ jsxs("body", {
      children: [children, /* @__PURE__ */ jsx(ScrollRestoration, {}), /* @__PURE__ */ jsx(Scripts, {})]
    })]
  });
}
const root = UNSAFE_withComponentProps(function App() {
  return /* @__PURE__ */ jsx(Outlet, {});
});
const ErrorBoundary = UNSAFE_withErrorBoundaryProps(function ErrorBoundary2() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? error.statusText : error instanceof Error ? error.message : "Unknown error";
  return /* @__PURE__ */ jsxs("html", {
    lang: "en",
    children: [/* @__PURE__ */ jsxs("head", {
      children: [/* @__PURE__ */ jsx("meta", {
        charSet: "utf-8"
      }), /* @__PURE__ */ jsx("meta", {
        name: "viewport",
        content: "width=device-width, initial-scale=1"
      }), /* @__PURE__ */ jsx("title", {
        children: "Catalog Admin Error"
      }), /* @__PURE__ */ jsx(Links, {})]
    }), /* @__PURE__ */ jsxs("body", {
      children: [/* @__PURE__ */ jsxs("main", {
        children: [/* @__PURE__ */ jsx("h1", {
          children: "Catalog Admin Error"
        }), /* @__PURE__ */ jsx("p", {
          children: message
        })]
      }), /* @__PURE__ */ jsx(Scripts, {})]
    })]
  });
});
const route0 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ErrorBoundary,
  Layout,
  default: root,
  loader: loader$d
}, Symbol.toStringTag, { value: "Module" }));
function cx(...values) {
  return values.filter(Boolean).join(" ");
}
const sizeClasses = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6"
};
const toneClasses = {
  primary: "text-foreground",
  secondary: "text-secondary",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  inverse: "text-inverse"
};
function glyph(name) {
  switch (name) {
    case "search":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "11", cy: "11", r: "7" }),
        /* @__PURE__ */ jsx("path", { d: "M20 20l-3.5-3.5" })
      ] });
    case "cart":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "9", cy: "19", r: "1.5" }),
        /* @__PURE__ */ jsx("circle", { cx: "18", cy: "19", r: "1.5" }),
        /* @__PURE__ */ jsx("path", { d: "M3 4h2l2.6 10.5a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 8H7" })
      ] });
    case "filter":
      return /* @__PURE__ */ jsx("path", { d: "M4 6h16M7 12h10M10 18h4" });
    case "dashboard":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("rect", { x: "4", y: "4", width: "7", height: "7", rx: "1" }),
        /* @__PURE__ */ jsx("rect", { x: "13", y: "4", width: "7", height: "5", rx: "1" }),
        /* @__PURE__ */ jsx("rect", { x: "13", y: "11", width: "7", height: "9", rx: "1" }),
        /* @__PURE__ */ jsx("rect", { x: "4", y: "13", width: "7", height: "7", rx: "1" })
      ] });
    case "close":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M6 6l12 12" }),
        /* @__PURE__ */ jsx("path", { d: "M18 6L6 18" })
      ] });
    case "check":
      return /* @__PURE__ */ jsx("path", { d: "M5 12l4.5 4.5L19 7" });
    case "warning":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M12 4l8 15H4L12 4z" }),
        /* @__PURE__ */ jsx("path", { d: "M12 9v4" }),
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "16.5", r: "0.5", fill: "currentColor", stroke: "none" })
      ] });
    case "chevronDown":
      return /* @__PURE__ */ jsx("path", { d: "M6 9l6 6 6-6" });
    case "chevronUp":
      return /* @__PURE__ */ jsx("path", { d: "M6 15l6-6 6 6" });
    case "chevronLeft":
      return /* @__PURE__ */ jsx("path", { d: "M15 6l-6 6 6 6" });
    case "chevronRight":
      return /* @__PURE__ */ jsx("path", { d: "M9 6l6 6-6 6" });
    case "menu":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M4 7h16" }),
        /* @__PURE__ */ jsx("path", { d: "M4 12h16" }),
        /* @__PURE__ */ jsx("path", { d: "M4 17h16" })
      ] });
    case "spark":
      return /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsx("path", { d: "M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z" }) });
    case "package":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M4 8l8-4 8 4-8 4-8-4z" }),
        /* @__PURE__ */ jsx("path", { d: "M4 8v8l8 4 8-4V8" }),
        /* @__PURE__ */ jsx("path", { d: "M12 12v8" })
      ] });
    case "settings":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "3" }),
        /* @__PURE__ */ jsx("path", { d: "M19 12a7 7 0 0 0-.1-1l2.1-1.7-2-3.4-2.6 1a7.7 7.7 0 0 0-1.8-1L14.3 3h-4.6l-.3 2.9a7.7 7.7 0 0 0-1.8 1l-2.6-1-2 3.4 2.1 1.7a7 7 0 0 0 0 2L3 14.7l2 3.4 2.6-1a7.7 7.7 0 0 0 1.8 1l.3 2.9h4.6l.3-2.9a7.7 7.7 0 0 0 1.8-1l2.6 1 2-3.4-2.1-1.7c.1-.3.1-.7.1-1z" })
      ] });
    case "user":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "8", r: "4" }),
        /* @__PURE__ */ jsx("path", { d: "M5 20a7 7 0 0 1 14 0" })
      ] });
    case "info":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
        /* @__PURE__ */ jsx("path", { d: "M12 10v5" }),
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "7.5", r: "0.5", fill: "currentColor", stroke: "none" })
      ] });
    case "star":
      return /* @__PURE__ */ jsx(
        "path",
        {
          d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z",
          fill: "currentColor"
        }
      );
    case "starHalf":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
          }
        ),
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M12 2v15.27L5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z",
            fill: "currentColor"
          }
        )
      ] });
    case "starEmpty":
      return /* @__PURE__ */ jsx(
        "path",
        {
          d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
        }
      );
    case "copy":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("rect", { x: "9", y: "9", width: "11", height: "11", rx: "1.5" }),
        /* @__PURE__ */ jsx("path", { d: "M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15" })
      ] });
    case "plus":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M12 5v14" }),
        /* @__PURE__ */ jsx("path", { d: "M5 12h14" })
      ] });
    case "minus":
      return /* @__PURE__ */ jsx("path", { d: "M5 12h14" });
    case "edit":
      return /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsx("path", { d: "M17 3l4 4L7 21H3v-4L17 3z" }) });
    case "trash":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M4 7h16" }),
        /* @__PURE__ */ jsx("path", { d: "M10 11v6" }),
        /* @__PURE__ */ jsx("path", { d: "M14 11v6" }),
        /* @__PURE__ */ jsx("path", { d: "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" }),
        /* @__PURE__ */ jsx("path", { d: "M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" })
      ] });
    case "heart":
      return /* @__PURE__ */ jsx("path", { d: "M12 21C12 21 4 14 4 8.5A4.5 4.5 0 0 1 12 5a4.5 4.5 0 0 1 8 3.5C20 14 12 21 12 21z" });
    case "heartFilled":
      return /* @__PURE__ */ jsx(
        "path",
        {
          d: "M12 21C12 21 4 14 4 8.5A4.5 4.5 0 0 1 12 5a4.5 4.5 0 0 1 8 3.5C20 14 12 21 12 21z",
          fill: "currentColor"
        }
      );
    case "share":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "18", cy: "5", r: "3" }),
        /* @__PURE__ */ jsx("circle", { cx: "6", cy: "12", r: "3" }),
        /* @__PURE__ */ jsx("circle", { cx: "18", cy: "19", r: "3" }),
        /* @__PURE__ */ jsx("path", { d: "M8.59 13.51l6.83 3.98" }),
        /* @__PURE__ */ jsx("path", { d: "M15.41 6.51l-6.82 3.98" })
      ] });
    case "image":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
        /* @__PURE__ */ jsx("circle", { cx: "8.5", cy: "8.5", r: "1.5", fill: "currentColor", stroke: "none" }),
        /* @__PURE__ */ jsx("path", { d: "M21 15l-5-5L5 21" })
      ] });
    case "dollar":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M12 2v20" }),
        /* @__PURE__ */ jsx("path", { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" })
      ] });
    case "truck":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M1 3h15v13H1z" }),
        /* @__PURE__ */ jsx("path", { d: "M16 8h4l3 3v5h-7V8z" }),
        /* @__PURE__ */ jsx("circle", { cx: "5.5", cy: "18.5", r: "2.5" }),
        /* @__PURE__ */ jsx("circle", { cx: "18.5", cy: "18.5", r: "2.5" })
      ] });
    case "clock":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
        /* @__PURE__ */ jsx("path", { d: "M12 7v5l3 3" })
      ] });
    case "eye":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" }),
        /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "3" })
      ] });
    case "eyeOff":
      return /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" }),
        /* @__PURE__ */ jsx("path", { d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" }),
        /* @__PURE__ */ jsx("path", { d: "M14.12 14.12a3 3 0 1 1-4.24-4.24" }),
        /* @__PURE__ */ jsx("path", { d: "M1 1l22 22" })
      ] });
    default:
      return null;
  }
}
function Icon({
  name,
  size = "md",
  tone = "primary",
  label,
  ...rest
}) {
  const decorative = !label;
  return /* @__PURE__ */ jsx(
    "span",
    {
      ...rest,
      className: cx("inline-flex shrink-0 items-center", toneClasses[tone]),
      children: /* @__PURE__ */ jsx(
        "svg",
        {
          "aria-hidden": decorative,
          "aria-label": label,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.8",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          className: sizeClasses[size],
          children: glyph(name)
        }
      )
    }
  );
}
const chaseTheme = {
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
({
  typography: chaseTheme.typography,
  radius: chaseTheme.radius,
  zIndex: chaseTheme.zIndex,
  motion: chaseTheme.motion,
  breakpoints: chaseTheme.breakpoints
});
function resolveTheme(theme, baseTheme = chaseTheme) {
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
const tokenMap = [
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
  ["--motion-ease", (t) => t.motion?.ease]
];
function applyThemeStyle(target, theme) {
  const record = target;
  for (const [cssVar, accessor] of tokenMap) {
    const value = accessor(theme);
    if (value !== void 0) {
      record[cssVar] = value;
    }
  }
  return target;
}
function resolveThemeOverrideStyle(theme) {
  if (!theme) {
    return void 0;
  }
  const style = applyThemeStyle({}, theme);
  return Object.keys(style).length > 0 ? style : void 0;
}
function parseDurationSeconds(value, fallbackMs) {
  if (!value) {
    return fallbackMs / 1e3;
  }
  const trimmed = value.trim();
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) {
    return fallbackMs / 1e3;
  }
  if (trimmed.endsWith("ms")) {
    return number / 1e3;
  }
  if (trimmed.endsWith("s")) {
    return number;
  }
  return number / 1e3;
}
function parseEase(value) {
  const match = value?.match(/cubic-bezier\(([^)]+)\)/i);
  if (!match) {
    return [0.16, 1, 0.3, 1];
  }
  const parsed = match[1].split(",").map((segment) => Number.parseFloat(segment.trim())).filter((segment) => Number.isFinite(segment));
  if (parsed.length !== 4) {
    return [0.16, 1, 0.3, 1];
  }
  return parsed;
}
function buildPreset(initial, animate, exit, transition) {
  return { initial, animate, exit, transition };
}
function resolveChaseMotion(theme, reducedMotionSetting = "user", reducedMotion = false) {
  const resolvedTheme = resolveTheme(theme, chaseTheme);
  const durations = {
    fast: parseDurationSeconds(resolvedTheme.motion.fast, 120),
    base: parseDurationSeconds(resolvedTheme.motion.base, 180),
    slow: parseDurationSeconds(resolvedTheme.motion.slow, 260)
  };
  const easing = parseEase(resolvedTheme.motion.ease);
  const inertTransition = { duration: 0.01, ease: "linear" };
  if (reducedMotion) {
    const subtle = buildPreset(
      { opacity: 0 },
      { opacity: 1 },
      { opacity: 0 },
      inertTransition
    );
    return {
      reducedMotion,
      reducedMotionSetting,
      durations,
      easing,
      interactiveScale: 1,
      interactiveLift: 0,
      presets: {
        fade: subtle,
        lift: subtle,
        scale: subtle,
        slideUp: subtle,
        slideRight: subtle
      },
      viewPresets: {
        page: subtle,
        panel: subtle
      }
    };
  }
  const fastTween = { duration: durations.fast, ease: easing };
  const baseTween = { duration: durations.base, ease: easing };
  const slowTween = { duration: durations.slow, ease: easing };
  return {
    reducedMotion,
    reducedMotionSetting,
    durations,
    easing,
    interactiveScale: 1.015,
    interactiveLift: -4,
    presets: {
      fade: buildPreset({ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, fastTween),
      lift: buildPreset(
        { opacity: 0, y: 14, scale: 0.985 },
        { opacity: 1, y: 0, scale: 1 },
        { opacity: 0, y: 10, scale: 0.99 },
        baseTween
      ),
      scale: buildPreset(
        { opacity: 0, scale: 0.96 },
        { opacity: 1, scale: 1 },
        { opacity: 0, scale: 0.98 },
        baseTween
      ),
      slideUp: buildPreset(
        { opacity: 0, y: 22 },
        { opacity: 1, y: 0 },
        { opacity: 0, y: 18 },
        baseTween
      ),
      slideRight: buildPreset(
        { opacity: 0, x: 26 },
        { opacity: 1, x: 0 },
        { opacity: 0, x: 20 },
        slowTween
      )
    },
    viewPresets: {
      page: buildPreset(
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0 },
        { opacity: 0, y: 16 },
        slowTween
      ),
      panel: buildPreset(
        { opacity: 0, x: 20 },
        { opacity: 1, x: 0 },
        { opacity: 0, x: 12 },
        baseTween
      )
    }
  };
}
const DensityContext = createContext("comfortable");
const MotionContext = createContext(
  resolveChaseMotion(void 0, "user", false)
);
const PortalContext = createContext({
  overlayNode: null,
  toastNode: null
});
function subscribeToReducedMotion(callback) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {
    };
  }
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const listener = () => callback();
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }
  mediaQuery.addListener(listener);
  return () => mediaQuery.removeListener(listener);
}
function getReducedMotionSnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function ChaseRoot({
  children,
  density = "comfortable",
  reducedMotion = "user",
  colorMode = "system",
  theme,
  ...rest
}) {
  const [overlayNode, setOverlayNode] = useState(null);
  const [toastNode, setToastNode] = useState(null);
  const systemReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    () => false
  );
  const resolvedReducedMotion = reducedMotion === "always" ? true : reducedMotion === "never" ? false : systemReducedMotion;
  const motionSettings = useMemo(
    () => resolveChaseMotion(theme, reducedMotion, resolvedReducedMotion),
    [theme, reducedMotion, resolvedReducedMotion]
  );
  return /* @__PURE__ */ jsx(DensityContext.Provider, { value: density, children: /* @__PURE__ */ jsx(MotionContext.Provider, { value: motionSettings, children: /* @__PURE__ */ jsx(PortalContext.Provider, { value: { overlayNode, toastNode }, children: /* @__PURE__ */ jsx(
    MotionConfig,
    {
      reducedMotion,
      transition: {
        duration: motionSettings.durations.base,
        ease: motionSettings.easing
      },
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          ...rest,
          "data-chase-theme": "",
          "data-color-mode": colorMode,
          "data-density": density,
          "data-reduced-motion": resolvedReducedMotion ? "true" : "false",
          className: cx(
            "chase-root relative isolate min-h-screen bg-background font-body text-foreground"
          ),
          style: resolveThemeOverrideStyle(theme),
          children: [
            children,
            /* @__PURE__ */ jsx("div", { ref: setOverlayNode, "data-chase-overlay-root": "" }),
            /* @__PURE__ */ jsx("div", { ref: setToastNode, "data-chase-toast-root": "" })
          ]
        }
      )
    }
  ) }) }) });
}
function useChaseMotion() {
  return useContext(MotionContext);
}
function usePortalRoots() {
  return useContext(PortalContext);
}
const spaceClasses = {
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
const textAlignClasses = {
  left: "text-left",
  center: "text-center",
  right: "text-right"
};
const directionClasses = {
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
const alignClasses = {
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
const justifyClasses = {
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
const responsiveOrder = [
  "base",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl"
];
function resolveSpaceClass(prefix, value) {
  if (value === void 0) {
    return "";
  }
  return `${prefix}-${spaceClasses[String(value)]}`;
}
function resolveTextAlignClass(value) {
  return value ? textAlignClasses[value] : "";
}
function resolveResponsiveClass(value, classes) {
  if (value === void 0) {
    return "";
  }
  if (typeof value !== "object") {
    return classes[String(value)].base;
  }
  const output = [];
  for (const key of responsiveOrder) {
    const resolved = value[key];
    if (resolved !== void 0) {
      output.push(classes[String(resolved)][key]);
    }
  }
  return output.join(" ");
}
function resolveDirectionClass(value) {
  return resolveResponsiveClass(value, directionClasses);
}
function resolveAlignClass(value) {
  return resolveResponsiveClass(value, alignClasses);
}
function resolveJustifyClass(value) {
  return resolveResponsiveClass(value, justifyClasses);
}
const layoutWidthClasses = {
  narrow: "max-w-3xl",
  content: "max-w-5xl",
  wide: "max-w-7xl",
  full: "max-w-none"
};
function Stack({
  children,
  element = "div",
  direction = "column",
  align,
  justify,
  gap = 4,
  ...rest
}) {
  const Component = element;
  return /* @__PURE__ */ jsx(
    Component,
    {
      ...rest,
      className: cx(
        "flex",
        resolveDirectionClass(direction),
        resolveAlignClass(align),
        resolveJustifyClass(justify),
        resolveSpaceClass("gap", gap)
      ),
      children
    }
  );
}
function Inline({
  children,
  gap = 3,
  align = "center",
  wrap = true,
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      ...rest,
      className: cx(
        "flex",
        wrap && "flex-wrap",
        resolveAlignClass(align),
        resolveSpaceClass("gap", gap)
      ),
      children
    }
  );
}
function SkipLink({
  targetId = "main-content",
  label = "Skip to main content"
}) {
  return /* @__PURE__ */ jsx(
    "a",
    {
      href: `#${targetId}`,
      className: "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-tokenMd focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-contrast focus:shadow-overlay",
      children: label
    }
  );
}
const buttonToneClasses = {
  primary: "border-transparent bg-accent text-accent-contrast hover:brightness-110",
  secondary: "border-border bg-elevated text-foreground hover:border-accent hover:text-accent",
  ghost: "border-transparent bg-transparent text-secondary hover:border-border hover:bg-background hover:text-foreground",
  danger: "border-transparent bg-danger text-inverse hover:brightness-110"
};
const buttonSizeClasses = {
  sm: "min-h-10 px-3 text-sm",
  md: "touch-target px-4 text-sm",
  lg: "min-h-12 px-5 text-base"
};
const buttonBaseClass = "focus-ring relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-tokenMd border font-semibold shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none";
function resolveInteractiveMotion(reducedMotion, scale, lift) {
  if (reducedMotion) {
    return void 0;
  }
  return {
    whileHover: { y: lift, scale },
    whileTap: { y: 0, scale: 0.985 },
    transition: { duration: 0.18 }
  };
}
function renderActivePill(groupId, tone = "default") {
  return /* @__PURE__ */ jsx(
    motion.span,
    {
      layoutId: `${groupId}-active-pill`,
      className: cx(
        "absolute inset-0 rounded-tokenMd",
        tone === "accent" ? "bg-elevated shadow-tokenSm" : "bg-background shadow-tokenSm"
      ),
      transition: { duration: 0.18 }
    }
  );
}
function renderLeadingIcon(icon, tone) {
  if (!icon) {
    return null;
  }
  return /* @__PURE__ */ jsx(
    Icon,
    {
      name: icon,
      size: "sm",
      tone: tone === "primary" || tone === "danger" ? "inverse" : "accent"
    }
  );
}
function renderNavigationItem(item, active, orientation, groupId, onSelect) {
  const content = /* @__PURE__ */ jsxs(Fragment, { children: [
    item.icon ? /* @__PURE__ */ jsx(
      Icon,
      {
        name: item.icon,
        size: "sm",
        tone: active ? "accent" : "secondary"
      }
    ) : null,
    /* @__PURE__ */ jsx("span", { className: cx(orientation === "rail" && "text-xs"), children: item.label }),
    item.badge ? /* @__PURE__ */ jsx("span", { className: "rounded-full bg-background px-2 py-0.5 text-[0.7rem] font-semibold text-secondary", children: item.badge }) : null
  ] });
  const className = cx(
    "focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition",
    orientation === "vertical" && "w-full justify-between",
    orientation === "rail" && "w-full flex-col justify-center py-3",
    active ? "bg-background text-accent shadow-tokenSm" : "text-secondary hover:bg-background hover:text-foreground"
  );
  if (item.href) {
    return /* @__PURE__ */ jsxs("a", { href: item.href, className, children: [
      active && groupId ? renderActivePill(groupId) : null,
      /* @__PURE__ */ jsx("span", { className: "relative z-10 inline-flex items-center gap-2", children: content })
    ] }, item.key);
  }
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      className,
      onClick: () => onSelect?.(item.key),
      children: [
        active && groupId ? renderActivePill(groupId) : null,
        /* @__PURE__ */ jsx("span", { className: "relative z-10 inline-flex items-center gap-2", children: content })
      ]
    },
    item.key
  );
}
function renderBottomNavigationItem(item, active, groupId, onSelect) {
  const content = /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs("span", { className: "relative inline-flex h-5 w-5 items-center justify-center", children: [
      item.icon ? /* @__PURE__ */ jsx(
        Icon,
        {
          name: item.icon,
          size: "sm",
          tone: active ? "accent" : "secondary"
        }
      ) : null,
      item.badge ? /* @__PURE__ */ jsx(
        "span",
        {
          "aria-hidden": "true",
          className: "absolute -right-2 -top-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[0.65rem] font-semibold leading-none text-secondary shadow-tokenSm",
          children: item.badge
        }
      ) : null
    ] }),
    /* @__PURE__ */ jsx("span", { className: "text-xs", children: item.label }),
    item.badge ? /* @__PURE__ */ jsx("span", { className: "sr-only", children: ` ${item.badge}` }) : null
  ] });
  const className = cx(
    "focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-3 py-3 text-sm font-medium transition",
    active ? "bg-background text-accent shadow-tokenSm" : "text-secondary hover:bg-background hover:text-foreground"
  );
  if (item.href) {
    return /* @__PURE__ */ jsxs("a", { href: item.href, className, children: [
      active && groupId ? renderActivePill(groupId) : null,
      /* @__PURE__ */ jsx("span", { className: "relative z-10 inline-flex flex-col items-center justify-center gap-1", children: content })
    ] }, item.key);
  }
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      className,
      onClick: () => onSelect?.(item.key),
      children: [
        active && groupId ? renderActivePill(groupId) : null,
        /* @__PURE__ */ jsx("span", { className: "relative z-10 inline-flex flex-col items-center justify-center gap-1", children: content })
      ]
    },
    item.key
  );
}
const Button = forwardRef(function Button2({
  children,
  tone = "primary",
  size = "md",
  block = false,
  leadingIcon,
  trailingIcon,
  type = "button",
  ...rest
}, ref) {
  const motionSettings = useChaseMotion();
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift
  );
  const nativeProps = rest;
  return /* @__PURE__ */ jsxs(
    motion.button,
    {
      ...nativeProps,
      ref,
      type,
      ...interactiveMotion,
      className: cx(
        buttonBaseClass,
        buttonToneClasses[tone],
        buttonSizeClasses[size],
        block && "w-full"
      ),
      children: [
        renderLeadingIcon(leadingIcon, tone),
        /* @__PURE__ */ jsx("span", { children }),
        trailingIcon ? /* @__PURE__ */ jsx(
          Icon,
          {
            name: trailingIcon,
            size: "sm",
            tone: tone === "primary" || tone === "danger" ? "inverse" : "accent"
          }
        ) : null
      ]
    }
  );
});
const IconButton = forwardRef(
  function IconButton2({
    label,
    icon,
    tone = "ghost",
    size = "md",
    type = "button",
    ...rest
  }, ref) {
    const motionSettings = useChaseMotion();
    const interactiveMotion = resolveInteractiveMotion(
      motionSettings.reducedMotion,
      motionSettings.interactiveScale,
      motionSettings.interactiveLift
    );
    const nativeProps = rest;
    return /* @__PURE__ */ jsx(
      motion.button,
      {
        ...nativeProps,
        ref,
        type,
        "aria-label": label,
        ...interactiveMotion,
        className: cx(
          buttonBaseClass,
          buttonToneClasses[tone],
          buttonSizeClasses[size],
          "px-0"
        ),
        children: /* @__PURE__ */ jsx(
          Icon,
          {
            name: icon,
            size: "sm",
            tone: tone === "primary" || tone === "danger" ? "inverse" : "accent"
          }
        )
      }
    );
  }
);
const LinkButton = forwardRef(
  function LinkButton2({
    children,
    tone = "secondary",
    size = "md",
    leadingIcon,
    trailingIcon,
    block = false,
    ...rest
  }, ref) {
    const motionSettings = useChaseMotion();
    const interactiveMotion = resolveInteractiveMotion(
      motionSettings.reducedMotion,
      motionSettings.interactiveScale,
      motionSettings.interactiveLift
    );
    const nativeProps = rest;
    return /* @__PURE__ */ jsxs(
      motion.a,
      {
        ...nativeProps,
        ref,
        ...interactiveMotion,
        className: cx(
          buttonBaseClass,
          buttonToneClasses[tone],
          buttonSizeClasses[size],
          block && "w-full"
        ),
        children: [
          renderLeadingIcon(leadingIcon, tone),
          /* @__PURE__ */ jsx("span", { children }),
          trailingIcon ? /* @__PURE__ */ jsx(
            Icon,
            {
              name: trailingIcon,
              size: "sm",
              tone: tone === "primary" || tone === "danger" ? "inverse" : "accent"
            }
          ) : null
        ]
      }
    );
  }
);
function ButtonGroup({
  children,
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      ...rest,
      role: "group",
      className: "inline-flex flex-wrap items-center gap-3",
      children
    }
  );
}
function Breadcrumbs({
  items,
  ariaLabel = "Breadcrumb",
  ...rest
}) {
  return /* @__PURE__ */ jsx("nav", { ...rest, "aria-label": ariaLabel, children: /* @__PURE__ */ jsx("ol", { className: "flex flex-wrap items-center gap-2 text-sm text-secondary", children: items.map((item, index2) => {
    const isCurrent = index2 === items.length - 1;
    return /* @__PURE__ */ jsxs("li", { className: "inline-flex items-center gap-2", children: [
      item.href && !isCurrent ? /* @__PURE__ */ jsx("a", { href: item.href, className: "focus-ring rounded-tokenSm hover:text-foreground", children: item.label }) : /* @__PURE__ */ jsx("span", { className: isCurrent ? "font-semibold text-foreground" : void 0, children: item.label }),
      !isCurrent ? /* @__PURE__ */ jsx(Icon, { name: "chevronRight", size: "sm", tone: "secondary" }) : null
    ] }, `${item.label}-${index2}`);
  }) }) });
}
function TopNav({
  items,
  activeKey,
  onSelect,
  brand,
  actions,
  width = "full",
  ...rest
}) {
  const groupId = useId();
  return /* @__PURE__ */ jsx(
    "nav",
    {
      ...rest,
      className: "sticky top-0 z-sticky border-b border-muted bg-elevated px-4 py-3 shadow-tokenSm",
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          className: cx(
            "mx-auto flex w-full items-center justify-between gap-4",
            layoutWidthClasses[width]
          ),
          children: [
            /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-4", children: [
              brand,
              /* @__PURE__ */ jsx(LayoutGroup, { id: groupId, children: /* @__PURE__ */ jsx("div", { className: "hidden items-center gap-1 md:flex", children: items.map(
                (item) => renderNavigationItem(item, item.key === activeKey, "horizontal", groupId, onSelect)
              ) }) })
            ] }),
            /* @__PURE__ */ jsx("div", { className: "flex items-center gap-2", children: actions })
          ]
        }
      )
    }
  );
}
function SideNav({
  items,
  activeKey,
  onSelect,
  ...rest
}) {
  const groupId = useId();
  return /* @__PURE__ */ jsx(
    "nav",
    {
      ...rest,
      className: "modern-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm",
      children: /* @__PURE__ */ jsx(LayoutGroup, { id: groupId, children: items.map(
        (item) => renderNavigationItem(item, item.key === activeKey, "vertical", groupId, onSelect)
      ) })
    }
  );
}
function BottomNav({
  items,
  activeKey,
  onSelect,
  width = "full",
  ...rest
}) {
  const groupId = useId();
  return /* @__PURE__ */ jsx(
    "nav",
    {
      ...rest,
      className: "fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-elevated px-3 py-2 shadow-tokenLg md:hidden",
      children: /* @__PURE__ */ jsx(LayoutGroup, { id: groupId, children: /* @__PURE__ */ jsx("div", { className: cx("mx-auto grid w-full grid-cols-4 gap-2", layoutWidthClasses[width]), children: items.slice(0, 4).map(
        (item) => renderBottomNavigationItem(item, item.key === activeKey, groupId, onSelect)
      ) }) })
    }
  );
}
const softToneClasses = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-background text-accent",
  success: "border-success bg-background text-success",
  warning: "border-warning bg-background text-warning",
  danger: "border-danger bg-background text-danger",
  info: "border-info bg-background text-info"
};
function toneIcon(tone) {
  switch (tone) {
    case "success":
      return "check";
    case "warning":
      return "warning";
    case "danger":
      return "warning";
    case "info":
      return "info";
    case "accent":
      return "spark";
    default:
      return "info";
  }
}
function useControllableOpen(open, defaultOpen, onOpenChange) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const resolvedOpen = open ?? internalOpen;
  function handleOpenChange(nextOpen) {
    if (open === void 0) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }
  return [resolvedOpen, handleOpenChange];
}
function renderDialogFrame({
  open,
  title,
  description,
  children,
  footer,
  onDismiss,
  kind,
  reducedMotion,
  durations,
  easing,
  closeLabel = "Close"
}) {
  const frameAnimation = {
    initial: reducedMotion ? false : { opacity: 0, scale: 0.96, y: 14 },
    animate: reducedMotion ? void 0 : open ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.98, y: 10 },
    transition: reducedMotion ? void 0 : { duration: durations.base, ease: easing }
  };
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(DialogPrimitive.Overlay, { forceMount: true, asChild: true, children: /* @__PURE__ */ jsx(
      motion.div,
      {
        initial: false,
        animate: reducedMotion ? void 0 : open ? { opacity: 1 } : { opacity: 0 },
        transition: reducedMotion ? void 0 : { duration: durations.base, ease: easing },
        className: "fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
      }
    ) }),
    /* @__PURE__ */ jsx(
      DialogPrimitive.Content,
      {
        forceMount: true,
        asChild: true,
        children: /* @__PURE__ */ jsxs(
          motion.div,
          {
            initial: frameAnimation.initial,
            animate: frameAnimation.animate,
            transition: frameAnimation.transition,
            className: cx(
              "modern-surface fixed z-modal flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col rounded-tokenXl border border-muted p-5 shadow-overlay focus-visible:outline-none md:w-full md:max-w-2xl",
              "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
              kind === "drawer"
            ),
            children: [
              /* @__PURE__ */ jsxs("div", { className: "flex items-start justify-between gap-4", children: [
                /* @__PURE__ */ jsxs("div", { className: "space-y-1", children: [
                  /* @__PURE__ */ jsx(DialogPrimitive.Title, { className: "font-heading text-xl font-semibold text-foreground", children: title }),
                  /* @__PURE__ */ jsx(DialogPrimitive.Description, { className: description ? "text-sm text-secondary" : "sr-only", children: description ?? "Dialog content" })
                ] }),
                /* @__PURE__ */ jsx(DialogPrimitive.Close, { asChild: true, children: /* @__PURE__ */ jsx(
                  IconButton,
                  {
                    label: closeLabel,
                    icon: "close",
                    tone: "ghost",
                    onClick: onDismiss
                  }
                ) })
              ] }),
              /* @__PURE__ */ jsx("div", { className: "mt-4 min-h-0 flex-1 overflow-y-auto", children }),
              footer ? /* @__PURE__ */ jsx("div", { className: "mt-4", children: footer }) : null
            ]
          }
        )
      }
    )
  ] });
}
forwardRef(function AnimatedAccordionContent2({ children, ...rest }, ref) {
  const motionSettings = useChaseMotion();
  const isOpen = rest["data-state"] === "open";
  return /* @__PURE__ */ jsx(
    motion.div,
    {
      ...rest,
      ref,
      initial: false,
      animate: motionSettings.reducedMotion ? void 0 : isOpen ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 },
      transition: motionSettings.reducedMotion ? void 0 : { duration: motionSettings.durations.base, ease: motionSettings.easing },
      children
    }
  );
});
function Badge({
  children,
  tone = "neutral",
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "span",
    {
      ...rest,
      className: cx(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold",
        softToneClasses[tone]
      ),
      children
    }
  );
}
function StatusPill(props) {
  return /* @__PURE__ */ jsx(Badge, { ...props });
}
function Banner({
  title,
  description,
  tone = "info",
  actions,
  ...rest
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      ...rest,
      className: cx(
        "flex flex-col gap-4 rounded-tokenLg border p-4 md:flex-row md:items-center md:justify-between",
        softToneClasses[tone]
      ),
      children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-3", children: [
          /* @__PURE__ */ jsx(Icon, { name: toneIcon(tone), size: "sm", tone }),
          /* @__PURE__ */ jsxs("div", { className: "space-y-1", children: [
            /* @__PURE__ */ jsx("div", { className: "text-sm font-semibold", children: title }),
            description ? /* @__PURE__ */ jsx("div", { className: "text-sm", children: description }) : null
          ] })
        ] }),
        actions ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap gap-2", children: actions }) : null
      ]
    }
  );
}
function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  closeLabel
}) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  return /* @__PURE__ */ jsxs(
    DialogPrimitive.Root,
    {
      open: resolvedOpen,
      onOpenChange: setResolvedOpen,
      children: [
        trigger ? /* @__PURE__ */ jsx(DialogPrimitive.Trigger, { asChild: true, children: trigger }) : null,
        /* @__PURE__ */ jsx(DialogPrimitive.Portal, { container: overlayNode ?? void 0, children: renderDialogFrame({
          open: resolvedOpen,
          title,
          description,
          footer,
          kind: "dialog",
          children,
          reducedMotion: motionSettings.reducedMotion,
          durations: motionSettings.durations,
          easing: motionSettings.easing,
          closeLabel
        }) })
      ]
    }
  );
}
function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm
}) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  return /* @__PURE__ */ jsxs(
    AlertDialogPrimitive.Root,
    {
      open: resolvedOpen,
      onOpenChange: setResolvedOpen,
      children: [
        trigger ? /* @__PURE__ */ jsx(AlertDialogPrimitive.Trigger, { asChild: true, children: trigger }) : null,
        /* @__PURE__ */ jsxs(AlertDialogPrimitive.Portal, { container: overlayNode ?? void 0, children: [
          /* @__PURE__ */ jsx(AlertDialogPrimitive.Overlay, { forceMount: true, asChild: true, children: /* @__PURE__ */ jsx(
            motion.div,
            {
              initial: false,
              animate: motionSettings.reducedMotion ? void 0 : resolvedOpen ? { opacity: 1 } : { opacity: 0 },
              transition: motionSettings.reducedMotion ? void 0 : { duration: motionSettings.durations.base, ease: motionSettings.easing },
              className: "fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
            }
          ) }),
          /* @__PURE__ */ jsx(AlertDialogPrimitive.Content, { forceMount: true, asChild: true, children: /* @__PURE__ */ jsxs(
            motion.div,
            {
              initial: motionSettings.reducedMotion ? false : { opacity: 0, scale: 0.96, y: 14 },
              animate: motionSettings.reducedMotion ? void 0 : resolvedOpen ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.98, y: 8 },
              transition: motionSettings.reducedMotion ? void 0 : { duration: motionSettings.durations.base, ease: motionSettings.easing },
              className: "modern-surface fixed left-1/2 top-1/2 z-modal w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-tokenXl border border-muted p-5 shadow-overlay",
              children: [
                /* @__PURE__ */ jsxs("div", { className: "space-y-3", children: [
                  /* @__PURE__ */ jsx("div", { className: "inline-flex h-10 w-10 items-center justify-center rounded-full bg-background", children: /* @__PURE__ */ jsx(Icon, { name: toneIcon(tone), size: "sm", tone }) }),
                  /* @__PURE__ */ jsx(AlertDialogPrimitive.Title, { className: "font-heading text-xl font-semibold text-foreground", children: title }),
                  description ? /* @__PURE__ */ jsx(AlertDialogPrimitive.Description, { className: "text-sm text-secondary", children: description }) : null
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end", children: [
                  /* @__PURE__ */ jsx(AlertDialogPrimitive.Cancel, { asChild: true, children: /* @__PURE__ */ jsx(Button, { tone: "secondary", children: cancelLabel }) }),
                  /* @__PURE__ */ jsx(AlertDialogPrimitive.Action, { asChild: true, children: /* @__PURE__ */ jsx(Button, { tone: tone === "danger" ? "danger" : "primary", onClick: onConfirm, children: confirmLabel }) })
                ] })
              ]
            }
          ) })
        ] })
      ]
    }
  );
}
function ToastRegionItem({ item }) {
  const motionSettings = useChaseMotion();
  const [internalOpen, setInternalOpen] = useState(item.open ?? true);
  const resolvedOpen = item.open ?? internalOpen;
  function handleOpenChange(nextOpen) {
    if (item.open === void 0) {
      setInternalOpen(nextOpen);
    }
    item.onOpenChange?.(nextOpen);
  }
  return /* @__PURE__ */ jsx(
    ToastPrimitive.Root,
    {
      forceMount: true,
      open: resolvedOpen,
      onOpenChange: handleOpenChange,
      className: "modern-surface rounded-tokenLg border border-muted shadow-overlay",
      children: resolvedOpen ? /* @__PURE__ */ jsxs(
        motion.div,
        {
          layout: true,
          initial: motionSettings.reducedMotion ? false : { opacity: 0, y: 16, scale: 0.98 },
          animate: motionSettings.reducedMotion ? void 0 : { opacity: 1, y: 0, scale: 1, height: "auto" },
          transition: motionSettings.reducedMotion ? void 0 : { duration: motionSettings.durations.base, ease: motionSettings.easing },
          className: "grid grid-cols-[auto_1fr_auto] items-start gap-3 p-4",
          children: [
            /* @__PURE__ */ jsx("div", { className: "inline-flex h-10 w-10 items-center justify-center rounded-full bg-background", children: /* @__PURE__ */ jsx(
              Icon,
              {
                name: toneIcon(item.tone ?? "info"),
                size: "sm",
                tone: item.tone ?? "info"
              }
            ) }),
            /* @__PURE__ */ jsxs("div", { className: "min-w-0 space-y-1", children: [
              /* @__PURE__ */ jsx(ToastPrimitive.Title, { className: "text-sm font-semibold text-foreground", children: item.title }),
              item.description ? /* @__PURE__ */ jsx(ToastPrimitive.Description, { className: "text-sm text-secondary", children: item.description }) : null
            ] }),
            /* @__PURE__ */ jsx("div", { className: "self-start", children: /* @__PURE__ */ jsx(ToastPrimitive.Close, { asChild: true, children: /* @__PURE__ */ jsx(
              IconButton,
              {
                label: item.dismissLabel ?? "Dismiss notification",
                icon: "close",
                tone: "ghost",
                size: "sm"
              }
            ) }) })
          ]
        }
      ) : null
    }
  );
}
function ToastRegion({
  items
}) {
  const { toastNode } = usePortalRoots();
  const viewport = /* @__PURE__ */ jsx(ToastPrimitive.Viewport, { className: "fixed inset-x-0 bottom-0 z-toast mx-auto flex w-full max-w-md flex-col gap-3 p-4 outline-none" });
  return /* @__PURE__ */ jsxs(ToastPrimitive.Provider, { duration: 4e3, swipeDirection: "right", children: [
    items.map((item) => /* @__PURE__ */ jsx(ToastRegionItem, { item }, item.id)),
    toastNode ? createPortal(viewport, toastNode) : viewport
  ] });
}
function LoadingSpinner({
  label = "Loading",
  size = "md",
  ...rest
}) {
  const sizeClass = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-8 w-8" : "h-6 w-6";
  return /* @__PURE__ */ jsxs("div", { ...rest, className: "inline-flex items-center gap-2 text-secondary", children: [
    /* @__PURE__ */ jsx(
      "span",
      {
        "aria-hidden": "true",
        className: cx(
          "inline-flex animate-spin rounded-full border-2 border-muted border-t-accent",
          sizeClass
        )
      }
    ),
    /* @__PURE__ */ jsx("span", { className: "text-sm", children: label })
  ] });
}
function EmptyState({
  title,
  description,
  actions,
  icon = "spark",
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      ...rest,
      className: "rounded-tokenLg border border-dashed border-muted bg-background p-6 text-center",
      children: /* @__PURE__ */ jsxs("div", { className: "mx-auto flex max-w-sm flex-col items-center gap-4", children: [
        /* @__PURE__ */ jsx("div", { className: "inline-flex h-14 w-14 items-center justify-center rounded-full bg-elevated shadow-tokenSm", children: /* @__PURE__ */ jsx(Icon, { name: icon, size: "lg", tone: "accent" }) }),
        /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
          /* @__PURE__ */ jsx("div", { className: "font-heading text-xl font-semibold text-foreground", children: title }),
          description ? /* @__PURE__ */ jsx("div", { className: "text-sm text-secondary", children: description }) : null
        ] }),
        actions ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap justify-center gap-2", children: actions }) : null
      ] })
    }
  );
}
function DataTable({
  rows,
  columns: columns2,
  mobileMode = "stack",
  getRowId,
  emptyTitle = "Nothing to review",
  emptyDescription = "Adjust filters or add new records to populate this view.",
  sortKey,
  sortDirection,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  ...rest
}) {
  if (rows.length === 0) {
    return /* @__PURE__ */ jsx(
      EmptyState,
      {
        title: emptyTitle,
        description: emptyDescription
      }
    );
  }
  const selectable = selectedKeys !== void 0 && onSelectionChange !== void 0;
  const allIds = selectable ? rows.map((row, index2) => getRowId ? getRowId(row, index2) : String(index2)) : [];
  const allSelected = selectable && allIds.length > 0 && allIds.every((id) => selectedKeys.has(id));
  function handleSortClick(column) {
    if (!column.sortable || !onSortChange) return;
    const nextDirection = sortKey === column.key && sortDirection === "asc" ? "desc" : "asc";
    onSortChange(column.key, nextDirection);
  }
  function handleSelectAll() {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange(/* @__PURE__ */ new Set());
    } else {
      onSelectionChange(new Set(allIds));
    }
  }
  function handleSelectRow(id) {
    if (!onSelectionChange || !selectedKeys) return;
    const next = new Set(selectedKeys);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  }
  function renderSortIndicator(column) {
    if (!column.sortable) return null;
    if (sortKey !== column.key) {
      return /* @__PURE__ */ jsx(Icon, { name: "chevronDown", size: "sm", tone: "secondary" });
    }
    return /* @__PURE__ */ jsx(
      Icon,
      {
        name: sortDirection === "asc" ? "chevronUp" : "chevronDown",
        size: "sm",
        tone: "accent"
      }
    );
  }
  const table = /* @__PURE__ */ jsx("div", { className: "modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm", children: /* @__PURE__ */ jsxs("table", { className: "min-w-full border-collapse text-left text-sm", children: [
    /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "border-b border-muted bg-background", children: [
      selectable ? /* @__PURE__ */ jsx("th", { className: "w-12 px-4 py-3", children: /* @__PURE__ */ jsx(
        "input",
        {
          type: "checkbox",
          checked: allSelected,
          onChange: handleSelectAll,
          "aria-label": "Select all rows",
          className: "h-4 w-4 rounded border-border accent-accent"
        }
      ) }) : null,
      columns2.map((column) => /* @__PURE__ */ jsx(
        "th",
        {
          className: cx(
            "px-4 py-3 font-semibold text-foreground",
            column.align === "right" && "text-right"
          ),
          children: column.sortable ? /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "inline-flex items-center gap-1 hover:text-accent",
              onClick: () => handleSortClick(column),
              children: [
                column.header,
                renderSortIndicator(column)
              ]
            }
          ) : column.header
        },
        column.key
      ))
    ] }) }),
    /* @__PURE__ */ jsx("tbody", { children: rows.map((row, index2) => {
      const rowId = getRowId ? getRowId(row, index2) : String(index2);
      const isSelected = selectable && selectedKeys.has(rowId);
      return /* @__PURE__ */ jsxs(
        "tr",
        {
          className: cx(
            "border-b border-muted last:border-b-0",
            isSelected && "bg-background"
          ),
          children: [
            selectable ? /* @__PURE__ */ jsx("td", { className: "w-12 px-4 py-3", children: /* @__PURE__ */ jsx(
              "input",
              {
                type: "checkbox",
                checked: isSelected,
                onChange: () => handleSelectRow(rowId),
                "aria-label": `Select row ${rowId}`,
                className: "h-4 w-4 rounded border-border accent-accent"
              }
            ) }) : null,
            columns2.map((column) => /* @__PURE__ */ jsx(
              "td",
              {
                className: cx(
                  "px-4 py-3 text-secondary",
                  column.align === "right" && "text-right"
                ),
                children: column.cell(row)
              },
              column.key
            ))
          ]
        },
        rowId
      );
    }) })
  ] }) });
  const cards = /* @__PURE__ */ jsx("div", { role: "list", className: "space-y-3 md:hidden", children: rows.map((row, rowIndex) => /* @__PURE__ */ jsx(
    "div",
    {
      role: "listitem",
      className: "modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
      children: /* @__PURE__ */ jsx("div", { className: "space-y-3", children: columns2.map((column) => /* @__PURE__ */ jsxs("div", { className: "flex items-start justify-between gap-4", children: [
        /* @__PURE__ */ jsx("div", { className: "text-xs font-semibold uppercase tracking-wide text-secondary", children: column.mobileLabel ?? column.header }),
        /* @__PURE__ */ jsx(
          "div",
          {
            className: cx(
              "max-w-[60%] text-right text-sm text-foreground",
              column.align === "left" && "text-left"
            ),
            children: column.cell(row)
          }
        )
      ] }, column.key)) })
    },
    getRowId ? getRowId(row, rowIndex) : String(rowIndex)
  )) });
  return /* @__PURE__ */ jsxs("div", { ...rest, children: [
    mobileMode === "stack" ? cards : null,
    /* @__PURE__ */ jsx("div", { className: mobileMode === "stack" ? "hidden md:block" : "block", children: table })
  ] });
}
function KeyValueList({
  items,
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "dl",
    {
      ...rest,
      className: "modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm",
      children: items.map((item, index2) => /* @__PURE__ */ jsxs(
        "div",
        {
          className: "flex items-start justify-between gap-4 border-b border-muted pb-3 last:border-b-0 last:pb-0",
          children: [
            /* @__PURE__ */ jsx("dt", { className: "text-xs font-semibold uppercase tracking-wide text-secondary", children: item.key }),
            /* @__PURE__ */ jsx("dd", { className: "text-sm text-foreground", children: item.value })
          ]
        },
        index2
      ))
    }
  );
}
const controlClass = "focus-ring touch-target w-full rounded-tokenMd border border-border bg-elevated px-4 py-3 text-sm text-foreground shadow-tokenSm placeholder:text-secondary transition disabled:cursor-not-allowed disabled:opacity-60";
function FieldChrome({
  label,
  description,
  error,
  required = false,
  hideLabel = false,
  htmlFor,
  children,
  ...rest
}) {
  return /* @__PURE__ */ jsxs("div", { ...rest, className: "space-y-2", children: [
    label ? /* @__PURE__ */ jsxs(
      "label",
      {
        htmlFor,
        className: cx(
          "block text-sm font-medium text-foreground",
          hideLabel && "sr-only"
        ),
        children: [
          label,
          required ? /* @__PURE__ */ jsx("span", { className: "ml-1 text-accent", children: "*" }) : null
        ]
      }
    ) : null,
    children,
    error ? /* @__PURE__ */ jsx("div", { className: "text-xs font-medium text-danger", children: error }) : description ? /* @__PURE__ */ jsx("div", { className: "text-xs text-secondary", children: description }) : null
  ] });
}
function TextInput({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  type = "text",
  ...rest
}) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  return /* @__PURE__ */ jsx(
    FieldChrome,
    {
      label,
      description,
      error,
      required,
      hideLabel,
      htmlFor: inputId,
      children: /* @__PURE__ */ jsx("input", { ...rest, id: inputId, required, type, className: controlClass })
    }
  );
}
function Select({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose an option",
  disabled = false
}) {
  const fallbackId = useId();
  const { overlayNode } = usePortalRoots();
  return /* @__PURE__ */ jsx(
    FieldChrome,
    {
      label,
      description,
      error,
      required,
      hideLabel,
      htmlFor: fallbackId,
      children: /* @__PURE__ */ jsxs(
        SelectPrimitive.Root,
        {
          value,
          defaultValue,
          onValueChange,
          disabled,
          children: [
            /* @__PURE__ */ jsxs(
              SelectPrimitive.Trigger,
              {
                id: fallbackId,
                className: cx(
                  controlClass,
                  "inline-flex items-center justify-between gap-2 text-left"
                ),
                children: [
                  /* @__PURE__ */ jsx(SelectPrimitive.Value, { placeholder }),
                  /* @__PURE__ */ jsx(SelectPrimitive.Icon, { children: /* @__PURE__ */ jsx(Icon, { name: "chevronDown", size: "sm", tone: "secondary" }) })
                ]
              }
            ),
            /* @__PURE__ */ jsx(SelectPrimitive.Portal, { container: overlayNode ?? void 0, children: /* @__PURE__ */ jsx(
              SelectPrimitive.Content,
              {
                position: "popper",
                className: "modern-surface z-popover min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-tokenLg border border-muted shadow-overlay",
                children: /* @__PURE__ */ jsx(SelectPrimitive.Viewport, { className: "p-2", children: items.map((item) => /* @__PURE__ */ jsx(
                  SelectPrimitive.Item,
                  {
                    value: item.value,
                    disabled: item.disabled,
                    className: "focus-ring relative flex cursor-pointer select-none items-center rounded-tokenMd px-3 py-2 text-sm text-foreground outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-background",
                    children: /* @__PURE__ */ jsx(SelectPrimitive.ItemText, { children: /* @__PURE__ */ jsxs("div", { className: "space-y-0.5", children: [
                      /* @__PURE__ */ jsx("div", { children: item.label }),
                      item.description ? /* @__PURE__ */ jsx("div", { className: "text-xs text-secondary", children: item.description }) : null
                    ] }) })
                  },
                  item.value
                )) })
              }
            ) })
          ]
        }
      )
    }
  );
}
function Checkbox({
  label,
  description,
  error,
  required,
  hideLabel,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false
}) {
  const inputId = useId();
  return /* @__PURE__ */ jsx(
    FieldChrome,
    {
      label: void 0,
      description: error ? void 0 : description,
      error,
      required,
      hideLabel,
      children: /* @__PURE__ */ jsxs(
        "label",
        {
          htmlFor: inputId,
          className: "modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3",
          children: [
            /* @__PURE__ */ jsx(
              CheckboxPrimitive.Root,
              {
                id: inputId,
                checked,
                defaultChecked,
                onCheckedChange,
                disabled,
                className: "focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-elevated data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[disabled]:opacity-60",
                children: /* @__PURE__ */ jsx(CheckboxPrimitive.Indicator, { children: /* @__PURE__ */ jsx(Icon, { name: "check", size: "sm", tone: "inverse" }) })
              }
            ),
            /* @__PURE__ */ jsxs("div", { className: "space-y-1", children: [
              label ? /* @__PURE__ */ jsxs("div", { className: "text-sm font-medium text-foreground", children: [
                label,
                required ? /* @__PURE__ */ jsx("span", { className: "ml-1 text-accent", children: "*" }) : null
              ] }) : null,
              description ? /* @__PURE__ */ jsx("div", { className: "text-xs text-secondary", children: description }) : null
            ] })
          ]
        }
      )
    }
  );
}
function Page({
  children,
  width = "full",
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      ...rest,
      className: cx(
        "mx-auto flex w-full flex-col gap-6 px-4 py-6 pb-24 md:px-6 md:pb-8",
        layoutWidthClasses[width]
      ),
      children
    }
  );
}
function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  ...rest
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      ...rest,
      className: "flex flex-col gap-4 md:flex-row md:items-end md:justify-between",
      children: [
        /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
          eyebrow ? /* @__PURE__ */ jsx("div", { className: "text-xs font-semibold uppercase tracking-[0.2em] text-accent", children: eyebrow }) : null,
          /* @__PURE__ */ jsx("h1", { className: "font-display text-4xl font-semibold tracking-tight text-foreground md:text-5xl", children: title }),
          description ? /* @__PURE__ */ jsx("div", { className: "max-w-3xl text-base text-secondary", children: description }) : null
        ] }),
        actions ? /* @__PURE__ */ jsx(ButtonGroup, { children: actions }) : null
      ]
    }
  );
}
function PageSection({
  title,
  description,
  children,
  ...rest
}) {
  return /* @__PURE__ */ jsxs("section", { ...rest, className: "space-y-4", children: [
    title ? /* @__PURE__ */ jsxs("div", { className: "space-y-1", children: [
      /* @__PURE__ */ jsx("h2", { className: "font-heading text-2xl font-semibold text-foreground", children: title }),
      description ? /* @__PURE__ */ jsx("div", { className: "text-sm text-secondary", children: description }) : null
    ] }) : null,
    children
  ] });
}
function AdminShell({
  brand,
  navItems,
  activeKey,
  actions,
  children,
  width = "full"
}) {
  return /* @__PURE__ */ jsxs("div", { className: "min-h-screen bg-background", children: [
    /* @__PURE__ */ jsx(SkipLink, {}),
    /* @__PURE__ */ jsx(
      TopNav,
      {
        brand,
        items: navItems,
        activeKey,
        actions,
        width
      }
    ),
    /* @__PURE__ */ jsxs(
      "main",
      {
        id: "main-content",
        className: cx(
          "mx-auto grid min-h-[calc(100vh-4rem)] w-full gap-6 px-4 py-6 pb-24 lg:grid-cols-[16rem_minmax(0,1fr)] lg:pb-8",
          layoutWidthClasses[width]
        ),
        children: [
          /* @__PURE__ */ jsx("div", { className: "hidden lg:block", children: /* @__PURE__ */ jsx(SideNav, { items: navItems, activeKey }) }),
          /* @__PURE__ */ jsx("div", { className: "space-y-6", children })
        ]
      }
    ),
    /* @__PURE__ */ jsx(BottomNav, { items: navItems, activeKey, width })
  ] });
}
const textSizeClasses = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg"
};
const textWeightClasses = {
  regular: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold"
};
const textToneClasses = {
  primary: "text-foreground",
  secondary: "text-secondary",
  inverse: "text-inverse",
  accent: "text-accent"
};
function Text({
  children,
  element = "p",
  size = "md",
  tone = "primary",
  weight = "regular",
  align,
  ...rest
}) {
  const Component = element;
  return /* @__PURE__ */ jsx(
    Component,
    {
      ...rest,
      className: cx(
        "leading-relaxed",
        textSizeClasses[size],
        textToneClasses[tone],
        textWeightClasses[weight],
        resolveTextAlignClass(align)
      ),
      children
    }
  );
}
const ToastContext = createContext({
  addToast: () => {
  }
});
function useToasts() {
  return useContext(ToastContext);
}
let nextId = 0;
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const addToast = useCallback((title, tone = "success", description) => {
    const id = `toast-${++nextId}`;
    setToasts((prev) => [...prev, { id, title, description, tone, open: true }]);
  }, []);
  const handleOpenChange = useCallback((id, open) => {
    if (!open) {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }
  }, []);
  return /* @__PURE__ */ jsxs(ToastContext.Provider, { value: { addToast }, children: [
    children,
    /* @__PURE__ */ jsx(
      ToastRegion,
      {
        items: toasts.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          tone: t.tone,
          open: t.open,
          onOpenChange: (open) => handleOpenChange(t.id, open)
        }))
      }
    )
  ] });
}
function CatalogAdminProviders({ children }) {
  return /* @__PURE__ */ jsx(ToastProvider, { children });
}
const catalogAdminNavItems = [
  { key: "dimensions", label: "Dimensions", icon: "spark", href: "/dimensions" },
  { key: "fields", label: "Fields", icon: "edit", href: "/fields" },
  { key: "components", label: "Components", icon: "package", href: "/components" },
  { key: "blueprints", label: "Blueprints", icon: "copy", href: "/blueprints" },
  { key: "categories", label: "Categories", icon: "filter", href: "/categories" },
  { key: "catalog-items", label: "Catalog Items", icon: "dashboard", href: "/catalog-items" }
];
function CatalogAdminLayout({
  activeKey,
  children
}) {
  const [colorMode] = useState("system");
  return /* @__PURE__ */ jsx(ChaseRoot, { colorMode, children: /* @__PURE__ */ jsx(CatalogAdminProviders, { children: /* @__PURE__ */ jsx(
    AdminShell,
    {
      brand: /* @__PURE__ */ jsx(Text, { weight: "semibold", children: "Catalog Admin" }),
      navItems: catalogAdminNavItems,
      activeKey,
      children
    }
  ) }) });
}
function resolveActiveKey(pathname) {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment || "dimensions";
}
const layout = UNSAFE_withComponentProps(function CatalogAdminLayoutRoute() {
  const location = useLocation();
  return /* @__PURE__ */ jsx(CatalogAdminLayout, {
    activeKey: resolveActiveKey(location.pathname),
    children: /* @__PURE__ */ jsx(Outlet, {})
  });
});
const route1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: layout
}, Symbol.toStringTag, { value: "Module" }));
function loader$c() {
  throw redirect("/dimensions");
}
const index = UNSAFE_withComponentProps(function CatalogAdminIndexRoute() {
  return null;
});
const route2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: index,
  loader: loader$c
}, Symbol.toStringTag, { value: "Module" }));
function createId(prefix) {
  return `${prefix}_${ulid()}`;
}
const ALL_STATUSES = "__all__";
function EntityListPage({
  title,
  entityName,
  items,
  total,
  loading,
  error,
  columns: columns2,
  getRowId,
  getHref,
  createButton,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  statusOptions: statusOptions2,
  page = 0,
  pageSize = 50,
  onPageChange
}) {
  const totalPages = total !== void 0 ? Math.ceil(total / pageSize) : 0;
  const showPagination = total !== void 0 && total > pageSize;
  const columnsWithView = useMemo(() => [
    ...columns2,
    {
      key: "__view__",
      header: "",
      cell: (row) => /* @__PURE__ */ jsx(LinkButton, { href: getHref(row), size: "sm", tone: "secondary", children: "View" })
    }
  ], [columns2, getHref]);
  return /* @__PURE__ */ jsxs(Page, { children: [
    /* @__PURE__ */ jsx(
      PageHeader,
      {
        title,
        actions: createButton
      }
    ),
    /* @__PURE__ */ jsxs(Stack, { gap: 4, children: [
      (onSearchChange || onStatusFilterChange) && /* @__PURE__ */ jsxs(Inline, { gap: 3, align: "start", children: [
        onSearchChange && /* @__PURE__ */ jsx(
          TextInput,
          {
            label: "Search",
            value: search ?? "",
            onChange: (e) => onSearchChange(e.target.value),
            placeholder: `Search ${title.toLowerCase()}...`
          }
        ),
        onStatusFilterChange && statusOptions2 && /* @__PURE__ */ jsx(
          Select,
          {
            label: "Status",
            value: statusFilter || ALL_STATUSES,
            onValueChange: (v) => onStatusFilterChange(v === ALL_STATUSES ? "" : v),
            items: [{ label: "All statuses", value: ALL_STATUSES }, ...statusOptions2]
          }
        )
      ] }),
      error && /* @__PURE__ */ jsx(Banner, { tone: "danger", title: "Error", description: error }),
      loading && !items ? /* @__PURE__ */ jsx(LoadingSpinner, { label: `Loading ${title.toLowerCase()}...` }) : items && items.length === 0 ? /* @__PURE__ */ jsx(
        EmptyState,
        {
          title: `No ${title.toLowerCase()} found`,
          description: search || statusFilter ? "Try adjusting your filters." : `Create your first ${entityName.toLowerCase()} to get started.`,
          icon: "package"
        }
      ) : items ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(
          DataTable,
          {
            rows: items,
            columns: columnsWithView,
            getRowId: (row) => getRowId(row),
            emptyTitle: `No ${title.toLowerCase()}`
          }
        ),
        showPagination && /* @__PURE__ */ jsxs(Inline, { gap: 2, align: "center", children: [
          /* @__PURE__ */ jsx(
            Button,
            {
              tone: "secondary",
              size: "sm",
              onClick: () => onPageChange?.(page - 1),
              disabled: page === 0,
              children: "Previous"
            }
          ),
          /* @__PURE__ */ jsxs("span", { children: [
            "Page ",
            page + 1,
            " of ",
            totalPages
          ] }),
          /* @__PURE__ */ jsx(
            Button,
            {
              tone: "secondary",
              size: "sm",
              onClick: () => onPageChange?.(page + 1),
              disabled: page >= totalPages - 1,
              children: "Next"
            }
          )
        ] })
      ] }) : null
    ] })
  ] });
}
const DEFAULT_BASE_URL = "/api/catalog";
class ApiError extends Error {
  constructor(status, body) {
    super(
      typeof body === "object" && body !== null && "error" in body ? String(body.error) : `API error ${status}`
    );
    this.status = status;
    this.body = body;
  }
}
function queryFromString(query) {
  return Object.fromEntries(new URLSearchParams(query).entries());
}
async function parseJsonResponse(response) {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(response.status, errorBody);
  }
  return response.json();
}
function getDevHeaders() {
  return {
    "X-Tenant-Id": "tenant_dev",
    "X-User-Id": "user_dev",
    "X-Account-Id": "account_dev"
  };
}
function createCatalogApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch
} = {}) {
  const client = hc(baseUrl, { fetch });
  const headers = getDevHeaders();
  return {
    async listDimensions(query) {
      const response = await client.dimensions.$get({
        query: queryFromString(query),
        header: headers
      });
      return parseJsonResponse(response);
    },
    async getDimension(id) {
      const response = await client.dimensions[":id"].$get({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async createDimension(body) {
      const response = await client.dimensions.$post({
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseDimension(id, body) {
      const response = await client.dimensions[":id"].$put({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async activateDimension(id) {
      const response = await client.dimensions[":id"].activate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async deprecateDimension(id) {
      const response = await client.dimensions[":id"].deprecate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async archiveDimension(id) {
      const response = await client.dimensions[":id"].archive.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async addChoice(dimensionId, body) {
      const response = await client.dimensions[":id"].choices.$post({
        param: { id: dimensionId },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseChoice(dimensionId, choiceId, body) {
      const response = await client.dimensions[":id"].choices[":choiceId"].$put({
        param: { id: dimensionId, choiceId },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async deprecateChoice(dimensionId, choiceId) {
      const response = await client.dimensions[":id"].choices[":choiceId"].deprecate.$post({
        param: { id: dimensionId, choiceId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reactivateChoice(dimensionId, choiceId) {
      const response = await client.dimensions[":id"].choices[":choiceId"].reactivate.$post({
        param: { id: dimensionId, choiceId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reorderChoices(dimensionId, choiceIds) {
      const response = await client.dimensions[":id"].choices.order.$put({
        param: { id: dimensionId },
        json: { choiceIds },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async listFields(query) {
      const response = await client.fields.$get({
        query: queryFromString(query),
        header: headers
      });
      return parseJsonResponse(response);
    },
    async getField(id) {
      const response = await client.fields[":id"].$get({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async createField(body) {
      const response = await client.fields.$post({
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseField(id, body) {
      const response = await client.fields[":id"].$put({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async activateField(id) {
      const response = await client.fields[":id"].activate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async deprecateField(id) {
      const response = await client.fields[":id"].deprecate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async archiveField(id) {
      const response = await client.fields[":id"].archive.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async listComponents(query) {
      const response = await client.components.$get({
        query: queryFromString(query),
        header: headers
      });
      return parseJsonResponse(response);
    },
    async getComponent(id) {
      const response = await client.components[":id"].$get({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async createComponent(body) {
      const response = await client.components.$post({
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseComponent(id, body) {
      const response = await client.components[":id"].$put({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async addFieldRule(id, body) {
      const response = await client.components[":id"]["field-rules"].$post({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async removeFieldRule(id, fieldId) {
      const response = await client.components[":id"]["field-rules"][":fieldId"].$delete({
        param: { id, fieldId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async addDimensionRule(id, body) {
      const response = await client.components[":id"]["dimension-rules"].$post({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async removeDimensionRule(id, dimensionId) {
      const response = await client.components[":id"]["dimension-rules"][":dimensionId"].$delete({
        param: { id, dimensionId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async activateComponent(id) {
      const response = await client.components[":id"].activate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async deprecateComponent(id) {
      const response = await client.components[":id"].deprecate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async archiveComponent(id) {
      const response = await client.components[":id"].archive.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async listBlueprints(query) {
      const response = await client.blueprints.$get({
        query: queryFromString(query),
        header: headers
      });
      return parseJsonResponse(response);
    },
    async getBlueprint(id) {
      const response = await client.blueprints[":id"].$get({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async createBlueprint(body) {
      const response = await client.blueprints.$post({
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseBlueprint(id, body) {
      const response = await client.blueprints[":id"].$put({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async attachComponent(id, componentId) {
      const response = await client.blueprints[":id"].components[":componentId"].$post({
        param: { id, componentId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async detachComponent(id, componentId) {
      const response = await client.blueprints[":id"].components[":componentId"].$delete({
        param: { id, componentId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async setBlueprintFields(id, fieldRules) {
      const response = await client.blueprints[":id"].fields.$put({
        param: { id },
        json: { fieldRules },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async setBlueprintDimensions(id, dimensionRules) {
      const response = await client.blueprints[":id"].dimensions.$put({
        param: { id },
        json: { dimensionRules },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async setBlueprintVersionRules(id, canonicalDimensionOrder) {
      const response = await client.blueprints[":id"]["version-rules"].$put({
        param: { id },
        json: { canonicalDimensionOrder },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async publishBlueprint(id) {
      const response = await client.blueprints[":id"].publish.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async deprecateBlueprint(id) {
      const response = await client.blueprints[":id"].deprecate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async archiveBlueprint(id) {
      const response = await client.blueprints[":id"].archive.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async listCategories(query) {
      const response = await client.categories.$get({
        query: queryFromString(query),
        header: headers
      });
      return parseJsonResponse(response);
    },
    async getCategory(id) {
      const response = await client.categories[":id"].$get({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async createCategory(body) {
      const response = await client.categories.$post({
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseCategory(id, body) {
      const response = await client.categories[":id"].$put({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async publishCategory(id) {
      const response = await client.categories[":id"].publish.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async deprecateCategory(id) {
      const response = await client.categories[":id"].deprecate.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async archiveCategory(id) {
      const response = await client.categories[":id"].archive.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async listCatalogItems(query) {
      const response = await client.items.$get({
        query: queryFromString(query),
        header: headers
      });
      return parseJsonResponse(response);
    },
    async getCatalogItem(id) {
      const response = await client.items[":id"].$get({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async createCatalogItem(body) {
      const response = await client.items.$post({
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async assignBlueprint(id, blueprintId) {
      const response = await client.items[":id"].blueprint.$post({
        param: { id },
        json: { blueprintId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async setFieldValue(id, fieldId, value) {
      const response = await client.items[":id"].fields[":fieldId"].$put({
        param: { id, fieldId },
        json: { value },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async clearFieldValue(id, fieldId) {
      const response = await client.items[":id"].fields[":fieldId"].$delete({
        param: { id, fieldId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async assignCategory(id, categoryId) {
      const response = await client.items[":id"].categories[":categoryId"].$post({
        param: { id, categoryId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async removeCategory(id, categoryId) {
      const response = await client.items[":id"].categories[":categoryId"].$delete({
        param: { id, categoryId },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async publishCatalogItem(id, blueprintIsActive, requiredFieldIds) {
      const response = await client.items[":id"].publish.$post({
        param: { id },
        json: { blueprintIsActive, requiredFieldIds },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async reviseMetadata(id, body) {
      const response = await client.items[":id"].metadata.$put({
        param: { id },
        json: body,
        header: headers
      });
      return parseJsonResponse(response);
    },
    async retireCatalogItem(id) {
      const response = await client.items[":id"].retire.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async archiveCatalogItem(id) {
      const response = await client.items[":id"].archive.$post({
        param: { id },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async setTags(id, tags) {
      const response = await client.items[":id"].tags.$put({
        param: { id },
        json: { tags },
        header: headers
      });
      return parseJsonResponse(response);
    },
    async setImageUrls(id, imageUrls) {
      const response = await client.items[":id"]["image-urls"].$put({
        param: { id },
        json: { imageUrls },
        header: headers
      });
      return parseJsonResponse(response);
    }
  };
}
const api = createCatalogApiClient();
function useFetch(fetcher, deps = [], initialData) {
  const hasInitialData = initialData !== void 0;
  const [data, setData] = useState(initialData ?? null);
  const [loading, setLoading] = useState(!hasInitialData);
  const [error, setError] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const refresh = useCallback(() => setRefreshCount((c) => c + 1), []);
  useEffect(() => {
    if (hasInitialData && refreshCount === 0) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher().then((result) => {
      if (!cancelled) {
        setData(result);
        setLoading(false);
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasInitialData, refreshCount, ...deps]);
  return { data, loading, error, refresh };
}
function useDimensionList(query, initialData) {
  return useFetch(() => api.listDimensions(query), [query], initialData);
}
function useDimension(id, initialData) {
  return useFetch(() => api.getDimension(id), [id], initialData);
}
function createDimension(body) {
  return api.createDimension(body);
}
function reviseDimension(id, body) {
  return api.reviseDimension(id, body);
}
function activateDimension(id) {
  return api.activateDimension(id);
}
function deprecateDimension(id) {
  return api.deprecateDimension(id);
}
function archiveDimension(id) {
  return api.archiveDimension(id);
}
function addChoice(dimensionId, body) {
  return api.addChoice(dimensionId, body);
}
function reviseChoice(dimensionId, choiceId, body) {
  return api.reviseChoice(dimensionId, choiceId, body);
}
function deprecateChoice(dimensionId, choiceId) {
  return api.deprecateChoice(dimensionId, choiceId);
}
function reactivateChoice(dimensionId, choiceId) {
  return api.reactivateChoice(dimensionId, choiceId);
}
function reorderChoices(dimensionId, choiceIds) {
  return api.reorderChoices(dimensionId, choiceIds);
}
const columns$3 = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
];
const statusOptions$5 = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" }
];
function DimensionListPage({ initialData }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);
  const { data, loading, error, refresh } = useDimensionList(query, initialData);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  async function handleCreate() {
    const dimensionId = createId("dim");
    await createDimension({ dimensionId, key, name, description: description || void 0 });
    addToast("Dimension created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityListPage,
      {
        title: "Dimensions",
        entityName: "dimension",
        items: data?.items ?? null,
        total: data?.total,
        loading,
        error,
        columns: columns$3,
        getRowId: (row) => row.dimension_id,
        getHref: (row) => `/dimensions/${row.dimension_id}`,
        search,
        onSearchChange: (v) => {
          setSearch(v);
          setPage(0);
        },
        statusFilter,
        onStatusFilterChange: (v) => {
          setStatusFilter(v);
          setPage(0);
        },
        statusOptions: statusOptions$5,
        page,
        pageSize: 50,
        onPageChange: setPage,
        createButton: /* @__PURE__ */ jsx(Button, { onClick: () => setShowCreate(true), children: "New Dimension" })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showCreate,
        onOpenChange: setShowCreate,
        title: "Create Dimension",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleCreate, children: "Create" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: key, onChange: (e) => setKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: name, onChange: (e) => setName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: description, onChange: (e) => setDescription(e.target.value) })
        ] })
      }
    )
  ] });
}
function getCatalogApiBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.origin}/api/catalog`;
}
function createCatalogServerApiClient(request) {
  return createCatalogApiClient({
    baseUrl: getCatalogApiBaseUrl(request),
    fetch: globalThis.fetch
  });
}
const DEFAULT_LIST_QUERY$5 = "limit=50&offset=0";
async function loader$b({
  request
}) {
  const api2 = createCatalogServerApiClient(request);
  return api2.listDimensions(DEFAULT_LIST_QUERY$5);
}
const meta$b = () => [{
  title: "Dimensions | Catalog Admin"
}];
const dimensions = UNSAFE_withComponentProps(function DimensionsRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(DimensionListPage, {
    initialData: data
  });
});
const route3 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: dimensions,
  loader: loader$b,
  meta: meta$b
}, Symbol.toStringTag, { value: "Module" }));
function EntityDetailPage({
  title,
  breadcrumbs,
  actions,
  loading,
  notFound,
  error,
  children
}) {
  return /* @__PURE__ */ jsxs(Page, { children: [
    /* @__PURE__ */ jsx(Breadcrumbs, { items: breadcrumbs }),
    /* @__PURE__ */ jsx(PageHeader, { title, actions }),
    /* @__PURE__ */ jsxs(Stack, { gap: 4, children: [
      error && /* @__PURE__ */ jsx(Banner, { tone: "danger", title: "Error", description: error }),
      loading ? /* @__PURE__ */ jsx(LoadingSpinner, { label: "Loading..." }) : notFound ? /* @__PURE__ */ jsx(EmptyState, { title: "Not found", description: "The requested item does not exist.", icon: "search" }) : children
    ] })
  ] });
}
const statusTone = {
  draft: "neutral",
  active: "success",
  published: "success",
  deprecated: "warning",
  retired: "warning",
  archived: "danger"
};
function LifecycleControls({ status, transitions, onAction, loading }) {
  const [confirming, setConfirming] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  async function handleAction(action) {
    setActionLoading(true);
    try {
      await onAction(action);
    } finally {
      setActionLoading(false);
      setConfirming(null);
    }
  }
  return /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
    /* @__PURE__ */ jsx(StatusPill, { tone: statusTone[status] ?? "neutral", children: status }),
    transitions.map(
      (t) => t.confirm ? /* @__PURE__ */ jsx(
        AlertDialog,
        {
          open: confirming?.action === t.action,
          onOpenChange: (open) => !open && setConfirming(null),
          title: t.confirmTitle ?? `${t.label}?`,
          description: t.confirmDescription ?? `Are you sure you want to ${t.label.toLowerCase()} this item?`,
          confirmLabel: t.label,
          cancelLabel: "Cancel",
          tone: "danger",
          onConfirm: () => handleAction(t.action),
          trigger: /* @__PURE__ */ jsx(
            Button,
            {
              tone: t.tone ?? "secondary",
              size: "sm",
              disabled: loading || actionLoading,
              onClick: () => setConfirming(t),
              children: t.label
            }
          )
        },
        t.action
      ) : /* @__PURE__ */ jsx(
        Button,
        {
          tone: t.tone ?? "secondary",
          size: "sm",
          disabled: loading || actionLoading,
          onClick: () => handleAction(t.action),
          children: t.label
        },
        t.action
      )
    )
  ] });
}
function getTransitions$5(status) {
  switch (status) {
    case "draft":
      return [{ label: "Activate", action: "activate", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}
const choiceColumns = [
  { key: "code", header: "Code", cell: (row) => row.code },
  {
    key: "labels",
    header: "Labels",
    cell: (row) => row.labels && row.labels.length > 0 ? row.labels.map((l) => `${l.locale}: ${l.value}`).join(", ") : "—"
  },
  { key: "numeric_value", header: "Numeric Value", cell: (row) => row.numeric_value ?? "—" },
  { key: "display_order", header: "Order", cell: (row) => row.display_order },
  { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
];
function DimensionDetailPage({ id, initialData }) {
  const { data, loading, error, refresh } = useDimension(id, initialData);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [showAddChoice, setShowAddChoice] = useState(false);
  const [choiceCode, setChoiceCode] = useState("");
  const [choiceNumericValue, setChoiceNumericValue] = useState("");
  const [choiceLabels, setChoiceLabels] = useState([{ locale: "en", value: "" }]);
  const [editingChoice, setEditingChoice] = useState(null);
  const [editChoiceCode, setEditChoiceCode] = useState("");
  const [editChoiceNumericValue, setEditChoiceNumericValue] = useState("");
  const [editChoiceLabels, setEditChoiceLabels] = useState([]);
  const [showReorder, setShowReorder] = useState(false);
  const [reorderInput, setReorderInput] = useState("");
  async function handleLifecycleAction(action) {
    const actions = {
      activate: () => activateDimension(id),
      deprecate: () => deprecateDimension(id),
      archive: () => archiveDimension(id)
    };
    await actions[action]?.();
    addToast(`Dimension ${action}d`, "success");
    refresh();
  }
  async function handleRevise() {
    await reviseDimension(id, { key: editKey, name: editName, description: editDescription || void 0 });
    addToast("Dimension revised", "success");
    setEditing(false);
    refresh();
  }
  async function handleAddChoice() {
    const choiceId = createId("chc");
    const labels = choiceLabels.filter((l) => l.value.trim());
    await addChoice(id, {
      choiceId,
      code: choiceCode,
      labels: labels.length > 0 ? labels : void 0,
      numericValue: choiceNumericValue ? Number(choiceNumericValue) : void 0
    });
    addToast("Choice added", "success");
    setShowAddChoice(false);
    setChoiceCode("");
    setChoiceNumericValue("");
    setChoiceLabels([{ locale: "en", value: "" }]);
    refresh();
  }
  async function handleReviseChoice() {
    if (!editingChoice) return;
    const labels = editChoiceLabels.filter((l) => l.value.trim());
    await reviseChoice(id, editingChoice.choice_id, {
      code: editChoiceCode,
      labels: labels.length > 0 ? labels : void 0,
      numericValue: editChoiceNumericValue ? Number(editChoiceNumericValue) : void 0
    });
    addToast("Choice revised", "success");
    setEditingChoice(null);
    refresh();
  }
  function startEditChoice(choice) {
    setEditChoiceCode(choice.code);
    setEditChoiceNumericValue(choice.numeric_value?.toString() ?? "");
    setEditChoiceLabels(
      choice.labels && choice.labels.length > 0 ? choice.labels.map((l) => ({ locale: l.locale, value: l.value })) : [{ locale: "en", value: "" }]
    );
    setEditingChoice(choice);
  }
  async function handleDeprecateChoice(choiceId) {
    await deprecateChoice(id, choiceId);
    addToast("Choice deprecated", "success");
    refresh();
  }
  async function handleReactivateChoice(choiceId) {
    await reactivateChoice(id, choiceId);
    addToast("Choice reactivated", "success");
    refresh();
  }
  async function handleReorderChoices() {
    const choiceIds = reorderInput.split(",").map((s) => s.trim()).filter(Boolean);
    await reorderChoices(id, choiceIds);
    addToast("Choices reordered", "success");
    setShowReorder(false);
    refresh();
  }
  function startReorder() {
    if (data) {
      setReorderInput(data.choices.map((c) => c.choice_id).join(", "));
      setShowReorder(true);
    }
  }
  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditing(true);
    }
  }
  function updateLabel(labels, setLabels, index2, field, value) {
    setLabels(labels.map((l, i) => i === index2 ? { ...l, [field]: value } : l));
  }
  function renderLabelsEditor(labels, setLabels) {
    return /* @__PURE__ */ jsxs(Stack, { gap: 2, children: [
      labels.map((label, i) => /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
        /* @__PURE__ */ jsx(
          TextInput,
          {
            label: i === 0 ? "Locale" : void 0,
            value: label.locale,
            onChange: (e) => updateLabel(labels, setLabels, i, "locale", e.target.value)
          }
        ),
        /* @__PURE__ */ jsx(
          TextInput,
          {
            label: i === 0 ? "Label" : void 0,
            value: label.value,
            onChange: (e) => updateLabel(labels, setLabels, i, "value", e.target.value)
          }
        ),
        /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => setLabels(labels.filter((_, j) => j !== i)), children: "Remove" })
      ] }, i)),
      /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: () => setLabels([...labels, { locale: "", value: "" }]), children: "Add Label" }) })
    ] });
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityDetailPage,
      {
        title: data?.name ?? "Dimension",
        breadcrumbs: [
          { label: "Dimensions", href: "/dimensions" },
          { label: data?.name ?? id }
        ],
        actions: data ? /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
          /* @__PURE__ */ jsx(
            LifecycleControls,
            {
              status: data.status,
              transitions: getTransitions$5(data.status),
              onAction: handleLifecycleAction
            }
          ),
          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { tone: "secondary", size: "sm", onClick: startEditing, children: "Edit" })
        ] }) : void 0,
        loading,
        notFound: !loading && !data,
        error,
        children: data && /* @__PURE__ */ jsxs(Stack, { gap: 6, children: [
          /* @__PURE__ */ jsx(
            KeyValueList,
            {
              items: [
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
                { key: "Description", value: data.description ?? "—" },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at }
              ]
            }
          ),
          /* @__PURE__ */ jsx(
            PageSection,
            {
              title: "Choices",
              description: `${data.choices.length} choice(s)`,
              children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
                data.status !== "archived" && /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
                  /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowAddChoice(true), children: "Add Choice" }),
                  data.choices.length > 1 && /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: startReorder, children: "Reorder" })
                ] }),
                /* @__PURE__ */ jsx(
                  DataTable,
                  {
                    rows: data.choices,
                    columns: [
                      ...choiceColumns,
                      {
                        key: "actions",
                        header: "Actions",
                        cell: (row) => /* @__PURE__ */ jsxs(Inline, { gap: 1, children: [
                          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: () => startEditChoice(row), children: "Edit" }),
                          row.status === "active" && /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: () => handleDeprecateChoice(row.choice_id), children: "Deprecate" }),
                          row.status === "deprecated" && /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: () => handleReactivateChoice(row.choice_id), children: "Reactivate" })
                        ] })
                      }
                    ],
                    getRowId: (row) => row.choice_id,
                    emptyTitle: "No choices",
                    emptyDescription: "Add a choice to this dimension."
                  }
                )
              ] })
            }
          )
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showAddChoice,
        onOpenChange: setShowAddChoice,
        title: "Add Choice",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleAddChoice, children: "Add" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Code", value: choiceCode, onChange: (e) => setChoiceCode(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Numeric Value (optional)", value: choiceNumericValue, onChange: (e) => setChoiceNumericValue(e.target.value) }),
          renderLabelsEditor(choiceLabels, setChoiceLabels)
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: editingChoice !== null,
        onOpenChange: (open) => {
          if (!open) setEditingChoice(null);
        },
        title: "Edit Choice",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleReviseChoice, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Code", value: editChoiceCode, onChange: (e) => setEditChoiceCode(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Numeric Value (optional)", value: editChoiceNumericValue, onChange: (e) => setEditChoiceNumericValue(e.target.value) }),
          renderLabelsEditor(editChoiceLabels, setEditChoiceLabels)
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showReorder,
        onOpenChange: setShowReorder,
        title: "Reorder Choices",
        description: "Enter choice IDs separated by commas in the desired order.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleReorderChoices, children: "Save" }),
        children: /* @__PURE__ */ jsx(
          TextInput,
          {
            label: "Choice IDs",
            value: reorderInput,
            onChange: (e) => setReorderInput(e.target.value)
          }
        )
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: editing,
        onOpenChange: setEditing,
        title: "Edit Dimension",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleRevise, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: editKey, onChange: (e) => setEditKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: editName, onChange: (e) => setEditName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: editDescription, onChange: (e) => setEditDescription(e.target.value) })
        ] })
      }
    )
  ] });
}
async function loader$a({
  request,
  params
}) {
  const api2 = createCatalogServerApiClient(request);
  const id = params.id ?? "";
  try {
    const data = await api2.getDimension(id);
    return {
      id,
      data
    };
  } catch {
    return {
      id,
      data: null
    };
  }
}
const meta$a = ({
  data
}) => [{
  title: data?.data ? `${data.data.name} | Catalog Admin` : "Dimension | Catalog Admin"
}];
const dimensionsDetail = UNSAFE_withComponentProps(function DimensionDetailRoute() {
  const {
    id,
    data
  } = useLoaderData();
  return /* @__PURE__ */ jsx(DimensionDetailPage, {
    id,
    initialData: data
  });
});
const route4 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: dimensionsDetail,
  loader: loader$a,
  meta: meta$a
}, Symbol.toStringTag, { value: "Module" }));
function useFieldList(query, initialData) {
  return useFetch(() => api.listFields(query), [query], initialData);
}
function useField(id, initialData) {
  return useFetch(() => api.getField(id), [id], initialData);
}
function createField(body) {
  return api.createField(body);
}
function configureField(id, body) {
  return api.reviseField(id, body);
}
function activateField(id) {
  return api.activateField(id);
}
function deprecateField(id) {
  return api.deprecateField(id);
}
function archiveField(id) {
  return api.archiveField(id);
}
const columns$2 = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "value_type", header: "Type", cell: (row) => row.value_type },
  { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
];
const valueTypeOptions$1 = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" }
];
const statusOptions$4 = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" }
];
function FieldListPage({ initialData }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);
  const { data, loading, error, refresh } = useFieldList(query, initialData);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [valueType, setValueType] = useState("string");
  const [filterable, setFilterable] = useState(false);
  const [searchable, setSearchable] = useState(false);
  const [sortable, setSortable] = useState(false);
  async function handleCreate() {
    const fieldId = createId("fld");
    await createField({ fieldId, key, name, description: description || void 0, valueType, behavior: { filterable, searchable, sortable } });
    addToast("Field created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setValueType("string");
    setFilterable(false);
    setSearchable(false);
    setSortable(false);
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityListPage,
      {
        title: "Fields",
        entityName: "field",
        items: data?.items ?? null,
        total: data?.total,
        loading,
        error,
        columns: columns$2,
        getRowId: (row) => row.field_id,
        getHref: (row) => `/fields/${row.field_id}`,
        search,
        onSearchChange: (v) => {
          setSearch(v);
          setPage(0);
        },
        statusFilter,
        onStatusFilterChange: (v) => {
          setStatusFilter(v);
          setPage(0);
        },
        statusOptions: statusOptions$4,
        page,
        pageSize: 50,
        onPageChange: setPage,
        createButton: /* @__PURE__ */ jsx(Button, { onClick: () => setShowCreate(true), children: "New Field" })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showCreate,
        onOpenChange: setShowCreate,
        title: "Create Field",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleCreate, children: "Create" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: key, onChange: (e) => setKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: name, onChange: (e) => setName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: description, onChange: (e) => setDescription(e.target.value) }),
          /* @__PURE__ */ jsx(Select, { label: "Value Type", items: valueTypeOptions$1, value: valueType, onValueChange: setValueType }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Filterable", checked: filterable, onCheckedChange: (v) => setFilterable(v === true) }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Searchable", checked: searchable, onCheckedChange: (v) => setSearchable(v === true) }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Sortable", checked: sortable, onCheckedChange: (v) => setSortable(v === true) })
        ] })
      }
    )
  ] });
}
const DEFAULT_LIST_QUERY$4 = "limit=50&offset=0";
async function loader$9({
  request
}) {
  const api2 = createCatalogServerApiClient(request);
  return api2.listFields(DEFAULT_LIST_QUERY$4);
}
const meta$9 = () => [{
  title: "Fields | Catalog Admin"
}];
const fields = UNSAFE_withComponentProps(function FieldsRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(FieldListPage, {
    initialData: data
  });
});
const route5 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: fields,
  loader: loader$9,
  meta: meta$9
}, Symbol.toStringTag, { value: "Module" }));
function getTransitions$4(status) {
  switch (status) {
    case "draft":
      return [{ label: "Activate", action: "activate", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}
const valueTypeOptions = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" }
];
function FieldDetailPage({ id, initialData }) {
  const { data, loading, error, refresh } = useField(id, initialData);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editValueType, setEditValueType] = useState("string");
  const [editFilterable, setEditFilterable] = useState(false);
  const [editSearchable, setEditSearchable] = useState(false);
  const [editSortable, setEditSortable] = useState(false);
  async function handleLifecycleAction(action) {
    const actions = {
      activate: () => activateField(id),
      deprecate: () => deprecateField(id),
      archive: () => archiveField(id)
    };
    await actions[action]?.();
    addToast(`Field ${action}d`, "success");
    refresh();
  }
  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditValueType(data.value_type);
      setEditFilterable(data.filterable);
      setEditSearchable(data.searchable);
      setEditSortable(data.sortable);
      setEditing(true);
    }
  }
  async function handleConfigure() {
    await configureField(id, {
      key: editKey,
      name: editName,
      description: editDescription || void 0,
      valueType: editValueType,
      behavior: { filterable: editFilterable, searchable: editSearchable, sortable: editSortable }
    });
    addToast("Field configured", "success");
    setEditing(false);
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityDetailPage,
      {
        title: data?.name ?? "Field",
        breadcrumbs: [
          { label: "Fields", href: "/fields" },
          { label: data?.name ?? id }
        ],
        actions: data ? /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
          /* @__PURE__ */ jsx(
            LifecycleControls,
            {
              status: data.status,
              transitions: getTransitions$4(data.status),
              onAction: handleLifecycleAction
            }
          ),
          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { tone: "secondary", size: "sm", onClick: startEditing, children: "Configure" })
        ] }) : void 0,
        loading,
        notFound: !loading && !data,
        error,
        children: data && /* @__PURE__ */ jsx(
          KeyValueList,
          {
            items: [
              { key: "Key", value: data.key },
              { key: "Name", value: data.name },
              { key: "Description", value: data.description ?? "—" },
              { key: "Value Type", value: data.value_type },
              { key: "Filterable", value: data.filterable ? "Yes" : "No" },
              { key: "Searchable", value: data.searchable ? "Yes" : "No" },
              { key: "Sortable", value: data.sortable ? "Yes" : "No" },
              { key: "Status", value: data.status },
              { key: "Updated", value: data.updated_at }
            ]
          }
        )
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: editing,
        onOpenChange: setEditing,
        title: "Configure Field",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleConfigure, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: editKey, onChange: (e) => setEditKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: editName, onChange: (e) => setEditName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: editDescription, onChange: (e) => setEditDescription(e.target.value) }),
          /* @__PURE__ */ jsx(Select, { label: "Value Type", items: valueTypeOptions, value: editValueType, onValueChange: setEditValueType }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Filterable", checked: editFilterable, onCheckedChange: (v) => setEditFilterable(v === true) }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Searchable", checked: editSearchable, onCheckedChange: (v) => setEditSearchable(v === true) }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Sortable", checked: editSortable, onCheckedChange: (v) => setEditSortable(v === true) })
        ] })
      }
    )
  ] });
}
async function loader$8({
  request,
  params
}) {
  const api2 = createCatalogServerApiClient(request);
  const id = params.id ?? "";
  try {
    const data = await api2.getField(id);
    return {
      id,
      data
    };
  } catch {
    return {
      id,
      data: null
    };
  }
}
const meta$8 = ({
  data
}) => [{
  title: data?.data ? `${data.data.name} | Catalog Admin` : "Field | Catalog Admin"
}];
const fieldsDetail = UNSAFE_withComponentProps(function FieldDetailRoute() {
  const {
    id,
    data
  } = useLoaderData();
  return /* @__PURE__ */ jsx(FieldDetailPage, {
    id,
    initialData: data
  });
});
const route6 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: fieldsDetail,
  loader: loader$8,
  meta: meta$8
}, Symbol.toStringTag, { value: "Module" }));
function useComponentList(query, initialData) {
  return useFetch(() => api.listComponents(query), [query], initialData);
}
function useComponent(id, initialData) {
  return useFetch(() => api.getComponent(id), [id], initialData);
}
function createComponent(body) {
  return api.createComponent(body);
}
function configureComponent(id, body) {
  return api.reviseComponent(id, body);
}
function addFieldRule(id, body) {
  return api.addFieldRule(id, body);
}
function removeFieldRule(id, fieldId) {
  return api.removeFieldRule(id, fieldId);
}
function addDimensionRule(id, body) {
  return api.addDimensionRule(id, body);
}
function removeDimensionRule(id, dimensionId) {
  return api.removeDimensionRule(id, dimensionId);
}
function activateComponent(id) {
  return api.activateComponent(id);
}
function deprecateComponent(id) {
  return api.deprecateComponent(id);
}
function archiveComponent(id) {
  return api.archiveComponent(id);
}
const columns$1 = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
];
const statusOptions$3 = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" }
];
function ComponentListPage({ initialData }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);
  const { data, loading, error, refresh } = useComponentList(query, initialData);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  async function handleCreate() {
    const componentId = createId("cmp");
    await createComponent({ componentId, key, name, description: description || void 0 });
    addToast("Component created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityListPage,
      {
        title: "Components",
        entityName: "component",
        items: data?.items ?? null,
        total: data?.total,
        loading,
        error,
        columns: columns$1,
        getRowId: (row) => row.component_id,
        getHref: (row) => `/components/${row.component_id}`,
        search,
        onSearchChange: (v) => {
          setSearch(v);
          setPage(0);
        },
        statusFilter,
        onStatusFilterChange: (v) => {
          setStatusFilter(v);
          setPage(0);
        },
        statusOptions: statusOptions$3,
        page,
        pageSize: 50,
        onPageChange: setPage,
        createButton: /* @__PURE__ */ jsx(Button, { onClick: () => setShowCreate(true), children: "New Component" })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showCreate,
        onOpenChange: setShowCreate,
        title: "Create Component",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleCreate, children: "Create" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: key, onChange: (e) => setKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: name, onChange: (e) => setName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: description, onChange: (e) => setDescription(e.target.value) })
        ] })
      }
    )
  ] });
}
const DEFAULT_LIST_QUERY$3 = "limit=50&offset=0";
async function loader$7({
  request
}) {
  const api2 = createCatalogServerApiClient(request);
  return api2.listComponents(DEFAULT_LIST_QUERY$3);
}
const meta$7 = () => [{
  title: "Components | Catalog Admin"
}];
const components = UNSAFE_withComponentProps(function ComponentsRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(ComponentListPage, {
    initialData: data
  });
});
const route7 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: components,
  loader: loader$7,
  meta: meta$7
}, Symbol.toStringTag, { value: "Module" }));
function getTransitions$3(status) {
  switch (status) {
    case "draft":
      return [{ label: "Activate", action: "activate", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}
function ComponentDetailPage({ id, initialData }) {
  const { data, loading, error, refresh } = useComponent(id, initialData);
  const { addToast } = useToasts();
  const [showAddField, setShowAddField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);
  const [showAddDimension, setShowAddDimension] = useState(false);
  const [dimensionId, setDimensionId] = useState("");
  const [dimRequired, setDimRequired] = useState(false);
  const [dimAllowedChoiceIds, setDimAllowedChoiceIds] = useState("");
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  async function handleLifecycleAction(action) {
    const actions = {
      activate: () => activateComponent(id),
      deprecate: () => deprecateComponent(id),
      archive: () => archiveComponent(id)
    };
    await actions[action]?.();
    addToast(`Component ${action}d`, "success");
    refresh();
  }
  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditing(true);
    }
  }
  async function handleConfigure() {
    await configureComponent(id, {
      key: editKey,
      name: editName,
      description: editDescription || void 0,
      fieldRules: (data?.field_rules ?? []).map((rule) => ({
        fieldId: rule.fieldId,
        required: rule.required
      })),
      dimensionRules: (data?.dimension_rules ?? []).map((rule) => ({
        dimensionId: rule.dimensionId,
        required: rule.required,
        allowedChoiceIds: rule.allowedChoices.map((choice) => choice.choiceId)
      }))
    });
    addToast("Component updated", "success");
    setEditing(false);
    refresh();
  }
  async function handleAddFieldRule() {
    await addFieldRule(id, { fieldId, required: fieldRequired });
    addToast("Field rule added", "success");
    setShowAddField(false);
    setFieldId("");
    setFieldRequired(false);
    refresh();
  }
  async function handleRemoveFieldRule(fId) {
    await removeFieldRule(id, fId);
    addToast("Field rule removed", "success");
    refresh();
  }
  async function handleAddDimensionRule() {
    const allowedChoiceIds = dimAllowedChoiceIds.split(",").map((s) => s.trim()).filter(Boolean);
    await addDimensionRule(id, {
      dimensionId,
      required: dimRequired,
      allowedChoiceIds: allowedChoiceIds.length > 0 ? allowedChoiceIds : void 0
    });
    addToast("Dimension rule added", "success");
    setShowAddDimension(false);
    setDimensionId("");
    setDimRequired(false);
    setDimAllowedChoiceIds("");
    refresh();
  }
  async function handleRemoveDimensionRule(dId) {
    await removeDimensionRule(id, dId);
    addToast("Dimension rule removed", "success");
    refresh();
  }
  const fieldRules = data?.field_rules ?? [];
  const dimensionRules = data?.dimension_rules ?? [];
  const fieldRuleColumns = [
    { key: "fieldId", header: "Field", cell: (row) => row.fieldName },
    { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => handleRemoveFieldRule(row.fieldId), children: "Remove" }) : null
    }
  ];
  const dimensionRuleColumns = [
    { key: "dimensionId", header: "Dimension", cell: (row) => row.dimensionName },
    { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
    {
      key: "allowedChoices",
      header: "Allowed Choices",
      cell: (row) => row.allowedChoices.length > 0 ? row.allowedChoices.map((choice) => choice.code).join(", ") : "All"
    },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => handleRemoveDimensionRule(row.dimensionId), children: "Remove" }) : null
    }
  ];
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityDetailPage,
      {
        title: data?.name ?? "Component",
        breadcrumbs: [
          { label: "Components", href: "/components" },
          { label: data?.name ?? id }
        ],
        actions: data ? /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
          /* @__PURE__ */ jsx(
            LifecycleControls,
            {
              status: data.status,
              transitions: getTransitions$3(data.status),
              onAction: handleLifecycleAction
            }
          ),
          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { tone: "secondary", size: "sm", onClick: startEditing, children: "Edit" })
        ] }) : void 0,
        loading,
        notFound: !loading && !data,
        error,
        children: data && /* @__PURE__ */ jsxs(Stack, { gap: 6, children: [
          /* @__PURE__ */ jsx(
            KeyValueList,
            {
              items: [
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
                { key: "Description", value: data.description ?? "—" },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at }
              ]
            }
          ),
          /* @__PURE__ */ jsx(PageSection, { title: "Field Rules", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status !== "archived" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowAddField(true), children: "Add Field Rule" }) }),
            /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: fieldRules,
                columns: fieldRuleColumns,
                getRowId: (row) => row.fieldId,
                emptyTitle: "No field rules"
              }
            )
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Dimension Rules", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status !== "archived" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowAddDimension(true), children: "Add Dimension Rule" }) }),
            /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: dimensionRules,
                columns: dimensionRuleColumns,
                getRowId: (row) => row.dimensionId,
                emptyTitle: "No dimension rules"
              }
            )
          ] }) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: editing,
        onOpenChange: setEditing,
        title: "Edit Component",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleConfigure, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: editKey, onChange: (e) => setEditKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: editName, onChange: (e) => setEditName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: editDescription, onChange: (e) => setEditDescription(e.target.value) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showAddField,
        onOpenChange: setShowAddField,
        title: "Add Field Rule",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleAddFieldRule, children: "Add" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Field ID", value: fieldId, onChange: (e) => setFieldId(e.target.value) }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Required", checked: fieldRequired, onCheckedChange: (v) => setFieldRequired(v === true) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showAddDimension,
        onOpenChange: setShowAddDimension,
        title: "Add Dimension Rule",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleAddDimensionRule, children: "Add" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Dimension ID", value: dimensionId, onChange: (e) => setDimensionId(e.target.value) }),
          /* @__PURE__ */ jsx(Checkbox, { label: "Required", checked: dimRequired, onCheckedChange: (v) => setDimRequired(v === true) }),
          /* @__PURE__ */ jsx(
            TextInput,
            {
              label: "Allowed Choice IDs (comma-separated, leave empty for all)",
              value: dimAllowedChoiceIds,
              onChange: (e) => setDimAllowedChoiceIds(e.target.value)
            }
          )
        ] })
      }
    )
  ] });
}
async function loader$6({
  request,
  params
}) {
  const api2 = createCatalogServerApiClient(request);
  const id = params.id ?? "";
  try {
    const data = await api2.getComponent(id);
    return {
      id,
      data
    };
  } catch {
    return {
      id,
      data: null
    };
  }
}
const meta$6 = ({
  data
}) => [{
  title: data?.data ? `${data.data.name} | Catalog Admin` : "Component | Catalog Admin"
}];
const componentsDetail = UNSAFE_withComponentProps(function ComponentDetailRoute() {
  const {
    id,
    data
  } = useLoaderData();
  return /* @__PURE__ */ jsx(ComponentDetailPage, {
    id,
    initialData: data
  });
});
const route8 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: componentsDetail,
  loader: loader$6,
  meta: meta$6
}, Symbol.toStringTag, { value: "Module" }));
function useBlueprintList(query, initialData) {
  return useFetch(() => api.listBlueprints(query), [query], initialData);
}
function useBlueprint(id, initialData) {
  return useFetch(() => api.getBlueprint(id), [id], initialData);
}
function createBlueprint(body) {
  return api.createBlueprint(body);
}
function reviseBlueprint(id, body) {
  return api.reviseBlueprint(id, body);
}
function attachComponent(id, componentId) {
  return api.attachComponent(id, componentId);
}
function detachComponent(id, componentId) {
  return api.detachComponent(id, componentId);
}
function setBlueprintFields(id, fieldRules) {
  return api.setBlueprintFields(id, fieldRules);
}
function setBlueprintDimensions(id, dimensionRules) {
  return api.setBlueprintDimensions(id, dimensionRules);
}
function setBlueprintVersionRules(id, canonicalDimensionOrder) {
  return api.setBlueprintVersionRules(id, canonicalDimensionOrder);
}
function publishBlueprint(id) {
  return api.publishBlueprint(id);
}
function deprecateBlueprint(id) {
  return api.deprecateBlueprint(id);
}
function archiveBlueprint(id) {
  return api.archiveBlueprint(id);
}
const columns = [
  { key: "key", header: "Key", cell: (row) => row.key },
  { key: "name", header: "Name", cell: (row) => row.name },
  { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
];
const statusOptions$2 = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" }
];
function BlueprintListPage({ initialData }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);
  const { data, loading, error, refresh } = useBlueprintList(query, initialData);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  async function handleCreate() {
    const blueprintId = createId("bpr");
    await createBlueprint({ blueprintId, key, name, description: description || void 0 });
    addToast("Blueprint created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityListPage,
      {
        title: "Blueprints",
        entityName: "blueprint",
        items: data?.items ?? null,
        total: data?.total,
        loading,
        error,
        columns,
        getRowId: (row) => row.blueprint_id,
        getHref: (row) => `/blueprints/${row.blueprint_id}`,
        search,
        onSearchChange: (v) => {
          setSearch(v);
          setPage(0);
        },
        statusFilter,
        onStatusFilterChange: (v) => {
          setStatusFilter(v);
          setPage(0);
        },
        statusOptions: statusOptions$2,
        page,
        pageSize: 50,
        onPageChange: setPage,
        createButton: /* @__PURE__ */ jsx(Button, { onClick: () => setShowCreate(true), children: "New Blueprint" })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showCreate,
        onOpenChange: setShowCreate,
        title: "Create Blueprint",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleCreate, children: "Create" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: key, onChange: (e) => setKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: name, onChange: (e) => setName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: description, onChange: (e) => setDescription(e.target.value) })
        ] })
      }
    )
  ] });
}
const DEFAULT_LIST_QUERY$2 = "limit=50&offset=0";
async function loader$5({
  request
}) {
  const api2 = createCatalogServerApiClient(request);
  return api2.listBlueprints(DEFAULT_LIST_QUERY$2);
}
const meta$5 = () => [{
  title: "Blueprints | Catalog Admin"
}];
const blueprints = UNSAFE_withComponentProps(function BlueprintsRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(BlueprintListPage, {
    initialData: data
  });
});
const route9 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: blueprints,
  loader: loader$5,
  meta: meta$5
}, Symbol.toStringTag, { value: "Module" }));
function getTransitions$2(status) {
  switch (status) {
    case "draft":
      return [{ label: "Publish", action: "publish", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}
function BlueprintDetailPage({ id, initialData }) {
  const { data, loading, error, refresh } = useBlueprint(id, initialData);
  const { addToast } = useToasts();
  const [showAttachComponent, setShowAttachComponent] = useState(false);
  const [componentId, setComponentId] = useState("");
  const [showSetVersionRules, setShowSetVersionRules] = useState(false);
  const [canonicalOrder, setCanonicalOrder] = useState("");
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [showSetFieldRules, setShowSetFieldRules] = useState(false);
  const [editFieldRules, setEditFieldRules] = useState([]);
  const [showSetDimRules, setShowSetDimRules] = useState(false);
  const [editDimRules, setEditDimRules] = useState([]);
  async function handleLifecycleAction(action) {
    const actions = {
      publish: () => publishBlueprint(id),
      deprecate: () => deprecateBlueprint(id),
      archive: () => archiveBlueprint(id)
    };
    await actions[action]?.();
    addToast(`Blueprint ${action}ed`, "success");
    refresh();
  }
  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditing(true);
    }
  }
  async function handleRevise() {
    await reviseBlueprint(id, { key: editKey, name: editName, description: editDescription || void 0 });
    addToast("Blueprint revised", "success");
    setEditing(false);
    refresh();
  }
  async function handleAttachComponent() {
    await attachComponent(id, componentId);
    addToast("Component attached", "success");
    setShowAttachComponent(false);
    setComponentId("");
    refresh();
  }
  async function handleDetachComponent(compId) {
    await detachComponent(id, compId);
    addToast("Component detached", "success");
    refresh();
  }
  async function handleSetVersionRules() {
    const order = canonicalOrder.split(",").map((s) => s.trim()).filter(Boolean);
    await setBlueprintVersionRules(id, order);
    addToast("Version rules set", "success");
    setShowSetVersionRules(false);
    setCanonicalOrder("");
    refresh();
  }
  function startSetFieldRules() {
    setEditFieldRules(
      fieldRules.length > 0 ? fieldRules.map((r) => ({ fieldId: r.fieldId, required: r.required })) : [{ fieldId: "", required: false }]
    );
    setShowSetFieldRules(true);
  }
  async function handleSetFieldRules() {
    const rules = editFieldRules.filter((r) => r.fieldId.trim());
    await setBlueprintFields(id, rules);
    addToast("Field rules set", "success");
    setShowSetFieldRules(false);
    refresh();
  }
  function startSetDimRules() {
    setEditDimRules(
      dimensionRules.length > 0 ? dimensionRules.map((r) => ({
        dimensionId: r.dimensionId,
        required: r.required,
        allowedChoiceIds: r.allowedChoices.map((choice) => choice.choiceId).join(", ")
      })) : [{ dimensionId: "", required: false, allowedChoiceIds: "" }]
    );
    setShowSetDimRules(true);
  }
  async function handleSetDimRules() {
    const rules = editDimRules.filter((r) => r.dimensionId.trim()).map((r) => ({
      dimensionId: r.dimensionId,
      required: r.required,
      allowedChoiceIds: r.allowedChoiceIds.split(",").map((s) => s.trim()).filter(Boolean)
    }));
    await setBlueprintDimensions(id, rules);
    addToast("Dimension rules set", "success");
    setShowSetDimRules(false);
    refresh();
  }
  const fieldRules = data?.field_rules ?? [];
  const dimensionRules = data?.dimension_rules ?? [];
  const components2 = data?.components ?? [];
  const canonicalDimensionOrder = data?.canonical_dimension_order ?? [];
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityDetailPage,
      {
        title: data?.name ?? "Blueprint",
        breadcrumbs: [
          { label: "Blueprints", href: "/blueprints" },
          { label: data?.name ?? id }
        ],
        actions: data ? /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
          /* @__PURE__ */ jsx(
            LifecycleControls,
            {
              status: data.status,
              transitions: getTransitions$2(data.status),
              onAction: handleLifecycleAction
            }
          ),
          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { tone: "secondary", size: "sm", onClick: startEditing, children: "Edit" })
        ] }) : void 0,
        loading,
        notFound: !loading && !data,
        error,
        children: data && /* @__PURE__ */ jsxs(Stack, { gap: 6, children: [
          /* @__PURE__ */ jsx(
            KeyValueList,
            {
              items: [
                { key: "Key", value: data.key },
                { key: "Name", value: data.name },
                { key: "Description", value: data.description ?? "—" },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at }
              ]
            }
          ),
          /* @__PURE__ */ jsx(PageSection, { title: "Components", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status === "draft" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowAttachComponent(true), children: "Attach Component" }) }),
            components2.length === 0 ? /* @__PURE__ */ jsx(Text, { tone: "secondary", children: "No components attached." }) : /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: components2,
                columns: [
                  { key: "componentId", header: "Component", cell: (row) => row.name },
                  {
                    key: "actions",
                    header: "",
                    cell: (row) => data.status === "draft" ? /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => handleDetachComponent(row.componentId), children: "Detach" }) : null
                  }
                ],
                getRowId: (row) => row.componentId
              }
            )
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Field Rules", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status === "draft" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: startSetFieldRules, children: "Set Field Rules" }) }),
            /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: fieldRules,
                columns: [
                  { key: "fieldId", header: "Field", cell: (row) => row.fieldName },
                  { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" }
                ],
                getRowId: (row) => row.fieldId,
                emptyTitle: "No field rules"
              }
            )
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Dimension Rules", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status === "draft" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: startSetDimRules, children: "Set Dimension Rules" }) }),
            /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: dimensionRules,
                columns: [
                  { key: "dimensionId", header: "Dimension", cell: (row) => row.dimensionName },
                  { key: "required", header: "Required", cell: (row) => row.required ? "Yes" : "No" },
                  {
                    key: "allowedChoices",
                    header: "Allowed Choices",
                    cell: (row) => row.allowedChoices.length > 0 ? row.allowedChoices.map((choice) => choice.code).join(", ") : "All"
                  }
                ],
                getRowId: (row) => row.dimensionId,
                emptyTitle: "No dimension rules"
              }
            )
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Version Rules", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            /* @__PURE__ */ jsx(
              KeyValueList,
              {
                items: [
                  { key: "Canonical Dimension Order", value: canonicalDimensionOrder.length > 0 ? canonicalDimensionOrder.map((dimension) => dimension.dimensionName).join(", ") : "Not set" }
                ]
              }
            ),
            data.status === "draft" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => {
              setCanonicalOrder(canonicalDimensionOrder.map((dimension) => dimension.dimensionId).join(", "));
              setShowSetVersionRules(true);
            }, children: "Set Version Rules" }) })
          ] }) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: editing,
        onOpenChange: setEditing,
        title: "Edit Blueprint",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleRevise, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: editKey, onChange: (e) => setEditKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: editName, onChange: (e) => setEditName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: editDescription, onChange: (e) => setEditDescription(e.target.value) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showAttachComponent,
        onOpenChange: setShowAttachComponent,
        title: "Attach Component",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleAttachComponent, children: "Attach" }),
        children: /* @__PURE__ */ jsx(TextInput, { label: "Component ID", value: componentId, onChange: (e) => setComponentId(e.target.value) })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showSetVersionRules,
        onOpenChange: setShowSetVersionRules,
        title: "Set Version Rules",
        description: "Enter dimension IDs separated by commas in the canonical order.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleSetVersionRules, children: "Save" }),
        children: /* @__PURE__ */ jsx(
          TextInput,
          {
            label: "Canonical Dimension Order",
            value: canonicalOrder,
            onChange: (e) => setCanonicalOrder(e.target.value)
          }
        )
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showSetFieldRules,
        onOpenChange: setShowSetFieldRules,
        title: "Set Field Rules",
        description: "Configure which fields apply to this blueprint.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleSetFieldRules, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          editFieldRules.map((rule, i) => /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
            /* @__PURE__ */ jsx(
              TextInput,
              {
                label: i === 0 ? "Field ID" : void 0,
                value: rule.fieldId,
                onChange: (e) => setEditFieldRules((prev) => prev.map((r, j) => j === i ? { ...r, fieldId: e.target.value } : r))
              }
            ),
            /* @__PURE__ */ jsx(
              Checkbox,
              {
                label: "Required",
                checked: rule.required,
                onCheckedChange: (v) => setEditFieldRules((prev) => prev.map((r, j) => j === i ? { ...r, required: v === true } : r))
              }
            ),
            /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => setEditFieldRules((prev) => prev.filter((_, j) => j !== i)), children: "Remove" })
          ] }, i)),
          /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: () => setEditFieldRules((prev) => [...prev, { fieldId: "", required: false }]), children: "Add Rule" }) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showSetDimRules,
        onOpenChange: setShowSetDimRules,
        title: "Set Dimension Rules",
        description: "Configure which dimensions apply to this blueprint.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleSetDimRules, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          editDimRules.map((rule, i) => /* @__PURE__ */ jsxs(Stack, { gap: 2, children: [
            /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
              /* @__PURE__ */ jsx(
                TextInput,
                {
                  label: i === 0 ? "Dimension ID" : void 0,
                  value: rule.dimensionId,
                  onChange: (e) => setEditDimRules((prev) => prev.map((r, j) => j === i ? { ...r, dimensionId: e.target.value } : r))
                }
              ),
              /* @__PURE__ */ jsx(
                Checkbox,
                {
                  label: "Required",
                  checked: rule.required,
                  onCheckedChange: (v) => setEditDimRules((prev) => prev.map((r, j) => j === i ? { ...r, required: v === true } : r))
                }
              ),
              /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => setEditDimRules((prev) => prev.filter((_, j) => j !== i)), children: "Remove" })
            ] }),
            /* @__PURE__ */ jsx(
              TextInput,
              {
                label: "Allowed Choice IDs (comma-separated, leave empty for all)",
                value: rule.allowedChoiceIds,
                onChange: (e) => setEditDimRules((prev) => prev.map((r, j) => j === i ? { ...r, allowedChoiceIds: e.target.value } : r))
              }
            )
          ] }, i)),
          /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", tone: "secondary", onClick: () => setEditDimRules((prev) => [...prev, { dimensionId: "", required: false, allowedChoiceIds: "" }]), children: "Add Rule" }) })
        ] })
      }
    )
  ] });
}
async function loader$4({
  request,
  params
}) {
  const api2 = createCatalogServerApiClient(request);
  const id = params.id ?? "";
  try {
    const data = await api2.getBlueprint(id);
    return {
      id,
      data
    };
  } catch {
    return {
      id,
      data: null
    };
  }
}
const meta$4 = ({
  data
}) => [{
  title: data?.data ? `${data.data.name} | Catalog Admin` : "Blueprint | Catalog Admin"
}];
const blueprintsDetail = UNSAFE_withComponentProps(function BlueprintDetailRoute() {
  const {
    id,
    data
  } = useLoaderData();
  return /* @__PURE__ */ jsx(BlueprintDetailPage, {
    id,
    initialData: data
  });
});
const route10 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: blueprintsDetail,
  loader: loader$4,
  meta: meta$4
}, Symbol.toStringTag, { value: "Module" }));
function useCategoryList(query, initialData) {
  return useFetch(() => api.listCategories(query), [query], initialData);
}
function useCategory(id, initialData) {
  return useFetch(() => api.getCategory(id), [id], initialData);
}
function createCategory(body) {
  return api.createCategory(body);
}
function reviseCategory(id, body) {
  return api.reviseCategory(id, body);
}
function publishCategory(id) {
  return api.publishCategory(id);
}
function deprecateCategory(id) {
  return api.deprecateCategory(id);
}
function archiveCategory(id) {
  return api.archiveCategory(id);
}
function buildColumns$1() {
  return [
    { key: "key", header: "Key", cell: (row) => row.key },
    { key: "name", header: "Name", cell: (row) => row.name },
    { key: "parent", header: "Parent", cell: (row) => row.parent_category?.name ?? "—" },
    { key: "order", header: "Order", align: "right", cell: (row) => row.display_order },
    { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
  ];
}
const statusOptions$1 = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Deprecated", value: "deprecated" },
  { label: "Archived", value: "archived" }
];
function CategoryListPage({ initialData }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);
  const { data, loading, error, refresh } = useCategoryList(query, initialData);
  const columns2 = useMemo(() => buildColumns$1(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [displayOrder, setDisplayOrder] = useState("0");
  async function handleCreate() {
    const categoryId = createId("ctg");
    await createCategory({
      categoryId,
      key,
      name,
      description: description || void 0,
      parentCategoryId: parentId || void 0,
      displayOrder: Number(displayOrder) || 0
    });
    addToast("Category created", "success");
    setShowCreate(false);
    setKey("");
    setName("");
    setDescription("");
    setParentId("");
    setDisplayOrder("0");
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityListPage,
      {
        title: "Categories",
        entityName: "category",
        items: data?.items ?? null,
        total: data?.total,
        loading,
        error,
        columns: columns2,
        getRowId: (row) => row.category_id,
        getHref: (row) => `/categories/${row.category_id}`,
        search,
        onSearchChange: (v) => {
          setSearch(v);
          setPage(0);
        },
        statusFilter,
        onStatusFilterChange: (v) => {
          setStatusFilter(v);
          setPage(0);
        },
        statusOptions: statusOptions$1,
        page,
        pageSize: 50,
        onPageChange: setPage,
        createButton: /* @__PURE__ */ jsx(Button, { onClick: () => setShowCreate(true), children: "New Category" })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showCreate,
        onOpenChange: setShowCreate,
        title: "Create Category",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleCreate, children: "Create" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: key, onChange: (e) => setKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: name, onChange: (e) => setName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: description, onChange: (e) => setDescription(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Parent Category ID (optional)", value: parentId, onChange: (e) => setParentId(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Display Order", value: displayOrder, onChange: (e) => setDisplayOrder(e.target.value) })
        ] })
      }
    )
  ] });
}
const DEFAULT_LIST_QUERY$1 = "limit=50&offset=0";
async function loader$3({
  request
}) {
  const api2 = createCatalogServerApiClient(request);
  return api2.listCategories(DEFAULT_LIST_QUERY$1);
}
const meta$3 = () => [{
  title: "Categories | Catalog Admin"
}];
const categories = UNSAFE_withComponentProps(function CategoriesRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(CategoryListPage, {
    initialData: data
  });
});
const route11 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: categories,
  loader: loader$3,
  meta: meta$3
}, Symbol.toStringTag, { value: "Module" }));
function getTransitions$1(status) {
  switch (status) {
    case "draft":
      return [{ label: "Publish", action: "publish", tone: "primary" }];
    case "active":
      return [{ label: "Deprecate", action: "deprecate", confirm: true, tone: "danger" }];
    case "deprecated":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}
function CategoryDetailPage({ id, initialData }) {
  const { data, loading, error, refresh } = useCategory(id, initialData);
  const { addToast } = useToasts();
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editParentId, setEditParentId] = useState("");
  const [editDisplayOrder, setEditDisplayOrder] = useState("0");
  async function handleLifecycleAction(action) {
    const actions = {
      publish: () => publishCategory(id),
      deprecate: () => deprecateCategory(id),
      archive: () => archiveCategory(id)
    };
    await actions[action]?.();
    addToast(`Category ${action}ed`, "success");
    refresh();
  }
  function startEditing() {
    if (data) {
      setEditKey(data.key);
      setEditName(data.name);
      setEditDescription(data.description ?? "");
      setEditParentId(data.parent_category?.categoryId ?? "");
      setEditDisplayOrder(String(data.display_order));
      setEditing(true);
    }
  }
  async function handleRevise() {
    await reviseCategory(id, {
      key: editKey,
      name: editName,
      description: editDescription || void 0,
      parentCategoryId: editParentId || null,
      displayOrder: Number(editDisplayOrder) || 0
    });
    addToast("Category revised", "success");
    setEditing(false);
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityDetailPage,
      {
        title: data?.name ?? "Category",
        breadcrumbs: [
          { label: "Categories", href: "/categories" },
          { label: data?.name ?? id }
        ],
        actions: data ? /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
          /* @__PURE__ */ jsx(
            LifecycleControls,
            {
              status: data.status,
              transitions: getTransitions$1(data.status),
              onAction: handleLifecycleAction
            }
          ),
          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { tone: "secondary", size: "sm", onClick: startEditing, children: "Edit" })
        ] }) : void 0,
        loading,
        notFound: !loading && !data,
        error,
        children: data && /* @__PURE__ */ jsx(
          KeyValueList,
          {
            items: [
              { key: "Key", value: data.key },
              { key: "Name", value: data.name },
              { key: "Description", value: data.description ?? "—" },
              { key: "Parent Category", value: data.parent_category?.name ?? "None (root)" },
              { key: "Display Order", value: String(data.display_order) },
              { key: "Status", value: data.status },
              { key: "Updated", value: data.updated_at }
            ]
          }
        )
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: editing,
        onOpenChange: setEditing,
        title: "Edit Category",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleRevise, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Key", value: editKey, onChange: (e) => setEditKey(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Name", value: editName, onChange: (e) => setEditName(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: editDescription, onChange: (e) => setEditDescription(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Parent Category ID", value: editParentId, onChange: (e) => setEditParentId(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Display Order", value: editDisplayOrder, onChange: (e) => setEditDisplayOrder(e.target.value) })
        ] })
      }
    )
  ] });
}
async function loader$2({
  request,
  params
}) {
  const api2 = createCatalogServerApiClient(request);
  const id = params.id ?? "";
  try {
    const data = await api2.getCategory(id);
    return {
      id,
      data
    };
  } catch {
    return {
      id,
      data: null
    };
  }
}
const meta$2 = ({
  data
}) => [{
  title: data?.data ? `${data.data.name} | Catalog Admin` : "Category | Catalog Admin"
}];
const categoriesDetail = UNSAFE_withComponentProps(function CategoryDetailRoute() {
  const {
    id,
    data
  } = useLoaderData();
  return /* @__PURE__ */ jsx(CategoryDetailPage, {
    id,
    initialData: data
  });
});
const route12 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: categoriesDetail,
  loader: loader$2,
  meta: meta$2
}, Symbol.toStringTag, { value: "Module" }));
function useCatalogItemList(query, initialData) {
  return useFetch(() => api.listCatalogItems(query), [query], initialData);
}
function useCatalogItem(id, initialData) {
  return useFetch(() => api.getCatalogItem(id), [id], initialData);
}
function createCatalogItem(body) {
  return api.createCatalogItem(body);
}
function assignBlueprint(id, blueprintId) {
  return api.assignBlueprint(id, blueprintId);
}
function setFieldValue(id, fieldId, value) {
  return api.setFieldValue(id, fieldId, value);
}
function clearFieldValue(id, fieldId) {
  return api.clearFieldValue(id, fieldId);
}
function assignCategory(id, categoryId) {
  return api.assignCategory(id, categoryId);
}
function removeCategory(id, categoryId) {
  return api.removeCategory(id, categoryId);
}
function publishCatalogItem(id, blueprintIsActive, requiredFieldIds) {
  return api.publishCatalogItem(id, blueprintIsActive, requiredFieldIds);
}
function reviseMetadata(id, body) {
  return api.reviseMetadata(id, body);
}
function retireCatalogItem(id) {
  return api.retireCatalogItem(id);
}
function archiveCatalogItem(id) {
  return api.archiveCatalogItem(id);
}
function setTags(id, tags) {
  return api.setTags(id, tags);
}
function setImageUrls(id, imageUrls) {
  return api.setImageUrls(id, imageUrls);
}
function buildColumns() {
  return [
    { key: "title", header: "Title", cell: (row) => row.title },
    { key: "subtitle", header: "Subtitle", cell: (row) => row.subtitle ?? "—" },
    { key: "blueprint", header: "Blueprint", cell: (row) => row.blueprint?.name ?? "—" },
    { key: "status", header: "Status", cell: (row) => /* @__PURE__ */ jsx(StatusPill, { children: row.status }) }
  ];
}
const statusOptions = [
  { label: "Draft", value: "draft" },
  { label: "Active", value: "active" },
  { label: "Retired", value: "retired" },
  { label: "Archived", value: "archived" }
];
function CatalogItemListPage({ initialData }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", "50");
    params.set("offset", String(page * 50));
    return params.toString();
  }, [search, statusFilter, page]);
  const { data, loading, error, refresh } = useCatalogItemList(query, initialData);
  const columns2 = useMemo(() => buildColumns(), []);
  const { addToast } = useToasts();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [description, setDescription] = useState("");
  async function handleCreate() {
    const itemId = createId("cat");
    await createCatalogItem({ itemId, title, subtitle: subtitle || void 0, description: description || void 0 });
    addToast("Catalog item created", "success");
    setShowCreate(false);
    setTitle("");
    setSubtitle("");
    setDescription("");
    refresh();
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityListPage,
      {
        title: "Catalog Items",
        entityName: "catalog item",
        items: data?.items ?? null,
        total: data?.total,
        loading,
        error,
        columns: columns2,
        getRowId: (row) => row.item_id,
        getHref: (row) => `/catalog-items/${row.item_id}`,
        search,
        onSearchChange: (v) => {
          setSearch(v);
          setPage(0);
        },
        statusFilter,
        onStatusFilterChange: (v) => {
          setStatusFilter(v);
          setPage(0);
        },
        statusOptions,
        page,
        pageSize: 50,
        onPageChange: setPage,
        createButton: /* @__PURE__ */ jsx(Button, { onClick: () => setShowCreate(true), children: "New Catalog Item" })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showCreate,
        onOpenChange: setShowCreate,
        title: "Create Catalog Item",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleCreate, children: "Create" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Title", value: title, onChange: (e) => setTitle(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Subtitle (optional)", value: subtitle, onChange: (e) => setSubtitle(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: description, onChange: (e) => setDescription(e.target.value) })
        ] })
      }
    )
  ] });
}
const DEFAULT_LIST_QUERY = "limit=50&offset=0";
async function loader$1({
  request
}) {
  const api2 = createCatalogServerApiClient(request);
  return api2.listCatalogItems(DEFAULT_LIST_QUERY);
}
const meta$1 = () => [{
  title: "Catalog Items | Catalog Admin"
}];
const catalogItems = UNSAFE_withComponentProps(function CatalogItemsRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(CatalogItemListPage, {
    initialData: data
  });
});
const route13 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: catalogItems,
  loader: loader$1,
  meta: meta$1
}, Symbol.toStringTag, { value: "Module" }));
function getTransitions(status) {
  switch (status) {
    case "draft":
      return [{ label: "Publish", action: "publish", tone: "primary" }];
    case "active":
      return [{ label: "Retire", action: "retire", confirm: true, tone: "danger" }];
    case "retired":
      return [{ label: "Archive", action: "archive", confirm: true, tone: "danger" }];
    default:
      return [];
  }
}
function formatFieldValue(value) {
  if (value === null || value === void 0) {
    return "—";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
function CatalogItemDetailPage({ id, initialData }) {
  const { data, loading, error, refresh } = useCatalogItem(id, initialData);
  const { addToast } = useToasts();
  const [showAssignBlueprint, setShowAssignBlueprint] = useState(false);
  const [blueprintId, setBlueprintId] = useState("");
  const [showSetField, setShowSetField] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [fieldValue, setFieldValue$1] = useState("");
  const [showAssignCategory, setShowAssignCategory] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [showEditMetadata, setShowEditMetadata] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSubtitle, setEditSubtitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [showPublish, setShowPublish] = useState(false);
  const [publishBlueprintActive, setPublishBlueprintActive] = useState(true);
  const [publishRequiredFieldIds, setPublishRequiredFieldIds] = useState("");
  const [showSetTags, setShowSetTags] = useState(false);
  const [tagsInput, setTagsInput] = useState("");
  const [showSetImageUrls, setShowSetImageUrls] = useState(false);
  const [imageUrlsInput, setImageUrlsInput] = useState("");
  async function handleLifecycleAction(action) {
    if (action === "publish") {
      setShowPublish(true);
      return;
    }
    const actions = {
      retire: () => retireCatalogItem(id),
      archive: () => archiveCatalogItem(id)
    };
    await actions[action]?.();
    addToast(`Catalog item ${action}d`, "success");
    refresh();
  }
  async function handlePublish() {
    const requiredIds = publishRequiredFieldIds.split(",").map((s) => s.trim()).filter(Boolean);
    await publishCatalogItem(id, publishBlueprintActive, requiredIds);
    addToast("Catalog item published", "success");
    setShowPublish(false);
    refresh();
  }
  async function handleAssignBlueprint() {
    await assignBlueprint(id, blueprintId);
    addToast("Blueprint assigned", "success");
    setShowAssignBlueprint(false);
    setBlueprintId("");
    refresh();
  }
  async function handleSetFieldValue() {
    await setFieldValue(id, fieldId, fieldValue);
    addToast("Field value set", "success");
    setShowSetField(false);
    setFieldId("");
    setFieldValue$1("");
    refresh();
  }
  async function handleClearFieldValue(fId) {
    await clearFieldValue(id, fId);
    addToast("Field value cleared", "success");
    refresh();
  }
  async function handleAssignCategory() {
    await assignCategory(id, categoryId);
    addToast("Category assigned", "success");
    setShowAssignCategory(false);
    setCategoryId("");
    refresh();
  }
  async function handleRemoveCategory(catId) {
    await removeCategory(id, catId);
    addToast("Category removed", "success");
    refresh();
  }
  async function handleReviseMetadata() {
    await reviseMetadata(id, {
      title: editTitle,
      subtitle: editSubtitle || null,
      description: editDescription || void 0
    });
    addToast("Metadata revised", "success");
    setShowEditMetadata(false);
    refresh();
  }
  function startEditMetadata() {
    if (data) {
      setEditTitle(data.title);
      setEditSubtitle(data.subtitle ?? "");
      setEditDescription(data.description ?? "");
      setShowEditMetadata(true);
    }
  }
  async function handleSetTags() {
    const tags = tagsInput.split(",").map((s) => s.trim()).filter(Boolean);
    await setTags(id, tags);
    addToast("Tags updated", "success");
    setShowSetTags(false);
    refresh();
  }
  function startSetTags() {
    if (data) {
      setTagsInput((data.tags ?? []).join(", "));
      setShowSetTags(true);
    }
  }
  async function handleSetImageUrls() {
    const urls = imageUrlsInput.split("\n").map((s) => s.trim()).filter(Boolean);
    await setImageUrls(id, urls);
    addToast("Image URLs updated", "success");
    setShowSetImageUrls(false);
    refresh();
  }
  function startSetImageUrls() {
    if (data) {
      setImageUrlsInput((data.image_urls ?? []).join("\n"));
      setShowSetImageUrls(true);
    }
  }
  const fieldValues = data?.field_values ?? [];
  const categories2 = data?.categories ?? [];
  const fieldValueColumns = [
    { key: "fieldId", header: "Field", cell: (row) => row.fieldName },
    { key: "value", header: "Value", cell: (row) => formatFieldValue(row.value) },
    {
      key: "actions",
      header: "",
      cell: (row) => data?.status !== "archived" ? /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => handleClearFieldValue(row.fieldId), children: "Clear" }) : null
    }
  ];
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      EntityDetailPage,
      {
        title: data?.title ?? "Catalog Item",
        breadcrumbs: [
          { label: "Catalog Items", href: "/catalog-items" },
          { label: data?.title ?? id }
        ],
        actions: data ? /* @__PURE__ */ jsxs(Inline, { gap: 2, children: [
          /* @__PURE__ */ jsx(
            LifecycleControls,
            {
              status: data.status,
              transitions: getTransitions(data.status),
              onAction: handleLifecycleAction
            }
          ),
          data.status !== "archived" && /* @__PURE__ */ jsx(Button, { tone: "secondary", size: "sm", onClick: startEditMetadata, children: "Edit Metadata" })
        ] }) : void 0,
        loading,
        notFound: !loading && !data,
        error,
        children: data && /* @__PURE__ */ jsxs(Stack, { gap: 6, children: [
          /* @__PURE__ */ jsx(
            KeyValueList,
            {
              items: [
                { key: "Title", value: data.title },
                { key: "Subtitle", value: data.subtitle ?? "—" },
                { key: "Description", value: data.description ?? "—" },
                { key: "Blueprint", value: data.blueprint?.name ?? "None" },
                { key: "Status", value: data.status },
                { key: "Updated", value: data.updated_at }
              ]
            }
          ),
          data.status === "draft" && !data.blueprint && /* @__PURE__ */ jsx(PageSection, { title: "Blueprint", children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowAssignBlueprint(true), children: "Assign Blueprint" }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Field Values", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status !== "archived" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowSetField(true), children: "Set Field Value" }) }),
            /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: fieldValues,
                columns: fieldValueColumns,
                getRowId: (row) => row.fieldId,
                emptyTitle: "No field values"
              }
            )
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Categories", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status !== "archived" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: () => setShowAssignCategory(true), children: "Assign Category" }) }),
            categories2.length === 0 ? /* @__PURE__ */ jsx(Text, { tone: "secondary", children: "No categories assigned." }) : /* @__PURE__ */ jsx(
              DataTable,
              {
                rows: categories2,
                columns: [
                  { key: "categoryId", header: "Category", cell: (row) => row.name },
                  {
                    key: "actions",
                    header: "",
                    cell: (row) => data.status !== "archived" ? /* @__PURE__ */ jsx(Button, { size: "sm", tone: "danger", onClick: () => handleRemoveCategory(row.categoryId), children: "Remove" }) : null
                  }
                ],
                getRowId: (row) => row.categoryId
              }
            )
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Tags", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status !== "archived" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: startSetTags, children: "Set Tags" }) }),
            (data.tags ?? []).length === 0 ? /* @__PURE__ */ jsx(Text, { tone: "secondary", children: "No tags." }) : /* @__PURE__ */ jsx(Text, { children: (data.tags ?? []).join(", ") })
          ] }) }),
          /* @__PURE__ */ jsx(PageSection, { title: "Image URLs", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
            data.status !== "archived" && /* @__PURE__ */ jsx(Inline, { children: /* @__PURE__ */ jsx(Button, { size: "sm", onClick: startSetImageUrls, children: "Set Image URLs" }) }),
            (data.image_urls ?? []).length === 0 ? /* @__PURE__ */ jsx(Text, { tone: "secondary", children: "No image URLs." }) : /* @__PURE__ */ jsx(Stack, { gap: 1, children: (data.image_urls ?? []).map((url, i) => /* @__PURE__ */ jsx(Text, { children: url }, i)) })
          ] }) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showAssignBlueprint,
        onOpenChange: setShowAssignBlueprint,
        title: "Assign Blueprint",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleAssignBlueprint, children: "Assign" }),
        children: /* @__PURE__ */ jsx(TextInput, { label: "Blueprint ID", value: blueprintId, onChange: (e) => setBlueprintId(e.target.value) })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showSetField,
        onOpenChange: setShowSetField,
        title: "Set Field Value",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleSetFieldValue, children: "Set" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Field ID", value: fieldId, onChange: (e) => setFieldId(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Value", value: fieldValue, onChange: (e) => setFieldValue$1(e.target.value) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showAssignCategory,
        onOpenChange: setShowAssignCategory,
        title: "Assign Category",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleAssignCategory, children: "Assign" }),
        children: /* @__PURE__ */ jsx(TextInput, { label: "Category ID", value: categoryId, onChange: (e) => setCategoryId(e.target.value) })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showEditMetadata,
        onOpenChange: setShowEditMetadata,
        title: "Edit Metadata",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleReviseMetadata, children: "Save" }),
        children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
          /* @__PURE__ */ jsx(TextInput, { label: "Title", value: editTitle, onChange: (e) => setEditTitle(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Subtitle", value: editSubtitle, onChange: (e) => setEditSubtitle(e.target.value) }),
          /* @__PURE__ */ jsx(TextInput, { label: "Description", value: editDescription, onChange: (e) => setEditDescription(e.target.value) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showPublish,
        onOpenChange: setShowPublish,
        title: "Publish Catalog Item",
        description: "Confirm that the blueprint is active and provide required field IDs.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handlePublish, children: "Publish" }),
        children: /* @__PURE__ */ jsx(Stack, { gap: 3, children: /* @__PURE__ */ jsx(
          TextInput,
          {
            label: "Required Field IDs (comma-separated)",
            value: publishRequiredFieldIds,
            onChange: (e) => setPublishRequiredFieldIds(e.target.value)
          }
        ) })
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showSetTags,
        onOpenChange: setShowSetTags,
        title: "Set Tags",
        description: "Enter tags separated by commas.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleSetTags, children: "Save" }),
        children: /* @__PURE__ */ jsx(
          TextInput,
          {
            label: "Tags",
            value: tagsInput,
            onChange: (e) => setTagsInput(e.target.value)
          }
        )
      }
    ),
    /* @__PURE__ */ jsx(
      Dialog,
      {
        open: showSetImageUrls,
        onOpenChange: setShowSetImageUrls,
        title: "Set Image URLs",
        description: "Enter one URL per line.",
        footer: /* @__PURE__ */ jsx(Button, { onClick: handleSetImageUrls, children: "Save" }),
        children: /* @__PURE__ */ jsx(
          TextInput,
          {
            label: "Image URLs",
            value: imageUrlsInput,
            onChange: (e) => setImageUrlsInput(e.target.value)
          }
        )
      }
    )
  ] });
}
async function loader({
  request,
  params
}) {
  const api2 = createCatalogServerApiClient(request);
  const id = params.id ?? "";
  try {
    const data = await api2.getCatalogItem(id);
    return {
      id,
      data
    };
  } catch {
    return {
      id,
      data: null
    };
  }
}
const meta = ({
  data
}) => [{
  title: data?.data ? `${data.data.title} | Catalog Admin` : "Catalog Item | Catalog Admin"
}];
const catalogItemsDetail = UNSAFE_withComponentProps(function CatalogItemDetailRoute() {
  const {
    id,
    data
  } = useLoaderData();
  return /* @__PURE__ */ jsx(CatalogItemDetailPage, {
    id,
    initialData: data
  });
});
const route14 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: catalogItemsDetail,
  loader,
  meta
}, Symbol.toStringTag, { value: "Module" }));
const serverManifest = { "entry": { "module": "/assets/entry.client-Dp5q-T93.js", "imports": ["/assets/jsx-runtime-u17CrQMm.js", "/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/index-Hv0LzdIV.js"], "css": [] }, "routes": { "root": { "id": "root", "parentId": void 0, "path": "", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": true, "module": "/assets/root-CLtp7Cs9.js", "imports": ["/assets/jsx-runtime-u17CrQMm.js", "/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/index-Hv0LzdIV.js"], "css": ["/assets/root-JGl4DbdI.css"], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/layout": { "id": "routes/layout", "parentId": "root", "path": void 0, "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/layout-qspgt6I1.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/toasts-BPRCIIqg.js", "/assets/typography-BWoRgCGY.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/index": { "id": "routes/index", "parentId": "routes/layout", "path": void 0, "index": true, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/index-DmSiIAXa.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/dimensions": { "id": "routes/dimensions", "parentId": "routes/layout", "path": "dimensions", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/dimensions-pIAV7Xj3.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/entity-list-page-Bg7JjaQg.js", "/assets/use-dimensions-B3IqerW4.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/dimensions-detail": { "id": "routes/dimensions-detail", "parentId": "routes/layout", "path": "dimensions/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/dimensions-detail-DJg91rfM.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/lifecycle-controls-C3S48sY3.js", "/assets/use-dimensions-B3IqerW4.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/fields": { "id": "routes/fields", "parentId": "routes/layout", "path": "fields", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/fields-DV-0x85t.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/entity-list-page-Bg7JjaQg.js", "/assets/use-fields-BtRHSyCx.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/fields-detail": { "id": "routes/fields-detail", "parentId": "routes/layout", "path": "fields/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/fields-detail-2HwxTbjO.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/lifecycle-controls-C3S48sY3.js", "/assets/use-fields-BtRHSyCx.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/components": { "id": "routes/components", "parentId": "routes/layout", "path": "components", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/components-CKuza_dC.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/entity-list-page-Bg7JjaQg.js", "/assets/use-components-D7qb2--U.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/components-detail": { "id": "routes/components-detail", "parentId": "routes/layout", "path": "components/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/components-detail-C83jzbvw.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/lifecycle-controls-C3S48sY3.js", "/assets/use-components-D7qb2--U.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/blueprints": { "id": "routes/blueprints", "parentId": "routes/layout", "path": "blueprints", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/blueprints-2UKV-UtB.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/entity-list-page-Bg7JjaQg.js", "/assets/use-blueprints-C9ERhg6C.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/blueprints-detail": { "id": "routes/blueprints-detail", "parentId": "routes/layout", "path": "blueprints/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/blueprints-detail-D-Dw6EXC.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/typography-BWoRgCGY.js", "/assets/lifecycle-controls-C3S48sY3.js", "/assets/use-blueprints-C9ERhg6C.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/categories": { "id": "routes/categories", "parentId": "routes/layout", "path": "categories", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/categories-C0qO4k1Y.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/entity-list-page-Bg7JjaQg.js", "/assets/use-categories-DCbzMOJG.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/categories-detail": { "id": "routes/categories-detail", "parentId": "routes/layout", "path": "categories/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/categories-detail-Wf7wmQkU.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/lifecycle-controls-C3S48sY3.js", "/assets/use-categories-DCbzMOJG.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/catalog-items": { "id": "routes/catalog-items", "parentId": "routes/layout", "path": "catalog-items", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/catalog-items-DHtwPYwa.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/typed-ids-j-n9jrPc.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/entity-list-page-Bg7JjaQg.js", "/assets/use-catalog-items-W_ZWwVTC.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/catalog-items-detail": { "id": "routes/catalog-items-detail", "parentId": "routes/layout", "path": "catalog-items/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/catalog-items-detail-EcE2VYXN.js", "imports": ["/assets/chunk-UVKPFVEO-Ds7znI4H.js", "/assets/jsx-runtime-u17CrQMm.js", "/assets/toasts-BPRCIIqg.js", "/assets/use-fetch-D23a0TNW.js", "/assets/typography-BWoRgCGY.js", "/assets/lifecycle-controls-C3S48sY3.js", "/assets/use-catalog-items-W_ZWwVTC.js", "/assets/index-Hv0LzdIV.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 } }, "url": "/assets/manifest-e70e837e.js", "version": "e70e837e", "sri": void 0 };
const assetsBuildDirectory = "build\\client";
const basename = "/";
const future = { "unstable_optimizeDeps": false, "unstable_passThroughRequests": false, "unstable_subResourceIntegrity": false, "unstable_trailingSlashAwareDataRequests": false, "unstable_previewServerPrerendering": false, "v8_middleware": false, "v8_splitRouteModules": false, "v8_viteEnvironmentApi": false };
const ssr = true;
const isSpaMode = false;
const prerender = [];
const routeDiscovery = { "mode": "lazy", "manifestPath": "/__manifest" };
const publicPath = "/";
const entry = { module: entryServer };
const routes = {
  "root": {
    id: "root",
    parentId: void 0,
    path: "",
    index: void 0,
    caseSensitive: void 0,
    module: route0
  },
  "routes/layout": {
    id: "routes/layout",
    parentId: "root",
    path: void 0,
    index: void 0,
    caseSensitive: void 0,
    module: route1
  },
  "routes/index": {
    id: "routes/index",
    parentId: "routes/layout",
    path: void 0,
    index: true,
    caseSensitive: void 0,
    module: route2
  },
  "routes/dimensions": {
    id: "routes/dimensions",
    parentId: "routes/layout",
    path: "dimensions",
    index: void 0,
    caseSensitive: void 0,
    module: route3
  },
  "routes/dimensions-detail": {
    id: "routes/dimensions-detail",
    parentId: "routes/layout",
    path: "dimensions/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route4
  },
  "routes/fields": {
    id: "routes/fields",
    parentId: "routes/layout",
    path: "fields",
    index: void 0,
    caseSensitive: void 0,
    module: route5
  },
  "routes/fields-detail": {
    id: "routes/fields-detail",
    parentId: "routes/layout",
    path: "fields/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route6
  },
  "routes/components": {
    id: "routes/components",
    parentId: "routes/layout",
    path: "components",
    index: void 0,
    caseSensitive: void 0,
    module: route7
  },
  "routes/components-detail": {
    id: "routes/components-detail",
    parentId: "routes/layout",
    path: "components/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route8
  },
  "routes/blueprints": {
    id: "routes/blueprints",
    parentId: "routes/layout",
    path: "blueprints",
    index: void 0,
    caseSensitive: void 0,
    module: route9
  },
  "routes/blueprints-detail": {
    id: "routes/blueprints-detail",
    parentId: "routes/layout",
    path: "blueprints/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route10
  },
  "routes/categories": {
    id: "routes/categories",
    parentId: "routes/layout",
    path: "categories",
    index: void 0,
    caseSensitive: void 0,
    module: route11
  },
  "routes/categories-detail": {
    id: "routes/categories-detail",
    parentId: "routes/layout",
    path: "categories/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route12
  },
  "routes/catalog-items": {
    id: "routes/catalog-items",
    parentId: "routes/layout",
    path: "catalog-items",
    index: void 0,
    caseSensitive: void 0,
    module: route13
  },
  "routes/catalog-items-detail": {
    id: "routes/catalog-items-detail",
    parentId: "routes/layout",
    path: "catalog-items/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route14
  }
};
const allowedActionOrigins = false;
export {
  allowedActionOrigins,
  serverManifest as assets,
  assetsBuildDirectory,
  basename,
  entry,
  future,
  isSpaMode,
  prerender,
  publicPath,
  routeDiscovery,
  routes,
  ssr
};
