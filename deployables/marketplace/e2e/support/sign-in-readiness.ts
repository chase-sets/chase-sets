export function hasIdentifierSubmitHandler(element: object): boolean {
  return Object.entries(element).some(
    ([key, props]) =>
      key.startsWith("__reactProps$") &&
      typeof props === "object" &&
      props !== null &&
      "onSubmit" in props &&
      typeof props.onSubmit === "function",
  );
}
