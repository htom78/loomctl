mod auth;
mod credentials;
mod diagnostics;
mod native_http;
mod security;
mod updates;

use tauri::Manager;

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = security::validate_external_url(&url)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
        .map_err(|_| "external URL could not be opened".into())
}

fn internal_navigation(url: &url::Url) -> bool {
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    packaged || development
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(native_http::HttpState::default())
        .manage(auth::OidcState::default())
        .manage(diagnostics::DiagnosticsState::default())
        .manage(updates::UpdateState::default())
        .setup(|app| {
            diagnostics::initialize(
                app.handle(),
                app.state::<diagnostics::DiagnosticsState>().inner(),
            )?;
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("main window configuration is missing")?;
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(internal_navigation)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            credentials::save_secret,
            credentials::load_secret,
            credentials::delete_secret,
            native_http::configure_http_profile,
            native_http::http_request,
            native_http::start_http_stream,
            native_http::cancel_http_stream,
            auth::start_oidc_login,
            auth::complete_oidc_login,
            diagnostics::record_diagnostic,
            diagnostics::diagnostic_report,
            diagnostics::submit_pending_crash,
            updates::check_update,
            updates::install_update,
            updates::rollback_metadata,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loom Desktop");
}
