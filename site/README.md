# GamePilot 官网与游戏中心（独立前端站点）

![GamePilot 官网预览](./preview.jpg)

GamePilot 的产品官网与游戏中心，与同仓库的 Tauri 桌面端完全分离：本目录有独立的
`package.json`，不在根目录的 `pnpm-workspace.yaml`（只包含 `apps/*`、`packages/*`）中，
也不参与桌面端构建。

站点是**多页面应用**：首页负责产品叙事，游戏中心是独立的可浏览、可搜索、可分页的游戏库，
每个游戏有详情页，攻略、FAQ、商务合作与下载也都是独立路由。

## 路由

| 路径 | 页面 |
| --- | --- |
| `/` | 首页：产品 hero、pinned 横向游戏 Showcase、操作层四宫格、工作流、引擎字标、设备矩阵、对比、FAQ |
| `/games` | 游戏中心：焦点轮播、热门推荐、热门游戏视觉区（卡片进入游戏档案）、新游预约、分类、排行、搜索、分页 |
| `/games/hot/:id` | 热门游戏档案：官方封面、本地化介绍、官方画面、录制工作流分享位、素材说明 |
| `/games/:slug` | 游戏详情：封面、简介、自动化流程、识别示意、运行信息、相关场景 |
| `/guides` | 攻略列表 |
| `/guides/:slug` | 攻略文章（目录、正文、上一篇/下一篇） |
| `/faq` | 常见问题 |
| `/business` | 商务合作与需求表单（前端演示） |
| `/download` | 下载页：平台切换、系统要求、版本内容 |
| `*` | 404 |

`/games` 的筛选状态全部保存在 URL 里，可以直接分享或刷新：

- `?q=塔防` 关键词搜索
- `?category=角色扮演` 分类筛选
- `?sort=rating` 排序（`popular` / `rating` / `az`）
- `?page=2` 分页（每页 8 款）
- `?focus=search` 从头部搜索图标进入时自动聚焦搜索框

## 首页滚动叙事

首页不再是一排静态卡片，而是一段由滚动驱动的横向画廊（`src/components/GameShowcase.jsx`）：

- 桌面端把 6 张游戏卡固定在视口内，向下滚动时卡片横向推进，进度轨显示 `01 / 06`；
- 轨道末尾是一张“12 款可运行场景”的入口卡，继续滚动离开 pinned 区；
- 下方接着 12 个场景图标、第二段标题与教程入口，形成“游戏展示 → 产品能力”的叙事；
- ≤980px 或系统开启 reduced-motion 时自动退化为原生横向滑动，不固定、不劫持滚动。

滚动位置由 Motion 的 `useScroll` + `useSpring` 映射到 `translateX`，同时给每张卡叠加轻微的
纵向漂移；Hero 的文案与产品窗口也有随滚动淡出/上移的视差。

Showcase 之后是 `src/components/PlayStyles.jsx` 的“操作层”：真实工作台截图做斜切画框，
叠加识别/多开/录制/恢复边浮层，下方是四个六边形能力入口和“更多教程”链接。

## 视觉主题

官方配色与桌面客户端 `apps/desktop/src/index.css` 对齐，集中在 `src/styles/theme.css`：

- 底色 `#0f1115` / `#161920` / `#1c2029`，唯一强调色 `#4da3ff`，正文 `#e6e8ee`、次级 `#9aa3b2`、弱化 `#6b7280`；
- 主按钮为实心品牌蓝 + 深色前景 `#0b0d12`，不再使用紫→品红渐变；
- 章节强调文字统一为 `#4da3ff`，Hero 极光/CTA 光晕/TechText/滚动进度条改为蓝色与中性灰；
- 品牌 Logo 按你的要求保持原样，没有改动其配色或图形。
- 首屏产品窗口使用项目提供的真实桌面端截图 `src/assets/img/app-shot.jpg`，不再使用手绘 mockup。

## 游戏库

`src/data/games.js` 包含 12 款原创演示游戏（6 款可自动化 + 6 款预约中），字段包括标题、
分类、评分、热度、平台、标签、自动化配置、三条可运行场景与识别参数。游戏中心的焦点轮播、
热门推荐、下载排行、新游预约、分类计数、详情页和相关推荐都从这份数据派生。

12 款演示场景的封面是 `src/components/GamePoster.jsx` 里的 12 组内联 SVG（暗黑、霓虹、太空、
浮空岛、王冠、像素、冰原、余烬、潮汐、虚空、沙漠、花町），全部原创。

