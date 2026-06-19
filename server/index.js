const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const { exec, execSync, spawn } = require('child_process');
const db = require('./database');
const fm = require('./fileManager');

// 初始化数据库（异步）
const app = express();
const PORT = 3000;

let dbReady = false;

// ==================== 跨平台辅助（Windows 兼容） ====================

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * 统一的 spawn 包装：参数走数组，绝不手动加引号。
 * - Windows 默认 detached + stdio:'ignore'，调用方按需覆盖
 * - 返回 Promise，捕获 spawn 异常并包含 stderr 用于排查
 */
function spawnSafe(command, args, opts = {}) {
  return new Promise((resolve) => {
    const defaults = isWin
      ? { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: false }
      : { detached: true, stdio: 'ignore' };
    const finalOpts = { ...defaults, ...opts };
    let child;
    try {
      child = spawn(command, args, finalOpts);
    } catch (e) {
      return resolve({ ok: false, error: `spawn 失败: ${e.message}` });
    }
    if (!child) return resolve({ ok: false, error: 'spawn 返回空' });
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => { stderr += d.toString(); });
    }
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('spawn', () => {
      try { child.unref(); } catch (_) {}
      resolve({ ok: true });
    });
    // 兜底：4s 内未触发 spawn 事件视为失败
    setTimeout(() => {
      if (!child.killed && child.exitCode === null && child.pid) {
        resolve({ ok: true });
      }
    }, 4000);
  });
}

/**
 * 探测 PowerShell：优先 pwsh.exe（PowerShell 7+），fallback powershell.exe（5.1）。
 * Windows Server Core / 精简版可能两者都没有，返回 null。
 */
let _cachedShell = undefined;
function findPowerShell() {
  if (_cachedShell !== undefined) return _cachedShell;
  if (!isWin) { _cachedShell = null; return null; }
  // 注意：where 命令同步但极快（<50ms），仅启动期调用一次可接受
  for (const c of ['pwsh.exe', 'powershell.exe']) {
    try {
      execSync(`where ${c}`, { stdio: 'ignore', windowsHide: true });
      _cachedShell = c;
      return c;
    } catch (_) {}
  }
  _cachedShell = null;
  return null;
}

/**
 * 编码 PowerShell 脚本为 -EncodedCommand 参数（UTF-16LE Base64）。
 * 避免 -Command 字符串经 cmd/shell 转义时中文乱码 + 引号嵌套问题。
 */
function encodePSScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 统一错误响应：包含平台 + 错误信息，前端可显示。
 */
function sendPlatformError(res, action, err) {
  console.error(`[${action}] platform=${process.platform} error:`, err);
  return res.status(500).json({
    error: typeof err === 'string' ? err : (err?.message || String(err)),
    action,
    platform: process.platform,
  });
}

// ==================== 安全工具 ====================

// 跨平台路径归一化比较：Windows 大小写不敏感，且统一正斜杠便于比较
function normPath(p) {
  const r = path.resolve(p);
  return isWin ? r.toLowerCase().replace(/\\/g, '/') : r;
}

// 判断 child 是否等于 parent 或在 parent 之下（带分隔符边界）
function isPathUnder(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  if (c === p) return true;
  // 加 / 边界，避免 C:\Foo 被 C:\Foo-evil 绕过
  return c.startsWith(p + '/');
}

// 路径安全验证：确保路径在允许范围内
function isPathAllowed(targetPath) {
  const resolved = path.resolve(targetPath);
  const rootDir = db.getSetting('root_dir');
  if (rootDir && isPathUnder(resolved, rootDir)) return true;
  const tasks = db.getTasks();
  for (const t of tasks) {
    if (t.folder_path && isPathUnder(resolved, t.folder_path)) return true;
  }
  return false;
}

// asyncHandler 包装器
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('路由错误:', err);
      res.status(500).json({ error: err.message || '服务器错误' });
    });
  };
}

// AI 配置 JSON 文件路径
const AI_CONFIG_FILE = path.join(__dirname, '..', 'data', 'ai-config.json');

function readAIConfig() {
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) { console.error('读取 AI 配置失败:', e.message); }
  return { activeConfig: 0, configs: [] };
}

function writeAIConfig(data) {
  try {
    fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('写入 AI 配置失败:', e.message);
  }
}

// 设置键白名单（ai_configs/ai_active_config 存储在 data/ai-config.json，不经过 DB）
const ALLOWED_SETTINGS = [
  'root_dir', 'folder_format', 'auto_create_folder',
  'terminal_path', 'editor',
];

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'data', 'uploads')));

// 文件上传配置
const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    // 保留中文/Unicode 文件名，仅替换 Windows/Unix 非法字符
    // 之前 [^\w.\-] 会把中文全部替换成 _，导致 报告.docx → _.docx
    const safe = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const uniqueName = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safe;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ==================== Settings ====================

app.get('/api/settings', (req, res) => {
  const settings = db.getAllSettings();
  const aiCfg = readAIConfig();
  settings.ai_configs = aiCfg.configs;
  settings.ai_active_config = aiCfg.activeConfig;
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  // AI 配置写入 JSON 文件
  if (req.body.ai_configs !== undefined || req.body.ai_active_config !== undefined) {
    const aiCfg = readAIConfig();
    if (req.body.ai_configs !== undefined) aiCfg.configs = req.body.ai_configs;
    if (req.body.ai_active_config !== undefined) aiCfg.activeConfig = req.body.ai_active_config;
    writeAIConfig(aiCfg);
  }
  // 其他设置写入数据库
  for (const [key, value] of Object.entries(req.body)) {
    if (key !== 'ai_configs' && ALLOWED_SETTINGS.includes(key)) {
      // 路径类设置统一 normalize，避免混合分隔符（C:\foo vs C:/foo）造成后续匹配失败
      let finalValue = value;
      if ((key === 'root_dir' || key === 'terminal_path' || key === 'editor') && typeof value === 'string' && value.trim()) {
        finalValue = path.normalize(value);
      }
      db.setSetting(key, finalValue);
    }
  }
  res.json({ success: true });
});

// ==================== Goals ====================

app.get('/api/goals', (req, res) => res.json(db.getGoals()));

app.post('/api/goals', (req, res) => {
  const g = db.createGoal(req.body);
  res.json({ id: g.id });
});

app.put('/api/goals/:id', (req, res) => {
  db.updateGoal(Number(req.params.id), req.body);
  res.json({ success: true });
});

app.delete('/api/goals/:id', (req, res) => {
  db.deleteGoal(Number(req.params.id));
  res.json({ success: true });
});

// ==================== Routines ====================

app.get('/api/routines', (req, res) => res.json(db.getRoutines()));

app.post('/api/routines', (req, res) => {
  const r = db.createRoutine(req.body);
  res.json({ id: r.id });
});

app.put('/api/routines/:id', (req, res) => {
  db.updateRoutine(Number(req.params.id), req.body);
  res.json({ success: true });
});

app.delete('/api/routines/:id', (req, res) => {
  db.deleteRoutine(Number(req.params.id));
  res.json({ success: true });
});

// ==================== Tasks ====================

app.get('/api/tasks', (req, res) => res.json(db.getTasks(req.query)));

app.get('/api/tasks/today', (req, res) => {
  res.json(db.getTodayTasks());
});

app.get('/api/time-heatmap', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 365, 30), 730);
  res.json(db.getTimeHeatmap(days));
});

// AI 时间估算校准 + 建议
app.post('/api/tasks/:id/suggest-time', asyncHandler(async (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });

  // 收集历史已完成任务（有 estimated + actual）
  const allTasks = db.getTasks({});
  const history = allTasks
    .filter(t => t.id !== task.id && t.status === 'done' && t.estimated_time > 0 && t.actual_time > 0)
    .slice(0, 50)
    .map(t => ({
      title: t.title,
      estimated: t.estimated_time,
      actual: t.actual_time,
      ratio: t.actual_time / t.estimated_time,
    }));

  // 统计校准
  let calibration = null;
  if (history.length > 0) {
    const ratios = history.map(h => h.ratio).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    calibration = {
      count: history.length,
      medianRatio: Math.round(median * 100) / 100,
      avgRatio: Math.round(avg * 100) / 100,
      trend: avg > 1.15 ? 'underestimate' : (avg < 0.85 ? 'overestimate' : 'accurate'),
    };
  }

  // AI 建议
  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig];
  if (!cfg || !cfg.base_url || !cfg.model) {
    return res.json({ calibration, suggestion: null, error: '请先配置 AI 模型' });
  }

  const historyText = history.length > 0
    ? `\n历史任务样本（${history.length} 条）：\n${history.slice(0, 15).map(h => `- "${h.title}": 预估${h.estimated}分 → 实际${h.actual}分`).join('\n')}\n用户整体偏差：实际/预估 = ${calibration.avgRatio}（${calibration.trend === 'underestimate' ? '习惯低估' : calibration.trend === 'overestimate' ? '习惯高估' : '估算准确'}）`
    : '\n暂无历史数据';

  const prompt = `请为以下任务估算合理的预估工时（分钟）：

任务标题：${task.title}
描述：${task.description || '（无）'}
背景：${task.context || '（无）'}
当前预估：${task.estimated_time || 0} 分钟
${historyText}

要求：
- 返回一个整数分钟数（常见值：30、60、90、120、180、240、480）
- 综合考虑任务复杂度 + 用户历史估算偏差（如低估，适当上调）
- 直接返回数字，不要单位，不要解释文字`;

  try {
    const result = await aiChatSync(cfg, [
      { role: 'system', content: '你是项目管理助手。基于任务信息和用户历史偏差，给出合理的工时估算（分钟）。只返回纯数字，不要任何其他文字。' },
      { role: 'user', content: prompt },
    ]);
    const cleaned = result.trim().replace(/[^\d]/g, '');
    const minutes = parseInt(cleaned, 10);
    if (isNaN(minutes) || minutes <= 0) {
      return res.json({ calibration, suggestion: null, error: 'AI 返回格式无法解析' });
    }
    res.json({
      calibration,
      suggestion: Math.min(Math.max(minutes, 5), 2880), // 5 分 ~ 2 个工作日
    });
  } catch (e) {
    res.json({ calibration, suggestion: null, error: e.message });
  }
}));

