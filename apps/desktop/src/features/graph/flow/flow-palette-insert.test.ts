import { describe, expect, it } from 'vitest';

import {
  appendPaletteModule,
  insertPaletteModuleAfter,
  insertPaletteModuleBefore,
  storePositionsForInsertedSteps,
} from '@/features/graph/flow/flow-palette-insert';
import { validateFlowSteps } from '@/features/graph/flow/flow-structure';
import type { PaletteModule } from '@/features/graph/flow/flow-step-meta';
import type { FlowStep } from '@/types';

const manual: FlowStep = { id: 't', type: 'manual', params: {} };
const a: FlowStep = { id: 'a', type: 'delay', params: { ms: 1 } };

const delayModule: PaletteModule = { type: 'delay', label: '等待', hint: '', defaultParams: { ms: 100 } };
const condModule: PaletteModule = { type: 'cond', label: '条件', hint: '', defaultParams: { rec: '' } };
const loopModule: PaletteModule = { type: 'loop', label: '循环', hint: '', defaultParams: { count: 2 } };

describe('appendPaletteModule', () => {
  it('未知 palette 类型追加返回 null', () => {
    expect(
      appendPaletteModule([manual], {
        type: 'bogus_kind',
        label: '未知',
        hint: '',
        defaultParams: {},
      }),
    ).toBeNull();
  });

  it('条件成对生成「条件 + 条件结束」', () => {
    const result = appendPaletteModule([manual], condModule);
    expect(result!.steps.map((step) => step.type)).toEqual(['manual', 'cond', 'condend']);
    expect(validateFlowSteps(result!.steps)).toBeNull();
  });

  it('循环成对生成「循环 + 循环结束」', () => {
    const result = appendPaletteModule([manual], loopModule);
    expect(result!.steps.map((step) => step.type)).toEqual(['manual', 'loop', 'loopend']);
    expect(validateFlowSteps(result!.steps)).toBeNull();
  });

  it('空链上追加会先补手动触发', () => {
    const result = appendPaletteModule([], condModule);
    expect(result!.steps.map((step) => step.type)).toEqual(['manual', 'cond', 'condend']);
  });

  it('单独追加条件结束 / 否则 一律拒绝', () => {
    for (const type of ['condend', 'else', 'loopend']) {
      expect(appendPaletteModule([manual], { type, label: type, hint: '', defaultParams: {} })).toBeNull();
    }
  });
});

describe('insertPaletteModuleAfter / Before', () => {
  it('拖到模块身上：接在它后面并接入链（不再带未接入标记）', () => {
    const outcome = insertPaletteModuleAfter([manual, a], 't', delayModule);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.steps.map((step) => step.id)).toEqual(['t', outcome.primaryId, 'a']);
    expect(outcome.steps[1]!.params?._pendingLink).toBeFalsy();
  });

  it('拖到输入口：插在该模块之前', () => {
    const outcome = insertPaletteModuleBefore([manual, a], 'a', delayModule);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.steps.map((step) => step.id)).toEqual(['t', outcome.primaryId, 'a']);
  });

  it('不能插在触发器之前', () => {
    expect(insertPaletteModuleBefore([manual, a], 't', delayModule).ok).toBe(false);
  });
});

describe('storePositionsForInsertedSteps', () => {
  it('空白处落点（右键 / 拖到画布）用点击坐标，不接到上一个模块旁边', () => {
    const built = appendPaletteModule([manual, a], delayModule);
    expect(built).not.toBeNull();
    const placed = storePositionsForInsertedSteps(
      built!.steps,
      built!.insertedIds,
      null,
      { t: { x: 80, y: 180 }, a: { x: 340, y: 180 } },
      { x: 640, y: 420 },
    );
    expect(placed[built!.primaryId]).toEqual({ x: 640, y: 420 });
    expect(placed.a).toEqual({ x: 340, y: 180 });
  });
});
