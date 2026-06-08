# GodTodoList 数据库表设计文档

## 1. 概述

- **数据库类型**：SQLite（通过 sql.js 实现，纯 JS + WASM）
- **数据文件**：`data/godtodo.db`
- **ORM 方式**：手写 SQL，通过 `queryAll`/`queryOne`/`run` 封装
- **持久化**：写操作后 debounce 100ms 调用 `db.export()` 写入文件，`saveSync()` 用于即时写入

---

## 2. ER 关系图

```
┌──────────┐       ┌──────────┐       ┌──────────┐
│  goals   │       │ routines │       │   tags   │
├──────────┤       ├──────────┤       ├──────────┤
│ id (PK)  │←──┐   │ id (PK)  │       │ id (PK)  │
│ name     │   │   │ name     │       │ name     │
│ desc     │   │   │ goal_id  │──→FK  │ dimension│
│ color    │   │   │ frequency│       │ color    │
│ paths    │   │   │ archived │       │ sort_order│
│target_dt │   │   └──────────┘       └────┬─────┘
│ archived │   │                         │
└──────────┘   │                         │
     │         │                         │
     │    ┌────▼─────────────────────────▼──┐
     │    │            tasks                 │
     │    ├──────────────────────────────────┤
     └──→ │ id (PK)                          │
  FK←──── │ goal_id                          │
  FK←──── │ routine_id                       │
          │ title, description, context      │
          │ status, estimated_time, ...      │
          │ paths (JSON)                     │
          └──┬───────┬───────┬───────┬───────┘
             │       │       │       │
    ┌────────▼┐ ┌───▼────┐ ┌▼──────┐ ┌▼──────────────┐
    │task_tags│ │task_   │ │attach-│ │opencode_      │
    │         │ │people  │ │ments  │ │sessions       │
    ├─────────┤ ├────────┤ ├───────┤ ├───────────────┤
    │task_id  │ │task_id │ │task_id│ │task_id        │
    │tag_id   │ │person_ │ │file_  │ │name           │
    │(联合PK) │ │name    │ │name.. │ │started_at     │
    └─────────┘ │(联合PK)│ └───────┘ └───────────────┘
               └────────┘
         ┌──────────────┐    ┌──────────────┐
         │  time_logs   │    │  subtasks    │
         ├──────────────┤    ├──────────────┤
         │ id (PK)      │    │ id (PK)      │
         │ task_id      │    │ task_id (FK) │
         │ duration     │    │ title        │
         │ note         │    │ completed    │
         │ logged_at    │    │ sort_order   │
         └──────────────┘    └──────────────┘

┌──────────────┐
│  settings    │
├──────────────┤
│ key (PK)     │
│ value        │
└──────────────┘
```

---

## 3. 表结构详细设计

### 3.1 settings（系统设置）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| key | TEXT | PRIMARY KEY | 设置项名称 |
| value | TEXT | NOT NULL | 设置值（JSON 字符串或普通字符串） |

**预置设置项**：

| key | 默认值 | 说明 |
|-----|--------|------|
| root_dir | ~/Work/Tasks (Mac/Linux) / %USERPROFILE%\Work\Tasks (Windows) | 任务文件夹根目录 |
| auto_create_folder | true | 是否自动创建任务文件夹 |
| folder_format | date_name | 文件夹命名格式 (date_name / number_name) |
| ai_active_config | 0 | 当前激活的 AI 配置索引 |
| ai_configs | JSON 数组 | AI 模型配置列表 |
| terminal_path | Terminal (Mac) / x-terminal-emulator (Linux) | 终端程序路径 |
| opencode_cmd | opencode | OpenCode 命令 |

