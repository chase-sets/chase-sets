// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ListingCommandForm } from "./listing-command-form";

afterEach(cleanup);

it("keeps one mounted attempt across rerenders and rotates it only when the request changes", () => {
  const onChange = vi.fn();
  const content = (
    <ListingCommandForm onChange={onChange}>
      <input name="priceAmount" defaultValue="10.00" />
    </ListingCommandForm>
  );
  const view = render(content);
  const form = view.container.querySelector("form")!;
  const key = () => new FormData(form).get("idempotencyKey");
  const first = key();
  expect(String(first).length).toBeGreaterThan(15);
  view.rerender(content);
  expect(key()).toBe(first);
  fireEvent.change(form.querySelector('input[name="priceAmount"]')!, { target: { value: "11.00" } });
  expect(onChange).toHaveBeenCalledOnce();
  expect(key()).not.toBe(first);
  const changed = key();
  view.rerender(content);
  expect(key()).toBe(changed);
});
