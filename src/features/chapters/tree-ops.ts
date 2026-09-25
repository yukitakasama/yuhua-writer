/**
 * 卷章树的纯函数操作集。
 *
 * ## 为什么要把这些逻辑抽成纯函数
 *
 * 树操作最容易出错的地方是**排序序号的维护**：拖拽落位、跨卷移动、
 * 删除中间一项，都会让 `sort` 出现空洞或重复。一旦序号不连续，
 * 界面上就会出现「拖到第 3 位结果落在第 5 位」这类幽灵 bug。
 *
 * 把这件事从组件里抽出来的好处：
 *
 * 1. **可测试**。不需要渲染任何 DOM 就能验证「移动后序号是否连续」，
 *    测试跑起来是毫秒级，可以在几百个用例里穷举边界。
 * 2. **可复用**。拖拽落位、键盘上下移动、右键菜单移动，
 *    三种交互走同一份逻辑，行为不会分叉。
 * 3. **可推理**。函数签名全是 `(输入) -> 新输出`，不改原数组，
 *    因此组件可以放心地在 Solid 的 store 外先算好再一次性写入。
 *
 * ## 核心设计：三棵独立的数据视图
 *
 * 输入始终是 `Volume[] + ChapterSummary[]` 两个扁平数组（与 IPC 契约一致），
 * 而不是嵌套树。理由：扁平结构在增删改时不需要递归查找，
 * 且与 SQLite 的表结构同构，前端做的变换能直接映射回后端。
 *
 * ## 序号不变量
 *
 * - 同一卷内的章节 `sort` 恰好是 `0..n-1`，无空洞无重复
 * - 卷列表的 `sort` 恰好是 `0..m-1`
 * - 跨卷移动时，**源卷与目标卷都要重新编号**
 */

import type { ChapterSummary, Volume } from "@/lib/ipc";

/**
 * 卷章树的完整快照。
 *
 * 用 `readonly` 数组表达「这些函数不改输入」的契约：
 * 调用方拿到返回值才发现需要替换，不会误以为传进去的数组被就地改了。
 */
export interface TreeSnapshot {
  /** 全部卷。 */
  readonly volumes: readonly Volume[];
  /** 全部章节摘要（扁平，靠 volumeId 归属）。 */
  readonly chapters: readonly ChapterSummary[];
}

/** 一次移动的目标位置。 */
export interface MoveTarget {
  /** 目标卷 ID。 */
  readonly volumeId: string;
  /** 放入目标卷后的序号（0 起，基于**移除被移动项之后**的列表）。 */
  readonly index: number;
}

/** 移动结果：新快照 + 受影响卷的 ID（供 UI 决定哪些行需要播放 FLIP）。 */
export interface MoveResult {
  /** 新快照。 */
  readonly snapshot: TreeSnapshot;
  /** 因序号变化而需要重排的卷 ID。跨卷移动时有两个。 */
  readonly affectedVolumeIds: readonly string[];
  /** 移动是否真的改变了什么。为 false 时 UI 不必做任何动效。 */
  readonly changed: boolean;
}

/** 按 sort 升序排列卷。 */
export function sortVolumes(volumes: readonly Volume[]): Volume[] {
  return volumes.slice().sort((a, b) => a.sort - b.sort);
}

/** 取某一卷下的章节，按 sort 升序。 */
export function chaptersOf(snapshot: TreeSnapshot, volumeId: string): ChapterSummary[] {
  return snapshot.chapters.filter((c) => c.volumeId === volumeId).sort((a, b) => a.sort - b.sort);
}

/**
 * 把一卷内的章节序号重编为 `0..n-1`。
 *
 * 返回新数组而不是就地修改：调用方需要在「算完成功」与「算完失败」
 * 两条路径上都能拿到干净的数据。
 */
export function renumber(chapters: readonly ChapterSummary[], volumeId: string): ChapterSummary[] {
  const list = chaptersOf({ volumes: [], chapters }, volumeId);
  const order = new Map<string, number>();
  list.forEach((c, i) => order.set(c.id, i));
  return chapters.map((c) => {
    const next = order.get(c.id);
    return next === undefined || next === c.sort ? c : { ...c, sort: next };
  });
}

