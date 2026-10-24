//! The admin Commerce > Postage policies screen on Corten: a pilot port of admin-web's
//! `/commerce/postage-policies`, which reads and writes through the platform API as the
//! signed-in staff member. See README.md.
mod api;
mod app;
mod auth;
mod form;
mod receipt;
mod text;
mod theme;
mod views;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    app::app(app::Config::from_env()).serve().await
}
