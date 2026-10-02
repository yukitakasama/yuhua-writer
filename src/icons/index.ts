/**
 * 图标统一出口。
 *
 * 为什么要有这个 barrel：组件层只依赖 `@/icons`，将来重命名或增删图标
 * 不必逐个文件改 import 路径。
 *
 * 关于 tree-shaking 的取舍（计划书 7.2 要求「一图一文件，便于 tree-shaking」）：
 * barrel 本身是静态 re-export，打包器仍能按需保留；若某天发现打包器把整包都拉进来了，
 * 直接从 `@/icons/feather` 这样按文件导入即可，两种方式并存不冲突。
 */

import type { SvgIconProps } from "./base";

export { iconProps, ICON_VIEW_BOX, ICON_STROKE_WIDTH } from "./base";
export type { SvgIconProps } from "./base";

import { AlignLeftIcon } from "./align-left";
import { ArrowDownIcon } from "./arrow-down";
import { ArrowLeftIcon } from "./arrow-left";
import { ArrowRightIcon } from "./arrow-right";
import { ArrowUpIcon } from "./arrow-up";
import { BoldIcon } from "./bold";
import { BookIcon } from "./book";
import { CalendarIcon } from "./calendar";
import { ChapterIcon } from "./chapter";
import { CharacterIcon } from "./character";
import { CheckIcon } from "./check";
import { ClockIcon } from "./clock";
import { CloseIcon } from "./close";
import { CodeIcon } from "./code";
import { CollapseIcon } from "./collapse";
import { DividerIcon } from "./divider";
import { DragHandleIcon } from "./drag-handle";
import { ExpandIcon } from "./expand";
import { ExportIcon } from "./export";
import { FeatherIcon } from "./feather";
import { FileIcon } from "./file";
import { FlameIcon } from "./flame";
import { FocusIcon } from "./focus";
import { FolderIcon } from "./folder";
import { FormatDocxIcon } from "./format-docx";
import { FormatEpubIcon } from "./format-epub";
import { FormatMdIcon } from "./format-md";
import { FormatPdfIcon } from "./format-pdf";
import { FormatTxtIcon } from "./format-txt";
import { FullscreenIcon } from "./fullscreen";
import { GoalIcon } from "./goal";
import { HeadingIcon } from "./heading";
import { ImageIcon } from "./image";
import { InfoIcon } from "./info";
import { ItalicIcon } from "./italic";
import { LinkIcon } from "./link";
import { ListIcon } from "./list";
import { ListOrderedIcon } from "./list-ordered";
import { MinusIcon } from "./minus";
import { MoonIcon } from "./moon";
import { MoreIcon } from "./more";
import { OutlineIcon } from "./outline";
import { PanelLeftIcon } from "./panel-left";
import { PanelRightIcon } from "./panel-right";
import { PlusIcon } from "./plus";
import { QuoteIcon } from "./quote";
import { RedoIcon } from "./redo";
import { ReplaceIcon } from "./replace";
import { SaveIcon } from "./save";
import { SearchIcon } from "./search";
import { SettingsIcon } from "./settings";
import { StatsIcon } from "./stats";
import { SunIcon } from "./sun";
import { TargetIcon } from "./target";
import { TrashIcon } from "./trash";
import { TypeIcon } from "./type";
import { UndoIcon } from "./undo";
import { VolumeIcon } from "./volume";
import { WordCountIcon } from "./word-count";
import { WorldIcon } from "./world";

/**
 * 全部图标组件。统计页与开发预览页需要遍历渲染时用它，
 * 常规业务代码请按名导入，保持依赖关系清晰。
 */
export const ALL_ICONS = {
  "align-left": AlignLeftIcon,
  "arrow-down": ArrowDownIcon,
  "arrow-left": ArrowLeftIcon,
  "arrow-right": ArrowRightIcon,
  "arrow-up": ArrowUpIcon,
  bold: BoldIcon,
  book: BookIcon,
  calendar: CalendarIcon,
  chapter: ChapterIcon,
  character: CharacterIcon,
  check: CheckIcon,
  clock: ClockIcon,
  close: CloseIcon,
  code: CodeIcon,
  collapse: CollapseIcon,
  divider: DividerIcon,
  "drag-handle": DragHandleIcon,
  expand: ExpandIcon,
  export: ExportIcon,
  feather: FeatherIcon,
  file: FileIcon,
  flame: FlameIcon,
  focus: FocusIcon,
  folder: FolderIcon,
  "format-docx": FormatDocxIcon,
  "format-epub": FormatEpubIcon,
  "format-md": FormatMdIcon,
  "format-pdf": FormatPdfIcon,
  "format-txt": FormatTxtIcon,
  fullscreen: FullscreenIcon,
  goal: GoalIcon,
  heading: HeadingIcon,
  image: ImageIcon,
  info: InfoIcon,
  italic: ItalicIcon,
  link: LinkIcon,
  list: ListIcon,
  "list-ordered": ListOrderedIcon,
  minus: MinusIcon,
  moon: MoonIcon,
  more: MoreIcon,
  outline: OutlineIcon,
  "panel-left": PanelLeftIcon,
  "panel-right": PanelRightIcon,
  plus: PlusIcon,
  quote: QuoteIcon,
  redo: RedoIcon,
  replace: ReplaceIcon,
  save: SaveIcon,
  search: SearchIcon,
  settings: SettingsIcon,
  stats: StatsIcon,
  sun: SunIcon,
  target: TargetIcon,
  trash: TrashIcon,
  type: TypeIcon,
  undo: UndoIcon,
  volume: VolumeIcon,
  "word-count": WordCountIcon,
  world: WorldIcon,
} as const;

/** 图标名称联合类型。 */
export type IconName = keyof typeof ALL_ICONS;

/**
 * 图标数量。开发预览页与测试用它做完整性断言。
 *
 * 这个数必须与 `src/icons/` 下的图标文件数一致（`base.tsx` 是共享的
 * 基础组件，不是图标，不计入）。测试 `icons.test.tsx` 会钉死这一点 ——
 * 加了图标却忘了改这里，测试就会红。
 */
export const ICON_COUNT = 60;

/** 品牌标记（羽毛）的别名，便于调用处语义化。 */
export const BrandIcon = FeatherIcon;

export {
  AlignLeftIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BoldIcon,
  BookIcon,
  CalendarIcon,
  ChapterIcon,
  CharacterIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  CodeIcon,
  CollapseIcon,
  DividerIcon,
  DragHandleIcon,
  ExpandIcon,
  ExportIcon,
  FeatherIcon,
  FileIcon,
  FlameIcon,
  FocusIcon,
  FolderIcon,
  FormatDocxIcon,
  FormatEpubIcon,
  FormatMdIcon,
  FormatPdfIcon,
  FormatTxtIcon,
  FullscreenIcon,
  GoalIcon,
  HeadingIcon,
  ImageIcon,
  InfoIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  MoonIcon,
  MoreIcon,
  OutlineIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  QuoteIcon,
  RedoIcon,
  ReplaceIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  StatsIcon,
  SunIcon,
  TargetIcon,
  TrashIcon,
  TypeIcon,
  UndoIcon,
  VolumeIcon,
  WordCountIcon,
  WorldIcon,
};

export type { SvgIconProps as IconProps };
