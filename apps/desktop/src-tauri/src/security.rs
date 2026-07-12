use regex::Regex;
use std::sync::OnceLock;
use url::Url;

const MAX_CA_PEM_BYTES: usize = 256 * 1024;

pub fn validate_profile_id(value: &str) -> Result<(), String> {
    if value.len() >= 8
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        Ok(())
    } else {
        Err("invalid profile id".into())
    }
}

pub fn validate_ca_pem(value: Option<&str>) -> Result<Option<&str>, String> {
    let Some(pem) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if pem.len() > MAX_CA_PEM_BYTES
        || !pem.contains("-----BEGIN CERTIFICATE-----")
        || !pem.contains("-----END CERTIFICATE-----")
        || pem.contains("PRIVATE KEY")
    {
        return Err("custom CA must contain only a bounded PEM certificate chain".into());
    }
    Ok(Some(pem))
}

pub fn validate_service_url(value: &str, allow_path: bool) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "invalid service URL")?;
    validate_network_url(&url)?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("service URL must not contain credentials or fragments".into());
    }
    if url.query().is_some() {
        return Err("service URL must not contain query parameters".into());
    }
    if !allow_path && url.path() != "/" && !url.path().is_empty() {
        return Err("service URL must not contain a path".into());
    }
    if url.path().is_empty() {
        url.set_path("/");
    }
    Ok(url)
}

pub fn validate_network_url(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback(url.host_str()) => Ok(()),
        _ => Err("network URLs must use HTTPS; HTTP is limited to loopback development".into()),
    }
}

pub fn validate_callback_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "invalid authentication callback")?;
    if url.scheme() != "loom"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("untrusted authentication callback".into());
    }
    Ok(url)
}

pub fn validate_external_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "invalid external URL")?;
    validate_network_url(&url)?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("external URL must not contain credentials or fragments".into());
    }
    for (key, _) in url.query_pairs() {
        if sensitive_key().is_match(&key) {
            return Err("external URL contains a secret-bearing query parameter".into());
        }
    }
    Ok(url)
}

pub fn request_url(base: &Url, value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "invalid request URL")?;
    validate_network_url(&url)?;
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port_or_known_default() != base.port_or_known_default()
        || !path_is_within_base(base.path(), url.path())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("request URL is outside the configured Loom server".into());
    }
    if url
        .query_pairs()
        .any(|(key, _)| sensitive_key().is_match(&key))
    {
        return Err("request URL contains a secret-bearing query parameter".into());
    }
    Ok(url)
}

#[cfg(test)]
pub fn redact_text(value: &str) -> String {
    let bounded = value.chars().take(4096).collect::<String>();
    bearer_pattern()
        .replace_all(&bounded, "$1[redacted]")
        .into_owned()
}

fn is_loopback(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1"))
}

fn path_is_within_base(base: &str, candidate: &str) -> bool {
    if base == "/" {
        return true;
    }
    let base = base.trim_end_matches('/');
    candidate == base || candidate.starts_with(&format!("{base}/"))
}

fn sensitive_key() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new("(?i)(token|secret|password|authorization|cookie|api.?key|private.?key)")
            .expect("valid sensitive-key regex")
    })
}

#[cfg(test)]
fn bearer_pattern() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| {
        Regex::new("(?i)(bearer\\s+|(?:token|secret|password|api[_-]?key)\\s*[=:]\\s*)[^\\s,;]+")
            .expect("valid secret regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_urls_require_tls_outside_loopback() {
        assert!(validate_service_url("https://loom.example.com/base", true).is_ok());
        assert!(validate_service_url("http://127.0.0.1:8787", true).is_ok());
        assert!(validate_service_url("http://loom.example.com", true).is_err());
        assert!(validate_service_url("https://token@example.com", true).is_err());
    }

    #[test]
    fn callback_shape_is_exact() {
        assert!(validate_callback_url("loom://auth/callback?code=a&state=b").is_ok());
        assert!(validate_callback_url("loom://evil/callback?code=a&state=b").is_err());
        assert!(validate_callback_url("https://auth/callback?code=a&state=b").is_err());
    }

    #[test]
    fn custom_ca_rejects_private_keys() {
        assert!(validate_ca_pem(Some(
            "-----BEGIN CERTIFICATE-----\na\n-----END CERTIFICATE-----"
        ))
        .is_ok());
        assert!(validate_ca_pem(Some(
            "-----BEGIN PRIVATE KEY-----\na\n-----END PRIVATE KEY-----"
        ))
        .is_err());
    }

    #[test]
    fn diagnostics_scrub_bearer_and_inline_secrets() {
        let value = redact_text("failed Bearer abc123 password=hunter2 safe");
        assert!(!value.contains("abc123"));
        assert!(!value.contains("hunter2"));
        assert!(value.contains("safe"));
    }

    #[test]
    fn request_paths_cannot_escape_a_base_prefix() {
        let base = Url::parse("https://loom.example.com/api").expect("base");
        assert!(request_url(&base, "https://loom.example.com/api/runs").is_ok());
        assert!(request_url(&base, "https://loom.example.com/apievil/runs").is_err());
        assert!(request_url(&base, "https://loom.example.com/api/runs?token=secret").is_err());
    }
}
