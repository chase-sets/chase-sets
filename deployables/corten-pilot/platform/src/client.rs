//! The visitor's address, for an API that limits a public write by it (the waitlist's signup
//! limiter keys on `x-forwarded-for`, `publicClientRequestKey` in contracts/http/rate-limit.ts).
//! A server-side call comes from the app, not the browser, so the app says whose it is, as
//! `resolveClientAddress` (infrastructure/platform-runtime/http.ts) reads it: only when the
//! deployment says a proxy in front sets the headers (`CHASE_SETS_TRUST_FORWARDED_HEADERS=true`),
//! the nearest public address in `X-Forwarded-For` (the last hop the proxy added, not one the
//! browser wrote first), else its last entry, else `X-Real-IP`. Corten reads no peer address
//! (todd-skelton/corten#120 asks for one), so without a proxy there is none.
use std::net::IpAddr;

use corten::axum::http::HeaderMap;

/// Whether the deployment trusts its proxy's forwarded headers.
pub fn trusted_from_env() -> bool {
    std::env::var("CHASE_SETS_TRUST_FORWARDED_HEADERS").is_ok_and(|v| v.trim().eq_ignore_ascii_case("true"))
}

/// The visitor's address, when the forwarded headers are trusted and name one.
pub fn address(headers: &HeaderMap, trusted: bool) -> Option<String> {
    if !trusted {
        return None;
    }
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let hops: Vec<&str> =
        text("x-forwarded-for").map(|v| v.split(',').map(str::trim).filter(|h| !h.is_empty()).collect()).unwrap_or_default();
    let nearest = hops.iter().rev().find(|hop| !local(hop) && !private(hop)).or(hops.last());
    nearest
        .map(|hop| hop.to_ascii_lowercase())
        .or_else(|| text("x-real-ip").map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned))
}

/// The host of a hop (`[::1]:80`, `10.0.0.2:443`, `203.0.113.7`), without brackets or port.
fn host(hop: &str) -> String {
    let hop = hop.trim().to_ascii_lowercase();
    if let Some(rest) = hop.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_owned();
    }
    // An IPv6 address has several colons; an IPv4 address or a name with a port has one.
    match hop.matches(':').count() {
        1 => hop.split(':').next().unwrap_or("").to_owned(),
        _ => hop,
    }
}

fn local(hop: &str) -> bool {
    let host = host(hop);
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".test") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

fn private(hop: &str) -> bool {
    match host(hop).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let [a, b, ..] = ip.octets();
            ip.is_private() || (a == 100 && (64..=127).contains(&b))
        }
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use corten::axum::http::HeaderMap;

    use super::address;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn the_nearest_public_hop_is_the_visitor() {
        let chain = headers(&[("x-forwarded-for", "198.51.100.10, 203.0.113.7, 10.0.0.2")]);
        assert_eq!(address(&chain, true).as_deref(), Some("203.0.113.7"), "what the browser wrote first is not trusted");
        assert_eq!(address(&chain, false), None, "nothing without a trusted proxy");
        let private = headers(&[("x-forwarded-for", "10.0.0.3, 172.20.0.1, 100.64.1.1")]);
        assert_eq!(address(&private, true).as_deref(), Some("100.64.1.1"), "the last hop when every one is private");
        let real = headers(&[("x-real-ip", " 203.0.113.9 ")]);
        assert_eq!(address(&real, true).as_deref(), Some("203.0.113.9"));
        let v6 = headers(&[("x-forwarded-for", "2001:db8::1, [fd00::2]:443, ::1")]);
        assert_eq!(address(&v6, true).as_deref(), Some("2001:db8::1"));
        assert_eq!(address(&HeaderMap::new(), true), None);
    }
}
