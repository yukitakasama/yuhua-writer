/**
 * 组件预览页 `/dev/kit`（T1.9）。
 *
 * ## 这一页为什么不是"可选的开发工具"
 *
 * Gate G1 的通过条件是「**组件预览页可交互**；动效逐条核对通过」。
 * 计划书把它列为评审门，是因为在写作软件这种"视觉决策很多、
 * 但每个组件只出现一两次"的产品里，逐个打开业务界面去核对
 * 按钮的四种状态、弹层的三个方向，实际上做不到 ——
 * 你不可能在书架页里找到一个"危险态、加载中、禁用"的按钮。
 *
 * 因此这一页的价值是：**把所有状态并排放在一起**，让"按下态和
 * 悬停态的颜色是不是太接近了"这种问题一眼就能看出来。
 *
 * ## 为什么也放动效
 *
 * 计划书 5.5 节要求逐条核对动效时长与缓动。动效是**时间**维度的，
 * 静态截图核对不了。这里每个动效都带一个"重放"按钮，
 * 评审时能反复看同一条曲线，而不是等着它自己播。
 *
 * ## 为什么把动效令牌表也列出来
 *
 * 因为"逐条核对"需要有据可依。评审的人应当能一眼看到
 * `--d-base` 声明的是 180ms、实际也是 180ms，
 * 而不是只能凭感觉说"好像有点慢"。
 */

import { For, Show, createSignal, type JSX } from "solid-js";

import { t } from "@/strings";
import {
  Button,
  Checkbox,
  Dialog,
  Drawer,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  ScrollArea,
  Select,
  Switch,
  Tabs,
  Textarea,
  ToastRegion,
  Tooltip,
  pushToast,
} from "@/design/primitives";
import {
  DURATION,
  EASING,
  EASING_POINTS,
  SPRING_SOFT,
  SPRING_SNAPPY,
  prefersReducedMotion,
} from "@/design/motion";
import { formatNumber, heatColors, progressRing } from "@/design/charts";
import { PlusIcon, SearchIcon, SettingsIcon, TrashIcon } from "@/icons";

/** 预览页的区块。 */
function Section(props: {
  title: string;
  note?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section class="kit-section">
      <h2 class="kit-section__title">{props.title}</h2>
      <Show when={props.note}>
        {(note) => <p class="kit-section__note">{note()}</p>}
      </Show>
      <div class="kit-section__body">{props.children}</div>
    </section>
  );
}

/** 一组并排的样例。 */
function Row(props: { children: JSX.Element }): JSX.Element {
  return <div class="kit-row">{props.children}</div>;
}

