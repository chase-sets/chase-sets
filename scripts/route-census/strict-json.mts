import { fail } from "./errors.mts";

const MAX_JSON_BYTES = 64 * 1024 * 1024;

class StrictJsonParser {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#value();
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) this.#invalid("trailing content");
    return value;
  }

  #value(): unknown {
    this.#skipWhitespace();
    const character = this.#source[this.#index];
    if (character === "{") return this.#object();
    if (character === "[") return this.#array();
    if (character === '"') return this.#string();
    if (character === "-" || (character >= "0" && character <= "9")) return this.#number();
    if (this.#source.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.#source.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.#source.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#invalid("invalid value");
  }

  #object(): Record<string, unknown> {
    this.#index += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (true) {
      this.#skipWhitespace();
      if (this.#source[this.#index] !== '"') this.#invalid("object key must be a string");
      const key = this.#string();
      if (keys.has(key)) this.#invalid(`duplicate object key '${key}'`);
      keys.add(key);
      this.#skipWhitespace();
      if (this.#source[this.#index] !== ":") this.#invalid("missing object colon");
      this.#index += 1;
      result[key] = this.#value();
      this.#skipWhitespace();
      const delimiter = this.#source[this.#index];
      this.#index += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.#invalid("invalid object delimiter");
    }
  }

  #array(): unknown[] {
    this.#index += 1;
    const result: unknown[] = [];
    this.#skipWhitespace();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.#value());
      this.#skipWhitespace();
      const delimiter = this.#source[this.#index];
      this.#index += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.#invalid("invalid array delimiter");
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      if (character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.#source.slice(start, this.#index)) as string;
        } catch {
          return this.#invalid("invalid string escape");
        }
      }
      if (character === "\\") {
        this.#index += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.#invalid("control byte in string");
      this.#index += 1;
    }
    return this.#invalid("unterminated string");
  }

  #number(): number {
    const rest = this.#source.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) return this.#invalid("invalid number");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return this.#invalid("non-finite number");
    return value;
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.#source[this.#index] ?? "")) this.#index += 1;
  }

  #invalid(message: string): never {
    fail("E_ARTIFACT_INVALID", `Artifact JSON is invalid at byte ${this.#index}: ${message}.`);
  }
}

export function parseJsonStrict(source: string): unknown {
  if (Buffer.byteLength(source, "utf8") > MAX_JSON_BYTES) {
    fail("E_ARTIFACT_INVALID", `Artifact JSON exceeds ${MAX_JSON_BYTES} bytes.`);
  }
  return new StrictJsonParser(source).parse();
}
