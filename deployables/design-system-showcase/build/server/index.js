import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, ServerRouter, UNSAFE_withComponentProps, useLocation, useNavigate } from "react-router";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { Children, createContext, forwardRef, useCallback, useContext, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as VisuallyHiddenPrimitive from "@radix-ui/react-visually-hidden";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { createPortal } from "react-dom";
import * as ToastPrimitive from "@radix-ui/react-toast";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as LabelPrimitive from "@radix-ui/react-label";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region ../../node_modules/@react-router/dev/dist/config/defaults/entry.server.node.tsx
var entry_server_node_exports = /* @__PURE__ */ __exportAll({
	default: () => handleRequest,
	streamTimeout: () => streamTimeout
});
var streamTimeout = 5e3;
function handleRequest(request, responseStatusCode, responseHeaders, routerContext, loadContext) {
	if (request.method.toUpperCase() === "HEAD") return new Response(null, {
		status: responseStatusCode,
		headers: responseHeaders
	});
	return new Promise((resolve, reject) => {
		let shellRendered = false;
		let userAgent = request.headers.get("user-agent");
		let readyOption = userAgent && isbot(userAgent) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";
		let timeoutId = setTimeout(() => abort(), streamTimeout + 1e3);
		const { pipe, abort } = renderToPipeableStream(/* @__PURE__ */ jsx(ServerRouter, {
			context: routerContext,
			url: request.url
		}), {
			[readyOption]() {
				shellRendered = true;
				const body = new PassThrough({ final(callback) {
					clearTimeout(timeoutId);
					timeoutId = void 0;
					callback();
				} });
				const stream = createReadableStreamFromReadable(body);
				responseHeaders.set("Content-Type", "text/html");
				pipe(body);
				resolve(new Response(stream, {
					headers: responseHeaders,
					status: responseStatusCode
				}));
			},
			onShellError(error) {
				reject(error);
			},
			onError(error) {
				responseStatusCode = 500;
				if (shellRendered) console.error(error);
			}
		});
	});
}
//#endregion
//#region app/root.tsx
var root_exports = /* @__PURE__ */ __exportAll({
	Layout: () => Layout,
	default: () => root_default
});
function Layout({ children }) {
	return /* @__PURE__ */ jsxs("html", {
		lang: "en",
		children: [/* @__PURE__ */ jsxs("head", { children: [
			/* @__PURE__ */ jsx("meta", { charSet: "utf-8" }),
			/* @__PURE__ */ jsx("meta", {
				name: "viewport",
				content: "width=device-width, initial-scale=1"
			}),
			/* @__PURE__ */ jsx(Meta, {}),
			/* @__PURE__ */ jsx(Links, {})
		] }), /* @__PURE__ */ jsxs("body", { children: [
			children,
			/* @__PURE__ */ jsx(ScrollRestoration, {}),
			/* @__PURE__ */ jsx(Scripts, {})
		] })]
	});
}
var root_default = UNSAFE_withComponentProps(function App() {
	return /* @__PURE__ */ jsx(Outlet, {});
});
//#endregion
//#region ../../packages/design-system/src/utils/cx.ts
function cx(...values) {
	return values.filter(Boolean).join(" ");
}
//#endregion
//#region ../../packages/design-system/src/icons/index.tsx
var sizeClasses = {
	sm: "h-4 w-4",
	md: "h-5 w-5",
	lg: "h-6 w-6"
};
var toneClasses = {
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
		case "search": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("circle", {
			cx: "11",
			cy: "11",
			r: "7"
		}), /* @__PURE__ */ jsx("path", { d: "M20 20l-3.5-3.5" })] });
		case "cart": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("circle", {
				cx: "9",
				cy: "19",
				r: "1.5"
			}),
			/* @__PURE__ */ jsx("circle", {
				cx: "18",
				cy: "19",
				r: "1.5"
			}),
			/* @__PURE__ */ jsx("path", { d: "M3 4h2l2.6 10.5a1 1 0 0 0 1 .8h9.7a1 1 0 0 0 1-.8L21 8H7" })
		] });
		case "filter": return /* @__PURE__ */ jsx("path", { d: "M4 6h16M7 12h10M10 18h4" });
		case "dashboard": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("rect", {
				x: "4",
				y: "4",
				width: "7",
				height: "7",
				rx: "1"
			}),
			/* @__PURE__ */ jsx("rect", {
				x: "13",
				y: "4",
				width: "7",
				height: "5",
				rx: "1"
			}),
			/* @__PURE__ */ jsx("rect", {
				x: "13",
				y: "11",
				width: "7",
				height: "9",
				rx: "1"
			}),
			/* @__PURE__ */ jsx("rect", {
				x: "4",
				y: "13",
				width: "7",
				height: "7",
				rx: "1"
			})
		] });
		case "close": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("path", { d: "M6 6l12 12" }), /* @__PURE__ */ jsx("path", { d: "M18 6L6 18" })] });
		case "check": return /* @__PURE__ */ jsx("path", { d: "M5 12l4.5 4.5L19 7" });
		case "warning": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("path", { d: "M12 4l8 15H4L12 4z" }),
			/* @__PURE__ */ jsx("path", { d: "M12 9v4" }),
			/* @__PURE__ */ jsx("circle", {
				cx: "12",
				cy: "16.5",
				r: "0.5",
				fill: "currentColor",
				stroke: "none"
			})
		] });
		case "chevronDown": return /* @__PURE__ */ jsx("path", { d: "M6 9l6 6 6-6" });
		case "chevronUp": return /* @__PURE__ */ jsx("path", { d: "M6 15l6-6 6 6" });
		case "chevronLeft": return /* @__PURE__ */ jsx("path", { d: "M15 6l-6 6 6 6" });
		case "chevronRight": return /* @__PURE__ */ jsx("path", { d: "M9 6l6 6-6 6" });
		case "menu": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("path", { d: "M4 7h16" }),
			/* @__PURE__ */ jsx("path", { d: "M4 12h16" }),
			/* @__PURE__ */ jsx("path", { d: "M4 17h16" })
		] });
		case "spark": return /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsx("path", { d: "M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z" }) });
		case "package": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("path", { d: "M4 8l8-4 8 4-8 4-8-4z" }),
			/* @__PURE__ */ jsx("path", { d: "M4 8v8l8 4 8-4V8" }),
			/* @__PURE__ */ jsx("path", { d: "M12 12v8" })
		] });
		case "settings": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("circle", {
			cx: "12",
			cy: "12",
			r: "3"
		}), /* @__PURE__ */ jsx("path", { d: "M19 12a7 7 0 0 0-.1-1l2.1-1.7-2-3.4-2.6 1a7.7 7.7 0 0 0-1.8-1L14.3 3h-4.6l-.3 2.9a7.7 7.7 0 0 0-1.8 1l-2.6-1-2 3.4 2.1 1.7a7 7 0 0 0 0 2L3 14.7l2 3.4 2.6-1a7.7 7.7 0 0 0 1.8 1l.3 2.9h4.6l.3-2.9a7.7 7.7 0 0 0 1.8-1l2.6 1 2-3.4-2.1-1.7c.1-.3.1-.7.1-1z" })] });
		case "user": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("circle", {
			cx: "12",
			cy: "8",
			r: "4"
		}), /* @__PURE__ */ jsx("path", { d: "M5 20a7 7 0 0 1 14 0" })] });
		case "info": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("circle", {
				cx: "12",
				cy: "12",
				r: "9"
			}),
			/* @__PURE__ */ jsx("path", { d: "M12 10v5" }),
			/* @__PURE__ */ jsx("circle", {
				cx: "12",
				cy: "7.5",
				r: "0.5",
				fill: "currentColor",
				stroke: "none"
			})
		] });
		case "star": return /* @__PURE__ */ jsx("path", {
			d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z",
			fill: "currentColor"
		});
		case "starHalf": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" }), /* @__PURE__ */ jsx("path", {
			d: "M12 2v15.27L5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z",
			fill: "currentColor"
		})] });
		case "starEmpty": return /* @__PURE__ */ jsx("path", { d: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" });
		case "copy": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("rect", {
			x: "9",
			y: "9",
			width: "11",
			height: "11",
			rx: "1.5"
		}), /* @__PURE__ */ jsx("path", { d: "M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15" })] });
		case "plus": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("path", { d: "M12 5v14" }), /* @__PURE__ */ jsx("path", { d: "M5 12h14" })] });
		case "minus": return /* @__PURE__ */ jsx("path", { d: "M5 12h14" });
		case "edit": return /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsx("path", { d: "M17 3l4 4L7 21H3v-4L17 3z" }) });
		case "trash": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("path", { d: "M4 7h16" }),
			/* @__PURE__ */ jsx("path", { d: "M10 11v6" }),
			/* @__PURE__ */ jsx("path", { d: "M14 11v6" }),
			/* @__PURE__ */ jsx("path", { d: "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" }),
			/* @__PURE__ */ jsx("path", { d: "M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" })
		] });
		case "heart": return /* @__PURE__ */ jsx("path", { d: "M12 21C12 21 4 14 4 8.5A4.5 4.5 0 0 1 12 5a4.5 4.5 0 0 1 8 3.5C20 14 12 21 12 21z" });
		case "heartFilled": return /* @__PURE__ */ jsx("path", {
			d: "M12 21C12 21 4 14 4 8.5A4.5 4.5 0 0 1 12 5a4.5 4.5 0 0 1 8 3.5C20 14 12 21 12 21z",
			fill: "currentColor"
		});
		case "share": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("circle", {
				cx: "18",
				cy: "5",
				r: "3"
			}),
			/* @__PURE__ */ jsx("circle", {
				cx: "6",
				cy: "12",
				r: "3"
			}),
			/* @__PURE__ */ jsx("circle", {
				cx: "18",
				cy: "19",
				r: "3"
			}),
			/* @__PURE__ */ jsx("path", { d: "M8.59 13.51l6.83 3.98" }),
			/* @__PURE__ */ jsx("path", { d: "M15.41 6.51l-6.82 3.98" })
		] });
		case "image": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("rect", {
				x: "3",
				y: "3",
				width: "18",
				height: "18",
				rx: "2"
			}),
			/* @__PURE__ */ jsx("circle", {
				cx: "8.5",
				cy: "8.5",
				r: "1.5",
				fill: "currentColor",
				stroke: "none"
			}),
			/* @__PURE__ */ jsx("path", { d: "M21 15l-5-5L5 21" })
		] });
		case "dollar": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("path", { d: "M12 2v20" }), /* @__PURE__ */ jsx("path", { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" })] });
		case "truck": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("path", { d: "M1 3h15v13H1z" }),
			/* @__PURE__ */ jsx("path", { d: "M16 8h4l3 3v5h-7V8z" }),
			/* @__PURE__ */ jsx("circle", {
				cx: "5.5",
				cy: "18.5",
				r: "2.5"
			}),
			/* @__PURE__ */ jsx("circle", {
				cx: "18.5",
				cy: "18.5",
				r: "2.5"
			})
		] });
		case "clock": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("circle", {
			cx: "12",
			cy: "12",
			r: "9"
		}), /* @__PURE__ */ jsx("path", { d: "M12 7v5l3 3" })] });
		case "eye": return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" }), /* @__PURE__ */ jsx("circle", {
			cx: "12",
			cy: "12",
			r: "3"
		})] });
		case "eyeOff": return /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsx("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" }),
			/* @__PURE__ */ jsx("path", { d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" }),
			/* @__PURE__ */ jsx("path", { d: "M14.12 14.12a3 3 0 1 1-4.24-4.24" }),
			/* @__PURE__ */ jsx("path", { d: "M1 1l22 22" })
		] });
		default: return null;
	}
}
function Icon({ name, size = "md", tone = "primary", label, ...rest }) {
	const decorative = !label;
	return /* @__PURE__ */ jsx("span", {
		...rest,
		className: cx("inline-flex shrink-0 items-center", toneClasses[tone]),
		children: /* @__PURE__ */ jsx("svg", {
			"aria-hidden": decorative,
			"aria-label": label,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "2",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			className: sizeClasses[size],
			children: glyph(name)
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/theme/tokens.ts
var chaseTheme = {
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
chaseTheme.typography, chaseTheme.radius, chaseTheme.zIndex, chaseTheme.motion, chaseTheme.breakpoints;
function resolveTheme(theme, baseTheme = chaseTheme) {
	if (!theme) return baseTheme;
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
var tokenMap = [
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
		if (value !== void 0) record[cssVar] = value;
	}
	return target;
}
function resolveThemeOverrideStyle(theme) {
	if (!theme) return;
	const style = applyThemeStyle({}, theme);
	return Object.keys(style).length > 0 ? style : void 0;
}
//#endregion
//#region ../../packages/design-system/src/motion/config.ts
function parseDurationSeconds(value, fallbackMs) {
	if (!value) return fallbackMs / 1e3;
	const trimmed = value.trim();
	const number = Number.parseFloat(trimmed);
	if (!Number.isFinite(number)) return fallbackMs / 1e3;
	if (trimmed.endsWith("ms")) return number / 1e3;
	if (trimmed.endsWith("s")) return number;
	return number / 1e3;
}
function parseEase(value) {
	const match = value?.match(/cubic-bezier\(([^)]+)\)/i);
	if (!match) return [
		.16,
		1,
		.3,
		1
	];
	const parsed = match[1].split(",").map((segment) => Number.parseFloat(segment.trim())).filter((segment) => Number.isFinite(segment));
	if (parsed.length !== 4) return [
		.16,
		1,
		.3,
		1
	];
	return parsed;
}
function buildPreset(initial, animate, exit, transition) {
	return {
		initial,
		animate,
		exit,
		transition
	};
}
function resolveChaseMotion(theme, reducedMotionSetting = "user", reducedMotion = false) {
	const resolvedTheme = resolveTheme(theme, chaseTheme);
	const durations = {
		fast: parseDurationSeconds(resolvedTheme.motion.fast, 120),
		base: parseDurationSeconds(resolvedTheme.motion.base, 180),
		slow: parseDurationSeconds(resolvedTheme.motion.slow, 260)
	};
	const easing = parseEase(resolvedTheme.motion.ease);
	const inertTransition = {
		duration: .01,
		ease: "linear"
	};
	if (reducedMotion) {
		const subtle = buildPreset({ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, inertTransition);
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
	const fastTween = {
		duration: durations.fast,
		ease: easing
	};
	const baseTween = {
		duration: durations.base,
		ease: easing
	};
	const slowTween = {
		duration: durations.slow,
		ease: easing
	};
	return {
		reducedMotion,
		reducedMotionSetting,
		durations,
		easing,
		interactiveScale: 1.015,
		interactiveLift: -4,
		presets: {
			fade: buildPreset({ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, fastTween),
			lift: buildPreset({
				opacity: 0,
				y: 14,
				scale: .985
			}, {
				opacity: 1,
				y: 0,
				scale: 1
			}, {
				opacity: 0,
				y: 10,
				scale: .99
			}, baseTween),
			scale: buildPreset({
				opacity: 0,
				scale: .96
			}, {
				opacity: 1,
				scale: 1
			}, {
				opacity: 0,
				scale: .98
			}, baseTween),
			slideUp: buildPreset({
				opacity: 0,
				y: 22
			}, {
				opacity: 1,
				y: 0
			}, {
				opacity: 0,
				y: 18
			}, baseTween),
			slideRight: buildPreset({
				opacity: 0,
				x: 26
			}, {
				opacity: 1,
				x: 0
			}, {
				opacity: 0,
				x: 20
			}, slowTween)
		},
		viewPresets: {
			page: buildPreset({
				opacity: 0,
				y: 24
			}, {
				opacity: 1,
				y: 0
			}, {
				opacity: 0,
				y: 16
			}, slowTween),
			panel: buildPreset({
				opacity: 0,
				x: 20
			}, {
				opacity: 1,
				x: 0
			}, {
				opacity: 0,
				x: 12
			}, baseTween)
		}
	};
}
//#endregion
//#region ../../packages/design-system/src/theme/provider.tsx
var DensityContext = createContext("comfortable");
var MotionContext = createContext(resolveChaseMotion(void 0, "user", false));
var PortalContext = createContext({
	overlayNode: null,
	toastNode: null
});
function subscribeToReducedMotion(callback) {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
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
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function ChaseRoot({ children, density = "comfortable", reducedMotion = "user", colorMode = "system", theme, ...rest }) {
	const [overlayNode, setOverlayNode] = useState(null);
	const [toastNode, setToastNode] = useState(null);
	const systemReducedMotion = useSyncExternalStore(subscribeToReducedMotion, getReducedMotionSnapshot, () => false);
	const resolvedReducedMotion = reducedMotion === "always" ? true : reducedMotion === "never" ? false : systemReducedMotion;
	const motionSettings = useMemo(() => resolveChaseMotion(theme, reducedMotion, resolvedReducedMotion), [
		theme,
		reducedMotion,
		resolvedReducedMotion
	]);
	return /* @__PURE__ */ jsx(DensityContext.Provider, {
		value: density,
		children: /* @__PURE__ */ jsx(MotionContext.Provider, {
			value: motionSettings,
			children: /* @__PURE__ */ jsx(PortalContext.Provider, {
				value: {
					overlayNode,
					toastNode
				},
				children: /* @__PURE__ */ jsx(MotionConfig, {
					reducedMotion,
					transition: {
						duration: motionSettings.durations.base,
						ease: motionSettings.easing
					},
					children: /* @__PURE__ */ jsxs("div", {
						...rest,
						"data-chase-theme": "",
						"data-color-mode": colorMode,
						"data-density": density,
						"data-reduced-motion": resolvedReducedMotion ? "true" : "false",
						className: cx("chase-root relative isolate min-h-screen bg-background font-body text-foreground"),
						style: resolveThemeOverrideStyle(theme),
						children: [
							children,
							/* @__PURE__ */ jsx("div", {
								ref: setOverlayNode,
								"data-chase-overlay-root": ""
							}),
							/* @__PURE__ */ jsx("div", {
								ref: setToastNode,
								"data-chase-toast-root": ""
							})
						]
					})
				})
			})
		})
	});
}
function useDensity() {
	return useContext(DensityContext);
}
function useChaseMotion() {
	return useContext(MotionContext);
}
function usePortalRoots() {
	return useContext(PortalContext);
}
var colorModeOrder = [
	"light",
	"dark",
	"system"
];
function ColorModeToggle({ value, onValueChange, lightLabel = "Light", darkLabel = "Dark", systemLabel = "System" }) {
	const labels = {
		light: lightLabel,
		dark: darkLabel,
		system: systemLabel
	};
	function cycle() {
		const next = colorModeOrder[(colorModeOrder.indexOf(value) + 1) % colorModeOrder.length];
		onValueChange(next);
	}
	return /* @__PURE__ */ jsx("button", {
		type: "button",
		onClick: cycle,
		className: "focus-ring inline-flex touch-target items-center gap-2 rounded-tokenMd border border-muted bg-elevated px-3 py-2 text-sm font-medium text-secondary shadow-tokenSm transition hover:text-foreground",
		children: labels[value]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/shared.tsx
var buttonToneClasses = {
	primary: "border-transparent bg-accent text-accent-contrast hover:bg-accent-hover",
	secondary: "border-border bg-elevated text-foreground hover:border-accent hover:text-accent",
	ghost: "border-transparent bg-transparent text-secondary hover:border-border hover:bg-background hover:text-foreground",
	danger: "border-transparent bg-danger text-inverse hover:bg-danger-hover"
};
var buttonSizeClasses = {
	sm: "min-h-8 px-3 text-xs",
	md: "min-h-10 px-4 text-sm",
	lg: "min-h-12 px-5 text-base"
};
var buttonCompactSizeClasses = {
	sm: "min-h-7 px-2.5 text-xs",
	md: "min-h-8 px-3 text-sm",
	lg: "min-h-10 px-4 text-sm"
};
var buttonBaseClass = "focus-ring relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-tokenMd border font-semibold shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none";
function resolveInteractiveMotion(reducedMotion, scale, lift) {
	if (reducedMotion) return;
	return {
		whileHover: {
			y: lift,
			scale
		},
		whileTap: {
			y: 0,
			scale: .985
		},
		transition: { duration: .18 }
	};
}
function renderActivePill(groupId, tone = "default") {
	return /* @__PURE__ */ jsx(motion.span, {
		layoutId: `${groupId}-active-pill`,
		className: cx("absolute inset-0 rounded-tokenMd", tone === "accent" ? "bg-elevated shadow-tokenSm" : "bg-background shadow-tokenSm"),
		transition: { duration: .18 }
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/button.tsx
function iconTone(tone) {
	return tone === "primary" || tone === "danger" ? "inverse" : "accent";
}
function renderLeadingIcon(icon, tone) {
	if (!icon) return null;
	return /* @__PURE__ */ jsx(Icon, {
		name: icon,
		size: "sm",
		tone: iconTone(tone)
	});
}
function ButtonSpinner({ tone }) {
	const color = tone === "primary" || tone === "danger" ? "border-t-accent-contrast border-accent-contrast/30" : "border-t-accent border-accent/30";
	return /* @__PURE__ */ jsx("span", {
		"aria-hidden": "true",
		className: cx("absolute inset-0 flex items-center justify-center"),
		children: /* @__PURE__ */ jsx("span", { className: cx("h-4 w-4 animate-spin rounded-full border-2", color) })
	});
}
var Button = forwardRef(function Button({ children, tone = "primary", size = "md", block = false, loading = false, leadingIcon, trailingIcon, type = "button", disabled, ...rest }, ref) {
	const motionSettings = useChaseMotion();
	const sizeClasses = useDensity() === "compact" ? buttonCompactSizeClasses : buttonSizeClasses;
	const interactiveMotion = resolveInteractiveMotion(motionSettings.reducedMotion, motionSettings.interactiveScale, motionSettings.interactiveLift);
	const nativeProps = rest;
	const isDisabled = disabled || loading;
	return /* @__PURE__ */ jsxs(motion.button, {
		...nativeProps,
		ref,
		type,
		disabled: isDisabled,
		"aria-busy": loading || void 0,
		...isDisabled ? void 0 : interactiveMotion,
		className: cx(buttonBaseClass, buttonToneClasses[tone], sizeClasses[size], block && "w-full"),
		children: [loading ? /* @__PURE__ */ jsx(ButtonSpinner, { tone }) : null, /* @__PURE__ */ jsxs("span", {
			className: cx("inline-flex items-center gap-2", loading && "invisible"),
			children: [
				renderLeadingIcon(leadingIcon, tone),
				/* @__PURE__ */ jsx("span", { children }),
				trailingIcon ? /* @__PURE__ */ jsx(Icon, {
					name: trailingIcon,
					size: "sm",
					tone: iconTone(tone)
				}) : null
			]
		})]
	});
});
var IconButton = forwardRef(function IconButton({ label, icon, tone = "ghost", size = "md", type = "button", ...rest }, ref) {
	const motionSettings = useChaseMotion();
	const sizeClasses = useDensity() === "compact" ? buttonCompactSizeClasses : buttonSizeClasses;
	const interactiveMotion = resolveInteractiveMotion(motionSettings.reducedMotion, motionSettings.interactiveScale, motionSettings.interactiveLift);
	const nativeProps = rest;
	return /* @__PURE__ */ jsx(motion.button, {
		...nativeProps,
		ref,
		type,
		"aria-label": label,
		...interactiveMotion,
		className: cx(buttonBaseClass, buttonToneClasses[tone], sizeClasses[size], "px-0"),
		children: /* @__PURE__ */ jsx(Icon, {
			name: icon,
			size: "sm",
			tone: iconTone(tone)
		})
	});
});
var LinkButton = forwardRef(function LinkButton({ children, tone = "secondary", size = "md", leadingIcon, trailingIcon, block = false, ...rest }, ref) {
	const motionSettings = useChaseMotion();
	const interactiveMotion = resolveInteractiveMotion(motionSettings.reducedMotion, motionSettings.interactiveScale, motionSettings.interactiveLift);
	const nativeProps = rest;
	return /* @__PURE__ */ jsxs(motion.a, {
		...nativeProps,
		ref,
		...interactiveMotion,
		className: cx(buttonBaseClass, buttonToneClasses[tone], buttonSizeClasses[size], block && "w-full"),
		children: [
			renderLeadingIcon(leadingIcon, tone),
			/* @__PURE__ */ jsx("span", { children }),
			trailingIcon ? /* @__PURE__ */ jsx(Icon, {
				name: trailingIcon,
				size: "sm",
				tone: iconTone(tone)
			}) : null
		]
	});
});
function ButtonGroup({ children, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		role: "group",
		className: "inline-flex flex-wrap items-center gap-3",
		children
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/tabs.tsx
function Tabs({ items, defaultValue, value, onValueChange, orientation = "horizontal", dir, activationMode = "automatic" }) {
	const resolvedValue = defaultValue ?? items[0]?.value;
	const [internalValue, setInternalValue] = useState(resolvedValue);
	const currentValue = value ?? internalValue ?? resolvedValue;
	const groupId = useId();
	function handleValueChange(nextValue) {
		if (value === void 0) setInternalValue(nextValue);
		onValueChange?.(nextValue);
	}
	return /* @__PURE__ */ jsxs(TabsPrimitive.Root, {
		defaultValue: resolvedValue,
		value: currentValue,
		onValueChange: handleValueChange,
		orientation,
		dir,
		activationMode,
		className: "space-y-4",
		children: [/* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: /* @__PURE__ */ jsx(TabsPrimitive.List, {
				className: "inline-flex w-full flex-wrap gap-2 rounded-tokenLg border border-muted bg-background p-2",
				children: items.map((item) => {
					const active = item.value === currentValue;
					return /* @__PURE__ */ jsxs(TabsPrimitive.Trigger, {
						value: item.value,
						className: "focus-ring relative inline-flex touch-target flex-1 items-center justify-center gap-2 overflow-hidden rounded-tokenMd px-4 py-2 text-sm font-semibold text-secondary transition data-[state=active]:text-accent",
						children: [
							active ? renderActivePill(groupId, "accent") : null,
							/* @__PURE__ */ jsx("span", {
								className: "relative z-10",
								children: item.label
							}),
							item.badge ? /* @__PURE__ */ jsx("span", {
								className: "relative z-10 rounded-full bg-background px-2 py-0.5 text-[0.7rem]",
								children: item.badge
							}) : null
						]
					}, item.value);
				})
			})
		}), /* @__PURE__ */ jsx(AnimatePresence, {
			initial: false,
			mode: "wait",
			children: /* @__PURE__ */ jsx(motion.div, {
				initial: {
					opacity: 0,
					y: 10
				},
				animate: {
					opacity: 1,
					y: 0
				},
				exit: {
					opacity: 0,
					y: -6
				},
				transition: { duration: .18 },
				children: /* @__PURE__ */ jsx(TabsPrimitive.Content, {
					value: currentValue,
					forceMount: true,
					className: "focus-visible:outline-none",
					children: items.find((item) => item.value === currentValue)?.content
				})
			}, currentValue)
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/segmented-control.tsx
function SegmentedControl({ items, value, onValueChange, ...rest }) {
	const groupId = useId();
	function handleKeyDown(event, index) {
		let next = -1;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % items.length;
		else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = items.length - 1;
		if (next >= 0) {
			event.preventDefault();
			onValueChange?.(items[next].value);
			(event.currentTarget.parentElement?.querySelectorAll("[role=\"tab\"]"))?.[next]?.focus();
		}
	}
	return /* @__PURE__ */ jsx(LayoutGroup, {
		id: groupId,
		children: /* @__PURE__ */ jsx("div", {
			...rest,
			role: "tablist",
			className: "inline-flex flex-wrap rounded-tokenLg border border-muted bg-background p-1",
			children: items.map((item, index) => {
				const active = item.value === value;
				return /* @__PURE__ */ jsxs("button", {
					type: "button",
					role: "tab",
					"aria-selected": active,
					tabIndex: active ? 0 : -1,
					className: cx("focus-ring relative inline-flex min-h-10 items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-semibold transition", active ? "text-accent" : "text-secondary hover:text-foreground"),
					onClick: () => onValueChange?.(item.value),
					onKeyDown: (event) => handleKeyDown(event, index),
					children: [
						active ? renderActivePill(groupId, "accent") : null,
						item.icon ? /* @__PURE__ */ jsx(Icon, {
							name: item.icon,
							size: "sm"
						}) : null,
						/* @__PURE__ */ jsx("span", {
							className: "relative z-10",
							children: item.label
						})
					]
				}, item.value);
			})
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/breadcrumbs.tsx
function Breadcrumbs({ items, ariaLabel = "Breadcrumb", ...rest }) {
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		"aria-label": ariaLabel,
		children: /* @__PURE__ */ jsx("ol", {
			className: "flex flex-wrap items-center gap-2 text-sm text-secondary",
			children: items.map((item, index) => {
				const isCurrent = index === items.length - 1;
				return /* @__PURE__ */ jsxs("li", {
					className: "inline-flex items-center gap-2",
					children: [item.href && !isCurrent ? /* @__PURE__ */ jsx("a", {
						href: item.href,
						className: "focus-ring rounded-tokenSm hover:text-foreground",
						children: item.label
					}) : /* @__PURE__ */ jsx("span", {
						className: isCurrent ? "font-semibold text-foreground" : void 0,
						children: item.label
					}), !isCurrent ? /* @__PURE__ */ jsx(Icon, {
						name: "chevronRight",
						size: "sm",
						tone: "secondary"
					}) : null]
				}, `${item.label}-${index}`);
			})
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/pagination.tsx
function buildPageRange(page, totalPages) {
	if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
	const pages = [1];
	if (page > 3) pages.push("ellipsis-start");
	const start = Math.max(2, page - 1);
	const end = Math.min(totalPages - 1, page + 1);
	for (let i = start; i <= end; i++) pages.push(i);
	if (page < totalPages - 2) pages.push("ellipsis-end");
	pages.push(totalPages);
	return pages;
}
function Pagination({ page, totalPages, onPageChange, previousLabel = "Previous page", nextLabel = "Next page", ...rest }) {
	const pages = buildPageRange(page, totalPages);
	return /* @__PURE__ */ jsxs("nav", {
		...rest,
		"aria-label": "Pagination",
		className: "flex items-center gap-2",
		children: [
			/* @__PURE__ */ jsx(IconButton, {
				label: previousLabel,
				icon: "chevronLeft",
				tone: "secondary",
				disabled: page <= 1,
				onClick: () => onPageChange?.(Math.max(1, page - 1))
			}),
			/* @__PURE__ */ jsx("div", {
				className: "flex flex-wrap gap-2",
				children: pages.map((value) => {
					if (typeof value === "string") return /* @__PURE__ */ jsx("span", {
						className: "inline-flex min-h-10 min-w-10 items-center justify-center text-sm text-secondary",
						"aria-hidden": "true",
						children: "…"
					}, value);
					return /* @__PURE__ */ jsx("button", {
						type: "button",
						"aria-current": value === page ? "page" : void 0,
						className: cx("focus-ring inline-flex min-h-10 min-w-10 items-center justify-center rounded-tokenMd border px-3 text-sm font-semibold transition", value === page ? "border-accent bg-accent text-accent-contrast" : "border-muted bg-elevated text-secondary hover:text-foreground"),
						onClick: () => onPageChange?.(value),
						children: value
					}, value);
				})
			}),
			/* @__PURE__ */ jsx(IconButton, {
				label: nextLabel,
				icon: "chevronRight",
				tone: "secondary",
				disabled: page >= totalPages,
				onClick: () => onPageChange?.(Math.min(totalPages, page + 1))
			})
		]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/page-stepper.tsx
function PageStepper({ items, ...rest }) {
	return /* @__PURE__ */ jsx("ol", {
		...rest,
		className: "grid gap-3 md:grid-cols-3",
		children: items.map((item, index) => /* @__PURE__ */ jsx("li", {
			className: cx("rounded-tokenLg border p-4 shadow-tokenSm", item.status === "complete" && "border-success bg-elevated", item.status === "current" && "border-accent bg-elevated", item.status === "upcoming" && "border-muted bg-background"),
			children: /* @__PURE__ */ jsxs("div", {
				className: "flex items-start gap-3",
				children: [/* @__PURE__ */ jsx("span", {
					className: cx("inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold", item.status === "complete" && "bg-success text-inverse", item.status === "current" && "bg-accent text-accent-contrast", item.status === "upcoming" && "bg-muted text-secondary"),
					children: item.status === "complete" ? /* @__PURE__ */ jsx(Icon, {
						name: "check",
						size: "sm"
					}) : index + 1
				}), /* @__PURE__ */ jsxs("div", {
					className: "space-y-1",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-sm font-semibold text-foreground",
						children: item.label
					}), item.description ? /* @__PURE__ */ jsx("div", {
						className: "text-xs text-secondary",
						children: item.description
					}) : null]
				})]
			})
		}, `${item.label}-${index}`))
	});
}
//#endregion
//#region ../../packages/design-system/src/utils/system.ts
var breakpoints = [
	"base",
	"sm",
	"md",
	"lg",
	"xl",
	"2xl"
];
var textAlignClasses = {
	left: "text-left",
	center: "text-center",
	right: "text-right"
};
var directionClasses = {
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
var alignClasses = {
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
var justifyClasses = {
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
var columnsClasses = {
	1: {
		base: "grid-cols-1",
		sm: "sm:grid-cols-1",
		md: "md:grid-cols-1",
		lg: "lg:grid-cols-1",
		xl: "xl:grid-cols-1",
		"2xl": "2xl:grid-cols-1"
	},
	2: {
		base: "grid-cols-2",
		sm: "sm:grid-cols-2",
		md: "md:grid-cols-2",
		lg: "lg:grid-cols-2",
		xl: "xl:grid-cols-2",
		"2xl": "2xl:grid-cols-2"
	},
	3: {
		base: "grid-cols-3",
		sm: "sm:grid-cols-3",
		md: "md:grid-cols-3",
		lg: "lg:grid-cols-3",
		xl: "xl:grid-cols-3",
		"2xl": "2xl:grid-cols-3"
	},
	4: {
		base: "grid-cols-4",
		sm: "sm:grid-cols-4",
		md: "md:grid-cols-4",
		lg: "lg:grid-cols-4",
		xl: "xl:grid-cols-4",
		"2xl": "2xl:grid-cols-4"
	}
};
function resolveSpaceClass(prefix, value) {
	if (value === void 0) return "";
	return `${prefix}-${value}`;
}
function resolveTextAlignClass(value) {
	return value ? textAlignClasses[value] : "";
}
function resolveResponsiveClass(value, classes) {
	if (value === void 0) return "";
	if (typeof value !== "object") return classes[String(value)].base;
	const output = [];
	for (const key of breakpoints) {
		const resolved = value[key];
		if (resolved !== void 0) output.push(classes[String(resolved)][key]);
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
function resolveColumnsClass(value) {
	return resolveResponsiveClass(value, columnsClasses);
}
function resolveSystemProps(props) {
	return cx(resolveSpaceClass("p", props.padding), resolveSpaceClass("px", props.paddingX), resolveSpaceClass("py", props.paddingY), resolveSpaceClass("gap", props.gap), resolveTextAlignClass(props.textAlign));
}
//#endregion
//#region ../../packages/design-system/src/primitives/layout.tsx
function Box({ element = "div", children, padding, paddingX, paddingY, gap, textAlign, ...rest }) {
	return /* @__PURE__ */ jsx(element, {
		...rest,
		className: resolveSystemProps({
			padding,
			paddingX,
			paddingY,
			gap,
			textAlign
		}),
		children
	});
}
var layoutWidthClasses = {
	narrow: "max-w-3xl",
	content: "max-w-5xl",
	wide: "max-w-7xl",
	full: "max-w-none"
};
function Container({ children, width = "full", paddingX = 4, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("w-full", resolveSystemProps({ paddingX })),
		children: /* @__PURE__ */ jsx("div", {
			className: cx("mx-auto w-full", layoutWidthClasses[width]),
			children
		})
	});
}
function Stack({ children, element = "div", direction = "column", align, justify, gap = 4, ...rest }) {
	return /* @__PURE__ */ jsx(element, {
		...rest,
		className: cx("flex", resolveDirectionClass(direction), resolveAlignClass(align), resolveJustifyClass(justify), resolveSpaceClass("gap", gap)),
		children
	});
}
function Inline({ children, gap = 3, align = "center", wrap = true, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("flex", wrap && "flex-wrap", resolveAlignClass(align), resolveSpaceClass("gap", gap)),
		children
	});
}
function Cluster({ children, justify = "between", gap = 3, align = "center", ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("flex w-full flex-wrap", resolveAlignClass(align), resolveJustifyClass(justify), resolveSpaceClass("gap", gap)),
		children
	});
}
function Grid({ children, columns = {
	base: 1,
	md: 2,
	xl: 3
}, gap = 4, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("grid", resolveColumnsClass(columns), resolveSpaceClass("gap", gap)),
		children
	});
}
function Spacer({ axis = "vertical", size = 4, flexible = false, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		"aria-hidden": "true",
		className: cx(flexible && "flex-1", axis === "vertical" ? resolveSpaceClass("my", size) : resolveSpaceClass("mx", size))
	});
}
function Inset({ children, padding = 4, ...rest }) {
	return /* @__PURE__ */ jsx(Box, {
		...rest,
		padding,
		children
	});
}
function Center({ children, inline = false, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx(inline ? "inline-flex" : "flex", "items-center justify-center"),
		children
	});
}
function AspectRatio({ children, ratio = 1, ...rest }) {
	return /* @__PURE__ */ jsx(AspectRatioPrimitive.Root, {
		...rest,
		ratio,
		children
	});
}
var surfaceToneClasses = {
	default: "modern-surface bg-elevated",
	muted: "bg-background",
	accent: "bg-accent text-accent-contrast"
};
function Surface({ children, element = "div", tone = "default", elevated = false, padding = 4, paddingX, paddingY, gap, textAlign, ...rest }) {
	return /* @__PURE__ */ jsx(element, {
		...rest,
		className: cx("surface-border rounded-tokenLg", surfaceToneClasses[tone], resolveSystemProps({
			padding,
			paddingX,
			paddingY,
			gap,
			textAlign
		}), elevated ? "shadow-tokenLg" : "shadow-tokenSm"),
		children
	});
}
function Divider({ orientation = "horizontal", decorative = true, ...rest }) {
	return /* @__PURE__ */ jsx(SeparatorPrimitive.Root, {
		...rest,
		decorative,
		orientation,
		className: cx("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px")
	});
}
var scrollHeights = {
	auto: "",
	sm: "max-h-48",
	md: "max-h-72",
	lg: "max-h-96",
	full: "h-full"
};
function ScrollArea({ children, height = "auto", ...rest }) {
	return /* @__PURE__ */ jsxs(ScrollAreaPrimitive.Root, {
		...rest,
		className: cx("modern-surface overflow-hidden rounded-tokenLg border border-muted", scrollHeights[height]),
		children: [
			/* @__PURE__ */ jsx(ScrollAreaPrimitive.Viewport, {
				className: "h-full w-full",
				children
			}),
			/* @__PURE__ */ jsx(ScrollAreaPrimitive.Scrollbar, {
				orientation: "vertical",
				className: "flex w-2.5 touch-none select-none bg-transparent p-0.5",
				children: /* @__PURE__ */ jsx(ScrollAreaPrimitive.Thumb, { className: "relative flex-1 rounded-full bg-muted" })
			}),
			/* @__PURE__ */ jsx(ScrollAreaPrimitive.Scrollbar, {
				orientation: "horizontal",
				className: "flex h-2.5 touch-none select-none bg-transparent p-0.5",
				children: /* @__PURE__ */ jsx(ScrollAreaPrimitive.Thumb, { className: "relative flex-1 rounded-full bg-muted" })
			}),
			/* @__PURE__ */ jsx(ScrollAreaPrimitive.Corner, { className: "bg-muted" })
		]
	});
}
function VisuallyHidden({ children, ...rest }) {
	return /* @__PURE__ */ jsx(VisuallyHiddenPrimitive.Root, {
		...rest,
		children
	});
}
function SkipLink({ targetId = "main-content", label = "Skip to main content" }) {
	return /* @__PURE__ */ jsx("a", {
		href: `#${targetId}`,
		className: "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-tokenMd focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-contrast focus:shadow-overlay",
		children: label
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/navigation.tsx
function renderNavigationItem(item, active, orientation, groupId, onSelect) {
	const content = /* @__PURE__ */ jsxs(Fragment, { children: [
		item.icon ? /* @__PURE__ */ jsx(Icon, {
			name: item.icon,
			size: "sm",
			tone: active ? "accent" : "secondary"
		}) : null,
		/* @__PURE__ */ jsx("span", {
			className: cx(orientation === "rail" && "text-xs"),
			children: item.label
		}),
		item.badge ? /* @__PURE__ */ jsx("span", {
			className: "rounded-full bg-background px-2 py-0.5 text-[0.7rem] font-semibold text-secondary",
			children: item.badge
		}) : null
	] });
	const className = cx("focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition", orientation === "vertical" && "w-full justify-between", orientation === "rail" && "w-full flex-col justify-center py-3", active ? "bg-background text-accent shadow-tokenSm" : "text-secondary hover:bg-background hover:text-foreground");
	if (item.href) return /* @__PURE__ */ jsxs("a", {
		href: item.href,
		className,
		children: [active && groupId ? renderActivePill(groupId) : null, /* @__PURE__ */ jsx("span", {
			className: "relative z-10 inline-flex items-center gap-2",
			children: content
		})]
	}, item.key);
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		className,
		onClick: () => onSelect?.(item.key),
		children: [active && groupId ? renderActivePill(groupId) : null, /* @__PURE__ */ jsx("span", {
			className: "relative z-10 inline-flex items-center gap-2",
			children: content
		})]
	}, item.key);
}
function renderBottomNavigationItem(item, active, groupId, onSelect) {
	const content = /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("span", {
			className: "relative inline-flex h-5 w-5 items-center justify-center",
			children: [item.icon ? /* @__PURE__ */ jsx(Icon, {
				name: item.icon,
				size: "sm",
				tone: active ? "accent" : "secondary"
			}) : null, item.badge ? /* @__PURE__ */ jsx("span", {
				"aria-hidden": "true",
				className: "absolute -right-2 -top-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[0.65rem] font-semibold leading-none text-secondary shadow-tokenSm",
				children: item.badge
			}) : null]
		}),
		/* @__PURE__ */ jsx("span", {
			className: "text-xs",
			children: item.label
		}),
		item.badge ? /* @__PURE__ */ jsx("span", {
			className: "sr-only",
			children: ` ${item.badge}`
		}) : null
	] });
	const className = cx("focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-3 py-3 text-sm font-medium transition", active ? "bg-background text-accent shadow-tokenSm" : "text-secondary hover:bg-background hover:text-foreground");
	if (item.href) return /* @__PURE__ */ jsxs("a", {
		href: item.href,
		className,
		children: [active && groupId ? renderActivePill(groupId) : null, /* @__PURE__ */ jsx("span", {
			className: "relative z-10 inline-flex flex-col items-center justify-center gap-1",
			children: content
		})]
	}, item.key);
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		className,
		onClick: () => onSelect?.(item.key),
		children: [active && groupId ? renderActivePill(groupId) : null, /* @__PURE__ */ jsx("span", {
			className: "relative z-10 inline-flex flex-col items-center justify-center gap-1",
			children: content
		})]
	}, item.key);
}
function TopNav({ items, activeKey, onSelect, brand, actions, width = "full", ...rest }) {
	const groupId = useId();
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		className: "sticky top-0 z-sticky border-b border-muted bg-elevated/95 px-4 py-3 shadow-tokenSm backdrop-blur-md",
		children: /* @__PURE__ */ jsxs("div", {
			className: cx("mx-auto flex w-full items-center justify-between gap-4", layoutWidthClasses[width]),
			children: [/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-4",
				children: [brand, /* @__PURE__ */ jsx(LayoutGroup, {
					id: groupId,
					children: /* @__PURE__ */ jsx("div", {
						className: "hidden items-center gap-1 md:flex",
						children: items.map((item) => renderNavigationItem(item, item.key === activeKey, "horizontal", groupId, onSelect))
					})
				})]
			}), /* @__PURE__ */ jsx("div", {
				className: "flex items-center gap-2",
				children: actions
			})]
		})
	});
}
function SideNav({ items, activeKey, onSelect, ...rest }) {
	const groupId = useId();
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		className: "modern-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm",
		children: /* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: items.map((item) => renderNavigationItem(item, item.key === activeKey, "vertical", groupId, onSelect))
		})
	});
}
function BottomNav({ items, activeKey, onSelect, width = "full", ...rest }) {
	const groupId = useId();
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		className: "fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-elevated/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-tokenLg backdrop-blur-md md:hidden",
		children: /* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: /* @__PURE__ */ jsx("div", {
				className: cx("mx-auto grid w-full grid-cols-4 gap-2", layoutWidthClasses[width]),
				children: items.slice(0, 4).map((item) => renderBottomNavigationItem(item, item.key === activeKey, groupId, onSelect))
			})
		})
	});
}
function NavRail({ items, activeKey, onSelect, ...rest }) {
	const groupId = useId();
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		className: "modern-surface hidden h-full w-24 flex-col gap-2 rounded-tokenLg border border-muted p-2 md:flex",
		children: /* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: items.map((item) => renderNavigationItem(item, item.key === activeKey, "rail", groupId, onSelect))
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/copy-button.tsx
function CopyButton({ value, label = "Copy", copiedLabel = "Copied", tone = "secondary", size = "sm", type = "button", ...rest }) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef(null);
	const motionSettings = useChaseMotion();
	const interactiveMotion = resolveInteractiveMotion(motionSettings.reducedMotion, motionSettings.interactiveScale, motionSettings.interactiveLift);
	const nativeProps = rest;
	const handleClick = useCallback(() => {
		navigator.clipboard.writeText(value).then(() => {
			setCopied(true);
			if (timerRef.current !== null) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => setCopied(false), 2e3);
		});
	}, [value]);
	return /* @__PURE__ */ jsxs(motion.button, {
		...nativeProps,
		type,
		...interactiveMotion,
		className: cx(buttonBaseClass, buttonToneClasses[tone], buttonSizeClasses[size]),
		onClick: handleClick,
		children: [/* @__PURE__ */ jsx(Icon, {
			name: copied ? "check" : "copy",
			size: "sm",
			tone: tone === "primary" || tone === "danger" ? "inverse" : "accent"
		}), /* @__PURE__ */ jsx("span", { children: copied ? copiedLabel : label })]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/table.tsx
function Table({ columns, rows, caption, ...rest }) {
	const cellPad = useDensity() === "compact" ? "px-3 py-2" : "px-4 py-3";
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: "modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm",
		children: /* @__PURE__ */ jsxs("table", {
			className: "min-w-full border-collapse text-left text-sm",
			children: [
				caption ? /* @__PURE__ */ jsx("caption", {
					className: "sr-only",
					children: caption
				}) : null,
				/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsx("tr", {
					className: "border-b border-muted bg-background",
					children: columns.map((column, index) => /* @__PURE__ */ jsx("th", {
						className: `${cellPad} font-semibold text-foreground`,
						children: column
					}, index))
				}) }),
				/* @__PURE__ */ jsx("tbody", { children: rows.map((row, rowIndex) => /* @__PURE__ */ jsx("tr", {
					className: "border-b border-muted transition-colors hover:bg-background/60 last:border-b-0",
					children: row.map((cell, cellIndex) => /* @__PURE__ */ jsx("td", {
						className: `${cellPad} text-foreground`,
						children: cell
					}, cellIndex))
				}, rowIndex)) })
			]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/shared.tsx
var softToneClasses = {
	neutral: "border-muted bg-background text-secondary",
	accent: "border-accent/40 bg-accent/8 text-accent",
	success: "border-success/40 bg-success/8 text-success",
	warning: "border-warning/40 bg-warning/8 text-warning",
	danger: "border-danger/40 bg-danger/8 text-danger",
	info: "border-info/40 bg-info/8 text-info"
};
function toneIcon(tone) {
	switch (tone) {
		case "success": return "check";
		case "warning": return "warning";
		case "danger": return "warning";
		case "info": return "info";
		case "accent": return "spark";
		default: return "info";
	}
}
function toneToIconTone(tone) {
	return tone === "neutral" ? "secondary" : tone;
}
function useControllableOpen(open, defaultOpen, onOpenChange) {
	const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
	const resolvedOpen = open ?? internalOpen;
	function handleOpenChange(nextOpen) {
		if (open === void 0) setInternalOpen(nextOpen);
		onOpenChange?.(nextOpen);
	}
	return [resolvedOpen, handleOpenChange];
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/badge.tsx
function Badge({ children, tone = "neutral", ...rest }) {
	return /* @__PURE__ */ jsx("span", {
		...rest,
		className: cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold", softToneClasses[tone]),
		children
	});
}
function StatusPill(props) {
	return /* @__PURE__ */ jsx(Badge, { ...props });
}
function Tag({ children, tone = "neutral", onRemove, ...rest }) {
	return /* @__PURE__ */ jsxs("span", {
		...rest,
		className: cx("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold", softToneClasses[tone]),
		children: [/* @__PURE__ */ jsx("span", { children }), onRemove ? /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "focus-ring rounded-full",
			onClick: onRemove,
			"aria-label": `Remove ${typeof children === "string" ? children : "tag"}`,
			children: /* @__PURE__ */ jsx(Icon, {
				name: "close",
				size: "sm",
				tone: toneToIconTone(tone)
			})
		}) : null]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/banner.tsx
function Banner({ title, description, tone = "info", actions, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: cx("flex flex-col gap-4 rounded-tokenLg border p-4 md:flex-row md:items-center md:justify-between", softToneClasses[tone]),
		children: [/* @__PURE__ */ jsxs("div", {
			className: "flex items-start gap-3",
			children: [/* @__PURE__ */ jsx(Icon, {
				name: toneIcon(tone),
				size: "sm",
				tone
			}), /* @__PURE__ */ jsxs("div", {
				className: "space-y-1",
				children: [/* @__PURE__ */ jsx("div", {
					className: "text-sm font-semibold",
					children: title
				}), description ? /* @__PURE__ */ jsx("div", {
					className: "text-sm",
					children: description
				}) : null]
			})]
		}), actions ? /* @__PURE__ */ jsx("div", {
			className: "flex flex-wrap gap-2",
			children: actions
		}) : null]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/dialog.tsx
function renderDialogFrame({ open, title, description, children, footer, onDismiss, kind, reducedMotion, durations, easing, closeLabel = "Close" }) {
	const frameAnimation = kind === "drawer" ? {
		initial: reducedMotion ? false : {
			opacity: 0,
			y: 24,
			x: 0
		},
		animate: reducedMotion ? void 0 : open ? {
			opacity: 1,
			y: 0,
			x: 0
		} : {
			opacity: 0,
			y: 20,
			x: 12
		},
		transition: reducedMotion ? void 0 : {
			duration: durations.slow,
			ease: easing
		}
	} : {
		initial: reducedMotion ? false : {
			opacity: 0,
			scale: .96,
			y: 14
		},
		animate: reducedMotion ? void 0 : open ? {
			opacity: 1,
			scale: 1,
			y: 0
		} : {
			opacity: 0,
			scale: .98,
			y: 10
		},
		transition: reducedMotion ? void 0 : {
			duration: durations.base,
			ease: easing
		}
	};
	const overlayAnimation = {
		initial: false,
		animate: reducedMotion ? void 0 : open ? { opacity: 1 } : { opacity: 0 },
		transition: reducedMotion ? void 0 : {
			duration: durations.base,
			ease: easing
		}
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(DialogPrimitive.Overlay, {
		forceMount: true,
		asChild: true,
		children: /* @__PURE__ */ jsx(motion.div, {
			initial: overlayAnimation.initial,
			animate: overlayAnimation.animate,
			transition: overlayAnimation.transition,
			className: "fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
		})
	}), /* @__PURE__ */ jsx(DialogPrimitive.Content, {
		forceMount: true,
		asChild: true,
		children: /* @__PURE__ */ jsxs(motion.div, {
			initial: frameAnimation.initial,
			animate: frameAnimation.animate,
			transition: frameAnimation.transition,
			className: cx("modern-surface fixed z-modal flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col rounded-tokenXl border border-muted p-5 shadow-overlay focus-visible:outline-none md:w-full md:max-w-2xl", kind === "dialog" && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2", kind === "drawer" && "inset-x-4 bottom-4 md:inset-y-4 md:right-4 md:left-auto md:w-[28rem]"),
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex items-start justify-between gap-4",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "space-y-1",
						children: [/* @__PURE__ */ jsx(DialogPrimitive.Title, {
							className: "font-heading text-xl font-semibold text-foreground",
							children: title
						}), /* @__PURE__ */ jsx(DialogPrimitive.Description, {
							className: description ? "text-sm text-secondary" : "sr-only",
							children: description ?? "Dialog content"
						})]
					}), /* @__PURE__ */ jsx(DialogPrimitive.Close, {
						asChild: true,
						children: /* @__PURE__ */ jsx(IconButton, {
							label: closeLabel,
							icon: "close",
							tone: "ghost",
							onClick: onDismiss
						})
					})]
				}),
				/* @__PURE__ */ jsx("div", {
					className: "mt-4 min-h-0 flex-1 overflow-y-auto",
					children
				}),
				footer ? /* @__PURE__ */ jsx("div", {
					className: "mt-4",
					children: footer
				}) : null
			]
		})
	})] });
}
function Dialog({ open, defaultOpen, onOpenChange, title, description, trigger, children, footer, closeLabel }) {
	const { overlayNode } = usePortalRoots();
	const motionSettings = useChaseMotion();
	const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
	return /* @__PURE__ */ jsxs(DialogPrimitive.Root, {
		open: resolvedOpen,
		onOpenChange: setResolvedOpen,
		children: [trigger ? /* @__PURE__ */ jsx(DialogPrimitive.Trigger, {
			asChild: true,
			children: trigger
		}) : null, /* @__PURE__ */ jsx(DialogPrimitive.Portal, {
			container: overlayNode ?? void 0,
			children: renderDialogFrame({
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
			})
		})]
	});
}
function Drawer({ open, defaultOpen, onOpenChange, title, description, trigger, children, footer, closeLabel }) {
	const { overlayNode } = usePortalRoots();
	const motionSettings = useChaseMotion();
	const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
	return /* @__PURE__ */ jsxs(DialogPrimitive.Root, {
		open: resolvedOpen,
		onOpenChange: setResolvedOpen,
		children: [trigger ? /* @__PURE__ */ jsx(DialogPrimitive.Trigger, {
			asChild: true,
			children: trigger
		}) : null, /* @__PURE__ */ jsx(DialogPrimitive.Portal, {
			container: overlayNode ?? void 0,
			children: renderDialogFrame({
				open: resolvedOpen,
				title,
				description,
				footer,
				kind: "drawer",
				children,
				reducedMotion: motionSettings.reducedMotion,
				durations: motionSettings.durations,
				easing: motionSettings.easing,
				closeLabel
			})
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/motion-overlay.ts
function resolveOverlayMotion(settings, open, enterValues, exitValues, initialValues, speed = "fast") {
	if (settings.reducedMotion) return {
		initial: false,
		animate: void 0,
		transition: void 0
	};
	return {
		initial: initialValues ?? exitValues,
		animate: open ? enterValues : exitValues,
		transition: {
			duration: settings.durations[speed],
			ease: settings.easing
		}
	};
}
function resolveOverlayFade(settings, open, speed = "base") {
	return {
		initial: false,
		animate: settings.reducedMotion ? void 0 : open ? { opacity: 1 } : { opacity: 0 },
		transition: settings.reducedMotion ? void 0 : {
			duration: settings.durations[speed],
			ease: settings.easing
		}
	};
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/alert-dialog.tsx
function AlertDialog({ open, defaultOpen, onOpenChange, title, description, trigger, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "danger", onConfirm }) {
	const { overlayNode } = usePortalRoots();
	const motionSettings = useChaseMotion();
	const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
	const overlayFade = resolveOverlayFade(motionSettings, resolvedOpen);
	const contentMotion = resolveOverlayMotion(motionSettings, resolvedOpen, {
		opacity: 1,
		scale: 1,
		y: 0
	}, {
		opacity: 0,
		scale: .96,
		y: 14
	}, void 0, "base");
	return /* @__PURE__ */ jsxs(AlertDialogPrimitive.Root, {
		open: resolvedOpen,
		onOpenChange: setResolvedOpen,
		children: [trigger ? /* @__PURE__ */ jsx(AlertDialogPrimitive.Trigger, {
			asChild: true,
			children: trigger
		}) : null, /* @__PURE__ */ jsxs(AlertDialogPrimitive.Portal, {
			container: overlayNode ?? void 0,
			children: [/* @__PURE__ */ jsx(AlertDialogPrimitive.Overlay, {
				forceMount: true,
				asChild: true,
				children: /* @__PURE__ */ jsx(motion.div, {
					initial: overlayFade.initial,
					animate: overlayFade.animate,
					transition: overlayFade.transition,
					className: "fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
				})
			}), /* @__PURE__ */ jsx(AlertDialogPrimitive.Content, {
				forceMount: true,
				asChild: true,
				children: /* @__PURE__ */ jsxs(motion.div, {
					initial: contentMotion.initial,
					animate: contentMotion.animate,
					transition: contentMotion.transition,
					className: "modern-surface fixed left-1/2 top-1/2 z-modal w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-tokenXl border border-muted p-5 shadow-overlay",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "space-y-3",
						children: [
							/* @__PURE__ */ jsx("div", {
								className: "inline-flex h-10 w-10 items-center justify-center rounded-full bg-background",
								children: /* @__PURE__ */ jsx(Icon, {
									name: toneIcon(tone),
									size: "sm",
									tone
								})
							}),
							/* @__PURE__ */ jsx(AlertDialogPrimitive.Title, {
								className: "font-heading text-xl font-semibold text-foreground",
								children: title
							}),
							description ? /* @__PURE__ */ jsx(AlertDialogPrimitive.Description, {
								className: "text-sm text-secondary",
								children: description
							}) : null
						]
					}), /* @__PURE__ */ jsxs("div", {
						className: "mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end",
						children: [/* @__PURE__ */ jsx(AlertDialogPrimitive.Cancel, {
							asChild: true,
							children: /* @__PURE__ */ jsx(Button, {
								tone: "secondary",
								children: cancelLabel
							})
						}), /* @__PURE__ */ jsx(AlertDialogPrimitive.Action, {
							asChild: true,
							children: /* @__PURE__ */ jsx(Button, {
								tone: tone === "danger" ? "danger" : "primary",
								onClick: onConfirm,
								children: confirmLabel
							})
						})]
					})]
				})
			})]
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/popover.tsx
function Popover({ trigger, title, children }) {
	const { overlayNode } = usePortalRoots();
	const motionSettings = useChaseMotion();
	const [open, setOpen] = useState(false);
	const motionProps = resolveOverlayMotion(motionSettings, open, {
		opacity: 1,
		y: 0,
		scale: 1
	}, {
		opacity: 0,
		y: 8,
		scale: .98
	});
	return /* @__PURE__ */ jsxs(PopoverPrimitive.Root, {
		open,
		onOpenChange: setOpen,
		children: [/* @__PURE__ */ jsx(PopoverPrimitive.Trigger, {
			asChild: true,
			children: trigger
		}), /* @__PURE__ */ jsx(PopoverPrimitive.Portal, {
			container: overlayNode ?? void 0,
			children: /* @__PURE__ */ jsx(PopoverPrimitive.Content, {
				sideOffset: 8,
				forceMount: true,
				asChild: true,
				children: /* @__PURE__ */ jsxs(motion.div, {
					initial: motionProps.initial,
					animate: motionProps.animate,
					transition: motionProps.transition,
					className: "modern-surface z-popover w-[min(90vw,22rem)] rounded-tokenLg border border-muted p-4 shadow-overlay",
					children: [title ? /* @__PURE__ */ jsx("div", {
						className: "mb-2 text-sm font-semibold text-foreground",
						children: title
					}) : null, children]
				})
			})
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/tooltip.tsx
function Tooltip({ content, children }) {
	const { overlayNode } = usePortalRoots();
	const motionSettings = useChaseMotion();
	const [open, setOpen] = useState(false);
	const motionProps = resolveOverlayMotion(motionSettings, open, {
		opacity: 1,
		y: 0
	}, {
		opacity: 0,
		y: 6
	});
	return /* @__PURE__ */ jsx(TooltipPrimitive.Provider, {
		delayDuration: 150,
		children: /* @__PURE__ */ jsxs(TooltipPrimitive.Root, {
			open,
			onOpenChange: setOpen,
			children: [/* @__PURE__ */ jsx(TooltipPrimitive.Trigger, {
				asChild: true,
				children
			}), /* @__PURE__ */ jsx(TooltipPrimitive.Portal, {
				container: overlayNode ?? void 0,
				children: /* @__PURE__ */ jsx(TooltipPrimitive.Content, {
					sideOffset: 8,
					forceMount: true,
					asChild: true,
					children: /* @__PURE__ */ jsxs(motion.div, {
						initial: motionProps.initial,
						animate: motionProps.animate,
						transition: motionProps.transition,
						className: "z-popover rounded-tokenMd bg-foreground px-3 py-2 text-xs font-medium text-inverse shadow-overlay",
						children: [content, /* @__PURE__ */ jsx(TooltipPrimitive.Arrow, { className: "fill-foreground" })]
					})
				})
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/menu.tsx
function renderMenuItem(item) {
	return /* @__PURE__ */ jsxs(DropdownMenuPrimitive.Item, {
		disabled: item.disabled,
		className: cx("focus-ring flex cursor-pointer select-none items-start gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none data-[highlighted]:bg-background data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50", item.destructive ? "text-danger" : "text-foreground"),
		onSelect: item.onSelect,
		children: [
			item.icon ? /* @__PURE__ */ jsx(Icon, {
				name: item.icon,
				size: "sm",
				tone: item.destructive ? "danger" : "secondary"
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				className: "flex-1 space-y-0.5",
				children: [/* @__PURE__ */ jsx("div", {
					className: "font-medium",
					children: item.label
				}), item.description ? /* @__PURE__ */ jsx("div", {
					className: "text-xs text-secondary",
					children: item.description
				}) : null]
			}),
			item.shortcut ? /* @__PURE__ */ jsx("span", {
				className: "ml-auto text-xs text-secondary",
				children: item.shortcut
			}) : null
		]
	}, item.key);
}
function Menu({ trigger, items, groups }) {
	const { overlayNode } = usePortalRoots();
	const motionSettings = useChaseMotion();
	const [open, setOpen] = useState(false);
	const motionProps = resolveOverlayMotion(motionSettings, open, {
		opacity: 1,
		y: 0,
		scale: 1
	}, {
		opacity: 0,
		y: 10,
		scale: .98
	});
	return /* @__PURE__ */ jsxs(DropdownMenuPrimitive.Root, {
		open,
		onOpenChange: setOpen,
		children: [/* @__PURE__ */ jsx(DropdownMenuPrimitive.Trigger, {
			asChild: true,
			children: trigger
		}), /* @__PURE__ */ jsx(DropdownMenuPrimitive.Portal, {
			container: overlayNode ?? void 0,
			children: /* @__PURE__ */ jsx(DropdownMenuPrimitive.Content, {
				sideOffset: 8,
				forceMount: true,
				asChild: true,
				children: /* @__PURE__ */ jsx(motion.div, {
					initial: motionProps.initial,
					animate: motionProps.animate,
					transition: motionProps.transition,
					className: "modern-surface z-dropdown min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay",
					children: groups ? groups.map((group, groupIndex) => /* @__PURE__ */ jsxs(DropdownMenuPrimitive.Group, { children: [
						group.label ? /* @__PURE__ */ jsx(DropdownMenuPrimitive.Label, {
							className: "px-3 py-2 text-xs font-semibold uppercase tracking-wide text-secondary",
							children: group.label
						}) : null,
						group.items.map(renderMenuItem),
						groupIndex < groups.length - 1 ? /* @__PURE__ */ jsx(DropdownMenuPrimitive.Separator, { className: "my-1 h-px bg-muted" }) : null
					] }, groupIndex)) : items?.map(renderMenuItem)
				})
			})
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/toast.tsx
function ToastRegionItem({ item }) {
	const motionSettings = useChaseMotion();
	const [internalOpen, setInternalOpen] = useState(item.open ?? true);
	const resolvedOpen = item.open ?? internalOpen;
	const motionProps = resolveOverlayMotion(motionSettings, resolvedOpen, {
		opacity: 1,
		y: 0,
		scale: 1
	}, {
		opacity: 0,
		y: 16,
		scale: .98
	}, void 0, "base");
	function handleOpenChange(nextOpen) {
		if (item.open === void 0) setInternalOpen(nextOpen);
		item.onOpenChange?.(nextOpen);
	}
	return /* @__PURE__ */ jsx(ToastPrimitive.Root, {
		forceMount: true,
		open: resolvedOpen,
		onOpenChange: handleOpenChange,
		className: "modern-surface rounded-tokenLg border border-muted shadow-overlay",
		children: resolvedOpen ? /* @__PURE__ */ jsxs(motion.div, {
			layout: true,
			initial: motionProps.initial,
			animate: motionProps.animate,
			transition: motionProps.transition,
			className: "grid grid-cols-[auto_1fr_auto] items-start gap-3 p-4",
			children: [
				/* @__PURE__ */ jsx("div", {
					className: "inline-flex h-10 w-10 items-center justify-center rounded-full bg-background",
					children: /* @__PURE__ */ jsx(Icon, {
						name: toneIcon(item.tone ?? "info"),
						size: "sm",
						tone: item.tone ?? "info"
					})
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "min-w-0 space-y-1",
					children: [/* @__PURE__ */ jsx(ToastPrimitive.Title, {
						className: "text-sm font-semibold text-foreground",
						children: item.title
					}), item.description ? /* @__PURE__ */ jsx(ToastPrimitive.Description, {
						className: "text-sm text-secondary",
						children: item.description
					}) : null]
				}),
				/* @__PURE__ */ jsx("div", {
					className: "self-start",
					children: /* @__PURE__ */ jsx(ToastPrimitive.Close, {
						asChild: true,
						children: /* @__PURE__ */ jsx(IconButton, {
							label: item.dismissLabel ?? "Dismiss notification",
							icon: "close",
							tone: "ghost",
							size: "sm"
						})
					})
				})
			]
		}) : null
	});
}
function ToastRegion({ items }) {
	const { toastNode } = usePortalRoots();
	const viewport = /* @__PURE__ */ jsx(ToastPrimitive.Viewport, { className: "fixed inset-x-0 bottom-0 z-toast mx-auto flex w-full max-w-md flex-col gap-3 p-4 outline-none" });
	return /* @__PURE__ */ jsxs(ToastPrimitive.Provider, {
		duration: 4e3,
		swipeDirection: "right",
		children: [items.map((item) => /* @__PURE__ */ jsx(ToastRegionItem, { item }, item.id)), toastNode ? createPortal(viewport, toastNode) : viewport]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/loading.tsx
function LoadingSpinner({ label = "Loading", size = "md", ...rest }) {
	const sizeClass = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-8 w-8" : "h-6 w-6";
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "inline-flex items-center gap-2 text-secondary",
		children: [/* @__PURE__ */ jsx("span", {
			"aria-hidden": "true",
			className: cx("inline-flex animate-spin rounded-full border-2 border-muted border-t-accent", sizeClass)
		}), /* @__PURE__ */ jsx("span", {
			className: "text-sm",
			children: label
		})]
	});
}
function ProgressBar({ value, max = 100, tone = "accent", formatLabel = (p) => `${Math.round(p)}%`, ...rest }) {
	const percentage = Math.max(0, Math.min(100, value / max * 100));
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "space-y-2",
		children: [/* @__PURE__ */ jsx("div", {
			className: "h-2 w-full overflow-hidden rounded-full bg-muted",
			children: /* @__PURE__ */ jsx("div", {
				className: cx("h-full rounded-full transition-all", tone === "accent" && "bg-accent", tone === "success" && "bg-success", tone === "warning" && "bg-warning", tone === "danger" && "bg-danger", tone === "info" && "bg-info"),
				style: { width: `${percentage}%` }
			})
		}), /* @__PURE__ */ jsx("div", {
			className: "text-xs text-secondary",
			children: formatLabel(percentage)
		})]
	});
}
function Skeleton({ height = "md", ...rest }) {
	const heightClass = height === "sm" ? "h-4" : height === "lg" ? "h-24" : "h-12";
	return /* @__PURE__ */ jsx("div", {
		...rest,
		"aria-hidden": "true",
		className: cx("w-full animate-pulse rounded-tokenMd bg-muted", heightClass)
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/empty-state.tsx
function EmptyState({ title, description, actions, icon = "spark", ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: "rounded-tokenLg border border-dashed border-muted bg-background p-6 text-center",
		children: /* @__PURE__ */ jsxs("div", {
			className: "mx-auto flex max-w-sm flex-col items-center gap-4",
			children: [
				/* @__PURE__ */ jsx("div", {
					className: "inline-flex h-14 w-14 items-center justify-center rounded-full bg-elevated shadow-tokenSm",
					children: /* @__PURE__ */ jsx(Icon, {
						name: icon,
						size: "lg",
						tone: "accent"
					})
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-2",
					children: [/* @__PURE__ */ jsx("div", {
						className: "font-heading text-xl font-semibold text-foreground",
						children: title
					}), description ? /* @__PURE__ */ jsx("div", {
						className: "text-sm text-secondary",
						children: description
					}) : null]
				}),
				actions ? /* @__PURE__ */ jsx("div", {
					className: "flex flex-wrap justify-center gap-2",
					children: actions
				}) : null
			]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/rating.tsx
function Rating({ value, max = 5, size = "md", interactive = false, onValueChange, label = "Rating", ...rest }) {
	const stars = Array.from({ length: max }, (_, i) => {
		const position = i + 1;
		const filled = value >= position;
		const half = !filled && value >= position - .5;
		const iconName = filled ? "star" : half ? "starHalf" : "starEmpty";
		if (interactive) return /* @__PURE__ */ jsx("button", {
			type: "button",
			role: "radio",
			"aria-checked": value === position,
			"aria-label": `${position} of ${max}`,
			className: "focus-ring rounded-sm text-warning",
			onClick: () => onValueChange?.(position),
			children: /* @__PURE__ */ jsx(Icon, {
				name: iconName,
				size,
				tone: "warning"
			})
		}, position);
		return /* @__PURE__ */ jsx(Icon, {
			name: iconName,
			size,
			tone: "warning"
		}, position);
	});
	return /* @__PURE__ */ jsx("div", {
		...rest,
		role: interactive ? "radiogroup" : void 0,
		"aria-label": label,
		className: "inline-flex items-center gap-0.5",
		children: stars
	});
}
//#endregion
//#region ../../packages/design-system/src/components/feedback/accordion.tsx
var AnimatedAccordionContent = forwardRef(function AnimatedAccordionContent({ children, ...rest }, ref) {
	const motionSettings = useChaseMotion();
	const isOpen = rest["data-state"] === "open";
	return /* @__PURE__ */ jsx(motion.div, {
		...rest,
		ref,
		initial: false,
		animate: motionSettings.reducedMotion ? void 0 : isOpen ? {
			height: "auto",
			opacity: 1
		} : {
			height: 0,
			opacity: 0
		},
		transition: motionSettings.reducedMotion ? void 0 : {
			duration: motionSettings.durations.base,
			ease: motionSettings.easing
		},
		children
	});
});
function Accordion({ items, type = "single", defaultValue, collapsible = true, ...rest }) {
	const rootProps = type === "multiple" ? {
		type: "multiple",
		defaultValue: Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : void 0
	} : {
		type: "single",
		collapsible,
		defaultValue: typeof defaultValue === "string" ? defaultValue : void 0
	};
	return /* @__PURE__ */ jsx(AccordionPrimitive.Root, {
		...rootProps,
		...rest,
		className: "modern-surface rounded-tokenLg border border-muted shadow-tokenSm",
		children: items.map((item, index) => /* @__PURE__ */ jsxs(AccordionPrimitive.Item, {
			value: item.value,
			className: cx("border-muted", index < items.length - 1 && "border-b"),
			children: [/* @__PURE__ */ jsx(AccordionPrimitive.Header, { children: /* @__PURE__ */ jsxs(AccordionPrimitive.Trigger, {
				className: "focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-background [&[data-state=open]>span]:rotate-180",
				children: [/* @__PURE__ */ jsx("span", {
					className: "flex-1",
					children: item.trigger
				}), /* @__PURE__ */ jsx("span", {
					className: "inline-flex shrink-0 transition-transform duration-200",
					children: /* @__PURE__ */ jsx(Icon, {
						name: "chevronDown",
						size: "sm",
						tone: "secondary"
					})
				})]
			}) }), /* @__PURE__ */ jsx(AccordionPrimitive.Content, {
				forceMount: true,
				asChild: true,
				children: /* @__PURE__ */ jsx(AnimatedAccordionContent, {
					className: "overflow-hidden",
					children: /* @__PURE__ */ jsx("div", {
						className: "px-4 pb-4 text-sm text-secondary",
						children: item.content
					})
				})
			})]
		}, item.value))
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/data-table.tsx
var skeletonWidths = [
	"w-3/4",
	"w-1/2",
	"w-2/3",
	"w-5/6",
	"w-2/5"
];
function DataTable({ rows, columns, mobileMode = "stack", getRowId, emptyTitle = "Nothing to review", emptyDescription = "Adjust filters or add new records to populate this view.", sortKey, sortDirection, onSortChange, selectedKeys, onSelectionChange, loading = false, loadingRows = 5, ...rest }) {
	const density = useDensity();
	const cellPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";
	const headPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";
	if (!loading && rows.length === 0) return /* @__PURE__ */ jsx(EmptyState, {
		title: emptyTitle,
		description: emptyDescription
	});
	const selectable = selectedKeys !== void 0 && onSelectionChange !== void 0;
	const allIds = selectable ? rows.map((row, index) => getRowId ? getRowId(row, index) : String(index)) : [];
	const allSelected = selectable && allIds.length > 0 && allIds.every((id) => selectedKeys.has(id));
	function handleSortClick(column) {
		if (!column.sortable || !onSortChange) return;
		const nextDirection = sortKey === column.key && sortDirection === "asc" ? "desc" : "asc";
		onSortChange(column.key, nextDirection);
	}
	function handleSelectAll() {
		if (!onSelectionChange) return;
		if (allSelected) onSelectionChange(/* @__PURE__ */ new Set());
		else onSelectionChange(new Set(allIds));
	}
	function handleSelectRow(id) {
		if (!onSelectionChange || !selectedKeys) return;
		const next = new Set(selectedKeys);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onSelectionChange(next);
	}
	function renderSortIndicator(column) {
		if (!column.sortable) return null;
		if (sortKey !== column.key) return /* @__PURE__ */ jsx(Icon, {
			name: "chevronDown",
			size: "sm",
			tone: "secondary"
		});
		return /* @__PURE__ */ jsx(Icon, {
			name: sortDirection === "asc" ? "chevronUp" : "chevronDown",
			size: "sm",
			tone: "accent"
		});
	}
	const table = /* @__PURE__ */ jsx("div", {
		className: "modern-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm",
		children: /* @__PURE__ */ jsxs("table", {
			className: "min-w-full border-collapse text-left text-sm",
			children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", {
				className: "border-b border-muted bg-background",
				children: [selectable ? /* @__PURE__ */ jsx("th", {
					className: cx("w-12", headPad),
					children: /* @__PURE__ */ jsx("input", {
						type: "checkbox",
						checked: allSelected,
						onChange: handleSelectAll,
						"aria-label": "Select all rows",
						className: "h-4 w-4 rounded border-border accent-accent"
					})
				}) : null, columns.map((column) => /* @__PURE__ */ jsx("th", {
					className: cx(headPad, "font-semibold text-foreground", column.align === "right" && "text-right"),
					children: column.sortable ? /* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "inline-flex items-center gap-1 hover:text-accent",
						onClick: () => handleSortClick(column),
						children: [column.header, renderSortIndicator(column)]
					}) : column.header
				}, column.key))]
			}) }), /* @__PURE__ */ jsx("tbody", { children: loading ? Array.from({ length: loadingRows }, (_, i) => /* @__PURE__ */ jsxs("tr", {
				className: "border-b border-muted last:border-b-0",
				children: [selectable ? /* @__PURE__ */ jsx("td", { className: cx("w-12", cellPad) }) : null, columns.map((column, colIndex) => /* @__PURE__ */ jsx("td", {
					className: cellPad,
					children: /* @__PURE__ */ jsx("div", {
						"aria-hidden": "true",
						className: cx("h-4 animate-pulse rounded-tokenSm bg-muted", skeletonWidths[(i + colIndex) % skeletonWidths.length])
					})
				}, column.key))]
			}, `skeleton-${i}`)) : rows.map((row, index) => {
				const rowId = getRowId ? getRowId(row, index) : String(index);
				const isSelected = selectable && selectedKeys.has(rowId);
				return /* @__PURE__ */ jsxs("tr", {
					className: cx("border-b border-muted transition-colors last:border-b-0", isSelected ? "bg-background" : "hover:bg-background/60"),
					children: [selectable ? /* @__PURE__ */ jsx("td", {
						className: cx("w-12", cellPad),
						children: /* @__PURE__ */ jsx("input", {
							type: "checkbox",
							checked: isSelected,
							onChange: () => handleSelectRow(rowId),
							"aria-label": `Select row ${rowId}`,
							className: "h-4 w-4 rounded border-border accent-accent"
						})
					}) : null, columns.map((column) => /* @__PURE__ */ jsx("td", {
						className: cx(cellPad, "text-foreground", column.align === "right" && "text-right"),
						children: column.cell(row)
					}, column.key))]
				}, rowId);
			}) })]
		})
	});
	const cards = /* @__PURE__ */ jsx("div", {
		role: "list",
		className: "space-y-3 md:hidden",
		children: loading ? Array.from({ length: loadingRows }, (_, i) => /* @__PURE__ */ jsx("div", {
			className: "modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
			children: /* @__PURE__ */ jsx("div", {
				className: "space-y-3",
				children: columns.map((column, colIndex) => /* @__PURE__ */ jsxs("div", {
					className: "flex items-start justify-between gap-4",
					children: [/* @__PURE__ */ jsx("div", {
						className: "h-3 w-16 animate-pulse rounded-tokenSm bg-muted",
						"aria-hidden": "true"
					}), /* @__PURE__ */ jsx("div", {
						"aria-hidden": "true",
						className: cx("h-4 animate-pulse rounded-tokenSm bg-muted", skeletonWidths[(i + colIndex) % skeletonWidths.length])
					})]
				}, column.key))
			})
		}, `skeleton-card-${i}`)) : rows.map((row, rowIndex) => /* @__PURE__ */ jsx("div", {
			role: "listitem",
			className: "modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
			children: /* @__PURE__ */ jsx("div", {
				className: "space-y-3",
				children: columns.map((column) => /* @__PURE__ */ jsxs("div", {
					className: "flex items-start justify-between gap-4",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-xs font-semibold uppercase tracking-wide text-secondary",
						children: column.mobileLabel ?? column.header
					}), /* @__PURE__ */ jsx("div", {
						className: cx("max-w-[60%] text-right text-sm text-foreground", column.align === "left" && "text-left"),
						children: column.cell(row)
					})]
				}, column.key))
			})
		}, getRowId ? getRowId(row, rowIndex) : String(rowIndex)))
	});
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		children: [mobileMode === "stack" ? cards : null, /* @__PURE__ */ jsx("div", {
			className: mobileMode === "stack" ? "hidden md:block" : "block",
			children: table
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/key-value-list.tsx
function KeyValueList({ items, ...rest }) {
	return /* @__PURE__ */ jsx("dl", {
		...rest,
		className: "modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm",
		children: items.map((item, index) => /* @__PURE__ */ jsxs("div", {
			className: "flex items-start justify-between gap-4 border-b border-muted pb-3 last:border-b-0 last:pb-0",
			children: [/* @__PURE__ */ jsx("dt", {
				className: "text-xs font-semibold uppercase tracking-wide text-secondary",
				children: item.key
			}), /* @__PURE__ */ jsx("dd", {
				className: "text-sm text-foreground",
				children: item.value
			})]
		}, index))
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/stat.tsx
function Stat({ label, value, trend, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "text-xs font-semibold uppercase tracking-wide text-secondary",
				children: label
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mt-2 font-heading text-3xl font-semibold text-foreground",
				children: value
			}),
			trend ? /* @__PURE__ */ jsx("div", {
				className: "mt-2 text-sm text-secondary",
				children: trend
			}) : null
		]
	});
}
function StatGrid({ columns = {
	base: 1,
	sm: 2
}, children, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("grid gap-4", resolveColumnsClass(columns)),
		children
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/timeline.tsx
function Timeline({ items, ...rest }) {
	return /* @__PURE__ */ jsx("ol", {
		...rest,
		className: "modern-surface space-y-4 rounded-tokenLg border border-muted p-4 shadow-tokenSm",
		children: items.map((item, index) => /* @__PURE__ */ jsxs("li", {
			className: "flex gap-3",
			children: [/* @__PURE__ */ jsx("span", { className: "mt-1 inline-flex h-3 w-3 shrink-0 rounded-full bg-accent" }), /* @__PURE__ */ jsxs("div", {
				className: "space-y-1",
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "text-sm font-semibold text-foreground",
						children: item.title
					}),
					item.description ? /* @__PURE__ */ jsx("div", {
						className: "text-sm text-secondary",
						children: item.description
					}) : null,
					item.timestamp ? /* @__PURE__ */ jsx("div", {
						className: "text-xs text-secondary",
						children: item.timestamp
					}) : null
				]
			})]
		}, index))
	});
}
function ActivityList({ items, ...rest }) {
	return /* @__PURE__ */ jsx("ul", {
		...rest,
		className: "modern-surface space-y-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm",
		children: items.map((item, index) => /* @__PURE__ */ jsx("li", {
			className: "rounded-tokenMd bg-background px-4 py-3",
			children: /* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center justify-between gap-3",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "space-y-1",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-sm font-semibold text-foreground",
						children: item.title
					}), item.description ? /* @__PURE__ */ jsx("div", {
						className: "text-sm text-secondary",
						children: item.description
					}) : null]
				}), /* @__PURE__ */ jsxs("div", {
					className: "text-xs text-secondary",
					children: [
						item.actor,
						item.actor && item.timestamp ? " • " : null,
						item.timestamp
					]
				})]
			})
		}, index))
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/card.tsx
function Card({ children, media, interactive = false, ...rest }) {
	const motionSettings = useChaseMotion();
	const interactiveMotion = interactive && !motionSettings.reducedMotion ? {
		whileHover: {
			y: motionSettings.interactiveLift,
			scale: motionSettings.interactiveScale
		},
		whileTap: {
			y: 0,
			scale: .99
		},
		transition: {
			duration: motionSettings.durations.base,
			ease: motionSettings.easing
		}
	} : void 0;
	const nativeProps = rest;
	return /* @__PURE__ */ jsx(motion.div, {
		...nativeProps,
		...interactiveMotion,
		className: cx("modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm", interactive && "cursor-pointer transition hover:border-accent hover:shadow-tokenMd", !media && "p-4"),
		children: media ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", { children: media }), /* @__PURE__ */ jsx("div", {
			className: "p-4",
			children
		})] }) : children
	});
}
function DetailPanel({ title, actions, children, ...rest }) {
	return /* @__PURE__ */ jsxs(Card, {
		...rest,
		children: [/* @__PURE__ */ jsxs("div", {
			className: "mb-4 flex flex-wrap items-center justify-between gap-3",
			children: [/* @__PURE__ */ jsx("div", {
				className: "font-heading text-lg font-semibold text-foreground",
				children: title
			}), actions ? /* @__PURE__ */ jsx("div", {
				className: "flex flex-wrap gap-2",
				children: actions
			}) : null]
		}), children != null ? /* @__PURE__ */ jsx("div", {
			className: "space-y-4",
			children
		}) : null]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/filter.tsx
function FilterBar({ children, actions, stickyOffset, ...rest }) {
	const motionSettings = useChaseMotion();
	const nativeProps = rest;
	return /* @__PURE__ */ jsxs(motion.div, {
		...nativeProps,
		initial: motionSettings.reducedMotion ? false : {
			opacity: 0,
			y: 10
		},
		animate: motionSettings.reducedMotion ? void 0 : {
			opacity: 1,
			y: 0
		},
		transition: motionSettings.reducedMotion ? void 0 : {
			duration: motionSettings.durations.base,
			ease: motionSettings.easing
		},
		style: stickyOffset ? { top: stickyOffset } : void 0,
		className: cx("modern-surface sticky z-sticky flex flex-col gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm md:flex-row md:items-center md:justify-between", !stickyOffset && "top-16"),
		children: [/* @__PURE__ */ jsx("div", {
			className: "flex flex-1 flex-wrap gap-3",
			children
		}), actions ? /* @__PURE__ */ jsx("div", {
			className: "flex flex-wrap gap-2",
			children: actions
		}) : null]
	});
}
function FilterDrawer({ trigger, children, title = "Filters", applyLabel = "Apply filters", ...rest }) {
	return /* @__PURE__ */ jsx(Drawer, {
		...rest,
		trigger,
		title,
		footer: /* @__PURE__ */ jsx(Button, {
			tone: "primary",
			block: true,
			children: applyLabel
		}),
		children: /* @__PURE__ */ jsx("div", {
			className: "space-y-4",
			children
		})
	});
}
function BulkActionBar({ count, actions, formatSelectedLabel = (n) => `${n} item${n === 1 ? "" : "s"} selected`, ...rest }) {
	const motionSettings = useChaseMotion();
	const nativeProps = rest;
	return /* @__PURE__ */ jsxs(motion.div, {
		...nativeProps,
		initial: motionSettings.reducedMotion ? false : {
			opacity: 0,
			y: 14
		},
		animate: motionSettings.reducedMotion ? void 0 : {
			opacity: 1,
			y: 0
		},
		transition: motionSettings.reducedMotion ? void 0 : {
			duration: motionSettings.durations.base,
			ease: motionSettings.easing
		},
		className: "modern-surface sticky bottom-20 z-sticky flex flex-col gap-3 rounded-tokenLg border border-accent p-4 shadow-overlay md:bottom-4 md:flex-row md:items-center md:justify-between",
		children: [/* @__PURE__ */ jsx("div", {
			className: "text-sm font-semibold text-foreground",
			children: formatSelectedLabel(count)
		}), actions ? /* @__PURE__ */ jsx("div", {
			className: "flex flex-wrap gap-2",
			children: actions
		}) : null]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/image-gallery.tsx
function parseAspectRatio(value) {
	const parts = value.split("/");
	if (parts.length === 2) {
		const width = Number(parts[0]);
		const height = Number(parts[1]);
		if (width > 0 && height > 0) return width / height;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}
function ImageGallery({ images, aspectRatio = "3/4", emptyState, maxHeightClassName, ...rest }) {
	const [activeIndex, setActiveIndex] = useState(0);
	const active = images[activeIndex];
	const galleryStyle = {
		aspectRatio,
		"--gallery-aspect-ratio": String(parseAspectRatio(aspectRatio))
	};
	const frameClassName = cx("modern-surface overflow-hidden rounded-tokenLg border border-muted", maxHeightClassName ? cx(maxHeightClassName, "lg:h-[var(--gallery-max-height)]", "lg:w-[min(100%,calc(var(--gallery-max-height)*var(--gallery-aspect-ratio)))]", "lg:max-w-full") : "");
	if (images.length === 0) {
		if (!emptyState) return null;
		return /* @__PURE__ */ jsx("div", {
			...rest,
			className: "space-y-3",
			children: /* @__PURE__ */ jsx("div", {
				className: cx(frameClassName, "flex items-center justify-center p-6 shadow-tokenSm"),
				style: galleryStyle,
				children: emptyState
			})
		});
	}
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "space-y-3",
		children: [/* @__PURE__ */ jsx("div", {
			className: frameClassName,
			style: galleryStyle,
			children: active ? /* @__PURE__ */ jsx("img", {
				src: active.src,
				alt: active.alt,
				className: "h-full w-full object-contain"
			}) : null
		}), images.length > 1 ? /* @__PURE__ */ jsx("div", {
			className: "flex gap-2 overflow-x-auto",
			children: images.map((image, index) => /* @__PURE__ */ jsx("button", {
				type: "button",
				onClick: () => setActiveIndex(index),
				className: cx("focus-ring h-16 w-16 shrink-0 overflow-hidden rounded-tokenMd border transition", index === activeIndex ? "border-accent shadow-tokenSm" : "border-muted hover:border-accent"),
				children: /* @__PURE__ */ jsx("img", {
					src: image.src,
					alt: image.alt,
					className: "h-full w-full object-cover"
				})
			}, index))
		}) : null]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/shared.tsx
var controlClass = "focus-ring touch-target w-full rounded-tokenMd border border-border bg-elevated px-4 py-3 text-sm text-foreground shadow-tokenSm placeholder:text-secondary transition duration-150 disabled:cursor-not-allowed disabled:opacity-60";
function fieldHintId(inputId) {
	return inputId ? `${inputId}-hint` : void 0;
}
function FieldChrome({ label, description, error, required = false, hideLabel = false, htmlFor, children, ...rest }) {
	const hintId = fieldHintId(htmlFor);
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "space-y-2",
		children: [
			label ? /* @__PURE__ */ jsxs("label", {
				htmlFor,
				className: cx("block text-sm font-medium text-foreground", hideLabel && "sr-only"),
				children: [label, required ? /* @__PURE__ */ jsx("span", {
					className: "ml-1 text-accent",
					children: "*"
				}) : null]
			}) : null,
			children,
			error ? /* @__PURE__ */ jsx("div", {
				id: hintId,
				role: "alert",
				className: "text-xs font-medium text-danger",
				children: error
			}) : description ? /* @__PURE__ */ jsx("div", {
				id: hintId,
				className: "text-xs text-secondary",
				children: description
			}) : null
		]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/field.tsx
function Field(props) {
	return /* @__PURE__ */ jsx(FieldChrome, { ...props });
}
function HelperText({ children, tone = "default", ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("text-xs", tone === "default" && "text-secondary", tone === "danger" && "text-danger", tone === "success" && "text-success"),
		children
	});
}
function InlineMessage({ children, icon = "info", tone = "default", ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: cx("flex items-start gap-2 rounded-tokenMd border px-3 py-2 text-sm", tone === "default" && "border-info bg-background text-info", tone === "danger" && "border-danger bg-background text-danger", tone === "success" && "border-success bg-background text-success"),
		children: [/* @__PURE__ */ jsx(Icon, {
			name: icon,
			size: "sm",
			tone: tone === "default" ? "info" : tone
		}), /* @__PURE__ */ jsx("span", { children })]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/fieldset.tsx
function Fieldset({ legend, description, children, ...rest }) {
	return /* @__PURE__ */ jsxs("fieldset", {
		...rest,
		className: "modern-surface space-y-4 rounded-tokenLg border border-muted p-4",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "space-y-1",
			children: [/* @__PURE__ */ jsx("legend", {
				className: "text-sm font-semibold text-foreground",
				children: legend
			}), description ? /* @__PURE__ */ jsx("div", {
				className: "text-xs text-secondary",
				children: description
			}) : null]
		}), children]
	});
}
function FormSection({ title, description, children, ...rest }) {
	return /* @__PURE__ */ jsxs("section", {
		...rest,
		className: "modern-surface space-y-4 rounded-tokenLg border border-muted p-4 shadow-tokenSm",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "space-y-1",
			children: [/* @__PURE__ */ jsx("h3", {
				className: "font-heading text-lg font-semibold text-foreground",
				children: title
			}), description ? /* @__PURE__ */ jsx("div", {
				className: "text-sm text-secondary",
				children: description
			}) : null]
		}), children]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/text-input.tsx
function TextInput({ id, label, description, error, required, hideLabel, type = "text", ...rest }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsx("input", {
			...rest,
			id: inputId,
			required,
			type,
			"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
			"aria-invalid": !!error || void 0,
			className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30")
		})
	});
}
function NumberInput(props) {
	return /* @__PURE__ */ jsx(TextInput, {
		...props,
		type: "number",
		inputMode: "numeric"
	});
}
function CurrencyInput({ id, label, description, error, required, hideLabel, currencySymbol = "$", ...rest }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs("div", {
			className: "relative",
			children: [/* @__PURE__ */ jsx("span", {
				className: "pointer-events-none absolute inset-y-0 left-4 flex items-center text-secondary",
				children: currencySymbol
			}), /* @__PURE__ */ jsx("input", {
				...rest,
				id: inputId,
				required,
				type: "number",
				inputMode: "decimal",
				"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
				"aria-invalid": !!error || void 0,
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "pl-8")
			})]
		})
	});
}
function SearchInput({ id, label = "Search", description, error, required, hideLabel, ...rest }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs("div", {
			className: "relative",
			children: [/* @__PURE__ */ jsx("span", {
				className: "pointer-events-none absolute inset-y-0 left-4 flex items-center",
				children: /* @__PURE__ */ jsx(Icon, {
					name: "search",
					size: "sm",
					tone: "secondary"
				})
			}), /* @__PURE__ */ jsx("input", {
				...rest,
				id: inputId,
				required,
				type: "search",
				"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
				"aria-invalid": !!error || void 0,
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "pl-10")
			})]
		})
	});
}
function DateInput(props) {
	return /* @__PURE__ */ jsx(TextInput, {
		...props,
		type: "date"
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/textarea.tsx
function Textarea({ id, label, description, error, required, hideLabel, rows = 4, ...rest }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsx("textarea", {
			...rest,
			id: inputId,
			required,
			rows,
			"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
			"aria-invalid": !!error || void 0,
			className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "min-h-28 resize-y")
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/select.tsx
function Select({ label, description, error, required, hideLabel, items, value, defaultValue, onValueChange, placeholder = "Choose an option", disabled = false }) {
	const fallbackId = useId();
	const { overlayNode } = usePortalRoots();
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: fallbackId,
		children: /* @__PURE__ */ jsxs(SelectPrimitive.Root, {
			value,
			defaultValue,
			onValueChange,
			disabled,
			children: [/* @__PURE__ */ jsxs(SelectPrimitive.Trigger, {
				id: fallbackId,
				"aria-describedby": error || description ? fieldHintId(fallbackId) : void 0,
				"aria-invalid": !!error || void 0,
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "inline-flex items-center justify-between gap-2 text-left"),
				children: [/* @__PURE__ */ jsx(SelectPrimitive.Value, { placeholder }), /* @__PURE__ */ jsx(SelectPrimitive.Icon, { children: /* @__PURE__ */ jsx(Icon, {
					name: "chevronDown",
					size: "sm",
					tone: "secondary"
				}) })]
			}), /* @__PURE__ */ jsx(SelectPrimitive.Portal, {
				container: overlayNode ?? void 0,
				children: /* @__PURE__ */ jsx(SelectPrimitive.Content, {
					position: "popper",
					className: "modern-surface z-popover min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-tokenLg border border-muted shadow-overlay",
					children: /* @__PURE__ */ jsx(SelectPrimitive.Viewport, {
						className: "p-2",
						children: items.map((item) => /* @__PURE__ */ jsx(SelectPrimitive.Item, {
							value: item.value,
							disabled: item.disabled,
							className: "focus-ring relative flex cursor-pointer select-none items-center rounded-tokenMd px-3 py-2 text-sm text-foreground outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-background",
							children: /* @__PURE__ */ jsx(SelectPrimitive.ItemText, { children: /* @__PURE__ */ jsxs("div", {
								className: "space-y-0.5",
								children: [/* @__PURE__ */ jsx("div", { children: item.label }), item.description ? /* @__PURE__ */ jsx("div", {
									className: "text-xs text-secondary",
									children: item.description
								}) : null]
							}) })
						}, item.value))
					})
				})
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/combobox.tsx
function Combobox({ label, description, error, required, hideLabel, items, value, onValueChange, placeholder = "Search options", noMatchesLabel = "No matches" }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const triggerId = useId();
	const listboxId = useId();
	const searchId = useId();
	const selected = items.find((item) => item.value === value);
	const filtered = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
	const { overlayNode } = usePortalRoots();
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: triggerId,
		children: /* @__PURE__ */ jsxs(PopoverPrimitive.Root, {
			open,
			onOpenChange: setOpen,
			children: [/* @__PURE__ */ jsxs(PopoverPrimitive.Trigger, {
				id: triggerId,
				role: "combobox",
				"aria-expanded": open,
				"aria-controls": listboxId,
				"aria-haspopup": "listbox",
				"aria-describedby": error || description ? fieldHintId(triggerId) : void 0,
				"aria-invalid": !!error || void 0,
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "inline-flex items-center justify-between gap-2 text-left"),
				children: [/* @__PURE__ */ jsx("span", { children: selected?.label ?? placeholder }), /* @__PURE__ */ jsx(Icon, {
					name: "chevronDown",
					size: "sm",
					tone: "secondary"
				})]
			}), /* @__PURE__ */ jsx(PopoverPrimitive.Portal, {
				container: overlayNode ?? void 0,
				children: /* @__PURE__ */ jsx(PopoverPrimitive.Content, {
					sideOffset: 8,
					className: "modern-surface z-popover w-[var(--radix-popover-trigger-width)] rounded-tokenLg border border-muted p-3 shadow-overlay",
					children: /* @__PURE__ */ jsxs("div", {
						className: "space-y-3",
						children: [/* @__PURE__ */ jsx("input", {
							id: searchId,
							value: query,
							onChange: (event) => setQuery(event.target.value),
							placeholder,
							"aria-label": "Filter options",
							"aria-autocomplete": "list",
							"aria-controls": listboxId,
							className: controlClass
						}), /* @__PURE__ */ jsx("div", {
							id: listboxId,
							role: "listbox",
							"aria-label": typeof label === "string" ? label : "Options",
							className: "max-h-60 space-y-1 overflow-y-auto",
							children: filtered.length === 0 ? /* @__PURE__ */ jsx("div", {
								className: "rounded-tokenMd bg-background px-3 py-2 text-sm text-secondary",
								children: noMatchesLabel
							}) : filtered.map((item) => /* @__PURE__ */ jsxs("button", {
								type: "button",
								role: "option",
								"aria-selected": item.value === value,
								className: "focus-ring flex w-full items-center justify-between rounded-tokenMd px-3 py-2 text-left text-sm text-foreground hover:bg-background",
								onClick: () => {
									onValueChange?.(item.value);
									setOpen(false);
									setQuery("");
								},
								children: [/* @__PURE__ */ jsx("span", { children: item.label }), item.value === value ? /* @__PURE__ */ jsx(Icon, {
									name: "check",
									size: "sm",
									tone: "accent"
								}) : null]
							}, item.value))
						})]
					})
				})
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/checkbox.tsx
function Checkbox({ label, description, error, required, hideLabel, checked, defaultChecked, onCheckedChange, disabled = false }) {
	const inputId = useId();
	return /* @__PURE__ */ jsx(FieldChrome, {
		label: void 0,
		description: error ? void 0 : description,
		error,
		required,
		hideLabel,
		children: /* @__PURE__ */ jsxs("label", {
			htmlFor: inputId,
			className: "modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3",
			children: [/* @__PURE__ */ jsx(CheckboxPrimitive.Root, {
				id: inputId,
				checked,
				defaultChecked,
				onCheckedChange,
				disabled,
				className: "focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-elevated data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[disabled]:opacity-60",
				children: /* @__PURE__ */ jsx(CheckboxPrimitive.Indicator, { children: /* @__PURE__ */ jsx(Icon, {
					name: "check",
					size: "sm",
					tone: "inverse"
				}) })
			}), /* @__PURE__ */ jsxs("div", {
				className: "space-y-1",
				children: [label ? /* @__PURE__ */ jsxs("div", {
					className: "text-sm font-medium text-foreground",
					children: [label, required ? /* @__PURE__ */ jsx("span", {
						className: "ml-1 text-accent",
						children: "*"
					}) : null]
				}) : null, description ? /* @__PURE__ */ jsx("div", {
					className: "text-xs text-secondary",
					children: description
				}) : null]
			})]
		})
	});
}
function CheckboxGroup({ label, description, error, required, hideLabel, items, values, onValuesChange }) {
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		children: /* @__PURE__ */ jsx("div", {
			className: "space-y-2",
			children: items.map((item) => {
				const checked = values.includes(item.value);
				return /* @__PURE__ */ jsx(Checkbox, {
					label: item.label,
					description: item.description,
					checked,
					onCheckedChange: (state) => {
						const next = state ? [...values, item.value] : values.filter((entry) => entry !== item.value);
						onValuesChange?.(Array.from(new Set(next)));
					}
				}, item.value);
			})
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/radio-group.tsx
function RadioGroup({ label, description, error, required, hideLabel, items, value, defaultValue, onValueChange }) {
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		children: /* @__PURE__ */ jsx(RadioGroupPrimitive.Root, {
			value,
			defaultValue,
			onValueChange,
			className: "space-y-2",
			children: items.map((item) => /* @__PURE__ */ jsxs("label", {
				className: "modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3",
				children: [/* @__PURE__ */ jsx(RadioGroupPrimitive.Item, {
					value: item.value,
					className: "focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background",
					children: /* @__PURE__ */ jsx(RadioGroupPrimitive.Indicator, { className: "h-2.5 w-2.5 rounded-full bg-accent" })
				}), /* @__PURE__ */ jsxs("div", {
					className: "space-y-1",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-sm font-medium text-foreground",
						children: item.label
					}), item.description ? /* @__PURE__ */ jsx("div", {
						className: "text-xs text-secondary",
						children: item.description
					}) : null]
				})]
			}, item.value))
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/switch.tsx
function Switch({ label, description, error, required, hideLabel, checked, defaultChecked, onCheckedChange, disabled = false }) {
	const inputId = useId();
	return /* @__PURE__ */ jsx(FieldChrome, {
		label: void 0,
		description: error ? void 0 : description,
		error,
		required,
		hideLabel,
		children: /* @__PURE__ */ jsxs("label", {
			htmlFor: inputId,
			className: "modern-surface flex cursor-pointer items-center justify-between gap-4 rounded-tokenMd border border-muted p-3",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "space-y-1",
				children: [label ? /* @__PURE__ */ jsxs("div", {
					className: "text-sm font-medium text-foreground",
					children: [label, required ? /* @__PURE__ */ jsx("span", {
						className: "ml-1 text-accent",
						children: "*"
					}) : null]
				}) : null, description ? /* @__PURE__ */ jsx("div", {
					className: "text-xs text-secondary",
					children: description
				}) : null]
			}), /* @__PURE__ */ jsx(SwitchPrimitive.Root, {
				id: inputId,
				checked,
				defaultChecked,
				onCheckedChange,
				disabled,
				className: "focus-ring relative inline-flex h-7 w-12 items-center rounded-full bg-muted transition data-[state=checked]:bg-accent data-[disabled]:opacity-60",
				children: /* @__PURE__ */ jsx(SwitchPrimitive.Thumb, { className: "block h-5 w-5 translate-x-1 rounded-full bg-elevated shadow-tokenSm transition data-[state=checked]:translate-x-6" })
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/slider.tsx
function Slider({ label, description, error, required, hideLabel, value, defaultValue, onValueChange, min = 0, max = 100, step = 1 }) {
	const resolvedValue = value === void 0 ? void 0 : [value];
	const resolvedDefault = defaultValue === void 0 ? void 0 : [defaultValue];
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		children: /* @__PURE__ */ jsxs("div", {
			className: "modern-surface space-y-2 rounded-tokenMd border border-muted p-4",
			children: [/* @__PURE__ */ jsxs(SliderPrimitive.Root, {
				min,
				max,
				step,
				value: resolvedValue,
				defaultValue: resolvedDefault,
				onValueChange: (values) => onValueChange?.(values[0] ?? min),
				className: "relative flex h-6 w-full items-center",
				children: [/* @__PURE__ */ jsx(SliderPrimitive.Track, {
					className: "relative h-2 w-full rounded-full bg-muted",
					children: /* @__PURE__ */ jsx(SliderPrimitive.Range, { className: "absolute h-full rounded-full bg-accent" })
				}), /* @__PURE__ */ jsx(SliderPrimitive.Thumb, { className: "focus-ring block h-5 w-5 rounded-full border border-accent bg-elevated shadow-tokenSm" })]
			}), /* @__PURE__ */ jsxs("div", {
				className: "flex justify-between text-xs text-secondary",
				children: [
					/* @__PURE__ */ jsx("span", { children: min }),
					/* @__PURE__ */ jsx("span", { children: value ?? defaultValue ?? min }),
					/* @__PURE__ */ jsx("span", { children: max })
				]
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/file-dropzone.tsx
function FileDropzone({ id, label, description, error, required, hideLabel, accept, multiple = false, onFilesChange, dropLabel = "Drop files here", browseLabel = "or choose from your device" }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	const [dragging, setDragging] = useState(false);
	function handleDragOver(event) {
		event.preventDefault();
		event.stopPropagation();
		setDragging(true);
	}
	function handleDragLeave(event) {
		event.preventDefault();
		event.stopPropagation();
		setDragging(false);
	}
	function handleDrop(event) {
		event.preventDefault();
		event.stopPropagation();
		setDragging(false);
		onFilesChange?.(event.dataTransfer.files);
	}
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs("label", {
			htmlFor: inputId,
			onDragOver: handleDragOver,
			onDragEnter: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
			className: cx("flex cursor-pointer flex-col items-center justify-center gap-3 rounded-tokenLg border border-dashed bg-background px-4 py-8 text-center transition", dragging ? "border-accent bg-elevated" : "border-muted"),
			children: [
				/* @__PURE__ */ jsx(Icon, {
					name: "package",
					size: "lg",
					tone: "accent"
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "space-y-1",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-sm font-semibold text-foreground",
						children: dropLabel
					}), /* @__PURE__ */ jsx("div", {
						className: "text-xs text-secondary",
						children: browseLabel
					})]
				}),
				/* @__PURE__ */ jsx("input", {
					id: inputId,
					accept,
					multiple,
					required,
					type: "file",
					className: "sr-only",
					onChange: (event) => onFilesChange?.(event.target.files)
				})
			]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/tag-input.tsx
function TagInput({ label, description, error, required, hideLabel, values, onValuesChange, placeholder = "Add a tag…", maxTags }) {
	const [input, setInput] = useState("");
	const inputId = useId();
	function addTag(raw) {
		const tag = raw.trim();
		if (!tag) return;
		if (values.includes(tag)) return;
		if (maxTags !== void 0 && values.length >= maxTags) return;
		onValuesChange?.([...values, tag]);
		setInput("");
	}
	function removeTag(tag) {
		onValuesChange?.(values.filter((v) => v !== tag));
	}
	function handleKeyDown(event) {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			addTag(input);
		} else if (event.key === "Backspace" && input === "" && values.length > 0) removeTag(values[values.length - 1]);
	}
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs("div", {
			className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "flex flex-wrap gap-2 px-3 py-2"),
			children: [values.map((tag) => /* @__PURE__ */ jsxs("span", {
				className: "inline-flex items-center gap-1.5 rounded-full border border-muted bg-background px-2.5 py-0.5 text-xs font-semibold text-foreground",
				children: [/* @__PURE__ */ jsx("span", { children: tag }), /* @__PURE__ */ jsx("button", {
					type: "button",
					className: "focus-ring rounded-full",
					onClick: () => removeTag(tag),
					"aria-label": `Remove ${tag}`,
					children: /* @__PURE__ */ jsx(Icon, {
						name: "close",
						size: "sm",
						tone: "secondary"
					})
				})]
			}, tag)), /* @__PURE__ */ jsx("input", {
				id: inputId,
				value: input,
				onChange: (e) => setInput(e.target.value),
				onKeyDown: handleKeyDown,
				onBlur: () => addTag(input),
				placeholder: values.length === 0 ? placeholder : void 0,
				"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
				"aria-invalid": !!error || void 0,
				className: "min-w-20 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-secondary"
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/password-input.tsx
function PasswordInput({ showPasswordLabel = "Show password", hidePasswordLabel = "Hide password", id, label, description, error, required, hideLabel, ...rest }) {
	const [visible, setVisible] = useState(false);
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs("div", {
			className: "relative",
			children: [/* @__PURE__ */ jsx("input", {
				...rest,
				id: inputId,
				required,
				type: visible ? "text" : "password",
				"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
				"aria-invalid": !!error || void 0,
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "pr-12")
			}), /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "focus-ring absolute inset-y-0 right-3 flex items-center rounded-sm",
				onClick: () => setVisible((v) => !v),
				"aria-label": visible ? hidePasswordLabel : showPasswordLabel,
				children: /* @__PURE__ */ jsx(Icon, {
					name: visible ? "eyeOff" : "eye",
					size: "sm",
					tone: "secondary"
				})
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/motion/primitives.tsx
function Reveal({ preset = "fade", delayMs = 0, layout = false, children }) {
	const motionSettings = useChaseMotion();
	const definition = motionSettings.presets[preset];
	return /* @__PURE__ */ jsx(motion.div, {
		layout,
		initial: definition.initial,
		animate: definition.animate,
		exit: definition.exit,
		transition: {
			...definition.transition,
			delay: motionSettings.reducedMotion ? 0 : delayMs / 1e3
		},
		children
	});
}
function Stagger({ preset = "lift", staggerMs = 70, children }) {
	const motionSettings = useChaseMotion();
	const nodes = Children.toArray(children);
	const staggerDelay = motionSettings.reducedMotion ? 0 : staggerMs / 1e3;
	return /* @__PURE__ */ jsx(motion.div, {
		initial: "hidden",
		animate: "visible",
		variants: {
			hidden: {},
			visible: { transition: {
				staggerChildren: staggerDelay,
				delayChildren: 0
			} }
		},
		children: nodes.map((child, index) => {
			const definition = motionSettings.presets[preset];
			return /* @__PURE__ */ jsx(motion.div, {
				variants: {
					hidden: definition.initial,
					visible: {
						...definition.animate,
						transition: definition.transition
					}
				},
				children: child
			}, child?.key ?? index);
		})
	});
}
function ViewTransition({ transitionKey, preset = "page", mode = "wait", children }) {
	const definition = useChaseMotion().viewPresets[preset];
	return /* @__PURE__ */ jsx(AnimatePresence, {
		initial: false,
		mode,
		children: /* @__PURE__ */ jsx(motion.div, {
			initial: definition.initial,
			animate: definition.animate,
			exit: definition.exit,
			transition: definition.transition,
			children
		}, transitionKey)
	});
}
//#endregion
//#region ../../packages/design-system/src/patterns/app-shells.tsx
function Page({ children, width = "full", ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("mx-auto flex w-full flex-col gap-6 px-4 py-6 pb-24 md:px-6 md:pb-8", layoutWidthClasses[width]),
		children
	});
}
function PageHeader({ eyebrow, title, description, actions, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "flex flex-col gap-4 md:flex-row md:items-end md:justify-between",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [
				eyebrow ? /* @__PURE__ */ jsx("div", {
					className: "text-xs font-semibold uppercase tracking-[0.2em] text-accent",
					children: eyebrow
				}) : null,
				/* @__PURE__ */ jsx("h1", {
					className: "font-display text-4xl font-semibold tracking-tight text-foreground md:text-5xl",
					children: title
				}),
				description ? /* @__PURE__ */ jsx("div", {
					className: "max-w-3xl text-base text-secondary",
					children: description
				}) : null
			]
		}), actions ? /* @__PURE__ */ jsx(ButtonGroup, { children: actions }) : null]
	});
}
function PageSection({ title, description, children, ...rest }) {
	return /* @__PURE__ */ jsxs("section", {
		...rest,
		className: "space-y-4",
		children: [title ? /* @__PURE__ */ jsxs("div", {
			className: "space-y-1",
			children: [/* @__PURE__ */ jsx("h2", {
				className: "font-heading text-2xl font-semibold text-foreground",
				children: title
			}), description ? /* @__PURE__ */ jsx("div", {
				className: "text-sm text-secondary",
				children: description
			}) : null]
		}) : null, children]
	});
}
var splitPaneWidthClasses = {
	nav: "lg:grid-cols-[minmax(0,1fr)_16rem]",
	filter: "lg:grid-cols-[minmax(0,1fr)_18rem]",
	detail: "lg:grid-cols-[minmax(0,1fr)_22rem]",
	summary: "lg:grid-cols-[minmax(0,1fr)_24rem]"
};
function SplitPane({ primary, secondary, secondaryWidth = "detail", secondarySticky = false, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: cx("grid gap-6", splitPaneWidthClasses[secondaryWidth]),
		children: [/* @__PURE__ */ jsx("div", { children: primary }), /* @__PURE__ */ jsx("div", {
			className: cx(secondarySticky && "lg:sticky lg:top-24 lg:self-start"),
			children: secondary
		})]
	});
}
function RecordPage({ header, summary, details, width = "full" }) {
	return /* @__PURE__ */ jsxs(Page, {
		width,
		children: [header, /* @__PURE__ */ jsx(SplitPane, {
			primary: summary,
			secondary: details
		})]
	});
}
function MarketplaceShell({ brand, topNavItems, bottomNavItems, activeKey, actions, hero, sidebar, children, width = "full" }) {
	const content = /* @__PURE__ */ jsx("div", {
		className: "space-y-6",
		children
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "min-h-screen bg-background",
		children: [
			/* @__PURE__ */ jsx(SkipLink, {}),
			/* @__PURE__ */ jsx(TopNav, {
				brand,
				items: topNavItems,
				activeKey,
				actions,
				width
			}),
			/* @__PURE__ */ jsx("main", {
				id: "main-content",
				children: /* @__PURE__ */ jsxs(Page, {
					width,
					children: [hero, sidebar ? /* @__PURE__ */ jsxs("div", {
						className: "grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]",
						children: [/* @__PURE__ */ jsx("div", {
							className: "hidden lg:block",
							children: sidebar
						}), content]
					}) : content]
				})
			}),
			/* @__PURE__ */ jsx(BottomNav, {
				items: bottomNavItems,
				activeKey,
				width
			})
		]
	});
}
function AdminShell({ brand, navItems, activeKey, actions, children, width = "full" }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "min-h-screen bg-background",
		children: [
			/* @__PURE__ */ jsx(SkipLink, {}),
			/* @__PURE__ */ jsx(TopNav, {
				brand,
				items: navItems,
				activeKey,
				actions,
				width
			}),
			/* @__PURE__ */ jsxs("main", {
				id: "main-content",
				className: cx("mx-auto grid min-h-[calc(100vh-4rem)] w-full gap-6 px-4 py-6 pb-24 lg:grid-cols-[16rem_minmax(0,1fr)] lg:pb-8", layoutWidthClasses[width]),
				children: [/* @__PURE__ */ jsx("div", {
					className: "hidden lg:block",
					children: /* @__PURE__ */ jsx("div", {
						className: "sticky top-24 self-start",
						children: /* @__PURE__ */ jsx(SideNav, {
							items: navItems,
							activeKey
						})
					})
				}), /* @__PURE__ */ jsx("div", {
					className: "space-y-6",
					children
				})]
			}),
			/* @__PURE__ */ jsx(BottomNav, {
				items: navItems,
				activeKey,
				width
			})
		]
	});
}
function SearchResultsLayout({ filters, summary, children }) {
	const content = /* @__PURE__ */ jsxs("div", {
		className: "space-y-6",
		children: [summary, children]
	});
	if (!filters) return content;
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]",
		children: [/* @__PURE__ */ jsx("div", {
			className: "hidden lg:block",
			children: filters
		}), content]
	});
}
function CheckoutLayout({ summary, children }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]",
		children: [/* @__PURE__ */ jsx("div", { children }), /* @__PURE__ */ jsx("div", {
			className: "lg:sticky lg:top-24 lg:self-start",
			children: summary
		})]
	});
}
function InspectorLayout({ main, inspector }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]",
		children: [/* @__PURE__ */ jsx("div", { children: main }), /* @__PURE__ */ jsx("div", { children: inspector })]
	});
}
function SelectionToolbar({ count, actions, formatSelectedLabel = (n) => `${n} record${n === 1 ? "" : "s"} selected`, ...rest }) {
	const motionSettings = useChaseMotion();
	const nativeProps = rest;
	return /* @__PURE__ */ jsxs(motion.div, {
		...nativeProps,
		initial: motionSettings.reducedMotion ? false : {
			opacity: 0,
			y: 14
		},
		animate: motionSettings.reducedMotion ? void 0 : {
			opacity: 1,
			y: 0
		},
		transition: motionSettings.reducedMotion ? void 0 : {
			duration: motionSettings.durations.base,
			ease: motionSettings.easing
		},
		className: "modern-surface sticky bottom-20 z-sticky flex flex-col gap-3 rounded-tokenLg border border-accent p-4 shadow-overlay md:bottom-4 md:flex-row md:items-center md:justify-between",
		children: [/* @__PURE__ */ jsx("div", {
			className: "text-sm font-semibold text-foreground",
			children: formatSelectedLabel(count)
		}), actions ? /* @__PURE__ */ jsx(ButtonGroup, { children: actions }) : null]
	});
}
function PriceDisplay({ amount, currency = "USD", emphasis = false, locale, ...rest }) {
	return /* @__PURE__ */ jsx("span", {
		...rest,
		className: cx("font-heading", emphasis ? "text-2xl font-semibold text-foreground" : "text-lg font-semibold text-foreground"),
		children: new Intl.NumberFormat(locale, {
			style: "currency",
			currency
		}).format(amount)
	});
}
function ConditionBadge({ condition, ...rest }) {
	const tone = condition === "NM" ? "success" : condition === "LP" ? "accent" : condition === "MP" ? "warning" : "danger";
	return /* @__PURE__ */ jsx(Badge, {
		...rest,
		tone,
		children: condition
	});
}
function SellerBadge({ name, verified = false, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "inline-flex items-center gap-2 rounded-full border border-muted bg-elevated px-3 py-1.5 text-sm font-medium text-foreground shadow-tokenSm",
		children: [/* @__PURE__ */ jsx("span", { children: name }), verified ? /* @__PURE__ */ jsx(Badge, {
			tone: "success",
			children: "Verified"
		}) : null]
	});
}
function OrderSummary({ title = "Order summary", lines, total, totalLabel = "Total" }) {
	return /* @__PURE__ */ jsxs(DetailPanel, {
		title,
		children: [/* @__PURE__ */ jsx(KeyValueList, { items: lines.map((line) => ({
			key: line.label,
			value: line.value
		})) }), /* @__PURE__ */ jsxs("div", {
			className: "flex items-center justify-between border-t border-muted pt-4",
			children: [/* @__PURE__ */ jsx("span", {
				className: "text-sm font-semibold text-foreground",
				children: totalLabel
			}), /* @__PURE__ */ jsx("span", {
				className: "font-heading text-2xl font-semibold text-foreground",
				children: total
			})]
		})]
	});
}
function MetricStrip({ items }) {
	return /* @__PURE__ */ jsx(StatGrid, {
		columns: {
			base: 1,
			sm: 2,
			xl: 4
		},
		children: items.map((item, index) => /* @__PURE__ */ jsx(Stat, {
			label: item.label,
			value: item.value,
			trend: item.trend
		}, index))
	});
}
function Wizard({ steps, activeStep, onStepChange, onComplete, nextLabel = "Continue", previousLabel = "Back", completeLabel = "Complete" }) {
	const motionSettings = useChaseMotion();
	const activeIndex = steps.findIndex((s) => s.key === activeStep);
	const current = steps[activeIndex];
	const isFirst = activeIndex === 0;
	const isLast = activeIndex === steps.length - 1;
	return /* @__PURE__ */ jsxs("div", {
		className: "space-y-6",
		children: [
			/* @__PURE__ */ jsx(PageStepper, { items: steps.map((step, index) => ({
				label: step.label,
				description: step.description,
				status: index < activeIndex ? "complete" : index === activeIndex ? "current" : "upcoming"
			})) }),
			/* @__PURE__ */ jsx(AnimatePresence, {
				initial: false,
				mode: "wait",
				children: /* @__PURE__ */ jsx(motion.div, {
					initial: motionSettings.reducedMotion ? false : {
						opacity: 0,
						x: 18
					},
					animate: motionSettings.reducedMotion ? void 0 : {
						opacity: 1,
						x: 0
					},
					exit: motionSettings.reducedMotion ? void 0 : {
						opacity: 0,
						x: -12
					},
					transition: motionSettings.reducedMotion ? void 0 : {
						duration: motionSettings.durations.base,
						ease: motionSettings.easing
					},
					children: current?.content
				}, current?.key)
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ jsx("div", { children: !isFirst ? /* @__PURE__ */ jsx(Button, {
					tone: "secondary",
					onClick: () => onStepChange(steps[activeIndex - 1].key),
					children: previousLabel
				}) : null }), /* @__PURE__ */ jsx("div", { children: isLast ? /* @__PURE__ */ jsx(Button, {
					tone: "primary",
					disabled: current?.isValid === false,
					onClick: onComplete,
					children: completeLabel
				}) : /* @__PURE__ */ jsx(Button, {
					tone: "primary",
					disabled: current?.isValid === false,
					onClick: () => onStepChange(steps[activeIndex + 1].key),
					children: nextLabel
				}) })]
			})
		]
	});
}
//#endregion
//#region ../../packages/design-system/src/primitives/typography.tsx
var textSizeClasses = {
	xs: "text-xs",
	sm: "text-sm",
	md: "text-base",
	lg: "text-lg"
};
var textWeightClasses = {
	regular: "font-normal",
	medium: "font-medium",
	semibold: "font-semibold",
	bold: "font-bold"
};
var textToneClasses = {
	primary: "text-foreground",
	secondary: "text-secondary",
	inverse: "text-inverse",
	accent: "text-accent"
};
function Text({ children, element = "p", size = "md", tone = "primary", weight = "regular", align, ...rest }) {
	return /* @__PURE__ */ jsx(element, {
		...rest,
		className: cx("leading-relaxed", textSizeClasses[size], textToneClasses[tone], textWeightClasses[weight], resolveTextAlignClass(align)),
		children
	});
}
var headingClasses = {
	1: "font-display text-4xl font-semibold leading-tight tracking-tight md:text-5xl md:leading-[1.15]",
	2: "font-heading text-3xl font-semibold leading-tight tracking-tight md:text-4xl md:leading-tight",
	3: "font-heading text-2xl font-semibold leading-snug tracking-tight md:text-3xl md:leading-tight",
	4: "font-heading text-xl font-semibold leading-snug tracking-tight md:text-2xl md:leading-snug",
	5: "font-heading text-lg font-semibold leading-snug tracking-tight",
	6: "font-heading text-base font-semibold leading-snug tracking-tight"
};
function Heading({ children, level = 2, align, ...rest }) {
	return /* @__PURE__ */ jsx(`h${level}`, {
		...rest,
		className: cx(headingClasses[level], resolveTextAlignClass(align)),
		children
	});
}
function Label({ muted = false, ...rest }) {
	return /* @__PURE__ */ jsx(LabelPrimitive.Root, {
		...rest,
		className: cx("text-sm font-medium", muted ? "text-secondary" : "text-foreground")
	});
}
function Caption(props) {
	return /* @__PURE__ */ jsx(Text, {
		...props,
		size: props.size ?? "xs",
		tone: props.tone ?? "secondary"
	});
}
function CodeText({ children, ...rest }) {
	return /* @__PURE__ */ jsx("code", {
		...rest,
		className: "rounded-tokenSm bg-background px-1.5 py-1 font-mono text-xs text-accent",
		children
	});
}
function LinkText({ children, tone = "accent", trailingIcon, ...rest }) {
	return /* @__PURE__ */ jsxs("a", {
		...rest,
		className: cx("focus-ring inline-flex items-center gap-2 rounded-tokenSm font-medium underline-offset-4", tone === "accent" ? "text-accent hover:text-foreground hover:underline" : "text-secondary hover:text-foreground hover:underline"),
		children: [/* @__PURE__ */ jsx("span", { children }), trailingIcon ? /* @__PURE__ */ jsx(Icon, {
			name: trailingIcon,
			size: "sm"
		}) : null]
	});
}
function List({ items, ordered = false, ...rest }) {
	return /* @__PURE__ */ jsx(ordered ? "ol" : "ul", {
		...rest,
		className: cx("space-y-2 pl-5 text-sm leading-relaxed text-secondary", ordered ? "list-decimal" : "list-disc"),
		children: items.map((item, index) => /* @__PURE__ */ jsx("li", { children: item }, index))
	});
}
function Quote({ children, cite, ...rest }) {
	return /* @__PURE__ */ jsxs("blockquote", {
		...rest,
		className: "modern-surface rounded-tokenLg border-l-4 border-accent px-5 py-4",
		children: [/* @__PURE__ */ jsx(Text, {
			size: "md",
			weight: "medium",
			children
		}), cite ? /* @__PURE__ */ jsx(Text, {
			element: "div",
			size: "xs",
			tone: "secondary",
			children: cite
		}) : null]
	});
}
var avatarSizeClasses = {
	sm: "h-8 w-8 text-xs",
	md: "h-10 w-10 text-sm",
	lg: "h-14 w-14 text-base"
};
function initials(value) {
	return value.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}
function Avatar({ name, size = "md", src, alt, ...rest }) {
	if (src) return /* @__PURE__ */ jsx("img", {
		...rest,
		alt: alt ?? name,
		src,
		className: cx("rounded-full border border-muted object-cover shadow-tokenSm", avatarSizeClasses[size])
	});
	return /* @__PURE__ */ jsx("div", {
		"aria-label": alt ?? name,
		children: /* @__PURE__ */ jsx("div", {
			className: cx("inline-flex items-center justify-center rounded-full border border-muted bg-background font-semibold text-secondary shadow-tokenSm", avatarSizeClasses[size]),
			children: initials(name)
		})
	});
}
function Thumbnail({ src, alt, ratio = 1, icon = "package", ...rest }) {
	return /* @__PURE__ */ jsx(Surface, {
		padding: 0,
		elevated: true,
		children: /* @__PURE__ */ jsx(AspectRatio, {
			ratio,
			children: src ? /* @__PURE__ */ jsx("img", {
				...rest,
				alt,
				src,
				className: "h-full w-full rounded-tokenLg object-cover"
			}) : /* @__PURE__ */ jsx(Center, { children: /* @__PURE__ */ jsx("div", {
				className: "flex h-full w-full items-center justify-center bg-background",
				children: /* @__PURE__ */ jsx(Icon, {
					name: icon,
					size: "lg",
					tone: "secondary"
				})
			}) })
		})
	});
}
function EmptyStateIllustration({ title = "No results yet", ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: "w-full",
		children: /* @__PURE__ */ jsx(AspectRatio, {
			ratio: 16 / 9,
			children: /* @__PURE__ */ jsx("div", {
				className: "flex h-full w-full items-center justify-center rounded-tokenLg border border-dashed border-muted bg-background",
				children: /* @__PURE__ */ jsxs("div", {
					className: "space-y-3 text-center",
					children: [/* @__PURE__ */ jsx(Center, { children: /* @__PURE__ */ jsx(Icon, {
						name: "spark",
						size: "lg",
						tone: "accent"
					}) }), /* @__PURE__ */ jsx(Caption, { children: title })]
				})
			})
		})
	});
}
//#endregion
//#region src/showcase-theme-control.tsx
function ShowcaseThemeControl({ colorMode, onColorModeChange, reducedMotion, onReducedMotionChange }) {
	return /* @__PURE__ */ jsxs(Inline, {
		gap: 2,
		align: "center",
		children: [
			/* @__PURE__ */ jsx(Text, {
				size: "sm",
				tone: "secondary",
				children: "Theme"
			}),
			/* @__PURE__ */ jsx(SegmentedControl, {
				value: colorMode,
				onValueChange: (value) => onColorModeChange(value),
				items: [
					{
						value: "system",
						label: "System"
					},
					{
						value: "light",
						label: "Light"
					},
					{
						value: "dark",
						label: "Dark"
					}
				]
			}),
			/* @__PURE__ */ jsx(Text, {
				size: "sm",
				tone: "secondary",
				children: "Motion"
			}),
			/* @__PURE__ */ jsx(SegmentedControl, {
				value: reducedMotion,
				onValueChange: (value) => onReducedMotionChange(value),
				items: [
					{
						value: "user",
						label: "System"
					},
					{
						value: "never",
						label: "Full"
					},
					{
						value: "always",
						label: "Reduced"
					}
				]
			})
		]
	});
}
//#endregion
//#region app/routes/layout.tsx
var layout_exports = /* @__PURE__ */ __exportAll({ default: () => layout_default });
function resolveMode(pathname) {
	const segment = pathname.split("/").filter(Boolean)[0];
	return segment === "admin" || segment === "components" ? segment : "marketplace";
}
var layout_default = UNSAFE_withComponentProps(function ShowcaseLayoutRoute() {
	const location = useLocation();
	const navigate = useNavigate();
	const [colorMode, setColorMode] = useState("system");
	const [reducedMotion, setReducedMotion] = useState("user");
	const [isDemoToastOpen, setIsDemoToastOpen] = useState(true);
	const showcaseMode = resolveMode(location.pathname);
	return /* @__PURE__ */ jsxs(ChaseRoot, {
		colorMode,
		reducedMotion,
		children: [
			/* @__PURE__ */ jsxs(Page, { children: [/* @__PURE__ */ jsx(Surface, {
				elevated: true,
				children: /* @__PURE__ */ jsx(PageHeader, {
					eyebrow: "Design system",
					title: "One package, shared marketplace and admin surfaces",
					description: "The showcase validates theme tokens, layout primitives, and responsive application shells from a single explicit stylesheet contract.",
					actions: /* @__PURE__ */ jsx(ShowcaseThemeControl, {
						colorMode,
						onColorModeChange: setColorMode,
						reducedMotion,
						onReducedMotionChange: setReducedMotion
					})
				})
			}), /* @__PURE__ */ jsx(Tabs, {
				value: showcaseMode,
				onValueChange: (value) => navigate(value === "marketplace" ? "/" : `/${value}`),
				items: [
					{
						value: "marketplace",
						label: "Marketplace",
						content: null
					},
					{
						value: "admin",
						label: "Admin",
						content: null
					},
					{
						value: "components",
						label: "Components",
						content: null
					}
				]
			})] }),
			/* @__PURE__ */ jsx(Outlet, {}),
			/* @__PURE__ */ jsx(ToastRegion, { items: [{
				id: "demo-toast",
				title: "Design system ready",
				description: "Marketplace and admin surfaces are rendering from a shared package with an explicit stylesheet import.",
				tone: "success",
				open: isDemoToastOpen,
				onOpenChange: setIsDemoToastOpen
			}] })
		]
	});
});
//#endregion
//#region src/fixtures.ts
var marketplaceNav = [
	{
		key: "browse",
		label: "Browse",
		icon: "search"
	},
	{
		key: "sets",
		label: "Sets",
		icon: "spark"
	},
	{
		key: "cart",
		label: "Cart",
		icon: "cart",
		badge: "3"
	},
	{
		key: "account",
		label: "Account",
		icon: "user"
	}
];
var adminNav = [
	{
		key: "dashboard",
		label: "Dashboard",
		icon: "dashboard"
	},
	{
		key: "inventory",
		label: "Inventory",
		icon: "package"
	},
	{
		key: "pricing",
		label: "Pricing",
		icon: "spark"
	},
	{
		key: "settings",
		label: "Settings",
		icon: "settings"
	}
];
var inventoryRows = [
	{
		sku: "CS-001",
		card: "Charizard ex - 199/165",
		condition: "NM",
		price: 29.95,
		stock: 14
	},
	{
		sku: "CS-014",
		card: "Iono - 237/091",
		condition: "LP",
		price: 12.5,
		stock: 32
	},
	{
		sku: "CS-104",
		card: "Mewtwo VSTAR - GG44",
		condition: "NM",
		price: 9.25,
		stock: 7
	}
];
var showcaseIconNames = [
	"search",
	"cart",
	"filter",
	"dashboard",
	"close",
	"check",
	"warning",
	"chevronDown",
	"chevronUp",
	"chevronLeft",
	"chevronRight",
	"menu",
	"spark",
	"package",
	"settings",
	"user",
	"info",
	"star",
	"starHalf",
	"starEmpty",
	"copy",
	"plus",
	"minus",
	"edit",
	"trash",
	"heart",
	"heartFilled",
	"share",
	"image",
	"dollar",
	"truck",
	"clock",
	"eye",
	"eyeOff"
];
//#endregion
//#region src/views/marketplace-view.tsx
function MarketplaceView() {
	const [cartPage, setCartPage] = useState(3);
	const [selectedSet, setSelectedSet] = useState();
	return /* @__PURE__ */ jsxs(MarketplaceShell, {
		brand: /* @__PURE__ */ jsx(SellerBadge, {
			name: "Chase Sets",
			verified: true
		}),
		topNavItems: marketplaceNav,
		bottomNavItems: marketplaceNav,
		activeKey: "browse",
		actions: /* @__PURE__ */ jsxs(Inline, {
			gap: 2,
			children: [/* @__PURE__ */ jsx(Tooltip, {
				content: "View your saved want lists",
				children: /* @__PURE__ */ jsx(IconButton, {
					label: "Saved wants",
					icon: "spark"
				})
			}), /* @__PURE__ */ jsx(LinkButton, {
				href: "#sell",
				tone: "secondary",
				children: "Sell cards"
			})]
		}),
		hero: /* @__PURE__ */ jsx(Surface, {
			elevated: true,
			children: /* @__PURE__ */ jsx(PageHeader, {
				eyebrow: "Marketplace",
				title: "Build a complete set without fighting the interface",
				description: "Responsive search, transparent pricing, and buyer-first cart building are all composed from design-system primitives.",
				actions: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Button, { children: "Start browsing" }), /* @__PURE__ */ jsx(Button, {
					tone: "secondary",
					children: "View saved wants"
				})] })
			})
		}),
		sidebar: /* @__PURE__ */ jsxs(Stack, {
			gap: 4,
			children: [
				/* @__PURE__ */ jsxs(Surface, { children: [
					/* @__PURE__ */ jsx(Heading, {
						level: 4,
						children: "Quick Filters"
					}),
					/* @__PURE__ */ jsx(Text, {
						tone: "secondary",
						children: "Card type, rarity, price band, condition, and seller trust all fit into the same primitive stack."
					}),
					/* @__PURE__ */ jsxs(Inline, {
						gap: 2,
						children: [
							/* @__PURE__ */ jsx(Tag, {
								tone: "accent",
								onRemove: () => {},
								children: "Modern"
							}),
							/* @__PURE__ */ jsx(Tag, {
								tone: "success",
								onRemove: () => {},
								children: "Verified"
							}),
							/* @__PURE__ */ jsx(Badge, {
								tone: "info",
								children: "Ships fast"
							})
						]
					})
				] }),
				/* @__PURE__ */ jsxs(Surface, { children: [/* @__PURE__ */ jsx(Heading, {
					level: 5,
					children: "Top Sellers"
				}), /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsxs(Inline, {
						gap: 2,
						children: [/* @__PURE__ */ jsx(Avatar, {
							name: "North Side Cards",
							size: "sm"
						}), /* @__PURE__ */ jsxs(Stack, {
							gap: 0,
							children: [/* @__PURE__ */ jsx(Text, {
								size: "sm",
								weight: "semibold",
								children: "North Side Cards"
							}), /* @__PURE__ */ jsx(Caption, { children: "4.9 stars - 2,400 sales" })]
						})]
					}), /* @__PURE__ */ jsxs(Inline, {
						gap: 2,
						children: [/* @__PURE__ */ jsx(Avatar, {
							name: "Gem Mint TCG",
							size: "sm"
						}), /* @__PURE__ */ jsxs(Stack, {
							gap: 0,
							children: [/* @__PURE__ */ jsx(Text, {
								size: "sm",
								weight: "semibold",
								children: "Gem Mint TCG"
							}), /* @__PURE__ */ jsx(Caption, { children: "4.8 stars - 1,800 sales" })]
						})]
					})]
				})] }),
				/* @__PURE__ */ jsxs(Surface, { children: [/* @__PURE__ */ jsx(Heading, {
					level: 5,
					children: "Browse by Set"
				}), /* @__PURE__ */ jsx(Combobox, {
					label: "Set",
					hideLabel: true,
					items: [
						{
							value: "sv8",
							label: "Surging Sparks"
						},
						{
							value: "sv7",
							label: "Stellar Crown"
						},
						{
							value: "sv6",
							label: "Twilight Masquerade"
						},
						{
							value: "sv5",
							label: "Temporal Forces"
						}
					],
					value: selectedSet,
					onValueChange: setSelectedSet,
					placeholder: "Search sets..."
				})] })
			]
		}),
		children: [/* @__PURE__ */ jsxs(PageSection, {
			title: "Search Results",
			description: "Every result card is built from library exports only.",
			children: [
				/* @__PURE__ */ jsx(Breadcrumbs, { items: [
					{
						label: "Home",
						href: "#"
					},
					{
						label: "Pokemon TCG",
						href: "#"
					},
					{ label: "Surging Sparks" }
				] }),
				/* @__PURE__ */ jsxs(FilterBar, {
					actions: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs(FilterDrawer, {
						trigger: /* @__PURE__ */ jsx(Button, {
							tone: "secondary",
							children: "Filters"
						}),
						children: [/* @__PURE__ */ jsx(Select, {
							label: "Condition",
							items: [
								{
									value: "nm",
									label: "Near mint"
								},
								{
									value: "lp",
									label: "Light play"
								},
								{
									value: "mp",
									label: "Moderate play"
								}
							]
						}), /* @__PURE__ */ jsx(Select, {
							label: "Seller rating",
							items: [{
								value: "all",
								label: "All sellers"
							}, {
								value: "trusted",
								label: "Trusted only"
							}]
						})]
					}), /* @__PURE__ */ jsx(Popover, {
						trigger: /* @__PURE__ */ jsx(Button, {
							tone: "ghost",
							children: "Sort"
						}),
						title: "Sort listings",
						children: /* @__PURE__ */ jsx(RadioGroup, {
							label: "Sort order",
							hideLabel: true,
							items: [
								{
									value: "price-asc",
									label: "Price: low to high"
								},
								{
									value: "price-desc",
									label: "Price: high to low"
								},
								{
									value: "recent",
									label: "Recently listed"
								}
							],
							defaultValue: "price-asc"
						})
					})] }),
					children: [/* @__PURE__ */ jsx(SearchInput, {
						label: "Find cards",
						placeholder: "Search card, set, or variant"
					}), /* @__PURE__ */ jsx(Select, {
						label: "Rarity",
						items: [
							{
								value: "all",
								label: "All rarities"
							},
							{
								value: "rare",
								label: "Rare+"
							},
							{
								value: "common",
								label: "Common to uncommon"
							}
						]
					})]
				}),
				/* @__PURE__ */ jsx(SearchResultsLayout, {
					summary: /* @__PURE__ */ jsxs(Inline, {
						gap: 3,
						align: "center",
						children: [/* @__PURE__ */ jsx(Text, {
							tone: "secondary",
							children: "428 matching listings across 36 sellers with consolidated shipping."
						}), /* @__PURE__ */ jsx(StatusPill, {
							tone: "success",
							children: "Live"
						})]
					}),
					children: /* @__PURE__ */ jsx(Grid, {
						columns: {
							base: 1,
							sm: 2,
							lg: 3,
							xl: 4
						},
						gap: 3,
						children: inventoryRows.map((row) => /* @__PURE__ */ jsxs(Card, { children: [/* @__PURE__ */ jsx(Thumbnail, {
							alt: row.card,
							ratio: 1
						}), /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [/* @__PURE__ */ jsx(ConditionBadge, { condition: row.condition }), /* @__PURE__ */ jsx(Badge, {
										tone: "success",
										children: "In stock"
									})]
								}),
								/* @__PURE__ */ jsx(Heading, {
									level: 5,
									children: row.card
								}),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [/* @__PURE__ */ jsx(Avatar, {
										name: "North Side Cards",
										size: "sm"
									}), /* @__PURE__ */ jsx(LinkText, {
										href: "#",
										children: "North Side Cards"
									})]
								}),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(PriceDisplay, { amount: row.price }), /* @__PURE__ */ jsxs(Text, {
										size: "sm",
										tone: "secondary",
										children: [row.stock, " available"]
									})]
								}),
								/* @__PURE__ */ jsx(Tooltip, {
									content: "Add this card to your cart",
									children: /* @__PURE__ */ jsx(Button, {
										block: true,
										children: "Add to cart"
									})
								})
							]
						})] }, row.sku))
					})
				}),
				/* @__PURE__ */ jsx(Pagination, {
					page: cartPage,
					totalPages: 48,
					onPageChange: setCartPage
				})
			]
		}), /* @__PURE__ */ jsxs(PageSection, {
			title: "Checkout Flow",
			children: [/* @__PURE__ */ jsx(PageStepper, { items: [
				{
					label: "Cart review",
					description: "Verify items and quantities",
					status: "complete"
				},
				{
					label: "Shipping",
					description: "Choose delivery method",
					status: "current"
				},
				{
					label: "Payment",
					description: "Secure checkout",
					status: "upcoming"
				}
			] }), /* @__PURE__ */ jsx(CheckoutLayout, {
				summary: /* @__PURE__ */ jsx(OrderSummary, {
					lines: [
						{
							label: "Cards (3)",
							value: "$51.70"
						},
						{
							label: "Shipping",
							value: "$4.25"
						},
						{
							label: "Rebate",
							value: "-$1.15"
						}
					],
					total: "$54.80"
				}),
				children: /* @__PURE__ */ jsxs(FormSection, {
					title: "Shipping Details",
					description: "Where should we send your cards?",
					children: [
						/* @__PURE__ */ jsx(TextInput, {
							label: "Full name",
							defaultValue: "Todd S."
						}),
						/* @__PURE__ */ jsx(TextInput, {
							label: "Address",
							placeholder: "123 Main St"
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 3,
							children: [/* @__PURE__ */ jsx(TextInput, {
								label: "City",
								placeholder: "Chicago"
							}), /* @__PURE__ */ jsx(TextInput, {
								label: "ZIP",
								placeholder: "60601"
							})]
						}),
						/* @__PURE__ */ jsx(DateInput, { label: "Preferred delivery date" })
					]
				})
			})]
		})]
	});
}
//#endregion
//#region app/routes/marketplace.tsx
var marketplace_exports = /* @__PURE__ */ __exportAll({
	default: () => marketplace_default,
	meta: () => meta$2
});
var meta$2 = () => [{ title: "Marketplace Showcase" }];
var marketplace_default = UNSAFE_withComponentProps(function MarketplaceShowcaseRoute() {
	return /* @__PURE__ */ jsx(MarketplaceView, {});
});
//#endregion
//#region src/views/admin-view.tsx
function AdminView() {
	const [showDeleteDialog, setShowDeleteDialog] = useState(false);
	const [sliderValue, setSliderValue] = useState(75);
	const [selectedItems, setSelectedItems] = useState(2);
	return /* @__PURE__ */ jsx(AdminShell, {
		brand: /* @__PURE__ */ jsx(SellerBadge, {
			name: "Chase Sets Ops",
			verified: true
		}),
		navItems: adminNav,
		activeKey: "inventory",
		actions: /* @__PURE__ */ jsxs(Inline, {
			gap: 2,
			children: [/* @__PURE__ */ jsx(Menu, {
				trigger: /* @__PURE__ */ jsx(Button, {
					tone: "secondary",
					leadingIcon: "menu",
					children: "Actions"
				}),
				items: [
					{
						key: "export",
						label: "Export inventory",
						description: "Download as CSV"
					},
					{
						key: "import",
						label: "Bulk import",
						description: "Upload listing spreadsheet"
					},
					{
						key: "archive",
						label: "Archive sold",
						description: "Move zero-stock to archive",
						destructive: true
					}
				]
			}), /* @__PURE__ */ jsx(Button, { children: "New listing" })]
		}),
		children: /* @__PURE__ */ jsxs(Page, { children: [
			/* @__PURE__ */ jsx(PageHeader, {
				eyebrow: "Admin",
				title: "Inventory, pricing, and fulfillment in one responsive surface",
				description: "The same library covers dashboard stats, dense data tables, and form-heavy listing editors."
			}),
			/* @__PURE__ */ jsx(Banner, {
				tone: "info",
				title: "Platform maintenance scheduled",
				description: "Marketplace indexing will be paused Sunday 2am-4am CST. Listings remain live.",
				actions: /* @__PURE__ */ jsx(Button, {
					tone: "secondary",
					size: "sm",
					children: "View details"
				})
			}),
			/* @__PURE__ */ jsx(MetricStrip, { items: [
				{
					label: "Live listings",
					value: "8,420",
					trend: "+6.1% week over week"
				},
				{
					label: "Pending orders",
					value: "126",
					trend: "12 need same-day shipment"
				},
				{
					label: "Margin lift",
					value: "4.8%",
					trend: "vs competitor benchmark"
				},
				{
					label: "Low stock SKUs",
					value: "19",
					trend: "Restock recommended"
				}
			] }),
			/* @__PURE__ */ jsx(PageSection, {
				title: "Fulfillment Progress",
				children: /* @__PURE__ */ jsxs(Grid, {
					columns: {
						base: 1,
						md: 2
					},
					gap: 4,
					children: [/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Text, {
								weight: "semibold",
								children: "Daily shipment quota"
							}),
							/* @__PURE__ */ jsx(ProgressBar, {
								value: sliderValue,
								tone: "accent"
							}),
							/* @__PURE__ */ jsxs(Caption, { children: [sliderValue, " of 100 orders shipped today"] })
						]
					}) }), /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Text, {
								weight: "semibold",
								children: "Processing pipeline"
							}),
							/* @__PURE__ */ jsxs(Inline, {
								gap: 2,
								children: [/* @__PURE__ */ jsx(LoadingSpinner, {
									size: "sm",
									label: "Syncing"
								}), /* @__PURE__ */ jsx(Caption, { children: "14 orders syncing with carrier API" })]
							}),
							/* @__PURE__ */ jsx(Skeleton, { height: "sm" }),
							/* @__PURE__ */ jsx(Skeleton, { height: "md" })
						]
					}) })]
				})
			}),
			/* @__PURE__ */ jsxs(PageSection, {
				title: "Inventory Table",
				children: [
					/* @__PURE__ */ jsx(DataTable, {
						rows: inventoryRows,
						columns: [
							{
								key: "sku",
								header: "SKU",
								cell: (row) => /* @__PURE__ */ jsx(CodeText, { children: row.sku })
							},
							{
								key: "card",
								header: "Card",
								mobileLabel: "Listing",
								cell: (row) => row.card
							},
							{
								key: "condition",
								header: "Condition",
								cell: (row) => /* @__PURE__ */ jsx(ConditionBadge, { condition: row.condition })
							},
							{
								key: "price",
								header: "Price",
								align: "right",
								cell: (row) => /* @__PURE__ */ jsx(PriceDisplay, { amount: row.price })
							},
							{
								key: "stock",
								header: "Stock",
								align: "right",
								cell: (row) => row.stock
							}
						]
					}),
					selectedItems > 0 ? /* @__PURE__ */ jsx(BulkActionBar, {
						count: selectedItems,
						actions: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Button, {
							tone: "secondary",
							size: "sm",
							onClick: () => setSelectedItems(0),
							children: "Deselect"
						}), /* @__PURE__ */ jsx(Button, {
							tone: "danger",
							size: "sm",
							onClick: () => setShowDeleteDialog(true),
							children: "Remove listings"
						})] })
					}) : null,
					/* @__PURE__ */ jsx(SelectionToolbar, {
						count: 3,
						actions: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Button, {
							tone: "secondary",
							size: "sm",
							children: "Reprice"
						}), /* @__PURE__ */ jsx(Button, {
							tone: "secondary",
							size: "sm",
							children: "Export"
						})] })
					})
				]
			}),
			/* @__PURE__ */ jsx(InspectorLayout, {
				main: /* @__PURE__ */ jsxs(FormSection, {
					title: "Listing Editor",
					description: "The listing editor composes entirely from form primitives and layout surfaces.",
					children: [
						/* @__PURE__ */ jsxs(Fieldset, {
							legend: "Core listing data",
							description: "Market-ready metadata with no custom CSS.",
							children: [
								/* @__PURE__ */ jsx(TextInput, {
									label: "Listing title",
									defaultValue: "Charizard ex - 199/165"
								}),
								/* @__PURE__ */ jsx(CurrencyInput, {
									label: "Unit price",
									defaultValue: "29.95"
								}),
								/* @__PURE__ */ jsx(NumberInput, {
									label: "Quantity",
									defaultValue: "14"
								}),
								/* @__PURE__ */ jsx(Textarea, {
									label: "Seller notes",
									placeholder: "Condition details, special offers...",
									rows: 3
								})
							]
						}),
						/* @__PURE__ */ jsx(Fieldset, {
							legend: "Categorization",
							description: "Help buyers find this listing.",
							children: /* @__PURE__ */ jsx(CheckboxGroup, {
								label: "Listing tags",
								items: [
									{
										value: "chase",
										label: "Chase card",
										description: "High-demand pull"
									},
									{
										value: "alt-art",
										label: "Alternate art"
									},
									{
										value: "promo",
										label: "Promo / event exclusive"
									}
								],
								values: ["chase"]
							})
						}),
						/* @__PURE__ */ jsxs(Fieldset, {
							legend: "Operational settings",
							description: "Bulk-safe admin controls.",
							children: [
								/* @__PURE__ */ jsx(Checkbox, {
									label: "Eligible for rapid ship",
									description: "Prioritize this listing in same-day fulfillment queues.",
									defaultChecked: true
								}),
								/* @__PURE__ */ jsx(Switch, {
									label: "Auto repricing",
									description: "Keep this listing aligned to the target spread.",
									defaultChecked: true
								}),
								/* @__PURE__ */ jsx(Slider, {
									label: "Target margin",
									value: sliderValue,
									onValueChange: setSliderValue,
									min: 0,
									max: 100
								}),
								/* @__PURE__ */ jsx(FileDropzone, {
									label: "Product assets",
									description: "Optional scans or listing collateral."
								}),
								/* @__PURE__ */ jsx(InlineMessage, {
									tone: "success",
									icon: "check",
									children: "All required fields are complete. This listing is ready to publish."
								})
							]
						})
					]
				}),
				inspector: /* @__PURE__ */ jsxs(DetailPanel, {
					title: "Listing Preview",
					children: [
						/* @__PURE__ */ jsx(KeyValueList, { items: [
							{
								key: "SKU",
								value: "CS-001"
							},
							{
								key: "Condition",
								value: "Near Mint"
							},
							{
								key: "Set",
								value: "Surging Sparks"
							},
							{
								key: "Listed",
								value: "Mar 1, 2026"
							}
						] }),
						/* @__PURE__ */ jsxs(StatGrid, { children: [/* @__PURE__ */ jsx(Stat, {
							label: "Expected margin",
							value: "28%",
							trend: "Healthy after shipping rebate"
						}), /* @__PURE__ */ jsx(Stat, {
							label: "Velocity",
							value: "2.1/day",
							trend: "Trending up"
						})] }),
						/* @__PURE__ */ jsx(PageSection, {
							title: "Publish Health",
							children: /* @__PURE__ */ jsx(EmptyState, {
								title: "No blocking issues",
								description: "Required metadata is present and pricing rules are valid.",
								icon: "check"
							})
						})
					]
				})
			}),
			/* @__PURE__ */ jsx(PageSection, {
				title: "Order Activity",
				children: /* @__PURE__ */ jsxs(Grid, {
					columns: {
						base: 1,
						lg: 2
					},
					gap: 4,
					children: [/* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsx(Timeline, { items: [
						{
							title: "Order #1042 shipped",
							description: "Charizard ex sent via USPS Priority",
							timestamp: "2 hours ago"
						},
						{
							title: "Pricing rule triggered",
							description: "Iono adjusted from $13.50 to $12.50",
							timestamp: "4 hours ago"
						},
						{
							title: "New listing published",
							description: "Mewtwo VSTAR added to inventory",
							timestamp: "Yesterday"
						}
					] }) }), /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsx(ActivityList, { items: [{
						title: "Bulk import completed",
						description: "42 listings added",
						actor: "System",
						timestamp: "1h ago"
					}, {
						title: "Price override",
						description: "Manual price set on CS-014",
						actor: "Todd S.",
						timestamp: "3h ago"
					}] }) })]
				})
			}),
			/* @__PURE__ */ jsx(AlertDialog, {
				open: showDeleteDialog,
				onOpenChange: setShowDeleteDialog,
				title: "Remove selected listings?",
				description: "This will delist the selected items from the marketplace. Inventory records are preserved.",
				confirmLabel: "Remove",
				cancelLabel: "Keep listings",
				tone: "danger",
				onConfirm: () => {
					setSelectedItems(0);
					setShowDeleteDialog(false);
				}
			})
		] })
	});
}
//#endregion
//#region app/routes/admin.tsx
var admin_exports = /* @__PURE__ */ __exportAll({
	default: () => admin_default,
	meta: () => meta$1
});
var meta$1 = () => [{ title: "Admin Showcase" }];
var admin_default = UNSAFE_withComponentProps(function AdminShowcaseRoute() {
	return /* @__PURE__ */ jsx(AdminView, {});
});
//#endregion
//#region src/views/components-view.tsx
function RatingDemo() {
	const [value, setValue] = useState(3);
	return /* @__PURE__ */ jsx(Rating, {
		value,
		max: 5,
		size: "md",
		interactive: true,
		onValueChange: setValue,
		label: "Your rating"
	});
}
function TagInputDemo() {
	const [tags, setTags] = useState(["Pokemon", "Charizard"]);
	return /* @__PURE__ */ jsx(TagInput, {
		values: tags,
		onValuesChange: setTags,
		placeholder: "Add a tag...",
		maxTags: 5
	});
}
function ColorModeToggleDemo() {
	const [mode, setMode] = useState("system");
	return /* @__PURE__ */ jsx(ColorModeToggle, {
		value: mode,
		onValueChange: setMode
	});
}
function WizardDemo() {
	const [step, setStep] = useState("details");
	return /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsx(Wizard, {
		steps: [
			{
				key: "details",
				label: "Card Details",
				content: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsx(TextInput, {
						label: "Card name",
						defaultValue: "Charizard ex"
					}), /* @__PURE__ */ jsx(Select, {
						label: "Set",
						items: [{
							value: "ss",
							label: "Surging Sparks"
						}, {
							value: "sc",
							label: "Stellar Crown"
						}]
					})]
				})
			},
			{
				key: "condition",
				label: "Condition & Price",
				content: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsx(Select, {
						label: "Condition",
						items: [{
							value: "nm",
							label: "Near Mint"
						}, {
							value: "lp",
							label: "Light Play"
						}]
					}), /* @__PURE__ */ jsx(CurrencyInput, {
						label: "Price",
						defaultValue: "29.95"
					})]
				})
			},
			{
				key: "review",
				label: "Review",
				content: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsx(Text, { children: "Review your listing before publishing." }), /* @__PURE__ */ jsx(KeyValueList, { items: [
						{
							key: "Card",
							value: "Charizard ex"
						},
						{
							key: "Condition",
							value: "Near Mint"
						},
						{
							key: "Price",
							value: "$29.95"
						}
					] })]
				})
			}
		],
		activeStep: step,
		onStepChange: setStep,
		onComplete: () => {}
	}) });
}
function MotionDemo() {
	const [view, setView] = useState("search");
	return /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsxs(Stack, {
		gap: 4,
		children: [
			/* @__PURE__ */ jsx(SegmentedControl, {
				value: view,
				onValueChange: setView,
				items: [{
					value: "search",
					label: "Search"
				}, {
					value: "detail",
					label: "Detail"
				}]
			}),
			/* @__PURE__ */ jsx(ViewTransition, {
				transitionKey: view,
				children: view === "search" ? /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 2,
					children: [/* @__PURE__ */ jsx(Text, {
						weight: "semibold",
						children: "Marketplace search view"
					}), /* @__PURE__ */ jsx(Text, {
						size: "sm",
						tone: "secondary",
						children: "Route-level transitions stay design-system led."
					})]
				}) }) : /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 2,
					children: [/* @__PURE__ */ jsx(Text, {
						weight: "semibold",
						children: "Item detail view"
					}), /* @__PURE__ */ jsx(Text, {
						size: "sm",
						tone: "secondary",
						children: "Panels can enter with shared timing and reduced-motion awareness."
					})]
				}) })
			}),
			/* @__PURE__ */ jsxs(Stagger, { children: [
				/* @__PURE__ */ jsx(Reveal, {
					preset: "fade",
					children: /* @__PURE__ */ jsx(Badge, {
						tone: "accent",
						children: "Fade"
					})
				}),
				/* @__PURE__ */ jsx(Reveal, {
					preset: "lift",
					children: /* @__PURE__ */ jsx(Badge, {
						tone: "success",
						children: "Lift"
					})
				}),
				/* @__PURE__ */ jsx(Reveal, {
					preset: "slideRight",
					children: /* @__PURE__ */ jsx(Badge, {
						tone: "info",
						children: "Slide Right"
					})
				})
			] })
		]
	}) });
}
function ShowcaseIconCard({ name }) {
	return /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsxs(Stack, {
		gap: 1,
		align: "center",
		children: [/* @__PURE__ */ jsx(Icon, {
			name,
			size: "md",
			tone: "accent"
		}), /* @__PURE__ */ jsx(Caption, { children: name })]
	}) });
}
function ComponentsView() {
	return /* @__PURE__ */ jsxs(Page, { children: [
		/* @__PURE__ */ jsx(PageHeader, {
			eyebrow: "Primitives",
			title: "Layout, typography, and feedback components",
			description: "Atomic building blocks that compose into marketplace and admin surfaces."
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Icons",
			children: /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsx(Inline, {
				gap: 4,
				children: showcaseIconNames.map((name) => /* @__PURE__ */ jsx(ShowcaseIconCard, { name }, name))
			}) })
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Typography",
			children: /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsxs(Stack, {
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(Heading, {
						level: 1,
						children: "Heading 1 - Display"
					}),
					/* @__PURE__ */ jsx(Heading, {
						level: 2,
						children: "Heading 2"
					}),
					/* @__PURE__ */ jsx(Heading, {
						level: 3,
						children: "Heading 3"
					}),
					/* @__PURE__ */ jsx(Heading, {
						level: 4,
						children: "Heading 4"
					}),
					/* @__PURE__ */ jsx(Heading, {
						level: 5,
						children: "Heading 5"
					}),
					/* @__PURE__ */ jsx(Heading, {
						level: 6,
						children: "Heading 6"
					}),
					/* @__PURE__ */ jsx(Divider, {}),
					/* @__PURE__ */ jsx(Text, { children: "Body text in the default size and weight." }),
					/* @__PURE__ */ jsx(Text, {
						size: "lg",
						weight: "semibold",
						children: "Large semibold text for emphasis."
					}),
					/* @__PURE__ */ jsx(Text, {
						size: "sm",
						tone: "secondary",
						children: "Small secondary text for supporting content."
					}),
					/* @__PURE__ */ jsx(Caption, { children: "Caption text for metadata and timestamps." }),
					/* @__PURE__ */ jsx(Label, { children: "Form label" }),
					/* @__PURE__ */ jsx(Label, {
						muted: true,
						children: "Muted label"
					}),
					/* @__PURE__ */ jsxs(Text, { children: [
						"Inline ",
						/* @__PURE__ */ jsx(CodeText, { children: "code snippets" }),
						" render in the mono font."
					] }),
					/* @__PURE__ */ jsx(LinkText, {
						href: "#",
						children: "Accent link with default styling"
					}),
					/* @__PURE__ */ jsx(LinkText, {
						href: "#",
						tone: "subtle",
						trailingIcon: "chevronRight",
						children: "Subtle link with trailing icon"
					}),
					/* @__PURE__ */ jsx(Quote, {
						cite: "- Design system principles",
						children: "Every component should be composable, accessible, and theme-aware without requiring custom CSS."
					}),
					/* @__PURE__ */ jsx(List, { items: [
						"Near Mint (NM)",
						"Light Play (LP)",
						"Moderate Play (MP)",
						"Heavy Play (HP)"
					] }),
					/* @__PURE__ */ jsx(List, {
						ordered: true,
						items: [
							"Search for your card",
							"Compare seller prices",
							"Add to cart and checkout"
						]
					})
				]
			}) })
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Layout Primitives",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 2
				},
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Box & Inset"
						}), /* @__PURE__ */ jsxs(Box, {
							padding: 4,
							gap: 2,
							children: [/* @__PURE__ */ jsx(Text, {
								size: "sm",
								tone: "secondary",
								children: "Box with padding=4 and gap=2"
							}), /* @__PURE__ */ jsx(Inset, {
								padding: 3,
								children: /* @__PURE__ */ jsx(Surface, {
									tone: "muted",
									children: /* @__PURE__ */ jsx(Text, {
										size: "sm",
										children: "Inset content inside a Box"
									})
								})
							})]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Center"
						}), /* @__PURE__ */ jsx(Surface, {
							tone: "muted",
							children: /* @__PURE__ */ jsx(Center, { children: /* @__PURE__ */ jsxs(Stack, {
								gap: 2,
								align: "center",
								children: [/* @__PURE__ */ jsx(Icon, {
									name: "spark",
									size: "lg",
									tone: "accent"
								}), /* @__PURE__ */ jsx(Text, {
									size: "sm",
									children: "Centered content"
								})]
							}) })
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Cluster"
						}), /* @__PURE__ */ jsxs(Cluster, {
							gap: 2,
							children: [
								/* @__PURE__ */ jsx(Badge, { children: "Tag A" }),
								/* @__PURE__ */ jsx(Badge, {
									tone: "accent",
									children: "Tag B"
								}),
								/* @__PURE__ */ jsx(Badge, {
									tone: "success",
									children: "Tag C"
								}),
								/* @__PURE__ */ jsx(Badge, {
									tone: "warning",
									children: "Tag D"
								}),
								/* @__PURE__ */ jsx(Badge, {
									tone: "info",
									children: "Tag E"
								})
							]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Spacer"
						}), /* @__PURE__ */ jsxs(Surface, {
							tone: "muted",
							children: [
								/* @__PURE__ */ jsx(Text, {
									size: "sm",
									children: "Above spacer"
								}),
								/* @__PURE__ */ jsx(Spacer, { size: 4 }),
								/* @__PURE__ */ jsx(Text, {
									size: "sm",
									children: "Below spacer (size=4)"
								})
							]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Container"
						}), /* @__PURE__ */ jsx(Container, {
							width: "narrow",
							paddingX: 4,
							children: /* @__PURE__ */ jsx(Surface, {
								tone: "muted",
								children: /* @__PURE__ */ jsx(Text, {
									size: "sm",
									children: "Narrow container (max-w-3xl)"
								})
							})
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "AspectRatio"
						}), /* @__PURE__ */ jsx(AspectRatio, {
							ratio: 16 / 9,
							children: /* @__PURE__ */ jsx(Surface, {
								tone: "accent",
								padding: 0,
								children: /* @__PURE__ */ jsx(Center, { children: /* @__PURE__ */ jsx(Text, {
									tone: "inverse",
									weight: "semibold",
									children: "16:9"
								}) })
							})
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "ScrollArea"
						}), /* @__PURE__ */ jsx(ScrollArea, {
							height: "sm",
							children: /* @__PURE__ */ jsx(Stack, {
								gap: 2,
								children: Array.from({ length: 12 }, (_, index) => /* @__PURE__ */ jsx(Inset, {
									padding: 3,
									children: /* @__PURE__ */ jsxs(Text, {
										size: "sm",
										children: ["Scrollable item ", index + 1]
									})
								}, index))
							})
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Divider"
							}),
							/* @__PURE__ */ jsx(Text, {
								size: "sm",
								children: "Content above"
							}),
							/* @__PURE__ */ jsx(Divider, {}),
							/* @__PURE__ */ jsx(Text, {
								size: "sm",
								children: "Content below"
							}),
							/* @__PURE__ */ jsxs(Inline, {
								gap: 3,
								align: "center",
								children: [
									/* @__PURE__ */ jsx(Text, {
										size: "sm",
										children: "Left"
									}),
									/* @__PURE__ */ jsx(Divider, { orientation: "vertical" }),
									/* @__PURE__ */ jsx(Text, {
										size: "sm",
										children: "Right"
									})
								]
							})
						]
					}) })
				]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Buttons & Navigation",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 2
				},
				gap: 4,
				children: [/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [
						/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Button Variants"
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 2,
							children: [
								/* @__PURE__ */ jsx(Button, { children: "Primary" }),
								/* @__PURE__ */ jsx(Button, {
									tone: "secondary",
									children: "Secondary"
								}),
								/* @__PURE__ */ jsx(Button, {
									tone: "ghost",
									children: "Ghost"
								}),
								/* @__PURE__ */ jsx(Button, {
									tone: "danger",
									children: "Danger"
								})
							]
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 2,
							children: [
								/* @__PURE__ */ jsx(Button, {
									size: "sm",
									children: "Small"
								}),
								/* @__PURE__ */ jsx(Button, {
									size: "md",
									children: "Medium"
								}),
								/* @__PURE__ */ jsx(Button, {
									size: "lg",
									children: "Large"
								})
							]
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 2,
							children: [
								/* @__PURE__ */ jsx(IconButton, {
									label: "Search",
									icon: "search"
								}),
								/* @__PURE__ */ jsx(IconButton, {
									label: "Settings",
									icon: "settings",
									tone: "secondary"
								}),
								/* @__PURE__ */ jsx(IconButton, {
									label: "Close",
									icon: "close",
									tone: "ghost"
								})
							]
						}),
						/* @__PURE__ */ jsx(LinkButton, {
							href: "#",
							leadingIcon: "cart",
							children: "Link as button"
						}),
						/* @__PURE__ */ jsxs(ButtonGroup, { children: [/* @__PURE__ */ jsx(Button, {
							tone: "secondary",
							size: "sm",
							children: "Secondary action"
						}), /* @__PURE__ */ jsx(Button, {
							size: "sm",
							children: "Primary action"
						})] })
					]
				}) }), /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsx(Heading, {
						level: 5,
						children: "NavRail"
					}), /* @__PURE__ */ jsx(NavRail, {
						items: adminNav,
						activeKey: "dashboard"
					})]
				}) })]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Motion",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 2
				},
				gap: 4,
				children: [/* @__PURE__ */ jsx(MotionDemo, {}), /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [
						/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Motion policy"
						}),
						/* @__PURE__ */ jsx(Text, {
							size: "sm",
							tone: "secondary",
							children: "`ChaseRoot` owns reduced-motion behavior with system, full, and reduced modes."
						}),
						/* @__PURE__ */ jsx(Text, {
							size: "sm",
							tone: "secondary",
							children: "Core overlays, navigation, tabs, cards, toasts, and wizards now inherit the same timing model."
						})
					]
				}) })]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Feedback & Overlays",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 2
				},
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Badges & Pills"
							}),
							/* @__PURE__ */ jsxs(Inline, {
								gap: 2,
								children: [
									/* @__PURE__ */ jsx(Badge, { children: "Neutral" }),
									/* @__PURE__ */ jsx(Badge, {
										tone: "accent",
										children: "Accent"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "success",
										children: "Success"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "warning",
										children: "Warning"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "danger",
										children: "Danger"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "info",
										children: "Info"
									})
								]
							}),
							/* @__PURE__ */ jsxs(Inline, {
								gap: 2,
								children: [
									/* @__PURE__ */ jsx(StatusPill, {
										tone: "success",
										children: "Active"
									}),
									/* @__PURE__ */ jsx(StatusPill, {
										tone: "warning",
										children: "Pending"
									}),
									/* @__PURE__ */ jsx(StatusPill, {
										tone: "danger",
										children: "Sold out"
									})
								]
							}),
							/* @__PURE__ */ jsxs(Inline, {
								gap: 2,
								children: [/* @__PURE__ */ jsx(Tag, {
									onRemove: () => {},
									children: "Removable"
								}), /* @__PURE__ */ jsx(Tag, {
									tone: "accent",
									onRemove: () => {},
									children: "Accent tag"
								})]
							})
						]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Banners"
							}),
							/* @__PURE__ */ jsx(Banner, {
								tone: "success",
								title: "Import complete",
								description: "42 new listings are live."
							}),
							/* @__PURE__ */ jsx(Banner, {
								tone: "warning",
								title: "Low stock alert",
								description: "19 SKUs need restocking."
							}),
							/* @__PURE__ */ jsx(Banner, {
								tone: "danger",
								title: "Payment failed",
								description: "Update your billing method."
							})
						]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Loading States"
							}),
							/* @__PURE__ */ jsx(LoadingSpinner, {
								size: "sm",
								label: "Fetching listings..."
							}),
							/* @__PURE__ */ jsx(LoadingSpinner, {
								size: "md",
								label: "Processing order..."
							}),
							/* @__PURE__ */ jsx(ProgressBar, {
								value: 65,
								tone: "accent"
							}),
							/* @__PURE__ */ jsx(ProgressBar, {
								value: 30,
								tone: "warning"
							}),
							/* @__PURE__ */ jsx(Skeleton, { height: "sm" }),
							/* @__PURE__ */ jsx(Skeleton, { height: "md" }),
							/* @__PURE__ */ jsx(Skeleton, { height: "lg" })
						]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Dialogs & Drawers"
						}), /* @__PURE__ */ jsxs(Inline, {
							gap: 2,
							children: [/* @__PURE__ */ jsx(Dialog, {
								trigger: /* @__PURE__ */ jsx(Button, {
									tone: "secondary",
									children: "Open dialog"
								}),
								title: "Confirm action",
								description: "This demonstrates the Dialog component.",
								footer: /* @__PURE__ */ jsx(Button, { children: "Done" }),
								children: /* @__PURE__ */ jsx(Text, { children: "Dialog content with any components inside." })
							}), /* @__PURE__ */ jsx(Drawer, {
								trigger: /* @__PURE__ */ jsx(Button, {
									tone: "secondary",
									children: "Open drawer"
								}),
								title: "Listing details",
								description: "Side panel for editing.",
								children: /* @__PURE__ */ jsxs(Stack, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(TextInput, {
										label: "Title",
										defaultValue: "Charizard ex"
									}), /* @__PURE__ */ jsx(CurrencyInput, {
										label: "Price",
										defaultValue: "29.95"
									})]
								})
							})]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Inline Messages & Helpers"
							}),
							/* @__PURE__ */ jsx(InlineMessage, {
								tone: "default",
								icon: "info",
								children: "Informational message for the user."
							}),
							/* @__PURE__ */ jsx(InlineMessage, {
								tone: "success",
								icon: "check",
								children: "Operation completed successfully."
							}),
							/* @__PURE__ */ jsx(InlineMessage, {
								tone: "danger",
								icon: "warning",
								children: "Something needs attention."
							}),
							/* @__PURE__ */ jsx(Field, {
								label: "Example field",
								children: /* @__PURE__ */ jsx(Text, {
									size: "sm",
									tone: "secondary",
									children: "Field wrapper for custom content."
								})
							}),
							/* @__PURE__ */ jsx(HelperText, { children: "Default helper text below a field." }),
							/* @__PURE__ */ jsx(HelperText, {
								tone: "danger",
								children: "Error helper text."
							}),
							/* @__PURE__ */ jsx(HelperText, {
								tone: "success",
								children: "Success helper text."
							})
						]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Empty States"
							}),
							/* @__PURE__ */ jsx(EmptyState, {
								title: "No results found",
								description: "Try adjusting your search or filters.",
								icon: "search",
								actions: /* @__PURE__ */ jsx(Button, {
									tone: "secondary",
									size: "sm",
									children: "Clear filters"
								})
							}),
							/* @__PURE__ */ jsx(EmptyStateIllustration, { title: "No chart data yet" })
						]
					}) })
				]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Data Display",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 2
				},
				gap: 4,
				children: [/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsx(Heading, {
						level: 5,
						children: "Table (simple)"
					}), /* @__PURE__ */ jsx(Table, {
						columns: [
							"Set",
							"Cards",
							"Completion"
						],
						rows: [
							[
								"Surging Sparks",
								"195",
								"82%"
							],
							[
								"Stellar Crown",
								"175",
								"64%"
							],
							[
								"Twilight Masquerade",
								"198",
								"91%"
							]
						],
						caption: "Set completion tracker"
					})]
				}) }), /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [
						/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Avatars"
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsx(Avatar, {
									name: "Todd S.",
									size: "sm"
								}),
								/* @__PURE__ */ jsx(Avatar, {
									name: "North Side",
									size: "md"
								}),
								/* @__PURE__ */ jsx(Avatar, {
									name: "Gem Mint TCG",
									size: "lg"
								})
							]
						}),
						/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Thumbnails"
						}),
						/* @__PURE__ */ jsxs(Grid, {
							columns: { base: 3 },
							gap: 2,
							children: [
								/* @__PURE__ */ jsx(Thumbnail, {
									alt: "Card front",
									ratio: 3 / 4,
									icon: "spark"
								}),
								/* @__PURE__ */ jsx(Thumbnail, {
									alt: "Card back",
									ratio: 3 / 4,
									icon: "package"
								}),
								/* @__PURE__ */ jsx(Thumbnail, {
									alt: "Card detail",
									ratio: 3 / 4,
									icon: "search"
								})
							]
						})
					]
				}) })]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "RecordPage Pattern",
			children: /* @__PURE__ */ jsx(RecordPage, {
				header: /* @__PURE__ */ jsx(PageHeader, {
					eyebrow: "Order #1042",
					title: "Charizard ex - 199/165",
					actions: /* @__PURE__ */ jsxs(Inline, {
						gap: 2,
						children: [/* @__PURE__ */ jsx(Button, {
							tone: "secondary",
							children: "Edit"
						}), /* @__PURE__ */ jsx(Button, {
							tone: "danger",
							children: "Cancel order"
						})]
					})
				}),
				summary: /* @__PURE__ */ jsxs(Stack, {
					gap: 4,
					children: [/* @__PURE__ */ jsx(KeyValueList, { items: [
						{
							key: "Buyer",
							value: "Todd S."
						},
						{
							key: "Status",
							value: "Shipped"
						},
						{
							key: "Tracking",
							value: "9400111899223"
						},
						{
							key: "Total",
							value: "$34.20"
						}
					] }), /* @__PURE__ */ jsx(Timeline, { items: [
						{
							title: "Delivered",
							timestamp: "Mar 5, 2026"
						},
						{
							title: "In transit",
							timestamp: "Mar 3, 2026"
						},
						{
							title: "Shipped",
							timestamp: "Mar 2, 2026"
						},
						{
							title: "Order placed",
							timestamp: "Mar 1, 2026"
						}
					] })]
				}),
				details: /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsxs(Stack, {
					gap: 4,
					children: [/* @__PURE__ */ jsx(Heading, {
						level: 5,
						children: "Order Details"
					}), /* @__PURE__ */ jsx(KeyValueList, { items: [
						{
							key: "Card",
							value: "Charizard ex"
						},
						{
							key: "Set",
							value: "Surging Sparks"
						},
						{
							key: "Condition",
							value: "Near Mint"
						},
						{
							key: "Seller",
							value: "North Side Cards"
						}
					] })]
				}) })
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "New Components",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 2
				},
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(Heading, {
								level: 5,
								children: "Rating"
							}),
							/* @__PURE__ */ jsxs(Inline, {
								gap: 4,
								align: "center",
								children: [/* @__PURE__ */ jsx(Rating, {
									value: 4,
									max: 5,
									size: "md",
									label: "Product rating"
								}), /* @__PURE__ */ jsx(Rating, {
									value: 3.5,
									max: 5,
									size: "sm",
									label: "Small rating"
								})]
							}),
							/* @__PURE__ */ jsx(Text, {
								size: "sm",
								tone: "secondary",
								children: "Interactive rating:"
							}),
							/* @__PURE__ */ jsx(RatingDemo, {})
						]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "CopyButton"
						}), /* @__PURE__ */ jsxs(Inline, {
							gap: 2,
							children: [/* @__PURE__ */ jsx(CopyButton, {
								value: "CS-001-NM",
								label: "Copy SKU",
								copiedLabel: "SKU copied!"
							}), /* @__PURE__ */ jsx(CopyButton, {
								value: "https://chase-sets.com/listing/199",
								tone: "ghost"
							})]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Accordion"
						}), /* @__PURE__ */ jsx(Accordion, {
							type: "single",
							collapsible: true,
							items: [
								{
									value: "details",
									trigger: "Card Details",
									content: /* @__PURE__ */ jsx(Text, {
										size: "sm",
										children: "Charizard ex - 199/165, Surging Sparks. Illustration rare with textured holo."
									})
								},
								{
									value: "condition",
									trigger: "Condition Guide",
									content: /* @__PURE__ */ jsx(Text, {
										size: "sm",
										children: "Near Mint (NM): Minimal edge wear, no scratches on holo surface."
									})
								},
								{
									value: "shipping",
									trigger: "Shipping Policy",
									content: /* @__PURE__ */ jsx(Text, {
										size: "sm",
										children: "Free standard shipping on orders over $25. Cards ship in penny sleeve + toploader."
									})
								}
							]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "ImageGallery"
						}), /* @__PURE__ */ jsx(ImageGallery, { images: [
							{
								src: "https://placehold.co/300x400/1a1a2e/eaeaea?text=Front",
								alt: "Card front"
							},
							{
								src: "https://placehold.co/300x400/16213e/eaeaea?text=Back",
								alt: "Card back"
							},
							{
								src: "https://placehold.co/300x400/0f3460/eaeaea?text=Close-up",
								alt: "Holo close-up"
							}
						] })]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "TagInput"
						}), /* @__PURE__ */ jsx(TagInputDemo, {})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "PasswordInput"
						}), /* @__PURE__ */ jsx(PasswordInput, {
							label: "Password",
							placeholder: "Enter password"
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Card with Media Slot"
						}), /* @__PURE__ */ jsx(Card, {
							media: /* @__PURE__ */ jsx(AspectRatio, {
								ratio: 3 / 4,
								children: /* @__PURE__ */ jsx(Surface, {
									tone: "accent",
									padding: 0,
									children: /* @__PURE__ */ jsx(Center, { children: /* @__PURE__ */ jsx(Icon, {
										name: "image",
										size: "lg",
										tone: "inverse"
									}) })
								})
							}),
							interactive: true,
							children: /* @__PURE__ */ jsxs(Stack, {
								gap: 1,
								children: [
									/* @__PURE__ */ jsx(Text, {
										weight: "semibold",
										children: "Charizard ex - 199/165"
									}),
									/* @__PURE__ */ jsx(Text, {
										size: "sm",
										tone: "secondary",
										children: "Near Mint - Surging Sparks"
									}),
									/* @__PURE__ */ jsx(PriceDisplay, { amount: 29.95 })
								]
							})
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Enhanced Menu"
						}), /* @__PURE__ */ jsx(Menu, {
							trigger: /* @__PURE__ */ jsx(Button, {
								tone: "secondary",
								children: "Actions menu"
							}),
							groups: [{
								label: "Listing",
								items: [{
									key: "edit",
									label: "Edit listing",
									icon: "edit",
									onSelect: () => {}
								}, {
									key: "copy",
									label: "Copy link",
									icon: "copy",
									shortcut: "Ctrl+C",
									onSelect: () => {}
								}]
							}, {
								label: "Danger zone",
								items: [{
									key: "delete",
									label: "Delete listing",
									icon: "trash",
									disabled: false,
									onSelect: () => {}
								}]
							}]
						})]
					}) }),
					/* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsxs(Stack, {
						gap: 3,
						children: [/* @__PURE__ */ jsx(Heading, {
							level: 5,
							children: "Design System ColorModeToggle"
						}), /* @__PURE__ */ jsx(ColorModeToggleDemo, {})]
					}) })
				]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Wizard Pattern",
			children: /* @__PURE__ */ jsx(WizardDemo, {})
		}),
		/* @__PURE__ */ jsx(VisuallyHidden, { children: /* @__PURE__ */ jsx(Text, { children: "This text is visually hidden but available to screen readers." }) })
	] });
}
//#endregion
//#region app/routes/components.tsx
var components_exports = /* @__PURE__ */ __exportAll({
	default: () => components_default,
	meta: () => meta
});
var meta = () => [{ title: "Components Showcase" }];
var components_default = UNSAFE_withComponentProps(function ComponentsShowcaseRoute() {
	return /* @__PURE__ */ jsx(ComponentsView, {});
});
//#endregion
//#region \0virtual:react-router/server-manifest
var server_manifest_default = {
	"entry": {
		"module": "/assets/entry.client-BIqEK2eA.js",
		"imports": ["/assets/jsx-runtime-tyc0aEiz.js", "/assets/react-dom-Cpcj4XpI.js"],
		"css": []
	},
	"routes": {
		"root": {
			"id": "root",
			"parentId": void 0,
			"path": "",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/assets/root-CB3tiBIh.js",
			"imports": ["/assets/jsx-runtime-tyc0aEiz.js", "/assets/react-dom-Cpcj4XpI.js"],
			"css": ["/assets/root-4R7eI0Ia.css"],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/layout": {
			"id": "routes/layout",
			"parentId": "root",
			"path": void 0,
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/assets/layout-DaBb3yJO.js",
			"imports": [
				"/assets/jsx-runtime-tyc0aEiz.js",
				"/assets/src-JmgAgm4E.js",
				"/assets/react-dom-Cpcj4XpI.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/marketplace": {
			"id": "routes/marketplace",
			"parentId": "routes/layout",
			"path": void 0,
			"index": true,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/assets/marketplace-BETqHd40.js",
			"imports": [
				"/assets/jsx-runtime-tyc0aEiz.js",
				"/assets/fixtures-BVzQ3ml4.js",
				"/assets/src-JmgAgm4E.js",
				"/assets/react-dom-Cpcj4XpI.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/admin": {
			"id": "routes/admin",
			"parentId": "routes/layout",
			"path": "admin",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/assets/admin-DNxUWwh7.js",
			"imports": [
				"/assets/jsx-runtime-tyc0aEiz.js",
				"/assets/fixtures-BVzQ3ml4.js",
				"/assets/src-JmgAgm4E.js",
				"/assets/react-dom-Cpcj4XpI.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/components": {
			"id": "routes/components",
			"parentId": "routes/layout",
			"path": "components",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/assets/components-C04xGsKB.js",
			"imports": [
				"/assets/jsx-runtime-tyc0aEiz.js",
				"/assets/fixtures-BVzQ3ml4.js",
				"/assets/src-JmgAgm4E.js",
				"/assets/react-dom-Cpcj4XpI.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		}
	},
	"url": "/assets/manifest-40941083.js",
	"version": "40941083",
	"sri": void 0
};
//#endregion
//#region \0virtual:react-router/server-build
var assetsBuildDirectory = "build\\client";
var basename = "/";
var future = {
	"unstable_optimizeDeps": false,
	"unstable_passThroughRequests": false,
	"unstable_subResourceIntegrity": false,
	"unstable_trailingSlashAwareDataRequests": false,
	"unstable_previewServerPrerendering": false,
	"v8_middleware": false,
	"v8_splitRouteModules": false,
	"v8_viteEnvironmentApi": false
};
var ssr = true;
var isSpaMode = false;
var prerender = [];
var routeDiscovery = {
	"mode": "lazy",
	"manifestPath": "/__manifest"
};
var publicPath = "/";
var entry = { module: entry_server_node_exports };
var routes = {
	"root": {
		id: "root",
		parentId: void 0,
		path: "",
		index: void 0,
		caseSensitive: void 0,
		module: root_exports
	},
	"routes/layout": {
		id: "routes/layout",
		parentId: "root",
		path: void 0,
		index: void 0,
		caseSensitive: void 0,
		module: layout_exports
	},
	"routes/marketplace": {
		id: "routes/marketplace",
		parentId: "routes/layout",
		path: void 0,
		index: true,
		caseSensitive: void 0,
		module: marketplace_exports
	},
	"routes/admin": {
		id: "routes/admin",
		parentId: "routes/layout",
		path: "admin",
		index: void 0,
		caseSensitive: void 0,
		module: admin_exports
	},
	"routes/components": {
		id: "routes/components",
		parentId: "routes/layout",
		path: "components",
		index: void 0,
		caseSensitive: void 0,
		module: components_exports
	}
};
var allowedActionOrigins = false;
//#endregion
export { allowedActionOrigins, server_manifest_default as assets, assetsBuildDirectory, basename, entry, future, isSpaMode, prerender, publicPath, routeDiscovery, routes, ssr };
