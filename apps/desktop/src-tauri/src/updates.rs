use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    published_at: Option<String>,
    channel: String,
    rollback: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackMetadata {
    schema_version: String,
    channel: String,
    current_version: String,
    current_tag: String,
    previous_version: Option<String>,
    previous_tag: Option<String>,
    published_at: String,
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    channel: String,
    allow_rollback: bool,
) -> Result<Option<UpdateInfo>, String> {
    let endpoint = channel_url(
        &channel,
        if allow_rollback {
            "rollback-latest.json"
        } else {
            "latest.json"
        },
    )?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|_| "update channel could not be configured")?
        .timeout(Duration::from_secs(30));
    if allow_rollback {
        builder = builder.version_comparator(|current, remote| remote.version != current);
    }
    let update = builder
        .build()
        .map_err(|_| "updater could not be initialized")?
        .check()
        .await
        .map_err(|_| "signed update check failed")?;
    let info = update.as_ref().map(|value| UpdateInfo {
        version: value.version.clone(),
        current_version: value.current_version.clone(),
        notes: value.body.clone(),
        published_at: value.date.map(|date| date.to_string()),
        channel: channel.clone(),
        rollback: allow_rollback && is_older_version(&value.version, &value.current_version),
    });
    *state
        .pending
        .lock()
        .map_err(|_| "update state is unavailable")? = update;
    Ok(info)
}

#[tauri::command]
pub async fn install_update(state: State<'_, UpdateState>) -> Result<bool, String> {
    let update = state
        .pending
        .lock()
        .map_err(|_| "update state is unavailable")?
        .take();
    let Some(update) = update else {
        return Ok(false);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "signed update installation failed")?;
    Ok(true)
}

#[tauri::command]
pub async fn rollback_metadata(channel: String) -> Result<RollbackMetadata, String> {
    let endpoint = channel_url(&channel, "rollback.json")?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "rollback client could not be initialized")?
        .get(endpoint)
        .send()
        .await
        .map_err(|_| "rollback metadata request failed")?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 32 * 1024 {
        return Err("rollback metadata is unavailable".into());
    }
    let metadata = response
        .json::<RollbackMetadata>()
        .await
        .map_err(|_| "rollback metadata is invalid")?;
    if metadata.schema_version != "loom-desktop-rollback/v1" || metadata.channel != channel {
        return Err("rollback metadata does not match the selected channel".into());
    }
    Ok(metadata)
}

fn channel_url(channel: &str, file: &str) -> Result<Url, String> {
    if !matches!(channel, "stable" | "beta") {
        return Err("update channel must be stable or beta".into());
    }
    #[cfg(feature = "e2e")]
    if let Ok(base) = std::env::var("LOOM_DESKTOP_E2E_UPDATE_BASE_URL") {
        return loopback_channel_url(&base, channel, file);
    }
    Url::parse(&format!(
        "https://github.com/htom78/loomctl/releases/download/desktop-{channel}/{file}"
    ))
    .map_err(|_| "invalid update channel URL".into())
}

#[cfg(feature = "e2e")]
fn loopback_channel_url(base: &str, channel: &str, file: &str) -> Result<Url, String> {
    let base = Url::parse(base).map_err(|_| "invalid E2E update URL")?;
    let loopback = match base.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(domain)) => domain == "localhost",
        None => false,
    };
    if base.scheme() != "http"
        || !loopback
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("E2E update URL must be an unauthenticated HTTP loopback origin".into());
    }
    base.join(&format!("{channel}/{file}"))
        .map_err(|_| "invalid E2E update URL".into())
}

fn is_older_version(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(current),
    ) {
        (Ok(candidate), Ok(current)) => candidate < current,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use minisign_verify::{PublicKey, Signature};
    use std::{env, fs};

    #[test]
    fn update_channels_are_fixed_to_project_releases() {
        assert_eq!(
            channel_url("stable", "latest.json")
                .expect("stable")
                .as_str(),
            "https://github.com/htom78/loomctl/releases/download/desktop-stable/latest.json"
        );
        assert!(channel_url("nightly", "latest.json").is_err());
        assert!(channel_url("stable", "rollback-latest.json").is_ok());
        assert!(is_older_version("1.9.0", "1.10.0"));
        assert!(!is_older_version("invalid", "1.10.0"));
    }

    #[cfg(feature = "e2e")]
    #[test]
    fn e2e_update_url_accepts_only_http_loopback_origins() {
        assert_eq!(
            loopback_channel_url("http://127.0.0.1:18787/", "stable", "latest.json")
                .expect("loopback")
                .as_str(),
            "http://127.0.0.1:18787/stable/latest.json"
        );
        assert!(loopback_channel_url("https://127.0.0.1/", "stable", "latest.json").is_err());
        assert!(loopback_channel_url("http://example.com/", "stable", "latest.json").is_err());
        assert!(loopback_channel_url("http://user@localhost/", "stable", "latest.json").is_err());
    }

    #[test]
    #[ignore = "requires a signed updater artifact"]
    fn signed_updater_artifact_matches_embedded_key() {
        let artifact = fs::read(env::var("LOOM_TEST_UPDATE_ARTIFACT").expect("artifact path"))
            .expect("read artifact");
        let signature =
            fs::read_to_string(env::var("LOOM_TEST_UPDATE_SIGNATURE").expect("signature path"))
                .expect("read signature");
        let public_key = env::var("LOOM_TEST_UPDATE_PUBLIC_KEY").expect("public key");

        assert!(!artifact.is_empty(), "artifact must not be empty");
        verify_update_signature(&artifact, &signature, &public_key)
            .expect("signed updater artifact must verify");

        let mut tampered = artifact;
        let index = tampered.len() / 2;
        tampered[index] ^= 1;
        assert!(verify_update_signature(&tampered, &signature, &public_key).is_err());
    }

    fn verify_update_signature(
        artifact: &[u8],
        signature: &str,
        public_key: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let public_key = String::from_utf8(STANDARD.decode(public_key.trim())?)?;
        let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
        PublicKey::decode(&public_key)?.verify(artifact, &Signature::decode(&signature)?, true)?;
        Ok(())
    }
}
