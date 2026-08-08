/**
 * Mukoko Kweli's public, read-only graph MCP tools — the Worker-native
 * sibling of `nyuchi/kweli`'s `lib/mcp/tools.ts`. Queries `places.places` and
 * `entity.entities` directly (no Next.js service layer to carry over), using
 * the same field shapes documented in kweli's CLAUDE.md.
 *
 * All tools are READ tools except `request_place`, which enqueues a
 * single-place creation request onto apps/single-place-agent over a service
 * binding — the "by request for a single place" half of Kweli's ingestion
 * surface (bulk lives in apps/mcp-ingestion / apps/bulk-ingestion-agent).
 */

import { z } from 'zod'
import { DB, tierSpec, verifyEntityUrl, verifyPlaceUrl } from '@kweli-mcp/mongo'
import { getMongo } from './mongo-client'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const MAX_SEARCH_LIMIT = 20
const DEFAULT_SEARCH_LIMIT = 10

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const ENQUEUE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

export const TOOLS = [
  {
    name: 'search_places',
    title: 'Search places',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      'Search the Mukoko knowledge graph for places (businesses, parks, schools, NGOs, media, government offices, landmarks — every entity type) by name or city. Returns compact rows with id, name, type, city, rating, verification tier.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name text to match (case-insensitive)' },
        city: { type: 'string', description: 'Filter to a city/locality name' },
        limit: {
          type: 'number',
          description: `Max results (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT})`,
        },
      },
    },
  },
  {
    name: 'get_place',
    title: 'Get a place',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      'Fetch a single place by its id or slug: name, type, address, coordinates, phone/website when present, rating, and verification tier.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The place UUID or slug' } },
      required: ['id'],
    },
  },
  {
    name: 'get_organization',
    title: 'Get an organization',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      'Fetch the public trust profile of an organization (the entity node that operates places): name, legal name, entity type, verification tier, ubuntu trust score, and how many active places it operates.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The organization (entity) UUID or slug' } },
      required: ['id'],
    },
  },
  {
    name: 'get_verification',
    title: 'Get verification status',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      'Return the verification tier for a place OR an organization on the 4-tier Mukoko ladder (1 community/Terracotta, 2 otp/Cobalt, 3 government/Gold, 4 licensed/Tanzanite; 0 unverified), plus the Kweli verification gateway URL. Pass exactly one of placeId or entityId.',
    inputSchema: {
      type: 'object',
      properties: {
        placeId: { type: 'string', description: 'The place UUID to check' },
        entityId: { type: 'string', description: 'The organization (entity) UUID to check' },
      },
    },
  },
  {
    name: 'get_open_stats',
    title: 'Get open analytics',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      'Open analytics over the graph: total places, counts by country, top cities, and verified counts by tier for both places and organizations.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_place',
    title: 'Request a single named place',
    annotations: { ...ENQUEUE_ANNOTATIONS, title: 'Request a single named place' },
    description:
      'Ask Fundi to create exactly one named place on request (not an area sweep) — e.g. "my company\'s office at this address". Returns immediately with a task id; creation runs asynchronously via apps/single-place-agent, tier 0 (unverified) until claimed through Kweli.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The place's name (e.g. a company or venue name)" },
        lat: { type: 'number', description: 'Latitude' },
        lng: { type: 'number', description: 'Longitude' },
        address: { type: 'string', description: 'Free-text address, used if lat/lng are omitted' },
        requestedByPersonId: { type: 'string', description: 'The requesting person, if known' },
      },
      required: ['name'],
    },
  },
] as const

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  return typeof v === 'string' ? v.trim() : ''
}

