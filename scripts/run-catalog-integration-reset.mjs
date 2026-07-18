import { register } from "tsx/esm/api";

const unregister = register();
try {
  await import("./catalog-integration-reset.ts");
} finally {
  unregister();
}
