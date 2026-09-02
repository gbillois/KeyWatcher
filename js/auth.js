import { SESSION_KEY } from "./core.js";

const ARM_SCOPE = "https://management.azure.com/user_impersonation";
const OAUTH_KEY = "keywatcher.oauth.pending.v1";

export class AzureAuth {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  get session() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  get isAuthenticated() {
    return Boolean(this.session?.accessToken && this.session.expiresAt > Date.now() + 30_000);
  }

  get accessToken() {
    return this.isAuthenticated ? this.session.accessToken : "";
  }

  get accountLabel() {
    return this.session?.accountName || "Compte Microsoft";
  }

  async login() {
    const config = this.getConfig().azure;
    if (!config.clientId) throw new Error("Renseignez l’identifiant de l’application Entra.");
    if (window.location.protocol === "file:") throw new Error("Lancez KeyWatcher avec start.command avant de vous connecter.");

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const redirectUri = currentRedirectUri();
    const tenant = encodeURIComponent(config.tenantId || "organizations");
    sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier, state, redirectUri, createdAt: Date.now() }));

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: `openid profile ${ARM_SCOPE}`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    window.location.assign(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`);
  }

  async handleRedirect() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if (!code && !oauthError) return false;

    const message = url.searchParams.get("error_description") || oauthError;
    clearOAuthQuery(url);
    if (oauthError) throw new Error(message || "Connexion Microsoft refusée.");

    const pending = JSON.parse(sessionStorage.getItem(OAUTH_KEY) || "null");
    sessionStorage.removeItem(OAUTH_KEY);
    if (!pending || pending.state !== url.searchParams.get("state")) {
      throw new Error("La réponse Microsoft n’a pas pu être validée. Recommencez la connexion.");
    }
    if (Date.now() - pending.createdAt > 10 * 60_000) throw new Error("La tentative de connexion a expiré.");

    const config = this.getConfig().azure;
    const tenant = encodeURIComponent(config.tenantId || "organizations");
    const body = new URLSearchParams({
      client_id: config.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      scope: `openid profile ${ARM_SCOPE}`,
    });
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error_description || "Microsoft n’a pas délivré de jeton Azure.");
    const claims = decodeJwt(payload.id_token || payload.access_token);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      accessToken: payload.access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600) - 60) * 1000,
      accountName: claims.name || claims.preferred_username || "Compte Microsoft",
    }));
    return true;
  }

  logout() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(OAUTH_KEY);
  }
}

export function currentRedirectUri() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.href;
}

function clearOAuthQuery(url) {
  const clean = new URL(url);
  clean.search = "";
  clean.hash = "";
  history.replaceState({}, document.title, clean);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(decodeURIComponent(escape(atob(payload))));
  } catch {
    return {};
  }
}
