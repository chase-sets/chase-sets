import { createHash } from "node:crypto";
import { closed, digest, identity, integer } from "./codecs";
import { channelHealthSources, ChannelHealthError, type ChannelHealthSource } from "./contracts";

export function healthDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function deriveChannelHealthSourceWorkId(
  input: Readonly<{
    sourceKind: ChannelHealthSource;
    connectionId: string;
    authorityIdentity: string;
    operationMode: string;
    setupGeneration: number;
    scheduleGeneration: number;
    policyRevision: string;
  }>,
): string {
  const r = closed(input, [
    "sourceKind",
    "connectionId",
    "authorityIdentity",
    "operationMode",
    "setupGeneration",
    "scheduleGeneration",
    "policyRevision",
  ]);
  if (!channelHealthSources.includes(input.sourceKind)) throw new ChannelHealthError("invalid-health-contract");
  return healthDigest([
    r.sourceKind,
    identity(r.connectionId),
    digest(r.authorityIdentity),
    identity(r.operationMode),
    integer(r.setupGeneration),
    integer(r.scheduleGeneration),
    digest(r.policyRevision),
  ]);
}
