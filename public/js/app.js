const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

createApp({
  setup() {
    // ==================== 状态 ====================
    const currentView = ref('dashboard');
    const sidebarCollapsed = ref(false);

    // 数据
    const goals = ref([]);
    const routines = ref([]);
    const tasks = ref([]);
    const tags = ref([]);
    const settings = reactive({ root_dir: '', folder_format: 'date_name', auto_create_folder: 'true', ai_base_url: '', ai_model: '', ai_api_key: '', ai_x_token: '', terminal_path: 'Terminal', editor: 'Obsidian' });

    // 筛选
    const filterStatus = ref(null);
    const filterGoalId = ref(null);
    const filterTagIds = ref([]);
    const filterToday = ref(false);
    const filterReportOnly = ref(false);
    const searchQuery = ref('');
    const reportMeetings = ref([]);
    let searchTimer = null;

    // 选择
    const selectedTaskId = ref(null);
    const selectedTask = ref(null);

    // 看板拖拽
    const kanbanDragOver = ref(null);
    const kanbanColumns = computed(() => {
      const cols = [
        { status: 'active', label: '正在进行', tasks: [] },
        { status: 'shelved', label: '搁置', tasks: [] },
        { status: 'done', label: '已完成', tasks: [] },
      ];
      for (const t of filteredTasks.value) {
        if (t.status === 'done') cols[2].tasks.push(t);
        else if (t.status === 'shelved') cols[1].tasks.push(t);
        else cols[0].tasks.push(t); // todo + in-progress
      }
      return cols;
    });

    // 批量操作
    const batchMode = ref(false);
    const batchSelected = ref([]);
    const batchStatus = ref('');
    const batchGoalId = ref(null);
    const settingsTab = ref('files');

    function toggleBatchSelect(taskId) {
      const idx = batchSelected.value.indexOf(taskId);
      if (idx >= 0) batchSelected.value.splice(idx, 1);
      else batchSelected.value.push(taskId);
    }

    async function applyBatchStatus() {
      if (!batchStatus.value || !batchSelected.value.length) return;
      for (const id of batchSelected.value) {
        await api(`/api/tasks/${id}`, { method: 'PUT', body: { status: batchStatus.value } });
      }
      batchSelected.value = [];
      batchStatus.value = '';
      await loadTasks();
    }

    async function applyBatchGoal() {
      if (batchGoalId.value === null || !batchSelected.value.length) return;
      for (const id of batchSelected.value) {
        await api(`/api/tasks/${id}`, { method: 'PUT', body: { goal_id: batchGoalId.value || null } });
      }
      batchSelected.value = [];
      batchGoalId.value = null;
      await loadTasks();
    }

    async function batchToggleToday() {
      for (const id of batchSelected.value) {
        await api(`/api/tasks/${id}/toggle-today`, { method: 'POST' });
      }
      batchSelected.value = [];
      await loadTasks();
    }

    async function batchDelete() {
      if (!confirm(`确定要删除 ${batchSelected.value.length} 个任务吗？`)) return;
      for (const id of batchSelected.value) {
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
      }
      batchSelected.value = [];
      batchMode.value = false;
      await loadTasks();
    }

    // 子任务统计
    function subtaskDoneCount(task) {
      if (!task.subtasks) return 0;
      return task.subtasks.filter(s => s.status === 'done').length;
    }
    function subtaskPercent(task) {
      if (!task.subtasks || !task.subtasks.length) return 0;
      return Math.round(subtaskDoneCount(task) / task.subtasks.length * 100);
    }

    function childTaskCount(parentId) {
      return tasks.value.filter(t => t.parent_task_id === parentId).length;
    }

    // 看板拖拽处理
    function onKanbanDragStart(e, task) {
      e.dataTransfer.setData('text/plain', String(task.id));
      e.dataTransfer.effectAllowed = 'move';
    }

    function onKanbanDragOver(e, status) {
      kanbanDragOver.value = status;
    }

    function onKanbanDragLeave(e, status) {
      if (kanbanDragOver.value === status) kanbanDragOver.value = null;
    }

    async function onKanbanDrop(e, status) {
      kanbanDragOver.value = null;
      const taskId = parseInt(e.dataTransfer.getData('text/plain'));
      if (!taskId) return;
      const task = tasks.value.find(t => t.id === taskId);
      // Map virtual 'active' column to 'in-progress'
      const targetStatus = status === 'active' ? 'in-progress' : status;
      if (!task || task.status === targetStatus) return;
      await api(`/api/tasks/${taskId}`, { method: 'PUT', body: { status: targetStatus } });
      await loadTasks();
      if (selectedTask.value?.id === taskId) {
        selectedTask.value = await api(`/api/tasks/${taskId}`);
      }
    }

    // 弹窗
    const showQuickAdd = ref(false);
    const showGoalModal = ref(false);
    const showRoutineModal = ref(false);
    const showTimeLog = ref(false);
    const timeEditing = reactive({ estimated: false, actual: false });
    const showImportModal = ref(false);

    // 表单
    const editingGoal = ref(null);
    const editingRoutine = ref(null);
    const goalForm = reactive({ name: '', description: '', color: '#3b82f6' });
    const routineForm = reactive({ name: '', description: '', goal_id: null, frequency: 'weekly', is_report: false, report_meeting: '' });

    // 新建任务
    const newTask = reactive({
      title: '', description: '', goal_id: null, routine_id: null,
      tag_ids: [], due_date: '', estimated_time: 0,
      people_str: '', create_folder: true,
      is_report: false, report_meeting: '',
    });

    // 标签管理
    const newTagName = ref('');
    const newTagDimension = ref('value');
    const newTagIcon = ref('');
    const emojiPickerFor = ref(null);
    const commonEmojis = '🔥 ⭐ 🚀 💡 📌 🎯 ⚡ 🔔 💼 📊 🏠 📝 🔧 🛠 📋 🏷 🎨 💬 🧠 🎵 📚 🗂 🔍 ⚙️ 💰 📅 🏃 🎪 🔮 🧩 🏆 🎭 🌟 💎 🕐 📢 🗣 🌍 💻 🎓 🧪 🛡️ 🔑 📎 ✨ 💪 🤝 🎁 🏗 🧹 📈 🧲 💊 🔬 📡 🏥 🚧 🎲 📖 🖊️ ✅ ❌ ❓ 💭 🗳️ 📨 🔗 🧭 🪜 🎻'.split(' ');
    const emojiSuggest = {
      '紧急': '🔥', '重要': '⭐', '高优': '🚀', 'bug': '🐛', '修复': '🔧',
      '学习': '📚', '研究': '🔬', '调研': '🔍', '文档': '📝', '写作': '✍️',
      '会议': '📋', '汇报': '📊', '周报': '📅', '月报': '📈', '复盘': '🔄',
      '设计': '🎨', '开发': '💻', '测试': '🧪', '部署': '🚀', '运维': '🛠',
      '数据': '📊', '分析': '🧠', '实验': '🧪', '优化': '⚡', '性能': '⚡',
      '安全': '🛡️', '沟通': '💬', '协作': '🤝', '评审': '👀', '审核': '✅',
      '规划': '🗺️', '目标': '🎯', '项目': '📋', '需求': '📝', '产品': '💎',
      '健康': '💪', '运动': '🏃', '生活': '🏠', '财务': '💰', '理财': '💵',
      '阅读': '📖', '写作': '🖊️', '翻译': '🌍', '管理': '⚙️', '组织': '🗂',
      '跟进': '📌', '备忘': '📎', '灵感': '💡', '创意': '🎭', '娱乐': '🎵',
      '日常': '📅', '提醒': '🔔', '待办': '✅', '完成': '🎉', '阻塞': '🚧',
      '依赖': '🔗', '工具': '🔑', '通知': '📢', '存档': '🗄️', '废弃': '🗑️',
      '讲师': '🎓', '培训': '🏫', '分享': '📤', '想法': '💭', '创新': '🔮',
    };
    function guessEmoji(name) {
      if (!name) return '';
      for (const [kw, emoji] of Object.entries(emojiSuggest)) {
        if (name.includes(kw)) return emoji;
      }
      return '';
    }
    function selectTagEmoji(target, emoji) {
      if (target === 'new') newTagIcon.value = emoji;
      else {
        const tag = tags.value.find(t => t.id === target);
        if (tag) { tag.icon = emoji; updateTag(tag); }
      }
      emojiPickerFor.value = null;
    }

    // 人员
    const newPerson = ref('');

    // 时间记录
    const timeLogDuration = ref(null);
    const timeLogNote = ref('');

    // 文件拖拽
    const isDragging = ref(false);
    const fileInput = ref(null);

    // AI 军师
    const showAIChat = ref(false);
    const aiMessages = ref([]);
    const aiInput = ref('');
    const aiStreaming = ref(false);
    const aiStreamContent = ref('');
    const aiChatMessages = ref(null);

    // 笔记卡片 AI 对话
    const noteChatCardId = ref(null);
    const noteConversations = reactive({});

    // 统计
    const statsDays = ref(30);
    const timeStats = ref([]);
    const goalStats = ref([]);

    // AI 进展分析
    const analyzingTaskId = ref(null);

    // 路径管理
    const pathReadmeStatus = reactive({});
    const dragPathIndex = ref(-1);
    const dragPathOverIndex = ref(-1);

    // AI 进度折叠（仅分析完成后首次展开）
    const expandedProgress = ref({});

    // AI 会话关联
    const taskConversations = ref([]);
    const scanResults = ref([]);
    const scanningConversations = ref(false);
    const showScanModal = ref(false);

    // 快速追加笔记
    const quickNote = ref('');
    const appendingNote = ref(false);

    // 通用笔记卡片
    const noteCards = ref([]);
    const newCardText = ref('');
    const newItemTexts = reactive({});

    // 回顾
    const reviewType = ref('daily');
    const reviewData = reactive({ completed: [], inProgress: [], overdue: [] });

    // Timer
    const activeTimers = ref([]);
    let timerInterval = null;

    // Contacts
    const contacts = ref([]);
    const contactForm = reactive({ name: '', employee_id: '', email: '', relationship: '' });
    const editingContactId = ref(null);

    // Subtasks
    const newSubtaskTitle = ref('');
    const aiDecomposing = ref(false);

    // Dark mode
    const darkMode = ref(false);

    // Quick input
    const quickInputText = ref('');
    const aiSuggestions = ref(null);
    const aiEnriching = ref(false);

    // 周数 & 剩余天数
    function getISOWeek(d) {
      const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const dayNum = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    }
    function getTotalWeeks(year) {
      const dec31 = new Date(year, 11, 31);
      return getISOWeek(dec31);
    }
    const weekInfo = computed(() => {
      const today = new Date();
      const week = getISOWeek(today);
      const total = getTotalWeeks(today.getFullYear());
      const yearEnd = new Date(today.getFullYear(), 11, 31);
      const remaining = Math.ceil((yearEnd - today) / 86400000);
      return { week, total, remaining };
    });

    // Calendar
    const now = new Date();
    const calendarYear = ref(now.getFullYear());
    const calendarMonth = ref(now.getMonth() + 1);
    const calendarViewMode = ref('month'); // 'month' | 'week'

    function calendarPrevMonth() {
      if (calendarMonth.value <= 1) { calendarMonth.value = 12; calendarYear.value--; }
      else calendarMonth.value--;
    }
    function calendarNextMonth() {
      if (calendarMonth.value >= 12) { calendarMonth.value = 1; calendarYear.value++; }
      else calendarMonth.value++;
    }

    // AI 测试
    const aiTestResult = ref('');

    // AI 多模型配置
    const aiConfigs = ref([]);
    const activeAIConfig = ref(0);
    const aiConfigSaved = ref(false);
    const showAIConfigJson = ref(false);
    const aiConfigsJson = computed(() => JSON.stringify({ activeConfig: activeAIConfig.value, configs: aiConfigs.value }, null, 2));

    // 导入
    const importDir = ref('');
    const importItems = ref([]);
    const importScanning = ref(false);
    const importing = ref(false);
    const importSelectedCount = computed(() => importItems.value.filter(i => i.selected).length);
    const importSelectedAll = computed({
      get: () => importItems.value.length > 0 && importItems.value.filter(i => !i.already_exists).every(i => i.selected),
      set: (v) => { importItems.value.forEach(i => { if (!i.already_exists) i.selected = v; }); }
    });

    // 自动创建文件夹
    const autoCreateFolder = computed({
      get: () => settings.auto_create_folder === 'true',
      set: (v) => { settings.auto_create_folder = v ? 'true' : 'false'; }
    });

    // 状态选项
    const statuses = [
      { value: 'todo', label: '待办' },
      { value: 'in-progress', label: '进行中' },
      { value: 'done', label: '已完成' },
      { value: 'shelved', label: '搁置' },
    ];

    // ==================== API 工具 ====================
    const lastApiError = ref('');

    async function api(url, options = {}) {
      lastApiError.value = '';
      try {
        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `请求失败 (${res.status})`);
        }
        return res.json();
      } catch (e) {
        lastApiError.value = e.message;
        throw e;
      }
    }

    // ==================== 数据加载 ====================
    async function loadGoals() {
      goals.value = await api('/api/goals');
    }

    async function loadRoutines() {
      routines.value = await api('/api/routines');
    }

    async function loadTasks() {
      const filters = {};
      if (filterStatus.value) filters.status = filterStatus.value;
      if (filterGoalId.value) filters.goal_id = filterGoalId.value;
      if (filterTagIds.value.length === 1) filters.tag_id = filterTagIds.value[0];
      if (searchQuery.value) filters.search = searchQuery.value;
      if (filterReportOnly.value) filters.is_report = 1;
      tasks.value = await api('/api/tasks?' + new URLSearchParams(filters).toString());
    }

    async function loadTags() {
      tags.value = await api('/api/tags');
      // 为没有图标的标签本地匹配图标（不触发 save，避免递归）
      for (const tag of tags.value) {
        if (!tag.icon) tag.icon = guessEmoji(tag.name);
      }
    }

    async function loadSettings() {
      const s = await api('/api/settings');
      Object.assign(settings, s);
      // 加载 AI 配置列表
      if (Array.isArray(s.ai_configs)) {
        aiConfigs.value = s.ai_configs;
      }
      activeAIConfig.value = parseInt(s.ai_active_config) || 0;
    }

    async function loadAll() {
      await Promise.all([loadGoals(), loadRoutines(), loadTasks(), loadTags(), loadSettings(), loadContacts(), refreshTimers()]);
      loadNoteConversations();
    }

    // ==================== 视图切换 ====================
    function switchView(view) {
      currentView.value = view;
      if (view !== 'kanban') closeDetail();
      if (view === 'goals') loadGoalStats();
      if (view === 'dashboard') { loadReview(); loadReports(); }
      if (view === 'notes') loadNoteCards();
      if (view === 'reports') loadReportMeetings();
      expandedProgress.value = {};
    }

    function goToTask(taskId) {
      switchView('kanban');
      nextTick(() => selectTask(taskId));
    }

    async function loadReportMeetings() {
      reportMeetings.value = await api('/api/report-meetings');
    }

    const groupedReportTasks = computed(() => {
      const groups = {};
      const reportTasks = tasks.value.filter(t => t.is_report);
      for (const t of reportTasks) {
        const meeting = t.report_meeting || '未归类';
        if (!groups[meeting]) groups[meeting] = [];
        groups[meeting].push(t);
      }
      return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    });

    // ==================== 筛选 ====================
    const filteredTasks = computed(() => {
      let result = tasks.value;

      if (filterToday.value) {
        result = result.filter(t => t.is_today);
      }

      if (filterTagIds.value.length > 0) {
        result = result.filter(t => {
          if (!t.tags) return false;
          return t.tags.some(tag => filterTagIds.value.includes(tag.id));
        });
      }

      return result;
    });

    // Calendar weeks computation
    const calendarWeeks = computed(() => {
      const y = calendarYear.value;
      const m = calendarMonth.value;
      const firstDay = new Date(y, m - 1, 1);
      const lastDay = new Date(y, m, 0);
      let startDow = firstDay.getDay(); // 0=Sun
      if (startDow === 0) startDow = 7;
      const weeks = [];
      let day = 1 - (startDow - 1); // Monday-based
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      // 预索引：按日期分组 goals（仅活跃的）
      const activeGoals = goals.value.filter(g => !g.archived && g.target_date);
      const goalsByDate = {};
      for (const g of activeGoals) {
        if (!goalsByDate[g.target_date]) goalsByDate[g.target_date] = [];
        goalsByDate[g.target_date].push(g);
      }

      for (let w = 0; w < 6; w++) {
        const week = [];
        for (let d = 0; d < 7; d++) {
          const cur = new Date(y, m - 1, day);
          const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
          const isCurrentMonth = cur.getMonth() === m - 1 && cur.getFullYear() === y;
          week.push({
            day: cur.getDate(),
            date: dateStr,
            isToday: dateStr === todayStr,
            otherMonth: !isCurrentMonth,
            tasks: isCurrentMonth ? tasks.value.filter(t => t.due_date === dateStr) : [],
            goals: isCurrentMonth ? (goalsByDate[dateStr] || []) : []
          });
          day++;
        }
        weeks.push(week);
        if (day > lastDay.getDate() + 7) break;
      }
      return weeks;
    });

    // Calendar week view: get Monday of the week containing the given year/month
    const calendarWeekDays = computed(() => {
      const y = calendarYear.value;
      const m = calendarMonth.value;
      // Use the 15th of the month to find which week we're showing in month view
      const midMonth = new Date(y, m - 1, 15);
      const dayOfWeek = midMonth.getDay();
      const monday = new Date(midMonth);
      monday.setDate(midMonth.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      const activeGoals = goals.value.filter(g => !g.archived && g.target_date);
      const goalsByDate = {};
      for (const g of activeGoals) {
        if (!goalsByDate[g.target_date]) goalsByDate[g.target_date] = [];
        goalsByDate[g.target_date].push(g);
      }

      const days = [];
      const dayNames = ['一','二','三','四','五','六','日'];
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        days.push({
          day: d.getDate(),
          date: dateStr,
          dayName: dayNames[i],
          isToday: dateStr === todayStr,
          isWeekend: i >= 5,
          tasks: tasks.value.filter(t => t.due_date === dateStr),
          goals: goalsByDate[dateStr] || []
        });
      }
      return days;
    });

    function calendarPrevWeek() {
      // Move back one week
      const y = calendarYear.value;
      const m = calendarMonth.value;
      const midMonth = new Date(y, m - 1, 15);
      const dayOfWeek = midMonth.getDay();
      const monday = new Date(midMonth);
      monday.setDate(midMonth.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      monday.setDate(monday.getDate() - 7);
      calendarYear.value = monday.getFullYear();
      calendarMonth.value = monday.getMonth() + 1;
    }

    function calendarNextWeek() {
      const y = calendarYear.value;
      const m = calendarMonth.value;
      const midMonth = new Date(y, m - 1, 15);
      const dayOfWeek = midMonth.getDay();
      const monday = new Date(midMonth);
      monday.setDate(midMonth.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      monday.setDate(monday.getDate() + 7);
      calendarYear.value = monday.getFullYear();
      calendarMonth.value = monday.getMonth() + 1;
    }

    // ==================== 时间轴 ====================
    const timelineGroups = computed(() => {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;
      // 本周结束（周日）
      const weekEnd = new Date(today);
      weekEnd.setDate(today.getDate() + (7 - (today.getDay() || 7)));
      const weekEndStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth()+1).padStart(2,'0')}-${String(weekEnd.getDate()).padStart(2,'0')}`;
      // 本月结束
      const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      const monthEndStr = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth()+1).padStart(2,'0')}-${String(monthEnd.getDate()).padStart(2,'0')}`;

      const groups = [
        { label: '今天', isToday: true, dateRange: todayStr, items: [] },
        { label: '明天', isToday: false, dateRange: tomorrowStr, items: [] },
        { label: '本周', isToday: false, dateRange: todayStr + ' ~ ' + weekEndStr, items: [] },
        { label: '本月', isToday: false, dateRange: todayStr + ' ~ ' + monthEndStr, items: [] },
        { label: '更晚', isToday: false, dateRange: monthEndStr + ' 之后', items: [] }
      ];

      const allItems = [];

      // 未归档的任务（有截止日期）
      for (const t of tasks.value) {
        if (!t.due_date || t.status === 'done') continue;
        allItems.push({
          type: 'task', id: t.id, title: t.title, date: t.due_date, status: t.status,
          goalName: t.goal_name || '', _key: 't' + t.id
        });
      }

      // 未归档的目标（有目标日期）
      for (const g of goals.value) {
        if (!g.target_date || g.archived) continue;
        allItems.push({
          type: 'goal', id: g.id, title: g.title, date: g.target_date, status: 'active',
          goalName: '', _key: 'g' + g.id
        });
      }

      // 按日期排序
      allItems.sort((a, b) => a.date.localeCompare(b.date));

      // 分组
      for (const item of allItems) {
        if (item.date === todayStr) groups[0].items.push(item);
        else if (item.date === tomorrowStr) groups[1].items.push(item);
        else if (item.date <= weekEndStr) groups[2].items.push(item);
        else if (item.date <= monthEndStr) groups[3].items.push(item);
        else groups[4].items.push(item);
      }

      return groups.filter(g => g.items.length > 0);
    });

    function toggleGoalFilter(goalId) {
      filterGoalId.value = filterGoalId.value === goalId ? null : goalId;
      currentView.value = 'kanban';
      loadTasks();
    }

    function toggleTagFilter(tagId) {
      const idx = filterTagIds.value.indexOf(tagId);
      if (idx >= 0) {
        filterTagIds.value.splice(idx, 1);
      } else {
        filterTagIds.value.push(tagId);
      }
    }

    // ==================== 快速输入解析 ====================

    const DAY_NAMES = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

    function parseQuickInput(raw) {
      let text = raw.trim();
      if (!text) return null;

      const result = { title: '', due_date: '', tag_ids: [], people: [], estimated_time: 0, is_today: false };

      // Extract #tags
      const tagPattern = /#(\S+)/g;
      let m;
      while ((m = tagPattern.exec(text)) !== null) {
        const name = m[1];
        const found = tags.value.find(t => t.name.includes(name) || name.includes(t.name));
        if (found && !result.tag_ids.includes(found.id)) result.tag_ids.push(found.id);
      }
      text = text.replace(tagPattern, '').trim();

      // Extract +people
      const peoplePattern = /[+＋](\S+)/g;
      while ((m = peoplePattern.exec(text)) !== null) {
        result.people.push(m[1]);
      }
      text = text.replace(peoplePattern, '').trim();

      // Extract !priority (1=30m, 2=1h, 3=4h)
      const priMatch = text.match(/!([123])/);
      if (priMatch) {
        result.estimated_time = [30, 60, 240][Number(priMatch[1]) - 1];
        text = text.replace(/![123]/, '').trim();
      }

      // Extract 🔥 or !! for is_today
      if (/🔥|!!/.test(text)) {
        result.is_today = true;
        text = text.replace(/🔥|!!/g, '').trim();
      }

      // Extract @date
      const datePattern = /@(今天|明天|后天|周([一二三四五六七天])|(\d{1,2})\/(\d{1,2}))/;
      const dateMatch = text.match(datePattern);
      if (dateMatch) {
        const d = new Date();
        if (dateMatch[1] === '今天') { /* keep d */ }
        else if (dateMatch[1] === '明天') d.setDate(d.getDate() + 1);
        else if (dateMatch[1] === '后天') d.setDate(d.getDate() + 2);
        else if (dateMatch[2]) {
          const target = DAY_NAMES[dateMatch[2]];
          const current = d.getDay() || 7;
          let diff = target - current;
          if (diff <= 0) diff += 7;
          d.setDate(d.getDate() + diff);
        } else if (dateMatch[3] && dateMatch[4]) {
          d.setMonth(Number(dateMatch[3]) - 1, Number(dateMatch[4]));
        }
        result.due_date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        text = text.replace(datePattern, '').trim();
      }

      result.title = text.replace(/\s+/g, ' ').trim();
      return result;
    }

    const quickInputParsed = computed(() => {
      if (!quickInputText.value.trim()) return null;
      return parseQuickInput(quickInputText.value);
    });

    async function createFromQuickInput() {
      const parsed = parseQuickInput(quickInputText.value);
      if (!parsed || !parsed.title) return;

      // Context defaults
      const goal_id = filterGoalId.value || null;
      const tag_ids = [...new Set([...parsed.tag_ids, ...filterTagIds.value])];

      const id = await api('/api/tasks', {
        method: 'POST',
        body: {
          title: parsed.title,
          description: '',
          goal_id,
          routine_id: null,
          tag_ids,
          due_date: parsed.due_date || null,
          estimated_time: parsed.estimated_time,
          people: parsed.people,
          is_today: parsed.is_today ? 1 : 0,
          create_folder: false,  // 延迟创建，等 AI 建议确认后再创建
        }
      });

      quickInputText.value = '';
      await loadTasks();
      selectTask(id.id);

      // AI enrich async
      fetchAISuggestions(id.id, parsed.title);
    }

    async function fetchAISuggestions(taskId, title) {
      aiEnriching.value = true;
      aiSuggestions.value = null;
      try {
        const result = await api('/api/ai/enrich', {
          method: 'POST',
          body: { title }
        });
        if (result && Object.keys(result).length > 0) {
          result._taskId = taskId;
          aiSuggestions.value = result;
        }
      } catch (e) {
        // Silent fail - AI enrich is optional
      }
      aiEnriching.value = false;
    }

    async function aiPickFolder() {
      try {
        const result = await api('/api/pick-folder', { method: 'POST' });
        if (result && result.path && aiSuggestions.value) {
          aiSuggestions.value.reuse_folder_path = result.path;
        }
      } catch (e) { /* cancelled */ }
    }

    async function applyAISuggestions() {
      if (!aiSuggestions.value || !selectedTask.value) return;
      const s = aiSuggestions.value;
      const folderName = s.folder_name || '';
      const updates = {};
      // AI 推理的任务标题：始终优先使用
      if (s.title) updates.title = s.title;
      if (s.description && !selectedTask.value.description) updates.description = s.description;
      if (s.estimated_time && !selectedTask.value.estimated_time) updates.estimated_time = s.estimated_time;
      if (s.goal_id && !selectedTask.value.goal_id) updates.goal_id = s.goal_id;
      if (updates.title !== undefined) selectedTask.value.title = updates.title;
      if (updates.description !== undefined) selectedTask.value.description = updates.description;
      if (updates.estimated_time !== undefined) selectedTask.value.estimated_time = updates.estimated_time;
      if (updates.goal_id !== undefined) selectedTask.value.goal_id = updates.goal_id;
      await saveSelectedTask();

      // Add suggested tags
      if (s.tag_ids && s.tag_ids.length) {
        for (const tid of s.tag_ids) {
          if (!isTaskTagged(tid)) await toggleTaskTag(tid);
        }
      }

      // Add suggested subtasks
      if (s.subtasks && s.subtasks.length) {
        for (const title of s.subtasks) {
          await api(`/api/tasks/${selectedTask.value.id}/subtasks`, {
            method: 'POST', body: { title }
          });
        }
        selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
      }

      // 保存复用目录路径，在清除前取出
      const reusePath = s.reuse_folder_path || '';

      aiSuggestions.value = null;

      // 优先复用已有目录
      if (reusePath && selectedTask.value && !selectedTask.value.folder_path) {
        await api(`/api/tasks/${selectedTask.value.id}`, {
          method: 'PUT', body: { folder_path: reusePath }
        });
        await loadTasks();
        selectTask(selectedTask.value.id);
      } else if (folderName) {
        await createFolderWithName(selectedTask.value.id, folderName);
      }
    }

    function dismissAISuggestions() {
      // 只应用文本信息，不创建目录
      const s = aiSuggestions.value;
      if (s && selectedTask.value) {
        if (s.title) selectedTask.value.title = s.title;
        if (s.description && !selectedTask.value.description) selectedTask.value.description = s.description;
        if (s.estimated_time && !selectedTask.value.estimated_time) selectedTask.value.estimated_time = s.estimated_time;
        if (s.goal_id && !selectedTask.value.goal_id) selectedTask.value.goal_id = s.goal_id;
        saveSelectedTask();
      }
      aiSuggestions.value = null;
    }

    async function createFolderWithName(taskId, folderName) {
      const task = await api(`/api/tasks/${taskId}`);
      if (task && !task.folder_path && folderName.trim()) {
        await api(`/api/tasks/${taskId}/create-folder`, {
          method: 'POST',
          body: { folder_name: folderName.trim() }
        });
        await loadTasks();
        selectTask(taskId);
      }
    }

    async function ensureTaskFolder(taskId) {
      const task = await api(`/api/tasks/${taskId}`);
      if (task && !task.folder_path) {
        const shortName = task.title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '-').slice(0, 40);
        const folderName = prompt('输入文件夹名称（简短即可）:', shortName);
        if (folderName === null) return;
        const name = folderName.trim() || shortName;
        await api(`/api/tasks/${taskId}/create-folder`, {
          method: 'POST',
          body: { folder_name: name }
        });
        await loadTasks();
        selectTask(taskId);
      }
    }

    // ==================== 周报/日报生成 ====================

    const aiReportContent = ref('');
    const aiGeneratingReport = ref(false);

    async function generateReport(type) {
      aiGeneratingReport.value = true;
      aiReportContent.value = '';
      try {
        const completed = tasks.value.filter(t => t.status === 'done');
        const inProgress = tasks.value.filter(t => t.status === 'in-progress');
        const overdue = tasks.value.filter(t => t.due_date && isOverdue(t.due_date) && t.status !== 'done');

        const prompt = type === 'daily'
          ? `请根据以下数据生成今日日报（Markdown格式），包含：今日完成、进行中、明日计划。数据：\n已完成：${completed.map(t=>t.title).join('、') || '无'}\n进行中：${inProgress.map(t=>t.title).join('、') || '无'}\n逾期：${overdue.map(t=>t.title).join('、') || '无'}`
          : `请根据以下数据生成本周工作周报（Markdown格式），包含：本周完成、进行中、下周计划、风险与建议。数据：\n已完成：${completed.map(t=>t.title).join('、') || '无'}\n进行中：${inProgress.map(t=>t.title).join('、') || '无'}\n逾期：${overdue.map(t=>t.title).join('、') || '无'}\n目标：${goals.value.map(g=>g.name).join('、') || '无'}`;

        const configs = aiConfigs.value;
        const idx = activeAIConfig.value || 0;
        const cfg = configs[idx];
        if (!cfg || !cfg.base_url) throw new Error('请先配置 AI');

        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          for (const line of lines) {
            const tl = line.trim();
            if (!tl.startsWith('data:')) continue;
            const data = tl.substring(tl.indexOf(':') + 1).trim();
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const d = json.choices?.[0]?.delta;
              fullContent += (d?.content || '');
            } catch (e) {}
          }
          aiReportContent.value = fullContent;
        }
        // 保存到历史
        if (fullContent) {
          await api('/api/reports', { method: 'POST', body: { type, content: fullContent } });
          await loadReports();
          // 将新报告设为选中
          selectedReport.value = null;
        }
      } catch (e) {
        aiReportContent.value = '生成失败: ' + e.message;
      }
      aiGeneratingReport.value = false;
    }

    const reportHistory = ref([]);
    const selectedReport = ref(null);

    async function loadReports() {
      reportHistory.value = await api(`/api/reports?type=${reviewType.value}`);
    }
    async function deleteReport(id) {
      await api(`/api/reports/${id}`, { method: 'DELETE' });
      if (selectedReport.value?.id === id) selectedReport.value = null;
      await loadReports();
    }
    function copyReportContent(content) {
      navigator.clipboard.writeText(content || '');
    }

    function copyReportText() {
      if (aiReportContent.value) {
        navigator.clipboard.writeText(aiReportContent.value);
      }
    }

    function debounceSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadTasks(), 300);
    }

    watch(filterStatus, () => loadTasks());

    // ==================== 任务操作 ====================
    function openQuickAdd() {
      Object.assign(newTask, {
        title: '', description: '', goal_id: filterGoalId.value || null,
        routine_id: null, tag_ids: [...filterTagIds.value], due_date: '', estimated_time: 0,
        people_str: '', create_folder: true
      });
      showQuickAdd.value = true;
      nextTick(() => {
        const el = document.querySelector('.quick-add-modal .input-lg');
        if (el) el.focus();
      });
    }

    async function quickCreateTask() {
      if (!newTask.title.trim()) return;

      const people = newTask.people_str
        ? newTask.people_str.split(/[,，]/).map(s => s.trim()).filter(Boolean)
        : [];

      const id = await api('/api/tasks', {
        method: 'POST',
        body: {
          title: newTask.title,
          description: newTask.description,
          goal_id: newTask.goal_id,
          routine_id: newTask.routine_id,
          tag_ids: newTask.tag_ids,
          due_date: newTask.due_date || new Date(Date.now() + 7*86400000).toISOString().slice(0, 10),
          estimated_time: newTask.estimated_time,
          people,
          create_folder: newTask.create_folder,
          is_report: newTask.is_report ? 1 : 0,
          report_meeting: newTask.report_meeting,
        }
      });

      showQuickAdd.value = false;
      await loadTasks();
      selectTask(id.id);
    }

    function toggleNewTaskTag(tagId) {
      const idx = newTask.tag_ids.indexOf(tagId);
      if (idx >= 0) newTask.tag_ids.splice(idx, 1);
      else newTask.tag_ids.push(tagId);
    }

    async function selectTask(id) {
      selectedTaskId.value = id;
      try {
        selectedTask.value = await api(`/api/tasks/${id}`);
        loadTaskConversations(id);
        checkAllPathReadmes();
      } catch (e) {
        selectedTaskId.value = null;
        selectedTask.value = null;
      }
    }

    function closeDetail() {
      selectedTaskId.value = null;
      selectedTask.value = null;
    }

    async function saveSelectedTask() {
      if (!selectedTask.value) return;
      const t = selectedTask.value;
      await api(`/api/tasks/${t.id}`, {
        method: 'PUT',
        body: {
          title: t.title,
          description: t.description,
          context: t.context,
          goal_id: t.goal_id,
          routine_id: t.routine_id,
          status: t.status,
          estimated_time: t.estimated_time,
          actual_time: t.actual_time,
          due_date: t.due_date,
          is_report: t.is_report ? 1 : 0,
          report_meeting: t.report_meeting || '',
        }
      });
      await loadTasks();
    }

    async function changeStatus(status) {
      selectedTask.value.status = status;
      await saveSelectedTask();
    }

    async function deleteSelectedTask() {
      const task = selectedTask.value;
      if (!task) return;
      if (!confirm('确定要删除此任务吗？（数据库记录将被移除）')) return;

      // If task has a folder, open it for user to manually delete
      if (task.folder_path) {
        try { await api('/api/open-folder', { method: 'POST', body: { path: task.folder_path } }); } catch(e) {}
        alert('已打开任务目录，请手动删除文件夹后再确认。目录路径：\n' + task.folder_path);
      }

      await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
      closeDetail();
      await loadTasks();
    }

    // ==================== 标签操作 ====================
    function isTaskTagged(tagId) {
      return selectedTask.value?.tags?.some(t => t.id === tagId);
    }

    async function toggleTaskTag(tagId) {
      if (!selectedTask.value) return;
      const current = selectedTask.value.tags.map(t => t.id);
      const idx = current.indexOf(tagId);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(tagId);
      await api(`/api/tasks/${selectedTask.value.id}/tags`, {
        method: 'PUT',
        body: { tag_ids: current }
      });
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
      await loadTasks();
    }

    async function addTag() {
      if (!newTagName.value.trim()) return;
      const icon = newTagIcon.value || guessEmoji(newTagName.value);
      await api('/api/tags', {
        method: 'POST',
        body: { name: newTagName.value, dimension: newTagDimension.value, icon }
      });
      newTagName.value = '';
      newTagIcon.value = '';
      await loadTags();
    }

    async function removeTag(id) {
      await api(`/api/tags/${id}`, { method: 'DELETE' });
      await loadTags();
    }

    async function updateTag(tag) {
      const icon = tag.icon || guessEmoji(tag.name);
      // 本地先更新，确保 UI 立即响应
      if (icon && !tag.icon) tag.icon = icon;
      await api(`/api/tags/${tag.id}`, {
        method: 'PUT',
        body: { name: tag.name, dimension: tag.dimension, color: tag.color, icon }
      });
    }

    // ==================== 人员操作 ====================
    async function addPerson() {
      if (!newPerson.value.trim() || !selectedTask.value) return;
      const people = selectedTask.value.people.map(p => p.name);
      people.push(newPerson.value.trim());
      await api(`/api/tasks/${selectedTask.value.id}/people`, {
        method: 'PUT',
        body: { people }
      });
      newPerson.value = '';
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    async function removePerson(index) {
      const people = selectedTask.value.people.map(p => p.name);
      people.splice(index, 1);
      await api(`/api/tasks/${selectedTask.value.id}/people`, {
        method: 'PUT',
        body: { people }
      });
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    // ==================== 时间记录 ====================
    async function logTime() {
      if (!timeLogDuration.value || timeLogDuration.value <= 0) return;
      await api(`/api/tasks/${selectedTask.value.id}/time-logs`, {
        method: 'POST',
        body: { duration: timeLogDuration.value, note: timeLogNote.value }
      });
      // 更新实际时间
      const total = (selectedTask.value.actual_time || 0) + timeLogDuration.value;
      await api(`/api/tasks/${selectedTask.value.id}`, {
        method: 'PUT',
        body: { actual_time: total }
      });
      timeLogDuration.value = null;
      timeLogNote.value = '';
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    // ==================== 文件操作 ====================
    function triggerFileInput() {
      const el = document.querySelector('.drop-zone input[type="file"]');
      if (el) el.click();
    }

    async function uploadFiles(files) {
      if (!selectedTask.value || !files.length) return;

      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }

      try {
        const res = await fetch(`/api/tasks/${selectedTask.value.id}/attachments`, {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) throw new Error('Upload failed');
        await res.json();

        // 重新加载任务详情
        selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
        await loadTasks();
      } catch (e) {
        console.error('上传失败:', e);
        alert('文件上传失败: ' + e.message);
      }
    }

    function handleFileDrop(e) {
      isDragging.value = false;
      const files = e.dataTransfer?.files;
      if (files && files.length) uploadFiles(files);
    }

    function handleFileSelect(e) {
      const files = e.target?.files;
      if (files && files.length) uploadFiles(files);
      e.target.value = ''; // 重置以允许再次选择同一文件
    }

    async function deleteAttachment(attId) {
      await api(`/api/attachments/${attId}`, { method: 'DELETE' });
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    async function openAttachment(att) {
      await api('/api/attachments/open', {
        method: 'POST',
        body: { file_path: att.file_path }
      });
    }

    async function openFolder() {
      await api(`/api/tasks/${selectedTask.value.id}/open-folder`, { method: 'POST' });
    }

    async function openWithEditor() {
      const task = selectedTask.value;
      if (!task?.folder_path) return;
      const editor = settings.editor || 'Obsidian';
      await api('/api/open-with-editor', {
        method: 'POST',
        body: { path: task.folder_path, editor }
      });
    }

    async function appendToReadme() {
      if (!quickNote.value.trim()) return;
      appendingNote.value = true;
      try {
        await api(`/api/tasks/${selectedTask.value.id}/append-readme`, {
          method: 'POST',
          body: { text: quickNote.value.trim() }
        });
        quickNote.value = '';
        // 刷新 README 状态
        if (selectedTask.value?.folder_path) {
          checkPathReadme(selectedTask.value.folder_path);
        }
      } catch (e) {
        // ignore
      }
      appendingNote.value = false;
    }

    // 通用笔记卡片
    async function loadNoteCards() {
      noteCards.value = await api('/api/note-cards');
    }
    async function createCard() {
      const text = newCardText.value.trim();
      if (!text) return;
      await api('/api/note-cards', { method: 'POST', body: { content: text } });
      newCardText.value = '';
      await loadNoteCards();
    }
    async function renameCard(cardId, title) {
      await api(`/api/note-cards/${cardId}`, { method: 'PUT', body: { title: title?.trim() || '未命名' } });
    }
    async function deleteCard(cardId) {
      await api(`/api/note-cards/${cardId}`, { method: 'DELETE' });
      await loadNoteCards();
    }
    async function addItem(cardId) {
      const text = (newItemTexts[cardId] || '').trim();
      if (!text) return;
      await api(`/api/note-cards/${cardId}/items`, { method: 'POST', body: { content: text } });
      newItemTexts[cardId] = '';
      await loadNoteCards();
    }
    async function updateItem(itemId, content) {
      await api(`/api/note-items/${itemId}`, { method: 'PUT', body: { content: content || '' } });
    }
    async function deleteItem(cardId, itemId) {
      await api(`/api/note-items/${itemId}`, { method: 'DELETE' });
      await loadNoteCards();
    }

    async function unlinkFolder() {
      if (!confirm('确定要取消此任务的目录关联吗？（不会删除实际目录）')) return;
      await api(`/api/tasks/${selectedTask.value.id}/unlink-folder`, { method: 'POST' });
      await loadTasks();
      selectTask(selectedTask.value.id);
    }

    // ==================== 目标操作 ====================
    async function saveGoal() {
      if (!goalForm.name.trim()) return;
      if (editingGoal.value) {
        await api(`/api/goals/${editingGoal.value}`, {
          method: 'PUT',
          body: { name: goalForm.name, description: goalForm.description, color: goalForm.color }
        });
      } else {
        await api('/api/goals', {
          method: 'POST',
          body: { name: goalForm.name, description: goalForm.description, color: goalForm.color }
        });
      }
      showGoalModal.value = false;
      editingGoal.value = null;
      Object.assign(goalForm, { name: '', description: '', color: '#3b82f6' });
      await loadGoals();
    }

    function editGoal(goal) {
      editingGoal.value = goal.id;
      Object.assign(goalForm, { name: goal.name, description: goal.description, color: goal.color });
      showGoalModal.value = true;
    }

    async function archiveGoal(id) {
      if (!confirm('确定要归档此目标吗？')) return;
      await api(`/api/goals/${id}`, { method: 'DELETE' });
      await loadGoals();
    }

    async function saveGoalTargetDate(goalId, date) {
      await api(`/api/goals/${goalId}`, { method: 'PUT', body: { target_date: date || null } });
      await loadGoals();
      if (currentView.value === 'goals') loadGoalStats();
    }

    // 今日视图数据
    const todayTasks = computed(() => {
      const today = new Date().toISOString().slice(0, 10);
      return tasks.value.filter(t => {
        if (t.is_today) return true;
        if (t.due_date === today) return true;
        if (t.status === 'done' && t.completed_at && t.completed_at.startsWith(today)) return true;
        return false;
      });
    });

    const todayTimeBudget = computed(() => {
      const total = todayTasks.value.reduce((sum, t) => sum + (t.estimated_time || 0), 0);
      return { total, hours: (total / 60).toFixed(1) };
    });

    // 仪表盘数据
    const upcomingDeadlines = computed(() => {
      return tasks.value
        .filter(t => t.status !== 'done' && t.due_date)
        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
        .slice(0, 10);
    });

    const recentCompleted = computed(() => {
      return tasks.value
        .filter(t => t.status === 'done' && t.completed_at)
        .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
        .slice(0, 10);
    });

    const pressureTasks = computed(() => {
      const today = new Date().toISOString().slice(0, 10);
      const threeDaysLater = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      return tasks.value
        .filter(t => {
          if (t.status === 'done' || t.status === 'shelved') return false;
          if (!t.due_date) return false;
          return t.due_date <= threeDaysLater;
        })
        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    });

    const pressureAnalysis = ref('');
    const analyzingPressure = ref(false);
    const pressureChatMode = ref(false);

    function buildPressurePrompt() {
      const active = tasks.value.filter(t => t.status === 'in-progress' || t.status === 'todo');
      const overdue = tasks.value.filter(t => t.due_date && isOverdue(t.due_date) && t.status !== 'done' && t.status !== 'shelved');
      const shelved = tasks.value.filter(t => t.status === 'shelved');
      return `你是一位资深技术管理顾问。请根据以下工作数据，帮我分析当前压力来源，并指出破局关键。

## 我的目标
${goals.value.map(g => `- ${g.name}${g.description ? '：' + g.description : ''}`).join('\n') || '无'}

## 活跃任务（进行中+待办）
${active.map(t => `- ${t.title} [${t.status === 'in-progress' ? '进行中' : '待办'}]${t.due_date ? ' 截止:' + t.due_date : ''}${t.estimated_time ? ' 预估:' + t.estimated_time + 'min' : ''}${t.goal_name ? ' 目标:' + t.goal_name : ''}`).join('\n') || '无'}

## 已逾期
${overdue.map(t => `- ${t.title} 截止:${t.due_date}`).join('\n') || '无'}

## 搁置
${shelved.map(t => `- ${t.title}`).join('\n') || '无'}

请从以下角度分析并和我讨论（简洁，每条不要太长）：
1. **核心压力来源**：哪些任务/目标组合造成了最大的认知负荷和时间压力？
2. **隐藏风险**：是否有被忽视但可能爆发的问题？
3. **破局关键**：哪个点一旦突破，其他问题会连锁缓解？给出具体可操作的建议。
4. **优先级重排建议**：当前任务应该如何重新排序？

请用中文回答，Markdown 格式。我们可以多轮讨论直到确定最终策略。`;
    }

    async function analyzePressure() {
      const prompt = buildPressurePrompt();
      // 打开 AI 军师面板，预填 prompt
      aiMessages.value = [];
      aiInput.value = prompt;
      showAIChat.value = true;
      pressureChatMode.value = true;
      await nextTick();
      sendAIMessage();
    }

    function savePressureAnalysis() {
      // 取最后一条 assistant 消息保存到压力面板
      const lastAI = [...aiMessages.value].reverse().find(m => m.role === 'assistant');
      if (lastAI) {
        pressureAnalysis.value = lastAI.content;
        pressureChatMode.value = false;
        showAIChat.value = false;
      }
    }

    async function loadGoalStats() {
      goalStats.value = await api('/api/stats/goals');
    }

    function goalProgress(stat) {
      if (!stat.total_tasks) return 0;
      return Math.round((stat.done_tasks / stat.total_tasks) * 100);
    }

    // ==================== 惯例操作 ====================
    async function saveRoutine() {
      if (!routineForm.name.trim()) return;
      if (editingRoutine.value) {
        await api(`/api/routines/${editingRoutine.value}`, {
          method: 'PUT',
          body: { name: routineForm.name, description: routineForm.description, goal_id: routineForm.goal_id, frequency: routineForm.frequency, is_report: routineForm.is_report ? 1 : 0, report_meeting: routineForm.report_meeting }
        });
      } else {
        await api('/api/routines', {
          method: 'POST',
          body: { name: routineForm.name, description: routineForm.description, goal_id: routineForm.goal_id, frequency: routineForm.frequency, is_report: routineForm.is_report ? 1 : 0, report_meeting: routineForm.report_meeting }
        });
      }
      showRoutineModal.value = false;
      editingRoutine.value = null;
      Object.assign(routineForm, { name: '', description: '', goal_id: null, frequency: 'weekly' });
      await loadRoutines();
    }

    function editRoutine(routine) {
      editingRoutine.value = routine.id;
      Object.assign(routineForm, {
        name: routine.name, description: routine.description,
        goal_id: routine.goal_id, frequency: routine.frequency,
        is_report: !!routine.is_report, report_meeting: routine.report_meeting || '',
      });
      showRoutineModal.value = true;
    }

    async function archiveRoutine(id) {
      if (!confirm('确定要归档此惯例吗？')) return;
      await api(`/api/routines/${id}`, { method: 'DELETE' });
      await loadRoutines();
    }

    async function createTaskFromRoutine(routine) {
      Object.assign(newTask, {
        title: routine.name, description: routine.description,
        goal_id: routine.goal_id, routine_id: routine.id,
        tag_ids: [], due_date: '', estimated_time: 0,
        people_str: '', create_folder: false,
        is_report: !!routine.is_report,
        report_meeting: routine.report_meeting || '',
      });
      showQuickAdd.value = true;
    }

    // ==================== 统计 ====================
    async function loadTimeStats() {
      timeStats.value = await api(`/api/stats/time?days=${statsDays.value}`);
    }

    async function loadReview() {
      const data = await api(`/api/stats/review?type=${reviewType.value}`);
      Object.assign(reviewData, data);
    }

    const totalTasksCount = computed(() => tasks.value.length);
    const completedTasksCount = computed(() => tasks.value.filter(t => t.status === 'done').length);
    const totalTimeSpent = computed(() => tasks.value.reduce((sum, t) => sum + (t.actual_time || 0), 0));

    function barHeight(completed) {
      const max = Math.max(...timeStats.value.map(d => d.completed || 0), 1);
      return ((completed || 0) / max) * 100;
    }

    // ==================== 批量导入 ====================

    async function scanImportDir() {
      if (!importDir.value.trim()) return;
      importScanning.value = true;
      importItems.value = [];
      try {
        const items = await api('/api/import/scan', {
          method: 'POST',
          body: { directory: importDir.value.trim() }
        });
        importItems.value = items.map(i => ({ ...i, selected: !i.already_exists }));
      } catch (e) {
        alert('扫描失败: ' + e.message);
      }
      importScanning.value = false;
    }

    function toggleImportAll(e) {
      const val = e.target.checked;
      importItems.value.forEach(i => { if (!i.already_exists) i.selected = val; });
    }

    async function executeImport() {
      const selected = importItems.value.filter(i => i.selected);
      if (!selected.length) return;
      importing.value = true;
      try {
        const result = await api('/api/import/execute', {
          method: 'POST',
          body: { items: selected }
        });
        alert(`成功导入 ${result.count} 个任务`);
        showImportModal.value = false;
        importItems.value = [];
        await loadTasks();
      } catch (e) {
        alert('导入失败: ' + e.message);
      }
      importing.value = false;
    }

    // ==================== 设置 ====================
    async function saveSettings() {
      await api('/api/settings', {
        method: 'PUT',
        body: settings
      });
    }

    // ==================== AI 多模型配置 ====================

    function addAIConfig() {
      aiConfigs.value.push({ name: '新模型', provider: 'openai', base_url: '', model: '', api_key: '', x_token: '' });
      activeAIConfig.value = aiConfigs.value.length - 1;
      saveAIConfigs();
    }

    function removeAIConfig() {
      if (aiConfigs.value.length <= 1) return;
      aiConfigs.value.splice(activeAIConfig.value, 1);
      if (activeAIConfig.value >= aiConfigs.value.length) activeAIConfig.value = aiConfigs.value.length - 1;
      saveAIConfigs();
    }

    async function switchAIModel() {
      await api('/api/settings', {
        method: 'PUT',
        body: { ai_active_config: activeAIConfig.value }
      });
    }

    async function saveAIConfigs() {
      await api('/api/settings', {
        method: 'PUT',
        body: { ai_configs: aiConfigs.value, ai_active_config: activeAIConfig.value }
      });
      aiConfigSaved.value = true;
      setTimeout(() => { aiConfigSaved.value = false; }, 2000);
    }

    async function testAIConnection() {
      await saveAIConfigs();
      aiTestResult.value = '测试中...';
      try {
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '你好，请用一句话回复' }] }),
        });
        if (!res.ok) {
          let errMsg = '连接失败';
          try { errMsg = (await res.json()).error || errMsg; } catch (e) {}
          aiTestResult.value = '❌ ' + errMsg;
          return;
        }

        const ct = res.headers.get('Content-Type') || '';
        if (ct.includes('text/event-stream')) {
          // SSE 流式响应 — 解析 SSE 事件
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let gotContent = false;
          const timeout = setTimeout(() => { reader.cancel(); if (!gotContent) aiTestResult.value = '⚠️ 连接成功但未收到内容（超时）'; }, 15000);

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              const events = buffer.split('\n\n');
              buffer = events.pop();

              for (const event of events) {
                for (const line of event.split('\n')) {
                  const tl = line.trim();
                  if (!tl.startsWith('data:')) continue;
                  const raw = tl.substring(tl.indexOf(':') + 1).trim();
                  if (!raw || raw === '[DONE]') continue;
                  try {
                    const d = JSON.parse(raw);
                    const c = d.choices?.[0]?.delta?.content
                           || d.choices?.[0]?.delta?.reasoning_content
                           || d.choices?.[0]?.message?.content
                           || d.content || d.text || d.delta?.text;
                    if (c) gotContent = true;
                  } catch (e) { /* skip */ }
                }
              }
              if (gotContent) {
                aiTestResult.value = '✅ 连接成功，模型正常响应';
                clearTimeout(timeout);
                reader.cancel();
                return;
              }
            }
          } catch (e) { /* reader cancelled */ }
          if (!gotContent) aiTestResult.value = '⚠️ 连接成功但未收到内容';
        } else {
          // 非流式响应 — 直接解析 JSON
          try {
            const data = await res.json();
            const c = data.choices?.[0]?.message?.content || data.content || data.text || '';
            aiTestResult.value = c ? '✅ 连接成功，模型正常响应' : '⚠️ 连接成功但响应为空';
          } catch (e) {
            aiTestResult.value = '⚠️ 连接成功但响应格式异常';
          }
        }
      } catch (e) {
        aiTestResult.value = e.message.includes('Failed to fetch')
          ? '❌ 服务未启动'
          : '❌ 连接失败: ' + e.message;
      }
    }

    // ==================== 工具函数 ====================
    function statusLabel(status) {
      const map = { 'todo': '待办', 'in-progress': '进行中', 'done': '已完成', 'shelved': '搁置' };
      return map[status] || status;
    }

    function freqLabel(freq) {
      const map = { daily: '每天', weekly: '每周', biweekly: '每两周', monthly: '每月', quarterly: '每季度' };
      return map[freq] || freq;
    }

    function isOverdue(dateStr) {
      if (!dateStr) return false;
      const [y, m, d] = dateStr.split('-').map(Number);
      const dueDate = new Date(y, m - 1, d);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return dueDate < today;
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function formatChartDate(dateStr) {
      if (!dateStr) return '';
      const d = new Date(dateStr);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }

    function fileIcon(ext) {
      if (!ext) return '📄';
      const map = {
        '.pdf': '📕', '.doc': '📘', '.docx': '📘', '.xls': '📊', '.xlsx': '📊',
        '.ppt': '📙', '.pptx': '📙', '.txt': '📝', '.md': '📝',
        '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
        '.zip': '📦', '.rar': '📦', '.7z': '📦',
        '.mp4': '🎬', '.mp3': '🎵',
        '.js': '💻', '.py': '💻', '.java': '💻', '.cpp': '💻', '.c': '💻',
      };
      return map[ext.toLowerCase()] || '📄';
    }

    function formatSize(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      let size = bytes;
      while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
      return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }

    // ==================== 键盘快捷键 ====================
    function handleKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        openQuickAdd();
      }
      if (e.key === 'Escape') {
        if (showQuickAdd.value) showQuickAdd.value = false;
        else if (showGoalModal.value) showGoalModal.value = false;
        else if (showRoutineModal.value) showRoutineModal.value = false;
        else if (showAIChat.value) closeAIChat();
        else if (selectedTask.value) closeDetail();
      }
    }

    // ==================== 目标关联目录 ====================

    function goalTaskFolders(goalId) {
      return tasks.value
        .filter(t => t.goal_id === goalId && t.folder_path)
        .map(t => ({
          task_id: t.id,
          task_title: t.title,
          folder_path: t.folder_path,
          folder_name: t.folder_path.split(/[/\\]/).pop() || t.folder_path,
        }));
    }

    async function refreshGoalPaths(goalId) {
      const goal = goals.value.find(g => g.id === goalId);
      if (!goal) return;
      // 收集该目标下所有任务的目录路径
      const taskFolders = goalTaskFolders(goalId).map(f => f.folder_path);
      // 合并去重
      const existing = new Set(goal.paths || []);
      let added = false;
      for (const p of taskFolders) {
        if (!existing.has(p)) {
          existing.add(p);
          added = true;
        }
      }
      if (added) {
        await api(`/api/goals/${goalId}`, { method: 'PUT', body: { paths: [...existing] } });
        await loadGoals();
        if (currentView.value === 'goals') loadGoalStats();
      }
    }

    async function openFolderFor(folderPath) {
      await api('/api/open-folder', { method: 'POST', body: { path: folderPath } });
    }

    // 目标路径管理
    async function addGoalPath(goalId) {
      try {
        const result = await api('/api/pick-folder', { method: 'POST' });
        if (result && result.path) {
          const goal = goals.value.find(g => g.id === goalId);
          if (!goal) return;
          const paths = [...(goal.paths || []), result.path];
          await api(`/api/goals/${goalId}`, { method: 'PUT', body: { paths } });
          await loadGoals();
          if (currentView.value === 'goals') loadGoalStats();
        }
      } catch (e) {
        console.error('addGoalPath error:', e);
      }
    }

    // 通用：弹出系统文件夹选择器，结果写入 ref
    async function pickFolderFor(refKey) {
      try {
        const result = await api('/api/pick-folder', { method: 'POST' });
        if (result && result.path) {
          if (refKey === 'rootDir') settings.root_dir = result.path;
          else if (refKey === 'importDir') importDir.value = result.path;
        }
      } catch (e) {}
    }

    async function pickFileFor(refKey) {
      try {
        const result = await api('/api/pick-file', { method: 'POST' });
        if (result && result.path) {
          if (refKey === 'terminal') settings.terminal_path = result.path;
          else if (refKey === 'editor') settings.editor = result.path;
          saveSettings();
        }
      } catch (e) {}
    }

    async function removeGoalPath(goalId, index) {
      const goal = goals.value.find(g => g.id === goalId);
      if (!goal) return;
      const paths = (goal.paths || []).filter((_, i) => i !== index);
      await api(`/api/goals/${goalId}`, { method: 'PUT', body: { paths } });
      await loadGoals();
      if (currentView.value === 'goals') loadGoalStats();
    }

    // 任务路径管理
    async function openDirBrowser(taskId) {
      // taskId 可能被 Vue 传入事件对象，确保是数字才用
      const tid = typeof taskId === 'number' ? taskId : selectedTask.value?.id;
      try {
        const result = await api('/api/pick-folder', { method: 'POST' });
        if (result && result.path) {
          await doAddPath(tid, result.path);
        }
      } catch (e) {
        console.error('openDirBrowser error:', e);
      }
    }

    async function addTaskPath(taskId) {
      openDirBrowser(taskId);
    }

    async function doAddPath(taskId, pathStr) {
      const task = await api(`/api/tasks/${taskId}`);
      const paths = [...(task.paths || []), pathStr];
      await api(`/api/tasks/${taskId}`, { method: 'PUT', body: { paths } });
      if (selectedTask.value?.id === taskId) {
        selectedTask.value = await api(`/api/tasks/${taskId}`);
      }
      await loadTasks();
    }

    async function removeTaskPath(taskId, index) {
      const task = await api(`/api/tasks/${taskId}`);
      const paths = (task.paths || []).filter((_, i) => i !== index);
      await api(`/api/tasks/${taskId}`, { method: 'PUT', body: { paths } });
      if (selectedTask.value?.id === taskId) {
        selectedTask.value = await api(`/api/tasks/${taskId}`);
        checkAllPathReadmes();
      }
      await loadTasks();
    }

    // 拖拽排序
    function onPathDragStart(e, index) {
      dragPathIndex.value = index;
      e.dataTransfer.effectAllowed = 'move';
    }
    function onPathDragOver(e, index) {
      e.dataTransfer.dropEffect = 'move';
      dragPathOverIndex.value = index;
    }
    async function onPathDrop(e, index) {
      dragPathOverIndex.value = -1;
      const from = dragPathIndex.value;
      dragPathIndex.value = -1;
      if (from === index || from < 0) return;
      const task = selectedTask.value;
      if (!task) return;
      const paths = [...(task.paths || [])];
      const [moved] = paths.splice(from, 1);
      paths.splice(index, 0, moved);
      await api(`/api/tasks/${task.id}`, { method: 'PUT', body: { paths } });
      selectedTask.value = await api(`/api/tasks/${task.id}`);
    }

    // 设为主路径
    async function setPrimaryPath(index) {
      const task = selectedTask.value;
      if (!task) return;
      const paths = [...(task.paths || [])];
      const newPrimary = paths.splice(index, 1)[0];
      const oldPrimary = task.folder_path || '';
      if (oldPrimary) {
        paths.unshift(oldPrimary);
      }
      await api(`/api/tasks/${task.id}`, { method: 'PUT', body: { folder_path: newPrimary, paths } });
      selectedTask.value = await api(`/api/tasks/${task.id}`);
      checkAllPathReadmes();
    }

    // 检查单个路径的 README
    async function checkPathReadme(dirPath) {
      try {
        const result = await api(`/api/paths/check-readme?path=${encodeURIComponent(dirPath)}`);
        pathReadmeStatus[dirPath] = result.exists;
      } catch (e) {
        pathReadmeStatus[dirPath] = false;
      }
    }

    // 检查所有关联路径的 README
    async function checkAllPathReadmes() {
      const task = selectedTask.value;
      if (!task) return;
      const dirs = [];
      if (task.folder_path) dirs.push(task.folder_path);
      if (Array.isArray(task.paths)) dirs.push(...task.paths);
      for (const d of dirs) {
        await checkPathReadme(d);
      }
    }

    async function launchTerminal() {
      if (!selectedTask.value?.folder_path) return;
      await api('/api/launch-terminal', {
        method: 'POST',
        body: { directory: selectedTask.value.folder_path }
      });
    }

    // ==================== AI 军师 ====================

    function clearAIChat() {
      aiMessages.value = [];
      aiStreamContent.value = '';
      pressureChatMode.value = false;
      if (noteChatCardId.value) {
        delete noteConversations[noteChatCardId.value];
        saveNoteConversations();
        noteChatCardId.value = null;
      }
    }

    function closeAIChat() {
      showAIChat.value = false;
      pressureChatMode.value = false;
      if (noteChatCardId.value) {
        saveNoteConversations();
        noteChatCardId.value = null;
      }
    }

    function openNoteChat(cardId, cardTitle, cardItems) {
      noteChatCardId.value = cardId;
      pressureChatMode.value = false;

      if (noteConversations[cardId]) {
        aiMessages.value = [...noteConversations[cardId]];
      } else {
        const itemsText = (cardItems || []).map((item, i) => `${i + 1}. ${item.content}`).join('\n');
        const systemMsg = {
          role: 'system',
          content: `用户正在整理笔记卡片「${cardTitle || '未命名'}」，以下是卡片中的内容：\n\n${itemsText || '(空卡片)'}\n\n请帮助用户梳理这些内容，理清思路，提取关键点，或者根据用户的提问给出建议。请用中文回复。`
        };
        aiMessages.value = [systemMsg, { role: 'assistant', content: '你好！我看到你的笔记卡片 **「' + (cardTitle || '未命名') + '」** 中有 ' + ((cardItems || []).length || 0) + ' 条内容。需要我帮你做什么？比如：\n\n- 梳理和归类这些内容\n- 提取关键点和行动项\n- 根据内容制定计划\n- 或者其他你需要的帮助\n\n直接告诉我就好～' }];
        noteConversations[cardId] = [...aiMessages.value];
      }
      showAIChat.value = true;
    }

    function saveNoteConversations() {
      try {
        const data = {};
        for (const [k, v] of Object.entries(noteConversations)) {
          data[k] = v;
        }
        localStorage.setItem('godtodo_note_conversations', JSON.stringify(data));
      } catch (e) {}
    }

    function loadNoteConversations() {
      try {
        const raw = localStorage.getItem('godtodo_note_conversations');
        if (raw) {
          const data = JSON.parse(raw);
          for (const [k, v] of Object.entries(data)) {
            noteConversations[k] = v;
          }
        }
      } catch (e) {}
    }

    async function sendAIMessage() {
      const text = aiInput.value.trim();
      if (!text || aiStreaming.value) return;

      aiMessages.value.push({ role: 'user', content: text });
      aiInput.value = '';
      aiStreaming.value = true;
      aiStreamContent.value = '';

      await nextTick();
      scrollAIChat();

      try {
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: aiMessages.value }),
        });

        if (!res.ok) {
          let errMsg = '请求失败';
          try { const err = await res.json(); errMsg = err.error || errMsg; } catch (e) {}
          aiMessages.value.push({ role: 'assistant', content: '❌ ' + errMsg + '\n\n请前往 **设置 → AI 军师配置** 填写 API 地址、模型名和 API Key。' });
          aiStreaming.value = false;
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          // 解析 SSE 数据
          const lines = chunk.split('\n');
          for (const line of lines) {
            const tl = line.trim();
            if (tl.startsWith('data:')) {
              const data = tl.substring(tl.indexOf(':') + 1).trim();
              if (data === '[DONE]') continue;
              try {
                const json = JSON.parse(data);
                const d = json.choices?.[0]?.delta;
                const delta = (d?.content || '');
                if (delta) {
                  fullContent += delta;
                  aiStreamContent.value = fullContent;
                  await nextTick();
                  scrollAIChat();
                }
              } catch (e) {
                // 非 JSON 行，直接追加
                fullContent += chunk;
                aiStreamContent.value = fullContent;
              }
            }
          }
        }

        aiMessages.value.push({ role: 'assistant', content: fullContent });
        if (noteChatCardId.value) {
          noteConversations[noteChatCardId.value] = [...aiMessages.value];
          saveNoteConversations();
        }
      } catch (e) {
        const msg = e.message.includes('Failed to fetch')
          ? '❌ 无法连接服务器，请确认服务已启动（终端运行 node server/index.js）'
          : '❌ 连接失败: ' + e.message;
        aiMessages.value.push({ role: 'assistant', content: msg });
      }

      aiStreaming.value = false;
      aiStreamContent.value = '';
      await nextTick();
      scrollAIChat();
    }

    function sendAIPrompt(prompt) {
      aiInput.value = prompt;
      sendAIMessage();
    }

    function scrollAIChat() {
      const el = document.querySelector('.ai-chat-messages');
      if (el) el.scrollTop = el.scrollHeight;
    }

    function renderMarkdown(text) {
      if (!text) return '';
      try {
        // marked 可能暴露为 window.marked 或 window.marked.marked (取决于版本/打包方式)
        const md = window.marked?.marked || window.marked;
        let html = '';
        if (md && typeof md === 'function') {
          html = md.parse ? md.parse(text) : md(text);
        } else if (md && typeof md.parse === 'function') {
          html = md.parse(text);
        }
        if (html) {
          // 使用 DOMPurify 防止 XSS（AI 生成内容不可信）
          if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
            return window.DOMPurify.sanitize(html, {
              ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','b','i','u','s','a','ul','ol','li','code','pre','blockquote','table','thead','tbody','tr','th','td','hr','img','span','div','del','input'],
              ALLOWED_ATTR: ['href','src','alt','title','class','checked','type','disabled']
            });
          }
          return html;
        }
      } catch (e) {}
      // fallback: 基本 HTML 转义 + 换行
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }

    // ==================== 计时器 ====================

    async function refreshTimers() {
      try { activeTimers.value = await api('/api/timers/active'); } catch (e) {}
    }

    async function startTaskTimer(taskId) {
      await api(`/api/tasks/${taskId}/timer/start`, { method: 'POST' });
      await refreshTimers();
      await loadTasks();
      if (selectedTask.value?.id === taskId) selectedTask.value = await api(`/api/tasks/${taskId}`);
    }

    async function stopTaskTimer(taskId) {
      const result = await api(`/api/tasks/${taskId}/timer/stop`, { method: 'POST' });
      await refreshTimers();
      await loadTasks();
      if (selectedTask.value?.id === taskId) selectedTask.value = await api(`/api/tasks/${taskId}`);
      return result.minutes;
    }

    function isTimerActive(taskId) {
      return activeTimers.value.some(t => t.id === taskId);
    }

    function formatDuration(totalMinutes) {
      if (!totalMinutes || totalMinutes <= 0) return '0分钟';
      const mins = totalMinutes;
      if (mins >= 43200) return `${(mins / 43200).toFixed(1)}个月`;
      if (mins >= 1440) return `${(mins / 1440).toFixed(1)}天`;
      if (mins >= 60) return `${(mins / 60).toFixed(1)}小时`;
      if (mins >= 1) return `${Math.round(mins)}分钟`;
      return `${Math.round(mins * 60)}秒`;
    }

    function getTimerElapsed(taskId) {
      const timer = activeTimers.value.find(t => t.id === taskId);
      if (!timer) return '';
      const ms = Date.now() - new Date(timer.timer_started_at).getTime();
      return formatDuration(ms / 60000);
    }

    function formatTime(minutes) {
      return formatDuration(minutes);
    }

    // 启动定时刷新计时器显示
    onMounted(async () => {
      document.addEventListener('keydown', handleKeydown);
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.emoji-pick-btn') && !e.target.closest('.emoji-grid')) {
          emojiPickerFor.value = null;
        }
      });
      await loadAll();
      timerInterval = setInterval(() => {
        if (activeTimers.value.length > 0) refreshTimers();
      }, 5000);
      // Dark mode
      if (localStorage.getItem('darkMode') === 'true') {
        darkMode.value = true;
        document.body.classList.add('dark');
      }
    });

    // ==================== 今日必做 ====================

    async function toggleToday(taskId) {
      await api(`/api/tasks/${taskId}/toggle-today`, { method: 'POST' });
      await loadTasks();
      if (selectedTask.value?.id === taskId) selectedTask.value = await api(`/api/tasks/${taskId}`);
    }

    async function analyzeTaskProgress(taskId) {
      analyzingTaskId.value = taskId;
      try {
        const result = await api(`/api/tasks/${taskId}/analyze-progress`, { method: 'POST' });
        expandedProgress.value[taskId] = true;
        await loadTasks();
        if (selectedTask.value?.id === taskId) {
          selectedTask.value = await api(`/api/tasks/${taskId}`);
        }
      } catch (e) {
        // ignore
      }
      analyzingTaskId.value = null;
    }

    // ==================== AI 会话关联 ====================

    async function loadTaskConversations(taskId) {
      if (!taskId) return;
      taskConversations.value = await api(`/api/tasks/${taskId}/conversations`);
    }

    async function scanConversations(directory) {
      scanningConversations.value = true;
      try {
        scanResults.value = await api(`/api/conversations/scan?directory=${encodeURIComponent(directory || '')}`);
      } catch (e) {
        scanResults.value = [];
      }
      scanningConversations.value = false;
    }

    async function linkConversation(taskId, conv) {
      await api(`/api/tasks/${taskId}/conversations`, { method: 'POST', body: conv });
      await loadTaskConversations(taskId);
    }

    async function unlinkConversation(convId) {
      await api(`/api/conversations/${convId}`, { method: 'DELETE' });
      const tid = selectedTask.value?.id;
      if (tid) await loadTaskConversations(tid);
    }

    async function continueConversation(convId) {
      await api(`/api/conversations/${convId}/continue`, { method: 'POST' });
    }

    // 快速继续任务的最新 AI 会话（从卡片上调用）
    async function quickContinueConversation(taskId) {
      try {
        // 先看已关联的会话
        const convs = await api(`/api/tasks/${taskId}/conversations`);
        if (convs && convs.length > 0) {
          await api(`/api/conversations/${convs[0].id}/continue`, { method: 'POST' });
          return;
        }
        // 没有关联，获取任务信息
        const task = await api(`/api/tasks/${taskId}`);
        // 收集所有目录：folder_path + paths
        const dirs = [];
        if (task.folder_path) dirs.push(task.folder_path);
        if (Array.isArray(task.paths)) dirs.push(...task.paths);
        if (dirs.length === 0) {
          // 没有目录，打开详情面板让用户手动关联
          await selectTask(taskId);
          await scanConversations('');
          showScanModal.value = true;
          return;
        }
        // 扫描所有关联目录
        let latest = null;
        for (const dir of dirs) {
          const results = await api(`/api/conversations/scan?directory=${encodeURIComponent(dir)}`);
          if (results && results.length > 0) {
            const candidate = results[0];
            if (!latest || (candidate.created_at || '') > (latest.created_at || '')) {
              latest = candidate;
            }
          }
        }
        if (latest) {
          // 关联并继续
          await api(`/api/tasks/${taskId}/conversations`, { method: 'POST', body: latest });
          const newConvs = await api(`/api/tasks/${taskId}/conversations`);
          if (newConvs && newConvs.length > 0) {
            await api(`/api/conversations/${newConvs[0].id}/continue`, { method: 'POST' });
          }
        } else {
          // 没找到，打开扫描弹窗
          await selectTask(taskId);
          await scanConversations(dirs[0]);
          showScanModal.value = true;
        }
      } catch (e) {
        console.error('quickContinueConversation error:', e);
      }
    }

    // ==================== 子任务 ====================

    async function addSubtask() {
      if (!newSubtaskTitle.value.trim() || !selectedTask.value) return;
      await api(`/api/tasks/${selectedTask.value.id}/subtasks`, {
        method: 'POST',
        body: { title: newSubtaskTitle.value.trim() }
      });
      newSubtaskTitle.value = '';
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    async function toggleSubtask(subtask) {
      await api(`/api/subtasks/${subtask.id}`, {
        method: 'PUT',
        body: { status: subtask.status === 'done' ? 'todo' : 'done' }
      });
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    async function deleteSubtask(id) {
      await api(`/api/subtasks/${id}`, { method: 'DELETE' });
      selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
    }

    async function aiDecompose() {
      if (!selectedTask.value) return;
      aiDecomposing.value = true;
      try {
        const result = await api('/api/ai/decompose', {
          method: 'POST',
          body: {
            title: selectedTask.value.title,
            description: selectedTask.value.description,
            context: selectedTask.value.context,
          }
        });
        for (const title of result.subtasks) {
          await api(`/api/tasks/${selectedTask.value.id}/subtasks`, {
            method: 'POST',
            body: { title }
          });
        }
        selectedTask.value = await api(`/api/tasks/${selectedTask.value.id}`);
      } catch (e) {
        alert('AI 分解失败: ' + e.message);
      }
      aiDecomposing.value = false;
    }

    // ==================== 联系人 ====================

    async function loadContacts() {
      contacts.value = await api('/api/contacts');
    }

    function editContact(c) {
      editingContactId.value = c.id;
      Object.assign(contactForm, { name: c.name, employee_id: c.employee_id, email: c.email, relationship: c.relationship });
    }

    async function saveContact() {
      if (!contactForm.name.trim()) return;
      if (editingContactId.value) {
        await api(`/api/contacts/${editingContactId.value}`, { method: 'PUT', body: { ...contactForm } });
        editingContactId.value = null;
      } else {
        await api('/api/contacts', { method: 'POST', body: { ...contactForm } });
      }
      Object.assign(contactForm, { name: '', employee_id: '', email: '', relationship: '' });
      await loadContacts();
    }

    async function deleteContact(id) {
      await api(`/api/contacts/${id}`, { method: 'DELETE' });
      await loadContacts();
    }

    // ==================== 深色模式 ====================

    function toggleDarkMode() {
      darkMode.value = !darkMode.value;
      document.body.classList.toggle('dark', darkMode.value);
      localStorage.setItem('darkMode', darkMode.value);
    }

    // ==================== 备份 ====================

    function downloadBackup() {
      window.open('/api/backup', '_blank');
    }

    function restoreBackup() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.db';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch('/api/restore', { method: 'POST', body: formData });
          const result = await res.json();
          alert(result.message || '恢复成功');
          location.reload();
        } catch (e) {
          alert('恢复失败: ' + e.message);
        }
      };
      input.click();
    }

    // ==================== 任务复制 ====================

    async function copyTask(taskId) {
      const t = await api(`/api/tasks/${taskId}`);
      const id = await api('/api/tasks', {
        method: 'POST',
        body: {
          title: t.title + ' (副本)',
          description: t.description,
          context: t.context,
          goal_id: t.goal_id,
          routine_id: t.routine_id,
          tag_ids: (t.tags || []).map(tag => tag.id),
          people: (t.people || []).map(p => p.name),
          estimated_time: t.estimated_time,
          due_date: t.due_date || null,
          create_folder: false,
        }
      });
      await loadTasks();
      selectTask(id.id);
    }

    return {
      currentView, sidebarCollapsed,
      goals, routines, tasks, tags, settings,
      filterStatus, filterGoalId, filterTagIds, filterToday, searchQuery,
      selectedTaskId, selectedTask, analyzingTaskId,
      showQuickAdd, showGoalModal, showRoutineModal, showTimeLog, timeEditing, showImportModal,
      importDir, importItems, importScanning, importing,
      importSelectedCount, importSelectedAll,
      scanImportDir, toggleImportAll, executeImport,
      editingGoal, editingRoutine, goalForm, routineForm,
      newTask, newTagName, newTagDimension, newTagIcon, emojiPickerFor, commonEmojis, selectTagEmoji, newPerson,
      timeLogDuration, timeLogNote,
      isDragging, fileInput,
      statsDays, timeStats, goalStats,
      reviewType, reviewData,
      autoCreateFolder, statuses,
      showAIChat, aiMessages, aiInput, aiStreaming, aiStreamContent, aiChatMessages,
      filteredTasks, totalTasksCount, completedTasksCount, totalTimeSpent,
      switchView, goToTask, toggleGoalFilter, toggleTagFilter, debounceSearch,
      openQuickAdd, quickCreateTask, toggleNewTaskTag,
      selectTask, closeDetail, saveSelectedTask, changeStatus, deleteSelectedTask,
      isTaskTagged, toggleTaskTag, addTag, removeTag, updateTag,
      addPerson, removePerson,
      logTime,
      triggerFileInput, handleFileDrop, handleFileSelect,
      deleteAttachment, openAttachment, openFolder, openWithEditor,
      quickNote, appendingNote, appendToReadme,
      noteCards, newCardText, newItemTexts,
      loadNoteCards, createCard, renameCard, deleteCard,
      addItem, updateItem, deleteItem,
      unlinkFolder,
      saveGoal, editGoal, archiveGoal, loadGoalStats, goalProgress,
      saveRoutine, editRoutine, archiveRoutine, createTaskFromRoutine,
      loadTimeStats, loadReview, barHeight,
      saveSettings,
      aiConfigs, activeAIConfig, addAIConfig, removeAIConfig, switchAIModel, saveAIConfigs, aiConfigSaved, showAIConfigJson, aiConfigsJson,
      testAIConnection, aiTestResult,
      statusLabel, freqLabel, isOverdue, formatDate, formatChartDate,
      fileIcon, formatSize,
      goalTaskFolders, openFolderFor,
      pickFolderFor, pickFileFor, refreshGoalPaths, addGoalPath, removeGoalPath, addTaskPath, removeTaskPath,
      onPathDragStart, onPathDragOver, onPathDrop, setPrimaryPath,
      pathReadmeStatus, checkPathReadme, checkAllPathReadmes,
      expandedProgress, dragPathIndex, dragPathOverIndex,
      openDirBrowser,
      launchTerminal,
      clearAIChat, closeAIChat, sendAIMessage, sendAIPrompt, renderMarkdown,
      noteChatCardId, noteConversations, openNoteChat,
      // Timer
      activeTimers, startTaskTimer, stopTaskTimer, isTimerActive, getTimerElapsed, formatTime,
      // Today
      toggleToday,
      // Subtasks
      newSubtaskTitle, addSubtask, toggleSubtask, deleteSubtask, aiDecompose, aiDecomposing,
      // Contacts
      contacts, contactForm, editingContactId, loadContacts, editContact, saveContact, deleteContact,
      // Dark mode
      darkMode, toggleDarkMode,
      // Backup
      downloadBackup, restoreBackup,
      // Copy
      copyTask, analyzeTaskProgress,
      // Kanban
      kanbanDragOver, kanbanColumns,
      // Batch
      batchMode, batchSelected, batchStatus, batchGoalId,
      toggleBatchSelect, applyBatchStatus, applyBatchGoal, batchToggleToday, batchDelete,
      settingsTab,
      // Subtask/parent helpers
      subtaskDoneCount, subtaskPercent, childTaskCount,
      // Kanban drag
      onKanbanDragStart, onKanbanDragOver, onKanbanDragLeave, onKanbanDrop,
      // Dashboard
      upcomingDeadlines, recentCompleted, pressureTasks, pressureAnalysis, analyzingPressure, analyzePressure, pressureChatMode, savePressureAnalysis,
      // Reports
      filterReportOnly, reportMeetings, loadReportMeetings, groupedReportTasks,
      // Conversations
      taskConversations, scanResults, scanningConversations, showScanModal,
      loadTaskConversations, scanConversations, linkConversation, unlinkConversation, continueConversation, quickContinueConversation,
      // Calendar
      calendarYear, calendarMonth, calendarWeeks, calendarViewMode, calendarWeekDays,
      timelineGroups,
      calendarPrevMonth, calendarNextMonth, calendarPrevWeek, calendarNextWeek,
      // Quick input
      quickInputText, quickInputParsed, createFromQuickInput,
      // AI suggestions
      aiSuggestions, aiEnriching, aiPickFolder, applyAISuggestions, dismissAISuggestions,
      ensureTaskFolder, createFolderWithName,
      // Goal target date
      saveGoalTargetDate,
      // Task files
      // Today
      todayTasks, todayTimeBudget,
      // Report
      aiReportContent, aiGeneratingReport, generateReport, copyReportText,
      reportHistory, selectedReport, loadReports, deleteReport, copyReportContent,
      // Week info
      weekInfo,
    };
  }
}).mount('#app');
