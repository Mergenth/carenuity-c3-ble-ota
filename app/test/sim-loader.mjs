// JavaScript model of firmware/main/ble_ota.c, used to test the sender.
import { ACK_REQUEST, CMD_ABORT, CMD_END, CMD_QUERY, CMD_START, crc32 } from '../src/protocol.ts';

export class SimLoader {
  constructor({ slot = 3 * 1024 * 1024, maxPayload = 508, dropEvery = 0, loseAckEvery = 0, corruptAt = -1 } = {}) {
    Object.assign(this, { slot, maxPayload, dropEvery, loseAckEvery, corruptAt });
    this.state = 'idle';
    this.flash = new Uint8Array(0);
    this.packets = 0;
    this.acks = 0;
    this.dropped = 0;
    this.listener = () => {};
    this.installed = null;
  }

  // ---- OtaTransport -------------------------------------------------------
  async readInfo() {
    return { p: 1, fw: 'sim', chip: 'ESP32-C3', mtu: this.maxPayload + 7, max: this.maxPayload, slot: this.slot, app: '', ver: '', busy: 0 };
  }
  onControl(l) { this.listener = l; }
  emit(e) { setTimeout(() => this.listener(e), 0); }

  async writeControl(b) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (b[0]) {
      case CMD_START: {
        const size = v.getUint32(1, true);
        if (size > this.slot) return this.emit({ type: 'error', code: 2, espErr: 0x104 });
        this.total = size; this.rx = 0; this.flash = new Uint8Array(size); this.state = 'rx';
        return this.emit({ type: 'ready', maxPayload: this.maxPayload, slotSize: this.slot });
      }
      case CMD_END: {
        if (this.state !== 'rx') return this.emit({ type: 'error', code: 6, espErr: 0x103 });
        if (this.rx !== this.total) return this.emit({ type: 'error', code: 6, espErr: 0x104 });
        if (crc32(this.flash) !== v.getUint32(1, true)) return this.emit({ type: 'error', code: 4, espErr: 0x109 });
        this.state = 'done'; this.installed = this.flash;
        return this.emit({ type: 'done' });
      }
      case CMD_ABORT: this.state = 'idle'; return;
      case CMD_QUERY: return this.emit({ type: 'ack', offset: this.state === 'rx' ? this.rx : 0 });
    }
  }

  async writeData(b) {
    if (this.state !== 'rx') return;
    this.packets++;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const raw = v.getUint32(0, true);
    const wantAck = (raw & ACK_REQUEST) !== 0;
    const offset = (raw & ~ACK_REQUEST) >>> 0;
    const payload = b.subarray(4);
    const lost = this.dropEvery && this.packets % this.dropEvery === 0;   // lost on air
    if (lost) return;
    if (offset !== this.rx || offset + payload.length > this.total) {
      this.dropped++;
      if (wantAck) this.ack();
      return;
    }
    this.flash.set(payload, offset);
    if (this.corruptAt >= offset && this.corruptAt < offset + payload.length) this.flash[this.corruptAt] ^= 0xff;
    this.rx = offset + payload.length;
    if (wantAck) this.ack();
  }

  ack() {
    this.acks++;
    if (this.loseAckEvery && this.acks % this.loseAckEvery === 0) return;   // notification lost
    this.emit({ type: 'ack', offset: this.rx });
  }
}
