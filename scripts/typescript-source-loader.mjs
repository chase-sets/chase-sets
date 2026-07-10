/**
 * Node's built-in type stripping does not add TypeScript extensions to
 * extensionless ESM imports. Repo source follows the bundler-friendly
 * extensionless convention, so operator scripts register this narrow resolver
 * before importing a context-owned TypeScript module.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/iu.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
