import {
  createContext,
  forwardRef,
  useContext,
  type AnchorHTMLAttributes,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from "react";

/**
 * Props every registered link component must accept. Deliberately a superset of
 * `<a>` attributes (`href` stays a plain string) rather than a router-specific shape
 * (e.g. React Router's `to`) so the DS root never has to know a router's prop
 * vocabulary — adapters translate at the boundary (see `RouterLinkAdapter` in the
 * `@chase-sets/design-system/react-router` subpath).
 */
export interface LinkAdapterProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href?: string;
  children?: ReactNode;
}

/**
 * A component that renders a navigational href. DS nav surfaces (NavigationItem,
 * LinkButton, Breadcrumbs, ...) render through this instead of a raw `<a>` so a host
 * app can register its router's `Link` once and get client-side transitions
 * everywhere without the DS taking a hard router dependency.
 */
export type LinkComponent = ForwardRefExoticComponent<LinkAdapterProps & RefAttributes<HTMLAnchorElement>>;

/**
 * Router-agnostic fallback: a plain `<a>`. Full document navigation, but native
 * keyboard/middle-click/cmd-click behavior for free. This is also the DS's default
 * `LinkAdapterContext` value, so any consumer that never registers a router still
 * gets correct (if non-SPA) links.
 */
export const AnchorLink: LinkComponent = forwardRef<HTMLAnchorElement, LinkAdapterProps>(function AnchorLink(
  { href, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} href={href} {...rest}>
      {children}
    </a>
  );
});

const LinkAdapterContext = createContext<LinkComponent>(AnchorLink);

export const LinkAdapterProvider = LinkAdapterContext.Provider;

/**
 * Returns the link component registered on `ChaseRoot` (a router `Link` in apps that
 * registered one), or `AnchorLink` when none was registered. DS nav surfaces call
 * this instead of rendering `<a>` directly so router registration is a single point
 * of integration.
 */
export function useLinkComponent(): LinkComponent {
  return useContext(LinkAdapterContext);
}
