/**
 * 卷章树纯函数测试。
 *
 * ## 测试重点
 *
 * 这些用例刻意围绕**最容易出错的不变量**展开，而不是逐行覆盖：
 *
 * 1. 任何操作之后，同卷章节的 `sort` 必须恰好是 `0..n-1`
 * 2. 跨卷移动时源卷与目标卷都要重编号
 * 3. 向下拖动与向上拖动的「差一位」问题
 * 4. 空值、越界索引、空标题这些边界输入不能抛异常
 */

import { describe, expect, it } from "vitest";

import type { ChapterSummary, Volume } from "@/lib/ipc";
import {
  addChapter,
  chaptersOf,
  clampIndex,
  defaultChapterTitle,
  defaultVolumeTitle,
  insertChapter,
  moveChapter,
  moveVolume,
  removeChapter,
  removeVolume,
  renameChapter,
  renameVolume,
  renumber,
  renumberVolumes,
  resolveDropIndex,
  sortVolumes,
  validateTitle,
  type TreeSnapshot,
} from "./tree-ops";

/** 造一个卷。 */
function vol(id: string, sort: number, title = id): Volume {
  return { id, bookId: "bk_1", title, sort, created: "2026-01-01T09:00:00+08:00" };
}

/**
 * 造一章摘要。
 *
 * 注意这里**没有 bookId / body / bodyLoaded 等字段** —— 卷章树操作的
 * 输入就是摘要，测试用的数据必须与真实契约同形，否则测过的东西
 * 到了界面上会因为字段缺失而炸。
 */
function ch(id: string, volumeId: string, sort: number, title = id, wordCount = 100): ChapterSummary {
  return {
    id,
    volumeId,
    title,
    status: "draft",
    sort,
    path: `manuscript/${volumeId}/${id}.md`,
    wordCount,
    wordGoal: 0,
    summary: "",
    updated: "2026-01-01T09:00:00+08:00",
  };
}

/** 一个两卷、五章的样例树。 */
function sample(): TreeSnapshot {
  return {
    volumes: [vol("v1", 0, "第一卷"), vol("v2", 1, "第二卷")],
    chapters: [
      ch("c1", "v1", 0, "第一章", 1000),
      ch("c2", "v1", 1, "第二章", 2000),
      ch("c3", "v1", 2, "第三章", 3000),
      ch("c4", "v2", 0, "第四章", 400),
      ch("c5", "v2", 1, "第五章", 500),
    ],
  };
}

/** 断言某一卷内的章节 id 顺序与 sort 连续性。 */
function expectVolume(snapshot: TreeSnapshot, volumeId: string, expectedIds: string[]): void {
  const list = chaptersOf(snapshot, volumeId);
  expect(list.map((c) => c.id)).toEqual(expectedIds);
  // 关键不变量：序号必须连续，否则拖拽落位会跳
  expect(list.map((c) => c.sort)).toEqual(expectedIds.map((_, i) => i));
}

describe("sortVolumes / renumberVolumes", () => {
  it("按 sort 升序排列卷，不改原数组", () => {
    const input = [vol("b", 2), vol("a", 0), vol("c", 1)];
    const sorted = sortVolumes(input);
    expect(sorted.map((v) => v.id)).toEqual(["a", "c", "b"]);
    // 纯函数：原数组必须没被动过
    expect(input.map((v) => v.id)).toEqual(["b", "a", "c"]);
  });

  it("重编号按数组顺序写入序号，不按旧 sort 重排", () => {
    // 这条契约是拖拽排序能工作的前提：数组已经是新顺序，
    // 若这里再按旧 sort 排一次，移动就会被静默撤销
    const input = [vol("b", 9), vol("a", 5)];
    const out = renumberVolumes(input);
    expect(out.map((v) => v.id)).toEqual(["b", "a"]);
    expect(out.map((v) => v.sort)).toEqual([0, 1]);
  });

  it("序号已正确的卷保持同一对象引用，减少无谓重渲染", () => {
    const input = [vol("a", 0), vol("b", 1)];
    const out = renumberVolumes(input);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
  });

  it("空卷列表重编号返回空数组而不是抛异常", () => {
    expect(renumberVolumes([])).toEqual([]);
  });
});

describe("renumber", () => {
  it("把一卷内乱序的章节收敛为连续序号", () => {
    const broken: ChapterSummary[] = [ch("a", "v1", 7), ch("b", "v1", 3), ch("c", "v2", 0)];
    const out = renumber(broken, "v1");
    // renumber 保持**数组顺序不变**，只改序号；
    // 章节在数组里的相对次序由 sort 表达，因此要按 sort 排序后再断言
    expect(chaptersOf({ volumes: [], chapters: out }, "v1").map((c) => c.id)).toEqual(["b", "a"]);
    expect(chaptersOf({ volumes: [], chapters: out }, "v1").map((c) => c.sort)).toEqual([0, 1]);
    // 别的卷不受影响
    expect(out.find((c) => c.id === "c")?.sort).toBe(0);
  });

  it("空标题章节也能安全参与重编号", () => {
    const out = renumber([ch("a", "v1", 0, "")], "v1");
    expect(out).toHaveLength(1);
  });
});

