import { readFileSync } from "node:fs";
import { fireEvent, isInaccessible, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, Profiler, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RouterForm } from "../components/forms/router-form";
import { FormProvider } from "../components/forms/form";
import {
  Autocomplete,
  Button,
  Checkbox,
  CheckboxGroup,
  Combobox,
  CurrencyInput,
  DateInput,
  DatePicker,
  Field,
  FileDropzone,
  Form,
  NativeSelect,
  NumberField,
  PasswordInput,
  QuantityStepper,
  RadioGroup,
  Select,
  SearchInput,
  Slider,
  Switch,
  TagInput,
  TextInput,
  Textarea,
  ValidationSummary,
  normalizeFormErrors,
  useFormContext,
  useFormState,
} from "../index";

type DeferredValidation = {
  values: { code: string };
  resolve: (value: { code?: string } | null) => void;
};

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function FormContextProbe() {
  const form = useFormContext();

  return (
    <output
      data-disabled={String(form.disabled)}
      data-form-id={form.formId}
      data-status={form.status}
      data-submitting={String(form.submitting)}
      data-summary={form.validationSummaryId}
    >
      {form.status}
    </output>
  );
}

function ControlledFormHarness() {
  const form = useFormState(
    {
      email: "",
      name: "Alex",
    },
    {
      validate: (values) => ({
        email: values.email.includes("@") ? undefined : "Enter a valid email.",
        _form: values.name.trim() ? undefined : "Add a contact name.",
      }),
    },
  );

  return (
    <Form
      id="controlled-form"
      onSubmit={(event) => {
        event.preventDefault();
        form.submitAttempted();
      }}
    >
      <TextInput id="controlled-email" label="Email" description="Used for receipts." {...form.fieldProps("email")} />
      <TextInput label="Name" {...form.fieldProps("name")} />
      <output data-dirty={String(form.dirty)} data-submit-count={form.submitCount} data-valid={String(form.valid)}>
        {form.fieldMeta.email.touched ? "touched" : "untouched"}
      </output>
      <Button type="submit">Submit</Button>
      <Button type="button" onClick={() => form.reset()}>
        Reset
      </Button>
    </Form>
  );
}

function AsyncValidationHarness({
  validate,
}: {
  validate: (values: { code: string }) => Promise<{ code?: string } | null>;
}) {
  const form = useFormState(
    {
      code: "old",
    },
    { validate },
  );

  return (
    <Form id="async-form">
      <TextInput label="Code" {...form.fieldProps("code")} />
      <output data-validating={String(form.validating)} data-valid={String(form.valid)}>
        {form.fieldMeta.code.error ?? form.errors.formErrors[0] ?? "ready"}
      </output>
      <Button type="button" onClick={() => void form.validateAsync()}>
        Validate
      </Button>
    </Form>
  );
}

