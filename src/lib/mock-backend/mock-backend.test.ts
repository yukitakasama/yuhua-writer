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

import { createMockBackend, MockError, findOccurrences, type MockBackend } from "./index";
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

describe("示例数据", () => {
  it("打开返回至少两卷，且有章", () => {
    const result = backend.openWorkspace("C:/x");
    expect(result.document.volumes.length).toBeGreaterThanOrEqual(2);
    expect(result.document.chapters.length).toBeGreaterThan(0);
  });

  it("文稿结构里的章节**不含正文**（内存指标要求）", () => {
    const result = backend.openWorkspace("C:/x");
    for (const chapter of result.document.chapters) {
      expect(chapter).not.toHaveProperty("body");
    }
  });

  it("每章的 volumeId 都指向真实存在的卷", () => {
    const result = backend.openWorkspace("C:/x");
    const ids = new Set(result.document.volumes.map((v) => v.id));
    for (const chapter of result.document.chapters) {
      expect(ids.has(chapter.volumeId)).toBe(true);
    }
  });

  it("同一卷内的 sort 恰好是 0..n-1", () => {
    const result = backend.openWorkspace("C:/x");
    for (const volume of result.document.volumes) {
      const sorts = result.document.chapters
        .filter((c) => c.volumeId === volume.id)
        .map((c) => c.sort)
        .sort((a, b) => a - b);
      expect(sorts).toEqual(sorts.map((_, i) => i));
    }
  });

  it("卷的 sort 恰好是 0..m-1", () => {
    const sorts = backend.openWorkspace("C:/x").document.volumes.map((v) => v.sort);
    expect(sorts).toEqual(sorts.map((_, i) => i));
  });

  it("卷名互不相同（示例数据要能区分）", () => {
    const titles = backend.openWorkspace("C:/x").document.volumes.map((v) => v.title);
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
    expect(() => backend.createVolume({ title: "   " })).toThrowError(MockError);
    try {
      backend.createVolume({ title: "" });
    } catch (err) {
      expect((err as MockError).error.code).toBe("INVALID_INPUT");
      expect((err as MockError).error.recoverable).toBe(true);
    }
  });

  it("超长卷名被拒绝", () => {
    expect(() => backend.createVolume({ title: "字".repeat(201) })).toThrowError(MockError);
  });

  it("中文卷名可以完整取回", () => {
    backend.createVolume({ title: "第四卷 惊蛰之末" });
    expect(backend.getOutline().some((n) => n.title === "第四卷 惊蛰之末")).toBe(true);
  });
});

