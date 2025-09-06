/**
 * notification.js — Logic for the "Reminder" / 用药提醒 page
 * 用药提醒页面逻辑
 *
 * Responsibilities:
 * - 用药提醒管理（添加、编辑、删除）
 * - 本地存储持久化
 * - 提醒通知（基于时间）- 使用Capacitor本地通知插件
 * - Provide initCase(rootEl) / destroyCase() lifecycle for dynamic page loader
 *
 * Supports both:
 * - Standalone HTML usage (rootEl = document)
 * - Shadow DOM injection (rootEl = ShadowRoot)
 */
(function () {
  console.debug("[reminder] notification.js evaluated");
  if (typeof window !== 'undefined') {
    if (window.__notification_loaded__) {
      console.debug('[reminder] notification.js already loaded, skip');
      return;
    }
    window.__notification_loaded__ = true;
  }

  // Capacitor LocalNotifications 插件
  let LocalNotifications = null;
  let Capacitor = null;

  // Backend API base: absolute by default; can be overridden via window.__API_BASE__
  const __API_BASE_DEFAULT__ = (typeof window !== 'undefined' && window.__API_BASE__) || 'https://app.zdelf.cn';
  const __API_BASE__ = __API_BASE_DEFAULT__ && __API_BASE_DEFAULT__.endsWith('/')
    ? __API_BASE_DEFAULT__.slice(0, -1)
    : __API_BASE_DEFAULT__;

  // 尝试导入Capacitor插件
  try {
    Capacitor = window.Capacitor;
    if (Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
      LocalNotifications = Capacitor.Plugins.LocalNotifications;
      console.log('✅ Capacitor LocalNotifications 插件已加载');
    } else {
      console.warn('⚠️ Capacitor LocalNotifications 插件未找到，将使用浏览器原生通知');
    }
  } catch (error) {
    console.warn('⚠️ 无法加载Capacitor插件，将使用浏览器原生通知:', error);
  }

  // Array of teardown callbacks to run when leaving the page
  let cleanupFns = [];

  // 提醒数据
  let reminders = [];
  let editingReminderId = null;
  let pendingDeleteId = null; // 待删除的提醒ID
  let reminderTimeouts = new Map(); // 存储定时器引用（fallback用）
  let uiAdvanceTimeouts = new Map(); // 仅用于UI推进的定时器（原生调度时使用）
  let currentRoot = null; // 当前的Shadow Root引用
  let isSettingUpReminders = false; // 防止重复设置提醒
  let sentNotifications = new Set(); // 防止重复发送通知
  let lastNotificationTime = new Map(); // 记录最后发送通知的时间
  let handledNotificationIds = new Set(); // 已处理的本地通知ID，避免重复推进

  // 依据提醒ID生成稳定的数字通知ID，避免重复调度
  function stableIdFromString(str) {
    try {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // 32位
      }
      hash = Math.abs(hash);
      return hash === 0 ? 1 : hash; // 避免0
    } catch (_) {
      return Math.floor(Math.random() * 900000) + 100000;
    }
  }

  // 内部硬删除：不弹确认，直接删除指定提醒
  async function hardDeleteReminder(reminderId) {
    try {
      // 清理fallback定时器
      if (reminderTimeouts.has(reminderId)) {
        clearTimeout(reminderTimeouts.get(reminderId));
        reminderTimeouts.delete(reminderId);
      }
      // 清理UI推进定时器
      if (uiAdvanceTimeouts.has(reminderId)) {
        clearTimeout(uiAdvanceTimeouts.get(reminderId));
        uiAdvanceTimeouts.delete(reminderId);
      }
      // 取消原生通知
      if (LocalNotifications) {
        const nid = stableIdFromString(reminderId);
        try { await LocalNotifications.cancel({ notifications: [{ id: nid }] }); } catch (_) {}
      }
      // 移除数据、保存并刷新
      reminders = reminders.filter(r => r.id !== reminderId);
      saveReminders();
      if (currentRoot) renderReminders(currentRoot);
    } catch (e) {
      console.error('硬删除提醒失败:', e);
    }
  }

  // 存储键名
  const STORAGE_KEY = 'medication_reminders';

  // 震动反馈函数
  function hapticFeedback(style = 'Light') {
    try { window.__hapticImpact__ && window.__hapticImpact__(style); } catch(_) {}
  }

  /**
   * 根据当前时间返回有趣的问候语
   */
  function getGreeting() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 8) return "🌅 早安，今天不要忘记吃药～"; // Very early morning
    if (hour >= 8 && hour < 12) return "☀️ 早上好，该吃药啦"; // Morning
    if (hour >= 12 && hour < 14) return "🌞 中午好，吃药时间到"; // Noon
    if (hour >= 14 && hour < 17) return "⛅ 下午好，不要忘记吃药哦"; // Afternoon
    if (hour >= 17 && hour < 19) return "🌆 黄昏好，坚持吃药哦"; // Evening
    if (hour >= 19 && hour < 22) return "🌙 晚上好，准备前记得吃药哦"; // Night
    if (hour >= 22 || hour < 2) return "🌃 夜深了，赶紧吃药睡觉哦"; // Late night
    return "🕐 嘿，时间过得真快，又该吃药啦"; // Default
  }

  // 工具函数：Promise化获取用户名
  async function getUsernameAsync() {
    return await new Promise((resolve) => {
      try { getUsername((name) => resolve(name || '访客')); } catch (_) { resolve('访客'); }
    });
  }

  // 工具函数：构建通知标题
  function buildNotificationTitle() {
    return getGreeting();
  }

  // 工具函数：构建通知内容
  function buildNotificationBody(username, reminder) {
    const medicationName = (reminder && reminder.name) ? reminder.name : '药品';
    let body = `嘿，${username}！该吃${medicationName}啦`;
    if (reminder && reminder.dosage) {
      body += `，记得吃 ${reminder.dosage}`;
    }
    return body;
  }

  /**
   * 获取用户名
   */
  function getUsername(callback) {
    const userId = localStorage.getItem('userId');

    if (!userId || userId === 'undefined' || userId === 'null') {
      callback('访客');
      return;
    }

    // 请求后端获取用户信息
    fetch(__API_BASE__ + '/readdata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_name: 'users', user_id: userId }),
    })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      return response.json();
    })
    .then((data) => {
      if (data.success && Array.isArray(data.data) && data.data.length > 0) {
        const username = data.data[0].username || '访客';
        callback(username);
      } else {
        callback('访客');
      }
    })
    .catch((error) => {
      console.error('❌ 获取用户信息失败:', error);
      callback('访客');
    });
  }

  /**
   * 检测是否在Capacitor原生App环境中运行
   */
  function isCapacitorApp() {
    try {
      // 检查Capacitor对象是否存在
      if (typeof window.Capacitor === 'undefined') {
        return false;
      }

      // 检查是否为原生平台
      if (typeof window.Capacitor.isNativePlatform === 'function') {
        return window.Capacitor.isNativePlatform();
      }

      // 备选检查：检查Capacitor对象的基本结构
      return !!(window.Capacitor && window.Capacitor.Plugins);
    } catch (error) {
      console.warn('检测Capacitor环境时出错:', error);
      return false;
    }
  }

  /**
   * 显示浏览器限制提示
   */
  function showBrowserRestriction(root) {
    const container = root.getElementById('remindersContainer');
    if (!container) return;

    container.innerHTML = `
      <div class="browser-restriction">
        <div class="restriction-icon">📱</div>
        <h2 class="restriction-title">请在App中使用</h2>
        <p class="restriction-message">
          用药提醒功能需要在移动App中才能正常工作，以确保提醒通知的可靠性和持久性。
        </p>
        <div class="restriction-details">
          <div class="detail-item">
            <div class="detail-icon">🔔</div>
            <div class="detail-text">
              <strong>可靠的通知</strong><br>
              App中的本地通知更加可靠，不会被浏览器限制
            </div>
          </div>
          <div class="detail-item">
            <div class="detail-icon">⚡</div>
            <div class="detail-text">
              <strong>后台运行</strong><br>
              App可以持续在后台运行，确保提醒按时触发
            </div>
          </div>
          <div class="detail-item">
            <div class="detail-icon">🔄</div>
            <div class="detail-text">
              <strong>自动同步</strong><br>
              App中的数据会自动同步和持久保存
            </div>
          </div>
        </div>
        <div class="restriction-footer">
          <p>请下载我们的移动App来使用完整的用药提醒功能。</p>
        </div>
      </div>
    `;

    // 隐藏添加按钮
    const addBtn = root.getElementById('addReminderBtn');
    if (addBtn) {
      addBtn.style.display = 'none';
    }
  }

  /**
   * Initialize the "Reminder" page UI.
   * @param {Document|ShadowRoot} rootEl - Scope for DOM queries.
   */
  async function initCase(rootEl) {
    const root = rootEl || document;
    currentRoot = root; // 存储当前的root引用

    // 检查是否在Capacitor App环境中
    if (!isCapacitorApp()) {
      console.warn('⚠️ 检测到非Capacitor环境，显示浏览器限制提示');
      showBrowserRestriction(root);
      return;
    }

    // 加载保存的提醒数据
    loadReminders();

    // 先补齐已过期的提醒到下一次
    catchUpOverdueReminders();

    // 绑定事件监听器
    bindEvents(root);

    // 请求通知权限
    const hasPermission = await requestNotificationPermission();
    console.log('🔍 通知权限状态:', hasPermission);

    // 渲染提醒列表
    renderReminders(root);

    // 设置提醒定时器
    await setupReminders();

    console.log('✅ initCase 执行，用药提醒页面已初始化');
  }

  /**
   * 绑定所有事件监听器
   */
  function bindEvents(root) {
    // 添加提醒按钮
    const addBtn = root.getElementById('addReminderBtn');
    if (addBtn) {
      const addHandler = () => {
        hapticFeedback('Light');
        openModal(root);
      };
      addBtn.addEventListener('click', addHandler);
      cleanupFns.push(() => addBtn.removeEventListener('click', addHandler));
    }

    // 模态框事件
    const modal = root.getElementById('reminderModal');
    const closeBtn = root.getElementById('modalClose');
    const cancelBtn = root.getElementById('cancelBtn');
    const form = root.getElementById('reminderForm');

    if (closeBtn) {
      const closeHandler = () => {
        hapticFeedback('Light');
        closeModal(root);
      };
      closeBtn.addEventListener('click', closeHandler);
      cleanupFns.push(() => closeBtn.removeEventListener('click', closeHandler));
    }

    if (cancelBtn) {
      const cancelHandler = () => {
        hapticFeedback('Light');
        closeModal(root);
      };
      cancelBtn.addEventListener('click', cancelHandler);
      cleanupFns.push(() => cancelBtn.removeEventListener('click', cancelHandler));
    }

    if (form) {
      const submitHandler = (e) => {
        e.preventDefault();
        saveReminder(root);
      };
      form.addEventListener('submit', submitHandler);
      cleanupFns.push(() => form.removeEventListener('submit', submitHandler));

      const repeatSelect = root.getElementById('repeatInterval');
      const repeatGroup = root.getElementById('repeatCustomGroup');
      const repeatLabel = root.getElementById('repeatCustomLabel');
      if (repeatSelect && repeatGroup) {
        const changeHandler = () => {
          const v = repeatSelect.value;
          repeatGroup.style.display = (v !== 'none') ? '' : 'none';
          if (repeatLabel) {
            repeatLabel.textContent = `自定义间隔（${v === 'hourly' ? '小时' : v === 'daily' ? '天' : v === 'weekly' ? '周' : ''}）`;
          }
        };
        repeatSelect.addEventListener('change', changeHandler);
        cleanupFns.push(() => repeatSelect.removeEventListener('change', changeHandler));
      }
    }

    // 点击模态框背景关闭
    if (modal) {
      const modalHandler = (e) => {
        if (e.target === modal) {
          hapticFeedback('Light');
          closeModal(root);
        }
      };
      modal.addEventListener('click', modalHandler);
      cleanupFns.push(() => modal.removeEventListener('click', modalHandler));
    }

    // ESC 键关闭模态框
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        if (modal && modal.classList.contains('show')) {
          hapticFeedback('Light');
          closeModal(root);
        } else if (deleteModal && deleteModal.classList.contains('show')) {
          hapticFeedback('Light');
          closeDeleteModal(root);
        }
      }
    };
    document.addEventListener('keydown', escHandler);
    cleanupFns.push(() => document.removeEventListener('keydown', escHandler));

    // 删除确认弹窗事件
    const deleteModal = root.getElementById('deleteConfirmModal');
    const deleteCancelBtn = root.getElementById('deleteCancelBtn');
    const deleteConfirmBtn = root.getElementById('deleteConfirmBtn');

    if (deleteCancelBtn) {
      const cancelHandler = () => {
        hapticFeedback('Light');
        closeDeleteModal(root);
      };
      deleteCancelBtn.addEventListener('click', cancelHandler);
      cleanupFns.push(() => deleteCancelBtn.removeEventListener('click', cancelHandler));
    }

    if (deleteConfirmBtn) {
      const confirmHandler = () => {
        hapticFeedback('Medium');
        confirmDelete(root);
      };
      deleteConfirmBtn.addEventListener('click', confirmHandler);
      cleanupFns.push(() => deleteConfirmBtn.removeEventListener('click', confirmHandler));
    }

    // 点击删除确认弹窗背景关闭
    if (deleteModal) {
      const deleteModalHandler = (e) => {
        if (e.target === deleteModal) {
          hapticFeedback('Light');
          closeDeleteModal(root);
        }
      };
      deleteModal.addEventListener('click', deleteModalHandler);
      cleanupFns.push(() => deleteModal.removeEventListener('click', deleteModalHandler));
    }
  }

  /**
   * 从本地存储加载提醒数据
   */
  function loadReminders() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        reminders = JSON.parse(stored);
        console.log('📦 加载了', reminders.length, '个提醒');
      } else {
        reminders = [];
        console.log('📦 没有找到保存的提醒数据');
      }
    } catch (error) {
      console.error('❌ 加载提醒数据失败:', error);
      reminders = [];
    }
  }

  /**
   * 保存提醒数据到本地存储
   */
  function saveReminders() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
      console.log('💾 保存了', reminders.length, '个提醒');
    } catch (error) {
      console.error('❌ 保存提醒数据失败:', error);
    }
  }

  /**
   * 渲染提醒列表
   */
  function renderReminders(root) {
    const container = root.getElementById('remindersContainer');
    if (!container) return;

    if (reminders.length === 0) {
      container.innerHTML = `
        <div class="empty-state" id="emptyAddCard" style="cursor:pointer;">
          <div class="icon">💊</div>
          <h3>还没有用药提醒</h3>
          <p>点击此方框添加您的第一个药提醒</p>
        </div>
      `;
      // 绑定点击打开新增提醒
      const emptyCard = container.querySelector('#emptyAddCard');
      if (emptyCard) {
        const emptyClick = () => { hapticFeedback('Light'); openModal(currentRoot || document); };
        emptyCard.addEventListener('click', emptyClick);
      }
      return;
    }

    // 按日期+时间排序
    const sortedReminders = [...reminders].sort((a, b) => {
      const dateA = a.date || '1970-01-01';
      const dateB = b.date || '1970-01-01';
      const timeA = a.time || '00:00';
      const timeB = b.time || '00:00';
      const isoA = `${dateA}T${timeA}:00`;
      const isoB = `${dateB}T${timeB}:00`;
      return new Date(isoA) - new Date(isoB);
    });

    container.innerHTML = sortedReminders.map(reminder => {
      const intervalText = formatRepeatText(reminder);
      return `
      <div class="reminder-card" data-id="${reminder.id}">
        <div class="reminder-header">
          <h3 class="medication-name">${reminder.name}</h3>
          <span class="reminder-time">${(reminder.date || '')} ${formatTime(reminder.time)}</span>
        </div>
        ${reminder.dosage ? `<div class=\"reminder-details\">剂量：${reminder.dosage}</div>` : ''}
        ${intervalText ? `<div class=\"reminder-details\">${intervalText}</div>` : ''}
        ${reminder.notes ? `<div class=\"reminder-details\">备注：${reminder.notes}</div>` : ''}
        <div class="reminder-actions">
          <button class="btn btn-secondary" data-action="edit" data-id="${reminder.id}">编辑</button>
          <button class="btn btn-danger" data-action="delete" data-id="${reminder.id}">删除</button>
        </div>
      </div>`;
    }).join('');

    // 添加“新增提醒”虚线卡片
    const addCardHtml = `
      <div class="reminder-card add-card" id="addReminderCard">
        <div class="add-card-inner">增加用药提醒</div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', addCardHtml);

    // 绑定卡片内事件保持不变
    const handleButtonClick = (e) => {
      const btn = e.target.closest('.btn');
      if (!btn) return;

      hapticFeedback('Light');
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'edit') {
        editReminder(id);
      } else if (action === 'delete') {
        deleteReminder(id);
      }
    };

    const oldHandler = container._buttonClickHandler;
    if (oldHandler) {
      container.removeEventListener('click', oldHandler);
    }
    container.addEventListener('click', handleButtonClick);
    container._buttonClickHandler = handleButtonClick;

    // 绑定新增卡片点击
    const addCard = container.querySelector('#addReminderCard');
    if (addCard) {
      const addHandler = () => {
        hapticFeedback('Light');
        openModal(root);
      };
      addCard.addEventListener('click', addHandler);
      // 记录清理函数
      if (!container._addCardCleanup) {
        container._addCardCleanup = [];
      }
      container._addCardCleanup.push(() => addCard.removeEventListener('click', addHandler));
    }
  }

  /**
   * 格式化时间显示
   */
  function formatTime(timeString) {
    if (!timeString) return '未设置';
    const [hours, minutes] = timeString.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? '下午' : '上午';
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return `${ampm} ${displayHour}:${minutes}`;
  }

  /**
   * 打开添加/编辑模态框
   */
  function openModal(root, reminderId = null) {
    const modal = root.getElementById('reminderModal');
    const title = root.getElementById('modalTitle');
    const form = root.getElementById('reminderForm');

    if (!modal || !title || !form) return;

    editingReminderId = reminderId;

    if (reminderId) {
      // 编辑模式
      const reminder = reminders.find(r => r.id === reminderId);
      if (reminder) {
        title.textContent = '编辑用药提醒';
        root.getElementById('medicationName').value = reminder.name || '';
        root.getElementById('reminderTime').value = reminder.time || '';
        const dateEl = root.getElementById('reminderDate');
        if (dateEl) dateEl.value = reminder.date || '';
        root.getElementById('dosage').value = reminder.dosage || '';
        const repeatSelect = root.getElementById('repeatInterval');
        const repeatValue = root.getElementById('repeatCustomValue');
        const repeatGroup = root.getElementById('repeatCustomGroup');
        const repeatLabel = root.getElementById('repeatCustomLabel');
        if (repeatSelect) repeatSelect.value = reminder.repeatInterval || 'none';
        if (repeatValue) repeatValue.value = reminder.repeatCustomValue || '';
        if (repeatGroup) repeatGroup.style.display = (reminder.repeatInterval && reminder.repeatInterval !== 'none') ? '' : 'none';
        if (repeatLabel && repeatSelect) {
          repeatLabel.textContent = `自定义间隔（${repeatSelect.value === 'hourly' ? '小时' : repeatSelect.value === 'daily' ? '天' : repeatSelect.value === 'weekly' ? '周' : ''}）`;
        }
      }
    } else {
      // 添加模式
      title.textContent = '添加用药提醒';
      form.reset();
      // 设置默认日期与时间
      const now = new Date();
      const currentTime = now.toTimeString().slice(0, 5); // HH:MM
      const currentDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const timeEl = root.getElementById('reminderTime');
      const dateEl = root.getElementById('reminderDate');
      if (timeEl) timeEl.value = currentTime;
      if (dateEl) dateEl.value = currentDate;
      const repeatSelect = root.getElementById('repeatInterval');
      const repeatValue = root.getElementById('repeatCustomValue');
      const repeatGroup = root.getElementById('repeatCustomGroup');
      const repeatLabel = root.getElementById('repeatCustomLabel');
      if (repeatSelect) repeatSelect.value = 'none';
      if (repeatValue) repeatValue.value = '';
      if (repeatGroup) repeatGroup.style.display = 'none';
      if (repeatLabel) repeatLabel.textContent = '自定义间隔';
    }

    modal.classList.add('show');
  }

  /**
   * 关闭模态框
   */
  function closeModal(root) {
    const modal = root.getElementById('reminderModal');
    if (modal) {
      modal.classList.remove('show');
    }
    editingReminderId = null;
  }

  /**
   * 保存提醒
   */
  async function saveReminder(root) {
    const name = root.getElementById('medicationName').value.trim();
    const time = root.getElementById('reminderTime').value;
    const date = (root.getElementById('reminderDate') && root.getElementById('reminderDate').value) || '';
    const dosage = root.getElementById('dosage').value.trim();
    const notes = root.getElementById('notes').value.trim();
    const repeatInterval = (root.getElementById('repeatInterval') && root.getElementById('repeatInterval').value) || 'none';
    const repeatCustomValueRaw = (root.getElementById('repeatCustomValue') && root.getElementById('repeatCustomValue').value) || '';
    const repeatCustomValue = repeatCustomValueRaw ? Math.max(1, parseInt(repeatCustomValueRaw, 10)) : null;

    if (!name || !time || !date) {
      alert('请填写药品名称、提醒日期与时间');
      return;
    }

    const reminder = {
      id: editingReminderId || generateId(),
      name,
      time,
      date,
      dosage,
      notes,
      repeatInterval,
      repeatCustomValue,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (editingReminderId) {
      // 更新现有提醒
      const index = reminders.findIndex(r => r.id === editingReminderId);
      if (index !== -1) {
        reminders[index] = reminder;
      }
    } else {
      // 添加新提醒
      reminders.push(reminder);
    }

    saveReminders();
    renderReminders(root);
    await setupReminders(); // 重新设置定时器
    closeModal(root);
    hapticFeedback('Medium');
  }

  /**
   * 编辑提醒
   */
  function editReminder(reminderId) {
    if (!currentRoot) {
      console.error('❌ currentRoot未设置，无法编辑提醒');
      return;
    }
    editingReminderId = reminderId;
    openModal(currentRoot, reminderId);
  }

  /**
   * 删除提醒 - 显示确认弹窗
   */
  function deleteReminder(reminderId) {
    if (!currentRoot) {
      console.error('❌ currentRoot未设置，无法删除提醒');
      return;
    }
    pendingDeleteId = reminderId;
    showDeleteModal(currentRoot);
  }

  /**
   * 显示删除确认弹窗
   */
  function showDeleteModal(root) {
    const modal = root.getElementById('deleteConfirmModal');
    if (modal) {
      modal.classList.add('show');
    }
  }

  /**
   * 关闭删除确认弹窗
   */
  function closeDeleteModal(root) {
    const modal = root.getElementById('deleteConfirmModal');
    if (modal) {
      modal.classList.remove('show');
    }
    pendingDeleteId = null;
  }

  /**
   * 确认删除提醒
   */
  async function confirmDelete(root) {
    if (!pendingDeleteId) return;

    const reminderId = pendingDeleteId;

    try {
      // 清除相关的定时器
      if (reminderTimeouts.has(reminderId)) {
        clearTimeout(reminderTimeouts.get(reminderId));
        reminderTimeouts.delete(reminderId);
      }

      // 取消Capacitor通知（使用稳定ID）
      if (LocalNotifications) {
        const notificationId = stableIdFromString(reminderId);
        try { await LocalNotifications.cancel({ notifications: [{ id: notificationId }] }); } catch (_) {}
        console.log('🔔 已取消Capacitor通知:', reminderId);
      }

      // 从数组中移除提醒
      reminders = reminders.filter(r => r.id !== reminderId);
      saveReminders();

      // 重新渲染列表
      renderReminders(root);

      // 重新设置提醒（因为删除了一个）
      await setupReminders();

      hapticFeedback('Medium');
      console.log('✅ 提醒已删除:', reminderId);

    } catch (error) {
      console.error('❌ 删除提醒失败:', error);
      // 即使删除失败，也要从UI中移除
      reminders = reminders.filter(r => r.id !== reminderId);
      saveReminders();
      renderReminders(root);
      hapticFeedback('Medium');
    }

    // 关闭弹窗
    closeDeleteModal(root);
  }

  /**
   * 生成唯一ID
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  /**
   * 设置提醒定时器
   */
  async function setupReminders() {
    // 防止重复设置提醒
    if (isSettingUpReminders) {
      return;
    }

    isSettingUpReminders = true;

    try {
      // 清除所有现有定时器
      reminderTimeouts.forEach(timeout => clearTimeout(timeout));
      reminderTimeouts.clear();
      uiAdvanceTimeouts.forEach(timeout => clearTimeout(timeout));
      uiAdvanceTimeouts.clear();

      if (LocalNotifications) {
        // 使用Capacitor本地通知调度（逐条调度，不合并）
        const notifications = [];
        const cancelList = [];

        // 统一用户名（不阻塞整体，即使失败也有默认值）
        let username = '访客';
        try { username = await getUsernameAsync(); } catch(_) {}

        reminders.forEach(reminder => {
          if (!reminder.time) return;

          const [hours, minutes] = reminder.time.split(':');
          const baseDate = reminder.date || new Date().toISOString().slice(0,10);
          const reminderTime = new Date(`${baseDate}T${hours}:${minutes}:00`);

          // 计算首次触发时间（仅用于调度，不修改存储）
          const now = new Date();
          const firstTime = computeNextTime(reminder, reminderTime, now);

          // UI推进（到点后推进/删除）
          scheduleUiAdvance(reminder.id, firstTime);

          // 稳定ID，调度前取消旧的
          const notificationId = stableIdFromString(reminder.id);
          cancelList.push({ id: notificationId });

          const schedule = { at: firstTime };
          if (reminder.repeatInterval && reminder.repeatInterval !== 'none') {
            if (reminder.repeatInterval === 'hourly' && (!reminder.repeatCustomValue || reminder.repeatCustomValue === 1)) {
              schedule.every = 'hour';
              schedule.repeats = true;
            } else if (reminder.repeatInterval === 'daily' && (!reminder.repeatCustomValue || reminder.repeatCustomValue === 1)) {
              schedule.every = 'day';
              schedule.repeats = true;
            } else if (reminder.repeatInterval === 'weekly' && (!reminder.repeatCustomValue || reminder.repeatCustomValue === 1)) {
              schedule.every = 'week';
              schedule.repeats = true;
            }
          }

          notifications.push({
            id: notificationId,
            title: buildNotificationTitle(),
            body: buildNotificationBody(username, reminder),
            schedule,
            sound: 'default',
            actionTypeId: 'medication_reminder',
            extra: {
              reminderId: reminder.id,
              medicationName: reminder.name
            }
          });
        });

        // 取消旧的同ID调度
        if (cancelList.length > 0) {
          try { await LocalNotifications.cancel({ notifications: cancelList }); } catch (_) {}
        }

        if (notifications.length > 0) {
          try {
            await LocalNotifications.schedule({ notifications });
            console.log('⏰ 已调度', notifications.length, '个提醒通知');
          } catch (scheduleError) {
            console.error('❌ Capacitor通知调度失败:', scheduleError);
            throw scheduleError;
          }
        }
      } else {
        // 回退到setTimeout方式（不修改存储，仅调度）
        reminderTimeouts.forEach(timeout => clearTimeout(timeout));
        reminderTimeouts.clear();
        uiAdvanceTimeouts.forEach(timeout => clearTimeout(timeout));
        uiAdvanceTimeouts.clear();
        const now = new Date();
        reminders.forEach(reminder => {
          if (!reminder.time) return;

          const [hours, minutes] = reminder.time.split(':');
          const baseDate = reminder.date || new Date().toISOString().slice(0,10);
          const baseTime = new Date(`${baseDate}T${hours}:${minutes}:00`);

          const firstTime = computeNextTime(reminder, baseTime, now);

          const timeUntilReminder = firstTime - now;

          const timeout = setTimeout(() => {
            if (canSendNotification(reminder.id)) {
              showNotification(reminder);
            }
            // 若设置循环，则继续安排下一次
            if (reminder.repeatInterval && reminder.repeatInterval !== 'none') {
              scheduleNextFallback(reminder);
            }
          }, Math.max(0, timeUntilReminder));

          reminderTimeouts.set(reminder.id, timeout);
        });
      }
    } catch (error) {
      console.error('❌ 设置提醒失败:', error);
      // 如果Capacitor通知失败，回退到setTimeout方式
      setupFallbackReminders();
    } finally {
      // 重置设置标志位
      isSettingUpReminders = false;
    }
  }

  /**
   * 回退到setTimeout方式设置提醒（当Capacitor不可用时）
   */
  function setupFallbackReminders() {
    reminderTimeouts.forEach(timeout => clearTimeout(timeout));
    reminderTimeouts.clear();
    uiAdvanceTimeouts.forEach(timeout => clearTimeout(timeout));
    uiAdvanceTimeouts.clear();

    const now = new Date();
    reminders.forEach(reminder => {
      if (!reminder.time) return;
      if (reminder.repeatInterval === 'none') return; // 不循环则不进入fallback循环

      const [hours, minutes] = reminder.time.split(':');
      const reminderTime = new Date(`${(reminder.date || new Date().toISOString().slice(0,10))}T${hours}:${minutes}:00`);

      // 如果提醒时间已经过去，设置为下一次
      const firstTime = computeNextTime(reminder, reminderTime, now);
      const timeUntilReminder = firstTime - now;

      // 设置定时器
      const timeout = setTimeout(() => {
        if (canSendNotification(reminder.id)) {
          showNotification(reminder);
        }
        scheduleNextFallback(reminder);
      }, Math.max(0, timeUntilReminder));

      reminderTimeouts.set(reminder.id, timeout);
    });

    console.log('⏰ 回退模式：设置了', reminderTimeouts.size, '个提醒定时器');
  }

  function computeNextTime(reminder, baseTime, fromTime) {
    let next = new Date(baseTime.getTime());
    if (reminder.repeatInterval === 'hourly') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) next = new Date(next.getTime() + mult * 60 * 60 * 1000);
    } else if (reminder.repeatInterval === 'daily') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) next.setDate(next.getDate() + mult);
    } else if (reminder.repeatInterval === 'weekly') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) next.setDate(next.getDate() + 7 * mult);
    } else {
      if (next <= fromTime) next.setDate(next.getDate() + 1);
    }
    return next;
  }

  function scheduleNextFallback(reminder) {
    if (reminder.repeatInterval === 'none') return;
    let intervalMs = 24 * 60 * 60 * 1000; // 默认每天
    if (reminder.repeatInterval === 'hourly') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 60 * 60 * 1000;
    } else if (reminder.repeatInterval === 'daily') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 24 * 60 * 60 * 1000;
    } else if (reminder.repeatInterval === 'weekly') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 7 * 24 * 60 * 60 * 1000;
    }

    const timeout = setTimeout(() => {
      if (canSendNotification(reminder.id)) {
        showNotification(reminder);
      }
      scheduleNextFallback(reminder);
    }, intervalMs);

    reminderTimeouts.set(reminder.id, timeout);
  }

  /**
   * 为明天设置提醒
   */
  function setupReminderForTomorrow(reminder) {
    // 兼容旧逻辑：保留按天循环，但若配置了其它周期，则走新函数
    if (reminder.repeatInterval && reminder.repeatInterval !== 'daily' && reminder.repeatInterval !== 'none') {
      scheduleNextFallback(reminder);
      return;
    }

    const timeout = setTimeout(() => {
      // 检查是否可以发送通知（防重复）
      if (canSendNotification(reminder.id)) {
        showNotification(reminder);
      }
      setupReminderForTomorrow(reminder); // 递归设置下一天
    }, 24 * 60 * 60 * 1000); // 24小时

    reminderTimeouts.set(reminder.id, timeout);
  }

  /**
   * 检查是否可以发送通知（防重复）
   */
  function canSendNotification(reminderId) {
    const now = Date.now();
    const lastTime = lastNotificationTime.get(reminderId);
    const cooldownPeriod = 5 * 60 * 1000; // 5分钟冷却期
    
    if (lastTime && (now - lastTime) < cooldownPeriod) {
      console.log('⏰ 通知冷却中，跳过发送:', reminderId);
      return false;
    }
    
    return true;
  }

  /**
   * 显示提醒通知
   */
  async function showNotification(reminder) {
    // 防重复发送检查
    if (!canSendNotification(reminder.id)) {
      return;
    }

    try {
      // 获取用户名
      const username = await getUsernameAsync();

      const notificationTitle = buildNotificationTitle();
      const notificationBody = buildNotificationBody(username, reminder);

      // 优先使用Capacitor本地通知
      if (LocalNotifications) {
        const notificationId = stableIdFromString(reminder.id);
        const notificationData = {
          id: notificationId,
          title: notificationTitle,
          body: notificationBody,
          schedule: { at: new Date() },
          sound: 'default',
          actionTypeId: 'medication_reminder',
          extra: {
            reminderId: reminder.id,
            medicationName: reminder.name
          }
        };

        try {
          await LocalNotifications.schedule({
            notifications: [notificationData]
          });
          console.log('🔔 通知已发送:', reminder.name);
        } catch (error) {
          console.error('❌ Capacitor通知发送失败:', error);
          throw error;
        }
      } else {
        // 回退到浏览器原生通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(notificationTitle, {
            body: notificationBody,
            icon: '/favicon.ico',
            tag: `medication-${reminder.id}`
          });
          console.log('🔔 浏览器通知已发送:', reminder.name);
        }
      }

      // 记录发送时间
      lastNotificationTime.set(reminder.id, Date.now());
      sentNotifications.add(reminder.id);

      // 震动反馈
      hapticFeedback('Heavy');

      // 非循环：发送完成后直接删除该提醒
      if (!reminder.repeatInterval || reminder.repeatInterval === 'none') {
        await hardDeleteReminder(reminder.id);
        return;
      }

      // 循环：推进到下一次触发时间
      advanceReminderNextRun(reminder);

    } catch (error) {
      console.error('❌ 发送通知失败:', error);
    }
  }

  function advanceReminderNextRun(reminder) {
    try {
      const idx = reminders.findIndex(r => r.id === reminder.id);
      if (idx === -1) return;

      const baseDateStr = reminder.date || new Date().toISOString().slice(0,10);
      const base = new Date(`${baseDateStr}T${(reminder.time || '00:00')}:00`);
      let next = new Date(base.getTime());

      if (reminder.repeatInterval === 'hourly') {
        const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
        next = new Date(base.getTime() + mult * 60 * 60 * 1000);
      } else if (reminder.repeatInterval === 'daily') {
        const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
        next.setDate(next.getDate() + mult);
      } else if (reminder.repeatInterval === 'weekly') {
        const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
        next.setDate(next.getDate() + 7 * mult);
      } else {
        const now = new Date();
        if (next <= now) next.setDate(next.getDate() + 1);
      }

      const nextDate = next.toISOString().slice(0,10);
      const nextTime = next.toTimeString().slice(0,5);
      reminders[idx] = { ...reminders[idx], date: nextDate, time: nextTime, updatedAt: new Date().toISOString() };

      saveReminders();
      if (currentRoot) {
        renderReminders(currentRoot);
        updateEditingModalIfOpen(currentRoot, reminders[idx]);
      }

      // 重新设置UI推进定时器
      scheduleUiAdvance(reminders[idx].id, next);

      // 原生环境下（无内建 repeats 的自定义间隔），我们手动调度下一次
      if (LocalNotifications) {
        const needsCustomNative = (reminder.repeatInterval === 'hourly' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1)
          || (reminder.repeatInterval === 'daily' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1)
          || (reminder.repeatInterval === 'weekly' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1);
        if (needsCustomNative) {
          scheduleNextNative(reminders[idx]);
        }
      } else {
        // 回退模式继续安排
        scheduleNextFallback(reminders[idx]);
      }
    } catch (e) {
      console.error('推进下次提醒失败:', e);
    }
  }

  function scheduleNextNative(reminder) {
    try {
      if (!LocalNotifications) return;
      if (!reminder.date || !reminder.time) return;
      const [hh, mm] = reminder.time.split(':');
      const at = new Date(`${reminder.date}T${hh}:${mm}:00`);
      const notificationId = stableIdFromString(reminder.id);
      // 先取消同ID，再安排下一次
      LocalNotifications.cancel({ notifications: [{ id: notificationId }] }).catch(() => {});
      LocalNotifications.schedule({ notifications: [{
        id: notificationId,
        title: buildNotificationTitle(),
        body: buildNotificationBody('您', reminder),
        schedule: { at },
        sound: 'default',
        actionTypeId: 'medication_reminder',
        extra: { reminderId: reminder.id, medicationName: reminder.name }
      }]});
    } catch (_) {}
  }

  function updateEditingModalIfOpen(root, updatedReminder) {
    try {
      const modal = root.getElementById('reminderModal');
      if (!modal || !modal.classList.contains('show')) return;
      if (!editingReminderId || editingReminderId !== updatedReminder.id) return;
      const dateEl = root.getElementById('reminderDate');
      const timeEl = root.getElementById('reminderTime');
      if (dateEl) dateEl.value = updatedReminder.date || '';
      if (timeEl) timeEl.value = updatedReminder.time || '';
    } catch (_) {}
  }

  function advanceReminderNextRunById(reminderId) {
    const reminder = reminders.find(r => r.id === reminderId);
    if (reminder) advanceReminderNextRun(reminder);
  }

  /**
   * 请求通知权限
   */
  async function requestNotificationPermission() {
    try {
      // 优先使用Capacitor的通知权限
      if (LocalNotifications) {
        const result = await LocalNotifications.requestPermissions();
        if (result.display === 'granted') {
          console.log('✅ Capacitor通知权限已授予');
          return true;
        } else {
          console.warn('❌ Capacitor通知权限被拒绝');
          return false;
        }
      } else {
        // 回退到浏览器原生通知
        if ('Notification' in window) {
          if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            return permission === 'granted';
          } else if (Notification.permission === 'granted') {
            return true;
          } else {
            return false;
          }
        } else {
          console.warn('⚠️ 浏览器不支持通知API');
          return false;
        }
      }
    } catch (error) {
      console.error('❌ 请求通知权限失败:', error);
      return false;
    }
  }

  /**
   * Cleanup function: run all stored teardown callbacks.
   * Called before leaving the page to prevent leaks.
   */
  function destroyCase() {
    // 清除所有定时器
    reminderTimeouts.forEach(timeout => clearTimeout(timeout));
    reminderTimeouts.clear();
    uiAdvanceTimeouts.forEach(timeout => clearTimeout(timeout));
    uiAdvanceTimeouts.clear();

    // 清除当前的root引用
    currentRoot = null;

    // 统一执行清理函数
    cleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    cleanupFns = [];

    // 清理新增卡片事件监听器
    if (currentRoot) {
      const addCard = currentRoot.querySelector('#addReminderCard');
      if (addCard) {
        const addHandler = () => {
          hapticFeedback('Light');
          openModal(currentRoot);
        };
        addCard.removeEventListener('click', addHandler);
      }
    }

    console.log('🧹 destroyCase 清理完成');
  }

  function catchUpOverdueReminders() {
    const now = new Date();
    let changed = false;
    reminders = reminders.map(reminder => {
      if (!reminder.time) return reminder;
      const [hours, minutes] = reminder.time.split(':');
      const baseDate = reminder.date || new Date().toISOString().slice(0,10);
      const base = new Date(`${baseDate}T${hours}:${minutes}:00`);
      const next = computeNextTime(reminder, base, now);
      if (next.getTime() !== base.getTime()) {
        changed = true;
        return { ...reminder, date: next.toISOString().slice(0,10), time: next.toTimeString().slice(0,5), updatedAt: new Date().toISOString() };
      }
      return reminder;
    });
    if (changed) {
      saveReminders();
    }
  }

  function scheduleUiAdvance(reminderId, atDate) {
    try {
      if (uiAdvanceTimeouts.has(reminderId)) {
        clearTimeout(uiAdvanceTimeouts.get(reminderId));
        uiAdvanceTimeouts.delete(reminderId);
      }
      const now = Date.now();
      const delay = Math.max(0, atDate.getTime() - now + 500); // 微小偏移，确保在系统展示后推进
      const timeout = setTimeout(() => {
        const r = reminders.find(x => x.id === reminderId);
        if (!r) return;
        if (!r.repeatInterval || r.repeatInterval === 'none') {
          // 非循环：到点后直接删除
          hardDeleteReminder(reminderId);
        } else {
          advanceReminderNextRunById(reminderId);
        }
      }, delay);
      uiAdvanceTimeouts.set(reminderId, timeout);
    } catch (_) {}
  }

  function formatRepeatText(reminder) {
    if (!reminder || !reminder.repeatInterval || reminder.repeatInterval === 'none') return '';
    const n = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
    if (reminder.repeatInterval === 'hourly') {
      return `循环：每${n === 1 ? '' : n}小时`.replace('每小时', '每小时');
    }
    if (reminder.repeatInterval === 'daily') {
      return `循环：每${n === 1 ? '' : n}天`.replace('每天', '每天');
    }
    if (reminder.repeatInterval === 'weekly') {
      return `循环：每${n === 1 ? '' : n}周`;
    }
    return '';
  }

  // 页面加载时初始化（独立运行模式）
  document.addEventListener("DOMContentLoaded", async function () {
    // 检查是否已经在Shadow DOM中运行，避免重复初始化
    if (window.location.pathname.includes('notification.html')) {
      // 请求通知权限
      await requestNotificationPermission();

      // 设置通知监听器
      setupNotificationListeners();

      // 初始化页面
      initCase(document);
    }

    // 添加测试功能（仅在开发环境下）
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      window.testNotification = async () => {
        const testReminder = {
          id: 'test-reminder',
          name: '测试药品',
          dosage: '100mg',
          time: '12:00'
        };
        await showNotification(testReminder);
      };
    }
  });

  /**
   * 设置通知监听器
   */
  function setupNotificationListeners() {
    if (!LocalNotifications) {
      return;
    }

    try {
      // 监听通知接收事件（前台触达）
      LocalNotifications.addListener('localNotificationReceived', (notification) => {
        hapticFeedback('Heavy');
        const id = notification && notification.id;
        if (id && handledNotificationIds.has(id)) return;
        if (id) handledNotificationIds.add(id);
        const rid = notification && notification.extra && notification.extra.reminderId;
        if (!rid) return;
        const r = reminders.find(x => x.id === rid);
        if (!r) return;
        if (!r.repeatInterval || r.repeatInterval === 'none') {
          // 非循环：到点后直接删除
          hardDeleteReminder(rid);
        } else {
          advanceReminderNextRunById(rid);
        }
      });

      // 监听通知点击事件（用户点开）
      LocalNotifications.addListener('localNotificationActionPerformed', (notificationAction) => {
        const { notification } = notificationAction;
        const id = notification && notification.id;
        if (id && handledNotificationIds.has(id)) return;
        if (id) handledNotificationIds.add(id);
        if (!(notification.extra && notification.extra.reminderId)) return;
        const reminderId = notification.extra.reminderId;
        const r = reminders.find(x => x.id === reminderId);
        if (!r) return;
        if (!r.repeatInterval || r.repeatInterval === 'none') {
          hardDeleteReminder(reminderId);
        } else {
          advanceReminderNextRunById(reminderId);
          highlightReminder(reminderId);
        }
      });
    } catch (error) {
      console.error('❌ 设置通知监听器失败:', error);
    }
  }

  /**
   * 高亮显示特定提醒（当用户点击通知时）
   */
  function highlightReminder(reminderId) {
    const reminderCard = document.querySelector(`[data-id="${reminderId}"]`);
    if (reminderCard) {
      reminderCard.style.animation = 'highlight 2s ease-out';
      reminderCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        reminderCard.style.animation = '';
      }, 2000);
    }
  }

  // Expose lifecycle functions to global scope for loader
  window.initNotification = initCase;
  window.destroyNotification = destroyCase;

  // 暴露全局函数供HTML调用
  window.editReminder = editReminder;
  window.deleteReminder = deleteReminder;
})();
