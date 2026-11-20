//! public-web on Corten: the public, cacheable market price-history page (`/market/{slug}`, the
//! Pricing context's `market-price-history` route), `robots.txt` and the sitemap of the pages it
//! serves, read from the platform API with no session. See README.md.
mod api;
mod app;
mod compare;
mod developers;
mod help;
mod home;
mod kept;
mod market;
mod policy;
mod presence;
mod site;
mod text;
mod views;
mod welcome;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(app::app(app::Config::from_env())).await
}
