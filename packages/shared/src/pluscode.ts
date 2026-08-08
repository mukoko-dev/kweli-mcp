// Vendored Open Location Code (Plus Code) encoder. Sovereign addressing layer:
// open algorithm, no API, no key, works forever. Reference implementation port
// of Google's openlocationcode encode path (Apache-2.0). We only need encode.

const CODE_ALPHABET = "23456789CFGHJMPQRVWX";
const ENCODING_BASE = CODE_ALPHABET.length; // 20
const LATITUDE_MAX = 90;
const LONGITUDE_MAX = 180;
const PAIR_CODE_LENGTH = 10;
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;
const PADDING_CHARACTER = "0";
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const GRID_SIZE_DEGREES = 0.000125;

// Place values for each of the five pairs (degrees covered by one digit).
const PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];

function clipLatitude(latitude: number): number {
  return Math.min(90, Math.max(-90, latitude));
}

function normalizeLongitude(longitude: number): number {
  let lng = longitude;
  while (lng < -180) lng += 360;
  while (lng >= 180) lng -= 360;
  return lng;
}

function computeLatitudePrecision(codeLength: number): number {
  if (codeLength <= PAIR_CODE_LENGTH) {
    return Math.pow(ENCODING_BASE, Math.floor(codeLength / -2 + 2));
  }
  return Math.pow(ENCODING_BASE, -3) / Math.pow(GRID_ROWS, codeLength - PAIR_CODE_LENGTH);
}

function encodePairs(latitude: number, longitude: number, codeLength: number): string {
  let code = "";
  let adjustedLatitude = latitude + LATITUDE_MAX;
  let adjustedLongitude = longitude + LONGITUDE_MAX;
  let digitCount = 0;
  while (digitCount < codeLength) {
    const placeValue = PAIR_RESOLUTIONS[Math.floor(digitCount / 2)];
    let digitValue = Math.floor(adjustedLatitude / placeValue);
    adjustedLatitude -= digitValue * placeValue;
    code += CODE_ALPHABET.charAt(digitValue);
    digitCount += 1;
    digitValue = Math.floor(adjustedLongitude / placeValue);
    adjustedLongitude -= digitValue * placeValue;
    code += CODE_ALPHABET.charAt(digitValue);
    digitCount += 1;
    if (digitCount === SEPARATOR_POSITION && digitCount < codeLength) {
      code += SEPARATOR;
    }
  }
  while (code.length < SEPARATOR_POSITION) code += PADDING_CHARACTER;
  if (code.length === SEPARATOR_POSITION) code += SEPARATOR;
  return code;
}

function encodeGrid(latitude: number, longitude: number, codeLength: number): string {
  let code = "";
  let latPlaceValue = GRID_SIZE_DEGREES;
  let lngPlaceValue = GRID_SIZE_DEGREES;
  let adjustedLatitude = (latitude + LATITUDE_MAX) % GRID_SIZE_DEGREES;
  let adjustedLongitude = (longitude + LONGITUDE_MAX) % GRID_SIZE_DEGREES;
  for (let i = 0; i < codeLength; i++) {
    const row = Math.floor(adjustedLatitude / (latPlaceValue / GRID_ROWS));
    const col = Math.floor(adjustedLongitude / (lngPlaceValue / GRID_COLUMNS));
    latPlaceValue /= GRID_ROWS;
    lngPlaceValue /= GRID_COLUMNS;
    adjustedLatitude -= row * latPlaceValue;
    adjustedLongitude -= col * lngPlaceValue;
    code += CODE_ALPHABET.charAt(row * GRID_COLUMNS + col);
  }
  return code;
}

export function encodePlusCode(latitude: number, longitude: number, codeLength = 10): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("encodePlusCode: latitude/longitude must be finite numbers");
  }
  let lat = clipLatitude(latitude);
  const lng = normalizeLongitude(longitude);
  // The poles fall on the edge of the final code cell; nudge inward.
  if (lat === 90) lat -= computeLatitudePrecision(codeLength);
  let code = encodePairs(lat, lng, Math.min(codeLength, PAIR_CODE_LENGTH));
  if (codeLength > PAIR_CODE_LENGTH) {
    code += encodeGrid(lat, lng, codeLength - PAIR_CODE_LENGTH);
  }
  return code;
}
