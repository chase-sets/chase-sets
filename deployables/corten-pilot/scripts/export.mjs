// Exports what the pilot's apps read from Chase Sets' own sources, so their copy, navigation and
// look cannot drift from the web hosts'. Every output is committed; CI runs this with --check.
//
// - admin/locales/en.json: the postage-policy screen's English catalog (ordering.features.postagePolicies.ui.*
//   and the route title), keys in the snake case `messages!` takes.
// - admin/locales/catalog.en.json: the catalog area's English catalog (the dimension, field and
//   catalog item pages, the shared list, detail, lifecycle, bulk lifecycle and realtime reload
//   controls, and the routes' titles).
// - admin/locales/operations.en.json: the Operations Attention queue's English catalog
//   (platformOperations.operationsAttention.*).
// - admin/nav.json: admin-web's primary-nav contributions from every bounded context's context.json.
// - admin/defaults.json: the default postage policy (contracts/product-measures), which a new draft
//   starts from.
// - admin/scope-domains.json: the Catalog's scope product domains (`catalogScopeProductDomains`),
//   the scopes list's domain filter.
// - marketplace/locales/en.json: the storage-locations screen's English catalog
//   (inventory.features.storageLocations.ui.storageLocationPage.*, inventory.recovery.*, the route's
//   title and description).
// - marketplace/locales/restock.en.json: the restock decisions screen's English catalog
//   (inventory.features.restockDecisions.ui.queue.*, the route's title and description, and the
//   resource route's "could not be verified").
// - marketplace/locales/cart.en.json: the cart page's English catalog (checkout.features.cart.ui.cartPage.*
//   and checkout.routes.accountCart.*, the route's title, description and messages, and the
//   language labels a line's badge uses).
// - marketplace/locales/item.en.json: the item page's English catalog (discovery.features.itemDetail.ui.itemDetailPage.*,
//   its page view's, product selector's, similar items' and market panel's, discovery.routes.itemDetail.*, the language
//   labels the details list uses, an item's display identity, and Collections' Add to List words,
//   collections.features.savedLists.ui.addToList.* and .api.route.*).
// - marketplace/locales/search.en.json: marketplace search's English catalog (discovery.features.search.ui.searchPage.*,
//   discovery.routes.search.*, the home page's discovery.features.home.ui.homeMerchandising.*, a set's page's
//   discovery.routes.set.*, and the listing card's, language labels' and display identity's words).
// - marketplace/locales/listing.en.json: a listing's public page's English catalog (discovery.routes.publicListing.*,
//   and the item page's words for a price without a currency).
// - marketplace/nav.json: marketplace-web's top-nav contributions, each group with its children.
// - platform/tokens.json: the design system's light and dark values (packages/design-system styles.css)
//   for the tokens the pilot uses, in the format of Corten's `tokens!`.
// - <app>/static/fonts/: the three @fontsource files the screens use, in each app's static folder.
//
// <app>/locales/pilot.en.json is each app's own text (its shell and input checks) and is not exported.
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
const apps = ["admin", "marketplace"];

const snake = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * The entries of a localization catalog the rules pick, renamed: a rule is [prefix, name] for
 * every key under `prefix` (named `name.<rest>`, or `<rest>` for an empty name) or [key, name]
 * for one key.
 */
async function catalog(file, exportName, rules) {
  const all = (await import(pathToFileURL(path.join(repo, "contracts/localization/locales/en", file)).href))[exportName];
  const out = {};
  for (const [key, text] of Object.entries(all)) {
    let name;
    for (const [match, rename] of rules) {
      if (match.endsWith(".") && key.startsWith(match)) {
        const rest = key.slice(match.length);
        name = rename ? `${rename}.${rest}` : rest;
      } else if (key === match) name = rename;
      if (name) break;
    }
    if (!name) continue;
    // An argument is {name} as the catalog has it; any other brace is text, which `messages!`
    // takes doubled.
    out[name.split(".").map(snake).join(".")] = text.replace(/\{([A-Za-z0-9_]+)\}|[{}]/g, (brace, arg) => (arg ? brace : brace + brace));
  }
  return out;
}

