/**
 * 示例数据。
 *
 * ## 为什么示例书要写得像真的
 *
 * 浏览器预览模式下，界面上出现「第一章 测试」这种占位文字，
 * 会让人无法判断布局在真实文案（长标题、卷名带书名号、不同字数）
 * 下是否还会正常换行、截断。所以这里刻意给了一本有卷名、有长短标题、
 * 字数差别很大的书。
 *
 * 示例数据全部是程序生成的确定性内容，不读磁盘、不连网络，
 * 因此 mock 后端在任何环境下行为一致（测试可以断言具体数值）。
 */

import type { Book, ChapterStatus, ChapterSummary, Volume } from "../ipc/types";
import { countByMode } from "./count";

/** 造一个前缀合法的确定性 ID，避免测试依赖随机值。 */
function mockId(prefix: string, index: number): string {
  // 用固定的十六进制尾巴凑够长度，看着像真的 UUID v7 去掉横线
  const tail = index.toString(16).padStart(12, "0");
  return `${prefix}0192f3a4b5c6d7e8f9a0${tail}`;
}

/** 造一个固定的 RFC 3339 时间戳（天数偏移）。 */
function mockTime(dayOffset: number, hour = 9, minute = 0): string {
  const base = Date.UTC(2026, 0, 1, hour - 8, minute, 0);
  const t = new Date(base + dayOffset * 86400_000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:00+08:00`;
}

/** 一个卷的原始定义（章节用标题数组描述，正文由标题生成）。 */
interface SeedVolume {
  title: string;
  chapters: Array<{
    title: string;
    status: ChapterStatus;
    paragraphs: number;
    summary?: string;
  }>;
}

/** 示例书的骨架。 */
export const SEED_VOLUMES: SeedVolume[] = [
  {
    title: "第一卷 落羽",
    chapters: [
      {
        title: "第一章 落羽",
        status: "done",
        paragraphs: 8,
        summary: "主角在雨夜醒来，发现自己失去了三天的记忆。",
      },
      { title: "第二章 山雨", status: "done", paragraphs: 6 },
      {
        title: "第三章 入城",
        status: "revising",
        paragraphs: 11,
        summary: "第一次进入州城，见到城门上的告示。",
      },
    ],
  },
  {
    title: "第二卷 惊蛰",
    chapters: [
      { title: "第四章 惊蛰", status: "done", paragraphs: 9 },
      { title: "第五章 长夜", status: "draft", paragraphs: 4 },
    ],
  },
  {
    title: "第三卷 未命名",
    chapters: [],
  },
];

/** 生成一段可读的中文正文。 */
function seedBody(paragraphs: number): string {
  const sentences = [
    "雨下了整整一夜，屋檐下的水声始终没有停过。",
    "他把手伸进衣袋，摸到那枚已经磨得发亮的铜扣。",
    "远处传来更夫的梆子声，三更天了。",
    "灯火在风里晃了一下，又稳住了。",
    "「你还记得回来。」她说这话的时候没有回头。",
    "他想了想，终究什么也没有说。",
    "街上的积水映着天光，像一条浅灰的带子。",
    "这一天和别的日子并没有什么不同。",
    "他忽然很想问一句为什么，可是话到嘴边又咽了回去。",
    "有些事情一旦说出口，就再也收不回来了。",
    "窗纸透进来的光是冷的，说明天还没有全亮。",
    "他数着自己的脚步声，一直数到一百。",
  ];
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i += 1) {
    const a = sentences[(i * 3) % sentences.length] ?? "";
    const b = sentences[(i * 5 + 1) % sentences.length] ?? "";
    out.push(a + b);
  }
  return out.join("\n\n");
}

/** 构造示例工作区的初始数据。 */
export function buildSeedData(): {
  book: Book;
  volumes: Volume[];
  chapters: ChapterSummary[];
  bodies: Map<string, string>;
} {
  const book: Book = {
    id: mockId("bk_", 1),
    title: "羽化录",
    author: "无名",
    description: "一个关于记忆与羽毛的长篇故事。",
    created: mockTime(0),
    updated: mockTime(30),
  };

  const volumes: Volume[] = [];
  const chapters: ChapterSummary[] = [];
  // 正文单独存：列表载荷里绝不能带正文（见 ipc/types.ts 的说明）
  const bodies = new Map<string, string>();
  let chapterIndex = 0;

  SEED_VOLUMES.forEach((seed, volumeIndex) => {
    const volume: Volume = {
      id: mockId("vol_", volumeIndex + 1),
      bookId: book.id,
      title: seed.title,
      sort: volumeIndex,
      created: mockTime(volumeIndex),
    };
    volumes.push(volume);

    seed.chapters.forEach((chapterSeed, sort) => {
      chapterIndex += 1;
      const id = mockId("ch_", chapterIndex);
      const body = seedBody(chapterSeed.paragraphs);
      // 正文进 bodies 表，摘要进 chapters 列表：两者的字段集合刻意不同
      bodies.set(id, body);
      chapters.push({
        id,
        volumeId: volume.id,
        title: chapterSeed.title,
        status: chapterSeed.status,
        sort,
        path: `manuscript/${String(volumeIndex + 1).padStart(3, "0")}-${seed.title}/${String(sort + 1).padStart(3, "0")}-${chapterSeed.title}.md`,
        wordCount: countByMode(body, "withoutPunctuation"),
        wordGoal: 3000,
        summary: chapterSeed.summary ?? "",
        updated: mockTime(volumeIndex * 5 + sort, 21, 30),
      });
    });
  });

  return { book, volumes, chapters, bodies };
}

/** 供测试复用的 ID 生成器。 */
export { mockId, mockTime };
