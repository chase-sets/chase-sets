//! OpenTelemetry for a pilot app that replaces a React host which exported it (feature `otlp`):
//! marketplace-web starts `@chase-sets/observability`, which sends traces, logs and metrics over
//! OTLP HTTP to the cluster's collector, and the collector takes nothing else (no stdout). Corten
//! leaves this to the app's `tracing` subscriber, so [`init`] installs one that writes the same
//! stdout lines Corten's would and exports the rest.
//!
//! It reads the variables `loadObservabilityConfig` reads: on unless `OBSERVABILITY_ENABLED` is
//! `false`, to `OTEL_EXPORTER_OTLP_ENDPOINT` with `OTEL_EXPORTER_OTLP_HEADERS`, as
//! `OTEL_SERVICE_NAME` (else the React host's name) at `OTEL_SERVICE_VERSION`, in
//! `DEPLOYMENT_ENVIRONMENT` (else `local`), with `OTEL_RESOURCE_ATTRIBUTES`, and sampling by
//! `OTEL_TRACES_SAMPLER` at `OTEL_TRACES_SAMPLER_ARG` (else 0.1 where `NODE_ENV` is `production`,
//! 1.0 elsewhere). Where it differs: with no endpoint set it exports nothing, where marketplace-web
//! sends to `localhost:4318`, so a pilot run locally without a collector does not try one.
//!
//! [`Spans`] and [`Traced`] make each request a server span named by its route (`GET /items/{id}`),
//! never its path or query, and [`inject`] gives an API call the span's `traceparent`, so platform-api's spans
//! join the page's trace as they join marketplace-web's.
use std::{collections::HashMap, io::IsTerminal, sync::OnceLock};

use corten::{
    http::{Request, Response},
    middleware::{MatchedPath, Middleware, Next},
};
pub use opentelemetry::{KeyValue, metrics::Counter};
use opentelemetry::{
    global,
    propagation::Injector,
    trace::{TraceContextExt as _, TracerProvider as _},
};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    Resource,
    logs::SdkLoggerProvider,
    metrics::SdkMeterProvider,
    propagation::TraceContextPropagator,
    trace::{Sampler, SdkTracer, SdkTracerProvider},
};
use tracing::{Instrument, Level, field::Empty};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{Layer, filter::LevelFilter, filter::filter_fn, layer::SubscriberExt, util::SubscriberInitExt};

/// The instrumentation scope marketplace-web's metrics are in (`OBSERVABILITY_SCOPE_NAME`).
const SCOPE: &str = "@chase-sets/observability";

/// What [`init`] exports, read from the environment.
#[derive(Debug, PartialEq)]
pub struct Config {
    pub service_name: String,
    pub service_version: Option<String>,
    pub environment: String,
    /// The collector's base address; the signals go to `/v1/traces`, `/v1/logs` and `/v1/metrics`.
    pub endpoint: String,
    pub headers: HashMap<String, String>,
    pub sampler: Sampling,
    pub resource: Vec<(String, String)>,
}

/// How traces are sampled (`OTEL_TRACES_SAMPLER`): by default a root span by ratio and a span with
/// a parent as its parent was.
#[derive(Debug, PartialEq)]
pub enum Sampling {
    AlwaysOn,
    AlwaysOff,
    Ratio(f64),
    ParentBasedRatio(f64),
}

impl Config {
    /// The configuration in the environment, or `None` when observability is off or no collector
    /// is named. `service_name` and `service_version` are the React host's defaults.
    pub fn from_env(service_name: &str, service_version: &str) -> Option<Self> {
        Self::from(|name| std::env::var(name).ok(), service_name, service_version)
    }

    fn from(var: impl Fn(&str) -> Option<String>, service_name: &str, service_version: &str) -> Option<Self> {
        let set = |name: &str| var(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        if var("OBSERVABILITY_ENABLED").as_deref() == Some("false") {
            return None;
        }
        let endpoint = set("OTEL_EXPORTER_OTLP_ENDPOINT")?.trim_end_matches('/').to_owned();
        let production = var("NODE_ENV").as_deref() == Some("production");
        let ratio = set("OTEL_TRACES_SAMPLER_ARG")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|r| (0.0..=1.0).contains(r))
            .unwrap_or(if production { 0.1 } else { 1.0 });
        let sampler = match set("OTEL_TRACES_SAMPLER").as_deref() {
            Some("always_on") => Sampling::AlwaysOn,
            Some("always_off") => Sampling::AlwaysOff,
            Some("traceidratio") => Sampling::Ratio(ratio),
            _ => Sampling::ParentBasedRatio(ratio),
        };
        Some(Self {
            service_name: set("OTEL_SERVICE_NAME").unwrap_or_else(|| service_name.to_owned()),
            service_version: set("OTEL_SERVICE_VERSION").or_else(|| Some(service_version.to_owned())),
            environment: set("DEPLOYMENT_ENVIRONMENT").unwrap_or_else(|| "local".to_owned()),
            endpoint,
            headers: pairs(set("OTEL_EXPORTER_OTLP_HEADERS").as_deref()).into_iter().collect(),
            sampler,
            resource: pairs(set("OTEL_RESOURCE_ATTRIBUTES").as_deref()),
        })
    }
}

