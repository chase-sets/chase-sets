//! What the screen's forms post, and the checks the pilot makes before it calls the API.
//!
//! The rules (an effective-until after effective-from, which values a policy may hold) are the
//! platform's: the API checks them and its refusal becomes the form's message
//! (`Errors::add_form`). The pilot checks only what it needs to build the request, which the
//! inputs' `required` and `type="number"` already ask of the browser: text is there and numbers
//! are numbers. The fields hold the text as typed, so a form re-rendered with errors shows it.
use corten::prelude::*;
use serde::Deserialize;

use crate::{
    api::{CloneCommand, Payload, Policy, PolicyCommand, PreviewCommand},
    text::Pilot,
};

/// The default policy a new draft starts from (contracts/product-measures, by scripts/export.mjs).
pub fn default_payload() -> Payload {
    serde_json::from_str(include_str!("../defaults.json")).expect("defaults.json is the export's output")
}

/// A policy's fields: the create form and the revise form, which also carries the preview's
/// inputs (its preview button posts the same form to the preview route).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct PolicyInput {
    pub label: String,
    pub effective_from: String,
    #[serde(default)]
    pub effective_until: String,
    pub policy_version: String,
    pub max_letter_units: String,
    pub max_letter_weight_ounces: String,
    pub max_letter_thickness_inches: String,
    pub max_letter_declared_value_amount: String,
    pub letter_envelope_weight_ounces: String,
    pub parcel_packaging_weight_ounces: String,
    #[serde(default)]
    pub signature_required_declared_value_amount: String,
    #[serde(default)]
    pub insurance_required_declared_value_amount: String,
    #[serde(default)]
    pub parcel_required_shipping_options: Vec<String>,
    #[serde(default)]
    pub parcel_required_physical_flags: Vec<String>,
    #[serde(default)]
    pub letter_required_physical_flags: Vec<String>,
    #[serde(default)]
    pub signature_required_shipping_options: Vec<String>,
    #[serde(default)]
    pub signature_required_physical_flags: Vec<String>,
    #[serde(default)]
    pub preview_shipping_option: String,
    #[serde(default)]
    pub preview_item_subtotal_amount: String,
    #[serde(default)]
    pub preview_quantity: String,
    #[serde(default)]
    pub preview_unit_length_inches: String,
    #[serde(default)]
    pub preview_unit_width_inches: String,
    #[serde(default)]
    pub preview_unit_height_inches: String,
    #[serde(default)]
    pub preview_unit_weight_ounces: String,
    #[serde(default)]
    pub preview_physical_flags: Vec<String>,
}

fn number(n: f64) -> String {
    n.to_string()
}

impl PolicyInput {
    /// A form showing `payload`, with the preview's defaults.
    pub fn new(label: &str, effective_from: &str, effective_until: &str, payload: &Payload) -> Self {
        let optional = |n: Option<f64>| n.map(number).unwrap_or_default();
        PolicyInput {
            label: label.into(),
            effective_from: effective_from.into(),
            effective_until: effective_until.into(),
            policy_version: payload.policy_version.clone(),
            max_letter_units: number(payload.max_letter_units),
            max_letter_weight_ounces: number(payload.max_letter_weight_ounces),
            max_letter_thickness_inches: number(payload.max_letter_thickness_inches),
            max_letter_declared_value_amount: number(payload.max_letter_declared_value_amount),
            letter_envelope_weight_ounces: number(payload.letter_envelope_weight_ounces),
            parcel_packaging_weight_ounces: number(payload.parcel_packaging_weight_ounces),
            signature_required_declared_value_amount: optional(payload.signature_required_declared_value_amount),
            insurance_required_declared_value_amount: optional(payload.insurance_required_declared_value_amount),
            parcel_required_shipping_options: payload.parcel_required_shipping_options.clone(),
            parcel_required_physical_flags: payload.parcel_required_physical_flags.clone(),
            letter_required_physical_flags: payload.letter_required_physical_flags.clone(),
            signature_required_shipping_options: payload.signature_required_shipping_options.clone(),
            signature_required_physical_flags: payload.signature_required_physical_flags.clone(),
            preview_shipping_option: "standard".into(),
            preview_item_subtotal_amount: "25.00".into(),
            preview_quantity: "1".into(),
            preview_unit_length_inches: "3.5".into(),
            preview_unit_width_inches: "2.5".into(),
            preview_unit_height_inches: "0.016".into(),
            preview_unit_weight_ounces: "0.05".into(),
            preview_physical_flags: vec!["raw-card".into()],
        }
    }