describe("addChapter", () => {
  it("追加到卷末尾并给出正确序号", () => {
    const next = addChapter(sample(), ch("c6", "", 999), "v1");
    expectVolume(next, "v1", ["c1", "c2", "c3", "c6"]);
  });

  it("新增到空卷时序号为 0", () => {
    const empty: TreeSnapshot = { volumes: [vol("v1", 0)], chapters: [] };
    const next = addChapter(empty, ch("c1", "", 42), "v1");
    expectVolume(next, "v1", ["c1"]);
  });

  it("传入的 volumeId 会被目标卷覆盖，避免挂在错误的卷上", () => {
    const next = addChapter(sample(), ch("c9", "v2", 0), "v1");
    expect(next.chapters.find((c) => c.id === "c9")?.volumeId).toBe("v1");
  });
});

describe("insertChapter", () => {
  it("插入到中间，后续章节序号顺延", () => {
    const next = insertChapter(sample(), ch("cx", "v1", 0), { volumeId: "v1", index: 1 });
    expectVolume(next, "v1", ["c1", "cx", "c2", "c3"]);
  });

  it("越界索引被夹紧到末尾而不是报错", () => {
    const next = insertChapter(sample(), ch("cx", "v1", 0), { volumeId: "v1", index: 99 });
    expectVolume(next, "v1", ["c1", "c2", "c3", "cx"]);
  });

  it("负数索引被夹紧到开头", () => {
    const next = insertChapter(sample(), ch("cx", "v1", 0), { volumeId: "v1", index: -5 });
    expectVolume(next, "v1", ["cx", "c1", "c2", "c3"]);
  });

  it("把已有的章移到本卷别的位置不会产生副本", () => {
    const next = insertChapter(sample(), { ...ch("c1", "v1", 0) }, { volumeId: "v1", index: 2 });
    expect(next.chapters.filter((c) => c.id === "c1")).toHaveLength(1);
    expectVolume(next, "v1", ["c2", "c3", "c1"]);
  });
});

describe("removeChapter", () => {
  it("删除中间一章后其余章节序号前移，不留空洞", () => {
    const next = removeChapter(sample(), "c2");
    expectVolume(next, "v1", ["c1", "c3"]);
  });

  it("删除不存在的章原样返回，不抛异常", () => {
    const before = sample();
    expect(removeChapter(before, "不存在")).toBe(before);
  });

  it("删除后另一卷不受影响", () => {
    const next = removeChapter(sample(), "c1");
    expectVolume(next, "v2", ["c4", "c5"]);
  });
});

describe("renameChapter", () => {
  it("正常改名并 trim 前后空白", () => {
    const next = renameChapter(sample(), "c1", "  第一章 落羽  ");
    expect(next.chapters.find((c) => c.id === "c1")?.title).toBe("第一章 落羽");
  });

  it("空标题被拒绝，原样返回", () => {
    const before = sample();
    expect(renameChapter(before, "c1", "   ")).toBe(before);
  });

  it("标题没变时保持原对象引用，避免无谓重渲染", () => {
    const before = sample();
    const next = renameChapter(before, "c1", "第一章");
    expect(next.chapters.find((c) => c.id === "c1")).toBe(before.chapters[0]);
  });

  it("中文多字节标题可以完整取回", () => {
    const next = renameChapter(sample(), "c2", "第二章 山雨欲来风满楼");
    expect(next.chapters.find((c) => c.id === "c2")?.title).toBe("第二章 山雨欲来风满楼");
  });
});

describe("renameVolume", () => {
  it("正常改名", () => {
    const next = renameVolume(sample(), "v1", "第一卷 落羽");
    expect(next.volumes.find((v) => v.id === "v1")?.title).toBe("第一卷 落羽");
  });

  it("空名被拒绝", () => {
    const before = sample();
    expect(renameVolume(before, "v1", "")).toBe(before);
  });
});

