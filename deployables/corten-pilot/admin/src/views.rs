//! The screen's views. Each component's stylesheet (and the sheet's script) is next to it in
//! `views/`; `static/style.css` has the element defaults and the shell's frame.
use std::time::{SystemTime, UNIX_EPOCH};

use corten::{
    Component,
    axum::http::{StatusCode, Uri},
    prelude::*,
};

use crate::{
    api::PackagePlan,
    app::{Screen, url},
    auth::Viewer,
    form::{ActivateInput, CloneInput, PolicyInput, RetireInput, default_payload},
    text::{Msg, Pilot},
};
use platform::theme;

mod admin_nav;
mod badge;
mod lifecycle;
mod live_status;
mod policy_fields;
mod policy_sheet;
mod policy_table;

pub use admin_nav::AdminNav;
pub use badge::Badge;
pub use lifecycle::{ActivateForm, CloneForm, Lifecycle, RetireForm};
pub use live_status::{LiveStatus, LiveWords};
pub use platform::section::{Banner, PageHeader, Section};
pub use policy_fields::{CreateForm, PolicyFields, ReviseForm};
pub use policy_sheet::{PolicySheet, PreviewResult};
pub use policy_table::{Pagination, PolicyTable};

/// The components every page renders (the frame and the shared parts), tokens first, and the ones
/// several areas render (a live stream's status): their stylesheets are `components.css`.
pub const COMPONENTS: &[Component] = &[theme::TOKENS, AdminNav, Section, LiveStatus];

/// The postage screen's components: its area's stylesheet.
pub const POSTAGE: &[Component] = &[Badge, PolicyTable, PolicyFields, PolicySheet, Lifecycle];

/// A form's typed values and what is wrong with them.
#[derive(Clone, Debug)]
pub struct Draft<T> {
    pub input: T,
    pub errors: Errors,
}

impl<T> Draft<T> {
    pub fn new(input: T) -> Self {
        Draft { input, errors: Errors::new() }
    }
}

/// Forms that come back from a failed submit, and a preview's result, in place of the defaults.
#[derive(Default)]
pub struct Forms {
    pub create: Option<Draft<PolicyInput>>,
    pub revise: Option<Draft<PolicyInput>>,
    pub activate: Option<Draft<ActivateInput>>,
    pub retire: Option<Draft<RetireInput>>,
    pub clone: Option<Draft<CloneInput>>,
    pub preview: Option<PackagePlan>,
}

/// Now, as `new Date().toISOString()` writes it: the default for "effective from".
pub fn now_iso() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (now.as_secs() as i64, now.subsec_millis());
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

/// The document around every page: admin-web's frame (its sections and the commerce pages) for
/// `viewer` and their color mode, `title`, the page's own `head` tags and the page
/// (`children`). A client navigation gets only the title, the head tags and `<main>`'s children.
/// The viewer is the handler's `Caller`; the error page has none (Corten gives it no caller).
#[component]
pub fn Layout<'a, H: Render, C: Render>(
    req: &'a Req,
    viewer: Option<&'a Viewer>,
    title: &'a str,
    head: H,
    children: C,
) -> impl Document + 'a {
    let p: Pilot = req.t();
    let theme = viewer.and_then(|v| v.color_mode.theme());
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()} data-theme={theme}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link
                    rel="preload"
                    as="font"
                    type="font/woff2"
                    crossorigin
                    href={req.asset("fonts/ibm-plex-sans-latin-400-normal.woff2")}
                >
                <link rel="stylesheet" href={req.asset("style.css")}>
                <title>{title}</title>
                {head}
                <Corten />
                <script type="module" src={req.asset("app.js")}></script>
            </head>
            <body>
                if let Some(viewer) = viewer {
                    <AdminNav p={p} viewer={viewer} path={req.path()} />
                }
                <main>{children}</main>
            </body>
        </html>
    }
}

