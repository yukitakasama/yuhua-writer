/**
 * 设置模块用到的图标再导出。
 *
 * 为什么不直接在业务组件里 import "@/icons"：设置面板要到
 * 太阳 / 月亮 / 字符 / 对齐 / 信息五枚图标，集中在这里可以让
 * 依赖关系一眼看清，也便于将来替换某一枚的视觉方案时只改一处。
 *
 * 注意这只是**再导出**，不是包装组件：图标依旧是 src/icons/ 下
 * 一图一文件的手写 SVG，规范（24x24 / 线宽 1.5 / currentColor）不变。
 */

export {
  AlignLeftIcon as IconAlignLeft,
  InfoIcon as IconInfo,
  MoonIcon as IconMoon,
  SunIcon as IconSun,
  TypeIcon as IconType,
} from "@/icons";
