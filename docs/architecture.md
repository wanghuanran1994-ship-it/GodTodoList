# GodTodoList 概要设计文档

## 1. 系统架构

### 1.1 总体架构

采用经典的三层 B/S 架构，前后端分离：

```
┌─────────────────────────────────────────────────────────────┐
│                    浏览器 (Client)                            │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Vue 3 SPA (CDN)                            ││
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐││
│  │  │看板  │ │目标  │ │今日  │ │惯例  │ │统计  │ │回顾  │││
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘││
│  └─────────────────────────────────────────────────────────┘│
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP / SSE
┌──────────────────────▼──────────────────────────────────────┐
│          Express Server (127.0.0.1:3000)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐ │
│  │ REST API │ │ 文件上传  │ │ AI 代理  │ │ 安全中间件      │ │
│  │          │ │          │ │ (SSE)    │ │ isPathAllowed  │ │
│  │          │ │          │ │          │ │ asyncHandler   │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────────────┘ │
└───────┼────────────┼────────────┼───────────────────────────┘
        │            │            │
┌───────▼────────────▼────────────▼───────────────────────────┐
│                  数据层 (Local)                               │
│  ┌──────────────┐  ┌────────────────────────────────────────┐│
│  │ SQLite DB    │  │ 文件系统                               ││
│  │ (sql.js)     │  │ ┌────────────────────────────────────┐ ││
│  │              │  │ │ 任务文件夹                          │ ││
│  │ data/        │  │ │ ├── 20260601_任务A/                │ ││
│  │ godtodo.db   │  │ │ │   ├── README.md                 │ ││
│  │              │  │ │ │   └── 附件/生成的文件...         │ ││
│  └──────────────┘  │ └────────────────────────────────────┘ ││
│                    └────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### 1.2 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| Web 框架 | Express | 轻量、生态成熟、适合单用户工具 |
| 前端框架 | Vue 3 (CDN) | 无需构建工具，开发快，响应式 |
| 数据库 | sql.js (SQLite WASM) | 零编译、单文件、跨平台、SQL 查询能力 |
| 文件上传 | Multer | Express 标准文件上传中间件 |
| AI 通信 | HTTP + SSE | 流式响应，兼容 OpenAI/Anthropic 协议 |
| 进程管理 | child_process.spawn | args 数组传参，避免命令注入 |

### 1.3 数据流

```
用户操作 → Vue 组件 → fetch API → asyncHandler → Express 路由
                                                → database.js (SQLite)
                                                → fileManager.js (文件系统)
                                                → AI 代理 (外部模型)
              ← JSON / SSE / Error ←