describe("form system", () => {
  it("announcement policy defaults preserve standalone, explicit inline and independent provider alerts", () => {
    const { container } = render(
      <>
        <TextInput label="Standalone" error="Standalone error" />
        <Form>
          <TextInput label="Default" error="Default error" />
        </Form>
        <Form errorAnnouncement="inline">
          <TextInput label="Inline" error="Inline error" />
        </Form>
        <FormProvider errorAnnouncement="summary">
          <TextInput label="Owned" error="Owned error" />
          <FormProvider>
            <TextInput label="Independent" error="Independent error" />
          </FormProvider>
          <Form>
            <TextInput label="New form" error="New form error" />
          </Form>
        </FormProvider>
      </>,
    );
    expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
      "Standalone error",
      "Default error",
      "Inline error",
      "Independent error",
      "New form error",
    ]);
    expect(screen.getByText("Owned error").getAttribute("role")).toBeNull();
    expect(container.querySelector("[errorAnnouncement]")).toBeNull();
  });

  it("announcement scope preserves a trailing standalone alert after a summary-owned form", () => {
    render(
      <>
        <Form errorAnnouncement="summary">
          <TextInput label="Trailing owned" error="Trailing owned error" />
        </Form>
        <TextInput label="Trailing standalone" error="Trailing standalone error" />
      </>,
    );
    expect(screen.getByText("Trailing owned error").getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual(["Trailing standalone error"]);
  });

  it("summary owns inline error announcements without changing canonical error styling", () => {
    render(
      <>
        <Form>
          <TextInput label="Default styled" error="Default styled error" />
        </Form>
        <Form errorAnnouncement="summary">
          <TextInput label="Owned styled" error="Owned styled error" />
        </Form>
      </>,
    );
    expect(screen.getByText("Owned styled error").className).toBe(screen.getByText("Default styled error").className);
  });

  it.each([undefined, "inline", "summary"] as const)(
    "announcement policy defaults reach RouterForm (%s) without DOM leakage",
    (policy) => {
      const router = createMemoryRouter([
        {
          path: "/",
          element: (
            <FormProvider errorAnnouncement="summary">
              <RouterForm errorAnnouncement={policy}>
                <TextInput label="Routed" error="Routed error" />
              </RouterForm>
            </FormProvider>
          ),
        },
      ]);
      const { container } = render(<RouterProvider router={router} />);
      expect(screen.getByText("Routed error").getAttribute("role")).toBe(policy === "summary" ? null : "alert");
      expect(container.querySelector("form")?.hasAttribute("errorAnnouncement")).toBe(false);
      router.dispose();
    },
  );

  it("summary owns inline error announcements with visible descriptions and natural pointer/Enter focus", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLElement>();
    const { container } = render(
      <Form errorAnnouncement="summary" validationSummaryId="owned-errors">
        <ValidationSummary
          ref={ref}
          id="owned-errors"
          errors={[
            { fieldId: "owned-email", message: "Fix email." },
            { fieldId: "owned-password", message: "Fix password." },
            { fieldId: "owned-condition", message: "Fix condition." },
          ]}
        />
        <TextInput id="owned-email" label="Email" description="Email help" error="Fix email." />
        <PasswordInput id="owned-password" label="Password" description="Password help" error="Fix password." />
        <NativeSelect
          id="owned-condition"
          label="Condition"
          description="Condition help"
          error="Fix condition."
          items={[{ value: "new", label: "New" }]}
        />
      </Form>,
    );
    expect(screen.getAllByRole("alert")).toEqual([ref.current]);
    expect(container.querySelectorAll('[role="alert"], [role="status"], [aria-live]')).toHaveLength(1);
    expect(ref.current?.getAttribute("aria-live")).toBe("assertive");
    expect(document.activeElement).not.toBe(ref.current);
    for (const label of ["Email", "Password", "Condition"]) {
      const control = screen.getByLabelText(label, { exact: true });
      const error = document.getElementById(`${control.id}-error`)!;
      expect(isInaccessible(error)).toBe(false);
      expect(error.getAttribute("role")).toBeNull();
      expect(error.getAttribute("aria-live")).toBeNull();
      expect(control.getAttribute("aria-invalid")).toBe("true");
      expect(control.getAttribute("aria-describedby")).toBe(`${control.id}-description ${control.id}-error`);
      const link = screen.getByRole("link", { name: `Fix ${label.toLowerCase()}.` });
      expect(link.getAttribute("href")).toBe(`#${control.id}`);
      await user.click(link);
      expect(document.activeElement).toBe(control);
      link.focus();
      await user.keyboard("{Enter}");
      expect(document.activeElement).toBe(control);
    }
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it("announcement scope and lifecycle preserve sibling, ID-only, nested and portal ownership without render focus", () => {
    const portal = document.createElement("div");
    document.body.append(portal);
    const ref = createRef<HTMLElement>();
    const view = (message?: string, status: "idle" | "error" | "success" = "idle") => (
      <>
        <Button>Keep editing</Button>
        <Form errorAnnouncement={message ? "summary" : "inline"} status={status}>
          <ValidationSummary ref={ref} errors={message ? [{ message }] : []} />
          <TextInput id="lifecycle" label="Lifecycle" error={message} />
          {createPortal(<TextInput id="portal" label="Portal" error={message} />, portal)}
          <FormProvider>
            <TextInput label="Nested" error="Nested error" />
          </FormProvider>
        </Form>
        <Form status="error">
          <TextInput label="Sibling" error="Sibling error" />
        </Form>
        <Form validationSummaryId="static-help">
          <TextInput label="ID only" error="ID-only error" />
          <p id="static-help">Help</p>
        </Form>
        <Form>
          <ValidationSummary errors={[{ message: "Default summary" }]} />
          <TextInput label="Unadopted" error="Unadopted error" />
        </Form>
      </>
    );
    const { rerender, unmount } = render(view());
    try {
      const keepEditing = screen.getByRole("button", { name: "Keep editing" });
      keepEditing.focus();
      expect(ref.current).toBeNull();
      for (const message of ["First failure", "Replacement failure"]) {
        rerender(view(message, "error"));
        expect(document.activeElement).toBe(keepEditing);
        expect(ref.current).toBe(screen.getAllByRole("alert")[0]);
        for (const id of ["lifecycle", "portal"]) {
          const error = document.getElementById(`${id}-error`)!;
          expect(error.textContent).toBe(message);
          expect(isInaccessible(error)).toBe(false);
          expect(error.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull();
        }
        expect(within(portal).queryByRole("alert")).toBeNull();
        expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
          expect.stringContaining(message),
          "Nested error",
          "Sibling error",
          "ID-only error",
          expect.stringContaining("Default summary"),
          "Unadopted error",
        ]);
      }
      expect(screen.queryByText("First failure")).toBeNull();
      for (const status of ["idle", "success"] as const) {
        rerender(view(undefined, status));
        expect(ref.current).toBeNull();
        expect(screen.queryByText("Replacement failure")).toBeNull();
        for (const id of ["lifecycle", "portal"]) {
          expect(document.getElementById(`${id}-error`)).toBeNull();
          expect(document.getElementById(id)?.getAttribute("aria-invalid")).toBeNull();
          expect(document.getElementById(id)?.getAttribute("aria-describedby")).toBeNull();
        }
        expect(document.activeElement).toBe(keepEditing);
      }
    } finally {
      unmount();
      portal.remove();
    }
  });

  describe.each([undefined, "summary"] as const)("field chrome announcement matrix (%s)", (policy) => {
    const props = { id: "matrix", label: "Matrix", description: "Help", error: "Actual error" };
    const items = [{ value: "one", label: "One" }];
    it.each([
      ["Autocomplete", <Autocomplete {...props} items={items} />],
      ["Checkbox", <Checkbox {...props} />],
      ["CheckboxGroup", <CheckboxGroup {...props} items={items} values={[]} />],
      ["Combobox", <Combobox {...props} items={items} />],
      ["DateInput", <DateInput {...props} />],
      ["DatePicker", <DatePicker {...props} />],
      [
        "Field",
        <Field {...props} id={undefined} htmlFor="matrix">
          {/* Field owns the frame anatomy; its caller owns the control's ARIA wiring. */}
          <input id="matrix" aria-invalid="true" aria-describedby="matrix-description matrix-error" />
        </Field>,
      ],
      ["FileDropzone", <FileDropzone {...props} />],
      ["NumberField", <NumberField {...props} />],
      ["CurrencyInput", <CurrencyInput {...props} currencyCode="USD" />],
      ["PasswordInput", <PasswordInput {...props} />],
      ["QuantityStepper", <QuantityStepper {...props} />],
      ["RadioGroup", <RadioGroup {...props} items={items} />],
      ["NativeSelect", <NativeSelect {...props} items={items} />],
      ["Select", <Select {...props} items={items} />],
      ["Slider", <Slider {...props} />],
      ["Switch", <Switch {...props} />],
      ["TagInput", <TagInput {...props} values={[]} />],
      ["TextInput", <TextInput {...props} />],
      ["SearchInput", <SearchInput {...props} />],
      ["Textarea", <Textarea {...props} />],
    ])("%s preserves error anatomy", (name, control) => {
      render(<Form errorAnnouncement={policy}>{control}</Form>);
      const error = screen.getByText("Actual error");
      expect(isInaccessible(error)).toBe(false);
      expect(error.id).toBe("matrix-error");
      expect(error.getAttribute("role")).toBe(policy === "summary" ? null : "alert");
      expect(error.getAttribute("aria-live")).toBeNull();
      const target = name === "RadioGroup" ? screen.getByRole("radiogroup") : document.getElementById("matrix");
      expect(target?.getAttribute("aria-invalid")).toBe("true");
      expect(target?.getAttribute("aria-describedby")).toBe("matrix-description matrix-error");
      expect(document.getElementById("matrix-description")?.textContent).toContain("Help");
    });
  });

  it("canonical announcement documentation opts in only with populated summary errors", () => {
    const readme = readFileSync(`${__dirname}/../../README.md`, "utf8");
    const contact = readme.slice(
      readme.indexOf("export function ContactForm()"),
      readme.indexOf("Field controls should"),
    );
    expect(contact).toContain('errorAnnouncement={errors.length > 0 ? "summary" : "inline"}');
    expect(contact).toContain('validationSummaryId={errors.length > 0 ? "contact-errors" : undefined}');
    expect(contact).toContain('<ValidationSummary id="contact-errors" errors={errors} />');
    expect(readme).toContain('`errorAnnouncement="inline"` (the default)');
    expect(readme).toContain("not inferred from `validationSummaryId`");
  });

  it("renders a native form with route-compatible submission attributes", () => {
    const handleSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });

    const { container } = render(
      <Form
        id="listing-form"
        action="/account/listings"
        method="post"
        encType="multipart/form-data"
        target="_blank"
        onSubmit={handleSubmit}
      >
        <TextInput label="Listing name" name="listing_name" defaultValue="Charizard" />
        <input type="hidden" name="intent" value="publish" />
        <Button type="submit">Publish</Button>
      </Form>,
    );

    const form = container.querySelector("form");

    expect(form).not.toBeNull();
    expect(form?.getAttribute("id")).toBe("listing-form");
    expect(form?.getAttribute("action")).toBe("/account/listings");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form?.getAttribute("target")).toBe("_blank");

    if (!form) {
      throw new Error("Expected form to render.");
    }

    const formData = new FormData(form);
    expect(formData.get("listing_name")).toBe("Charizard");
    expect(formData.get("intent")).toBe("publish");

    fireEvent.submit(form);
    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it("supports external submit controls through stable form ids", () => {
    const { container } = render(
      <>
        <Form id="checkout-confirmation-form" method="post">
          <input type="hidden" name="intent" value="confirm" />
        </Form>
        <Button type="submit" form="checkout-confirmation-form">
          Confirm order
        </Button>
      </>,
    );

    const form = container.querySelector("form");
    const externalSubmit = screen.getByRole("button", { name: "Confirm order" });

    expect(externalSubmit.getAttribute("form")).toBe("checkout-confirmation-form");
    expect((externalSubmit as HTMLButtonElement).form).toBe(form);
  });

  it("serializes custom select values through native FormData", () => {
    const { container } = render(
      <Form id="listing-settings-form">
        <Select
          id="listing-condition"
          name="condition"
          label="Condition"
          defaultValue="near_mint"
          items={[
            { value: "near_mint", label: "Near Mint" },
            { value: "played", label: "Played" },
          ]}
        />
        <Select
          name="disabled_condition"
          label="Disabled condition"
          defaultValue="played"
          disabled
          items={[{ value: "played", label: "Played" }]}
        />
      </Form>,
    );

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Expected form to render.");
    }

    const formData = new FormData(form);
    expect(formData.get("condition")).toBe("near_mint");
    expect(formData.get("disabled_condition")).toBeNull();
  });

  it("passes native form names through group and boolean controls", () => {
    const { container } = render(
      <Form id="preferences-form">
        <RadioGroup
          name="shipping_speed"
          label="Shipping speed"
          defaultValue="standard"
          items={[
            { value: "standard", label: "Standard" },
            { value: "express", label: "Express" },
          ]}
        />
        <Switch name="email_updates" label="Email updates" defaultChecked value="enabled" />
        <Slider name="max_price" label="Maximum price" defaultValue={42} min={0} max={100} />
        <CheckboxGroup
          id="listing-tags"
          name="tags"
          label="Listing tags"
          values={["sealed", "popular"]}
          items={[
            { value: "sealed", label: "Sealed" },
            { value: "popular", label: "Popular" },
            { value: "graded", label: "Graded" },
          ]}
        />
        <CheckboxGroup
          name="disabled_tags"
          label="Disabled tags"
          values={["draft"]}
          disabled
          items={[{ value: "draft", label: "Draft" }]}
        />
        <Checkbox name="readonly_opt_in" label="Read-only opt in" value="yes" readOnly />
      </Form>,
    );

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Expected form to render.");
    }

    const formData = new FormData(form);
    expect(formData.get("shipping_speed")).toBe("standard");
    expect(formData.get("email_updates")).toBe("enabled");
    expect(formData.get("max_price")).toBe("42");
    expect(formData.getAll("tags")).toEqual(["sealed", "popular"]);
    expect(formData.get("disabled_tags")).toBeNull();
    expect(formData.get("readonly_opt_in")).toBeNull();
    expect(screen.getByRole("group", { name: "Listing tags" }).getAttribute("aria-invalid")).toBeNull();

    fireEvent.click(screen.getByLabelText("Read-only opt in"));
    expect(new FormData(form).get("readonly_opt_in")).toBeNull();
  });

  it("exposes radio options by their visible labels", () => {
    render(
      <RadioGroup
        id="shipping-options"
        name="shipping_speed"
        label="Shipping speed"
        description="Choose the buyer-facing delivery promise."
        defaultValue="standard"
        items={[
          { value: "standard", label: "Standard", description: "3-5 business days." },
          { value: "express", label: "Express", description: "1-2 business days." },
        ]}
      />,
    );

    const standard = screen.getByRole("radio", { name: "Standard" });
    const express = screen.getByRole("radio", { name: "Express" });

    expect(standard.getAttribute("aria-describedby")).toBe("shipping-options-option-0-description");
    expect(express.getAttribute("aria-describedby")).toBe("shipping-options-option-1-description");
    expect(screen.getByText("3-5 business days.").getAttribute("id")).toBe("shipping-options-option-0-description");
    expect(screen.getByText("1-2 business days.").getAttribute("id")).toBe("shipping-options-option-1-description");
  });

  it("serializes composite field values through native FormData", () => {
    const { container } = render(
      <Form id="advanced-listing-form">
        <Autocomplete
          name="expansion"
          label="Expansion"
          defaultValue="sv1"
          items={[{ value: "sv1", label: "Scarlet & Violet" }]}
        />
        <Combobox name="language" label="Language" defaultValue="en" items={[{ value: "en", label: "English" }]} />
        <NumberField name="quantity" label="Quantity" defaultValue={3} />
        <TagInput name="tags" label="Tags" values={["sealed", "popular"]} />
      </Form>,
    );

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Expected form to render.");
    }

    const formData = new FormData(form);
    expect(formData.get("expansion")).toBe("sv1");
    expect(formData.get("language")).toBe("en");
    expect(formData.get("quantity")).toBe("3");
    expect(formData.getAll("tags")).toEqual(["sealed", "popular"]);
  });

  it("serializes controlled composite field values through native FormData", () => {
    const { container } = render(
      <Form id="controlled-composite-form">
        <Select
          name="condition"
          label="Condition"
          value="near_mint"
          onValueChange={() => {}}
          items={[
            { value: "near_mint", label: "Near Mint" },
            { value: "played", label: "Played" },
          ]}
        />
        <Autocomplete
          name="expansion"
          label="Expansion"
          value="Scarlet & Violet"
          onValueChange={() => {}}
          items={[{ value: "sv1", label: "Scarlet & Violet" }]}
        />
        <Combobox
          name="language"
          label="Language"
          value="en"
          onValueChange={() => {}}
          items={[{ value: "en", label: "English" }]}
        />
      </Form>,
    );

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Expected form to render.");
    }

    const formData = new FormData(form);
    expect(formData.get("condition")).toBe("near_mint");
    expect(formData.get("expansion")).toBe("Scarlet & Violet");
    expect(formData.get("language")).toBe("en");
  });

  it("keeps controlled custom selects caller-owned until the caller updates value", async () => {
    const user = userEvent.setup();
    const onSelectChange = vi.fn();
    const onComboboxChange = vi.fn();

    const { container } = render(
      <Form id="controlled-selects-form">
        <Select
          name="condition"
          label="Condition"
          value="played"
          onValueChange={onSelectChange}
          items={[
            { value: "near_mint", label: "Near Mint" },
            { value: "played", label: "Played" },
          ]}
        />
        <Combobox
          name="language"
          label="Language"
          value="en"
          onValueChange={onComboboxChange}
          items={[
            { value: "en", label: "English" },
            { value: "jp", label: "Japanese" },
          ]}
        />
      </Form>,
    );

    await user.click(screen.getByRole("combobox", { name: "Condition" }));
    await user.click(await screen.findByRole("option", { name: "Near Mint" }));
    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "Japanese" }));

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Expected form to render.");
    }

    const formData = new FormData(form);
    expect(onSelectChange).toHaveBeenCalledWith("near_mint");
    expect(onComboboxChange).toHaveBeenCalledWith("jp");
    expect(formData.get("condition")).toBe("played");
    expect(formData.get("language")).toBe("en");
  });

  it("supports caller-owned asynchronous Combobox input without filtering server matches", async () => {
    const user = userEvent.setup();
    const onInputValueChange = vi.fn();

    render(
      <Combobox
        label="Search marketplace"
        hideLabel
        items={[{ value: "charizard", label: "Charizard ex", description: "Pokemon TCG" }]}
        inputValue="dra"
        onInputValueChange={onInputValueChange}
        filterItems={false}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Search marketplace" });
    await user.click(screen.getByRole("button", { name: "Search marketplace" }));

    expect(await screen.findByRole("option", { name: /Charizard ex/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: "drac" } });

    expect(onInputValueChange).toHaveBeenCalledWith("drac");
  });

  it("updates controlled custom selects when caller state changes", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [condition, setCondition] = useState("played");

      return (
        <Form id="controlled-select-update-form">
          <Select
            name="condition"
            label="Condition"
            value={condition}
            onValueChange={setCondition}
            items={[
              { value: "near_mint", label: "Near Mint" },
              { value: "played", label: "Played" },
            ]}
          />
        </Form>
      );
    }

    const { container } = render(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "Condition" }));
    await user.click(await screen.findByRole("option", { name: "Near Mint" }));

    const form = container.querySelector("form");
    if (!form) {
      throw new Error("Expected form to render.");
    }

    expect(new FormData(form).get("condition")).toBe("near_mint");
  });

  it("propagates disabled and submitting state through form context and a disabled fieldset", () => {
    const { container } = render(
      <Form id="payment-form" disabled submitting validationSummaryId="payment-errors">
        <TextInput label="Cardholder" name="cardholder" defaultValue="Alex" />
        <FormContextProbe />
      </Form>,
    );

    const form = container.querySelector("form");
    const fieldset = container.querySelector("fieldset");
    const input = screen.getByLabelText("Cardholder");
    const probe = screen.getByText("submitting");

    expect(form?.getAttribute("aria-busy")).toBe("true");
    expect(form?.getAttribute("aria-disabled")).toBe("true");
    expect(form?.getAttribute("aria-describedby")).toBe("payment-errors");
    expect(form?.getAttribute("data-form-status")).toBe("submitting");
    expect(fieldset?.hasAttribute("disabled")).toBe(true);
    expect(fieldset?.className).toContain("contents");
    expect(input.closest("fieldset")).toBe(fieldset);
    expect(probe.getAttribute("data-disabled")).toBe("true");
    expect(probe.getAttribute("data-form-id")).toBe("payment-form");
    expect(probe.getAttribute("data-status")).toBe("submitting");
    expect(probe.getAttribute("data-submitting")).toBe("true");
    expect(probe.getAttribute("data-summary")).toBe("payment-errors");
  });

  it("exposes a React Router adapter without importing router Form through the core entrypoint", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <RouterForm id="router-listing-form" method="post" action="/listings" validationSummaryId="router-errors">
            <TextInput label="Listing name" name="listing_name" defaultValue="Blastoise" />
            <Button type="submit">Save</Button>
            <FormContextProbe />
          </RouterForm>
        ),
      },
      {
        path: "/listings",
        action: () => null,
        element: <div>Saved</div>,
      },
    ]);

    const { container } = render(<RouterProvider router={router} />);
    const form = container.querySelector("form");
    const probe = screen.getByText("idle");

    expect(form).not.toBeNull();
    expect(form?.getAttribute("id")).toBe("router-listing-form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/listings");
    expect(form?.getAttribute("aria-describedby")).toBe("router-errors");
    expect(probe.getAttribute("data-form-id")).toBe("router-listing-form");
    expect(probe.getAttribute("data-summary")).toBe("router-errors");

    if (!form) {
      throw new Error("Expected router form to render.");
    }

    expect(new FormData(form).get("listing_name")).toBe("Blastoise");
  });

  it("preserves the contents layout class on a disabled RouterForm fieldset", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <RouterForm submitting>
            <TextInput label="Listing name" name="listing_name" defaultValue="Blastoise" />
          </RouterForm>
        ),
      },
    ]);

    const { container } = render(<RouterProvider router={router} />);

    expect(container.querySelector("fieldset")?.className).toContain("contents");
  });

  it("associates helper text and errors with stable field ids at the same time", () => {
    render(
      <TextInput
        id="sku"
        label="SKU"
        description="Use the seller-visible SKU."
        error="SKU is required."
        status="Checking availability."
        counter="0 of 32"
        required
      />,
    );

    const input = screen.getByLabelText(/SKU/);
    const describedBy = input.getAttribute("aria-describedby");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy).toBe("sku-description sku-error sku-status sku-counter");
    expect(screen.getByText("Use the seller-visible SKU.").getAttribute("id")).toBe("sku-description");
    expect(screen.getByText("SKU is required.").getAttribute("id")).toBe("sku-error");
    expect(screen.getByText("Checking availability.").getAttribute("id")).toBe("sku-status");
    expect(screen.getByText("0 of 32").getAttribute("id")).toBe("sku-counter");
    expect(screen.getByText("0 of 32").getAttribute("aria-live")).toBe("polite");
  });

  it("extends field anatomy to composite and boolean controls", () => {
    render(
      <>
        <TagInput
          id="listing-tags"
          label="Tags"
          description="Separate tags with commas."
          error="Add at least one tag."
          status="Autosaved."
          counter="0 of 5"
          values={[]}
        />
        <Checkbox
          id="marketing-opt-in"
          label="Receive updates"
          description="Used for account notices."
          error="Choose an update preference."
          status="Optional."
          counter="1 choice"
          value="yes"
        />
      </>,
    );

    expect(screen.getByLabelText(/Tags/).getAttribute("aria-describedby")).toBe(
      "listing-tags-description listing-tags-error listing-tags-status listing-tags-counter",
    );
    expect(screen.getByLabelText(/Receive updates/).getAttribute("aria-describedby")).toBe(
      "marketing-opt-in-description marketing-opt-in-error marketing-opt-in-status marketing-opt-in-counter",
    );
    expect(screen.getByText("Separate tags with commas.").getAttribute("id")).toBe("listing-tags-description");
    expect(screen.getByText("Used for account notices.").getAttribute("id")).toBe("marketing-opt-in-description");
  });

  it("lets a consuming ref focus the natural summary root after commit without stealing focus on rerender", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLElement>();
    const view = (message?: string) => (
      <>
        <Button type="button">Keep focus</Button>
        <ValidationSummary
          ref={ref}
          id="caller-errors"
          errors={message ? [{ fieldId: "caller-email", message }] : []}
        />
        <TextInput id="caller-email" label="Email" />
      </>
    );
    const { rerender, unmount } = render(view());
    expect(ref.current).toBeNull();
    const button = screen.getByRole("button", { name: "Keep focus" });
    button.focus();

    rerender(view("Enter an email."));
    const summary = screen.getByRole("alert");
    expect(ref.current).toBe(summary);
    expect(summary.tagName).toBe("SECTION");
    expect(summary.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(button);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link"));

    ref.current?.focus();
    expect(document.activeElement).toBe(summary);
    button.focus();
    rerender(view("Use a valid email."));
    expect(ref.current).toBe(summary);
    expect(document.activeElement).toBe(button);
    ref.current?.focus();
    expect(document.activeElement).toBe(summary);

    rerender(view());
    expect(ref.current).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(view("Try again."));
    unmount();
    expect(ref.current).toBeNull();
  });

  it("summary links focus natural TextInput, PasswordInput and NativeSelect controls by pointer and Enter", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TextInput id="summary-email" label="Email" />
        <PasswordInput id="summary-password" label="Password" />
        <NativeSelect id="summary-condition" label="Condition" items={[{ value: "new", label: "New" }]} />
        <ValidationSummary
          errors={[
            { fieldId: "summary-email", message: "Fix email." },
            { fieldId: "summary-password", message: "Fix password." },
            { fieldId: "summary-condition", message: "Fix condition." },
            { fieldId: "absent-field", message: "Missing target." },
          ]}
        />
      </>,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("assertive");
    expect(screen.getByRole("alert").getAttribute("tabindex")).toBe("-1");
    for (const [message, label] of [
      ["Fix email.", "Email"],
      ["Fix password.", "Password"],
      ["Fix condition.", "Condition"],
    ]) {
      const link = screen.getByRole("link", { name: message });
      const control = screen.getByLabelText(label, { exact: true });
      expect(link.getAttribute("href")).toBe(`#${control.id}`);
      await user.click(link);
      expect(document.activeElement).toBe(control);
      link.focus();
      await user.keyboard("{Enter}");
      expect(document.activeElement).toBe(control);
    }
    const missingLink = screen.getByRole("link", { name: "Missing target." });
    missingLink.focus();
    fireEvent.click(missingLink);
    expect(document.activeElement).toBe(missingLink);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(missingLink);
  });

  it("cancels a summary link Enter keydown only when it focuses the target", () => {
    render(
      <>
        <TextInput id="cancel-email" label="Email" />
        <input id="cancel-disabled" aria-label="Disabled" disabled />
        <ValidationSummary
          errors={[
            { fieldId: "cancel-email", message: "Fix email." },
            { fieldId: "cancel-disabled", message: "Fix disabled." },
            { fieldId: "cancel-absent", message: "Missing target." },
          ]}
        />
      </>,
    );
    const email = screen.getByLabelText("Email", { exact: true });
    const emailLink = screen.getByRole("link", { name: "Fix email." });

    emailLink.focus();
    expect(fireEvent.keyDown(emailLink, { key: "a" })).toBe(true);
    expect(document.activeElement).toBe(emailLink);
    expect(fireEvent.keyDown(emailLink, { key: "Enter" })).toBe(false);
    expect(document.activeElement).toBe(email);
    emailLink.focus();
    expect(fireEvent.keyDown(emailLink, { key: "Enter", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(email);

    for (const message of ["Fix disabled.", "Missing target."]) {
      const link = screen.getByRole("link", { name: message });
      link.focus();
      expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
      expect(document.activeElement).toBe(link);
    }
  });

  it("summary link Enter inside a form focuses the field without submitting", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const keyDowns: { target: EventTarget; key: string; defaultPrevented: boolean }[] = [];
    render(
      <form
        aria-label="Shipping address"
        onSubmit={onSubmit}
        onKeyDown={(event) =>
          keyDowns.push({ target: event.target, key: event.key, defaultPrevented: event.nativeEvent.defaultPrevented })
        }
      >
        <ValidationSummary
          errors={[
            { fieldId: "form-street", message: "Enter a street." },
            { fieldId: "form-absent", message: "Missing target." },
          ]}
        />
        <TextInput id="form-street" label="Street" />
        <button type="submit">Save address</button>
      </form>,
    );
    const street = screen.getByLabelText("Street", { exact: true });
    const streetLink = screen.getByRole("link", { name: "Enter a street." });

    streetLink.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(street);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(keyDowns).toEqual([{ target: streetLink, key: "Enter", defaultPrevented: true }]);

    const missingLink = screen.getByRole("link", { name: "Missing target." });
    missingLink.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(missingLink);
    expect(keyDowns.at(-1)).toEqual({ target: missingLink, key: "Enter", defaultPrevented: false });
    expect(onSubmit).not.toHaveBeenCalled();

    street.focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("preserves summary consumer behavior without a ref across error and empty rerenders", () => {
    const view = (errors: { message: string }[]) => (
      <>
        <TextInput label="Continue editing" />
        <ValidationSummary
          id="legacy-errors"
          title="Existing title"
          description="Existing description"
          errors={errors}
        />
      </>
    );
    const { rerender } = render(view([]));
    const input = screen.getByLabelText("Continue editing");
    input.focus();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(view([{ message: "Existing message." }]));
    const summary = screen.getByRole("alert");
    expect(summary.getAttribute("id")).toBe("legacy-errors");
    expect(summary.getAttribute("aria-live")).toBe("assertive");
    expect(summary.getAttribute("tabindex")).toBe("-1");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Existing title" })).toBeTruthy();
    expect(screen.getByText("Existing description")).toBeTruthy();
    expect(screen.getByText("Existing message.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.activeElement).toBe(input);
    rerender(view([{ message: "Updated message." }]));
    expect(screen.getByRole("alert")).toBe(summary);
    expect(document.activeElement).toBe(input);
    rerender(view([]));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("renders validation summaries that link to invalid fields", () => {
    render(
      <>
        <input id="email" aria-label="Email" />
        <fieldset id="preferences">
          <legend>Preferences</legend>
          <input id="updates" aria-label="Updates" />
        </fieldset>
        <ValidationSummary
          id="checkout-errors"
          title="Fix checkout details"
          description="Two fields need attention."
          errors={[
            { fieldId: "email", fieldName: "Email", message: "Enter an email." },
            { fieldId: "preferences", fieldName: "Preferences", message: "Choose an option." },
            { message: "Payment could not be started." },
          ]}
        />
      </>,
    );

    expect(screen.getByRole("alert").getAttribute("id")).toBe("checkout-errors");
    const emailLink = screen.getByRole("link", { name: "Email: Enter an email." });
    expect(emailLink.getAttribute("href")).toBe("#email");
    fireEvent.click(emailLink);
    expect(document.activeElement?.getAttribute("id")).toBe("email");

    fireEvent.click(screen.getByRole("link", { name: "Preferences: Choose an option." }));
    expect(document.activeElement?.getAttribute("id")).toBe("updates");
    expect(screen.getByText("Payment could not be started.")).toBeTruthy();
  });

  it("moves focus into validation summary targets on keyboard link activation", async () => {
    const user = userEvent.setup();

    render(
      <>
        <input id="email" aria-label="Email" />
        <ValidationSummary
          errors={[{ fieldId: "email", fieldName: "Email", message: "Enter an email." }]}
          title="Fix listing details"
        />
      </>,
    );

    const emailLink = screen.getByRole("link", { name: "Email: Enter an email." });

    emailLink.focus();
    expect(document.activeElement).toBe(emailLink);

    await user.keyboard("{Enter}");

    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
  });

  it("hides decorative currency prefixes while naming the currency, derived from currencyCode", () => {
    const { container } = render(
      <CurrencyInput
        id="price"
        label="Price"
        currencyCode="USD"
        currencyAccessibleDescription="Amount in US dollars."
        decrementLabel="Decrease amount"
        incrementLabel="Increase amount"
      />,
    );

    const input = screen.getByRole("spinbutton", { name: "Price" });
    expect(input).toBeTruthy();
    expect(screen.getByRole("spinbutton", { description: /US dollars/ })).toBe(input);

    const prefix = container.querySelector("span[aria-hidden='true']");

    expect(prefix?.textContent).toBe("$");
  });

  it("derives the currency symbol and accessible name from a different currencyCode — no hardcoded dollar", () => {
    const { container } = render(
      <CurrencyInput
        id="price-eur"
        label="Price"
        currencyCode="eur"
        currencyAccessibleDescription="Amount in euros."
        decrementLabel="Decrease amount"
        incrementLabel="Increase amount"
      />,
    );

    expect(screen.getByRole("spinbutton", { description: /euros/ })).toBeTruthy();
    const prefix = container.querySelector("span[aria-hidden='true']");
    expect(prefix?.textContent).toBe("€");
  });

  it("emits a canonical decimal-string amount, never a bare float, on value change", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <CurrencyInput
        label="Amount"
        currencyCode="USD"
        currencyAccessibleDescription="Amount in US dollars."
        decrementLabel="Decrease amount"
        incrementLabel="Increase amount"
        onValueChange={onValueChange}
      />,
    );

    const input = screen.getByRole("spinbutton", { name: "Amount" });
    await user.click(input);
    await user.keyboard("19.99");
    await user.tab();

    const emittedValues = onValueChange.mock.calls.map((call) => call[0]);
    expect(emittedValues.some((value) => value === "19.99")).toBe(true);
    expect(emittedValues.every((value) => value === null || /^-?\d+\.\d{2}$/.test(value))).toBe(true);
  });

  describe.each(["NumberField", "CurrencyInput"] as const)("%s behavior", (kind) => {
    function renderField(options: { disabled?: boolean; error?: string } = {}) {
      const onValueChange = vi.fn();
      const shared = {
        label: "Value",
        decrementLabel: "Decrease value",
        incrementLabel: "Increase value",
        onValueChange,
        ...options,
      };
      render(
        kind === "NumberField" ? (
          <NumberField {...shared} defaultValue={2} min={1} max={3} />
        ) : (
          <CurrencyInput {...shared} currencyCode="USD" defaultValue="2.00" min="1.00" max="3.00" step="1.00" />
        ),
      );
      return {
        input: screen.getByRole("spinbutton", { name: "Value" }),
        decrement: screen.getByRole("button", { name: "Decrease value" }),
        increment: screen.getByRole("button", { name: "Increase value" }),
        onValueChange,
      };
    }

    const value = (number: number) => (kind === "NumberField" ? number : number.toFixed(2));

    it("commits typed values and null on clearing", async () => {
      const user = userEvent.setup();
      const { input, onValueChange } = renderField();
      await user.clear(input);
      await user.type(input, "3");
      await user.tab();
      expect(onValueChange).toHaveBeenLastCalledWith(value(3));
      await user.clear(input);
      await user.tab();
      expect(onValueChange).toHaveBeenLastCalledWith(null);
    });

    it("steps with buttons and keyboard without exceeding either bound", async () => {
      const user = userEvent.setup();
      const { input, decrement, increment, onValueChange } = renderField();
      await user.click(increment);
      expect(onValueChange).toHaveBeenLastCalledWith(value(3));
      expect(increment.hasAttribute("disabled")).toBe(true);
      await user.click(input);
      await user.keyboard("{ArrowUp}");
      expect(onValueChange).toHaveBeenLastCalledWith(value(3));
      await user.click(decrement);
      expect(onValueChange).toHaveBeenLastCalledWith(value(2));
      await user.click(input);
      await user.keyboard("{ArrowDown}");
      expect(onValueChange).toHaveBeenLastCalledWith(value(1));
      expect(decrement.hasAttribute("disabled")).toBe(true);
      await user.keyboard("{ArrowDown}");
      expect(onValueChange).toHaveBeenLastCalledWith(value(1));
      await user.keyboard("{ArrowUp}");
      expect(onValueChange).toHaveBeenLastCalledWith(value(2));
      expect(onValueChange.mock.calls.every(([next]) => Number(next) >= 1 && Number(next) <= 3)).toBe(true);
    });

    it("keeps disabled input and steppers inert", async () => {
      const user = userEvent.setup();
      const { input, decrement, increment, onValueChange } = renderField({ disabled: true });
      expect(input.hasAttribute("disabled")).toBe(true);
      expect(decrement.hasAttribute("disabled")).toBe(true);
      expect(increment.hasAttribute("disabled")).toBe(true);
      await user.type(input, "3{ArrowUp}{ArrowDown}");
      await user.click(decrement);
      await user.click(increment);
      expect(onValueChange).not.toHaveBeenCalled();
      expect(Number((input as HTMLInputElement).value)).toBe(2);
    });

    it("retains its error association while allowing ordinary editing", async () => {
      const user = userEvent.setup();
      const { input, onValueChange } = renderField({ error: "Enter a valid value." });
      const error = screen.getByText("Enter a valid value.");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
      await user.clear(input);
      await user.type(input, "3");
      await user.tab();
      expect(onValueChange).toHaveBeenLastCalledWith(value(3));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    });
  });

  it("normalizes server errors and drives controlled form state", () => {
    expect(
      normalizeFormErrors({
        email: ["Enter an email.", "Email must be unique."],
        _form: "Could not save.",
      }),
    ).toEqual({
      fieldErrors: { email: ["Enter an email.", "Email must be unique."] },
      formErrors: ["Could not save."],
    });

    render(<ControlledFormHarness />);

    const email = screen.getByLabelText("Email");
    const status = screen.getByText("untouched");

    expect(status.getAttribute("data-dirty")).toBe("false");
    expect(status.getAttribute("data-valid")).toBe("true");

    fireEvent.blur(email);
    expect(screen.getByText("touched").getAttribute("data-dirty")).toBe("false");

    fireEvent.change(email, { target: { value: "alex" } });
    expect(screen.getByText("touched").getAttribute("data-dirty")).toBe("true");

    const controlledForm = email.closest("form");
    if (!controlledForm) {
      throw new Error("Expected controlled form to render.");
    }
    fireEvent.submit(controlledForm);
    expect(screen.getByText("Enter a valid email.")).toBeTruthy();
    expect(screen.getByText("touched").getAttribute("data-submit-count")).toBe("1");
    expect(screen.getByText("touched").getAttribute("data-valid")).toBe("false");

    fireEvent.change(email, { target: { value: "alex@example.com" } });
    expect(screen.queryByText("Enter a valid email.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("untouched").getAttribute("data-dirty")).toBe("false");
  });

  it("suppresses stale async validation results after field edits", async () => {
    const validations: DeferredValidation[] = [];
    const validate = vi.fn(
      (values: { code: string }) =>
        new Promise<{ code?: string } | null>((resolve) => {
          validations.push({ values: { ...values }, resolve });
        }),
    );

    render(<AsyncValidationHarness validate={validate} />);

    const code = screen.getByLabelText("Code");
    const status = screen.getByText("ready");

    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(status.getAttribute("data-validating")).toBe("true");
    expect(validations[0]?.values).toEqual({ code: "old" });

    fireEvent.change(code, { target: { value: "new" } });
    expect(screen.getByText("ready").getAttribute("data-validating")).toBe("false");

    validations[0]?.resolve({ code: "Old code is no longer valid." });
    await waitFor(() => expect(screen.queryByText("Old code is no longer valid.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(validations[1]?.values).toEqual({ code: "new" });
    validations[1]?.resolve(null);

    await waitFor(() => expect(screen.getByText("ready").getAttribute("data-valid")).toBe("true"));
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("siblings and rows busy only themselves and preserve submitter serialization", async () => {
    const gate = deferred();
    const received: FormData[] = [];
    const router = createMemoryRouter([
      {
        path: "/",
        action: ({ request }) =>
          request.formData().then((data) => {
            received.push(data);
            return gate.promise;
          }),
        element: (
          <>
            <RouterForm method="post" data-testid="row-a">
              <input type="hidden" name="row" value="a" />
              <Button type="submit" name="intent" value="save">
                Save A
              </Button>
            </RouterForm>
            <RouterForm method="post" data-testid="row-b">
              <input type="hidden" name="row" value="b" />
              <Button type="submit" name="intent" value="save">
                Save B
              </Button>
            </RouterForm>
          </>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save A" }));
    await waitFor(() => expect(screen.getByTestId("row-a").getAttribute("data-submitting")).toBe("true"));
    expect(screen.getByTestId("row-b").getAttribute("data-submitting")).toBeNull();
    expect([...received[0]!.entries()]).toEqual([
      ["row", "a"],
      ["intent", "save"],
    ]);
    gate.resolve(null);
  });

  it("byte-identical twin supersession clears the earlier form", async () => {
    const gate = deferred();
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => gate.promise,
        element: (
          <>
            <RouterForm method="post" data-testid="twin-a">
              <Button type="submit">A</Button>
            </RouterForm>
            <RouterForm method="post" data-testid="twin-b">
              <Button type="submit">B</Button>
            </RouterForm>
          </>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "A" }));
    await waitFor(() => expect(screen.getByTestId("twin-a").getAttribute("data-submitting")).toBe("true"));
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(screen.getByTestId("twin-b").getAttribute("data-submitting")).toBe("true"));
    expect(screen.getByTestId("twin-a").getAttribute("data-submitting")).not.toBe("true");
    gate.resolve(null);
  });

  it("two submitters busy only the selected one", async () => {
    const gate = deferred();
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => gate.promise,
        element: (
          <RouterForm method="post" data-testid="multi">
            <Button type="submit" name="intent" value="first">
              First
            </Button>
            <Button type="submit" name="intent" value="second">
              Second
            </Button>
          </RouterForm>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Second" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Second" }).getAttribute("aria-busy")).toBe("true"));
    expect(screen.getByRole("button", { name: "First" }).getAttribute("aria-busy")).toBeNull();
    gate.resolve(null);
  });

  it("records its committed node without a mount-time state rerender", () => {
    let buttonNode: HTMLButtonElement | null = null;
    const renderPhases: string[] = [];

    const view = (pendingSubmitter: HTMLButtonElement | null) => (
      <FormProvider pendingSubmitter={pendingSubmitter}>
        <Profiler id="button" onRender={(_, phase) => renderPhases.push(phase)}>
          <Button
            ref={(node) => {
              buttonNode = node;
            }}
            type="submit"
          >
            Save
          </Button>
        </Profiler>
      </FormProvider>
    );

    const { rerender } = render(view(null));

    expect(renderPhases).toEqual(["mount"]);
    expect(buttonNode).not.toBeNull();

    rerender(view(buttonNode));

    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-busy")).toBe("true");
  });

  it("caller-written field keeps pending and reaches the action", async () => {
    const gate = deferred();
    let received = "";
    const router = createMemoryRouter([
      {
        path: "/",
        action: async ({ request }) => {
          received = String((await request.formData()).get("attempt"));
          return gate.promise;
        },
        element: (
          <RouterForm
            method="post"
            data-testid="written"
            onSubmit={(event) => {
              const input = document.createElement("input");
              input.name = "attempt";
              input.value = "written";
              event.currentTarget.append(input);
            }}
          >
            <Button type="submit">Save</Button>
          </RouterForm>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("written").getAttribute("data-submitting")).toBe("true"));
    expect(received).toBe("written");
    gate.resolve(null);
  });

  it("holds through loading and returns idle at a terminal", async () => {
    const gate = deferred();
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => gate.promise,
        element: (
          <RouterForm method="post" data-testid="terminal">
            <Button type="submit">Save</Button>
          </RouterForm>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("terminal").getAttribute("data-submitting")).toBe("true"));
    gate.resolve(null);
    await waitFor(() => expect(screen.getByTestId("terminal").getAttribute("data-submitting")).toBeNull());
  });

  it("ignores fetcher and GET transports", async () => {
    let count = 0;
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => {
          count += 1;
          return null;
        },
        element: (
          <>
            <RouterForm method="post" navigate={false} fetcherKey="f" data-testid="fetcher">
              <Button type="submit">Fetcher</Button>
            </RouterForm>
            <RouterForm method="get" data-testid="getter">
              <Button type="submit">Get</Button>
            </RouterForm>
          </>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Fetcher" }));
    await waitFor(() => expect(count).toBe(1));
    expect(screen.getByTestId("fetcher").getAttribute("data-submitting")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Get" }));
    expect(screen.getByTestId("getter").getAttribute("data-submitting")).toBeNull();
  });

  it("suppresses pointer and Enter re-submits", async () => {
    const gate = deferred();
    let count = 0;
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => {
          count += 1;
          return gate.promise;
        },
        element: (
          <RouterForm method="post" data-testid="repeat">
            <input aria-label="Name" />
            <Button type="submit">Save</Button>
          </RouterForm>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("repeat").getAttribute("data-submitting")).toBe("true"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByLabelText("Name"));
    await user.keyboard("{Enter}");
    expect(count).toBe(1);
    gate.resolve(null);
  });

  it("caller-cancelled then requestSubmit records a null submitter", async () => {
    const gate = deferred();
    let count = 0;
    let cancelled = false;
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => {
          count += 1;
          return gate.promise;
        },
        element: (
          <RouterForm
            method="post"
            data-testid="request"
            onSubmit={(event) => {
              if (!cancelled) {
                cancelled = true;
                event.preventDefault();
                const form = event.currentTarget;
                queueMicrotask(() => form.requestSubmit());
              }
            }}
          >
            <Button type="submit">Save</Button>
          </RouterForm>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(count).toBe(1));
    expect(screen.getByTestId("request").getAttribute("data-submitting")).toBe("true");
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-busy")).toBeNull();
    gate.resolve(null);
  });

  it("announces caller text only while derived pending and preserves busy name", async () => {
    const gate = deferred();
    const router = createMemoryRouter([
      {
        path: "/",
        action: () => gate.promise,
        element: (
          <RouterForm method="post" pendingAnnouncement="Saving" data-testid="announce">
            <Button type="submit">Save</Button>
          </RouterForm>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("status").textContent).toBe("");
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saving"));
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-busy")).toBe("true");
    gate.resolve(null);
  });

  it("keeps explicit submitting caller-owned and reloadDocument out of props", () => {
    const { container } = render(
      <RouterForm submitting data-testid="explicit">
        <Button type="submit">Save</Button>
      </RouterForm>,
    );
    expect(container.querySelector("fieldset[disabled]")).not.toBeNull();
    // @ts-expect-error reloadDocument is intentionally excluded from RouterFormProps
    const invalid = <RouterForm reloadDocument />;
    expect(invalid).toBeTruthy();
  });
});