/** Every bounded context's shell contributions to `deployable`'s `slot`. */
function contributions(deployable, slot) {
  const contexts = path.join(repo, "bounded-contexts");
  const items = [];
  for (const name of readdirSync(contexts).sort()) {
    const file = path.join(contexts, name, "context.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const item of manifest.shellContributions ?? []) {
      if (item.deployable === deployable && item.slot === slot) items.push({ context: name, item });
    }
  }
  return items;
}

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

function adminNav() {
  return contributions("admin-web", "primary-nav")
    .filter(({ item }) => item.section)
    .map(({ context, item }) => {
      if (item.parentKey) throw new Error(`${context}: ${item.key} has a parentKey, which the pilot's nav does not compose`);
      return { section: item.section, ...keep(item) };
    });
}

/** marketplace-web's top nav: the entries without a parent, each with the entries that name it. */
function marketplaceNav() {
  const all = contributions("marketplace-web", "top-nav").map(({ item }) => item);
  const keys = new Set(all.map((item) => item.key));
  for (const item of all) {
    if (item.parentKey && !keys.has(item.parentKey)) throw new Error(`${item.key}: no top-nav entry ${item.parentKey}`);
  }
  return all
    .filter((item) => !item.parentKey)
    .map((item) => {
      const children = [...(item.children ?? []), ...all.filter((child) => child.parentKey === item.key)];
      return keep({ ...item, ...(children.length ? { children } : {}) });
    });
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
const { catalogScopeProductDomains } = await import(
  pathToFileURL(path.join(repo, "bounded-contexts/catalog/features/scope-registry/domain/contract.ts")).href
);
const { defaultPostagePolicy } = await import(pathToFileURL(path.join(repo, "contracts/product-measures/index.ts")).href);
const outputs = [
  [
    "admin/locales/en.json",
    json(
      await catalog("ordering.ts", "orderingEnglishTranslations", [
        ["ordering.features.postagePolicies.ui.", ""],
        ["ordering.routes.admin.postagePolicies.title", "route.title"],
      ]),
    ),
  ],
  [
    "admin/locales/catalog.en.json",
    json(
      await catalog("catalog.ts", "catalogEnglishTranslations", [
        ["catalog.features.dimensions.ui.dimensionListPage.", "dimension_list"],
        ["catalog.features.dimensions.ui.dimensionDetailPage.", "dimension"],
        ["catalog.features.fields.ui.fieldListPage.", "field_list"],
        ["catalog.features.fields.ui.fieldDetailPage.", "field"],
        ["catalog.support.shellSupport.ui.entityListPage.", "list"],
        ["catalog.support.shellSupport.ui.entityDetailPage.", "detail"],
        ["catalog.support.shellSupport.ui.lifecycleControls.", "lifecycle"],
        ["catalog.support.shellSupport.ui.bulkLifecycleActions.", "bulk"],
        ["catalog.support.shellSupport.ui.realtimeReloadActionBar.", "realtime"],
        ["catalog.support.shellSupport.ui.realtimeConnectionStatus.", "live_status"],
        ["catalog.features.sourceObservations.ui.scopeLanding.", "scopes"],
        ["catalog.features.attentionQueue.", "attention"],
        ["catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.", "feedback"],
        ["catalog.features.catalogItems.ui.catalogItemListPage.", "item_list"],
        ["catalog.features.catalogItems.ui.catalogItemDetailPage.", "item"],
        ["catalog.routes.admin.dimensions.dimensions.catalog.admin", "route.dimensions"],
        ["catalog.routes.admin.dimensionsDetail.dimension.catalog.admin", "route.dimension"],
        ["catalog.routes.admin.fields.fields.catalog.admin", "route.fields"],
        ["catalog.routes.admin.fieldsDetail.field.catalog.admin", "route.field"],
        ["catalog.routes.admin.catalogItems.catalog.items.catalog.admin", "route.items"],
        ["catalog.routes.admin.catalogItemsDetail.catalog.item.catalog.admin", "route.item"],
        ["catalog.routes.admin.scopeLanding.scopes.catalog.admin", "route.scopes"],
      ]),
    ),
  ],
  [
    "admin/locales/operations.en.json",
    json(
      await catalog("platform-operations.ts", "platformOperationsEnglishTranslations", [
        ["platformOperations.operationsAttention.", "attention"],
      ]),
    ),
  ],
  ["admin/nav.json", json(adminNav())],
  ["admin/defaults.json", json(defaultPostagePolicy)],
  ["admin/scope-domains.json", json(catalogScopeProductDomains)],
  [
    "marketplace/locales/en.json",
    json(
      await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.storageLocations.ui.storageLocationPage.", "page"],
        ["inventory.recovery.", "recovery"],
        ["inventory.routes.marketplace.accountInventoryLocations.inventory.locations.marketplace", "route.title"],
        ["inventory.routes.marketplace.accountInventoryLocations.manage.the.storage.locations.and.ship", "route.description"],
      ]),
    ),
  ],
  [
    "marketplace/locales/restock.en.json",
    json({
      ...(await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.restockDecisions.ui.queue.", "queue"],
        ["inventory.routes.marketplace.accountInventoryRestockDecisions.title", "route.title"],
        ["inventory.routes.marketplace.accountInventoryRestockDecisions.description", "route.description"],
      ])),
      // What marketplace's resource route says when the read after a write fails for good.
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [["localization.routeResource.unverified", "unverified"]])),
    }),
  ],
  [
    "marketplace/locales/cart.en.json",
    json({
      ...(await catalog("checkout.ts", "checkoutEnglishTranslations", [
        ["checkout.features.cart.ui.cartPage.", "page"],
        ["checkout.routes.accountCart.", "route"],
      ])),
      // A line's language badge (`formatLanguageCodeLabel`).
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [["localization.languageCode.", "language"]])),
    }),
  ],
  [
    "marketplace/locales/item.en.json",
    json({
      ...(await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.features.itemDetail.ui.itemDetailPage.", "page"],
        ["discovery.features.itemDetail.ui.itemDetailPageView.", "view"],
        ["discovery.features.itemDetail.ui.productSelector.", "selector"],
        ["discovery.features.itemDetail.ui.similarItems.", "similar"],
        ["discovery.features.itemDetail.ui.marketPanel.", "panel"],
        ["discovery.routes.itemDetail.", "route"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
        // A similar item's picture's words (`formatDisplayIdentity`).
        ["localization.displayIdentity.", "identity"],
      ])),
      // Add to List (`AddToSavedListControl`) and the Collections API's refusals.
      ...(await catalog("collections.ts", "collectionsEnglishTranslations", [
        ["collections.features.savedLists.ui.addToList.", "saved"],
        ["collections.features.savedLists.api.route.", "saved_api"],
      ])),
    }),
  ],
  [
    "marketplace/locales/search.en.json",
    json({
      ...(await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.features.search.ui.searchPage.", "page"],
        ["discovery.routes.search.", "route"],
        // The home page's featured categories and new arrivals (`HomeMerchandising`).
        ["discovery.features.home.ui.homeMerchandising.", "home"],
        // A set's page (`routes/set.tsx`), whose cards are search's.
        ["discovery.routes.set.", "set"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        // A result's card (`ListingCard`), its language badge and its picture's words.
        ["localization.listingCard.", "card"],
        ["localization.languageCode.", "language"],
        ["localization.displayIdentity.", "identity"],
      ])),
    }),
  ],
  [
    "marketplace/locales/listing.en.json",
    json(
      await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.routes.publicListing.", "page"],
        // A listing without a currency's price (the item page's words, which the listing page uses).
        ["discovery.features.itemDetail.ui.itemDetailPageView.market.price.unavailable", "price_unavailable"],
      ]),
    ),
  ],
  ["marketplace/nav.json", json(marketplaceNav())],
  ["platform/tokens.json", json(tokens())],
];
const require = createRequire(path.join(repo, "packages/design-system/package.json"));
let stale = 0;
for (const [file, text] of outputs) {
  const target = path.join(pilot, file);
  if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
  if (check) {
    console.error(`${file} is out of date: run node --import tsx deployables/corten-pilot/scripts/export.mjs`);
    stale += 1;
  } else {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`wrote ${file}`);
  }
}
for (const app of apps) {
  mkdirSync(path.join(pilot, app, "static/fonts"), { recursive: true });
  for (const [pkg, name] of fonts) {
    const source = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", name);
    const target = path.join(pilot, app, "static/fonts", name);
    if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) continue;
    if (check) {
      console.error(`${app}/static/fonts/${name} is out of date`);
      stale += 1;
    } else {
      copyFileSync(source, target);
      console.log(`wrote ${app}/static/fonts/${name}`);
    }
  }
}
process.exit(stale ? 1 : 0);
