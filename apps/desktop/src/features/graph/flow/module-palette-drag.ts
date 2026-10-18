import { FLOW_MODULE_GROUPS, type PaletteModule } from '@/features/graph/flow/flow-step-meta';

export const FLOW_MODULE_MIME = 'application/x-gamepilot-flow-module';

export function moduleDragPayload(module: PaletteModule): string {
  return JSON.stringify({ type: module.type, defaultParams: module.defaultParams });
}

export function parseModuleDragPayload(raw: string): PaletteModule | null {
  try {
    const data = JSON.parse(raw) as { type?: string; defaultParams?: Record<string, unknown> };
    if (!data.type) {
      return null;
    }
    const found = FLOW_MODULE_GROUPS.flatMap((group) => group.items).find((item) => item.type === data.type);
    if (found) {
      return {
        ...found,
        defaultParams: data.defaultParams ?? found.defaultParams,
      };
    }
    return {
      type: data.type,
      label: data.type,
      hint: '',
      defaultParams: data.defaultParams ?? {},
    };
  } catch {
    return null;
  }
}
