# GodTodoList 详细设计文档

## 1. 后端详细设计

### 1.1 server/index.js — 主服务

#### 启动流程

```
main()
  │
  ├── async db.init()
  │     ├── initSqlJs()          ← 加载 WASM
  │     ├── new SQL.Database()   ← 创建/加载数据库
  │     ├── createTables()       ← 建表（IF NOT EXISTS）
  │     ├── seedDefaults()       ← 插入默认标签和设置
  │     ├── migrateFromJSON()    ← 条件迁移旧数据
  │     └── save()               ← 写入文件
  │
  ├── 配置 Express 中间件
  │     ├── express.json()       ← JSON 解析 (50MB 限制)
  │     ├── express.urlencoded() ← 表单解析
  │     ├── express.static()     ← 静态文件服务
  │     └── multer()             ← 文件上传处理
  │
  └── app.listen(PORT, '127.0.0.1')
        └── 自动打开浏览器
```

#### 安全工具函数

```javascript
// 路径安全验证 — 检查路径是否在 root_dir 或任务 folder_path 下
isPathAllowed(inputPath)
  → path.resolve(inputPath)
  → 获取 settings.root_dir
  → 获取所有 tasks.folder_path
  → 检查 inputPath.startsWith(allowedPath + sep) || inputPath === allowedPath

// Shell 转义（备用）
shellEscape(str)
  → "'" + str.replace(/'/g, "'\\''") + "'"

// 异步路由错误包装
asyncHandler(fn)
  → (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// 设置白名单
ALLOWED_SETTINGS = [
  'root_dir', 'auto_create_folder', 'folder_format',
  'ai_active_config', 'ai_configs', 'terminal_path', 'opencode_cmd'
]
```

#### 关键路由实现

**任务创建** `POST /api/tasks`

```
接收 JSON body
  → db.createTask(data)
    → INSERT INTO tasks
    → INSERT INTO task_tags (批量)
    → INSERT INTO task_people (批量)
  → fm.createTaskFolder(taskId, taskTitle)
    → 计算文件夹名 (日期_名称 / 编号_名称)
    → mkdir
  → db.updateTask(id, { folder_path })
  → fm.writeTaskReadme(task, goals, routines, tags)
    → 生成 YAML frontmatter + Markdown 正文
    → 写入 任务目录/README.md
  → 返回 { id }
```

**任务更新** `PUT /api/tasks/:id`

```
接收 JSON body
  → db.updateTask(id, data)
    → 动态构建 SET 子句
    → 如果 status === 'done' 且无 completed_at，自动设置
  → 获取更新后的任务
  → 如果有 folder_path:
    → fm.writeTaskReadme()  ← 同步 README
  → 返回 { success }
```

**任务删除** `DELETE /api/tasks/:id`

```
  → db.deleteTask(id)
    → DELETE FROM subtasks WHERE task_id = ?   ← 级联清理
    → DELETE FROM task_tags WHERE task_id = ?
    → DELETE FROM task_people WHERE task_id = ?
    → DELETE FROM attachments WHERE task_id = ?
    → DELETE FROM time_logs WHERE task_id = ?
    → DELETE FROM opencode_sessions WHERE task_id = ?
    → DELETE FROM tasks WHERE id = ?
  → 不自动删除文件夹（需前端先调 open-folder 让用户手动处理）
  → 返回 { success }
```

**AI 对话** `POST /api/ai/chat`

```
读取 ai_configs[ai_active_config]
  → 检查 base_url 和 model
  → 构建系统上下文 (db.getAIContext())
  → 判断 provider
    ├── 'openai'  → proxyOpenAI()
    │     → POST /v1/chat/completions
    │     → Authorization: Bearer {api_key}
    │     → 直接 pipe SSE 响应
    └── 'anthropic' → proxyAnthropic()
          → POST /v1/messages
          → x-api-key: {api_key}
          → anthropic-version: 2023-06-01
          → 解析 Anthropic SSE 事件
          → 转换为 OpenAI 格式
          → 写入响应流
```

**AI 任务丰富** `POST /api/ai/enrich`

