import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type FormEvent } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RouterForm } from "../components/forms/router-form";
import {
  Autocomplete,
  Button,
  Checkbox,
  CheckboxGroup,
  Combobox,
  CurrencyInput,
  Form,
  NumberField,
  RadioGroup,
  Select,
  Slider,
  Switch,
  TagInput,
  TextInput,
  ValidationSummary,
  normalizeFormErrors,
  useFormContext,
  useFormState,
} from "../index";

type DeferredValidation = {
  values: { code: string };
  resolve: (value: { code?: string } | null) => void;
};

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
    const { container } = render(<CurrencyInput id="price" label="Price" currencyCode="USD" />);

    const input = screen.getByRole("spinbutton", { name: "Price" });
    expect(input).toBeTruthy();
    expect(screen.getByRole("spinbutton", { description: /US Dollar/ })).toBe(input);

    const prefix = container.querySelector("span[aria-hidden='true']");

    expect(prefix?.textContent).toBe("$");
  });

  it("derives the currency symbol and accessible name from a different currencyCode — no hardcoded dollar", () => {
    const { container } = render(<CurrencyInput id="price-eur" label="Price" currencyCode="eur" />);

    expect(screen.getByRole("spinbutton", { description: /Euro/ })).toBeTruthy();
    const prefix = container.querySelector("span[aria-hidden='true']");
    expect(prefix?.textContent).toBe("€");
  });

  it("emits a canonical decimal-string amount, never a bare float, on value change", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(<CurrencyInput label="Amount" currencyCode="USD" onValueChange={onValueChange} />);

    const input = screen.getByRole("spinbutton", { name: "Amount" });
    await user.click(input);
    await user.keyboard("19.99");
    await user.tab();

    const emittedValues = onValueChange.mock.calls.map((call) => call[0]);
    expect(emittedValues.some((value) => value === "19.99")).toBe(true);
    expect(emittedValues.every((value) => value === null || /^-?\d+\.\d{2}$/.test(value))).toBe(true);
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
});
