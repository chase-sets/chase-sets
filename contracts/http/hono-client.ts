export type HonoClientEndpointInput = Readonly<{
  param?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  json?: unknown;
  header?: HeadersInit;
}>;

export type HonoClientEndpoint = (
  input?: HonoClientEndpointInput,
) => Promise<Response>;

type HonoClientRouteMethods = Readonly<{
  $delete: HonoClientEndpoint;
  $get: HonoClientEndpoint;
  $patch: HonoClientEndpoint;
  $post: HonoClientEndpoint;
  $put: HonoClientEndpoint;
}>;

export type HonoClientResource = HonoClientRouteMethods & Readonly<{
  [PathSegment in string as PathSegment extends `$${string}`
    ? never
    : PathSegment]: HonoClientResource;
}>;
