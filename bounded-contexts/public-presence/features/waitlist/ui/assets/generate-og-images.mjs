// Generates the committed 1200x630 Open Graph / Twitter card images for the
// public landing surfaces: the default landing card, one card per launch
// game (the `?game=` roster campaign-link variants), and the founders-offer
// terms card. Deterministic SVG composed from the design-system brand mark
// and dark-theme palette, rasterized to PNG with sharp -- no runtime OG
// service, no design tooling. Outputs are committed, so consumers never
// re-render them at build time.
//
// Re-run after changing card copy or the brand palette:
//   pnpm --filter @chase-sets/public-presence run generate:og-images
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const assetsDir = path.dirname(fileURLToPath(import.meta.url));

const WIDTH = 1200;
const HEIGHT = 630;

// Design-system dark theme + brand gradient (packages/design-system/src/styles/styles.css
// and packages/design-system/src/brand/chase-sets-logo.tsx dark palette).
const palette = {
  background: "#020617",
  surface: "#0b1428",
  foreground: "#f8fafc",
  muted: "#94a3b8",
  gradientStart: "#2dd4bf",
  gradientMid: "#5b8ef4",
  gradientEnd: "#93c5fd",
};

// The two brand-mark paths from chaseSetsLogoSvg (viewBox 0 0 1254 1254).
const logoPaths = [
  "M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z",
  "M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z",
];

const fontStack = `'IBM Plex Sans', 'Segoe UI', Arial, sans-serif`;

/**
 * Card copy stays inside shipped public claims: game names and the
 * "Full curated catalogs. Raw and graded." roster line mirror the landing
 * roster (contracts/localization/locales/en/public-presence.ts), the founders
 * card mirrors the published /founders offer terms, and the launch date is
 * the one hard public date (launch-config.ts). No traction numbers.
 */
const launchFooter = "Public launch · September 1, 2026";
const rosterSubtitle = "Full curated catalog · Raw and graded";

const cards = [
  {
    name: "default",
    eyebrow: "Trading card marketplace",
    title: "Chase the sets you love",
    subtitle: "Pokemon · Magic: The Gathering · Yu-Gi-Oh! · Disney Lorcana · One Piece",
  },
  { name: "pokemon", eyebrow: "Trading card marketplace", title: "Pokemon", subtitle: rosterSubtitle },
  {
    name: "magic-the-gathering",
    eyebrow: "Trading card marketplace",
    title: "Magic: The Gathering",
    subtitle: rosterSubtitle,
  },
  { name: "yu-gi-oh", eyebrow: "Trading card marketplace", title: "Yu-Gi-Oh!", subtitle: rosterSubtitle },
  { name: "disney-lorcana", eyebrow: "Trading card marketplace", title: "Disney Lorcana", subtitle: rosterSubtitle },
  {
    name: "one-piece-card-game",
    eyebrow: "Trading card marketplace",
    title: "One Piece Card Game",
    subtitle: rosterSubtitle,
  },
  {
    name: "founders",
    eyebrow: "Founders offer",
    title: "Founders offer terms",
    subtitle: "500 numbered badges · 60-day 0% seller-fee window",
  },
];

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function cardSvg({ eyebrow, title, subtitle }) {
  // Long game names step the display size down so every title stays inside
  // the 96px side margins without measurement-dependent layout.
  const titleFontSize = title.length > 14 ? 72 : 92;
  // The five-game roster line on the default card is the one long subtitle;
  // step it down so it clears the 96px right margin.
  const subtitleFontSize = subtitle.length > 50 ? 29 : 34;
  const logoScale = 120 / 1254;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${palette.gradientStart}"/>
      <stop offset="0.52" stop-color="${palette.gradientMid}"/>
      <stop offset="1" stop-color="${palette.gradientEnd}"/>
    </linearGradient>
    <linearGradient id="logoGradient" gradientUnits="userSpaceOnUse" x1="248" y1="420" x2="1012" y2="842">
      <stop offset="0" stop-color="${palette.gradientStart}"/>
      <stop offset="0.52" stop-color="${palette.gradientMid}"/>
      <stop offset="1" stop-color="${palette.gradientEnd}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.15" r="0.9">
      <stop offset="0" stop-color="${palette.surface}"/>
      <stop offset="1" stop-color="${palette.background}"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <rect width="${WIDTH}" height="10" fill="url(#brand)"/>
  <g transform="translate(96, 84) scale(${logoScale})">
    <g fill="url(#logoGradient)">
      ${logoPaths.map((d) => `<path d="${d}"/>`).join("\n      ")}
    </g>
  </g>
  <text x="240" y="168" font-family="${fontStack}" font-size="52" font-weight="600" fill="${palette.foreground}">Chase Sets</text>
  <text x="96" y="330" font-family="${fontStack}" font-size="30" font-weight="600" letter-spacing="6" fill="${palette.gradientStart}">${escapeXml(eyebrow.toUpperCase())}</text>
  <text x="96" y="428" font-family="${fontStack}" font-size="${titleFontSize}" font-weight="700" fill="${palette.foreground}">${escapeXml(title)}</text>
  <text x="96" y="492" font-family="${fontStack}" font-size="${subtitleFontSize}" fill="${palette.muted}">${escapeXml(subtitle)}</text>
  <text x="96" y="566" font-family="${fontStack}" font-size="30" font-weight="600" fill="${palette.gradientMid}">chasesets.com</text>
  <text x="${WIDTH - 96}" y="566" text-anchor="end" font-family="${fontStack}" font-size="30" fill="${palette.muted}">${escapeXml(launchFooter)}</text>
</svg>`;
}

async function generate() {
  for (const card of cards) {
    const outputPath = path.join(assetsDir, `chase-sets-og-${card.name}.png`);
    await sharp(Buffer.from(cardSvg(card)))
      .png({ compressionLevel: 9, palette: true })
      .toFile(outputPath);
    const metadata = await sharp(outputPath).metadata();
    if (metadata.width !== WIDTH || metadata.height !== HEIGHT) {
      throw new Error(`${outputPath} rendered at ${metadata.width}x${metadata.height}, expected ${WIDTH}x${HEIGHT}`);
    }
    const { size } = await stat(outputPath);
    console.log(`chase-sets-og-${card.name}.png (${size} bytes)`);
  }
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