/// The page for a failed request, in the layout (`App::error_page`). Under `corten dev` it shows
/// the error; Corten sends it with `X-Robots-Tag: noindex`.
pub fn error_page(req: &Req, failure: Failure) -> impl Document + '_ {
    let p: Pilot = req.t();
    // Each case is named, so a case Corten adds stops this compiling.
    let (title, text) = match &failure {
        Failure::NotFound => (p.error_not_found_title(), p.error_not_found()),
        Failure::Refused { .. } | Failure::CrossSite => (p.error_forbidden_title(), p.error_forbidden()),
        // A read that has not caught up with the write before it (`read_failed`).
        Failure::Failed { status, .. } if *status == StatusCode::SERVICE_UNAVAILABLE => {
            (p.error_failed_title(), p.error_pending())
        }
        Failure::Failed { status, .. } if *status == StatusCode::FORBIDDEN => (p.error_forbidden_title(), p.error_forbidden()),
        Failure::WrongMethod
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. }
        | Failure::TimedOut
        | Failure::Offline => (p.error_failed_title(), p.error_failed()),
    };
    let detail = failure.detail().map(str::to_owned);
    // Corten gives the error page no caller, so it is drawn without the nav and the user's theme
    // (todd-skelton/corten#88).
    html! {
        <Layout req={req} viewer={None} title={title} head="">
            <h1>{title}</h1>
            <p>{text}</p>
            if let Some(detail) = &detail {
                <pre>{detail}</pre>
            }
        </Layout>
    }
}

/// A link to an admin-web page outside the pilot.
pub fn admin_web(path: &str) -> Option<Uri> {
    format!("{}{path}", crate::app::admin_web_origin()).parse().ok()
}

/// The list, and the selected policy's sheet.
pub fn page<'a>(t: Msg, p: Pilot, screen: &'a Screen, forms: Forms) -> impl Render + 'a {
    let now = now_iso();
    let create =
        forms.create.unwrap_or_else(|| Draft::new(PolicyInput::new(t.list_default_policy(), &now, "", &default_payload())));
    let (mut active, mut candidates, mut retired) = (Vec::new(), Vec::new(), Vec::new());
    for policy in &screen.policies.items {
        match policy.status.as_str() {
            "active" => active.push(policy),
            "retired" => retired.push(policy),
            _ => candidates.push(policy),
        }
    }
    let sheet = screen.selected.as_ref().map(|policy| {
        let activate = forms.activate.unwrap_or_else(|| {
            Draft::new(ActivateInput {
                label: policy.label.clone(),
                activation_reason: t.detail_activation_reason_default().into(),
            })
        });
        let retire = forms.retire.unwrap_or_else(|| {
            Draft::new(RetireInput {
                label: policy.label.clone(),
                retirement_reason: t.detail_retirement_reason_default().into(),
            })
        });
        let clone = forms.clone.unwrap_or_else(|| {
            Draft::new(CloneInput {
                clone_label: t.detail_rollback_draft(&policy.label).to_string(),
                clone_effective_from: now.clone(),
                clone_effective_until: String::new(),
            })
        });
        let revise = forms.revise.unwrap_or_else(|| Draft::new(PolicyInput::of(policy)));
        (policy, revise, activate, retire, clone)
    });
    let close = url::Policies { limit: keep(screen.limit, 50), offset: keep(screen.offset, 0), ..Default::default() };
    let preview = forms.preview;
    html! {
        <PageHeader eyebrow={t.common_ordering()} title={t.list_title()} description={t.list_description()} />
        <Banner title={t.list_immutable_title()} description={t.list_immutable_description()} />
        <Section title={t.list_create_draft()}><CreateForm t={t} form={&create} /></Section>
        <PolicyTable
            t={t}
            title={t.list_active_policies()}
            policies={&active}
            empty_title={t.list_active_empty_title()}
            empty_description={t.list_active_empty_description()}
            screen={screen}
        />
        <PolicyTable
            t={t}
            title={t.list_candidates()}
            policies={&candidates}
            empty_title={t.list_candidates_empty_title()}
            empty_description={t.list_candidates_empty_description()}
            screen={screen}
        />
        <PolicyTable
            t={t}
            title={t.list_retired_archive()}
            policies={&retired}
            empty_title={t.list_retired_empty_title()}
            empty_description={t.list_retired_empty_description()}
            screen={screen}
        />
        <Pagination p={p} screen={screen} />
        if let Some((policy, revise, activate, retire, clone)) = &sheet {
            <PolicySheet
                t={t}
                policy={policy}
                close={&close}
                revise={revise}
                activate={activate}
                retire={retire}
                clone={clone}
                preview={preview.as_ref()}
            />
        }
    }
}

/// A query value, left out when it is the default.
pub fn keep(value: u32, default: u32) -> Option<u32> {
    (value != default).then_some(value)
}
