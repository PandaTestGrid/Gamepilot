export const GAME_CATEGORIES = [
  '全部',
  '角色扮演',
  '动作',
  '策略',
  '竞速',
  '休闲',
  '开放世界',
  '塔防',
  '冒险'
];

export const GAMES_PER_PAGE = 8;

const p = (sky, accent, glow) => ({ sky, accent, glow });

export const GAMES = [
  {
    slug: 'abyss-echo',
    title: '深渊回响',
    en: 'ABYSS ECHO',
    category: '角色扮演',
    genre: '暗黑幻想 · ARPG',
    art: 'abyss',
    palette: p(['#070a24', '#191347', '#3c1d5b'], '#ffd078', '#8f7bff'),
    rating: 4.8,
    heat: '128 万',
    size: '6.8 GB',
    platforms: ['Android', 'iOS', 'Windows'],
    status: '已上线',
    featured: true,
    popularity: 98,
    tags: ['日常清体力', '副本刷取'],
    tagline: '在被遗忘的深渊里，找回自己的名字。',
    summary:
      '暗黑幻想动作 RPG。白天推图，晚上刷深渊，重复的开门、走路、结算占了大部分时间 —— 正好交给状态机。',
    description:
      '《深渊回响》把玩家放进一座不断下沉的城市。每一次进入副本都要经过主城、深渊入口、难度选择、战斗与结算五层界面。GamePilot 用模板识别把这些界面串成一张状态图，体力清完自动停，弹窗与断线走恢复边。',
    highlights: ['主城 → 副本的固定路线可以完全交给图', '结算界面识别失败时自动回退重试', '体力不足、背包已满都会触发安全停止'],
    scenarios: [
      { name: '每日体力清理', desc: '自动进入最高难度副本，结算后循环，体力见底停止。', steps: ['识别主城', '打开副本入口', '选择难度', '战斗与结算'] },
      { name: '深渊票刷取', desc: '按剩余票数循环挑战，失败两次后切图。', steps: ['检查票数', '进入深渊', '记录结算', '循环或退出'] },
      { name: '活动商店兑换', desc: '活动期间每天领取并兑换限定材料。', steps: ['打开活动页', '领取奖励', '兑换材料', '返回主城'] }
    ],
    automation: { nodes: 34, templates: 62, recoveries: 9, resolution: '1080 × 2400' }
  },
  {
    slug: 'neon-velocity',
    title: '霓虹竞速',
    en: 'NEON VELOCITY',
    category: '竞速',
    genre: '赛博竞速',
    art: 'neon',
    palette: p(['#050618', '#170b33', '#2b0a44'], '#ff4fd8', '#ffb35c'),
    rating: 4.6,
    heat: '86 万',
    size: '4.2 GB',
    platforms: ['Android', 'iOS'],
    status: '已上线',
    featured: true,
    popularity: 95,
    tags: ['赛事挂机', '奖励领取'],
    tagline: '在永夜高架上，把油门踩到底。',
    summary:
      '赛博朋克竞速手游。赛事、日常、通行证奖励分散在四五个入口，GamePilot 负责跑完它们，你只负责开车。',
    description:
      '《霓虹竞速》的界面切换很快，结算弹窗多。GamePilot 的识别器在 30fps 投屏下仍能稳定命中「开始比赛」「结算」「领取」三类按钮，配合恢复边处理网络重连与每日重置。',
    highlights: ['赛事入口与结算按钮的模板可以独立调阈值', '断线重连后回到赛事大厅继续', '奖励领取失败会重试三次再跳过'],
    scenarios: [
      { name: '每日赛事挂机', desc: '按赛事列表顺序跑完三场，自动领取段位奖励。', steps: ['进入赛事', '选择赛道', '跑完结算', '领取奖励'] },
      { name: '通行证奖励', desc: '领取所有可领节点，红点消失后停止。', steps: ['打开通行证', '识别红点', '逐项领取', '返回大厅'] },
      { name: '签到与邮件', desc: '每日首次启动时完成签到、邮件与补给领取。', steps: ['打开签到', '领取邮件', '领取补给', '回到主界面'] }
    ],
    automation: { nodes: 26, templates: 48, recoveries: 7, resolution: '1080 × 2400' }
  },
  {
    slug: 'orbital-front',
    title: '星港防线',
    en: 'ORBITAL FRONT',
    category: '塔防',
    genre: '科幻塔防',
    art: 'orbit',
    palette: p(['#041226', '#062a4a', '#073b52'], '#58d7ff', '#2f7bff'),
    rating: 4.5,
    heat: '64 万',
    size: '3.1 GB',
    platforms: ['Android', 'Windows', 'Mock'],
    status: '已上线',
    featured: true,
    popularity: 91,
    tags: ['多开铺场', '循环防守'],
    tagline: '守住星港的最后一圈轨道。',
    summary:
      '科幻塔防，一局十分钟，适合多开。四个号同时铺场，GamePilot 用一套图控制四块屏幕。',
    description:
      '《星港防线》的玩法循环非常稳定：选关、布防、开战、结算。多开时每个窗口独立识别、独立执行，任意一个窗口卡住只会触发它自己的恢复边，不会拖慢其他窗口。',
    highlights: ['四开窗口共用同一张状态图', '布防阶段的固定点位可以直接复用', '结算后自动进入下一关，无需人工点继续'],
    scenarios: [
      { name: '四开循环防守', desc: '四个模拟器同时跑同一关，独立结算互不阻塞。', steps: ['连接四台 Mock', '进入关卡', '布防开战', '结算再战'] },
      { name: '日常资源关', desc: '体力优先刷资源本，次数用尽后切经验本。', steps: ['检查体力', '选择资源关', '战斗结算', '切换副本'] },
      { name: '联盟协助', desc: '每日协助与捐献，完成后退出。', steps: ['打开联盟', '协助成员', '完成捐献', '返回主界面'] }
    ],
    automation: { nodes: 41, templates: 55, recoveries: 12, resolution: '1600 × 900 × 4' }
  },
  {
    slug: 'wildland',
    title: '幻境远征',
    en: 'WILDLAND',
    category: '开放世界',
    genre: '开放世界 · 探索',
    art: 'flora',
    palette: p(['#071b17', '#0b2f28', '#123f2d'], '#ffd98a', '#52d98a'),
    rating: 4.7,
    heat: '152 万',
    size: '12.4 GB',
    platforms: ['Android', 'iOS', 'Windows'],
    status: '已上线',
    featured: false,
    popularity: 96,
    tags: ['采集跑图', '每日委托'],
    tagline: '风会记得每一个走过浮岛的人。',
    summary:
      '开放世界探索。跑图采集最耗时间，也最适合交给录制的连续路径与采集点识别。',
    description:
      '《幻境远征》的采集点会随天气刷新。GamePilot 先录制一条完整跑图路径，再用小地图与采集图标确认到达；找不到目标就回退到上一个锚点重新找，而不是盲目点击。',
    highlights: ['连续路径录制，一次跑完整条采集线', '采集点用多尺度模板匹配，远近都能命中', '天气变化导致画面偏色时自动切换备用模板'],
    scenarios: [
      { name: '每日采集线', desc: '沿固定路线采集 24 个点，遇到战斗自动绕行。', steps: ['传送锚点', '沿路径移动', '识别采集点', '回传送点'] },
      { name: '委托四连', desc: '自动接取并完成四个每日委托。', steps: ['打开委托', '接取任务', '前往目标', '领取奖励'] },
      { name: '钓鱼收菜', desc: '固定点位抛竿、收杆，背包满时停止。', steps: ['走到水边', '抛竿', '识别咬钩', '收杆入包'] }
    ],
    automation: { nodes: 57, templates: 88, recoveries: 15, resolution: '1280 × 720' }
  },
  {
    slug: 'crown-war',
    title: '王座战争',
    en: 'CROWN WAR',
    category: '策略',
    genre: '策略战争',
    art: 'crown',
    palette: p(['#170509', '#2a0a10', '#3a100c'], '#ffc95c', '#ff6a3d'),
    rating: 4.4,
    heat: '73 万',
    size: '2.6 GB',
    platforms: ['Android', 'Windows', 'Mock'],
    status: '已上线',
    featured: false,
    popularity: 88,
    tags: ['联盟集结', '资源征收'],
    tagline: '王座之下，皆是棋盘。',
    summary:
      '联盟策略游戏。集结、征收、造兵都是定时操作，GamePilot 让它们按时发生。',
    description:
      '《王座战争》的核心是等待与重复：征收资源、训练队列、联盟集结。GamePilot 用状态图管理多个队列，识别冷却倒计时，队列空出来才进入下一步，不靠固定延时硬等。',
    highlights: ['按队列空位决策，而不是死等固定秒数', '联盟集结与增援可以自动接受', '资源不足时暂停建造并发出提示'],
    scenarios: [
      { name: '资源征收', desc: '按队列征收四种资源，仓库接近上限时停止。', steps: ['打开领地', '检查队列', '征收资源', '等待冷却'] },
      { name: '联盟集结', desc: '自动接受盟友集结并派出可用部队。', steps: ['检查集结', '选择部队', '出发增援', '返回主城'] },
      { name: '造兵循环', desc: '训练队列空位补齐，资源不足自动切换兵种。', steps: ['打开兵营', '检查队列', '补充训练', '升级建筑'] }
    ],
    automation: { nodes: 48, templates: 71, recoveries: 11, resolution: '1280 × 720' }
  },
  {
    slug: 'pixel-harvest',
    title: '像素农场',
    en: 'PIXEL HARVEST',
    category: '休闲',
    genre: '休闲经营',
    art: 'pixel',
    palette: p(['#2b0f35', '#5a2148', '#7a3040'], '#ffcf8a', '#ff7aa8'),
    rating: 4.9,
    heat: '210 万',
    size: '680 MB',
    platforms: ['Android', 'iOS'],
    status: '已上线',
    featured: false,
    popularity: 99,
    tags: ['收菜日常', '订单交付'],
    tagline: '种下去，等一朵像素花开。',
    summary:
      '治愈系像素经营。收菜、浇水、交付订单，每天十分钟，也可以全部交给 GamePilot。',
    description:
      '《像素农场》的界面简单、节奏慢，适合作为第一张状态图：主界面、农田、订单栏三个节点就能跑通。GamePilot 支持把点击录制成连续路径，浇水时不会漏掉角落的地块。',
    highlights: ['三节点状态图就能完成每日收菜', '连续路径拖动浇水，覆盖整块农田', '订单不足时自动切换种植组合'],
    scenarios: [
      { name: '每日收菜', desc: '收获、补种、浇水一次完成。', steps: ['进入农田', '收获成熟作物', '补种', '浇水'] },
      { name: '订单交付', desc: '按订单需求交付作物并领取金币。', steps: ['打开订单', '核对库存', '交付作物', '领取奖励'] },
      { name: '动物照料', desc: '喂食、抚摸、收取畜产品。', steps: ['进入牧场', '补充饲料', '收取产品', '返回农场'] }
    ],
    automation: { nodes: 18, templates: 24, recoveries: 4, resolution: '1080 × 2400' }
  },
  {
    slug: 'frost-realm',
    title: '霜落之境',
    en: 'FROSTREALM',
    category: '开放世界',
    genre: '冰雪开放世界',
    art: 'frost',
    palette: p(['#061427', '#0b2b45', '#0e3b58'], '#bdefff', '#55b9ff'),
    rating: 4.7,
    heat: '8.6 万预约',
    size: '18.2 GB',
    platforms: ['Android', 'iOS', 'Windows'],
    status: '预约中',
    featured: true,
    popularity: 93,
    tags: ['日常跑图', '精英狩猎'],
    tagline: '雪线之上，只有风和脚印。',
    summary:
      '冰雪开放世界新作。预约阶段已可导入官方演示包里的状态图，提前验证跑图与狩猎流程。',
    description:
      '《霜落之境》把地图切成一块块雪原，每块雪原都有自己的精英怪与采集点。官方演示包提供了三张示例状态图：营地、雪原、精英巢穴；GamePilot 可以在 Mock 设备上离线跑通整套流程。',
    highlights: ['演示包自带三张状态图与模板', '雪地反光强烈，识别器默认启用直方图均衡', '预约用户可在 Mock 设备上提前试跑'],
    scenarios: [
      { name: '雪原日常', desc: '跑完四个营地任务，回到篝火结算。', steps: ['离开营地', '前往任务点', '完成采集', '回篝火'] },
      { name: '精英狩猎', desc: '识别精英血条与倒地状态，自动拾取。', steps: ['寻找精英', '进入战斗', '识别倒地', '拾取材料'] },
      { name: '营地补给', desc: '每日补给与装备修理，材料不足时停止。', steps: ['打开营地', '领取补给', '修理装备', '离开营地'] }
    ],
    automation: { nodes: 39, templates: 66, recoveries: 10, resolution: '1920 × 1080' }
  },
  {
    slug: 'ember-throne',
    title: '余烬王座',
    en: 'EMBER THRONE',
    category: '动作',
    genre: '硬核动作',
    art: 'ember',
    palette: p(['#160607', '#2b0a08', '#3c1208'], '#ffb15c', '#ff5a2a'),
    rating: 4.5,
    heat: '5.2 万预约',
    size: '9.6 GB',
    platforms: ['Windows', 'Android'],
    status: '预约中',
    featured: false,
    popularity: 90,
    tags: ['首领挑战', '材料刷取'],
    tagline: '火会熄灭，王座不会。',
    summary:
      '硬核动作新作。战斗本身不适合自动化，但刷材料、跑图与死亡重试可以。',
    description:
      '《余烬王座》的 boss 战需要人操作，GamePilot 只负责战斗之外的部分：从篝火走到材料点、清掉小怪、拾取、死亡后自动重试。战斗节点会检测血条与死亡界面，把操作权交还给你。',
    highlights: ['战斗节点只做检测，不做连招', '死亡后自动从篝火重跑', '材料背包满时停止并提示'],
    scenarios: [
      { name: '材料跑图', desc: '沿固定路线刷三处材料点，避开精英。', steps: ['离开篝火', '前往材料点', '清小怪', '拾取返回'] },
      { name: '死亡重试', desc: '检测死亡界面，自动回到篝火重新出发。', steps: ['检测死亡', '确认重试', '回到篝火', '继续跑图'] },
      { name: '装备修理', desc: '耐久低于阈值时回城修理。', steps: ['检查耐久', '返回据点', '修理装备', '继续'] }
    ],
    automation: { nodes: 31, templates: 45, recoveries: 13, resolution: '2560 × 1440' }
  },
  {
    slug: 'tide-archive',
    title: '潮汐档案',
    en: 'TIDAL ARCHIVE',
    category: '冒险',
    genre: '叙事解谜',
    art: 'tide',
    palette: p(['#031326', '#04263c', '#063b4a'], '#8ef0ff', '#2ad8c8'),
    rating: 4.6,
    heat: '41 万',
    size: '5.4 GB',
    platforms: ['Android', 'iOS', 'Mock'],
    status: '预约中',
    featured: false,
    popularity: 84,
    tags: ['线索收集', '每日探索'],
    tagline: '海平面之下，档案仍在呼吸。',
    summary:
      '水下叙事解谜。线索散落在潮汐涨落的不同区域，GamePilot 负责跑图与重复调查，不跳过剧情。',
    description:
      '《潮汐档案》的剧情不可跳过，但调查点的重复交互很适合自动化。GamePilot 用场景识别判断潮位，只在目标区域开放时前往；遇到剧情对话会暂停，等你读完再继续。',
    highlights: ['识别潮位后再决定路线', '剧情对话框自动暂停，不代替你做选择', '调查点全部完成后生成一份收集清单'],
    scenarios: [
      { name: '每日调查', desc: '跑完三个开放区域的可调查点。', steps: ['确认潮位', '进入区域', '调查发光点', '返回潜水艇'] },
      { name: '档案收集', desc: '按清单补齐缺失档案，重复项自动跳过。', steps: ['打开档案', '定位缺口', '前往区域', '录入档案'] },
      { name: '资源打捞', desc: '固定打捞点循环，氧气不足时上浮。', steps: ['下潜', '打捞资源', '检查氧气', '上浮补给'] }
    ],
    automation: { nodes: 36, templates: 52, recoveries: 8, resolution: '1080 × 2400' }
  },
  {
    slug: 'void-route',
    title: '虚空航线',
    en: 'VOID ROUTE',
    category: '角色扮演',
    genre: '太空歌剧 RPG',
    art: 'void',
    palette: p(['#05030c', '#120a26', '#1d0b33'], '#c39bff', '#7b5cff'),
    rating: 4.8,
    heat: '12.4 万预约',
    size: '14.8 GB',
    platforms: ['Windows', 'Android', 'iOS'],
    status: '预约中',
    featured: false,
    popularity: 94,
    tags: ['航线派遣', '资源采集'],
    tagline: '每一次跃迁，都是一次告别。',
    summary:
      '太空歌剧 RPG 新作。派遣、采集、贸易三条循环都可以在图里跑，战斗留给玩家。',
    description:
      '《虚空航线》把星系做成一张可航行的地图。GamePilot 通过星图识别当前位置，按预设航线派遣舰队、采集资源、完成贸易；遇到主线战斗会停在战斗前，等你接管。',
    highlights: ['星图锚点识别，跨星系也不会走错', '派遣队列按空位自动补充', '战斗前暂停，交还操作权'],
    scenarios: [
      { name: '航线派遣', desc: '按收益排序派出舰队，返航后自动再派。', steps: ['打开星图', '选择航线', '派出舰队', '等待返航'] },
      { name: '资源采集', desc: '在小行星带循环采集，货舱满时返港。', steps: ['跃迁矿区', '采集资源', '检查货舱', '返港卸货'] },
      { name: '贸易结算', desc: '低买高卖，按价格表决定航线。', steps: ['查看价格', '买入货物', '跃迁出售', '结算利润'] }
    ],
    automation: { nodes: 52, templates: 79, recoveries: 14, resolution: '1920 × 1080' }
  },
  {
    slug: 'solar-route',
    title: '烈日商路',
    en: 'SOLAR ROUTE',
    category: '策略',
    genre: '沙漠经营',
    art: 'solar',
    palette: p(['#2a1204', '#5a2408', '#8a3a08'], '#ffe08a', '#ff9b3d'),
    rating: 4.3,
    heat: '29 万',
    size: '1.8 GB',
    platforms: ['Android', 'Windows'],
    status: '预约中',
    featured: false,
    popularity: 80,
    tags: ['商队派遣', '订单结算'],
    tagline: '穿过沙海，把水卖成金子。',
    summary:
      '沙漠商队经营。派遣、补货、结算全是表格点击，最适合批量处理。',
    description:
      '《烈日商路》的界面信息密度高，但按钮位置稳定。GamePilot 通过表格行识别判断订单状态，按利润排序接单，商队归来后自动补货再出发。',
    highlights: ['表格行状态识别，不依赖固定坐标', '按利润排序接单，低收益订单自动跳过', '缺水时优先购买补给'],
    scenarios: [
      { name: '商队循环', desc: '接单、补货、出发、结算，循环到当日上限。', steps: ['打开商会', '筛选订单', '补货出发', '结算返程'] },
      { name: '绿洲补给', desc: '价格低于阈值时囤水与饲料。', steps: ['查看价格', '比较阈值', '买入补给', '返回商路'] },
      { name: '声望任务', desc: '每日声望任务与捐赠一键完成。', steps: ['打开声望', '领取任务', '完成捐赠', '领取奖励'] }
    ],
    automation: { nodes: 29, templates: 43, recoveries: 6, resolution: '1600 × 900' }
  },
  {
    slug: 'bloom-story',
    title: '花见町物语',
    en: 'HANAMI STORY',
    category: '休闲',
    genre: '治愈生活',
    art: 'bloom',
    palette: p(['#251238', '#3d1b4f', '#5a2755'], '#ffd0e4', '#ff8fb8'),
    rating: 4.7,
    heat: '57 万',
    size: '1.2 GB',
    platforms: ['Android', 'iOS'],
    status: '预约中',
    featured: false,
    popularity: 86,
    tags: ['日常问候', '庭院收菜'],
    tagline: '花开的时候，记得回来看看。',
    summary:
      '治愈系小镇生活。问候、浇水、收菜、参加祭典，一天五分钟，也可以托管。',
    description:
      '《花见町物语》的节奏很慢，适合用低帧率模式运行。GamePilot 以 12fps 抓屏，识别居民头顶的对话气泡与庭院作物的成熟状态，完成后再安静退出。',
    highlights: ['低帧率模式省电，适合长期挂机', '对话气泡识别，不误点其他 UI', '祭典与限时活动会单独提示'],
    scenarios: [
      { name: '每日问候', desc: '和全镇居民打招呼，领取好感度奖励。', steps: ['出门', '寻找居民', '完成对话', '领取奖励'] },
      { name: '庭院照料', desc: '浇水、施肥、收获成熟作物。', steps: ['进入庭院', '检查作物', '浇水施肥', '收获入包'] },
      { name: '祭典参与', desc: '活动期间完成一次祭典小游戏。', steps: ['前往神社', '参加祭典', '完成小游戏', '领取纪念品'] }
    ],
    automation: { nodes: 22, templates: 31, recoveries: 5, resolution: '1080 × 2400' }
  }
];

export const FEATURED_GAMES = GAMES.filter((game) => game.featured);
export const UPCOMING_GAMES = GAMES.filter((game) => game.status === '预约中');

export function getGame(slug) {
  return GAMES.find((game) => game.slug === slug);
}

export function getRelatedGames(game, count = 3) {
  return GAMES.filter((item) => item.slug !== game.slug)
    .sort((a, b) => {
      const sameA = a.category === game.category ? 1 : 0;
      const sameB = b.category === game.category ? 1 : 0;
      return sameB - sameA || b.popularity - a.popularity;
    })
    .slice(0, count);
}
