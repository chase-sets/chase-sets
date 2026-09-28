export type TcgplayerMarketRequestOptions = Readonly<{
  signal?: AbortSignal;
  onStage?: (fact: TcgplayerMarketStageFact) => void;
}>;

export type TcgplayerMarketStage =
  | "config-wait"
  | "limiter-wait"
  | "throttle-wait"
  | "request-construction"
  | "fetch-start"
  | "headers-received"
  | "error-body-read-start"
  | "error-body-read-end"
  | "parse-start"
  | "parse-end"
  | "parse-failure"
  | "retry-start"
  | "retry-end"
  | "retry-backoff-start"
  | "retry-backoff-end"
  | "cooldown-start"
  | "cooldown-end"
  | "abort"
  | "terminal";

export type TcgplayerMarketStageFact = Readonly<{
  stage: TcgplayerMarketStage;
  at: string;
  attempt: number;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx" | "other";
  activeStage?: TcgplayerMarketStage;
  outcome?: "success" | "failure" | "aborted";
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
 * clients. The separate generic provider-observation port family remains
 * outside this bounded slice.
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
