const CATALOG_ADMIN_BASE_PATH = "/catalog";

export function toCatalogAdminHref(href: string) {
  if (!href.startsWith("/")) {
    return href;
  }

  if (href === CATALOG_ADMIN_BASE_PATH || href.startsWith(`${CATALOG_ADMIN_BASE_PATH}/`)) {
    return href;
  }

  return `${CATALOG_ADMIN_BASE_PATH}${href}`;
}

