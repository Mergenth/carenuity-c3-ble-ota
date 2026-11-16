/**
 * Carenuity BLE-OTA protocol, version 1 (see docs/PROTOCOL.md).
 * Shared by the app and by the tests; mirrors firmware/main/ble_ota.h.
 */
export const SERVICE_UUID = 'ca2e0001-07a0-4c3b-8f1e-c3b10ad30001';
export const CONTROL_UUID = 'ca2e0002-07a0-4c3b-8f1e-c3b10ad30001';
export const DATA_UUID = 'ca2e0003-07a0-4c3b-8f1e-c3b10ad30001';
export const INFO_UUID = 'ca2e0004-07a0-4c3b-8f1e-c3b10ad30001';

export const CMD_START = 0x01;
export const CMD_END = 0x02;
export const CMD_ABORT = 0x03;
export const CMD_BOOT = 0x04;
export const CMD_QUERY = 0x05;

export const EVT_READY = 0x81;
export const EVT_ACK = 0x82;
export const EVT_DONE = 0x83;
export const EVT_ERROR = 0xe0;

/** Bit 31 of a data packet's offset: "acknowledge once this packet is in flash". */
export const ACK_REQUEST = 0x80000000;
export const DATA_HEADER = 4;

export const ERROR_TEXT: Record<number, string> = {
  1: 'The board did not understand the command.',
  2: 'This app is too large for the board.',
  3: 'The board could not write to its flash memory.',
  4: 'The data arrived damaged (checksum mismatch).',
  5: 'The board rejected the image. It is not a valid ESP32-C3 app.',
  6: 'The transfer got out of step.',
  7: 'The board ran out of buffer space.',
};

export interface LoaderInfo {
  /** protocol version */
  p: number;
  /** loader firmware version */
  fw: string;
  chip: string;
  mtu: number;
  /** largest data payload per packet, in bytes */
  max: number;
  /** size of the app slot in bytes */
  slot: number;
  /** name and version of the installed app, empty when none */
  app: string;
  ver: string;
  busy: number;
}

export type ControlEvent =
  | { type: 'ready'; maxPayload: number; slotSize: number }
  | { type: 'ack'; offset: number }
  | { type: 'done' }
  | { type: 'error'; code: number; espErr: number };

export function parseControlEvent(v: DataView): ControlEvent | null {
  if (v.byteLength < 1) return null;
  switch (v.getUint8(0)) {
    case EVT_READY:
      return v.byteLength >= 7
        ? { type: 'ready', maxPayload: v.getUint16(1, true), slotSize: v.getUint32(3, true) }
        : null;
    case EVT_ACK:
      return v.byteLength >= 5 ? { type: 'ack', offset: v.getUint32(1, true) } : null;
    case EVT_DONE:
      return { type: 'done' };
    case EVT_ERROR:
      return v.byteLength >= 6
        ? { type: 'error', code: v.getUint8(1), espErr: v.getInt32(2, true) }
        : null;
    default:
      return null;
  }
}

export function startCommand(size: number): Uint8Array {
  const b = new Uint8Array(9);
  const v = new DataView(b.buffer);
  b[0] = CMD_START;
  v.setUint32(1, size, true);
  v.setUint32(5, 0, true); // reserved
  return b;
}

export function endCommand(crc: number): Uint8Array {
  const b = new Uint8Array(5);
  b[0] = CMD_END;
  new DataView(b.buffer).setUint32(1, crc >>> 0, true);
  return b;
}

export function dataPacket(image: Uint8Array, offset: number, length: number, requestAck: boolean): Uint8Array {
  const b = new Uint8Array(DATA_HEADER + length);
  new DataView(b.buffer).setUint32(0, (requestAck ? (offset | ACK_REQUEST) : offset) >>> 0, true);
  b.set(image.subarray(offset, offset + length), DATA_HEADER);
  return b;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (zlib), the same value esp_rom_crc32_le() produces from 0. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
