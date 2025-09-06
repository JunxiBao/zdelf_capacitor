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

  // Capacitor LocalNotifications 插件
  let LocalNotifications = null;
  let Capacitor = null;

  // 尝试导入Capacitor插件
  try {
    Capacitor = window.Capacitor;
    if (Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
      LocalNotifications = Capacitor.Plugins.LocalNotifications;
      console.log('✅ Capacitor LocalNotifications 插件已加载');
      console.log('🔍 Capacitor平台信息:', Capacitor.getPlatform());
      console.log('🔍 Capacitor是否为原生平台:', Capacitor.isNativePlatform());
    } else {
      console.warn('⚠️ Capacitor LocalNotifications 插件未找到，将使用浏览器原生通知');
      console.log('🔍 Capacitor对象:', Capacitor);
      console.log('🔍 Capacitor.Plugins:', Capacitor?.Plugins);
    }
  } catch (error) {
    console.warn('⚠️ 无法加载Capacitor插件，将使用浏览器原生通知:', error);
    console.log('🔍 错误详情:', error.message);
  }

  // Array of teardown callbacks to run when leaving the page
  let cleanupFns = [];

  // 提醒数据
  let reminders = [];
  let editingReminderId = null;
  let pendingDeleteId = null; // 待删除的提醒ID
  let reminderTimeouts = new Map(); // 存储定时器引用
  let currentRoot = null; // 当前的Shadow Root引用

  // 存储键名
  const STORAGE_KEY = 'medication_reminders';

  // 震动反馈函数
  function hapticFeedback(style = 'Light') {
    try { window.__hapticImpact__ && window.__hapticImpact__(style); } catch(_) {}
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
        <div class="empty-state">
          <div class="icon">💊</div>
          <h3>还没有用药提醒</h3>
          <p>点击右下角的 + 按钮添加您的第一个用药提醒</p>
        </div>
      `;
      return;
    }

    // 按时间排序
    const sortedReminders = [...reminders].sort((a, b) => {
      const timeA = a.time || '00:00';
      const timeB = b.time || '00:00';
      return timeA.localeCompare(timeB);
    });

    container.innerHTML = sortedReminders.map(reminder => `
      <div class="reminder-card" data-id="${reminder.id}">
        <div class="reminder-header">
          <h3 class="medication-name">${reminder.name}</h3>
          <span class="reminder-time">${formatTime(reminder.time)}</span>
        </div>
        ${reminder.dosage ? `<div class="reminder-details">剂量：${reminder.dosage}</div>` : ''}
        ${reminder.frequency ? `<div class="reminder-details">频率：${reminder.frequency}</div>` : ''}
        ${reminder.notes ? `<div class="reminder-details">备注：${reminder.notes}</div>` : ''}
        <div class="reminder-actions">
          <button class="btn btn-secondary" data-action="edit" data-id="${reminder.id}">编辑</button>
          <button class="btn btn-danger" data-action="delete" data-id="${reminder.id}">删除</button>
        </div>
      </div>
    `).join('');

    // 绑定卡片内的事件 - 使用事件委托
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

    // 移除之前的事件监听器（如果存在）
    const oldHandler = container._buttonClickHandler;
    if (oldHandler) {
      container.removeEventListener('click', oldHandler);
    }

    // 添加新的事件监听器
    container.addEventListener('click', handleButtonClick);
    container._buttonClickHandler = handleButtonClick;
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
        root.getElementById('dosage').value = reminder.dosage || '';
        root.getElementById('frequency').value = reminder.frequency || '';
        root.getElementById('notes').value = reminder.notes || '';
      }
    } else {
      // 添加模式
      title.textContent = '添加用药提醒';
      form.reset();
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
    const dosage = root.getElementById('dosage').value.trim();
    const frequency = root.getElementById('frequency').value.trim();
    const notes = root.getElementById('notes').value.trim();

    if (!name || !time) {
      alert('请填写药品名称和提醒时间');
      return;
    }

    const reminder = {
      id: editingReminderId || generateId(),
      name,
      time,
      dosage,
      frequency,
      notes,
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

      // 取消Capacitor通知
      if (LocalNotifications) {
        const notificationId = parseInt(reminderId.replace(/\D/g, ''), 10);
        if (notificationId) {
          await LocalNotifications.cancel({
            notifications: [{ id: notificationId }]
          });
          console.log('🔔 已取消Capacitor通知:', reminderId);
        }
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
    try {
      // 清除所有现有定时器
      reminderTimeouts.forEach(timeout => clearTimeout(timeout));
      reminderTimeouts.clear();

      const now = new Date();

      if (LocalNotifications) {
        // 使用Capacitor本地通知调度
        const notifications = [];

        reminders.forEach(reminder => {
          if (!reminder.time) return;

          const [hours, minutes] = reminder.time.split(':');
          const reminderTime = new Date();
          reminderTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

          // 如果提醒时间已经过去，设置为明天
          if (reminderTime <= now) {
            reminderTime.setDate(reminderTime.getDate() + 1);
          }

          const notificationId = Math.floor(Math.random() * 900000) + 100000; // 6位随机数，避免冲突

          // 暂时使用非重复通知来测试基本功能
          notifications.push({
            id: notificationId,
            title: `用药提醒: ${reminder.name}`,
            body: `该服用 ${reminder.dosage || '药品'} 了`,
            schedule: {
              at: reminderTime
              // 先去掉 repeats 和 every，测试基本功能
            },
            sound: 'default',
            actionTypeId: 'medication_reminder',
            extra: {
              reminderId: reminder.id,
              medicationName: reminder.name
            }
          });

          console.log(`📅 为 ${reminder.name} 调度通知:`, reminderTime.toLocaleString());
        });

        if (notifications.length > 0) {
          console.log('📱 准备调度的通知列表:', notifications);
          try {
            const scheduleResult = await LocalNotifications.schedule({ notifications });
            console.log('⏰ Capacitor已调度', notifications.length, '个提醒通知');
            console.log('📱 调度结果:', scheduleResult);
          } catch (scheduleError) {
            console.error('❌ Capacitor通知调度失败:', scheduleError);
            console.error('❌ 调度失败详情:', scheduleError.message);
            throw scheduleError;
          }
        }
      } else {
        // 回退到setTimeout方式
        reminders.forEach(reminder => {
          if (!reminder.time) return;

          const [hours, minutes] = reminder.time.split(':');
          const reminderTime = new Date();
          reminderTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

          // 如果提醒时间已经过去，设置为明天
          if (reminderTime <= now) {
            reminderTime.setDate(reminderTime.getDate() + 1);
          }

          const timeUntilReminder = reminderTime - now;

          // 设置定时器
          const timeout = setTimeout(() => {
            showNotification(reminder);
            // 设置下一天的提醒
            setupReminderForTomorrow(reminder);
          }, timeUntilReminder);

          reminderTimeouts.set(reminder.id, timeout);
        });

        console.log('⏰ 设置了', reminderTimeouts.size, '个提醒定时器');
      }
    } catch (error) {
      console.error('❌ 设置提醒失败:', error);
      // 如果Capacitor通知失败，回退到setTimeout方式
      setupFallbackReminders();
    }
  }

  /**
   * 回退到setTimeout方式设置提醒（当Capacitor不可用时）
   */
  function setupFallbackReminders() {
    reminderTimeouts.forEach(timeout => clearTimeout(timeout));
    reminderTimeouts.clear();

    const now = new Date();
    reminders.forEach(reminder => {
      if (!reminder.time) return;

      const [hours, minutes] = reminder.time.split(':');
      const reminderTime = new Date();
      reminderTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

      // 如果提醒时间已经过去，设置为明天
      if (reminderTime <= now) {
        reminderTime.setDate(reminderTime.getDate() + 1);
      }

      const timeUntilReminder = reminderTime - now;

      // 设置定时器
      const timeout = setTimeout(() => {
        showNotification(reminder);
        // 设置下一天的提醒
        setupReminderForTomorrow(reminder);
      }, timeUntilReminder);

      reminderTimeouts.set(reminder.id, timeout);
    });

    console.log('⏰ 回退模式：设置了', reminderTimeouts.size, '个提醒定时器');
  }

  /**
   * 为明天设置提醒
   */
  function setupReminderForTomorrow(reminder) {
    const timeout = setTimeout(() => {
      showNotification(reminder);
      setupReminderForTomorrow(reminder); // 递归设置下一天
    }, 24 * 60 * 60 * 1000); // 24小时

    reminderTimeouts.set(reminder.id, timeout);
  }

  /**
   * 显示提醒通知
   */
  async function showNotification(reminder) {
    try {
      // 优先使用Capacitor本地通知
      if (LocalNotifications) {
        console.log('📱 发送即时通知...');
        const notificationId = Math.floor(Math.random() * 900000) + 100000; // 6位随机数
        const notificationData = {
          id: notificationId,
          title: `用药提醒: ${reminder.name}`,
          body: `该服用 ${reminder.dosage || '药品'} 了`,
          schedule: { at: new Date() },
          sound: 'default',
          actionTypeId: 'medication_reminder',
          extra: {
            reminderId: reminder.id,
            medicationName: reminder.name
          }
        };

        console.log('🆔 即时通知ID:', notificationId);

        console.log('📱 通知数据:', notificationData);

        try {
          const result = await LocalNotifications.schedule({
            notifications: [notificationData]
          });
          console.log('🔔 Capacitor通知已发送:', reminder.name);
          console.log('📱 发送结果:', result);
        } catch (error) {
          console.error('❌ Capacitor通知发送失败:', error);
          console.error('❌ 发送失败详情:', error.message);
          throw error;
        }
      } else {
        // 回退到浏览器原生通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`用药提醒: ${reminder.name}`, {
            body: `该服用 ${reminder.dosage || '药品'} 了`,
            icon: '/favicon.ico',
            tag: `medication-${reminder.id}`
          });
          console.log('🔔 浏览器通知已发送:', reminder.name);
        }
      }
    } catch (error) {
      console.error('❌ 发送通知失败:', error);
      // 如果Capacitor通知失败，尝试使用浏览器通知作为备用
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(`用药提醒: ${reminder.name}`, {
            body: `该服用 ${reminder.dosage || '药品'} 了`,
            icon: '/favicon.ico',
            tag: `medication-${reminder.id}`
          });
          console.log('🔔 备用浏览器通知已发送:', reminder.name);
        } catch (fallbackError) {
          console.error('❌ 备用通知也失败:', fallbackError);
        }
      }
    }

    // 震动反馈
    hapticFeedback('Heavy');

    console.log('🔔 提醒:', reminder.name, 'at', reminder.time);
  }

  /**
   * 请求通知权限
   */
  async function requestNotificationPermission() {
    try {
      console.log('🔍 开始请求通知权限...');
      console.log('🔍 LocalNotifications对象:', LocalNotifications);
      console.log('🔍 Capacitor平台:', Capacitor?.getPlatform());

      // 优先使用Capacitor的通知权限
      if (LocalNotifications) {
        console.log('📱 使用Capacitor请求通知权限...');
        const result = await LocalNotifications.requestPermissions();
        console.log('📱 Capacitor权限请求结果:', result);

        if (result.display === 'granted') {
          console.log('✅ Capacitor通知权限已授予');
          return true;
        } else {
          console.warn('❌ Capacitor通知权限被拒绝:', result);
          return false;
        }
      } else {
        console.warn('⚠️ Capacitor LocalNotifications 不可用');
        // 回退到浏览器原生通知
        if ('Notification' in window) {
          console.log('🌐 当前通知权限状态:', Notification.permission);

          if (Notification.permission === 'default') {
            console.log('🌐 请求浏览器通知权限...');
            const permission = await Notification.requestPermission();
            console.log('🌐 浏览器权限请求结果:', permission);

            if (permission === 'granted') {
              console.log('✅ 浏览器通知权限已授予');
              return true;
            } else {
              console.warn('❌ 浏览器通知权限被拒绝');
              return false;
            }
          } else if (Notification.permission === 'granted') {
            console.log('✅ 浏览器通知权限已存在');
            return true;
          } else {
            console.warn('❌ 浏览器通知权限被拒绝');
            return false;
          }
        } else {
          console.warn('⚠️ 浏览器不支持通知API');
          return false;
        }
      }
    } catch (error) {
      console.error('❌ 请求通知权限失败:', error);
      console.error('❌ 错误详情:', error.message);
      console.error('❌ 错误堆栈:', error.stack);
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

    // 清除当前的root引用
    currentRoot = null;

    // 统一执行清理函数
    cleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    cleanupFns = [];

    console.log('🧹 destroyCase 清理完成');
  }

  // 页面加载时初始化（独立运行模式）
  document.addEventListener("DOMContentLoaded", async function () {
    console.log("💊 用药提醒页面初始化");

    // 请求通知权限
    await requestNotificationPermission();

    // 设置通知监听器
    setupNotificationListeners();

    // 初始化页面
    initCase(document);

    // 添加测试功能（仅在开发环境下）
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.log('🧪 添加测试功能...');
      window.testNotification = async () => {
        console.log('🔔 测试通知发送...');
        const testReminder = {
          id: 'test-reminder',
          name: '测试药品',
          dosage: '100mg',
          time: '12:00'
        };
        await showNotification(testReminder);
      };
      console.log('✅ 测试功能已添加，运行 testNotification() 来测试通知');
    }
  });

  /**
   * 设置通知监听器
   */
  function setupNotificationListeners() {
    if (!LocalNotifications) {
      console.log('⚠️ Capacitor LocalNotifications 不可用，跳过监听器设置');
      return;
    }

    try {
      // 监听通知接收事件
      LocalNotifications.addListener('localNotificationReceived', (notification) => {
        console.log('📱 收到本地通知:', notification);
        hapticFeedback('Heavy');
      });

      // 监听通知点击事件
      LocalNotifications.addListener('localNotificationActionPerformed', (notificationAction) => {
        console.log('📱 用户点击了通知:', notificationAction);

        const { notification } = notificationAction;
        if (notification.extra && notification.extra.reminderId) {
          const reminderId = notification.extra.reminderId;
          console.log('🔔 用户点击了提醒通知:', reminderId);

          // 可以在这里添加跳转到特定提醒的逻辑
          // 例如：高亮显示对应的提醒卡片
          highlightReminder(reminderId);
        }
      });

      console.log('✅ 通知监听器已设置');
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
      // 添加高亮动画
      reminderCard.style.animation = 'highlight 2s ease-out';
      reminderCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // 移除动画
      setTimeout(() => {
        reminderCard.style.animation = '';
      }, 2000);
    }
  }

  // Expose lifecycle functions to global scope for loader
  console.debug("[reminder] exposing lifecycle: initNotification/destroyNotification");
  window.initNotification = initCase;
  window.destroyNotification = destroyCase;

  // 暴露全局函数供HTML调用
  window.editReminder = editReminder;
  window.deleteReminder = deleteReminder;
})();
