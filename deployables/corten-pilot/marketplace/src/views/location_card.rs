use corten::{form::Within, prelude::*, view::Id};

use super::{Draft, WriteForm};
use crate::{api::Location, app::url, auth::Viewer, form::LocationInput, recovery::Family, text::Msg};

/// The create form's id: a refused create's patch replaces it.
#[derive(Id, Clone, Copy)]
pub struct CreateFormId;

/// A location's save form.
#[derive(Id, Clone, Copy)]
pub struct LocationFormId<'a>(pub &'a str);

/// A location's archive form.
#[derive(Id)]
pub struct ArchiveFormId<'a>(pub &'a str);

/// How an input takes its text.
#[derive(Clone, Copy)]
pub enum Kind {
    Text,
    Email,
    Area,
}

/// A labelled input, its error next to it. The error is outside the label, so it is not part of
/// the input's name (it describes it).
#[component(css = LocationCard)]
pub fn Field<'a, I: Id>(
    label: &'a str,
    name: FieldName<String>,
    value: &'a str,
    kind: Kind,
    required: bool,
    errors: &'a Within<'a, I>,
) -> impl Render {
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                match kind {
                    Kind::Area => {
                        <textarea name={name} rows="3" required={required} {..errors.aria(name)}>{value}</textarea>
                    }
                    Kind::Email => {
                        <input type="email" name={name} value={value} required={required} {..errors.aria(name)}>
                    }
                    Kind::Text => {
                        <input type="text" name={name} value={value} required={required} {..errors.aria(name)}>
                    }
                }
            </label>
            {errors.message(name)}
        </div>
    }
}

/// A location's fields: the create form and each location's save form. marketplace labels the
/// two from separate keys (`name` and `name.2`, ...), which hold the same text.
#[component(css = LocationCard)]
pub fn LocationFields<'a, I: Id + Copy>(t: Msg, form_id: I, draft: &'a Draft, create: bool) -> impl Render {
    let f = LocationInput::FIELDS;
    let (i, e) = (&draft.input, draft.errors.within(form_id));
    let (name, description, code) = if create {
        (t.page_name(), t.page_description(), t.page_ship_from_code())
    } else {
        (t.page_name_2(), t.page_description_2(), t.page_ship_from_code_2())
    };
    html! {
        <div class={Fields}>
            <Field label={name} name={f.name} value={&i.name} kind={Kind::Text} required errors={&e} />
            <Field
                label={description}
                name={f.description}
                value={&i.description}
                kind={Kind::Area}
                required={false}
                errors={&e}
            />
            <Field label={code} name={f.ship_from_code} value={&i.ship_from_code} kind={Kind::Text} required errors={&e} />
            <Field
                label={t.page_ship_from_name()}
                name={f.ship_from_name}
                value={&i.ship_from_name}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.page_ship_from_company()}
                name={f.ship_from_company}
                value={&i.ship_from_company}
                kind={Kind::Text}
                required={false}
                errors={&e}
            />
            <Field
                label={t.page_ship_from_line1()}
                name={f.ship_from_line1}
                value={&i.ship_from_line1}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.page_ship_from_line2()}
                name={f.ship_from_line2}
                value={&i.ship_from_line2}
                kind={Kind::Text}
                required={false}
                errors={&e}
            />
            <Field
                label={t.page_ship_from_city()}
                name={f.ship_from_city}
                value={&i.ship_from_city}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.page_ship_from_state()}
                name={f.ship_from_state}
                value={&i.ship_from_state}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.page_ship_from_postal_code()}
                name={f.ship_from_postal_code}
                value={&i.ship_from_postal_code}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.page_ship_from_country()}
                name={f.ship_from_country}
                value={&i.ship_from_country}
                kind={Kind::Text}
                required
                errors={&e}
            />
            <Field
                label={t.page_ship_from_phone()}
                name={f.ship_from_phone}
                value={&i.ship_from_phone}
                kind={Kind::Text}
                required={false}
                errors={&e}
            />
            <Field
                label={t.page_ship_from_email()}
                name={f.ship_from_email}
                value={&i.ship_from_email}
                kind={Kind::Email}
                required={false}
                errors={&e}
            />
        </div>
    }
}

