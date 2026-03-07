import type { IconName, NavigationItem } from "@chase-sets/design-system";

export interface InventoryRow {
  sku: string;
  card: string;
  condition: "NM" | "LP" | "MP" | "HP" | "DMG";
  price: number;
  stock: number;
}

export const marketplaceNav = [
  { key: "browse", label: "Browse", icon: "search" },
  { key: "sets", label: "Sets", icon: "spark" },
  { key: "cart", label: "Cart", icon: "cart", badge: "3" },
  { key: "account", label: "Account", icon: "user" }
] satisfies NavigationItem[];

export const adminNav = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard" },
  { key: "inventory", label: "Inventory", icon: "package" },
  { key: "pricing", label: "Pricing", icon: "spark" },
  { key: "settings", label: "Settings", icon: "settings" }
] satisfies NavigationItem[];

export const inventoryRows: InventoryRow[] = [
  {
    sku: "CS-001",
    card: "Charizard ex - 199/165",
    condition: "NM",
    price: 29.95,
    stock: 14
  },
  {
    sku: "CS-014",
    card: "Iono - 237/091",
    condition: "LP",
    price: 12.5,
    stock: 32
  },
  {
    sku: "CS-104",
    card: "Mewtwo VSTAR - GG44",
    condition: "NM",
    price: 9.25,
    stock: 7
  }
];

export const showcaseIconNames = [
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
  "eyeOff"
] as const satisfies readonly IconName[];
