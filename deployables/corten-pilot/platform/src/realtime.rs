//! The platform's realtime stream (`/api/realtime/public/events`, infrastructure/platform-runtime
//! realtime.ts) as the signed-in user: a tick for every change to the topics, as admin-web's
//! `subscribeRealtimePatches` sees them. A page that shows a projection reads it again on a
//! tick, as `useCatalogRealtimeRevalidation` revalidates the route.
//!
//! Like the web client it resumes after a dropped connection from the last event's cursor, backs
//! off a second after an error, and treats `sync.required` as a change. The changes in a short
//! window are one tick (admin-web debounces its revalidation by 150 ms).
use std::{collections::VecDeque, time::Duration};

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream::BoxStream};
use reqwest::{StatusCode, header};

use crate::api::Caller;

/// admin-web's revalidation debounce (`DEFAULT_REVALIDATION_DEBOUNCE_MS`).
const DEBOUNCE: Duration = Duration::from_millis(150);
/// The web client's reconnect backoff (`DEFAULT_RECONNECT_POLICY.backoffMs`).
const BACKOFF: Duration = Duration::from_secs(1);
/// The stream sends a heartbeat every 15 s; three missed is a dead connection.
const SILENCE: Duration = Duration::from_secs(45);

/// What the stream said.
#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    /// The topics changed (a `projection.patch`, or a `sync.required`): read again.
    Changed,
    /// The API refused the stream (signed out, or not allowed): it will not send changes.
    Refused(StatusCode),
}

/// One server-sent event: its type, id and data.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Event {
    pub event: String,
    pub id: Option<String>,
    pub data: String,
}

impl Caller<'_> {
    /// The changes to `topics` from now on, as ticks, until the API refuses the stream. The
    /// stream owns what it needs, so it can outlive the request that opened it.
    pub fn changes(&self, topics: &[&str]) -> impl Stream<Item = Tick> + Send + use<> {
        let mut query: Vec<(&str, &str)> = topics.iter().map(|topic| ("topic", *topic)).collect();
        query.sort_unstable();
        let open = self.request(reqwest::Method::GET, "/api/realtime/public/events", "platform-runtime");
        let open = open.query(&query).header(header::ACCEPT, "text/event-stream");
        let state = Upstream { open, cursor: None, events: None, failed: false, refused: false };
        futures_util::stream::unfold(state, Upstream::next).boxed()
    }
}

struct Upstream {
    open: reqwest::RequestBuilder,
    /// The last event's id: the cursor a reconnect resumes from.
    cursor: Option<String>,
    events: Option<BoxStream<'static, Result<Event, ()>>>,
    /// The last connection failed: wait before the next.
    failed: bool,
    /// The API refused the stream: it has ended.
    refused: bool,
}

impl Upstream {
    async fn next(mut self) -> Option<(Tick, Self)> {
        if self.refused {
            return None;
        }
        loop {
            let Some(events) = self.events.as_mut() else {
                if std::mem::take(&mut self.failed) {
                    tokio::time::sleep(BACKOFF).await;
                }
                let open = self.open.try_clone().expect("a GET without a body clones");
                match connect(open, self.cursor.clone()).await {
                    Ok(events) => self.events = Some(events),
                    Err(Some(status)) => {
                        tracing::info!("realtime stream refused: {status}");
                        self.refused = true;
                        return Some((Tick::Refused(status), self));
                    }
                    Err(None) => self.failed = true,
                }
                continue;
            };
            match tokio::time::timeout(SILENCE, events.next()).await {
                Ok(Some(Ok(event))) => {
                    if let Some(id) = event.id {
                        self.cursor = Some(id);
                    }
                    if !matches!(event.event.as_str(), "projection.patch" | "sync.required") {
                        continue;
                    }
                    // The changes in the window are one tick.
                    let window = tokio::time::sleep(DEBOUNCE);
                    tokio::pin!(window);
                    loop {
                        tokio::select! {
                            () = &mut window => break,
                            more = events.next() => match more {
                                Some(Ok(Event { id: Some(id), .. })) => self.cursor = Some(id),
                                Some(Ok(_)) => {}
                                Some(Err(())) | None => {
                                    self.events = None;
                                    self.failed = true;
                                    break;
                                }
                            },
                        }
                    }
                    return Some((Tick::Changed, self));
                }
                // Ended, broke, or went quiet: connect again from the cursor.
                Ok(Some(Err(()))) | Ok(None) | Err(_) => {
                    self.events = None;
                    self.failed = true;
                }
            }
        }
    }
}

