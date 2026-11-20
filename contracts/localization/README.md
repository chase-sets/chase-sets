# Localization

Chase Sets launches with English only, but user-facing copy must go through the shared localization contract so additional locales can be added without combing through UI and route code later.

## Runtime

- Catalog-independent, browser-safe mechanics are exported by `@chase-sets/localization/core`. Its translators require explicit catalogs, snapshot the supplied data and are immutable. Missing or empty locale catalogs produce missing-key behavior. Copy-dependent core helpers require a `Translate` argument; they never import a catalog or the legacy root facade.
- Existing English copy remains under `contracts/localization/locales/en/<context>.ts` (for example `en/checkout.ts`, `en/payments.ts`), including Catalog's nested leaves. The committed `contracts/localization/locales/en.ts` is a generated literal-data compatibility snapshot, not an editable second source. Nested namespace merges such as `en/catalog.ts` remain generated. Neither snapshot nor merges are authored discovery inputs. Cross-module duplicate keys fail generation with both paths and owners named, including an old authored source retained beside its moved replacement.
- A bounded context can label its owned merge member with the optional `localeCatalogs` array in `context.json`; declarations never determine membership. The `admin-web`, `experience`, `localization`, `reputation`, and `support` namespaces have no single matching bounded-context owner, so collision diagnostics fall back to their tracked module paths.
- Existing callers can continue importing `t` from `@chase-sets/localization`; root translator options, helper defaults, `translationCatalogs`, locale subpaths and literal `EnglishTranslationKey` remain compatible:

```ts
import { t } from "@chase-sets/localization";

t("checkout.features.cart.ui.cartPage.check.out");
t("catalog.support.shellSupport.ui.lifecycleControls.confirm.action.title", {
  action: "Archive",
});
```

The translator supports named interpolation with `{name}` tokens. Keep interpolation values data-only; do not build sentences by concatenating translated fragments when a complete sentence key would be clearer.

## Owner-Local Composition

New owner-local catalogs use `localization/locales/en.ts` or `localization/locales/en/<slice>.ts` under their owning workspace or feature. Tracked files following this convention are discovered across `bounded-contexts`, `contracts`, `infrastructure`, `packages` and `deployables`; untracked files cannot become sources. The generator's synthetic fixtures exercise these example paths, not production catalog migrations:

```text
bounded-contexts/catalog/features/items/localization/locales/en/cards.ts
infrastructure/platform-runtime/localization/locales/en.ts
deployables/marketplace/localization/locales/en.ts
```

These are conventions, not a membership registry. Optional context declarations label ownership but never exclude undeclared tracked sources.

Catalog modules export exactly one statically keyed string-literal object (including `as const`, `satisfies`, computed literal keys and named export aliases). They are data, not executable registration. Generation parses sources without importing or executing them, and the legacy snapshot imports no owner module. Do not author a generated nested merge as a source.

```ts
import { createTranslator } from "@chase-sets/localization/core";
import { itemEnglishTranslations } from "./localization/locales/en/items";

const { t } = createTranslator({ catalogs: { en: itemEnglishTranslations } });
t("catalog.items.title");
```

Keep catalogs and scoped translators internal unless a named real caller needs an owner `./localization` export. Compose immutable catalogs locally with ordinary imports and object composition; there is no runtime registry, provider, host plugin or ambient catalog state. Use the guard-recognized identifier `t` at call sites.

This foundation does not migrate production catalogs or callers. Generic technical keys move in the technical-owner slice; experience/support move to platform-operations and reputation to marketplace in their existing successor slices, without renaming keys.

Use `formatLanguageCodeLabel` for visible catalog language-code badges or display fields. Keep the underlying API, event, query, and persisted values as language codes such as `en` or `ja`; only convert them to localized labels at presentation boundaries.

## Missing Translations

Missing keys return a visible sentinel in the current locale:

```txt
[missing:en:some.key]
```

Callers that need telemetry can create a translator with `createTranslator({ onMissingTranslation })`. The default export is intentionally safe for launch: missing copy is obvious in UI and tests instead of silently falling back to English source text.

## Adding Copy

1. Add the English value to its existing authored catalog, or an owner-local source following the convention above. Track new modules and optionally label context ownership with `localeCatalogs`. The legacy `./locales/en/*` export remains available. Never edit generated `en.ts` or `en/catalog.ts`; run `pnpm run sync:workspace-metadata` after adding, removing, or renaming a tracked source. `--check` reports missing/stale output and deleted membership without writing. Repeated generation is byte-identical.
2. Use a namespaced key that follows ownership:
   - `checkout.features.cart.ui.cartPage.check.out`
   - `catalog.support.shellSupport.ui.lifecycleControls.cancel`
   - `payments.routes.marketplace.accountPayment.payment.not.found`
3. Use complete natural-language phrases. Prefer `"{count} listings"` over `"listings"` plus manual string assembly.
4. Keep brand names, domain identifiers, route paths, form field names, enum values, and SQL out of localization unless they are displayed as copy.

## Adding Locales

1. Extend the committed-artifact generator for the locale and add its root file beside `locales/en.ts`.
2. Extend core's `supportedLocales` and the legacy facade's `translationCatalogs` as part of that future locale change.
3. Keep every locale file key-complete with English, including the same `{placeholder}` token names.
4. Update app locale resolution when a user or operator locale preference exists. Until then, `defaultLocale` is `en`.

## Guardrail

Run:

```sh
npm run check:localization
```

The check verifies that every `t("...")` key exists in English and blocks direct hardcoded copy in JSX text, common copy-bearing props, common copy-bearing object properties, and copy-bearing template literals. It is included in `npm run verify`.

Runtime tests in `contracts/localization/index.test.ts` also assert that every supported locale has the same keys and interpolation placeholders as English.

Intentional exclusions are still allowed for non-copy values: IDs, enum values, field names, URL paths, query strings, CSS classes, SQL, telemetry labels, test data, and persisted domain values. If one of those values becomes visible explanatory copy, wrap the full phrase in a localization key at the UI or route boundary.

## Bridge Removal

The compatibility facade and snapshot are finite migration bridges. Each owner migration removes its vacated authored source, not its keys. Only after every legacy consumer, including type imports, dynamic keys and helper callers, migrates may the terminal slice [#8315 Remove legacy locality bridges and prove the full migration is complete](https://github.com/chase-sets/chase-sets/issues/8315) delete global/root exports, the snapshot, old locale subpaths and legacy discovery branches. That deletion must prove filesystem/import/export absence. Do not retarget final tooling or remove the bridge early in this foundation.
