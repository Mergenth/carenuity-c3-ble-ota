/**
 * Finds the ESP32-C3 application image inside whatever the Solution Builder
 * serves: a merged flash image (bootloader + partition table + app, from 0x0),
 * separate parts with flash offsets, or a plain app .bin.
 *
 * Only the application image can be written over the air; bootloader and
 * partition table stay as the Carenuity BLE-OTA loader installed them.
 */
export interface FirmwarePart {
  /** flash offset this part is meant for */
  offset: number;
  data: Uint8Array;
}

export interface AppImage {
  image: Uint8Array;
  projectName: string;
  version: string;
  idfVersion: string;
  chipId: number;
  hashAppended: boolean;
  /** flash offset the image was found at in the original file */
  foundAt: number;
}

export const CHIP_ID_ESP32C3 = 5;
const IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432;
const HEADER_LEN = 24;
const DEFAULT_APP_OFFSET = 0x10000;
const PARTITION_TABLE_OFFSET = 0x8000;

const CHIP_NAMES: Record<number, string> = {
  0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6', 16: 'ESP32-H2',
};

export class ImageError extends Error {}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function cString(b: Uint8Array, at: number, max: number): string {
  let s = '';
  for (let i = 0; i < max && at + i < b.length && b[at + i] !== 0; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

/** True when an application image (not a bootloader) starts at `at`. */
function isAppImage(b: Uint8Array, at: number): boolean {
  if (at < 0 || at + HEADER_LEN + 8 + 4 > b.length) return false;
  if (b[at] !== IMAGE_MAGIC) return false;
  return view(b).getUint32(at + HEADER_LEN + 8, true) === APP_DESC_MAGIC;
}

/** Exact length of the image starting at `at`, or null if it runs past the data. */
function imageLength(b: Uint8Array, at: number): number | null {
  const v = view(b);
  const segments = b[at + 1];
  if (segments === 0 || segments > 16) return null;
  let p = at + HEADER_LEN;
  for (let s = 0; s < segments; s++) {
    if (p + 8 > b.length) return null;
    p += 8 + v.getUint32(p + 4, true);
    if (p > b.length) return null;
  }
  // one checksum byte, padded so that the length is a multiple of 16
  let len = ((p - at + 1 + 15) & ~15) >>> 0;
  if (b[at + 23] === 1) len += 32; // appended SHA-256
  return at + len <= b.length ? len : null;
}

/** App partition offsets listed in an embedded partition table, factory first. */
function appOffsetsFromTable(b: Uint8Array, tableAt: number): number[] {
  const v = view(b);
  const found: { sub: number; off: number }[] = [];
  for (let p = tableAt; p + 32 <= b.length && p < tableAt + 0xc00; p += 32) {
    if (v.getUint16(p, true) !== 0x50aa) break;
    if (b[p + 2] === 0) found.push({ sub: b[p + 3], off: v.getUint32(p + 4, true) });
  }
  return found.sort((a, c) => a.sub - c.sub).map((f) => f.off);
}

export function findAppImage(parts: FirmwarePart[]): AppImage {
  if (!parts.length) throw new ImageError('The download contains no firmware.');

  const candidates: { part: FirmwarePart; at: number }[] = [];
  for (const part of parts) {
    const rel = (flash: number) => flash - part.offset;
    if (part.offset <= PARTITION_TABLE_OFFSET) {
      for (const off of appOffsetsFromTable(part.data, rel(PARTITION_TABLE_OFFSET))) {
        candidates.push({ part, at: rel(off) });
      }
    }
    if (part.offset <= DEFAULT_APP_OFFSET) candidates.push({ part, at: rel(DEFAULT_APP_OFFSET) });
    candidates.push({ part, at: 0 });
  }

  const hit = candidates.find((c) => isAppImage(c.part.data, c.at));
  if (!hit) throw new ImageError('No ESP32 application image found in this download.');

  const b = hit.part.data;
  const at = hit.at;
  const chipId = view(b).getUint16(at + 12, true);
  if (chipId !== CHIP_ID_ESP32C3) {
    throw new ImageError(
      `This app was built for ${CHIP_NAMES[chipId] ?? `chip id ${chipId}`}, not for the ESP32-C3.`,
    );
  }
  const len = imageLength(b, at);
  if (len === null) throw new ImageError('The application image is incomplete.');

  const desc = at + HEADER_LEN + 8;
  return {
    image: b.slice(at, at + len),
    version: cString(b, desc + 16, 32),
    projectName: cString(b, desc + 48, 32),
    idfVersion: cString(b, desc + 112, 32),
    chipId,
    hashAppended: b[at + 23] === 1,
    foundAt: hit.part.offset + at,
  };
}

/**
 * True when the image is the Carenuity BLE-OTA loader itself. The loader is the
 * base firmware; it is installed by USB and must not be sent as an app.
 */
export function isBaseFirmware(app: AppImage): boolean {
  return app.projectName === 'carenuity_ble_ota_loader';
}

/** Checks the SHA-256 that ESP-IDF appends to an image. Resolves true when there is none. */
export async function verifyImageHash(app: AppImage): Promise<boolean> {
  if (!app.hashAppended) return true;
  const body = app.image.subarray(0, app.image.length - 32);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body as BufferSource));
  const stored = app.image.subarray(app.image.length - 32);
  return digest.every((x, i) => x === stored[i]);
}