app.get('/api/daily-briefing', asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const allTasks = db.getTasks({});
  const todayDue = allTasks.filter(t => t.due_date === today && t.status !== 'done');
  const inProgress = allTasks.filter(t => t.status === 'in-progress');
  const shelved = allTasks.filter(t => t.status === 'shelved' && t.updated_at && new Date(t.updated_at) < weekAgo);
  const overdue = allTasks.filter(t => t.due_date && t.due_date < today && t.status !== 'done' && t.status !== 'shelved');
  const todayDone = allTasks.filter(t => t.status === 'done' && t.updated_at && t.updated_at.slice(0, 10) === today);
  const heatmap = db.getTimeHeatmap(1);
  const todayMinutes = (heatmap[0] || {}).minutes || 0;

  const data = {
    date: today,
    stats: {
      todayDueCount: todayDue.length,
      todayDueTitles: todayDue.slice(0, 5).map(t => t.title),
      inProgressCount: inProgress.length,
      inProgressTitles: inProgress.slice(0, 5).map(t => t.title),
      shelvedCount: shelved.length,
      overdueCount: overdue.length,
      todayDoneCount: todayDone.length,
      todayMinutes,
    },
    aiBriefing: null,
    aiError: null,
  };

  // 模板兜底（即使没 AI 配置也有内容）
  const s = data.stats;
  const lines = [];
  if (s.todayDueCount > 0) lines.push(`📌 今日截止 ${s.todayDueCount} 项：${s.todayDueTitles.join('、')}`);
  if (s.overdueCount > 0) lines.push(`⚠️ 已逾期 ${s.overdueCount} 项，建议优先处理`);
  if (s.inProgressCount > 0) lines.push(`🚧 进行中 ${s.inProgressCount} 项：${s.inProgressTitles.join('、')}`);
  if (s.shelvedCount > 0) lines.push(`💤 搁置超 7 天 ${s.shelvedCount} 项，可考虑重新激活或归档`);
  if (s.todayDoneCount > 0) lines.push(`✅ 今日已完成 ${s.todayDoneCount} 项`);
  if (s.todayMinutes > 0) lines.push(`⏱️ 今日已计时 ${Math.round(s.todayMinutes)} 分钟`);
  if (lines.length === 0) lines.push('🌅 今日无截止任务，可以利用空档推进长期目标或学习');
  data.summary = lines.join('\n');

  // AI 增强（仅 force=true 时调用，避免每次进 dashboard 都消耗 token）
  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig];
  if (force && cfg && cfg.base_url && cfg.model) {
    try {
      const prompt = `今天是 ${today}。请基于以下工作数据生成简洁的中文每日简报（3-5 句话，有重点，结尾一句鼓励）：

${data.summary}

格式：
1. 今日重点：最紧急的 1-3 件事
2. 提醒：如果有逾期/搁置的潜在风险
3. 一句话激励`;
      const result = await aiChatSync(cfg, [
        { role: 'system', content: '你是一个高效的工作教练。用中文写每日简报，简洁、有洞察、不啰嗦。' },
        { role: 'user', content: prompt },
      ]);
      data.aiBriefing = result.trim();
    } catch (e) {
      data.aiError = e.message;
    }
  }

  res.json(data);
}));

app.get('/api/tasks/:id', (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  const data = req.body;
  const task = db.createTask(data);

  // 创建文件夹
  if (data.create_folder !== false) {
    const folderName = data.folder_name || null;
    const folderPath = fm.createTaskFolder(task.id, task.title, folderName);
    db.updateTask(task.id, { folder_path: folderPath });
    // 写 README
    const updated = db.getTask(task.id);
    fm.writeTaskReadme(updated, db.getGoals(), db.getRoutines(), db.getTags());
  }

  res.json({ id: task.id });
});

// 为已有任务创建目录（延迟创建）
app.post('/api/tasks/:id/create-folder', asyncHandler(async (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.folder_path) return res.status(400).json({ error: '任务已有目录' });

  const folderName = req.body.folder_name || null;
  const folderPath = fm.createTaskFolder(task.id, task.title, folderName);
  db.updateTask(task.id, { folder_path: folderPath });
  const updated = db.getTask(task.id);
  fm.writeTaskReadme(updated, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true, folder_path: folderPath });
}));

// 取消任务目录关联（不删除实际目录）
app.post('/api/tasks/:id/unlink-folder', asyncHandler(async (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  db.updateTask(task.id, { folder_path: '' });
  res.json({ success: true });
}));

app.put('/api/tasks/:id', (req, res) => {
  db.updateTask(Number(req.params.id), req.body);
  // 更新 README
  const task = db.getTask(Number(req.params.id));
  if (task && task.folder_path) {
    fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  }
  res.json({ success: true });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.deleteTask(Number(req.params.id));
  res.json({ success: true });
});

// ==================== 批量导入 ====================

// 预览：扫描目录，返回可导入的任务列表（不实际导入）
app.post('/api/import/scan', asyncHandler(async (req, res) => {
  const { directory } = req.body;
  if (!directory || !fs.existsSync(directory)) {
    return res.status(400).json({ error: '目录不存在' });
  }
  if (!isPathAllowed(directory)) {
    return res.status(403).json({ error: '目录不在允许范围内' });
  }
  const items = fm.scanDirectories(directory);
  // 标记已有任务（通过 folder_path 匹配）
  const existingFolders = new Set(db.getTasks().map(t => t.folder_path).filter(Boolean));
  items.forEach(item => {
    item.already_exists = existingFolders.has(item.folder_path);
  });
  res.json(items);
}));

// 执行导入
app.post('/api/import/execute', (req, res) => {
  const { items } = req.body; // [{title, description, context, status, goal, routine, tags, people, due_date, folder_path, ...}]
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '没有可导入的任务' });
  }

  const goals = db.getGoals();
  const routines = db.getRoutines();
  const tags = db.getTags();
  const imported = [];

  for (const item of items) {
    // 匹配目标
    let goal_id = null;
    if (item.goal) {
      const g = goals.find(x => x.name === item.goal);
      if (g) goal_id = g.id;
    }

    // 匹配惯例
    let routine_id = null;
    if (item.routine) {
      const r = routines.find(x => x.name === item.routine);
      if (r) routine_id = r.id;
    }

    // 匹配标签
    const tag_ids = [];
    if (Array.isArray(item.tags)) {
      for (const tagName of item.tags) {
        const t = tags.find(x => x.name === tagName);
        if (t) tag_ids.push(t.id);
      }
    }

    const task = db.createTask({
      title: item.title,
      description: item.description || '',
      context: item.context || '',
      status: item.status || 'todo',
      goal_id,
      routine_id,
      tag_ids,
      people: item.people || [],
      due_date: item.due_date || null,
      estimated_time: item.estimated_time || 0,
      create_folder: false, // 已有目录
    });

    // 关联已有目录
    db.updateTask(task.id, { folder_path: item.folder_path });

    // 写 README（如果没有的话）或更新
    const fullTask = db.getTask(task.id);
    fm.writeTaskReadme(fullTask, goals, routines, tags);

    imported.push({ id: task.id, title: task.title });
  }

  res.json({ imported, count: imported.length });
});

// ==================== Tags ====================

app.get('/api/tags', (req, res) => res.json(db.getTags()));

app.post('/api/tags', (req, res) => {
  const t = db.createTag(req.body);
  res.json({ id: t.id });
});

app.put('/api/tags/:id', (req, res) => {
  db.updateTag(Number(req.params.id), req.body);
  res.json({ success: true });
});

app.delete('/api/tags/:id', (req, res) => {
  db.deleteTag(Number(req.params.id));
  res.json({ success: true });
});

app.put('/api/tasks/:id/tags', (req, res) => {
  db.setTaskTags(Number(req.params.id), req.body.tag_ids || []);
  const task = db.getTask(Number(req.params.id));
  if (task?.folder_path) fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true });
});

