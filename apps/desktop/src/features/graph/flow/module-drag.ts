/**
 * 左栏 → 画布的模块拖放（兼容 WebView2：自定义 MIME 不可靠，用 text/plain 兜底 + 内存回退）。
 */
import {
  FLOW_MODULE_MIME,
  moduleDragPayload,
  parseModuleDragPayload,
} from '@/features/graph/flow/module-palette-drag';
import type { PaletteModule } from '@/features/graph/flow/flow-step-meta';

export {
  FLOW_MODULE_MIME,
  moduleDragPayload,
  parseModuleDragPayload,
} from '@/features/graph/flow/module-palette-drag';

export const MODULE_DRAG_PLAIN_PREFIX = 'gamepilot-flow-module:';

let draggingModule: PaletteModule | null = null;

export function setDraggingModule(module: PaletteModule | null): void {
  draggingModule = module;
}

export function peekDraggingModule(): PaletteModule | null {
  return draggingModule;
}

export function writeModuleDragData(dataTransfer: DataTransfer, module: PaletteModule): void {
  const payload = moduleDragPayload(module);
  try {
    dataTransfer.setData(FLOW_MODULE_MIME, payload);
  } catch {
    // 某些环境禁自定义 type，只靠 plain + 内存
  }
  dataTransfer.setData('text/plain', `${MODULE_DRAG_PLAIN_PREFIX}${payload}`);
  dataTransfer.effectAllowed = 'copy';
  setDraggingModule(module);
}

export function readModuleDragData(dataTransfer: DataTransfer): PaletteModule | null {
  let raw = '';
  try {
    raw = dataTransfer.getData(FLOW_MODULE_MIME);
  } catch {
    /* WebView 可能抛错 */
  }
  if (!raw) {
    const plain = dataTransfer.getData('text/plain');
    if (plain.startsWith(MODULE_DRAG_PLAIN_PREFIX)) {
      raw = plain.slice(MODULE_DRAG_PLAIN_PREFIX.length);
    }
  }
  const parsed = raw ? parseModuleDragPayload(raw) : null;
  if (parsed) {
    return parsed;
  }
  return peekDraggingModule();
}

export function isModuleDragEvent(event: React.DragEvent): boolean {
  if (peekDraggingModule()) {
    return true;
  }
  const types = Array.from(event.dataTransfer.types);
  return types.includes(FLOW_MODULE_MIME) || types.includes('text/plain');
}

export function acceptModuleDrag(event: React.DragEvent): void {
  if (!isModuleDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'copy';
}
