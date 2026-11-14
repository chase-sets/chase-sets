import type { webContextRegistry } from "./context-registry";

// The registry keeps literal context and package names. Dropping `as const`
// widens both to string, which turns every expected error below into a failure.
type Entry = (typeof webContextRegistry)[number];
type Expect<TValue extends true> = TValue;
type Admits<TValue, TUnion> = [TValue] extends [TUnion] ? true : false;

export type PublicWebContextRegistryTypeContract = [
  Expect<Admits<"pricing", Entry["contextName"]>>,
  Expect<Admits<"@chase-sets/pricing", Entry["packageName"]>>,
  // @ts-expect-error A context this host does not register is not a member.
  Expect<Admits<"catalog", Entry["contextName"]>>,
  // @ts-expect-error A plain string is not a context-name member.
  Expect<Admits<string, Entry["contextName"]>>,
  // @ts-expect-error A plain string is not a package-name member.
  Expect<Admits<string, Entry["packageName"]>>,
];
