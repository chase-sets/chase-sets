// Generates the committed PWA icon PNGs for the marketplace and admin-web
// deployables: four distinct images (standard and maskable at 192 and 512)
// duplicated byte-for-byte across the two deployables' public/icons trees.
// The mark geometry is read from the shipped design-system vector source and
// the brand-foil colours from the committed candidate-token fixture, so the
// rasters can never silently desynchronise from the vector mark. Outputs are
// committed; consumers never re-render them at build time.
//
// Re-run after the mark geometry or the brand foil moves:
//   pnpm run generate:brand-icons
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const markSourcePath = path.join(repositoryRoot, "packages", "design-system", "src", "brand", "chase-sets-logo.svg");
const fixturePath = path.join(
  repositoryRoot,
  "packages",
  "design-system",
  "src",
  "theme",
  "__fixtures__",
  "ink-foil-candidate-tokens.json",
);

const markSource = readFileSync(markSourcePath, "utf8");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

function requireMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`${label} not found in ${markSourcePath} -- the derivation seam moved`);
  }
  return match;
}

// Geometry is derived from the shipped mark source, never re-typed here.
const viewBoxMatch = requireMatch(markSource, /viewBox="0 0 (\d+) (\d+)"/, "viewBox");
const viewBoxWidth = Number(viewBoxMatch[1]);
const viewBoxHeight = Number(viewBoxMatch[2]);

const markPaths = [...markSource.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1]);
if (markPaths.length !== 2) {
  throw new Error(`expected exactly two mark paths in ${markSourcePath}, found ${markPaths.length}`);
}

const gradientMatch = requireMatch(
  markSource,
  /<linearGradient id="logoGradient" gradientUnits="userSpaceOnUse" x1="(\d+)" y1="(\d+)" x2="(\d+)" y2="(\d+)">/,
  "logoGradient",
);
const gradient = {
  x1: Number(gradientMatch[1]),
  y1: Number(gradientMatch[2]),
  x2: Number(gradientMatch[3]),
  y2: Number(gradientMatch[4]),
};

// Icons render on a white canvas, so they take the light brand foil; the
// values come from the committed fixture's candidates, never from this file.
const foil = Object.fromEntries(
  ["start", "mid", "end"].map((stop) => {
    const entry = fixture.light[`--chase-logo-${stop}`];
    if (!entry || typeof entry.candidate !== "string") {
      throw new Error(`fixture light --chase-logo-${stop} candidate missing at ${fixturePath}`);
    }
    return [stop, entry.candidate];
  }),
);

// The mark's own bounding box in viewBox space, computed from the path data
// (the shipped paths are absolute M/L commands, so every token pair is a
// coordinate).
let markMinX = Infinity;
let markMinY = Infinity;
let markMaxX = -Infinity;
let markMaxY = -Infinity;
for (const d of markPaths) {
  for (const pair of d.matchAll(/(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g)) {
    const x = Number(pair[1]);
    const y = Number(pair[2]);
    if (x < markMinX) markMinX = x;
    if (x > markMaxX) markMaxX = x;
    if (y < markMinY) markMinY = y;
    if (y > markMaxY) markMaxY = y;
  }
}
const markHeight = markMaxY - markMinY;

const canvasColor = "#ffffff";

// Committed framing, measured from the shipped icons: the full viewBox is
// centred on the canvas, scaled so the mark's bounding-box height occupies
// 350/512 of the canvas (standard) or 290/512 (maskable safe zone). Framing
// is a fixed input; this file re-renders the shipped composition and never
// re-chooses it.
const roles = [
  { role: "standard", markHeightFraction: 350 / 512 },
  { role: "maskable", markHeightFraction: 290 / 512 },
];
const sizes = [192, 512];

function iconSvg(size, markHeightFraction) {
  const scale = (size * markHeightFraction) / markHeight;
  const translateX = (size - viewBoxWidth * scale) / 2;
  const translateY = (size - viewBoxHeight * scale) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${canvasColor}"/>
  <defs>
    <linearGradient id="brandFoil" gradientUnits="userSpaceOnUse" x1="${gradient.x1}" y1="${gradient.y1}" x2="${gradient.x2}" y2="${gradient.y2}">
      <stop offset="0" stop-color="${foil.start}"/>
      <stop offset="0.52" stop-color="${foil.mid}"/>
      <stop offset="1" stop-color="${foil.end}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${translateX}, ${translateY}) scale(${scale})">
    <g fill="url(#brandFoil)">
      ${markPaths.map((d) => `<path d="${d}"/>`).join("\n      ")}
    </g>
  </g>
</svg>`;
}

function outputPaths(role, size) {
  const marketplaceName = role === "maskable" ? `chase-sets-maskable-${size}.png` : `chase-sets-${size}.png`;
  const adminName = role === "maskable" ? `chase-sets-admin-maskable-${size}.png` : `chase-sets-admin-${size}.png`;
  return [
    path.join(repositoryRoot, "deployables", "marketplace", "public", "icons", marketplaceName),
    path.join(repositoryRoot, "deployables", "admin-web", "public", "icons", adminName),
  ];
}

async function generate() {
  for (const { role, markHeightFraction } of roles) {
    for (const size of sizes) {
      const buffer = await sharp(Buffer.from(iconSvg(size, markHeightFraction)))
        .png({ compressionLevel: 9 })
        .toBuffer();
      const metadata = await sharp(buffer).metadata();
      if (metadata.width !== size || metadata.height !== size) {
        throw new Error(`${role} ${size} rendered at ${metadata.width}x${metadata.height}, expected ${size}x${size}`);
      }
      // One rendered image per role and size, written byte-for-byte to both
      // deployables so the eight committed paths stay four distinct images.
      for (const outputPath of outputPaths(role, size)) {
        writeFileSync(outputPath, buffer);
        console.log(`${path.relative(repositoryRoot, outputPath)} (${buffer.byteLength} bytes)`);
      }
    }
  }
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
