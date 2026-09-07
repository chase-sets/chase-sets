export type TcgplayerMarketRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type TcgplayerMarketGet = <TResponse>(
  path: string,
  params?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  options?: TcgplayerMarketRequestOptions,
) => Promise<TResponse>;

export type TcgplayerMarketPost = <TResponse>(
  path: string,
  data?: unknown,
  options?: TcgplayerMarketRequestOptions,
) => Promise<TResponse>;

/**
 * Pricing's concrete transport seam over the already-mounted automation
 * clients. It intentionally does not generalize provider observations; #4311
 * owns that future port family.
 */
export type TcgplayerMarketTransport = Readonly<{
  mpGateway: Readonly<{ post: TcgplayerMarketPost }>;
  mpApi: Readonly<{ post: TcgplayerMarketPost }>;
  mpSearchApi: Readonly<{ post: TcgplayerMarketPost }>;
  infiniteApi: Readonly<{ get: TcgplayerMarketGet }>;
}>;

export type TcgplayerMarketTransportCapability = TcgplayerMarketTransport | Readonly<{ kind: "not-mounted" }>;

export function isTcgplayerMarketTransport(
  capability: TcgplayerMarketTransportCapability,
): capability is TcgplayerMarketTransport {
  return !("kind" in capability);
}