/**
 * 把卷的序号重编为 `0..m-1`，**按数组顺序**。
 *
 * 注意这里**不排序**。看起来 `sortVolumes` 一下更"安全"，但那会让
 * 移动卷失效：拖拽后数组已经是新顺序，而每项还带着旧的 sort，
 * 再按旧 sort 排一次就等于把移动撤销了。
 *
 * 因此这个函数的语义是「数组顺序就是真序，把它写成序号」。
 * 需要先排序的场景（比如从后端拿到的乱序列表）应当显式调用
 * {@link sortVolumes} 再进来。
 */
export function renumberVolumes(volumes: readonly Volume[]): Volume[] {
  return volumes.map((v, i) => (v.sort === i ? v : { ...v, sort: i }));
}

/**
 * 在指定卷的指定位置插入一章。
 *
 * `index` 会被夹紧到合法区间：调用方（拖拽）常常会传出越界值，
 * 比如「拖到列表最下方之外」，这时应当理解为「放到末尾」而不是报错。
 */
export function insertChapter(snapshot: TreeSnapshot, chapter: ChapterSummary, target: MoveTarget): TreeSnapshot {
  const siblings = chaptersOf(snapshot, target.volumeId).filter((c) => c.id !== chapter.id);
  const index = clampIndex(target.index, siblings.length);

  // 先给被插入项一个「半整数锚点」，再统一收敛回整数。
  // 直接写 sort = index 是不够的：后面的兄弟项序号并不会自动让位，
  // 于是 renumber 会按旧的 sort 顺序把它们排回去，插入位置就失效了。
  // 这与 moveChapter 用的是同一套手法，两处行为必须一致。
  const anchor = siblings[index];
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const provisional = provisionalSort(anchor?.sort, previous?.sort);

  const placed: ChapterSummary = { ...chapter, volumeId: target.volumeId, sort: provisional };
  const others = snapshot.chapters.filter((c) => c.id !== chapter.id);
  const next = [...others, placed];
  return {
    volumes: snapshot.volumes,
    chapters: renumber(next, target.volumeId),
  };
}

/**
 * 计算插入用的临时序号。
 *
 * 取值落在目标位置前后两项之间，这样按 sort 排序时新项恰好落在中间。
 * 边界用 `±0.5` 外扩；两者都缺席时（列表为空）用 0。
 */
function provisionalSort(anchor: number | undefined, previous: number | undefined): number {
  if (anchor !== undefined && previous !== undefined) return (anchor + previous) / 2;
  if (anchor !== undefined) return anchor - 0.5;
  if (previous !== undefined) return previous + 0.5;
  return 0;
}

/**
 * 新增一章，追加到指定卷末尾。
 *
 * 与 {@link insertChapter} 分开是因为语义不同：这是「写新的一章」，
 * 序号由当前卷的章数决定，与任何拖拽位置无关。
 */
export function addChapter(snapshot: TreeSnapshot, chapter: ChapterSummary, volumeId: string): TreeSnapshot {
  const sheet: ChapterSummary = { ...chapter, volumeId, sort: chaptersOf(snapshot, volumeId).length };
  return {
    volumes: snapshot.volumes,
    chapters: [...snapshot.chapters, sheet],
  };
}

/**
 * 删除一章。
 *
 * 删除后同卷内其余章节的序号必须前移，否则会出现「第 2 章、第 4 章」
 * 这种断层。这是回收站恢复时最容易出错的地方，因此在这里一次性做对。
 */
export function removeChapter(snapshot: TreeSnapshot, chapterId: string): TreeSnapshot {
  const target = snapshot.chapters.find((c) => c.id === chapterId);
  if (!target) return snapshot;
  const rest = snapshot.chapters.filter((c) => c.id !== chapterId);
  return {
    volumes: snapshot.volumes,
    chapters: renumber(rest, target.volumeId),
  };
}

/**
 * 重命名一章。
 *
 * 名称会 trim；trim 后为空则**拒绝并原样返回**。理由：空白标题会让
 * 树里出现点不中的条目，而静默改名（比如自动叫「未命名」）会让用户
 * 以为自己删掉的内容还在。拒绝并保持原状是最不容易误解的行为，
 * 由调用方负责提示。
 */