    /// The revise form for a policy.
    pub fn of(policy: &Policy) -> Self {
        Self::new(&policy.label, &policy.effective_from, policy.effective_until.as_deref().unwrap_or(""), &policy.payload)
    }

    /// The create or revise request, or what is missing.
    pub fn command(&self, t: Pilot) -> Result<PolicyCommand, Errors> {
        let f = Self::FIELDS;
        let mut check = Check { t, errors: Errors::new() };
        check.text(f.label, &self.label);
        check.text(f.effective_from, &self.effective_from);
        let payload = self.payload(&mut check);
        check.errors.into_result(PolicyCommand {
            label: self.label.trim().into(),
            effective_from: self.effective_from.trim().into(),
            effective_until: self.effective_until.trim().into(),
            payload,
        })
    }

    fn payload(&self, check: &mut Check) -> Payload {
        let f = Self::FIELDS;
        check.text(f.policy_version, &self.policy_version);
        Payload {
            policy_version: self.policy_version.trim().into(),
            max_letter_units: check.number(f.max_letter_units, &self.max_letter_units),
            max_letter_weight_ounces: check.number(f.max_letter_weight_ounces, &self.max_letter_weight_ounces),
            max_letter_thickness_inches: check.number(f.max_letter_thickness_inches, &self.max_letter_thickness_inches),
            max_letter_declared_value_amount: check
                .number(f.max_letter_declared_value_amount, &self.max_letter_declared_value_amount),
            letter_envelope_weight_ounces: check.number(f.letter_envelope_weight_ounces, &self.letter_envelope_weight_ounces),
            parcel_packaging_weight_ounces: check.number(f.parcel_packaging_weight_ounces, &self.parcel_packaging_weight_ounces),
            parcel_required_shipping_options: self.parcel_required_shipping_options.clone(),
            letter_required_physical_flags: self.letter_required_physical_flags.clone(),
            parcel_required_physical_flags: self.parcel_required_physical_flags.clone(),
            signature_required_shipping_options: self.signature_required_shipping_options.clone(),
            signature_required_declared_value_amount: check
                .optional(f.signature_required_declared_value_amount, &self.signature_required_declared_value_amount),
            signature_required_physical_flags: self.signature_required_physical_flags.clone(),
            insurance_required_declared_value_amount: check
                .optional(f.insurance_required_declared_value_amount, &self.insurance_required_declared_value_amount),
        }
    }

    /// The preview's rules, or what is missing. The request borrows the input and the payload.
    pub fn preview_payload(&self, t: Pilot) -> Result<(Payload, [f64; 5]), Errors> {
        let f = Self::FIELDS;
        let mut check = Check { t, errors: Errors::new() };
        let payload = self.payload(&mut check);
        check.text(f.preview_item_subtotal_amount, &self.preview_item_subtotal_amount);
        let numbers = [
            check.number(f.preview_quantity, &self.preview_quantity),
            check.number(f.preview_unit_length_inches, &self.preview_unit_length_inches),
            check.number(f.preview_unit_width_inches, &self.preview_unit_width_inches),
            check.number(f.preview_unit_height_inches, &self.preview_unit_height_inches),
            check.number(f.preview_unit_weight_ounces, &self.preview_unit_weight_ounces),
        ];
        check.errors.into_result((payload, numbers))
    }

