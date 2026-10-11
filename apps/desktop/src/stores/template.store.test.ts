/**
 * 模板截图缓存：这是"拖动后模板突然全没了"那个问题的根治点。
 *
 * 守住四条：
 *   1. 同一张模板只取一次（画布/详情/识别器面板共用一份）；
 *   2. **已经有图时再失败，图继续留着**（宁可显示旧图，也不能变"×"）；
 *   3. 从来没成功过才算失败（并且可以重试）；
 *   4. 重试**不会先清掉已有的图**（不然用户会看到模板又消失一次）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cachedTemplate,
  clearTemplateCache,
  preloadTemplates,
  useTemplateStore,
} from '@/stores/template.store';

type TemplateReply = { label?: string; png?: string };
const templateImage = vi.fn((_label: string, _grayscale?: boolean): Promise<TemplateReply> =>
  Promise.resolve({}),
);
vi.mock('@/lib/rpc', () => ({
  templateImage: (label: string, grayscale?: boolean): Promise<TemplateReply> =>
    templateImage(label, grayscale),
  devLog: vi.fn(),
}));

const PNG = 'data:image/png;base64,AAAA';

describe('模板截图缓存', () => {
  beforeEach(() => {
    templateImage.mockReset();
    // 缓存是模块级的（故意的：组件重挂不该丢图）→ 用例之间要手动清
    clearTemplateCache();
  });

  it('同一张模板只取一次（画布 + 详情 + 面板都读同一份）', async () => {
    templateImage.mockResolvedValue({ label: 'main_start', png: PNG });

    preloadTemplates(['main_start', 'main_start']);
    await vi.waitFor(() => expect(cachedTemplate('main_start')).toBe(PNG));

    expect(templateImage).toHaveBeenCalledTimes(1);
    expect(useTemplateStore.getState().entries['main_start:color']?.url).toBe(PNG);
  });

  it('已有图之后再失败：图继续留着，不显示失败', async () => {
    templateImage.mockResolvedValueOnce({ label: 'main_start', png: PNG });
    useTemplateStore.getState().load('main_start');
    await vi.waitFor(() => expect(cachedTemplate('main_start')).toBe(PNG));

    templateImage.mockRejectedValueOnce(new Error('引擎忙'));
    useTemplateStore.getState().retry('main_start');

    await vi.waitFor(() => expect(templateImage).toHaveBeenCalledTimes(2));
    // 关键：旧的图还在（用户不会看到模板消失）
    expect(useTemplateStore.getState().entries['main_start:color']?.url).toBe(PNG);
    expect(useTemplateStore.getState().entries['main_start:color']?.error).toBeUndefined();
  });

  it('从来没成功过才算失败（可以点重试）', async () => {
    templateImage.mockRejectedValueOnce(new Error('引擎忙'));
    useTemplateStore.getState().load('shop_home');

    await vi.waitFor(() => {
      expect(useTemplateStore.getState().entries['shop_home:color']?.error).toBeTruthy();
    });
    expect(cachedTemplate('shop_home')).toBeUndefined();

    // 再重试成功后就有图了
    templateImage.mockResolvedValueOnce({ label: 'shop_home', png: PNG });
    useTemplateStore.getState().retry('shop_home');
    await vi.waitFor(() => expect(cachedTemplate('shop_home')).toBe(PNG));
  });

  it('引擎返回空图（png 为空）算失败，不会写进缓存', async () => {
    templateImage.mockResolvedValueOnce({ label: 'color_only', png: '' });
    useTemplateStore.getState().load('color_only');

    await vi.waitFor(() => {
      expect(useTemplateStore.getState().entries['color_only:color']?.error).toBeTruthy();
    });
    expect(cachedTemplate('color_only')).toBeUndefined();
  });

  it('黑白版与彩色版分开缓存（点缩略图切黑白不会互相覆盖）', async () => {
    templateImage.mockImplementation((_label: string, grayscale?: boolean) =>
      Promise.resolve({ png: grayscale ? `${PNG}-gray` : PNG }),
    );

    useTemplateStore.getState().load('main_start');
    useTemplateStore.getState().load('main_start', true);

    await vi.waitFor(() => expect(cachedTemplate('main_start', true)).toBe(`${PNG}-gray`));
    expect(cachedTemplate('main_start')).toBe(PNG);
    expect(templateImage).toHaveBeenCalledTimes(2);
  });
});
