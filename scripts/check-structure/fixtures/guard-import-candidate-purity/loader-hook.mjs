export function resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs" || specifier === "fs") {
    return { url: new URL("./denied-fs.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