function num(params: Record<string, unknown>, key: string): number | null {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

interface PlaceDoc {
  _id: string
  name: string
  slug?: string
  placeType?: string[]
  description?: string
  address?: { street?: string; city?: string; region?: string }
  geo?: { type: 'Point'; coordinates: [number, number] }
  telephone?: string
  url?: string
  discovery?: { aggregateRating?: { value: number; count: number } }
  bundu?: { verificationTier?: number }
}

interface EntityDoc {
  _id: string
  name: string
  legalName?: string
  slug?: string
  entityType?: string
  schemaOrgType?: string
  bundu?: { verificationTier?: number; trustSignals?: { ubuntuScore?: number } }
}

function compactPlaceRow(doc: PlaceDoc) {
  const tier = Number(doc.bundu?.verificationTier) || 0
  return {
    id: doc._id,
    name: doc.name,
    type: doc.placeType?.[0] ?? null,
    city: doc.address?.city ?? null,
    rating: doc.discovery?.aggregateRating ?? null,
    tier,
  }
}

async function toolSearchPlaces(args: Record<string, unknown>, env: KweliEnv): Promise<ToolResult> {
  const query = str(args, 'query')
  const city = str(args, 'city')
  const limit = Math.min(Math.max(Math.trunc(num(args, 'limit') ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT)

  const client = await getMongo(env.MONGODB_URI)
  const filter: Record<string, unknown> = { isActive: { $ne: false } }
  if (query) filter.name = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  if (city) filter['address.city'] = { $regex: `^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' }

  const docs = await client
    .db(DB.places)
    .collection<PlaceDoc>('places')
    .find(filter, { limit })
    .toArray()

  if (docs.length === 0) return textResult('No places match that search.')
  return jsonResult(docs.map(compactPlaceRow))
}

async function toolGetPlace(args: Record<string, unknown>, env: KweliEnv): Promise<ToolResult> {
  const id = str(args, 'id')
  if (!id) return textResult('get_place: id is required', true)

  const client = await getMongo(env.MONGODB_URI)
  const col = client.db(DB.places).collection<PlaceDoc>('places')
  const doc = (await col.findOne({ _id: id })) ?? (await col.findOne({ slug: id }))
  if (!doc) return textResult(`get_place: no place found with id ${id}`, true)

  const tier = Number(doc.bundu?.verificationTier) || 0
  return jsonResult({
    id: doc._id,
    name: doc.name,
    type: doc.placeType,
    description: doc.description,
    address: doc.address,
    geo: doc.geo?.coordinates ? { lat: doc.geo.coordinates[1], lng: doc.geo.coordinates[0] } : null,
    ...(doc.telephone ? { phone: doc.telephone } : {}),
    ...(doc.url ? { website: doc.url } : {}),
    rating: doc.discovery?.aggregateRating ?? null,
    verification: { tier, label: tierSpec(tier).label },
    verifyUrl: verifyPlaceUrl(doc._id),
  })
}

async function toolGetOrganization(args: Record<string, unknown>, env: KweliEnv): Promise<ToolResult> {
  const id = str(args, 'id')
  if (!id) return textResult('get_organization: id is required', true)

  const client = await getMongo(env.MONGODB_URI)
  const entities = client.db(DB.entity).collection<EntityDoc>('entities')
  const doc = (await entities.findOne({ _id: id })) ?? (await entities.findOne({ slug: id }))
  if (!doc) return textResult(`get_organization: no organization found with id ${id}`, true)

  const tier = Number(doc.bundu?.verificationTier) || 0
  const placeCount = await client
    .db(DB.places)
    .collection('places')
    .countDocuments({ ownerEntityId: doc._id, isActive: { $ne: false } })

  return jsonResult({
    id: doc._id,
    name: doc.name,
    legalName: doc.legalName,
    slug: doc.slug,
    entityType: doc.entityType,
    schemaOrgType: doc.schemaOrgType,
    placeCount,
    verification: { tier, label: tierSpec(tier).label, mineral: tierSpec(tier).mineral },
    ubuntuScore: doc.bundu?.trustSignals?.ubuntuScore ?? null,
    verifyUrl: verifyEntityUrl(doc._id),
  })
}

async function toolGetVerification(args: Record<string, unknown>, env: KweliEnv): Promise<ToolResult> {
  const placeId = str(args, 'placeId')
  const entityId = str(args, 'entityId')
  if (!placeId && !entityId) {
    return textResult('get_verification: pass exactly one of placeId or entityId', true)
  }
  if (placeId && entityId) {
    return textResult('get_verification: pass exactly one of placeId or entityId, not both', true)
  }

  const client = await getMongo(env.MONGODB_URI)
  if (entityId) {
    const doc = await client.db(DB.entity).collection<EntityDoc>('entities').findOne({ _id: entityId })
    if (!doc) return textResult(`get_verification: no organization found with id ${entityId}`, true)
    const tier = Number(doc.bundu?.verificationTier) || 0
    const spec = tierSpec(tier)
    return jsonResult({
      entityId: doc._id,
      name: doc.name,
      tier,
      label: spec.label,
      mineral: spec.mineral,
      verified: tier > 0,
      verifyUrl: verifyEntityUrl(doc._id),
    })
  }

  const doc = await client.db(DB.places).collection<PlaceDoc>('places').findOne({ _id: placeId })
  if (!doc) return textResult(`get_verification: no place found with id ${placeId}`, true)
  const tier = Number(doc.bundu?.verificationTier) || 0
  const spec = tierSpec(tier)
  return jsonResult({
    placeId: doc._id,
    name: doc.name,
    tier,
    label: spec.label,
    mineral: spec.mineral,
    verified: tier > 0,
    verifyUrl: verifyPlaceUrl(doc._id),
  })
}

async function toolGetOpenStats(env: KweliEnv): Promise<ToolResult> {
  const client = await getMongo(env.MONGODB_URI)
  const places = client.db(DB.places).collection<PlaceDoc>('places')
  const entities = client.db(DB.entity).collection<EntityDoc>('entities')

  const [total, byCountry, topCities, byTier, orgsByTier] = await Promise.all([
    places.countDocuments({ isActive: { $ne: false } }),
    places
      .aggregate([
        { $match: { isActive: { $ne: false } } },
        { $group: { _id: '$hierarchy.countryId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ])
      .toArray(),
    places
      .aggregate([
        { $match: { isActive: { $ne: false } } },
        { $group: { _id: '$address.city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray(),
    places
      .aggregate([{ $group: { _id: { $ifNull: ['$bundu.verificationTier', 0] }, count: { $sum: 1 } } }])
      .toArray(),
    entities
      .aggregate([{ $group: { _id: { $ifNull: ['$bundu.verificationTier', 0] }, count: { $sum: 1 } } }])
      .toArray(),
  ])

  return jsonResult({
    totalPlaces: total,
    byCountry,
    topCities,
    placesByTier: byTier,
    organizationsByTier: orgsByTier,
    // TODO: trust-graph vouch/verification-event aggregates (parity with
    // kweli's lib/services/analytics.service.ts getOpenStats) — needs the
    // engagement.vouches / entity.verifications shapes ported too.
  })
}

const requestPlaceInput = z.object({
  name: z.string().min(1),
  lat: z.number().optional(),
  lng: z.number().optional(),
  address: z.string().optional(),
  requestedByPersonId: z.string().optional(),
})

async function toolRequestPlace(
  args: Record<string, unknown>,
  singlePlaceAgent: Fetcher,
): Promise<ToolResult> {
  const parsed = requestPlaceInput.safeParse(args)
  if (!parsed.success) return textResult(`request_place: ${parsed.error.message}`, true)

  const resp = await singlePlaceAgent.fetch('https://internal/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: parsed.data.name,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      address: parsed.data.address,
      source: { kind: 'ops_mcp', requestedByPersonId: parsed.data.requestedByPersonId },
    }),
  })
  const body = await resp.json().catch(() => ({ error: 'invalid response from single-place-agent' }))
  return jsonResult(body)
}

export interface KweliEnv {
  MONGODB_URI: string
  SINGLE_PLACE_AGENT: Fetcher
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: KweliEnv,
): Promise<ToolResult> {
  switch (name) {
    case 'search_places':
      return toolSearchPlaces(args, env)
    case 'get_place':
      return toolGetPlace(args, env)
    case 'get_organization':
      return toolGetOrganization(args, env)
    case 'get_verification':
      return toolGetVerification(args, env)
    case 'get_open_stats':
      return toolGetOpenStats(env)
    case 'request_place':
      return toolRequestPlace(args, env.SINGLE_PLACE_AGENT)
    default:
      return textResult(`Unknown tool: ${name}`, true)
  }
}
