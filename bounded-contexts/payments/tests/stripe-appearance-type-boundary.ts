import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";
import { createStripeElementsAppearance } from "@chase-sets/stripe-appearance";

declare const theme: EmbeddedSurfaceTheme;
const known: EmbeddedSurfaceTheme = theme;
void known;

// @ts-expect-error The v1 contract has no arbitrary provider token slot.
const unknown: EmbeddedSurfaceTheme = { ...theme, providerToken: "#fff" };
// @ts-expect-error The adapter accepts a theme, not a DOM scope.
createStripeElementsAppearance({ scope: document.body });
void unknown;