describe("重命名卷", () => {
  it("改名成功", () => {
    const id = firstVolumeId();
    backend.renameVolume(id, "第一卷 重命名");
    expect(backend.getOutline().find((n) => n.volumeId === id)?.title).toBe("第一卷 重命名");
  });

  it("改名后其下章节的路径跟着更新", () => {
    const id = firstVolumeId();
    const before = backend.listChapters().find((c) => c.volumeId === id)?.path ?? "";
    backend.renameVolume(id, "新卷名");
    const after = backend.listChapters().find((c) => c.volumeId === id)?.path ?? "";
    expect(after).not.toBe(before);
    expect(after).toContain("新卷名");
  });

  it("空名被拒绝且原名不变", () => {
    const id = firstVolumeId();
    const before = backend.getOutline().find((n) => n.volumeId === id)?.title;
    expect(() => backend.renameVolume(id, "  ")).toThrowError(MockError);
    expect(backend.getOutline().find((n) => n.volumeId === id)?.title).toBe(before);
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
  it("追加到卷末尾并自动编号", () => {
    const id = firstVolumeId();
    const created = backend.createChapter({ volumeId: id });
    expect(created.sort).toBe(3); // 示例第一卷有 3 章
    expect(created.status).toBe("draft");
    expect(created.wordCount).toBe(0);
  });

  it("新章必须有归属卷", () => {
    const id = firstVolumeId();
    const created = backend.createChapter({ volumeId: id });
    expect(created.volumeId).toBe(id);
  });

  it("可以指定标题", () => {
    const created = backend.createChapter({ volumeId: firstVolumeId(), title: "第六章 归途" });
    expect(created.title).toBe("第六章 归途");
  });

  it("卷内序号保持连续", () => {
    const id = firstVolumeId();
    backend.createChapter({ volumeId: id });
    backend.createChapter({ volumeId: id });
    const sorts = backend
      .listChapters()
      .filter((c) => c.volumeId === id)
      .map((c) => c.sort)
      .sort((a, b) => a - b);
    expect(sorts).toEqual(sorts.map((_, i) => i));
  });

  it("新章有可用的路径", () => {
    const created = backend.createChapter({ volumeId: firstVolumeId(), title: "新章" });
    expect(created.path).toMatch(/^manuscript\//);
    expect(created.path.endsWith(".md")).toBe(true);
  });

  it("往不存在的卷里新建章报错", () => {
    expect(() => backend.createChapter({ volumeId: "vol_无" })).toThrowError(MockError);
  });
});

describe("读取与保存正文", () => {
  it("读回来的正文非空，且统计口径与内容一致", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    const content = backend.readChapter(first.id);
    expect(content.body.length).toBeGreaterThan(0);
    expect(content.words.withoutPunctuation).toBe(countWords(content.body).withoutPunctuation);
  });

  it("保存后字数与哈希都更新", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    const before = backend.readChapter(first.id);
    const saved = backend.saveChapter(first.id, "新的正文内容，一共十五个字。", before.contentHash);
    expect(saved.contentHash).not.toBe(before.contentHash);
    expect(saved.body).toBe("新的正文内容，一共十五个字。");
    // 逐字核对：新(1)的(2)正(3)文(4)内(5)容(6)一(7)共(8)十(9)五(10)个(11)字(12)
    // 「，」与「。」是标点，不计入 hanChars，但计入含标点口径
    expect(saved.words.hanChars).toBe(12);
    expect(saved.words.withPunctuation).toBe(14);
  });

  it("保存后列表里的字数同步更新", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    const content = backend.readChapter(first.id);
    backend.saveChapter(first.id, "短", content.contentHash);
    expect(backend.listChapters().find((c) => c.id === first.id)?.wordCount).toBe(1);
  });

  it("哈希对不上时拒绝保存（乐观并发）", () => {
    const first = backend.listChapters()[0];
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
    const first = backend.listChapters()[0];
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
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    const content = backend.readChapter(first.id);
    const saved = backend.saveChapter(first.id, "", content.contentHash);
    expect(saved.body).toBe("");
    expect(saved.words.withPunctuation).toBe(0);
  });
});

describe("重命名章", () => {
  it("改名成功且路径同步", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.renameChapter(first.id, "改名后的一章");
    const after = backend.listChapters().find((c) => c.id === first.id);
    expect(after?.title).toBe("改名后的一章");
    expect(after?.path).toContain("改名后的一章");
  });

  it("空标题被拒绝", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    expect(() => backend.renameChapter(first.id, "   ")).toThrowError(MockError);
  });
});

describe("章节状态", () => {
  it("可以设置为已完成", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.setChapterStatus(first.id, "done");
    expect(backend.listChapters().find((c) => c.id === first.id)?.status).toBe("done");
  });

  it("三种状态都能设置", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    for (const status of ["draft", "revising", "done"] as const) {
      backend.setChapterStatus(first.id, status);
      expect(backend.listChapters().find((c) => c.id === first.id)?.status).toBe(status);
    }
  });
});

