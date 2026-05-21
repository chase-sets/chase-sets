import { createHash, randomBytes } from "node:crypto";

export type AuthSecretAdapters = Readonly<{
  issueOpaqueToken: (prefix: string) => string;
  hashSecret: (value: string) => string;
  verifySecret: (value: string, hashedValue: string) => boolean;
  issueChallenge: () => string;
}>;

export function createAuthSecretAdapters(): AuthSecretAdapters {
  return {
    issueOpaqueToken: (prefix) => {
      const suffix = randomBytes(18).toString("hex");
      return prefix ? `${prefix}_${suffix}` : suffix;
    },
    hashSecret: (value) => createHash("sha256").update(value).digest("hex"),
    verifySecret: (value, hashedValue) => createHash("sha256").update(value).digest("hex") === hashedValue,
    issueChallenge: () => randomBytes(24).toString("base64url"),
  };
}
