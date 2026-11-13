//! A repricing policy's body as the editor writes it: marketplace's `PolicyEditorBody` (the dry
//! run's body with the policy's name), the authoring intent that lets a preset or a Pricing Goal
//! open in its simple controls again (`domain/authoring-intent.ts`), and what the structured and
//! advanced editors' controls do to it (`policy-controls-fields.tsx`, `policy-editor-drawer.tsx`).
//!
//! The body stays Pricing's JSON rather than a type of the pilot's, so whatever the editor does not
//! draw goes back as it was read. The editor's post carries the body it drew (`body`) and the
//! controls drawn over it: [`read`] lays the controls on the body as marketplace's `onChange`
//! handlers do, a changed choice (a mode, a condition's type, an anchor's source) starting that
//! part again from its defaults, and an [`Op`] is a button that adds, removes or moves a rule, a
//! condition or an anchor. A change to what the policy does drops the authoring intent
//! (`changeBody`); the Pricing Goal's simple controls bind it again (`changeSimpleGoal`).
//!
//! A rule's conditions and anchors are rows of their own keyed by the rule and their place
//! (`{rule}-{index}`), since a Corten form's row cannot hold rows (see the README's open
//! workarounds).
use std::collections::BTreeMap;

use corten::prelude::*;
use serde_json::{Map, Value, json};

use crate::repricing::Preset;

/// A whole number when it is one, so the body says 10 and not 10.0, as the browser's JSON does.
pub fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 { json!(n as i64) } else { json!(n) }
}

/// `JSON.stringify` of a number: an integer without a fraction, and no `-0`.
fn js_number(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().unwrap_or_default();
    if f == 0.0 {
        "0".to_owned()
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        f.to_string()
    }
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
        Value::Number(n) => out.push_str(&js_number(n)),
        other => out.push_str(&other.to_string()),
    }
}

/// The body's JSON with each object's keys in order (`canonical`), as marketplace writes it to
/// compare two bodies.
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

/// What a policy does, without its name or intent (`authoringBodyKey`): its scope, exclusions,
/// rules and daily cap.
pub fn body_key(body: &Value) -> String {
    let mut key = Map::new();
    for field in ["scope", "rules", "maxChangesPerDay"] {
        if let Some(value) = body.get(field) {
            key.insert(field.to_owned(), value.clone());
        }
    }
    let excluded = body.get("excludedListingIds").filter(|ids| !ids.is_null()).cloned().unwrap_or_else(|| json!([]));
    key.insert("excludedListingIds".to_owned(), excluded);
    canonical(&Value::Object(key))
}

/// The body with the authoring intent of `source` (`bindAuthoringIntent`).
pub fn bind(body: &mut Value, source: Value) {
    let semantic = body_key(body);
    body["authoringIntent"] = json!({ "version": 1, "compilerVersion": 1, "source": source, "semanticBody": semantic });
}

/// What a recognized authoring intent was written with.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Preset { preset: Preset, knob: f64, age: i64 },
    Goal { goal_id: String, goal_version: f64 },
}

/// A preset's body (`compilePresetBody`), its intent bound.
#[allow(clippy::too_many_arguments)]
pub fn compile_preset(preset: Preset, name: &str, currency: &str, floor: Value, knob: f64, age: i64, scope: Value) -> Value {
    let anchors = match preset {
        Preset::Beat => json!([{ "source": "lowest-competing-ask" }, { "source": "market-estimate" }]),
        Preset::Premium => json!([{ "source": "comp-percentile", "percentile": 75 }, { "source": "market-estimate" }]),
        Preset::Track | Preset::Slow => {
            json!([{ "source": "market-estimate" }, { "source": "lowest-competing-ask" }, { "source": "last-sold" }])
        }
    };
    let percent = if matches!(preset, Preset::Beat | Preset::Slow) { -knob } else { knob };
    let tolerance = match preset {
        Preset::Beat => 1,
        Preset::Premium => 3,
        Preset::Track | Preset::Slow => 2,
    };
    let max_move = match preset {
        Preset::Premium => 15,
        Preset::Slow => 25,
        Preset::Track | Preset::Beat => 20,
    };
    let directive = json!({
        "currencyCode": currency,
        "anchorChain": anchors,
        "offset": { "mode": "percent", "percent": number(percent) },
        "floor": floor,
        "ceiling": null,
        "tolerance": { "mode": "percent", "percent": tolerance },
        "rounding": { "mode": "none" },
        "maxMovePercent": max_move,
        "terminal": { "kind": "hold" },
    });
    let rules = if preset == Preset::Slow {
        let mut rest = directive.clone();
        rest["offset"] = json!({ "mode": "percent", "percent": 0 });
        rest["tolerance"] = json!({ "mode": "percent", "percent": 5 });
        rest["maxMovePercent"] = json!(10);
        json!([
            { "conditions": [{ "type": "listing-age-at-least", "days": age }], "directive": directive },
            { "conditions": [], "directive": rest },
        ])
    } else {
        json!([{ "conditions": [], "directive": directive }])
    };
    let mut body = json!({
        "name": name,
        "scope": scope,
        "excludedListingIds": [],
        "maxChangesPerDay": 250,
        "rules": rules,
    });
    bind(&mut body, json!({ "kind": "preset", "preset": preset.key(), "knob": number(knob), "ageDays": age }));
    body
}

