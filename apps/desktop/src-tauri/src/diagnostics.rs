use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const MAX_EVENTS: usize = 50;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEvent {
    at_unix_ms: u128,
    category: String,
    status: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    schema_version: &'static str,
    app_version: String,
    os: &'static str,
    architecture: &'static str,
    events: Vec<DiagnosticEvent>,
    pending_crash: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEventInput {
    category: String,
    status: Option<u16>,
}

#[derive(Default)]
pub struct DiagnosticsState {
    events: Mutex<VecDeque<DiagnosticEvent>>,
    crash_path: Mutex<Option<PathBuf>>,
}

pub fn initialize(app: &AppHandle, state: &DiagnosticsState) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop diagnostics directory is unavailable")?;
    fs::create_dir_all(&root).map_err(|_| "desktop diagnostics directory could not be created")?;
    let path = root.join("pending-crash.json");
    *state
        .crash_path
        .lock()
        .map_err(|_| "diagnostics state is unavailable")? = Some(path.clone());
    install_panic_hook(path);
    Ok(())
}

#[tauri::command]
pub fn record_diagnostic(
    state: State<'_, DiagnosticsState>,
    input: DiagnosticEventInput,
) -> Result<(), String> {
    if !matches!(
        input.category.as_str(),
        "auth" | "network" | "update" | "ui"
    ) {
        return Err("invalid diagnostic category".into());
    }
    let mut events = state
        .events
        .lock()
        .map_err(|_| "diagnostics state is unavailable")?;
    events.push_back(DiagnosticEvent {
        at_unix_ms: now_unix_ms(),
        category: input.category,
        status: input.status,
    });
    while events.len() > MAX_EVENTS {
        events.pop_front();
    }
    Ok(())
}

#[tauri::command]
pub fn diagnostic_report(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
) -> Result<DiagnosticReport, String> {
    report(&app, &state)
}

#[tauri::command]
pub async fn submit_pending_crash(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
    enabled: bool,
    endpoint: String,
    ca_pem: Option<String>,
) -> Result<bool, String> {
    if !enabled {
        return Err("crash reporting is not enabled".into());
    }
    let endpoint = super::security::validate_external_url(&endpoint)?;
    let path = crash_path(&state)?;
    if !path.exists() {
        return Ok(false);
    }
    let report = report(&app, &state)?;
    let response = super::native_http::client_with_ca(ca_pem.as_deref())?
        .post(endpoint)
        .json(&report)
        .send()
        .await
        .map_err(|_| "crash report submission failed")?;
    if !response.status().is_success() {
        return Err("crash report endpoint rejected the report".into());
    }
    fs::remove_file(path).map_err(|_| "submitted crash report could not be cleared")?;
    Ok(true)
}

fn report(app: &AppHandle, state: &DiagnosticsState) -> Result<DiagnosticReport, String> {
    let events = state
        .events
        .lock()
        .map_err(|_| "diagnostics state is unavailable")?
        .iter()
        .cloned()
        .collect();
    let path = crash_path(state)?;
    let pending_crash = read_pending_crash(&path);
    Ok(DiagnosticReport {
        schema_version: "loom-desktop-diagnostics/v1",
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        events,
        pending_crash,
    })
}

fn read_pending_crash(path: &Path) -> Option<serde_json::Value> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn crash_path(state: &DiagnosticsState) -> Result<PathBuf, String> {
    state
        .crash_path
        .lock()
        .map_err(|_| "diagnostics state is unavailable")?
        .clone()
        .ok_or_else(|| "diagnostics are not initialized".into())
}

fn install_panic_hook(path: PathBuf) {
    let _ = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location();
        let value = serde_json::json!({
            "schemaVersion": "loom-desktop-crash/v1",
            "occurredAtUnixMs": now_unix_ms(),
            "kind": "rust_panic",
            "location": location.map(|value| serde_json::json!({
                "file": Path::new(value.file()).file_name().and_then(|name| name.to_str()).unwrap_or("unknown"),
                "line": value.line(),
                "column": value.column(),
            })),
        });
        if let Ok(bytes) = serde_json::to_vec(&value) {
            let _ = fs::write(&path, bytes);
        }
        eprintln!("Loom Desktop encountered an unrecoverable error");
    }));
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_events_are_structured_without_message_fields() {
        let event = DiagnosticEvent {
            at_unix_ms: 1,
            category: "network".into(),
            status: Some(503),
        };
        let value = serde_json::to_value(event).expect("diagnostic event");
        assert_eq!(value["category"], "network");
        assert!(value.get("message").is_none());
        assert!(value.get("token").is_none());
    }
}