export function renameChapter(snapshot: TreeSnapshot, chapterId: string, title: string): TreeSnapshot {
  const trimmed = title.trim();
  if (trimmed.length === 0) return snapshot;
  return {
    volumes: snapshot.volumes,
    chapters: snapshot.chapters.map((c) => (c.id === chapterId && c.title !== trimmed ? { ...c, title: trimmed } : c)),
  };
}

/**
 * 重命名一卷。
 *
 * 与章节同理拒绝空名。注意**卷改名会让其下章节的相对路径失效**，
 * 但路径是由 Rust 侧负责维护的（只有它知道磁盘上的真实目录名），
 * 因此这里只改内存里的标题，落盘后由 {@link reloadDocument} 整体刷新。
 */
export function renameVolume(snapshot: TreeSnapshot, volumeId: string, title: string): TreeSnapshot {
  const trimmed = title.trim();
  if (trimmed.length === 0) return snapshot;
  return {
    ...snapshot,
    volumes: snapshot.volumes.map((v) => (v.id === volumeId && v.title !== trimmed ? { ...v, title: trimmed } : v)),
  };
}

/**
 * 移动一章到目标位置。**拖拽排序的核心。**
 *
 * ## 位置语义
 *
 * `target.index` 是在**移除被拖项之后**的目标卷列表里的插入位置。
 * 这个语义很重要：如果说「插入到第 3 位」但在计算时又把自己算进去，
 * 向下拖动时就会差一位 —— 这类差一位的 bug 在拖拽里极其常见，
 * 因此语义在这里写死并通过测试固定住。
 *
 * ## 返回值里的 `affectedVolumeIds`
 *
 * UI 需要知道哪些卷的行序变了才能播放 FLIP 让位动效。
 * 让这个函数算出来而不是让 UI 再推断一次，避免两边逻辑不一致。
 */
export function moveChapter(snapshot: TreeSnapshot, chapterId: string, target: MoveTarget): MoveResult {
  const moving = snapshot.chapters.find((c) => c.id === chapterId);
  if (!moving) {
    return { snapshot, affectedVolumeIds: [], changed: false };
  }

  const targetSiblings = chaptersOf(snapshot, target.volumeId).filter((c) => c.id !== chapterId);
  const index = clampIndex(target.index, targetSiblings.length);

  // 同卷内位置没变：直接返回，UI 可以据此跳过动效
  const currentSiblings = chaptersOf(snapshot, moving.volumeId);
  const currentIndex = currentSiblings.findIndex((c) => c.id === chapterId);
  if (moving.volumeId === target.volumeId && currentIndex === index) {
    return { snapshot, affectedVolumeIds: [], changed: false };
  }

  // 用「半整数锚点」把新位置钉住，随后统一 renumber 收敛回整数。
  // 直接写整数会在向下拖动时与旧序号冲突，导致排序不稳定。
  const anchor = targetSiblings[index];
  const previous = index > 0 ? targetSiblings[index - 1] : undefined;
  let provisional: number;
  if (anchor !== undefined && previous !== undefined) {
    provisional = (anchor.sort + previous.sort) / 2;
  } else if (anchor !== undefined) {
    provisional = anchor.sort - 0.5;
  } else if (previous !== undefined) {
    provisional = previous.sort + 0.5;
  } else {
    provisional = 0;
  }

  const moved: ChapterSummary = { ...moving, volumeId: target.volumeId, sort: provisional };
  let chapters = snapshot.chapters.map((c) => (c.id === chapterId ? moved : c));

  const affected = new Set<string>();
  affected.add(moving.volumeId);
  affected.add(target.volumeId);

  // 两个卷都要重编号：源卷少了一项，目标卷多了一项
  chapters = renumber(chapters, moving.volumeId);
  if (moving.volumeId !== target.volumeId) {
    chapters = renumber(chapters, target.volumeId);
  }

  return {
    snapshot: { volumes: snapshot.volumes, chapters },
    affectedVolumeIds: [...affected],
    changed: true,
  };
}

/**
 * 移动一卷到新位置。
 *
 * 卷的移动不影响章节归属，因此只改 `volumes`，章节数组原样返回 ——
 * 这样 UI 层面「卷拖拽」只需要重排卷，行数据引用不变，
 * Solid 的 store 不会触发任何章节行的重渲染。
 */
