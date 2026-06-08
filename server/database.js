const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'godtodo.db');
const JSON_FILE = path.join(DATA_DIR, 'db.json');

let db = null;

function now() { return new Date().toISOString(); }

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// ==================== 初始化 ====================

async function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  createTables();
  seedDefaults();

  // 如果存在旧的 db.json，自动迁移
  if (fs.existsSync(JSON_FILE) && !fs.existsSync(DB_FILE.replace('.db', '.migrated'))) {
    migrateFromJSON();
    fs.writeFileSync(DB_FILE.replace('.db', '.migrated'), 'done');
  }

  save();
  return db;
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#3b82f6',
    sort_order INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    goal_id INTEGER,
    frequency TEXT DEFAULT 'weekly',
    sort_order INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dimension TEXT DEFAULT 'urgency',
    color TEXT DEFAULT '#6b7280',
    sort_order INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    context TEXT DEFAULT '',
    goal_id INTEGER,
    routine_id INTEGER,
    parent_task_id INTEGER,
    status TEXT DEFAULT 'todo',
    estimated_time INTEGER DEFAULT 0,
    actual_time REAL DEFAULT 0,
    folder_path TEXT DEFAULT '',
    due_date TEXT,
    is_today INTEGER DEFAULT 0,
    timer_started_at TEXT,
    completed_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'todo',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    employee_id TEXT DEFAULT '',
    email TEXT DEFAULT '',
    relationship TEXT DEFAULT '',
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS task_tags (
    task_id INTEGER,
    tag_id INTEGER,
    PRIMARY KEY (task_id, tag_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS task_people (
    task_id INTEGER,
    person_name TEXT,
    PRIMARY KEY (task_id, person_name)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    file_name TEXT,
    file_path TEXT,
    file_type TEXT,
    file_size INTEGER DEFAULT 0,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS time_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    duration REAL,
    note TEXT DEFAULT '',
    logged_at TEXT
  )`);

  // 兼容旧表：添加新列（如不存在）
  try { db.run('ALTER TABLE tasks ADD COLUMN is_today INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE tasks ADD COLUMN timer_started_at TEXT'); } catch (e) {}
  try { db.run('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER'); } catch (e) {}
  try { db.run('ALTER TABLE tasks ADD COLUMN actual_time REAL DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE goals ADD COLUMN paths TEXT DEFAULT "[]"'); } catch (e) {}
  try { db.run('ALTER TABLE goals ADD COLUMN target_date TEXT'); } catch (e) {}
  try { db.run('ALTER TABLE tasks ADD COLUMN ai_progress TEXT DEFAULT ""'); } catch (e) {}
  try { db.run('ALTER TABLE tasks ADD COLUMN is_report INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE tasks ADD COLUMN report_meeting TEXT DEFAULT ""'); } catch (e) {}
  try { db.run('ALTER TABLE routines ADD COLUMN is_report INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE routines ADD COLUMN report_meeting TEXT DEFAULT ""'); } catch (e) {}
  try { db.run('ALTER TABLE task_conversations ADD COLUMN goal_id INTEGER'); } catch (e) {}
  try { db.run('ALTER TABLE task_conversations ADD COLUMN updated_at TEXT'); } catch (e) {}

  // AI 对话关联表
  db.run(`CREATE TABLE IF NOT EXISTS task_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    goal_id INTEGER,
    tool TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT DEFAULT '',
    directory TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
  )`);
  try { db.run('ALTER TABLE tasks ADD COLUMN paths TEXT DEFAULT "[]"'); } catch (e) {}

  // 笔记卡片
  db.run(`CREATE TABLE IF NOT EXISTS note_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS note_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    content TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT,
    FOREIGN KEY (card_id) REFERENCES note_cards(id) ON DELETE CASCADE
  )`);

  // 日报/周报
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    content TEXT DEFAULT '',
    created_at TEXT
  )`);

  // 索引
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_goal_id ON tasks(goal_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_is_today ON tasks(is_today)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_subtasks_task_id ON subtasks(task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id ON task_tags(tag_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_time_logs_task_id ON time_logs(task_id)');
}

function seedDefaults() {
  // 只在表为空时插入默认数据
  const tagCount = queryOne('SELECT COUNT(*) as c FROM tags');
  if (tagCount.c === 0) {
    const defaults = [
      { name: '急迫', dimension: 'urgency', color: '#ef4444', sort_order: 1 },
      { name: '高优先级', dimension: 'urgency', color: '#f97316', sort_order: 2 },
      { name: '中优先级', dimension: 'urgency', color: '#eab308', sort_order: 3 },
      { name: '低优先级', dimension: 'urgency', color: '#22c55e', sort_order: 4 },
      { name: '闪光', dimension: 'value', color: '#f59e0b', sort_order: 1 },
      { name: '让子弹飞', dimension: 'value', color: '#4f46e5', sort_order: 2 },
      { name: '他人需求', dimension: 'value', color: '#8b5cf6', sort_order: 3 },
      { name: '个人尝试', dimension: 'value', color: '#06b6d4', sort_order: 4 },
      { name: '效率提升', dimension: 'value', color: '#10b981', sort_order: 5 },
    ];
    for (const t of defaults) {
      db.run('INSERT INTO tags (name, dimension, color, sort_order) VALUES (?, ?, ?, ?)',
        [t.name, t.dimension, t.color, t.sort_order]);
    }
  }

  // 默认设置
  const defaults = {
    root_dir: path.join(os.homedir(), 'Work', 'Tasks'),
    auto_create_folder: 'true',
    folder_format: 'date_name',
    ai_active_config: '0',
    ai_configs: JSON.stringify([
      { name: 'GLM-5.1', provider: 'anthropic', base_url: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.1', api_key: process.env.ZHIPU_API_KEY || '', x_token: '' },
      { name: 'DeepSeek V4', provider: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-chat', api_key: '', x_token: '' },
    ]),
    terminal_path: process.platform === 'win32' ? 'cmd' : 'Terminal',
  };
  for (const [k, v] of Object.entries(defaults)) {
    const existing = queryOne('SELECT value FROM settings WHERE key = ?', [k]);
    if (!existing) {
      db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);
    }
  }
}

// ==================== JSON 迁移 ====================

function migrateFromJSON() {
  try {
    const raw = fs.readFileSync(JSON_FILE, 'utf-8');
    const data = JSON.parse(raw);

    // 迁移设置
    if (data.settings) {
      for (const [k, v] of Object.entries(data.settings)) {
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, val]);
      }
    }

    // 迁移标签
    if (data.tags) {
      for (const t of data.tags) {
        db.run('INSERT OR IGNORE INTO tags (id, name, dimension, color, sort_order) VALUES (?, ?, ?, ?, ?)',
          [t.id, t.name, t.dimension, t.color, t.sort_order || 0]);
      }
    }

    // 迁移目标
    if (data.goals) {
      for (const g of data.goals) {
        db.run('INSERT OR IGNORE INTO goals (id, name, description, color, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [g.id, g.name, g.description || '', g.color || '#3b82f6', g.sort_order || 0, g.archived ? 1 : 0, g.created_at || now(), g.updated_at || now()]);
      }
    }

    // 迁移惯例
    if (data.routines) {
      for (const r of data.routines) {
        db.run('INSERT OR IGNORE INTO routines (id, name, description, goal_id, frequency, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [r.id, r.name, r.description || '', r.goal_id, r.frequency || 'weekly', r.sort_order || 0, r.archived ? 1 : 0, r.created_at || now(), r.updated_at || now()]);
      }
    }

    // 迁移任务
    if (data.tasks) {
      for (const t of data.tasks) {
        db.run(`INSERT OR IGNORE INTO tasks
          (id, title, description, context, goal_id, routine_id, status, estimated_time, actual_time, folder_path, due_date, completed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [t.id, t.title, t.description || '', t.context || '', t.goal_id, t.routine_id,
           t.status || 'todo', t.estimated_time || 0, t.actual_time || 0, t.folder_path || '',
           t.due_date || null, t.completed_at || null, t.created_at || now(), t.updated_at || now()]);

        // 标签
        if (t.tag_ids) {
          for (const tagId of t.tag_ids) {
            db.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [t.id, tagId]);
          }
        }

        // 人员
        if (t.people) {
          for (const p of t.people) {
            if (p.trim()) db.run('INSERT OR IGNORE INTO task_people (task_id, person_name) VALUES (?, ?)', [t.id, p.trim()]);
          }
        }

        // 附件
        if (t.attachments) {
          for (const a of t.attachments) {
            db.run('INSERT INTO attachments (id, task_id, file_name, file_path, file_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [a.id, t.id, a.file_name, a.file_path, a.file_type, a.file_size || 0, a.created_at || now()]);
          }
        }

        // 时间日志
        if (t.time_logs) {
          for (const l of t.time_logs) {
            db.run('INSERT INTO time_logs (id, task_id, duration, note, logged_at) VALUES (?, ?, ?, ?, ?)',
              [l.id, t.id, l.duration, l.note || '', l.logged_at || now()]);
          }
        }

      }
    }

    console.log('✅ 已从 db.json 迁移数据到 SQLite');
  } catch (e) {
    console.error('迁移失败:', e.message);
  }
}

// ==================== 工具函数 ====================

let saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = db.export();
    const buf = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buf);
    saveTimer = null;
  }, 100);
}

function saveSync() {
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buf);
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

// ==================== Settings ====================

function getSetting(key) {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return null;
  const val = row.value;
  // 尝试解析 JSON（数组/对象）
  if (val && (val.startsWith('[') || val.startsWith('{'))) {
    try { return JSON.parse(val); } catch (e) { return val; }
  }
  return val;
}

function setSetting(key, value) {
  const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, val]);
  save();
}

function getAllSettings() {
  const rows = queryAll('SELECT key, value FROM settings');
  const result = {};
  for (const r of rows) {
    let val = r.value;
    if (val && (val.startsWith('[') || val.startsWith('{'))) {
      try { val = JSON.parse(val); } catch (e) { /* keep string */ }
    }
    result[r.key] = val;
  }
  return result;
}

// ==================== Goals ====================

function getGoals() {
  return queryAll('SELECT * FROM goals WHERE archived = 0').map(g => ({
    ...g,
    archived: !!g.archived,
    paths: safeJsonParse(g.paths, []),
    active_count: queryOne('SELECT COUNT(*) as c FROM tasks WHERE goal_id = ? AND status != "done"', [g.id])?.c || 0,
    total_count: queryOne('SELECT COUNT(*) as c FROM tasks WHERE goal_id = ?', [g.id])?.c || 0,
    done_count: queryOne('SELECT COUNT(*) as c FROM tasks WHERE goal_id = ? AND status = "done"', [g.id])?.c || 0,
  }));
}

function createGoal(d) {
  db.run('INSERT INTO goals (name, description, color, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    [d.name, d.description || '', d.color || '#3b82f6', 0, now(), now()]);
  save();
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  return { id, name: d.name, description: d.description || '', color: d.color || '#3b82f6' };
}

function updateGoal(id, d) {
  const fields = [];
  const params = [];
  const allowed = ['name', 'description', 'color', 'sort_order', 'archived', 'paths', 'target_date'];
  for (const [k, v] of Object.entries(d)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = ?`);
      params.push(k === 'archived' ? (v ? 1 : 0) : (k === 'paths' ? JSON.stringify(v) : v));
    }
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(now());
  params.push(id);
  db.run(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`, params);
  save();
}

function deleteGoal(id) { updateGoal(id, { archived: true }); }

// ==================== Routines ====================

function getRoutines() {
  return queryAll('SELECT * FROM routines WHERE archived = 0').map(r => {
    const g = queryOne('SELECT name, color FROM goals WHERE id = ?', [r.goal_id]);
    return { ...r, archived: !!r.archived, goal_name: g ? g.name : null, goal_color: g ? g.color : null };
  });
}

function createRoutine(d) {
  db.run('INSERT INTO routines (name, description, goal_id, frequency, is_report, report_meeting, sort_order, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    [d.name, d.description || '', d.goal_id || null, d.frequency || 'weekly', d.is_report ? 1 : 0, d.report_meeting || '', 0, now(), now()]);
  save();
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  return { id, name: d.name };
}

function updateRoutine(id, d) {
  const fields = [];
  const params = [];
  const allowed = ['name', 'description', 'goal_id', 'frequency', 'is_report', 'report_meeting', 'sort_order', 'archived'];
  for (const [k, v] of Object.entries(d)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = ?`);
      params.push(k === 'archived' ? (v ? 1 : 0) : v);
    }
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(now());
  params.push(id);
  db.run(`UPDATE routines SET ${fields.join(', ')} WHERE id = ?`, params);
  save();
}

function deleteRoutine(id) { updateRoutine(id, { archived: true }); }

// ==================== Tasks ====================

function getTasks(filters = {}) {
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.goal_id) { sql += ' AND goal_id = ?'; params.push(Number(filters.goal_id)); }
  if (filters.routine_id) { sql += ' AND routine_id = ?'; params.push(Number(filters.routine_id)); }
  if (filters.tag_id) {
    sql += ' AND id IN (SELECT task_id FROM task_tags WHERE tag_id = ?)';
    params.push(Number(filters.tag_id));
  }
  if (filters.search) {
    sql += ' AND (title LIKE ? OR description LIKE ? OR context LIKE ?)';
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  if (filters.is_report) {
    sql += ' AND is_report = 1';
  }

  sql += ' ORDER BY created_at DESC';
  return queryAll(sql, params).map(enrichTask);
}

function enrichTask(t) {
  const g = t.goal_id ? queryOne('SELECT name, color FROM goals WHERE id = ?', [t.goal_id]) : null;
  const r = t.routine_id ? queryOne('SELECT name FROM routines WHERE id = ?', [t.routine_id]) : null;
  const tags = queryAll('SELECT t.* FROM tags t JOIN task_tags tt ON t.id = tt.tag_id WHERE tt.task_id = ?', [t.id]);
  const people = queryAll('SELECT person_name as name FROM task_people WHERE task_id = ?', [t.id]);
  const attachments = queryAll('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at', [t.id]);
  const timeLogs = queryAll('SELECT * FROM time_logs WHERE task_id = ? ORDER BY logged_at DESC', [t.id]);
  const subtasks = queryAll('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, id', [t.id]);

  return {
    ...t,
    is_today: !!t.is_today,
    paths: safeJsonParse(t.paths, []),
    goal_name: g ? g.name : null,
    goal_color: g ? g.color : null,
    routine_name: r ? r.name : null,
    tags,
    people,
    attachments,
    time_logs: timeLogs,
    subtasks,
  };
}

function getTask(id) {
  const t = queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
  return t ? enrichTask(t) : null;
}

function createTask(d) {
  db.run(`INSERT INTO tasks (title, description, context, goal_id, routine_id, parent_task_id, status, estimated_time, actual_time, folder_path, due_date, is_today, is_report, report_meeting, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?, ?, NULL, ?, ?)`,
    [d.title, d.description || '', d.context || '', d.goal_id || null, d.routine_id || null,
     d.parent_task_id || null, d.status || 'todo', d.estimated_time || 0,
     d.due_date || new Date(Date.now() + 7*86400000).toISOString().slice(0, 10), d.is_today ? 1 : 0,
     d.is_report ? 1 : 0, d.report_meeting || '', now(), now()]);

  const id = queryOne('SELECT last_insert_rowid() as id').id;

  // 标签
  if (d.tag_ids) {
    for (const tagId of d.tag_ids) {
      db.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [id, tagId]);
    }
  }

  // 人员（同时自动加入联系人表）
  if (d.people) {
    for (const p of d.people) {
      if (p.trim()) {
        db.run('INSERT OR IGNORE INTO task_people (task_id, person_name) VALUES (?, ?)', [id, p.trim()]);
        ensureContact(p.trim());
      }
    }
  }

  save();
  return getTask(id);
}

function updateTask(id, d) {
  const allowed = ['title', 'description', 'context', 'goal_id', 'routine_id', 'status', 'estimated_time', 'actual_time', 'folder_path', 'due_date', 'completed_at', 'is_today', 'parent_task_id', 'paths', 'ai_progress', 'is_report', 'report_meeting'];
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(d)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = ?`);
      params.push(k === 'paths' ? JSON.stringify(v) : v);
    }
  }
  if (fields.length === 0) return;

  // 自动设置 completed_at
  if (d.status === 'done') {
    const task = queryOne('SELECT completed_at FROM tasks WHERE id = ?', [id]);
    if (task && !task.completed_at) {
      fields.push('completed_at = ?');
      params.push(now());
    }
  }

  fields.push('updated_at = ?');
  params.push(now());
  params.push(id);
  db.run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, params);
  save();
}

function deleteTask(id) {
  db.run('DELETE FROM subtasks WHERE task_id = ?', [id]);
  db.run('DELETE FROM task_tags WHERE task_id = ?', [id]);
  db.run('DELETE FROM task_people WHERE task_id = ?', [id]);
  db.run('DELETE FROM attachments WHERE task_id = ?', [id]);
  db.run('DELETE FROM time_logs WHERE task_id = ?', [id]);
  db.run('DELETE FROM tasks WHERE id = ?', [id]);
  save();
}

// ==================== Tags ====================

function getTags() {
  return queryAll('SELECT * FROM tags ORDER BY dimension, sort_order');
}

function createTag(d) {
  db.run('INSERT INTO tags (name, dimension, color, sort_order) VALUES (?, ?, ?, ?)',
    [d.name, d.dimension, d.color || '#6b7280', d.sort_order || 0]);
  save();
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  return { id, name: d.name, dimension: d.dimension, color: d.color || '#6b7280' };
}

function updateTag(id, d) {
  const fields = [];
  const params = [];
  if (d.name !== undefined) { fields.push('name = ?'); params.push(d.name); }
  if (d.color !== undefined) { fields.push('color = ?'); params.push(d.color); }
  if (d.dimension !== undefined) { fields.push('dimension = ?'); params.push(d.dimension); }
  if (fields.length === 0) return;
  params.push(id);
  db.run(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`, params);
  save();
}

function deleteTag(id) {
  db.run('DELETE FROM task_tags WHERE tag_id = ?', [id]);
  db.run('DELETE FROM tags WHERE id = ?', [id]);
  save();
}

function setTaskTags(taskId, tagIds) {
  db.run('DELETE FROM task_tags WHERE task_id = ?', [taskId]);
  for (const tagId of tagIds) {
    db.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [taskId, tagId]);
  }
  save();
}

// ==================== People ====================

function setTaskPeople(taskId, people) {
  db.run('DELETE FROM task_people WHERE task_id = ?', [taskId]);
  for (const p of people) {
    if (p.trim()) {
      db.run('INSERT OR IGNORE INTO task_people (task_id, person_name) VALUES (?, ?)', [taskId, p.trim()]);
      ensureContact(p.trim());
    }
  }
  save();
}

function getAllPeople() {
  return queryAll('SELECT DISTINCT person_name as name FROM task_people ORDER BY person_name').map(r => r.name);
}

// ==================== Attachments ====================

function addAttachment(taskId, fileName, filePath, fileType, fileSize) {
  db.run('INSERT INTO attachments (task_id, file_name, file_path, file_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [taskId, fileName, filePath, fileType, fileSize, now()]);
  save();
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  return { id, task_id: taskId, file_name: fileName, file_path: filePath, file_type: fileType, file_size, created_at: now() };
}

function deleteAttachment(attId) {
  const att = queryOne('SELECT a.file_path, t.folder_path FROM attachments a LEFT JOIN tasks t ON a.task_id = t.id WHERE a.id = ?', [attId]);
  if (att && att.file_path) {
    // Only delete file if it's under the task's folder_path
    const filePath = path.resolve(att.file_path);
    const folderPath = att.folder_path ? path.resolve(att.folder_path) : '';
    if (folderPath && filePath.startsWith(folderPath)) {
      try { fs.unlinkSync(att.file_path); } catch (e) { /* ignore */ }
    }
  }
  db.run('DELETE FROM attachments WHERE id = ?', [attId]);
  save();
}

// ==================== Time Logs ====================

function addTimeLog(taskId, duration, note) {
  db.run('INSERT INTO time_logs (task_id, duration, note, logged_at) VALUES (?, ?, ?, ?)',
    [taskId, duration, note || '', now()]);
  save();
}

// ==================== Stats ====================

function getGoalStats() {
  return queryAll('SELECT * FROM goals WHERE archived = 0').map(g => {
    const stats = queryOne(`SELECT
      COUNT(*) as total_tasks,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_tasks,
      SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) as in_progress_tasks,
      SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo_tasks,
      COALESCE(SUM(actual_time), 0) as total_time,
      COALESCE(SUM(estimated_time), 0) as total_estimated
    FROM tasks WHERE goal_id = ?`, [g.id]);
    return { id: g.id, name: g.name, description: g.description, color: g.color, paths: safeJsonParse(g.paths, []), target_date: g.target_date || null, ...stats };
  });
}

function getTimeStats(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return queryAll(`SELECT
    DATE(updated_at) as date,
    COUNT(DISTINCT id) as tasks_worked,
    COALESCE(SUM(actual_time), 0) as total_time,
    SUM(CASE WHEN status = 'done' AND DATE(completed_at) = DATE(updated_at) THEN 1 ELSE 0 END) as completed
  FROM tasks WHERE DATE(updated_at) >= ? AND updated_at IS NOT NULL
  GROUP BY DATE(updated_at) ORDER BY date DESC`, [sinceStr]);
}

function getReviewData(type = 'daily') {
  const days = type === 'weekly' ? 7 : 1;
  return {
    completed: queryAll(`SELECT * FROM tasks WHERE status = 'done' AND completed_at >= datetime('now', '-${days} days')`),
    inProgress: queryAll(`SELECT * FROM tasks WHERE status = 'in-progress'`),
    overdue: queryAll(`SELECT * FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < DATE('now')`),
  };
}


// ==================== Contacts ====================

function getContacts() {
  return queryAll('SELECT * FROM contacts ORDER BY name');
}

function createContact(d) {
  db.run('INSERT INTO contacts (name, employee_id, email, relationship, created_at) VALUES (?, ?, ?, ?, ?)',
    [d.name, d.employee_id || '', d.email || '', d.relationship || '', now()]);
  save();
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  return { id, name: d.name };
}

function updateContact(id, d) {
  const fields = []; const params = [];
  for (const k of ['name', 'employee_id', 'email', 'relationship']) {
    if (d[k] !== undefined) { fields.push(`${k} = ?`); params.push(d[k]); }
  }
  if (!fields.length) return;
  params.push(id);
  db.run(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`, params);
  save();
}

function deleteContact(id) {
  db.run('DELETE FROM contacts WHERE id = ?', [id]);
  save();
}

// 确保联系人存在（自动添加）
function ensureContact(name) {
  if (!name || !name.trim()) return;
  const existing = queryOne('SELECT id FROM contacts WHERE name = ?', [name.trim()]);
  if (!existing) {
    createContact({ name: name.trim() });
  }
}

// ==================== Subtasks ====================

function getSubtasks(taskId) {
  return queryAll('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, id', [taskId]);
}

function createSubtask(taskId, d) {
  db.run('INSERT INTO subtasks (task_id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [taskId, d.title, d.status || 'todo', d.sort_order || 0, now(), now()]);
  save();
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  return { id, task_id: taskId, title: d.title, status: 'todo' };
}

function updateSubtask(id, d) {
  const fields = []; const params = [];
  for (const k of ['title', 'status', 'sort_order']) {
    if (d[k] !== undefined) { fields.push(`${k} = ?`); params.push(d[k]); }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?'); params.push(now());
  params.push(id);
  db.run(`UPDATE subtasks SET ${fields.join(', ')} WHERE id = ?`, params);
  save();
}

function deleteSubtask(id) {
  db.run('DELETE FROM subtasks WHERE id = ?', [id]);
  save();
}

// ==================== Timer ====================

function startTimer(taskId) {
  db.run('UPDATE tasks SET timer_started_at = ?, status = CASE WHEN status = "todo" THEN "in-progress" ELSE status END, updated_at = ? WHERE id = ?',
    [now(), now(), taskId]);
  save();
}

function stopTimer(taskId) {
  const task = queryOne('SELECT timer_started_at, actual_time FROM tasks WHERE id = ?', [taskId]);
  if (!task || !task.timer_started_at) return 0;
  const elapsed = (Date.now() - new Date(task.timer_started_at).getTime()) / 60000; // 分钟
  const newActual = (task.actual_time || 0) + elapsed;
  db.run('UPDATE tasks SET timer_started_at = NULL, actual_time = ?, updated_at = ? WHERE id = ?',
    [Math.round(newActual * 10) / 10, now(), taskId]);
  // 同时记录时间日志
  db.run('INSERT INTO time_logs (task_id, duration, note, logged_at) VALUES (?, ?, ?, ?)',
    [taskId, Math.round(elapsed * 10) / 10, '计时器', now()]);
  save();
  return Math.round(elapsed * 10) / 10;
}

function getActiveTimers() {
  return queryAll('SELECT id, title, timer_started_at, actual_time FROM tasks WHERE timer_started_at IS NOT NULL');
}

// ==================== Today ====================

function toggleToday(taskId) {
  const task = queryOne('SELECT is_today FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;
  db.run('UPDATE tasks SET is_today = ?, updated_at = ? WHERE id = ?', [task.is_today ? 0 : 1, now(), taskId]);
  save();
}

function getTodayTasks() {
  return queryAll('SELECT * FROM tasks WHERE is_today = 1 AND status != "done"').map(enrichTask);
}

// ==================== AI Conversations ====================

function getConversations(taskId, goalId) {
  const conditions = [];
  const params = [];
  if (taskId) { conditions.push('task_id = ?'); params.push(taskId); }
  if (goalId) { conditions.push('goal_id = ?'); params.push(goalId); }
  if (conditions.length === 0) return [];
  return queryAll(`SELECT * FROM task_conversations WHERE ${conditions.join(' OR ')} ORDER BY updated_at DESC`, params);
}

function getConversation(id) {
  return queryOne('SELECT * FROM task_conversations WHERE id = ?', [id]);
}

function addConversation(data) {
  db.run('INSERT INTO task_conversations (task_id, goal_id, tool, session_id, title, directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [data.task_id || null, data.goal_id || null, data.tool, data.session_id, data.title || '', data.directory || '', data.created_at || now(), now()]);
  save();
}

function deleteConversation(id) {
  db.run('DELETE FROM task_conversations WHERE id = ?', [id]);
  save();
}

// ==================== AI Context ====================

function getAIContext() {
  const goals = queryAll('SELECT * FROM goals WHERE archived = 0');
  const activeTasks = queryAll('SELECT * FROM tasks WHERE status != "done"');
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = queryAll('SELECT * FROM tasks WHERE status = "done" AND DATE(completed_at) = ?', [today]);
  const routines = queryAll('SELECT * FROM routines WHERE archived = 0');

  let context = `你是用户的职场AI军师，帮助管理任务、规划工作、分析效率。\n\n`;
  context += `## 当前目标\n`;
  for (const g of goals) {
    const cnt = queryOne('SELECT COUNT(*) as c FROM tasks WHERE goal_id = ?', [g.id]);
    const done = queryOne('SELECT COUNT(*) as c FROM tasks WHERE goal_id = ? AND status = "done"', [g.id]);
    context += `- **${g.name}**: ${cnt.c}个任务, 完成${done.c}个\n`;
  }

  context += `\n## 活跃任务 (${activeTasks.length})\n`;
  for (const t of activeTasks) {
    const g = t.goal_id ? queryOne('SELECT name FROM goals WHERE id = ?', [t.goal_id]) : null;
    const tagNames = queryAll('SELECT t.name FROM tags t JOIN task_tags tt ON t.id = tt.tag_id WHERE tt.task_id = ?', [t.id]).map(r => r.name);
    context += `- **${t.title}** [${t.status}]${g ? ` → 目标:${g.name}` : ''}${tagNames.length ? ` 标签:${tagNames.join(',')}` : ''}${t.due_date ? ` 截止:${t.due_date}` : ''}${t.estimated_time ? ` 预估:${t.estimated_time}分` : ''}\n`;
  }

  context += `\n## 今日已完成 (${doneToday.length})\n`;
  for (const t of doneToday) { context += `- ${t.title}\n`; }

  context += `\n## 惯例\n`;
  for (const r of routines) {
    context += `- **${r.name}** (${r.frequency})${r.goal_id ? ' → 目标' : ''}\n`;
  }

  return context;
}

// ==================== 笔记卡片 ====================

function getNoteCards() {
  const cards = queryAll('SELECT * FROM note_cards ORDER BY sort_order DESC, created_at DESC');
  for (const c of cards) {
    c.items = queryAll('SELECT * FROM note_items WHERE card_id = ? ORDER BY sort_order ASC, id ASC', [c.id]);
  }
  return cards;
}

function createNoteCard(title, content) {
  db.run('INSERT INTO note_cards (title, created_at, updated_at) VALUES (?, ?, ?)',
    [title || '', now(), now()]);
  const id = queryOne('SELECT last_insert_rowid() as id').id;
  if (content) {
    db.run('INSERT INTO note_items (card_id, content, sort_order, created_at) VALUES (?, ?, ?, ?)',
      [id, content, 0, now()]);
  }
  save();
  return id;
}

function updateNoteCard(id, data) {
  const fields = []; const params = [];
  if (data.title !== undefined) { fields.push('title = ?'); params.push(data.title); }
  if (fields.length) {
    fields.push('updated_at = ?'); params.push(now());
    params.push(id);
    db.run(`UPDATE note_cards SET ${fields.join(', ')} WHERE id = ?`, params);
    save();
  }
}

function deleteNoteCard(id) {
  db.run('DELETE FROM note_items WHERE card_id = ?', [id]);
  db.run('DELETE FROM note_cards WHERE id = ?', [id]);
  save();
}

function addNoteItem(cardId, content) {
  const maxSort = queryOne('SELECT MAX(sort_order) as m FROM note_items WHERE card_id = ?', [cardId]);
  const sort = (maxSort?.m ?? -1) + 1;
  db.run('INSERT INTO note_items (card_id, content, sort_order, created_at) VALUES (?, ?, ?, ?)',
    [cardId, content || '', sort, now()]);
  db.run('UPDATE note_cards SET updated_at = ? WHERE id = ?', [now(), cardId]);
  save();
  return queryOne('SELECT last_insert_rowid() as id').id;
}

function updateNoteItem(id, content) {
  db.run('UPDATE note_items SET content = ? WHERE id = ?', [content, id]);
  save();
}

function deleteNoteItem(id) {
  db.run('DELETE FROM note_items WHERE id = ?', [id]);
  save();
}

// ==================== 日报/周报 ====================

function getReports(type) {
  if (type) {
    return queryAll('SELECT * FROM reports WHERE type = ? ORDER BY created_at DESC LIMIT 30', [type]);
  }
  return queryAll('SELECT * FROM reports ORDER BY created_at DESC LIMIT 60');
}

function saveReport(type, content) {
  db.run('INSERT INTO reports (type, content, created_at) VALUES (?, ?, ?)', [type, content, now()]);
  save();
  return queryOne('SELECT last_insert_rowid() as id').id;
}

function deleteReport(id) {
  db.run('DELETE FROM reports WHERE id = ?', [id]);
  save();
}

function getReportMeetings() {
  return queryAll("SELECT DISTINCT report_meeting FROM tasks WHERE is_report = 1 AND report_meeting != '' ORDER BY report_meeting")
    .map(r => r.report_meeting);
}

module.exports = {
  init, save,
  getSetting, setSetting, getAllSettings,
  getGoals, createGoal, updateGoal, deleteGoal,
  getRoutines, createRoutine, updateRoutine, deleteRoutine,
  getTasks, getTask, createTask, updateTask, deleteTask,
  getTags, createTag, updateTag, deleteTag, setTaskTags,
  setTaskPeople, getAllPeople,
  addAttachment, deleteAttachment,
  addTimeLog,
  getAIContext,
  getGoalStats, getTimeStats, getReviewData,
  // Contacts
  getContacts, createContact, updateContact, deleteContact,
  // Subtasks
  getSubtasks, createSubtask, updateSubtask, deleteSubtask,
  // Timer
  startTimer, stopTimer, getActiveTimers,
  // Today
  toggleToday, getTodayTasks,
  getConversations, getConversation, addConversation, deleteConversation,
  getNoteCards, createNoteCard, updateNoteCard, deleteNoteCard,
  addNoteItem, updateNoteItem, deleteNoteItem,
  getReports, saveReport, deleteReport, getReportMeetings,
};