fn is_one(value: &Value) -> bool {
    value.as_f64() == Some(1.0)
}

/// The intent the body's own rules still say (`recognizeAuthoringIntent` without the goal
/// registry, as the browser's editor calls it): a preset only when compiling it again gives these
/// rules, and a Pricing Goal only when the policy is that goal's one rule. Whether a seller may
/// choose the goal's version is the editor's to check (`goalAdoption`).
pub fn recognize(body: &Value) -> Option<Source> {
    let intent = body.get("authoringIntent")?;
    let semantic = intent.get("semanticBody")?.as_str()?;
    if !is_one(&intent["version"]) || !is_one(&intent["compilerVersion"]) || semantic != body_key(body) {
        return None;
    }
    let source = &intent["source"];
    match source["kind"].as_str()? {
        "preset" => {
            let preset = Preset::read(source["preset"].as_str()?)?;
            let (knob, age) = (source["knob"].as_f64()?, source["ageDays"].as_f64()?);
            let (min, max, _) = preset.knob();
            let directive = &body["rules"][0]["directive"];
            let currency = directive["currencyCode"].as_str().filter(|code| !code.is_empty())?;
            if !knob.is_finite() || knob < min as f64 || knob > max as f64 || age.fract() != 0.0 || !(14.0..=180.0).contains(&age)
            {
                return None;
            }
            let compiled =
                compile_preset(preset, "", currency, directive["floor"].clone(), knob, age as i64, body["scope"].clone());
            (body_key(&compiled) == semantic).then_some(Source::Preset { preset, knob, age: age as i64 })
        }
        "goal" => {
            let parameters = source.get("parameters").filter(|p| p.is_object())?;
            let rules = body["rules"].as_array()?;
            let rule = rules.first()?;
            let chain = rule["directive"]["anchorChain"].as_array()?;
            let anchor = chain.first()?;
            let conditions = rule["conditions"].as_array().map_or(0, Vec::len);
            if rules.len() != 1 || conditions != 0 || chain.len() != 1 || anchor["source"] != "curve-objective" {
                return None;
            }
            let (goal_id, goal_version) = (source["goalId"].as_str()?, source["goalVersion"].as_f64()?);
            let same = anchor["goalId"].as_str() == Some(goal_id)
                && anchor["goalVersion"].as_f64() == Some(goal_version)
                && canonical(&anchor["parameters"]) == canonical(parameters);
            same.then(|| Source::Goal { goal_id: goal_id.to_owned(), goal_version })
        }
        _ => None,
    }
}

/// The first Pricing Goal any rule anchors on, as the editor checks it (`goalAnchor`).
pub fn goal_anchor(body: &Value) -> Option<&Value> {
    body["rules"]
        .as_array()?
        .iter()
        .flat_map(|rule| rule["directive"]["anchorChain"].as_array().into_iter().flatten())
        .find(|anchor| anchor["source"] == "curve-objective")
}

/// Which of the editor's controls draw the body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    /// Choose a strategy.
    Preset,
    /// A Pricing Goal's floor and cap.
    Goal,
    /// One rule's directive.
    Structured,
    /// Every rule, its conditions, and each anchor's listing stratum.
    Advanced,
}

