import { createHash, randomBytes } from "node:crypto";
import { equalSha256HexDigests } from "../../../support/runtime-support/secret-digests";

export type IdentitySecretAdapters = Readonly<{
  issueOpaqueToken: (prefix: string) => string;
  hashSecret: (value: string) => string;
  verifySecret: (value: string, hashedValue: string) => boolean;
  issueChallenge: () => string;
}>;

export function createIdentitySecretAdapters(): IdentitySecretAdapters {
  return {
    issueOpaqueToken: (prefix) => {
      const suffix = randomBytes(18).toString("hex");
      return prefix ? `${prefix}_${suffix}` : suffix;
    },
    hashSecret: (value) => createHash("sha256").update(value).digest("hex"),
    verifySecret: (value, hashedValue) =>
      equalSha256HexDigests(createHash("sha256").update(value).digest("hex"), hashedValue),
    issueChallenge: () => randomBytes(24).toString("base64url"),
  };
}
