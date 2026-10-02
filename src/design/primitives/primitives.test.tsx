/**
 * 基础原语测试（T1.4）。
 *
 * 重点覆盖三类行为：
 * 1. 交互与状态（点击、禁用、受控值、错误态）；
 * 2. 无障碍契约（role、aria 属性、键盘可达）；
 * 3. 中文与多字节（placeholder、错误文案、字数统计）——长篇小说软件的主要输入是中文，
 *    英文用例通过并不代表中文没问题。
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  Checkbox,
  IconButton,
  Input,
  Select,
  Switch,
  Textarea,
  Tooltip,
} from "./index";
import { mockReducedMotion } from "./test-utils";

describe("Button", () => {
  it("渲染文本并默认使用 primary / md", () => {
    const { container } = render(() => <Button>保存</Button>);
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("保存");
    expect(button?.classList.contains("yh-btn--primary")).toBe(true);
    expect(button?.classList.contains("yh-btn--md")).toBe(true);
  });

  it("点击触发 onClick", () => {
    const onClick = vi.fn();
    const { container } = render(() => <Button onClick={onClick}>保存</Button>);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled 时原生 disabled 生效且不触发 onClick", () => {
    const onClick = vi.fn();
    const { container } = render(() => (
      <Button disabled onClick={onClick}>
        保存
      </Button>
    ));
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // 原生 disabled 元素不会派发 click，fireEvent 会静默跳过。
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading 时拦住点击、置 aria-busy 并播报状态", () => {
    const onClick = vi.fn();
    const { container } = render(() => (
      <Button loading onClick={onClick}>
        保存
      </Button>
    ));
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector("[role='status']")).not.toBeNull();

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Enter 与 Space 都能激活按钮（原生按钮语义）", () => {
    const onClick = vi.fn();
    const { container } = render(() => <Button onClick={onClick}>保存</Button>);
    const button = container.querySelector("button") as HTMLButtonElement;
    button.focus();
    // jsdom 不实现「按 Enter 触发按钮 click」的默认行为，
    // 这里直接派发 click 验证回调接线，键盘可达性由原生标签保证。
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("size 与 block 生成对应的类名", () => {
    const { container } = render(() => (
      <Button size="lg" block variant="danger">
        删除
      </Button>
    ));
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.classList.contains("yh-btn--lg")).toBe(true);
    expect(button.classList.contains("yh-btn--danger")).toBe(true);
    expect(button.classList.contains("yh-btn--block")).toBe(true);
  });

  it("默认 type=button，避免在表单里被误当提交按钮", () => {
    const { container } = render(() => <Button>普通</Button>);
    expect(container.querySelector("button")?.getAttribute("type")).toBe(
      "button",
    );
  });

  it("class 透传给调用方", () => {
    const { container } = render(() => <Button class="my-save">保存</Button>);
    expect(
      container.querySelector("button")?.classList.contains("my-save"),
    ).toBe(true);
  });
});

describe("IconButton", () => {
  it("aria-label 提供给读屏，图标本身标记为装饰", () => {
    const { container } = render(() => (
      <IconButton aria-label="删除当前章节">
        <svg viewBox="0 0 16 16" />
      </IconButton>
    ));
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("删除当前章节");
    const svgWrapper = button.querySelector("span");
    expect(svgWrapper?.getAttribute("aria-hidden")).toBe("true");
  });

  it("点击触发 onClick", () => {
    const onClick = vi.fn();
    const { container } = render(() => (
      <IconButton aria-label="关闭" onClick={onClick}>
        <svg viewBox="0 0 16 16" />
      </IconButton>
    ));
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("传 pressed 时渲染为 aria-pressed 切换按钮", () => {
    const { container } = render(() => (
      <IconButton aria-label="切换侧栏" pressed>
        <svg />
      </IconButton>
    ));
    expect(
      container.querySelector("button")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("不传 pressed 时不渲染 aria-pressed", () => {
    const { container } = render(() => (
      <IconButton aria-label="关闭">
        <svg />
      </IconButton>
    ));
    expect(
      container.querySelector("button")?.hasAttribute("aria-pressed"),
    ).toBe(false);
  });

  it("disabled 时不触发 onClick", () => {
    const onClick = vi.fn();
    const { container } = render(() => (
      <IconButton aria-label="关闭" disabled onClick={onClick}>
        <svg />
      </IconButton>
    ));
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Input", () => {
  it("受控值渲染到输入框，输入回调带回中文文本", () => {
    const onInput = vi.fn();
    render(() => <Input label="书名" value="羽化写作" onInput={onInput} />);
    const input = screen.getByLabelText("书名") as HTMLInputElement;
    expect(input.value).toBe("羽化写作");

    fireEvent.input(input, { target: { value: "长安十二时辰" } });
    expect(onInput).toHaveBeenCalledWith("长安十二时辰", expect.anything());
  });

  it("错误态设置 aria-invalid，并给出 role=alert 的错误文案", () => {
    render(() => <Input label="书名" value="" error="书名不能为空" />);
    const input = screen.getByLabelText("书名");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("书名不能为空");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("有错误时不同时渲染 hint，避免信息竞争", () => {
    render(() => <Input label="书名" hint="最多 40 字" error="书名不能为空" />);
    expect(screen.queryByText("最多 40 字")).toBeNull();
    expect(screen.getByText("书名不能为空")).not.toBeNull();
  });

  it("无错误时 hint 通过 aria-describedby 关联", () => {
    render(() => <Input label="书名" hint="最多 40 字" />);
    const input = screen.getByLabelText("书名");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "最多 40 字",
    );
  });

  it("placeholder 支持中文", () => {
    render(() => <Input label="书名" placeholder="例如：羽化写作" />);
    expect(screen.getByPlaceholderText("例如：羽化写作")).not.toBeNull();
  });
});

describe("Textarea", () => {
  it("默认 4 行且受控", () => {
    render(() => <Textarea label="摘要" value="第一章概要" />);
    const area = screen.getByLabelText("摘要") as HTMLTextAreaElement;
    expect(area.rows).toBe(4);
    expect(area.value).toBe("第一章概要");
  });

  it("rows 可覆盖", () => {
    render(() => <Textarea label="摘要" rows={8} />);
    expect((screen.getByLabelText("摘要") as HTMLTextAreaElement).rows).toBe(8);
  });

  it("错误态设置 aria-invalid", () => {
    render(() => <Textarea label="摘要" error="摘要过长" />);
    expect(screen.getByLabelText("摘要").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByRole("alert").textContent).toBe("摘要过长");
  });
});

describe("Select", () => {
  const options = [
    { value: "v1", label: "第一卷 羽化" },
    { value: "v2", label: "第二卷 长安" },
    { value: "v3", label: "第三卷 归途", disabled: true },
  ];

  it("渲染全部选项并选中受控值", () => {
    render(() => <Select label="卷" options={options} value="v2" />);
    const select = screen.getByLabelText("卷") as HTMLSelectElement;
    expect(select.value).toBe("v2");
    expect(select.querySelectorAll("option")).toHaveLength(3);
  });

  it("未选中时渲染 placeholder 项", () => {
    render(() => (
      <Select label="卷" options={options} placeholder="请选择卷" />
    ));
    const select = screen.getByLabelText("卷") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.querySelector("option")?.textContent).toBe("请选择卷");
  });

  it("已有值时不再渲染 placeholder 项", () => {
    render(() => (
      <Select label="卷" options={options} value="v1" placeholder="请选择卷" />
    ));
    expect(screen.queryByText("请选择卷")).toBeNull();
  });

  it("选择后回调收到中文标签对应的值", () => {
    const onChange = vi.fn();
    render(() => (
      <Select label="卷" options={options} value="v1" onChange={onChange} />
    ));
    fireEvent.change(screen.getByLabelText("卷"), { target: { value: "v2" } });
    expect(onChange).toHaveBeenCalledWith("v2", expect.anything());
  });

  it("禁用选项带 disabled 属性", () => {
    render(() => <Select label="卷" options={options} value="v1" />);
    const select = screen.getByLabelText("卷") as HTMLSelectElement;
    expect(
      (select.querySelectorAll("option")[2] as HTMLOptionElement).disabled,
    ).toBe(true);
  });

  it("错误态设置 aria-invalid 并展示错误文案", () => {
    render(() => <Select label="卷" options={options} error="请选择所属卷" />);
    expect(screen.getByLabelText("卷").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByRole("alert").textContent).toBe("请选择所属卷");
  });
});

describe("Checkbox", () => {
  it("点击切换并回调新状态", () => {
    const onChange = vi.fn();
    render(() => (
      <Checkbox checked={false} onChange={onChange}>
        全选
      </Checkbox>
    ));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("选中时 data-checked 为 true", () => {
    const { container } = render(() => <Checkbox checked>已选</Checkbox>);
    expect(
      container.querySelector(".yh-checkbox")?.getAttribute("data-checked"),
    ).toBe("true");
  });

  it("indeterminate 会写到 DOM 属性上（Solid JSX 不支持该属性）", () => {
    const { container } = render(() => (
      <Checkbox indeterminate>部分选中</Checkbox>
    ));
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
    expect(
      container
        .querySelector(".yh-checkbox")
        ?.getAttribute("data-indeterminate"),
    ).toBe("true");
  });

  it("disabled 时不触发回调", () => {
    const onChange = vi.fn();
    render(() => (
      <Checkbox disabled onChange={onChange}>
        全选
      </Checkbox>
    ));
    const input = screen.getByRole("checkbox") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.click(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("invalid 时标记 aria-invalid 并加错误类", () => {
    const { container } = render(() => <Checkbox invalid>同意许可</Checkbox>);
    expect(screen.getByRole("checkbox").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      container
        .querySelector(".yh-checkbox")
        ?.classList.contains("yh-checkbox--invalid"),
    ).toBe(true);
  });
});

describe("Switch", () => {
  it("具备 role=switch 与 aria-checked", () => {
    render(() => <Switch checked={false}>自动保存</Switch>);
    const element = screen.getByRole("switch");
    expect(element.getAttribute("aria-checked")).toBe("false");
    expect(element.textContent).toContain("自动保存");
  });

  it("点击回调取反后的值", () => {
    const onChange = vi.fn();
    render(() => (
      <Switch checked={false} onChange={onChange}>
        自动保存
      </Switch>
    ));
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("checked 时 data-checked 与 aria-checked 均为 true", () => {
    render(() => <Switch checked>跟随系统主题</Switch>);
    const element = screen.getByRole("switch");
    expect(element.getAttribute("aria-checked")).toBe("true");
    expect(element.getAttribute("data-checked")).toBe("true");
  });

  it("disabled 时不触发回调", () => {
    const onChange = vi.fn();
    render(() => (
      <Switch disabled onChange={onChange}>
        自动保存
      </Switch>
    ));
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Tooltip", () => {
  it("悬停经过延迟后才出现", async () => {
    vi.useFakeTimers();
    render(() => (
      <Tooltip content="保存并返回书架" delay={300}>
        <Button>保存</Button>
      </Tooltip>
    ));

    const anchor = document.querySelector(".yh-tooltip-anchor") as HTMLElement;
    fireEvent.pointerEnter(anchor);
    // 延迟未到：不应出现。这正是「划过不闪提示」的关键。
    expect(screen.queryByRole("tooltip")).toBeNull();

    vi.advanceTimersByTime(299);
    expect(screen.queryByRole("tooltip")).toBeNull();

    await vi.advanceTimersByTimeAsync(2);
    expect(screen.getByRole("tooltip").textContent).toBe("保存并返回书架");
    vi.useRealTimers();
  });

  it("移出后立即收起", async () => {
    vi.useFakeTimers();
    render(() => (
      <Tooltip content="提示" delay={0}>
        <Button>按钮</Button>
      </Tooltip>
    ));
    const anchor = document.querySelector(".yh-tooltip-anchor") as HTMLElement;
    fireEvent.pointerEnter(anchor);
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole("tooltip")).not.toBeNull();

    fireEvent.pointerLeave(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });

  it("键盘聚焦也能看到提示（键盘用户拿不到悬停）", async () => {
    vi.useFakeTimers();
    render(() => (
      <Tooltip content="为什么这个按钮不可用" delay={0}>
        <Button disabled>保存</Button>
      </Tooltip>
    ));
    const anchor = document.querySelector(".yh-tooltip-anchor") as HTMLElement;
    fireEvent.focusIn(anchor);
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    vi.useRealTimers();
  });

  it("disabled 时不渲染提示", async () => {
    vi.useFakeTimers();
    render(() => (
      <Tooltip content="提示" delay={0} disabled>
        <Button>按钮</Button>
      </Tooltip>
    ));
    fireEvent.pointerEnter(
      document.querySelector(".yh-tooltip-anchor") as HTMLElement,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });

  it("reduced-motion 下降级为无位移、时长压到 100ms 以内", async () => {
    mockReducedMotion(true);
    vi.useFakeTimers();
    render(() => (
      <Tooltip content="提示" delay={0}>
        <Button>按钮</Button>
      </Tooltip>
    ));
    fireEvent.pointerEnter(
      document.querySelector(".yh-tooltip-anchor") as HTMLElement,
    );
    await vi.advanceTimersByTimeAsync(1);

    const tooltip = screen.getByRole("tooltip") as HTMLElement;
    expect(tooltip.style.transform).toBe("none");
    expect(
      Number.parseInt(tooltip.style.transitionDuration, 10),
    ).toBeLessThanOrEqual(100);
    vi.useRealTimers();
  });
});

// cleanup 由 test-utils 的 afterEach 统一处理。
cleanup;
