import { extname } from "node:path";

const SOURCE_TYPESCRIPT_CANDIDATE = ".ts";

export const TYPESCRIPT_RESOLUTION_CANDIDATES = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
]);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (originalError) {
    const sourceEligible =
      (specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/iu.test(specifier);
    const cleanSpecifier = specifier.split(/[?#]/, 1)[0] ?? specifier;
    const pathLike = specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(specifier);
    const extensionError =
      originalError?.code === "ERR_MODULE_NOT_FOUND" || originalError?.code === "ERR_UNSUPPORTED_DIR_IMPORT";
    const extensionEligible = pathLike && !extname(cleanSpecifier) && extensionError;

    if (!sourceEligible && !extensionEligible) throw originalError;

    const candidates = extensionEligible ? TYPESCRIPT_RESOLUTION_CANDIDATES : [SOURCE_TYPESCRIPT_CANDIDATE];
    for (const extension of candidates) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch (candidateError) {
        if (
          extensionEligible &&
          candidateError?.code !== "ERR_MODULE_NOT_FOUND" &&
          candidateError?.code !== "ERR_UNSUPPORTED_DIR_IMPORT"
        ) {
          throw candidateError;
        }
      }
    }

    throw originalError;
  }
}
