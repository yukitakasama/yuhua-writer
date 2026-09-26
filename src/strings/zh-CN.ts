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
    stats: "写作统计",
    commands: "命令面板",
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
    /** 本章目标环（T5.5）。 */
    chapterGoal: "本章目标",
    /** 今日目标环（T5.5）。 */
    todayGoal: "今日目标",
    /** 没有设置目标时环的说明。 */
    goalUnset: "未设目标",
    /** 目标达成率，例如「已完成 42%」。 */
    goalRatio: "已完成 {percent}",
    /** 目标已达成。 */
    goalReached: "已达成",
    /** 目标完成度的无障碍描述。 */
    goalA11y: "{label}：已写 {done} 字，目标 {goal} 字，已完成 {percent}",
    /** 进度环 SVG 的无障碍标签。 */
    ringLabel: "{label} 进度环",
    /** 今日字数的口径说明。 */
    todayHint: "今日字数来自本地写作统计，只记字数与时间",
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

  /** 检索与大纲（M6）。 */
  search: {
    placeholder: "搜索正文、标题",
    title: "搜索",
    empty: "输入关键词开始检索",
    noResult: "没有找到匹配的内容",
    resultCount: "找到 {count} 条结果",
    hint: "支持中文二字组检索，无需分词",
    /** 两个标签页。 */
    tabSearch: "检索",
    tabOutline: "大纲",
    /** 检索框的无障碍标签。 */
    inputLabel: "检索关键词",
    /** 只搜标题开关。 */
    titleOnly: "只搜标题",
    /** 检索结果列表的无障碍标签。 */
    resultList: "检索结果",
    /** 结果条的章节路径。 */
    hitPath: "路径",
    /** 命中片段的分隔说明。 */
    snippetLabel: "匹配片段",
    /** 关键词被识别出的 token 提示。 */
    tokens: "已拆分：{tokens}",
    /** 输入过程中的提示。 */
    searching: "正在检索",
    /** 跳转后的提示。 */
    jumped: "已跳到「{title}」，匹配位置已高亮",
    /** 大纲视图。 */
    outline: "大纲",
    outlineEmpty: "还没有可展示的大纲",
    outlineVolumeMeta: "{chapters} 章 · {words} 字",
    outlineChapterMeta: "{words} 字",
    outlineExpand: "展开本卷",
    outlineCollapse: "收起本卷",
    /** 键盘操作提示。 */
    keyboardHint: "↑↓ 移动，回车跳转，Esc 关闭",
  },

  /** 命令面板（T5.7）。 */
  command: {
    title: "命令面板",
    placeholder: "输入命令名称",
    empty: "没有匹配的命令",
    /** 列表的无障碍标签。 */
    listLabel: "可用命令",
    /** 快捷键提示。 */
    hint: "↑↓ 选择，回车执行，Esc 关闭",
    /** 分组名。 */
    groupNavigate: "导航",
    groupWrite: "写作",
    groupView: "视图",
    /** 命令名。 */
    openSearch: "全文检索",
    openOutline: "大纲视图",
    openStats: "写作统计",
    openLibrary: "回到书架",
    newChapter: "新建一章",
    newVolume: "新建一卷",
    toggleLeft: "折叠 / 展开左栏",
    toggleRight: "折叠 / 展开右栏",
    closeWorkspace: "关闭当前工作区",
  },

  /** 快捷键面板（T4.9）。 */
  shortcuts: {
    title: "快捷键",
    /** 面板底部的说明。 */
    hint: "快捷键可在设置中自定义。标红的键位有冲突。",
    /** 冲突标注。 */
    conflict: "这个键位被多个动作占用",
  },

  /** 组件预览页 /dev/kit（T1.9）。 */
  kit: {
    title: "组件预览",
    note: "这是开发用的组件与动效预览页，不在正式界面中出现。用于 G1 评审门逐条核对。",
    /** 减少动态效果的状态播报。 */
    reducedMotionOn: "当前系统开启了「减少动态效果」，动效已降级。",
    reducedMotionOff: "当前系统未开启「减少动态效果」，动效正常播放。",
    buttons: "按钮",
    buttonsNote:
      "四种变体 × 三种尺寸 × 禁用 / 载入中 / 图标按钮。并排放在一起才能看出危险态与主态是不是太像了。",
    inputs: "输入",
    containers: "容器与弹层",
    containersNote:
      "对话框、抽屉、浮层、菜单、提示、吐司、标签页、滚动区。逐个打开确认焦点陷阱与 Esc 关闭。",
    motion: "动效",
    motionNote: "计划书 5.5 节要求逐条核对时长与缓动。点「重放」可反复看同一条曲线。",
    charts: "图表基座",
    chartsNote: "五档色阶与进度环。M8 的日历与热力图直接复用这里的色阶。",
    footer: "组件预览页 · 仅在开发环境可达",
  },

  /** 编辑器（M4）。 */
  editorM4: {
    /** 专注模式。 */
    focusOn: "进入专注模式",
    focusOff: "退出专注模式",
    /** 查找与替换。 */
    find: "查找",
    replace: "替换",
    /** 自动保存状态。 */
    autosaved: "已自动保存",
    saving: "正在保存",
    saveFailed: "保存失败，请检查磁盘空间",
  },

  /** 设置（M9）。 */
  settings: {
    title: "设置",
    placeholder: "外观、字号、保存间隔等设置将在后续里程碑中提供。",
    about: "关于羽化写作",
    /** 分区标签。 */
    tabs: {
      appearance: "外观",
      fonts: "字体",
      typography: "排版",
      about: "关于",
    },
    /** 设置面板的整体说明，挂在 tablist 上供读屏朗读。 */
    panelLabel: "设置分区",
    /** 三个作用域的名称与说明。 */
    scope: {
      body: "正文",
      heading: "标题",
      ui: "界面",
      bodyHint: "编辑区正文的字体与行距",
      headingHint: "书名、卷名、章节标题",
      uiHint: "侧栏、工具栏、按钮等界面文字",
    },
    /** 全局级 / 工作区级（T9.4）。 */
    level: {
      label: "生效范围",
      global: "全局",
      workspace: "本书",
      globalHint: "对所有作品生效，换书也保持",
      workspaceHint: "只对当前作品生效，覆盖全局设置",
      /** 未打开工作区时工作区级的禁用原因。 */
      noWorkspace: "打开一本书后可以为它单独设置字体",
      /** 某一项已被本书覆盖的标记。 */
      overridden: "本书已覆盖",
      /** 恢复继承全局。 */
      inherit: "跟随全局",
      resetWorkspace: "清除本书的外观设置",
      resetWorkspaceDone: "本书外观已恢复为跟随全局",
    },
    /** 主题。 */
    theme: {
      label: "主题",
      light: "亮色",
      dark: "暗色",
      system: "跟随系统",
      systemResolvedLight: "跟随系统（当前为亮色）",
      systemResolvedDark: "跟随系统（当前为暗色）",
    },
    /** 字体选择（T9.2）。 */
    font: {
      label: "字体族",
      /** 分组标题。 */
      bundledGroup: "内置字体",
      systemGroup: "系统字体",
      /** 内置字体说明。 */
      bundledNote: "随应用分发，离线可用；生僻字自动回退系统字体",
      /** 预览区标题。 */
      previewTitle: "预览",
      /** 预览用的样例文本 —— 刻意混入生僻字，用来暴露回退链是否生效。 */
      previewBody:
        "江南的雨总是下得很轻，落在屋檐上只听见一层细细的沙沙声。他提笔写下第一行字，墨迹在纸上慢慢洇开。",
      previewHeading: "第一章·落羽",
      previewUi: "字数 12,480 · 今日 1,206 · 连续 23 天",
      /** 生僻字回退说明。 */
      fallbackNote: "预览中的字若显示为系统字体，说明内置字体缺少该字形，这是预期行为。",
      /** 缺字回退链的展示标题。 */
      fallbackChain: "回退链",
      /** 加载失败提示（多半是没跑 fonts:fetch）。 */
      loadFailed: "{name}尚未生成，当前使用回退字体",
    },
    /** 排版（T9.5）。 */
    typography: {
      size: "字号",
      lineHeight: "行距",
      paragraphGap: "段距",
      measure: "正文宽度",
      /** 数值单位后缀。 */
      px: "px",
      em: "em",
      /** 恢复本分区的默认值。 */
      reset: "恢复默认排版",
      resetDone: "排版已恢复默认",
      /** 预览提示。 */
      livePreview: "调整即时生效，无需保存",
    },
    /** 关于页（T9.8）。 */
    aboutPage: {
      version: "版本",
      buildChannel: "构建通道",
      licenseTitle: "开源许可",
      /** 本项目自身许可。 */
      selfLicense: "羽化写作自身代码",
      fontLicenseTitle: "字体署名",
      fontLicenseIntro: "随应用分发的字体各自受 SIL Open Font License 1.1 约束，不因本项目采用 MIT 而改变。",
      /** 许可文件路径说明。 */
      licenseFile: "许可全文随包分发于",
      acknowledgements: "致谢",
      acknowledgementsBody:
        "感谢 Adobe 与 Google 发布思源宋体，感谢 LXGW 发布霞鹜文楷。这些高质量的开源中文字体是本项目能够做到「离线可用 + 排版一致」的前提。",
      /** 技术栈说明。 */
      stack: "技术栈",
      stackBody: "Tauri 2 · Rust · SolidJS · TypeScript",
      /** 无外链说明。 */
      offlineNote: "本页所有信息来自随包的许可文件，不依赖网络。",
    },
    /** 首次启动向导（T9.7）。 */
    wizard: {
      title: "欢迎使用羽化写作",
      /** 三步的标题与说明。 */
      stepTheme: "选择主题",
      stepThemeBody: "随时可以在设置里改。",
      stepFont: "选择字体",
      stepFontBody: "正文、标题、界面可以分别选择，之后也能单独调整。",
      stepDone: "可以开始了",
      stepDoneBody: "新建一个工作区，羽化写作会在你选择的文件夹里生成书稿结构。",
      /** 进度朗读文案。 */
      stepIndicator: "第 {current} 步，共 {total} 步",
      next: "下一步",
      back: "上一步",
      finish: "开始写作",
      /** 跳过：必须是一等公民，不能藏起来。 */
      skip: "跳过引导",
      skipHint: "跳过也可以，所有设置都能在设置面板里找到。",
    },
  },

  /** 写作统计（M8）。 */
  stats: {
    title: "写作统计",
    /** 导航里的分区名。 */
    navOverview: "总览",
    navCalendar: "码字日历",
    navHeatmap: "年热力图",
    navGoal: "目标",
    navBreakdown: "分章分卷",
    navPrivacy: "隐私",
    /** 概览卡片。 */
    cardTotal: "累计码字",
    cardThisMonth: "本月",
    cardThisWeek: "本周",
    cardToday: "今日",
    cardAverage7: "近 7 日平均",
    cardBestDay: "最高单日",
    cardMinutes: "累计时长",
    cardActiveDays: "写作天数",
    cardStreak: "连续天数",
    /** 概览里的次要说明。 */
    unitWords: "字",
    unitDays: "天",
    /** 预计完稿。 */
    estimateLabel: "预计完稿",
    estimateNone: "暂无数据，写几天就能估算",
    estimateDays: "还需约 {days} 天",
    estimateReached: "已达成总目标",
    /** 连续天数（T8.10）。 */
    streakTitle: "连续码字",
    streakBody: "每天写满 {threshold} 字即算一天。今天还没写不算断。",
    streakZero: "今天与昨天都还没写够，连续记录已经断了",
    streakDays: "连续 {days} 天",
    /** 码字日历（T8.7）。 */
    calendarTitle: "码字日历",
    calendarPrev: "上个月",
    calendarNext: "下个月",
    calendarToday: "回到本月",
    calendarMonthTotal: "本月共 {words} 字",
    calendarDayDetail: "单日明细",
    calendarNoRecord: "这一天没有记录",
    calendarDayWords: "新增 {words} 字",
    calendarDayMinutes: "写作 {minutes}",
    calendarDayChapters: "涉及 {count} 章",
    calendarGrid: "{month} 的码字日历",
    /** 热力图（T8.8）。 */
    heatmapTitle: "年热力图",
    heatmapPrev: "上一年",
    heatmapNext: "下一年",
    heatmapTotal: "全年共 {words} 字",
    heatmapActiveDays: "有 {days} 天在写",
    heatmapBestDay: "最高单日 {words} 字",
    heatmapLegend: "色阶",
    heatmapLess: "少",
    heatmapMore: "多",
    heatmapCellA11y: "{date}，{words} 字",
    heatmapGrid: "{year} 年的码字热力图",
    /** 目标设置（T8.11）。 */
    goalTitle: "写作目标",
    goalDaily: "每日目标",
    goalWeekly: "每周目标",
    goalUnit: "字",
    goalPlaceholder: "例如 2000",
    goalSave: "保存目标",
    goalSaved: "目标已保存",
    goalInvalid: "请输入 0 到 1000000 之间的整数",
    goalClear: "清除目标",
    goalDailyHint: "每天的目标字数，热力图的色阶以它为基准",
    goalWeeklyHint: "一周的目标字数，周一起算",
    goalStreakThreshold: "连续天数阈值",
    goalStreakHint: "当天字数达到这个值才算「写了这一天」",
    goalProgressTitle: "今日进度",
    goalProgressWeek: "本周进度",
    /** 分章分卷（T8.12）。 */
    breakdownTitle: "分章分卷",
    breakdownByVolume: "按卷",
    breakdownByChapter: "按章",
    breakdownVolume: "卷",
    breakdownChapter: "章",
    breakdownWords: "字数",
    breakdownShare: "占比",
    breakdownGoal: "目标",
    breakdownEmpty: "还没有章节数据",
    breakdownChart: "字数分布的条形图",
    /** 统计页空状态。 */
    emptyTitle: "还没有可统计的数据",
    emptyBody: "统计只在你写作之后才有意义。开始写第一章，这里就会亮起来。",
    /** 隐私说明（T8.14）。 */
    privacyTitle: "统计与隐私",
    privacyBody:
      "统计文件只记录字数与时间，绝不记录正文、标题或文件路径，也不联网、不上报。数据保存在你自己的工作区里，随时可以删除。",
    privacyWordsOnly: "只记字数与时长",
    privacyNoProse: "不记正文、标题与路径",
    privacyOffline: "不联网、不上报",
    privacyLocalOnly: "数据留在你的工作区内",
    privacyPath: "统计文件位置",
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