impl Tier {
    pub fn key(self) -> &'static str {
        match self {
            Tier::Preset => "preset",
            Tier::Goal => "goal",
            Tier::Structured => "structured",
            Tier::Advanced => "advanced",
        }
    }

    pub fn read(key: &str) -> Option<Tier> {
        [Tier::Preset, Tier::Goal, Tier::Structured, Tier::Advanced].into_iter().find(|tier| tier.key() == key)
    }

    /// The tier a body opens in (`openRepricingPreset`): its intent's, else `requested`, else the
    /// structured editor for one rule and the advanced editor for more. A Pricing Goal whose version
    /// a seller may not choose opens in `requested` or the structured editor.
    pub fn opened(body: &Value, selectable: impl Fn(&str, f64) -> bool, requested: Option<Tier>) -> Tier {
        match recognize(body) {
            Some(Source::Preset { .. }) => Tier::Preset,
            Some(Source::Goal { goal_id, goal_version }) if selectable(&goal_id, goal_version) => Tier::Goal,
            Some(Source::Goal { .. }) => requested.unwrap_or(Tier::Structured),
            None => requested.unwrap_or(if rules_of(body).len() == 1 { Tier::Structured } else { Tier::Advanced }),
        }
    }
}

/// The body's rules.
pub fn rules_of(body: &Value) -> &[Value] {
    body["rules"].as_array().map_or(&[], Vec::as_slice)
}

/// A condition or anchor row's key: its rule and its place in the rule.
pub fn slot(rule: usize, index: usize) -> String {
    format!("{rule}-{index}")
}

/// One rule's directive as the editor posts it. A choice's value field is the one its choice draws.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleFields {
    pub currency: Option<String>,
    pub offset: Option<String>,
    pub offset_value: Option<String>,
    pub floor: Option<String>,
    pub amount: Option<String>,
    pub margin: Option<String>,
    pub fallback: Option<String>,
    pub ceiling: Option<String>,
    pub ceiling_value: Option<String>,
    pub tolerance: Option<String>,
    pub tolerance_value: Option<String>,
    pub rounding: Option<String>,
    pub increment: Option<String>,
    pub max_move: Option<String>,
    pub terminal: Option<String>,
    pub terminal_value: Option<String>,
}

/// A rule's condition as the editor posts it.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct ConditionFields {
    pub kind: Option<String>,
    pub category: Option<String>,
    pub grading: Option<String>,
    pub value: Option<String>,
    pub cost: Option<String>,
    #[serde(default)]
    pub days: Vec<String>,
    pub start: Option<String>,
    pub end: Option<String>,
}

/// An anchor of a rule's chain as the editor posts it.
#[derive(Clone, Debug, Default, Fields)]
#[serde(rename_all = "camelCase", default)]
pub struct AnchorFields {
    pub source: Option<String>,
    pub percentile: Option<String>,
    pub strata: Option<String>,
    pub band: Option<String>,
}

/// What the editor's post drew over the body.
pub struct Posted<'a> {
    pub name: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub categories: &'a [String],
    pub listings: Option<&'a str>,
    pub excluded: Option<&'a str>,
    pub cap: Option<&'a str>,
    pub rules: &'a BTreeMap<u32, RuleFields>,
    pub conditions: &'a BTreeMap<String, ConditionFields>,
    pub anchors: &'a BTreeMap<String, AnchorFields>,
}

/// Text as typed, trimmed.
fn text(value: Option<&String>) -> Option<String> {
    value.map(|value| value.trim().to_owned())
}

/// A number field: a number, or null when it is blank or not one (marketplace's `NaN`).
fn numeric(value: &str) -> Value {
    value.trim().parse::<f64>().ok().filter(|n| n.is_finite()).map_or(Value::Null, number)
}

