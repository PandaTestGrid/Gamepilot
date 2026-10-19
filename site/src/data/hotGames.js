// 真实游戏视觉参考。封面来自夜神模拟器官网（yeshen.com）的游戏页，仅用于站点视觉展示，
// 不代表官方合作、已适配名单或对这些游戏自动化行为的承诺。
export const HOT_GAMES = [
  {
    id: 'azur',
    title: '碧蓝航线',
    en: 'AZUR LANE',
    genre: '舰船养成',
    cover: 'azur.jpg',
    accent: '#4da3ff'
  },
  {
    id: 'arknights',
    title: '明日方舟',
    en: 'ARKNIGHTS',
    genre: '策略塔防',
    cover: 'arknights.jpg',
    accent: '#4da3ff'
  },
  {
    id: 'fgo',
    title: 'Fate/Grand Order',
    en: 'FATE / GRAND ORDER',
    genre: '指令卡 RPG',
    cover: 'fgo.jpg',
    accent: '#4da3ff'
  },
  {
    id: 'onmyoji',
    title: '阴阳师',
    en: 'ONMYOJI',
    genre: '和风卡牌',
    cover: 'onmyoji.jpg',
    accent: '#4da3ff'
  }
];

export const HOT_ICONS = [
  'icon-1.jpg',
  'icon-2.jpg',
  'icon-3.jpg',
  'icon-4.jpg',
  'icon-5.jpg',
  'icon-onmyoji.png'
];

export const HOT_GALLERY = [
  {
    id: 'azur',
    name: '碧蓝航线',
    tab: '碧蓝航线',
    icon: 'icon-azur.png',
    orientation: 'portrait',
    ratio: '9 / 16',
    shotWidth: 1080,
    shotHeight: 1920,
    source: 'https://www.yeshen.com/appcenter/blhx.html',
    shots: ['azur-shots/1.jpg', 'azur-shots/2.jpg', 'azur-shots/3.jpg', 'azur-shots/4.jpg', 'azur-shots/5.jpg']
  },
  {
    id: 'arknights',
    name: '明日方舟',
    tab: '明日方舟',
    icon: 'icon-arknights.png',
    orientation: 'landscape',
    ratio: '16 / 9',
    shotWidth: 1280,
    shotHeight: 720,
    source: 'https://www.yeshen.com/appcenter/ak.html',
    shots: ['arknights-shots/1.jpg', 'arknights-shots/2.jpg', 'arknights-shots/3.jpg', 'arknights-shots/4.jpg', 'arknights-shots/5.jpg']
  },
  {
    id: 'fgo',
    name: 'Fate/Grand Order',
    tab: 'FGO',
    icon: 'icon-fgo.png',
    orientation: 'portrait',
    ratio: '3 / 5',
    shotWidth: 480,
    shotHeight: 800,
    source: 'https://www.yeshen.com/appcenter/fgo.html',
    shots: ['fgo-shots/1.jpg', 'fgo-shots/2.jpg', 'fgo-shots/3.jpg', 'fgo-shots/4.jpg', 'fgo-shots/5.jpg']
  },
  {
    id: 'onmyoji',
    name: '阴阳师',
    tab: '阴阳师',
    icon: 'icon-onmyoji.png',
    orientation: 'landscape',
    ratio: '16 / 9',
    shotWidth: 1280,
    shotHeight: 720,
    source: 'https://www.yeshen.com/appcenter/yys.html',
    shots: ['onmyoji-shots/1.jpg', 'onmyoji-shots/2.jpg', 'onmyoji-shots/3.jpg', 'onmyoji-shots/4.jpg', 'onmyoji-shots/5.jpg']
  }
];

export const WORKFLOW_SLOTS = [
  {
    id: 'daily',
    label: 'DAILY',
    title: '日常流程',
    desc: '登录、领取、日常任务、体力清理，适合每天重复跑的固定路径。'
  },
  {
    id: 'event',
    label: 'EVENT',
    title: '活动流程',
    desc: '活动入口、关卡推进、结算与重复刷取，活动期间只需要换入口。'
  },
  {
    id: 'multi',
    label: 'MULTI',
    title: '多开流程',
    desc: '多个实例同步启动，单实例异常时只恢复那一台，不拖住其他窗口。'
  }
];

export const HOT_GAME_PAGES = {
  azur: {
    tagline: '舰队日常，交给状态机',
    description:
      '从港口日常到活动海域，重复的委托、编队和结算步骤可以拆成状态图。录一次完整流程，之后让状态机自己判断走到了哪一步。',
    highlights: [
      '识别港口、委托、结算等界面，不依赖固定坐标',
      '录制一次日常路径，之后按状态图重复执行',
      '多开时每个实例独立控制，互不抢焦点',
      '弹窗、掉线或卡住时回到恢复边继续跑'
    ],
    workflows: [],
    slots: WORKFLOW_SLOTS
  },
  arknights: {
    tagline: '清理智、刷素材，重复的部分交出去',
    description:
      '清理智、刷素材、打活动关，流程稳定但重复。把编队、进关、战斗和结算串起来，活动期间只需要换入口，日常路径保持不变。',
    highlights: [
      '模板识别主界面、关卡入口与结算页',
      '把编队、开战、结算拆成可替换的状态节点',
      '多开同步刷素材，单实例异常单独恢复',
      '体力不足、编队错误时自动停下并提示'
    ],
    workflows: [],
    slots: WORKFLOW_SLOTS
  },
  fgo: {
    tagline: '周回与活动，录一次反复跑',
    description:
      '周回、活动 free 本、每日任务，操作路径固定但次数很多。录制一次选关、战斗与结算，支持中断后从恢复边继续，不必每次都从头来。',
    highlights: [
      '识别关卡列表、战斗界面与结算奖励',
      '录制选关、出击、技能与结算的完整路径',
      '多开时每个窗口独立识别、独立执行',
      '网络中断或弹窗出现时自动回到安全状态'
    ],
    workflows: [],
    slots: WORKFLOW_SLOTS
  },
  onmyoji: {
    tagline: '御魂、觉醒与日常，交给工作流',
    description:
      '御魂、觉醒、日常与活动，重复度最高的几段先交给状态机。录一次流程，之后按识别结果自己往下走，界面变了也能从恢复边找回路径。',
    highlights: [
      '识别庭院、御魂/觉醒入口与结算界面',
      '录制组队、挑战、结算与再次挑战的循环',
      '多开同步时每个账号独立状态、独立恢复',
      '活动入口变化时只改一个节点，不用重录全程'
    ],
    workflows: [],
    slots: WORKFLOW_SLOTS
  }
};
