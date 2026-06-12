import react from "@vitejs/plugin-react";
import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";

export default defineBoundedContextTestConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
  },
});