```
接收 { task_id, title }
  → 获取 AI 配置
  → 构建系统提示（要求返回 JSON 格式建议）
  → 调用 AI API（非流式）
  → 解析 AI 响应为 JSON:
    { description, estimated_time, goal_id, tag_ids, subtasks }
  → 返回 JSON 给前端
```

**任务目录文件发现** `GET /api/tasks/:id/files`

```
获取任务的 folder_path
  → isPathAllowed(folder_path) 验证
  → fs.readdir(folder_path)
  → 过滤: 排除隐藏目录 (以 . 开头)、README.md
  → 返回文件列表 [{ name, path, size, modified }]
```

**通用路径打开** `POST /api/open-folder`

```
接收 { path }
  → isPathAllowed(path) 验证
  → 跨平台打开:
    ├── mac → spawn('open', [path])
    ├── win → spawn('explorer', [path])
    └── linux → spawn('xdg-open', [path])
```

**终端启动** `POST /api/launch-terminal`（安全重写）

```
接收 { directory }
  → 获取 terminal_path 设置
  → spawn 启动（不使用 exec 字符串拼接）:
    ├── macOS Terminal → spawn('osascript', ['-e', `tell application "Terminal" to do script "cd ${dir}"`])
    ├── macOS iTerm    → spawn('open', ['-a', 'iTerm', dir])
    ├── Windows        → spawn('cmd', ['/c', 'cd', '/d', dir, '&&', 'start', 'cmd'])
    └── Linux          → spawn(terminal_path, ['--working-directory', dir])
```

**OpenCode 启动** `POST /api/launch-opencode`（安全重写）

```
接收 { directory }
  → 获取 opencode_cmd 设置
  → spawn(opencode_cmd, [], { cwd: directory, detached: true, stdio: 'ignore' })
  → child.unref()
```

**设置更新** `PUT /api/settings`（白名单保护）

```
接收 JSON body (key-value pairs)
  → 过滤: 仅保留 ALLOWED_SETTINGS 中的 key
  → 逐个 db.run('INSERT OR REPLACE INTO settings ...')
  → save()
  → 返回 { success }
```

**批量导入** `POST /api/import/scan` + `POST /api/import/execute`

```
扫描阶段:
  → isPathAllowed(importDir) 验证（限制在 root_dir 内）
  → fm.scanDirectories(rootDir)
    → readdir(rootDir)
    → 对每个子目录:
      ├── 有 README.md → parseReadme() → 提取元数据
      └── 无 README.md → 用目录名作为标题
    → 检查 folder_path 是否已存在于 tasks 表
    → 返回预览列表 (含 already_exists 标记)

导入阶段:
  遍历选中的 items:
    → 按名称匹配 goals、routines、tags
    → db.createTask()
    → db.updateTask(id, { folder_path })
    → fm.writeTaskReadme()
  → 返回导入结果
```

**Skills 扫描** `GET /api/tasks/:id/skills`

```
获取任务的 folder_path
  → 扫描三个目录:
    ├── .opencode/skills/*/SKILL.md
    ├── .claude/skills/*/SKILL.md
    └── .agents/skills/*/SKILL.md
  → 对每个 SKILL.md:
    → 读取内容
    → 解析 YAML frontmatter (name, description)
    → 返回 { name, description, source, path }
```

---

### 1.2 server/database.js — 数据访问层

#### 核心封装

```javascript
queryAll(sql, params)   // 返回 [{...}, ...]
queryOne(sql, params)   // 返回 {...} 或 null
run(sql, params)        // 执行写操作 + save()
save()                   // debounced: setTimeout 100ms → db.export() → 写文件
saveSync()               // 即时: db.export() → 写文件（用于删除等需要立即落地的场景）
```

#### 增量 ALTER TABLE

系统启动时自动检测并添加新列：

```javascript
// goals 表新增列
ALTER TABLE goals ADD COLUMN paths TEXT DEFAULT '[]'
ALTER TABLE goals ADD COLUMN target_date TEXT

// tasks 表新增列
ALTER TABLE tasks ADD COLUMN paths TEXT DEFAULT '[]'
```

通过 try-catch 实现 IF NOT EXISTS 语义（SQLite 不支持 IF NOT EXISTS for ALTER COLUMN）。

#### 任务查询 `enrichTask(task)`