/// Each value once, trimmed, in order; empty ones left out.
pub fn distinct(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// The scope its controls say (`PolicyScopeFields`): a new kind starts empty.
pub fn scope(kind: &str, categories: &[String], listings: Option<&str>) -> Value {
    match kind {
        "catalog-filter" => json!({ "kind": "catalog-filter", "categoryIds": distinct(categories.iter().cloned()) }),
        "listing-set" => {
            json!({ "kind": "listing-set", "listingIds": distinct(listings.unwrap_or_default().split(',').map(str::to_owned)) })
        }
        _ => json!({ "kind": "all-listings" }),
    }
}

/// A new condition of `kind` (`newPolicyCondition`).
pub fn new_condition(kind: &str) -> Option<Value> {
    Some(match kind {
        "category" => json!({ "type": kind, "categoryId": "" }),
        "item-grading" => json!({ "type": kind, "grading": "raw" }),
        "quantity-at-least" => json!({ "type": kind, "quantity": null }),
        "listing-age-at-least" => json!({ "type": kind, "days": null }),
        "competing-listing-count-at-least" => json!({ "type": kind, "count": null }),
        "schedule-window" => json!({ "type": kind, "daysOfWeek": [], "startTime": "", "endTime": "" }),
        "cost-basis-present" | "cost-basis-absent" => json!({ "type": kind }),
        _ => return None,
    })
}

/// A new anchor of `source` (`newAnchor`).
pub fn new_anchor(source: &str) -> Value {
    match source {
        "comp-percentile" => json!({ "source": source, "percentile": null }),
        "lowest-competing-ask" | "last-sold" => json!({ "source": source }),
        _ => json!({ "source": "market-estimate" }),
    }
}

/// The condition types in the editor's order (`policyControls.condition`).
pub const CONDITIONS: [&str; 8] = [
    "category",
    "item-grading",
    "quantity-at-least",
    "listing-age-at-least",
    "cost-basis-present",
    "cost-basis-absent",
    "competing-listing-count-at-least",
    "schedule-window",
];

/// The anchors a seller may choose (`anchorControlItems`: a Pricing Goal is not one).
pub const ANCHORS: [&str; 4] = ["market-estimate", "lowest-competing-ask", "comp-percentile", "last-sold"];

/// The number a condition of `kind` holds, by its key.
pub fn condition_number(kind: &str) -> Option<&'static str> {
    match kind {
        "quantity-at-least" => Some("quantity"),
        "listing-age-at-least" => Some("days"),
        "competing-listing-count-at-least" => Some("count"),
        _ => None,
    }
}

/// A choice between modes, each with its own fields: `chosen` when it is a mode of `modes` and
/// not the current one starts again from that mode's default; otherwise `keep` reads its fields.
fn choose(current: &mut Value, tag: &str, chosen: Option<&str>, defaults: &[(&str, Value)], keep: impl FnOnce(&mut Value)) {
    let now = current.get(tag).and_then(Value::as_str).unwrap_or_default().to_owned();
    match chosen.and_then(|mode| defaults.iter().find(|(key, _)| *key == mode)) {
        Some((mode, default)) if *mode != now => *current = default.clone(),
        _ => keep(current),
    }
}

/// The floor its controls say (`PolicyFloorFields`).
fn floor(
    current: &mut Value,
    mode: Option<&String>,
    amount: Option<&String>,
    margin: Option<&String>,
    fallback: Option<&String>,
) {
    let defaults = [
        ("absolute", json!({ "mode": "absolute", "amount": "" })),
        (
            "cost-basis-plus-margin",
            json!({ "mode": "cost-basis-plus-margin", "marginPercent": 10, "absoluteFallbackAmount": "" }),
        ),
    ];
    choose(current, "mode", mode.map(String::as_str), &defaults, |floor| match floor["mode"].as_str() {
        Some("absolute") => {
            if let Some(amount) = text(amount) {
                floor["amount"] = json!(amount);
            }
        }
        Some("cost-basis-plus-margin") => {
            if let Some(margin) = margin {
                floor["marginPercent"] = numeric(margin);
            }
            if let Some(fallback) = text(fallback) {
                floor["absoluteFallbackAmount"] = json!(fallback);
            }
        }
        _ => {}
    });
}