游戏中心另有一组“热门游戏”视觉区，封面、图标与截图取自
[夜神模拟器官网](https://www.yeshen.com/) 的游戏详情页，存放在 `public/hot/`：

- 4 张 4:5 封面（272 × 342）：碧蓝航线、明日方舟、Fate/Grand Order、阴阳师；
- 4 个 360 × 360 官方图标：`icon-azur.png`、`icon-arknights.png`、`icon-fgo.png`、`icon-onmyoji.png`；
- 画廊按 4 款游戏切换，每款 5 张官方截图，共 20 张：
  - 碧蓝航线 `azur-shots/`、FGO `fgo-shots/` 为竖屏（1080 × 1920 / 480 × 800）；
  - 明日方舟 `arknights-shots/`、阴阳师 `onmyoji-shots/` 为 1280 × 720 横屏；
- 数据在 `src/data/hotGames.js` 的 `HOT_GALLERY`；桌面用游戏标签切换，移动端标签可横向滑动；
- 每张截图点击可在新窗口查看原图，画廊右上角“查看来源”跳到对应夜神详情页。

### 单个游戏的档案页

热门区的四张大卡会进入 `/games/hot/:id`（`src/pages/HotGamePage.jsx`），每款游戏一个独立页面：

- Hero：官方 4:5 封面、中文名/英文名、页面级介绍与两个 CTA（申请内测、跳到当前页工作流区）；
- 左侧 sticky 页内导航：游戏档案 / 官方画面 / 录制的工作流 / 素材与说明；
- 官方画面复用 `HOT_GALLERY` 的 5 张截图，按竖屏/横屏自动排布；
- 录制的工作流区先由 `WORKFLOW_SLOTS` 提供三张“待发布”占位（日常/活动/多开），页面同时支持真实 `workflows` 数据；
- 底部素材说明把来源、素材类型、更新状态和版权归属写清楚。

真实录制数据到位后，在对应游戏对象上加 `workflows` 数组即可替换占位卡片。每张卡建议包含
`title`、`kind`、`summary`、`steps`、`version`、`resolution` 和 `author`；页面会优先渲染真实数据。

只作为视觉展示，不代表官方合作、已适配名单或对这些游戏自动化的承诺。

### 替换成自己的封面

如果你有已授权的官方素材，把图片放进 `public/covers/`，然后在 `src/data/games.js` 对应
游戏上加一个 `cover` 字段即可，其他布局无需改动：

```js
{
  slug: 'abyss-echo',
  // ...
  cover: 'covers/abyss-echo.jpg'
}
```

`GamePoster` 会优先渲染 `cover`，并自动拼接 Vite 的 `BASE_URL`。海报建议使用 400 × 520
（或同比例）的竖图；详情页的大图与游戏卡会按 `object-fit: cover` 裁切。

> 12 款演示场景没有直接搬用第三方封面；热门游戏区的真实封面来自夜神官网的游戏页，
> 版权归原游戏方，页面已标注“仅视觉展示”。若要正式上线，请替换为已授权素材。

## 技术栈

- Vite 8 + React 19
- React Router 7（`BrowserRouter`）
- Motion（`motion/react`）负责入场、滚动揭示、pinned 横向画廊与 Hero 视差
- Lenis 负责平滑滚动与锚点跳转
- 无 UI 框架、无 Tailwind、无外部字体/CDN；图片均为本地资源（真实 App 截图、夜神官网热门游戏封面、内联 SVG）

## ReactBits 组件

`src/reactbits/` 下是 [ReactBits](https://reactbits.dev/) 组件，按原版行为移植为无 Tailwind 版本：

| 组件 | 用途 |
| --- | --- |
| `TechText` | 首页引擎区全宽 `GAMEPILOT` 虚线蓝图字；鼠标透镜揭示填充、自动扫光、字母可拖拽/点击 |
| `TiltedCard` | 游戏海报卡的 3D 倾斜、视差与 glare（游戏中心、新游预约） |
| `BlurText` | 章节标题逐字模糊浮现 |
| `SpotlightCard` | 功能卡片跟随鼠标的径向高光 |
| `CountUp` | 首屏数据滚动计数 |
| `GlareHover` | 代码面板扫光 |
| `StarBorder` | 底部 CTA 旋转描边 |
| `ClickSpark` | 全站点按火花 |
| `Magnetic` | 主按钮磁吸 |
| `ShinyText` | 首屏内测标签的流光扫过 |
| `RotatingText` | 滚动画廊副标题中轮换“安卓手机 / iPhone / 桌面窗口 / Mock 设备” |
| `ScrollVelocity` | 图标墙下方的双向滚动文案带 |
| `DecryptedText` | 引擎区 `STATE MACHINE` 的逐字解密 |
| `GlitchText` | 404 的故障切片文字（悬停触发） |

`TechText`、`TiltedCard` 保留原版权头与实现；其余组件按 ReactBits 行为改写为无 Tailwind 版本。
当前共接入 14 个 ReactBits 效果。
`TechText` 的移动端提示会自动切换为“触摸字母 · 拖拽试试”。

## 本地运行

```bash
cd site
npm install
npm run dev      # http://127.0.0.1:4173
```

生产构建与本地预览：

```bash
npm run build    # 输出到 site/dist
npm run preview  # http://127.0.0.1:4173
```

## 部署

站点使用真实路径（`BrowserRouter`），部署时需要把未知路径回退到 `index.html`：

- Nginx：`try_files $uri $uri/ /index.html;`
- Vercel / Netlify / Cloudflare Pages：开启 SPA fallback
- 本地静态服务器：不要直接 `python -m http.server dist` 访问 `/games/xxx`，会 404

`vite.config.js` 使用默认的根路径 `base: '/'`。如果部署在子路径下，需要同时设置 Vite 的
`base` 与 `BrowserRouter` 的 `basename`。

## 目录

```
site/
├─ index.html
├─ vite.config.js
├─ public/covers/      自有封面素材（可选）
├─ src/
│  ├─ main.jsx / App.jsx / Layout.jsx
│  ├─ pages/           首页、游戏中心、详情、攻略、FAQ、商务、下载、404
│  ├─ components/      页面分区、GameShowcase、游戏卡、海报、分页、页头等 UI
│  ├─ data/            games.js / guides.js / faqs.js
│  ├─ reactbits/       ReactBits 组件
│  ├─ context/         DownloadContext（全局下载弹窗）
│  ├─ hooks/           usePageMeta
│  ├─ styles/          base.css + enhancements.css + pages.css + theme.css（靛蓝主题）
│  └─ assets/img/      favicon、设备画面 SVG
└─ dist/               npm run build 产物
```

## 说明

- 12 款游戏为原创视觉演示场景，不代表官方合作或已适配名单；真实识别效果取决于游戏画面。
- 站点不包含真实安装包下载、账号或支付能力；按钮与表单均明确标注为演示。
- 商务表单与内测邮箱表单只在前端生效，不会上传或发送任何数据。
- 更新依赖后请重新执行 `npm run build` 验证。
