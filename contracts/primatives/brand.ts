declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };
