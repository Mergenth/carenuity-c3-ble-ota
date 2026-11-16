/**
 * Bluetooth LE link to a board that runs the Carenuity BLE-OTA loader.
 *
 * Uses @capacitor-community/bluetooth-le, which talks to the native stacks in
 * the Android / iOS app and to Web Bluetooth in the browser (Chrome on
 * Android, Bluefy on the iPhone).
 */
import { Capacitor } from '@capacitor/core';
import { BleClient, ConnectionPriority } from '@capacitor-community/bluetooth-le';
import {
  CMD_BOOT, CONTROL_UUID, DATA_UUID, INFO_UUID, SERVICE_UUID, parseControlEvent,
  type ControlEvent, type LoaderInfo,
} from './protocol.ts';
import type { OtaTransport } from './ota.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function bluetoothAvailable(): boolean {
  return Capacitor.isNativePlatform() || (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
}

export class Board implements OtaTransport {
  info: LoaderInfo | null = null;
  private listener: ((e: ControlEvent) => void) | null = null;

  readonly deviceId: string;
  readonly name: string;

  private constructor(deviceId: string, name: string) {
    this.deviceId = deviceId;
    this.name = name;
  }

  /** Opens the system device picker and connects. Must be called from a tap. */
  static async connect(onDisconnect: () => void): Promise<Board> {
    await BleClient.initialize({ androidNeverForLocation: true });
    const device = await BleClient.requestDevice({ services: [SERVICE_UUID] });
    const board = new Board(device.deviceId, device.name ?? 'Carenuity board');

    await BleClient.connect(device.deviceId, () => onDisconnect(), { timeout: 15000 });
    if (Capacitor.getPlatform() === 'android') {
      try {
        await BleClient.requestConnectionPriority(device.deviceId, ConnectionPriority.CONNECTION_PRIORITY_HIGH);
      } catch {
        /* optional */
      }
    }
    await BleClient.startNotifications(device.deviceId, SERVICE_UUID, CONTROL_UUID, (value) => {
      const e = parseControlEvent(value);
      if (e) board.listener?.(e);
    });
    // Give the phone and the board a moment to agree on packet size and speed.
    await sleep(700);
    await board.readInfo();
    return board;
  }

  async readInfo(): Promise<LoaderInfo> {
    const value = await BleClient.read(this.deviceId, SERVICE_UUID, INFO_UUID);
    const text = new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    this.info = JSON.parse(text) as LoaderInfo;
    return this.info;
  }

  writeControl(data: Uint8Array): Promise<void> {
    return BleClient.write(this.deviceId, SERVICE_UUID, CONTROL_UUID, dv(data));
  }

  writeData(data: Uint8Array): Promise<void> {
    return BleClient.writeWithoutResponse(this.deviceId, SERVICE_UUID, DATA_UUID, dv(data));
  }

  onControl(listener: (e: ControlEvent) => void): void {
    this.listener = listener;
  }

  /** Leave update mode and start the installed app. */
  startInstalledApp(): Promise<void> {
    return this.writeControl(Uint8Array.of(CMD_BOOT));
  }

  async disconnect(): Promise<void> {
    try {
      await BleClient.disconnect(this.deviceId);
    } catch {
      /* already gone */
    }
  }
}
