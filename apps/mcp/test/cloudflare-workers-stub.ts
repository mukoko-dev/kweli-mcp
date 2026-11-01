// Node stand-in for the Workers runtime's `cloudflare:workers` module, which
// @cloudflare/workers-oauth-provider imports for `WorkerEntrypoint`. Only the
// class identity is needed: the provider uses it to tell an entrypoint class
// from a plain `{ fetch }` handler, and this Worker passes the latter.
export class WorkerEntrypoint {}
