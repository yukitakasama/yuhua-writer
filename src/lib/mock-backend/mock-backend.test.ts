/**
 * mock 后端测试。
 *
 * ## 为什么值得给"假后端"写测试
 *
 * 这份 mock 不是一次性脚手架：浏览器预览模式、组件测试、
 * 以及将来 CI 里的端到端测试都依赖它。如果它的行为与真实后端
 * 有偏差，前端就会在 mock 上跑得好好的、接上 Tauri 立刻出错 ——
 * 这类问题最难定位，因为"测试是绿的"。
 *
 * 因此这些用例的重点是**语义一致性**：
 * 序号连续性、删除进回收站而不真删、字数口径与 Rust 相同、
 * 乐观并发会拒绝过期写入。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  createMockBackend,
  MockError,
  findOccurrences,
  type MockBackend,
} from "./index";
import { countWords } from "./count";

let backend: MockBackend;

beforeEach(() => {
  backend = createMockBackend();
});

/** 取示例书的第一卷 ID。 */
function firstVolumeId(): string {
  const volume = backend.getOutline()[0];
  if (!volume) throw new Error("示例数据里没有卷");
  return volume.volumeId;
}

/**
 * 取全部章节（拉平大纲）。
 *
 * ## 为什么 mock 不再提供 `listChapters`
 *
 * 真实后端没有这个命令：**大纲就是章节列表**（`get_outline` 按卷
 * 聚合）。mock 曾经提供它，于是前端代码里出现了一堆"只在浏览器里
 * 能用"的调用。删掉它，让 mock 与后端保持同一份接口。
 *
 * 测试需要拉平的列表时由这个本地辅助函数提供 —— 这是**测试侧**
 * 的便利，不是接口的一部分。
 */
function allChapters() {
  return backend.getOutline().flatMap((node) => node.chapters);
}

/** 取某一卷的章节。 */
function chaptersIn(volumeId: string) {
  return allChapters().filter((c) => c.volumeId === volumeId);
}

