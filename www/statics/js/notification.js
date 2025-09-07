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
  let isActiveReminderView = false; // 是否在提醒页面处于激活状态（由 init/destroy 控制）
  let allowedFireAt = new Map(); // 允许触发的时间窗口：reminderId -> epoch ms（今天最近一次）

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
      // 定位当前提醒
      const target = reminders.find(r => r.id === reminderId);
      // 清理fallback定时器
      if (reminderTimeouts.has(reminderId)) { clearTimeout(reminderTimeouts.get(reminderId)); reminderTimeouts.delete(reminderId); }
      // 清理所有该提醒相关的“按时间点”定时器
      [...reminderTimeouts.keys()].forEach(key => {
        if (typeof key === 'string' && key.startsWith(reminderId + '|')) {
          clearTimeout(reminderTimeouts.get(key));
          reminderTimeouts.delete(key);
        }
      });
      // 清理UI推进定时器
      if (uiAdvanceTimeouts.has(reminderId)) {
        clearTimeout(uiAdvanceTimeouts.get(reminderId));
        uiAdvanceTimeouts.delete(reminderId);
      }
      // 清理允许窗口
      if (allowedFireAt.has(reminderId)) allowedFireAt.delete(reminderId);
      // 取消原生通知
      if (LocalNotifications) {
        const cancelIds = [];
        // 取消旧的通用ID
        cancelIds.push({ id: stableIdFromString(reminderId) });
        // 取消每个时间点的ID
        if (target && Array.isArray(target.dailyTimes)) {
          target.dailyTimes.filter(Boolean).forEach(t => {
            cancelIds.push({ id: stableIdFromString(reminderId + '|' + t) });
          });
        }
        try { await LocalNotifications.cancel({ notifications: cancelIds }); } catch (_) {}
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

  // 判断某个具体时间点是否启用（向后兼容：未设置映射时默认启用）
  function isTimeEnabled(reminder, timeHHMM) {
    if (!reminder) return false;
    const map = reminder.dailyTimeEnabled;
    if (!map || typeof map !== 'object') return true;
    if (Object.prototype.hasOwnProperty.call(map, timeHHMM)) {
      return !!map[timeHHMM];
    }
    return true;
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
    console.log('🚀 initCase 开始执行', new Date().toISOString());
    const root = rootEl || document;
    currentRoot = root; // 存储当前的root引用
    isActiveReminderView = true;

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

    // 设置日期输入框的最小值为今天，防止选择过去的日期（使用本地时间）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    
    const startDateInput = root.getElementById('startDate');
    const endDateInput = root.getElementById('endDate');
    
    if (startDateInput) {
      startDateInput.min = today;
      startDateInput.value = today; // 设置默认值为今天
      console.log('📅 设置开始日期默认值和最小值为今天:', today);
    }
    if (endDateInput) {
      endDateInput.min = today;
      endDateInput.value = today; // 设置默认值为今天
      console.log('📅 设置结束日期默认值和最小值为今天:', today);
    }

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
            repeatLabel.textContent = `自定义间隔（${v === 'daily' ? '天' : v === 'weekly' ? '周' : v === 'monthly' ? '月' : v === 'yearly' ? '年' : ''}）`;
          }
        };
        repeatSelect.addEventListener('change', changeHandler);
        cleanupFns.push(() => repeatSelect.removeEventListener('change', changeHandler));
      }

      // 每日次数与时间列表事件
      const dailyCountEl = root.getElementById('dailyCount');
      const dailyGroup = root.getElementById('dailyTimesGroup');
      const dailyList = root.getElementById('dailyTimesList');
      const addDailyBtn = root.getElementById('addDailyTimeBtn');
      if (dailyCountEl && dailyGroup && dailyList && addDailyBtn) {
        // 工具：读取当前所有时间值（包含空值）
        const readTimes = () => [...dailyList.querySelectorAll('input[type="time"]')].map(i => i.value);
        // 工具：按目标数量n重建两列布局，尽量保留已填值（包含空位）
        const rebuildToCount = (n) => {
          const current = [...dailyList.querySelectorAll('input[type="time"]')].map(i => i.value);
          while (current.length < n) current.push('');
          while (current.length > n) current.pop();
          renderDailyTimesEditor(root, current);
        };

        const onCountChange = () => {
          let n = parseInt(dailyCountEl.value || '0', 10) || 0;
          // 限制最大值为20
          if (n > 20) {
            n = 20;
            dailyCountEl.value = '20';
            hapticFeedback('Medium'); // 超出限制时的反馈
          }
          dailyGroup.style.display = n > 0 ? '' : 'none';
          rebuildToCount(n);
        };
        const onAddRow = () => {
          const currentCount = parseInt(dailyCountEl.value || '0', 10) || 0;
          if (currentCount >= 20) {
            hapticFeedback('Heavy'); // 达到最大值时的强反馈
            return; // 不允许继续添加
          }
          hapticFeedback('Light');
          const current = readTimes();
          current.push('');
          dailyCountEl.value = String(currentCount + 1);
          renderDailyTimesEditor(root, current);
        };
        const onListClick = (e) => {
          const btn = e.target.closest('[data-remove-input]');
          if (!btn) return;
          hapticFeedback('Medium');
          const input = btn.parentElement && btn.parentElement.querySelector('input[type="time"]');
          const all = [...dailyList.querySelectorAll('input[type="time"]')];
          const values = all.map(i => i.value);
          const idx = all.indexOf(input);
          if (idx >= 0) {
            values.splice(idx, 1);
            const n = Math.max(0, (parseInt(dailyCountEl.value || '0', 10) || 0) - 1);
            if (n === 0) {
              dailyCountEl.value = '';
            } else {
              dailyCountEl.value = String(n);
            }
            renderDailyTimesEditor(root, values);
            dailyGroup.style.display = n > 0 ? '' : 'none';
          }
        };
        dailyCountEl.addEventListener('input', onCountChange);
        dailyCountEl.addEventListener('change', onCountChange);
        addDailyBtn.addEventListener('click', onAddRow);
        dailyList.addEventListener('click', onListClick);
        cleanupFns.push(() => {
          dailyCountEl.removeEventListener('input', onCountChange);
          dailyCountEl.removeEventListener('change', onCountChange);
          addDailyBtn.removeEventListener('click', onAddRow);
          dailyList.removeEventListener('click', onListClick);
        });
      }

      // 开始/结束日期联动校验与限制
      const sEl = root.getElementById('startDate');
      const eEl = root.getElementById('endDate');
      if (sEl && eEl) {
        const onStartChange = () => {
          if (sEl.value) eEl.min = sEl.value;
          if (eEl.value && sEl.value && eEl.value < sEl.value) eEl.value = sEl.value;
        };
        sEl.addEventListener('change', onStartChange);
        cleanupFns.push(() => sEl.removeEventListener('change', onStartChange));
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

    // 按日期+时间排序（若有dailyTimes按第一项参与排序）
    const sortedReminders = [...reminders].sort((a, b) => {
      const dateA = a.startDate || '1970-01-01';
      const dateB = b.startDate || '1970-01-01';
      const timeA = (Array.isArray(a.dailyTimes) && a.dailyTimes[0]) || '00:00';
      const timeB = (Array.isArray(b.dailyTimes) && b.dailyTimes[0]) || '00:00';
      const isoA = `${dateA}T${timeA}:00`;
      const isoB = `${dateB}T${timeB}:00`;
      return new Date(isoA) - new Date(isoB);
    });

    container.innerHTML = sortedReminders.map(reminder => {
      const intervalText = formatRepeatText(reminder);
      const hasTimes = reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0;
      const timesHtml = hasTimes
        ? `<div class=\"reminder-details\"><div style=\"margin-bottom:6px;\">每日${reminder.dailyCount}次</div><div class=\"reminder-times\" style=\"display:flex;flex-wrap:wrap;gap:8px;\">${reminder.dailyTimes.map(t => t ? `<label class=\"time-item\" style=\"display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #ddd;border-radius:6px;\"><input type=\"checkbox\" class=\"time-toggle\" data-id=\"${reminder.id}\" data-time=\"${t}\" ${isTimeEnabled(reminder, t) ? 'checked' : ''}/> <span>${t}</span></label>` : '').join('')}</div></div>`
        : '';
      const rangeText = `${reminder.startDate || ''}${reminder.endDate ? ' ~ ' + reminder.endDate : ''}`;
      return `
      <div class=\"reminder-card\" data-id=\"${reminder.id}\">\n        <div class=\"reminder-header\">\n          <h3 class=\"medication-name\">${reminder.name}</h3>\n          <span class=\"reminder-time\">${rangeText}</span>\n        </div>\n        ${reminder.dosage ? `<div class=\\\"reminder-details\\\">剂量：${reminder.dosage}</div>` : ''}\n        ${intervalText ? `<div class=\\\"reminder-details\\\">${intervalText}</div>` : ''}\n        ${timesHtml}\n        ${reminder.notes ? `<div class=\\\"reminder-details\\\">备注：${reminder.notes}</div>` : ''}\n        <div class=\"reminder-actions\">\n          <button class=\"btn btn-secondary\" data-action=\"edit\" data-id=\"${reminder.id}\">编辑</button>\n          <button class=\"btn btn-danger\" data-action=\"delete\" data-id=\"${reminder.id}\">删除</button>\n        </div>\n      </div>`;
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

    // 勾选/取消某个时间点的启用开关
    const handleToggleChange = async (e) => {
      const chk = e.target.closest && e.target.closest('.time-toggle');
      if (!chk) return;
      const reminderId = chk.getAttribute('data-id');
      const time = chk.getAttribute('data-time');
      const rIdx = reminders.findIndex(r => r.id === reminderId);
      if (rIdx === -1) return;
      if (!reminders[rIdx].dailyTimeEnabled || typeof reminders[rIdx].dailyTimeEnabled !== 'object') {
        reminders[rIdx].dailyTimeEnabled = {};
      }
      reminders[rIdx].dailyTimeEnabled[time] = !!chk.checked;
      reminders[rIdx].updatedAt = new Date().toISOString();
      saveReminders();
      hapticFeedback('Light');
      // 重新设置调度
      await setupReminders();
    };
    const prevToggle = container._timeToggleHandler;
    if (prevToggle) {
      container.removeEventListener('change', prevToggle);
    }
    container.addEventListener('change', handleToggleChange);
    container._timeToggleHandler = handleToggleChange;

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
        const sEl = root.getElementById('startDate');
        const eEl = root.getElementById('endDate');
        if (sEl) sEl.value = reminder.startDate || '';
        if (eEl) eEl.value = reminder.endDate || '';
        if (sEl && eEl && sEl.value) { eEl.min = sEl.value; }
        root.getElementById('dosage').value = reminder.dosage || '';
        const repeatSelect = root.getElementById('repeatInterval');
        const repeatValue = root.getElementById('repeatCustomValue');
        const repeatGroup = root.getElementById('repeatCustomGroup');
        const repeatLabel = root.getElementById('repeatCustomLabel');
        if (repeatSelect) repeatSelect.value = reminder.repeatInterval || 'none';
        if (repeatValue) repeatValue.value = reminder.repeatCustomValue || '';
        if (repeatGroup) repeatGroup.style.display = (reminder.repeatInterval && reminder.repeatInterval !== 'none') ? '' : 'none';
        if (repeatLabel && repeatSelect) {
          repeatLabel.textContent = `自定义间隔（${repeatSelect.value === 'daily' ? '天' : repeatSelect.value === 'weekly' ? '周' : repeatSelect.value === 'monthly' ? '月' : repeatSelect.value === 'yearly' ? '年' : ''}）`;
        }
        // 每日次数与时间列表
        const dailyCountEl = root.getElementById('dailyCount');
        const dailyGroup = root.getElementById('dailyTimesGroup');
        if (dailyCountEl) dailyCountEl.value = reminder.dailyCount || '';
        if (dailyGroup) dailyGroup.style.display = reminder.dailyCount > 0 ? '' : 'none';
        // 确保编辑模式下时间输入数量与次数一致（不足则补空）
        const timesInit = Array.isArray(reminder.dailyTimes) ? [...reminder.dailyTimes] : [];
        const need = Math.max(0, (reminder.dailyCount || 0) - timesInit.length);
        for (let i = 0; i < need; i++) timesInit.push('');
        renderDailyTimesEditor(root, timesInit);
      }
    } else {
      // 添加模式
      title.textContent = '添加用药提醒';
      form.reset();
      // 设置默认开始日期
      const now = new Date();
      const currentDate = now.toISOString().slice(0, 10);
      const sEl = root.getElementById('startDate');
      if (sEl) sEl.value = currentDate;
      const eEl = root.getElementById('endDate');
      if (sEl && eEl) {
        eEl.min = sEl.value;
        eEl.value = sEl.value; // 默认结束日期与开始日期相同
      }
      const repeatSelect = root.getElementById('repeatInterval');
      const repeatValue = root.getElementById('repeatCustomValue');
      const repeatGroup = root.getElementById('repeatCustomGroup');
      const repeatLabel = root.getElementById('repeatCustomLabel');
      if (repeatSelect) repeatSelect.value = 'none';
      if (repeatValue) repeatValue.value = '';
      if (repeatGroup) repeatGroup.style.display = 'none';
      if (repeatLabel) repeatLabel.textContent = '自定义间隔';
      // 每日次数UI
      const dailyCountEl = root.getElementById('dailyCount');
      const dailyGroup = root.getElementById('dailyTimesGroup');
      if (dailyCountEl) dailyCountEl.value = '';
      if (dailyGroup) dailyGroup.style.display = 'none';
      renderDailyTimesEditor(root, []);
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
    const startDate = (root.getElementById('startDate') && root.getElementById('startDate').value) || '';
    const endDateEl = root.getElementById('endDate');
    const endDate = (endDateEl && endDateEl.value) || '';
    const dosage = root.getElementById('dosage').value.trim();
    const notes = root.getElementById('notes').value.trim();
    const repeatInterval = (root.getElementById('repeatInterval') && root.getElementById('repeatInterval').value) || 'none';
    const repeatCustomValueRaw = (root.getElementById('repeatCustomValue') && root.getElementById('repeatCustomValue').value) || '';
    const repeatCustomValue = repeatCustomValueRaw ? Math.max(1, parseInt(repeatCustomValueRaw, 10)) : null;
    const dailyCount = parseInt((root.getElementById('dailyCount') && root.getElementById('dailyCount').value) || '0', 10) || 0;
    const dailyList = root.getElementById('dailyTimesList');
    const dailyTimes = dailyList ? [...dailyList.querySelectorAll('input[type="time"]')].map(i => i.value).filter(Boolean) : [];

    if (!name || !startDate) {
      alert('请填写药品名称与开始日期');
      return;
    }
    
    // 检查开始日期不能是过去的日期（使用本地时间）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    
    if (startDate < today) {
      alert('开始日期不能是过去的日期');
      return;
    }
    
    if (!endDate) {
      alert('请填写结束日期');
      if (endDateEl && typeof endDateEl.scrollIntoView === 'function') endDateEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (endDateEl && typeof endDateEl.focus === 'function') endDateEl.focus();
      return;
    }
    if (endDate && endDate < startDate) {
      alert('结束日期必须大于或等于开始日期');
      if (endDateEl && typeof endDateEl.scrollIntoView === 'function') endDateEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (endDateEl && typeof endDateEl.focus === 'function') endDateEl.focus();
      return;
    }
    
    // 检查结束日期不能是过去的日期
    if (endDate && endDate < today) {
      alert('结束日期不能是过去的日期');
      if (endDateEl && typeof endDateEl.scrollIntoView === 'function') endDateEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (endDateEl && typeof endDateEl.focus === 'function') endDateEl.focus();
      return;
    }

    // 校验：每日提醒次数与每日提醒时间为必填
    const dailyCountEl = root.getElementById('dailyCount');
    const dailyTimesGroup = root.getElementById('dailyTimesGroup');
    if (!dailyCount || dailyCount < 1) {
      alert('请填写每日提醒次数（至少为1次）');
      if (dailyCountEl && typeof dailyCountEl.scrollIntoView === 'function') dailyCountEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (dailyCountEl && typeof dailyCountEl.focus === 'function') dailyCountEl.focus();
      return;
    }
    if (!Array.isArray(dailyTimes) || dailyTimes.length !== dailyCount) {
      alert('请填写与次数相同数量的提醒时间');
      if (dailyTimesGroup && typeof dailyTimesGroup.scrollIntoView === 'function') dailyTimesGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const firstEmpty = dailyList && [...dailyList.querySelectorAll('input[type="time"]')].find(i => !i.value);
      if (firstEmpty && typeof firstEmpty.focus === 'function') firstEmpty.focus();
      return;
    }

    // 校验：每天提醒时间不得在同一分钟重复
    const timeSet = new Set();
    let duplicateValue = null;
    for (const t of dailyTimes) {
      if (timeSet.has(t)) { duplicateValue = t; break; }
      timeSet.add(t);
    }
    if (duplicateValue) {
      alert('每天提醒时间不能相同，请修改重复的时间：' + duplicateValue);
      if (dailyTimesGroup && typeof dailyTimesGroup.scrollIntoView === 'function') dailyTimesGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const dupInput = dailyList && [...dailyList.querySelectorAll('input[type="time"]')].find(i => i.value === duplicateValue);
      if (dupInput && typeof dupInput.focus === 'function') dupInput.focus();
      return;
    }

    // 生成/合并每日时间启用状态映射
    let dailyTimeEnabled = {};
    if (editingReminderId) {
      const existing = reminders.find(r => r.id === editingReminderId);
      if (existing && existing.dailyTimeEnabled && typeof existing.dailyTimeEnabled === 'object') {
        // 保留已有状态
        dailyTimes.forEach(t => {
          if (Object.prototype.hasOwnProperty.call(existing.dailyTimeEnabled, t)) {
            dailyTimeEnabled[t] = !!existing.dailyTimeEnabled[t];
          } else {
            dailyTimeEnabled[t] = true; // 新增时间默认启用
          }
        });
      } else {
        dailyTimes.forEach(t => { dailyTimeEnabled[t] = true; });
      }
    } else {
      dailyTimes.forEach(t => { dailyTimeEnabled[t] = true; });
    }

    const reminder = {
      id: editingReminderId || generateId(),
      name,
      startDate,
      endDate,
      dosage,
      notes,
      repeatInterval,
      repeatCustomValue,
      dailyCount,
      dailyTimes,
      dailyTimeEnabled,
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
      const target = reminders.find(r => r.id === reminderId);
      if (reminderTimeouts.has(reminderId)) { clearTimeout(reminderTimeouts.get(reminderId)); reminderTimeouts.delete(reminderId); }
      [...reminderTimeouts.keys()].forEach(key => {
        if (typeof key === 'string' && key.startsWith(reminderId + '|')) {
          clearTimeout(reminderTimeouts.get(key));
          reminderTimeouts.delete(key);
        }
      });

      // 取消Capacitor通知（使用稳定ID）
      if (LocalNotifications) {
        const cancelIds = [];
        cancelIds.push({ id: stableIdFromString(reminderId) });
        if (target && Array.isArray(target.dailyTimes)) {
          target.dailyTimes.filter(Boolean).forEach(t => {
            cancelIds.push({ id: stableIdFromString(reminderId + '|' + t) });
          });
        }
        try { await LocalNotifications.cancel({ notifications: cancelIds }); } catch (_) {}
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
    console.log('⏰ setupReminders 开始执行', new Date().toISOString());
    // 防止重复设置提醒
    if (isSettingUpReminders) {
      console.log('⏰ setupReminders 跳过：正在设置中');
      return;
    }

    isSettingUpReminders = true;

    try {
      // 清除所有现有定时器
      reminderTimeouts.forEach(timeout => clearTimeout(timeout));
      reminderTimeouts.clear();
      uiAdvanceTimeouts.forEach(timeout => clearTimeout(timeout));
      uiAdvanceTimeouts.clear();
      allowedFireAt.clear(); // 清除允许触发窗口

      if (LocalNotifications) {
        // 使用Capacitor本地通知调度（逐条调度）
        const notifications = [];
        const cancelList = [];

        // 统一用户名
        let username = '访客';
        try { username = await getUsernameAsync(); } catch(_) {}

        reminders.forEach(reminder => {
          // 必须有 dailyTimes
          if (!(reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0)) return;

          const timesAll = [...reminder.dailyTimes].filter(Boolean).sort();
          const timesEnabled = timesAll.filter(t => isTimeEnabled(reminder, t));
          const now = new Date();
          let nextAtForUi = null;

          // 先取消所有该提醒下（所有时间点）的既有原生通知
          timesAll.forEach((t) => {
            const notificationId = stableIdFromString(reminder.id + '|' + t);
            cancelList.push({ id: notificationId });
          });

          // 仅为启用的时间点调度
          timesEnabled.forEach((t) => {
            const baseDate = reminder.startDate || new Date().toISOString().slice(0,10);
            const baseTime = new Date(`${baseDate}T${t}:00`);
            
            // 如果基础时间已过，直接跳到下一天
            let firstTime = baseTime;
            console.log(`⏰ 计算时间: ${t}, startDate: ${reminder.startDate}, baseDate: ${baseDate}, 基础时间: ${baseTime.toISOString()}, 当前时间: ${now.toISOString()}`);
            if (firstTime <= now) {
              // 如果今天的时间已过，跳到下一天
              const nextDay = new Date(baseTime);
              nextDay.setDate(nextDay.getDate() + 1);
              firstTime = new Date(`${nextDay.toISOString().slice(0,10)}T${t}:00`);
              console.log(`⏰ 时间已过，跳到下一天: ${firstTime.toISOString()}`);
            } else {
              console.log(`⏰ 时间未到，使用原时间: ${firstTime.toISOString()}`);
            }

            // 如果超出结束日期，则跳过
            if (reminder.endDate) {
              const end = new Date(`${reminder.endDate}T23:59:59`);
              if (firstTime > end) return;
            }

            if (!nextAtForUi || firstTime < nextAtForUi) nextAtForUi = firstTime;

            const notificationId = stableIdFromString(reminder.id + '|' + t);
            const schedule = { at: firstTime };
            // 不再使用 repeats/every，避免原生立即触发或时间漂移，由应用层手动重调度

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

          if (nextAtForUi) scheduleUiAdvance(reminder.id, nextAtForUi);
        });

        if (cancelList.length > 0) {
          try { await LocalNotifications.cancel({ notifications: cancelList }); } catch (_) {}
        }
        if (notifications.length > 0) {
          try { await LocalNotifications.schedule({ notifications }); }
          catch (e) { console.error('❌ Capacitor通知调度失败:', e); throw e; }
        }
      } else {
        // 回退模式：按dailyTimes设置
        reminderTimeouts.forEach(timeout => clearTimeout(timeout));
        reminderTimeouts.clear();
        const now = new Date();
        reminders.forEach(reminder => {
          if (!(reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0)) return;
          const times = [...reminder.dailyTimes].filter(Boolean).filter(t => isTimeEnabled(reminder, t)).sort();
          times.forEach((t) => {
            const baseDate = reminder.startDate || new Date().toISOString().slice(0,10);
            const baseTime = new Date(`${baseDate}T${t}:00`);
            
            // 如果基础时间已过，跳到下一天
            let firstTime = baseTime;
            if (firstTime <= now) {
              const nextDay = new Date(baseTime);
              nextDay.setDate(nextDay.getDate() + 1);
              firstTime = new Date(`${nextDay.toISOString().slice(0,10)}T${t}:00`);
            }
            
            // 范围检查
            if (reminder.endDate) {
              const end = new Date(`${reminder.endDate}T23:59:59`);
              if (firstTime > end) return;
            }
            
            const delay = firstTime - now;
            // 只有时间在未来才设置定时器
            if (delay > 0) {
              const timeout = setTimeout(() => {
                if (canSendNotification(reminder.id)) showNotification(reminder);
                if (reminder.repeatInterval && reminder.repeatInterval !== 'none') scheduleNextFallback(reminder);
              }, delay);
              reminderTimeouts.set(reminder.id + '|' + t, timeout);
            }
          });
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
    // 仅在提醒页面激活时才使用回退定时器，防止动态加载到其他页面误发
    if (!isActiveReminderView) {
      console.warn('回退模式已跳过：当前不在提醒页面');
      return;
    }
    reminderTimeouts.forEach(timeout => clearTimeout(timeout));
    reminderTimeouts.clear();
    uiAdvanceTimeouts.forEach(timeout => clearTimeout(timeout));
    uiAdvanceTimeouts.clear();
    allowedFireAt.clear(); // 清除允许触发窗口

    const now = new Date();
    reminders.forEach(reminder => {
      if (!(reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0)) return;
      if (reminder.repeatInterval === 'none') return; // 不循环则不进入fallback循环

      const times = [...reminder.dailyTimes].filter(Boolean).filter(t => isTimeEnabled(reminder, t)).sort();
      times.forEach((t) => {
        const baseDate = reminder.startDate || new Date().toISOString().slice(0,10);
        const baseTime = new Date(`${baseDate}T${t}:00`);
        
        // 如果基础时间已过，跳到下一天
        let firstTime = baseTime;
        if (firstTime <= now) {
          const nextDay = new Date(baseTime);
          nextDay.setDate(nextDay.getDate() + 1);
          firstTime = new Date(`${nextDay.toISOString().slice(0,10)}T${t}:00`);
        }
        
        // 检查是否超出结束日期
        if (reminder.endDate) {
          const end = new Date(`${reminder.endDate}T23:59:59`);
          if (firstTime > end) return;
        }
        
        const timeUntilReminder = firstTime - now;
        
        // 只有时间在未来才设置定时器
        if (timeUntilReminder > 0) {
          const timeout = setTimeout(() => {
            if (canSendNotification(reminder.id)) {
              showNotification(reminder);
            }
            scheduleNextFallback(reminder);
          }, timeUntilReminder);

          reminderTimeouts.set(reminder.id + '|' + t, timeout);
        }
      });
    });

    console.log('⏰ 回退模式：设置了', reminderTimeouts.size, '个提醒定时器');
  }

  function computeNextTime(reminder, baseTime, fromTime) {
    // 若配置了每日多个时间，优先使用它们（每日重复）
    if (reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0) {
      const times = [...reminder.dailyTimes].filter(Boolean).filter(t => isTimeEnabled(reminder, t)).sort(); // "HH:MM"
      const from = new Date(fromTime);
      const fromDateStr = from.toISOString().slice(0,10);
      const fromHhmm = from.toTimeString().slice(0,5);
      
      // 检查今天剩余的时间
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (t > fromHhmm) {
          return new Date(`${fromDateStr}T${t}:00`);
        }
      }
      
      // 如果今天的时间都过了，跳到下一天的第一个时间
      const nextDay = new Date(from);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().slice(0,10);
      const first = times[0];
      return new Date(`${nextDayStr}T${first}:00`);
    }

    let next = new Date(baseTime.getTime());
    if (reminder.repeatInterval === 'daily') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) next.setDate(next.getDate() + mult);
    } else if (reminder.repeatInterval === 'weekly') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) next.setDate(next.getDate() + 7 * mult);
    } else if (reminder.repeatInterval === 'monthly') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) {
        const m = next.getMonth() + mult;
        next = new Date(next.getFullYear(), m, next.getDate(), next.getHours(), next.getMinutes(), 0, 0);
      }
    } else if (reminder.repeatInterval === 'yearly') {
      const mult = reminder.repeatCustomValue && reminder.repeatCustomValue > 0 ? reminder.repeatCustomValue : 1;
      while (next <= fromTime) {
        next = new Date(next.getFullYear() + mult, next.getMonth(), next.getDate(), next.getHours(), next.getMinutes(), 0, 0);
      }
    } else {
      if (next <= fromTime) next.setDate(next.getDate() + 1);
    }
    return next;
  }

  function scheduleNextFallback(reminder) {
    if (reminder.repeatInterval === 'none') return;
    let intervalMs = 24 * 60 * 60 * 1000; // 默认每天
    if (reminder.repeatInterval === 'daily') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 24 * 60 * 60 * 1000;
    } else if (reminder.repeatInterval === 'weekly') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 7 * 24 * 60 * 60 * 1000;
    } else if (reminder.repeatInterval === 'monthly') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 30 * 24 * 60 * 60 * 1000; // 近似每月30天
    } else if (reminder.repeatInterval === 'yearly') {
      const mult = (reminder.repeatCustomValue && reminder.repeatCustomValue > 0) ? reminder.repeatCustomValue : 1;
      intervalMs = mult * 365 * 24 * 60 * 60 * 1000; // 近似每年365天
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
      // 仅在提醒页激活且页面可见时允许浏览器/回退发送
      if (!LocalNotifications) {
        if (!isActiveReminderView || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
          console.warn('跳过浏览器通知：当前不在提醒页面或页面不可见');
          return;
        }
        // 严格时间窗口校验：仅在计划时间附近发送
        const planned = allowedFireAt.get(reminder.id);
        if (!planned) {
          console.warn('跳过浏览器通知：未登记的允许触发窗口');
          return;
        }
        const now = Date.now();
        const EARLY = 90 * 1000; // 最早提前90秒
        const LATE = 5 * 60 * 1000; // 最迟滞后5分钟
        if (now < planned - EARLY || now > planned + LATE) {
          console.warn('跳过浏览器通知：超出允许触发窗口');
          return;
        }
      }

      // 获取用户名
      const username = await getUsernameAsync();

      const notificationTitle = buildNotificationTitle();
      const notificationBody = buildNotificationBody(username, reminder);

      // 优先使用Capacitor本地通知
      if (LocalNotifications) {
        const notificationId = Math.floor(Math.random() * 900000) + 100000;
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

      // 非循环：仅当“今天所有时间点都发完”才删除；否则继续等今天的下一个时间点
      if (!reminder.repeatInterval || reminder.repeatInterval === 'none') {
        const nextToday = getNextTimeToday(reminder, new Date());
        if (nextToday) {
          scheduleUiAdvance(reminder.id, nextToday);
        } else {
          await hardDeleteReminder(reminder.id);
        }
        return;
      }

      // 循环：推进到下一次触发时间（同日或跨日）
      advanceReminderNextRun(reminder);

    } catch (error) {
      console.error('❌ 发送通知失败:', error);
    }
  }

  function advanceReminderNextRun(reminder) {
    try {
      const idx = reminders.findIndex(r => r.id === reminder.id);
      if (idx === -1) return;

      // 范围检查，若超过结束日期则直接删除
      if (isReminderExpired(reminder)) {
        hardDeleteReminder(reminder.id);
        return;
      }

      // 使用 dailyTimes 推进到下一次最近时间（仅考虑启用的时间）
      if (reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0) {
        const now = new Date();
        const next = computeNextTime(reminder, new Date(`${reminder.startDate || now.toISOString().slice(0,10)}T00:00:00`), now);
        // 若 next 超过结束日期，则删除
        if (isReminderExpired(reminder, next)) {
          hardDeleteReminder(reminder.id);
          return;
        }
        const nextDate = next.toISOString().slice(0,10);
        const nextTime = next.toTimeString().slice(0,5);
        reminders[idx] = { ...reminders[idx], startDate: reminders[idx].startDate || nextDate, updatedAt: new Date().toISOString() };
        // 不再单独存 time 字段
        saveReminders();
        if (currentRoot) { renderReminders(currentRoot); updateEditingModalIfOpen(currentRoot, reminders[idx]); }
        scheduleUiAdvance(reminders[idx].id, next);
        if (LocalNotifications) {
          const needsCustomNative = (reminder.repeatInterval === 'daily' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1)
            || (reminder.repeatInterval === 'weekly' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1)
            || (reminder.repeatInterval === 'monthly' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1)
            || (reminder.repeatInterval === 'yearly' && reminder.repeatCustomValue && reminder.repeatCustomValue > 1);
          if (needsCustomNative) scheduleNextNative(reminders[idx]);
        } else {
          scheduleNextFallback(reminders[idx]);
        }
        return;
      }

      // 无时间点则不推进
    } catch (e) {
      console.error('推进下次提醒失败:', e);
    }
  }

  function scheduleNextNative(reminder) {
    try {
      if (!LocalNotifications) return;
      // 计算下一次at
      const now = new Date();
      let nextAt = null;
      if (reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0) {
        // 优先使用每日时间
        const nextToday = getNextTimeToday(reminder, now);
        if (nextToday) {
          nextAt = nextToday;
        } else {
          // 如果今天没有剩余时间，跳到下一天
          const baseDate = (reminder.startDate || now.toISOString().slice(0,10));
          // 选择下一个启用的第一个时间
          const enabledTimes = [...reminder.dailyTimes].filter(Boolean).filter(t => isTimeEnabled(reminder, t)).sort();
          const firstEnabled = enabledTimes[0] || reminder.dailyTimes[0] || '00:00';
          const baseTime = new Date(`${baseDate}T${firstEnabled}:00`);
          if (baseTime <= now) {
            // 如果基础时间已过，跳到下一天
            const nextDay = new Date(baseTime);
            nextDay.setDate(nextDay.getDate() + 1);
            nextAt = new Date(`${nextDay.toISOString().slice(0,10)}T${firstEnabled}:00`);
          } else {
            nextAt = baseTime;
          }
        }
      } else {
        // 无dailyTimes则不重调度
        return;
      }
      // 范围检查
      if (reminder.endDate) {
        const end = new Date(`${reminder.endDate}T23:59:59`);
        if (nextAt > end) return;
      }
      // 安全窗口修正：若过早，推迟到计划点；若非常接近，向后偏移500ms
      const nowMs = Date.now();
      let atMs = nextAt.getTime();
      if (atMs < nowMs) atMs = nowMs + 500;
      const at = new Date(atMs);

      // 对于按多个时间点调度，按“明确定点时间”的ID来调度，以便与启用状态对齐
      const enabledTimes = [...(reminder.dailyTimes || [])].filter(Boolean).filter(t => isTimeEnabled(reminder, t)).sort();
      const nextTimeHHMM = nextAt.toTimeString().slice(0,5);
      const idKey = enabledTimes.includes(nextTimeHHMM) ? (reminder.id + '|' + nextTimeHHMM) : reminder.id;
      const notificationId = stableIdFromString(idKey);
      // 先取消相关ID，再按 at 调度，不使用 repeats
      const cancelIds = [{ id: stableIdFromString(reminder.id) }];
      enabledTimes.forEach(t => cancelIds.push({ id: stableIdFromString(reminder.id + '|' + t) }));
      LocalNotifications.cancel({ notifications: cancelIds }).catch(() => {});
      LocalNotifications.schedule({ notifications: [{
        id: notificationId,
        title: buildNotificationTitle(),
        body: buildNotificationBody('您', reminder),
        schedule: { at },
        sound: 'default',
        actionTypeId: 'medication_reminder',
        extra: { reminderId: reminder.id, medicationName: reminder.name }
      }]});
      // 同步UI推进窗口
      scheduleUiAdvance(reminder.id, at);
    } catch (_) {}
  }

  function updateEditingModalIfOpen(root, updatedReminder) {
    try {
      const modal = root.getElementById('reminderModal');
      if (!modal || !modal.classList.contains('show')) return;
      if (!editingReminderId || editingReminderId !== updatedReminder.id) return;
      const sEl = root.getElementById('startDate');
      const eEl = root.getElementById('endDate');
      if (sEl) sEl.value = updatedReminder.startDate || '';
      if (eEl) eEl.value = updatedReminder.endDate || '';
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
    allowedFireAt.clear(); // 清除允许触发窗口

    // 清除当前的root引用
    currentRoot = null;
    isActiveReminderView = false;

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
    // 不再自动推进提醒时间，避免页面切换时重复发送
    // 只更新UI显示，不触发通知
    console.log('⏰ 跳过自动推进，避免重复发送');
  }

  function scheduleUiAdvance(reminderId, atDate) {
    try {
      if (uiAdvanceTimeouts.has(reminderId)) {
        clearTimeout(uiAdvanceTimeouts.get(reminderId));
        uiAdvanceTimeouts.delete(reminderId);
      }
      // 记录允许触发窗口（以该时间为准）
      allowedFireAt.set(reminderId, atDate.getTime());

      const now = Date.now();
      const delay = Math.max(0, atDate.getTime() - now + 500); // 微小偏移，确保在系统展示后推进
      const timeout = setTimeout(() => {
        const r = reminders.find(x => x.id === reminderId);
        if (!r) return;
        const nextToday = getNextTimeToday(r, new Date());
        if (!r.repeatInterval || r.repeatInterval === 'none') {
          if (nextToday) {
            scheduleUiAdvance(reminderId, nextToday);
          } else {
            hardDeleteReminder(reminderId);
          }
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
    if (reminder.repeatInterval === 'daily') {
      return `循环：每${n === 1 ? '' : n}天`.replace('每天', '每天');
    }
    if (reminder.repeatInterval === 'weekly') {
      return `循环：每${n === 1 ? '' : n}周`;
    }
    if (reminder.repeatInterval === 'monthly') {
      return `循环：每${n === 1 ? '' : n}月`;
    }
    if (reminder.repeatInterval === 'yearly') {
      return `循环：每${n === 1 ? '' : n}年`;
    }
    return '';
  }

  function renderDailyTimesEditor(root, times) {
    const list = root.getElementById('dailyTimesList');
    if (!list) return;
    const values = Array.isArray(times) ? [...times] : [];
    list.innerHTML = '';

    // 工具：创建一行，左格必有输入；右格可选（若为null则只放占位）
    const createRow = (leftVal = '', rightVal = null) => {
      const row = document.createElement('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '1fr 1fr';
      row.style.gap = '8px';
      row.style.marginBottom = '8px';
      const makeCell = (val) => {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '6px';
        wrap.innerHTML = `<input type=\"time\" class=\"form-input\" value=\"${val}\" style=\"flex:1;\"/><button type=\"button\" class=\"btn btn-danger\" data-remove-input>删除</button>`;
        return wrap;
      };
      // 左格（必有输入）
      row.appendChild(makeCell(leftVal));
      // 右格（可为空占位）
      if (rightVal !== null && rightVal !== undefined) {
        row.appendChild(makeCell(rightVal));
      } else {
        const placeholder = document.createElement('div');
        row.appendChild(placeholder);
      }
      list.appendChild(row);
    };

    // 按两列布局渲染，最后一行若为奇数则只渲染一个输入
    for (let i = 0; i < values.length; i += 2) {
      if (i + 1 < values.length) {
        createRow(values[i] || '', values[i + 1] || '');
      } else {
        createRow(values[i] || '', null);
      }
    }

    // 若没有任何值，初始化一行一个输入（第二格占位），避免空白
    if (values.length === 0) {
      createRow('', null);
    }
  }

  // 计算“今天内”的下一次时间（仅针对 dailyTimes），若没有则返回 null
  function getNextTimeToday(reminder, fromDate) {
    if (!(reminder && reminder.dailyCount > 0 && Array.isArray(reminder.dailyTimes) && reminder.dailyTimes.length > 0)) return null;
    const times = [...reminder.dailyTimes].filter(Boolean).filter(t => isTimeEnabled(reminder, t)).sort();
    const from = fromDate ? new Date(fromDate) : new Date();
    const dateStr = from.toISOString().slice(0,10);
    const hhmm = from.toTimeString().slice(0,5);
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t > hhmm) return new Date(`${dateStr}T${t}:00`);
    }
    return null;
  }

  // 检查提醒是否超出结束日期
  function isReminderExpired(reminder, checkTime = new Date()) {
    if (!reminder.endDate) return false;
    const end = new Date(`${reminder.endDate}T23:59:59`);
    return checkTime > end;
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
          const nextToday = getNextTimeToday(r, new Date());
          if (nextToday) {
            scheduleUiAdvance(rid, nextToday);
          } else {
            hardDeleteReminder(rid);
          }
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
          const nextToday = getNextTimeToday(r, new Date());
          if (nextToday) {
            scheduleUiAdvance(reminderId, nextToday);
          } else {
            hardDeleteReminder(reminderId);
          }
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
