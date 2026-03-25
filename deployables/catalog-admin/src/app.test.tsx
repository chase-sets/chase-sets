import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./app";

describe("catalog admin deployable", () => {
  it("mounts the bounded-context catalog admin shell", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0, count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<App />);

    expect(await screen.findByText("Catalog Admin")).toBeTruthy();
  });
});
