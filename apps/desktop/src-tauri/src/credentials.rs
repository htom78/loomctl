const KEYRING_SERVICE: &str = "dev.loom.desktop";

pub fn set_secret(profile_id: &str, token: &str) -> Result<(), String> {
    super::security::validate_profile_id(profile_id)?;
    if token.trim().is_empty() {
        return Err("token cannot be empty".into());
    }
    keyring::Entry::new(KEYRING_SERVICE, profile_id)
        .map_err(redacted_keyring_error)?
        .set_password(token)
        .map_err(redacted_keyring_error)
}

#[tauri::command]
pub fn save_secret(profile_id: String, token: String) -> Result<(), String> {
    set_secret(&profile_id, &token)
}

#[tauri::command]
pub fn load_secret(profile_id: String) -> Result<Option<String>, String> {
    super::security::validate_profile_id(&profile_id)?;
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
pub fn delete_secret(profile_id: String) -> Result<(), String> {
    super::security::validate_profile_id(&profile_id)?;
    match keyring::Entry::new(KEYRING_SERVICE, &profile_id)
        .map_err(redacted_keyring_error)?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(redacted_keyring_error(error)),
    }
}

fn redacted_keyring_error(_: keyring::Error) -> String {
    "operating system credential store operation failed".into()
}
