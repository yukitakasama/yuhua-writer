import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { t } from "@/strings";

/**
 * 护栏一：界面里不许出现「恒真三元」`cond ? t(k) : t(k)`。
 *
 * 两个分支返回同一个键，于是切换状态时文案不变 —— 面板已经收起了，
 * 按钮还写着「折叠左侧栏」。这比漏一个键更难发现：类型检查过、lint 过、
 * 渲染出来也是个正常按钮，只有把鼠标停在恰好的那个状态下才看得出来。
 * `Toolbar.tsx` 的左右两个折叠按钮都这样静默错了很久，所以把它钉成测试。
 *
 * 只匹配 `t("…")` 形式是刻意的：这是本仓唯一会出现「两个分支字面相同」的
 * 场景（读的是同一份文案字典），扩大到任意表达式会误报。
 *
 * 护栏二：那两个按钮的标签必须真的随 `leftCollapsed` / `rightCollapsed` 变。
 */

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** 把源码压成单行：三元经常被 prettier 折成多行。 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

const DEAD_TERNARY = /\?\s*(t\("[^"]+"\))\s*:\s*\1(?=[\s)};,])/g;

const toolbar = flatten(
  readFileSync(join(SRC_ROOT, "app/Toolbar.tsx"), "utf8"),
);

describe("界面文案不许出现恒真三元", () => {
  it("src 下没有 `cond ? t(k) : t(k)` 的写法", () => {
    const offenders: string[] = [];
    for (const file of listSources(SRC_ROOT)) {
      const text = flatten(readFileSync(file, "utf8"));
      for (const m of text.matchAll(DEAD_TERNARY)) {
        offenders.push(
          `${relative(SRC_ROOT, file).split(sep).join("/")} → ${m[1]}`,
        );
      }
    }
    expect(
      offenders,
      `两个分支返回同一份文案，切换状态时标签不会变：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("工具栏折叠按钮的标签随面板状态改变", () => {
  it("左栏：折叠态与展开态用不同的键", () => {
    expect(toolbar).toContain(
      'layout.leftCollapsed ? t("toolbar.expandLeft") : t("toolbar.collapseLeft")',
    );
  });

  it("右栏：折叠态与展开态用不同的键", () => {
    expect(toolbar).toContain(
      'layout.rightCollapsed ? t("toolbar.expandRight") : t("toolbar.collapseRight")',
    );
  });

  it("四个键都在字典里，且两个方向的文案确实不同", () => {
    // 漏配键时 t() 回退成键名本身，所以先确认键存在，再比较内容
    expect(t("toolbar.collapseLeft")).not.toBe("toolbar.collapseLeft");
    expect(t("toolbar.expandLeft")).not.toBe("toolbar.expandLeft");
    expect(t("toolbar.collapseRight")).not.toBe("toolbar.collapseRight");
    expect(t("toolbar.expandRight")).not.toBe("toolbar.expandRight");
    expect(t("toolbar.collapseLeft")).not.toBe(t("toolbar.expandLeft"));
    expect(t("toolbar.collapseRight")).not.toBe(t("toolbar.expandRight"));
  });
});