/// Opens the stream from `cursor`. `Err(Some(status))` is a refusal (not retried), `Err(None)` a
/// failure (retried).
async fn connect(
    mut open: reqwest::RequestBuilder,
    cursor: Option<String>,
) -> Result<BoxStream<'static, Result<Event, ()>>, Option<StatusCode>> {
    if let Some(cursor) = &cursor {
        open = open.query(&[("cursor", cursor)]);
    }
    {
        let res = open.send().await.map_err(|error| {
            tracing::warn!("realtime stream unreachable: {error}");
            None
        })?;
        let status = res.status();
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            return Err(Some(status));
        }
        if !status.is_success() {
            tracing::warn!("realtime stream answered {status}");
            return Err(None);
        }
        Ok(events(res.bytes_stream().map(|chunk| chunk.map_err(|_| ()))).boxed())
    }
}

/// The events in a `text/event-stream` body (the WHATWG parsing rules, minus `retry`).
pub fn events<S>(body: S) -> impl Stream<Item = Result<Event, ()>> + Send + 'static
where
    S: Stream<Item = Result<Bytes, ()>> + Send + Unpin + 'static,
{
    let state = (body, Vec::<u8>::new(), VecDeque::<Event>::new(), Event::default());
    futures_util::stream::unfold(state, |(mut body, mut buffer, mut ready, mut event)| async move {
        loop {
            if let Some(next) = ready.pop_front() {
                return Some((Ok(next), (body, buffer, ready, event)));
            }
            match body.next().await {
                Some(Ok(chunk)) => {
                    buffer.extend_from_slice(&chunk);
                    while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let mut line: Vec<u8> = buffer.drain(..=end).collect();
                        line.pop();
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        let line = String::from_utf8_lossy(&line);
                        if line.is_empty() {
                            if !event.data.is_empty() || !event.event.is_empty() || event.id.is_some() {
                                let done = std::mem::take(&mut event);
                                if !done.data.is_empty() {
                                    ready.push_back(Event { data: done.data.trim_end_matches('\n').to_owned(), ..done });
                                } else if done.id.is_some() {
                                    ready.push_back(done);
                                }
                            }
                            continue;
                        }
                        if line.starts_with(':') {
                            continue;
                        }
                        let (field, value) =
                            line.split_once(':').map_or((&*line, ""), |(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)));
                        match field {
                            "event" => event.event = value.to_owned(),
                            "id" => event.id = Some(value.to_owned()),
                            "data" => {
                                event.data.push_str(value);
                                event.data.push('\n');
                            }
                            _ => {}
                        }
                    }
                }
                Some(Err(())) => return Some((Err(()), (body, buffer, ready, event))),
                None => return None,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parse(chunks: &[&str]) -> Vec<Event> {
        let body = futures_util::stream::iter(chunks.iter().map(|c| Ok(Bytes::from(c.to_string()))).collect::<Vec<_>>());
        events(body).map(|e| e.unwrap()).collect().await
    }

    #[tokio::test]
    async fn events_are_split_across_chunks_and_lines() {
        let got = parse(&[
            "id: c1\nevent: heartbeat\ndata: {}\n\n: comment\n",
            "event: projection.patch\r\nid: c2\r\nda",
            "ta: {\"a\":1}\r\n\r\n",
        ])
        .await;
        assert_eq!(
            got,
            vec![
                Event { event: "heartbeat".into(), id: Some("c1".into()), data: "{}".into() },
                Event { event: "projection.patch".into(), id: Some("c2".into()), data: r#"{"a":1}"#.into() },
            ]
        );
    }
}