// 扫描任务目录中的文件
app.get('/api/tasks/:id/files', asyncHandler(async (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task || !task.folder_path) return res.json([]);
  const folderPath = task.folder_path;
  if (!fs.existsSync(folderPath)) return res.json([]);

  const files = [];
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'README.md') continue;
    const fullPath = path.join(folderPath, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch (e) {}
  }
  res.json(files);
}));

// ==================== People ====================

app.get('/api/people', (req, res) => res.json(db.getAllPeople()));

app.put('/api/tasks/:id/people', (req, res) => {
  db.setTaskPeople(Number(req.params.id), req.body.people || []);
  const task = db.getTask(Number(req.params.id));
  if (task?.folder_path) fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true });
});

// ==================== 通用文件上传 ====================

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ success: true, url, filename: req.file.originalname });
});

// ==================== Attachments ====================

app.post('/api/tasks/:id/attachments', upload.array('files', 20), (req, res) => {
  const taskId = Number(req.params.id);
  const task = db.getTask(taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  let taskFolder = task.folder_path;
  if (!taskFolder) {
    taskFolder = fm.createTaskFolder(taskId, task.title);
    db.updateTask(taskId, { folder_path: taskFolder });
  }

  const attachments = [];
  for (const file of (req.files || [])) {
    const info = fm.saveAttachment(taskFolder, file);
    const att = db.addAttachment(taskId, info.fileName, info.filePath, info.fileType, info.fileSize);
    if (att) attachments.push(att);
  }

  res.json({ attachments });
});

app.delete('/api/attachments/:id', (req, res) => {
  db.deleteAttachment(Number(req.params.id));
  res.json({ success: true });
});

// 通用：按路径打开文件夹（安全校验）
app.post('/api/open-folder', asyncHandler(async (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: '缺少 path 参数' });
  if (!isPathAllowed(folderPath)) return res.status(403).json({ error: '路径不在允许范围内' });
  fm.openFolder(folderPath);
  res.json({ success: true });
}));

// 检查路径下是否有 README.md
app.get('/api/paths/check-readme', asyncHandler(async (req, res) => {
  const { path: dirPath } = req.query;
  if (!dirPath) return res.status(400).json({ error: '缺少 path 参数' });
  if (!isPathAllowed(dirPath)) return res.status(403).json({ error: '路径不在允许范围内' });
  const readmePath = require('path').join(dirPath, 'README.md');
  const parsed = fm.parseReadme(readmePath);
  res.json(parsed ? { exists: true, ...parsed } : { exists: false });
}));

app.post('/api/tasks/:id/open-folder', (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });

  let folderPath = task.folder_path;
  if (!folderPath) {
    folderPath = fm.createTaskFolder(Number(req.params.id), task.title);
    db.updateTask(Number(req.params.id), { folder_path: folderPath });
  }

  fm.openFolder(folderPath);
  res.json({ success: true });
});

// 用指定编辑器打开任务目录或文件
// 短名编辑器白名单（用户在设置里可填短名 OR 完整 .exe 路径）
const ALLOWED_EDITORS = ['obsidian', 'typora', 'vscode', 'code', 'sublime', 'textedit', 'terminal'];

// 判断 editor 输入是否为完整可执行路径（含路径分隔符）
function isEditorPath(editor) {
  return /[\\/]/.test(editor);
}

app.post('/api/open-with-editor', asyncHandler(async (req, res) => {
  const { path: targetPath, editor } = req.body;
  if (!targetPath) return res.status(400).json({ error: '缺少 path 参数' });
  if (!isPathAllowed(targetPath)) return res.status(403).json({ error: '路径不在允许范围内' });

  const rawEditor = (editor || '').trim();
  if (!rawEditor) return res.status(400).json({ error: '缺少 editor 参数' });

  // 双模式校验：
  //   - 短名（如 obsidian/vscode）必须在白名单
  //   - 完整路径（含 / 或 \）允许，但必须文件存在（防止注入）
  const safeEditor = rawEditor.toLowerCase();
  if (!isEditorPath(rawEditor) && !ALLOWED_EDITORS.includes(safeEditor)) {
    return res.status(400).json({ error: '不支持的编辑器: ' + editor });
  }
  if (isEditorPath(rawEditor) && !fs.existsSync(rawEditor)) {
    return res.status(400).json({ error: '编辑器路径不存在: ' + editor });
  }

  // 确保文件存在
  if (!fs.existsSync(targetPath)) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, '', 'utf-8');
  }

  // 如果是目录，优先打开里面的 README.md；如果是文件直接用它
  let fileToOpen;
  if (fs.statSync(targetPath).isDirectory()) {
    const readmePath = path.join(targetPath, 'README.md');
    fileToOpen = fs.existsSync(readmePath) ? readmePath : targetPath;
  } else {
    fileToOpen = targetPath;
  }

  const platform = process.platform;
  let spawnArgs = null; // [cmd, args[], opts]

  if (platform === 'win32') {
    if (isEditorPath(rawEditor)) {
      // 用户配置了完整 .exe 路径，直接 spawn
      spawnArgs = [rawEditor, [fileToOpen], { detached: true, stdio: 'ignore' }];
    } else if (safeEditor === 'vscode' || safeEditor === 'code') {
      // code 命令依赖 PATH（VSCode 安装时勾选），shell:true 让 Windows 找 .cmd
      spawnArgs = ['code', [fileToOpen], { detached: true, stdio: 'ignore', shell: true }];
    } else if (safeEditor === 'obsidian') {
      const dir = path.dirname(fileToOpen);
      spawnArgs = ['cmd', ['/c', 'start', '', `obsidian://open?path=${encodeURIComponent(dir)}`], { detached: true, stdio: 'ignore' }];
    } else {
      // 其余短名（typora/sublime/textedit）用系统关联打开（Windows 无 textedit）
      spawnArgs = ['cmd', ['/c', 'start', '', fileToOpen], { detached: true, stdio: 'ignore' }];
    }
  } else if (platform === 'darwin') {
    const appName = {
      typora: 'Typora',
      vscode: 'Visual Studio Code',
      code: 'Visual Studio Code',
      sublime: 'Sublime Text',
      textedit: 'TextEdit',
    }[safeEditor];

    if (isEditorPath(rawEditor)) {
      spawnArgs = [rawEditor, [fileToOpen], { detached: true, stdio: 'ignore' }];
    } else if (safeEditor === 'obsidian') {
      // Obsidian 走目录而非 README 文件
      spawnArgs = ['open', ['-a', 'Obsidian', path.dirname(fileToOpen)], { detached: true, stdio: 'ignore' }];
    } else if (appName) {
      spawnArgs = ['open', ['-a', appName, fileToOpen], { detached: true, stdio: 'ignore' }];
    } else {
      spawnArgs = ['open', [fileToOpen], { detached: true, stdio: 'ignore' }];
    }
  } else {
    // Linux
    if (isEditorPath(rawEditor)) {
      spawnArgs = [rawEditor, [fileToOpen], { detached: true, stdio: 'ignore' }];
    } else if (safeEditor === 'vscode' || safeEditor === 'code') {
      spawnArgs = ['code', [fileToOpen], { detached: true, stdio: 'ignore' }];
    } else {
      spawnArgs = ['xdg-open', [fileToOpen], { detached: true, stdio: 'ignore' }];
    }
  }

  try {
    const [cmd, args, opts] = spawnArgs;
    const child = spawn(cmd, args, opts);
    child.on('error', (e) => console.error(`[open-with-editor] spawn error: ${cmd}:`, e.message));
    child.unref();
  } catch (e) {
    return sendPlatformError(res, 'open-with-editor', e);
  }
  res.json({ success: true });
}));

// 追加内容到任务 README
app.post('/api/tasks/:id/append-readme', asyncHandler(async (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });

  if (!task.folder_path) {
    const folderPath = fm.createTaskFolder(Number(req.params.id), task.title);
    db.updateTask(Number(req.params.id), { folder_path: folderPath });
    task.folder_path = folderPath;
    // 首次创建写 README
    const updated = db.getTask(Number(req.params.id));
    fm.writeTaskReadme(updated, db.getGoals(), db.getRoutines(), db.getTags());
  }

  const readmePath = require('path').join(task.folder_path, 'README.md');
  const text = req.body.text || '';
  const now = new Date().toLocaleString('zh-CN');

  let content = '';
  if (fs.existsSync(readmePath)) {
    content = fs.readFileSync(readmePath, 'utf-8');
  }

  // 在末尾追加，带时间戳
  const appendBlock = `\n\n> 📝 ${now}\n${text}\n`;
  fs.writeFileSync(readmePath, content + appendBlock, 'utf-8');

  // 同步更新 foldermatter（updated_at）
  fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true });
}));

