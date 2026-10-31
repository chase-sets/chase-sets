//! What the location forms post, and the checks the pilot makes before it calls the API.
//!
//! The rules (what a ship-from code or an address may be) are the Inventory context's: the API
//! checks them, and its refusal becomes the form's message (`Errors::add_form`). The pilot checks
//! only what the inputs' `required` already asks of the browser, and that the form carries the
//! attempt the pilot issued. The body is built as marketplace's route action builds it: required
//! text as typed, optional text trimmed or `null`, an empty country as `US`.
use corten::prelude::*;
use serde::Deserialize;

use crate::{
    api::{Address, DecisionCommand, Location, LocationCommand, Outcome},
    recovery::valid_attempt,
    text::Pilot,
};

/// A location's fields and the attempt the form was posted with (its `SubmitKey`, drawn fresh
/// each time the form is). The archive form sends the
/// location's current fields as hidden inputs, as marketplace's does.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct LocationInput {
    pub attempt: String,
    pub name: String,
    pub description: String,
    pub ship_from_code: String,
    pub ship_from_name: String,
    pub ship_from_company: String,
    pub ship_from_line1: String,
    pub ship_from_line2: String,
    pub ship_from_city: String,
    pub ship_from_state: String,
    pub ship_from_postal_code: String,
    pub ship_from_country: String,
    pub ship_from_phone: String,
    pub ship_from_email: String,
}

fn optional(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

impl LocationInput {
    /// The create form: empty, the country `US`.
    pub fn blank() -> Self {
        LocationInput { ship_from_country: "US".into(), ..Default::default() }
    }

    /// A location's update and archive forms.
    pub fn of(location: &Location) -> Self {
        let a = &location.ship_from_address;
        let text = |t: &Option<String>| t.clone().unwrap_or_default();
        LocationInput {
            attempt: String::new(),
            name: location.name.clone(),
            description: text(&location.description),
            ship_from_code: location.ship_from_code.clone(),
            ship_from_name: a.name.clone(),
            ship_from_company: text(&a.company),
            ship_from_line1: a.line1.clone(),
            ship_from_line2: text(&a.line2),
            ship_from_city: a.city.clone(),
            ship_from_state: a.state.clone(),
            ship_from_postal_code: a.postal_code.clone(),
            ship_from_country: a.country.clone(),
            ship_from_phone: text(&a.phone),
            ship_from_email: text(&a.email),
        }
    }

    /// The request, or what is missing. `archived` is `None` for a create.
    pub fn command(&self, p: Pilot, archived: Option<bool>) -> Result<LocationCommand, Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        if !valid_attempt(&self.attempt) {
            errors.add_form(p.check_attempt());
        }
        for (field, text) in [
            (f.name, &self.name),
            (f.ship_from_code, &self.ship_from_code),
            (f.ship_from_name, &self.ship_from_name),
            (f.ship_from_line1, &self.ship_from_line1),
            (f.ship_from_city, &self.ship_from_city),
            (f.ship_from_state, &self.ship_from_state),
            (f.ship_from_postal_code, &self.ship_from_postal_code),
        ] {
            if text.trim().is_empty() {
                errors.add(field, p.check_required());
            }
        }
        errors.into_result(LocationCommand {
            name: self.name.clone(),
            description: optional(&self.description),
            ship_from_code: self.ship_from_code.clone(),
            ship_from_address: Address {
                name: self.ship_from_name.clone(),
                company: optional(&self.ship_from_company),
                line1: self.ship_from_line1.clone(),
                line2: optional(&self.ship_from_line2),
                city: self.ship_from_city.clone(),
                state: self.ship_from_state.clone(),
                postal_code: self.ship_from_postal_code.clone(),
                country: if self.ship_from_country.is_empty() { "US".into() } else { self.ship_from_country.clone() },
                phone: optional(&self.ship_from_phone),
                email: optional(&self.ship_from_email),
            },
            is_archived: archived,
        })
    }
}

/// What a restock decision's two forms post: the attempt, the decision's version as the page read
/// it, and (the write-off form only) a damage note.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct DecisionInput {
    pub attempt: String,
    pub expected_version: String,
    pub damage_note: String,
}

impl DecisionInput {
    /// A decision's forms, at the version the page read.
    pub fn of(version: u64) -> Self {
        DecisionInput { expected_version: version.to_string(), ..Default::default() }
    }

    /// The request for `outcome`, or why the form cannot send it. The version is a hidden input;
    /// one that is not a number means the form is out of date, as a missing attempt does.
    pub fn command(&self, p: Pilot, outcome: Outcome) -> Result<DecisionCommand, Errors> {
        let mut errors = Errors::new();
        let version = self.expected_version.trim().parse::<u64>().ok().filter(|v| *v >= 1);
        if !valid_attempt(&self.attempt) || version.is_none() {
            errors.add_form(p.check_attempt());
        }
        errors.into_result(DecisionCommand {
            expected_version: version.unwrap_or_default(),
            outcome,
            damage_note: (outcome == Outcome::WrittenOff).then(|| optional(&self.damage_note)),
        })
    }
}
