//! A durable job's status stream (`createDurableJobEventStream`, infrastructure/platform-runtime
//! durable-job-events.ts) as the signed-in user: the job's record after each change, until it is
//! done, as admin-web's `streamJobEvents` reads it.
//!
//! Like that client it resumes a dropped stream from the last event's id (`Last-Event-ID`) after
//! 750 ms, waits 1.5 s when the API is busy (429, 503), takes a `sync.required` event's snapshot
//! as the record, and stops at a record `done` says is final. Another refusal ends the stream.
use std::time::Duration;

use futures_util::{Stream, StreamExt, stream::BoxStream};
use reqwest::{StatusCode, header};
use serde::de::DeserializeOwned;

use crate::{
    api::Caller,
    realtime::{Event, events},
};

/// The web client's wait before it reconnects (`waitForJobReconnect(750)`).
const RECONNECT: Duration = Duration::from_millis(750);
/// Its wait when the API is busy (`waitForJobReconnect(1_500)`).
const BUSY: Duration = Duration::from_millis(1_500);
/// The stream sends a keepalive every 15 s; three missed is a dead connection.
const SILENCE: Duration = Duration::from_secs(45);

/// What the stream said.
#[derive(Debug, PartialEq, Eq)]
pub enum Update<T> {
    /// The job's record after a change, and the event's id: where a later stream can resume.
    Job(T, Option<String>),
    /// The API refused the stream (signed out, not allowed, no such job): nothing more comes.
    Refused(StatusCode),
}

impl Caller<'_> {
    /// The record of the job whose stream is at `path`, after each change after `from` (an
    /// event's id an update carried) or from the job's first event, until `done` says one is
    /// final (that one is the last) or the API refuses. The stream owns what it needs, so it can
    /// outlive the request that opened it.
    pub fn watch_job<T>(
        &self,
        path: &str,
        context: &str,
        from: Option<String>,
        done: fn(&T) -> bool,
    ) -> impl Stream<Item = Update<T>> + Send + use<T>
    where
        T: DeserializeOwned + Send + 'static,
    {
        let open = self.request(reqwest::Method::GET, path, context).header(header::ACCEPT, "text/event-stream");
        let state = Upstream { open, last: from, events: None, wait: None, over: false, done };
        futures_util::stream::unfold(state, Upstream::next).boxed()
    }
}

struct Upstream<T> {
    open: reqwest::RequestBuilder,
    /// The last event's id: where a reconnect resumes.
    last: Option<String>,
    events: Option<BoxStream<'static, Result<Event, ()>>>,
    /// How long to wait before connecting again.
    wait: Option<Duration>,
    /// The job is done, or the API refused: the stream has ended.
    over: bool,
    done: fn(&T) -> bool,
}

impl<T: DeserializeOwned> Upstream<T> {
    async fn next(mut self) -> Option<(Update<T>, Self)> {
        if self.over {
            return None;
        }
        loop {
            let Some(events) = self.events.as_mut() else {
                if let Some(wait) = self.wait.take() {
                    tokio::time::sleep(wait).await;
                }
                let mut open = self.open.try_clone().expect("a GET without a body clones");
                if let Some(last) = &self.last {
                    open = open.header("last-event-id", last);
                }
                match open.send().await {
                    Ok(res) if res.status().is_success() => {
                        self.events = Some(events(res.bytes_stream().map(|chunk| chunk.map_err(|_| ()))).boxed());
                    }
                    Ok(res) if matches!(res.status(), StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE) => {
                        self.wait = Some(BUSY);
                    }
                    Ok(res) => {
                        let status = res.status();
                        tracing::info!("job stream refused: {status}");
                        self.over = true;
                        return Some((Update::Refused(status), self));
                    }
                    Err(error) => {
                        tracing::warn!("job stream unreachable: {error}");
                        self.wait = Some(RECONNECT);
                    }
                }
                continue;
            };
            match tokio::time::timeout(SILENCE, events.next()).await {
                Ok(Some(Ok(event))) => {
                    if let Some(id) = &event.id {
                        self.last = Some(id.clone());
                    }
                    let Some(job) = record::<T>(&event) else { continue };
                    self.over = (self.done)(&job);
                    let id = self.last.clone();
                    return Some((Update::Job(job, id), self));
                }
                // Ended before the job was done, broke, or went quiet: connect again from the last id.
                Ok(Some(Err(()))) | Ok(None) | Err(_) => {
                    self.events = None;
                    self.wait = Some(RECONNECT);
                }
            }
        }
    }
}

/// The job's record in an event: its data, or a `sync.required` event's snapshot.
fn record<T: DeserializeOwned>(event: &Event) -> Option<T> {
    if event.data.is_empty() {
        return None;
    }
    let parsed = if event.event == "sync.required" {
        serde_json::from_str::<serde_json::Value>(&event.data)
            .ok()
            .and_then(|v| serde_json::from_value(v.get("snapshot")?.clone()).ok())
    } else {
        serde_json::from_str(&event.data).ok()
    };
    if parsed.is_none() {
        tracing::warn!("job stream sent an event that is not a job: {}", event.event);
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, serde::Deserialize, PartialEq)]
    struct Job {
        status: String,
    }

    #[test]
    fn a_sync_required_event_is_its_snapshot() {
        let event = |name: &str, data: &str| Event { event: name.into(), id: Some("3".into()), data: data.into() };
        assert_eq!(record::<Job>(&event("job.progress", r#"{"status":"running"}"#)), Some(Job { status: "running".into() }));
        let sync = r#"{"kind":"sync.required","reason":"replay-backpressure","snapshot":{"status":"completed"}}"#;
        assert_eq!(record::<Job>(&event("sync.required", sync)), Some(Job { status: "completed".into() }));
        assert_eq!(record::<Job>(&event("job.progress", "not json")), None);
    }
}
