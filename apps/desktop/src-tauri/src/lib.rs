const KEYRING_SERVICE: &str = "dev.loom.desktop";

#[tauri::command]
fn save_secret(profile_id: String, token: String) -> Result<(), String> {
    validate_profile_id(&profile_id)?;
    if token.trim().is_empty() {
        return Err("token cannot be empty".into());
    }
    keyring::Entry::new(KEYRING_SERVICE, &profile_id)
        .map_err(redacted_keyring_error)?
        .set_password(&token)
        .map_err(redacted_keyring_error)
}

#[tauri::command]
fn load_secret(profile_id: String) -> Result<Option<String>, String> {
    validate_profile_id(&profile_id)?;
    match keyring::Entry::new(KEYRING_SERVICE, &profile_id)
        .map_err(redacted_keyring_error)?
        .get_password()
    {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(redacted_keyring_error(error)),
    }
}

#[tauri::command]
fn delete_secret(profile_id: String) -> Result<(), String> {
    validate_profile_id(&profile_id)?;
    match keyring::Entry::new(KEYRING_SERVICE, &profile_id)
        .map_err(redacted_keyring_error)?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(redacted_keyring_error(error)),
    }
}

fn validate_profile_id(value: &str) -> Result<(), String> {
    if value.len() >= 8 && value.len() <= 128 && value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-') {
        Ok(())
    } else {
        Err("invalid profile id".into())
    }
}

fn redacted_keyring_error(_: keyring::Error) -> String {
    "operating system credential store operation failed".into()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_secret, load_secret, delete_secret])
        .run(tauri::generate_context!())
        .expect("error while running Loom Desktop");
}
