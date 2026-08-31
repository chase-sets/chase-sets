import type { HTMLAttributes } from "react";
import {
  BarChart3,
  BadgeCheck,
  Bell,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleHelp,
  Clock,
  Copy,
  CreditCard,
  DollarSign,
  ExternalLink,
  Eye,
  EyeOff,
  Flag,
  Flame,
  Grid2X2,
  Heart,
  Home,
  ImageIcon,
  Inbox,
  Info,
  LayoutDashboard,
  Lock,
  LockKeyhole,
  LogOut,
  Mail,
  MapPin,
  Menu,
  MessageSquare,
  Minus,
  MoreVertical,
  Package,
  PackageCheck,
  Pencil,
  Pause,
  Plus,
  Play,
  RefreshCcw,
  Rocket,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Star,
  StarHalf,
  Store,
  Tags,
  Trash2,
  TriangleAlert,
  Truck,
  User,
  Users,
  WalletCards,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cx } from "../utils/cx";

export type IconName =
  | "search"
  | "cart"
  | "filter"
  | "dashboard"
  | "close"
  | "check"
  | "warning"
  | "chevronDown"
  | "chevronUp"
  | "chevronLeft"
  | "chevronRight"
  | "menu"
  | "spark"
  | "package"
  | "packageCheck"
  | "settings"
  | "user"
  | "info"
  | "star"
  | "starHalf"
  | "starEmpty"
  | "copy"
  | "plus"
  | "pause"
  | "play"
  | "minus"
  | "edit"
  | "trash"
  | "heart"
  | "heartFilled"
  | "share"
  | "image"
  | "dollar"
  | "truck"
  | "clock"
  | "eye"
  | "eyeOff"
  | "home"
  | "bell"
  | "flag"
  | "message"
  | "help"
  | "calendar"
  | "tag"
  | "shield"
  | "cards"
  | "book"
  | "figure"
  | "sneaker"
  | "shirt"
  | "grid"
  | "lock"
  | "lockClosed"
  | "logOut"
  | "creditCard"
  | "chart"
  | "users"
  | "rocket"
  | "refreshCcw"
  | "externalLink"
  | "moreVertical"
  | "badgeCheck"
  | "flame"
  | "circle"
  | "wallet"
  | "bag"
  | "store"
  | "mapPin"
  | "checkCircle"
  | "xCircle"
  | "inbox";

type IconSize = "sm" | "md" | "lg";
type IconTone =
  | "inherit"
  | "primary"
  | "secondary"
  | "tertiary"
  | "accent"
  | "accent2"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "trust"
  | "deal"
  | "rating"
  | "inverse";

const iconMap: Record<IconName, LucideIcon> = {
  search: Search,
  cart: ShoppingCart,
  filter: SlidersHorizontal,
  dashboard: LayoutDashboard,
  close: X,
  check: Check,
  warning: TriangleAlert,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  menu: Menu,
  spark: Sparkles,
  package: Package,
  packageCheck: PackageCheck,
  settings: Settings,
  user: User,
  info: Info,
  star: Star,
  starHalf: StarHalf,
  starEmpty: Star,
  copy: Copy,
  plus: Plus,
  pause: Pause,
  play: Play,
  minus: Minus,
  edit: Pencil,
  trash: Trash2,
  heart: Heart,
  heartFilled: Heart,
  share: Share2,
  image: ImageIcon,
  dollar: DollarSign,
  truck: Truck,
  clock: Clock,
  eye: Eye,
  eyeOff: EyeOff,
  home: Home,
  bell: Bell,
  flag: Flag,
  message: MessageSquare,
  help: CircleHelp,
  calendar: CalendarDays,
  tag: Tags,
  shield: ShieldCheck,
  cards: BadgeCheck,
  book: BookOpen,
  figure: Bot,
  sneaker: ShoppingBag,
  shirt: Shirt,
  grid: Grid2X2,
  lock: LockKeyhole,
  lockClosed: Lock,
  logOut: LogOut,
  creditCard: CreditCard,
  chart: BarChart3,
  users: Users,
  rocket: Rocket,
  refreshCcw: RefreshCcw,
  externalLink: ExternalLink,
  moreVertical: MoreVertical,
  badgeCheck: BadgeCheck,
  flame: Flame,
  circle: Circle,
  wallet: WalletCards,
  bag: BriefcaseBusiness,
  store: Store,
  mapPin: MapPin,
  checkCircle: CheckCircle2,
  xCircle: XCircle,
  inbox: Inbox,
};

const sizeClasses: Record<IconSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

const toneClasses: Record<IconTone, string> = {
  inherit: "text-current",
  primary: "text-foreground",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
  accent: "text-accent",
  accent2: "text-accent-2",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  trust: "text-trust",
  deal: "text-deal",
  rating: "text-rating",
  inverse: "text-inverse",
};

export interface IconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  name: IconName;
  size?: IconSize;
  tone?: IconTone;
  label?: string;
}

export function Icon({ name, size = "md", tone = "primary", label, ...rest }: IconProps) {
  const Glyph = iconMap[name];
  const decorative = !label;
  const filled = name === "star" || name === "starHalf" || name === "heartFilled";

  return (
    <span {...rest} className={cx("inline-flex shrink-0 items-center", toneClasses[tone])}>
      <Glyph
        aria-hidden={decorative}
        aria-label={label}
        strokeWidth={2}
        fill={filled ? "currentColor" : "none"}
        className={sizeClasses[size]}
      />
    </span>
  );
}
