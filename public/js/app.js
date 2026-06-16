const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

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
    const kanbanDragOverTaskId = ref(null);
    const kanbanDropPosition = ref('after'); // 'before' | 'after'
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

    function onKanbanCardDragOver(e, task) {
      kanbanDragOver.value = null;
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      kanbanDragOverTaskId.value = task.id;
      kanbanDropPosition.value = e.clientY < midY ? 'before' : 'after';
    }

    function onKanbanCardDragLeave(e, task) {
      if (kanbanDragOverTaskId.value === task.id) {
        kanbanDragOverTaskId.value = null;
      }
    }

    function getStatusGroup(s) { return (s === 'todo' || s === 'in-progress') ? 'active' : s; }

    async function onKanbanCardDrop(e, col, targetTask) {
      e.preventDefault();
      const taskId = parseInt(e.dataTransfer.getData('text/plain'));
      clearKanbanDrag();
      if (!taskId || taskId === targetTask.id) return;
      const task = tasks.value.find(t => t.id === taskId);
      if (!task) return;

      const colTasks = col.tasks;
      const targetIndex = colTasks.findIndex(t => t.id === targetTask.id);
      if (targetIndex < 0) return;

      // calculate sort_order between neighbors
      const prevSort = targetIndex > 0 ? (colTasks[targetIndex - 1].sort_order || 0) : null;
      const nextSort = targetIndex < colTasks.length - 1 ? (colTasks[targetIndex + 1].sort_order || 0) : null;
      const targetSort = targetTask.sort_order || 0;

      let newSortOrder;
      if (kanbanDropPosition.value === 'before') {
        newSortOrder = prevSort != null ? (targetSort + prevSort) / 2 : targetSort - 1;
      } else {
        newSortOrder = nextSort != null ? (targetSort + nextSort) / 2 : targetSort + 1;
      }

      const sameGroup = getStatusGroup(task.status) === getStatusGroup(targetTask.status);
      const body = { sort_order: newSortOrder };
      if (!sameGroup) {
        body.status = col.status === 'active' ? 'in-progress' : col.status;
      }
      await api(`/api/tasks/${taskId}`, { method: 'PUT', body });
      await loadTasks();
      if (selectedTask.value?.id === taskId) {
        selectedTask.value = await api(`/api/tasks/${taskId}`);
      }
    }

    async function onKanbanDrop(e, status) {
      // drop on column area (empty space between cards)
      const taskId = parseInt(e.dataTransfer.getData('text/plain'));
      clearKanbanDrag();
      if (!taskId) return;
      const task = tasks.value.find(t => t.id === taskId);
      if (!task) return;
      const targetStatus = status === 'active' ? 'in-progress' : status;
      const colTasks = kanbanColumns.value.find(c => c.status === status)?.tasks || [];

      if (task.status === targetStatus) {
        // 同列拖拽到空隙：移到列末尾
        const lastSort = colTasks.length > 0 ? (colTasks[colTasks.length - 1].sort_order || 0) + 1 : 0;
        await api(`/api/tasks/${taskId}`, { method: 'PUT', body: { sort_order: lastSort } });
      } else {
        // 跨列拖拽：改状态，放到目标列顶部
        const topSort = colTasks.length > 0 ? (colTasks[0].sort_order || 0) - 1 : 0;
        await api(`/api/tasks/${taskId}`, { method: 'PUT', body: { status: targetStatus, sort_order: topSort } });
      }
      await loadTasks();
      if (selectedTask.value?.id === taskId) {
        selectedTask.value = await api(`/api/tasks/${taskId}`);
      }
    }

    function clearKanbanDrag() {
      kanbanDragOver.value = null;
      kanbanDragOverTaskId.value = null;
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
      tag_ids: [], due_date: new Date(Date.now() + 7*86400000).toISOString().slice(0, 10),
      estimated_time: 0,
      people_str: '', create_folder: true,
      is_report: false, report_meeting: '',
      is_today: false,
      folder_name: '', reuse_folder_path: '', subtasks: [],
    });

    // 标签管理
    const newTagName = ref('');
    const newTagDimension = ref('value');
    const newTagIcon = ref('');
    const emojiPickerFor = ref(null);
    const commonEmojis = '🔥 ⭐ 🚀 💡 📌 🎯 ⚡ 🔔 💼 📊 🏠 📝 🔧 🛠 📋 🏷 🎨 💬 🧠 🎵 📚 🗂 🔍 ⚙️ 💰 📅 🏃 🎪 🔮 🧩 🏆 🎭 🌟 💎 🕐 📢 🗣 🌍 💻 🎓 🧪 🛡️ 🔑 📎 ✨ 💪 🤝 🎁 🏗 🧹 📈 🧲 💊 🔬 📡 🏥 🚧 🎲 📖 🖊️ ✅ ❌ ❓ 💭 🗳️ 📨 🔗 🧭 🪜 🎻'.split(' ');
    // 笔记条目行首图标选择器
    const noteItemIconPicker = ref(null);
    const noteItemIcons = ['🚩', '⚫', '📌', '💡', '⚠️', '✅', '❤️', '⭐', '🔥', '🚧', '❌', '❓', '🎯', '🏁', '💎', '🗑️'];
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

    // 笔记条目图标：默认值规则 —— 顶层🚩 / 子项⚫
    function displayItemIcon(item) {
      if (item.icon) return item.icon;
      return item.parent_id ? '⚫' : '🚩';
    }
    function toggleItemIconPicker(itemId) {
      noteItemIconPicker.value = noteItemIconPicker.value === itemId ? null : itemId;
    }
    async function setItemIcon(item, icon) {
      // 保存原始值，失败时回滚（避免把已有图标错误清成 null）
      const oldIcon = item.icon;
      item.icon = icon;
      noteItemIconPicker.value = null;
      try {
        await api(`/api/note-items/${item.id}`, { method: 'PUT', body: { icon } });
      } catch (e) {
        item.icon = oldIcon;
      }
    }
    async function clearItemIcon(item) {
      const prev = item.icon;
      item.icon = null;
      noteItemIconPicker.value = null;
      try {
        await api(`/api/note-items/${item.id}`, { method: 'PUT', body: { icon: null } });
      } catch (e) {
        item.icon = prev;
      }
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

    // 全局 AI 推理进度条（模拟进度，因 API 非流式无法预知真实进度）
    const aiProgress = reactive({ active: false, percent: 0, text: '' });
    let aiProgressTimer = null;
    function startAIProgress(text) {
      aiProgress.active = true;
      aiProgress.percent = 0;
      aiProgress.text = text || 'AI 推理中…';
      if (aiProgressTimer) clearInterval(aiProgressTimer);
      // 每 250ms 增长，开始快后慢，封顶 92%（剩余 8% 留给完成）
      aiProgressTimer = setInterval(() => {
        const remaining = 92 - aiProgress.percent;
        const step = Math.max(0.5, remaining * 0.08);
        aiProgress.percent = Math.min(92, aiProgress.percent + step);
      }, 250);
    }
    function stopAIProgress() {
      if (aiProgressTimer) { clearInterval(aiProgressTimer); aiProgressTimer = null; }
      aiProgress.percent = 100;
      // 600ms 让用户看到 100%，再隐藏
      setTimeout(() => { aiProgress.active = false; aiProgress.percent = 0; }, 600);
    }

    // 笔记卡片 AI 对话
    const noteChatCardId = ref(null);
    const noteConversations = reactive({});

    // 统计
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
    const NOTE_CATEGORIES = [
      { key: '随手记', icon: '📝', color: '#6b7280' },
      { key: '命令', icon: '💻', color: '#2563eb' },
      { key: 'Patch', icon: '🔧', color: '#ea580c' },
      { key: 'Idea', icon: '💡', color: '#eab308' },
      { key: '手里剑', icon: '⚡', color: '#7c3aed' },
    ];
    const noteCards = ref([]);
    const cardSizes = ref({});

    // 气泡快速输入
    const bubbleInput = reactive({ visible: false, categoryKey: '', text: '' });
    const bubbleInputRef = ref(null);
    const bubblePillRect = ref(null);

    const bubbleStyle = computed(() => {
      if (!bubblePillRect.value) return { display: 'none' };
      const r = bubblePillRect.value;
      return {
        left: (r.left + r.width / 2) + 'px',
        top: (r.bottom + 8) + 'px',
        transform: 'translateX(-50%)',
      };
    });

    function getCatByKey(key) {
      return NOTE_CATEGORIES.find(c => c.key === key);
    }

    async function showBubbleInput(catKey, event) {
      const el = event.currentTarget;
      bubblePillRect.value = el ? el.getBoundingClientRect() : null;
      bubbleInput.categoryKey = catKey;
      bubbleInput.text = '';
      bubbleInput.visible = true;
      await nextTick();
      if (bubbleInputRef.value) bubbleInputRef.value.focus();
    }

    async function submitBubbleInput() {
      const text = bubbleInput.text.trim();
      if (!text) return;
      const catKey = bubbleInput.categoryKey;
      // 始终创建新卡片
      const result = await api('/api/note-cards', { method: 'POST', body: { category: catKey, content: text } });
      // 为新卡片立即预留默认尺寸，防止 applyCardMinSizes 的 setTimeout 150ms 期间
      // 用户切换分类导致 cardSizes 未及时写入，从而 :style 返回 {} → 卡片塌缩
      if (result?.id) {
        cardSizes.value[result.id] = { w: 320, h: 180, mw: 200, mh: 120 };
      }
      filterNoteCategory.value = null; // 切回"全部"，避免卡被筛掉
      await loadNoteCards();
      dismissBubbleInput();
    }

    function dismissBubbleInput() {
      bubbleInput.visible = false;
      bubbleInput.text = '';
      bubblePillRect.value = null;
    }

    function loadCardSizes() {
      try {
        const saved = localStorage.getItem('noteCardSizes');
        if (saved) {
          const parsed = JSON.parse(saved);
          // 旧版本数据可能缺少 mw/mh 字段，补全为 0（首次访问时由 applyCardMinSizes 计算）
          for (const id of Object.keys(parsed)) {
            if (parsed[id] && typeof parsed[id] === 'object') {
              if (parsed[id].mw === undefined) parsed[id].mw = 0;
              if (parsed[id].mh === undefined) parsed[id].mh = 0;
              // 防御性：过滤掉无效数据
              if (!parsed[id].w || parsed[id].w < 0) delete parsed[id];
            } else {
              delete parsed[id];
            }
          }
          cardSizes.value = parsed;
        }
      } catch (e) { /* ignore */ }
    }
    function saveCardSizesFromDOM() {
      const sizes = {};
      document.querySelectorAll('.note-card').forEach(el => {
        const cardId = el.dataset.cardId;
        if (!cardId) return;
        const r = el.getBoundingClientRect();
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        if (w > 0 && h > 0) {
          // 保留已存的 mw/mh（从 cardSizes reactive 读）
          const saved = cardSizes.value[cardId] || {};
          sizes[cardId] = { w, h, mw: saved.mw || 0, mh: saved.mh || 0 };
        }
      });
      localStorage.setItem('noteCardSizes', JSON.stringify(sizes));
    }
    let saveCardSizesTimer = null;
    function debouncedSaveCardSizes() {
      clearTimeout(saveCardSizesTimer);
      saveCardSizesTimer = setTimeout(() => {
        // 从 cardSizes reactive 状态保存，移除宽高为 0 的条目
        const sizes = {};
        for (const [id, s] of Object.entries(cardSizes.value)) {
          if (s && s.w > 0) {
            sizes[id] = { w: s.w, h: s.h || 0, mw: s.mw || 0, mh: s.mh || 0 };
          }
        }
        localStorage.setItem('noteCardSizes', JSON.stringify(sizes));
      }, 100);
    }
    let cardResizeObserver = null;

    function calcCardMinHeight(el) {
      // 临时把 .note-items 的 flex 伸缩和 overflow 裁切解除，
      // 得到真实内容高度，否则 flex: 1 拉伸后 scrollHeight 会包含
      // 被拉伸的多余空间，导致 minHeight 偏大。
      // 返回数值（px），不再直接设置 el.style.minHeight —— 改由 Vue :style 应用
      let contentH = 0;
      const itemsEl = el.querySelector('.note-items');
      let itemsRealH = 0;
      if (itemsEl) {
        const prevOY = itemsEl.style.overflowY;
        const prevFlex = itemsEl.style.flex;
        itemsEl.style.overflowY = 'visible';
        itemsEl.style.flex = '0 0 auto';
        void itemsEl.offsetHeight;
        itemsRealH = itemsEl.scrollHeight;
        itemsEl.style.overflowY = prevOY;
        itemsEl.style.flex = prevFlex;
      }
      for (const child of el.children) {
        contentH += (child === itemsEl) ? itemsRealH : child.offsetHeight;
      }
      const cs = getComputedStyle(el);
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const borderBot = parseFloat(cs.borderBottomWidth) || 0;
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBot = parseFloat(cs.paddingBottom) || 0;
      // 兜底 120px，防止 contentH=0 时 minHeight=0 导致 :style minHeight:0px 覆盖 CSS 默认值
      return Math.max(contentH + padTop + padBot + borderTop + borderBot, 120);
    }

    function calcCardMinWidth(el) {
      // 测量"完整标题文本宽度 + 其他 header 子元素宽度"，作为卡片最小宽度。
      // 这样无论用户怎么缩小，标题文字都能完整显示，且不会过度预留空间。
      const header = el.querySelector('.note-card-header');
      if (!header) return 200; // 兜底
      const titleEl = header.querySelector('.note-card-title');

      // 1. 测量标题完整文本宽度（克隆法）
      let titleFullW = 0;
      if (titleEl) {
        const tcs = getComputedStyle(titleEl);
        const span = document.createElement('span');
        span.style.fontSize = tcs.fontSize;
        span.style.fontWeight = tcs.fontWeight;
        span.style.fontFamily = tcs.fontFamily;
        span.style.letterSpacing = tcs.letterSpacing;
        span.style.position = 'absolute';
        span.style.visibility = 'hidden';
        span.style.whiteSpace = 'nowrap';
        span.textContent = titleEl.value || '未命名';
        document.body.appendChild(span);
        const tpadL = parseFloat(tcs.paddingLeft) || 0;
        const tpadR = parseFloat(tcs.paddingRight) || 0;
        titleFullW = span.offsetWidth + tpadL + tpadR + 2;
        document.body.removeChild(span);
      }

      // 2. 累加其他子元素的实际宽度
      let otherW = 0;
      let otherCount = 0;
      for (const child of header.children) {
        if (child !== titleEl) {
          otherW += child.offsetWidth;
          otherCount++;
        }
      }

      // 3. 加上 gap（子元素总数 - 1 个 gap）和 header padding
      const hcs = getComputedStyle(header);
      const gap = parseFloat(hcs.gap) || 6;
      const padL = parseFloat(hcs.paddingLeft) || 0;
      const padR = parseFloat(hcs.paddingRight) || 0;
      const totalChildren = (titleEl ? 1 : 0) + otherCount;
      const totalGaps = totalChildren > 1 ? (totalChildren - 1) * gap : 0;

      // 加 2px 容差 + 卡片 border（左右各 1px）
      // 兜底 200px，防止测量异常返回 0 被 :style minWidth:0px 覆盖 CSS 默认值
      return Math.max(titleFullW + otherW + totalGaps + padL + padR + 2, 200);
    }

    function fitTitleWidth(input) {
      if (!input || !input.value) return;
      const cs = getComputedStyle(input);
      const span = document.createElement('span');
      span.style.fontSize = cs.fontSize;
      span.style.fontWeight = cs.fontWeight;
      span.style.fontFamily = cs.fontFamily;
      span.style.letterSpacing = cs.letterSpacing;
      span.style.position = 'absolute';
      span.style.visibility = 'hidden';
      span.style.whiteSpace = 'nowrap';
      span.textContent = input.value;
      document.body.appendChild(span);
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const padRight = parseFloat(cs.paddingRight) || 0;
      input.style.width = (span.offsetWidth + padLeft + padRight + 2) + 'px'; // +2 防小数取整偏差
      document.body.removeChild(span);
    }

    function fitAllTitleWidths() {
      document.querySelectorAll('.note-card-title').forEach(fitTitleWidth);
    }

    function applyCardMinSizes() {
      setTimeout(() => {
        if (cardResizeObserver) cardResizeObserver.disconnect();
        cardResizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            // 用 getBoundingClientRect 取 border-box 尺寸，与 Vue 的 width/height 属性一致
            // （全局 box-sizing: border-box，contentBoxSize 会少算 border 导致持续收缩）
            const rect = entry.target.getBoundingClientRect();
            const newW = Math.round(rect.width);
            const newH = Math.round(rect.height);
            // 关键修复：元素被 Vue 销毁时（切换胶囊/删除卡片），ResizeObserver 会最后一次触发
            // 此时 getBoundingClientRect 返回 0×0，如果不过滤会把 w:0/h:0 写入 cardSizes，
            // 导致下次切换回来时 :style 应用 width:0，卡片塌缩成 minWidth×minHeight
            if (newW === 0 || newH === 0) continue;
            const oldW = parseFloat(entry.target.dataset.lastWidth) || 0;
            const oldH = parseFloat(entry.target.dataset.lastHeight) || 0;
            const wChanged = Math.abs(newW - oldW) > 0.5;
            const hChanged = Math.abs(newH - oldH) > 0.5;
            const cardId = entry.target.dataset.cardId;
            if (!cardId) continue;
            if (!wChanged && !hChanged) continue;
            entry.target.dataset.lastWidth = newW;
            entry.target.dataset.lastHeight = newH;
            const cur = cardSizes.value[cardId] || {};
            const mw = cur.mw || calcCardMinWidth(entry.target);
            // 宽度变化 → 内容回流 → 重算 minHeight；高度变化 → 直接复用旧 mh
            const mh = wChanged ? calcCardMinHeight(entry.target) : (cur.mh || calcCardMinHeight(entry.target));
            // 只有尺寸真正变化（>1px）才写持久化值，避免测量噪声无限循环
            const sameW = cur.w && Math.abs(newW - cur.w) <= 1;
            const sameH = cur.h && Math.abs(newH - cur.h) <= 1;
            if (sameW && sameH && cur.mw === mw && cur.mh === mh) continue;
            cardSizes.value[cardId] = { w: newW, h: newH, mw, mh };
            debouncedSaveCardSizes();
          }
        });
        // 先读取所有卡片的实际 DOM 尺寸，防止后续测量覆盖用户已拖动的尺寸
        // 用 getBoundingClientRect 取 border-box 尺寸，与 Vue width/height 一致
        const domSizes = {};
        document.querySelectorAll('.note-card').forEach(el => {
          const id = el.dataset.cardId;
          if (id) {
            const r = el.getBoundingClientRect();
            domSizes[id] = { w: Math.round(r.width), h: Math.round(r.height) };
          }
        });
        // 1. 先把所有标题宽度 fit 好
        fitAllTitleWidths();
        // 2. 测量每张卡片的 minWidth / minHeight，并写入 cardSizes
        document.querySelectorAll('.note-card').forEach(el => {
          const cardId = el.dataset.cardId;
          if (!cardId) return;
          const mw = calcCardMinWidth(el);
          const mh = calcCardMinHeight(el);
          const saved = cardSizes.value[cardId];
          const cur = domSizes[cardId];
          if (!saved || !saved.w) {
            // 新卡片：用实际 DOM 尺寸（用户可能已拖动），不低于 minWidth
            const w = Math.max(cur?.w || 0, mw);
            const h = Math.max(cur?.h || 0, mh);
            cardSizes.value[cardId] = { w, h, mw, mh };
            debouncedSaveCardSizes();
          } else {
            // 已有保存尺寸：优先用 DOM 当前尺寸（用户可能在 setTimeout 150ms 期间拖动了卡片，
            // 此时 saved 的 w/h 是旧值，会覆盖用户最新的拖动 → "跳回" bug）
            // 如果 DOM 尺寸 == saved 尺寸（用户没拖动），赋值相同值不会触发响应式
            const dw = cur?.w ?? saved.w;
            const dh = cur?.h ?? saved.h;
            if (saved.w !== dw || saved.h !== dh || saved.mw !== mw || saved.mh !== mh) {
              cardSizes.value[cardId] = { w: dw, h: dh, mw, mh };
              debouncedSaveCardSizes();
            }
          }
          // 同步 lastWidth/lastHeight 到当前实际值，避免 ResizeObserver 误判变化
          const r = el.getBoundingClientRect();
          el.dataset.lastWidth = Math.round(r.width);
          el.dataset.lastHeight = Math.round(r.height);
          el.dataset.observed = '1';
          cardResizeObserver.observe(el);
        });
      }, 150);
    }

    const newCardText = ref('');
    const newCardCategory = ref('随手记');
    const filterNoteCategory = ref(null);
    const newItemTexts = reactive({});
    const editingItemId = ref(null);

    const filteredNoteCards = computed(() => {
      if (!filterNoteCategory.value) return noteCards.value;
      return noteCards.value.filter(c => (c.category || '随手记') === filterNoteCategory.value);
    });

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
    const aiInferringQuickAdd = ref(false);

    // 周数 & 剩余天数
    function getISOWeek(d) {
      const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const dayNum = date.getDay() || 7;
      date.setDate(date.getDate() + 4 - dayNum);
      const yearStart = new Date(date.getFullYear(), 0, 1);
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
    const calendarTab = ref('calendar'); // 'calendar' | 'gantt'

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
      await Promise.all([loadGoals(), loadRoutines(), loadTasks(), loadTags(), loadSettings(), loadContacts(), loadNoteCards(), refreshTimers()]);
      loadNoteConversations();
    }

    // ==================== 视图切换 ====================
    function switchView(view) {
      if (view === 'gantt') view = 'calendar';
      if (currentView.value === 'notes' && view !== 'notes') saveCardSizesFromDOM();
      // 离开 graph 视图时停止 rAF 循环和容器监听，避免持续渲染浪费 CPU
      if (currentView.value === 'graph' && view !== 'graph') {
        if (gAnimId) { cancelAnimationFrame(gAnimId); gAnimId = null; }
        if (window._graphResizeObserver) { window._graphResizeObserver.disconnect(); window._graphResizeObserver = null; }
      }
      currentView.value = view;
      if (view !== 'kanban') closeDetail();
      if (view === 'goals') loadGoalStats();
      if (view === 'dashboard') { loadReview(); loadReports(); }
      if (view === 'notes') loadNoteCards();
      if (view === 'reports') view = 'routines';
      if (view === 'routines') loadReportMeetings();
      if (view === 'graph') { nextTick(() => initGraph()); }
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

    // ==================== 甘特图 ====================
    const ganttRows = ref(null);
    const ganttScaleBody = ref(null);
    function syncGanttScroll(source, target) {
      if (!source || !target) return;
      target.scrollLeft = source.scrollLeft;
    }

    const ganttData = computed(() => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTs = today.getTime();
      // 筛选有截止日期的活跃任务
      const active = tasks.value.filter(t => t.due_date && t.status !== 'done');
      if (!active.length) return null;
      // 找出最早和最晚日期
      let minDate = todayStr(), maxDate = todayStr();
      for (const t of active) {
        const s = t.created_at ? t.created_at.slice(0, 10) : todayStr();
        if (s < minDate) minDate = s;
        if (t.due_date < minDate) minDate = t.due_date;
        if (t.due_date > maxDate) maxDate = t.due_date;
      }
      // 对齐到周一，末尾对齐到周日
      const minD = new Date(minDate);
      minD.setDate(minD.getDate() - (minD.getDay() || 7) + 1);
      const maxD = new Date(maxDate);
      maxD.setDate(maxD.getDate() + (7 - (maxD.getDay() || 7)));
      const totalDays = Math.max(14, Math.ceil((maxD - minD) / 86400000) + 1);
      const startTs = minD.getTime();
      const endTs = startTs + totalDays * 86400000;
      const totalMs = totalDays * 86400000;
      // 生成天列表 + 月分组
      const days = [];
      const months = [];
      let curMonth = -1;
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(startTs + i * 86400000);
        const m = d.getMonth() + 1;
        const dayNum = d.getDate();
        const isToday = d.getTime() === todayTs;
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        days.push({ label: dayNum, isToday, isWeekend, month: m });
        if (m !== curMonth) {
          curMonth = m;
          months.push({ label: m + '月', startIdx: i, count: 0 });
        }
        months[months.length - 1].count++;
      }
      // 汇总所有任务每天投入的时间（分钟）
      let globalMaxDaily = 0;
      const taskMaps = []; // [{dailyMap, task}]
      for (const t of active) {
        const dm = {};
        if (t.time_logs) {
          for (const log of t.time_logs) {
            const dateStr = log.logged_at ? log.logged_at.slice(0, 10) : '';
            if (dateStr) {
              dm[dateStr] = (dm[dateStr] || 0) + (log.duration || 0);
            }
          }
        }
        for (const v of Object.values(dm)) {
          if (v > globalMaxDaily) globalMaxDaily = v;
        }
        taskMaps.push({ dm, task: t });
      }
      if (globalMaxDaily <= 0) globalMaxDaily = 60;

      const dayPct = 100 / totalDays;
      // 构建gantt任务对象（不修改原task，避免触发响应式循环）
      const ganttTasks = [];
      for (const { dm, task: t } of taskMaps) {
        const s = t.created_at ? new Date(t.created_at.slice(0, 10)).getTime() : todayTs;
        const e = new Date(t.due_date).getTime();
        const barLeft = Math.max(0, ((s - startTs) / totalMs) * 100);
        const barWidth = Math.max(dayPct, ((e - Math.max(s, startTs)) / totalMs) * 100);
        const segs = [];
        const startDay = Math.floor((Math.max(s, startTs) - startTs) / 86400000);
        const endDay = Math.min(totalDays - 1, Math.floor((e - startTs) / 86400000));
        for (let di = startDay; di <= endDay; di++) {
          const d = new Date(startTs + di * 86400000);
          const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          const mins = dm[ds] || 0;
          const alpha = mins > 0 ? (0.2 + 0.8 * (mins / globalMaxDaily)) : 0.08;
          segs.push({ left: di * dayPct, width: dayPct, alpha });
        }
        ganttTasks.push({
          id: t.id, title: t.title, due_date: t.due_date, goal_id: t.goal_id,
          barLeft, barWidth, segments: segs, dateLabel: t.due_date
        });
      }
      // 计算今天线的百分比
      const todayPercent = ((todayTs - startTs) / totalMs) * 100;
      // 按goal分组
      const goalMap = new Map();
      for (const gt of ganttTasks) {
        const gid = gt.goal_id || '_none';
        if (!goalMap.has(gid)) {
          const g = goals.value.find(gg => gg.id === gid);
          goalMap.set(gid, {
            goalId: gid,
            goalName: g ? g.name : '其他',
            color: g ? g.color : '#9ca3af',
            tasks: []
          });
        }
        goalMap.get(gid).tasks.push(gt);
      }
      for (const g of goalMap.values()) {
        g.tasks.sort((a, b) => a.due_date.localeCompare(b.due_date));
      }
      const groups = [...goalMap.values()].sort((a, b) => {
        if (a.goalId === '_none') return 1;
        if (b.goalId === '_none') return -1;
        return 0;
      });
      const COL_W = 32;
      const trackWidth = totalDays * COL_W;
      return { days, months, groups, todayPercent, totalDays, trackWidth };
    });
    function todayStr() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    function toggleGoalFilter(goalId) {
      filterGoalId.value = filterGoalId.value === goalId ? null : goalId;
      currentView.value = 'kanban';
      loadTasks();
    }

    // ==================== 关联图谱 ====================
    const graphTooltip = ref(null);
    const graphCanvas = ref(null);
    const graphCanvasWrap = ref(null);
    const graphZoom = ref(1);
    let gNodes = [], gEdges = [], gAnimId = null, gCtx = null;
    let gScale = 1, gOffX = 0, gOffY = 0, gDPR = 1;
    let gDragging = null, gHovered = null, gDragOX = 0, gDragOY = 0;
    let gFocused = null, gClickNode = null, gClickTimer = null, gDragMoved = false;
    let gParticles = [], gTime = 0;

    function buildGraph() {
      const activeGoals = goals.value.filter(g => !g.archived);
      const activeTasks = tasks.value.filter(t => t.status !== 'done');
      if (!activeGoals.length && !activeTasks.length) { gNodes = []; gEdges = []; return; }
      // 收集每个goal的tag和人员
      const goalTags = {}, goalPeople = {};
      for (const g of activeGoals) {
        const ts = new Set(), ps = new Set();
        for (const t of tasks.value) {
          if (t.goal_id === g.id) {
            if (t.tags) for (const tag of t.tags) ts.add(tag.name || tag.id);
            if (t.people) for (const p of t.people) ps.add(typeof p === 'string' ? p : p.name);
          }
        }
        goalTags[g.id] = ts;
        goalPeople[g.id] = ps;
      }
      // 目标节点
      const cx = (window.innerWidth - 300) / 2;
      const cy = window.innerHeight / 2 - 80;
      gNodes = activeGoals.map((g, i) => {
        const angle = (2 * Math.PI * i) / Math.max(activeGoals.length, 1);
        const r = Math.min(480, Math.max(activeGoals.length, 1) * 100);
        const myTasks = tasks.value.filter(t => t.goal_id === g.id);
        const total = myTasks.length;
        const done = myTasks.filter(t => t.status === 'done').length;
        return {
          id: g.id, label: g.name, color: g.color, type: 'goal',
          radius: 20 + Math.min(total * 2.5, 26),
          x: cx + Math.cos(angle) * r + (Math.random() - 0.5) * 40,
          y: cy + Math.sin(angle) * r + (Math.random() - 0.5) * 40,
          vx: 0, vy: 0, total, done,
          tags: [...goalTags[g.id]], people: [...goalPeople[g.id]]
        };
      });
      // 任务节点 — 围绕父目标分布
      gEdges = [];
      const goalMap = {};
      for (const g of gNodes) { goalMap[g.id] = g; }
      for (const goal of gNodes) {
        const myTasks = activeTasks.filter(t => t.goal_id === goal.id);
        for (let i = 0; i < myTasks.length; i++) {
          const t = myTasks[i];
          const angle = (2 * Math.PI * i) / Math.max(myTasks.length, 1);
          const dist = goal.radius + 60 + Math.random() * 50;
          const taskNode = {
            id: t.id, label: t.title, type: 'task',
            parentId: goal.id,
            color: goal.color,
            radius: 9 + Math.random() * 6,
            x: goal.x + Math.cos(angle) * dist,
            y: goal.y + Math.sin(angle) * dist,
            vx: 0, vy: 0,
            status: t.status, done: t.status === 'done',
            tags: t.tags ? t.tags.map(tg => tg.name || tg.id) : [],
            people: t.people ? t.people.map(p => typeof p === 'string' ? p : p.name) : []
          };
          gNodes.push(taskNode);
          gEdges.push({ source: taskNode, target: goal, weight: 1, type: 'parent-child' });
        }
      }
      // 无目标的任务
      const orphans = activeTasks.filter(t => !t.goal_id || !goalMap[t.goal_id]);
      for (let i = 0; i < orphans.length; i++) {
        const t = orphans[i];
        const taskNode = {
          id: t.id, label: t.title, type: 'task',
          parentId: null,
          color: '#94a3b8',
          radius: 5.5 + Math.random() * 4,
          x: cx + (Math.random() - 0.5) * 300,
          y: cy + 200 + (Math.random() - 0.5) * 60,
          vx: 0, vy: 0,
          status: t.status, done: t.status === 'done',
          tags: t.tags ? t.tags.map(tg => tg.name || tg.id) : [],
          people: t.people ? t.people.map(p => typeof p === 'string' ? p : p.name) : []
        };
        gNodes.push(taskNode);
      }
      // 目标-目标边：tag共享 + 人员共享
      for (let i = 0; i < activeGoals.length; i++) {
        for (let j = i + 1; j < activeGoals.length; j++) {
          const a = gNodes[i], b = gNodes[j];
          if (a.type !== 'goal' || b.type !== 'goal') continue;
          const sharedTags = a.tags.filter(t => b.tags.includes(t));
          const sharedPeople = a.people.filter(p => b.people.includes(p));
          const weight = sharedTags.length + sharedPeople.length;
          if (weight) {
            gEdges.push({
              source: a, target: b, weight,
              tags: sharedTags, people: sharedPeople,
              type: sharedTags.length && sharedPeople.length ? 'both'
                : sharedTags.length ? 'tag' : 'people'
            });
          }
        }
      }
      // 粒子背景
      gParticles = [];
      const pw = graphCanvas.value ? graphCanvas.value.width / gDPR : window.innerWidth;
      const ph = graphCanvas.value ? graphCanvas.value.height / gDPR : window.innerHeight;
      for (let i = 0; i < 60; i++) {
        gParticles.push({
          x: Math.random() * pw,
          y: Math.random() * ph,
          r: Math.random() * 1.5 + 0.5,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          alpha: Math.random() * 0.4 + 0.1
        });
      }
    }

    function gIsDark() { return document.body.classList.contains('dark'); }

    function graphSimulate() {
      const goals = gNodes.filter(n => n.type === 'goal');
      const tasks = gNodes.filter(n => n.type === 'task');
      const goalMap = {};
      for (const g of goals) { goalMap[g.id] = g; }
      const cx = (window.innerWidth - 300) / 2, cy = window.innerHeight / 2 - 80;
      // 目标→中心引力
      for (const n of goals) {
        n.vx += (cx - n.x) * 0.002;
        n.vy += (cy - n.y) * 0.002;
      }
      // 目标↔目标 互斥
      for (const n of goals) {
        for (const m of goals) {
          if (n === m) continue;
          let dx = n.x - m.x, dy = n.y - m.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = 4000 / (dist * dist);
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
        }
      }
      // 目标-目标 弹簧边
      for (const e of gEdges) {
        if (e.type === 'parent-child') continue;
        const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = dist * 0.006 * e.weight;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        e.source.vx += fx; e.source.vy += fy;
        e.target.vx -= fx; e.target.vy -= fy;
      }
      // 目标阻尼
      for (const n of goals) {
        if (gDragging !== n) { n.vx *= 0.82; n.vy *= 0.82; }
        n.x += n.vx; n.y += n.vy;
      }
      // 任务→父目标 强吸引
      for (const n of tasks) {
        const parent = goalMap[n.parentId];
        if (parent) {
          const dx = parent.x - n.x, dy = parent.y - n.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const targetDist = parent.radius + 70 + n.radius;
          const force = (dist - targetDist) * 0.02;
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
        }
      }
      // 任务↔任务 互斥（同父目标）
      for (const n of tasks) {
        for (const m of tasks) {
          if (n === m || n.parentId !== m.parentId) continue;
          let dx = n.x - m.x, dy = n.y - m.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = 150 / (dist * dist);
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
        }
      }
      // 任务↔目标 互斥（防止任务钻进目标里）
      for (const t of tasks) {
        for (const g of goals) {
          if (t.parentId === g.id) continue;
          let dx = t.x - g.x, dy = t.y - g.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const minDist = g.radius + t.radius + 10;
          if (dist < minDist) {
            const force = (minDist - dist) * 0.1;
            t.vx += (dx / dist) * force;
            t.vy += (dy / dist) * force;
          }
        }
      }
      // 任务阻尼
      for (const n of tasks) {
        if (gDragging !== n) { n.vx *= 0.78; n.vy *= 0.78; }
        n.x += n.vx; n.y += n.vy;
      }
    }

    function graphRender() {
      if (!gCtx) return;
      const canvas = gCtx.canvas;
      const w = canvas.width / gDPR, h = canvas.height / gDPR;
      const dark = gIsDark();
      const bg = dark ? '#14141e' : '#f8f9fb';
      gCtx.setTransform(gDPR, 0, 0, gDPR, 0, 0);
      gCtx.clearRect(0, 0, w, h);
      // 背景
      gCtx.fillStyle = bg;
      gCtx.fillRect(0, 0, w, h);
      // 粒子
      gTime += 0.005;
      for (const p of gParticles) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        gCtx.beginPath();
        gCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        gCtx.fillStyle = dark ? `rgba(255,255,255,${p.alpha * 0.5})` : `rgba(124,58,237,${p.alpha * 0.3})`;
        gCtx.fill();
      }

      gCtx.save();
      gCtx.translate(gOffX, gOffY);
      gCtx.scale(gScale, gScale);

      const goalNodes = gNodes.filter(n => n.type === 'goal');
      const taskNodes = gNodes.filter(n => n.type === 'task');

      // ---- 目标-目标边 (Bezier曲线) ----
      for (const e of gEdges) {
        if (e.type === 'parent-child') continue;
        const sx = e.source.x, sy = e.source.y, tx = e.target.x, ty = e.target.y;
        const mx = (sx + tx) / 2, my = (sy + ty) / 2;
        const dx = tx - sx, dy = ty - sy;
        const len = Math.sqrt(dx * dx + dy * dy || 1);
        const perp = len * 0.12;
        const cpx = mx - (dy / len) * perp * (e.weight % 2 ? 1 : -1);
        const cpy = my + (dx / len) * perp * (e.weight % 2 ? 1 : -1);
        gCtx.beginPath();
        gCtx.moveTo(sx, sy);
        gCtx.quadraticCurveTo(cpx, cpy, tx, ty);
        const alpha = 0.10 + e.weight * 0.06;
        gCtx.strokeStyle = dark ? `rgba(255,255,255,${alpha})` : `rgba(124,58,237,${alpha})`;
        gCtx.lineWidth = 0.7 + e.weight * 0.6;
        gCtx.stroke();
        // 边标签
        const midX = (sx + cpx + tx) / 3, midY = (sy + cpy + ty) / 3;
        gCtx.fillStyle = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.3)';
        gCtx.font = '10px -apple-system, "PingFang SC", sans-serif';
        gCtx.textAlign = 'center';
        gCtx.fillText(e.weight + '个关联', midX, midY - 2);
      }

      // ---- 任务-父目标边 ----
      for (const e of gEdges) {
        if (e.type !== 'parent-child') continue;
        const sx = e.source.x, sy = e.source.y, tx = e.target.x, ty = e.target.y;
        gCtx.beginPath();
        gCtx.setLineDash([3, 5]);
        gCtx.moveTo(sx, sy);
        gCtx.lineTo(tx, ty);
        const edgeAlpha = (gHovered && (gHovered === e.source || gHovered === e.target)) ? 0.35 : 0.12;
        gCtx.strokeStyle = e.source.color + (edgeAlpha > 0.3 ? '88' : '44');
        gCtx.lineWidth = (gHovered && (gHovered === e.source || gHovered === e.target)) ? 1.2 : 0.5;
        gCtx.stroke();
        gCtx.setLineDash([]);
      }

      // hover 高亮目标-目标边
      if (gHovered && gHovered.type === 'goal') {
        for (const e of gEdges) {
          if (e.type === 'parent-child') continue;
          if (e.source === gHovered || e.target === gHovered) {
            const sx = e.source.x, sy = e.source.y, tx = e.target.x, ty = e.target.y;
            const mx = (sx + tx) / 2, my = (sy + ty) / 2;
            const dx = tx - sx, dy = ty - sy;
            const len = Math.sqrt(dx * dx + dy * dy || 1);
            const perp = len * 0.12;
            const cpx = mx - (dy / len) * perp * (e.weight % 2 ? 1 : -1);
            const cpy = my + (dx / len) * perp * (e.weight % 2 ? 1 : -1);
            gCtx.beginPath();
            gCtx.moveTo(sx, sy);
            gCtx.quadraticCurveTo(cpx, cpy, tx, ty);
            gCtx.strokeStyle = gHovered.color + 'aa';
            gCtx.lineWidth = 2.5 + e.weight;
            gCtx.shadowColor = gHovered.color + '66';
            gCtx.shadowBlur = 8;
            gCtx.stroke();
            gCtx.shadowBlur = 0;
          }
        }
      }

      // ---- 目标节点 ----
      for (const n of goalNodes) {
        const r = gHovered === n ? n.radius + 5 : n.radius;
        // 光晕
        const outerGlow = gCtx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, r * 2.2);
        outerGlow.addColorStop(0, n.color + '30');
        outerGlow.addColorStop(1, 'transparent');
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r * 2.2, 0, Math.PI * 2);
        gCtx.fillStyle = outerGlow;
        gCtx.fill();
        // 完成环
        if (n.total > 0 && n.done > 0) {
          const ratio = n.done / n.total;
          gCtx.beginPath();
          gCtx.arc(n.x, n.y, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
          gCtx.strokeStyle = '#22c55e';
          gCtx.lineWidth = 2.5;
          gCtx.stroke();
          gCtx.beginPath();
          gCtx.arc(n.x, n.y, r + 3, -Math.PI / 2 + Math.PI * 2 * ratio, -Math.PI / 2 + Math.PI * 2);
          gCtx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
          gCtx.lineWidth = 2.5;
          gCtx.stroke();
        }
        // 阴影
        gCtx.shadowColor = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.2)';
        gCtx.shadowBlur = 16;
        // 主体渐变
        const grad = gCtx.createRadialGradient(n.x - r * 0.25, n.y - r * 0.3, r * 0.05, n.x, n.y, r);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.35, gHovered === n ? lightenColor(n.color, 0.2) : n.color);
        grad.addColorStop(1, n.color + 'bb');
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r, 0, Math.PI * 2);
        gCtx.fillStyle = grad;
        gCtx.fill();
        gCtx.shadowBlur = 0;
        // 内环高光
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r - 3, 0, Math.PI * 2);
        gCtx.strokeStyle = 'rgba(255,255,255,0.15)';
        gCtx.lineWidth = 1;
        gCtx.stroke();
      }

      // ---- 目标标签 ----
      for (const n of goalNodes) {
        const r = gHovered === n ? n.radius + 5 : n.radius;
        const labelH = 20, labelY = n.y - r - 16;
        gCtx.font = '600 12px -apple-system, "PingFang SC", sans-serif';
        const labelW = gCtx.measureText(n.label).width + 16;
        gCtx.fillStyle = dark ? 'rgba(20,20,30,0.85)' : 'rgba(255,255,255,0.9)';
        gCtx.beginPath();
        if (gCtx.roundRect) {
          gCtx.roundRect(n.x - labelW / 2, labelY - labelH / 2, labelW, labelH, 6);
        } else {
          gCtx.rect(n.x - labelW / 2, labelY - labelH / 2, labelW, labelH);
        }
        gCtx.fill();
        gCtx.fillStyle = dark ? '#e2e8f0' : '#1e1e2e';
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText(n.label, n.x, labelY);
        // 任务数在中心
        gCtx.fillStyle = '#fff';
        gCtx.font = `bold ${Math.max(10, r * 0.45)}px -apple-system, "PingFang SC", sans-serif`;
        gCtx.fillText(n.total, n.x, n.y + 1);
      }

      // ---- 任务节点（普通，非焦点）----
      const focusedTask = gFocused && gFocused.type === 'task' ? gFocused : null;
      for (const n of taskNodes) {
        if (n === focusedTask) continue; // 焦点任务最后画
        const isFocused = n === gFocused;
        const isHovered = gHovered === n;
        const parentHovered = gHovered && gHovered.type === 'goal' && n.parentId === gHovered.id;
        const r = isHovered ? n.radius + 3 : parentHovered ? n.radius + 1.5 : n.radius;
        const alpha = isHovered ? 1 : parentHovered ? 0.85 : 0.6;
        // 光晕
        if (isHovered || parentHovered) {
          gCtx.beginPath();
          gCtx.arc(n.x, n.y, r * 2.5, 0, Math.PI * 2);
          gCtx.fillStyle = n.color + '20';
          gCtx.fill();
        }
        // 主体 — 浅底+原色描边，与目标的实心渐变形成质感对比
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r, 0, Math.PI * 2);
        gCtx.fillStyle = n.done ? '#94a3b8' : muteColor(n.color);
        gCtx.globalAlpha = alpha;
        gCtx.fill();
        gCtx.globalAlpha = 1;
        // 描边（原色）
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r, 0, Math.PI * 2);
        gCtx.strokeStyle = (n.done ? '#94a3b8' : n.color) + (isHovered || parentHovered ? 'aa' : '44');
        gCtx.lineWidth = isHovered ? 1.8 : 1;
        gCtx.stroke();
        // 完成标记
        if (n.done) {
          gCtx.strokeStyle = '#22c55e';
          gCtx.lineWidth = 1.2;
          gCtx.beginPath();
          gCtx.arc(n.x, n.y, r + 1.5, 0, Math.PI * 2);
          gCtx.stroke();
        }
        // 常驻任务名
        const showLabel = isHovered || parentHovered;
        const labelMax = showLabel ? 25 : 12;
        const label = n.label.length > labelMax ? n.label.slice(0, labelMax) + '..' : n.label;
        const lh = showLabel ? 18 : 15, ly = n.y + r + (showLabel ? 8 : 5);
        const labelAlpha = showLabel ? 0.9 : 0.55;
        gCtx.font = `${showLabel ? 10 : 8.5}px -apple-system, "PingFang SC", sans-serif`;
        const lw = gCtx.measureText(label).width + 10;
        gCtx.fillStyle = dark ? `rgba(20,20,30,${0.7 * labelAlpha})` : `rgba(255,255,255,${0.8 * labelAlpha})`;
        gCtx.beginPath();
        if (gCtx.roundRect) {
          gCtx.roundRect(n.x - lw / 2, ly - lh / 2, lw, lh, 3);
        } else {
          gCtx.rect(n.x - lw / 2, ly - lh / 2, lw, lh);
        }
        gCtx.fill();
        gCtx.fillStyle = dark ? `rgba(226,232,240,${0.55 * labelAlpha})` : `rgba(30,30,46,${0.5 * labelAlpha})`;
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText(label, n.x, ly);
      }
      // ---- 焦点任务节点（放大，最前）----
      if (focusedTask) {
        const n = focusedTask;
        const r = n.radius + 10;
        // 强光晕
        const glow = gCtx.createRadialGradient(n.x, n.y, r * 0.3, n.x, n.y, r * 2.5);
        glow.addColorStop(0, n.color + '50');
        glow.addColorStop(1, 'transparent');
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r * 2.5, 0, Math.PI * 2);
        gCtx.fillStyle = glow;
        gCtx.fill();
        // 主体（更大，更亮）
        gCtx.shadowColor = n.color + '55';
        gCtx.shadowBlur = 18;
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r, 0, Math.PI * 2);
        gCtx.fillStyle = n.done ? '#94a3b8' : n.color;
        gCtx.fill();
        gCtx.shadowBlur = 0;
        // 高光
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r - 3, 0, Math.PI * 2);
        gCtx.strokeStyle = 'rgba(255,255,255,0.25)';
        gCtx.lineWidth = 1.5;
        gCtx.stroke();
        // 全名标签（不截断）
        const label = n.label;
        const lh = 20, ly = n.y + r + 10;
        gCtx.font = '600 12px -apple-system, "PingFang SC", sans-serif';
        const lw = gCtx.measureText(label).width + 16;
        gCtx.fillStyle = dark ? 'rgba(20,20,30,0.92)' : 'rgba(255,255,255,0.95)';
        gCtx.beginPath();
        if (gCtx.roundRect) {
          gCtx.roundRect(n.x - lw / 2, ly - lh / 2, lw, lh, 5);
        } else {
          gCtx.rect(n.x - lw / 2, ly - lh / 2, lw, lh);
        }
        gCtx.fill();
        gCtx.fillStyle = dark ? '#f1f5f9' : '#1e1e2e';
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText(label, n.x, ly);
      }
      gCtx.textBaseline = 'alphabetic';

      // ---- 焦点节点高亮 ----
      if (gFocused && !gDragging) {
        const n = gFocused;
        const r = n.type === 'goal' ? n.radius + 8 : n.radius + 6;
        // 呼吸环
        const breathe = 1 + Math.sin(gTime * 3) * 0.15;
        gCtx.beginPath();
        gCtx.arc(n.x, n.y, r * breathe, 0, Math.PI * 2);
        gCtx.strokeStyle = n.type === 'goal' ? n.color : muteColor(n.color);
        gCtx.lineWidth = 2.5;
        gCtx.shadowColor = n.type === 'goal' ? n.color + '66' : muteColor(n.color) + '66';
        gCtx.shadowBlur = 12;
        gCtx.stroke();
        gCtx.shadowBlur = 0;
        // 高亮关联边
        const relatedEdges = gEdges.filter(e => e.source === n || e.target === n);
        for (const e of relatedEdges) {
          gCtx.beginPath();
          gCtx.moveTo(e.source.x, e.source.y);
          if (e.type !== 'parent-child') {
            const mx = (e.source.x + e.target.x) / 2, my = (e.source.y + e.target.y) / 2;
            const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
            const len = Math.sqrt(dx * dx + dy * dy || 1);
            const perp = len * 0.12;
            const cpx = mx - (dy / len) * perp * (e.weight % 2 ? 1 : -1);
            const cpy = my + (dx / len) * perp * (e.weight % 2 ? 1 : -1);
            gCtx.quadraticCurveTo(cpx, cpy, e.target.x, e.target.y);
          } else {
            gCtx.lineTo(e.target.x, e.target.y);
          }
          gCtx.strokeStyle = n.type === 'goal' ? n.color + '88' : muteColor(n.color) + '88';
          gCtx.lineWidth = e.type === 'parent-child' ? 1.5 : 2.2;
          gCtx.stroke();
        }
        // 关联节点微亮
        const relatedIds = new Set();
        for (const e of relatedEdges) {
          if (e.source !== n) relatedIds.add(e.source);
          if (e.target !== n) relatedIds.add(e.target);
        }
        for (const rn of relatedIds) {
          gCtx.beginPath();
          gCtx.arc(rn.x, rn.y, rn.radius + 5, 0, Math.PI * 2);
          gCtx.fillStyle = (rn.type === 'goal' ? (rn.color || '#94a3b8') : muteColor(rn.color || '#94a3b8')) + '18';
          gCtx.fill();
        }
        // 关联节点简略标签（1-2层）
        const hop1 = new Set(), hop2 = new Set();
        for (const e of gEdges) {
          if (e.source === n && e.target !== n) hop1.add(e.target);
          if (e.target === n && e.source !== n) hop1.add(e.source);
        }
        for (const h1 of hop1) {
          for (const e of gEdges) {
            if (e.source === h1 && e.target !== n && !hop1.has(e.target)) hop2.add(e.target);
            if (e.target === h1 && e.source !== n && !hop1.has(e.source)) hop2.add(e.source);
          }
        }
        const dark2 = gIsDark();
        for (const [set, maxLen, fontSize, yOff] of [[hop2, 5, 9, 18], [hop1, 8, 10, 16]]) {
          for (const node of set) {
            const txt = node.label.length > maxLen ? node.label.slice(0, maxLen) + '..' : node.label;
            const ly = node.y + node.radius + yOff;
            gCtx.font = `${fontSize}px -apple-system, "PingFang SC", sans-serif`;
            const lw = gCtx.measureText(txt).width + 10;
            gCtx.fillStyle = dark2 ? 'rgba(20,20,30,0.7)' : 'rgba(255,255,255,0.75)';
            gCtx.beginPath();
            if (gCtx.roundRect) {
              gCtx.roundRect(node.x - lw / 2, ly - 8, lw, 14, 3);
            } else {
              gCtx.rect(node.x - lw / 2, ly - 8, lw, 14);
            }
            gCtx.fill();
            gCtx.fillStyle = dark2 ? 'rgba(226,232,240,0.7)' : 'rgba(30,30,46,0.65)';
            gCtx.textAlign = 'center';
            gCtx.textBaseline = 'middle';
            gCtx.fillText(txt, node.x, ly - 1);
          }
        }
      }

      gCtx.restore();
    }

    function lightenColor(hex, amount) {
      const num = parseInt(hex.replace('#', ''), 16);
      const r = Math.min(255, (num >> 16) + 40);
      const g = Math.min(255, ((num >> 8) & 0x00FF) + 40);
      const b = Math.min(255, (num & 0x0000FF) + 40);
      return `rgb(${r},${g},${b})`;
    }
    // 与父目标同色系但更柔和（混白/黑降低饱和度，用于任务节点）
    function muteColor(hex) {
      const num = parseInt(hex.replace('#', ''), 16);
      const r = (num >> 16), g = ((num >> 8) & 0xFF), b = (num & 0xFF);
      const mix = gIsDark() ? [30, 34, 45] : [255, 255, 255];
      // 30% 目标色 + 70% 背景色 → 明显比目标浅
      const mr = Math.round(r * 0.3 + mix[0] * 0.7);
      const mg = Math.round(g * 0.3 + mix[1] * 0.7);
      const mb = Math.round(b * 0.3 + mix[2] * 0.7);
      return `rgb(${mr},${mg},${mb})`;
    }

    function graphLoop() {
      // 焦点节点居中动画
      if (gFocused && gCtx) {
        const cw = gCtx.canvas.width / gDPR, ch = gCtx.canvas.height / gDPR;
        const targetOX = cw / 2 - gFocused.x * gScale;
        const targetOY = ch / 2 - gFocused.y * gScale;
        gOffX += (targetOX - gOffX) * 0.08;
        gOffY += (targetOY - gOffY) * 0.08;
      }
      graphSimulate();
      graphRender();
      gAnimId = requestAnimationFrame(graphLoop);
    }

    function initGraph() {
      if (!graphCanvas.value || !graphCanvasWrap.value) return;
      const wrap = graphCanvasWrap.value;
      const canvas = graphCanvas.value;
      const rawDPR = window.devicePixelRatio || 1;
      gDPR = Math.ceil(rawDPR) * 2; // 2x 超采样，曲线/文字更平滑
      const cw = wrap.clientWidth, ch = wrap.clientHeight;
      canvas.width = cw * gDPR;
      canvas.height = ch * gDPR;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
      gCtx = canvas.getContext('2d');
      gScale = 1; gOffX = 0; gOffY = 0; gFocused = null;
      buildGraph();
      autoFitGraph();
      graphZoom.value = gScale;
      if (gAnimId) cancelAnimationFrame(gAnimId);
      gAnimId = requestAnimationFrame(graphLoop);
      // 自动监听容器大小变化
      if (window._graphResizeObserver) window._graphResizeObserver.disconnect();
      window._graphResizeObserver = new ResizeObserver(() => {
        resizeGraph();
        buildGraph();
        autoFitGraph();
        graphZoom.value = gScale;
      });
      window._graphResizeObserver.observe(wrap);
    }

    function autoFitGraph() {
      if (!gNodes.length || !gCtx) return;
      // 计算所有节点的包围盒
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of gNodes) {
        if (n.x - n.radius < minX) minX = n.x - n.radius;
        if (n.y - n.radius < minY) minY = n.y - n.radius;
        if (n.x + n.radius > maxX) maxX = n.x + n.radius;
        if (n.y + n.radius > maxY) maxY = n.y + n.radius;
      }
      const bw = maxX - minX, bh = maxY - minY;
      if (bw <= 0 || bh <= 0) return;
      const cw = gCtx.canvas.width / gDPR, ch = gCtx.canvas.height / gDPR;
      // 留 15% 边距，计算合适的缩放比例
      const scaleX = (cw * 0.85) / bw;
      const scaleY = (ch * 0.85) / bh;
      gScale = Math.min(scaleX, scaleY, 2.5); // 最多放大到 2.5x
      // 居中偏移
      const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
      gOffX = cw / 2 - midX * gScale;
      gOffY = ch / 2 - midY * gScale;
    }

    function graphMouseDown(e) {
      gDragMoved = false;
      gDragging = null;
      if (!gNodes.length) return;
      const rect = graphCanvas.value.getBoundingClientRect();
      const mx = (e.clientX - rect.left - gOffX) / gScale;
      const my = (e.clientY - rect.top - gOffY) / gScale;
      let best = null, bestDist = Infinity;
      for (const n of gNodes) {
        const d = Math.hypot(mx - n.x, my - n.y);
        if (d < n.radius + 8 && d < bestDist) { best = n; bestDist = d; }
      }
      if (best) { gDragging = best; gDragOX = best.x - mx; gDragOY = best.y - my; }
    }
    function graphMouseMove(e) {
      if (!gNodes.length) return;
      const rect = graphCanvas.value.getBoundingClientRect();
      const mx = (e.clientX - rect.left - gOffX) / gScale;
      const my = (e.clientY - rect.top - gOffY) / gScale;
      if (gDragging) {
        const dx = (mx + gDragOX) - gDragging.x;
        const dy = (my + gDragOY) - gDragging.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) gDragMoved = true;
        gDragging.x = mx + gDragOX; gDragging.y = my + gDragOY;
        gDragging.vx = 0; gDragging.vy = 0;
        return;
      }
      let found = null;
      // 优先找最小的hover目标（先task后goal，避免大目标吞噬小任务）
      let bestDist = Infinity;
      for (const n of gNodes) {
        const d = Math.hypot(mx - n.x, my - n.y);
        const hitR = n.radius + 6;
        if (d < hitR && d < bestDist) { found = n; bestDist = d; }
      }
      gHovered = found;
      if (found) {
        const rows = [];
        if (found.type === 'task') {
          // 任务节点tooltip
          const parentGoal = gNodes.find(n => n.id === found.parentId);
          if (parentGoal) rows.push(`🎯 ${parentGoal.label}`);
          const statusMap = { 'todo': '⏳ 待办', 'in-progress': '🔄 进行中', 'done': '✅ 完成' };
          rows.push(statusMap[found.status] || found.status);
          if (found.tags && found.tags.length) rows.push(`🏷️ ${found.tags.join(', ')}`);
          if (found.people && found.people.length) rows.push(`👤 ${found.people.join(', ')}`);
        } else {
          // 目标节点tooltip
          const connected = [];
          const tagNames = new Set(), peopleNames = new Set();
          for (const e of gEdges) {
            if (e.type === 'parent-child') continue;
            const other = e.source === found ? e.target : e.target === found ? e.source : null;
            if (other) {
              if (e.tags) e.tags.forEach(t => tagNames.add(t));
              if (e.people) e.people.forEach(p => peopleNames.add(p));
              connected.push(other.label);
            }
          }
          if (connected.length) rows.push(`🔗 ${connected.join('、')}`);
          if (tagNames.size) rows.push(`🏷️ 共享标签: ${[...tagNames].join(', ')}`);
          if (peopleNames.size) rows.push(`👤 共享人员: ${[...peopleNames].join(', ')}`);
          rows.push(`📊 任务: ${found.total}个 (完成${found.done})`);
        }
        graphTooltip.value = { x: e.clientX + 14, y: e.clientY - 10, title: found.label, rows };
        graphCanvas.value.style.cursor = 'pointer';
      } else {
        graphTooltip.value = null;
        graphCanvas.value.style.cursor = 'grab';
      }
    }
    function graphMouseUp() {
      const clicked = gDragging;
      gDragging = null;
      if (clicked && !gDragMoved) {
        // 点击了节点（无拖拽）
        if (gClickNode === clicked) {
          // 同一节点短时间内第二次 mouseup → 双击，交给 dblclick 处理
          gClickNode = null;
          if (gClickTimer) { clearTimeout(gClickTimer); gClickTimer = null; }
        } else {
          gClickNode = clicked;
          if (gClickTimer) clearTimeout(gClickTimer);
          gClickTimer = setTimeout(() => {
            gClickTimer = null;
            if (gClickNode) {
              gFocused = gFocused === gClickNode ? null : gClickNode;
              gClickNode = null;
            }
          }, 300);
        }
      } else if (!clicked) {
        // 点击空白 → 取消聚焦
        gFocused = null;
        gClickNode = null;
        if (gClickTimer) { clearTimeout(gClickTimer); gClickTimer = null; }
      }
    }
    function zoomAtCenter(newScale) {
      if (!gCtx) return;
      const cw = gCtx.canvas.width / gDPR;
      const ch = gCtx.canvas.height / gDPR;
      gOffX = cw / 2 - (cw / 2 - gOffX) * (newScale / gScale);
      gOffY = ch / 2 - (ch / 2 - gOffY) * (newScale / gScale);
      gScale = newScale;
    }
    function graphWheel(e) {
      e.preventDefault();
      const newScale = Math.max(0.2, Math.min(3, gScale * (e.deltaY > 0 ? 0.92 : 1.08)));
      zoomAtCenter(newScale);
      graphZoom.value = gScale;
    }
    function graphZoomTo(v) {
      const newScale = parseFloat(v) / 100;
      zoomAtCenter(newScale);
      graphZoom.value = gScale;
    }
    function graphZoomIn() {
      const newScale = Math.min(3, gScale * 1.15);
      zoomAtCenter(newScale);
      graphZoom.value = gScale;
    }
    function graphZoomOut() {
      const newScale = Math.max(0.2, gScale * 0.87);
      zoomAtCenter(newScale);
      graphZoom.value = gScale;
    }
    function graphClick(e) {
      // 由 graphMouseUp 处理单双击逻辑，这里仅作兜底
    }
    function graphDblClick(e) {
      if (gClickTimer) { clearTimeout(gClickTimer); gClickTimer = null; }
      gClickNode = null;
      if (!gHovered) return;
      // 双击 → 跳转
      if (gHovered.type === 'task') {
        selectTask(gHovered.id);
        currentView.value = 'kanban';
      } else {
        filterGoalId.value = gHovered.id;
        currentView.value = 'kanban';
        loadTasks();
      }
    }
    function resizeGraph() {
      if (!graphCanvas.value || !graphCanvasWrap.value) return;
      const wrap = graphCanvasWrap.value;
      const canvas = graphCanvas.value;
      const rawDPR = window.devicePixelRatio || 1;
      gDPR = Math.ceil(rawDPR) * 2;
      const cw = wrap.clientWidth, ch = wrap.clientHeight;
      canvas.width = cw * gDPR;
      canvas.height = ch * gDPR;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
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

    const DAY_NAMES = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '日': 7, '天': 7 };

    // 快速输入栏：把整段文本作为描述，打开统一弹窗（用户在弹窗里点 AI 推理提炼属性）
    function createFromQuickInput() {
      const desc = quickInputText.value.trim();
      if (!desc) return;

      Object.assign(newTask, {
        title: '',
        description: desc,
        goal_id: filterGoalId.value || null,
        routine_id: null,
        tag_ids: [...filterTagIds.value],
        due_date: '',
        estimated_time: 0,
        people_str: '',
        create_folder: true,
        is_report: false,
        report_meeting: '',
        is_today: false,
        folder_name: '',
        reuse_folder_path: '',
        subtasks: [],
      });

      quickInputText.value = '';
      showQuickAdd.value = true;
      // 自动触发 AI 推理：用户从输入栏敲完「创建」就开跑，不用再点按钮
      nextTick(() => {
        aiInferQuickAdd();
      });
    }

    async function fetchAISuggestions(taskId, title) {
      aiEnriching.value = true;
      aiSuggestions.value = null;
      startAIProgress('正在推理任务属性…');
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
      stopAIProgress();
      aiEnriching.value = false;
    }

    // AI 推理阶段文案（让 inline 进度条不只是一根光秃秃的条）
    function aiInferInlineStatus(percent) {
      if (percent < 25) return '正在理解描述…';
      if (percent < 55) return '提炼标题与属性…';
      if (percent < 85) return '匹配目标与标签…';
      if (percent < 100) return '生成子任务与目录…';
      return '完成 ✓';
    }

    // AI 推理：从描述自动填充新建任务属性
    async function aiInferQuickAdd() {
      const desc = newTask.description || newTask.title;
      if (!desc) return;
      aiInferringQuickAdd.value = true;
      startAIProgress('正在分析描述，推理任务属性…');
      try {
        const result = await api('/api/ai/enrich', {
          method: 'POST',
          body: { description: desc }
        });
        if (result && Object.keys(result).length > 0) {
          if (result.title && !newTask.title) newTask.title = result.title;
          if (result.estimated_time && !newTask.estimated_time) newTask.estimated_time = result.estimated_time;
          if (result.due_date && !newTask.due_date) newTask.due_date = result.due_date;
          if (result.goal_id && !newTask.goal_id) newTask.goal_id = result.goal_id;
          if (result.tag_ids && result.tag_ids.length) {
            if (!newTask.tag_ids) newTask.tag_ids = [];
            for (const tid of result.tag_ids) {
              if (!newTask.tag_ids.includes(tid)) newTask.tag_ids.push(tid);
            }
          }
          if (result.subtasks && result.subtasks.length) {
            newTask.subtasks = result.subtasks;
          }
          if (result.folder_name && !newTask.folder_name) {
            newTask.folder_name = result.folder_name;
            newTask.create_folder = true;
          }
        }
      } catch (e) { /* silent - AI inference is optional */ }
      stopAIProgress();
      aiInferringQuickAdd.value = false;
    }

    async function aiPickFolder() {
      try {
        const result = await api('/api/pick-folder', { method: 'POST' });
        if (result && result.path && aiSuggestions.value) {
          aiSuggestions.value.reuse_folder_path = result.path;
        }
      } catch (e) { /* cancelled */ }
    }

    async function quickAddPickFolder() {
      try {
        const result = await api('/api/pick-folder', { method: 'POST' });
        if (result && result.path) {
          newTask.reuse_folder_path = result.path;
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
    watch([filterGoalId, filterReportOnly], () => {
      if (currentView.value === 'kanban' || currentView.value === 'dashboard') {
        loadTasks();
      }
    });
    // ==================== 任务操作 ====================
    function openQuickAdd() {
      Object.assign(newTask, {
        title: '', description: '', goal_id: filterGoalId.value || null,
        routine_id: null, tag_ids: [...filterTagIds.value], due_date: '', estimated_time: 0,
        people_str: '', create_folder: true, is_report: false, report_meeting: '',
        is_today: false, folder_name: '', reuse_folder_path: '', subtasks: [],
      });
      showQuickAdd.value = true;
      nextTick(() => {
        const el = document.querySelector('.quick-add-modal .input-lg');
        if (el) el.focus();
      });
    }

    // 新建汇报任务：先重置，再标记 is_report
    function openQuickAddReport() {
      openQuickAdd();
      newTask.is_report = true;
    }

    async function quickCreateTask() {
      if (!newTask.title.trim()) return;

      const people = newTask.people_str
        ? newTask.people_str.split(/[,，]/).map(s => s.trim()).filter(Boolean)
        : [];

      // 如果选了已有目录，则不创建新文件夹
      const reusePath = newTask.reuse_folder_path || '';
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
          create_folder: reusePath ? false : newTask.create_folder,
          folder_name: newTask.folder_name || null,
          is_report: newTask.is_report ? 1 : 0,
          report_meeting: newTask.report_meeting,
          is_today: newTask.is_today ? 1 : 0,
        }
      });

      // 关联已有目录
      if (reusePath) {
        await api(`/api/tasks/${id.id}`, {
          method: 'PUT', body: { folder_path: reusePath }
        });
      }

      // 创建子任务
      if (newTask.subtasks && newTask.subtasks.length) {
        for (const st of newTask.subtasks) {
          if (st.trim()) {
            await api(`/api/tasks/${id.id}/subtasks`, {
              method: 'POST', body: { title: st.trim() }
            });
          }
        }
      }

      showQuickAdd.value = false;
      // 重置表单
      Object.assign(newTask, {
        title: '', description: '', goal_id: null, routine_id: null,
        tag_ids: [], due_date: new Date(Date.now() + 7*86400000).toISOString().slice(0, 10),
        estimated_time: 0,
        people_str: '', create_folder: true,
        is_report: false, report_meeting: '', is_today: false,
        folder_name: '', reuse_folder_path: '', subtasks: [],
      });
      await loadTasks();
      selectTask(id.id);
    }

    function toggleNewTaskTag(tagId) {
      const idx = newTask.tag_ids.indexOf(tagId);
      if (idx >= 0) newTask.tag_ids.splice(idx, 1);
      else newTask.tag_ids.push(tagId);
    }

    // ========== 子任务列表：拖拽排序 ==========
    let subtaskDragIdx = null;
    function onSubtaskDragStart(idx) { subtaskDragIdx = idx; }
    function onSubtaskDragOver(idx) {
      if (subtaskDragIdx === null || subtaskDragIdx === idx) return;
      // 实时交换让拖拽视觉跟手
      const arr = newTask.subtasks;
      const [moved] = arr.splice(subtaskDragIdx, 1);
      arr.splice(idx, 0, moved);
      subtaskDragIdx = idx;
    }
    function onSubtaskDrop() { subtaskDragIdx = null; }
    function onSubtaskDragEnd() { subtaskDragIdx = null; }
    function addSubtaskAt(idx) {
      // 回车新增：在当前行下面插入一个空行并聚焦
      newTask.subtasks.splice(idx + 1, 0, '');
      nextTick(() => {
        const inputs = document.querySelectorAll('.subtask-input');
        if (inputs[idx + 1]) inputs[idx + 1].focus();
      });
    }

    // 系统标签：「汇报」「今日必做」dimension='system'
    // 这两个标签与其他标签完全一样（存在 task_tags），只是会触发 is_report/is_today 字段同步
    // 这个 computed 用于在弹窗里判断是否选了「汇报」标签，决定要不要显示「汇报会议」输入框
    const isReportTagSelected = computed(() => {
      const t = tags.value.find(x => x.dimension === 'system' && x.name === '汇报');
      return !!(t && newTask.tag_ids.includes(t.id));
    });
    // 详情页：当前任务是否选了「汇报」标签
    const isReportTask = computed(() => {
      const t = tags.value.find(x => x.dimension === 'system' && x.name === '汇报');
      return !!(t && selectedTask.value?.tags?.some(x => x.id === t.id));
    });

    // 详情弹窗：当前激活的标签页（basic/assoc/exec/subtask/asset）
    const activeDetailTab = ref('basic');
    function switchDetailTab(name) { activeDetailTab.value = name; }

    let selectTaskRequestId = 0;
    async function selectTask(id) {
      selectedTaskId.value = id;
      const reqId = ++selectTaskRequestId;
      try {
        const task = await api(`/api/tasks/${id}`);
        // 确保没有更新的请求覆盖
        if (reqId !== selectTaskRequestId) return;
        selectedTask.value = task;
        activeDetailTab.value = 'basic';   // 每次打开默认「基本」tab
        loadTaskConversations(id);
        checkAllPathReadmes();
      } catch (e) {
        if (reqId !== selectTaskRequestId) return;
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
      await nextTick();
      applyCardMinSizes();
    }
    async function createCard() {
      const text = newCardText.value.trim();
      if (!text) return;
      await api('/api/note-cards', { method: 'POST', body: { content: text, category: newCardCategory.value } });
      newCardText.value = '';
      await loadNoteCards();
    }
    async function renameCard(cardId, title) {
      await api(`/api/note-cards/${cardId}`, { method: 'PUT', body: { title: title?.trim() || '未命名' } });
      // 标题变化 → 重算该卡片 minWidth，否则缩小卡片时标题会被裁切
      nextTick(() => {
        const el = document.querySelector(`.note-card[data-card-id="${cardId}"]`);
        if (el && cardSizes.value[cardId]) {
          const mw = calcCardMinWidth(el);
          cardSizes.value[cardId] = { ...cardSizes.value[cardId], mw };
          debouncedSaveCardSizes();
        }
      });
    }
    async function updateCardCategory(cardId, category) {
      await api(`/api/note-cards/${cardId}`, { method: 'PUT', body: { category } });
      await loadNoteCards();
    }
    function cycleCardCategory(card) {
      const cur = card.category || '随手记';
      const idx = NOTE_CATEGORIES.findIndex(c => c.key === cur);
      const next = NOTE_CATEGORIES[(idx + 1) % NOTE_CATEGORIES.length];
      updateCardCategory(card.id, next.key);
    }
    async function deleteCard(cardId) {
      await api(`/api/note-cards/${cardId}`, { method: 'DELETE' });
      // 清理 cardSizes 缓存，避免 localStorage 残留已删除卡片的尺寸数据
      delete cardSizes.value[cardId];
      await loadNoteCards();
    }
    async function addItem(cardId, parentId) {
      const text = (newItemTexts[cardId] || '').trim();
      if (!text) return;
      await api(`/api/note-cards/${cardId}/items`, { method: 'POST', body: { content: text, parent_id: parentId || null } });
      newItemTexts[cardId] = '';
      await loadNoteCards();
    }
    function handleNoteKeydown(e, cardId) {
      // Tab 键：作为上一条的子项提交
      if (e.key === 'Tab') {
        e.preventDefault();
        const text = (newItemTexts[cardId] || '').trim();
        if (!text) return;
        const card = noteCards.value.find(c => c.id === cardId);
        const items = card?.items || [];
        const lastTopLevel = [...items].reverse().find(it => !it.parent_id);
        addItem(cardId, lastTopLevel?.id || null);
      }
    }
    // 笔记条目拖拽排序（mousedown/move/up，不用 HTML5 Drag API）
    let gDragCardId = null, gDragItemId = null;
    let gDragClone = null;      // 拖拽时显示的浮动克隆
    let gDragStartY = 0;        // mousedown 位置
    let gDragCurY = 0;          // 当前鼠标 Y

    function onNoteHandleDown(e, cardId, itemId) {
      if (e.button !== 0) return; // 只响应左键
      e.preventDefault();
      gNoteDragged = true;
      gDragCardId = cardId;
      gDragItemId = itemId;
      gDragStartY = e.clientY;
      gDragCurY = e.clientY;
      const sourceItem = e.currentTarget.closest('.note-item');
      if (!sourceItem) return;
      sourceItem.classList.add('dragging');
      // 创建浮动克隆
      gDragClone = sourceItem.cloneNode(true);
      gDragClone.classList.add('note-drag-clone');
      gDragClone.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      const sr = sourceItem.getBoundingClientRect();
      gDragClone.style.cssText = `position:fixed;left:${sr.left}px;top:${sr.top}px;width:${sr.width}px;z-index:9999;pointer-events:none;opacity:0.92;box-shadow:0 4px 20px rgba(0,0,0,0.15);transform:rotate(1deg);`;
      document.body.appendChild(gDragClone);
      document.addEventListener('mousemove', onNoteMouseMove);
      document.addEventListener('mouseup', onNoteMouseUp);
    }

    function onNoteMouseMove(e) {
      if (!gDragClone) return;
      gDragCurY = e.clientY;
      const dy = e.clientY - gDragStartY;
      const sr = document.querySelector(`.note-item[data-item-id="${gDragItemId}"]`);
      const sw = sr ? sr.getBoundingClientRect().width : 200;
      gDragClone.style.left = (parseFloat(gDragClone.style.left) || 0) + 'px';
      gDragClone.style.top = (e.clientY - 16) + 'px';
      // 清除所有指示器
      document.querySelectorAll('.note-item.drag-over-top, .note-item.drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      // 找到光标下方的目标条目
      const container = document.querySelector(`.note-items[data-card-id="${gDragCardId}"]`);
      if (!container) return;
      const items = [...container.querySelectorAll('.note-item:not(.dragging)')];
      const target = items.find(el => {
        const r = el.getBoundingClientRect();
        return e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (target) {
        const r = target.getBoundingClientRect();
        target.classList.add(e.clientY < r.top + r.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
      }
    }

    function onNoteMouseUp(e) {
      document.removeEventListener('mousemove', onNoteMouseMove);
      document.removeEventListener('mouseup', onNoteMouseUp);
      if (gDragClone) { gDragClone.remove(); gDragClone = null; }
      const container = document.querySelector(`.note-items[data-card-id="${gDragCardId}"]`);
      if (!container || !gDragItemId || !gDragCardId) { gNoteDragged = false; gDragCardId = null; gDragItemId = null; return; }
      // 清除指示器
      const allItems = [...container.querySelectorAll('.note-item')];
      allItems.forEach(el => el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
      // 找到光标下方或最近的目标条目
      const candidates = allItems.filter(el => parseInt(el.dataset.itemId) !== gDragItemId);
      let target = candidates.find(el => {
        const r = el.getBoundingClientRect();
        return e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (!target) {
        let best = null, bestDist = Infinity;
        candidates.forEach(el => {
          const r = el.getBoundingClientRect();
          const dist = Math.abs(e.clientY - (r.top + r.bottom) / 2);
          if (dist < bestDist) { bestDist = dist; best = el; }
        });
        target = best;
      }
      if (target) {
        const targetId = parseInt(target.dataset.itemId);
        const r = target.getBoundingClientRect();
        if (targetId && targetId !== gDragItemId) {
          reorderNoteItems(gDragCardId, gDragItemId, targetId, e.clientY >= r.top + r.height / 2);
        }
      }
      gNoteDragged = false;
      gDragCardId = null;
      gDragItemId = null;
    }

    async function reorderNoteItems(cardId, fromId, toId, after) {
      const card = noteCards.value.find(c => c.id === cardId);
      if (!card) return;
      const items = [...card.items];
      const fromIdx = items.findIndex(it => it.id === fromId);
      if (fromIdx < 0) return;
      const moved = items.splice(fromIdx, 1)[0];
      let toIdx = items.findIndex(it => it.id === toId);
      if (toIdx < 0) return;
      if (after) toIdx++;
      items.splice(toIdx, 0, moved);
      const updates = items.map((it, i) => ({ id: it.id, sort_order: i }));
      await api('/api/note-items/reorder', { method: 'PUT', body: { items: updates } });
      await loadNoteCards();
    }
    async function updateItem(itemId, content, icon) {
      const body = { content: content || '' };
      if (icon !== undefined) body.icon = icon;
      await api(`/api/note-items/${itemId}`, { method: 'PUT', body });
    }
    async function deleteItem(cardId, itemId) {
      await api(`/api/note-items/${itemId}`, { method: 'DELETE' });
      await loadNoteCards();
    }

    // 渲染条目内容：自动识别链接和图片
    function renderItemContent(text) {
      if (!text) return '<span class="nc-empty">空</span>';

      // 先处理 Markdown 表格：把表格块替换成 HTML table 占位
      const tablePlaceholders = [];
      const lines = text.split('\n');
      let i = 0;
      let processed = '';
      while (i < lines.length) {
        // 检测表格：连续至少3行以 | 开头和结尾
        const line = lines[i];
        if (/^\|.+\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
          // 找到表格块
          const tableLines = [line];
          i++;
          tableLines.push(lines[i]); // separator
          i++;
          while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
            tableLines.push(lines[i]);
            i++;
          }
          const tableHtml = markdownTableToHtml(tableLines);
          tablePlaceholders.push(tableHtml);
          processed += '\x00TABLE' + (tablePlaceholders.length - 1) + '\x00';
        } else {
          processed += (processed ? '\n' : '') + lines[i];
          i++;
        }
      }

      // URL 占位（先于路径检测，防止路径正则误吞 URL 的路径部分）
      const urlPlaceholders = [];
      processed = processed.replace(/(https?:\/\/[^\s<>"'\u4e00-\u9fff\u3000]+)/g, (url) => {
        try { new URL(url); } catch (e) { return url; }
        urlPlaceholders.push(url);
        return '\x00URL' + (urlPlaceholders.length - 1) + '\x00';
      });

      // 检测绝对路径（支持中文、引号包围），替换为占位符
      const pathPlaceholders = [];
      processed = processed.replace(/["']?(\/[^\s<>"']{2,})["']?/g, (fullMatch, p) => {
        if (fullMatch.startsWith('](') || fullMatch.startsWith('![')) return fullMatch;
        if (/^\|/.test(p.trim())) return fullMatch;
        const clean = p.replace(/["']/g, '');
        pathPlaceholders.push(clean);
        return '\x00PATH' + (pathPlaceholders.length - 1) + '\x00';
      });

      // 转义 HTML
      let html = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // 图片 ![](url)
      html = html.replace(/!\[([^\]]*)\]\((\/uploads\/[^\s)]+)\)/g, (_, alt, url) =>
        `<img src="${url}" alt="${alt}" class="nc-img" loading="lazy" onclick="window.open('${url}')">`);

      // 还原 URL
      urlPlaceholders.forEach((url, idx) => {
        html = html.replace('\x00URL' + idx + '\x00',
          `<a href="${url}" target="_blank" rel="noopener" class="nc-link" title="点击打开: ${url}">${url}</a>`);
      });

      // 还原表格
      tablePlaceholders.forEach((tableHtml, idx) => {
        html = html.replace('\x00TABLE' + idx + '\x00', tableHtml);
      });

      // 还原路径
      pathPlaceholders.forEach((p, idx) => {
        html = html.replace('\x00PATH' + idx + '\x00',
          `<span class="nc-path" data-path="${p.replace(/"/g, '&quot;')}" title="点击打开: ${p.replace(/"/g, '&quot;')}">${p}</span>`);
      });

      return html;
    }

    // 单击内容：链接→打开，图片→不编辑，路径→打开，否则→编辑
    function onNoteClick(event, item) {
      // 拖拽后不触发编辑
      if (gNoteDragged) { gNoteDragged = false; return; }
      // 点击链接、图片让浏览器/默认行为处理
      if (event.target.closest('a') || event.target.closest('img')) return;
      const pathEl = event.target.closest('.nc-path');
      if (pathEl) {
        event.preventDefault();
        openNotePath(pathEl.dataset.path);
        return;
      }
      startEditItem(item);
    }
    let gNoteDragged = false;

    async function openNotePath(filePath) {
      try {
        await api('/api/open-with-editor', {
          method: 'POST',
          body: { path: filePath, editor: 'terminal' }
        });
      } catch (e) {
        console.error('打开路径失败:', e);
      }
    }

    function markdownTableToHtml(lines) {
      // lines[0] = header, lines[1] = separator, lines[2..] = body
      const parseRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const header = parseRow(lines[0]);
      const body = lines.slice(2).map(parseRow);
      let table = '<table class="nc-table"><thead><tr>';
      header.forEach(h => { table += `<th>${h}</th>`; });
      table += '</tr></thead><tbody>';
      body.forEach(row => {
        table += '<tr>';
        row.forEach(cell => { table += `<td>${cell}</td>`; });
        table += '</tr>';
      });
      table += '</tbody></table>';
      return '<div class="nc-table-wrap">' + table + '</div>';
    }

    function copyItemContent(text) {
      navigator.clipboard.writeText(text || '').then(() => {
        // 短暂视觉反馈由 CSS :active 处理
      }).catch(() => {});
    }

    function startEditItem(item) {
      editingItemId.value = item.id;
      // 自动 focus textarea：让 @blur 在用户点击外部时自然触发 saveEditItem
      // 同一时刻只有一个 item 在编辑，querySelector 取第一个即可
      nextTick(() => {
        const ta = document.querySelector('textarea.note-item-edit');
        if (ta) {
          ta.focus();
          // 光标放到末尾，方便续写
          const len = ta.value.length;
          ta.setSelectionRange(len, len);
        }
      });
    }
    async function saveEditItem(itemId, newContent) {
      editingItemId.value = null;
      if (newContent !== undefined) {
        await updateItem(itemId, newContent.trim() || '');
        await loadNoteCards();
      }
    }
    function cancelEditItem() {
      editingItemId.value = null;
    }

    // 处理粘贴：图片、Excel表格
    async function handleNotePaste(event, cardId) {
      const cd = event.clipboardData;
      if (!cd) return;

      // 1. 检查图片（files 兼容 Windows 截图，items 兼容其他来源）
      const files = cd.files ? [...cd.files] : [];
      let imageFiles = files.filter(f => f.type.startsWith('image/'));
      // 也从 items 收集
      if (!imageFiles.length && cd.items) {
        for (const item of cd.items) {
          if (item.type.startsWith('image/')) {
            const f = item.getAsFile();
            if (f) imageFiles.push(f);
          }
        }
      }
      if (imageFiles.length) {
        event.preventDefault();
        for (const file of imageFiles) {
          const formData = new FormData();
          formData.append('file', file);
          try {
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.url) {
              const current = newItemTexts[cardId] || '';
              newItemTexts[cardId] = current + (current ? '\n' : '') + `![](${data.url})`;
            }
          } catch (e) {
            console.error('图片上传失败:', e);
          }
        }
        return;
      }

      // 2. 检查 Excel/HTML 表格
      const html = cd.getData('text/html');
      if (html && /<table/i.test(html)) {
        event.preventDefault();
        const md = htmlTableToMarkdown(html);
        if (md) {
          const current = newItemTexts[cardId] || '';
          newItemTexts[cardId] = current + (current ? '\n' : '') + md;
        }
        return;
      }

      // 3. 兜底：Tab 分隔的纯文本（Excel 等）
      const plain = cd.getData('text/plain');
      if (plain && plain.includes('\t')) {
        const lines = plain.split('\n').filter(l => l.trim());
        if (lines.length >= 2 && lines.every(l => l.includes('\t'))) {
          event.preventDefault();
          const rows = lines.map(l => l.split('\t'));
          const colCount = Math.max(...rows.map(r => r.length));
          const normalized = rows.map(r => { while (r.length < colCount) r.push(''); return r; });
          const mdLines = [];
          mdLines.push('| ' + normalized[0].join(' | ') + ' |');
          mdLines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
          for (let i = 1; i < normalized.length; i++) {
            mdLines.push('| ' + normalized[i].join(' | ') + ' |');
          }
          const current = newItemTexts[cardId] || '';
          newItemTexts[cardId] = current + (current ? '\n' : '') + mdLines.join('\n');
        }
      }
    }

    // HTML table → Markdown table
    function htmlTableToMarkdown(html) {
      const match = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
      if (!match) return null;
      const tbody = match[1];
      const rows = [];
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRe.exec(tbody)) !== null) {
        const cells = [];
        const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let tdMatch;
        while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
          cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) return null;
      const colCount = Math.max(...rows.map(r => r.length));
      const normalized = rows.map(r => {
        while (r.length < colCount) r.push('');
        return r;
      });
      const lines = [];
      lines.push('| ' + normalized[0].join(' | ') + ' |');
      lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
      for (let i = 1; i < normalized.length; i++) {
        lines.push('| ' + normalized[i].join(' | ') + ' |');
      }
      return lines.join('\n');
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

    const pressureAnalysis = ref('');
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

    const collapsedGoalFolders = reactive({});
    function toggleGoalFolders(goalId) {
      collapsedGoalFolders[goalId] = !collapsedGoalFolders[goalId];
    }

    function goalDeadlineHint(stat) {
      if (!stat.target_date) return '';
      const remainingMs = new Date(stat.target_date) - new Date();
      if (remainingMs <= 0) return '已过期';
      return '剩余 ' + formatDuration(remainingMs / 60000);
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
      Object.assign(routineForm, { name: '', description: '', goal_id: null, frequency: 'weekly', is_report: false, report_meeting: '' });
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
        title: routine.name, description: routine.description || '',
        goal_id: routine.goal_id || null, routine_id: routine.id,
        tag_ids: [], due_date: '', estimated_time: routine.estimated_time || 0,
        people_str: '', create_folder: false,
        is_report: !!routine.is_report,
        report_meeting: routine.report_meeting || '',
        is_today: false, folder_name: '', reuse_folder_path: '', subtasks: [],
      });
      showQuickAdd.value = true;
      nextTick(() => {
        const el = document.querySelector('.quick-add-modal .input-lg');
        if (el) el.focus();
      });
    }

    async function loadReview() {
      const data = await api(`/api/stats/review?type=${reviewType.value}`);
      Object.assign(reviewData, data);
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

    let aiConfigSavedTimer = null;
    async function saveAIConfigs() {
      await api('/api/settings', {
        method: 'PUT',
        body: { ai_configs: aiConfigs.value, ai_active_config: activeAIConfig.value }
      });
      aiConfigSaved.value = true;
      // 用 ref 跟踪 timer，连续保存时清掉旧 timer，避免遗留回调把新状态错误重置
      if (aiConfigSavedTimer) clearTimeout(aiConfigSavedTimer);
      aiConfigSavedTimer = setTimeout(() => { aiConfigSaved.value = false; aiConfigSavedTimer = null; }, 2000);
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
              // 按 \n 切（兼容 \r\n），最后一段可能是不完整行，留到下次
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
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
      } catch (e) { console.error('pickFolderFor error:', e); }
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
      startAIProgress('正在思考…');

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
          stopAIProgress();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        // SSE buffer：TCP 包可能把一行 data: 拆到多个 chunk，必须跨 chunk 拼接
        let sseBuffer = '';
        let firstChunkReceived = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          sseBuffer += chunk;
          // 按 \n 切，最后一段可能是不完整行，留到下次
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const line of lines) {
            const tl = line.trim();
            if (!tl.startsWith('data:')) continue;
            const data = tl.substring(tl.indexOf(':') + 1).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const d = json.choices?.[0]?.delta;
              const delta = (d?.content || '');
              if (delta) {
                // 第一个 chunk 到达后停进度条，让用户专注流式输出
                if (!firstChunkReceived) { firstChunkReceived = true; stopAIProgress(); }
                fullContent += delta;
                aiStreamContent.value = fullContent;
                await nextTick();
                scrollAIChat();
              }
            } catch (e) {
              // 单行 JSON.parse 失败：忽略该行，不再追加原始 chunk（避免把 SSE 协议文本混入正文）
              console.warn('SSE JSON parse failed:', data.slice(0, 100));
            }
          }
        }
        // 处理 buffer 中残留的最后一行
        const lastLine = sseBuffer.trim();
        if (lastLine.startsWith('data:')) {
          const data = lastLine.substring(lastLine.indexOf(':') + 1).trim();
          if (data && data !== '[DONE]') {
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) fullContent += delta;
            } catch (e) { /* ignore */ }
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

      // 兜底：如果流式从未开始（错误/空响应），停掉进度条
      stopAIProgress();
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

    // 复制 AI 消息内容到剪贴板，1.5s 视觉反馈
    async function copyAIMessage(text, ev) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        // 降级：用临时 textarea 兜底（部分浏览器在非 HTTPS / 非聚焦时 clipboard API 不可用）
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) { return; }
      }
      if (!ev || !ev.currentTarget) return;
      const btn = ev.currentTarget;
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
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
      if (mins >= 1) return `${mins.toFixed(1)}分钟`;
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
      loadCardSizes();
      // 监听过滤变化（切换分类胶囊、新增/删除卡片等），重新 observe 新出现的 DOM 元素。
      // 没有这个 watch 的话，Vue 重创建元素后 ResizeObserver 会失效，
      // 用户拖动卡片尺寸不会被记录。
      watch(filteredNoteCards, () => {
        nextTick(() => {
          // 切换分类后，对新出现的 DOM 元素重新 fit 标题宽度（input.style.width 在 Vue 重创建时丢失）
          document.querySelectorAll('.note-card').forEach(el => {
            if (el.dataset.observed === '1') return;
            el.dataset.observed = '1';
            // 重新 fit 标题
            const titleInput = el.querySelector('.note-card-title');
            if (titleInput) fitTitleWidth(titleInput);
            const cardId = el.dataset.cardId;
            const saved = cardId ? cardSizes.value[cardId] : null;
            // 关键：先确认 Vue 已经把 :style 应用到 DOM（cardSizes.w 与实际宽度一致）
            // 否则下面读到的 r.width 可能是错误值（被 minWidth 撑大或还没应用）
            const r = el.getBoundingClientRect();
            el.dataset.lastWidth = Math.round(r.width);
            el.dataset.lastHeight = Math.round(r.height);
            // 新卡片可能在 cardSizes 中还没有条目，补一次测量
            if (cardId && !saved) {
              const mw = calcCardMinWidth(el);
              const mh = calcCardMinHeight(el);
              cardSizes.value[cardId] = {
                w: Math.max(Math.round(r.width), mw),
                h: Math.max(Math.round(r.height), mh),
                mw, mh
              };
            } else if (cardId && saved) {
              // 已有 cardSizes：仅刷新 mw/mh（内容或标题可能变化），保留用户拖动的 w/h
              const mw = calcCardMinWidth(el);
              const mh = calcCardMinHeight(el);
              if (saved.mw !== mw || saved.mh !== mh) {
                cardSizes.value[cardId] = { ...saved, mw, mh };
              }
            }
            if (cardResizeObserver) cardResizeObserver.observe(el);
          });
        });
      });
      window.addEventListener('beforeunload', saveCardSizesFromDOM);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveCardSizesFromDOM();
      });
      document.addEventListener('keydown', handleKeydown);
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.emoji-pick-btn') && !e.target.closest('.emoji-grid')) {
          emojiPickerFor.value = null;
        }
        // 关闭笔记条目图标选择器
        if (!e.target.closest('.note-item-icon-btn') && !e.target.closest('.note-item-icon-grid')) {
          noteItemIconPicker.value = null;
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
      window.addEventListener('resize', onWindowResize);
      // Vue 接管完成，淡出加载过渡层（不等 loadAll，让用户尽早看到骨架）
      const loader = document.getElementById('app-loader');
      if (loader) {
        requestAnimationFrame(() => {
          loader.classList.add('hide');
          setTimeout(() => loader.remove(), 500);
        });
      }
    });

    // 具名 resize handler，方便 onUnmounted 时移除
    function onWindowResize() {
      if (currentView.value === 'graph') resizeGraph();
    }

    // 单页应用理论上不卸载，但显式 cleanup 防御未来热重载/组件化场景
    onUnmounted(() => {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      if (gAnimId) { cancelAnimationFrame(gAnimId); gAnimId = null; }
      if (window._graphResizeObserver) { window._graphResizeObserver.disconnect(); window._graphResizeObserver = null; }
      if (cardResizeObserver) { cardResizeObserver.disconnect(); cardResizeObserver = null; }
      if (aiConfigSavedTimer) { clearTimeout(aiConfigSavedTimer); aiConfigSavedTimer = null; }
      if (aiProgressTimer) { clearInterval(aiProgressTimer); aiProgressTimer = null; }
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('beforeunload', saveCardSizesFromDOM);
    });

    // ==================== 今日必做 ====================

    async function toggleToday(taskId) {
      await api(`/api/tasks/${taskId}/toggle-today`, { method: 'POST' });
      await loadTasks();
      if (selectedTask.value?.id === taskId) selectedTask.value = await api(`/api/tasks/${taskId}`);
    }

    async function analyzeTaskProgress(taskId) {
      analyzingTaskId.value = taskId;
      startAIProgress('正在分析任务进展…');
      try {
        const result = await api(`/api/tasks/${taskId}/analyze-progress`, { method: 'POST' });
        expandedProgress.value[taskId] = true;
        await loadTasks();
        if (selectedTask.value?.id === taskId) {
          selectedTask.value = await api(`/api/tasks/${taskId}`);
        }
      } catch (e) {
        // auto-triggered, fail silently
      }
      stopAIProgress();
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
      noteItemIconPicker, noteItemIcons, displayItemIcon, toggleItemIconPicker, setItemIcon, clearItemIcon,
      timeLogDuration, timeLogNote,
      isDragging, fileInput,
      goalStats,
      reviewType, reviewData,
      autoCreateFolder, statuses,
      showAIChat, aiMessages, aiInput, aiStreaming, aiStreamContent, aiChatMessages, aiProgress,
      filteredTasks,
      switchView, goToTask, toggleGoalFilter, toggleTagFilter, debounceSearch,
      openQuickAdd, openQuickAddReport, quickCreateTask, toggleNewTaskTag, isReportTagSelected, isReportTask, activeDetailTab, switchDetailTab,
      onSubtaskDragStart, onSubtaskDragOver, onSubtaskDrop, onSubtaskDragEnd, addSubtaskAt,
      selectTask, closeDetail, saveSelectedTask, changeStatus, deleteSelectedTask,
      isTaskTagged, toggleTaskTag, addTag, removeTag, updateTag,
      addPerson, removePerson,
      logTime,
      triggerFileInput, handleFileDrop, handleFileSelect,
      deleteAttachment, openAttachment, openFolder, openWithEditor,
      quickNote, appendingNote, appendToReadme,
      noteCards, cardSizes, newCardText, newCardCategory, filterNoteCategory, newItemTexts, editingItemId,
      bubbleInput, bubbleInputRef, bubbleStyle, showBubbleInput, submitBubbleInput, dismissBubbleInput, getCatByKey,
      NOTE_CATEGORIES, filteredNoteCards,
      loadNoteCards, createCard, renameCard, updateCardCategory, cycleCardCategory, deleteCard,
      fitTitleWidth, fitAllTitleWidths,
      addItem, updateItem, deleteItem, handleNoteKeydown,
      onNoteHandleDown,
      renderItemContent, copyItemContent, onNoteClick, startEditItem, saveEditItem, cancelEditItem, handleNotePaste, openNotePath,
      unlinkFolder,
      saveGoal, editGoal, archiveGoal, loadGoalStats, goalProgress,
      collapsedGoalFolders, toggleGoalFolders, goalDeadlineHint,
      saveRoutine, editRoutine, archiveRoutine, createTaskFromRoutine,
      loadReview,
      saveSettings,
      aiConfigs, activeAIConfig, addAIConfig, removeAIConfig, switchAIModel, saveAIConfigs, aiConfigSaved, showAIConfigJson, aiConfigsJson,
      testAIConnection, aiTestResult,
      statusLabel, freqLabel, isOverdue, formatDate,
      fileIcon, formatSize,
      goalTaskFolders, openFolderFor,
      pickFolderFor, pickFileFor, refreshGoalPaths, addGoalPath, removeGoalPath, removeTaskPath,
      onPathDragStart, onPathDragOver, onPathDrop, setPrimaryPath,
      pathReadmeStatus, checkPathReadme, checkAllPathReadmes,
      expandedProgress, dragPathIndex, dragPathOverIndex,
      openDirBrowser,
      launchTerminal,
      clearAIChat, closeAIChat, sendAIMessage, sendAIPrompt, renderMarkdown, copyAIMessage,
      noteChatCardId, noteConversations, openNoteChat,
      // Timer
      activeTimers, startTaskTimer, stopTaskTimer, isTimerActive, getTimerElapsed, formatTime, formatDuration,
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
      kanbanDragOver, kanbanDragOverTaskId, kanbanDropPosition, kanbanColumns,
      onKanbanDragStart, onKanbanDragOver, onKanbanDragLeave, onKanbanCardDragOver, onKanbanCardDragLeave, onKanbanDrop, onKanbanCardDrop,
      // Batch
      batchMode, batchSelected, batchStatus, batchGoalId,
      toggleBatchSelect, applyBatchStatus, applyBatchGoal, batchToggleToday, batchDelete,
      settingsTab,
      // Subtask/parent helpers
      subtaskDoneCount, subtaskPercent, childTaskCount,
      // Dashboard
      upcomingDeadlines, pressureAnalysis, analyzePressure, pressureChatMode, savePressureAnalysis,
      // Reports
      filterReportOnly, reportMeetings, loadReportMeetings, groupedReportTasks,
      // Conversations
      taskConversations, scanResults, scanningConversations, showScanModal,
      loadTaskConversations, scanConversations, linkConversation, unlinkConversation, continueConversation, quickContinueConversation,
      // Calendar
      calendarYear, calendarMonth, calendarWeeks, calendarViewMode, calendarWeekDays, calendarTab,
      ganttData, ganttRows, ganttScaleBody, syncGanttScroll,
      graphTooltip, graphCanvas, graphCanvasWrap,
      graphMouseDown, graphMouseMove, graphMouseUp, graphWheel, graphClick, graphDblClick,
      graphZoom, graphZoomTo, graphZoomIn, graphZoomOut,
      calendarPrevMonth, calendarNextMonth, calendarPrevWeek, calendarNextWeek,
      // Quick input
      quickInputText, createFromQuickInput,
      // AI suggestions
      aiSuggestions, aiEnriching, aiPickFolder, applyAISuggestions, dismissAISuggestions,
      aiInferringQuickAdd, aiInferQuickAdd, aiInferInlineStatus, quickAddPickFolder, createFolderWithName,
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