describe("示例数据", () => {
  it("打开返回至少两卷，且有章", () => {
    const result = backend.openWorkspace("C:/x");
    expect(result.outline.length).toBeGreaterThanOrEqual(2);
    expect(allChapters().length).toBeGreaterThan(0);
  });

  it("openWorkspace 返回的键与 Rust OpenResult 一致", () => {
    // mock 是行为镜像：它的返回值形状必须与 commands.rs 的 OpenResult
    // 逐键相同。此前它返回 { root, document }，于是前端读 result.document
    // 在浏览器里能跑通、到 Tauri 里拿到 undefined —— 那正是这一层
    // 存在的意义所要防止的事故。
    const result = backend.openWorkspace("C:/x");
    expect(Object.keys(result).sort()).toEqual([
      "outline",
      "recovery",
      "words",
      "workspace",
    ]);
  });

  it("文稿结构里的章节**不含正文**（内存指标要求）", () => {
    for (const chapter of allChapters()) {
      expect(chapter).not.toHaveProperty("body");
    }
  });

  it("每章的 volumeId 都指向真实存在的卷", () => {
    const ids = new Set(backend.getOutline().map((n) => n.volumeId));
    for (const chapter of allChapters()) {
      expect(ids.has(chapter.volumeId)).toBe(true);
    }
  });

  it("同一卷内的 sort 恰好是 0..n-1", () => {
    for (const node of backend.getOutline()) {
      const sorts = node.chapters.map((c) => c.sort).sort((a, b) => a - b);
      expect(sorts).toEqual(sorts.map((_, i) => i));
    }
  });

  it("卷的 sort 恰好是 0..m-1", () => {
    const sorts = backend.getOutline().map((n) => n.sort);
    expect(sorts).toEqual(sorts.map((_, i) => i));
  });

  it("卷名互不相同（示例数据要能区分）", () => {
    const titles = backend.getOutline().map((n) => n.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("新建卷", () => {
  it("追加到末尾并给出连续序号", () => {
    const before = backend.getOutline().length;
    backend.createVolume({ title: "第四卷 归途" });
    const outline = backend.getOutline();
    expect(outline.length).toBe(before + 1);
    expect(outline.map((n) => n.sort)).toEqual(outline.map((_, i) => i));
  });

  it("可以在指定位置插入", () => {
    backend.createVolume({ title: "插在最前", sort: 0 });
    expect(backend.getOutline()[0]?.title).toBe("插在最前");
  });

  it("空卷名被拒绝", () => {
    expect(() => backend.createVolume({ title: "   " })).toThrowError(
      MockError,
    );
    try {
      backend.createVolume({ title: "" });
    } catch (err) {
      expect((err as MockError).error.code).toBe("INVALID_INPUT");
      expect((err as MockError).error.recoverable).toBe(true);
    }
  });

  it("超长卷名被拒绝", () => {
    expect(() =>
      backend.createVolume({ title: "字".repeat(201) }),
    ).toThrowError(MockError);
  });

  it("中文卷名可以完整取回", () => {
    backend.createVolume({ title: "第四卷 惊蛰之末" });
    expect(
      backend.getOutline().some((n) => n.title === "第四卷 惊蛰之末"),
    ).toBe(true);
  });
});

describe("重命名卷", () => {
  it("改名成功", () => {
    const id = firstVolumeId();
    backend.renameVolume(id, "第一卷 重命名");
    expect(backend.getOutline().find((n) => n.volumeId === id)?.title).toBe(
      "第一卷 重命名",
    );
  });

  it("改名后其下章节的路径跟着更新", () => {
    const id = firstVolumeId();
    const before = chaptersIn(id)[0]?.path ?? "";
    backend.renameVolume(id, "新卷名");
    const after = chaptersIn(id)[0]?.path ?? "";
    expect(after).not.toBe(before);
    expect(after).toContain("新卷名");
  });

  it("空名被拒绝且原名不变", () => {
    const id = firstVolumeId();
    const before = backend.getOutline().find((n) => n.volumeId === id)?.title;
    expect(() => backend.renameVolume(id, "  ")).toThrowError(MockError);
    expect(backend.getOutline().find((n) => n.volumeId === id)?.title).toBe(
      before,
    );
  });

  it("重命名不存在的卷报 NOT_FOUND", () => {
    try {
      backend.renameVolume("vol_不存在", "x");
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as MockError).error.code).toBe("NOT_FOUND");
    }
  });
});

describe("新建章", () => {
  /** 取某一卷的最后一章（新建默认追加到末尾）。 */
  function lastChapterIn(volumeId: string) {
    const list = chaptersIn(volumeId);
    return list[list.length - 1];
  }

  it("追加到卷末尾并自动编号", () => {
    const id = firstVolumeId();
    backend.createChapter({ volumeId: id });
    const created = lastChapterIn(id);
    expect(created?.sort).toBe(3); // 示例第一卷原有 3 章
    expect(created?.status).toBe("draft");
    expect(created?.wordCount).toBe(0);
  });

  it("新章必须有归属卷", () => {
    const id = firstVolumeId();
    backend.createChapter({ volumeId: id });
    expect(lastChapterIn(id)?.volumeId).toBe(id);
  });

  it("可以指定标题", () => {
    const id = firstVolumeId();
    backend.createChapter({ volumeId: id, title: "第六章 归途" });
    expect(lastChapterIn(id)?.title).toBe("第六章 归途");
  });

  it("卷内序号保持连续", () => {
    const id = firstVolumeId();
    backend.createChapter({ volumeId: id });
    backend.createChapter({ volumeId: id });
    const sorts = chaptersIn(id)
      .map((c) => c.sort)
      .sort((a, b) => a - b);
    expect(sorts).toEqual(sorts.map((_, i) => i));
  });

  it("新章有可用的路径", () => {
    const id = firstVolumeId();
    backend.createChapter({ volumeId: id, title: "新章" });
    const created = lastChapterIn(id);
    expect(created?.path).toMatch(/^manuscript\//);
    expect(created?.path.endsWith(".md")).toBe(true);
  });

  it("往不存在的卷里新建章报错", () => {
    expect(() => backend.createChapter({ volumeId: "vol_无" })).toThrowError(
      MockError,
    );
  });
});

describe("读取与保存正文", () => {
  it("读回来的正文非空，且统计口径与内容一致", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    const content = backend.readChapter(first.id);
    expect(content.body.length).toBeGreaterThan(0);
    expect(content.words.withoutPunctuation).toBe(
      countWords(content.body).withoutPunctuation,
    );
  });

  it("保存后字数与哈希都更新", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    const before = backend.readChapter(first.id);
    const saved = backend.saveChapter(
      first.id,
      "新的正文内容，一共十五个字。",
      before.contentHash,
    );
    expect(saved.contentHash).not.toBe(before.contentHash);
    expect(saved.body).toBe("新的正文内容，一共十五个字。");
    // 逐字核对：新(1)的(2)正(3)文(4)内(5)容(6)一(7)共(8)十(9)五(10)个(11)字(12)
    // 「，」与「。」是标点，不计入 hanChars，但计入含标点口径
    expect(saved.words.hanChars).toBe(12);
    expect(saved.words.withPunctuation).toBe(14);
  });

  it("保存后列表里的字数同步更新", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    const content = backend.readChapter(first.id);
    backend.saveChapter(first.id, "短", content.contentHash);
    expect(allChapters().find((c) => c.id === first.id)?.wordCount).toBe(1);
  });

  it("哈希对不上时拒绝保存（乐观并发）", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    try {
      backend.saveChapter(first.id, "不该被写入", "过期的哈希");
      expect.unreachable("应当拒绝");
    } catch (err) {
      expect((err as MockError).error.code).toBe("INVARIANT_VIOLATION");
      expect((err as MockError).error.message).toContain("外部修改");
    }
  });

  it("拒绝后正文保持原样，没有被静默覆盖", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    const original = backend.readChapter(first.id).body;
    try {
      backend.saveChapter(first.id, "覆盖内容", "错误的哈希");
    } catch {
      /* 预期内 */
    }
    expect(backend.readChapter(first.id).body).toBe(original);
  });

  it("保存空正文是合法的（清空一章）", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    const content = backend.readChapter(first.id);
    const saved = backend.saveChapter(first.id, "", content.contentHash);
    expect(saved.body).toBe("");
    expect(saved.words.withPunctuation).toBe(0);
  });
});