    pub fn preview<'a>(&'a self, payload: &'a Payload, n: &[f64; 5]) -> PreviewCommand<'a> {
        let shipping = if self.preview_shipping_option.is_empty() { "standard" } else { &self.preview_shipping_option };
        PreviewCommand {
            policy: payload,
            shipping_option: shipping,
            item_subtotal_amount: self.preview_item_subtotal_amount.trim(),
            quantity: n[0],
            unit_length_inches: n[1],
            unit_width_inches: n[2],
            unit_height_inches: n[3],
            unit_weight_ounces: n[4],
            physical_flags: &self.preview_physical_flags,
        }
    }
}

struct Check {
    t: Pilot,
    errors: Errors,
}

impl Check {
    fn text(&mut self, field: FieldName, text: &str) {
        if text.trim().is_empty() {
            self.errors.add(field, self.t.check_required());
        }
    }

    fn number(&mut self, field: FieldName, text: &str) -> f64 {
        match text.trim() {
            "" => {
                self.errors.add(field, self.t.check_required());
                0.0
            }
            text => text.parse::<f64>().ok().filter(|n| n.is_finite()).unwrap_or_else(|| {
                self.errors.add(field, self.t.check_number());
                0.0
            }),
        }
    }

    fn optional(&mut self, field: FieldName, text: &str) -> Option<f64> {
        (!text.trim().is_empty()).then(|| self.number(field, text))
    }
}

/// The activate form. `label` is the policy's, for the confirm dialog's title when the form
/// comes back with an error.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct ActivateInput {
    #[serde(default)]
    pub label: String,
    pub activation_reason: String,
}

/// The retire form, `label` as in [`ActivateInput`].
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct RetireInput {
    #[serde(default)]
    pub label: String,
    pub retirement_reason: String,
}

/// The clone form: a rollback draft of the policy.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct CloneInput {
    pub clone_label: String,
    pub clone_effective_from: String,
    #[serde(default)]
    pub clone_effective_until: String,
}

/// A required reason, or its error.
pub fn reason(t: Pilot, field: FieldName, text: &str) -> Result<String, Errors> {
    let mut check = Check { t, errors: Errors::new() };
    check.text(field, text);
    check.errors.into_result(text.trim().to_owned())
}

impl CloneInput {
    pub fn command(&self, t: Pilot) -> Result<CloneCommand<'_>, Errors> {
        let f = Self::FIELDS;
        let mut check = Check { t, errors: Errors::new() };
        check.text(f.clone_label, &self.clone_label);
        check.text(f.clone_effective_from, &self.clone_effective_from);
        check.errors.into_result(CloneCommand {
            label: self.clone_label.trim(),
            effective_from: self.clone_effective_from.trim(),
            effective_until: self.clone_effective_until.trim(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_form_reads_back_the_policy_it_shows() {
        let payload = default_payload();
        let input = PolicyInput::new("Default", "2026-01-01T00:00:00.000Z", "", &payload);
        let command = input.command(Pilot::default()).expect("the defaults are valid");
        assert_eq!(command.payload.max_letter_weight_ounces, 3.5);
        assert_eq!(command.payload.signature_required_declared_value_amount, Some(250.0));
        assert_eq!(command.payload.parcel_required_shipping_options, ["expedited", "priority"]);
        let json = serde_json::to_value(&command).unwrap();
        assert_eq!(json["maxLetterUnits"], 8.0, "the rules sit beside the label, as the API reads them: {json}");
        assert_eq!(json["effectiveFrom"], "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn missing_text_and_bad_numbers_name_their_fields() {
        let f = PolicyInput::FIELDS;
        let input = PolicyInput {
            label: " ".into(),
            max_letter_units: "eight".into(),
            insurance_required_declared_value_amount: String::new(),
            ..PolicyInput::new("x", "2026-01-01", "", &default_payload())
        };
        let errors = input.command(Pilot::default()).unwrap_err();
        assert_eq!(errors.get(f.label), Some(Pilot::default().check_required()));
        assert_eq!(errors.get(f.max_letter_units), Some(Pilot::default().check_number()));
        assert!(!errors.has(f.insurance_required_declared_value_amount), "blank is no threshold");
    }
}