```
1. 查询关联标签 (task_tags + tags)
2. 查询关联人员 (task_people)
3. 查询附件 (attachments)
4. 查询时间日志 (time_logs)
5. 查询子任务 (subtasks)
6. 解析 paths JSON → 数组
7. 返回完整任务对象
```

#### 目标查询 `getGoals()` / `getGoalStats()`

```
getGoals():
  → SELECT * FROM goals
  → 解析 paths JSON → 数组

getGoalStats():
  → 按目标聚合: 任务数、完成数、预估总时间、实际总时间
  → 包含 target_date
  → 包含 total_estimated（SQL SUM 计算）
```

#### 级联删除 `deleteTask(id)`

```
1. DELETE FROM subtasks WHERE task_id = ?
2. DELETE FROM task_tags WHERE task_id = ?
3. DELETE FROM task_people WHERE task_id = ?
4. DELETE FROM attachments WHERE task_id = ?
5. DELETE FROM time_logs WHERE task_id = ?
6. DELETE FROM opencode_sessions WHERE task_id = ?
7. DELETE FROM tasks WHERE id = ?
8. saveSync()
```

#### 附件安全删除 `deleteAttachment(id)`

```
1. 查询附件 record (file_path, task_id)
2. 查询对应任务的 folder_path
3. 验证 file_path 在 folder_path 下
4. fs.unlink(file_path)（仅在验证通过时）
5. DELETE FROM attachments WHERE id = ?
6. save()
```

#### 目标更新 `updateGoal(id, data)`

允许字段白名单：`['name', 'description', 'color', 'sort_order', 'archived', 'paths', 'target_date']`

#### AI 上下文生成 `getAIContext()`

```
1. 查询所有活跃目标 (goals WHERE archived = 0)
2. 查询所有活跃任务 (tasks WHERE status != 'done')
3. 查询今日完成任务 (tasks WHERE status = 'done' AND DATE(completed_at) = today)
4. 查询所有活跃惯例 (routines WHERE archived = 0)
5. 对每个活跃任务，查询关联的标签名
6. 拼接 Markdown 格式的系统提示
7. 返回完整上下文字符串
```

---

### 1.3 server/fileManager.js — 文件管理

#### README 生成 `writeTaskReadme(task, goals, routines, tags)`

```
1. 匹配目标名称 (通过 goal_id)
2. 匹配惯例名称 (通过 routine_id)
3. 匹配标签名称 (通过 tag_ids)
4. 构建 YAML frontmatter:
     task_id, title, status, goal, routine, due_date,
     estimated_time, actual_time, people[], tags[],
     created_at, updated_at
5. 构建 Markdown 正文:
     # 标题
     ## 描述
     ## 背景
6. 保留用户手动添加的笔记 (<!-- notes-start --> 区域)
7. 写入 任务目录/README.md
```

#### README 解析 `parseReadme(filePath)`

```
1. 读取文件内容
2. 正则匹配 YAML frontmatter (--- ... ---)
3. 逐行解析:
   - "  - value" → 数组项
   - "key: value" → 键值对
   - "key: []" → 空数组
   - 空值的 people/tags 字段 → 空数组
   - 空值的其他字段 → 空字符串
4. 解析正文:
   - ## 描述 → description
   - ## 背景 → context
5. 返回结构化数据
```

#### 目录扫描 `scanDirectories(rootDir)`

```
1. readdir(rootDir)
2. 过滤: 仅目录、跳过隐藏目录 (以 . 开头)
3. 对每个子目录:
   ├── 有 README.md → parseReadme()
   └── 无 README.md → 用目录名创建空任务对象
4. 返回任务列表
```

---

## 2. 前端详细设计

### 2.1 页面结构 (index.html)

