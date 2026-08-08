/**
 * Mukoko Kweli MCP protocol plumbing — Streamable HTTP (JSON-RPC 2.0 over
 * POST /mcp). Ported near-verbatim from `nyuchi/kweli`'s `lib/mcp/server.ts`;
 * the only difference is `callTool` now needs an env (Mongo URI + the
 * SINGLE_PLACE_AGENT service binding) since there's no Next.js request
 * context to close over.
 */

import { TOOLS, callTool, type KweliEnv } from './tools'

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
export const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export const SERVER_INFO = {
  name: 'mukoko-kweli',
  title: 'Mukoko Kweli — Africa Trust Platform',
  version: '1.1.0',
}

const INSTRUCTIONS =
  'Mukoko Kweli is the Africa Trust Platform — the verification backbone of the Mukoko ' +
  'knowledge graph: places, the organizations that operate them, and the trust (kweli) that ' +
  'travels with both. Search places with search_places, fetch a full profile with get_place, ' +
  'read an organization’s trust profile with get_organization, check the 4-tier verification ' +
  'ladder with get_verification, pull open trust-graph analytics with get_open_stats, and ' +
  'request creation of a single named place with request_place. Read tools need no ' +
  'authentication; request_place enqueues asynchronous work.'

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

export function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function handleMessage(msg: JsonRpcRequest, env: KweliEnv): Promise<unknown | null> {
  const { id, method, params = {} } = msg

  if (id === undefined) return null
  if (typeof method !== 'string' || method.length === 0) {
    return rpcError(id, -32600, 'Invalid Request: missing method')
  }

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        return rpcResult(id, await callTool(name, args, env))
      } catch (err) {
        console.error('tools/call failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
        return rpcResult(id, {
          content: [{ type: 'text', text: `${name}: tool execution failed` }],
          isError: true,
        })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

export async function handleMcpBody(parsed: unknown, env: KweliEnv): Promise<unknown | null> {
  const messages = Array.isArray(parsed) ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest]

  const responses = (await Promise.all(messages.map((m) => handleMessage(m, env)))).filter(
    (r): r is Record<string, unknown> => r !== null,
  )

  if (responses.length === 0) return null
  return Array.isArray(parsed) ? responses : responses[0]
}
