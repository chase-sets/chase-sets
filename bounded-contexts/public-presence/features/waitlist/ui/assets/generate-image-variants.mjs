// Generates the narrower WebP width variants that back the landing page's
// `srcset`/`sizes` responsive images. The widest variant is the
// already-committed source asset itself -- this script only produces the
// smaller derivatives, so mobile/tablet viewports stop downloading
// desktop-weight images.
//
// Re-run after replacing a source asset:
//   pnpm --filter @chase-sets/public-presence run generate:landing-image-variants
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const assetsDir = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {{ source: string; widths: number[] }} VariantSpec */

/** @type {VariantSpec[]} */
const variantSpecs = [
  // Hero: eager + fetchpriority=high, the page's LCP element. 800w keeps
  // mobile viewports (~375-430 CSS px at 2x DPR) off the desktop-weight file.
  { source: "chase-sets-prelaunch-hero.webp", widths: [800, 1200] },
  // Below-the-fold "how it works" visual (MarketingVisualCard): lazy +
  // fetchpriority=low, but still worth trimming for the ~50vw desktop slot.
  { source: "chase-sets-waitlist-card-panels.webp", widths: [600, 1080] },
];

function variantFileName(source, width) {
  const ext = path.extname(source);
  const base = source.slice(0, -ext.length);
  return `${base}-${width}w${ext}`;
}

async function generate() {
  for (const { source, widths } of variantSpecs) {
    const sourcePath = path.join(assetsDir, source);
    await access(sourcePath);
    const sourceStat = await stat(sourcePath);

    for (const width of widths) {
      const outputPath = path.join(assetsDir, variantFileName(source, width));
      await sharp(sourcePath).resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toFile(outputPath);
      const outputStat = await stat(outputPath);
      console.log(`${path.basename(outputPath)} (${outputStat.size} bytes, source ${sourceStat.size} bytes)`);
    }
  }
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