describe("重命名章", () => {
  it("改名成功且路径同步", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.renameChapter(first.id, "改名后的一章");
    const after = allChapters().find((c) => c.id === first.id);
    expect(after?.title).toBe("改名后的一章");
    expect(after?.path).toContain("改名后的一章");
  });

  it("空标题被拒绝", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    expect(() => backend.renameChapter(first.id, "   ")).toThrowError(
      MockError,
    );
  });
});

describe("章节状态", () => {
  it("可以设置为已完成", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.setChapterStatus(first.id, "done");
    expect(allChapters().find((c) => c.id === first.id)?.status).toBe("done");
  });

  it("三种状态都能设置", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    for (const status of ["draft", "revising", "done"] as const) {
      backend.setChapterStatus(first.id, status);
      expect(allChapters().find((c) => c.id === first.id)?.status).toBe(status);
    }
  });
});

describe("删除与回收站", () => {
  it("删除章节后列表不再包含它", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.deleteChapter(first.id);
    expect(allChapters().some((c) => c.id === first.id)).toBe(false);
  });

  it("删除后进入回收站而不是消失（可恢复）", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.deleteChapter(first.id);
    const trash = backend.listTrash();
    expect(trash.some((t) => t.originalId === first.id)).toBe(true);
    expect(trash[0]?.kind).toBe("chapter");
    // 回收站里的路径必须是相对路径（工作区可整体移动）
    expect(trash[0]?.originalPath).not.toContain(":\\");
  });

  it("删除后同卷序号重新连续", () => {
    const id = firstVolumeId();
    const chapters = allChapters().filter((c) => c.volumeId === id);
    const middle = chapters[1];
    if (!middle) throw new Error("示例数据不足");
    backend.deleteChapter(middle.id);
    const sorts = chaptersIn(id)
      .map((c) => c.sort)
      .sort((a, b) => a - b);
    expect(sorts).toEqual(sorts.map((_, i) => i));
  });

  it("从回收站恢复会移除该条目", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.deleteChapter(first.id);
    const entry = backend.listTrash()[0];
    if (!entry) throw new Error("回收站为空");
    backend.restoreFromTrash(entry.trashDirName);
    expect(backend.listTrash().length).toBe(0);
  });

  it("清空回收站返回清掉的条数", () => {
    const chapters = allChapters();
    backend.deleteChapter(chapters[0]?.id ?? "");
    backend.deleteChapter(chapters[1]?.id ?? "");
    expect(backend.emptyTrash()).toBe(2);
    expect(backend.listTrash().length).toBe(0);
  });

  it("恢复不存在的条目报 NOT_FOUND", () => {
    expect(() => backend.restoreFromTrash("不存在")).toThrowError(MockError);
  });

  it("删除整卷时其下章节一并进回收站", () => {
    const id = firstVolumeId();
    const count = allChapters().filter((c) => c.volumeId === id).length;
    backend.deleteVolume(id);
    expect(backend.listTrash().length).toBe(count);
    expect(allChapters().some((c) => c.volumeId === id)).toBe(false);
  });

  it("删光所有卷后自动补一个空卷（章不能没有卷）", () => {
    for (const node of backend.getOutline()) {
      backend.deleteVolume(node.volumeId);
    }
    const outline = backend.getOutline();
    expect(outline.length).toBe(1);
    expect(outline[0]?.chapterCount).toBe(0);
  });
});