// 异步执行 PowerShell 脚本，捕获 stdout（不阻塞 Node 主线程）
// 返回 { ok, stdout, stderr, error }
function runPowerShell(script) {
  return new Promise((resolve) => {
    const shell = findPowerShell();
    if (!shell) {
      return resolve({ ok: false, error: '未找到 pwsh.exe 或 powershell.exe' });
    }
    const child = spawn(shell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-OutputFormat', 'Text',
      '-EncodedCommand', encodePSScript(script),
    ], { windowsHide: false });
    let stdout = '', stderr = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => done({ ok: false, stdout, stderr, error: e.message }));
    child.on('close', (code) => {
      // 退出码非 0 通常是用户取消对话框，视为 cancelled 而非错误
      done({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), error: code !== 0 ? `exit=${code}` : null });
    });
    setTimeout(() => {
      try { child.kill(); } catch (_) {}
      done({ ok: false, stdout, stderr, error: 'PowerShell 60s 超时' });
    }, 60000).unref();
  });
}

// 系统原生文件夹选择器（macOS Finder / Windows / Linux）
app.post('/api/pick-folder', asyncHandler(async (req, res) => {
  const platform = process.platform;
  if (platform === 'darwin') {
    try {
      const folderPath = execSync(`osascript -e 'choose folder' -e 'POSIX path of result'`, { encoding: 'utf-8', timeout: 60000 }).trim();
      if (!folderPath) return res.json({ cancelled: true });
      return res.json({ path: folderPath });
    } catch (e) {
      return res.json({ cancelled: true });
    }
  } else if (platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = '选择任务根目录'
if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`;
    const r = await runPowerShell(script);
    if (!r.ok) {
      // 用户取消 / 超时 / 无 PowerShell 一律视为 cancelled（前端不需区分）
      if (r.error && r.error.includes('未找到')) return sendPlatformError(res, 'pick-folder', r.error);
      return res.json({ cancelled: true });
    }
    if (!r.stdout) return res.json({ cancelled: true });
    return res.json({ path: r.stdout });
  } else {
    try {
      const folderPath = execSync('zenity --file-selection --directory 2>/dev/null || echo ""', { encoding: 'utf-8', timeout: 60000 }).trim();
      if (!folderPath) return res.json({ cancelled: true });
      return res.json({ path: folderPath });
    } catch (e) {
      return res.json({ cancelled: true });
    }
  }
}));

app.post('/api/pick-file', asyncHandler(async (req, res) => {
  const platform = process.platform;
  const filter = req.body?.filter || 'exec'; // 'exec' (默认) | 'any'
  if (platform === 'darwin') {
    try {
      const filePath = execSync(`osascript -e 'choose file' -e 'POSIX path of result'`, { encoding: 'utf-8', timeout: 60000 }).trim();
      if (!filePath) return res.json({ cancelled: true });
      return res.json({ path: filePath });
    } catch (e) {
      return res.json({ cancelled: true });
    }
  } else if (platform === 'win32') {
    // 过滤器包含 .lnk 快捷方式（Windows 用户常通过快捷方式启动应用）
    const filterLine = filter === 'any'
      ? "所有文件 (*.*)|*.*"
      : "可执行/快捷方式 (*.exe;*.bat;*.cmd;*.lnk)|*.exe;*.bat;*.cmd;*.lnk|所有文件 (*.*)|*.*";
    const script = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = '${filterLine}'
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }`;
    const r = await runPowerShell(script);
    if (!r.ok) {
      if (r.error && r.error.includes('未找到')) return sendPlatformError(res, 'pick-file', r.error);
      return res.json({ cancelled: true });
    }
    if (!r.stdout) return res.json({ cancelled: true });
    return res.json({ path: r.stdout });
  } else {
    try {
      const filePath = execSync('zenity --file-selection 2>/dev/null || echo ""', { encoding: 'utf-8', timeout: 60000 }).trim();
      if (!filePath) return res.json({ cancelled: true });
      return res.json({ path: filePath });
    } catch (e) {
      return res.json({ cancelled: true });
    }
  }
}));

app.post('/api/attachments/open', asyncHandler(async (req, res) => {
  const filePath = req.body.file_path;
  if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
  if (!isPathAllowed(filePath)) return res.status(403).json({ error: '路径不在允许范围内' });
  fm.openFile(filePath);
  res.json({ success: true });
}));

// ==================== Time Logs ====================

app.post('/api/tasks/:id/time-logs', (req, res) => {
  // Number() 强转，防止前端传字符串导致 actual_time 累加时变成字符串拼接
  const duration = Number(req.body.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return res.status(400).json({ error: '时长必须是正数' });
  }
  db.addTimeLog(Number(req.params.id), duration, req.body.note);
  res.json({ success: true });
});

// ==================== Contacts ====================

app.get('/api/contacts', (req, res) => res.json(db.getContacts()));

app.post('/api/contacts', (req, res) => {
  const c = db.createContact(req.body);
  res.json({ id: c.id });
});

app.put('/api/contacts/:id', (req, res) => {
  db.updateContact(Number(req.params.id), req.body);
  res.json({ success: true });
});

app.delete('/api/contacts/:id', (req, res) => {
  db.deleteContact(Number(req.params.id));
  res.json({ success: true });
});

// ==================== Subtasks ====================

app.get('/api/tasks/:id/subtasks', (req, res) => {
  res.json(db.getSubtasks(Number(req.params.id)));
});

app.post('/api/tasks/:id/subtasks', (req, res) => {
  const s = db.createSubtask(Number(req.params.id), req.body);
  const task = db.getTask(Number(req.params.id));
  if (task?.folder_path) fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json(s);
});

app.put('/api/subtasks/:id', (req, res) => {
  const id = Number(req.params.id);
  // 完成前检查依赖项是否已完成
  if (req.body.status === 'done') {
    const check = db.canCompleteSubtask(id);
    if (!check.ok) {
      return res.status(400).json({
        error: `请先完成依赖项：${check.blockedBy.title}`,
        blockedBy: check.blockedBy,
      });
    }
  }
  db.updateSubtask(id, req.body);
  res.json({ success: true });
});

app.delete('/api/subtasks/:id', (req, res) => {
  db.deleteSubtask(Number(req.params.id));
  res.json({ success: true });
});

// ==================== Timer ====================

app.post('/api/tasks/:id/timer/start', (req, res) => {
  db.startTimer(Number(req.params.id));
  const task = db.getTask(Number(req.params.id));
  if (task?.folder_path) fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true });
});

app.post('/api/tasks/:id/timer/stop', (req, res) => {
  const minutes = db.stopTimer(Number(req.params.id));
  const task = db.getTask(Number(req.params.id));
  if (task?.folder_path) fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true, minutes });
});

app.get('/api/timers/active', (req, res) => {
  res.json(db.getActiveTimers());
});

// ==================== Today ====================

app.post('/api/tasks/:id/toggle-today', (req, res) => {
  db.toggleToday(Number(req.params.id));
  const task = db.getTask(Number(req.params.id));
  if (task?.folder_path) fm.writeTaskReadme(task, db.getGoals(), db.getRoutines(), db.getTags());
  res.json({ success: true });
});

// ==================== AI Subtask Decompose ====================

app.post('/api/ai/decompose', (req, res) => {
  const { title, description, context } = req.body;

  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig] || null;

  if (!cfg || !cfg.base_url || !cfg.model) {
    return res.status(400).json({ error: '请先配置 AI 模型' });
  }

  const prompt = `你是一个项目管理专家。请将以下任务拆解为3-7个具体的子阶段，每个子阶段用一行表示。
任务标题：${title}
任务描述：${description || '无'}
背景：${context || '无'}

请直接输出子阶段列表，每行一个，不要编号，不要其他内容。`;

  const isHttps = cfg.base_url.toLowerCase().startsWith('https');
  const requester = isHttps ? https : http;

  const baseEndpoint = cfg.base_url.replace(/\/+$/, '');
  let postData, options;
  if (cfg.provider === 'anthropic') {
    const fullUrl = baseEndpoint.endsWith('/v1') ? baseEndpoint + '/messages' : baseEndpoint + '/v1/messages';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, stream: false });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' },
    };
  } else {
    const fullUrl = baseEndpoint.endsWith('/v1') ? baseEndpoint + '/chat/completions' : baseEndpoint + '/v1/chat/completions';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, stream: false });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Authorization': `Bearer ${cfg.api_key}` },
    };
  }
  if (cfg.x_token) { options.headers['X-Token'] = cfg.x_token; options.headers['x-auth-token'] = cfg.x_token; }

  const proxyReq = requester.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      if (proxyRes.statusCode >= 400) {
        let errMsg = `AI 服务返回 ${proxyRes.statusCode}`;
        try { const e = JSON.parse(body); errMsg = e.error?.message || e.message || e.error || errMsg; } catch (_) {}
        return res.status(502).json({ error: errMsg });
      }
      try {
        const json = JSON.parse(body);
        let text = '';
        if (cfg.provider === 'anthropic') {
          text = json.content?.[0]?.text || (typeof json.content === 'string' ? json.content : '') || '';
        } else {
          text = json.content || json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '';
        }
        const subtasks = text.split('\n').map(s => s.replace(/^[\d.\-*]+\s*/, '').trim()).filter(s => s.length > 0);
        res.json({ subtasks });
      } catch (e) {
        res.status(502).json({ error: 'AI 解析失败' });
      }
    });
  });
  proxyReq.on('error', (err) => res.status(502).json({ error: 'AI 连接失败' }));
  proxyReq.write(postData);
  proxyReq.end();
});

