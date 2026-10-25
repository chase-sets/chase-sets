//! What the catalog forms post, and the bodies admin-web's pages send for them. The rules (what a
//! key may be, which transitions a status allows) are the Catalog context's: the API checks them
//! and its refusal becomes the form's message. The pilot checks only shape: a number parses, an
//! action is one the form offers.
use corten::prelude::*;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::api::{Dimension, DimensionOption, Field};
use crate::text::Pilot;

/// A new id for a form about to be drawn, as `createId(prefix)` makes it: the API takes the id
/// from the body, so the same form posted twice names the same record.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", ulid::Ulid::new())
}

/// `localizedTextMapFromEnglish`: the text in English, or no text.
pub fn english(text: &str) -> Value {
    let text = text.trim();
    let mut values = Map::new();
    if !text.is_empty() {
        values.insert("en".into(), json!(text));
    }
    json!({ "defaultLocale": "en", "values": values })
}

/// A dimension's create and edit form.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct DimensionInput {
    /// The id a create was drawn with (empty for an edit).
    pub dimension_id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub value_kind: String,
}

impl DimensionInput {
    pub fn blank() -> Self {
        DimensionInput { dimension_id: new_id("dim"), value_kind: "unordered".into(), ..Default::default() }
    }

    pub fn of(d: &Dimension) -> Self {
        DimensionInput {
            dimension_id: String::new(),
            key: d.key.clone(),
            name: d.name.clone(),
            description: d.description.clone().unwrap_or_default(),
            value_kind: d.value_kind.clone(),
        }
    }

    /// `createDimension`'s body, or `reviseDimension`'s without the id.
    pub fn body(&self, create: bool) -> Value {
        let mut body = json!({
            "key": self.key,
            "name": english(&self.name),
            "description": english(&self.description),
            "valueKind": self.value_kind,
        });
        if create {
            body["dimensionId"] = json!(self.dimension_id);
        }
        body
    }
}

/// A field's create and configure form. A checkbox sends `on`, or nothing when it is clear.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct FieldInput {
    pub field_id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub value_type: String,
    #[serde(default)]
    pub filterable: bool,
    #[serde(default)]
    pub searchable: bool,
    #[serde(default)]
    pub sortable: bool,
}

impl FieldInput {
    pub fn blank() -> Self {
        FieldInput { field_id: new_id("fld"), value_type: "string".into(), ..Default::default() }
    }

    pub fn of(f: &Field) -> Self {
        FieldInput {
            field_id: String::new(),
            key: f.key.clone(),
            name: f.name.clone(),
            description: f.description.clone().unwrap_or_default(),
            value_type: f.value_type.clone(),
            filterable: f.filterable,
            searchable: f.searchable,
            sortable: f.sortable,
        }
    }

    /// `createField`'s body, or `configureField`'s without the id.
    pub fn body(&self, create: bool) -> Value {
        let mut body = json!({
            "key": self.key,
            "name": english(&self.name),
            "description": english(&self.description),
            "valueType": self.value_type,
            "behavior": { "filterable": self.filterable, "searchable": self.searchable, "sortable": self.sortable },
        });
        if create {
            body["fieldId"] = json!(self.field_id);
        }
        body
    }
}

/// An option's add and edit form: its code, a number, and a label per locale (rows of
/// `label_locale` and `label_value`). `relabel` is the button that adds a row (`add`) or
/// removes one (its index): the form is drawn again and nothing is written.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct OptionInput {
    pub option_id: String,
    pub code: String,
    pub numeric_value: String,
    #[serde(default)]
    pub label_locale: Vec<String>,
    #[serde(default)]
    pub label_value: Vec<String>,
    pub relabel: Option<String>,
}

impl OptionInput {
    pub fn blank() -> Self {
        OptionInput {
            option_id: new_id("chc"),
            label_locale: vec!["en".into()],
            label_value: vec![String::new()],
            ..Default::default()
        }
    }

    /// An option's edit form: its labels, or one English row.
    pub fn of(o: &DimensionOption) -> Self {
        let labels: Vec<(String, String)> =
            o.label_i18n.as_ref().map(|l| l.values.clone().into_iter().collect()).unwrap_or_default();
        let (label_locale, label_value) =
            if labels.is_empty() { (vec!["en".into()], vec![String::new()]) } else { labels.into_iter().unzip() };
        OptionInput {
            option_id: o.option_id.clone(),
            code: o.code.clone(),
            numeric_value: o.numeric_value.map(|n| n.to_string()).unwrap_or_default(),
            label_locale,
            label_value,
            relabel: None,
        }
    }

    /// The label rows, as many as the longer of the two lists.
    pub fn labels(&self) -> Vec<(&str, &str)> {
        fn at(list: &[String], i: usize) -> &str {
            list.get(i).map(String::as_str).unwrap_or("")
        }
        let rows = self.label_locale.len().max(self.label_value.len());
        (0..rows).map(|i| (at(&self.label_locale, i), at(&self.label_value, i))).collect()
    }

    /// The form after its `relabel` button: a row more, or a row less. `None` for a submit.
    pub fn relabeled(&self) -> Option<Self> {
        let button = self.relabel.as_deref()?;
        let (mut locales, mut values): (Vec<String>, Vec<String>) =
            self.labels().into_iter().map(|(l, v)| (l.to_owned(), v.to_owned())).unzip();
        match button {
            "add" => {
                locales.push(String::new());
                values.push(String::new());
            }
            index => {
                if let Ok(i) = index.parse::<usize>()
                    && i < locales.len()
                {
                    locales.remove(i);
                    values.remove(i);
                }
            }
        }
        Some(OptionInput { label_locale: locales, label_value: values, relabel: None, ..self.clone() })
    }

