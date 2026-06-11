import { extname } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      !shouldTryExtension(specifier) ||
      (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT")
    ) {
      throw error;
    }

    for (const extension of [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch (nextError) {
        if (nextError?.code !== "ERR_MODULE_NOT_FOUND" && nextError?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") {
          throw nextError;
        }
      }
    }

    throw error;
  }
}

function shouldTryExtension(specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0] ?? specifier;
  return (
    !extname(cleanSpecifier) &&
    (specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier))
  );
}