```
<div id="app">
  ├── <aside class="sidebar">          左侧导航栏
  │     ├── logo                        Logo + 折叠
  │     ├── nav                         7 个视图导航
  │     │                                （看板/目标/今日/惯例/统计/回顾/设置）
  │     ├── goal-list                   目标快捷筛选
  │     └── settings-link              设置入口
  │
  ├── <main class="main-content">      主内容区
  │     ├── kanban-view                 看板视图
  │     │     ├── quick-input-bar       快速输入栏（自然语言解析）
  │     │     │     ├── input           一行输入框
  │     │     │     └── parsed-preview  解析预览标签（日期/标签/人员/优先级/🔥）
  │     │     └── task-columns          任务列
  │     ├── goals-view                  目标视图
  │     │     └── goal-card             目标卡片（含 paths 列表、target_date、进度）
  │     ├── today-view                  今日视图
  │     │     ├── today-budget          时间预算（已分配 vs 8h）
  │     │     ├── today-pending         今日待办（🔥标记 + 今日截止）
  │     │     └── today-completed       今日已完成
  │     ├── routines-view               惯例视图
  │     ├── stats-view                  统计视图
  │     ├── review-view                 回顾视图
  │     │     ├── review-tabs           日报/周报 tab
  │     │     └── ai-report             AI 报告（可编辑 textarea + 复制按钮）
  │     └── settings-view               设置视图
  │
  ├── <aside class="detail-panel">     右侧详情面板 (条件渲染)
  │     ├── 状态按钮组
  │     ├── 标题/目标/惯例/标签
  │     ├── 截止日期/人员
  │     ├── 路径列表（可编辑 + 一键打开）
  │     ├── 时间管理
  │     ├── 描述/背景
  │     ├── 子任务列表
  │     ├── AI 建议卡片（可编辑描述/时间/子任务/标签，选择性应用）
  │     ├── 文件拖拽区 + 附件列表
  │     ├── 目录文件发现（刷新按钮 + 文件列表）
  │     ├── OpenCode 会话
  │     ├── Skills 列表
  │     └── 删除按钮（打开目录后删除）
  │
  ├── 弹窗们
  │     ├── quick-add-modal             新建任务（720px 宽两栏布局）
  │     ├── goal-modal                  新建/编辑目标（含 paths、target_date）
  │     ├── routine-modal               新建/编辑惯例
  │     └── import-modal                批量导入
  │
  └── AI 面板
        ├── ai-fab                      浮动按钮
        └── ai-chat-panel               聊天面板
              ├── 模型切换下拉
              ├── 消息列表
              ├── 快捷提示
              └── 输入框 + 发送按钮
</div>
```

### 2.2 Vue 状态管理 (app.js)

#### 数据加载流程

```
onMounted()
  └── loadAll()
        ├── loadGoals()       GET /api/goals
        ├── loadRoutines()    GET /api/routines
        ├── loadTasks()       GET /api/tasks
        ├── loadTags()        GET /api/tags
        └── loadSettings()    GET /api/settings
                              └── 填充 aiConfigs / activeAIConfig
```

#### 快速创建任务流程

```
用户在 quick-input 输入文本
  → quickInputParsed (computed) 实时解析:
    → @明天 / @2026-06-05  → due_date
    → #标签名               → tag_ids (模糊匹配已有标签)
    → +人名                 → people
    → !1/!2/!3/!4          → priority (映射到 urgency 标签)
    → 🔥                    → is_today = true
    → 剩余文本              → title
  → 显示解析预览标签
  → 用户按 Enter 或点击创建
  → createFromQuickInput()
    → POST /api/tasks (parsed data)
    → 刷新任务列表
    → 可选: fetchAISuggestions(id, title)
```

#### AI 建议丰富流程

```
任务创建后 / 用户点击"AI 丰富"
  → fetchAISuggestions(taskId, title)
    → set aiEnriching = true
    → POST /api/ai/enrich { task_id, title }
    → 返回 { description, estimated_time, goal_id, tag_ids, subtasks }
    → set aiSuggestions = response
    → set aiEnriching = false
  → UI 展示可编辑建议卡片:
    ├── description input
    ├── estimated_time input
    ├── subtasks 可编辑列表（可删除单条）
    ├── tags 可取消勾选
    └── 底部按钮: 「应用选中项」+「全部应用」+「忽略」
  → applyAISuggestions()
    → 读取用户编辑后的值
    → PUT /api/tasks/:id (description, estimated_time, goal_id)
    → PUT /api/tasks/:id/tags (tag_ids)
    → POST /api/tasks/:id/subtasks (逐条创建)
    → 刷新任务
    → clear aiSuggestions
  → dismissAISuggestions()
    → clear aiSuggestions
```