/// `a=1,b=2` as its pairs, each name and value trimmed and percent-decoded, as the OTLP
/// specification writes the header and resource variables. A pair without `=` or a name is skipped.
fn pairs(value: Option<&str>) -> Vec<(String, String)> {
    let decode = |s: &str| percent_encoding::percent_decode_str(s.trim()).decode_utf8_lossy().into_owned();
    value
        .unwrap_or_default()
        .split(',')
        .filter_map(|entry| {
            let (name, value) = entry.split_once('=')?;
            let name = decode(name);
            (!name.is_empty()).then(|| (name, decode(value)))
        })
        .collect()
}

/// What [`init`] started: flushed and stopped when dropped, at the end of `main`.
pub struct Telemetry {
    tracer: SdkTracerProvider,
    logger: SdkLoggerProvider,
    meter: SdkMeterProvider,
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        // Each flushes what it holds; what a collector that is gone by now loses, nothing can
        // report but stdout.
        let _ = self.tracer.shutdown();
        let _ = self.logger.shutdown();
        let _ = self.meter.shutdown();
    }
}

/// Installs the subscriber when [`Config::from_env`] names a collector: stdout lines as Corten
/// writes them (events at `INFO` and above, without the spans they are in), and traces, logs and
/// metrics to the collector. Without one it installs nothing, and `corten::serve` installs its own.
/// Call it before `serve` and keep what it returns until `serve` returns.
pub fn init(service_name: &str, service_version: &str) -> Option<Telemetry> {
    let config = Config::from_env(service_name, service_version)?;
    match start(&config) {
        Ok(telemetry) => Some(telemetry),
        Err(error) => {
            // No subscriber is installed yet, so the line goes to stderr directly.
            eprintln!("OpenTelemetry export is off: {error}");
            None
        }
    }
}

fn start(config: &Config) -> Result<Telemetry, Box<dyn std::error::Error>> {
    let mut attributes = vec![KeyValue::new("deployment.environment", config.environment.clone())];
    if let Some(version) = &config.service_version {
        attributes.push(KeyValue::new("service.version", version.clone()));
    }
    attributes.extend(config.resource.iter().map(|(k, v)| KeyValue::new(k.clone(), v.clone())));
    let resource = Resource::builder_empty().with_attributes(attributes).with_service_name(config.service_name.clone()).build();
    let url = |signal: &str| format!("{}/v1/{signal}", config.endpoint);

    let spans = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(url("traces"))
        .with_headers(config.headers.clone())
        .build()?;
    let logs = LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(url("logs"))
        .with_headers(config.headers.clone())
        .build()?;
    let metrics = MetricExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(url("metrics"))
        .with_headers(config.headers.clone())
        .build()?;

    let sampler = match config.sampler {
        Sampling::AlwaysOn => Sampler::AlwaysOn,
        Sampling::AlwaysOff => Sampler::AlwaysOff,
        Sampling::Ratio(r) => Sampler::TraceIdRatioBased(r),
        Sampling::ParentBasedRatio(r) => Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(r))),
    };
    let tracer =
        SdkTracerProvider::builder().with_batch_exporter(spans).with_sampler(sampler).with_resource(resource.clone()).build();
    let logger = SdkLoggerProvider::builder().with_batch_exporter(logs).with_resource(resource.clone()).build();
    let meter = SdkMeterProvider::builder().with_periodic_exporter(metrics).with_resource(resource).build();
    global::set_meter_provider(meter.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());

    install(tracer.tracer(SCOPE), &logger)?;
    Ok(Telemetry { tracer, logger, meter })
}

/// The exporters' own crates are left out of the export, so a failed export does not export its
/// own failure.
fn exported(meta: &tracing::Metadata<'_>) -> bool {
    !meta.target().starts_with("opentelemetry") && *meta.level() <= Level::INFO
}

