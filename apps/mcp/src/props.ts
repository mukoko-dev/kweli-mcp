export interface Props {
  user: { id: string; email?: string; name?: string };
  accessToken: string;
  idToken: string;
  refreshToken: string;
  permissions: string[];
  organizationId?: string;

  // Required so Props satisfies McpAgent's `Record<string, unknown>` constraint.
  [key: string]: unknown;
}
