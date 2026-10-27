//! A form with files, read with Corten's `Upload` under the pilot's limits: the text fields as
//! `Raw` (what `Query<Raw>` reads from an address, so a page reads its form and its address
//! alike) and each file whole, up to its limit. A file over its limit, or one past the count, is
//! read past and left out, so the form keeps every other field.
use bytes::Bytes;
use corten::{
    Upload,
    axum::http::{HeaderMap, header},
};

use crate::items::Raw;

/// How much a form may send.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// One file's bytes.
    pub file: usize,
    /// How many files, empty file inputs left out.
    pub files: usize,
    /// The whole body's bytes.
    pub whole: usize,
}

/// A file the form sent.
#[derive(Clone, Debug)]
pub struct Sent {
    /// The file input's name.
    pub field: String,
    pub filename: String,
    /// The type the browser declared (`image/jpeg`), without parameters.
    pub content_type: String,
    pub bytes: Bytes,
}

/// What a multipart form sent: its text fields, its files, and a file it left out.
#[derive(Clone, Debug, Default)]
pub struct Posted {
    pub fields: Raw,
    pub files: Vec<Sent>,
    /// A file over a limit, read past and left out.
    pub over: Option<Over>,
}

/// A file left out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Over {
    /// A file over `Limits::file`.
    FileTooLarge,
    /// More files than `Limits::files`.
    TooManyFiles,
}

/// Why a body was not read.
#[derive(Debug)]
pub enum Unread {
    /// The body says it is over `Limits::whole`, so none of it is read.
    TooLarge,
    /// Corten refused it: over the limit as it arrived (413), broken (400) or fields that are not
    /// `Raw` (422).
    Refused(corten::Error),
}

/// Reads a multipart form. A file input left empty is no file.
///
/// A body over the limit is a 413 `corten::Error` from `Upload`, which a handler cannot tell
/// from a broken one: the error's status is not readable (todd-skelton/corten#150). So a body
/// whose `Content-Length` is over the limit is refused here first, and the page can say the
/// photos were too large; one without a length that turns out too large is Corten's 413.
pub async fn read(headers: &HeaderMap, mut upload: Upload<Raw>, limits: Limits) -> Result<Posted, Unread> {
    let length = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if length.is_some_and(|length| length > limits.whole) {
        return Err(Unread::TooLarge);
    }
    upload.limit(limits.whole);
    let (mut files, mut over) = (Vec::new(), None);
    while let Some(mut file) = upload.next_file().await.map_err(Unread::Refused)? {
        if files.len() == limits.files {
            over.get_or_insert(Over::TooManyFiles);
            continue;
        }
        let field = file.field().to_owned();
        let filename = file.filename().to_owned();
        let content_type = file.content_type().split(';').next().unwrap_or_default().trim().to_owned();
        match file.bytes_up_to(limits.file).await.map_err(Unread::Refused)? {
            Some(bytes) => files.push(Sent { field, filename, content_type, bytes }),
            None => {
                over.get_or_insert(Over::FileTooLarge);
            }
        }
    }
    let fields = upload.fields().await.map_err(Unread::Refused)?;
    Ok(Posted { fields, files, over })
}

/// Whether a file's first bytes are the picture type it claims, JPEG, PNG or WebP: the platform
/// API answers 500 to a file it cannot decode (chase-sets/chase-sets#10649), so the pilot checks
/// what it can before sending. Remove the check when that issue lands.
pub fn is_picture(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use corten::axum::{body::Body, extract::FromRequest, http::Request};

    use super::*;

    const LIMITS: Limits = Limits { file: 16, files: 2, whole: 1024 };

    fn multipart(parts: &[(&str, Option<&str>, &str)]) -> Request<Body> {
        let mut body = String::new();
        for (name, filename, value) in parts {
            body.push_str("--b\r\n");
            match filename {
                Some(file) => body.push_str(&format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file}\"\r\nContent-Type: image/png\r\n\r\n"
                )),
                None => body.push_str(&format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n")),
            }
            body.push_str(value);
            body.push_str("\r\n");
        }
        body.push_str("--b--\r\n");
        Request::builder()
            .header(header::CONTENT_TYPE, "multipart/form-data; boundary=b")
            .header(header::CONTENT_LENGTH, body.len())
            .body(Body::from(body))
            .unwrap()
    }

    async fn read_with(req: Request<Body>, limits: Limits) -> Result<Posted, Unread> {
        let headers = req.headers().clone();
        let upload = Upload::<Raw>::from_request(req, &()).await.map_err(|_| Unread::TooLarge).expect("a multipart body");
        read(&headers, upload, limits).await
    }

    #[tokio::test]
    async fn fields_are_raw_and_files_whole() {
        let req = multipart(&[
            ("price", None, "12.50"),
            ("option.form", None, "raw"),
            ("tag", None, "a"),
            ("tag", None, "b"),
            ("evidence", Some("front.png"), "abc"),
            ("evidence", Some(""), ""),
        ]);
        let posted = read_with(req, LIMITS).await.unwrap();
        assert_eq!(posted.fields["price"].all(), ["12.50"]);
        assert_eq!(posted.fields["option.form"].all(), ["raw"]);
        assert_eq!(posted.fields["tag"].all(), ["a", "b"]);
        assert_eq!(posted.files.len(), 1, "an empty file input is no file");
        let file = &posted.files[0];
        assert_eq!(
            (file.field.as_str(), file.filename.as_str(), file.content_type.as_str()),
            ("evidence", "front.png", "image/png")
        );
        assert_eq!(&file.bytes[..], b"abc");
    }

    #[tokio::test]
    async fn a_file_over_a_limit_is_left_out_and_the_fields_after_it_are_read() {
        let req = multipart(&[("evidence", Some("big.png"), "0123456789abcdefg"), ("price", None, "3")]);
        let posted = read_with(req, LIMITS).await.unwrap();
        assert_eq!((posted.over, posted.files.len()), (Some(Over::FileTooLarge), 0));
        assert_eq!(posted.fields["price"].all(), ["3"]);
        let three = [("evidence", Some("1.png"), "a"), ("evidence", Some("2.png"), "b"), ("evidence", Some("3.png"), "c")];
        let posted = read_with(multipart(&three), LIMITS).await.unwrap();
        assert_eq!((posted.over, posted.files.len()), (Some(Over::TooManyFiles), 2));
        let small = Limits { whole: 40, ..LIMITS };
        let refused = read_with(multipart(&[("evidence", Some("1.png"), "a")]), small).await;
        assert!(matches!(refused, Err(Unread::TooLarge)), "a body whose length is over the limit is not read");
    }

    #[tokio::test]
    async fn a_body_over_the_limit_without_a_length_is_corten_s_413() {
        let mut req = multipart(&[("evidence", Some("1.png"), "a")]);
        req.headers_mut().remove(header::CONTENT_LENGTH);
        let refused = read_with(req, Limits { whole: 40, ..LIMITS }).await;
        let Err(Unread::Refused(error)) = refused else { panic!("not refused") };
        let res = corten::axum::response::IntoResponse::into_response(error);
        assert_eq!(res.status(), corten::axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn a_picture_is_known_by_its_first_bytes() {
        assert!(is_picture("image/jpeg", &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(is_picture("image/png", b"\x89PNG\r\n\x1a\n...."));
        assert!(is_picture("image/webp", b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!is_picture("image/jpeg", b"this is not a picture"));
        assert!(!is_picture("image/png", &[0xff, 0xd8, 0xff]), "a JPEG named a PNG");
        assert!(!is_picture("image/gif", b"GIF89a"));
    }
}