```

---

## 2. 模块划分

### 2.1 后端模块

```
server/
├── index.js          # 主入口，路由定义，AI 代理，安全中间件
├── database.js       # 数据访问层，SQL 封装，debounced save
└── fileManager.js    # 文件操作，README 读写，目录扫描
```

#### index.js 职责
- Express 应用初始化与中间件配置
- 安全工具函数：`isPathAllowed()`、`shellEscape()`、`asyncHandler()`、`ALLOWED_SETTINGS`
- RESTful API 路由定义（Settings/Goals/Routines/Tasks/Tags/People/Attachments/TimeLogs/Subtasks/Stats/Import/Skills/Files）
- AI 代理：OpenAI 协议 / Anthropic 协议双向支持，SSE 流式转发
- AI 丰富建议：`POST /api/ai/enrich` 返回结构化建议
- 任务目录文件发现：`GET /api/tasks/:id/files`
- 通用路径打开：`POST /api/open-folder`
- 终端/OpenCode 启动（spawn + args 数组）
- 服务器绑定 `127.0.0.1`
- SPA 回退路由

#### database.js 职责
- SQLite 数据库初始化、建表、增量 ALTER TABLE
- 数据库自动迁移（JSON → SQLite）
- 默认数据种子
- 所有 CRUD 操作的 SQL 封装
- Debounced `save()`（100ms）+ `saveSync()` 即时保存
- 级联删除（deleteTask 清理 subtasks + 关联数据）
- 附件删除路径验证
- AI 上下文生成

#### fileManager.js 职责
- 任务文件夹创建（日期命名/编号命名）
- 附件保存与去重
- README.md 生成与解析（YAML frontmatter + Markdown）
- 目录扫描（批量导入）
- 文件/文件夹打开（跨平台）
- OpenCode Skills 扫描

### 2.2 前端模块

```
public/
├── index.html        # SPA 页面结构（侧边栏 + 主内容 + 详情面板 + 弹窗 + AI 面板）
├── css/style.css     # 全局样式（白色主题 + 紫色高亮 + 大字体 + 中文优化）
└── js/app.js         # Vue 3 Composition API 单文件应用
```

#### 页面结构
- **侧边栏**：导航（看板/目标/今日/惯例/统计/回顾）+ 目标快捷筛选 + 设置入口
- **主内容区**：七个视图（看板/目标/今日/惯例/统计/回顾/设置）
- **详情面板**：右侧滑出，任务全字段编辑 + AI 建议卡片 + 目录文件列表
- **快速输入栏**：看板顶部一行输入，自然语言解析预览
- **弹窗**：新建任务（720px 宽两栏布局）/ 新建目标 / 新建惯例 / 批量导入
- **AI 面板**：固定定位浮动面板，可切换模型

#### Vue 状态管理
使用 Vue 3 Composition API 的 `ref`/`reactive`/`computed`，无 Vuex/Pinia：

- **数据状态**：goals, routines, tasks, tags, settings
- **UI 状态**：currentView, selectedTask, showQuickAdd, showAIChat 等
- **AI 状态**：aiMessages, aiStreaming, aiStreamContent, aiConfigs, activeAIConfig
- **AI 建议状态**：aiSuggestions (description/estimated_time/subtasks/tags), aiEnriching
- **快速输入状态**：quickInputText, quickInputParsed (computed)
- **今日视图状态**：todayTasks (computed), todayTimeBudget (computed)
- **报告状态**：aiReportContent, aiGeneratingReport
- **文件发现状态**：taskFiles
- **错误状态**：lastApiError
- **导入状态**：importItems, importDir, importScanning 等

---

## 3. API 设计

### 3.1 RESTful API 列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/settings | 获取所有设置 |
| PUT | /api/settings | 批量更新设置（白名单校验） |
| GET | /api/goals | 获取目标列表（含统计、paths、target_date） |
| POST | /api/goals | 创建目标 |
| PUT | /api/goals/:id | 更新目标（含 paths、target_date） |
| DELETE | /api/goals/:id | 归档目标 |
| GET | /api/routines | 获取惯例列表 |
| POST | /api/routines | 创建惯例 |
| PUT | /api/routines/:id | 更新惯例 |
| DELETE | /api/routines/:id | 归档惯例 |
| GET | /api/tasks | 获取任务列表（支持筛选） |
| GET | /api/tasks/:id | 获取任务详情（含标签/人员/附件/时间日志/子任务） |
| POST | /api/tasks | 创建任务 |
| PUT | /api/tasks/:id | 更新任务 |
| DELETE | /api/tasks/:id | 删除任务（级联删除 subtasks） |
| GET | /api/tasks/:id/files | 扫描任务目录文件（排除隐藏目录和 README） |
| GET | /api/tags | 获取标签列表 |
| POST | /api/tags | 创建标签 |
| PUT | /api/tags/:id | 更新标签（保留 task_tags 关联） |
| DELETE | /api/tags/:id | 删除标签 |
| PUT | /api/tasks/:id/tags | 设置任务标签 |
| GET | /api/people | 获取所有相关人员 |
| PUT | /api/tasks/:id/people | 设置任务人员 |
| POST | /api/tasks/:id/attachments | 上传附件 |
| DELETE | /api/attachments/:id | 删除附件（验证路径安全） |
| POST | /api/tasks/:id/open-folder | 打开任务文件夹 |
| POST | /api/attachments/open | 打开附件文件 |
| POST | /api/open-folder | 通用路径打开接口（isPathAllowed 验证） |
| POST | /api/tasks/:id/time-logs | 添加时间日志 |
| GET | /api/stats/goals | 目标统计数据（含 total_estimated） |
| GET | /api/stats/time | 时间统计数据 |
| GET | /api/stats/review | 回顾数据 |
| GET | /api/tasks/:id/opencode-sessions | 获取 OpenCode 会话 |
| POST | /api/tasks/:id/opencode-sessions | 创建 OpenCode 会话 |
| GET | /api/tasks/:id/skills | 扫描任务 Skills |
| POST | /api/skills/open | 打开 SKILL.md |
| POST | /api/launch-terminal | 启动终端（spawn + args 数组） |
| POST | /api/launch-opencode | 启动 OpenCode（spawn + args 数组） |
| POST | /api/ai/chat | AI 对话代理（SSE 流式） |
| POST | /api/ai/enrich | AI 任务丰富建议（返回 JSON） |
| POST | /api/import/scan | 扫描目录（导入预览，限制在 root_dir 内） |
| POST | /api/import/execute | 执行批量导入 |

---

## 4. AI 代理架构

```
┌──────────┐   POST /api/ai/chat   ┌──────────────┐
│  浏览器   │ ───────────────────→ │ Express 路由  │
│          │ ←───────────────────  │              │
│  SSE 解析 │   SSE data: ...      │  ai_configs   │
└──────────┘                       │  读取当前配置  │
                                   └──────┬───────┘
                                          │
                          ┌───────────────┼───────────────┐
                          │               │               │
                    ┌─────▼─────┐   ┌─────▼─────┐   ┌────▼────┐
                    │ OpenAI    │   │ Anthropic │   │ 未来    │
                    │ 协议代理   │   │ 协议代理   │   │ 其他    │
                    └─────┬─────┘   └─────┬─────┘   └─────────┘
                          │               │
              ┌───────────┼───┐   ┌───────┼────────┐
              │           │   │   │                │
         ┌────▼──┐  ┌────▼──┐│  ┌▼─────┐   ┌─────▼────┐
         │DeepSeek│ │GLM   ││  │智谱   │   │Anthropic │
         │       │ │(OpenAI)│  │(Claude)│  │ 官方     │
         └───────┘ └───────┘   └───────┘   └──────────┘
