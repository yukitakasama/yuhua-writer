/**
 * 全部界面文案的唯一来源（T0.13）。
 *
 * ## 为什么要把文案集中在一处
 *
 * 1. **改文案不需要翻组件**。写作软件的文案会被反复打磨（「删除」还是
 *    「移到回收站」），散落在 40 个 tsx 里就一定会漏改。
 * 2. **为 i18n 预留**。本阶段不引入 i18n 框架（计划书明确），但只要
 *    所有字面量都从这里取，将来加一层 locale 切换只是换一个对象。
 * 3. **可测试**。嵌套对象可以被遍历，于是「有没有空文案」「有没有漏配的
 *    键」这类问题能写成测试，而不是等到界面上出现空白按钮才发现。
 *
 * ## 约定
 *
 * - 键名用英文小驼峰，值全部是中文；**不要**在组件里内联中文字面量
 * - 需要插值的地方用 `{name}` 形式，由 {@link ./index.ts} 的 t 访问器替换
 * - 文案里**禁止 emoji**（全仓硬约定），需要图形一律自绘 SVG
 * - 名词性短语不加句号，完整句子加句号，保持一致
 */

/** 文案字典的类型由 zh-CN 推导，其它语言必须实现同样的键。 */
const zhCN = {
  /** 应用标识。 */
  app: {
    name: "羽化写作",
    tagline: "面向长篇小说的本地优先写作软件",
    /** 首屏骨架上的载入提示。 */
    booting: "正在载入羽化写作",
    /** 非 Tauri 环境（浏览器里跑 pnpm dev）的状态栏提示。 */
    browserMode: "浏览器预览模式 · 数据来自内置示例，不会写入磁盘",
  },

  /** 顶部工具栏。 */
  toolbar: {
    newVolume: "新建卷",
    newChapter: "新建章",
    search: "搜索",
    settings: "设置",
    library: "书架",
    toggleLeft: "折叠左侧栏",
    toggleRight: "折叠右侧栏",
    /** 工具栏按钮的 title 后缀，用于无障碍朗读。 */
    moreActions: "更多操作",
  },

  /** 通用按钮与动作。 */
  action: {
    create: "新建",
    rename: "重命名",
    remove: "删除",
    /** 章节删除是移入回收站而不是抹除，按钮文案必须如实反映。 */
    moveToTrash: "移到回收站",
    restore: "恢复",
    cancel: "取消",
    confirm: "确定",
    save: "保存",
    retry: "重试",
    close: "关闭",
    open: "打开",
    collapse: "折叠",
    expand: "展开",
    back: "返回",
    refresh: "刷新",
  },

  /** 书架（T5.2）。 */
  library: {
    title: "书架",
    /** 最近打开区块。 */
    recent: "最近打开",
    recentEmpty: "还没有最近打开的书籍",
    allBooks: "全部书籍",
    newWorkspace: "新建工作区",
    openWorkspace: "打开已有工作区",
    openDirectory: "选择目录",
    workspaceName: "书名",
    workspaceNamePlaceholder: "例如：羽化录",
    workspaceLocation: "存放位置",
    createWorkspace: "创建工作区",
    /** 书籍网格的空状态。 */
    emptyTitle: "书架还是空的",
    emptyBody: "新建一个工作区，羽化写作会在你选择的文件夹里生成书稿结构。文稿始终是纯 Markdown 文件，随时可以用别的编辑器打开。",
    /** 工作区不可用（被移动或删除）时的标示。 */
    unavailable: "位置已失效",
    chapterCount: "{count} 章",
    wordCountLabel: "全书 {count} 字",
    lastOpenedAt: "上次打开 {time}",
    neverOpened: "尚未打开",
  },

  /** 卷章树（T5.3）。 */
  chapters: {
    title: "卷章",
    /** 树的空状态：整本书一个字都还没写。 */
    emptyTitle: "还没有任何章节",
    emptyBody: "先建一卷，再往里面放章。卷是长篇小说的骨架，章是每天要写的那一页。",
    emptyAction: "新建第一卷",
    /** 卷下无章时的占位提示。 */
    volumeEmpty: "本卷还没有章节",
    addChapter: "在此卷新建章",
    addVolume: "新建卷",
    /** 卷的默认名，后面自动接序号。 */
    defaultVolumeName: "第{index}卷",
    defaultChapterName: "第{index}章",
    renameHint: "回车确认，Esc 取消",
    /** 重命名校验失败提示。 */
    renameEmpty: "名称不能为空",
    renameTooLong: "名称不能超过 {max} 个字符",
    /** 拖拽排序的无障碍提示。 */
    dragHandle: "拖动以调整顺序",
    draggingTip: "松开鼠标完成排序",
    /** 树节点上的字数与状态标签。 */
    wordSuffix: "字",
    chapterIndex: "第 {index} 章",
  },

  /** 写作状态名，与 Rust 侧 ChapterStatus::label 保持一致。 */
  status: {
    draft: "草稿",
    done: "已完成",
    revising: "修订中",
    /** 切换状态的控件标题。 */
    changeLabel: "写作状态",
  },

  /** 字数口径。 */
  wordCount: {
    /** 三套口径的切换控件。 */
    modeLabel: "字数口径",
    withPunctuation: "含标点",
    withoutPunctuation: "不含标点",
    wordsForEnglish: "英文按词",
    unit: "字",
    /** 字数面板（T5.5 的占位）。 */
    panelTitle: "字数",
    thisChapter: "本章",
    thisVolume: "本卷",
    thisBook: "全书",
    today: "今日",
    chapterCount: "章节数",
    volumeCount: "卷数",
    averageChapter: "平均每章",
    /** 未选中章节时的占位。 */
    noSelection: "未选中章节",
  },

  /** 右侧元数据面板（T5.4 的占位骨架）。 */
  meta: {
    panelTitle: "章节信息",
    title: "标题",
    volume: "所属卷",
    status: "状态",
    wordGoal: "目标字数",
    wordGoalPlaceholder: "不设置",
    summary: "摘要",
    summaryPlaceholder: "用一句话说明本章会发生什么",
    notes: "便签",
    notesPlaceholder: "给自己留的备注，不会被导出",
    created: "创建于",
    updated: "修改于",
    path: "文件路径",
    noSelection: "在左侧选择一章查看信息",
  },

  /** 搜索入口（T5.7 的占位）。 */
  search: {
    placeholder: "搜索正文、标题",
    title: "搜索",
    empty: "输入关键词开始检索",
    noResult: "没有找到匹配的内容",
    resultCount: "找到 {count} 条结果",
    hint: "支持中文二字组检索，无需分词",
  },

  /** 设置入口（M9 的占位）。 */
  settings: {
    title: "设置",
    placeholder: "外观、字号、保存间隔等设置将在后续里程碑中提供。",
    about: "关于羽化写作",
  },

  /** 错误提示。 */
  error: {
    /** 统一的错误标题。 */
    title: "出了点问题",
    generic: "操作失败，请重试",
    /** 未打开工作区（对应 Rust 侧 NO_WORKSPACE）。 */
    noWorkspace: "尚未打开工作区，请先新建或打开一个。",
    /** 未找到实体（NOT_FOUND）。 */
    notFound: "目标已不存在，可能已被删除或移动。",
    /** 工作区无效（WORKSPACE_INVALID）。 */
    workspaceInvalid: "这个目录不是有效的工作区。",
    /** IO 错误。 */
    io: "文件操作失败，请检查目录权限或磁盘空间。",
    /** 解析错误。 */
    parse: "文件内容无法解析，可能在外部被改坏了。",
    /** 索引库错误。 */
    database: "索引库出错，可以从 Markdown 重新建立索引。",
    /** 尚未实现的功能。 */
    unimplemented: "这个功能还没有实现。",
    /** 不可恢复错误。 */
    unrecoverable: "这个错误无法自动恢复。",
    /** 重命名冲突。 */
    duplicateName: "已经有一个同名的了",
    /** 载入失败。 */
    loadFailed: "载入失败",
  },

  /** 加载与保存状态。 */
  saveState: {
    idle: "已保存",
    saving: "保存中",
    dirty: "有未保存的改动",
    failed: "保存失败",
  },

  /** 编辑器占位（M4 实现，本阶段只放占位）。 */
  editor: {
    placeholderTitle: "编辑区",
    placeholderBody: "编辑器内核将在 M4 里程碑接入。当前可以先用左侧的卷章树整理结构。",
    noChapter: "从左侧选择一章开始写作",
    /** 未打开的章节。 */
    selectHint: "也可以直接新建一章",
  },

  /** 无障碍朗读用的隐藏文案。 */
  a11y: {
    mainRegion: "主工作区",
    leftPanel: "卷章导航",
    rightPanel: "章节信息",
    treeRole: "卷章树",
    resizer: "拖动调整面板宽度",
    dragged: "正在拖动 {name}",
    dropped: "已把 {name} 移到第 {position} 位",
  },

  /** 时间显示。 */
  time: {
    justNow: "刚刚",
    minutesAgo: "{count} 分钟前",
    hoursAgo: "{count} 小时前",
    daysAgo: "{count} 天前",
    never: "从未",
  },

  /** 单位与数量。 */
  unit: {
    count: "{count}",
    /** 章节序号前缀。 */
    chapterNo: "第 {index} 章",
    volumeNo: "第 {index} 卷",
  },
} as const;

export default zhCN;

/** 文案字典的形状。其它语言包必须与之结构一致。 */
export type StringDict = typeof zhCN;
