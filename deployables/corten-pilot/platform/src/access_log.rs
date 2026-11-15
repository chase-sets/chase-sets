//! One line per request, in admin-web's shape (morgan's `METHOD path status length - ms`):
//! `GET /commerce/postage-policies 200 5123 - 4.210 ms`. The path has no query, as admin-web's
//! has none, so a search or a token in it is never written.
//!
//! Corten writes no such line itself (corten-run/corten#1449). An app's own `Middleware` would
//! miss what Corten answers before it (a host it does not serve, a write from another site) and
//! the `304` it turns a `200` into after it, so this is a tower layer around the whole app
//! (`App::layer`), which sees every answer the client gets. Its length is the body's as sent,
//! compressed or not, or `-` when the body is streamed; the router sets `Content-Length` only
//! after every layer. A `HEAD`'s is its `GET`'s, as admin-web's is.
use std::{
    fmt::Write as _,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, ready},
    time::{Duration, Instant},
};

use corten::http::{Method, Request, Response, StatusCode, Uri};
use http_body::Body as _;

type Sink = Arc<dyn Fn(&str) + Send + Sync>;

/// The layer: `.layer(AccessLog::new())` writes each line as an `INFO` event, which Corten's
/// subscriber prints on standard output.
#[derive(Clone)]
pub struct AccessLog {
    sink: Sink,
}

impl AccessLog {
    pub fn new() -> Self {
        Self::to(|line| tracing::info!("{line}"))
    }

    /// The same, giving each line to `sink` instead.
    pub fn to(sink: impl Fn(&str) + Send + Sync + 'static) -> Self {
        AccessLog { sink: Arc::new(sink) }
    }
}

impl Default for AccessLog {
    fn default() -> Self {
        Self::new()
    }
}

impl<S> tower_layer::Layer<S> for AccessLog {
    type Service = Logging<S>;

    fn layer(&self, inner: S) -> Logging<S> {
        Logging { inner, sink: self.sink.clone() }
    }
}

/// The app with its requests logged.
#[derive(Clone)]
pub struct Logging<S> {
    inner: S,
    sink: Sink,
}

impl<S> tower_service::Service<Request> for Logging<S>
where
    S: tower_service::Service<Request, Response = Response>,
    S::Future: Unpin,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Logged<S::Future>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request) -> Logged<S::Future> {
        let (method, uri) = (req.method().clone(), req.uri().clone());
        Logged { inner: self.inner.call(req), started: Instant::now(), method, uri, sink: self.sink.clone() }
    }
}

/// A request's answer, logged once it is ready.
pub struct Logged<F> {
    inner: F,
    started: Instant,
    method: Method,
    uri: Uri,
    sink: Sink,
}

impl<F, E> Future for Logged<F>
where
    F: Future<Output = Result<Response, E>> + Unpin,
{
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.get_mut();
        let answer = ready!(Pin::new(&mut this.inner).poll(cx));
        if let Ok(res) = &answer {
            let length = res.body().size_hint().exact();
            (this.sink)(&line(&this.method, this.uri.path(), res.status(), length, this.started.elapsed()));
        }
        Poll::Ready(answer)
    }
}

/// `GET /path 200 1234 - 5.123 ms`, or `-` for a length not known.
fn line(method: &Method, path: &str, status: StatusCode, length: Option<u64>, took: Duration) -> String {
    let mut line = format!("{method} {path} {} ", status.as_u16());
    match length {
        Some(length) => write!(line, "{length}"),
        None => write!(line, "-"),
    }
    .expect("writing to a String");
    write!(line, " - {:.3} ms", took.as_secs_f64() * 1000.0).expect("writing to a String");
    line
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use corten::{App, Local, Routes, http::header, security::Policy};

    use super::*;

    #[test]
    fn a_line_is_admin_webs() {
        let took = Duration::from_micros(4_210);
        assert_eq!(line(&Method::GET, "/a", StatusCode::OK, Some(5123), took), "GET /a 200 5123 - 4.210 ms");
        assert_eq!(line(&Method::POST, "/b", StatusCode::SEE_OTHER, None, took), "POST /b 303 - - 4.210 ms");
    }

    fn logged(policy: Policy) -> (corten::testing::Client, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let app = App::new(Routes::new()).policy(policy).layer(AccessLog::to(move |line| sink.lock().unwrap().push(line.into())));
        (app.test(), lines)
    }

    #[tokio::test]
    async fn every_answer_is_logged_without_its_query() {
        let (client, lines) = logged(Policy::new());
        let missing = client.get(&Local::parse("/no-such-page?token=secret").unwrap()).await;
        assert_eq!(missing.status(), 404);
        let live = client.get(&Local::parse("/health/live").unwrap()).await;
        assert_eq!(live.status(), 200);
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].starts_with("GET /no-such-page 404 "), "{}", lines[0]);
        assert!(!lines[0].contains("secret"), "the query is not written: {}", lines[0]);
        assert!(lines[1].starts_with("GET /health/live 200 "), "{}", lines[1]);
        assert!(lines[1].ends_with(" ms"), "{}", lines[1]);
    }

    #[tokio::test]
    async fn a_request_corten_refuses_before_the_app_is_logged_too() {
        let (client, lines) = logged(Policy::new().host("pilot.example"));
        let refused = client.get(&Local::parse("/").unwrap()).header(header::HOST, "other.example").await;
        assert_eq!(refused.status(), 421);
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with("GET / 421 "), "{}", lines[0]);
    }
}
