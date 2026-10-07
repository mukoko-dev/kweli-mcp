// Kweli MCP worker entrypoint.
//   • <base> — WorkOS OAuth-gated (Authorization Code + PKCE) MCP surface,
//     KweliMcp (see mcp.ts): every Kweli function — graph reads, verification,
//     and place generation — in one place. `<base>` is the worker's mount
//     point, `/mcp` by default (see paths.ts): the deployed endpoint is
//     `https://kweli.mukoko.com/mcp`.
//
// Generation tools (seed_region, seed_admin_bulk, request_place) don't touch
// the queue/ledger/Mongo directly — they call bulk-place-agent's /
// single-place-agent's own public POST /tasks over a service binding, minting
// their own WorkOS M2M token exactly like any other Nyuchi/Mukoko app would.
// There is no raw HTTP passthrough here for that — call the agents directly
// if you're not an MCP client.

import OAuthProvider, {
  getOAuthApi,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import {
  createKweliAuthkitHandler,
  type KweliAuthkitApp,
} from "./authkit-handler";
import { KweliMcp } from "./mcp";
import { mcpBasePath } from "./paths";
import {
  decideAnonymous,
  isAuthServerMetadataPath,
  protectedResourceMetadata,
  signInRequired,
  withMountIssuer,
} from "./public-gate";

export { KweliMcp };

// The mount point comes from the environment, which a Worker only has at fetch
// time — so the provider is built on first request and cached per isolate,
// keyed by base path so a changed var can't be served by a stale instance.
type Mount = {
  basePath: string;
  options: OAuthProviderOptions<Env>;
  provider: OAuthProvider<Env>;
  defaultHandler: KweliAuthkitApp;
};

let cachedMount: Mount | null = null;

function mountFor(basePath: string): Mount {
  if (cachedMount?.basePath === basePath) return cachedMount;

  const defaultHandler = createKweliAuthkitHandler(basePath);
  const options: OAuthProviderOptions<Env> = {
    apiRoute: basePath,
    apiHandler: KweliMcp.serve(basePath) as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: `${basePath}/authorize`,
    tokenEndpoint: `${basePath}/token`,
    clientRegistrationEndpoint: `${basePath}/register`,
  };

  const mount: Mount = {
    basePath,
    options,
    provider: new OAuthProvider(options),
    defaultHandler,
  };
  cachedMount = mount;
  return mount;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const basePath = mcpBasePath(env);
    const { options, provider, defaultHandler } = mountFor(basePath);
    const { origin, pathname } = new URL(request.url);

    // Discovery for MCP clients, served under paths the zone routes send here
    // (wrangler.jsonc). The origin-root documents belong to the Kweli web app.
    if (
      pathname === `/.well-known/oauth-protected-resource${basePath}` ||
      pathname === `${basePath}/.well-known/oauth-protected-resource`
    ) {
      return protectedResourceMetadata(origin, basePath);
    }
    if (isAuthServerMetadataPath(pathname, basePath)) {
      const res = await provider.fetch(
        new Request(`${origin}/.well-known/oauth-authorization-server`),
        env,
        ctx,
      );
      if (!res.ok) return res;
      const metadata = (await res.json()) as Record<string, unknown>;
      return Response.json(withMountIssuer(metadata, origin, basePath), {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    // `apiRoute` is matched by PREFIX inside the provider, and with the MCP
    // endpoint mounted at `<base>` every sibling path shares that prefix — so
    // `<base>/authorize`, `<base>/callback` and `<base>/health` would all be
    // swallowed by the token-gated MCP handler and answered 401 instead of
    // reaching the sign-in UI. The provider checks the token and registration
    // endpoints by exact match *before* the prefix match, so those two are
    // safe; everything else belongs to the default handler and is dispatched
    // here, before the provider can claim it.
    // The MCP endpoint IS the mount point, so a person opening
    // https://kweli.mukoko.com/mcp in a browser would otherwise get a bare 401
    // from the token gate. MCP clients never ask for HTML — Streamable HTTP
    // sends `application/json` / `text/event-stream` — so an explicit
    // `text/html` preference is a safe signal to serve the landing page
    // instead. Anything else on this path is treated as a real MCP request.
    const wantsHtmlLanding =
      pathname === basePath &&
      request.method === "GET" &&
      (request.headers.get("accept") || "").includes("text/html");

    const belongsToProvider =
      !wantsHtmlLanding &&
      (pathname === basePath ||
        pathname === options.tokenEndpoint ||
        pathname === options.clientRegistrationEndpoint);

    // The open door (split by tool, see public-gate.ts): no token, so the
    // graph reads are served anonymously and a gated tool answers 401.
    if (
      pathname === basePath &&
      !wantsHtmlLanding &&
      request.method !== "OPTIONS" &&
      !request.headers.get("authorization")
    ) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (env.PUBLIC_RATE_LIMITER) {
        const { success } = await env.PUBLIC_RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return Response.json(
            {
              error: "rate_limited",
              error_description: "Too many requests; slow down.",
            },
            { status: 429, headers: { "retry-after": "60" } },
          );
        }
      }
      let forward = request;
      if (request.method === "POST") {
        const raw = await request.text();
        const decision = decideAnonymous(raw);
        if (decision.kind === "sign_in") {
          return signInRequired(origin, basePath, decision.tool);
        }
        forward = new Request(request, { body: decision.body ?? raw });
      }
      const anonymous = options.apiHandler as unknown as {
        fetch(r: Request, e: Env, c: ExecutionContext): Promise<Response>;
      };
      return anonymous.fetch(forward, env, ctx);
    }

    if (!belongsToProvider) {
      // The provider injects this binding on its own default-handler path;
      // dispatching ourselves means supplying it ourselves.
      if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = getOAuthApi(options, env);
      return defaultHandler.fetch(request, env, ctx);
    }

    return provider.fetch(request, env, ctx);
  },
};