    /// `addOption`'s body (with the id) or `reviseOption`'s, or the number that does not parse.
    pub fn body(&self, p: Pilot, add: bool) -> Result<Value, Errors> {
        let numeric = self.numeric_value.trim();
        let number = if numeric.is_empty() {
            None
        } else {
            match numeric.parse::<f64>() {
                Ok(n) if n.is_finite() => Some(n),
                _ => {
                    let mut errors = Errors::new();
                    errors.add(Self::FIELDS.numeric_value, p.check_number());
                    return Err(errors);
                }
            }
        };
        // labelEntriesToMap: the rows with a locale and a text, or the code in English.
        let values: Map<String, Value> = self
            .labels()
            .into_iter()
            .map(|(l, v)| (l.trim(), v.trim()))
            .filter(|(l, v)| !l.is_empty() && !v.is_empty())
            .map(|(l, v)| (l.to_owned(), json!(v)))
            .collect();
        let label = if values.is_empty() { english(&self.code) } else { json!({ "defaultLocale": "en", "values": values }) };
        let mut body = json!({ "code": self.code, "label": label });
        if let Some(n) = number {
            body["numericValue"] = json!(n);
        }
        if add {
            body["optionId"] = json!(self.option_id);
        }
        Ok(body)
    }
}

/// The reorder form: option ids, comma-separated, as admin-web asks for them.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ReorderInput {
    pub option_ids: String,
}

impl ReorderInput {
    pub fn body(&self) -> Value {
        let ids: Vec<&str> = self.option_ids.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        json!({ "optionIds": ids })
    }
}

/// A lifecycle form: the action its button names, and the status it was drawn for (only to draw
/// the form again after a refusal; the API decides what the status allows).
#[derive(Clone, Debug, Default, Deserialize, Fields)]
#[serde(default)]
pub struct ActionInput {
    pub action: String,
    pub status: String,
}

impl ActionInput {
    /// The action, when it is one of `allowed`.
    pub fn of<'a>(&self, allowed: &[&'a str]) -> Option<&'a str> {
        allowed.iter().copied().find(|a| *a == self.action)
    }
}

/// A bulk change's form: the action, and which records (`mode`, as the API's `selection.mode`):
/// the checked rows (`mode=ids`, their boxes join the form with `form=`) or every record the
/// list's filters match (`mode=filter`).
/// `all` is the select-all box, which joins the form so its script finds it; it is not read.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct BulkInput {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub ids: Vec<String>,
    /// Only its name is used (the select-all box's), so markup and script agree on it.
    #[serde(default)]
    #[allow(dead_code)]
    pub all: bool,
}

impl BulkInput {
    /// The API's `{ action, selection }`, the filter's query being `filter`
    /// (`BulkLifecycleSelection`).
    pub fn body(&self, filter: Value) -> Value {
        let selection = if self.mode == "filter" {
            json!({ "mode": "filter", "query": filter })
        } else {
            json!({ "mode": "ids", "ids": self.ids })
        };
        json!({ "action": self.action, "selection": selection })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_built_as_admin_webs_pages_build_them() {
        let d = DimensionInput { dimension_id: "dim_1".into(), key: "k".into(), name: " Size ".into(), ..Default::default() };
        assert_eq!(
            d.body(true),
            json!({ "dimensionId": "dim_1", "key": "k", "name": { "defaultLocale": "en", "values": { "en": "Size" } },
                    "description": { "defaultLocale": "en", "values": {} }, "valueKind": "" })
        );
        assert!(d.body(false).get("dimensionId").is_none());

        let o = OptionInput {
            code: "nm".into(),
            label_locale: vec!["en".into(), "fr".into(), "".into()],
            label_value: vec!["Near mint".into(), " ".into(), "x".into()],
            ..Default::default()
        };
        let body = o.body(Pilot::default(), false).unwrap();
        assert_eq!(body["label"], json!({ "defaultLocale": "en", "values": { "en": "Near mint" } }));
        assert!(body.get("numericValue").is_none());
        let unlabeled = OptionInput { code: "lp".into(), numeric_value: "2.5".into(), ..Default::default() };
        let body = unlabeled.body(Pilot::default(), true).unwrap();
        assert_eq!((body["label"]["values"]["en"].as_str(), body["numericValue"].as_f64()), (Some("lp"), Some(2.5)));
        assert!(OptionInput { numeric_value: "two".into(), ..Default::default() }.body(Pilot::default(), true).is_err());
    }

    #[test]
    fn a_relabel_button_adds_or_removes_a_row() {
        let o = OptionInput { label_locale: vec!["en".into()], label_value: vec!["A".into()], ..Default::default() };
        assert!(o.relabeled().is_none(), "a submit");
        let added = OptionInput { relabel: Some("add".into()), ..o.clone() }.relabeled().unwrap();
        assert_eq!(added.labels(), [("en", "A"), ("", "")]);
        let removed = OptionInput { relabel: Some("0".into()), ..added }.relabeled().unwrap();
        assert_eq!(removed.labels(), [("", "")]);
        assert!(new_id("dim").starts_with("dim_") && new_id("dim").len() == 30);
    }
}
