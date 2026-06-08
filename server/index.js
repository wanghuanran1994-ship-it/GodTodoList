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

// ==================== 安全工具 ====================

// 路径安全验证：确保路径在允许范围内
function isPathAllowed(targetPath) {
  const rootDir = db.getSetting('root_dir');
  const resolved = path.resolve(targetPath);
  // 允许 root_dir 下的路径
  if (rootDir && resolved.startsWith(path.resolve(rootDir))) return true;
  // 允许任务 folder_path 下的路径
  const tasks = db.getTasks();
  for (const t of tasks) {
    if (t.folder_path && resolved.startsWith(path.resolve(t.folder_path))) return true;
  }
  return false;
}

// Shell 安全转义
function shellEscape(str) {
  return str.replace(/(["'\\$`!])/g, '\\$1');
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
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
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

// 文件上传配置
const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, '_');
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
      db.setSetting(key, value);
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
    const folderPath = fm.createTaskFolder(task.id, task.title);
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
app.post('/api/open-with-editor', asyncHandler(async (req, res) => {
  const { path: targetPath, editor } = req.body;
  if (!targetPath) return res.status(400).json({ error: '缺少 path 参数' });
  if (!isPathAllowed(targetPath)) return res.status(403).json({ error: '路径不在允许范围内' });

  // 确保文件存在
  if (!fs.existsSync(targetPath)) {
    const dir = require('path').dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, '', 'utf-8');
  }

  // 如果是目录，优先打开里面的 README.md；如果是文件直接用它
  let fileToOpen;
  if (fs.statSync(targetPath).isDirectory()) {
    const readmePath = require('path').join(targetPath, 'README.md');
    fileToOpen = fs.existsSync(readmePath) ? readmePath : targetPath;
  } else {
    fileToOpen = targetPath;
  }

  let command;
  if (editor.toLowerCase() === 'obsidian') {
    // Obsidian 打开文件所在的目录（作为 vault）
    const dir = require('path').dirname(fileToOpen);
    command = `open -a Obsidian "${dir}"`;
  } else if (editor.toLowerCase() === 'typora') {
    command = `open -a Typora "${fileToOpen}"`;
  } else if (editor.toLowerCase() === 'vscode' || editor.toLowerCase() === 'code') {
    command = `open -a "Visual Studio Code" "${fileToOpen}"`;
  } else {
    command = `open "${fileToOpen}"`;
  }

  exec(command, (err) => {
    if (err) console.error('打开编辑器失败:', err);
  });
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

// 系统原生文件夹选择器（macOS Finder / Windows / Linux）
app.post('/api/pick-folder', asyncHandler(async (req, res) => {
  const platform = process.platform;
  let folderPath = '';
  try {
    if (platform === 'darwin') {
      folderPath = execSync(`osascript -e 'choose folder' -e 'POSIX path of result'`, { encoding: 'utf-8', timeout: 60000 }).trim();
    } else if (platform === 'win32') {
      // 使用 VBScript + Shell.Application 调用原生文件夹选择器，兼容所有 Windows 版本
      // 输出写入临时文件（UTF-8），避免控制台编码问题
      const outFile = path.join(os.tmpdir(), `godtodo_pick_${Date.now()}.txt`);
      const vbsScript = path.join(os.tmpdir(), `godtodo_pick_${Date.now()}.vbs`);
      const vbsCode = `Set objShell = CreateObject("Shell.Application")\r\nSet objFolder = objShell.BrowseForFolder(0, "选择文件夹", 0, 0)\r\nIf Not objFolder Is Nothing Then\r\nSet stream = CreateObject("ADODB.Stream")\r\nstream.Type = 2\r\nstream.Charset = "utf-8"\r\nstream.Open\r\nstream.WriteText objFolder.Self.Path\r\nstream.SaveToFile "${outFile.replace(/\\/g, '\\\\')}", 2\r\nstream.Close\r\nEnd If`;
      fs.writeFileSync(vbsScript, vbsCode, 'utf-8');
      try {
        execSync(`cscript //NoLogo //B "${vbsScript}"`, { timeout: 60000 });
        if (fs.existsSync(outFile)) {
          folderPath = fs.readFileSync(outFile, 'utf-8').trim();
        }
      } finally {
        try { fs.unlinkSync(vbsScript); } catch (e) {}
        try { fs.unlinkSync(outFile); } catch (e) {}
      }
    } else {
      // Linux: try zenity
      folderPath = execSync('zenity --file-selection --directory 2>/dev/null || echo ""', { encoding: 'utf-8', timeout: 60000 }).trim();
    }
  } catch (e) {
    // user cancelled
    return res.json({ cancelled: true });
  }
  if (!folderPath) return res.json({ cancelled: true });
  res.json({ path: folderPath });
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
  db.addTimeLog(Number(req.params.id), req.body.duration, req.body.note);
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
  db.updateSubtask(Number(req.params.id), req.body);
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

app.get('/api/tasks/today', (req, res) => {
  res.json(db.getTodayTasks());
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
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' },
    };
  } else {
    const fullUrl = baseEndpoint.endsWith('/v1') ? baseEndpoint + '/chat/completions' : baseEndpoint + '/v1/chat/completions';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }] });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Authorization': `Bearer ${cfg.api_key}` },
    };
    if (cfg.x_token) options.headers['X-Token'] = cfg.x_token;
  }

  const proxyReq = requester.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      try {
        let text = '';
        if (cfg.provider === 'anthropic') {
          const json = JSON.parse(body);
          text = json.content?.[0]?.text || '';
        } else {
          const json = JSON.parse(body);
          text = json.choices?.[0]?.message?.content || '';
        }
        const subtasks = text.split('\n').map(s => s.replace(/^[\d.\-*]+\s*/, '').trim()).filter(s => s.length > 1);
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
  const { title } = req.body;
  if (!title) return res.json({});

  const aiCfg = readAIConfig();
  const cfg = aiCfg.configs[aiCfg.activeConfig] || null;
  if (!cfg || !cfg.base_url || !cfg.model) return res.json({});

  const allGoals = db.getGoals();
  const allTags = db.getTags();
  const goalList = allGoals.map(g => g.name).join('、') || '无';
  const tagList = allTags.map(t => t.name).join('、') || '无';

  // 扫描 root_dir 下已有目录
  let existingDirs = '';
  let existingDirList = [];
  try {
    const rootDir = fm.getRootDir();
    if (fs.existsSync(rootDir)) {
      const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(rootDir, e.name) }))
        .slice(0, 30);
      existingDirs = dirs.map(d => d.name).join('\n') || '无';
      existingDirList = dirs;
    }
  } catch (e) { existingDirs = '无'; }

  const prompt = `你是一个项目管理助手。请根据用户输入，给出以下建议（JSON格式）：
用户输入：${title}
可选目标：${goalList}
可选标签：${tagList}

已有的任务目录（在root_dir下）：
${existingDirs}

首先，从用户输入中提取一个简洁的任务标题（10字以内）。
然后严格返回以下JSON格式（不要其他内容）：
{
  "title": "简洁的任务标题（10字以内）",
  "description": "任务描述（1-2句话）",
  "estimated_time": 预估分钟数（整数）,
  "goal": "最匹配的目标名称（从可选目标中选，不确定则留空）",
  "tags": ["匹配的标签名1"],
  "subtasks": ["子任务1", "子任务2", "子任务3"],
  "folder_name": "简短的英文/拼音文件夹名（如 feature-analysis, api-refactor，10字符以内）",
  "reuse_folder": "如果已有目录完全匹配此任务，填目录名（从已有目录列表中选）；否则留空"
}`;

  const isHttps = cfg.base_url.toLowerCase().startsWith('https');
  const requester = isHttps ? https : http;

  const baseEndpoint2 = cfg.base_url.replace(/\/+$/, '');
  let postData, options;
  if (cfg.provider === 'anthropic') {
    const fullUrl = baseEndpoint2.endsWith('/v1') ? baseEndpoint2 + '/messages' : baseEndpoint2 + '/v1/messages';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'x-api-key': cfg.api_key, 'anthropic-version': '2023-06-01' },
    };
  } else {
    const fullUrl = baseEndpoint2.endsWith('/v1') ? baseEndpoint2 + '/chat/completions' : baseEndpoint2 + '/v1/chat/completions';
    const url = new URL(fullUrl);
    postData = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }] });
    options = {
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Authorization': `Bearer ${cfg.api_key}` },
    };
    if (cfg.x_token) options.headers['X-Token'] = cfg.x_token;
  }

  const proxyReq = requester.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      try {
        let text = '';
        if (cfg.provider === 'anthropic') {
          const json = JSON.parse(body);
          text = json.content?.[0]?.text || '';
        } else {
          const json = JSON.parse(body);
          text = json.choices?.[0]?.message?.content || '';
        }
        // Extract JSON from response (may have markdown wrapping)
        let cleanText = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return res.json({});
        const parsed = JSON.parse(jsonMatch[0]);

        // Map goal name to id
        if (parsed.goal) {
          const g = allGoals.find(g => g.name === parsed.goal);
          if (g) parsed.goal_id = g.id;
        }
        delete parsed.goal;

        // Map tag names to ids
        if (parsed.tags && parsed.tags.length) {
          parsed.tag_ids = parsed.tags
            .map(name => { const t = allTags.find(t => t.name === name); return t ? t.id : null; })
            .filter(Boolean);
        }
        delete parsed.tags;

        // 处理复用目录：将目录名解析为完整路径
        if (parsed.reuse_folder) {
          const rootDir = fm.getRootDir();
          const fullPath = path.join(rootDir, parsed.reuse_folder);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            parsed.reuse_folder_path = fullPath;
          } else {
            delete parsed.reuse_folder;
          }
        }

        parsed.existing_dirs = existingDirList;
        res.json(parsed);
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
  fs.copyFileSync(req.file.path, dbPath);
  try { fs.unlinkSync(req.file.path); } catch (e) {}
  res.json({ success: true, message: '数据库已恢复，请重启服务' });
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
      if (terminalPath.toLowerCase() === 'cmd') {
        spawn('cmd', ['/c', `cd /d "${directory}" && start cmd`], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('cmd', ['/c', 'start', '""', `"${terminalPath}"`], { detached: true, stdio: 'ignore' }).unref();
      }
    } else if (platform === 'darwin') {
      if (terminalPath && terminalPath !== 'Terminal') {
        spawn('open', ['-a', terminalPath, directory], { detached: true, stdio: 'ignore' }).unref();
      } else {
        exec(`osascript -e 'tell application "Terminal"\nactivate\ndo script "cd \\"${shellEscape(directory)}\\" && clear"\nend tell'`);
      }
    } else {
      // Linux
      const term = terminalPath === 'Terminal' ? 'x-terminal-emulator' : terminalPath;
      spawn(term, ['--working-directory', directory], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '启动终端失败: ' + err.message });
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
  if (xToken) options.headers['X-Token'] = xToken;

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
function proxyAnthropic(baseUrl, model, apiKey, allMessages, res) {
  const isHttps = baseUrl.toLowerCase().startsWith('https');
  const requester = isHttps ? https : http;

  // 智能处理 baseUrl 中已有的 /v1 路径
  const base = baseUrl.replace(/\/+$/, '');
  const fullUrl = base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages';
  const url = new URL(fullUrl);

  // Anthropic 使用 system 字段而非 system message
  const systemContent = allMessages.find(m => m.role === 'system')?.content || '';
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
      // 处理 buffer 中剩余的数据
      if (buffer.trim()) {
        const tl = buffer.trim();
        if (tl.startsWith('data:')) {
          const raw = tl.substring(tl.indexOf(':') + 1).trim();
          if (raw && raw !== '[DONE]') {
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'message_stop') {
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
  const task = db.getTask(req.params.id);
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
      const systemContent = messages.find(m => m.role === 'system')?.content || '';
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
    } else {
      headers['Authorization'] = `Bearer ${cfg.api_key}`;
      if (cfg.x_token) headers['X-Token'] = cfg.x_token;
    }

    const proxyReq = requester.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST', timeout: 60000, headers }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (provider === 'anthropic') {
            resolve(data.content?.[0]?.text || '无内容');
          } else {
            resolve(data.choices?.[0]?.message?.content || '无内容');
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
                directory: data.cwd,
                created_at: data.startedAt ? new Date(data.startedAt).toISOString() : '',
              });
            }
          } catch (e) {}
        }
        sessions.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        // 按目录过滤
        const filtered = directory
          ? sessions.filter(s => s.directory.startsWith(directory) || directory.startsWith(s.directory))
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
            const like = directory ? `%${directory}%` : '%';
            const stmt = openDb.prepare('SELECT id, title, directory, time_created FROM session WHERE directory LIKE ? ORDER BY time_created DESC LIMIT 10');
            stmt.bind([like]);
            while (stmt.step()) {
              const row = stmt.getAsObject();
              results.push({
                tool: 'opencode',
                session_id: row.id || '',
                title: row.title || '',
                directory: row.directory || '',
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

  const safeCwd = cwd.replace(/'/g, "'\\''");
  const safeSessionId = (conv.session_id || '').replace(/'/g, "'\\''");
  let runCmd;
  if (conv.tool === 'opencode') {
    runCmd = `cd '${safeCwd}' && opencode --session '${safeSessionId}'`;
  } else {
    runCmd = `cd '${safeCwd}' && claude --resume '${safeSessionId}'`;
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    // 写入临时脚本避免 osascript 转义问题
    const tmpScript = path.join(os.tmpdir(), `godtodo_continue_${Date.now()}.sh`);
    fs.writeFileSync(tmpScript, `#!/bin/bash\n${runCmd}\n`, { mode: 0o755 });
    exec(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "bash ${tmpScript.replace(/"/g, '\\"')}"'`);
  } else if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', runCmd], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', `bash -c "${runCmd}; exec bash"`], { detached: true, stdio: 'ignore' }).unref();
  }

  res.json({ success: true });
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
    proxyAnthropic(cfg.base_url, cfg.model, cfg.api_key, allMessages, res);
  } else {
    proxyOpenAI(cfg.base_url, cfg.model, cfg.api_key, cfg.x_token, allMessages, res);
  }
});

