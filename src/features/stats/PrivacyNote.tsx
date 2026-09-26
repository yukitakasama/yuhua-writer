/**
 * 隐私说明（T8.14）。
 *
 * ## 为什么这段文案要单独成块、常驻可见
 *
 * 「只记字数与时间，不记正文，不联网」是写作软件里最容易被怀疑、
 * 也最容易被开发者遗忘的一条承诺。把它塞进设置页的某个折叠面板，
 * 等于没有承诺。因此它作为统计页的一个**独立分区**常驻，
 * 让任何人第一次打开统计时就能看到。
 *
 * ## 文案与实现的对应关系
 *
 * 每一条都不是宣传语，而是可以在代码里指认的：
 *
 * | 文案 | 实现 |
 * | --- | --- |
 * | 只记字数与时长 | yuhua-stats 的 DayRecord 只有 words / minutes / sessions |
 * | 不记正文、标题与路径 | 章节以 ID（ch_xxx）出现，模型里没有自由文本字段 |
 * | 不联网、不上报 | 全仓没有出站网络调用，统计层连 HTTP 客户端都没引入 |
 * | 数据留在工作区内 | .yuhua/stats/daily-YYYY-MM.json，用户可直接删除 |
 *
 * 这一段由 Rust 侧 model.rs 的 `no_field_can_hold_prose` 测试守住。
 */

import { For, type JSX } from "solid-js";

import { t } from "@/strings";
import { InfoIcon } from "@/icons";

/** 隐私说明分区。 */
export function PrivacyNote(): JSX.Element {
  /** 四条承诺。顺序与上面表格一致，方便逐一核对实现。 */
  const points = [
    t("stats.privacyWordsOnly"),
    t("stats.privacyNoProse"),
    t("stats.privacyOffline"),
    t("stats.privacyLocalOnly"),
  ];

  return (
    <section class="stats-privacy" aria-labelledby="stats-privacy-title">
      <h3 class="stats-privacy__title" id="stats-privacy-title">
        <InfoIcon size={15} />
        <span>{t("stats.privacyTitle")}</span>
      </h3>
      <p class="stats-privacy__body">{t("stats.privacyBody")}</p>
      <ul class="stats-privacy__list">
        <For each={points}>{(point) => <li class="stats-privacy__item">{point}</li>}</For>
      </ul>
      <p class="stats-privacy__path">
        <span>{t("stats.privacyPath")}</span>
        <code>.yuhua/stats/daily-YYYY-MM.json</code>
      </p>
    </section>
  );
}
