# Form Acceptance Matrix

This matrix is the design-system acceptance checklist for form primitives. Keep it in sync with `src/__tests__/form-system.test.tsx`, route/browser smoke tests, and the no-legacy-form guardrail.

## Form-Level Patterns

| Pattern | Required coverage | Current evidence |
| --- | --- | --- |
| `Form` | Native `method`, `action`, `encType`, `target`, `ref`, hidden fields, external submit controls, disabled/submitting context, validation summary association | `form-system.test.tsx` |
| `RouterForm` | React Router action compatibility through `@chase-sets/design-system/react-router`, no direct framework `Form` imports in production consumers | `form-system.test.tsx`, `check:no-legacy-forms` |
| `ValidationSummary` | Field links, delegated focus for native/group targets, form-level messages, alert semantics, dynamic error updates | `form-system.test.tsx` |
| `useFormState` and error helpers | dirty, touched, reset, submit count, local validation, async validation, validating/submitting state, normalized server errors, stale field-error clearing | `form-system.test.tsx` |

## Primitive Matrix

| Primitive | Field anatomy | Native submission | Required verification |
| --- | --- | --- | --- |
| `TextInput` | label, description, error, status, counter | native input | accessible label/description/error/status and `FormData` |
| `CurrencyInput` | label, description, error, status, counter | native input | accessible label/description/error/status and `FormData` |
| `SearchInput` | label, description, error, status, counter | native input | accessible label/description/error/status and `FormData` |
| `PasswordInput` | label, description, error, status, counter | native input | accessible label/description/error/status, reveal toggle, and `FormData` |
| `Textarea` | label, description, error, status, counter | native textarea | accessible label/description/error/status and `FormData` |
| `NativeSelect` | label, description, error, status, counter | native select | accessible label/description/error/status and `FormData` |
| `Select` | label, description, error, status, counter | hidden input synced from selected value | accessible trigger text, option interaction, disabled submission exclusion, and `FormData` |
| `NumberField` | label, description, error, status, counter | Base UI hidden/native input via `name`/`form` | value stepping, disabled/read-only behavior, and `FormData` |
| `Checkbox` | visible item label plus shared description, error, status, counter | native checkbox | checked, unchecked, indeterminate visual state, disabled exclusion, and `FormData` |
| `CheckboxGroup` | fieldset/legend group label plus item labels | repeated native checkbox values via `name`/`form` | group label semantics, disabled/read-only behavior, and repeated `FormData` values |
| `RadioGroup` | group label plus item labels | Base UI hidden/native radio inputs via `name`/`form` | selected value, required behavior, keyboard behavior, and `FormData` |
| `Switch` | visible item label plus shared description, error, status, counter | Base UI hidden input via `name`/`form` | checked/unchecked values, disabled/read-only behavior, and `FormData` |
| `Slider` | label, description, error, status, counter | Base UI hidden range input via `name`/`form` | value formatting, keyboard behavior, disabled behavior, and `FormData` |
| `Combobox` | label, description, error, status, counter | hidden input synced from selected value | selected value, filtering, disabled behavior, and `FormData` |
| `Autocomplete` | label, description, error, status, counter | hidden input synced from selected value | selected value, empty state, keyboard behavior, and `FormData` |
| `TagInput` | label, description, error, status, counter | repeated hidden inputs, one per tag | add/remove keyboard behavior, duplicate prevention, max-tags behavior, and repeated `FormData` values |
| `FileDropzone` | label, description, error, status, counter | native file input | file selection/drop behavior, multipart route smoke coverage, and `FormData` |

## Migration Gates

- Production code must use `Form` or an approved design-system adapter instead of lowercase JSX/HTML `<form>`.
- React Router route actions must use `RouterForm` from `@chase-sets/design-system/react-router`.
- `pnpm run check:no-legacy-forms` must pass in final mode with an empty `scripts/no-legacy-forms.baseline.json`.
- Migration slices must preserve submitted field names, hidden fields, multipart uploads, GET filters, destructive actions, and external submit controls.
