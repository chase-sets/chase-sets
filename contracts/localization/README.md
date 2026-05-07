# Localization

Chase Sets launches with English only, but user-facing copy must go through the shared localization contract so additional locales can be added without combing through UI and route code later.

## Runtime

- Shared localization primitives live in `contracts/localization`.
- English copy lives in `contracts/localization/locales/en.ts`.
- Import `t` from `@chase-sets/localization` anywhere user-facing text is composed:

```ts
import { t } from "@chase-sets/localization";

t("checkout.features.cart.ui.cartPage.start.checkout");
t("catalog.support.shellSupport.ui.lifecycleControls.confirm.action.title", {
  action: "Archive",
});
```

The translator supports named interpolation with `{name}` tokens. Keep interpolation values data-only; do not build sentences by concatenating translated fragments when a complete sentence key would be clearer.

## Missing Translations

Missing keys return a visible sentinel in the current locale:

```txt
[missing:en:some.key]
```

Callers that need telemetry can create a translator with `createTranslator({ onMissingTranslation })`. The default export is intentionally safe for launch: missing copy is obvious in UI and tests instead of silently falling back to English source text.

## Adding Copy

1. Add the English value to `contracts/localization/locales/en.ts`.
2. Use a namespaced key that follows ownership:
   - `checkout.features.cart.ui.cartPage.start.checkout`
   - `catalog.support.shellSupport.ui.lifecycleControls.cancel`
   - `payments.routes.marketplace.accountPayment.payment.not.found`
3. Use complete natural-language phrases. Prefer `"{count} listings"` over `"listings"` plus manual string assembly.
4. Keep brand names, domain identifiers, route paths, form field names, enum values, and SQL out of localization unless they are displayed as copy.

## Adding Locales

1. Add a locale file beside `locales/en.ts`.
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