export function moveVolume(snapshot: TreeSnapshot, volumeId: string, toIndex: number): MoveResult {
  const sorted = sortVolumes(snapshot.volumes);
  const from = sorted.findIndex((v) => v.id === volumeId);
  if (from < 0) return { snapshot, affectedVolumeIds: [], changed: false };

  // 摘出被移动项之后再夹紧：否则「移到最后一位」会被误夹成倒数第二位。
  // 例如 3 卷中把第 0 卷移到末位，目标索引 2，但移除后数组只剩 2 项，
  // 合法插入点是 0..2 且 2 就是末尾，因此夹紧上限应当是移除后的长度。
  const rest = sorted.slice();
  const [picked] = rest.splice(from, 1);
  if (!picked) return { snapshot, affectedVolumeIds: [], changed: false };

  const clamped = clampIndex(toIndex, rest.length);
  if (from === clamped) return { snapshot, affectedVolumeIds: [], changed: false };

  const next = rest;
  next.splice(clamped, 0, picked);

  return {
    snapshot: { volumes: renumberVolumes(next), chapters: snapshot.chapters },
    affectedVolumeIds: [volumeId],
    changed: true,
  };
}

/**
 * 删除一卷（连同其下章节）。
 *
 * 若删到一卷不剩，**自动补一个空卷**：领域模型规定了「章不能没有卷」，
 * 卷列表为空的状态在 UI 上没有可用的落点（无法新建章），
 * 因此这个约束在纯函数层就守住，而不是指望每个调用点记得处理。
 */
export function removeVolume(snapshot: TreeSnapshot, volumeId: string): TreeSnapshot {
  const remaining = snapshot.volumes.filter((v) => v.id !== volumeId);
  const chapters = snapshot.chapters.filter((c) => c.volumeId !== volumeId);
  if (remaining.length === 0) {
    const bookId = snapshot.volumes[0]?.bookId ?? "";
    const now = new Date().toISOString();
    return {
      volumes: [
        {
          id: `vol_placeholder_${bookId}`,
          bookId,
          title: "第一卷",
          sort: 0,
          created: now,
        },
      ],
      chapters,
    };
  }
  return { volumes: renumberVolumes(remaining), chapters };
}

/** 生成一个默认卷名，例如「第三卷」。 */
export function defaultVolumeTitle(index: number): string {
  const names = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const label = names[index] ?? String(index + 1);
  return `第${label}卷`;
}

/** 生成一个默认章节名，例如「第 7 章」。 */
export function defaultChapterTitle(index: number): string {
  return `第 ${index + 1} 章`;
}

/**
 * 校验一个名称是否可用作卷名 / 章名。
 *
 * 返回 `null` 表示通过，否则返回错误码（由调用方翻译成文案）。
 * 校验放在纯函数里，这样界面与测试用的是同一套规则。
 */
export function validateTitle(title: string, maxLength = 200): "empty" | "tooLong" | null {
  if (title.trim().length === 0) return "empty";
  if (title.trim().length > maxLength) return "tooLong";
  return null;
}

/**
 * 计算拖拽落位指示线的位置。
 *
 * ## 为什么需要它
 *
 * 拖拽时只有「被拖项跟随指针」是不够的 —— 用户需要知道**会落在哪**。
 * 指示线画在两个行之间的缝隙上，其位置由指针相对每行的**上半/下半**
 * 决定（这是树形拖拽的通行做法：上半意味着插到该行之前）。
 *
 * 返回的 `index` 使用与 {@link moveChapter} 相同的语义
 * （移除被拖项之后的位置），两个函数可以直接串起来用。
 */
export function resolveDropIndex(rows: ReadonlyArray<{ id: string; top: number; height: number }>, pointerY: number, draggedId: string): number {
  let index = 0;
  for (const row of rows) {
    if (row.id === draggedId) continue;
    const middle = row.top + row.height / 2;
    if (pointerY < middle) return index;
    index += 1;
  }
  return index;
}

/** 把序号夹紧到 `0..max`。 */
export function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return max;
  return Math.max(0, Math.min(Math.round(index), max));
}
