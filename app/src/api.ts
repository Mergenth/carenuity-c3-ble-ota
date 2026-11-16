/**
 * Read-only client for the public Carenuity Solution Builder API
 * (https://solutions.carenuity.com). No account is needed.
 */
import type { FirmwarePart } from './image.ts';

const API = 'https://solutions-api.carenuity.com/v1';
const MICROCONTROLLER_NAME = 'C3-Mini';
const MICROCONTROLLER_ID = '4OQQy4edGswvbN6boCKw';

export interface Solution {
  id: string;
  name: string;
  description: string;
  sensor: string;
  actuator: string;
  /** undefined until the list of apps has been loaded */
  apps?: SolutionApp[];
}

export interface SolutionApp {
  id: string;
  solutionId: string;
  /** name the developer gave this build */
  tag: string;
  /** kind of application, e.g. "Air-Quality-Meter" */
  type: string;
  ecosystem: string;
  repository: string;
  createdAt: string;
  manifest: string;
}

interface Page<T> {
  offset?: string;
  total: number;
  size: number;
  items: T[];
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`The Solution Builder answered with status ${r.status}.`);
  return (await r.json()) as T;
}

/** Follows the cursor ("offset") until every item has been read. */
async function getAll<T extends { id: string }>(path: string, params: Record<string, string> = {}): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let offset: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams(params);
    if (offset) q.set('offset', offset);
    const query = q.toString();
    const body = await getJson<{ data: Page<T> | T[] }>(`${API}${path}${query ? `?${query}` : ''}`);
    const data = body.data;
    const items = Array.isArray(data) ? data : data.items ?? [];
    const fresh = items.filter((i) => !seen.has(i.id));
    fresh.forEach((i) => seen.add(i.id));
    all.push(...fresh);
    if (Array.isArray(data) || !data.offset || data.offset === offset || !fresh.length || all.length >= data.total) break;
    offset = data.offset;
  }
  return all;
}

interface RawComponent { id: string; name: string; category: string }
interface RawTemplate {
  id: string; name: string; description?: string;
  sensor_id: string; microcontroller_id: string; actuator_id: string;
}
interface RawNamed { id: string; name: string }
interface RawBinary {
  id: string; application_id: string; ecosystem_id: string; chip_family: string;
  manifest: string; repository: string; tag: string; created_at: string; solution_id: string;
}

let names: { apps: Map<string, string>; ecosystems: Map<string, string> } | null = null;

/** All solutions of the Solution Builder that are built around the C3-Mini. */
export async function loadSolutions(): Promise<Solution[]> {
  const [components, templates, apps, ecosystems] = await Promise.all([
    getAll<RawComponent>('/iot-components'),
    getAll<RawTemplate>('/solution-templates'),
    getAll<RawNamed>('/applications'),
    getAll<RawNamed>('/ecosystems'),
  ]);
  names = {
    apps: new Map(apps.map((a) => [a.id, a.name])),
    ecosystems: new Map(ecosystems.map((e) => [e.id, e.name])),
  };
  const byId = new Map(components.map((c) => [c.id, c.name]));
  const mc =
    components.find((c) => c.category === 'microcontroller' && c.name.trim() === MICROCONTROLLER_NAME)?.id ??
    MICROCONTROLLER_ID;

  return templates
    .filter((t) => t.microcontroller_id === mc)
    .map((t) => ({
      id: t.id,
      name: t.name.trim(),
      description: (t.description ?? '').trim(),
      sensor: byId.get(t.sensor_id) ?? '',
      actuator: byId.get(t.actuator_id) ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The installable apps of one solution, newest first. */
export async function loadApps(solutionId: string): Promise<SolutionApp[]> {
  const raw = await getAll<RawBinary>('/binaries', { solution_id: solutionId, mode: 'full' });
  return raw
    .filter((b) => b.manifest && (!b.chip_family || b.chip_family === 'ESP32-C3'))
    .map((b) => ({
      id: b.id,
      solutionId: b.solution_id,
      tag: b.tag || 'Unnamed app',
      type: names?.apps.get(b.application_id) ?? '',
      ecosystem: names?.ecosystems.get(b.ecosystem_id) ?? '',
      repository: b.repository ?? '',
      createdAt: b.created_at ?? '',
      manifest: b.manifest,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

interface Manifest {
  name?: string;
  builds?: { chipFamily: string; parts: { path: string; offset: number }[] }[];
}

/** Downloads every flash part an app's ESP Web Tools manifest lists for the ESP32-C3. */
export async function downloadFirmware(
  app: SolutionApp,
  onProgress: (received: number, total: number) => void,
): Promise<FirmwarePart[]> {
  const manifest = await getJson<Manifest>(app.manifest);
  const build = manifest.builds?.find((b) => b.chipFamily === 'ESP32-C3') ?? manifest.builds?.[0];
  if (!build?.parts?.length) throw new Error('This app has no firmware file.');

  const parts: FirmwarePart[] = [];
  let received = 0;
  let expected = 0;
  for (const part of build.parts) {
    const r = await fetch(new URL(part.path, app.manifest).toString());
    if (!r.ok) throw new Error(`Download failed with status ${r.status}.`);
    expected += Number(r.headers.get('content-length')) || 0;
    const chunks: Uint8Array[] = [];
    const reader = r.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received, Math.max(expected, received));
      }
    } else {
      const all = new Uint8Array(await r.arrayBuffer());
      chunks.push(all);
      received += all.length;
      onProgress(received, Math.max(expected, received));
    }
    const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    parts.push({ offset: Number(part.offset) || 0, data });
  }
  return parts;
}
