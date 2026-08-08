/**
 * The 4-tier Mukoko verification ladder — single source of truth for tier
 * labels and their Mzizi badge minerals (the `nyuchi-verified-badge`
 * contract). Tier 0 = unverified.
 *
 * This is a direct port of `nyuchi/kweli`'s `lib/verification-tiers.ts` (and
 * mirrored again in `nyuchi/api-gateway`'s `gateway/routers/kweli.py`
 * `TIER_LADDER`). All three must stay in sync — if the ladder changes in one,
 * update it in the other two in the same PR.
 */

export interface VerificationTierSpec {
  label: string
  mineral: string | null
}

export const VERIFICATION_TIERS: Record<number, VerificationTierSpec> = {
  0: { label: 'unverified', mineral: null },
  1: { label: 'community', mineral: 'Terracotta' },
  2: { label: 'otp', mineral: 'Cobalt' },
  3: { label: 'government', mineral: 'Gold' },
  4: { label: 'licensed', mineral: 'Tanzanite' },
}

// Tier 0 is always present in the literal above — asserted once here so
// every caller of tierSpec() gets a non-optional VerificationTierSpec back.
const UNVERIFIED: VerificationTierSpec = VERIFICATION_TIERS[0]!

export function tierSpec(tier: number): VerificationTierSpec {
  return VERIFICATION_TIERS[tier] ?? UNVERIFIED
}

export function clampTier(tier: number): number {
  if (Number.isNaN(tier)) return 0
  return Math.max(0, Math.min(4, Math.trunc(tier)))
}

export interface TierGateDecision {
  allowed: boolean
  requiredTier: number
  actualTier: number
}

export function checkTierGate(actualTier: number, minTier: number): TierGateDecision {
  const requiredTier = clampTier(minTier)
  const clampedActual = clampTier(actualTier)
  return { allowed: clampedActual >= requiredTier, requiredTier, actualTier: clampedActual }
}

export const KWELI_VERIFY_URL = 'https://kweli.mukoko.com/en/verify'

export function verifyPlaceUrl(placeId: string, source = 'kweli-mcp'): string {
  return `${KWELI_VERIFY_URL}?place=${placeId}&source=${source}`
}

export function verifyEntityUrl(entityId: string, source = 'kweli-mcp'): string {
  return `${KWELI_VERIFY_URL}?entity=${entityId}&source=${source}`
}
