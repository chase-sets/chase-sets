// @vitest-environment node
import { readFileSync } from "node:fs";
import * as lucide from "lucide-react";
import { renderToString } from "react-dom/server";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "../icons";

// Immutable pre-flag bindings reviewed from 39798acce370b43656136f87bfd0ac7982a887e4.
// This oracle never reads Git refs or derives expectations from the candidate.
const preFlagBindings = {
  search: "Search",
  cart: "ShoppingCart",
  filter: "SlidersHorizontal",
  dashboard: "LayoutDashboard",
  close: "X",
  check: "Check",
  warning: "TriangleAlert",
  chevronDown: "ChevronDown",
  chevronUp: "ChevronUp",
  chevronLeft: "ChevronLeft",
  chevronRight: "ChevronRight",
  menu: "Menu",
  spark: "Sparkles",
  package: "Package",
  packageCheck: "PackageCheck",
  settings: "Settings",
  user: "User",
  info: "Info",
  star: "Star",
  starHalf: "StarHalf",
  starEmpty: "Star",
  copy: "Copy",
  plus: "Plus",
  pause: "Pause",
  play: "Play",
  minus: "Minus",
  edit: "Pencil",
  trash: "Trash2",
  heart: "Heart",
  heartFilled: "Heart",
  share: "Share2",
  image: "ImageIcon",
  dollar: "DollarSign",
  truck: "Truck",
  clock: "Clock",
  eye: "Eye",
  eyeOff: "EyeOff",
  home: "Home",
  bell: "Bell",
  message: "MessageSquare",
  help: "CircleHelp",
  calendar: "CalendarDays",
  tag: "Tags",
  shield: "ShieldCheck",
  cards: "BadgeCheck",
  book: "BookOpen",
  figure: "Bot",
  sneaker: "ShoppingBag",
  shirt: "Shirt",
  grid: "Grid2X2",
  lock: "LockKeyhole",
  lockClosed: "Lock",
  logOut: "LogOut",
  creditCard: "CreditCard",
  chart: "BarChart3",
  users: "Users",
  rocket: "Rocket",
  refreshCcw: "RefreshCcw",
  externalLink: "ExternalLink",
  moreVertical: "MoreVertical",
  badgeCheck: "BadgeCheck",
  flame: "Flame",
  circle: "Circle",
  wallet: "WalletCards",
  bag: "BriefcaseBusiness",
  store: "Store",
  mapPin: "MapPin",
  checkCircle: "CheckCircle2",
  xCircle: "XCircle",
  inbox: "Inbox",
  mail: "Mail",
} as const satisfies Record<string, keyof typeof lucide>;

function assertRegistry(source: string, withFlag: boolean) {
  const tree = ts.createSourceFile("icons.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names: string[] = [];
  const bindings: [string, string][] = [];
  function visit(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "IconName" && ts.isUnionTypeNode(node.type)) {
      for (const member of node.type.types) {
        expect(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)).toBe(true);
        names.push((member as ts.LiteralTypeNode).literal.getText(tree).slice(1, -1));
      }
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "iconMap") {
      expect(node.initializer && ts.isObjectLiteralExpression(node.initializer)).toBe(true);
      for (const property of (node.initializer as ts.ObjectLiteralExpression).properties) {
        expect(ts.isPropertyAssignment(property)).toBe(true);
        const assignment = property as ts.PropertyAssignment;
        bindings.push([assignment.name.getText(tree), assignment.initializer.getText(tree)]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const expected = withFlag ? { ...preFlagBindings, flag: "Flag" } : preFlagBindings;
  expect(names.sort()).toEqual(Object.keys(expected).sort());
  expect(bindings.sort(([a], [b]) => a.localeCompare(b))).toEqual(
    Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)),
  );
}

const source = readFileSync(new URL("../icons/index.tsx", import.meta.url), "utf8");

describe("icon registry", () => {
  it("maps flag to a rendered glyph without changing any existing icon binding", () => {
    assertRegistry(source, true);
    for (const [name, glyph] of Object.entries({ ...preFlagBindings, flag: "Flag" } as const)) {
      const icon = Icon({ name: name as IconName });
      expect(icon.props.children.type).toBe(lucide[glyph]);
      expect(renderToString(icon)).toContain("<svg");
    }
    expect(Icon({ name: "flag" }).props.children.type).toBe(lucide.Flag);
    expect(renderToString(<Icon name="flag" />)).toContain("lucide-flag");
    expect(() => renderToString(<Icon name={"__unmapped_icon_probe__" as IconName} />)).toThrow(
      "Element type is invalid",
    );
  });

  it("validates pre-flag and post-flag fixtures without Git", () => {
    const renderFixture = (withFlag: boolean) => {
      const bindings = withFlag ? { ...preFlagBindings, flag: "Flag" } : preFlagBindings;
      return `type IconName = ${Object.keys(bindings)
        .map((name) => JSON.stringify(name))
        .join(" | ")};
        const iconMap = { ${Object.entries(bindings)
          .map(([name, glyph]) => `${name}: ${glyph}`)
          .join(",")} };`;
    };
    assertRegistry(renderFixture(false), false);
    assertRegistry(renderFixture(true), true);
  });

  it.each([
    ["extra name", (text: string) => text.replace('| "search"', '| "extra" | "search"')],
    ["binding swap", (text: string) => text.replace("search: Search", "search: ShoppingCart")],
    ["misbound flag", (text: string) => text.replace("flag: Flag", "flag: TriangleAlert")],
    ["duplicate flag", (text: string) => text.replace("flag: Flag,", "flag: Flag, flag: Flag,")],
    ["duplicate flag name", (text: string) => text.replace('| "flag"', '| "flag" | "flag"')],
  ] as const)("rejects %s", (_name, mutate) => {
    const mutant = mutate(source);
    expect(mutant).not.toBe(source);
    expect(() => assertRegistry(mutant, true)).toThrow();
  });
});
