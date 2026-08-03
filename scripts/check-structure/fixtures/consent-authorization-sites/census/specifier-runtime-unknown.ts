// The specifier is only known at run time, so no static census can name the
// module it acquires. The admitted unknown is the whole census fact here.
export function censusRuntimeUnknownSpecifierProbe(specifier: string) {
  return require(specifier);
}
