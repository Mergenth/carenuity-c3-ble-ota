/**
 * Sends an application image to the Carenuity BLE-OTA loader.
 *
 * Flow control is go-back-N: every data packet carries its offset, the last
 * packet of a window asks for an acknowledgement, and the loader answers with
 * the number of bytes it has written to flash. If the answer is lower than
 * expected, sending resumes from that offset.
 */
import {
  CMD_ABORT, CMD_QUERY, ERROR_TEXT, crc32, dataPacket, endCommand, startCommand,
  type ControlEvent, type LoaderInfo,
} from './protocol.ts';

export interface OtaTransport {
  readInfo(): Promise<LoaderInfo>;
  /** write with response to the CONTROL characteristic */
  writeControl(data: Uint8Array): Promise<void>;
  /** write without response to the DATA characteristic */
  writeData(data: Uint8Array): Promise<void>;
  /** register the single listener for CONTROL notifications */
  onControl(listener: (e: ControlEvent) => void): void;
}

export interface OtaProgress {
  sent: number;
  total: number;
  bytesPerSecond: number;
  resends: number;
}

export interface OtaOptions {
  onProgress?: (p: OtaProgress) => void;
  signal?: AbortSignal;
  /** timings in ms, shortened in tests */
  ackTimeout?: number;
  readyTimeout?: number;
  doneTimeout?: number;
  maxWindow?: number;
}

export class OtaError extends Error {}

class Inbox {
  private queue: ControlEvent[] = [];
  private wake: (() => void) | null = null;

  push(e: ControlEvent) {
    this.queue.push(e);
    this.wake?.();
  }

  /** Next event that `want` accepts; throws on a loader error; undefined on timeout. */
  async next<T extends ControlEvent>(want: (e: ControlEvent) => e is T, timeout: number): Promise<T | undefined> {
    const deadline = Date.now() + timeout;
    for (;;) {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        if (e.type === 'error') {
          throw new OtaError(`${ERROR_TEXT[e.code] ?? 'The board reported an error.'} (code ${e.code}/${e.espErr})`);
        }
        if (want(e)) return e;
      }
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => { clearTimeout(t); resolve(); };
      });
      this.wake = null;
    }
  }
}

const isReady = (e: ControlEvent): e is Extract<ControlEvent, { type: 'ready' }> => e.type === 'ready';
const isDone = (e: ControlEvent): e is Extract<ControlEvent, { type: 'done' }> => e.type === 'done';
type Ack = Extract<ControlEvent, { type: 'ack' }>;

export async function sendImage(t: OtaTransport, image: Uint8Array, opt: OtaOptions = {}): Promise<void> {
  const ackTimeout = opt.ackTimeout ?? 3000;
  const maxWindow = opt.maxWindow ?? 24;
  const inbox = new Inbox();
  t.onControl((e) => inbox.push(e));

  const check = () => {
    if (opt.signal?.aborted) throw new OtaError('Cancelled.');
  };

  const info = await t.readInfo();
  if (info.p !== 1) throw new OtaError(`This board speaks protocol ${info.p}. Please update the app.`);
  if (image.length > info.slot) {
    throw new OtaError(
      `This app needs ${(image.length / 1024).toFixed(0)} KB, the board has room for ${(info.slot / 1024).toFixed(0)} KB.`,
    );
  }

  await t.writeControl(startCommand(image.length));
  const ready = await inbox.next(isReady, opt.readyTimeout ?? 15000);
  if (!ready) throw new OtaError('The board did not answer. Press RESET on the board and connect again.');
  const payload = Math.max(16, Math.min(ready.maxPayload, info.max || ready.maxPayload));

  const total = image.length;
  const started = Date.now();
  let offset = 0;
  let window = 4;
  let resends = 0;
  let stalls = 0;

  try {
    while (offset < total) {
      check();
      const end = Math.min(offset + window * payload, total);
      for (let p = offset; p < end; ) {
        const n = Math.min(payload, end - p);
        await t.writeData(dataPacket(image, p, n, p + n === end));
        p += n;
      }

      const from = offset;
      let ack = await inbox.next((e): e is Ack => e.type === 'ack' && e.offset > from, ackTimeout);
      if (!ack) {
        // Nothing came back: ask the loader where it stands.
        await t.writeControl(Uint8Array.of(CMD_QUERY));
        ack = await inbox.next((e): e is Ack => e.type === 'ack' && e.offset >= from, ackTimeout * 2);
        if (!ack) throw new OtaError('The board stopped answering during the transfer.');
      }

      if (ack.offset < end) {
        resends++;
        stalls = ack.offset === from ? stalls + 1 : 0;
        if (stalls > 8 || resends > 200) throw new OtaError('Too many transmission errors. Move the phone closer and try again.');
        window = Math.max(1, window >> 1);
      } else {
        stalls = 0;
        window = Math.min(maxWindow, window + 2);
      }
      offset = Math.min(ack.offset, total);

      const seconds = Math.max(0.001, (Date.now() - started) / 1000);
      opt.onProgress?.({ sent: offset, total, bytesPerSecond: offset / seconds, resends });
    }

    check();
    await t.writeControl(endCommand(crc32(image)));
    const done = await inbox.next(isDone, opt.doneTimeout ?? 30000);
    if (!done) throw new OtaError('The board did not confirm the installation.');
  } catch (e) {
    try {
      await t.writeControl(Uint8Array.of(CMD_ABORT));
    } catch {
      /* the link may already be gone */
    }
    throw e;
  }
}
