import { describe, expect, it } from 'vitest';

import { RESERVED_LABEL, checkRecognizerName } from '@/features/recognizers/recognizer-name';

const EXISTING = ['main_region_1', 'main_region_2'];

function check(value: string, current = 'main_region_1'): string | null {
  return checkRecognizerName(value, { current, existing: EXISTING });
}

describe('识别器改名：前端预校验', () => {
  it('正常名字（含中文与空格）通过', () => {
    expect(check('开始按钮')).toBeNull();
    expect(check('main 2')).toBeNull();
    expect(check('  前后有空白  ')).toBeNull();
  });

  it('空名字不通过', () => {
    expect(check('')).toContain('不能为空');
    expect(check('   ')).toContain('不能为空');
  });

  it('太长不通过（48 个字符以内）', () => {
    expect(check('a'.repeat(48))).toBeNull();
    expect(check('a'.repeat(49))).toContain('太长');
  });

  it('带路径分隔符不通过（它会变成模板文件名）', () => {
    expect(check('a/b')).toContain('/');
    expect(check('a\\b')).toContain('/');
  });

  it('带控制字符不通过', () => {
    expect(check('a\u0000b')).toContain('控制字符');
    expect(check('a\nb')).toContain('控制字符');
  });

  it('保留名 always 不通过（那是"无条件边"的哨兵值）', () => {
    expect(check(RESERVED_LABEL)).toContain('保留名');
  });

  it('和别人重名不通过；改成自己（大小写/空白差异）通过', () => {
    expect(check('main_region_2')).toContain('已经有同名识别器');
    expect(check('  main_region_1  ')).toBeNull();
  });
});
