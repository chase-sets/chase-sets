import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

type JsdomError = {
  cause?: unknown;
  message: string;
  type?: string;
};

declare const jsdom: {
  virtualConsole: {
    on(event: "jsdomError", listener: (error: JsdomError) => void): void;
    removeAllListeners(event: "jsdomError"): void;
  };
};

jsdom.virtualConsole.removeAllListeners("jsdomError");
jsdom.virtualConsole.on("jsdomError", (error) => {
  if (error.type === "css-parsing") {
    return;
  }

  if (error.type === "unhandled-exception" && error.cause instanceof Error) {
    console.error(error.cause.stack ?? error.cause.message);
    return;
  }

  console.error(error.message);
});

afterEach(() => {
  cleanup();
});