describe("重排（与后端 reorder 契约一致）", () => {
  /** 取某一卷章节的 ID 顺序。 */
  function orderIn(volumeId: string): string[] {
    return chaptersIn(volumeId)
      .slice()
      .sort((a, b) => a.sort - b.sort)
      .map((c) => c.id);
  }

  it("同卷内重排：把最后一章挪到最前", () => {
    const id = firstVolumeId();
    const order = orderIn(id);
    const last = order[2];
    if (!last) throw new Error("示例数据不足");
    backend.reorderChapters(id, [last, ...order.slice(0, 2)]);

    const after = chaptersIn(id)
      .slice()
      .sort((a, b) => a.sort - b.sort);
    expect(after[0]?.id).toBe(last);
    // 序号必须重新收敛成 0..n-1，不能留空洞
    expect(after.map((c) => c.sort)).toEqual([0, 1, 2]);
  });

  it("重排后路径里的编号跟着更新", () => {
    const id = firstVolumeId();
    const order = orderIn(id);
    const last = order[order.length - 1];
    if (!last) throw new Error("示例数据不足");
    backend.reorderChapters(id, [last, ...order.slice(0, -1)]);
    const moved = chaptersIn(id).find((c) => c.id === last);
    expect(moved?.path).toContain("001-");
  });

  it("顺序里漏掉的章节保留在末尾（不丢数据）", () => {
    const id = firstVolumeId();
    const order = orderIn(id);
    const second = order[1];
    if (!second) throw new Error("示例数据不足");
    // 只提及一章：其余两章必须仍然存在
    backend.reorderChapters(id, [second]);
    const after = chaptersIn(id)
      .slice()
      .sort((a, b) => a.sort - b.sort);
    expect(after.length).toBe(3);
    expect(after[0]?.id).toBe(second);
    expect(after.map((c) => c.sort)).toEqual([0, 1, 2]);
  });

  it("重排卷改变卷的顺序", () => {
    const outline = backend.getOutline();
    const first = outline[0];
    const second = outline[1];
    if (!first || !second) throw new Error("示例数据不足");
    backend.reorderVolumes([second.volumeId, first.volumeId]);
    const after = backend.getOutline();
    expect(after[0]?.volumeId).toBe(second.volumeId);
    expect(after[1]?.volumeId).toBe(first.volumeId);
    expect(after.map((n) => n.sort)).toEqual(after.map((_, i) => i));
  });

  it("重排卷时漏掉的卷保留在末尾（不丢数据）", () => {
    const outline = backend.getOutline();
    const first = outline[0];
    if (!first) throw new Error("示例数据不足");
    const before = outline.length;
    backend.reorderVolumes([first.volumeId]);
    expect(backend.getOutline().length).toBe(before);
    expect(backend.getOutline()[0]?.volumeId).toBe(first.volumeId);
  });

  it("重排不存在的卷报 NOT_FOUND", () => {
    expect(() => backend.reorderChapters("vol_无", ["ch_1"])).toThrowError(
      MockError,
    );
  });
});

