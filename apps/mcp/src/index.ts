// Kweli MCP worker entrypoint.
//   • /mcp — WorkOS OAuth-gated (Authorization Code + PKCE) MCP surface,
//     KweliMcp (see mcp.ts): every Kweli function — graph reads, verification,
//     and place generation — in one place.
//
// Generation tools (seed_region, seed_admin_bulk, request_place) don't touch
// the queue/ledger/Mongo directly — they call bulk-place-agent's /
// single-place-agent's own public POST /tasks over a service binding, minting
// their own WorkOS M2M token exactly like any other Nyuchi/Mukoko app would.
// There is no raw HTTP passthrough here for that — call the agents directly
// if you're not an MCP client.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { KweliAuthkitHandler } from "./authkit-handler";
import { KweliMcp } from "./mcp";

export { KweliMcp };

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: KweliMcp.serve("/mcp") as never,
  defaultHandler: KweliAuthkitHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Everything (/mcp, /authorize, /token, /register, /, /health, /callback)
    // flows through the OAuth provider.
    return oauthProvider.fetch(request, env, ctx);
  },
};
