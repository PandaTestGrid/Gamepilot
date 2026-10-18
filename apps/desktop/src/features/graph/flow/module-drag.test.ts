import { describe, expect, it } from 'vitest';

import {
  MODULE_DRAG_PLAIN_PREFIX,
  peekDraggingModule,
  readModuleDragData,
  setDraggingModule,
  writeModuleDragData,
} from '@/features/graph/flow/module-drag';
import type { PaletteModule } from '@/features/graph/flow/flow-step-meta';
import { moduleDragPayload } from '@/features/graph/flow/module-palette-drag';

const sample: PaletteModule = {
  type: 'click',
  label: '点击',
  hint: '',
  defaultParams: {},
};

describe('module-drag', () => {
  it('reads from text/plain fallback', () => {
    const payload = moduleDragPayload(sample);
    const dt = {
      getData: (type: string) => (type === 'text/plain' ? `${MODULE_DRAG_PLAIN_PREFIX}${payload}` : ''),
      types: ['text/plain'],
    } as unknown as DataTransfer;
    expect(readModuleDragData(dt)?.type).toBe('click');
  });

  it('falls back to in-memory module during drag', () => {
    setDraggingModule(sample);
    const dt = { getData: () => '', types: [] } as unknown as DataTransfer;
    expect(readModuleDragData(dt)).toEqual(sample);
    setDraggingModule(null);
    expect(peekDraggingModule()).toBeNull();
  });

  it('writeModuleDragData sets plain prefix', () => {
    const stored: Record<string, string> = {};
    const dt = {
      setData: (type: string, value: string) => {
        stored[type] = value;
      },
      effectAllowed: '',
    } as unknown as DataTransfer;
    writeModuleDragData(dt, sample);
    expect(stored['text/plain']?.startsWith(MODULE_DRAG_PLAIN_PREFIX)).toBe(true);
    setDraggingModule(null);
  });
});
