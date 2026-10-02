/**
 * 关于分区（T9.8）。
 *
 * ## 展示什么，为什么
 *
 * 1. **版本号与构建通道** —— 用户报 bug 时第一句话往往是「我用的哪个版本」；
 * 2. **字体署名与 OFL 全文** —— OFL 1.1 要求「随附版权声明与许可全文」，
 *    应用内可查看是合规的一部分，不是可有可无的装饰；
 * 3. **本项目自身的 MIT 许可** —— 与字体许可明确分开，
 *    避免用户误以为「项目是 MIT 所以字体也是 MIT」。
 *
 * ## 为什么许可全文放在可折叠的 <details> 里
 *
 * OFL 全文有 100 多行，直接铺开会把版本号与署名挤出屏幕。
 * `<details>` 是原生元素：键盘可达（Enter/Space 展开）、
 * 读屏会正确播报展开 / 折叠状态、与会话内的查找（Ctrl+F）天然协作。
 * 自己用 div + aria-expanded 实现只是把这三件事重做一遍，且更容易漏。
 *
 * ## 零外链
 *
 * 全文通过 Vite 的 `?raw` 导入内联进产物，页面上没有任何网络请求 ——
 * 这与 index.html 里 `default-src 'self'` 的 CSP 一致。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { buildChannel, loadAboutInfo } from "./about-info";
import { IconInfo } from "./icons";

/**
 * 关于分区。
 *
 * @example
 * <AboutPanel />
 */
export function AboutPanel(): JSX.Element {
  // 只读一次：数据全部来自构建期内联的常量，没有重新读取的理由
  const info = createMemo(() => loadAboutInfo());

  return (
    <div class="settings-panel about-panel">
      <header class="about-panel__hero">
        <span class="about-panel__mark" aria-hidden="true">
          <IconInfo size={20} />
        </span>
        <div>
          <h3 class="about-panel__name">{t("app.name")}</h3>
          <p class="about-panel__tagline">{t("app.tagline")}</p>
        </div>
      </header>

      <dl class="about-panel__meta">
        <div class="about-panel__meta-row">
          <dt>{t("settings.aboutPage.version")}</dt>
          <dd class="yh-num">{info().version}</dd>
        </div>
        <div class="about-panel__meta-row">
          <dt>{t("settings.aboutPage.buildChannel")}</dt>
          <dd>{buildChannel(info().version)}</dd>
        </div>
        <div class="about-panel__meta-row">
          <dt>{t("settings.aboutPage.stack")}</dt>
          <dd>{t("settings.aboutPage.stackBody")}</dd>
        </div>
      </dl>

      {/* ---------------- 开源许可 ---------------- */}
      <section class="about-section" aria-labelledby="yh-about-license">
        <h4 class="about-section__title" id="yh-about-license">
          {t("settings.aboutPage.licenseTitle")}
        </h4>

        <ul class="about-license-list">
          <li class="about-license">
            <div class="about-license__head">
              <span class="about-license__asset">
                {t("settings.aboutPage.selfLicense")}
              </span>
              <span class="about-license__badge">{info().selfLicense}</span>
            </div>
          </li>
          <For
            each={info().licenses.filter((entry) => entry.license !== "MIT")}
          >
            {(entry) => (
              <li class="about-license">
                <div class="about-license__head">
                  <span class="about-license__asset">{entry.asset}</span>
                  <span class="about-license__badge">{entry.license}</span>
                </div>
                <p class="about-license__note">{entry.note}</p>
              </li>
            )}
          </For>
        </ul>

        <p class="about-section__note">
          {t("settings.aboutPage.licenseFile")}
          <code>licenses/OFL-1.1.txt</code>
        </p>

        <details class="about-details">
          <summary class="about-details__summary">
            SIL Open Font License 1.1{" "}
            <span class="about-details__hint">（点击展开全文）</span>
          </summary>
          <pre class="about-details__body">{info().oflText}</pre>
        </details>

        <details class="about-details">
          <summary class="about-details__summary">
            许可清单 <span class="about-details__hint">licenses/README.md</span>
          </summary>
          <pre class="about-details__body">{info().licenseReadme}</pre>
        </details>
      </section>

      {/* ---------------- 字体署名 ---------------- */}
      <section class="about-section" aria-labelledby="yh-about-fonts">
        <h4 class="about-section__title" id="yh-about-fonts">
          {t("settings.aboutPage.fontLicenseTitle")}
        </h4>
        <p class="about-section__note">
          {t("settings.aboutPage.fontLicenseIntro")}
        </p>

        <ul class="about-fonts">
          <For each={info().fonts}>
            {(font) => (
              <li class="about-font">
                <div class="about-font__head">
                  <span class="about-font__family">{font.family}</span>
                  <span class="about-license__badge">{font.license}</span>
                </div>
                <p class="about-font__source">
                  基于 {font.source}
                  <Show when={font.weights.length > 0}>
                    <span class="about-font__weights">
                      {" "}
                      · 字重 {font.weights.join(" / ")}
                    </span>
                  </Show>
                </p>
              </li>
            )}
          </For>
        </ul>
      </section>

      {/* ---------------- 致谢 ---------------- */}
      <section class="about-section" aria-labelledby="yh-about-thanks">
        <h4 class="about-section__title" id="yh-about-thanks">
          {t("settings.aboutPage.acknowledgements")}
        </h4>
        <p class="about-section__note">
          {t("settings.aboutPage.acknowledgementsBody")}
        </p>
      </section>

      <p class="about-panel__offline">{t("settings.aboutPage.offlineNote")}</p>
    </div>
  );
}