#### AI 报告生成流程

```
用户在回顾页点击"AI 生成报告"
  → generateReport(type)  // 'daily' | 'weekly'
    → set aiGeneratingReport = true
    → POST /api/ai/chat (SSE 流式)
      → system prompt: "根据以下数据生成 Markdown 格式{日/周}报..."
      → context: 本{日/周}完成任务、进行中、逾期任务列表
    → ReadableStream reader.read()
    → 累积 content → aiReportContent
    → 完成后 set aiGeneratingReport = false
  → UI 展示:
    ├── 可编辑 textarea (v-model="aiReportContent")
    └── 复制按钮 → copyReportText() → navigator.clipboard.writeText()
```

#### 今日视图流程

```
todayTasks (computed):
  → 过滤 tasks:
    ├── status != 'done' && (
    │     ├── is_today === true (🔥 标记)
    │     └── due_date === today
    │   )
  → 按 priority 排序
  → 返回: { pending, completed }

todayTimeBudget (computed):
  → sum(todayPending.map(t => t.estimated_time))
  → 返回: { allocated (分钟), total: 480 (8h), percentage }
```

#### 任务操作流程

```
selectTask(id)
  → GET /api/tasks/:id
  → loadSkills()  GET /api/tasks/:id/skills
  → refreshTaskFiles(id)  GET /api/tasks/:id/files  ← 目录文件发现

saveSelectedTask()
  → PUT /api/tasks/:id (自动保存)

toggleTaskTag(tagId)
  → PUT /api/tasks/:id/tags
  → 重新加载任务 (刷新 tags)

handleFileDrop(e)
  → FormData(files)
  → POST /api/tasks/:id/attachments
  → 重新加载任务

refreshTaskFiles(taskId)
  → GET /api/tasks/:id/files
  → set taskFiles = response
  → 展示目录内文件列表

deleteSelectedTask()
  → POST /api/open-folder { path: task.folder_path }  ← 先打开目录
  → DELETE /api/tasks/:id  ← 仅删除数据库记录
  → 不自动删除文件夹
```

#### 复制任务流程

```
copyTask(taskId)
  → 获取源任务数据
  → POST /api/tasks:
    ├── title: 原标题 + "(副本)"
    ├── 复制: description, context, goal_id, estimated_time, due_date
    ├── create_folder: false    ← 不创建新文件夹
    ├── tag_ids: 原 tag_ids
    └── 不复制: subtasks, attachments, folder_path
  → 刷新任务列表
```

#### 更新标签流程（已修复）

```
updateTag(tag)
  → PUT /api/tags/:id { name, color, dimension }  ← 直接更新，保留 task_tags 关联
  → 刷新标签列表

// 旧方案（已废弃）: DELETE + CREATE — 会丢失所有 task_tags 关联
```

#### AI 对话流程

```
sendAIMessage()
  → push user message
  → set aiStreaming = true
  → POST /api/ai/chat (fetch)
  → ReadableStream reader.read()
  → 解析 SSE data: 行
  → 累积 delta.content → aiStreamContent
  → nextTick → scrollAIChat()
  → 完成后 push assistant message
  → set aiStreaming = false
```

#### SSE 解析逻辑

```
chunk.split('\n')
  → 过滤 "data: " 开头的行
  → JSON.parse
  → choices[0].delta.content
  → 拼接到 fullContent
  → 更新 aiStreamContent (响应式)
```

#### 错误处理

```
api(method, url, data)
  → try {
      const res = await fetch(...)
      if (!res.ok) throw new Error(...)
      return await res.json()
    } catch (err) {
      showToast(err.message)
      lastApiError.value = err.message
      return null
    }
```

### 2.3 样式系统 (style.css)

#### CSS 变量

```css
--primary: #7c3aed;          /* 紫色主色 */
--primary-dark: #6d28d9;
--primary-light: #ede9fe;
--bg: #f8f9fb;               /* 背景色 */
--card: #ffffff;              /* 卡片色 */
--text: #1e293b;              /* 主文字 */
--text-sm: 14px;              /* 基础字号 */
--radius: 8px;                /* 圆角 */
```

#### 字体栈

