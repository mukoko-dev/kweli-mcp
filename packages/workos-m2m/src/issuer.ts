// The WorkOS AuthKit issuer, parsed — never concatenated — into an https origin.
//
// One function for every side of this package (verify.ts binds `iss` to it and
// fetches the JWKS from it; mint.ts posts to its token endpoint) and for the
// Kweli MCP's sign-in flow, so the value composed into URLs and the value a
// token's `iss` is compared with are always the same canonical string.

/**
 * Parse a configured AuthKit issuer into an https origin, or throw.
 *
 * Accepts a bare host or an https origin, in any case. Any path, query or
 * fragment is dropped. A blank value, `http:`, any other scheme, embedded
 * credentials and anything `URL` cannot parse all throw an error whose message
 * starts with `<name> is not configured` — an unusable value fails closed
 * exactly like a missing one. The result is `URL.origin`.
 */
export function normaliseAuthkitDomain(
  value: string | undefined,
  name = "WORKOS_ISSUER",
): string {
  const missing = `${name} is not configured`;
  const raw = value?.trim();
  if (!raw) throw new Error(missing);
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
    );
  } catch {
    throw new Error(`${missing} (not a valid host or URL)`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${missing} (must be an https origin)`);
  }
  return url.origin;
}