/// Create a location.
#[component(css = LocationCard)]
pub fn CreateForm<'a>(t: Msg, viewer: &'a Viewer, draft: &'a Draft, enabled: bool) -> impl Patch {
    html! {
        <WriteForm
            t={t}
            id={CreateFormId}
            action={url::Locations::default()}
            viewer={viewer}
            family={Family::Create}
            target="draft"
            attempt={LocationInput::FIELDS.attempt}
            errors={&draft.errors}
            enabled={enabled}
        >
            <LocationFields t={t} form_id={CreateFormId} draft={draft} create />
            <div class={Buttons}><button type="submit">{t.page_create_location_2()}</button></div>
        </WriteForm>
    }
}

/// Save a location.
#[component(css = LocationCard)]
pub fn UpdateForm<'a>(t: Msg, viewer: &'a Viewer, id: &'a str, draft: &'a Draft, enabled: bool) -> impl Patch {
    html! {
        <WriteForm
            t={t}
            id={LocationFormId(id)}
            action={url::Location { id }}
            viewer={viewer}
            family={Family::Update}
            target={id}
            attempt={LocationInput::FIELDS.attempt}
            errors={&draft.errors}
            enabled={enabled}
        >
            <LocationFields t={t} form_id={LocationFormId(id)} draft={draft} create={false} />
            <div class={Buttons}><button type="submit" class={Secondary}>{t.page_save_location()}</button></div>
        </WriteForm>
    }
}

/// Archive a location: its current fields go along as hidden inputs, as marketplace sends them.
#[component(css = LocationCard)]
pub fn ArchiveForm<'a>(t: Msg, viewer: &'a Viewer, id: &'a str, draft: &'a Draft, enabled: bool) -> impl Patch {
    let f = LocationInput::FIELDS;
    let i = &draft.input;
    let hidden = [
        (f.name, &i.name),
        (f.description, &i.description),
        (f.ship_from_code, &i.ship_from_code),
        (f.ship_from_name, &i.ship_from_name),
        (f.ship_from_company, &i.ship_from_company),
        (f.ship_from_line1, &i.ship_from_line1),
        (f.ship_from_line2, &i.ship_from_line2),
        (f.ship_from_city, &i.ship_from_city),
        (f.ship_from_state, &i.ship_from_state),
        (f.ship_from_postal_code, &i.ship_from_postal_code),
        (f.ship_from_country, &i.ship_from_country),
        (f.ship_from_phone, &i.ship_from_phone),
        (f.ship_from_email, &i.ship_from_email),
    ];
    html! {
        <WriteForm
            t={t}
            id={ArchiveFormId(id)}
            action={url::Archive { id }}
            viewer={viewer}
            family={Family::Archive}
            target={id}
            attempt={LocationInput::FIELDS.attempt}
            errors={&draft.errors}
            enabled={enabled}
        >
            for (name, value) in &hidden {
                <input type="hidden" name={*name} value={value.as_str()}>
            }
            <div class={Buttons}><button type="submit" class={Danger}>{t.page_archive_location()}</button></div>
        </WriteForm>
    }
}

/// The locations, one card each.
#[component(css = LocationCard)]
pub fn CardList<C: Render>(children: C) -> impl Render {
    html! { <ul class={List}>{children}</ul> }
}

/// One location: its name, description and state, its save form and, while active, its archive
/// form.
#[component(css)]
pub fn LocationCard<'a>(
    t: Msg,
    viewer: &'a Viewer,
    location: &'a Location,
    update: &'a Draft,
    archive: &'a Draft,
    enabled: bool,
) -> impl Render {
    let id = location.storage_location_id.as_str();
    let description = location.description.as_deref().unwrap_or(t.page_no_description());
    let (tone, state) = if location.is_archived { (Warning, t.page_archived()) } else { (Accent, t.page_active()) };
    html! {
        <li class={Card}>
            <div class={Head}>
                <p class={Name}>{&location.name}</p>
                <p class={Muted}>{description}</p>
                <span class={(Pill, tone)}>{state}</span>
            </div>
            <UpdateForm t={t} viewer={viewer} id={id} draft={update} enabled={enabled} />
            if !location.is_archived {
                <ArchiveForm t={t} viewer={viewer} id={id} draft={archive} enabled={enabled} />
            }
        </li>
    }
}
