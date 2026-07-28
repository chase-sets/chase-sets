# Localization

Chase Sets launches with English only, but user-facing copy must go through the shared localization contract so additional locales can be added without combing through UI and route code later.

## Runtime

- Shared localization primitives live in `contracts/localization`.
- English copy is split by owning context under `contracts/localization/locales/en/<context>.ts` (for example `en/checkout.ts`, `en/payments.ts`). The committed merge modules at `contracts/localization/locales/en.ts` and `en/catalog.ts` are generated from tracked modules discovered with `git ls-files`; they hold no copy of their own. A namespace directory produces its matching merge module, so Catalog's files under `en/catalog/` feed `en/catalog.ts`, which then feeds the root English catalog. Cross-module duplicate keys fail generation with both owning modules named.
- A bounded context can label its owned merge member with the optional `localeCatalogs` array in `context.json`; declarations never determine membership. The `admin-web`, `experience`, `localization`, `reputation`, and `support` namespaces have no single matching bounded-context owner, so collision diagnostics fall back to their tracked module paths.
- Import `t` from `@chase-sets/localization` anywhere user-facing text is composed:

```ts
import { t } from "@chase-sets/localization";

t("checkout.features.cart.ui.cartPage.check.out");
t("catalog.support.shellSupport.ui.lifecycleControls.confirm.action.title", {
  action: "Archive",
});
```

The translator supports named interpolation with `{name}` tokens. Keep interpolation values data-only; do not build sentences by concatenating translated fragments when a complete sentence key would be clearer.

Use `formatLanguageCodeLabel` for visible catalog language-code badges or display fields. Keep the underlying API, event, query, and persisted values as language codes such as `en` or `ja`; only convert them to localized labels at presentation boundaries.

## Missing Translations

Missing keys return a visible sentinel in the current locale:

```txt
[missing:en:some.key]
```

Callers that need telemetry can create a translator with `createTranslator({ onMissingTranslation })`. The default export is intentionally safe for launch: missing copy is obvious in UI and tests instead of silently falling back to English source text.

## Adding Copy

1. Add the English value to the owning context's file under `contracts/localization/locales/en/` (for example `en/checkout.ts`), or the matching per-slice file under `en/catalog/` for Catalog keys. For a new English namespace, add and track its module and declare it in the owning context's optional `localeCatalogs` array when one owner exists. The `./locales/en/*` package export resolves new namespace subpaths without another manifest edit. Do not edit the generated merge files `en.ts` or `en/catalog.ts`; run `pnpm run sync:workspace-metadata` after adding, removing, or renaming a tracked module.
2. Use a namespaced key that follows ownership:
   - `checkout.features.cart.ui.cartPage.check.out`
   - `catalog.support.shellSupport.ui.lifecycleControls.cancel`
   - `payments.routes.marketplace.accountPayment.payment.not.found`
3. Use complete natural-language phrases. Prefer `"{count} listings"` over `"listings"` plus manual string assembly.
4. Keep brand names, domain identifiers, route paths, form field names, enum values, and SQL out of localization unless they are displayed as copy.

## Adding Locales

1. Extend the committed-artifact generator for the locale and add its root file beside `locales/en.ts`.
2. Add the locale code to `supportedLocales` and `translationCatalogs` in `contracts/localization/index.ts`.
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