app.post('/api/ai/enrich', (req, res) => {
  const { title, description } = req.body;
  const input = description || title;
  if (!input) return res.json({});

  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig] || null;
  if (!cfg || !cfg.base_url || !cfg.model) return res.json({});

  const allGoals = db.getGoals();
  const allTags = db.getTags();
  const goalList = allGoals.map(g => g.name).join('、') || '无';
  const tagList = allTags.map(t => t.name).join('、') || '无';

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `你是一个项目管理助手。请根据用户输入，给出以下建议（JSON格式）：
用户输入（任务描述）：${input}
今天的日期：${today}
可选目标：${goalList}
可选标签：${tagList}

首先，从用户输入中提取一个简洁的任务标题（10字以内）。
然后识别用户提到的截止时间（如"明天"、"下周一"、"3天后"、"月底"等自然语言），换算成具体日期（YYYY-MM-DD 格式）。如果没有明确截止时间则留空。
然后从可选标签中选出所有相关的标签（必须从可选标签里选，名字完全一致）。注意：「今日必做」表示当天要做的任务（描述中包含"今天"、"马上"、"立即"等急迫语义时选）；「汇报」表示这是要向上级或会议汇报的内容。如果没有任何匹配的标签，返回空数组。
然后严格返回以下JSON格式（不要其他内容）：
{
  "title": "简洁的任务标题（10字以内）",
  "description": "任务描述（1-2句话）",
  "estimated_time": 预估分钟数（整数）,
  "due_date": "YYYY-MM-DD 或留空",
  "goal": "最匹配的目标名称（从可选目标中选，不确定则留空）",
  "tags": ["匹配的标签名，可多个，名字必须与可选标签完全一致"],
  "subtasks": ["子任务1", "子任务2", "子任务3"],
  "folder_name": "简短的英文/拼音文件夹名（如 feature-analysis, api-refactor，10字符以内）"
}`;

  const isHttps = cfg.base_url.toLowerCase().startsWith('https');
  const requester = isHttps ? https : http;

  const baseEndpoint2 = cfg.base_url.replace(/\/+$/, '');
  let postData, options;
  if (cfg.provider === 'anthropic') {
    const fullUrl = baseEndpoint2.endsWith('/v1') ? baseEndpoint2 + '/messages' : baseEndpoint2 + '/v1/messages';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, stream: false });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' },
    };
  } else {
    const fullUrl = baseEndpoint2.endsWith('/v1') ? baseEndpoint2 + '/chat/completions' : baseEndpoint2 + '/v1/chat/completions';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, stream: false });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Authorization': `Bearer ${cfg.api_key}` },
    };
  }
  if (cfg.x_token) { options.headers['X-Token'] = cfg.x_token; options.headers['x-auth-token'] = cfg.x_token; }

  const proxyReq = requester.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      if (proxyRes.statusCode >= 400) {
        let errMsg = `AI 服务返回 ${proxyRes.statusCode}`;
        try { const e = JSON.parse(body); errMsg = e.error?.message || e.message || e.error || errMsg; } catch (_) {}
        return res.status(502).json({ error: errMsg });
      }
      try {
        const json = JSON.parse(body);
        let text = '';
        if (cfg.provider === 'anthropic') {
          text = json.content?.[0]?.text || (typeof json.content === 'string' ? json.content : '') || '';
        } else {
          text = json.content || json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '';
        }
        // Extract JSON from response (may have markdown wrapping)
        let cleanText = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return res.json({});
        const parsed = JSON.parse(jsonMatch[0]);

        // 字段校验和类型转换 —— AI 可能返回意外类型（字符串 vs 数字、null、缺字段）
        const result = {
          title: typeof parsed.title === 'string' ? parsed.title.slice(0, 100) : '',
          description: typeof parsed.description === 'string' ? parsed.description.slice(0, 500) : '',
          estimated_time: Math.max(0, Math.min(60 * 24 * 7, Number(parsed.estimated_time) || 0)),
          folder_name: typeof parsed.folder_name === 'string' ? parsed.folder_name.replace(/[^\w\-]/g, '').slice(0, 30) : '',
          subtasks: Array.isArray(parsed.subtasks)
            ? parsed.subtasks.filter(s => typeof s === 'string' && s.trim()).slice(0, 10)
            : [],
        };
        // due_date 校验：必须是 YYYY-MM-DD 格式的合法日期
        if (parsed.due_date && typeof parsed.due_date === 'string') {
          const m = parsed.due_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (m) {
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            if (!isNaN(d.getTime()) && d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) {
              result.due_date = parsed.due_date;
            }
          }
        }
        if (parsed.goal && typeof parsed.goal === 'string') {
          const g = allGoals.find(g => g.name === parsed.goal);
          if (g) result.goal_id = g.id;
        }
        if (Array.isArray(parsed.tags)) {
          const ids = parsed.tags
            .map(name => { const t = allTags.find(t => t.name === String(name)); return t ? t.id : null; })
            .filter(Boolean);
          if (ids.length) result.tag_ids = ids;
        }

        res.json(result);
      } catch (e) {
        res.json({});
      }
    });
  });
  proxyReq.on('error', () => res.json({}));
  proxyReq.write(postData);
  proxyReq.end();
});

// ==================== Backup ====================

app.get('/api/backup', (req, res) => {
  const dbPath = path.join(__dirname, '..', 'data', 'godtodo.db');
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: '数据库文件不存在' });
  res.download(dbPath, `godtodo-backup-${new Date().toISOString().slice(0,10)}.db`);
});

app.post('/api/restore', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择备份文件' });
  const dbPath = path.join(__dirname, '..', 'data', 'godtodo.db');
  // 先备份当前数据库
  if (fs.existsSync(dbPath)) {
    const backupPath = dbPath + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try { fs.copyFileSync(dbPath, backupPath); } catch (e) { console.error('备份当前数据库失败:', e.message); }
  }
  try {
    fs.copyFileSync(req.file.path, dbPath);
    db.reload();
  } catch (e) {
    return res.status(500).json({ error: '恢复失败: ' + e.message });
  }
  try { fs.unlinkSync(req.file.path); } catch (e) {}
  res.json({ success: true, message: '数据库已恢复' });
});

// ==================== Stats ====================

app.get('/api/stats/goals', (req, res) => res.json(db.getGoalStats()));

app.get('/api/stats/time', (req, res) => {
  res.json(db.getTimeStats(parseInt(req.query.days) || 30));
});

app.get('/api/stats/review', (req, res) => {
  res.json(db.getReviewData(req.query.type || 'daily'));
});


// ==================== Launch Terminal / OpenCode ====================

app.post('/api/launch-terminal', asyncHandler(async (req, res) => {
  const { directory } = req.body;
  if (!directory || !fs.existsSync(directory)) {
    return res.status(400).json({ error: '目录不存在' });
  }

  const terminalPath = db.getSetting('terminal_path') || (process.platform === 'win32' ? 'cmd' : 'Terminal');
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // ⚠️ spawn 数组传参，绝不手动加引号（之前的写法会把字面 " 当路径字符）
      if (terminalPath.toLowerCase() === 'cmd') {
        // cmd /c start cmd /d "<dir>"  —— start 启动新 cmd，/d 设置工作目录
        spawn('cmd', ['/c', 'start', 'cmd', '/d', directory], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // 用 path.basename 鲁棒判断 wt（用户可能填完整路径如 C:\Users\xxx\wt.exe）
        const base = path.basename(terminalPath).toLowerCase();
        const isWt = base === 'wt.exe' || base === 'wt';
        if (isWt) {
          // wt.exe -d "<dir>"（直接 spawn wt 即可，无需 cmd /c start）
          spawn(terminalPath, ['-d', directory], { detached: true, stdio: 'ignore' }).unref();
        } else {
          // 其他终端（如 WezTerm/Alacritty/Hyper）：
          // 直接 spawn 终端可执行文件 + cwd 选项，避免 start 命令对含空格路径的分词 bug
          // shell:true 让 Windows 自动处理 PATH 查找和 .exe/.cmd 拓展名
          try {
            const child = spawn(terminalPath, [], {
              cwd: directory,
              detached: true,
              stdio: 'ignore',
              shell: false,
            });
            child.on('error', (e) => {
              // spawn 失败（如 terminalPath 不存在或不在 PATH）→ 兜底用 start
              console.error(`[launch-terminal] spawn "${terminalPath}" 失败, 回退 start:`, e.message);
              try {
                spawn('cmd', ['/c', 'start', '', '/d', directory, terminalPath], { detached: true, stdio: 'ignore', shell: true }).unref();
              } catch (_) {}
            });
            child.unref();
          } catch (e) {
            sendPlatformError(res, 'launch-terminal', e);
            return;
          }
        }
      }
    } else if (platform === 'darwin') {
      if (terminalPath && terminalPath !== 'Terminal') {
        // 用户配置了 iTerm2 / Hyper 等
        spawn('open', ['-a', terminalPath, directory], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // 默认 Terminal.app 用 AppleScript 打开新窗口并 cd
        // osascript 字符串内的转义需手动处理（osascript 是 shell 命令）
        const safeDir = directory.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = `tell application "Terminal"\nactivate\ndo script "cd \\"${safeDir}\\" && clear"\nend tell`;
        spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      }
    } else {
      // Linux
      const term = terminalPath === 'Terminal' ? 'x-terminal-emulator' : terminalPath;
      spawn(term, ['--working-directory', directory], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ success: true });
  } catch (err) {
    sendPlatformError(res, 'launch-terminal', err);
  }
}));



