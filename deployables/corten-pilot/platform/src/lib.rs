//! What the pilot's apps share: the platform API called as the signed-in user ([`api`]), signing in through Auth's API ([`auth`]), the
//! read-after-write receipt ([`receipt`]), the realtime stream's changes ([`realtime`]), a durable job's status ([`jobs`]), the React apps' nav rules ([`nav`]), the session cookie
//! and color mode ([`session`]), the visitor's address behind a trusted proxy ([`client`]), the design system's tokens ([`theme`]), and the page parts both
//! apps draw ([`section`], and a time series, [`chart`]), and what an amount of money is ([`money`]). Each app owns its
//! screens, its shell and its API calls.
pub mod api;
pub mod auth;
pub mod chart;
pub mod jobs;
pub mod money;
pub mod nav;
pub mod realtime;
pub mod receipt;
pub mod section;
pub mod session;
pub mod theme;
pub mod ui;
