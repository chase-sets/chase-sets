// Exports what the pilot reads from Chase Sets' own sources, so its copy, navigation and look
// cannot drift from admin-web's. Every output is committed; CI runs this with --check.
//
// - locales/en.json: the postage-policy screen's English catalog (ordering.features.postagePolicies.ui.*
//   and the route title), keys and arguments in the snake case `messages!` takes.
// - nav.json: admin-web's primary-nav contributions from every bounded context's context.json.
// - tokens.json: the design system's light and dark values (packages/design-system styles.css)
//   for the tokens the pilot uses, in the format of Corten's `tokens!`.
// - defaults.json: the default postage policy (contracts/product-measures), which a new draft
//   starts from.
// - static/fonts/: the three @fontsource files the screen uses.
//
// locales/pilot.en.json is the pilot's own text (its shell and input checks) and is not exported.
//
// Usage: node --import tsx deployables/corten-pilot/scripts/export.mjs [--check]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pilot = path.resolve(here, "..");
const repo = path.resolve(pilot, "../..");
const check = process.argv.includes("--check");

const snake = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

async function catalog() {
  const file = path.join(repo, "contracts/localization/locales/en/ordering.ts");
  const { orderingEnglishTranslations: all } = await import(pathToFileURL(file).href);
  const prefix = "ordering.features.postagePolicies.ui.";
  const out = {};
  for (const [key, text] of Object.entries(all)) {
    let name;
    if (key.startsWith(prefix)) name = key.slice(prefix.length);
    else if (key === "ordering.routes.admin.postagePolicies.title") name = "route.title";
    else continue;
    out[name.split(".").map(snake).join(".")] = text.replace(/\{([A-Za-z0-9_]+)\}/g, (_, arg) => `{${snake(arg)}}`);
  }
  return out;
}

function nav() {
  const contexts = path.join(repo, "bounded-contexts");
  const keep = (item) => ({
    key: item.key,
    label: item.label,
    ...(item.href ? { href: item.href } : {}),
    order: item.order,
    visibility: item.visibility ?? "signed-in",
    requiredPermissions: item.requiredPermissions ?? [],
    requiredPermissionsMatch: item.requiredPermissionsMatch ?? "all",
    excludedRoleKeys: item.excludedRoleKeys ?? [],
    ...(item.children ? { children: item.children.map(keep) } : {}),
  });
  const items = [];
  for (const name of readdirSync(contexts).sort()) {
    const file = path.join(contexts, name, "context.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const item of manifest.shellContributions ?? []) {
      if (item.deployable !== "admin-web" || item.slot !== "primary-nav" || !item.section) continue;
      if (item.parentKey) throw new Error(`${name}: ${item.key} has a parentKey, which the pilot's nav does not compose`);
      items.push({ section: item.section, ...keep(item) });
    }
  }
  return items;
}

// Token name in the pilot -> custom property in the design system. Dark values are the same
// property with a --dark- prefix.
const colors = {
  background: "background",
  surface: "card",
  "surface-2": "surface-2",
  "surface-3": "surface-3",
  border: "border",
  "border-strong": "border-strong",
  input: "input",
  ring: "ring",
  text: "foreground",
  "text-secondary": "text-secondary",
  "text-muted": "text-muted",
  primary: "primary",
  "primary-hover": "primary-hover",
  "primary-foreground": "primary-foreground",
  "primary-soft": "primary-soft",
  secondary: "secondary",
  "secondary-foreground": "secondary-foreground",
  success: "success",
  "success-soft": "success-soft",
  warning: "warning",
  "warning-soft": "warning-soft",
  danger: "danger",
  "danger-soft": "danger-soft",
  "danger-hover": "danger-hover",
  "danger-contrast": "danger-contrast",
  info: "info",
  "info-soft": "info-soft",
  overlay: "overlay",
};
const shadows = { sm: "shadow-sm", md: "shadow-md", lg: "shadow-lg", overlay: "shadow-overlay" };

function tokens() {
  const css = readFileSync(path.join(repo, "packages/design-system/src/styles/styles.css"), "utf8");
  const vars = new Map();
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (!vars.has(match[1])) vars.set(match[1], match[2].trim());
  }
  const value = (name) => {
    const found = vars.get(name);
    if (!found) throw new Error(`styles.css has no --${name}`);
    const alias = /^var\(--([a-z0-9-]+)\)$/.exec(found);
    return alias ? value(alias[1]) : found;
  };
  const scale = (map, prefix = "") =>
    Object.fromEntries(Object.entries(map).map(([token, name]) => [token, value(`${prefix}${name}`)]));
  const space = Object.fromEntries(Array.from({ length: 13 }, (_, n) => [String(n), value(`space-${n}`)]));
  return {
    breakpoints: { md: "48rem", lg: "64rem" },
    scales: {
      color: scale(colors),
      space,
      radius: { md: value("radius"), lg: value("radius-lg"), xl: value("radius-xl"), full: value("radius-full") },
      shadow: scale(shadows),
      font: { display: value("display-font"), body: value("body-font"), mono: value("mono-font") },
      control: { height: value("control-md-height"), px: value("control-md-px"), py: value("control-md-py") },
    },
    themes: {
      '[data-theme="dark"]': {
        "@media": { "(prefers-color-scheme: dark)": ':root:not([data-theme="light"])' },
        color: scale(colors, "dark-"),
        shadow: scale(shadows, "dark-"),
      },
    },
    utilities: { gap: { property: "gap", scale: "space" } },
  };
}

const fonts = [
  ["@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
  ["@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2"],
  ["@fontsource/space-grotesk", "space-grotesk-latin-600-normal.woff2"],
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const { defaultPostagePolicy } = await import(pathToFileURL(path.join(repo, "contracts/product-measures/index.ts")).href);
const outputs = [
  ["locales/en.json", json(await catalog())],
  ["nav.json", json(nav())],
  ["tokens.json", json(tokens())],
  ["defaults.json", json(defaultPostagePolicy)],
];
const require = createRequire(path.join(repo, "packages/design-system/package.json"));
let stale = 0;
for (const [file, text] of outputs) {
  const target = path.join(pilot, file);
  if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
  if (check) {
    console.error(`${file} is out of date: run node deployables/corten-pilot/scripts/export.mjs`);
    stale += 1;
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${file}`);
  }
}
mkdirSync(path.join(pilot, "static/fonts"), { recursive: true });
for (const [pkg, name] of fonts) {
  const source = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", name);
  const target = path.join(pilot, "static/fonts", name);
  if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) continue;
  if (check) {
    console.error(`static/fonts/${name} is out of date`);
    stale += 1;
  } else {
    copyFileSync(source, target);
    console.log(`wrote static/fonts/${name}`);
  }
}
process.exit(stale ? 1 : 0);