describe("moveChapter 同卷内排序", () => {
  it("向下移动：把第 1 项移到第 3 位", () => {
    // index 语义：移除 c1 之后，目标列表是 [c2, c3]，插到第 2 位
    const result = moveChapter(sample(), "c1", { volumeId: "v1", index: 2 });
    expect(result.changed).toBe(true);
    expectVolume(result.snapshot, "v1", ["c2", "c3", "c1"]);
  });

  it("向上移动：把第 3 项移到第 1 位", () => {
    const result = moveChapter(sample(), "c3", { volumeId: "v1", index: 0 });
    expectVolume(result.snapshot, "v1", ["c3", "c1", "c2"]);
  });

  it("移动到原位置时报告未改变，UI 可以跳过动效", () => {
    const result = moveChapter(sample(), "c2", { volumeId: "v1", index: 1 });
    expect(result.changed).toBe(false);
    expect(result.affectedVolumeIds).toEqual([]);
  });

  it("移到卷末", () => {
    const result = moveChapter(sample(), "c2", { volumeId: "v1", index: 2 });
    expectVolume(result.snapshot, "v1", ["c1", "c3", "c2"]);
  });

  it("连续多次移动后序号依然连续（模拟反复拖拽）", () => {
    let snap = sample();
    snap = moveChapter(snap, "c1", { volumeId: "v1", index: 2 }).snapshot;
    snap = moveChapter(snap, "c3", { volumeId: "v1", index: 0 }).snapshot;
    snap = moveChapter(snap, "c2", { volumeId: "v1", index: 1 }).snapshot;
    expectVolume(snap, "v1", ["c3", "c2", "c1"]);
  });
});

describe("moveChapter 跨卷移动", () => {
  it("把章移到另一卷，两卷都重新编号", () => {
    const result = moveChapter(sample(), "c2", { volumeId: "v2", index: 0 });
    expect(result.changed).toBe(true);
    expectVolume(result.snapshot, "v1", ["c1", "c3"]);
    expectVolume(result.snapshot, "v2", ["c2", "c4", "c5"]);
    // 两个卷都要有让位动效
    // 用展开复制再排序：affectedVolumeIds 是 readonly 数组，
    // 且 noUncheckedIndexedAccess 下直接下标访问会带上 undefined
    expect([...result.affectedVolumeIds].sort()).toEqual(["v1", "v2"]);
  });

  it("移到空卷", () => {
    const withEmpty: TreeSnapshot = { volumes: [vol("v1", 0), vol("v2", 1)], chapters: [ch("c1", "v1", 0)] };
    const result = moveChapter(withEmpty, "c1", { volumeId: "v2", index: 0 });
    expectVolume(result.snapshot, "v2", ["c1"]);
    expectVolume(result.snapshot, "v1", []);
  });

  it("跨卷移动到指定位置", () => {
    const result = moveChapter(sample(), "c1", { volumeId: "v2", index: 1 });
    expectVolume(result.snapshot, "v2", ["c4", "c1", "c5"]);
  });

  it("移到不存在的章原样返回", () => {
    const before = sample();
    const result = moveChapter(before, "幽灵", { volumeId: "v1", index: 0 });
    expect(result.changed).toBe(false);
    expect(result.snapshot).toBe(before);
  });

  it("移到不存在的卷时按只读处理：不会丢失章节", () => {
    // 目标卷不存在 —— 纯函数不校验卷的存在性（那是后端的职责），
    // 但至少必须保证章节总数不变，不能悄悄吞掉数据
    const result = moveChapter(sample(), "c1", { volumeId: "不存在", index: 0 });
    expect(result.snapshot.chapters).toHaveLength(5);
  });
});

describe("moveVolume", () => {
  it("把第一卷移到第二位", () => {
    const result = moveVolume(sample(), "v1", 1);
    expect(result.changed).toBe(true);
    expect(sortVolumes(result.snapshot.volumes).map((v) => v.id)).toEqual(["v2", "v1"]);
    expect(sortVolumes(result.snapshot.volumes).map((v) => v.sort)).toEqual([0, 1]);
  });

  it("章节归属不因卷移动而改变", () => {
    const before = sample();
    const result = moveVolume(before, "v1", 1);
    expect(result.snapshot.chapters).toBe(before.chapters);
    expectVolume(result.snapshot, "v1", ["c1", "c2", "c3"]);
  });

  it("移到原位置报告未改变", () => {
    expect(moveVolume(sample(), "v1", 0).changed).toBe(false);
  });

  it("越界索引被夹紧", () => {
    const result = moveVolume(sample(), "v1", 99);
    expect(sortVolumes(result.snapshot.volumes).map((v) => v.id)).toEqual(["v2", "v1"]);
  });

  it("不存在的卷原样返回", () => {
    const before = sample();
    expect(moveVolume(before, "幽灵", 0).snapshot).toBe(before);
  });
});

