/**
 * zustand selector 的**稳定性**守卫。
 *
 * 背景：zustand v5 的 `useStore` 建在 `useSyncExternalStore` 上，
 * 它要求 `getSnapshot()` 在状态没变时返回**同一个引用**。选择器里写
 *   `useGraphStore((state) => state.graphs[id]?.variables ?? [])`
 * 这类"现场造值"的写法（`?? []` / `?? {}` / `.map(` / `.filter(` / `new X`），
 * 每次取值都是新数组 → React 认为状态一直在变 → 无限重渲染，
 * 控制台刷 `Maximum update depth exceeded`。项目里几处注释都警告过这个坑
 * （见 `features/graph/StateNode.tsx`、`lib/…`）。
 *
 * 为什么单测抓不住：jsdom 里 React 不会真的进那个循环，现有用例照样全绿。
 * 所以只能**扫源码**守住这条规矩：`use*Store(...)` 的选择器体里不许出现上面那些写法，
 * 空值请在组件里兜（`const g = useStore(s => s.graphs[id]); const list = g?.variables ?? [];`）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '..');

/** 选择器里出现这些就说明返回值可能是"新造的"（引用不稳定）。 */
const UNSTABLE = /\?\?\s*(\[\]|\{\})|\.map\(|\.filter\(|\.slice\(|\bnew\s+[A-Z]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    const isSource = /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry);
    return isSource ? [full] : [];
  });
}

/** 抠出文件里每一段 `useXxxStore( ... )` 的选择器体（按括号配对，能跨行）。 */
function selectorBodies(text: string): string[] {
  const bodies: string[] = [];
  const pattern = /use[A-Za-z]*Store\(/g;
  for (const match of text.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') {
        depth += 1;
      } else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(text.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

describe('zustand selector 必须返回稳定引用', () => {
  it('src 下没有"每次都造新数组/新对象"的 selector（会撞 Maximum update depth exceeded）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const body of selectorBodies(text)) {
        if (!UNSTABLE.test(body)) {
          continue;
        }
        const line = text.slice(0, text.indexOf(body)).split('\n').length;
        offenders.push(`${path.relative(SRC, file)}:${line} → ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
      // 顺手把 `?? []` 的写法和行号对上，报错信息里能直接跳到那行
      void lines;
    }

    expect(
      offenders,
      `这些 selector 每次都会返回新引用，改成"先取稳定对象、空值在组件里兜"：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
