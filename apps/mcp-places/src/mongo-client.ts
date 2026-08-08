import type { MongoClient } from 'mongodb'
import { buildClient } from '@kweli-mcp/mongo'

// Module-scope cache: reused across requests within the same isolate, same
// pattern as apps/mcp-ingestion's FundiMcp.getMongo() and
// apps/bulk-ingestion-agent's FundiAgent.getMongo(). Connect lazily, never at
// module load (Workers disallow TCP sockets at global scope).
let cached: MongoClient | undefined

export async function getMongo(uri: string): Promise<MongoClient> {
  if (cached) return cached
  if (!uri) throw new Error('MONGODB_URI is not configured on the worker')
  const client = buildClient(uri)
  await client.connect()
  cached = client
  return client
}
