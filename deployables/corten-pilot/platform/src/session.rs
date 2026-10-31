//! The session both web hosts sign in (the `chase_sets_session` cookie, resolved by
//! `GET /api/auth/session`) and the color mode the user chose (`chase_sets_color_mode`).
use corten::{
    axum::http::{HeaderMap, header},
    security::cookie,
};

pub const SESSION_COOKIE: &str = "chase_sets_session";
const COLOR_MODE_COOKIE: &str = "chase_sets_color_mode";

/// The color mode the user chose.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub enum ColorMode {
    #[default]
    System,
    Light,
    Dark,
}

impl ColorMode {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        match cookie::get(headers, COLOR_MODE_COOKIE) {
            Some("light") => ColorMode::Light,
            Some("dark") => ColorMode::Dark,
            _ => ColorMode::System,
        }
    }

    /// `data-theme` on `<html>`; `None` follows the system.
    pub fn theme(self) -> Option<&'static str> {
        match self {
            ColorMode::System => None,
            ColorMode::Light => Some("light"),
            ColorMode::Dark => Some("dark"),
        }
    }
}

/// What the session lookup forwards, owned so an `Identify` lookup's future can keep it: the cookies
/// and the host, or `None` without a session cookie (no lookup, no one signed in).
pub fn forwarded(headers: &HeaderMap) -> Option<HeaderMap> {
    forwarded_for(headers, &[SESSION_COOKIE])
}

/// [`forwarded`], for a lookup any of `cookies` starts: marketplace's actor is a guest checkout's
/// when the request has its cookie and no session (`resolveActorFromRequest`).
pub fn forwarded_for(headers: &HeaderMap, cookies: &[&str]) -> Option<HeaderMap> {
    cookies.iter().find_map(|name| cookie::get(headers, name))?;
    let mut forward = HeaderMap::new();
    for name in [header::COOKIE, header::HOST] {
        if let Some(value) = headers.get(&name) {
            forward.insert(name, value.clone());
        }
    }
    Some(forward)
}
