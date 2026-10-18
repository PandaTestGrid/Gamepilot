import { describe, expect, it } from 'vitest';

import { deviceRunLabel } from '@/lib/flow-run-attribution';

describe('deviceRunLabel', () => {
  it('没有工作流时不显示', () => {
    expect(deviceRunLabel([])).toBeNull();
  });

  it('一份工作流直接用名字', () => {
    expect(deviceRunLabel(['斗技'])).toBe('斗技');
  });

  it('多份时只展开第一份并标出其余数量', () => {
    expect(deviceRunLabel(['斗技', '百鬼', '御魂'])).toBe('斗技 +2');
  });
});