describe("字数统计", () => {
  it("全书字数是各章之和", () => {
    const stats = backend.getWordStats();
    const sum = allChapters().reduce((s, c) => s + c.wordCount, 0);
    expect(stats.book).toBe(sum);
  });

  it("章数与卷数正确", () => {
    const stats = backend.getWordStats();
    expect(stats.chapterCount).toBe(allChapters().length);
    expect(stats.volumeCount).toBe(backend.getOutline().length);
  });

  it("同时给卷与章时，两个字段都算出来", () => {
    const id = firstVolumeId();
    const chapter = allChapters().find((c) => c.volumeId === id);
    if (!chapter) throw new Error("示例数据不足");
    const stats = backend.getWordStats(id, chapter.id);
    expect(stats.chapter).toBe(chapter.wordCount);
    const volumeSum = allChapters()
      .filter((c) => c.volumeId === id)
      .reduce((s, c) => s + c.wordCount, 0);
    expect(stats.volume).toBe(volumeSum);
  });

  it("只给章不给卷时 volume 为 0（与 Rust 语义一致）", () => {
    // 这条钉的是 Rust `word_stats` 的真实语义：两个参数**各管一个字段**。
    // 曾经 mock 会从 chapter 反推出它所属卷的数字，比真实后端"聪明" ——
    // 那会掩盖调用方漏传 volumeId 这个真实缺陷（界面显示错误的"本卷 0 字"
    // 反而看不出来）。mock 是行为镜像，必须照做。
    const id = firstVolumeId();
    const chapter = allChapters().find((c) => c.volumeId === id);
    if (!chapter) throw new Error("示例数据不足");
    const stats = backend.getWordStats(undefined, chapter.id);
    expect(stats.chapter).toBe(chapter.wordCount);
    expect(stats.volume).toBe(0);
  });

  it("不存在的章节返回全 0 而不是抛错", () => {
    const stats = backend.getWordStats(undefined, "ch_无");
    expect(stats.chapter).toBe(0);
    expect(stats.volume).toBe(0);
    expect(stats.book).toBeGreaterThan(0);
  });

  it("三口径统计彼此关系正确（含标点 >= 不含标点）", () => {
    const first = allChapters()[0];
    if (!first) throw new Error("没有章节");
    const words = backend.getChapterWordCount(first.id);
    expect(words.withPunctuation).toBeGreaterThanOrEqual(
      words.withoutPunctuation,
    );
    expect(words.withoutPunctuation).toBeGreaterThanOrEqual(words.hanChars);
  });
});

