import { randomBytes, createHash } from "node:crypto";

export interface OAuthProvider {
  name: "google" | "microsoft";
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export const GOOGLE: OAuthProvider = {
  name: "google",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email", "profile"],
};

export const MICROSOFT: OAuthProvider = {
  name: "microsoft",
  authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: ["openid", "email", "profile"],
};

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * A fresh OIDC nonce. Sent in the auth URL and echoed back inside the
 * id_token's `nonce` claim, so a replayed id_token (captured from a
 * victim via a compromised client or phishing proxy) cannot be
 * presented to our callback — it won't carry the nonce we stored in
 * the user's browser cookie.
 */
export function generateNonce(): string {
  return randomBytes(24).toString("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * PKCE verifier + S256 challenge. The verifier stays in a cookie on
 * the user's browser and is submitted during token exchange; the
 * challenge travels through the provider. This binds the authorization
 * code to this specific browser session — an intercepted `code`
 * cannot be redeemed elsewhere.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface AuthUrlOptions {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function buildAuthUrl(
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  opts: AuthUrlOptions
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: provider.scopes.join(" "),
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "select_account",
  });
  return `${provider.authUrl}?${params.toString()}`;
}

export async function exchangeCode(
  provider: OAuthProvider,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<{ id_token: string; access_token: string }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OAuth token exchange failed (${res.status}): ${text.slice(0, 200)}`
    );
  }

  const json = (await res.json()) as {
    id_token?: string;
    access_token?: string;
  };
  if (!json.id_token) {
    throw new Error("No id_token in OAuth token response");
  }
  return {
    id_token: json.id_token,
    access_token: json.access_token ?? "",
  };
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  nonce?: string;
}

/**
 * Decode the payload of a JWT without verifying the signature.
 * Safe here because we just exchanged the authorization code over
 * HTTPS directly with the provider — the token is authentic.
 */
export function decodeIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT structure");
  const payload = JSON.parse(
    Buffer.from(parts[1]!, "base64url").toString("utf8")
  );
  return {
    sub: payload.sub ?? "",
    email: payload.email ?? undefined,
    name: payload.name ?? undefined,
    nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
  };
}
