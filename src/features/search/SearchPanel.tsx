/**
 * 检索与大纲面板（T6.1 / T6.2 / T6.3）。
 *
 * ## 两个标签页而不是两个入口
 *
 * 「我刚写的那句在哪儿」和「这本书的结构是什么样」是同一个心理动作的
 * 两个方向：都在找"我写的东西在哪"。合成一个面板后，作者只需要记住
 * 一个快捷键（Ctrl+K / Ctrl+F），不必先判断自己该开哪一个。
 *
 * ## 检索是防抖 + 竞态安全
 *
 * 两个容易出事的地方：
 *
 * 1. **每敲一个字就查一次 FTS5** —— 中文输入法下"写小说"这三个字
 *    会产生十几次中间态。因此 180ms 防抖。
 * 2. **慢的旧请求覆盖快的新请求** —— 输入"张三"时，只有"张"的结果
 *    先回来，界面会显示错的结果。因此每次请求带一个自增序号，
 *    回来时序号不是最新的就整个丢弃。
 *
 * ## 键盘可达（A9 验收项）
 *
 * 输入框里按 ↓ 直接进入结果列表；结果里 ↑↓ 移动、回车跳转、Esc 关闭。
 * 全流程不碰鼠标。
 */

import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js";

import { t } from "@/strings";
import * as ipc from "@/lib/ipc";
import type { OutlineNode, SearchHit } from "@/lib/ipc";
import { Dialog, ScrollArea } from "@/design/primitives";
import { Button } from "@/app/ui/Button";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyTree } from "@/app/ui/illustrations";
import { OutlineIcon, SearchIcon } from "@/icons";
import { selectChapter, selectedChapterId } from "@/app/workspace-store";
import { requestJump } from "./search-store";
import { SnippetText } from "./SnippetText";


/** 检索面板属性。 */
export interface SearchPanelProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭。 */
  onClose: () => void;
  /** 打开时的初始标签页。 */
  initialTab?: "search" | "outline";
}

/** 防抖时长。太短会让输入法中间态也触发查询，太长会感觉迟钝。 */
const DEBOUNCE_MS = 180;