describe("检索", () => {
  it("空关键词返回空结果而不是全部", () => {
    const result = backend.search({ keyword: "  " });
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("能搜到正文里的词", () => {
    const result = backend.search({ keyword: "雨" });
    expect(result.total).toBeGreaterThan(0);
    expect(result.hits[0]?.snippets.length).toBeGreaterThan(0);
  });

  it("能搜到标题", () => {
    const result = backend.search({ keyword: "落羽" });
    expect(result.hits.some((h) => h.title.includes("落羽"))).toBe(true);
  });

  it("搜不到的词返回空", () => {
    expect(backend.search({ keyword: "这个词一定不存在xyz" }).total).toBe(0);
  });

  it("标题命中的相关度高于仅正文命中", () => {
    const result = backend.search({ keyword: "落羽" });
    if (result.hits.length >= 2) {
      expect(result.hits[0]?.score).toBeGreaterThanOrEqual(
        result.hits[1]?.score ?? 0,
      );
    } else {
      expect(result.hits.length).toBeGreaterThan(0);
    }
  });

  it("titleOnly 时不搜正文", () => {
    const all = backend.search({ keyword: "雨" });
    const titleOnly = backend.search({ keyword: "雨", titleOnly: true });
    expect(titleOnly.total).toBeLessThanOrEqual(all.total);
  });

  it("limit 被夹紧在 1..200", () => {
    expect(backend.search({ keyword: "雨", limit: 0 }).limit).toBe(1);
    expect(backend.search({ keyword: "雨", limit: 9999 }).limit).toBe(200);
    expect(backend.search({ keyword: "雨" }).limit).toBe(30);
  });

  it("offset 分页不重复", () => {
    const all = backend.search({ keyword: "的", limit: 200 });
    if (all.hits.length >= 2) {
      const page = backend.search({ keyword: "的", limit: 1, offset: 1 });
      expect(page.hits[0]?.chapterId).not.toBe(all.hits[0]?.chapterId);
    } else {
      expect(all.total).toBeLessThan(2);
    }
  });

  it("可以限定只在某一卷内检索", () => {
    const volumeId = firstVolumeId();
    const scoped = backend.search({ keyword: "雨", volumeId });
    for (const hit of scoped.hits) {
      expect(hit.volumeId).toBe(volumeId);
    }
  });

  it("高亮区间是**字节**偏移，与 Rust 侧契约一致", () => {
    // 这条用例固定住一个踩过的坑：mock 曾经输出字符下标，
    // 而 IPC 层会把它当字节再转一次，于是中文区间塌缩成 [0,0]，
    // 界面上什么都高亮不出来。汉字的字节长度是 3，因此区间
    // 必须明显大于字符长度。
    const result = backend.search({ keyword: "雨" });
    const hit = result.hits[0];
    expect(hit).toBeDefined();
    const snippet = hit?.snippets[0];
    expect(snippet).toBeDefined();
    const range = snippet?.ranges[0];
    expect(range).toBeDefined();
    const [start, end] = range ?? [0, 0];
    expect(end - start).toBe(3); // 「雨」的 UTF-8 字节长度
  });

  it("高亮区间转换后能切出关键词所在的字节", () => {
    const result = backend.search({ keyword: "雨" });
    const snippet = result.hits[0]?.snippets[0];
    const [start, end] = snippet?.ranges[0] ?? [0, 0];
    // 把片段编码成字节后按区间切，得到的就是「雨」
    const bytes = new TextEncoder().encode(snippet?.text ?? "");
    expect(new TextDecoder().decode(bytes.slice(start, end))).toBe("雨");
  });

  it("高亮区间落在片段文本范围内", () => {
    const result = backend.search({ keyword: "雨" });
    for (const hit of result.hits) {
      for (const snippet of hit.snippets) {
        for (const [start, end] of snippet.ranges) {
          expect(start).toBeGreaterThanOrEqual(0);
          expect(end).toBeLessThanOrEqual(snippet.text.length);
          expect(end).toBeGreaterThan(start);
        }
      }
    }
  });
});

describe("findOccurrences", () => {
  it("找出所有出现位置", () => {
    expect(findOccurrences("哈哈哈哈哈", "哈哈")).toEqual([0, 1, 2, 3]);
  });

  it("没有命中返回空数组", () => {
    expect(findOccurrences("中文内容", "不存在")).toEqual([]);
  });

  it("空关键词返回空数组（避免死循环）", () => {
    expect(findOccurrences("任意内容", "")).toEqual([]);
  });

  it("中文多字节按字符计数", () => {
    expect(findOccurrences("第一第三章第一", "第一")).toEqual([0, 5]);
  });
});

describe("新建工作区", () => {
  it("新建后至少有一卷（章不能没有卷）", () => {
    const result = backend.createWorkspace("C:/新书", "新书");
    expect(result.outline.length).toBe(1);
    expect(result.outline[0]?.chapters.length).toBe(0);
    expect(result.workspace.title).toBe("新书");
  });

  it("新建后书名跟随", () => {
    backend.createWorkspace("C:/新书", "我的新小说");
    expect(backend.openWorkspace("C:/新书").workspace.title).toBe("我的新小说");
  });

  it("空书名被拒绝", () => {
    expect(() => backend.createWorkspace("C:/x", "  ")).toThrowError(MockError);
  });

  it("新建后出现在最近列表首位", () => {
    backend.createWorkspace("C:/新书", "新书");
    expect(backend.listRecentWorkspaces()[0]?.root).toBe("C:/新书");
  });
});

describe("最近工作区列表", () => {
  it("包含可用与不可用两种状态（UI 需要都能渲染）", () => {
    const recents = backend.listRecentWorkspaces();
    expect(recents.some((r) => r.available)).toBe(true);
    expect(recents.some((r) => !r.available)).toBe(true);
  });

  it("打开失效的工作区报 WORKSPACE_INVALID", () => {
    const broken = backend.listRecentWorkspaces().find((r) => !r.available);
    if (!broken) throw new Error("没有失效项");
    try {
      backend.openWorkspace(broken.root);
      expect.unreachable("应当报错");
    } catch (err) {
      expect((err as MockError).error.code).toBe("WORKSPACE_INVALID");
    }
  });

  it("返回的是副本，外部改动不会污染内部状态", () => {
    const first = backend.listRecentWorkspaces()[0];
    if (!first) throw new Error("列表为空");
    first.title = "被改掉了";
    expect(backend.listRecentWorkspaces()[0]?.title).not.toBe("被改掉了");
  });
});

describe("恢复报告", () => {
  it("示例工作区是干净的", () => {
    const report = backend.getRecoveryReport();
    expect(report.interruptedOperations).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.sweptTempFiles).toBe(0);
  });
});
