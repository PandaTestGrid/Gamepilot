import BlurText from '../reactbits/BlurText';
import SpotlightCard from '../reactbits/SpotlightCard';
import Icon from './Icon';
import Reveal from './Reveal';

export default function Reliability() {
  return (
    <section className="section section-alt" id="stack" aria-labelledby="stack-title">
      <div className="container">
        <div className="section-head section-head-row">
          <div>
            <Reveal as="p" className="eyebrow">
              为长时间运行设计
            </Reveal>
            <h2 id="stack-title">
              <BlurText as="span" text="挂机不是“跑一次”，" animateBy="chars" delay={24} />
              <br className="br-mobile" />
              <BlurText
                as="span"
                text="是“跑一整晚”"
                animateBy="chars"
                delay={24}
                startDelay={0.3}
              />
            </h2>
          </div>
          <Reveal as="p" className="section-lead" delay={0.08}>
            状态判断、异常恢复、资源占用、数据归属 —— 这些决定一套脚本能不能真的替你睡觉。
          </Reveal>
        </div>

        <div className="bento">
          <Reveal className="bento-wide" delay={0.04} amount={0.1}>
            <SpotlightCard className="bento-card">
              <span className="bento-icon">
                <Icon name="refresh" />
              </span>
              <h3>不知道自己在哪里？全局重新定位</h3>
              <p>
                掉线、闪断、误触把游戏带到了别的界面 —— 引擎会重新识别所有节点，找到路再继续，而不是原地死循环。
                恢复边（recovery）优先级高于一切，弹窗出现立刻打断处理。
              </p>
              <div className="recovery-diagram" aria-hidden="true">
                <span className="gnode">
                  <i className="dot warn" />
                  战斗中
                </span>
                <span className="recovery-line" />
                <span className="gnode is-rose">
                  <i className="dot rose" />
                  弹窗恢复
                </span>
                <span className="recovery-line" />
                <span className="gnode">
                  <i className="dot ok" />
                  回到主城
                </span>
              </div>
            </SpotlightCard>
          </Reveal>

          <Reveal delay={0.08} amount={0.1}>
            <SpotlightCard className="bento-card">
              <span className="bento-icon">
                <Icon name="target" />
              </span>
              <h3>坐标归一化</h3>
              <p>控制、录制、识别共用同一套归一化坐标。旋转、分辨率、黑边都不再让点击偏到隔壁。</p>
              <div className="coord-visual" aria-hidden="true">
                <span className="coord-phone" />
                <span className="crosshair" />
                <em>0.5, 0.5</em>
              </div>
            </SpotlightCard>
          </Reveal>

          <Reveal delay={0.12} amount={0.1}>
            <SpotlightCard className="bento-card">
              <span className="bento-icon">
                <Icon name="zap" />
              </span>
              <h3>热重载，不打断运行</h3>
              <p>改阈值、加一条边、切换工作流，保存即生效。运行中的状态机保留当前节点与运行态。</p>
              <div className="hot-reload" aria-hidden="true">
                <code>graph.json</code>
                <span>→</span>
                <code className="is-live">已生效</code>
              </div>
            </SpotlightCard>
          </Reveal>

          <Reveal delay={0.16} amount={0.1}>
            <SpotlightCard className="bento-card">
              <span className="bento-icon">
                <Icon name="lock" />
              </span>
              <h3>全程本地</h3>
              <p>投屏、识别、决策、执行都在这台电脑上完成。没有账号体系，没有云端推理，不依赖网络。</p>
              <div className="local-visual" aria-hidden="true">
                <span className="lock-ring">
                  <Icon name="lock" />
                </span>
                <span>画面不出本机</span>
              </div>
            </SpotlightCard>
          </Reveal>

          <Reveal delay={0.2} amount={0.1}>
            <SpotlightCard className="bento-card">
              <span className="bento-icon">
                <Icon name="cpu" />
              </span>
              <h3>变量与运行期黑板</h3>
              <p>
                坐标、阈值、重试次数抽成变量，动作里写 <code>$变量名</code>；<code>set</code>{' '}
                动作让脚本能计数、改状态。
              </p>
              <div className="var-visual" aria-hidden="true">
                <code>$次数</code>
                <span>=</span>
                <code>$次数 + 1</code>
                <em>→ 18</em>
              </div>
            </SpotlightCard>
          </Reveal>

          <Reveal delay={0.24} amount={0.1}>
            <SpotlightCard className="bento-card">
              <span className="bento-icon">
                <Icon name="folder" />
              </span>
              <h3>工作区就是文件夹</h3>
              <p>一个文件夹 = 一个工作区，一张流程图 = 一个子目录。可以放进 Git，也可以直接压缩发给朋友。</p>
              <div className="tree-visual" aria-hidden="true">
                <div>
                  <Icon name="folder" />
                  日常
                </div>
                <div className="tree-in">
                  <code>graph.json</code>
                </div>
                <div className="tree-in">
                  <code>templates/</code>
                  <span>12 张</span>
                </div>
              </div>
            </SpotlightCard>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