// ==================== AI Chat Proxy ====================

const https = require('https');

// OpenAI 兼容协议 (DeepSeek, GLM, 通义千问, Ollama 等)
function proxyOpenAI(baseUrl, model, apiKey, xToken, allMessages, res) {
  const isHttps = baseUrl.toLowerCase().startsWith('https');
  const requester = isHttps ? https : http;

  // 拼接完整 URL，智能处理 baseUrl 中已有的 /v1 路径
  const base = baseUrl.replace(/\/+$/, '');
  const fullUrl = base.endsWith('/v1') ? base + '/chat/completions' : base + '/v1/chat/completions';
  const url = new URL(fullUrl);

  const postData = JSON.stringify({ model, messages: allMessages, stream: true });

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    timeout: 300000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': `Bearer ${apiKey}`,
    },
  };
  if (xToken) { options.headers['X-Token'] = xToken; options.headers['x-auth-token'] = xToken; }

  const proxyReq = requester.request(options, (proxyRes) => {
    // 非 2xx 状态码：收集错误信息直接返回 JSON
    if (proxyRes.statusCode >= 400) {
      let body = '';
      proxyRes.on('data', chunk => { body += chunk.toString(); });
      proxyRes.on('end', () => {
        let errMsg = `AI 服务返回 ${proxyRes.statusCode}`;
        try {
          const parsed = JSON.parse(body);
          errMsg = parsed.error?.message || parsed.message || parsed.error || errMsg;
        } catch (e) {}
        res.status(502).json({ error: errMsg });
      });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('AI Proxy Error:', err);
    res.status(502).json({ error: 'AI 服务连接失败: ' + err.message });
  });
  proxyReq.write(postData);
  proxyReq.end();
}

// Anthropic Claude 协议
function proxyAnthropic(baseUrl, model, apiKey, xToken, allMessages, res) {
  const isHttps = baseUrl.toLowerCase().startsWith('https');
  const requester = isHttps ? https : http;

  // 智能处理 baseUrl 中已有的 /v1 路径
  const base = baseUrl.replace(/\/+$/, '');
  const fullUrl = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages';
  const url = new URL(fullUrl);

  // Anthropic 使用 system 字段而非 system message，合并多条 system 消息
  const systemContent = allMessages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const chatMessages = allMessages.filter(m => m.role !== 'system');

  const postData = JSON.stringify({
    model,
    system: systemContent,
    messages: chatMessages,
    stream: true,
    max_tokens: 4096,
  });

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    timeout: 300000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  };
  if (xToken) { options.headers['X-Token'] = xToken; options.headers['x-auth-token'] = xToken; }

  const proxyReq = requester.request(options, (proxyRes) => {
    // 非 2xx 状态码：收集错误信息直接返回 JSON
    if (proxyRes.statusCode >= 400) {
      let body = '';
      proxyRes.on('data', chunk => { body += chunk.toString(); });
      proxyRes.on('end', () => {
        let errMsg = `AI 服务返回 ${proxyRes.statusCode}`;
        try {
          const parsed = JSON.parse(body);
          errMsg = parsed.error?.message || parsed.message || parsed.error || errMsg;
        } catch (e) {}
        res.status(502).json({ error: errMsg });
      });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 将 Anthropic SSE 格式转换为 OpenAI SSE 格式，前端无需改动
    let buffer = '';
    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留未完成的行

      for (const line of lines) {
        const tl = line.trim();
        if (!tl.startsWith('data:')) continue;
        const raw = tl.substring(tl.indexOf(':') + 1).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            // 转为 OpenAI 格式
            const openaiChunk = { choices: [{ delta: { content: evt.delta.text } }] };
            res.write('data: ' + JSON.stringify(openaiChunk) + '\n\n');
          } else if (evt.type === 'message_stop') {
            res.write('data: [DONE]\n\n');
          }
        } catch (e) { /* skip */ }
      }
    });
    proxyRes.on('end', () => {
      // 处理 buffer 中剩余的数据（可能包含最后的 content_block_delta）
      if (buffer.trim()) {
        const tl = buffer.trim();
        if (tl.startsWith('data:')) {
          const raw = tl.substring(tl.indexOf(':') + 1).trim();
          if (raw && raw !== '[DONE]') {
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'content_block_delta' && evt.delta?.text) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: evt.delta.text } }] })}\n\n`);
              }
              if (evt.type === 'message_stop' || evt.type === 'content_block_delta') {
                res.write('data: [DONE]\n\n');
              }
            } catch (e) {}
          }
        }
      }
      res.end();
    });
  });
  proxyReq.on('error', (err) => {
    console.error('AI Proxy Error:', err);
    res.status(502).json({ error: 'AI 服务连接失败: ' + err.message });
  });
  proxyReq.write(postData);
  proxyReq.end();
}

// 分析任务进展 —— 读取关联目录全部文件内容，让 AI 推理当前进度
app.post('/api/tasks/:id/analyze-progress', asyncHandler(async (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const dirs = [];
  if (task.folder_path) dirs.push(task.folder_path);
  if (task.paths) dirs.push(...task.paths);
  if (dirs.length === 0) return res.json({ progress: '' });

  const MAX_SIZE = 60000; // 总共最多 60KB 内容
  let totalSent = 0;
  const parts = [];
  const binaryExts = new Set(['.png','.jpg','.jpeg','.gif','.ico','.bmp','.svg','.woff','.woff2','.ttf','.eot','.pdf','.zip','.gz','.tar','.db','.sqlite','.wasm','.mp3','.mp4','.mov','.avi']);
  const skipDirs = new Set(['node_modules','.git','target','__pycache__','.venv','venv','dist','build','.next','.nuxt','coverage','.cache']);

  function readAllFiles(dirPath, basePath) {
    if (totalSent >= MAX_SIZE) return;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      // 先读文件，再递归目录
      for (const e of entries) {
        if (totalSent >= MAX_SIZE) return;
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dirPath, e.name);
        const rel = path.relative(basePath, fp);
        if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (binaryExts.has(ext)) continue;
          const size = fs.statSync(fp).size;
          if (size > 100000) continue; // 跳过超大文件
          try {
            const content = fs.readFileSync(fp, 'utf8');
            const maxForFile = Math.min(size, MAX_SIZE - totalSent);
            const text = content.slice(0, maxForFile);
            if (text.trim()) {
              parts.push(`\n=== ${rel} ===\n${text}`);
              totalSent += text.length;
            }
          } catch (e) {}
        }
      }
      for (const e of entries) {
        if (totalSent >= MAX_SIZE) return;
        if (e.name.startsWith('.') || skipDirs.has(e.name)) continue;
        const fp = path.join(dirPath, e.name);
        if (e.isDirectory()) {
          readAllFiles(fp, basePath);
        }
      }
    } catch (e) {}
  }

  for (const dir of dirs) {
    if (totalSent >= MAX_SIZE) break;
    const dirPath = path.resolve(dir);
    if (!fs.existsSync(dirPath)) continue;
    parts.push(`# 目录: ${dirPath}`);
    readAllFiles(dirPath, dirPath);
  }

  // git 信息作为补充
  for (const dir of dirs) {
    if (totalSent >= MAX_SIZE) break;
    const dirPath = path.resolve(dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      const log = execSync('git log --oneline -5', { cwd: dirPath, timeout: 5000, encoding: 'utf8' }).trim();
      if (log) {
        parts.push(`\n# Git 最近提交\n${log}`);
        totalSent += log.length;
      }
    } catch (e) {}
  }

  if (parts.length === 0) return res.json({ progress: '目录为空或无文本文件' });

  const allContent = parts.join('\n').slice(0, MAX_SIZE);
  const prompt = `以下是任务"${task.title}"(描述: ${task.description || '无'}) 关联目录的全部文件内容和 git 记录。

请基于这些信息分析：
1. 项目整体是什么、技术栈是什么
2. 已经完成了哪些功能和模块
3. 当前进行中的工作、最近的改动
4. 项目的完成度和下一步应该做什么

用简短格式回复（中文），不要空行，紧凑排列：
🔧 技术栈：xxx
✅ 已完成：xxx
🚧 进行中：xxx
📌 下一步：xxx

${allContent}`;

  // 获取 AI 配置
  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig] || null;
  if (!cfg || !cfg.base_url || !cfg.model) {
    return res.json({ progress: '请先配置 AI 模型' });
  }

  const systemMsg = { role: 'system', content: '你是一个技术项目进展分析助手。简洁准确地总结项目进度。' };
  const messages = [systemMsg, { role: 'user', content: prompt }];

  // 非流式调用 AI
  try {
    let result = await aiChatSync(cfg, messages);
    result = result.split('\n').filter(l => l.trim()).join('\n');
    db.updateTask(task.id, { ai_progress: result });
    res.json({ progress: result });
  } catch (e) {
    res.json({ progress: '分析失败: ' + e.message });
  }
}));