/** 检索与大纲面板。 */
export function SearchPanel(props: SearchPanelProps): JSX.Element {
  const [tab, setTab] = createSignal<"search" | "outline">(props.initialTab ?? "search");
  const [keyword, setKeyword] = createSignal("");
  const [titleOnly, setTitleOnly] = createSignal(false);
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [total, setTotal] = createSignal(0);
  const [tokens, setTokens] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [outline, setOutline] = createSignal<OutlineNode[]>([]);
  const [outlineLoading, setOutlineLoading] = createSignal(false);
  /** 进入过检索态才显示"没有结果"，避免刚打开就报"没有找到" */
  const [searched, setSearched] = createSignal(false);

  let inputEl: HTMLInputElement | undefined;
  /** 请求序号：只有最新一次请求的结果会被采纳。 */
  let requestId = 0;
  let debounceTimer: number | undefined;

  /**
   * 打开时把焦点送到输入框并载入大纲。
   *
   * ## 这里曾经有一个自触发死循环
   *
   * 第一版写的是：
   *
   * ```ignore
   * createEffect(() => {
   *   if (!props.open) return;
   *   if (outline().length === 0) void loadOutline();  // ← 问题在这一行
   * });
   * ```
   *
   * Solid 的 `createEffect` 会追踪**函数体内读到的每一个 signal**。
   * 这个 effect 里读了 `outline()`，而 `loadOutline` 又会
   * `setOutline(...)` —— 于是每次大纲变化都重新触发 effect，
   * 重新判断"是不是空的"，再触发一次加载。空大纲时这个环不收敛，
   * 组件的 render 永远不返回，**整个测试 worker 挂死**（不是报错，
   * 是死等）。这个 bug 是"跑测试挂住"暴露出来的，读代码看不出来。
   *
   * 修复办法是**把判断写成不追踪的形式**：`untrack` 让这次读取
   * 不进依赖图。加载本身由 `props.open` 的变化驱动，而不是由
   * "当前大纲是否为空"驱动 —— 后者本来就是个会自我否定的条件。
   */
  createEffect(() => {
    if (!props.open) return;
    setActiveIndex(0);
    queueMicrotask(() => inputEl?.focus());
    // 只在打开时判断一次"要不要加载"，且这次判断不建立依赖
    const needsLoad = untrack(() => outline().length === 0);
    if (needsLoad) void loadOutline();
  });

  // 关窗时清掉待触发的防抖，避免"关了面板还在后台查询"
  onCleanup(() => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  });

  /** 载入大纲（T6.3）。 */
  const loadOutline = async (): Promise<void> => {
    setOutlineLoading(true);
    try {
      const nodes = await ipc.getOutline();
      setOutline(nodes);
    } catch {
      // 大纲拿不到不是致命错误：卷章树还在左侧，用户照常写作
      setOutline([]);
    } finally {
      setOutlineLoading(false);
    }
  };

  /** 执行一次检索。 */
  const runSearch = async (text: string, onlyTitle: boolean): Promise<void> => {
    const query = text.trim();
    requestId += 1;
    const mine = requestId;
    if (query.length === 0) {
      setHits([]);
      setTotal(0);
      setTokens([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    try {
      const results = await ipc.search({ keyword: query, titleOnly: onlyTitle, limit: 50 });
      // 竞态：慢的旧请求回来时直接丢弃
      if (mine !== requestId) return;
      setHits(results.hits);
      setTotal(results.total);
      setTokens(results.tokens);
      setActiveIndex(0);
      setSearched(true);
    } catch {
      if (mine !== requestId) return;
      setHits([]);
      setTotal(0);
      setSearched(true);
    } finally {
      if (mine === requestId) setLoading(false);
    }
  };

  /** 输入变化：防抖后检索。 */
  const handleInput = (value: string): void => {
    setKeyword(value);
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      void runSearch(value, titleOnly());
    }, DEBOUNCE_MS);
  };

  /** 切换「只搜标题」时立刻重查（它是显式动作，不需要防抖）。 */
  const handleToggleTitleOnly = (): void => {
    const next = !titleOnly();
    setTitleOnly(next);
    void runSearch(keyword(), next);
  };

  /**
   * 跳转到一条结果（T6.2）。
   *
   * 三段式：选中章节 → 请求编辑器跳到偏移 → 关闭面板。
   * 关闭放最后：正文载入是异步的，先关面板能让作者立刻看到编辑器。
   */
  const jumpTo = (hit: SearchHit): void => {
    const offset = computeOffset(hit, keyword());
    selectChapter(hit.chapterId);
    requestJump(hit.chapterId, offset);
    props.onClose();
  };

  /** 当前高亮的结果项。 */
  const current = createMemo(() => hits()[activeIndex()] ?? null);

  /** 结果列表的键盘导航。 */
  const handleListKeyDown = (event: KeyboardEvent): void => {
    const list = hits();
    if (list.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, list.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(list.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = list[activeIndex()];
      if (hit) jumpTo(hit);
    }
  };

  /** 输入框里的 ↓：把焦点交给结果列表（A9 的"全键盘可达"）。 */
  const handleInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" && hits().length > 0) {
      event.preventDefault();
      const first = document.querySelector<HTMLElement>(".hit");
      first?.focus();
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("search.title")}
      width={640}
      initialFocus={() => inputEl ?? null}
      class="search-panel"
    >
      <div class="search-panel__tabs" role="tablist" aria-label={t("search.title")}>
        <button
          type="button"
          role="tab"
          class="search-panel__tab"
          classList={{ "is-active": tab() === "search" }}
          aria-selected={tab() === "search" ? "true" : "false"}
          onClick={() => setTab("search")}
        >
          <SearchIcon size={14} />
          <span>{t("search.tabSearch")}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="search-panel__tab"
          classList={{ "is-active": tab() === "outline" }}
          aria-selected={tab() === "outline" ? "true" : "false"}
          onClick={() => setTab("outline")}
        >
          <OutlineIcon size={14} />
          <span>{t("search.tabOutline")}</span>
        </button>
      </div>

      <Show when={tab() === "search"}>
        <div class="search-panel__field">
          <label class="yh-visually-hidden" for="search-panel-input">
            {t("search.inputLabel")}
          </label>
          <input
            id="search-panel-input"
            ref={inputEl}
            type="search"
            class="field search-panel__input"
            placeholder={t("search.placeholder")}
            value={keyword()}
            aria-label={t("search.inputLabel")}
            onInput={(event) => handleInput(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
          />
          <button
            type="button"
            class="stats-nav-btn"
            aria-pressed={titleOnly() ? "true" : "false"}
            onClick={handleToggleTitleOnly}
          >
            {t("search.titleOnly")}
          </button>
        </div>

        <p class="search-panel__meta" role="status" aria-live="polite">
          <Show when={keyword().trim().length > 0} fallback={t("search.empty")}>
            <Show when={!loading()} fallback={t("search.searching")}>
              <span class="yh-num">{t("search.resultCount", { count: total() })}</span>
              <Show when={tokens().length > 0}>
                <span class="search-panel__tokens"> {t("search.tokens", { tokens: tokens().join(" / ") })}</span>
              </Show>
            </Show>
          </Show>
        </p>

        <ScrollArea class="search-panel__results" orientation="vertical">
          <Show
            when={hits().length > 0}
            fallback={
              <Show when={!searched() || loading()}>
                <p class="search-panel__hint">{t("search.hint")}</p>
              </Show>
            }
          >
            <ul
              class="hits"
              aria-label={t("search.resultList")}
              onKeyDown={handleListKeyDown}
            >
              <For each={hits()}>
                {(hit, index) => (
                  <li>
                    <button
                      type="button"
                      class="hit"
                      classList={{ "is-active": index() === activeIndex() }}
                      aria-current={current()?.chapterId === hit.chapterId ? "true" : undefined}
                      tabindex={index() === activeIndex() ? 0 : -1}
                      onClick={() => jumpTo(hit)}
                      onFocus={() => setActiveIndex(index())}
                    >
                      <span class="hit__title">{hit.title}</span>
                      <span class="hit__path">{hit.path}</span>
                      <For each={hit.snippets.slice(0, 3)}>
                        {(snippet) => (
                          <span class="hit__line">
                            <SnippetText snippet={snippet} />
                          </span>
                        )}
                      </For>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={searched() && hits().length === 0 && !loading()}>
            <p class="search-panel__empty" role="status">
              {t("search.noResult")}
            </p>
          </Show>
        </ScrollArea>

        <p class="search-panel__keyboard">{t("search.keyboardHint")}</p>
      </Show>

      <Show when={tab() === "outline"}>
        <Show
          when={outline().length > 0}
          fallback={
            <Show when={!outlineLoading()}>
              <EmptyState illustration={<IllustrationEmptyTree size={96} />} title={t("search.outlineEmpty")} />
            </Show>
          }
        >
          <ScrollArea class="search-panel__results" orientation="vertical">
            <ul class="outline">
              <For each={outline()}>
                {(volume) => (
                  <li class="outline__volume">
                    <div class="outline__volume-head">
                      <span class="outline__volume-title">{volume.title}</span>
                      <span class="outline__meta yh-num">
                        {t("search.outlineVolumeMeta", {
                          chapters: volume.chapterCount,
                          words: volume.wordCount.toLocaleString("zh-CN"),
                        })}
                      </span>
                    </div>
                    <ul class="outline__chapters">
                      <For each={volume.chapters}>
                        {(chapter) => (
                          <li>
                            <button
                              type="button"
                              class="outline__chapter"
                              aria-current={selectedChapterId() === chapter.id ? "true" : undefined}
                              onClick={() => {
                                selectChapter(chapter.id);
                                requestJump(chapter.id, 0);
                                props.onClose();
                              }}
                            >
                              <span class="outline__chapter-title">{chapter.title}</span>
                              <span class="outline__meta yh-num">
                                {t("search.outlineChapterMeta", { words: chapter.wordCount.toLocaleString("zh-CN") })}
                              </span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </li>
                )}
              </For>
            </ul>
          </ScrollArea>
        </Show>

        <div class="search-panel__foot">
          <Button variant="ghost" size="sm" onClick={() => void loadOutline()}>
            {t("action.refresh")}
          </Button>
        </div>
      </Show>
    </Dialog>
  );
}

/**
 * 由一条结果算出**片段内**的命中下标。
 *
 * ## 为什么这里只算片段内的下标
 *
 * 检索结果里只有片段，没有正文。片段是围绕命中位置截出来的窗口
 * （前后各约 24 字），它自己不知道在正文的哪个位置。把片段起点当锚点、
 * 在真实正文里重新定位是**编辑器**的活（见 EditorPane 对 pendingJump
 * 的消费），因为只有它拿得到正文。
 *
 * 因此这里必须给准：直接用后端已经算好的 `ranges[0][0]`，
 * 而不是再 `indexOf` 一次 —— 关键词跨换行（片段里换行被压成空格）时
 * `indexOf` 会找不到，而 range 是后端在原文本上算出来的，永远是对的。
 *
 * ## 为什么优先用含高亮的片段
 *
 * 不含高亮的片段说明命中在**标题**里，正文里未必有这个词。
 * 拿它去定位会把光标送到一个无关的位置，比不跳更让人困惑。
 */
export function computeOffset(hit: SearchHit, keyword: string): number {
  const preferred = hit.snippets.find((s) => s.ranges.length > 0) ?? hit.snippets[0];
  if (!preferred) return 0;
  const range = preferred.ranges[0];
  if (range) return Math.max(0, range[0]);
  const at = preferred.text.indexOf(keyword.trim());
  return at >= 0 ? at : 0;
}

/**
 * 取一条结果的「锚点文字」：片段开头的一小段。
 *
 * 编辑器用它把「片段内的偏移」换算成「正文里的偏移」：先在正文里
 * 找到锚点，再加上片段内偏移。取 16 个字符是权衡的结果 ——
 * 太短会在常见短语上撞车（「他说」到处都是），太长则正文稍有改动
 * （云盘同步、外部编辑器改过）就找不到。
 */
export function hitAnchor(hit: SearchHit): string {
  const preferred = hit.snippets.find((s) => s.ranges.length > 0) ?? hit.snippets[0];
  if (!preferred) return "";
  return preferred.text.slice(0, Math.min(16, preferred.text.length)).trim();
}