### 3.2 goals（目标）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 目标 ID |
| name | TEXT | NOT NULL | 目标名称 |
| description | TEXT | DEFAULT '' | 目标描述 |
| color | TEXT | DEFAULT '#3b82f6' | 显示颜色 |
| sort_order | INTEGER | DEFAULT 0 | 排序权重 |
| archived | INTEGER | DEFAULT 0 | 是否归档 (0/1) |
| paths | TEXT | DEFAULT '[]' | 关联路径列表（JSON 数组） |
| target_date | TEXT | | 目标截止日期 (YYYY-MM-DD) |
| created_at | TEXT | | 创建时间 (ISO 8601) |
| updated_at | TEXT | | 更新时间 (ISO 8601) |

**paths 字段示例**：
```json
["/Users/dev/project/src", "/Users/dev/docs/api"]
```

**target_date 用途**：目标卡片展示距截止日天数、进度健康度判断。

### 3.3 routines（惯例）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 惯例 ID |
| name | TEXT | NOT NULL | 惯例名称 |
| description | TEXT | DEFAULT '' | 惯例描述 |
| goal_id | INTEGER | FK → goals.id | 关联目标 |
| frequency | TEXT | DEFAULT 'weekly' | 频率 (daily/weekly/biweekly/monthly/quarterly) |
| sort_order | INTEGER | DEFAULT 0 | 排序权重 |
| archived | INTEGER | DEFAULT 0 | 是否归档 |
| created_at | TEXT | | 创建时间 |
| updated_at | TEXT | | 更新时间 |

### 3.4 tags（标签）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 标签 ID |
| name | TEXT | NOT NULL | 标签名称 |
| dimension | TEXT | DEFAULT 'urgency' | 维度 (urgency / value) |
| color | TEXT | DEFAULT '#6b7280' | 显示颜色 |
| sort_order | INTEGER | DEFAULT 0 | 排序权重 |

**预置数据**：

| id | name | dimension | color |
|----|------|-----------|-------|
| 1 | 急迫 | urgency | #ef4444 |
| 2 | 高优先级 | urgency | #f97316 |
| 3 | 中优先级 | urgency | #eab308 |
| 4 | 低优先级 | urgency | #22c55e |
| 5 | 闪光 | value | #f59e0b |
| 6 | 让子弹飞 | value | #4f46e5 |
| 7 | 他人需求 | value | #8b5cf6 |
| 8 | 个人尝试 | value | #06b6d4 |
| 9 | 效率提升 | value | #10b981 |

### 3.5 tasks（任务）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 任务 ID |
| title | TEXT | NOT NULL | 任务标题 |
| description | TEXT | DEFAULT '' | 任务描述 |
| context | TEXT | DEFAULT '' | 背景备注 |
| goal_id | INTEGER | FK → goals.id | 关联目标 |
| routine_id | INTEGER | FK → routines.id | 关联惯例 |
| status | TEXT | DEFAULT 'todo' | 状态 (todo/in-progress/done/shelved) |
| estimated_time | INTEGER | DEFAULT 0 | 预估时间（分钟） |
| actual_time | INTEGER | DEFAULT 0 | 实际时间（分钟） |
| folder_path | TEXT | DEFAULT '' | 任务文件夹路径 |
| paths | TEXT | DEFAULT '[]' | 关联路径列表（JSON 数组） |
| due_date | TEXT | | 截止日期 (YYYY-MM-DD) |
| completed_at | TEXT | | 完成时间 |
| created_at | TEXT | | 创建时间 |
| updated_at | TEXT | | 更新时间 |

**paths 字段示例**：
```json
["/Users/dev/project/src/module", "/Users/dev/project/tests"]
```

### 3.6 subtasks（子任务）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 子任务 ID |
| task_id | INTEGER | FK → tasks.id | 所属任务 |
| title | TEXT | NOT NULL | 子任务标题 |
| completed | INTEGER | DEFAULT 0 | 是否完成 (0/1) |
| sort_order | INTEGER | DEFAULT 0 | 排序权重 |

### 3.7 task_tags（任务-标签关联）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| task_id | INTEGER | PK, FK → tasks.id | 任务 ID |
| tag_id | INTEGER | PK, FK → tags.id | 标签 ID |

多对多关联表，联合主键。一个任务可以有多个标签，一个标签可关联多个任务。