```css
PingFang SC, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif
```

#### 关键新增样式类

| 类名 | 用途 |
|------|------|
| `.ai-suggest-input` | AI 建议卡片输入框 |
| `.ai-subtask-row` | AI 建议子任务行（可删除） |
| `.goal-deadline` | 目标截止日期区 |
| `.goal-date-input` | 目标日期选择器 |
| `.goal-deadline-hint` | 截止日倒计时提示 |
| `.today-content` | 今日视图容器 |
| `.today-section` | 今日视图分区 |
| `.today-budget` | 时间预算展示 |
| `.dir-files-section` | 目录文件发现区 |
| `.dir-file-item` | 目录文件条目 |
| `.report-textarea` | AI 报告编辑区 |
| `.quick-add-modal` | 新建任务弹窗（720px 宽） |
| `.quick-add-body` | 弹窗内容两栏网格布局 |

---

## 3. 跨平台实现

### 3.1 终端启动

| 平台 | 命令 | 实现方式 |
|------|------|----------|
| macOS (Terminal.app) | `spawn('osascript', ['-e', script])` | args 数组，无注入风险 |
| macOS (iTerm 等) | `spawn('open', ['-a', appName, dir])` | args 数组 |
| Windows | `spawn('cmd', ['/c', 'cd', '/d', dir, '&&', 'start', 'cmd'])` | args 数组 |
| Linux | `spawn(terminal, ['--working-directory', dir])` | args 数组 |

### 3.2 文件夹打开

| 平台 | 命令 |
|------|------|
| macOS | `spawn('open', [path])` |
| Windows | `spawn('explorer', [path])` |
| Linux | `spawn('xdg-open', [path])` |

### 3.3 文件路径处理

- 数据库存储绝对路径
- Node.js `path.join()` 自动处理分隔符
- 文件夹命名 `sanitizeName()` 过滤非法字符
- `isPathAllowed()` 使用 `path.resolve()` 统一路径格式后比较

### 3.4 平台默认值

| 设置项 | macOS/Linux | Windows |
|--------|-------------|---------|
| root_dir | ~/Work/Tasks | %USERPROFILE%\Work\Tasks |
| terminal_path | Terminal | — |
| Linux terminal | x-terminal-emulator | — |

---

## 4. 安全设计

### 4.1 路径安全

| 风险 | 措施 | 应用点 |
|------|------|--------|
| 路径遍历攻击 | `isPathAllowed()` 验证路径在 root_dir 或任务 folder_path 下 | `/api/open-folder`, `/api/attachments/open`, `/api/skills/open`, `/api/import/scan`, `GET /api/tasks/:id/files` |
| 任意路径读取 | 限制扫描范围在 root_dir 内 | `/api/import/scan` |
| 附件误删 | `deleteAttachment()` 验证 file_path 在任务 folder_path 下 | 附件删除 |

### 4.2 命令注入防护

| 风险 | 措施 |
|------|------|
| shell 元字符注入 | 使用 `child_process.spawn` + args 数组替代 `exec` + 字符串拼接 |
| 路径注入 | 参数通过 args 数组传递，不经 shell 解析 |

### 4.3 网络安全

| 措施 | 说明 |
|------|------|
| 本地绑定 | `app.listen(PORT, '127.0.0.1')` — 仅本机可访问 |
| 设置白名单 | `ALLOWED_SETTINGS` 数组限制可修改的 key |
| JSON 解析限制 | `express.json({ limit: '50mb' })` |

### 4.4 统一错误处理

| 层级 | 实现 |
|------|------|
| 后端路由 | `asyncHandler(fn)` 包装，catch 返回 500 JSON |
| 前端 API | `api()` 函数全局 catch，toast 提示 + `lastApiError` ref |
| AI 流 | SSE 流错误 → 前端 catch → toast 提示 |

### 4.5 其他安全措施

| 风险 | 措施 |
|------|------|
| 文件上传 | multer 限制 100MB，生成随机文件名前缀 |
| AI API Key | 前端 password 输入框，不缓存到浏览器 localStorage |
| SQL 注入 | 所有查询使用参数化查询（`?` 占位符） |
| XSS | AI 返回内容通过 `renderMarkdown()` 做基础转义 |
