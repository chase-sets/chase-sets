import { createHash } from "node:crypto";

export function addProductCardsBundleHashes(html: string): string {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (!meta?.[1]) throw new Error("Product Cards document CSP is missing.");

  // vite-plugin-singlefile emits one inline script and one inline stylesheet.
  const bundles = [...html.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  let policy = meta[1];
  for (const tag of ["script", "style"]) {
    const [bundle, ...extra] = bundles.filter((match) => match[1] === tag);
    const marker = `'sha256-BUNDLED_${tag.toUpperCase()}'`;
    if (!bundle?.[2] || extra.length || bundle.index < meta.index || !policy.includes(marker)) {
      throw new Error(`Product Cards document CSP needs one bundled ${tag} after the policy.`);
    }
    const hash = createHash("sha256").update(bundle[2].replace(/\r\n?/g, "\n")).digest("base64");
    policy = policy.replace(marker, `'sha256-${hash}'`);
  }
  return html.replace(meta[0], () => meta[0].replace(meta[1]!, policy));
}