describe("removeVolume", () => {
  it("删除一卷时其下章节一并移除", () => {
    const next = removeVolume(sample(), "v1");
    expect(next.volumes.map((v) => v.id)).toEqual(["v2"]);
    expect(next.chapters.map((c) => c.id)).toEqual(["c4", "c5"]);
    expect(next.volumes[0]?.sort).toBe(0);
  });

  it("删到一卷不剩时自动补一个空卷（章不能没有卷）", () => {
    const one: TreeSnapshot = { volumes: [vol("v1", 0)], chapters: [ch("c1", "v1", 0)] };
    const next = removeVolume(one, "v1");
    expect(next.volumes).toHaveLength(1);
    expect(next.chapters).toHaveLength(0);
    expect(next.volumes[0]?.title).toBe("第一卷");
  });

  it("删除不存在的卷时列表保持不变", () => {
    const next = removeVolume(sample(), "幽灵");
    expect(next.volumes.map((v) => v.id)).toEqual(["v1", "v2"]);
  });
});

describe("chaptersOf", () => {
  it("只返回目标卷的章节并按 sort 排序", () => {
    const list = chaptersOf(sample(), "v2");
    expect(list.map((c) => c.id)).toEqual(["c4", "c5"]);
  });

  it("空卷返回空数组", () => {
    expect(chaptersOf({ volumes: [], chapters: [] }, "v1")).toEqual([]);
  });
});

describe("默认名称", () => {
  it("卷名按中文数字递增", () => {
    expect(defaultVolumeTitle(0)).toBe("第一卷");
    expect(defaultVolumeTitle(2)).toBe("第三卷");
  });

  it("超出中文数字表后回退为阿拉伯数字", () => {
    expect(defaultVolumeTitle(12)).toBe("第13卷");
  });

  it("章名从 1 开始编号", () => {
    expect(defaultChapterTitle(0)).toBe("第 1 章");
    expect(defaultChapterTitle(9)).toBe("第 10 章");
  });
});

describe("validateTitle", () => {
  it("空字符串与纯空白都判定为空", () => {
    expect(validateTitle("")).toBe("empty");
    expect(validateTitle("   ")).toBe("empty");
  });

  it("超长标题被拒绝", () => {
    expect(validateTitle("字".repeat(201))).toBe("tooLong");
  });

  it("正常中文标题通过", () => {
    expect(validateTitle("第一章 落羽")).toBeNull();
  });

  it("长度按字符而不是字节计算（中文一字算一个）", () => {
    // 200 个汉字 = 600 字节，按字节判断会误报超长
    expect(validateTitle("字".repeat(200))).toBeNull();
  });
});

describe("clampIndex", () => {
  it("夹紧到 0..max", () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(99, 5)).toBe(5);
    expect(clampIndex(2, 5)).toBe(2);
  });

  it("NaN / Infinity 视为落在末尾", () => {
    expect(clampIndex(Number.NaN, 4)).toBe(4);
    expect(clampIndex(Number.POSITIVE_INFINITY, 4)).toBe(4);
  });
});

describe("resolveDropIndex", () => {
  const rows = [
    { id: "c1", top: 0, height: 28 },
    { id: "c2", top: 28, height: 28 },
    { id: "c3", top: 56, height: 28 },
  ];

  it("指针在上半部时插到该行之前", () => {
    expect(resolveDropIndex(rows, 10, "c9")).toBe(0);
    expect(resolveDropIndex(rows, 30, "c9")).toBe(1);
  });

  it("指针在下半部时插到该行之后", () => {
    expect(resolveDropIndex(rows, 20, "c9")).toBe(1);
    expect(resolveDropIndex(rows, 70, "c9")).toBe(3);
  });

  it("被拖动的行不计入位置，避免自己占位", () => {
    // 拖动 c1 时，指针在 c2 上方 -> 应落在索引 0（c2 变成第 0 项）
    expect(resolveDropIndex(rows, 30, "c1")).toBe(0);
  });

  it("指针在列表下方时落在末尾", () => {
    expect(resolveDropIndex(rows, 999, "c2")).toBe(2);
  });

  it("空列表返回 0", () => {
    expect(resolveDropIndex([], 50, "c1")).toBe(0);
  });
});

describe("不变量：任意操作序列后序号都连续", () => {
  it("混合增删改移之后，每个卷内的 sort 恰好是 0..n-1", () => {
    let snap = sample();
    snap = addChapter(snap, ch("c6", "v1", 0), "v1");
    snap = addChapter(snap, ch("c7", "v2", 0), "v2");
    snap = moveChapter(snap, "c6", { volumeId: "v2", index: 0 }).snapshot;
    snap = removeChapter(snap, "c3");
    snap = moveChapter(snap, "c4", { volumeId: "v1", index: 1 }).snapshot;
    snap = renameChapter(snap, "c4", "改名后的章");
    snap = renameVolume(snap, "v2", "第二卷 惊蛰");

    for (const volume of snap.volumes) {
      const list = chaptersOf(snap, volume.id);
      expect(list.map((c) => c.sort)).toEqual(list.map((_, i) => i));
    }
  });
});
