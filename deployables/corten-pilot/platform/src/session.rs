//! The session both web hosts sign in (the `chase_sets_session` cookie, resolved by
//! `GET /api/auth/session`) and the color mode the user chose (`chase_sets_color_mode`).
use corten::{
    http::{HeaderMap, HeaderValue, header},
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

/// What the session lookup forwards, owned so an `Identify` lookup's future can keep it: the cookies,
/// the host and a [`bearer`] session token, or `None` with neither a session cookie nor a token (no
/// lookup, no one signed in).
pub fn forwarded(headers: &HeaderMap) -> Option<HeaderMap> {
    forwarded_for(headers, &[SESSION_COOKIE])
}

/// [`forwarded`], for a lookup any of `cookies` starts: marketplace's actor is a guest checkout's
/// when the request has its cookie and no session (`resolveActorFromRequest`).
pub fn forwarded_for(headers: &HeaderMap, cookies: &[&str]) -> Option<HeaderMap> {
    let token = bearer(headers);
    if token.is_none() {
        cookies.iter().find_map(|name| cookie::get(headers, name))?;
    }
    let mut forward = HeaderMap::new();
    for name in [header::COOKIE, header::HOST] {
        if let Some(value) = headers.get(&name) {
            forward.insert(name, value.clone());
        }
    }
    if let Some(token) = token {
        forward.insert(header::AUTHORIZATION, token.clone());
    }
    Some(forward)
}

/// The request's `Authorization: Bearer` session token, which the React hosts and the API take
/// in place of the session cookie (`readAuthSessionToken`: the cookie first, then the token). The
/// apps forward it to the API with the cookies; any other scheme, or more than one
/// `Authorization` line, is not forwarded.
pub fn bearer(headers: &HeaderMap) -> Option<&HeaderValue> {
    let mut lines = headers.get_all(header::AUTHORIZATION).iter();
    let only = match (lines.next(), lines.next()) {
        (Some(value), None) => Some(value),
        _ => None,
    };
    only.filter(|value| {
        value.to_str().is_ok_and(|text| text.strip_prefix("Bearer ").is_some_and(|token| !token.trim().is_empty()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        pairs.iter().map(|(name, value)| (name.clone(), value.parse().unwrap())).collect()
    }

    #[test]
    fn a_bearer_token_is_looked_up_like_the_session_cookie_and_forwarded() {
        let token = headers(&[(header::AUTHORIZATION, "Bearer tok_1"), (header::HOST, "admin.example")]);
        let forward = forwarded(&token).expect("a token is a session to look up");
        assert_eq!(forward.get(header::AUTHORIZATION).unwrap(), "Bearer tok_1");
        assert_eq!(forward.get(header::HOST).unwrap(), "admin.example");

        let both = headers(&[(header::COOKIE, "chase_sets_session=ses_1"), (header::AUTHORIZATION, "Bearer tok_1")]);
        let forward = forwarded(&both).unwrap();
        assert_eq!(forward.get(header::COOKIE).unwrap(), "chase_sets_session=ses_1", "the API reads the cookie first");
        assert_eq!(forward.get(header::AUTHORIZATION).unwrap(), "Bearer tok_1");
    }

    #[test]
    fn no_session_cookie_and_no_bearer_token_is_no_one() {
        assert!(forwarded(&headers(&[(header::AUTHORIZATION, "Basic dXNlcjpwYXNz")])).is_none());
        assert!(forwarded(&headers(&[(header::AUTHORIZATION, "Bearer  ")])).is_none());
        assert!(forwarded(&headers(&[(header::COOKIE, "chase_sets_color_mode=dark")])).is_none());
        let mut twice = headers(&[(header::AUTHORIZATION, "Bearer tok_1")]);
        twice.append(header::AUTHORIZATION, "Bearer tok_2".parse().unwrap());
        assert!(forwarded(&twice).is_none(), "two Authorization lines are no token");
        let cookie = forwarded(&headers(&[(header::COOKIE, "chase_sets_session=ses_1")])).unwrap();
        assert!(cookie.get(header::AUTHORIZATION).is_none());
    }
}