/** 组件预览页。 */
export function DevKit(): JSX.Element {
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [popoverOpen, setPopoverOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [checked, setChecked] = createSignal(true);
  const [switched, setSwitched] = createSignal(false);
  const [text, setText] = createSignal("");
  const [selectValue, setSelectValue] = createSignal("draft");
  const [tab, setTab] = createSignal("basic");
  const [replay, setReplay] = createSignal(0);

  /** 触发一次动效重放。`data-replay` 变化会让 CSS 动画重新开始。 */
  const bump = (): void => {
    setReplay((n) => n + 1);
  };

  return (
    <div class="kit">
      <header class="kit__head">
        <h1 class="kit__title">{t("kit.title")}</h1>
        <p class="kit__note">{t("kit.note")}</p>
        <p class="kit__status" role="status">
          {prefersReducedMotion()
            ? t("kit.reducedMotionOn")
            : t("kit.reducedMotionOff")}
        </p>
      </header>

      {/* ---------- 基础原语 ---------- */}
      <Section title={t("kit.buttons")} note={t("kit.buttonsNote")}>
        <Row>
          <Button>默认</Button>
          <Button variant="secondary">次要</Button>
          <Button variant="ghost">幽灵</Button>
          <Button variant="danger">危险</Button>
        </Row>
        <Row>
          <Button size="sm">小</Button>
          <Button size="md">中</Button>
          <Button size="lg">大</Button>
        </Row>
        <Row>
          <Button disabled>禁用</Button>
          <Button loading>载入中</Button>
          <IconButton aria-label="搜索" pressed>
            <SearchIcon size={16} />
          </IconButton>
          <IconButton aria-label="新建">
            <PlusIcon size={16} />
          </IconButton>
          <IconButton aria-label="删除" variant="danger">
            <TrashIcon size={16} />
          </IconButton>
        </Row>
      </Section>

      <Section title={t("kit.inputs")}>
        <Row>
          <Input placeholder="单行输入" value={text()} onInput={setText} />
          <Select
            value={selectValue()}
            onChange={(value) => setSelectValue(value)}
            options={[
              { value: "draft", label: "草稿" },
              { value: "done", label: "已完成" },
              { value: "revising", label: "修订中" },
            ]}
          />
        </Row>
        <Row>
          <Checkbox checked={checked()} onChange={(next) => setChecked(next)}>
            记住这个选项
          </Checkbox>
          <Checkbox indeterminate>部分选中</Checkbox>
          <Switch checked={switched()} onChange={() => setSwitched((v) => !v)}>
            开启某个开关
          </Switch>
        </Row>
        <Textarea placeholder="多行输入" rows={3} />
        <Input label="带标签的输入" hint="这是一条辅助说明" placeholder="…" />
        <Input label="错误态" error="这一项不能为空" placeholder="…" />
      </Section>

      {/* ---------- 容器原语 ---------- */}
      <Section title={t("kit.containers")} note={t("kit.containersNote")}>
        <Row>
          <Button onClick={() => setDialogOpen(true)}>对话框</Button>
          <Button onClick={() => setDrawerOpen(true)}>抽屉</Button>
          <Button onClick={() => setPopoverOpen((v) => !v)}>浮层</Button>
          <Button onClick={() => setMenuOpen((v) => !v)}>菜单</Button>
          <Tooltip content="这是一个提示">
            <Button variant="secondary">悬停提示</Button>
          </Tooltip>
          <Button
            onClick={() =>
              pushToast({
                id: "kit-demo",
                title: "这是一条提示消息",
                tone: "info",
                duration: 3000,
              })
            }
          >
            吐司
          </Button>
        </Row>

        {/* 浮层与菜单用 Popover / Menu 的受控形式，锚点就是上面的按钮 */}
        <Popover
          open={popoverOpen()}
          onOpenChange={setPopoverOpen}
          content={
            <div class="kit-popover-body">
              浮层内容。按 Esc 或点击外部关闭。
            </div>
          }
        />

        <Menu open={menuOpen()} onClose={() => setMenuOpen(false)}>
          <MenuItem onSelect={() => setMenuOpen(false)}>第一项</MenuItem>
          <MenuItem onSelect={() => setMenuOpen(false)}>第二项</MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => setMenuOpen(false)}>
            危险项
          </MenuItem>
        </Menu>

        <Tabs
          value={tab()}
          onChange={setTab}
          label="预览分区"
          items={[
            { value: "basic", label: "基础" },
            { value: "motion", label: "动效" },
            { value: "charts", label: "图表" },
          ]}
        >
          {(value) => <p class="kit-note">当前分区：{String(value)}</p>}
        </Tabs>

        <div class="kit-scroll">
          <ScrollArea>
            <div class="kit-scroll__inner">
              <For each={Array.from({ length: 30 })}>
                {(_, i) => <p>第 {i() + 1} 行内容</p>}
              </For>
            </div>
          </ScrollArea>
        </div>
      </Section>

      {/* ---------- 动效（G1 逐条核对用） ---------- */}
      <Section title={t("kit.motion")} note={t("kit.motionNote")}>
        <table class="kit-table">
          <thead>
            <tr>
              <th>令牌</th>
              <th>时长</th>
              <th>缓动</th>
            </tr>
          </thead>
          <tbody>
            <For each={Object.entries(DURATION)}>
              {([name, ms]) => (
                <tr>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>{ms} ms</td>
                  <td>—</td>
                </tr>
              )}
            </For>
            <For each={Object.entries(EASING)}>
              {([name, value]) => (
                <tr>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td>—</td>
                  <td>
                    <code>{value}</code>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        <p class="kit-note">
          弹簧 SOFT：{JSON.stringify(SPRING_SOFT)}；SNAPPY：
          {JSON.stringify(SPRING_SNAPPY)}
        </p>
        <p class="kit-note">
          标准缓动控制点：{EASING_POINTS.standard.join(", ")}
        </p>

        <Row>
          <Button onClick={bump}>重放动效</Button>
          <span class="kit-note">已重放 {replay()} 次</span>
        </Row>

        {/*
          ## 重放为什么用 `<For>` 重建而不是加 class

          CSS 动画只在**元素被创建**时播放。给已经存在的元素改 class
          或属性都不会让它重播 —— 只会在动画已经结束的情况下
          保持终态。用 `<For>` 遍历一个只有一项的数组、
          并把 `replay()` 当 key，重放时旧节点被销毁、新节点被创建，
          动画自然从头开始。

          这是"重放"这类需求的标准做法，比为它引入 Web Animations API
          的 `anim.cancel(); anim.play()` 简单得多。
        */}
        <Row>
          <For each={[replay()]}>
            {(_, i) => (
              <div class="kit-motion-box kit-motion-box--fade" data-run={i()}>
                淡入 180ms
              </div>
            )}
          </For>
          <For each={[replay()]}>
            {(_, i) => (
              <div class="kit-motion-box kit-motion-box--slide" data-run={i()}>
                滑入 240ms
              </div>
            )}
          </For>
          <For each={[replay()]}>
            {(_, i) => (
              <div class="kit-motion-box kit-motion-box--scale" data-run={i()}>
                缩放 180ms
              </div>
            )}
          </For>
        </Row>
      </Section>

      {/* ---------- 图表基座 ---------- */}
      <Section title={t("kit.charts")} note={t("kit.chartsNote")}>
        <Row>
          {/* 直接取色阶数组：预览要显示的是"第 N 档长什么样"，
              而不是"打了一定字数会落在第几档" —— 后者是映射逻辑，
              由 scale.ts 的 levelForWords 负责，不在这里演示 */}
          <For each={heatColors("light")}>
            {(color, index) => (
              <div class="kit-heat">
                <div class="kit-heat__cell" style={{ background: color }} />
                <span class="kit-heat__label">
                  第 {formatNumber(index())} 档
                </span>
              </div>
            )}
          </For>
        </Row>
        <Row>
          <For
            each={[
              { value: 0, max: 100, label: "未开始" },
              { value: 35, max: 100, label: "进行中" },
              { value: 78, max: 100, label: "接近完成" },
              { value: 100, max: 100, label: "已达标" },
            ]}
          >
            {(item) => {
              // 进度环的几何由图表基座算：调用方只给半径与进度比，
              // 不自己写 `2πr` 与 `dasharray` —— 那类计算散在组件里
              // 必然会在某处写错一次
              const radius = 20;
              const strokeWidth = 5;
              const ring = progressRing(radius, item.value / item.max);
              return (
                <div class="kit-ring">
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 48 48"
                    role="img"
                    aria-label={`${item.label} ${item.value} / ${item.max}`}
                  >
                    <circle
                      cx="24"
                      cy="24"
                      r={radius}
                      fill="none"
                      stroke="var(--c-border)"
                      stroke-width={strokeWidth}
                    />
                    <circle
                      cx="24"
                      cy="24"
                      r={radius}
                      fill="none"
                      stroke="var(--c-accent)"
                      stroke-width={strokeWidth}
                      stroke-dasharray={ring.dashArray}
                      stroke-dashoffset={ring.offset}
                      stroke-linecap="round"
                      transform="rotate(-90 24 24)"
                    />
                  </svg>
                  <span class="kit-ring__label">{item.label}</span>
                </div>
              );
            }}
          </For>
        </Row>
      </Section>

      {/* ---------- 弹层实例 ---------- */}
      <Dialog
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
        title="对话框标题"
      >
        <p>这是对话框内容。焦点会被陷阱在内部，Esc 可关闭。</p>
        <Button onClick={() => setDialogOpen(false)}>关闭</Button>
      </Dialog>

      <Drawer
        open={drawerOpen()}
        side="right"
        onClose={() => setDrawerOpen(false)}
        title="抽屉标题"
      >
        <p>抽屉从右侧滑入。</p>
        <Button onClick={() => setDrawerOpen(false)}>关闭</Button>
      </Drawer>

      <ToastRegion />

      <footer class="kit__foot">
        <SettingsIcon size={14} />
        <span>{t("kit.footer")}</span>
      </footer>
    </div>
  );
}
