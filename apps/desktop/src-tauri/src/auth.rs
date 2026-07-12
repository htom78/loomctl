use openidconnect::{
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    AuthorizationCode, ClientId, CsrfToken, IssuerUrl, Nonce, OAuth2TokenResponse,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::State;

const CALLBACK_URL: &str = "loom://auth/callback";

#[derive(Clone)]
struct PendingOidc {
    profile_id: String,
    issuer: String,
    client_id: String,
    ca_pem: Option<String>,
    csrf_state: String,
    nonce: String,
    pkce_verifier: String,
    created_at: Instant,
}

#[derive(Default)]
pub struct OidcState {
    pending: Mutex<HashMap<String, PendingOidc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcLoginRequest {
    profile_id: String,
    issuer: String,
    client_id: String,
    audience: Option<String>,
    scopes: Option<String>,
    ca_pem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcLoginStart {
    profile_id: String,
    authorization_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcLoginResult {
    profile_id: String,
    actor: String,
}

#[tauri::command]
pub async fn start_oidc_login(
    state: State<'_, OidcState>,
    request: OidcLoginRequest,
) -> Result<OidcLoginStart, String> {
    super::security::validate_profile_id(&request.profile_id)?;
    if request.client_id.trim().is_empty() || request.client_id.len() > 256 {
        return Err("invalid OIDC client id".into());
    }
    let issuer = super::security::validate_service_url(&request.issuer, false)?;
    let http_client = super::native_http::client_with_ca(request.ca_pem.as_deref())?;
    let provider = CoreProviderMetadata::discover_async(
        IssuerUrl::new(issuer.to_string()).map_err(|_| "invalid OIDC issuer")?,
        &http_client,
    )
    .await
    .map_err(oidc_discovery_error)?;
    let client = CoreClient::from_provider_metadata(
        provider,
        ClientId::new(request.client_id.trim().to_string()),
        None,
    )
    .set_redirect_uri(RedirectUrl::new(CALLBACK_URL.into()).map_err(|_| "invalid OIDC callback")?);
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let mut authorization = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("openid".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(challenge);
    for scope in request.scopes.as_deref().unwrap_or("").split_whitespace() {
        if !matches!(scope, "openid" | "profile") && scope.len() <= 128 {
            authorization = authorization.add_scope(Scope::new(scope.to_string()));
        }
    }
    let audience = request
        .audience
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = &audience {
        if value.len() > 256 {
            return Err("invalid OIDC audience".into());
        }
        authorization = authorization.add_extra_param("audience", value.clone());
    }
    let (authorization_url, csrf_state, nonce) = authorization.url();
    let pending = PendingOidc {
        profile_id: request.profile_id.clone(),
        issuer: issuer.to_string(),
        client_id: request.client_id.trim().to_string(),
        ca_pem: request.ca_pem,
        csrf_state: csrf_state.secret().clone(),
        nonce: nonce.secret().clone(),
        pkce_verifier: verifier.secret().clone(),
        created_at: Instant::now(),
    };
    state
        .pending
        .lock()
        .map_err(|_| "OIDC login state is unavailable")?
        .insert(request.profile_id.clone(), pending);
    Ok(OidcLoginStart {
        profile_id: request.profile_id,
        authorization_url: authorization_url.to_string(),
    })
}

#[tauri::command]
pub async fn complete_oidc_login(
    state: State<'_, OidcState>,
    callback_url: String,
) -> Result<OidcLoginResult, String> {
    let callback = super::security::validate_callback_url(&callback_url)?;
    let values = callback
        .query_pairs()
        .into_owned()
        .collect::<HashMap<_, _>>();
    let returned_state = values
        .get("state")
        .ok_or("OIDC callback is missing state")?;
    let pending = {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "OIDC login state is unavailable")?;
        let profile_id = pending
            .iter()
            .find_map(|(profile_id, value)| {
                (value.csrf_state == *returned_state).then(|| profile_id.clone())
            })
            .ok_or("OIDC callback state is invalid or expired")?;
        pending
            .remove(&profile_id)
            .ok_or("OIDC login state is unavailable")?
    };
    if oidc_state_expired(pending.created_at) {
        return Err("OIDC callback state is expired".into());
    }
    if values.contains_key("error") {
        return Err("OIDC provider rejected the sign-in request".into());
    }
    let code = values
        .get("code")
        .ok_or("OIDC callback is missing an authorization code")?;
    let http_client = super::native_http::client_with_ca(pending.ca_pem.as_deref())?;
    let issuer = super::security::validate_service_url(&pending.issuer, false)?;
    let provider = CoreProviderMetadata::discover_async(
        IssuerUrl::new(issuer.to_string()).map_err(|_| "invalid OIDC issuer")?,
        &http_client,
    )
    .await
    .map_err(oidc_discovery_error)?;
    let client =
        CoreClient::from_provider_metadata(provider, ClientId::new(pending.client_id), None)
            .set_redirect_uri(
                RedirectUrl::new(CALLBACK_URL.into()).map_err(|_| "invalid OIDC callback")?,
            );
    let token = client
        .exchange_code(AuthorizationCode::new(code.clone()))
        .map_err(|_| "OIDC token endpoint is unavailable")?
        .set_pkce_verifier(PkceCodeVerifier::new(pending.pkce_verifier))
        .request_async(&http_client)
        .await
        .map_err(|_| "OIDC authorization code exchange failed")?;
    let id_token = openidconnect::TokenResponse::id_token(&token)
        .ok_or("OIDC provider did not return an ID token")?;
    let claims = id_token
        .claims(&client.id_token_verifier(), &Nonce::new(pending.nonce))
        .map_err(|_| "OIDC ID token validation failed")?;
    super::credentials::set_secret(&pending.profile_id, token.access_token().secret())?;
    Ok(OidcLoginResult {
        profile_id: pending.profile_id,
        actor: claims.subject().as_str().to_string(),
    })
}

fn oidc_state_expired(created_at: Instant) -> bool {
    created_at.elapsed() > Duration::from_secs(10 * 60)
}

fn oidc_discovery_error(error: impl std::fmt::Display) -> String {
    #[cfg(feature = "e2e")]
    eprintln!("OIDC discovery failed: {error}");
    #[cfg(not(feature = "e2e"))]
    let _ = error;
    "OIDC discovery failed".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_never_accepts_tokens_in_place_of_codes() {
        let callback = super::super::security::validate_callback_url(
            "loom://auth/callback?access_token=secret&state=state",
        )
        .expect("callback shape");
        let values = callback
            .query_pairs()
            .into_owned()
            .collect::<HashMap<_, _>>();
        assert!(!values.contains_key("code"));
    }

    #[test]
    fn callback_state_expires_after_ten_minutes() {
        assert!(!oidc_state_expired(Instant::now()));
        assert!(oidc_state_expired(
            Instant::now() - Duration::from_secs(601)
        ));
    }
}