// ==================== 笔记卡片 ====================

app.get('/api/note-cards', (req, res) => {
  res.json(db.getNoteCards());
});

app.post('/api/note-cards', (req, res) => {
  const { title, content } = req.body;
  const id = db.createNoteCard(title || '', content || '');
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
  const id = db.addNoteItem(Number(req.params.id), req.body.content || '');
  res.json({ id });
});

app.put('/api/note-items/:id', (req, res) => {
  db.updateNoteItem(Number(req.params.id), req.body.content || '');
  res.json({ success: true });
});

app.delete('/api/note-items/:id', (req, res) => {
  db.deleteNoteItem(Number(req.params.id));
  res.json({ success: true });
});

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

// ==================== SPA fallback ====================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ==================== Start ====================

(async () => {
  await db.init();

  // 首次启动：从 SQLite 迁移 AI 配置到 JSON 文件
  if (!fs.existsSync(AI_CONFIG_FILE)) {
    const configs = db.getSetting('ai_configs') || [];
    const activeConfig = parseInt(db.getSetting('ai_active_config')) || 0;
    writeAIConfig({ activeConfig, configs });
    console.log('  📝 AI 配置已迁移到 data/ai-config.json');
  }

  dbReady = true;

  app.listen(PORT, '127.0.0.1', () => {
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
      exec(`open "${url}"`);
    } else if (platform === 'win32') {
      exec(`start "" "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  });
})();