/// A directive its controls say (`PolicyDirectiveFields`), but its anchors.
fn directive(directive: &mut Value, f: &RuleFields) {
    if let Some(currency) = text(f.currency.as_ref()) {
        directive["currencyCode"] = json!(currency);
    }
    let percent_or_amount = |part: &mut Value, value: Option<&String>| match part["mode"].as_str() {
        Some("percent") => {
            if let Some(value) = value {
                part["percent"] = numeric(value);
            }
        }
        Some("absolute") => {
            if let Some(value) = text(value) {
                part["amount"] = json!(value);
            }
        }
        _ => {}
    };
    let modes = || {
        [("percent", json!({ "mode": "percent", "percent": null })), ("absolute", json!({ "mode": "absolute", "amount": "" }))]
    };
    choose(&mut directive["offset"], "mode", f.offset.as_deref(), &modes(), |part| {
        percent_or_amount(part, f.offset_value.as_ref())
    });
    floor(&mut directive["floor"], f.floor.as_ref(), f.amount.as_ref(), f.margin.as_ref(), f.fallback.as_ref());
    match f.ceiling.as_deref() {
        Some("none") => directive["ceiling"] = Value::Null,
        chosen => {
            if directive["ceiling"].is_null() {
                if let Some((_, default)) = modes().into_iter().find(|(mode, _)| Some(*mode) == chosen) {
                    directive["ceiling"] = default;
                }
            } else {
                choose(&mut directive["ceiling"], "mode", chosen, &modes(), |part| {
                    percent_or_amount(part, f.ceiling_value.as_ref())
                });
            }
        }
    }
    choose(&mut directive["tolerance"], "mode", f.tolerance.as_deref(), &modes(), |part| {
        percent_or_amount(part, f.tolerance_value.as_ref())
    });
    let rounding = [
        ("none", json!({ "mode": "none" })),
        ("charm", json!({ "mode": "charm" })),
        ("increment", json!({ "mode": "increment", "incrementAmount": "" })),
    ];
    choose(&mut directive["rounding"], "mode", f.rounding.as_deref(), &rounding, |part| {
        if part["mode"] == "increment"
            && let Some(amount) = text(f.increment.as_ref())
        {
            part["incrementAmount"] = json!(amount);
        }
    });
    if let Some(max_move) = &f.max_move {
        directive["maxMovePercent"] = numeric(max_move);
    }
    let terminals = [
        ("hold", json!({ "kind": "hold" })),
        ("pause", json!({ "kind": "pause", "reason": "" })),
        ("fallback-price", json!({ "kind": "fallback-price", "amount": "" })),
        ("price-at-floor", json!({ "kind": "price-at-floor" })),
        ("notify-only", json!({ "kind": "notify-only" })),
    ];
    choose(&mut directive["terminal"], "kind", f.terminal.as_deref(), &terminals, |part| {
        let key = match part["kind"].as_str() {
            Some("pause") => "reason",
            Some("fallback-price") => "amount",
            _ => return,
        };
        if let Some(value) = text(f.terminal_value.as_ref()) {
            part[key] = json!(value);
        }
    });
}

/// A condition its controls say (`PolicyConditionFields`): a new type starts from its default.
fn condition(current: &mut Value, f: &ConditionFields) {
    let now = current["type"].as_str().unwrap_or_default().to_owned();
    // Cost basis present or absent is one control of two words (`toggle-pair`).
    let chosen = match (f.kind.as_deref(), f.cost.as_deref()) {
        (Some(kind), _) if kind != now => Some(kind),
        (_, Some(cost)) if now.starts_with("cost-basis-") && cost != now => Some(cost),
        _ => None,
    };
    if let Some(fresh) = chosen.and_then(new_condition) {
        *current = fresh;
        return;
    }
    match now.as_str() {
        "category" => {
            if let Some(category) = text(f.category.as_ref()) {
                current["categoryId"] = json!(category);
            }
        }
        "item-grading" => {
            if let Some(grading) = &f.grading {
                current["grading"] = json!(if grading == "graded" { "graded" } else { "raw" });
            }
        }
        "schedule-window" => {
            let days: Vec<Value> =
                (0..7u8).filter(|day| f.days.iter().any(|d| d == &day.to_string())).map(|day| json!(day)).collect();
            current["daysOfWeek"] = Value::Array(days);
            if let Some(start) = text(f.start.as_ref()) {
                current["startTime"] = json!(start);
            }
            if let Some(end) = text(f.end.as_ref()) {
                current["endTime"] = json!(end);
            }
        }
        kind => {
            if let (Some(key), Some(value)) = (condition_number(kind), &f.value) {
                current[key] = numeric(value);
            }
        }
    }
}

