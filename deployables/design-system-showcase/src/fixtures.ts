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
  { key: "categories", label: "Categories", icon: "grid" },
  { key: "how", label: "How it Works", icon: "help" },
  { key: "sell", label: "Sell", icon: "tag" },
  { key: "cart", label: "Cart", icon: "cart", badge: "3" },
  { key: "account", label: "Account", icon: "user" }
] satisfies NavigationItem[];

export const adminNav = [
  { key: "overview", label: "Overview", icon: "home" },
  { key: "listings", label: "Listings", icon: "package" },
  { key: "orders", label: "Orders", icon: "bag" },
  { key: "analytics", label: "Analytics", icon: "chart" },
  { key: "payouts", label: "Payouts", icon: "wallet" },
  { key: "messages", label: "Messages", icon: "message", badge: "2" },
  { key: "reviews", label: "Reviews", icon: "star" },
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
  "eyeOff",
  "home",
  "bell",
  "message",
  "help",
  "calendar",
  "tag",
  "shield",
  "cards",
  "book",
  "figure",
  "sneaker",
  "shirt",
  "grid",
  "lock",
  "creditCard",
  "chart",
  "users",
  "rocket",
  "externalLink",
  "moreVertical",
  "badgeCheck",
  "flame",
  "wallet",
  "bag",
  "store"
] as const satisfies readonly IconName[];

export const demoProducts = [
  {
    title: "2020 Pikachu VMAX",
    subtitle: "PSA 10",
    price: "$1,250",
    imageSrc: "/demo-assets/pikachu-card.svg",
    status: "Verified"
  },
  {
    title: "Amazing Spider-Man #300",
    subtitle: "CGC 9.6",
    price: "$1,650",
    imageSrc: "/demo-assets/spider-comic.svg",
    status: "Hot"
  },
  {
    title: "Dragon Ball Z Goku",
    subtitle: "S.H.Figuarts",
    price: "$275",
    imageSrc: "/demo-assets/figure.svg",
    status: "Hot"
  },
  {
    title: "Air Jordan 1 Retro High",
    subtitle: "Chicago (2015)",
    price: "$850",
    imageSrc: "/demo-assets/sneaker.svg",
    status: "Verified"
  },
  {
    title: "Michael Jordan Jersey",
    subtitle: "Autographed",
    price: "$2,450",
    imageSrc: "/demo-assets/jersey.svg",
    status: "Verified"
  }
];
