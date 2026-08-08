import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import * as jose from "jose";
import { iconSvg } from "./icon";
import { landingHtml } from "./landing";
import type { Props } from "./props";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

// --- PKCE helpers ---

function base64UrlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function buildPkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
  );
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(hash);
  return { codeVerifier, codeChallenge };
}

async function startWorkOSFlow(env: Env, stateToken: string, requestUrl: string): Promise<string> {
  const { codeVerifier, codeChallenge } = await buildPkce();
  await env.OAUTH_KV.put(`oauth:pkce:${stateToken}`, codeVerifier, { expirationTtl: 600 });

  const redirectUri = new URL("/callback", requestUrl).href;
  // The Connect app exposes permissions as OAuth scopes. Request the required
  // permission so WorkOS grants it (in the token's `scope` claim) only when the
  // user's org role actually holds it.
  const scopes = ["openid", "email", "profile"];
  const requiredPermission = (env.WORKOS_REQUIRED_PERMISSION || "").trim();
  if (requiredPermission) scopes.push(requiredPermission);
  const params = new URLSearchParams({
    client_id: env.WORKOS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    state: stateToken,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: scopes.join(" "),
  });
  // Pin the flow to our org so the token is organization-scoped.
  if (env.WORKOS_ORGANIZATION_ID) {
    params.set("organization_id", env.WORKOS_ORGANIZATION_ID);
  }
  return `${env.WORKOS_AUTHKIT_DOMAIN}/oauth2/authorize?${params}`;
}

// ---

const app = new Hono<{
  Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
}>();

app.get("/", (c) => {
  return c.html(landingHtml(), 200, {
    "Cache-Control": "public, max-age=300",
  });
});

app.get("/health", (c) => {
  return c.json({ worker: "fundi-ingestion", status: "ok" });
});

function serveIcon() {
  return new Response(iconSvg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
app.get("/favicon.ico", () => serveIcon());
app.get("/icon.svg", () => serveIcon());
app.get("/icon.png", () => serveIcon());

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    const location = await startWorkOSFlow(c.env, stateToken, c.req.url);
    return new Response(null, {
      status: 302,
      headers: { "Set-Cookie": sessionBindingCookie, location },
    });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description:
        "Authenticated MCP for agentic place ingestion. WorkOS verifies your identity before the MCP client gets access.",
      logo: new URL("/icon.svg", c.req.url).href,
      name: "Fundi MCP",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    const location = await startWorkOSFlow(c.env, stateToken, c.req.url);

    const headers = new Headers({ Location: location });
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);
    return new Response(null, { status: 302, headers });
  } catch (error: unknown) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) return error.toResponse();
    const message = error instanceof Error ? error.message : String(error);
    return c.text(`Internal server error: ${message}`, 500);
  }
});

app.get("/callback", async (c) => {
  const errorParam = c.req.query("error");
  if (errorParam) {
    const desc = c.req.query("error_description") || "Authorization failed";
    return c.text(`Authorization denied: ${desc}`, 400);
  }

  const stateFromQuery = new URL(c.req.url).searchParams.get("state");
  if (!stateFromQuery) {
    return c.text("Missing state parameter", 400);
  }

  // Retrieve and immediately delete the PKCE verifier (single-use)
  const codeVerifier = await c.env.OAUTH_KV.get(`oauth:pkce:${stateFromQuery}`);
  await c.env.OAUTH_KV.delete(`oauth:pkce:${stateFromQuery}`);
  if (!codeVerifier) {
    return c.text("Invalid or expired PKCE state", 400);
  }

  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;
  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const redirectUri = new URL("/callback", c.req.url).href;
  const tokenRes = await fetch(`${c.env.WORKOS_AUTHKIT_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.env.WORKOS_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    console.error("WorkOS token exchange error:", await tokenRes.text());
    return c.text("Failed to exchange authorization code", 400);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    id_token?: string;
    refresh_token?: string;
  };

  const accessToken = tokens.access_token;
  const idToken = tokens.id_token ?? "";
  const refreshToken = tokens.refresh_token ?? "";

  const idClaims = idToken ? jose.decodeJwt(idToken) : {};
  const userId = String((idClaims as { sub?: unknown }).sub ?? "");
  if (!userId) {
    return c.text("Could not determine user identity from token", 400);
  }

  const userEmail =
    typeof (idClaims as { email?: unknown }).email === "string"
      ? (idClaims as { email: string }).email
      : undefined;
  const rawGiven = (idClaims as { given_name?: unknown }).given_name;
  const rawFamily = (idClaims as { family_name?: unknown }).family_name;
  const userName =
    typeof (idClaims as { name?: unknown }).name === "string"
      ? (idClaims as { name: string }).name
      : [rawGiven, rawFamily].filter((v) => typeof v === "string").join(" ") || undefined;

  const atClaims = jose.decodeJwt<{ permissions?: string[]; org_id?: string; scope?: string }>(
    accessToken,
  );
  // The Connect app grants permissions as OAuth scopes, so the granted
  // permission lands in the space-delimited `scope` claim; also accept a
  // `permissions` array if present.
  const grantedScopes =
    typeof atClaims.scope === "string" ? atClaims.scope.split(" ").filter(Boolean) : [];
  const permissions: string[] = [...(atClaims.permissions ?? []), ...grantedScopes];
  const organizationId = atClaims.org_id;

  const allowedOrgs = (c.env.WORKOS_ALLOWED_ORG_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedOrgs.length > 0 && (!organizationId || !allowedOrgs.includes(organizationId))) {
    return c.text("Your WorkOS organization is not authorized to use this MCP server.", 403);
  }

  const requiredPermission = (c.env.WORKOS_REQUIRED_PERMISSION || "").trim();
  if (requiredPermission && !permissions.includes(requiredPermission)) {
    return c.text(
      `Missing required permission "${requiredPermission}". Ask your WorkOS admin to grant it.`,
      403,
    );
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId,
    metadata: {},
    scope: permissions,
    props: {
      accessToken,
      idToken,
      refreshToken,
      permissions,
      organizationId,
      user: { id: userId, email: userEmail, name: userName },
    } satisfies Props,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }
  return new Response(null, { status: 302, headers });
});

export const FundiAuthkitHandler = app;
