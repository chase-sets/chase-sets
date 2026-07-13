export const CONNECT_EMBEDDED_COMPONENT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://connect-js.stripe.com https://js.stripe.com",
  "connect-src 'self' https://api.stripe.com https://merchant-ui-api.stripe.com",
  "frame-src https://connect-js.stripe.com https://js.stripe.com",
  "img-src 'self' data: https://*.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' data:",
].join("; ");

export function stripeConnectHeaders() {
  return {
    "Content-Security-Policy": CONNECT_EMBEDDED_COMPONENT_CSP,
    "Cross-Origin-Opener-Policy": "unsafe-none",
  };
}
