//! Catalog > Scope Coverage: the Unmapped Scope Inbox (`UnmappedScopeInboxPage`) and a scope's
//! coverage page (`ScopeCoverageDetailPage`), drawn with the scope page's parts and stylesheet. The
//! inbox's rows are cards on a phone, each cell under its heading.
use corten::prelude::*;

use super::{
    CoveragePart, DetailPage, Empty, Filters, InboxHeader, InboxRow, InboxTone, Pick, Refused, Rows, ScopePage, Toasts, value,
};
use crate::{
    catalog::{
        coverage::{CoverageScreen, InboxScreen, url},
        scope::{ScopeBack, url::Via},
        scopes,
    },
    text::{Cat, Pilot},
};

/// The inbox: what is waiting, the product domain filter, and a row per scope.
pub fn coverage_inbox<'a>(t: Cat, p: Pilot, screen: &'a InboxScreen) -> impl Render + 'a {
    let counts = &screen.inbox.counts;
    let summary =
        t.inbox_summary_description(counts.total_groups, counts.total_candidates, counts.high_confidence_candidates).to_string();
    let tone = if counts.total_groups > 0 { InboxTone::Warning } else { InboxTone::Success };
    let domains: Vec<(&str, &str)> = scopes::product_domains().iter().map(|d| (d.as_str(), d.as_str())).collect();
    let f = url::InboxQuery::FIELDS;
    let action = url::Inbox { query: Default::default() }.href();
    let head = [
        t.inbox_scope(),
        t.inbox_product_domain(),
        t.inbox_scope_kind(),
        t.inbox_official_code(),
        t.inbox_status(),
        t.inbox_pending_proposals(),
        "",
    ];
    let title = t.inbox_unmapped_scope_inbox();
    html! {
        <ScopePage>
            <InboxHeader t={t} summary={&summary} tone={tone} />
            <Filters t={t} action={&action}>
                <Pick
                    label={t.inbox_product_domain()}
                    name={f.product_domain}
                    all={t.scopes_filter_all_domains()}
                    options={&domains}
                    value={value(&screen.product_domain)}
                />
            </Filters>
            if screen.inbox.groups.is_empty() {
                <Empty title={t.inbox_nothing_pending_title()} description={t.inbox_nothing_pending_description()} />
            } else {
                <Rows label={title} head={&head}>
                    for group in &screen.inbox.groups {
                        <InboxRow t={t} group={group} />
                    }
                </Rows>
            }
        </ScopePage>
        <Toasts p={p} notice={None} />
    }
}

/// A scope's coverage page: the way back to the inbox, a refused write's message, and the matrix,
/// whose writes come back here.
pub fn coverage_page<'a>(
    t: Cat,
    p: Pilot,
    screen: &'a CoverageScreen,
    notice: Option<String>,
    back: ScopeBack,
    manage: bool,
) -> impl Render + 'a {
    let (refused, propose) = match back {
        ScopeBack::Nothing => (None, None),
        ScopeBack::Refused(message) => (Some(message), None),
        ScopeBack::Propose(input, message) => (None, Some((input, message))),
    };
    let inbox = url::Inbox { query: Default::default() }.href();
    let name = screen.matrix.as_ref().map_or(screen.scope_record_id.as_str(), |m| m.scope_name.as_str());
    html! {
        <DetailPage p={p} list={&inbox} list_label={t.inbox_unmapped_scope_inbox()} name={name}>
            <ScopePage>
                if let Some(message) = &refused {
                    <Refused p={p} message={message} />
                }
                <CoveragePart
                    t={t}
                    p={p}
                    id={&screen.scope_record_id}
                    coverage={screen.matrix.as_ref().map(|m| &m.coverage)}
                    propose={propose.as_ref()}
                    manage={manage}
                    via={Via::Coverage}
                />
            </ScopePage>
        </DetailPage>
        <Toasts p={p} notice={notice.as_ref()} />
    }
}
