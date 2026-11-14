import { closed, isEnvironment, safeInteger, type OperatorEnvironment } from "../protocol";
import {
  parseTcgplayerSetNameObservationPost,
  tcgplayerSetNameObservationLimits,
  type TcgplayerSetNameObservationPost,
} from "./contract";

export type SetNamesPostMessage = {
  action: "post-set-names";
  environment: OperatorEnvironment;
  post: TcgplayerSetNameObservationPost;
};
export type SetNamesPostResult =
  | { outcome: "recorded"; observationCount: number; newObservationCount: number; mappingsProposed: number }
  | { outcome: "grant-invalid" | "unavailable" | "refused" | "invalid-response" };
export type SetNamesPost = (
  environment: OperatorEnvironment,
  post: TcgplayerSetNameObservationPost,
) => Promise<SetNamesPostResult>;

export function isSetNamesPostMessage(value: unknown): value is SetNamesPostMessage {
  return (
    closed(value, ["action", "environment", "post"]) &&
    value.action === "post-set-names" &&
    isEnvironment(value.environment) &&
    parseTcgplayerSetNameObservationPost(value.post).ok &&
    new TextEncoder().encode(JSON.stringify(value.post)).byteLength <= tcgplayerSetNameObservationLimits.maxPostBytes
  );
}

export function isSetNamesPostResult(value: unknown): value is SetNamesPostResult {
  if (closed(value, ["outcome"]))
    return (
      typeof value.outcome === "string" &&
      ["grant-invalid", "unavailable", "refused", "invalid-response"].includes(value.outcome)
    );
  return (
    closed(value, ["outcome", "observationCount", "newObservationCount", "mappingsProposed"]) &&
    value.outcome === "recorded" &&
    safeInteger(value.observationCount) &&
    safeInteger(value.newObservationCount) &&
    safeInteger(value.mappingsProposed)
  );
}
