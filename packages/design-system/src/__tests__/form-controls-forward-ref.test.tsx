import { createRef, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Autocomplete,
  Calendar,
  Checkbox,
  CheckboxGroup,
  Combobox,
  CurrencyInput,
  DateInput,
  DatePicker,
  FileDropzone,
  HiddenInput,
  HoneypotInput,
  NativeSelect,
  NumberField,
  PasswordInput,
  ProductSelectionFields,
  QuantityStepper,
  RadioGroup,
  SearchInput,
  Select,
  Slider,
  Switch,
  TagInput,
  Textarea,
  TextInput,
} from "../components/forms";
import { ChaseRoot } from "../theme/provider";

function renderInRoot(ui: ReactNode) {
  return render(<ChaseRoot>{ui}</ChaseRoot>);
}

describe("form control refs", () => {
  it("reach each control's natural focusable element", () => {
    const textInputRef = createRef<HTMLInputElement>();
    const searchInputRef = createRef<HTMLInputElement>();
    const dateInputRef = createRef<HTMLInputElement>();
    const textareaRef = createRef<HTMLTextAreaElement>();
    const nativeSelectRef = createRef<HTMLSelectElement>();
    const selectRef = createRef<HTMLButtonElement>();
    const autocompleteRef = createRef<HTMLInputElement>();
    const comboboxRef = createRef<HTMLInputElement>();
    const numberFieldRef = createRef<HTMLInputElement>();
    const currencyInputRef = createRef<HTMLInputElement>();
    const quantityStepperRef = createRef<HTMLInputElement>();
    const checkboxRef = createRef<HTMLInputElement>();
    const checkboxGroupRef = createRef<HTMLInputElement>();
    const radioGroupRef = createRef<HTMLButtonElement>();
    const switchRef = createRef<HTMLButtonElement>();
    const sliderRef = createRef<HTMLInputElement>();
    const fileDropzoneRef = createRef<HTMLInputElement>();
    const tagInputRef = createRef<HTMLInputElement>();
    const passwordInputRef = createRef<HTMLInputElement>();
    const calendarRef = createRef<HTMLButtonElement>();
    const datePickerRef = createRef<HTMLButtonElement>();
    const productSelectionFieldsRef = createRef<HTMLSelectElement>();
    const hiddenInputRef = createRef<HTMLInputElement>();
    const honeypotInputRef = createRef<HTMLInputElement>();

    renderInRoot(
      <>
        <TextInput id="ref-text" ref={textInputRef} label="Text" />
        <SearchInput id="ref-search" ref={searchInputRef} />
        <DateInput id="ref-date-input" ref={dateInputRef} label="Date" />
        <Textarea id="ref-textarea" ref={textareaRef} label="Textarea" />
        <NativeSelect id="ref-native-select" ref={nativeSelectRef} label="Native select" items={[]} />
        <Select id="ref-select" ref={selectRef} label="Select" items={[{ value: "one", label: "One" }]} />
        <Autocomplete
          id="ref-autocomplete"
          ref={autocompleteRef}
          label="Autocomplete"
          items={[{ value: "one", label: "One" }]}
        />
        <Combobox id="ref-combobox" ref={comboboxRef} label="Combobox" items={[{ value: "one", label: "One" }]} />
        <NumberField id="ref-number" ref={numberFieldRef} label="Number" />
        <CurrencyInput id="ref-currency" ref={currencyInputRef} label="Currency" currencyCode="USD" />
        <QuantityStepper id="ref-quantity" ref={quantityStepperRef} label="Quantity" />
        <Checkbox id="ref-checkbox" ref={checkboxRef} label="Checkbox" />
        <CheckboxGroup
          id="ref-checkbox-group"
          ref={checkboxGroupRef}
          label="Checkbox group"
          values={[]}
          items={[{ value: "one", label: "One" }]}
        />
        <RadioGroup
          id="ref-radio-group"
          ref={radioGroupRef}
          label="Radio group"
          items={[{ value: "one", label: "One" }]}
        />
        <Switch id="ref-switch" ref={switchRef} label="Switch" />
        <Slider id="ref-slider" ref={sliderRef} label="Slider" />
        <FileDropzone id="ref-file" ref={fileDropzoneRef} label="Files" />
        <TagInput id="ref-tags" ref={tagInputRef} label="Tags" values={[]} />
        <PasswordInput id="ref-password" ref={passwordInputRef} label="Password" />
        <Calendar id="ref-calendar" ref={calendarRef} value="2026-06-15" aria-label="Calendar" />
        <DatePicker id="ref-date-picker" ref={datePickerRef} label="Date picker" />
        <ProductSelectionFields
          ref={productSelectionFieldsRef}
          fields={[
            { dimensionId: "condition", label: "Condition", value: "one", options: [{ value: "one", label: "One" }] },
          ]}
          onFieldChange={() => {}}
        />
        <HiddenInput id="ref-hidden" ref={hiddenInputRef} />
        <HoneypotInput id="ref-honeypot" ref={honeypotInputRef} name="website" />
      </>,
    );

    expect(textInputRef.current).toBe(document.getElementById("ref-text"));
    expect(searchInputRef.current).toBe(document.getElementById("ref-search"));
    expect(dateInputRef.current).toBe(document.getElementById("ref-date-input"));
    expect(textareaRef.current).toBe(document.getElementById("ref-textarea"));
    expect(nativeSelectRef.current).toBe(document.getElementById("ref-native-select"));
    expect(selectRef.current).toBe(screen.getByRole("combobox", { name: "Select" }));
    expect(autocompleteRef.current).toBe(document.getElementById("ref-autocomplete"));
    expect(comboboxRef.current).toBe(document.getElementById("ref-combobox"));
    expect(numberFieldRef.current).toBe(document.getElementById("ref-number"));
    expect(currencyInputRef.current).toBe(document.getElementById("ref-currency"));
    expect(quantityStepperRef.current).toBe(document.getElementById("ref-quantity"));
    expect(checkboxRef.current).toBe(document.getElementById("ref-checkbox"));
    expect(checkboxGroupRef.current?.type).toBe("checkbox");
    expect(radioGroupRef.current).toBe(screen.getByRole("radio", { name: "One" }));
    expect(switchRef.current).toBe(screen.getByRole("switch", { name: "Switch" }));
    expect(sliderRef.current).toBe(screen.getByRole("slider", { name: "Slider" }));
    expect(fileDropzoneRef.current).toBe(document.getElementById("ref-file"));
    expect(tagInputRef.current).toBe(document.getElementById("ref-tags"));
    expect(passwordInputRef.current).toBe(document.getElementById("ref-password"));
    expect(calendarRef.current).toBe(screen.getByRole("button", { name: "Monday, June 15, 2026" }));
    expect(datePickerRef.current).toBe(screen.getByRole("button", { name: "Date picker" }));
    expect(productSelectionFieldsRef.current).toBeInstanceOf(HTMLSelectElement);
    expect(hiddenInputRef.current).toBe(document.getElementById("ref-hidden"));
    expect(honeypotInputRef.current).toBe(document.getElementById("ref-honeypot"));
  });

  it("keeps the public component display names", () => {
    expect(TextInput.displayName).toBe("TextInput");
    expect(SearchInput.displayName).toBe("SearchInput");
    expect(DateInput.displayName).toBe("DateInput");
    expect(Textarea.displayName).toBe("Textarea");
    expect(NativeSelect.displayName).toBe("NativeSelect");
    expect(Select.displayName).toBe("Select");
    expect(Autocomplete.displayName).toBe("Autocomplete");
    expect(Combobox.displayName).toBe("Combobox");
    expect(NumberField.displayName).toBe("NumberField");
    expect(CurrencyInput.displayName).toBe("CurrencyInput");
    expect(QuantityStepper.displayName).toBe("QuantityStepper");
    expect(Checkbox.displayName).toBe("Checkbox");
    expect(CheckboxGroup.displayName).toBe("CheckboxGroup");
    expect(RadioGroup.displayName).toBe("RadioGroup");
    expect(Switch.displayName).toBe("Switch");
    expect(Slider.displayName).toBe("Slider");
    expect(FileDropzone.displayName).toBe("FileDropzone");
    expect(TagInput.displayName).toBe("TagInput");
    expect(PasswordInput.displayName).toBe("PasswordInput");
    expect(Calendar.displayName).toBe("Calendar");
    expect(DatePicker.displayName).toBe("DatePicker");
    expect(ProductSelectionFields.displayName).toBe("ProductSelectionFields");
    expect(HiddenInput.displayName).toBe("HiddenInput");
    expect(HoneypotInput.displayName).toBe("HoneypotInput");
  });
});
