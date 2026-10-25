import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { toGraphData } from '@/lib/graph-adapter';
import type { DeviceInfoPayload, FramePayload, GraphPayload } from '@/lib/rpc';
import { mergeScan, toRuntimeDevice, useDeviceStore } from '@/stores/device.store';
import { SCRIPT_SCOPE, useGraphStore } from '@/stores/graph.store';
import { useSessionStore } from '@/stores/session.store';

const handlers = vi.hoisted(
  () => [] as Array<(event: { payload: { method: string; params: Record<string, unknown> } }) => void>,
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (
      _name: string,
      handler: (event: { payload: { method: string; params: Record<string, unknown> } }) => void,
    ) => {
      handlers.push(handler);
      return Promise.resolve(() => {
        handlers.length = 0;
      });
    },
  ),
}));
vi.mock('@/stores/template.store', () => ({ preloadTemplates: vi.fn(), clearTemplateCache: vi.fn() }));

const raw: GraphPayload = {
  version: 1,
  defaults: {},
  recognizers: {},
  nodes: [],
  edges: [],
  flow: { steps: [{ id: 'trigger', type: 'manual' }] },
};
const frame = (index: number, activeStepIds?: readonly string[]): FramePayload => ({
  deviceId: 'device',
  index,
  ts: index,
  resolution: [2, 2],
  node: 'parallel',
  pending: null,
  tick: 1,
  fps: 20,
  captureMs: 1,
  detections: [],
  activeStepIds,
});
const notify = (method: string, params: unknown) =>
  handlers[0]?.({ payload: { method, params: params as Record<string, unknown> } });

let unlisten: () => void;
beforeAll(async () => {
  unlisten = await useSessionStore.getState().init();
});
afterAll(() => {
  unlisten();
  useSessionStore.getState().setStreamPolicy('device', 0);
});
beforeEach(() => {
  useGraphStore.setState({
    graphs: { [SCRIPT_SCOPE]: toGraphData(SCRIPT_SCOPE, raw) },
    raws: {},
    liveByDevice: {},
    workflowSnapshots: {},
  });
  useSessionStore.setState({ frames: {} });
  useDeviceStore.setState({ devices: [], activeId: '' });
});

describe('active-step runtime data chain', () => {
  it('propagates parallel IDs from frame notifications through session and graph live', () => {
    notify('engine.frame', frame(1, ['left', 'right']));
    expect(useSessionStore.getState().frames.device?.activeStepIds).toEqual(['left', 'right']);
    expect(useGraphStore.getState().graphs.device?.live?.activeStepIds).toEqual(['left', 'right']);
    const before = useGraphStore.getState();
    notify('engine.frame', frame(2, ['left', 'right']));
    expect(useGraphStore.getState()).toBe(before);
    notify('engine.frame', frame(3, ['right']));
    expect(useGraphStore.getState().graphs.device?.live?.activeStepIds).toEqual(['right']);
    notify('engine.frame', frame(4, []));
    expect(useGraphStore.getState().graphs.device?.live?.activeStepIds).toEqual([]);
  });

  it('falls back only for old engine metadata and keeps explicit empty authoritative', () => {
    notify('engine.frame', frame(1));
    expect(useGraphStore.getState().graphs.device?.live?.activeStepIds).toEqual(['parallel']);
    expect(toGraphData('device', raw, { node: 'old' }).live?.activeStepIds).toEqual(['old']);
    expect(toGraphData('device', raw, { node: 'old', activeStepIds: [] }).live?.activeStepIds).toEqual([]);
    expect(toGraphData('device', raw).live).toBeUndefined();
  });

  it('preserves per-device active IDs when republishing structure or converting graph snapshots', () => {
    const graph = toGraphData('device', raw, { node: 'parallel', activeStepIds: ['left', 'right'] });
    useGraphStore.getState().setGraph('device', graph, raw);
    useGraphStore.getState().updateLive('other', { node: 'single', pending: null, detections: [] });
    useGraphStore.getState().setGraph(SCRIPT_SCOPE, toGraphData(SCRIPT_SCOPE, raw), raw);
    expect(useGraphStore.getState().graphs.device?.live?.activeStepIds).toEqual(['left', 'right']);
    expect(useGraphStore.getState().graphs.other?.live?.activeStepIds).toEqual(['single']);
    useGraphStore.getState().clearDeviceLive();
    expect(useGraphStore.getState().graphs.device).toBeUndefined();
  });
});

describe('device capability metadata', () => {
  const info: DeviceInfoPayload = {
    id: 'device',
    uri: 'synthetic://',
    name: 'device',
    kind: 'android',
    status: 'discovered',
    serial: null,
    model: null,
    product: null,
    resolution: null,
    error: null,
    suggestedFix: null,
    capabilities: { multiTouch: true, maxTouchPoints: 10 },
  };
  it('retains scan capabilities for connected devices and missing legacy metadata', () => {
    const incoming = toRuntimeDevice(info);
    expect(incoming.capabilities).toEqual(info.capabilities);
    const connected = {
      ...incoming,
      status: 'connected' as const,
      capabilities: { multiTouch: false, maxTouchPoints: 1 },
    };
    expect(mergeScan([connected], [incoming], 'device').devices[0]?.capabilities).toEqual(info.capabilities);
    const legacy = { ...info, capabilities: undefined };
    expect(toRuntimeDevice(legacy).capabilities).toBeUndefined();
    expect(mergeScan([connected], [toRuntimeDevice(legacy)], 'device').devices[0]?.capabilities).toEqual(
      connected.capabilities,
    );
  });
  it('keeps capabilities through connected notifications and direct connection store updates', () => {
    useDeviceStore
      .getState()
      .markConnectedWith('device', [2, 2], undefined, undefined, undefined, info.capabilities);
    expect(useDeviceStore.getState().devices[0]?.capabilities).toEqual(info.capabilities);
    useDeviceStore.getState().markConnectedWith('device', [3, 3]);
    expect(useDeviceStore.getState().devices[0]?.capabilities).toEqual(info.capabilities);
    notify('device.connected', {
      deviceId: 'other',
      resolution: [2, 2],
      graph: raw,
      capabilities: { multiTouch: false, maxTouchPoints: 1 },
    });
    expect(useDeviceStore.getState().devices.find((device) => device.id === 'other')?.capabilities).toEqual({
      multiTouch: false,
      maxTouchPoints: 1,
    });
  });
});
