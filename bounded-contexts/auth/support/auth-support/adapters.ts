import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Promise wrapper around Node's async `scrypt`. We hand-roll this rather than
 * `promisify` because `promisify` collapses to the no-options overload, dropping
 * the tuned cost parameters. Async keeps the event loop free during sign-in.
 */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

/**
 * Password key-derivation parameters.
 *
 * We use Node's stdlib scrypt (memory- and CPU-hard, no native dependency) so
 * this compiles and runs identically in local, CI, and Docker builds. `N` (cost)
 * must be a power of two; memory usage is roughly `128 * N * r` bytes, so the
 * defaults below cost ~32 MiB per hash. These are the *current* parameters —
 * every stored hash embeds the parameters it was produced with (PHC-style
 * string) so they can be raised over time and older credentials transparently
 * upgrade on their next successful verify.
 */
const PASSWORD_ALGORITHM = "scrypt";
const PASSWORD_SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_BYTES = 16;

/** A bare legacy SHA-256 digest: exactly 64 lowercase hex characters, no `$`. */
const LEGACY_SHA256_HASH = /^[0-9a-f]{64}$/;

/** Node rejects scrypt when `maxmem` is below the working set; give generous headroom. */
function scryptMaxmem(cost: Readonly<{ N: number; r: number; p: number }>): number {
  return 128 * cost.N * cost.r * cost.p * 2 + 1024 * 1024;
}

function formatScryptPhc(cost: Readonly<{ N: number; r: number; p: number }>, salt: Buffer, derived: Buffer): string {
  return `${PASSWORD_ALGORITHM}$N=${cost.N},r=${cost.r},p=${cost.p}$${salt.toString("base64")}$${derived.toString(
    "base64",
  )}`;
}

type ParsedScryptPhc = Readonly<{ N: number; r: number; p: number; salt: Buffer; hash: Buffer }>;

function isScryptPhc(stored: string): boolean {
  return stored.startsWith(`${PASSWORD_ALGORITHM}$`);
}

function parseScryptPhc(stored: string): ParsedScryptPhc | null {
  // base64 never contains `$`, so splitting on `$` is unambiguous.
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_ALGORITHM) {
    return null;
  }

  const cost: Record<string, number> = {};
  for (const pair of parts[1]!.split(",")) {
    const [key, rawValue] = pair.split("=");
    const value = Number(rawValue);
    if (!key || !Number.isInteger(value) || value <= 0) {
      return null;
    }
    cost[key] = value;
  }

  const { N, r, p } = cost;
  if (N === undefined || r === undefined || p === undefined || (N & (N - 1)) !== 0) {
    return null;
  }

  const salt = Buffer.from(parts[2]!, "base64");
  const hash = Buffer.from(parts[3]!, "base64");
  if (salt.length === 0 || hash.length === 0) {
    return null;
  }

  return { N, r, p, salt, hash };
}

async function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: Readonly<{ N: number; r: number; p: number }>,
): Promise<Buffer> {
  return scrypt(password, salt, keyLength, { ...cost, maxmem: scryptMaxmem(cost) });
}

/**
 * Result of {@link AuthSecretAdapters.verifyPassword}. When `valid` is true and
 * `upgradedHash` is present, the stored credential was produced with a weaker
 * algorithm/params (legacy SHA-256, or older scrypt cost) and the caller MUST
 * persist `upgradedHash` so the credential transparently upgrades on sign-in.
 */
export type PasswordVerification = Readonly<{
  valid: boolean;
  upgradedHash?: string;
}>;

export type AuthSecretAdapters = Readonly<{
  issueOpaqueToken: (prefix: string) => string;
  /** Fast unsalted SHA-256. ONLY for high-entropy opaque server tokens — never passwords. */
  hashSecret: (value: string) => string;
  verifySecret: (value: string, hashedValue: string) => boolean;
  /** Salted, memory-hard KDF for user-chosen passwords. Returns a self-describing PHC string. */
  hashPassword: (password: string) => Promise<string>;
  /** Constant-time password verification with transparent rehash-on-login for legacy/weak hashes. */
  verifyPassword: (password: string, storedHash: string) => Promise<PasswordVerification>;
  issueChallenge: () => string;
}>;

export function createAuthSecretAdapters(): AuthSecretAdapters {
  async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const derived = await deriveScrypt(password, salt, PASSWORD_KEY_LENGTH, PASSWORD_SCRYPT_COST);
    return formatScryptPhc(PASSWORD_SCRYPT_COST, salt, derived);
  }

  async function verifyPassword(password: string, storedHash: string): Promise<PasswordVerification> {
    if (isScryptPhc(storedHash)) {
      const parsed = parseScryptPhc(storedHash);
      if (!parsed) {
        return { valid: false };
      }
      const candidate = await deriveScrypt(password, parsed.salt, parsed.hash.length, parsed);
      if (!timingSafeEqual(candidate, parsed.hash)) {
        return { valid: false };
      }
      const stale =
        parsed.N !== PASSWORD_SCRYPT_COST.N ||
        parsed.r !== PASSWORD_SCRYPT_COST.r ||
        parsed.p !== PASSWORD_SCRYPT_COST.p ||
        parsed.hash.length !== PASSWORD_KEY_LENGTH;
      return stale ? { valid: true, upgradedHash: await hashPassword(password) } : { valid: true };
    }

    if (LEGACY_SHA256_HASH.test(storedHash)) {
      const candidate = createHash("sha256").update(password).digest();
      const expected = Buffer.from(storedHash, "hex");
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        return { valid: false };
      }
      return { valid: true, upgradedHash: await hashPassword(password) };
    }

    return { valid: false };
  }

  return {
    issueOpaqueToken: (prefix) => {
      const suffix = randomBytes(18).toString("hex");
      return prefix ? `${prefix}_${suffix}` : suffix;
    },
    hashSecret: (value) => createHash("sha256").update(value).digest("hex"),
    verifySecret: (value, hashedValue) => createHash("sha256").update(value).digest("hex") === hashedValue,
    hashPassword,
    verifyPassword,
    issueChallenge: () => randomBytes(24).toString("base64url"),
  };
}
