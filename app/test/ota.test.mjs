import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sendImage } from '../src/ota.ts';
import { crc32 } from '../src/protocol.ts';
import { findAppImage, verifyImageHash } from '../src/image.ts';
import { SimLoader } from './sim-loader.mjs';

const fast = { ackTimeout: 40, readyTimeout: 500, doneTimeout: 500 };
const random = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 2654435761) >>> 24; return b; };

test('crc32 matches the zlib reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('clean link: image arrives byte for byte', async () => {
  const image = random(300_000);
  const sim = new SimLoader();
  let last;
  await sendImage(sim, image, { ...fast, onProgress: (p) => (last = p) });
  assert.deepEqual(sim.installed, image);
  assert.equal(last.sent, image.length);
  assert.equal(last.resends, 0);
});

test('lossy link: dropped packets and lost ACKs are recovered', async () => {
  const image = random(200_001);
  const sim = new SimLoader({ dropEvery: 23, loseAckEvery: 7, maxPayload: 240 });
  let last;
  await sendImage(sim, image, { ...fast, onProgress: (p) => (last = p) });
  assert.deepEqual(sim.installed, image);
  assert.ok(last.resends > 0);
});

test('small MTU (iPhone-like 182 byte payload)', async () => {
  const image = random(64_000);
  const sim = new SimLoader({ maxPayload: 178 });
  await sendImage(sim, image, fast);
  assert.deepEqual(sim.installed, image);
});

test('damaged data is reported, nothing is installed', async () => {
  const sim = new SimLoader({ corruptAt: 1234 });
  await assert.rejects(sendImage(sim, random(50_000), fast), /checksum/);
  assert.equal(sim.installed, null);
});

test('image larger than the slot is refused before sending', async () => {
  const sim = new SimLoader({ slot: 10_000 });
  await assert.rejects(sendImage(sim, random(20_000), fast), /room for/);
  assert.equal(sim.packets, 0);
});

test('dead link times out with a clear message', async () => {
  const sim = new SimLoader();
  sim.writeData = async () => {};
  sim.writeControl = async (b) => { if (b[0] === 1) sim.listener({ type: 'ready', maxPayload: 508, slotSize: 3e6 }); };
  await assert.rejects(sendImage(sim, random(5000), fast), /stopped answering/);
});

// ---- real images built by ESP-IDF (present after a firmware build) ---------
const merged = '../../firmware/release/Carenuity-BLE-OTA-Loader-C3-Mini.ino.bin';
const real = existsSync(new URL(merged, import.meta.url));
const load = () => {
  const full = new Uint8Array(readFileSync(new URL(merged, import.meta.url)));
  return { full, app: full.slice(0x10000) };   // the merged file ends with the app image
};

test('app image is cut out of a merged flash image', { skip: !real }, async () => {
  const { full, app } = load();
  const found = findAppImage([{ offset: 0, data: full }]);
  assert.deepEqual(found.image, app);
  assert.equal(found.foundAt, 0x10000);
  assert.equal(found.projectName, 'carenuity_ble_ota_loader');
  assert.equal(found.chipId, 5);
  assert.ok(await verifyImageHash(found));
});

test('padded 4 MB dump, separate parts and plain app file give the same image', { skip: !real }, () => {
  const { full, app } = load();
  const padded = new Uint8Array(4 * 1024 * 1024).fill(0xff);
  padded.set(full);
  assert.deepEqual(findAppImage([{ offset: 0, data: padded }]).image, app);
  const parts = [
    { offset: 0xe000, data: new Uint8Array(0x2000).fill(0xff) },
    { offset: 0, data: full.slice(0, 0x8000) },
    { offset: 0x10000, data: app },
    { offset: 0x8000, data: full.slice(0x8000, 0x9000) },
  ];
  assert.deepEqual(findAppImage(parts).image, app);
  assert.deepEqual(findAppImage([{ offset: 0, data: app }]).image, app);
});

test('bootloader-only file, wrong chip and truncated image are rejected', { skip: !real }, async () => {
  const { full, app } = load();
  assert.throws(() => findAppImage([{ offset: 0, data: full.slice(0, 0x8000) }]), /No ESP32 application image/);
  const wrong = app.slice(); wrong[12] = 9;
  assert.throws(() => findAppImage([{ offset: 0x10000, data: wrong }]), /ESP32-S3/);
  assert.throws(() => findAppImage([{ offset: 0x10000, data: app.slice(0, app.length - 100) }]), /incomplete/);
  const bad = app.slice(); bad[5000] ^= 1;
  assert.equal(await verifyImageHash(findAppImage([{ offset: 0x10000, data: bad }])), false);
});
