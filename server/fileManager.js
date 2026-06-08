const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { getSetting } = require('./database');

function getRootDir() {
  return getSetting('root_dir') || path.join(require('os').homedir(), 'Work', 'Tasks');
}

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function createTaskFolder(taskId, taskTitle, customFolderName) {
  const rootDir = getRootDir();
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  const format = getSetting('folder_format') || 'date_name';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeName = sanitizeName(customFolderName || taskTitle);

  let folderName;
  if (format === 'date_name') {
    folderName = `${date}_${safeName}`;
  } else if (format === 'number_name') {
    folderName = `${String(taskId).padStart(3, '0')}_${safeName}`;
  } else {
    folderName = `${date}_${safeName}`;
  }

  const folderPath = path.join(rootDir, folderName);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  return folderPath;
}

// ==================== README.md 读写 ====================

function writeTaskReadme(task, goals, routines, tags) {
  if (!task.folder_path) return;
  const readmePath = path.join(task.folder_path, 'README.md');

  // 构建 frontmatter
  const goalObj = goals ? goals.find(g => g.id === task.goal_id) : null;
  const routineObj = routines ? routines.find(r => r.id === task.routine_id) : null;
  // 兼容两种 task 对象格式：enriched (task.tags 是对象数组) 和 raw (task.tag_ids 是 ID 数组)
  const taskTags = task.tags
    ? task.tags.map(t => typeof t === 'string' ? t : t.name).filter(Boolean)
    : (task.tag_ids || []).map(id => tags ? tags.find(t => t.id === id) : null).filter(Boolean).map(t => t.name);

  const frontmatter = {
    task_id: task.id,
    title: task.title || '',
    status: task.status || 'todo',
    goal: goalObj ? goalObj.name : '',
    routine: routineObj ? routineObj.name : '',
    due_date: task.due_date || '',
    estimated_time: task.estimated_time || 0,
    actual_time: task.actual_time || 0,
    people: (task.people || []).map(p => typeof p === 'string' ? p : p.name).filter(Boolean),
    tags: taskTags.map(t => t.name),
    created_at: task.created_at || '',
    updated_at: new Date().toISOString(),
  };

  let fmBlock = '---\n';
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        fmBlock += `${k}: []\n`;
      } else {
        fmBlock += `${k}:\n`;
        v.forEach(item => { fmBlock += `  - ${item}\n`; });
      }
    } else {
      fmBlock += `${k}: ${v}\n`;
    }
  }
  fmBlock += '---\n';

  // 如果已有 README，保留 frontmatter 之外的全部内容
  let body = '';
  if (fs.existsSync(readmePath)) {
    try {
      const old = fs.readFileSync(readmePath, 'utf-8');
      // 提取原有 frontmatter 之后的内容
      const fmEndMatch = old.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
      if (fmEndMatch) {
        body = old.slice(fmEndMatch[0].length);
      } else {
        // 没有 frontmatter，整个保留
        body = old;
      }
    } catch (e) { /* ignore */ }
  } else {
    // 新 README，填入描述和背景
    body += `# ${task.title || '任务'}\n\n`;
    if (task.description) {
      body += `## 描述\n\n${task.description}\n\n`;
    }
    if (task.context) {
      body += `## 背景\n\n${task.context}\n\n`;
    }
  }

  try {
    fs.writeFileSync(readmePath, fmBlock + body, 'utf-8');
  } catch (e) {
    console.error('写 README 失败:', e.message);
  }
}

