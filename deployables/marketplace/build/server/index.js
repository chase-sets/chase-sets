import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter, UNSAFE_withComponentProps, Outlet, UNSAFE_withErrorBoundaryProps, useRouteError, isRouteErrorResponse, Links, Scripts, useLoaderData, useLocation, Meta, ScrollRestoration, Link, useNavigation, useSearchParams } from "react-router";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { createContext, useContext, useState, useSyncExternalStore, useMemo, forwardRef, useId, Children, useEffect } from "react";
import { MotionConfig, motion, LayoutGroup } from "motion/react";
import "react-dom";
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
function loader$2({
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
        children: "Marketplace Error"
      }), /* @__PURE__ */ jsx(Links, {})]
    }), /* @__PURE__ */ jsxs("body", {
      children: [/* @__PURE__ */ jsxs("main", {
        children: [/* @__PURE__ */ jsx("h1", {
          children: "Marketplace Error"
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
  loader: loader$2
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
    /* @__PURE__ */ jsx("span", { className: cx(orientation === "rail"), children: item.label }),
    item.badge ? /* @__PURE__ */ jsx("span", { className: "rounded-full bg-background px-2 py-0.5 text-[0.7rem] font-semibold text-secondary", children: item.badge }) : null
  ] });
  const className = cx(
    "focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition",
    orientation === "vertical",
    orientation === "rail",
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
forwardRef(
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
function SegmentedControl({
  items,
  value,
  onValueChange,
  ...rest
}) {
  const groupId = useId();
  function handleKeyDown(event, index) {
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % items.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next >= 0) {
      event.preventDefault();
      onValueChange?.(items[next].value);
      const container = event.currentTarget.parentElement;
      const buttons = container?.querySelectorAll('[role="tab"]');
      buttons?.[next]?.focus();
    }
  }
  return /* @__PURE__ */ jsx(LayoutGroup, { id: groupId, children: /* @__PURE__ */ jsx(
    "div",
    {
      ...rest,
      role: "tablist",
      className: "inline-flex flex-wrap rounded-tokenLg border border-muted bg-background p-1",
      children: items.map((item, index) => {
        const active = item.value === value;
        return /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": active,
            tabIndex: active ? 0 : -1,
            className: cx(
              "focus-ring relative inline-flex min-h-10 items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-semibold transition",
              active ? "text-accent" : "text-secondary hover:text-foreground"
            ),
            onClick: () => onValueChange?.(item.value),
            onKeyDown: (event) => handleKeyDown(event, index),
            children: [
              active ? renderActivePill(groupId, "accent") : null,
              item.icon ? /* @__PURE__ */ jsx(Icon, { name: item.icon, size: "sm" }) : null,
              /* @__PURE__ */ jsx("span", { className: "relative z-10", children: item.label })
            ]
          },
          item.value
        );
      })
    }
  ) });
}
function Breadcrumbs({
  items,
  ariaLabel = "Breadcrumb",
  ...rest
}) {
  return /* @__PURE__ */ jsx("nav", { ...rest, "aria-label": ariaLabel, children: /* @__PURE__ */ jsx("ol", { className: "flex flex-wrap items-center gap-2 text-sm text-secondary", children: items.map((item, index) => {
    const isCurrent = index === items.length - 1;
    return /* @__PURE__ */ jsxs("li", { className: "inline-flex items-center gap-2", children: [
      item.href && !isCurrent ? /* @__PURE__ */ jsx("a", { href: item.href, className: "focus-ring rounded-tokenSm hover:text-foreground", children: item.label }) : /* @__PURE__ */ jsx("span", { className: isCurrent ? "font-semibold text-foreground" : void 0, children: item.label }),
      !isCurrent ? /* @__PURE__ */ jsx(Icon, { name: "chevronRight", size: "sm", tone: "secondary" }) : null
    ] }, `${item.label}-${index}`);
  }) }) });
}
function buildPageRange(page, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = [1];
  if (page > 3) {
    pages.push("ellipsis-start");
  }
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  if (page < totalPages - 2) {
    pages.push("ellipsis-end");
  }
  pages.push(totalPages);
  return pages;
}
function Pagination({
  page,
  totalPages,
  onPageChange,
  previousLabel = "Previous page",
  nextLabel = "Next page",
  ...rest
}) {
  const pages = buildPageRange(page, totalPages);
  return /* @__PURE__ */ jsxs("nav", { ...rest, "aria-label": "Pagination", className: "flex items-center gap-2", children: [
    /* @__PURE__ */ jsx(
      IconButton,
      {
        label: previousLabel,
        icon: "chevronLeft",
        tone: "secondary",
        disabled: page <= 1,
        onClick: () => onPageChange?.(Math.max(1, page - 1))
      }
    ),
    /* @__PURE__ */ jsx("div", { className: "flex flex-wrap gap-2", children: pages.map((value) => {
      if (typeof value === "string") {
        return /* @__PURE__ */ jsx(
          "span",
          {
            className: "inline-flex min-h-10 min-w-10 items-center justify-center text-sm text-secondary",
            "aria-hidden": "true",
            children: "…"
          },
          value
        );
      }
      return /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          "aria-current": value === page ? "page" : void 0,
          className: cx(
            "focus-ring inline-flex min-h-10 min-w-10 items-center justify-center rounded-tokenMd border px-3 text-sm font-semibold transition",
            value === page ? "border-accent bg-accent text-accent-contrast" : "border-muted bg-elevated text-secondary hover:text-foreground"
          ),
          onClick: () => onPageChange?.(value),
          children: value
        },
        value
      );
    }) }),
    /* @__PURE__ */ jsx(
      IconButton,
      {
        label: nextLabel,
        icon: "chevronRight",
        tone: "secondary",
        disabled: page >= totalPages,
        onClick: () => onPageChange?.(Math.min(totalPages, page + 1))
      }
    )
  ] });
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
function KeyValueList({
  items,
  ...rest
}) {
  return /* @__PURE__ */ jsx(
    "dl",
    {
      ...rest,
      className: "modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm",
      children: items.map((item, index) => /* @__PURE__ */ jsxs(
        "div",
        {
          className: "flex items-start justify-between gap-4 border-b border-muted pb-3 last:border-b-0 last:pb-0",
          children: [
            /* @__PURE__ */ jsx("dt", { className: "text-xs font-semibold uppercase tracking-wide text-secondary", children: item.key }),
            /* @__PURE__ */ jsx("dd", { className: "text-sm text-foreground", children: item.value })
          ]
        },
        index
      ))
    }
  );
}
function Card({
  children,
  media,
  interactive = false,
  ...rest
}) {
  const motionSettings = useChaseMotion();
  const interactiveMotion = interactive && !motionSettings.reducedMotion ? {
    whileHover: { y: motionSettings.interactiveLift, scale: motionSettings.interactiveScale },
    whileTap: { y: 0, scale: 0.99 },
    transition: { duration: motionSettings.durations.base, ease: motionSettings.easing }
  } : void 0;
  const nativeProps = rest;
  return /* @__PURE__ */ jsx(
    motion.div,
    {
      ...nativeProps,
      ...interactiveMotion,
      className: cx(
        "modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm",
        interactive && "cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
        !media && "p-4"
      ),
      children: media ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("div", { children: media }),
        /* @__PURE__ */ jsx("div", { className: "p-4", children })
      ] }) : children
    }
  );
}
function DetailPanel({
  title,
  actions,
  children,
  ...rest
}) {
  return /* @__PURE__ */ jsxs(Card, { ...rest, children: [
    /* @__PURE__ */ jsxs("div", { className: "mb-4 flex flex-wrap items-center justify-between gap-3", children: [
      /* @__PURE__ */ jsx("div", { className: "font-heading text-lg font-semibold text-foreground", children: title }),
      actions ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap gap-2", children: actions }) : null
    ] }),
    children != null ? /* @__PURE__ */ jsx("div", { className: "space-y-4", children }) : null
  ] });
}
function FilterBar({
  children,
  actions,
  stickyOffset,
  ...rest
}) {
  const motionSettings = useChaseMotion();
  const nativeProps = rest;
  return /* @__PURE__ */ jsxs(
    motion.div,
    {
      ...nativeProps,
      initial: motionSettings.reducedMotion ? false : { opacity: 0, y: 10 },
      animate: motionSettings.reducedMotion ? void 0 : { opacity: 1, y: 0 },
      transition: motionSettings.reducedMotion ? void 0 : { duration: motionSettings.durations.base, ease: motionSettings.easing },
      style: stickyOffset ? { top: stickyOffset } : void 0,
      className: cx(
        "modern-surface sticky z-sticky flex flex-col gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm md:flex-row md:items-center md:justify-between",
        !stickyOffset && "top-16"
      ),
      children: [
        /* @__PURE__ */ jsx("div", { className: "flex flex-1 flex-wrap gap-3", children }),
        actions ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap gap-2", children: actions }) : null
      ]
    }
  );
}
function ImageGallery({
  images,
  aspectRatio = "3/4",
  ...rest
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = images[activeIndex];
  if (images.length === 0) return null;
  return /* @__PURE__ */ jsxs("div", { ...rest, className: "space-y-3", children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        className: "modern-surface overflow-hidden rounded-tokenLg border border-muted",
        style: { aspectRatio },
        children: active ? /* @__PURE__ */ jsx(
          "img",
          {
            src: active.src,
            alt: active.alt,
            className: "h-full w-full object-contain"
          }
        ) : null
      }
    ),
    images.length > 1 ? /* @__PURE__ */ jsx("div", { className: "flex gap-2 overflow-x-auto", children: images.map((image, index) => /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => setActiveIndex(index),
        className: cx(
          "focus-ring h-16 w-16 shrink-0 overflow-hidden rounded-tokenMd border transition",
          index === activeIndex ? "border-accent shadow-tokenSm" : "border-muted hover:border-accent"
        ),
        children: /* @__PURE__ */ jsx(
          "img",
          {
            src: image.src,
            alt: image.alt,
            className: "h-full w-full object-cover"
          }
        )
      },
      index
    )) }) : null
  ] });
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
function SearchInput({
  id,
  label = "Search",
  description,
  error,
  required,
  hideLabel,
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
      children: /* @__PURE__ */ jsxs("div", { className: "relative", children: [
        /* @__PURE__ */ jsx("span", { className: "pointer-events-none absolute inset-y-0 left-4 flex items-center", children: /* @__PURE__ */ jsx(Icon, { name: "search", size: "sm", tone: "secondary" }) }),
        /* @__PURE__ */ jsx(
          "input",
          {
            ...rest,
            id: inputId,
            required,
            type: "search",
            className: cx(controlClass, "pl-10")
          }
        )
      ] })
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
function Reveal({
  preset = "fade",
  delayMs = 0,
  layout: layout2 = false,
  children
}) {
  const motionSettings = useChaseMotion();
  const definition = motionSettings.presets[preset];
  return /* @__PURE__ */ jsx(
    motion.div,
    {
      layout: layout2,
      initial: definition.initial,
      animate: definition.animate,
      exit: definition.exit,
      transition: {
        ...definition.transition,
        delay: motionSettings.reducedMotion ? 0 : delayMs / 1e3
      },
      children
    }
  );
}
function Stagger({
  preset = "lift",
  staggerMs = 70,
  children
}) {
  const motionSettings = useChaseMotion();
  const nodes = Children.toArray(children);
  const staggerDelay = motionSettings.reducedMotion ? 0 : staggerMs / 1e3;
  return /* @__PURE__ */ jsx(
    motion.div,
    {
      initial: "hidden",
      animate: "visible",
      variants: {
        hidden: {},
        visible: {
          transition: {
            staggerChildren: staggerDelay,
            delayChildren: 0
          }
        }
      },
      children: nodes.map((child, index) => {
        const definition = motionSettings.presets[preset];
        return /* @__PURE__ */ jsx(
          motion.div,
          {
            variants: {
              hidden: definition.initial,
              visible: {
                ...definition.animate,
                transition: definition.transition
              }
            },
            children: child
          },
          child?.key ?? index
        );
      })
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
function MarketplaceShell({
  brand,
  topNavItems,
  bottomNavItems,
  activeKey,
  actions,
  hero,
  sidebar,
  children,
  width = "full"
}) {
  const content = /* @__PURE__ */ jsx("div", { className: "space-y-6", children });
  return /* @__PURE__ */ jsxs("div", { className: "min-h-screen bg-background", children: [
    /* @__PURE__ */ jsx(SkipLink, {}),
    /* @__PURE__ */ jsx(
      TopNav,
      {
        brand,
        items: topNavItems,
        activeKey,
        actions,
        width
      }
    ),
    /* @__PURE__ */ jsx("main", { id: "main-content", children: /* @__PURE__ */ jsxs(Page, { width, children: [
      hero,
      sidebar ? /* @__PURE__ */ jsxs("div", { className: "grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]", children: [
        /* @__PURE__ */ jsx("div", { className: "hidden lg:block", children: sidebar }),
        content
      ] }) : content
    ] }) }),
    /* @__PURE__ */ jsx(BottomNav, { items: bottomNavItems, activeKey, width })
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
const marketplaceTopNavItems = [
  { key: "search", label: "Browse", icon: "search", href: "/search" }
];
const marketplaceBottomNavItems = [
  { key: "search", label: "Browse", icon: "search", href: "/search" }
];
function DiscoveryShellLayout({
  activeKey = "search",
  children
}) {
  const [colorMode] = useState("system");
  return /* @__PURE__ */ jsx(ChaseRoot, { colorMode, children: /* @__PURE__ */ jsx(
    MarketplaceShell,
    {
      brand: /* @__PURE__ */ jsx(Text, { weight: "semibold", children: "Marketplace" }),
      topNavItems: marketplaceTopNavItems,
      bottomNavItems: marketplaceBottomNavItems,
      activeKey,
      children
    }
  ) });
}
const layout = UNSAFE_withComponentProps(function MarketplaceLayoutRoute() {
  return /* @__PURE__ */ jsx(DiscoveryShellLayout, {
    activeKey: "search",
    children: /* @__PURE__ */ jsx(Outlet, {})
  });
});
const route1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: layout
}, Symbol.toStringTag, { value: "Module" }));
function ItemCard({
  item,
  href
}) {
  return /* @__PURE__ */ jsx(Link, { to: href, className: "block", children: /* @__PURE__ */ jsx(
    Card,
    {
      interactive: true,
      media: item.image_urls.length > 0 ? /* @__PURE__ */ jsx(
        "img",
        {
          src: item.image_urls[0],
          alt: item.title,
          className: "h-48 w-full object-cover"
        }
      ) : /* @__PURE__ */ jsx("div", { className: "flex h-48 w-full items-center justify-center bg-background", children: /* @__PURE__ */ jsx(Icon, { name: "package", size: "lg", tone: "secondary" }) }),
      children: /* @__PURE__ */ jsxs(Stack, { gap: 2, children: [
        /* @__PURE__ */ jsx(Text, { weight: "semibold", children: item.title }),
        item.subtitle && /* @__PURE__ */ jsx(Text, { tone: "secondary", size: "sm", children: item.subtitle }),
        item.blueprint_name && /* @__PURE__ */ jsx(Text, { size: "sm", tone: "secondary", children: item.blueprint_name }),
        item.category_names.length > 0 && /* @__PURE__ */ jsx(Inline, { gap: 1, children: item.category_names.map((name) => /* @__PURE__ */ jsx(Badge, { tone: "accent", children: name }, name)) }),
        item.tags.length > 0 && /* @__PURE__ */ jsx(Inline, { gap: 1, children: item.tags.slice(0, 3).map((tag) => /* @__PURE__ */ jsx(Badge, { tone: "neutral", children: tag }, tag)) })
      ] })
    }
  ) });
}
function SearchFilters({
  categories,
  selectedCategory,
  onCategoryChange
}) {
  return /* @__PURE__ */ jsxs(Stack, { gap: 4, children: [
    /* @__PURE__ */ jsx(Text, { weight: "semibold", size: "sm", children: "Categories" }),
    /* @__PURE__ */ jsxs(Stack, { gap: 1, children: [
      /* @__PURE__ */ jsx(
        Button,
        {
          tone: !selectedCategory ? "primary" : "ghost",
          size: "sm",
          onClick: () => onCategoryChange(""),
          block: true,
          children: "All Categories"
        }
      ),
      categories.map((category) => /* @__PURE__ */ jsxs(
        Button,
        {
          tone: selectedCategory === category.name ? "primary" : "ghost",
          size: "sm",
          onClick: () => onCategoryChange(category.name),
          block: true,
          children: [
            category.name,
            " (",
            category.item_count,
            ")"
          ]
        },
        category.category_id
      ))
    ] })
  ] });
}
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
const PAGE_SIZE$1 = 24;
const sortOptions = [
  { label: "Relevance", value: "relevance" },
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
  { label: "Newest", value: "newest" }
];
function SearchPage({
  search: search2,
  category,
  sort,
  page,
  data,
  categories,
  loading = false,
  error = null,
  onSearchChange,
  onCategoryChange,
  onSortChange,
  onPageChange
}) {
  const [searchInput, setSearchInput] = useState(search2);
  const debouncedSearch = useDebounce(searchInput, 300);
  useEffect(() => {
    setSearchInput(search2);
  }, [search2]);
  useEffect(() => {
    if (debouncedSearch !== search2) {
      onSearchChange(debouncedSearch);
    }
  }, [debouncedSearch, onSearchChange, search2]);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE$1) : 0;
  return /* @__PURE__ */ jsxs("div", { className: "grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]", children: [
    /* @__PURE__ */ jsx("div", { className: "hidden lg:block", children: /* @__PURE__ */ jsx(
      SearchFilters,
      {
        categories,
        selectedCategory: category,
        onCategoryChange: (name) => {
          onCategoryChange(name);
          onPageChange(1);
        }
      }
    ) }),
    /* @__PURE__ */ jsxs(Stack, { gap: 4, children: [
      /* @__PURE__ */ jsxs(FilterBar, { children: [
        /* @__PURE__ */ jsx(
          SearchInput,
          {
            hideLabel: true,
            placeholder: "Search catalog items...",
            value: searchInput,
            onChange: (e) => setSearchInput(e.target.value)
          }
        ),
        /* @__PURE__ */ jsx(
          Select,
          {
            hideLabel: true,
            label: "Sort",
            items: sortOptions,
            value: sort,
            onValueChange: (value) => {
              onSortChange(value);
              onPageChange(1);
            }
          }
        )
      ] }),
      /* @__PURE__ */ jsxs(Stagger, { children: [
        data ? /* @__PURE__ */ jsxs(Text, { size: "sm", tone: "secondary", children: [
          data.total,
          " ",
          data.total === 1 ? "result" : "results",
          " found"
        ] }) : null,
        error ? /* @__PURE__ */ jsx(Banner, { tone: "danger", title: "Error", description: error }) : null,
        loading && !data ? /* @__PURE__ */ jsx(LoadingSpinner, { label: "Searching..." }) : data && data.items.length === 0 ? /* @__PURE__ */ jsx(
          EmptyState,
          {
            title: "No items found",
            description: search2 || category ? "Try adjusting your search or filters." : "No catalog items are available yet.",
            icon: "search"
          }
        ) : data ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-3", children: data.items.map((item) => /* @__PURE__ */ jsx(Reveal, { preset: "lift", children: /* @__PURE__ */ jsx(ItemCard, { item, href: `/items/${item.item_id}` }) }, item.item_id)) }),
          totalPages > 1 ? /* @__PURE__ */ jsx(Inline, { align: "center", children: /* @__PURE__ */ jsx(
            Pagination,
            {
              page,
              totalPages,
              onPageChange
            }
          ) }) : null
        ] }) : null
      ] })
    ] })
  ] });
}
const DEFAULT_BASE_URL = "/api/marketplace";
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
  const params = new URLSearchParams(query);
  return Object.fromEntries(params.entries());
}
async function parseJsonResponse(response) {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(response.status, errorBody);
  }
  return response.json();
}
function createDiscoveryApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch
} = {}) {
  const client = hc(baseUrl, { fetch });
  return {
    async searchItems(query) {
      const response = await client.items.$get({
        query: queryFromString(query)
      });
      return parseJsonResponse(response);
    },
    async getItemDetail(id) {
      const response = await client.items[":id"].$get({
        param: { id }
      });
      return parseJsonResponse(response);
    },
    async listCategories() {
      const response = await client.categories.$get();
      return parseJsonResponse(response);
    }
  };
}
createDiscoveryApiClient();
function getMarketplaceApiBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.origin}/api/marketplace`;
}
function createMarketplaceServerApiClient(request) {
  return createDiscoveryApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: globalThis.fetch
  });
}
const PAGE_SIZE = 24;
function buildSearchQuery({
  search: search2,
  category,
  sort,
  page
}) {
  const params = new URLSearchParams();
  if (search2) {
    params.set("search", search2);
  }
  if (category) {
    params.set("category", category);
  }
  params.set("sort", sort);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String((page - 1) * PAGE_SIZE));
  return params.toString();
}
async function loader$1({
  request
}) {
  const url = new URL(request.url);
  const search2 = url.searchParams.get("search") ?? "";
  const category = url.searchParams.get("category") ?? "";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const api = createMarketplaceServerApiClient(request);
  const [data, categories] = await Promise.all([api.searchItems(buildSearchQuery({
    search: search2,
    category,
    sort,
    page
  })), api.listCategories()]);
  return {
    search: search2,
    category,
    sort,
    page,
    data,
    categories: categories.items
  };
}
const meta$1 = ({
  data
}) => {
  const title = data?.search ? `Search "${data.search}" | Marketplace` : "Marketplace Search";
  return [{
    title
  }, {
    name: "description",
    content: "Browse the Chase Sets marketplace with server-rendered discovery results and item detail pages."
  }];
};
const search = UNSAFE_withComponentProps(function MarketplaceSearchRoute() {
  const data = useLoaderData();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  function updateSearchParams(nextValues) {
    const next = new URLSearchParams(searchParams);
    if (nextValues.search !== void 0) {
      if (nextValues.search) {
        next.set("search", nextValues.search);
      } else {
        next.delete("search");
      }
      next.delete("page");
    }
    if (nextValues.category !== void 0) {
      if (nextValues.category) {
        next.set("category", nextValues.category);
      } else {
        next.delete("category");
      }
      next.delete("page");
    }
    if (nextValues.sort !== void 0) {
      if (nextValues.sort && nextValues.sort !== "relevance") {
        next.set("sort", nextValues.sort);
      } else {
        next.delete("sort");
      }
      next.delete("page");
    }
    if (nextValues.page !== void 0) {
      if (nextValues.page > 1) {
        next.set("page", String(nextValues.page));
      } else {
        next.delete("page");
      }
    }
    setSearchParams(next, {
      preventScrollReset: true
    });
  }
  return /* @__PURE__ */ jsx(SearchPage, {
    search: data.search,
    category: data.category,
    sort: data.sort,
    page: data.page,
    data: data.data,
    categories: data.categories,
    loading: navigation.state !== "idle",
    onSearchChange: (value) => updateSearchParams({
      search: value
    }),
    onCategoryChange: (value) => updateSearchParams({
      category: value
    }),
    onSortChange: (value) => updateSearchParams({
      sort: value
    }),
    onPageChange: (value) => updateSearchParams({
      page: value
    })
  });
});
const route3 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: search,
  loader: loader$1,
  meta: meta$1
}, Symbol.toStringTag, { value: "Module" }));
const route2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: search,
  loader: loader$1,
  meta: meta$1
}, Symbol.toStringTag, { value: "Module" }));
function VersionSelector({
  schema,
  selections,
  onSelectionChange
}) {
  if (schema.dimensions.length === 0) {
    return null;
  }
  const orderedDimensions = schema.canonicalDimensionOrder.map(
    (order) => schema.dimensions.find((d) => d.dimensionId === order.dimensionId)
  ).filter((d) => d !== void 0);
  return /* @__PURE__ */ jsx(Stack, { gap: 4, children: orderedDimensions.map((dimension) => {
    const selected = selections[dimension.dimensionId] ?? "";
    const choiceLabel = (choice) => {
      if (choice.labels && choice.labels.length > 0) {
        return choice.labels[0].value;
      }
      return choice.code;
    };
    if (dimension.allowedChoices.length <= 5) {
      return /* @__PURE__ */ jsxs(Stack, { gap: 2, children: [
        /* @__PURE__ */ jsx(Text, { size: "sm", weight: "semibold", children: dimension.dimensionName }),
        /* @__PURE__ */ jsx(
          SegmentedControl,
          {
            items: dimension.allowedChoices.map((choice) => ({
              value: choice.choiceId,
              label: choiceLabel(choice)
            })),
            value: selected,
            onValueChange: (value) => onSelectionChange(dimension.dimensionId, value)
          }
        )
      ] }, dimension.dimensionId);
    }
    return /* @__PURE__ */ jsx(
      Select,
      {
        label: dimension.dimensionName,
        items: dimension.allowedChoices.map((choice) => ({
          value: choice.choiceId,
          label: choiceLabel(choice)
        })),
        value: selected,
        onValueChange: (value) => onSelectionChange(dimension.dimensionId, value)
      },
      dimension.dimensionId
    );
  }) });
}
function formatFieldValue(value) {
  if (value === null || value === void 0) {
    return "-";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
function ItemDetailPage({
  data,
  notFound = false,
  error = null
}) {
  const [selections, setSelections] = useState({});
  useEffect(() => {
    if (!data?.version_schema) {
      setSelections({});
      return;
    }
    const initial = {};
    for (const dim of data.version_schema.dimensions) {
      if (dim.allowedChoices.length > 0) {
        initial[dim.dimensionId] = dim.allowedChoices[0].choiceId;
      }
    }
    setSelections(initial);
  }, [data]);
  if (error) {
    return /* @__PURE__ */ jsx(Banner, { tone: "danger", title: "Error", description: error });
  }
  if (!data) {
    return /* @__PURE__ */ jsx(
      Banner,
      {
        tone: "danger",
        title: notFound ? "Not found" : "Error",
        description: notFound ? "This item could not be found." : "This item is not available right now."
      }
    );
  }
  const images = data.image_urls.map((url, index) => ({
    src: url,
    alt: `${data.title} image ${index + 1}`
  }));
  return /* @__PURE__ */ jsxs(Stagger, { children: [
    /* @__PURE__ */ jsx(
      Breadcrumbs,
      {
        items: [
          { label: "Search", href: "/search" },
          { label: data.title }
        ]
      }
    ),
    /* @__PURE__ */ jsxs("div", { className: "grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]", children: [
      /* @__PURE__ */ jsxs(Stack, { gap: 6, children: [
        /* @__PURE__ */ jsx(Reveal, { preset: "lift", children: images.length > 0 ? /* @__PURE__ */ jsx(ImageGallery, { images }) : /* @__PURE__ */ jsx("div", { className: "flex h-64 items-center justify-center rounded-lg border border-dashed border-muted bg-background", children: /* @__PURE__ */ jsx(Text, { tone: "secondary", children: "No images available" }) }) }),
        /* @__PURE__ */ jsx(Reveal, { preset: "lift", children: /* @__PURE__ */ jsx(PageHeader, { title: data.title, description: data.subtitle }) }),
        data.description ? /* @__PURE__ */ jsx(Reveal, { preset: "lift", children: /* @__PURE__ */ jsx(PageSection, { title: "Description", children: /* @__PURE__ */ jsx(Text, { children: data.description }) }) }) : null,
        data.version_schema && data.version_schema.dimensions.length > 0 ? /* @__PURE__ */ jsx(Reveal, { preset: "lift", children: /* @__PURE__ */ jsx(PageSection, { title: "Version", children: /* @__PURE__ */ jsx(
          VersionSelector,
          {
            schema: data.version_schema,
            selections,
            onSelectionChange: (dimensionId, choiceId) => setSelections((current) => ({
              ...current,
              [dimensionId]: choiceId
            }))
          }
        ) }) }) : null,
        data.field_values.length > 0 ? /* @__PURE__ */ jsx(Reveal, { preset: "lift", children: /* @__PURE__ */ jsx(PageSection, { title: "Details", children: /* @__PURE__ */ jsx(
          KeyValueList,
          {
            items: data.field_values.map((fieldValue) => ({
              key: fieldValue.fieldName,
              value: formatFieldValue(fieldValue.value)
            }))
          }
        ) }) }) : null
      ] }),
      /* @__PURE__ */ jsx(Reveal, { preset: "slideRight", children: /* @__PURE__ */ jsx(DetailPanel, { title: "Info", children: /* @__PURE__ */ jsxs(Stack, { gap: 3, children: [
        data.blueprint ? /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx(Text, { size: "sm", weight: "semibold", children: "Blueprint" }),
          /* @__PURE__ */ jsx(Text, { size: "sm", tone: "secondary", children: data.blueprint.name })
        ] }) : null,
        data.categories.length > 0 ? /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx(Text, { size: "sm", weight: "semibold", children: "Categories" }),
          /* @__PURE__ */ jsx("div", { className: "mt-1 flex flex-wrap gap-1", children: data.categories.map((category) => /* @__PURE__ */ jsx(Badge, { tone: "accent", children: category.name }, category.categoryId)) })
        ] }) : null,
        data.tags.length > 0 ? /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx(Text, { size: "sm", weight: "semibold", children: "Tags" }),
          /* @__PURE__ */ jsx("div", { className: "mt-1 flex flex-wrap gap-1", children: data.tags.map((tag) => /* @__PURE__ */ jsx(Badge, { tone: "neutral", children: tag }, tag)) })
        ] }) : null,
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx(Text, { size: "sm", weight: "semibold", children: "Last Updated" }),
          /* @__PURE__ */ jsx(Text, { size: "sm", tone: "secondary", children: data.updated_at })
        ] })
      ] }) }) })
    ] })
  ] });
}
async function loader({
  request,
  params
}) {
  const api = createMarketplaceServerApiClient(request);
  const id = params.id;
  if (!id) {
    return {
      item: null,
      notFound: true
    };
  }
  try {
    const item = await api.getItemDetail(id);
    return {
      item,
      notFound: false
    };
  } catch (error) {
    return {
      item: null,
      notFound: true,
      error: error instanceof Error ? error.message : "Item not found."
    };
  }
}
const meta = ({
  data
}) => {
  const title = data?.item ? `${data.item.title} | Marketplace` : "Item Not Found | Marketplace";
  const description = data?.item?.description ? data.item.description : "View marketplace item details for Chase Sets.";
  return [{
    title
  }, {
    name: "description",
    content: description
  }];
};
const itemDetail = UNSAFE_withComponentProps(function MarketplaceItemDetailRoute() {
  const data = useLoaderData();
  return /* @__PURE__ */ jsx(ItemDetailPage, {
    data: data.item,
    notFound: data.notFound,
    error: data.error
  });
});
const route4 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: itemDetail,
  loader,
  meta
}, Symbol.toStringTag, { value: "Module" }));
const serverManifest = { "entry": { "module": "/assets/entry.client-jKAUI6P3.js", "imports": ["/assets/chunk-UVKPFVEO-Bs0J-Mw6.js", "/assets/index-D2sef4Hq.js"], "css": [] }, "routes": { "root": { "id": "root", "parentId": void 0, "path": "", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": true, "module": "/assets/root-BISZCv2T.js", "imports": ["/assets/chunk-UVKPFVEO-Bs0J-Mw6.js", "/assets/index-D2sef4Hq.js"], "css": ["/assets/root-JGl4DbdI.css"], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/layout": { "id": "routes/layout", "parentId": "root", "path": void 0, "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": false, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/layout-roHVT1lD.js", "imports": ["/assets/chunk-UVKPFVEO-Bs0J-Mw6.js", "/assets/typography-C7kBLC_U.js", "/assets/app-shells-CW5kNT6C.js", "/assets/index-D2sef4Hq.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/index": { "id": "routes/index", "parentId": "routes/layout", "path": void 0, "index": true, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/index-1UicRyU1.js", "imports": ["/assets/chunk-UVKPFVEO-Bs0J-Mw6.js", "/assets/typography-C7kBLC_U.js", "/assets/primitives-C2W5YPk5.js", "/assets/index-D2sef4Hq.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/search": { "id": "routes/search", "parentId": "routes/layout", "path": "search", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/search-i8Rf0O6u.js", "imports": ["/assets/index-1UicRyU1.js", "/assets/chunk-UVKPFVEO-Bs0J-Mw6.js", "/assets/typography-C7kBLC_U.js", "/assets/index-D2sef4Hq.js", "/assets/primitives-C2W5YPk5.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 }, "routes/item-detail": { "id": "routes/item-detail", "parentId": "routes/layout", "path": "items/:id", "index": void 0, "caseSensitive": void 0, "hasAction": false, "hasLoader": true, "hasClientAction": false, "hasClientLoader": false, "hasClientMiddleware": false, "hasDefaultExport": true, "hasErrorBoundary": false, "module": "/assets/item-detail-Du5xcrIK.js", "imports": ["/assets/chunk-UVKPFVEO-Bs0J-Mw6.js", "/assets/typography-C7kBLC_U.js", "/assets/primitives-C2W5YPk5.js", "/assets/app-shells-CW5kNT6C.js", "/assets/index-D2sef4Hq.js"], "css": [], "clientActionModule": void 0, "clientLoaderModule": void 0, "clientMiddlewareModule": void 0, "hydrateFallbackModule": void 0 } }, "url": "/assets/manifest-1b9859bd.js", "version": "1b9859bd", "sri": void 0 };
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
  "routes/search": {
    id: "routes/search",
    parentId: "routes/layout",
    path: "search",
    index: void 0,
    caseSensitive: void 0,
    module: route3
  },
  "routes/item-detail": {
    id: "routes/item-detail",
    parentId: "routes/layout",
    path: "items/:id",
    index: void 0,
    caseSensitive: void 0,
    module: route4
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
