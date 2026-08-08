// The specifier is only known at run time, so no static census can name the
// module it acquires. Its expression kind is one the committed specifier shape
// disposition does not name, so it routes to the named runtime-unknown default
// arm by construction rather than to an acquisition-and-shape arm, which is
// what separates it from a lexical-constant identifier specifier. The admitted
// unknown is the whole census fact here.
export function censusRuntimeUnknownSpecifierProbe(request: { specifier: string }) {
  return require(request.specifier);
}