/// The subscriber: stdout for events only (so a line does not carry the request's span), the
/// request spans to the tracer, and the events to the logs.
fn install(tracer: SdkTracer, logger: &SdkLoggerProvider) -> Result<(), Box<dyn std::error::Error>> {
    let color = std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty());
    let stdout = tracing_subscriber::fmt::layer()
        .with_target(false)
        .with_ansi(color)
        .with_filter(filter_fn(|meta| meta.is_event() && *meta.level() <= Level::INFO));
    let spans = tracing_opentelemetry::layer().with_tracer(tracer).with_filter(filter_fn(exported));
    let logs = OpenTelemetryTracingBridge::new(logger).with_filter(filter_fn(|meta| meta.is_event() && exported(meta)));
    tracing_subscriber::registry().with(LevelFilter::INFO).with(stdout).with(spans).with(logs).try_init()?;
    Ok(())
}

/// A server span around each request ([`Spanned`]), as Corten's guide places one (`App::layer`):
/// outside the router, so the error page, the layout reads (polled beside the page, outside the
/// app's middleware) and every API call they make are in it. The route is not matched yet there,
/// so [`Traced`] names the span.
#[derive(Clone, Copy, Debug, Default)]
pub struct Spans;

impl<S> tower::Layer<S> for Spans {
    type Service = Spanned<S>;

    fn layer(&self, inner: S) -> Spanned<S> {
        Spanned(inner)
    }
}

/// The service [`Spans`] makes: the request's span, named by its method until [`Traced`] names it
/// by its route, with the answer's status, and an error for a 5xx.
#[derive(Clone, Debug)]
pub struct Spanned<S>(S);

impl<S> tower::Service<Request> for Spanned<S>
where
    S: tower::Service<Request, Response = Response> + Send,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), S::Error>> {
        self.0.poll_ready(cx)
    }

    fn call(&mut self, req: Request) -> Self::Future {
        let method = req.method().as_str().to_owned();
        let span = tracing::info_span!(
            "request",
            otel.name = method.as_str(),
            otel.kind = "server",
            otel.status_code = Empty,
            http.request.method = method.as_str(),
            http.route = Empty,
            http.response.status_code = Empty,
        );
        let answer = self.0.call(req).instrument(span.clone());
        Box::pin(async move {
            let res = answer.await?;
            let status = res.status();
            span.record("http.response.status_code", status.as_u16());
            if status.is_server_error() {
                span.record("otel.status_code", "ERROR");
            }
            Ok(res)
        })
    }
}

/// Names the request's span ([`Spans`]) by its method and the route it matched, as
/// marketplace-web's HTTP instrumentation names one: `GET /items/{id}`. An unknown address keeps
/// its method alone, so a scanner's paths make no names.
#[derive(Clone, Copy, Debug, Default)]
pub struct Traced;

impl Middleware for Traced {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        if let Some(route) = req.extensions().get::<MatchedPath>() {
            let span = tracing::Span::current();
            span.record("http.route", route.as_str());
            // The span started when [`Spanned`] entered it, and a started span takes a new name only
            // this way: a late `otel.name` record changes nothing.
            span.context().span().update_name(format!("{} {}", req.method(), route.as_str()));
        }
        next.run(req).await
    }
}

/// The current span's `traceparent` (and `tracestate`), for a call to the API made in it: none
/// when nothing is exported or the span is not sampled.
pub fn inject() -> Vec<(&'static str, String)> {
    struct Headers(Vec<(&'static str, String)>);
    impl Injector for Headers {
        fn set(&mut self, key: &str, value: String) {
            let key = match key {
                "traceparent" => "traceparent",
                "tracestate" => "tracestate",
                _ => return,
            };
            self.0.push((key, value));
        }
    }
    let context = tracing::Span::current().context();
    let mut headers = Headers(Vec::new());
    global::get_text_map_propagator(|propagator| propagator.inject_context(&context, &mut headers));
    headers.0
}

/// A metric label as marketplace-web bounds one (`boundedMetricLabel`): `none` for nothing, else
/// each run of characters other than ASCII letters, digits, `_`, `.` and `-` as one `_`, 80 at most.
pub fn label(value: Option<&str>) -> String {
    let Some(text) = value.map(str::trim).filter(|t| !t.is_empty()) else { return "none".to_owned() };
    let mut out = String::new();
    let mut run = false;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            run = false;
        } else if !run {
            out.push('_');
            run = true;
        }
    }
    out.chars().take(80).collect()
}