/// An anchor its controls say: a new source starts from its default, and in the advanced editor a
/// lowest competing ask of any kind brings its band.
fn anchor(current: &mut Value, f: &AnchorFields, advanced: bool) {
    let source = current["source"].as_str().unwrap_or_default().to_owned();
    if source == "curve-objective" {
        return;
    }
    if let Some(chosen) = f.source.as_deref().filter(|chosen| *chosen != source && ANCHORS.contains(chosen)) {
        *current = new_anchor(chosen);
        return;
    }
    match source.as_str() {
        "comp-percentile" => {
            if let Some(percentile) = &f.percentile {
                current["percentile"] = numeric(percentile);
            }
        }
        "lowest-competing-ask" => {
            let strata = current["strata"].as_str().unwrap_or("hard").to_owned();
            match f.strata.as_deref().filter(|_| advanced) {
                Some("any") if strata != "any" => {
                    *current = json!({ "source": source, "strata": "any", "band": { "ground": "market-estimate", "minPercentOfGround": null } });
                }
                Some("hard") if strata != "hard" => *current = json!({ "source": source, "strata": "hard" }),
                _ => {
                    if strata == "any"
                        && let Some(band) = &f.band
                    {
                        current["band"] = json!({ "ground": "market-estimate", "minPercentOfGround": numeric(band) });
                    }
                }
            }
        }
        _ => {}
    }
}

/// The body with what the post drew over it in `tier` (not the preset tier, whose controls
/// compile a body of their own). A change to what the policy does drops its intent, but in a
/// Pricing Goal's controls, which bind the goal's intent again.
pub fn read(body: &mut Value, tier: Tier, posted: &Posted<'_>) {
    let before = body_key(body);
    let goal = match (tier, recognize(body)) {
        (Tier::Goal, Some(Source::Goal { .. })) => Some(body["authoringIntent"]["source"].clone()),
        _ => None,
    };
    if let Some(name) = posted.name {
        body["name"] = json!(name.trim());
    }
    if let Some(kind) = posted.scope {
        body["scope"] = scope(kind, posted.categories, posted.listings);
    }
    if let Some(cap) = posted.cap {
        body["maxChangesPerDay"] = numeric(cap);
    }
    let count = rules_of(body).len();
    match tier {
        Tier::Goal => {
            // One floor for every rule, drawn with the first rule's controls.
            if let Some(f) = posted.rules.get(&0) {
                for rule in body["rules"].as_array_mut().into_iter().flatten() {
                    floor(
                        &mut rule["directive"]["floor"],
                        f.floor.as_ref(),
                        f.amount.as_ref(),
                        f.margin.as_ref(),
                        f.fallback.as_ref(),
                    );
                }
            }
        }
        Tier::Structured | Tier::Advanced => {
            if let Some(excluded) = posted.excluded {
                body["excludedListingIds"] = json!(distinct(excluded.split(',').map(str::to_owned)));
            }
            for (i, rule) in body["rules"].as_array_mut().into_iter().flatten().enumerate() {
                if let Some(f) = u32::try_from(i).ok().and_then(|i| posted.rules.get(&i)) {
                    directive(&mut rule["directive"], f);
                }
                if tier == Tier::Advanced && i + 1 != count {
                    for (j, current) in rule["conditions"].as_array_mut().into_iter().flatten().enumerate() {
                        if let Some(f) = posted.conditions.get(&slot(i, j)) {
                            condition(current, f);
                        }
                    }
                }
                for (j, current) in rule["directive"]["anchorChain"].as_array_mut().into_iter().flatten().enumerate() {
                    if let Some(f) = posted.anchors.get(&slot(i, j)) {
                        anchor(current, f, tier == Tier::Advanced);
                    }
                }
            }
        }
        Tier::Preset => {}
    }
    match goal {
        Some(source) => bind(body, source),
        None => unbind_if_changed(body, &before),
    }
}

