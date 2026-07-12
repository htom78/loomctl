use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::{header::HeaderName, redirect::Policy, Certificate, Client, Method};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct ProfileClient {
    base_url: Url,
    client: Client,
}

#[derive(Default)]
pub struct HttpState {
    profiles: Mutex<HashMap<String, ProfileClient>>,
    cancellations: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHttpRequest {
    profile_id: String,
    request_id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHttpHead {
    status: u16,
    headers: Vec<(String, String)>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum NativeStreamEvent {
    Chunk { data: String },
    End,
    Error { message: String },
}

#[tauri::command]
pub fn configure_http_profile(
    state: State<'_, HttpState>,
    profile_id: String,
    base_url: String,
    ca_pem: Option<String>,
) -> Result<(), String> {
    super::security::validate_profile_id(&profile_id)?;
    let base_url = super::security::validate_service_url(&base_url, true)?;
    let client = client_with_ca(ca_pem.as_deref())?;
    state
        .profiles
        .lock()
        .map_err(|_| "HTTP profile state is unavailable")?
        .insert(profile_id, ProfileClient { base_url, client });
    Ok(())
}

#[tauri::command]
pub async fn http_request(
    state: State<'_, HttpState>,
    request: NativeHttpRequest,
) -> Result<NativeHttpResponse, String> {
    validate_request_id(&request.request_id)?;
    let (client, url) = profile_request(&state, &request.profile_id, &request.url)?;
    let response = execute(&client, url, &request).await?;
    let status = response.status().as_u16();
    let headers = response_headers(response.headers());
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
        return Err("Loom response exceeds the desktop safety limit".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Loom response body could not be read")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Loom response exceeds the desktop safety limit".into());
    }
    let body = String::from_utf8(bytes.to_vec()).map_err(|_| "Loom response is not UTF-8")?;
    Ok(NativeHttpResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
pub async fn start_http_stream(
    app: AppHandle,
    state: State<'_, HttpState>,
    request: NativeHttpRequest,
    on_event: Channel<NativeStreamEvent>,
) -> Result<NativeHttpHead, String> {
    validate_request_id(&request.request_id)?;
    if request.method.to_uppercase() != "GET" || request.body.is_some() {
        return Err("stream requests must be GET without a body".into());
    }
    let (client, url) = profile_request(&state, &request.profile_id, &request.url)?;
    let response = execute(&client, url, &request).await?;
    let head = NativeHttpHead {
        status: response.status().as_u16(),
        headers: response_headers(response.headers()),
    };
    let cancellation = CancellationToken::new();
    state
        .cancellations
        .lock()
        .map_err(|_| "HTTP stream state is unavailable")?
        .insert(request.request_id.clone(), cancellation.clone());
    let request_id = request.request_id;
    tauri::async_runtime::spawn(async move {
        let mut body = response.bytes_stream();
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                item = body.next() => match item {
                    Some(Ok(bytes)) => {
                        if on_event.send(NativeStreamEvent::Chunk { data: STANDARD.encode(bytes) }).is_err() {
                            break;
                        }
                    }
                    Some(Err(_)) => {
                        let _ = on_event.send(NativeStreamEvent::Error { message: "Loom event stream ended unexpectedly".into() });
                        break;
                    }
                    None => {
                        let _ = on_event.send(NativeStreamEvent::End);
                        break;
                    }
                }
            }
        }
        if let Ok(mut values) = app.state::<HttpState>().cancellations.lock() {
            values.remove(&request_id);
        }
    });
    Ok(head)
}

#[tauri::command]
pub fn cancel_http_stream(state: State<'_, HttpState>, request_id: String) -> Result<(), String> {
    validate_request_id(&request_id)?;
    if let Some(cancellation) = state
        .cancellations
        .lock()
        .map_err(|_| "HTTP stream state is unavailable")?
        .remove(&request_id)
    {
        cancellation.cancel();
    }
    Ok(())
}

pub fn client_with_ca(ca_pem: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(130))
        .user_agent("Loom-Desktop/0.3");
    if let Some(pem) = super::security::validate_ca_pem(ca_pem)? {
        let certificates = Certificate::from_pem_bundle(pem.as_bytes())
            .map_err(|_| "custom CA PEM could not be parsed")?;
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder
        .build()
        .map_err(|_| "secure HTTP client could not be created".into())
}

fn profile_request(
    state: &State<'_, HttpState>,
    profile_id: &str,
    value: &str,
) -> Result<(Client, Url), String> {
    super::security::validate_profile_id(profile_id)?;
    let profiles = state
        .profiles
        .lock()
        .map_err(|_| "HTTP profile state is unavailable")?;
    let profile = profiles
        .get(profile_id)
        .ok_or_else(|| "HTTP profile is not configured".to_string())?;
    let url = super::security::request_url(&profile.base_url, value)?;
    Ok((profile.client.clone(), url))
}

async fn execute(
    client: &Client,
    url: Url,
    request: &NativeHttpRequest,
) -> Result<reqwest::Response, String> {
    let method =
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "invalid HTTP method")?;
    if !matches!(
        method,
        Method::GET | Method::POST | Method::DELETE | Method::PUT | Method::PATCH
    ) {
        return Err("HTTP method is not allowed".into());
    }
    if request.body.as_ref().map_or(0, |body| body.len()) > MAX_REQUEST_BYTES {
        return Err("Loom request exceeds the desktop safety limit".into());
    }
    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if !matches!(lower.as_str(), "accept" | "authorization" | "content-type") {
            return Err("HTTP header is not allowed".into());
        }
        let name = HeaderName::from_bytes(lower.as_bytes()).map_err(|_| "invalid HTTP header")?;
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    builder
        .send()
        .await
        .map_err(|_| "secure Loom network request failed".into())
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "content-type" | "content-length" | "retry-after"
            )
        })
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn validate_request_id(value: &str) -> Result<(), String> {
    if value.len() >= 8
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        Ok(())
    } else {
        Err("invalid request id".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_client_accepts_an_added_certificate_chain() {
        let certificate = rcgen::generate_simple_self_signed(vec!["enterprise.local".into()])
            .expect("test certificate");
        assert!(client_with_ca(Some(&certificate.cert.pem())).is_ok());
        assert!(client_with_ca(Some("not a certificate")).is_err());
    }

    #[test]
    fn request_ids_are_bounded() {
        assert!(validate_request_id("request-12345678").is_ok());
        assert!(validate_request_id("../request").is_err());
    }
}
