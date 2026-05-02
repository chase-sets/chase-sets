import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, ServerRouter, UNSAFE_withComponentProps, useLocation, useNavigate } from "react-router";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { createContext, forwardRef, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { BadgeCheck, BarChart3, Bell, BookOpen, Bot, BriefcaseBusiness, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, CircleHelp, Clock, Copy, CreditCard, DollarSign, ExternalLink, Eye, EyeOff, Flame, Grid2X2, Heart, Home, ImageIcon, Info, LayoutDashboard, LockKeyhole, Menu, MessageSquare, Minus, MoreVertical, Package, Pencil, Plus, Rocket, Search, Settings, Share2, ShieldCheck, Shirt, ShoppingBag, ShoppingCart, SlidersHorizontal, Sparkles, Star, StarHalf, Store, Tags, Trash2, TriangleAlert, Truck, User, Users, WalletCards, X } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toolbar } from "@base-ui/react/toolbar";
import { NavigationMenu } from "@base-ui/react/navigation-menu";
import { Separator } from "@base-ui/react/separator";
import { Toast } from "@base-ui/react/toast";
import { Field } from "@base-ui/react/field";
import { Select } from "@base-ui/react/select";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { NumberField } from "@base-ui/react/number-field";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
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
//#region ../../packages/design-system/src/brand/chase-sets-logo.tsx
function ChaseSetsLogo({ decorative = false, size = 24, title = "Chase Sets", ...rest }) {
	const gradientId = `chase-sets-logo-${useId().replaceAll(":", "")}`;
	const accessibleTitle = decorative ? void 0 : title;
	return /* @__PURE__ */ jsxs("svg", {
		...rest,
		xmlns: "http://www.w3.org/2000/svg",
		width: size,
		height: size,
		viewBox: "0 0 1254 1254",
		role: decorative ? void 0 : "img",
		"aria-hidden": decorative ? true : void 0,
		"aria-label": accessibleTitle,
		focusable: "false",
		children: [/* @__PURE__ */ jsx("defs", { children: /* @__PURE__ */ jsxs("linearGradient", {
			id: gradientId,
			gradientUnits: "userSpaceOnUse",
			x1: "248",
			y1: "420",
			x2: "1012",
			y2: "842",
			children: [
				/* @__PURE__ */ jsx("stop", {
					offset: "0",
					stopColor: "#05c2ef"
				}),
				/* @__PURE__ */ jsx("stop", {
					offset: "0.48",
					stopColor: "#1d64ff"
				}),
				/* @__PURE__ */ jsx("stop", {
					offset: "1",
					stopColor: "#702cff"
				})
			]
		}) }), /* @__PURE__ */ jsxs("g", {
			fill: `url(#${gradientId})`,
			children: [/* @__PURE__ */ jsx("path", { d: "M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z" }), /* @__PURE__ */ jsx("path", { d: "M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z" })]
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/utils/cx.ts
function cx(...values) {
	return values.filter(Boolean).join(" ");
}
//#endregion
//#region ../../packages/design-system/src/icons/index.tsx
var iconMap = {
	search: Search,
	cart: ShoppingCart,
	filter: SlidersHorizontal,
	dashboard: LayoutDashboard,
	close: X,
	check: Check,
	warning: TriangleAlert,
	chevronDown: ChevronDown,
	chevronUp: ChevronUp,
	chevronLeft: ChevronLeft,
	chevronRight: ChevronRight,
	menu: Menu,
	spark: Sparkles,
	package: Package,
	settings: Settings,
	user: User,
	info: Info,
	star: Star,
	starHalf: StarHalf,
	starEmpty: Star,
	copy: Copy,
	plus: Plus,
	minus: Minus,
	edit: Pencil,
	trash: Trash2,
	heart: Heart,
	heartFilled: Heart,
	share: Share2,
	image: ImageIcon,
	dollar: DollarSign,
	truck: Truck,
	clock: Clock,
	eye: Eye,
	eyeOff: EyeOff,
	home: Home,
	bell: Bell,
	message: MessageSquare,
	help: CircleHelp,
	calendar: CalendarDays,
	tag: Tags,
	shield: ShieldCheck,
	cards: BadgeCheck,
	book: BookOpen,
	figure: Bot,
	sneaker: ShoppingBag,
	shirt: Shirt,
	grid: Grid2X2,
	lock: LockKeyhole,
	creditCard: CreditCard,
	chart: BarChart3,
	users: Users,
	rocket: Rocket,
	externalLink: ExternalLink,
	moreVertical: MoreVertical,
	badgeCheck: BadgeCheck,
	flame: Flame,
	circle: Circle,
	wallet: WalletCards,
	bag: BriefcaseBusiness,
	store: Store
};
var sizeClasses = {
	sm: "h-4 w-4",
	md: "h-5 w-5",
	lg: "h-6 w-6"
};
var toneClasses = {
	primary: "text-foreground",
	secondary: "text-secondary",
	tertiary: "text-tertiary",
	accent: "text-accent",
	accent2: "text-accent-2",
	success: "text-success",
	warning: "text-warning",
	danger: "text-danger",
	info: "text-info",
	inverse: "text-inverse"
};
function Icon({ name, size = "md", tone = "primary", label, ...rest }) {
	const Glyph = iconMap[name];
	const decorative = !label;
	const filled = name === "star" || name === "starHalf" || name === "heartFilled";
	return /* @__PURE__ */ jsx("span", {
		...rest,
		className: cx("inline-flex shrink-0 items-center", toneClasses[tone]),
		children: /* @__PURE__ */ jsx(Glyph, {
			"aria-hidden": decorative,
			"aria-label": label,
			strokeWidth: 2,
			fill: filled ? "currentColor" : "none",
			className: sizeClasses[size]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/theme/tokens.ts
var chaseTheme = {
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
		glowBlue: "rgba(139, 92, 246, 0.26)"
	},
	typography: {
		display: "Space Grotesk",
		heading: "Space Grotesk",
		body: "Space Grotesk",
		mono: "IBM Plex Mono"
	},
	radius: {
		sm: "0.375rem",
		md: "0.75rem",
		lg: "1rem",
		xl: "1.5rem"
	},
	shadows: {
		sm: "0 10px 30px -20px rgba(15, 23, 42, 0.24)",
		md: "0 18px 50px -26px rgba(30, 64, 175, 0.3)",
		lg: "0 28px 74px -34px rgba(37, 99, 235, 0.38)",
		overlay: "0 36px 104px -32px rgba(30, 64, 175, 0.44)"
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
						className: cx("chase-root relative isolate min-h-screen w-full min-w-0 max-w-full overflow-x-clip bg-background font-body text-foreground"),
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
//#endregion
//#region ../../packages/design-system/src/utils/motion-props.ts
function toMotionDomProps(props) {
	return props;
}
//#endregion
//#region ../../packages/design-system/src/components/actions/shared.tsx
var buttonToneClasses = {
	primary: "border-transparent bg-accent text-accent-contrast shadow-[0_0_22px_-12px_var(--glow-accent)] hover:bg-accent-hover hover:shadow-[0_0_30px_-12px_var(--glow-accent)]",
	secondary: "border-border bg-surface-2 text-foreground hover:border-accent hover:text-accent",
	ghost: "border-transparent bg-transparent text-secondary hover:border-border hover:bg-surface-2 hover:text-foreground",
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
var buttonBaseClass = "focus-ring relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-tokenMd border font-semibold shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
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
		className: cx("absolute inset-0 rounded-tokenMd", tone === "accent" ? "bg-surface-2 shadow-tokenSm" : "bg-surface-2 shadow-tokenSm"),
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
	const nativeProps = toMotionDomProps(rest);
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
	const nativeProps = toMotionDomProps(rest);
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
	const nativeProps = toMotionDomProps(rest);
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
function Tabs$1({ items, defaultValue, value, onValueChange, orientation = "horizontal", dir, activationMode = "automatic" }) {
	const resolvedValue = defaultValue ?? items[0]?.value;
	const [internalValue, setInternalValue] = useState(resolvedValue);
	const currentValue = value ?? internalValue ?? resolvedValue;
	const groupId = useId();
	function handleValueChange(nextValue) {
		if (value === void 0) setInternalValue(nextValue);
		onValueChange?.(nextValue);
	}
	return /* @__PURE__ */ jsxs(Tabs.Root, {
		defaultValue: resolvedValue,
		value: currentValue,
		onValueChange: handleValueChange,
		orientation,
		className: "space-y-4",
		children: [/* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: /* @__PURE__ */ jsx(Tabs.List, {
				className: "grid w-full min-w-0 max-w-full grid-cols-2 gap-2 rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap",
				children: items.map((item) => {
					const active = item.value === currentValue;
					return /* @__PURE__ */ jsxs(Tabs.Tab, {
						value: item.value,
						className: (state) => cx("focus-ring relative inline-flex touch-target min-w-0 items-center justify-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-center text-sm font-semibold text-secondary transition md:flex-1 md:basis-0 md:px-4", state.active && "text-accent"),
						children: [
							active ? renderActivePill(groupId, "accent") : null,
							/* @__PURE__ */ jsx("span", {
								className: "relative z-10 min-w-0 break-words",
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
				children: /* @__PURE__ */ jsx(Tabs.Panel, {
					value: currentValue,
					keepMounted: true,
					className: "focus-visible:outline-none",
					children: items.find((item) => item.value === currentValue)?.content
				})
			}, currentValue)
		})]
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/segmented-control.tsx
function SegmentedControl({ items, value, fullWidth = false, onValueChange, ...rest }) {
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
			className: cx("rounded-tokenLg border border-muted bg-background p-1", fullWidth ? "grid w-full grid-flow-col auto-cols-fr" : "inline-flex flex-wrap"),
			children: items.map((item, index) => {
				const active = item.value === value;
				return /* @__PURE__ */ jsxs("button", {
					type: "button",
					role: "tab",
					"aria-selected": active,
					tabIndex: active ? 0 : -1,
					className: cx("focus-ring relative inline-flex min-h-10 items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-semibold transition", fullWidth && "justify-center", active ? "text-accent" : "text-secondary hover:text-foreground"),
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
//#region ../../packages/design-system/src/components/actions/toggle.tsx
function Toggle$1({ children, value, pressed, defaultPressed, onPressedChange, disabled = false, size = "md", icon, "aria-label": ariaLabel }) {
	return /* @__PURE__ */ jsxs(Toggle, {
		type: "button",
		value,
		pressed,
		defaultPressed,
		onPressedChange: (nextPressed) => onPressedChange?.(nextPressed),
		disabled,
		"aria-label": ariaLabel,
		className: (state) => cx(buttonBaseClass, buttonSizeClasses[size], state.pressed ? "border-accent bg-accent text-accent-contrast" : "border-border bg-surface-2 text-secondary hover:border-accent hover:text-accent", state.disabled && "cursor-not-allowed opacity-50 shadow-none"),
		children: [icon ? /* @__PURE__ */ jsx(Icon, {
			name: icon,
			size: "sm",
			tone: pressed ? "inverse" : "secondary"
		}) : null, children ? /* @__PURE__ */ jsx("span", { children }) : null]
	});
}
function ToggleGroup$1({ items, value, defaultValue, onValueChange, multiple = false, orientation = "horizontal", disabled = false, label, size = "sm" }) {
	return /* @__PURE__ */ jsx(ToggleGroup, {
		value,
		defaultValue,
		onValueChange: (nextValue) => onValueChange?.(nextValue),
		multiple,
		orientation,
		disabled,
		"aria-label": label,
		className: cx("inline-flex gap-2 rounded-tokenLg bg-surface-2 p-1", orientation === "vertical" && "flex-col"),
		children: items.map((item) => /* @__PURE__ */ jsxs(Toggle, {
			type: "button",
			value: item.value,
			disabled: item.disabled,
			className: (state) => cx(buttonBaseClass, buttonCompactSizeClasses[size], state.pressed ? "border-accent bg-elevated text-accent shadow-tokenSm" : "border-transparent bg-transparent text-secondary shadow-none hover:bg-elevated hover:text-foreground", state.disabled && "cursor-not-allowed opacity-50"),
			children: [item.icon ? /* @__PURE__ */ jsx(Icon, {
				name: item.icon,
				size: "sm",
				tone: item.disabled ? "secondary" : "accent"
			}) : null, /* @__PURE__ */ jsx("span", { children: item.label })]
		}, item.value))
	});
}
//#endregion
//#region ../../packages/design-system/src/components/actions/toolbar.tsx
function Toolbar$1({ children, label, orientation = "horizontal" }) {
	return /* @__PURE__ */ jsx(Toolbar.Root, {
		"aria-label": label,
		orientation,
		className: cx("inline-flex items-center gap-1 rounded-tokenLg border border-muted bg-surface-2 p-1", orientation === "vertical" && "flex-col items-stretch"),
		children
	});
}
function ToolbarButton({ children, icon, type = "button", ...rest }) {
	return /* @__PURE__ */ jsxs(Toolbar.Button, {
		...rest,
		type,
		className: "focus-ring inline-flex min-h-8 items-center justify-center gap-2 rounded-tokenMd px-2.5 text-sm font-semibold text-secondary transition hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
		children: [icon ? /* @__PURE__ */ jsx(Icon, {
			name: icon,
			size: "sm",
			tone: "secondary"
		}) : null, children ? /* @__PURE__ */ jsx("span", { children }) : null]
	});
}
function ToolbarInput(props) {
	return /* @__PURE__ */ jsx(Toolbar.Input, {
		...props,
		className: "focus-ring min-h-8 w-44 rounded-tokenMd border border-muted bg-elevated px-3 text-sm text-foreground placeholder:text-secondary"
	});
}
function ToolbarSeparator() {
	return /* @__PURE__ */ jsx(Toolbar.Separator, { className: "mx-1 h-5 w-px bg-muted" });
}
//#endregion
//#region ../../packages/design-system/src/components/actions/navigation-menu.tsx
function NavigationMenu$1({ items, value, defaultValue, onValueChange, orientation = "horizontal", label = "Primary navigation" }) {
	const { overlayNode } = usePortalRoots();
	return /* @__PURE__ */ jsxs(NavigationMenu.Root, {
		value,
		defaultValue,
		onValueChange: (nextValue) => onValueChange?.(nextValue),
		orientation,
		"aria-label": label,
		className: "relative",
		children: [/* @__PURE__ */ jsx(NavigationMenu.List, {
			className: cx("flex gap-1 rounded-tokenLg border border-muted bg-surface-2 p-1", orientation === "vertical" && "flex-col"),
			children: items.map((item) => /* @__PURE__ */ jsx(NavigationMenu.Item, {
				value: item.value,
				children: item.content ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs(NavigationMenu.Trigger, {
					className: (state) => cx("focus-ring inline-flex min-h-9 items-center gap-2 rounded-tokenMd px-3 text-sm font-semibold text-secondary transition hover:bg-elevated hover:text-foreground", state.open && "bg-elevated text-accent"),
					children: [/* @__PURE__ */ jsx("span", { children: item.label }), /* @__PURE__ */ jsx(NavigationMenu.Icon, { children: /* @__PURE__ */ jsx(Icon, {
						name: "chevronDown",
						size: "sm",
						tone: "secondary"
					}) })]
				}), /* @__PURE__ */ jsx(NavigationMenu.Content, {
					className: "p-4",
					children: item.content
				})] }) : /* @__PURE__ */ jsx(NavigationMenu.Link, {
					href: item.href,
					active: item.active,
					closeOnClick: true,
					className: (state) => cx("focus-ring inline-flex min-h-9 items-center rounded-tokenMd px-3 text-sm font-semibold text-secondary transition hover:bg-elevated hover:text-foreground", state.active && "bg-elevated text-accent"),
					children: item.label
				})
			}, item.value))
		}), /* @__PURE__ */ jsx(NavigationMenu.Portal, {
			container: overlayNode ?? void 0,
			children: /* @__PURE__ */ jsx(NavigationMenu.Positioner, {
				sideOffset: 8,
				className: "z-popover",
				children: /* @__PURE__ */ jsx(NavigationMenu.Popup, {
					className: "modern-surface min-w-72 overflow-hidden rounded-tokenLg border border-muted shadow-overlay",
					children: /* @__PURE__ */ jsx(NavigationMenu.Viewport, {})
				})
			})
		})]
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
	},
	5: {
		base: "grid-cols-5",
		sm: "sm:grid-cols-5",
		md: "md:grid-cols-5",
		lg: "lg:grid-cols-5",
		xl: "xl:grid-cols-5",
		"2xl": "2xl:grid-cols-5"
	}
};
var spaceClasses = {
	p: {
		0: "p-0",
		1: "p-1",
		2: "p-2",
		3: "p-3",
		4: "p-4",
		5: "p-5",
		6: "p-6",
		7: "p-7",
		8: "p-8",
		9: "p-9",
		10: "p-10",
		11: "p-11",
		12: "p-12"
	},
	px: {
		0: "px-0",
		1: "px-1",
		2: "px-2",
		3: "px-3",
		4: "px-4",
		5: "px-5",
		6: "px-6",
		7: "px-7",
		8: "px-8",
		9: "px-9",
		10: "px-10",
		11: "px-11",
		12: "px-12"
	},
	py: {
		0: "py-0",
		1: "py-1",
		2: "py-2",
		3: "py-3",
		4: "py-4",
		5: "py-5",
		6: "py-6",
		7: "py-7",
		8: "py-8",
		9: "py-9",
		10: "py-10",
		11: "py-11",
		12: "py-12"
	},
	m: {
		0: "m-0",
		1: "m-1",
		2: "m-2",
		3: "m-3",
		4: "m-4",
		5: "m-5",
		6: "m-6",
		7: "m-7",
		8: "m-8",
		9: "m-9",
		10: "m-10",
		11: "m-11",
		12: "m-12"
	},
	mx: {
		0: "mx-0",
		1: "mx-1",
		2: "mx-2",
		3: "mx-3",
		4: "mx-4",
		5: "mx-5",
		6: "mx-6",
		7: "mx-7",
		8: "mx-8",
		9: "mx-9",
		10: "mx-10",
		11: "mx-11",
		12: "mx-12"
	},
	my: {
		0: "my-0",
		1: "my-1",
		2: "my-2",
		3: "my-3",
		4: "my-4",
		5: "my-5",
		6: "my-6",
		7: "my-7",
		8: "my-8",
		9: "my-9",
		10: "my-10",
		11: "my-11",
		12: "my-12"
	},
	gap: {
		0: "gap-0",
		1: "gap-1",
		2: "gap-2",
		3: "gap-3",
		4: "gap-4",
		5: "gap-5",
		6: "gap-6",
		7: "gap-7",
		8: "gap-8",
		9: "gap-9",
		10: "gap-10",
		11: "gap-11",
		12: "gap-12"
	}
};
function resolveSpaceClass(prefix, value) {
	if (value === void 0) return "";
	return spaceClasses[prefix][value];
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
var layoutWidthClasses = {
	narrow: "max-w-3xl",
	content: "max-w-5xl",
	wide: "max-w-7xl",
	expanded: "max-w-screen-2xl",
	full: "max-w-none"
};
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
function Grid({ children, columns = {
	base: 1,
	md: 2,
	xl: 3
}, gap = 4, align, justify, ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("grid", resolveColumnsClass(columns), resolveAlignClass(align), resolveJustifyClass(justify), resolveSpaceClass("gap", gap)),
		children
	});
}
var surfaceToneClasses = {
	default: "glass-surface bg-elevated",
	muted: "bg-surface-2",
	accent: "brand-gradient text-accent-contrast",
	subtle: "bg-surface border-muted"
};
function Surface({ children, element = "div", tone = "default", elevated = false, glow = false, padding = 4, paddingX, paddingY, gap, textAlign, ...rest }) {
	return /* @__PURE__ */ jsx(element, {
		...rest,
		className: cx("surface-border min-w-0 max-w-full rounded-tokenLg", surfaceToneClasses[tone], resolveSystemProps({
			padding,
			paddingX,
			paddingY,
			gap,
			textAlign
		}), elevated ? "shadow-tokenLg" : "shadow-tokenSm", glow && "glow-accent"),
		children
	});
}
function Divider({ orientation = "horizontal", decorative = true, ...rest }) {
	return /* @__PURE__ */ jsx(Separator, {
		...rest,
		"aria-hidden": decorative || void 0,
		orientation,
		className: cx("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px")
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
function renderNavigationItem(item, active, orientation, groupId, onSelect, activeKey) {
	const content = /* @__PURE__ */ jsxs(Fragment, { children: [
		item.avatar ? item.avatar : item.icon ? /* @__PURE__ */ jsx(Icon, {
			name: item.icon,
			size: "sm",
			tone: active ? "accent" : "secondary"
		}) : null,
		/* @__PURE__ */ jsx("span", {
			className: cx(orientation === "rail" && "text-xs"),
			children: item.label
		}),
		item.badge ? /* @__PURE__ */ jsx("span", {
			className: "rounded-full bg-accent px-2 py-0.5 text-[0.7rem] font-semibold text-accent-contrast",
			children: item.badge
		}) : null
	] });
	const className = cx("focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition", orientation === "vertical" && "w-full justify-between", orientation === "rail" && "w-full flex-col justify-center py-3", active ? "bg-surface-2 text-accent shadow-tokenSm" : "text-secondary hover:bg-surface-2 hover:text-foreground");
	if (orientation === "horizontal" && item.children?.length) {
		const childIsActive = active;
		return /* @__PURE__ */ jsxs("details", {
			className: "group relative",
			children: [/* @__PURE__ */ jsxs("summary", {
				className: cx(className, "list-none [&::-webkit-details-marker]:hidden", childIsActive && "bg-surface-2 text-accent shadow-tokenSm"),
				children: [
					childIsActive && groupId ? renderActivePill(groupId) : null,
					/* @__PURE__ */ jsx("span", {
						className: "relative z-10 inline-flex items-center gap-2",
						children: content
					}),
					/* @__PURE__ */ jsx(Icon, {
						name: "chevronDown",
						size: "sm",
						tone: childIsActive ? "accent" : "secondary"
					})
				]
			}), /* @__PURE__ */ jsx("div", {
				className: "modern-surface absolute left-0 top-[calc(100%+0.5rem)] z-dropdown min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay",
				children: item.children.map((child) => renderNavigationItem(child, child.key === activeKey, "vertical", void 0, onSelect, activeKey))
			})]
		}, item.key);
	}
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
				className: "absolute -right-2 -top-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.65rem] font-semibold leading-none text-accent-contrast shadow-tokenSm",
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
	const className = cx("focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-3 py-3 text-sm font-medium transition", active ? "bg-surface-2 text-accent shadow-tokenSm" : "text-secondary hover:bg-surface-2 hover:text-foreground");
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
function isNavigationItemActive(item, activeKey) {
	return item.key === activeKey || Boolean(item.children?.some((child) => child.key === activeKey));
}
function TopNav({ items, activeKey, onSelect, brand, actions, width = "full", ...rest }) {
	const groupId = useId();
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		className: "sticky top-0 z-sticky border-b border-muted bg-background/88 px-4 py-3 shadow-tokenSm backdrop-blur-xl",
		children: /* @__PURE__ */ jsxs("div", {
			className: cx("mx-auto flex w-full items-center justify-between gap-4", layoutWidthClasses[width]),
			children: [/* @__PURE__ */ jsxs("div", {
				className: "flex items-center gap-4",
				children: [brand, /* @__PURE__ */ jsx(LayoutGroup, {
					id: groupId,
					children: /* @__PURE__ */ jsx("div", {
						className: "hidden items-center gap-1 md:flex",
						children: items.map((item) => renderNavigationItem(item, isNavigationItemActive(item, activeKey), "horizontal", groupId, onSelect, activeKey))
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
		className: "glass-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm",
		children: /* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: items.map((item) => renderNavigationItem(item, item.key === activeKey, "vertical", groupId, onSelect, activeKey))
		})
	});
}
function BottomNav({ items, activeKey, onSelect, width = "full", ...rest }) {
	const groupId = useId();
	return /* @__PURE__ */ jsx("nav", {
		...rest,
		className: "fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-background/88 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-tokenLg backdrop-blur-xl md:hidden",
		children: /* @__PURE__ */ jsx(LayoutGroup, {
			id: groupId,
			children: /* @__PURE__ */ jsx("div", {
				className: cx("mx-auto grid w-full grid-cols-4 gap-2", layoutWidthClasses[width]),
				children: items.slice(0, 4).map((item) => renderBottomNavigationItem(item, isNavigationItemActive(item, activeKey), groupId, onSelect))
			})
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
//#endregion
//#region ../../packages/design-system/src/components/feedback/badge.tsx
function Badge({ children, tone = "neutral", ...rest }) {
	return /* @__PURE__ */ jsx("span", {
		...rest,
		className: cx("inline-flex items-center gap-1 rounded-tokenMd border px-2.5 py-1 text-xs font-semibold shadow-tokenSm", softToneClasses[tone]),
		children
	});
}
Toast.createToastManager();
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
forwardRef(function AnimatedAccordionContent({ children, open, ...rest }, ref) {
	const motionSettings = useChaseMotion();
	return /* @__PURE__ */ jsx(motion.div, {
		...rest,
		ref,
		initial: false,
		animate: motionSettings.reducedMotion ? void 0 : open ? {
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
//#endregion
//#region ../../packages/design-system/src/components/data-display/data-table.tsx
var skeletonWidths = [
	"w-3/4",
	"w-1/2",
	"w-2/3",
	"w-5/6",
	"w-2/5"
];
function DataTable({ rows, columns, mobileMode = "stack", getRowId, emptyTitle = "Nothing to review", emptyDescription = "Adjust filters or add new records to populate this view.", sortKey, sortDirection, onSortChange, selectedKeys, onSelectionChange, loading = false, loadingRows = 5, density: densityProp, ...rest }) {
	const density = densityProp ?? useDensity();
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
		className: "glass-surface overflow-x-auto rounded-tokenLg border border-muted shadow-tokenSm",
		children: /* @__PURE__ */ jsxs("table", {
			className: "min-w-full border-collapse text-left text-sm",
			children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", {
				className: "border-b border-muted bg-surface-2",
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
					className: cx("border-b border-muted transition-colors last:border-b-0", isSelected ? "bg-surface-2" : "hover:bg-surface-2/70"),
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
			className: "glass-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
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
			className: "glass-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
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
function KeyValueList({ items, density = "default", variant = "surface", ...rest }) {
	return /* @__PURE__ */ jsx("dl", {
		...rest,
		className: variant === "surface" ? "modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm" : "grid gap-0",
		children: items.map((item, index) => /* @__PURE__ */ jsxs("div", {
			className: density === "compact" ? "flex items-start justify-between gap-4 border-b border-muted py-2 first:pt-0 last:border-b-0 last:pb-0" : "flex items-start justify-between gap-4 border-b border-muted pb-3 last:border-b-0 last:pb-0",
			children: [/* @__PURE__ */ jsx("dt", {
				className: "text-xs font-semibold uppercase text-secondary",
				children: item.key
			}), /* @__PURE__ */ jsx("dd", {
				className: "min-w-0 text-right text-sm text-foreground",
				children: item.value
			})]
		}, index))
	});
}
//#endregion
//#region ../../packages/design-system/src/components/data-display/stat.tsx
function Stat({ label, value, trend, icon, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "glass-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ jsx("div", {
					className: "text-xs font-semibold uppercase tracking-wide text-secondary",
					children: label
				}), icon ? /* @__PURE__ */ jsx("div", {
					className: "text-accent",
					children: icon
				}) : null]
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
function Card({ children, media, interactive = false, variant = "default", glow = false, ...rest }) {
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
	const nativeProps = toMotionDomProps(rest);
	return /* @__PURE__ */ jsx(motion.div, {
		...nativeProps,
		...interactiveMotion,
		className: cx("glass-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm", variant === "product" && "bg-surface", variant === "feature" && "bg-surface-2", variant === "stat" && "bg-surface-2", interactive && "cursor-pointer transition hover:border-accent hover:shadow-tokenMd", glow && "glow-accent", !media && "p-4"),
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
//#region ../../packages/design-system/src/components/forms/shared.tsx
var controlClass = "focus-ring touch-target w-full rounded-tokenMd border border-border bg-surface-2 px-4 py-2.5 text-sm text-foreground shadow-tokenSm placeholder:text-tertiary transition duration-150 hover:border-accent disabled:cursor-not-allowed disabled:opacity-60";
function fieldHintId(inputId) {
	return inputId ? `${inputId}-hint` : void 0;
}
function FieldChrome({ label, description, error, required = false, hideLabel = false, htmlFor, children, ...rest }) {
	const hintId = fieldHintId(htmlFor);
	return /* @__PURE__ */ jsxs(Field.Root, {
		...rest,
		invalid: !!error,
		className: "space-y-2",
		children: [
			label ? /* @__PURE__ */ jsxs(Field.Label, {
				htmlFor,
				className: cx("block text-sm font-medium text-foreground", hideLabel && "sr-only"),
				children: [label, required ? /* @__PURE__ */ jsx("span", {
					className: "ml-1 text-accent",
					children: "*"
				}) : null]
			}) : null,
			children,
			error ? /* @__PURE__ */ jsx(Field.Error, {
				id: hintId,
				match: true,
				className: "text-xs font-medium text-danger",
				children: error
			}) : description ? /* @__PURE__ */ jsx(Field.Description, {
				id: hintId,
				className: "text-xs text-secondary",
				children: description
			}) : null
		]
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
//#endregion
//#region ../../packages/design-system/src/components/forms/select.tsx
function NativeSelect({ id, label, description, error, required, hideLabel, items, placeholder, ...rest }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs("select", {
			...rest,
			id: inputId,
			required,
			"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
			"aria-invalid": !!error || void 0,
			className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30"),
			children: [placeholder ? /* @__PURE__ */ jsx("option", {
				value: "",
				children: placeholder
			}) : null, items.map((item) => /* @__PURE__ */ jsx("option", {
				value: item.value,
				disabled: item.disabled,
				children: item.label
			}, item.value))]
		})
	});
}
function Select$1({ label, description, error, required, hideLabel, items, value, defaultValue, onValueChange, placeholder = "Choose an option", disabled = false }) {
	const fallbackId = useId();
	const { overlayNode } = usePortalRoots();
	const itemLabels = useMemo(() => Object.fromEntries(items.map((item) => [item.value, item.label])), [items]);
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: fallbackId,
		children: /* @__PURE__ */ jsxs(Select.Root, {
			items: itemLabels,
			value,
			defaultValue,
			onValueChange: (nextValue) => {
				if (nextValue !== null) onValueChange?.(nextValue);
			},
			disabled,
			children: [/* @__PURE__ */ jsxs(Select.Trigger, {
				id: fallbackId,
				"aria-describedby": error || description ? fieldHintId(fallbackId) : void 0,
				"aria-invalid": !!error || void 0,
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "inline-flex items-center justify-between gap-2 text-left"),
				children: [/* @__PURE__ */ jsx(Select.Value, { placeholder }), /* @__PURE__ */ jsx(Select.Icon, { children: /* @__PURE__ */ jsx(Icon, {
					name: "chevronDown",
					size: "sm",
					tone: "secondary"
				}) })]
			}), /* @__PURE__ */ jsx(Select.Portal, {
				container: overlayNode ?? void 0,
				children: /* @__PURE__ */ jsx(Select.Positioner, {
					sideOffset: 8,
					className: "z-popover min-w-[var(--anchor-width)]",
					children: /* @__PURE__ */ jsx(Select.Popup, {
						className: "modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-overlay",
						children: /* @__PURE__ */ jsx(Select.List, {
							className: "p-2",
							children: items.map((item) => /* @__PURE__ */ jsxs(Select.Item, {
								value: item.value,
								disabled: item.disabled,
								className: (state) => cx("focus-ring relative flex cursor-pointer select-none items-center rounded-tokenMd px-3 py-2 text-sm text-foreground outline-none", state.disabled && "cursor-not-allowed opacity-50", state.highlighted && "bg-background"),
								children: [/* @__PURE__ */ jsx(Select.ItemText, { children: /* @__PURE__ */ jsxs("div", {
									className: "space-y-0.5",
									children: [/* @__PURE__ */ jsx("div", { children: item.label }), item.description ? /* @__PURE__ */ jsx("div", {
										className: "text-xs text-secondary",
										children: item.description
									}) : null]
								}) }), /* @__PURE__ */ jsx(Select.ItemIndicator, {
									className: "ml-auto",
									children: /* @__PURE__ */ jsx(Icon, {
										name: "check",
										size: "sm",
										tone: "accent"
									})
								})]
							}, item.value))
						})
					})
				})
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/autocomplete.tsx
function Autocomplete$1({ label, description, error, required, hideLabel, items, value, defaultValue, onValueChange, placeholder = "Search", noMatchesLabel = "No matches" }) {
	const inputId = useId();
	const listboxId = useId();
	const { overlayNode } = usePortalRoots();
	const values = items.map((item) => item.value);
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsxs(Autocomplete.Root, {
			items: values,
			value,
			defaultValue,
			onValueChange: (nextValue) => {
				if (nextValue !== null) onValueChange?.(nextValue);
			},
			itemToStringValue: (itemValue) => items.find((item) => item.value === itemValue)?.label ?? String(itemValue),
			openOnInputClick: true,
			children: [/* @__PURE__ */ jsxs(Autocomplete.InputGroup, {
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "inline-flex items-center justify-between gap-2 p-0"),
				children: [/* @__PURE__ */ jsx(Autocomplete.Input, {
					id: inputId,
					placeholder,
					"aria-controls": listboxId,
					"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
					"aria-invalid": !!error || void 0,
					className: "min-w-0 flex-1 bg-transparent px-4 py-2.5 outline-none"
				}), /* @__PURE__ */ jsx(Autocomplete.Trigger, {
					className: "focus-ring mr-2 inline-flex h-8 w-8 items-center justify-center rounded-tokenSm",
					children: /* @__PURE__ */ jsx(Icon, {
						name: "search",
						size: "sm",
						tone: "secondary"
					})
				})]
			}), /* @__PURE__ */ jsx(Autocomplete.Portal, {
				container: overlayNode ?? void 0,
				children: /* @__PURE__ */ jsx(Autocomplete.Positioner, {
					sideOffset: 8,
					className: "z-popover w-[var(--anchor-width)]",
					children: /* @__PURE__ */ jsx(Autocomplete.Popup, {
						className: "modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay",
						children: /* @__PURE__ */ jsxs(Autocomplete.List, {
							id: listboxId,
							className: "motion-safe-scroll-area max-h-60 space-y-1",
							children: [/* @__PURE__ */ jsx(Autocomplete.Empty, {
								className: "rounded-tokenMd bg-background px-3 py-2 text-sm text-secondary",
								children: noMatchesLabel
							}), items.map((item) => /* @__PURE__ */ jsx(Autocomplete.Item, {
								value: item.value,
								disabled: item.disabled,
								className: (state) => cx("focus-ring cursor-pointer rounded-tokenMd px-3 py-2 text-left text-sm text-foreground", state.highlighted && "bg-background", state.disabled && "cursor-not-allowed opacity-50"),
								children: /* @__PURE__ */ jsxs("div", {
									className: "space-y-0.5",
									children: [/* @__PURE__ */ jsx("div", { children: item.label }), item.description ? /* @__PURE__ */ jsx("div", {
										className: "text-xs text-secondary",
										children: item.description
									}) : null]
								})
							}, item.value))]
						})
					})
				})
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/number-field.tsx
function NumberField$1({ id, label, description, error, required, hideLabel, value, defaultValue, onValueChange, min, max, step = 1, disabled = false, readOnly = false, placeholder, decrementLabel = "Decrease value", incrementLabel = "Increase value" }) {
	const fallbackId = useId();
	const inputId = id ?? fallbackId;
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		htmlFor: inputId,
		children: /* @__PURE__ */ jsx(NumberField.Root, {
			id: inputId,
			value,
			defaultValue,
			onValueChange: (nextValue) => onValueChange?.(nextValue),
			min,
			max,
			step,
			required,
			disabled,
			readOnly,
			children: /* @__PURE__ */ jsxs(NumberField.Group, {
				className: cx(controlClass, !!error && "border-danger focus-visible:ring-danger/30", "grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1 p-1"),
				children: [
					/* @__PURE__ */ jsx(NumberField.Decrement, {
						"aria-label": decrementLabel,
						className: "focus-ring inline-flex h-8 w-8 items-center justify-center rounded-tokenSm text-secondary hover:bg-background",
						children: /* @__PURE__ */ jsx(Icon, {
							name: "minus",
							size: "sm"
						})
					}),
					/* @__PURE__ */ jsx(NumberField.Input, {
						placeholder,
						"aria-describedby": error || description ? fieldHintId(inputId) : void 0,
						"aria-invalid": !!error || void 0,
						className: "min-w-0 bg-transparent px-2 py-1.5 text-center outline-none"
					}),
					/* @__PURE__ */ jsx(NumberField.Increment, {
						"aria-label": incrementLabel,
						className: "focus-ring inline-flex h-8 w-8 items-center justify-center rounded-tokenSm text-secondary hover:bg-background",
						children: /* @__PURE__ */ jsx(Icon, {
							name: "plus",
							size: "sm"
						})
					})
				]
			})
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/components/forms/radio-group.tsx
function RadioGroup$1({ label, description, error, required, hideLabel, items, value, defaultValue, onValueChange }) {
	return /* @__PURE__ */ jsx(FieldChrome, {
		label,
		description,
		error,
		required,
		hideLabel,
		children: /* @__PURE__ */ jsx(RadioGroup, {
			value,
			defaultValue,
			onValueChange: (nextValue) => onValueChange?.(nextValue),
			className: "space-y-2",
			children: items.map((item) => /* @__PURE__ */ jsxs("label", {
				className: "modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3",
				children: [/* @__PURE__ */ jsx(Radio.Root, {
					value: item.value,
					className: "focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background",
					children: /* @__PURE__ */ jsx(Radio.Indicator, { className: "h-2.5 w-2.5 rounded-full bg-accent" })
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
function Switch$1({ label, description, error, required, hideLabel, checked, defaultChecked, onCheckedChange, disabled = false }) {
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
			}), /* @__PURE__ */ jsx(Switch.Root, {
				id: inputId,
				checked,
				defaultChecked,
				onCheckedChange: (nextChecked) => onCheckedChange?.(nextChecked),
				disabled,
				className: (state) => cx("focus-ring relative inline-flex h-7 w-12 items-center rounded-full bg-muted transition", state.checked && "bg-accent", state.disabled && "opacity-60"),
				children: /* @__PURE__ */ jsx(Switch.Thumb, { className: (state) => cx("block h-5 w-5 translate-x-1 rounded-full bg-elevated shadow-tokenSm transition", state.checked && "translate-x-6") })
			})]
		})
	});
}
//#endregion
//#region ../../packages/design-system/src/patterns/app-shells.tsx
function Page({ children, width = "full", ...rest }) {
	return /* @__PURE__ */ jsx("div", {
		...rest,
		className: cx("mx-auto flex w-full min-w-0 max-w-full flex-col gap-6 overflow-x-clip px-4 py-6 pb-24 md:px-6 md:pb-8", layoutWidthClasses[width]),
		children
	});
}
function PageHeader({ eyebrow, title, description, actions, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "min-w-0 space-y-2",
			children: [
				eyebrow ? /* @__PURE__ */ jsx("div", {
					className: "text-xs font-semibold uppercase text-accent",
					children: eyebrow
				}) : null,
				/* @__PURE__ */ jsx("h1", {
					className: "font-display text-4xl font-semibold text-foreground md:text-5xl",
					children: title
				}),
				description ? /* @__PURE__ */ jsx("div", {
					className: "max-w-full text-base text-secondary md:max-w-3xl",
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
				className: "font-heading text-xl font-semibold text-foreground",
				children: title
			}), description ? /* @__PURE__ */ jsx("div", {
				className: "text-sm text-secondary",
				children: description
			}) : null]
		}) : null, children]
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
				items: [],
				activeKey,
				actions,
				width
			}),
			/* @__PURE__ */ jsxs("main", {
				id: "main-content",
				className: cx("mx-auto grid min-h-[calc(100vh-4rem)] w-full gap-6 px-4 py-5 pb-24 lg:grid-cols-[16rem_minmax(0,1fr)] lg:py-6 lg:pb-8", layoutWidthClasses[width]),
				children: [/* @__PURE__ */ jsx("div", {
					className: "hidden lg:block",
					children: /* @__PURE__ */ jsx("div", {
						className: "sticky top-20 self-start",
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
function CheckoutLayout({ summary, children }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]",
		children: [/* @__PURE__ */ jsx("div", { children }), /* @__PURE__ */ jsx("div", {
			className: "lg:sticky lg:top-24 lg:self-start",
			children: summary
		})]
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
function SellerBadge({ logo, name, verified = false, ...rest }) {
	const resolvedLogo = logo === false ? null : logo ?? /* @__PURE__ */ jsx(ChaseSetsLogo, {
		decorative: true,
		size: 20
	});
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "inline-flex items-center gap-2 rounded-full border border-muted bg-elevated px-3 py-1.5 text-sm font-medium text-foreground shadow-tokenSm",
		children: [/* @__PURE__ */ jsxs("span", {
			className: "inline-flex min-w-0 items-center gap-0",
			children: [resolvedLogo ? /* @__PURE__ */ jsx("span", {
				className: "inline-flex h-5 w-5 shrink-0 items-center justify-center",
				children: resolvedLogo
			}) : null, /* @__PURE__ */ jsx("span", { children: name })]
		}), verified ? /* @__PURE__ */ jsx(Badge, {
			tone: "success",
			children: "Verified"
		}) : null]
	});
}
var tokenSwatchClasses = {
	brandPrimary: "bg-accent",
	brandSecondary: "bg-accent-2",
	cyan: "bg-info",
	indigo: "bg-indigo",
	background: "bg-background",
	surface: "bg-surface",
	surface2: "bg-surface-2",
	surface3: "bg-surface-3",
	border: "bg-border",
	textPrimary: "bg-foreground",
	textSecondary: "bg-secondary",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger"
};
function TokenSwatch({ label, value, color }) {
	return /* @__PURE__ */ jsx(Card, {
		variant: "feature",
		children: /* @__PURE__ */ jsxs("div", {
			className: "space-y-3",
			children: [/* @__PURE__ */ jsx("div", {
				"aria-hidden": "true",
				className: cx("h-10 rounded-tokenMd border border-muted shadow-tokenSm", tokenSwatchClasses[color])
			}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
				className: "text-sm font-semibold text-foreground",
				children: label
			}), /* @__PURE__ */ jsx("div", {
				className: "font-mono text-xs text-secondary",
				children: value
			})] })]
		})
	});
}
function ProductCard({ title, subtitle, price, imageSrc, imageAlt, imageFit = "cover", fallbackImageSrc, fallbackImageAlt, fallbackImageFit = "contain", href, target, rel, onSelect, selectLabel, status, meta, actions, actionLabel, children, ...rest }) {
	const motionSettings = useChaseMotion();
	const [resolvedImageSrc, setResolvedImageSrc] = useState(() => imageSrc ?? fallbackImageSrc);
	useEffect(() => {
		setResolvedImageSrc(imageSrc ?? fallbackImageSrc);
	}, [imageSrc, fallbackImageSrc]);
	const showingFallbackImage = Boolean(fallbackImageSrc) && resolvedImageSrc === fallbackImageSrc;
	const resolvedImageFit = showingFallbackImage ? fallbackImageFit : imageFit;
	const resolvedImageAlt = showingFallbackImage ? fallbackImageAlt ?? imageAlt ?? "" : imageAlt ?? "";
	const interactiveMotion = motionSettings.reducedMotion ? {} : {
		whileHover: {
			y: -2,
			scale: 1.01
		},
		whileTap: {
			y: 0,
			scale: .99
		},
		transition: {
			duration: motionSettings.durations.base,
			ease: motionSettings.easing
		}
	};
	const content = /* @__PURE__ */ jsxs("div", {
		className: "space-y-3",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "relative overflow-hidden rounded-tokenMd border border-muted bg-surface-2",
				children: [status ? /* @__PURE__ */ jsx("div", {
					className: "absolute left-2 top-2 z-10",
					children: status
				}) : null, /* @__PURE__ */ jsx("div", {
					className: "flex aspect-[4/3] items-center justify-center",
					children: resolvedImageSrc ? /* @__PURE__ */ jsx("img", {
						src: resolvedImageSrc,
						alt: resolvedImageAlt,
						onError: () => {
							setResolvedImageSrc((current) => fallbackImageSrc && current !== fallbackImageSrc ? fallbackImageSrc : void 0);
						},
						className: cx("h-full w-full", resolvedImageFit === "contain" ? "object-contain p-3" : "object-cover")
					}) : /* @__PURE__ */ jsx(Icon, {
						name: "image",
						size: "lg",
						tone: "secondary"
					})
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "space-y-1",
				children: [/* @__PURE__ */ jsx("div", {
					className: "text-sm font-semibold leading-snug text-foreground",
					children: title
				}), subtitle ? /* @__PURE__ */ jsx("div", {
					className: "text-xs text-secondary",
					children: subtitle
				}) : null]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-end justify-between gap-3",
				children: [/* @__PURE__ */ jsxs("div", { children: [price ? /* @__PURE__ */ jsx("div", {
					className: "font-heading text-xl font-semibold text-foreground",
					children: price
				}) : null, meta ? /* @__PURE__ */ jsx("div", {
					className: "mt-1 text-xs text-secondary",
					children: meta
				}) : null] }), actions]
			}),
			children ? /* @__PURE__ */ jsx("div", { children }) : null,
			actionLabel ? /* @__PURE__ */ jsxs("div", {
				className: "inline-flex items-center gap-2 text-sm font-semibold text-accent",
				children: [/* @__PURE__ */ jsx("span", { children: actionLabel }), /* @__PURE__ */ jsx(Icon, {
					name: "chevronRight",
					size: "sm",
					tone: "accent"
				})]
			}) : null
		]
	});
	const interactiveClassName = cx("focus-ring glass-surface block w-full overflow-hidden rounded-tokenLg border border-muted bg-surface p-4 text-left shadow-tokenSm transition hover:border-accent hover:shadow-tokenMd");
	if (href) return /* @__PURE__ */ jsx(motion.a, {
		...toMotionDomProps(rest),
		href,
		target,
		rel: rel ?? (target === "_blank" ? "noreferrer" : void 0),
		className: interactiveClassName,
		...interactiveMotion,
		children: content
	});
	if (onSelect) return /* @__PURE__ */ jsx(motion.button, {
		...toMotionDomProps(rest),
		type: "button",
		"aria-label": selectLabel,
		className: interactiveClassName,
		onClick: onSelect,
		...interactiveMotion,
		children: content
	});
	return /* @__PURE__ */ jsx(Card, {
		...rest,
		variant: "product",
		interactive: true,
		children: content
	});
}
function CategoryTile({ icon, label, detail, ...rest }) {
	return /* @__PURE__ */ jsx(Card, {
		...rest,
		variant: "feature",
		interactive: true,
		children: /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col items-center gap-3 text-center",
			children: [/* @__PURE__ */ jsx("div", {
				className: "rounded-tokenLg border border-accent/40 bg-accent/10 p-3 text-accent shadow-tokenSm",
				children: /* @__PURE__ */ jsx(Icon, {
					name: icon,
					size: "lg",
					tone: "accent"
				})
			}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
				className: "text-sm font-semibold text-foreground",
				children: label
			}), detail ? /* @__PURE__ */ jsx("div", {
				className: "mt-1 text-xs text-secondary",
				children: detail
			}) : null] })]
		})
	});
}
function FeatureCard({ icon, title, description, action, ...rest }) {
	return /* @__PURE__ */ jsx(Card, {
		...rest,
		variant: "feature",
		children: /* @__PURE__ */ jsxs("div", {
			className: "flex gap-4",
			children: [/* @__PURE__ */ jsx("div", {
				className: "shrink-0 text-accent",
				children: /* @__PURE__ */ jsx(Icon, {
					name: icon,
					size: "lg",
					tone: "accent"
				})
			}), /* @__PURE__ */ jsxs("div", {
				className: "space-y-2",
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "font-heading text-lg font-semibold text-foreground",
						children: title
					}),
					description ? /* @__PURE__ */ jsx("div", {
						className: "text-sm leading-relaxed text-secondary",
						children: description
					}) : null,
					action ? /* @__PURE__ */ jsx("div", { children: action }) : null
				]
			})]
		})
	});
}
function PromoStrip({ icon = "spark", title, description, action, ...rest }) {
	return /* @__PURE__ */ jsxs("div", {
		...rest,
		className: "glass-surface glow-accent flex flex-col gap-4 rounded-tokenLg border border-accent/40 p-5 md:flex-row md:items-center md:justify-between",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "flex items-center gap-4",
			children: [/* @__PURE__ */ jsx("div", {
				className: "brand-gradient rounded-tokenLg p-3 text-accent-contrast shadow-tokenMd",
				children: /* @__PURE__ */ jsx(Icon, {
					name: icon,
					size: "lg",
					tone: "inverse"
				})
			}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
				className: "font-heading text-xl font-semibold text-foreground",
				children: title
			}), description ? /* @__PURE__ */ jsx("div", {
				className: "mt-1 text-sm text-secondary",
				children: description
			}) : null] })]
		}), action ? /* @__PURE__ */ jsx("div", {
			className: "shrink-0",
			children: action
		}) : null]
	});
}
function CheckoutTrustPanel({ title = "Buyer Protection", items }) {
	return /* @__PURE__ */ jsx(DetailPanel, {
		title: /* @__PURE__ */ jsxs("span", {
			className: "inline-flex items-center gap-3",
			children: [/* @__PURE__ */ jsx(Icon, {
				name: "shield",
				size: "lg",
				tone: "accent"
			}), title]
		}),
		children: /* @__PURE__ */ jsx("div", {
			className: "space-y-4",
			children: items.map((item, index) => /* @__PURE__ */ jsxs("div", {
				className: "flex gap-3",
				children: [/* @__PURE__ */ jsx(Icon, {
					name: item.icon,
					size: "sm",
					tone: "accent"
				}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
					className: "text-sm font-semibold text-foreground",
					children: item.title
				}), item.description ? /* @__PURE__ */ jsx("div", {
					className: "text-sm text-secondary",
					children: item.description
				}) : null] })]
			}, index))
		})
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
	1: "font-display text-4xl font-semibold leading-tight md:text-5xl md:leading-[1.15]",
	2: "font-heading text-3xl font-semibold leading-tight md:text-4xl md:leading-tight",
	3: "font-heading text-2xl font-semibold leading-snug md:text-3xl md:leading-tight",
	4: "font-heading text-xl font-semibold leading-snug md:text-2xl md:leading-snug",
	5: "font-heading text-lg font-semibold leading-snug",
	6: "font-heading text-base font-semibold leading-snug"
};
function Heading({ children, level = 2, align, ...rest }) {
	return /* @__PURE__ */ jsx(`h${level}`, {
		...rest,
		className: cx(headingClasses[level], resolveTextAlignClass(align)),
		children
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
	return segment === "admin" || segment === "checkout" || segment === "components" ? segment : "marketplace";
}
var layout_default = UNSAFE_withComponentProps(function ShowcaseLayoutRoute() {
	const location = useLocation();
	const navigate = useNavigate();
	const [colorMode, setColorMode] = useState("system");
	const [reducedMotion, setReducedMotion] = useState("user");
	const showcaseMode = resolveMode(location.pathname);
	return /* @__PURE__ */ jsxs(ChaseRoot, {
		colorMode,
		reducedMotion,
		children: [/* @__PURE__ */ jsxs(Page, { children: [/* @__PURE__ */ jsxs(Surface, {
			padding: 3,
			children: [/* @__PURE__ */ jsx(Text, {
				size: "sm",
				tone: "secondary",
				children: "Showcase controls"
			}), /* @__PURE__ */ jsx(ShowcaseThemeControl, {
				colorMode,
				onColorModeChange: setColorMode,
				reducedMotion,
				onReducedMotionChange: setReducedMotion
			})]
		}), /* @__PURE__ */ jsx(Tabs$1, {
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
					label: "Seller Dashboard",
					content: null
				},
				{
					value: "checkout",
					label: "Checkout",
					content: null
				},
				{
					value: "components",
					label: "Design System",
					content: null
				}
			]
		})] }), /* @__PURE__ */ jsx(Outlet, {})]
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
		key: "categories",
		label: "Categories",
		icon: "grid"
	},
	{
		key: "how",
		label: "How it Works",
		icon: "help"
	},
	{
		key: "sell",
		label: "Sell",
		icon: "tag"
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
		key: "overview",
		label: "Overview",
		icon: "home"
	},
	{
		key: "listings",
		label: "Listings",
		icon: "package"
	},
	{
		key: "orders",
		label: "Orders",
		icon: "bag"
	},
	{
		key: "analytics",
		label: "Analytics",
		icon: "chart"
	},
	{
		key: "payouts",
		label: "Payouts",
		icon: "wallet"
	},
	{
		key: "messages",
		label: "Messages",
		icon: "message",
		badge: "2"
	},
	{
		key: "reviews",
		label: "Reviews",
		icon: "star"
	},
	{
		key: "settings",
		label: "Settings",
		icon: "settings"
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
	"eyeOff",
	"home",
	"bell",
	"message",
	"help",
	"calendar",
	"tag",
	"shield",
	"cards",
	"book",
	"figure",
	"sneaker",
	"shirt",
	"grid",
	"lock",
	"creditCard",
	"chart",
	"users",
	"rocket",
	"externalLink",
	"moreVertical",
	"badgeCheck",
	"flame",
	"wallet",
	"bag",
	"store"
];
var demoProducts = [
	{
		title: "2020 Pikachu VMAX",
		subtitle: "PSA 10",
		price: "$1,250",
		imageSrc: "/demo-assets/pikachu-card.svg",
		status: "Verified"
	},
	{
		title: "Amazing Spider-Man #300",
		subtitle: "CGC 9.6",
		price: "$1,650",
		imageSrc: "/demo-assets/spider-comic.svg",
		status: "Hot"
	},
	{
		title: "Dragon Ball Z Goku",
		subtitle: "S.H.Figuarts",
		price: "$275",
		imageSrc: "/demo-assets/figure.svg",
		status: "Hot"
	},
	{
		title: "Air Jordan 1 Retro High",
		subtitle: "Chicago (2015)",
		price: "$850",
		imageSrc: "/demo-assets/sneaker.svg",
		status: "Verified"
	},
	{
		title: "Michael Jordan Jersey",
		subtitle: "Autographed",
		price: "$2,450",
		imageSrc: "/demo-assets/jersey.svg",
		status: "Verified"
	}
];
//#endregion
//#region src/views/marketplace-view.tsx
function MarketplaceView() {
	const heroProduct = demoProducts[0];
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
			children: [/* @__PURE__ */ jsx(LinkButton, {
				href: "#signin",
				tone: "ghost",
				children: "Sign In"
			}), /* @__PURE__ */ jsx(Button, { children: "Get Started" })]
		}),
		hero: /* @__PURE__ */ jsx(Surface, {
			elevated: true,
			glow: true,
			padding: 6,
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					lg: 2
				},
				gap: 6,
				children: [/* @__PURE__ */ jsxs(Stack, {
					gap: 5,
					justify: "center",
					children: [
						/* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [/* @__PURE__ */ jsx(Badge, {
										tone: "accent",
										children: "Verified marketplace"
									}), /* @__PURE__ */ jsx(Badge, {
										tone: "info",
										children: "Collector owned"
									})]
								}),
								/* @__PURE__ */ jsx(Heading, {
									level: 1,
									children: "Buy, sell, and discover the collectibles worth chasing."
								}),
								/* @__PURE__ */ jsx(Text, {
									tone: "secondary",
									children: "The trusted marketplace for trading cards, comics, figures, sneakers, and more. Authentic. Secure. Built for collectors."
								})
							]
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 3,
							children: [/* @__PURE__ */ jsx(Button, {
								size: "lg",
								children: "Explore Marketplace"
							}), /* @__PURE__ */ jsx(Button, {
								size: "lg",
								tone: "secondary",
								children: "Start Selling"
							})]
						}),
						/* @__PURE__ */ jsxs(StatGrid, {
							columns: {
								base: 1,
								sm: 3
							},
							children: [
								/* @__PURE__ */ jsx(Stat, {
									label: "Active Listings",
									value: "100K+"
								}),
								/* @__PURE__ */ jsx(Stat, {
									label: "Collectors",
									value: "75K+"
								}),
								/* @__PURE__ */ jsx(Stat, {
									label: "Avg Rating",
									value: "4.9",
									trend: /* @__PURE__ */ jsx(Rating, {
										value: 5,
										size: "sm"
									})
								})
							]
						})
					]
				}), /* @__PURE__ */ jsxs(Stack, {
					gap: 4,
					children: [/* @__PURE__ */ jsx(ProductCard, {
						title: heroProduct.title,
						subtitle: heroProduct.subtitle,
						price: heroProduct.price,
						imageSrc: heroProduct.imageSrc,
						imageAlt: heroProduct.title,
						imageFit: "contain",
						status: /* @__PURE__ */ jsx(Badge, {
							tone: "info",
							children: "Featured"
						}),
						meta: "Champion's Path #074"
					}), /* @__PURE__ */ jsx(Surface, {
						tone: "subtle",
						padding: 4,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [/* @__PURE__ */ jsx(Icon, {
										name: "shield",
										tone: "accent"
									}), /* @__PURE__ */ jsx(Text, {
										weight: "semibold",
										children: "Buyer protection on every order"
									})]
								}),
								/* @__PURE__ */ jsx(Divider, {}),
								/* @__PURE__ */ jsxs(Grid, {
									columns: {
										base: 1,
										sm: 3
									},
									gap: 3,
									children: [
										/* @__PURE__ */ jsx(Stat, {
											label: "Verified Sellers",
											value: "2K+"
										}),
										/* @__PURE__ */ jsx(Stat, {
											label: "Protected Orders",
											value: "98%"
										}),
										/* @__PURE__ */ jsx(Stat, {
											label: "Avg Ship",
											value: "1.2d"
										})
									]
								})
							]
						})
					})]
				})]
			})
		}),
		children: [
			/* @__PURE__ */ jsx(Surface, {
				elevated: true,
				padding: 4,
				children: /* @__PURE__ */ jsxs(Stack, {
					gap: 3,
					children: [/* @__PURE__ */ jsx(SearchInput, {
						label: "Marketplace search",
						hideLabel: true,
						placeholder: "Search for cards, comics, figures, sneakers, and more..."
					}), /* @__PURE__ */ jsxs(Grid, {
						columns: {
							base: 2,
							md: 5
						},
						gap: 3,
						children: [
							/* @__PURE__ */ jsx(CategoryTile, {
								icon: "cards",
								label: "Trading Cards"
							}),
							/* @__PURE__ */ jsx(CategoryTile, {
								icon: "book",
								label: "Comics"
							}),
							/* @__PURE__ */ jsx(CategoryTile, {
								icon: "figure",
								label: "Figures"
							}),
							/* @__PURE__ */ jsx(CategoryTile, {
								icon: "sneaker",
								label: "Sneakers"
							}),
							/* @__PURE__ */ jsx(CategoryTile, {
								icon: "shirt",
								label: "Memorabilia"
							})
						]
					})]
				})
			}),
			/* @__PURE__ */ jsx(PageSection, {
				title: "Featured Collectibles",
				description: "High-signal marketplace cards for comparing product, price, status, and action states.",
				children: /* @__PURE__ */ jsx(Grid, {
					columns: {
						base: 1,
						sm: 2,
						lg: 5
					},
					gap: 3,
					children: demoProducts.map((product) => /* @__PURE__ */ jsx(ProductCard, {
						title: product.title,
						subtitle: product.subtitle,
						price: product.price,
						imageSrc: product.imageSrc,
						imageAlt: product.title,
						status: /* @__PURE__ */ jsx(Badge, {
							tone: product.status === "Hot" ? "warning" : "info",
							children: product.status
						}),
						actions: /* @__PURE__ */ jsx(IconButton, {
							label: "Save item",
							icon: "heart",
							size: "sm"
						})
					}, product.title))
				})
			}),
			/* @__PURE__ */ jsx(PageSection, {
				title: "Trending Categories",
				children: /* @__PURE__ */ jsxs(Grid, {
					columns: {
						base: 2,
						md: 5
					},
					gap: 3,
					children: [
						/* @__PURE__ */ jsx(CategoryTile, {
							icon: "cards",
							label: "Trading Cards",
							detail: "120K+ items"
						}),
						/* @__PURE__ */ jsx(CategoryTile, {
							icon: "book",
							label: "Comics",
							detail: "38K+ items"
						}),
						/* @__PURE__ */ jsx(CategoryTile, {
							icon: "figure",
							label: "Figures",
							detail: "22K+ items"
						}),
						/* @__PURE__ */ jsx(CategoryTile, {
							icon: "sneaker",
							label: "Sneakers",
							detail: "14K+ items"
						}),
						/* @__PURE__ */ jsx(CategoryTile, {
							icon: "shirt",
							label: "Memorabilia",
							detail: "9K+ items"
						}),
						/* @__PURE__ */ jsx(CategoryTile, {
							icon: "grid",
							label: "All Categories",
							detail: "Browse all"
						})
					]
				})
			}),
			/* @__PURE__ */ jsx(PageSection, {
				title: "How Chase Sets Works",
				children: /* @__PURE__ */ jsxs(Grid, {
					columns: {
						base: 1,
						md: 3
					},
					gap: 4,
					children: [
						/* @__PURE__ */ jsx(FeatureCard, {
							icon: "search",
							title: "Discover",
							description: "Explore verified collectibles from trusted sellers around the world."
						}),
						/* @__PURE__ */ jsx(FeatureCard, {
							icon: "shield",
							title: "Buy Securely",
							description: "Checkout and buyer protection are designed into every order."
						}),
						/* @__PURE__ */ jsx(FeatureCard, {
							icon: "tag",
							title: "Sell Easily",
							description: "List items quickly and reach collectors who are ready to buy."
						})
					]
				})
			}),
			/* @__PURE__ */ jsxs(StatGrid, {
				columns: {
					base: 1,
					md: 4
				},
				children: [
					/* @__PURE__ */ jsx(Stat, {
						label: "Active Listings",
						value: "100K+"
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Happy Collectors",
						value: "75K+"
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Verified Sellers",
						value: "2K+"
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Average Rating",
						value: "4.9/5",
						trend: /* @__PURE__ */ jsx(Rating, {
							value: 5,
							size: "sm"
						})
					})
				]
			}),
			/* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 4
				},
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(FeatureCard, {
						icon: "shield",
						title: "Authenticity First",
						description: "Collectibles are verified by trusted marketplace partners."
					}),
					/* @__PURE__ */ jsx(FeatureCard, {
						icon: "lock",
						title: "Buyer Protection",
						description: "Secure payments and hassle-free returns on eligible orders."
					}),
					/* @__PURE__ */ jsx(FeatureCard, {
						icon: "chart",
						title: "Transparent Pricing",
						description: "Real market data helps buyers and sellers move with confidence."
					}),
					/* @__PURE__ */ jsx(FeatureCard, {
						icon: "users",
						title: "Community Driven",
						description: "Collectors, sellers, and enthusiasts all in one marketplace."
					})
				]
			}),
			/* @__PURE__ */ jsx(PromoStrip, {
				icon: "spark",
				title: "Ready to find your next grail?",
				description: "Join collectors buying, selling, and building legendary collections.",
				action: /* @__PURE__ */ jsx(Button, { children: "Get Started" })
			}),
			/* @__PURE__ */ jsxs(Inline, {
				gap: 2,
				children: [/* @__PURE__ */ jsx(Icon, {
					name: "shield",
					tone: "accent"
				}), /* @__PURE__ */ jsx(Text, {
					size: "sm",
					tone: "secondary",
					children: "Authenticity first, transparent pricing, and community-driven trust."
				})]
			})
		]
	});
}
//#endregion
//#region app/routes/marketplace.tsx
var marketplace_exports = /* @__PURE__ */ __exportAll({
	default: () => marketplace_default,
	meta: () => meta$3
});
var meta$3 = () => [{ title: "Marketplace Showcase" }];
var marketplace_default = UNSAFE_withComponentProps(function MarketplaceShowcaseRoute() {
	return /* @__PURE__ */ jsx(MarketplaceView, {});
});
//#endregion
//#region src/views/admin-view.tsx
var rows = demoProducts.map((product, index) => ({
	item: product.title,
	condition: index === 1 ? "CGC 9.6" : index === 3 ? "Excellent" : "Mint",
	price: [
		1250,
		1650,
		275,
		850,
		2450
	][index],
	watchers: [
		42,
		28,
		33,
		15,
		57
	][index],
	stock: [
		1,
		1,
		3,
		2,
		1
	][index],
	status: "Active"
}));
function AdminView() {
	return /* @__PURE__ */ jsx(AdminShell, {
		brand: /* @__PURE__ */ jsx(SellerBadge, {
			name: "Chase Picks",
			verified: true
		}),
		navItems: adminNav,
		activeKey: "overview",
		actions: /* @__PURE__ */ jsxs(Inline, {
			gap: 3,
			children: [
				/* @__PURE__ */ jsx(IconButton, {
					label: "Notifications",
					icon: "bell"
				}),
				/* @__PURE__ */ jsx(IconButton, {
					label: "Messages",
					icon: "message"
				}),
				/* @__PURE__ */ jsxs(Inline, {
					gap: 2,
					children: [/* @__PURE__ */ jsx(Avatar, {
						name: "Alex R.",
						src: "/demo-assets/avatar-alex.svg"
					}), /* @__PURE__ */ jsx(Text, {
						size: "sm",
						weight: "semibold",
						children: "Alex R."
					})]
				})
			]
		}),
		children: /* @__PURE__ */ jsxs(Page, { children: [
			/* @__PURE__ */ jsx(PageHeader, {
				title: "Seller Dashboard",
				description: "Manage listings, track performance, and grow your collectibles business.",
				actions: /* @__PURE__ */ jsx(Button, {
					leadingIcon: "calendar",
					tone: "secondary",
					children: "May 12 - Jun 11"
				})
			}),
			/* @__PURE__ */ jsx(MetricStrip, { items: [
				{
					label: "Total Sales",
					value: "$12,846.75",
					trend: "+18.7% vs prior period"
				},
				{
					label: "Active Listings",
					value: "128",
					trend: "+6.2% vs prior period"
				},
				{
					label: "Orders This Month",
					value: "42",
					trend: "+24.1% vs prior period"
				},
				{
					label: "Conversion Rate",
					value: "4.36%",
					trend: "+0.8pp vs prior period"
				},
				{
					label: "Pending Payouts",
					value: "$2,340.50",
					trend: "Available to transfer"
				}
			] }),
			/* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					lg: 2
				},
				gap: 4,
				children: [/* @__PURE__ */ jsx(Surface, {
					elevated: true,
					children: /* @__PURE__ */ jsxs(Stack, {
						gap: 4,
						children: [
							/* @__PURE__ */ jsxs(Inline, {
								gap: 3,
								children: [/* @__PURE__ */ jsx(Icon, {
									name: "chart",
									tone: "accent"
								}), /* @__PURE__ */ jsx(Text, {
									weight: "semibold",
									children: "Sales Performance"
								})]
							}),
							/* @__PURE__ */ jsxs(Grid, {
								columns: {
									base: 1,
									md: 2
								},
								gap: 3,
								children: [/* @__PURE__ */ jsx(Stat, {
									label: "Revenue",
									value: "$12,846.75",
									trend: "+18.7%"
								}), /* @__PURE__ */ jsx(Stat, {
									label: "Average Order",
									value: "$305.87",
									trend: "+11.4%"
								})]
							}),
							/* @__PURE__ */ jsxs(Grid, {
								columns: { base: 5 },
								gap: 2,
								children: [
									/* @__PURE__ */ jsx(Surface, {
										tone: "accent",
										padding: 3
									}),
									/* @__PURE__ */ jsx(Surface, {
										tone: "accent",
										padding: 4
									}),
									/* @__PURE__ */ jsx(Surface, {
										tone: "accent",
										padding: 5
									}),
									/* @__PURE__ */ jsx(Surface, {
										tone: "accent",
										padding: 6
									}),
									/* @__PURE__ */ jsx(Surface, {
										tone: "accent",
										padding: 5
									})
								]
							})
						]
					})
				}), /* @__PURE__ */ jsx(Surface, {
					elevated: true,
					children: /* @__PURE__ */ jsxs(Stack, {
						gap: 4,
						children: [
							/* @__PURE__ */ jsxs(Inline, {
								gap: 3,
								children: [/* @__PURE__ */ jsx(Icon, {
									name: "cards",
									tone: "accent"
								}), /* @__PURE__ */ jsx(Text, {
									weight: "semibold",
									children: "Category Performance"
								})]
							}),
							/* @__PURE__ */ jsx(FeatureCard, {
								icon: "cards",
								title: "Trading Cards",
								description: "$5,426.20 in sales"
							}),
							/* @__PURE__ */ jsx(FeatureCard, {
								icon: "book",
								title: "Comics",
								description: "$2,341.75 in sales"
							}),
							/* @__PURE__ */ jsx(FeatureCard, {
								icon: "sneaker",
								title: "Sneakers",
								description: "$1,987.40 in sales"
							}),
							/* @__PURE__ */ jsx(LinkText, {
								href: "#",
								trailingIcon: "chevronRight",
								children: "View full analytics"
							})
						]
					})
				})]
			}),
			/* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					xl: 2
				},
				gap: 4,
				children: [/* @__PURE__ */ jsx(PageSection, {
					title: "Recent Orders",
					children: /* @__PURE__ */ jsx(DataTable, {
						density: "compact",
						rows,
						columns: [
							{
								key: "item",
								header: "Item",
								cell: (row) => row.item
							},
							{
								key: "condition",
								header: "Condition",
								cell: (row) => /* @__PURE__ */ jsx(Badge, {
									tone: "neutral",
									children: row.condition
								})
							},
							{
								key: "status",
								header: "Status",
								cell: (row) => /* @__PURE__ */ jsx(Badge, {
									tone: "info",
									children: row.status
								})
							},
							{
								key: "price",
								header: "Amount",
								align: "right",
								cell: (row) => /* @__PURE__ */ jsx(PriceDisplay, { amount: row.price })
							}
						]
					})
				}), /* @__PURE__ */ jsxs(Stack, {
					gap: 4,
					children: [/* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsx(Text, {
									weight: "semibold",
									children: "Payouts"
								}),
								/* @__PURE__ */ jsx(PriceDisplay, {
									amount: 2340.5,
									emphasis: true
								}),
								/* @__PURE__ */ jsx(Text, {
									size: "sm",
									tone: "secondary",
									children: "Next payout Jun 14, 2024 through PayPal."
								}),
								/* @__PURE__ */ jsx(Button, {
									block: true,
									children: "Transfer Now"
								})
							]
						})
					}), /* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Text, {
										weight: "semibold",
										children: "Seller Reputation"
									}), /* @__PURE__ */ jsx(Badge, {
										tone: "info",
										children: "Verified Seller"
									})]
								}),
								/* @__PURE__ */ jsx(Divider, {}),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Text, {
										size: "lg",
										weight: "bold",
										children: "4.9"
									}), /* @__PURE__ */ jsx(Rating, {
										value: 5,
										size: "sm"
									})]
								}),
								/* @__PURE__ */ jsx(Text, {
									size: "sm",
									tone: "secondary",
									children: "Based on 248 reviews with excellent response and shipping speed."
								}),
								/* @__PURE__ */ jsxs(Grid, {
									columns: { base: 3 },
									gap: 3,
									children: [
										/* @__PURE__ */ jsx(Stat, {
											label: "Response",
											value: "98%",
											trend: "Excellent"
										}),
										/* @__PURE__ */ jsx(Stat, {
											label: "Shipping",
											value: "1.2d",
											trend: "Excellent"
										}),
										/* @__PURE__ */ jsx(Stat, {
											label: "Defects",
											value: "0.6%",
											trend: "Excellent"
										})
									]
								})
							]
						})
					})]
				})]
			}),
			/* @__PURE__ */ jsx(PageSection, {
				title: "Active Listings",
				children: /* @__PURE__ */ jsx(Grid, {
					columns: {
						base: 1,
						md: 3
					},
					gap: 3,
					children: demoProducts.slice(0, 3).map((product) => /* @__PURE__ */ jsx(ProductCard, {
						title: product.title,
						subtitle: product.subtitle,
						price: product.price,
						imageSrc: product.imageSrc,
						imageAlt: product.title,
						status: /* @__PURE__ */ jsx(Badge, {
							tone: "success",
							children: "Active"
						}),
						actions: /* @__PURE__ */ jsx(IconButton, {
							label: "Listing actions",
							icon: "moreVertical",
							size: "sm"
						})
					}, product.title))
				})
			}),
			/* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					lg: 2
				},
				gap: 4,
				children: [/* @__PURE__ */ jsx(ActivityList, { items: [
					{
						title: "New order received",
						description: "2020 Pikachu VMAX PSA 10",
						timestamp: "2m ago"
					},
					{
						title: "Item shipped",
						description: "Air Jordan 1 Retro High Chicago",
						timestamp: "18m ago"
					},
					{
						title: "New review",
						description: "Fast shipping and item as described.",
						timestamp: "45m ago"
					}
				] }), /* @__PURE__ */ jsx(PromoStrip, {
					icon: "tag",
					title: "List more. Sell more.",
					description: "Listings with high-quality photos sell up to 2.5x faster.",
					action: /* @__PURE__ */ jsx(Button, { children: "Create New Listing" })
				})]
			})
		] })
	});
}
//#endregion
//#region app/routes/admin.tsx
var admin_exports = /* @__PURE__ */ __exportAll({
	default: () => admin_default,
	meta: () => meta$2
});
var meta$2 = () => [{ title: "Admin Showcase" }];
var admin_default = UNSAFE_withComponentProps(function AdminShowcaseRoute() {
	return /* @__PURE__ */ jsx(AdminView, {});
});
//#endregion
//#region src/views/checkout-view.tsx
function CheckoutView() {
	const product = demoProducts[0];
	return /* @__PURE__ */ jsxs(Page, { children: [
		/* @__PURE__ */ jsx(PageHeader, {
			eyebrow: "Secure Checkout",
			title: "Checkout",
			description: "Shipping, delivery, payment, and buyer protection patterns for order completion."
		}),
		/* @__PURE__ */ jsx(PageStepper, { items: [
			{
				label: "Cart",
				status: "complete"
			},
			{
				label: "Checkout",
				status: "current"
			},
			{
				label: "Confirmation",
				status: "upcoming"
			}
		] }),
		/* @__PURE__ */ jsx(CheckoutLayout, {
			summary: /* @__PURE__ */ jsxs(Stack, {
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(ProductCard, {
						title: product.title,
						subtitle: product.subtitle,
						price: "$1,250.00",
						imageSrc: product.imageSrc,
						imageAlt: product.title,
						imageFit: "contain",
						status: /* @__PURE__ */ jsx(Badge, {
							tone: "info",
							children: "1"
						})
					}),
					/* @__PURE__ */ jsx(OrderSummary, {
						title: "Order Summary",
						lines: [
							{
								label: "Item Price",
								value: "$1,250.00"
							},
							{
								label: "Shipping",
								value: "FREE"
							},
							{
								label: "Marketplace Fee",
								value: "$62.50"
							},
							{
								label: "Sales Tax",
								value: "$108.28"
							}
						],
						total: "$1,420.78"
					}),
					/* @__PURE__ */ jsx(CheckoutTrustPanel, { items: [
						{
							icon: "lock",
							title: "Secure Payment Hold",
							description: "Payment is held until the item is authenticated."
						},
						{
							icon: "badgeCheck",
							title: "Authenticity Verification",
							description: "Experts inspect every item before shipping."
						},
						{
							icon: "truck",
							title: "Insured Shipping",
							description: "Orders are tracked from vault to doorstep."
						}
					] })
				]
			}),
			children: /* @__PURE__ */ jsxs(Stack, {
				gap: 4,
				children: [
					/* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Badge, {
										tone: "accent",
										children: "1"
									}), /* @__PURE__ */ jsx(Heading, {
										level: 3,
										children: "Shipping"
									})]
								}),
								/* @__PURE__ */ jsx(Text, {
									tone: "secondary",
									children: "Where should we ship your order?"
								}),
								/* @__PURE__ */ jsxs(Grid, {
									columns: {
										base: 1,
										md: 2
									},
									gap: 3,
									children: [/* @__PURE__ */ jsx(TextInput, {
										label: "Contact Email",
										defaultValue: "alex@example.test"
									}), /* @__PURE__ */ jsx(TextInput, {
										label: "Full Name",
										defaultValue: "Alex Example"
									})]
								}),
								/* @__PURE__ */ jsx(TextInput, {
									label: "Address",
									defaultValue: "123 Example Way"
								}),
								/* @__PURE__ */ jsxs(Grid, {
									columns: {
										base: 1,
										md: 3
									},
									gap: 3,
									children: [
										/* @__PURE__ */ jsx(TextInput, {
											label: "City",
											defaultValue: "Austin"
										}),
										/* @__PURE__ */ jsx(NativeSelect, {
											label: "State",
											defaultValue: "TX",
											items: [{
												value: "TX",
												label: "Texas"
											}]
										}),
										/* @__PURE__ */ jsx(TextInput, {
											label: "ZIP Code",
											defaultValue: "78701"
										})
									]
								})
							]
						})
					}),
					/* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [/* @__PURE__ */ jsxs(Inline, {
								gap: 3,
								children: [/* @__PURE__ */ jsx(Badge, {
									tone: "accent",
									children: "2"
								}), /* @__PURE__ */ jsx(Heading, {
									level: 3,
									children: "Delivery"
								})]
							}), /* @__PURE__ */ jsx(RadioGroup$1, {
								label: "Shipping method",
								defaultValue: "standard",
								items: [{
									value: "standard",
									label: "Standard Insured",
									description: "Fully insured shipping with tracking."
								}, {
									value: "express",
									label: "Express Signature",
									description: "Expedited shipping with signature required."
								}]
							})]
						})
					}),
					/* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Badge, {
										tone: "accent",
										children: "3"
									}), /* @__PURE__ */ jsx(Heading, {
										level: 3,
										children: "Payment"
									})]
								}),
								/* @__PURE__ */ jsx(Text, {
									tone: "secondary",
									children: "All transactions are secure and encrypted."
								}),
								/* @__PURE__ */ jsx(TextInput, {
									label: "Card Number",
									defaultValue: "4242 4242 4242 4242"
								}),
								/* @__PURE__ */ jsxs(Grid, {
									columns: {
										base: 1,
										md: 3
									},
									gap: 3,
									children: [
										/* @__PURE__ */ jsx(TextInput, {
											label: "Expiry Date",
											defaultValue: "MM / YY"
										}),
										/* @__PURE__ */ jsx(TextInput, {
											label: "CVC",
											defaultValue: "123"
										}),
										/* @__PURE__ */ jsx(TextInput, {
											label: "Name on Card",
											defaultValue: "Alex Example"
										})
									]
								})
							]
						})
					}),
					/* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Grid, {
							columns: {
								base: 1,
								md: 3
							},
							gap: 4,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Icon, {
										name: "shield",
										tone: "accent"
									}), /* @__PURE__ */ jsxs(Stack, {
										gap: 1,
										children: [/* @__PURE__ */ jsx(Text, {
											weight: "semibold",
											children: "Buyer Protection"
										}), /* @__PURE__ */ jsx(Text, {
											size: "sm",
											tone: "secondary",
											children: "Eligible refunds on every order."
										})]
									})]
								}),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Icon, {
										name: "lock",
										tone: "accent"
									}), /* @__PURE__ */ jsxs(Stack, {
										gap: 1,
										children: [/* @__PURE__ */ jsx(Text, {
											weight: "semibold",
											children: "Secure Checkout"
										}), /* @__PURE__ */ jsx(Text, {
											size: "sm",
											tone: "secondary",
											children: "Encrypted payment handling."
										})]
									})]
								}),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 3,
									children: [/* @__PURE__ */ jsx(Icon, {
										name: "badgeCheck",
										tone: "success"
									}), /* @__PURE__ */ jsxs(Stack, {
										gap: 1,
										children: [/* @__PURE__ */ jsx(Text, {
											weight: "semibold",
											children: "Authenticity Guarantee"
										}), /* @__PURE__ */ jsx(Text, {
											size: "sm",
											tone: "secondary",
											children: "Expert verification before delivery."
										})]
									})]
								})
							]
						})
					}),
					/* @__PURE__ */ jsx(Button, {
						size: "lg",
						leadingIcon: "lock",
						children: "Complete Purchase"
					}),
					/* @__PURE__ */ jsx(Divider, {}),
					/* @__PURE__ */ jsx(Text, {
						size: "sm",
						tone: "secondary",
						align: "center",
						children: "Demo data is fictional and for visual validation only."
					})
				]
			})
		})
	] });
}
//#endregion
//#region app/routes/checkout.tsx
var checkout_exports = /* @__PURE__ */ __exportAll({
	default: () => checkout_default,
	meta: () => meta$1
});
var meta$1 = () => [{ title: "Checkout Showcase" }];
var checkout_default = UNSAFE_withComponentProps(function CheckoutShowcaseRoute() {
	return /* @__PURE__ */ jsx(CheckoutView, {});
});
//#endregion
//#region src/views/components-view.tsx
var brandTokens = [
	{
		label: "Primary Blue",
		value: "#3882F6",
		color: "brandPrimary"
	},
	{
		label: "Accent Purple",
		value: "#8B5CF6",
		color: "brandSecondary"
	},
	{
		label: "Cyan",
		value: "#06B6D4",
		color: "cyan"
	},
	{
		label: "Indigo",
		value: "#6366F1",
		color: "indigo"
	}
];
var surfaceTokens = [
	{
		label: "Background",
		value: "var(--color-background)",
		color: "background"
	},
	{
		label: "Surface 1",
		value: "var(--color-surface)",
		color: "surface"
	},
	{
		label: "Surface 2",
		value: "var(--color-surface-2)",
		color: "surface2"
	},
	{
		label: "Surface 3",
		value: "var(--color-surface-3)",
		color: "surface3"
	},
	{
		label: "Border",
		value: "var(--color-border)",
		color: "border"
	},
	{
		label: "Text Primary",
		value: "var(--color-text-primary)",
		color: "textPrimary"
	},
	{
		label: "Text Secondary",
		value: "var(--color-text-secondary)",
		color: "textSecondary"
	},
	{
		label: "Success",
		value: "var(--color-success)",
		color: "success"
	},
	{
		label: "Warning",
		value: "var(--color-warning)",
		color: "warning"
	},
	{
		label: "Danger",
		value: "var(--color-danger)",
		color: "danger"
	}
];
var typeRows = [
	{
		style: "H1",
		example: "Build your collection",
		size: "48 / 56",
		weight: "700"
	},
	{
		style: "H2",
		example: "Discover rare finds",
		size: "36 / 44",
		weight: "600"
	},
	{
		style: "H3",
		example: "Featured collectibles",
		size: "28 / 36",
		weight: "600"
	},
	{
		style: "H4",
		example: "Top Categories",
		size: "22 / 28",
		weight: "600"
	},
	{
		style: "Body",
		example: "Buy, sell, and discover collectibles.",
		size: "16 / 24",
		weight: "400"
	},
	{
		style: "Small",
		example: "Shipping protection included.",
		size: "14 / 20",
		weight: "400"
	},
	{
		style: "Caption",
		example: "Joined 100,000+ collectors",
		size: "12 / 16",
		weight: "400"
	}
];
var spacingRows = [
	{
		label: "0",
		value: "0px"
	},
	{
		label: "1",
		value: "4px"
	},
	{
		label: "2",
		value: "8px"
	},
	{
		label: "3",
		value: "12px"
	},
	{
		label: "4",
		value: "16px"
	},
	{
		label: "6",
		value: "24px"
	},
	{
		label: "8",
		value: "32px"
	},
	{
		label: "12",
		value: "48px"
	}
];
function SectionCard({ title, children }) {
	return /* @__PURE__ */ jsx(Surface, {
		elevated: true,
		children: /* @__PURE__ */ jsxs(Stack, {
			gap: 4,
			children: [/* @__PURE__ */ jsx(Heading, {
				level: 3,
				children: title
			}), children]
		})
	});
}
function ComponentsView() {
	return /* @__PURE__ */ jsxs(Page, { children: [
		/* @__PURE__ */ jsx(PageHeader, {
			eyebrow: "Chase Sets Design System",
			title: "Clean, modern collectibles marketplace.",
			description: "The canonical UI layer for marketplace, trading, checkout, and admin surfaces."
		}),
		/* @__PURE__ */ jsxs(Grid, {
			columns: {
				base: 1,
				xl: 2
			},
			gap: 4,
			align: "start",
			children: [/* @__PURE__ */ jsxs(SectionCard, {
				title: "Brand Colors",
				children: [
					/* @__PURE__ */ jsx(Grid, {
						columns: {
							base: 2,
							md: 4
						},
						gap: 3,
						children: brandTokens.map((token) => /* @__PURE__ */ jsx(TokenSwatch, {
							label: token.label,
							value: token.value,
							color: token.color
						}, token.label))
					}),
					/* @__PURE__ */ jsx(Divider, {}),
					/* @__PURE__ */ jsx(Grid, {
						columns: {
							base: 2,
							md: 5
						},
						gap: 3,
						children: surfaceTokens.map((token) => /* @__PURE__ */ jsx(TokenSwatch, {
							label: token.label,
							value: token.value,
							color: token.color
						}, token.label))
					})
				]
			}), /* @__PURE__ */ jsxs(SectionCard, {
				title: "Typography",
				children: [/* @__PURE__ */ jsxs(Stack, {
					gap: 2,
					children: [
						/* @__PURE__ */ jsx(Heading, {
							level: 1,
							children: "Build your collection"
						}),
						/* @__PURE__ */ jsx(Heading, {
							level: 2,
							children: "Discover rare finds"
						}),
						/* @__PURE__ */ jsx(Heading, {
							level: 3,
							children: "Featured collectibles"
						}),
						/* @__PURE__ */ jsx(Text, { children: "Buy, sell, and discover collectibles with confidence." }),
						/* @__PURE__ */ jsx(Caption, { children: "Joined 100,000+ collectors" })
					]
				}), /* @__PURE__ */ jsx(DataTable, {
					density: "compact",
					rows: typeRows,
					columns: [
						{
							key: "style",
							header: "Style",
							cell: (row) => row.style
						},
						{
							key: "example",
							header: "Example",
							cell: (row) => row.example
						},
						{
							key: "size",
							header: "Size / Line",
							cell: (row) => row.size
						},
						{
							key: "weight",
							header: "Weight",
							cell: (row) => row.weight
						}
					]
				})]
			})]
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Actions / States",
			children: /* @__PURE__ */ jsx(Surface, {
				elevated: true,
				children: /* @__PURE__ */ jsxs(Grid, {
					columns: {
						base: 1,
						lg: 3
					},
					gap: 4,
					align: "start",
					children: [
						/* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsx(Heading, {
									level: 4,
									children: "Buttons"
								}),
								/* @__PURE__ */ jsxs(ButtonGroup, { children: [
									/* @__PURE__ */ jsx(Button, { children: "Get Started" }),
									/* @__PURE__ */ jsx(Button, {
										tone: "secondary",
										children: "Explore Marketplace"
									}),
									/* @__PURE__ */ jsx(Button, {
										tone: "ghost",
										children: "Start Selling"
									}),
									/* @__PURE__ */ jsx(Button, {
										disabled: true,
										children: "Disabled"
									})
								] }),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [
										/* @__PURE__ */ jsx(IconButton, {
											label: "Search",
											icon: "search"
										}),
										/* @__PURE__ */ jsx(IconButton, {
											label: "Save",
											icon: "heart",
											tone: "secondary"
										}),
										/* @__PURE__ */ jsx(IconButton, {
											label: "Settings",
											icon: "settings",
											tone: "ghost"
										})
									]
								})
							]
						}),
						/* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [/* @__PURE__ */ jsx(Heading, {
								level: 4,
								children: "Badges"
							}), /* @__PURE__ */ jsxs(Inline, {
								gap: 2,
								children: [
									/* @__PURE__ */ jsx(Badge, {
										tone: "info",
										children: "Verified"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "warning",
										children: "Hot"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "success",
										children: "New"
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "danger",
										children: "Alert"
									}),
									/* @__PURE__ */ jsx(Badge, { children: "Outlined" })
								]
							})]
						}),
						/* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsx(Heading, {
									level: 4,
									children: "Navigation"
								}),
								/* @__PURE__ */ jsx(NavigationMenu$1, { items: [{
									value: "market",
									label: "Market",
									href: "#market",
									active: true
								}, {
									value: "seller",
									label: "Seller",
									content: /* @__PURE__ */ jsxs(Stack, {
										gap: 2,
										children: [/* @__PURE__ */ jsx(Text, {
											size: "sm",
											children: "Inventory, orders, payouts, and offer workflows."
										}), /* @__PURE__ */ jsx(Button, {
											tone: "secondary",
											size: "sm",
											children: "Open dashboard"
										})]
									})
								}] }),
								/* @__PURE__ */ jsx(SegmentedControl, {
									value: "all",
									items: [
										{
											value: "all",
											label: "All"
										},
										{
											value: "cards",
											label: "Cards"
										},
										{
											value: "comics",
											label: "Comics"
										},
										{
											value: "figures",
											label: "Figures"
										}
									]
								}),
								/* @__PURE__ */ jsx(Text, {
									size: "sm",
									tone: "secondary",
									children: "Focus, hover, active, and disabled states are token-driven."
								})
							]
						}),
						/* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsx(Heading, {
									level: 4,
									children: "Toolbar"
								}),
								/* @__PURE__ */ jsxs(Toolbar$1, {
									label: "Listing tools",
									children: [
										/* @__PURE__ */ jsx(ToolbarButton, {
											icon: "search",
											children: "Find"
										}),
										/* @__PURE__ */ jsx(ToolbarButton, {
											icon: "settings",
											children: "Tune"
										}),
										/* @__PURE__ */ jsx(ToolbarSeparator, {}),
										/* @__PURE__ */ jsx(ToolbarInput, {
											"aria-label": "Filter tools",
											placeholder: "Filter"
										})
									]
								}),
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [/* @__PURE__ */ jsx(Toggle$1, {
										icon: "heart",
										"aria-label": "Watch listing"
									}), /* @__PURE__ */ jsx(ToggleGroup$1, {
										label: "View density",
										defaultValue: ["comfortable"],
										items: [{
											value: "compact",
											label: "Compact"
										}, {
											value: "comfortable",
											label: "Comfort"
										}]
									})]
								})
							]
						})
					]
				})
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Inputs / Forms",
			children: /* @__PURE__ */ jsx(Surface, {
				elevated: true,
				children: /* @__PURE__ */ jsxs(Grid, {
					columns: {
						base: 1,
						lg: 2
					},
					gap: 4,
					children: [
						/* @__PURE__ */ jsx(SearchInput, {
							label: "Search Bar",
							placeholder: "Search for cards, comics, figures..."
						}),
						/* @__PURE__ */ jsx(TextInput, {
							label: "Text Field",
							placeholder: "Enter item title"
						}),
						/* @__PURE__ */ jsx(Select$1, {
							label: "Base UI Select",
							items: [{
								value: "all",
								label: "All Categories"
							}, {
								value: "cards",
								label: "Trading Cards"
							}]
						}),
						/* @__PURE__ */ jsx(Autocomplete$1, {
							label: "Autocomplete",
							items: [
								{
									value: "charizard",
									label: "Charizard"
								},
								{
									value: "pikachu",
									label: "Pikachu"
								},
								{
									value: "mewtwo",
									label: "Mewtwo"
								}
							],
							placeholder: "Find a character"
						}),
						/* @__PURE__ */ jsx(NumberField$1, {
							label: "Quantity",
							defaultValue: 1,
							min: 1,
							max: 99
						}),
						/* @__PURE__ */ jsx(NativeSelect, {
							label: "Native Select",
							placeholder: "Condition",
							items: [{
								value: "mint",
								label: "Mint"
							}, {
								value: "near-mint",
								label: "Near Mint"
							}]
						}),
						/* @__PURE__ */ jsxs(Inline, {
							gap: 4,
							children: [/* @__PURE__ */ jsx(Switch$1, {
								label: "Toggle",
								defaultChecked: true
							}), /* @__PURE__ */ jsx(RadioGroup$1, {
								label: "Auction mode",
								defaultValue: "auction",
								items: [{
									value: "auction",
									label: "Auction"
								}]
							})]
						})
					]
				})
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Cards / Marketplace Components",
			children: /* @__PURE__ */ jsxs(Grid, {
				columns: {
					base: 1,
					md: 4
				},
				gap: 4,
				align: "start",
				children: [
					/* @__PURE__ */ jsx(ProductCard, {
						href: "#product-card",
						title: demoProducts[0].title,
						subtitle: demoProducts[0].subtitle,
						price: demoProducts[0].price,
						imageSrc: demoProducts[0].imageSrc,
						imageAlt: demoProducts[0].title,
						imageFit: "contain",
						status: /* @__PURE__ */ jsx(Badge, {
							tone: "info",
							children: "Verified"
						})
					}),
					/* @__PURE__ */ jsx(CategoryTile, {
						icon: "cards",
						label: "Trading Cards",
						detail: "120K+ items"
					}),
					/* @__PURE__ */ jsx(Stat, {
						label: "Active Collectors",
						value: "100K+",
						icon: /* @__PURE__ */ jsx(Icon, { name: "users" })
					}),
					/* @__PURE__ */ jsx(Surface, {
						elevated: true,
						children: /* @__PURE__ */ jsxs(Stack, {
							gap: 3,
							children: [
								/* @__PURE__ */ jsxs(Inline, {
									gap: 2,
									children: [
										/* @__PURE__ */ jsx(Icon, {
											name: "star",
											tone: "warning"
										}),
										/* @__PURE__ */ jsx(Icon, {
											name: "star",
											tone: "warning"
										}),
										/* @__PURE__ */ jsx(Icon, {
											name: "star",
											tone: "warning"
										}),
										/* @__PURE__ */ jsx(Icon, {
											name: "star",
											tone: "warning"
										}),
										/* @__PURE__ */ jsx(Icon, {
											name: "star",
											tone: "warning"
										})
									]
								}),
								/* @__PURE__ */ jsx(Text, {
									size: "sm",
									tone: "secondary",
									children: "Chase Sets is the best marketplace I have used."
								}),
								/* @__PURE__ */ jsx(CodeText, { children: "ProductCard href/onSelect" })
							]
						})
					})
				]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Spacing / Layout",
			children: /* @__PURE__ */ jsxs(Surface, {
				elevated: true,
				children: [
					/* @__PURE__ */ jsx(Grid, {
						columns: {
							base: 2,
							md: 4
						},
						gap: 3,
						children: spacingRows.map((row) => /* @__PURE__ */ jsx(Stat, {
							label: `Space ${row.label}`,
							value: row.value
						}, row.label))
					}),
					/* @__PURE__ */ jsx(Divider, {}),
					/* @__PURE__ */ jsxs(StatGrid, {
						columns: {
							base: 1,
							md: 4
						},
						children: [
							/* @__PURE__ */ jsx(Stat, {
								label: "Control Radius",
								value: "12px"
							}),
							/* @__PURE__ */ jsx(Stat, {
								label: "Card Radius",
								value: "16px"
							}),
							/* @__PURE__ */ jsx(Stat, {
								label: "Grid Max",
								value: "12 Col"
							}),
							/* @__PURE__ */ jsx(Stat, {
								label: "Density",
								value: "Compact"
							})
						]
					})
				]
			})
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Iconography",
			children: /* @__PURE__ */ jsx(Surface, { children: /* @__PURE__ */ jsx(Inline, {
				gap: 3,
				children: showcaseIconNames.map((name) => /* @__PURE__ */ jsx(Icon, {
					name,
					tone: "accent"
				}, name))
			}) })
		}),
		/* @__PURE__ */ jsx(PageSection, {
			title: "Checkout Pattern",
			children: /* @__PURE__ */ jsx(CheckoutLayout, {
				summary: /* @__PURE__ */ jsxs(Stack, {
					gap: 4,
					children: [/* @__PURE__ */ jsx(OrderSummary, {
						title: "Order Summary",
						lines: [
							{
								label: "Item Price",
								value: "$1,250.00"
							},
							{
								label: "Shipping",
								value: "FREE"
							},
							{
								label: "Marketplace Fee",
								value: "$62.50"
							},
							{
								label: "Sales Tax",
								value: "$108.28"
							}
						],
						total: "$1,420.78"
					}), /* @__PURE__ */ jsx(CheckoutTrustPanel, { items: [
						{
							icon: "lock",
							title: "Secure Payment Hold",
							description: "Payment is held until the item is authenticated."
						},
						{
							icon: "badgeCheck",
							title: "Authenticity Verification",
							description: "Experts inspect every item before shipping."
						},
						{
							icon: "truck",
							title: "Insured Shipping",
							description: "Orders are tracked from vault to doorstep."
						}
					] })]
				}),
				children: /* @__PURE__ */ jsxs(Stack, {
					gap: 4,
					children: [
						/* @__PURE__ */ jsx(Surface, {
							elevated: true,
							children: /* @__PURE__ */ jsxs(Stack, {
								gap: 3,
								children: [
									/* @__PURE__ */ jsx(Heading, {
										level: 3,
										children: "Shipping"
									}),
									/* @__PURE__ */ jsxs(Grid, {
										columns: {
											base: 1,
											md: 2
										},
										gap: 3,
										children: [/* @__PURE__ */ jsx(TextInput, {
											label: "Contact Email",
											defaultValue: "alex@example.test"
										}), /* @__PURE__ */ jsx(TextInput, {
											label: "Full Name",
											defaultValue: "Alex Example"
										})]
									}),
									/* @__PURE__ */ jsx(TextInput, {
										label: "Address",
										defaultValue: "123 Example Way"
									})
								]
							})
						}),
						/* @__PURE__ */ jsx(Surface, {
							elevated: true,
							children: /* @__PURE__ */ jsxs(Stack, {
								gap: 3,
								children: [/* @__PURE__ */ jsx(Heading, {
									level: 3,
									children: "Delivery"
								}), /* @__PURE__ */ jsx(RadioGroup$1, {
									label: "Shipping method",
									defaultValue: "standard",
									items: [{
										value: "standard",
										label: "Standard Insured",
										description: "Fully insured shipping with tracking."
									}, {
										value: "express",
										label: "Express Signature",
										description: "Expedited shipping with signature required."
									}]
								})]
							})
						}),
						/* @__PURE__ */ jsx(Button, {
							size: "lg",
							leadingIcon: "lock",
							children: "Complete Purchase"
						})
					]
				})
			})
		})
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
		"module": "/assets/entry.client-D1cQde2i.js",
		"imports": ["/assets/jsx-runtime-D_HevnJU.js", "/assets/react-dom-Cnp9xt7r.js"],
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
			"module": "/assets/root-BJbAd5V6.js",
			"imports": ["/assets/jsx-runtime-D_HevnJU.js", "/assets/react-dom-Cnp9xt7r.js"],
			"css": ["/assets/root-B8q6f3-R.css"],
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
			"module": "/assets/layout-DsYzj9GU.js",
			"imports": [
				"/assets/jsx-runtime-D_HevnJU.js",
				"/assets/src-OkLPE6qb.js",
				"/assets/react-dom-Cnp9xt7r.js"
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
			"module": "/assets/marketplace-B9VP1kkX.js",
			"imports": [
				"/assets/jsx-runtime-D_HevnJU.js",
				"/assets/fixtures-C22cT_Wa.js",
				"/assets/src-OkLPE6qb.js",
				"/assets/react-dom-Cnp9xt7r.js"
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
			"module": "/assets/admin-BhAbe7Rz.js",
			"imports": [
				"/assets/jsx-runtime-D_HevnJU.js",
				"/assets/fixtures-C22cT_Wa.js",
				"/assets/src-OkLPE6qb.js",
				"/assets/react-dom-Cnp9xt7r.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		},
		"routes/checkout": {
			"id": "routes/checkout",
			"parentId": "routes/layout",
			"path": "checkout",
			"index": void 0,
			"caseSensitive": void 0,
			"hasAction": false,
			"hasLoader": false,
			"hasClientAction": false,
			"hasClientLoader": false,
			"hasClientMiddleware": false,
			"hasDefaultExport": true,
			"hasErrorBoundary": false,
			"module": "/assets/checkout-DGJM1PkF.js",
			"imports": [
				"/assets/jsx-runtime-D_HevnJU.js",
				"/assets/fixtures-C22cT_Wa.js",
				"/assets/src-OkLPE6qb.js",
				"/assets/react-dom-Cnp9xt7r.js"
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
			"module": "/assets/components-DFSK4ZON.js",
			"imports": [
				"/assets/jsx-runtime-D_HevnJU.js",
				"/assets/fixtures-C22cT_Wa.js",
				"/assets/src-OkLPE6qb.js",
				"/assets/react-dom-Cnp9xt7r.js"
			],
			"css": [],
			"clientActionModule": void 0,
			"clientLoaderModule": void 0,
			"clientMiddlewareModule": void 0,
			"hydrateFallbackModule": void 0
		}
	},
	"url": "/assets/manifest-a5e85016.js",
	"version": "a5e85016",
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
	"routes/checkout": {
		id: "routes/checkout",
		parentId: "routes/layout",
		path: "checkout",
		index: void 0,
		caseSensitive: void 0,
		module: checkout_exports
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
