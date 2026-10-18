import BlurText from '../reactbits/BlurText';
import Reveal from './Reveal';

const ROWS = [
  {
    label: '脚本形态',
    us: '状态图 + 可读 JSON',
    macro: '坐标回放',
    airtest: 'Python 脚本'
  },
  {
    label: '界面理解',
    us: '模板 / 颜色识别 + 实时分数',
    macro: '找图 / 找色',
    airtest: '图像识别 API'
  },
  {
    label: '异常处理',
    us: 'recovery 边 + 全局重定位',
    macro: '通常需要自己写',
    airtest: '手写 try / except'
  },
  {
    label: '多设备',
    us: '多开网格 + 同步控制',
    macro: '有限',
    airtest: '多进程脚本'
  },
  {
    label: '触控通道',
    us: 'scrcpy / HID / CGEvent',
    macro: '系统级模拟',
    airtest: 'adb / WDA'
  },
  {
    label: '上手成本',
    us: '框选 + 连线，无需代码',
    macro: '低',
    airtest: '需要 Python'
  },
  {
    label: '数据归属',
    us: '全部本地，可 git 管理',
    macro: '本地',
    airtest: '本地 / 可选云端'
  }
];

export default function Compare() {
  return (
    <section className="section" id="compare" aria-labelledby="compare-title">
      <div className="container">
        <div className="section-head">
          <Reveal as="p" className="eyebrow">
            怎么选
          </Reveal>
          <h2 id="compare-title">
            <BlurText as="span" text="和录制宏、脚本框架有什么不同" animateBy="chars" delay={20} />
          </h2>
          <Reveal as="p" className="section-lead" delay={0.08}>
            GamePilot 想解决的不是“模拟一次点击”，而是“让流程知道现在该做什么”。
          </Reveal>
        </div>

        <Reveal className="compare-wrap" amount={0.05}>
          <div className="compare-table" role="table" aria-label="GamePilot、录制宏与 Airtest 的能力对比">
            <div className="compare-row compare-head" role="row">
              <div className="compare-cell" role="columnheader">
                能力
              </div>
              <div className="compare-cell is-us" role="columnheader">
                <span className="us-mark">GamePilot</span>
              </div>
              <div className="compare-cell" role="columnheader">
                录制宏
              </div>
              <div className="compare-cell" role="columnheader">
                Airtest 类框架
              </div>
            </div>

            {ROWS.map((row) => (
              <div className="compare-row" role="row" key={row.label}>
                <div className="compare-cell" role="cell">
                  {row.label}
                </div>
                <div className="compare-cell is-us" role="cell">
                  <b>{row.us}</b>
                </div>
                <div className="compare-cell" role="cell">
                  {row.macro}
                </div>
                <div className="compare-cell" role="cell">
                  {row.airtest}
                </div>
              </div>
            ))}
          </div>
          <p className="compare-note">
            对比基于常见使用方式，不构成对第三方产品的完整评价。Airtest 等框架可通过编程实现更复杂的逻辑，
            GamePilot 面向的是“不想写代码、但要长期稳定跑”的场景。
          </p>
        </Reveal>
      </div>
    </section>
  );
}
