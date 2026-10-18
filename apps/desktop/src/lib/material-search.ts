/**
 * 素材区搜索：子串、拆词、拼音、乱序字、模糊相近。
 * 空查询 = 原样返回（保持全部/命中的顺序）。
 */
import { textPinyin } from '@/lib/pinyin-lite';

/** 中英常见界面用词：搜「开始」也能对上 start_btn。 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['开始', 'start', 'begin'],
  ['按钮', 'btn', 'button'],
  ['邀请', 'invite'],
  ['好友', 'friend'],
  ['进入', 'enter', 'goin'],
  ['返回', 'back', 'return'],
  ['确认', 'ok', 'confirm', '确定'],
  ['取消', 'cancel'],
  ['设置', 'setting', 'settings'],
  ['战斗', 'fight', 'battle'],
  ['攻击', 'attack'],
  ['任务', 'quest', 'task', 'mission'],
  ['背包', 'bag', 'inventory', 'pack'],
  ['关闭', 'close'],
  ['打开', 'open'],
  ['商店', 'shop', 'store'],
  ['活动', 'event'],
  ['登录', 'login'],
  ['注册', 'register', 'signup'],
  ['挑战', 'challenge'],
  ['奖励', 'reward'],
  ['邮件', 'mail'],
  ['公会', 'guild', 'clan'],
  ['技能', 'skill'],
  ['装备', 'equip', 'gear'],
  ['强化', 'enhance', 'upgrade'],
  ['抽卡', 'gacha', 'pull'],
  ['签到', 'checkin', 'signin'],
  ['跳过', 'skip'],
  ['继续', 'continue'],
  ['暂停', 'pause'],
  ['退出', 'exit', 'quit'],
  ['地图', 'map'],
  ['角色', 'role', 'hero', 'character'],
  ['英雄', 'hero'],
  ['宠物', 'pet'],
  ['金币', 'gold', 'coin'],
  ['钻石', 'diamond', 'gem'],
  ['体力', 'stamina', 'energy'],
  ['领取', 'claim', 'collect'],
  ['购买', 'buy', 'purchase'],
  ['刷新', 'refresh'],
  ['选择', 'select', 'choose'],
  ['使用', 'use'],
  ['升级', 'levelup', 'lvup'],
];

const ALIAS_LOOKUP: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of ALIAS_GROUPS) {
    for (const word of group) {
      const key = word.toLowerCase();
      const others = group.filter((item) => item.toLowerCase() !== key);
      const existing = map.get(key) ?? [];
      map.set(key, [...existing, ...others]);
    }
  }
  return map;
})();

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/** 英文按驼峰/数字切开，中文按字，蛇形/短横线当分隔。 */
export function tokenize(value: string): string[] {
  const parts = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[\s_\-/\\.+]+/u)
    .flatMap((part) => {
      const trimmed = part.trim().toLowerCase();
      if (!trimmed) {
        return [];
      }
      if (/[\u4e00-\u9fff]/.test(trimmed) && trimmed.length > 1) {
        const chars = [...trimmed];
        const grams: string[] = [trimmed, ...chars];
        for (let i = 0; i < chars.length - 1; i += 1) {
          grams.push(`${chars[i]}${chars[i + 1]}`);
        }
        return grams;
      }
      return [trimmed];
    });
  return [...new Set(parts)];
}

function expandTokens(tokens: readonly string[]): string[] {
  const extra: string[] = [];
  for (const token of tokens) {
    extra.push(token);
    const aliases = ALIAS_LOOKUP.get(token);
    if (aliases) {
      extra.push(...aliases.map((item) => item.toLowerCase()));
    }
  }
  return [...new Set(extra)];
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) {
    return true;
  }
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index += 1;
      if (index >= needle.length) {
        return true;
      }
    }
  }
  return false;
}

function bigrams(value: string): string[] {
  if (value.length <= 1) {
    return value ? [value] : [];
  }
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    grams.push(value.slice(i, i + 2));
  }
  return grams;
}

function dice(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.length === 0 || b.length === 0) {
    return left && left === right ? 1 : 0;
  }
  const bag = new Map<string, number>();
  for (const gram of a) {
    bag.set(gram, (bag.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const gram of b) {
    const count = bag.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      bag.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

function scoreAgainst(haystack: string, query: string): number {
  const h = normalize(haystack);
  const q = normalize(query);
  if (!q) {
    return 1;
  }
  if (!h) {
    return 0;
  }
  if (h === q) {
    return 100;
  }
  if (h.startsWith(q)) {
    return 92;
  }
  if (h.includes(q)) {
    return 80 + Math.min(12, Math.round((q.length / h.length) * 12));
  }

  const hayTokens = tokenize(haystack);
  const queryTokens = tokenize(query);
  const expanded = expandTokens(queryTokens);
  if (
    queryTokens.length > 0 &&
    queryTokens.every((token) => hayTokens.some((item) => item.includes(token) || token.includes(item)))
  ) {
    return 72;
  }
  if (
    expanded.some((token) => token.length >= 2 && (h.includes(normalize(token)) || hayTokens.includes(token)))
  ) {
    return 68;
  }

  const py = textPinyin(haystack);
  if (py.full && (py.full === q || py.full.startsWith(q) || py.full.includes(q))) {
    return 64;
  }
  if (
    py.initials &&
    q.length >= 2 &&
    (py.initials === q || py.initials.startsWith(q) || py.initials.includes(q))
  ) {
    return 58;
  }

  if (q.length >= 2 && isSubsequence(q, h)) {
    return 52;
  }

  const fuzzy = dice(q, h);
  if (fuzzy >= 0.4) {
    return Math.round(36 + fuzzy * 20);
  }
  return 0;
}

export interface MaterialSearchItem {
  readonly label: string;
  readonly type?: string;
}

/** 一条素材对这次搜索的相关度：0 = 不相近。 */
export function scoreMaterialQuery(item: MaterialSearchItem, query: string, extra = ''): number {
  const needle = query.trim();
  if (!needle) {
    return 1;
  }
  return Math.max(
    scoreAgainst(item.label, needle),
    scoreAgainst(item.type ?? '', needle),
    extra ? scoreAgainst(extra, needle) : 0,
  );
}

export function searchMaterials<T extends MaterialSearchItem>(
  items: readonly T[],
  query: string,
  extraText?: (item: T) => string,
): T[] {
  const needle = query.trim();
  if (!needle) {
    return [...items];
  }
  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreMaterialQuery(item, needle, extraText?.(item) ?? ''),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}