```

### AI 功能矩阵

| 功能 | 端点 | 模式 | 说明 |
|------|------|------|------|
| AI 军师对话 | POST /api/ai/chat | SSE 流式 | 上下文感知，支持多模型 |
| AI 任务丰富 | POST /api/ai/enrich | JSON 返回 | 返回描述/时间/标签/子任务建议 |
| AI 报告生成 | POST /api/ai/chat | SSE 流式 | 日报/周报，传入任务统计数据 |

### 协议适配

- **OpenAI 协议**：直接转发 SSE 流，前端解析 `choices[0].delta.content`
- **Anthropic 协议**：后端接收 Anthropic SSE 事件（`content_block_delta`），转换为 OpenAI 格式后转发，前端无需感知差异

### 模型配置

存储在 `settings` 表中，`ai_configs` 字段为 JSON 数组：

```json
[
  { "name": "GLM-5.1", "provider": "anthropic", "base_url": "...", "model": "glm-5.1", "api_key": "..." },
  { "name": "DeepSeek V4", "provider": "openai", "base_url": "...", "model": "deepseek-chat", "api_key": "..." }
]
```

`ai_active_config` 记录当前激活的配置索引。

---

## 5. README.md 双向同步机制

```
创建/更新任务 ──→ writeTaskReadme() ──→ 任务目录/README.md
                                              │
批量导入 ←── scanDirectories() ←── parseReadme() ←──┘
```

### README 格式

```markdown
---
title: 任务标题
status: todo
goal: 目标名称
due_date: 2026-06-01
people:
  - 张三
tags:
  - 急迫
created_at: 2026-06-01T00:00:00.000Z
updated_at: 2026-06-01T00:00:00.000Z
---

# 任务标题

## 描述

任务描述内容

## 背景

背景信息
```

### 设计意义
- 任务数据随目录走，拷贝目录即拷贝任务信息
- 人类可读，不依赖系统也能了解任务内容
- 支持从已有目录批量导入，实现系统间迁移

---

## 6. 安全架构

### 6.1 路径安全

```
isPathAllowed(inputPath)
  ├── 获取 root_dir 和所有任务 folder_path
  ├── 解析 inputPath 为绝对路径
  └── 检查是否在 root_dir 或某个 task.folder_path 下
      ├── 是 → 允许
      └── 否 → 拒绝 (403)
```

应用于：`/api/open-folder`、`/api/attachments/open`、`/api/skills/open`、`/api/import/scan`、`GET /api/tasks/:id/files`

### 6.2 命令执行安全

```
终端/OpenCode 启动
  ├── 旧方案: exec(`open -a "${app}" "${dir}"`) ← 命令注入风险
  └── 新方案: spawn(app, [dir]) ← args 数组，无 shell 解析
```

### 6.3 网络安全

- 服务器绑定 `127.0.0.1`：仅本机可访问
- 设置白名单 `ALLOWED_SETTINGS`：限制可修改的设置项 key

### 6.4 统一错误处理

```javascript
asyncHandler(fn)
  → try { await fn(req, res) }
  → catch (err) { res.status(500).json({ error: err.message }) }
```

所有路由处理器通过 `asyncHandler` 包装，异常统一返回 500 JSON。
