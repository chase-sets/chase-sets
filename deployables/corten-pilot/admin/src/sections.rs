//! admin-web's section homes (`routes/{commerce,growth,support,platform}-home.tsx`,
//! `createAdminSectionHomeLoader`): each sends the staff member to the first page of the
//! section's nav they may see, and answers 403 when they may see none. Access's home is a page of
//! its own (`crate::access`), and Catalog's opens on the dimensions (`crate::catalog`).
//!
//! | Route | Answers | Needs |
//! |---|---|---|
//! | `GET /commerce`, `/growth`, `/support`, `/platform` | a redirect to the section's first page the viewer may see | signed-in staff with an entry in the section |
use corten::{http::StatusCode, prelude::*};

use crate::{
    auth::{self, Viewer},
    views::link_to,
};

#[corten::routes(state = crate::app::Shared, area = Commerce, caller = crate::auth::Viewer)]
pub mod commerce {
    #[route("/commerce", get = crate::sections::home)]
    pub struct Commerce;
}

#[corten::routes(state = crate::app::Shared, area = Growth, caller = crate::auth::Viewer)]
pub mod growth {
    #[route("/growth", get = crate::sections::home)]
    pub struct Growth;
}

#[corten::routes(state = crate::app::Shared, area = Support, caller = crate::auth::Viewer)]
pub mod support {
    #[route("/support", get = crate::sections::home)]
    pub struct Support;
}

#[corten::routes(state = crate::app::Shared, area = Platform, caller = crate::auth::Viewer)]
pub mod platform {
    #[route("/platform", get = crate::sections::home)]
    pub struct Platform;
}

/// The section's first page the viewer may see, in its nav's order: an entry's own page, else its
/// first child's (`firstNavigationHref`), on the pilot when it serves it and on admin-web otherwise.
pub(crate) fn first_page(req: &Req, viewer: &Viewer, section: &str) -> Option<String> {
    auth::section_items(viewer, section)
        .into_iter()
        .find_map(|(item, children)| item.href.as_deref().or_else(|| children.iter().find_map(|child| child.href.as_deref())))
        .and_then(|href| link_to(req, &format!("/{section}{href}")))
}

async fn home(req: Req, Caller(viewer): Caller<Viewer>) -> HtmlResult {
    let section = req.path().trim_start_matches('/');
    match first_page(&req, &viewer, section) {
        Some(to) => req.redirect(&to.parse::<corten::http::Uri>().map_err(corten::Error::new)?),
        None => Err(corten::Error::status(StatusCode::FORBIDDEN)),
    }
}