/// A counter in marketplace-web's scope, made once; it counts nothing until [`init`] sets the
/// meter provider.
pub fn counter(cell: &'static OnceLock<Counter<u64>>, name: &'static str) -> &'static Counter<u64> {
    cell.get_or_init(|| global::meter(SCOPE).u64_counter(name).build())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(vars: &[(&str, &str)]) -> Option<Config> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Config::from(|name| vars.get(name).cloned(), "marketplace-web", "0.1.0")
    }

    #[test]
    fn it_is_off_without_a_collector_or_when_switched_off() {
        assert_eq!(config(&[]), None);
        assert_eq!(config(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "  ")]), None);
        assert_eq!(config(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:4318"), ("OBSERVABILITY_ENABLED", "false")]), None);
    }

    #[test]
    fn it_reads_what_marketplace_web_reads() {
        let on = config(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "x-token=a%3Db, =skipped,bad"),
            ("OTEL_RESOURCE_ATTRIBUTES", "cloud.provider=digitalocean,chase_sets.environment_slug=staging"),
            ("DEPLOYMENT_ENVIRONMENT", "staging"),
            ("NODE_ENV", "production"),
        ])
        .unwrap();
        assert_eq!(on.endpoint, "http://collector:4318");
        assert_eq!(on.service_name, "marketplace-web");
        assert_eq!(on.service_version.as_deref(), Some("0.1.0"));
        assert_eq!(on.environment, "staging");
        assert_eq!(on.headers, HashMap::from([("x-token".to_owned(), "a=b".to_owned())]));
        assert_eq!(on.resource[1], ("chase_sets.environment_slug".to_owned(), "staging".to_owned()));
        assert_eq!(on.sampler, Sampling::ParentBasedRatio(0.1), "production samples a tenth");

        let local = config(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:4318"), ("OTEL_SERVICE_NAME", "pilot")]).unwrap();
        assert_eq!((local.service_name.as_str(), local.environment.as_str()), ("pilot", "local"));
        assert_eq!(local.sampler, Sampling::ParentBasedRatio(1.0));
        let ratio = config(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:4318"),
            ("OTEL_TRACES_SAMPLER", "traceidratio"),
            ("OTEL_TRACES_SAMPLER_ARG", "0.25"),
        ]);
        assert_eq!(ratio.unwrap().sampler, Sampling::Ratio(0.25));
    }

    /// The exporters, started inside the runtime as `main` starts them, send each signal to its
    /// address under the collector's, and stopping them (as `main` does on its way out) does not
    /// panic the runtime.
    #[tokio::test(flavor = "multi_thread")]
    async fn it_sends_traces_logs_and_metrics_to_the_collector() {
        use std::io::{Read, Write};
        // A collector that answers 200 to each request and keeps its request line.
        let collector = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = collector.local_addr().unwrap();
        let posts = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = posts.clone();
        std::thread::spawn(move || {
            for stream in collector.incoming() {
                let Ok(mut stream) = stream else { return };
                let seen = seen.clone();
                std::thread::spawn(move || {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 8192];
                    loop {
                        let Ok(read) = stream.read(&mut buffer) else { return };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                        let head = String::from_utf8_lossy(&request[..end]).into_owned();
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_owned())
                            })
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(0);
                        if request.len() < end + 4 + length {
                            continue;
                        }
                        seen.lock().unwrap().push(head.lines().next().unwrap_or_default().to_owned());
                        request.drain(..end + 4 + length);
                        if stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").is_err() {
                            return;
                        }
                    }
                });
            }
        });

        let endpoint = format!("http://{address}");
        let config =
            Config::from(|name| (name == "OTEL_EXPORTER_OTLP_ENDPOINT").then(|| endpoint.clone()), "marketplace-web", "0.1.0")
                .unwrap();
        let telemetry = start(&config).expect("the exporters start");
        tracing::info_span!("request", otel.name = "GET /search").in_scope(|| tracing::info!("served"));
        static EVENTS: OnceLock<Counter<u64>> = OnceLock::new();
        counter(&EVENTS, "chase_sets_test_events_total").add(1, &[KeyValue::new("context", "test")]);
        drop(telemetry);

        let posts = posts.lock().unwrap().clone();
        for signal in ["traces", "logs", "metrics"] {
            assert!(posts.iter().any(|line| line.starts_with(&format!("POST /v1/{signal} "))), "{signal}: {posts:?}");
        }
    }

    #[test]
    fn a_label_is_bounded_as_marketplace_web_bounds_it() {
        assert_eq!(label(None), "none");
        assert_eq!(label(Some("  ")), "none");
        assert_eq!(label(Some("item_detail.rail-1")), "item_detail.rail-1");
        assert_eq!(label(Some("a b//c")), "a_b_c");
        assert_eq!(label(Some(&"x".repeat(90))).len(), 80);
    }
}