function parseReadme(filePath) {
  if (!fs.existsSync(filePath)) return null;

  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch (e) { return null; }

  // 解析 YAML frontmatter
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = {};
  const fmText = fmMatch[1];
  let currentArrayKey = null;

  for (const line of fmText.split('\n')) {
    // 数组项: "  - value"
    if (/^\s+- /.test(line) && currentArrayKey && Array.isArray(fm[currentArrayKey])) {
      fm[currentArrayKey].push(line.replace(/^\s+- /, '').trim());
      continue;
    }
    // key: value
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].trim();
      currentArrayKey = null;
      if (val === '[]') {
        fm[key] = [];
      } else if (val === '' && (key === 'people' || key === 'tags')) {
        fm[key] = [];
        currentArrayKey = key;
      } else {
        fm[key] = val;
      }
    }
  }

  // 解析正文
  const body = content.slice(fmMatch[0].length).trim();

  let description = '';
  let context = '';
  const descMatch = body.match(/## 描述\s*\n\n([\s\S]*?)(?=\n## |\n*$)/);
  if (descMatch) description = descMatch[1].trim();
  const ctxMatch = body.match(/## 背景\s*\n\n([\s\S]*?)(?=\n## |\n*$)/);
  if (ctxMatch) context = ctxMatch[1].trim();

  // 如果没有匹配到章节，把第一段非标题内容作为描述
  if (!description && !context) {
    const firstPara = body.replace(/^#.*$/m, '').trim();
    if (firstPara) description = firstPara;
  }

  return {
    title: fm.title || path.basename(path.dirname(filePath)),
    status: fm.status || 'todo',
    goal: fm.goal || '',
    routine: fm.routine || '',
    due_date: fm.due_date || '',
    estimated_time: parseInt(fm.estimated_time) || 0,
    actual_time: parseInt(fm.actual_time) || 0,
    people: Array.isArray(fm.people) ? fm.people : [],
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    task_id: fm.task_id ? parseInt(fm.task_id) : null,
    description,
    context,
    folder_path: path.dirname(filePath),
  };
}

// ==================== 目录扫描导入 ====================

function scanDirectories(rootDir) {
  if (!fs.existsSync(rootDir)) return [];

  const results = [];
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (e) { return []; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 跳过隐藏目录
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(rootDir, entry.name);
    const readmePath = path.join(dirPath, 'README.md');

    if (fs.existsSync(readmePath)) {
      const parsed = parseReadme(readmePath);
      if (parsed) {
        parsed.folder_name = entry.name;
        results.push(parsed);
      }
    } else {
      // 没有 README，也能导入（用目录名作为标题）
      results.push({
        title: entry.name,
        status: 'todo',
        goal: '',
        routine: '',
        due_date: '',
        estimated_time: 0,
        actual_time: 0,
        people: [],
        tags: [],
        task_id: null,
        description: '',
        context: '',
        folder_path: dirPath,
        folder_name: entry.name,
      });
    }
  }

  return results;
}

// ==================== 文件操作 ====================

function saveAttachment(taskFolder, file) {
  if (!fs.existsSync(taskFolder)) {
    fs.mkdirSync(taskFolder, { recursive: true });
  }

  const safeName = sanitizeName(path.basename(file.originalname || file.name || 'file'));
  const filePath = path.join(taskFolder, safeName);

  let finalPath = filePath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    finalPath = path.join(taskFolder, `${base}_${counter}${ext}`);
    counter++;
  }

  if (file.path && fs.existsSync(file.path)) {
    fs.copyFileSync(file.path, finalPath);
    try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
  } else if (file.buffer) {
    fs.writeFileSync(finalPath, file.buffer);
  }

  return {
    filePath: finalPath,
    fileName: path.basename(finalPath),
    fileType: path.extname(finalPath).toLowerCase(),
    fileSize: fs.statSync(finalPath).size,
  };
}

function openFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) return false;

  const platform = process.platform;
  let command;
  if (platform === 'darwin') {
    command = `open "${folderPath}"`;
  } else if (platform === 'win32') {
    command = `explorer "${folderPath}"`;
  } else {
    command = `xdg-open "${folderPath}"`;
  }

  exec(command, (err) => {
    if (err) console.error('打开文件夹失败:', err);
  });
  return true;
}

function openFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;

  const platform = process.platform;
  let command;
  if (platform === 'darwin') {
    command = `open "${filePath}"`;
  } else if (platform === 'win32') {
    command = `start "" "${filePath}"`;
  } else {
    command = `xdg-open "${filePath}"`;
  }

  exec(command, (err) => {
    if (err) console.error('打开文件失败:', err);
  });
  return true;
}

function ensureRootDir() {
  const rootDir = getRootDir();
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  return rootDir;
}

module.exports = {
  getRootDir,
  createTaskFolder,
  saveAttachment,
  openFolder,
  openFile,
  ensureRootDir,
  sanitizeName,
  writeTaskReadme,
  parseReadme,
  scanDirectories,
};