// 同步 AI 调用（非流式）
function aiChatSync(cfg, messages) {
  return new Promise((resolve, reject) => {
    const provider = cfg.provider || 'openai';
    const isHttps = cfg.base_url.toLowerCase().startsWith('https');
    const requester = isHttps ? https : http;

    let fullUrl, postData;
    const base = cfg.base_url.replace(/\/+$/, '');
    if (provider === 'anthropic') {
      fullUrl = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages';
      const systemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const chatMessages = messages.filter(m => m.role !== 'system');
      postData = JSON.stringify({ model: cfg.model, system: systemContent, messages: chatMessages, max_tokens: 512, stream: false });
    } else {
      fullUrl = base.endsWith('/v1') ? base + '/chat/completions' : base + '/v1/chat/completions';
      postData = JSON.stringify({ model: cfg.model, messages, max_tokens: 512, stream: false });
    }

    const url = new URL(fullUrl);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };
    if (provider === 'anthropic') {
      headers['x-api-key'] = cfg.api_key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${cfg.api_key}`;
    }
    if (cfg.x_token) { headers['X-Token'] = cfg.x_token; headers['x-auth-token'] = cfg.x_token; }

    const proxyReq = requester.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000, headers }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        if (proxyRes.statusCode >= 400) {
          let errMsg = `AI 服务返回 ${proxyRes.statusCode}`;
          try { const e = JSON.parse(body); errMsg = e.error?.message || e.message || e.error || errMsg; } catch (_) {}
          return reject(new Error(errMsg));
        }
        try {
          const data = JSON.parse(body);
          if (provider === 'anthropic') {
            resolve(data.content?.[0]?.text || (typeof data.content === 'string' ? data.content : '') || '无内容');
          } else {
            resolve(data.content || data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '无内容');
          }
        } catch (e) { reject(new Error('解析响应失败')); }
      });
    });
    proxyReq.on('error', (err) => reject(err));
    proxyReq.write(postData);
    proxyReq.end();
  });
}

// ==================== AI 会话关联 ====================

// 扫描目录下的 AI 会话（Claude Code + OpenCode）
app.get('/api/conversations/scan', asyncHandler(async (req, res) => {
  const directory = req.query.directory || '';
  const tool = req.query.tool || 'all';
  const results = [];

  // ---- Claude Code ----
  if (tool === 'all' || tool === 'claude') {
    const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
    if (fs.existsSync(SESSIONS_DIR)) {
      try {
        const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        // 按修改时间倒序
        const sessions = [];
        for (const sf of sessionFiles.slice(0, 200)) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, sf), 'utf8'));
            if (data.sessionId && data.cwd) {
              sessions.push({
                session_id: data.sessionId,
                title: data.name || data.sessionId.slice(0, 8),
                directory: path.normalize(data.cwd),
                created_at: data.startedAt ? new Date(data.startedAt).toISOString() : '',
              });
            }
          } catch (e) {}
        }
        sessions.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        // 按目录过滤：只匹配会话在任务目录内（或等于），不匹配父目录的会话
        // 用 path.normalize 统一路径分隔符，确保 win/mac 都正确
        const filtered = directory
          ? sessions.filter(s => {
              const nd = path.normalize(directory);
              return s.directory === nd || s.directory.startsWith(nd + path.sep);
            })
          : sessions;
        for (const s of filtered.slice(0, 30)) {
          results.push({ tool: 'claude', ...s });
        }
      } catch (e) {}
    }
  }

  // ---- OpenCode ----
  if (tool === 'all' || tool === 'opencode') {
    const OPENCODE_DB_PATHS = [
      path.join(os.homedir(), '.local', 'share', 'opencode', 'storage'),
      path.join(os.homedir(), '.opencode', 'storage'),
    ];
    for (const dbDir of OPENCODE_DB_PATHS) {
      if (!fs.existsSync(dbDir)) continue;
      try {
        const dbFiles = fs.readdirSync(dbDir).filter(f => f.endsWith('.db'));
        for (const dbFile of dbFiles.slice(0, 5)) {
          const dbPath = path.join(dbDir, dbFile);
          try {
            const buf = fs.readFileSync(dbPath);
            const SQL = await require('sql.js')();
            const openDb = new SQL.Database(buf);
            // 读取全部 session，用 JS 过滤（避免 SQLite LIKE 中 \ 被当成转义符）
            const stmt = openDb.prepare('SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC LIMIT 50');
            while (stmt.step()) {
              const row = stmt.getAsObject();
              const sesDir = path.normalize(row.directory || '');
              // 目录过滤：只在任务目录内（或等于）匹配
              if (directory) {
                const nd = path.normalize(directory);
                if (sesDir !== nd && !sesDir.startsWith(nd + path.sep)) continue;
              }
              results.push({
                tool: 'opencode',
                session_id: row.id || '',
                title: row.title || '',
                directory: sesDir,
                created_at: row.time_created || '',
              });
            }
            stmt.free();
            openDb.close();
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  // 去重、按时间排序、限制数量
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = `${r.tool}:${r.session_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(deduped.slice(0, 100));
}));

// 任务/目标的会话列表
app.get('/api/tasks/:id/conversations', (req, res) => {
  res.json(db.getConversations(Number(req.params.id), null));
});
app.get('/api/goals/:id/conversations', (req, res) => {
  res.json(db.getConversations(null, Number(req.params.id)));
});

// 关联会话
app.post('/api/tasks/:id/conversations', (req, res) => {
  db.addConversation({ ...req.body, task_id: Number(req.params.id) });
  res.json({ success: true });
});
app.post('/api/goals/:id/conversations', (req, res) => {
  db.addConversation({ ...req.body, goal_id: Number(req.params.id) });
  res.json({ success: true });
});

// 取消关联
app.delete('/api/conversations/:id', (req, res) => {
  db.deleteConversation(Number(req.params.id));
  res.json({ success: true });
});

// 继续对话（打开终端）
app.post('/api/conversations/:id/continue', asyncHandler(async (req, res) => {
  const conv = db.getConversation(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const dir = conv.directory || '';
  const cwd = fs.existsSync(dir) ? dir : fm.getRootDir();

  const platform = process.platform;
  let runCmd;
  if (platform === 'win32') {
    // cmd 元字符转义：& | < > ^ 用 ^ 前缀防命令拼接注入；% 重复防变量展开
    const escCmd = (s) => String(s).replace(/[&|<>^]/g, '^$&').replace(/%/g, '%%');
    const safeCwd = escCmd(cwd);
    const safeSession = escCmd(conv.session_id || '');
    if (conv.tool === 'opencode') {
      runCmd = `cd /d "${safeCwd}" && opencode --session "${safeSession}"`;
    } else {
      runCmd = `cd /d "${safeCwd}" && claude --resume "${safeSession}"`;
    }
    spawn('cmd', ['/c', 'start', 'cmd', '/k', runCmd], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const safeCwd = cwd.replace(/'/g, "'\\''");
    const safeSessionId = (conv.session_id || '').replace(/'/g, "'\\''");
    if (conv.tool === 'opencode') {
      runCmd = `cd '${safeCwd}' && opencode --session '${safeSessionId}'`;
    } else {
      runCmd = `cd '${safeCwd}' && claude --resume '${safeSessionId}'`;
    }
  if (platform === 'darwin') {
    const terminalPath = db.getSetting('terminal_path') || 'Terminal';
    const appName = path.basename(terminalPath.replace(/\/+$/, ''), '.app');
    if (/^iterm/i.test(appName)) {
      const appleScriptFile = path.join(os.tmpdir(), `godtodo_continue_${Date.now()}.applescript`);
      const safeCmd = runCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const scriptContent = `tell application "iTerm2"
  activate
  if (count of windows) = 0 then
    create window with default profile
  end if
  tell current window
    create tab with default profile
    tell current session
      write text "${safeCmd}"
    end tell
  end tell
end tell`;
      fs.writeFileSync(appleScriptFile, scriptContent, 'utf-8');
      exec(`osascript "${appleScriptFile}"`, (err, stdout, stderr) => {
        if (err) console.error('osascript error:', err.message, stderr);
        try { fs.unlinkSync(appleScriptFile); } catch (e) {}
      });
    } else {
      // Terminal.app：同样写临时文件，避免 shell 内联转义问题
      const appleScriptFile = path.join(os.tmpdir(), `godtodo_continue_${Date.now()}.applescript`);
      const safeCmd = runCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const scriptContent = `tell application "${appName}"
  activate
  do script "${safeCmd}"
end tell`;
      fs.writeFileSync(appleScriptFile, scriptContent, 'utf-8');
      exec(`osascript "${appleScriptFile}"`, (err, stdout, stderr) => {
        if (err) console.error('osascript error:', err.message, stderr);
        try { fs.unlinkSync(appleScriptFile); } catch (e) {}
      });
    }
  } else {
    spawn('x-terminal-emulator', ['-e', `bash -c "${runCmd}; exec bash"`], { detached: true, stdio: 'ignore' }).unref();
  }

  res.json({ success: true });
  }
}));

app.post('/api/ai/chat', (req, res) => {
  const { messages } = req.body;

  // 从 ai_configs 中获取当前激活的配置
  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig] || null;

  if (!cfg || !cfg.base_url || !cfg.model) {
    return res.status(400).json({ error: '请先在设置中配置 AI 模型（添加配置并填入 API Key）' });
  }

  const provider = cfg.provider || 'openai';
  const systemMsg = { role: 'system', content: db.getAIContext() };
  const allMessages = [systemMsg, ...(messages || [])];

  if (provider === 'anthropic') {
    proxyAnthropic(cfg.base_url, cfg.model, cfg.api_key, cfg.x_token, allMessages, res);
  } else {
    proxyOpenAI(cfg.base_url, cfg.model, cfg.api_key, cfg.x_token, allMessages, res);
  }
});

// ==================== 笔记卡片 ====================

app.get('/api/note-cards', (req, res) => {
  res.json(db.getNoteCards());
});

app.post('/api/note-cards', (req, res) => {
  const { title, content, category } = req.body;
  const id = db.createNoteCard(title || '', content || '', category);
  res.json({ id });
});

app.put('/api/note-cards/:id', (req, res) => {
  db.updateNoteCard(Number(req.params.id), req.body);
  res.json({ success: true });
});

app.delete('/api/note-cards/:id', (req, res) => {
  db.deleteNoteCard(Number(req.params.id));
  res.json({ success: true });
});

app.post('/api/note-cards/:id/items', (req, res) => {
  const id = db.addNoteItem(Number(req.params.id), req.body.content || '', req.body.parent_id || null);
  res.json({ id });
});

app.put('/api/note-items/reorder', (req, res) => {
  const items = req.body.items || [];
  for (const it of items) {
    db.reorderNoteItem(it.id, it.sort_order);
  }
  res.json({ success: true });
});

app.put('/api/note-items/:id', (req, res) => {
  const body = req.body;
  // ⚠️ 字段级 patch：只更新 body 里明确出现的字段
  // 之前 `body.content || ''` 会把 undefined 变成空串，导致 setItemIcon（只传 icon）冲掉现有 content
  const patch = {};
  if (body.content !== undefined) patch.content = body.content;
  if (body.parent_id !== undefined) patch.parent_id = body.parent_id;
  // icon: undefined=不修改 / null=清除 / 字符串=设置
  if (body.icon !== undefined) patch.icon = body.icon;
  db.updateNoteItem(Number(req.params.id), patch);
  res.json({ success: true });
});

app.put('/api/note-cards/reorder', (req, res) => {
  const items = req.body.items || [];
  db.reorderNoteCards(items);
  res.json({ success: true });
});

app.delete('/api/note-items/:id', (req, res) => {
  db.deleteNoteItem(Number(req.params.id));
  res.json({ success: true });
});

// ==================== 任务模板 ====================

app.get('/api/templates', (req, res) => {
  res.json(db.getTemplates());
});

app.post('/api/templates', (req, res) => {
  const { name, icon, data } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '模板名不能为空' });
  const id = db.createTemplate(name.trim(), icon, data);
  res.json({ id });
});

app.put('/api/templates/:id', (req, res) => {
  db.updateTemplate(Number(req.params.id), req.body);
  res.json({ success: true });
});

app.delete('/api/templates/:id', (req, res) => {
  db.deleteTemplate(Number(req.params.id));
  res.json({ success: true });
});

// AI 从笔记提取任务建议
app.post('/api/notes/:id/extract-tasks', asyncHandler(async (req, res) => {
  const cardId = Number(req.params.id);
  const cards = db.getNoteCards();
  const card = cards.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: '笔记不存在' });

  const items = (card.items || []).map(i => `- ${i.content}`).join('\n');
  if (!items.trim()) return res.status(400).json({ error: '笔记为空，无可提取内容' });

  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig];
  if (!cfg || !cfg.base_url || !cfg.model) {
    return res.status(400).json({ error: '请先在设置中配置 AI 模型' });
  }

  const prompt = `以下是笔记《${card.title || '未命名'}》的内容：

${items}

请分析这些笔记，提取其中隐含的可执行任务（行动项）。
返回严格的 JSON 数组，每项格式：
{"title": "任务标题（动词开头，简洁，15 字内）", "priority": "high|medium|low", "reason": "为什么提取（简短，20 字内）"}

要求：
- 只提取真正可执行的任务（不是信息/想法/事实陈述）
- 标题用动词开头（如"整理"、"联系"、"完成"、"调研"）
- 最多 8 条，按优先级排序
- 直接返回 JSON 数组，不要 markdown 代码块，不要解释文字`;

  try {
    const result = await aiChatSync(cfg, [
      { role: 'system', content: '你是任务提取助手。只返回纯 JSON 数组，不要其他任何文本或 markdown 标记。' },
      { role: 'user', content: prompt },
    ]);
    // 容错：剥离 markdown 代码块包裹 + 提取第一个 JSON 数组
    let cleaned = result.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) cleaned = jsonMatch[0];
    let suggestions;
    try {
      suggestions = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({ error: 'AI 返回格式无法解析，请重试' });
    }
    if (!Array.isArray(suggestions)) suggestions = [];
    // 清洗 + 标准化
    suggestions = suggestions
      .filter(s => s && typeof s.title === 'string' && s.title.trim())
      .slice(0, 10)
      .map(s => ({
        title: String(s.title).trim().slice(0, 100),
        priority: ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
        reason: String(s.reason || '').slice(0, 100),
        selected: true,
      }));
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: 'AI 调用失败: ' + e.message });
  }
}));