/// Drops the intent when what the policy does is not what it was (`changeBody`).
pub fn unbind_if_changed(body: &mut Value, before: &str) {
    if body_key(body) != before {
        body["authoringIntent"] = Value::Null;
    }
}

/// A button of the structured and advanced editors that changes the rules' shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    AddRule,
    MoveRuleUp(usize),
    RemoveRule(usize),
    AddCondition(usize),
    RemoveCondition(usize, usize),
    AddAnchor(usize),
    MoveAnchorUp(usize, usize),
    RemoveAnchor(usize, usize),
}

impl Op {
    /// The button's value.
    pub fn value(self) -> String {
        match self {
            Op::AddRule => "add-rule".to_owned(),
            Op::MoveRuleUp(i) => format!("move-rule-up:{i}"),
            Op::RemoveRule(i) => format!("remove-rule:{i}"),
            Op::AddCondition(i) => format!("add-condition:{i}"),
            Op::RemoveCondition(i, j) => format!("remove-condition:{i}:{j}"),
            Op::AddAnchor(i) => format!("add-anchor:{i}"),
            Op::MoveAnchorUp(i, j) => format!("move-anchor-up:{i}:{j}"),
            Op::RemoveAnchor(i, j) => format!("remove-anchor:{i}:{j}"),
        }
    }

    pub fn read(value: &str) -> Option<Op> {
        let mut parts = value.split(':');
        let name = parts.next()?;
        let numbers: Vec<usize> = parts.map(str::parse).collect::<Result<_, _>>().ok()?;
        Some(match (name, numbers.as_slice()) {
            ("add-rule", []) => Op::AddRule,
            ("move-rule-up", [i]) => Op::MoveRuleUp(*i),
            ("remove-rule", [i]) => Op::RemoveRule(*i),
            ("add-condition", [i]) => Op::AddCondition(*i),
            ("remove-condition", [i, j]) => Op::RemoveCondition(*i, *j),
            ("add-anchor", [i]) => Op::AddAnchor(*i),
            ("move-anchor-up", [i, j]) => Op::MoveAnchorUp(*i, *j),
            ("remove-anchor", [i, j]) => Op::RemoveAnchor(*i, *j),
            _ => return None,
        })
    }

    /// Does what the button says to the body, if the body has what it names. A rule's conditions
    /// and its moves are the advanced editor's, for every rule but the default, which stays last.
    pub fn apply(self, body: &mut Value) {
        let Some(rules) = body["rules"].as_array_mut() else { return };
        let len = rules.len();
        let ordinary = |i: usize| i + 1 < len;
        match self {
            Op::AddRule => {
                if let Some(last) = rules.last().cloned() {
                    let mut rule = last;
                    rule["conditions"] = json!([new_condition("category")]);
                    let at = rules.len() - 1;
                    rules.insert(at, rule);
                }
            }
            Op::MoveRuleUp(i) if i > 0 && ordinary(i) => rules.swap(i - 1, i),
            Op::RemoveRule(i) if ordinary(i) => {
                rules.remove(i);
            }
            Op::AddCondition(i) if ordinary(i) => {
                if let Some(conditions) = rules[i]["conditions"].as_array_mut() {
                    conditions.extend(new_condition("category"));
                }
            }
            Op::RemoveCondition(i, j) if ordinary(i) => {
                if let Some(conditions) = rules[i]["conditions"].as_array_mut().filter(|c| j < c.len()) {
                    conditions.remove(j);
                }
            }
            Op::AddAnchor(i) => {
                if let Some(chain) = rules.get_mut(i).and_then(|rule| rule["directive"]["anchorChain"].as_array_mut()) {
                    chain.push(json!({ "source": "market-estimate" }));
                }
            }
            Op::MoveAnchorUp(i, j) if j > 0 => {
                if let Some(chain) =
                    rules.get_mut(i).and_then(|rule| rule["directive"]["anchorChain"].as_array_mut()).filter(|c| j < c.len())
                {
                    chain.swap(j - 1, j);
                }
            }
            Op::RemoveAnchor(i, j) => {
                if let Some(chain) =
                    rules.get_mut(i).and_then(|rule| rule["directive"]["anchorChain"].as_array_mut()).filter(|c| j < c.len())
                {
                    chain.remove(j);
                }
            }
            _ => {}
        }
    }
}
