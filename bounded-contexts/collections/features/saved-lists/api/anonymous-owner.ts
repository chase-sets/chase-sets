import { createHash } from "node:crypto";
import { savedListLimits, type SavedListProductSelection } from "../domain/contracts";

type ProductTuple = readonly [string, string, readonly (readonly [string, string])[]];

export function savedListCanonicalIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)
  ) {
    throw new Error("Invalid Saved List canonical identifier.");
  }
  return value;
}

export function savedListCanonicalTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Saved List canonical title.");
  const title = savedListCanonicalIdentifier(value.trim());
  if (title.length > savedListLimits.maximumTitleLength) throw new Error("Invalid Saved List canonical title.");
  return title;
}

function array(value: unknown, length?: number): unknown[] {
  if (
    !Array.isArray(value) ||
    (length !== undefined && value.length !== length) ||
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.keys(value).some((key, index) => key !== String(index)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error("Invalid Saved List canonical tuple.");
  }
  return value;
}

function canonicalProduct(value: unknown): ProductTuple {
  const [item, product, optionsValue] = array(value, 3);
  const options = array(optionsValue);
  if (options.length > 64) throw new Error("Invalid Saved List canonical Options.");
  const dimensions = new Set<string>();
  const pairs = options
    .map((option): readonly [string, string] => {
      const [dimensionValue, optionValue] = array(option, 2);
      const dimension = savedListCanonicalIdentifier(dimensionValue);
      if (dimensions.has(dimension)) throw new Error("Duplicate Saved List canonical dimension.");
      dimensions.add(dimension);
      return [dimension, savedListCanonicalIdentifier(optionValue)];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return [savedListCanonicalIdentifier(item), savedListCanonicalIdentifier(product), pairs];
}

export function savedListCanonicalProduct(product: SavedListProductSelection): ProductTuple {
  if (
    !product ||
    Reflect.ownKeys(product).some(
      (key) => typeof key !== "string" || !["catalogItemId", "productId", "selectedOptions"].includes(key),
    )
  ) {
    throw new Error("Invalid Saved List canonical Product.");
  }
  if (!Array.isArray(product.selectedOptions)) throw new Error("Invalid Saved List canonical Options.");
  const options = product.selectedOptions.map((option) => {
    if (
      !option ||
      Reflect.ownKeys(option).some((key) => typeof key !== "string" || !["dimensionId", "optionId"].includes(key))
    )
      throw new Error("Invalid Saved List canonical Option.");
    return [option.dimensionId, option.optionId];
  });
  return canonicalProduct([product.catalogItemId, product.productId, options]);
}

function destination(value: unknown): readonly unknown[] {
  const parts = array(value);
  if (parts[0] === "existing") {
    array(parts, 2);
    return ["existing", savedListCanonicalIdentifier(parts[1])];
  }
  if (parts[0] === "new") {
    array(parts, 4);
    return [
      "new",
      savedListCanonicalIdentifier(parts[1]),
      savedListCanonicalIdentifier(parts[2]),
      savedListCanonicalTitle(parts[3]),
    ];
  }
  throw new Error("Invalid Saved List canonical destination.");
}

function surface(value: unknown) {
  if (value !== "search" && value !== "item-detail") throw new Error("Invalid Saved List canonical surface.");
  return value;
}

function quantity(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > savedListLimits.maximumTrackedQuantity
  )
    throw new Error("Invalid Saved List canonical quantity.");
  return value;
}

export function savedListCanonicalPreimage(value: unknown): string {
  const parts = array(value);
  let tuple: readonly unknown[];
  switch (parts[0]) {
    case "collections.anonymous-owner.v1":
      array(parts, 2);
      tuple = [parts[0], savedListCanonicalIdentifier(parts[1])];
      break;
    case "collections.anonymous-intent.v1":
      array(parts, 7);
      tuple = [
        parts[0],
        savedListCanonicalIdentifier(parts[1]),
        savedListCanonicalIdentifier(parts[2]),
        canonicalProduct(parts[3]),
        surface(parts[4]),
        savedListCanonicalIdentifier(parts[5]),
        savedListCanonicalIdentifier(parts[6]),
      ];
      break;
    case "collections.claim.v1":
      array(parts, 7);
      tuple = [
        parts[0],
        savedListCanonicalIdentifier(parts[1]),
        savedListCanonicalIdentifier(parts[2]),
        destination(parts[3]),
        canonicalProduct(parts[4]),
        quantity(parts[5]),
        surface(parts[6]),
      ];
      break;
    case "collections.addition.v1":
      array(parts, 9);
      tuple = [
        parts[0],
        savedListCanonicalIdentifier(parts[1]),
        savedListCanonicalIdentifier(parts[2]),
        destination(parts[3]),
        canonicalProduct(parts[4]),
        quantity(parts[5]),
        surface(parts[6]),
        savedListCanonicalIdentifier(parts[7]),
        savedListCanonicalIdentifier(parts[8]),
      ];
      break;
    default:
      throw new Error("Invalid Saved List canonical protocol.");
  }
  return JSON.stringify(tuple);
}

export function savedListFingerprint(tuple: unknown): string {
  return `sha256:v1:${createHash("sha256").update(savedListCanonicalPreimage(tuple), "utf8").digest("hex")}`;
}