// ==================== 日报/周报 ====================

app.get('/api/reports', (req, res) => {
  res.json(db.getReports(req.query.type || null));
});

app.post('/api/reports', (req, res) => {
  const id = db.saveReport(req.body.type, req.body.content);
  res.json({ id });
});

app.delete('/api/reports/:id', (req, res) => {
  db.deleteReport(Number(req.params.id));
  res.json({ success: true });
});

app.get('/api/report-meetings', (req, res) => {
  res.json(db.getReportMeetings());
});

// ==================== 全局错误处理 ====================

app.use((err, req, res, next) => {
  console.error('未捕获错误:', err);
  // multer 上传错误友好化（默认英文 + 堆栈，对用户不友好）
  if (err.name === 'MulterError') {
    let msg = '上传失败';
    if (err.code === 'LIMIT_FILE_SIZE') msg = `文件过大（上限 100MB）${err.field ? '：' + err.field : ''}`;
    else if (err.code === 'LIMIT_FILE_COUNT') msg = '上传文件数过多（上限 20 个）';
    else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = `上传字段不符预期${err.field ? '：' + err.field : ''}`;
    else if (err.code === 'LIMIT_PART_COUNT') msg = '上传表单字段过多';
    else if (err.code === 'LIMIT_FIELD_KEY') msg = '字段名过长';
    else if (err.code === 'LIMIT_FIELD_VALUE') msg = '字段值过长';
    else msg = `上传错误：${err.message}`;
    return res.status(400).json({ error: msg, code: err.code });
  }
  // JSON 解析错误
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: '请求体格式错误或过大' });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ==================== SPA fallback ====================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ==================== Start ====================

(async () => {
  try {
    await db.init();
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e.message);
    console.error('请检查 data 目录权限或删除 data/godtodo.db 后重试');
    process.exit(1);
  }

  // 首次启动：从 SQLite 迁移 AI 配置到 JSON 文件
  if (!fs.existsSync(AI_CONFIG_FILE)) {
    const configs = db.getSetting('ai_configs') || [];
    const activeConfig = parseInt(db.getSetting('ai_active_config')) || 0;
    writeAIConfig({ activeConfig, configs });
    console.log('  📝 AI 配置已迁移到 data/ai-config.json');
  }

  dbReady = true;

  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   🚀 GodTodoList 已启动              ║');
    console.log(`  ║   📍 http://localhost:${PORT}            ║`);
    console.log('  ║   💾 SQLite 数据库                   ║');
    console.log('  ║   按 Ctrl+C 停止服务                 ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    const platform = process.platform;
    const url = `http://localhost:${PORT}`;
    if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，请先关闭占用该端口的进程`);
    } else {
      console.error('服务器启动失败:', err.message);
    }
    process.exit(1);
  });
})();