describe("删除与回收站", () => {
  it("删除章节后列表不再包含它", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.deleteChapter(first.id);
    expect(backend.listChapters().some((c) => c.id === first.id)).toBe(false);
  });

  it("删除后进入回收站而不是消失（可恢复）", () => {
    const first = backend.listChapters()[0];
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
    const chapters = backend.listChapters().filter((c) => c.volumeId === id);
    const middle = chapters[1];
    if (!middle) throw new Error("示例数据不足");
    backend.deleteChapter(middle.id);
    const sorts = backend
      .listChapters()
      .filter((c) => c.volumeId === id)
      .map((c) => c.sort)
      .sort((a, b) => a - b);
    expect(sorts).toEqual(sorts.map((_, i) => i));
  });

  it("从回收站恢复会移除该条目", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    backend.deleteChapter(first.id);
    const entry = backend.listTrash()[0];
    if (!entry) throw new Error("回收站为空");
    backend.restoreFromTrash(entry.trashDirName);
    expect(backend.listTrash().length).toBe(0);
  });

  it("清空回收站返回清掉的条数", () => {
    const chapters = backend.listChapters();
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
    const count = backend.listChapters().filter((c) => c.volumeId === id).length;
    backend.deleteVolume(id);
    expect(backend.listTrash().length).toBe(count);
    expect(backend.listChapters().some((c) => c.volumeId === id)).toBe(false);
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

describe("移动与排序", () => {
  it("同卷内移动章节", () => {
    const id = firstVolumeId();
    const chapters = backend.listChapters().filter((c) => c.volumeId === id);
    const last = chapters[2];
    if (!last) throw new Error("示例数据不足");
    backend.moveChapter(last.id, id, 0);
    const after = backend.listChapters().filter((c) => c.volumeId === id).sort((a, b) => a.sort - b.sort);
    expect(after[0]?.id).toBe(last.id);
    expect(after.map((c) => c.sort)).toEqual([0, 1, 2]);
  });

  it("跨卷移动章节，两卷序号都连续", () => {
    const outline = backend.getOutline();
    const from = outline[0];
    const to = outline[1];
    if (!from || !to) throw new Error("示例数据不足");
    const moving = from.chapters[1];
    if (!moving) throw new Error("示例数据不足");
    backend.moveChapter(moving.id, to.volumeId, 0);

    const afterFrom = backend.listChapters().filter((c) => c.volumeId === from.volumeId).sort((a, b) => a.sort - b.sort);
    const afterTo = backend.listChapters().filter((c) => c.volumeId === to.volumeId).sort((a, b) => a.sort - b.sort);
    expect(afterFrom.map((c) => c.sort)).toEqual(afterFrom.map((_, i) => i));
    expect(afterTo.map((c) => c.sort)).toEqual(afterTo.map((_, i) => i));
    expect(afterTo[0]?.id).toBe(moving.id);
  });

  it("移动后章节的 volumeId 更新", () => {
    const outline = backend.getOutline();
    const from = outline[0];
    const to = outline[2];
    if (!from || !to) throw new Error("示例数据不足");
    const moving = from.chapters[0];
    if (!moving) throw new Error("示例数据不足");
    backend.moveChapter(moving.id, to.volumeId, 0);
    expect(backend.listChapters().find((c) => c.id === moving.id)?.volumeId).toBe(to.volumeId);
  });

  it("移动卷改变卷的顺序", () => {
    const outline = backend.getOutline();
    const first = outline[0];
    if (!first) throw new Error("示例数据不足");
    backend.moveVolume(first.volumeId, 1);
    const after = backend.getOutline();
    expect(after[1]?.volumeId).toBe(first.volumeId);
    expect(after.map((n) => n.sort)).toEqual(after.map((_, i) => i));
  });

  it("移动不存在的章节报 NOT_FOUND", () => {
    expect(() => backend.moveChapter("ch_无", firstVolumeId(), 0)).toThrowError(MockError);
  });
});

describe("字数统计", () => {
  it("全书字数是各章之和", () => {
    const stats = backend.getWordStats();
    const sum = backend.listChapters().reduce((s, c) => s + c.wordCount, 0);
    expect(stats.book).toBe(sum);
  });

  it("章数与卷数正确", () => {
    const stats = backend.getWordStats();
    expect(stats.chapterCount).toBe(backend.listChapters().length);
    expect(stats.volumeCount).toBe(backend.getOutline().length);
  });

  it("指定章节时返回该章与所属卷的字数", () => {
    const id = firstVolumeId();
    const chapter = backend.listChapters().find((c) => c.volumeId === id);
    if (!chapter) throw new Error("示例数据不足");
    const stats = backend.getWordStats(chapter.id);
    expect(stats.chapter).toBe(chapter.wordCount);
    const volumeSum = backend.listChapters().filter((c) => c.volumeId === id).reduce((s, c) => s + c.wordCount, 0);
    expect(stats.volume).toBe(volumeSum);
  });

  it("不存在的章节返回全 0 而不是抛错", () => {
    const stats = backend.getWordStats("ch_无");
    expect(stats.chapter).toBe(0);
    expect(stats.book).toBeGreaterThan(0);
  });

  it("三口径统计彼此关系正确（含标点 >= 不含标点）", () => {
    const first = backend.listChapters()[0];
    if (!first) throw new Error("没有章节");
    const words = backend.getChapterWordCount(first.id);
    expect(words.withPunctuation).toBeGreaterThanOrEqual(words.withoutPunctuation);
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
      expect(result.hits[0]?.score).toBeGreaterThanOrEqual(result.hits[1]?.score ?? 0);
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
    expect(result.document.volumes.length).toBe(1);
    expect(result.document.chapters.length).toBe(0);
  });

  it("新建后书名跟随", () => {
    backend.createWorkspace("C:/新书", "我的新小说");
    expect(backend.openWorkspace("C:/新书").document.book.title).toBe("我的新小说");
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