### 3.8 task_people（任务-人员关联）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| task_id | INTEGER | PK, FK → tasks.id | 任务 ID |
| person_name | TEXT | PK | 人员姓名 |

以人员姓名字符串直接存储，联合主键。

### 3.9 attachments（附件）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 附件 ID |
| task_id | INTEGER | FK → tasks.id | 所属任务 |
| file_name | TEXT | | 文件名 |
| file_path | TEXT | | 文件完整路径 |
| file_type | TEXT | | 文件扩展名 |
| file_size | INTEGER | DEFAULT 0 | 文件大小（字节） |
| created_at | TEXT | | 上传时间 |

### 3.10 time_logs（时间日志）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 日志 ID |
| task_id | INTEGER | FK → tasks.id | 所属任务 |
| duration | INTEGER | | 时长（分钟） |
| note | TEXT | DEFAULT '' | 备注 |
| logged_at | TEXT | | 记录时间 |

### 3.11 opencode_sessions（OpenCode 会话）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, AUTOINCREMENT | 会话 ID |
| task_id | INTEGER | FK → tasks.id | 所属任务 |
| name | TEXT | | 会话名称 |
| started_at | TEXT | | 开始时间 |

---

## 4. 索引设计

```sql
-- 任务查询优化
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_goal_id ON tasks(goal_id);
CREATE INDEX idx_tasks_created_at ON tasks(created_at);

-- 关联查询优化
CREATE INDEX idx_task_tags_tag_id ON task_tags(tag_id);
CREATE INDEX idx_attachments_task_id ON attachments(task_id);
CREATE INDEX idx_time_logs_task_id ON time_logs(task_id);
CREATE INDEX idx_opencode_sessions_task_id ON opencode_sessions(task_id);
CREATE INDEX idx_subtasks_task_id ON subtasks(task_id);
```

> 注：当前版本未显式创建索引，SQLite 在小数据量下性能足够。如需优化可后续添加。

---

## 5. 数据迁移

### 5.1 JSON → SQLite 迁移

系统首次启动时，如检测到 `data/db.json`（旧版 JSON 存储），自动执行迁移：

1. 读取 JSON 文件
2. 依次导入 settings → tags → goals → routines → tasks
3. 导入任务关联数据：task_tags、task_people、attachments、time_logs、opencode_sessions
4. 生成 `.migrated` 标记文件，防止重复迁移
5. 旧 db.json 保留不删除

### 5.2 README.md → SQLite 导入

通过批量导入 API：

1. 扫描指定目录下的子文件夹
2. 解析每个子文件夹中的 `README.md`
3. 提取 YAML frontmatter 中的元数据
4. 按名称匹配目标、标签
5. 创建任务并关联已有文件夹

### 5.3 增量 ALTER TABLE

系统启动时通过 ALTER TABLE 自动添加新列（IF NOT EXISTS 逻辑）：

```sql
ALTER TABLE goals ADD COLUMN paths TEXT DEFAULT '[]';
ALTER TABLE goals ADD COLUMN target_date TEXT;
ALTER TABLE tasks ADD COLUMN paths TEXT DEFAULT '[]';
```

---

## 6. 数据一致性

- **防重入保存**：`save()` 使用 100ms debounce，防止高频写入；`saveSync()` 用于需要即时落地的场景（如删除操作）
- **级联删除**：删除任务时级联删除 subtasks、task_tags、task_people、time_logs、opencode_sessions
- **附件安全删除**：`deleteAttachment()` 先验证 file_path 在任务 folder_path 下才执行文件删除
- **标签更新**：更新标签使用 PUT（保留 task_tags 关联），不使用 delete+create（避免丢失关联）
- **任务复制**：`copyTask` 设置 `create_folder: false`，仅复制元数据（含 due_date），不复制子任务/附件
- **软删除**：目标和惯例使用 `archived` 标记，不物理删除
- **前端错误恢复**：`api()` 全局 catch，异常时 toast 提示，设置 `lastApiError` 供 UI 展示
