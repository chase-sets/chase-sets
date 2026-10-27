//! A form with files, read until Corten can (todd-skelton/corten#140): `Form` takes only a
//! URL-encoded body, so a `multipart/form-data` post is a 415 before the handler runs, and axum's
//! default 2 MB limit would refuse one phone photo. The handler takes the raw body, which has no
//! limit, and this reads it with `multer` under limits of its own: the text fields as `Raw` (what
//! `Query<Raw>` reads from an address, so a page reads its form and its address alike) and each
//! file whole. Remove it when Corten reads a multipart form.
use std::collections::BTreeMap;

use bytes::Bytes;
use corten::axum::{
    body::Body,
    http::{HeaderMap, header},
};
use multer::{Constraints, Multipart, SizeLimit};

use crate::items::{Raw, Values};

/// How much a form may send.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// One file's bytes.
    pub file: u64,
    /// How many files, empty file inputs left out.
    pub files: usize,
    /// The whole body's bytes.
    pub whole: u64,
}

/// A file the form sent.
#[derive(Clone, Debug)]
pub struct Upload {
    /// The file input's name.
    pub field: String,
    pub filename: String,
    /// The type the browser declared (`image/jpeg`), as it said it.
    pub content_type: String,
    pub bytes: Bytes,
}

/// What a multipart form sent: its text fields, its files, and a file it left out.
#[derive(Clone, Debug, Default)]
pub struct Posted {
    pub fields: Raw,
    pub files: Vec<Upload>,
    /// A file over a limit, read past and left out, so the form keeps every other field.
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
#[derive(Debug, PartialEq, Eq)]
pub enum Unread {
    /// Not `multipart/form-data`, or no boundary.
    NotMultipart,
    /// The body over `Limits::whole`: what came after the limit is not read.
    TooLarge,
    /// The body is not a multipart form, or the connection ended.
    Broken,
}

/// Reads a multipart form. A file input left empty (no name, no bytes) is no file.
pub async fn read(headers: &HeaderMap, body: Body, limits: Limits) -> Result<Posted, Unread> {
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let boundary = multer::parse_boundary(content_type).map_err(|_| Unread::NotMultipart)?;
    let constraints = Constraints::new().size_limit(SizeLimit::new().whole_stream(limits.whole));
    let mut form = Multipart::with_constraints(body.into_data_stream(), boundary, constraints);
    let mut over = None;
    let mut fields: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut files = Vec::new();
    loop {
        let mut field = match form.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => return Err(unread(error)),
        };
        let name = field.name().unwrap_or_default().to_owned();
        match field.file_name().map(str::to_owned) {
            Some(filename) => {
                let content_type = field.content_type().map(|m| m.essence_str().to_owned()).unwrap_or_default();
                // Read up to the limit; past it, read on without keeping, so the fields after
                // the file are still read.
                let mut kept = Vec::new();
                let mut size = 0u64;
                while let Some(chunk) = field.chunk().await.map_err(unread)? {
                    size += chunk.len() as u64;
                    if size <= limits.file {
                        kept.extend_from_slice(&chunk);
                    }
                }
                if filename.is_empty() && size == 0 {
                    continue;
                }
                if size > limits.file {
                    over.get_or_insert(Over::FileTooLarge);
                } else if files.len() == limits.files {
                    over.get_or_insert(Over::TooManyFiles);
                } else {
                    files.push(Upload { field: name, filename, content_type, bytes: Bytes::from(kept) });
                }
            }
            None => {
                let text = field.text().await.map_err(unread)?;
                fields.entry(name).or_default().push(text);
            }
        }
    }
    let fields = fields
        .into_iter()
        .map(|(name, mut values)| {
            let values = if values.len() == 1 { Values::One(values.remove(0)) } else { Values::Many(values) };
            (name, values)
        })
        .collect();
    Ok(Posted { fields, files, over })
}

fn unread(error: multer::Error) -> Unread {
    match error {
        multer::Error::StreamSizeExceeded { .. } => Unread::TooLarge,
        _ => Unread::Broken,
    }
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
    use super::*;

    const LIMITS: Limits = Limits { file: 16, files: 2, whole: 1024 };

    fn multipart(parts: &[(&str, Option<&str>, &str)]) -> (HeaderMap, Body) {
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
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "multipart/form-data; boundary=b".parse().unwrap());
        (headers, Body::from(body))
    }

    #[tokio::test]
    async fn fields_are_raw_and_files_whole() {
        let (headers, body) = multipart(&[
            ("price", None, "12.50"),
            ("option.form", None, "raw"),
            ("tag", None, "a"),
            ("tag", None, "b"),
            ("evidence", Some("front.png"), "abc"),
            ("evidence", Some(""), ""),
        ]);
        let posted = read(&headers, body, LIMITS).await.unwrap();
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
        let (headers, body) = multipart(&[("evidence", Some("big.png"), "0123456789abcdefg"), ("price", None, "3")]);
        let posted = read(&headers, body, LIMITS).await.unwrap();
        assert_eq!((posted.over, posted.files.len()), (Some(Over::FileTooLarge), 0));
        assert_eq!(posted.fields["price"].all(), ["3"]);
        let three = [("evidence", Some("1.png"), "a"), ("evidence", Some("2.png"), "b"), ("evidence", Some("3.png"), "c")];
        let (headers, body) = multipart(&three);
        let posted = read(&headers, body, LIMITS).await.unwrap();
        assert_eq!((posted.over, posted.files.len()), (Some(Over::TooManyFiles), 2));
        let (headers, body) = multipart(&[("evidence", Some("1.png"), "a")]);
        let small = Limits { whole: 40, ..LIMITS };
        assert_eq!(read(&headers, body, small).await.unwrap_err(), Unread::TooLarge);
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/x-www-form-urlencoded".parse().unwrap());
        assert_eq!(read(&headers, Body::from("a=b"), LIMITS).await.unwrap_err(), Unread::NotMultipart);
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
