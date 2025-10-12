/**
 * 输入框体验增强模块
 * Input Enhancement Module
 * 
 * 功能特性:
 * - 优化移动端输入框的键盘弹出
 * - 智能震动反馈（不干扰键盘）
 * - 防止双击问题
 * - 更流畅的用户体验
 */

(function() {
  'use strict';

  // 配置选项
  const config = {
    // 震动延迟时间，避免干扰键盘弹出
    hapticDelay: 50,
    // 是否在blur时震动（输入完成）
    hapticOnBlur: true,
    // 是否在input时震动（输入中）
    hapticOnInput: false,
    // input防抖时间
    inputDebounce: 300
  };

  /**
   * 增强输入框体验
   * @param {HTMLInputElement|HTMLTextAreaElement} element 输入框元素
   * @param {Object} options 配置选项
   */
  function enhanceInput(element, options = {}) {
    if (!element) return;

    const opts = { ...config, ...options };
    let inputTimer = null;
    let hasInteracted = false;

    // 优化后的focus处理
    const handleFocus = function(e) {
      console.log('[InputEnhancement] focus事件触发', element);
      
      // 🔧 修复：只在用户主动交互后才触发震动
      // 初始化阶段如果元素自动获得焦点，不应该震动
      if (!hasInteracted) {
        console.log('[InputEnhancement] 初始化阶段，跳过震动');
        return;
      }
      
      // 确保键盘能够正常弹出
      requestAnimationFrame(() => {
        // 延迟震动，不干扰键盘弹出
        setTimeout(() => {
          if (document.activeElement === element) {
            console.log('[InputEnhancement] 延迟后验证焦点成功，触发震动');
            triggerHaptic('Light', 'input-focus');
          } else {
            console.warn('[InputEnhancement] 延迟后焦点丢失！当前焦点:', document.activeElement);
          }
        }, opts.hapticDelay);
      });
    };

    // 优化后的input处理（可选）
    const handleInput = function(e) {
      if (!opts.hapticOnInput) return;

      // 清除之前的定时器
      if (inputTimer) {
        clearTimeout(inputTimer);
      }

      // 防抖处理
      inputTimer = setTimeout(() => {
        if (element.value) {
          triggerHaptic('Light', 'input-typing');
        }
      }, opts.inputDebounce);
    };

    // 优化后的blur处理
    const handleBlur = function(e) {
      if (!opts.hapticOnBlur) return;
      
      // 输入完成时给予确认反馈
      // 无论是否有内容都给予反馈，让用户知道焦点已离开
      triggerHaptic('Light', 'input-blur');
    };

    // 阻止可能的双击问题
    const handleTouchStart = function(e) {
      // 🔧 标记为用户交互
      hasInteracted = true;
      
      // 如果已经有焦点，不做处理
      if (document.activeElement === element) {
        console.log('[InputEnhancement] touchstart: 已有焦点，跳过');
        return;
      }
      
      console.log('[InputEnhancement] touchstart: 主动聚焦', element);
      
      // 主动聚焦（某些设备需要）
      // 使用 try-catch 捕获可能的错误
      try {
        element.focus();
        
        // 验证是否真的聚焦成功
        requestAnimationFrame(() => {
          if (document.activeElement === element) {
            console.log('[InputEnhancement] ✅ 聚焦成功');
          } else {
            console.warn('[InputEnhancement] ⚠️ 聚焦失败，当前焦点:', document.activeElement);
            // 重试一次
            setTimeout(() => {
              element.focus();
            }, 50);
          }
        });
      } catch (err) {
        console.error('[InputEnhancement] 聚焦出错:', err);
      }
    };

    // 添加事件监听器
    element.addEventListener('focus', handleFocus, { passive: true });
    element.addEventListener('input', handleInput, { passive: true });
    element.addEventListener('blur', handleBlur, { passive: true });
    element.addEventListener('touchstart', handleTouchStart, { passive: true });

    // 返回清理函数
    return function cleanup() {
      element.removeEventListener('focus', handleFocus);
      element.removeEventListener('input', handleInput);
      element.removeEventListener('blur', handleBlur);
      element.removeEventListener('touchstart', handleTouchStart);
      if (inputTimer) {
        clearTimeout(inputTimer);
      }
    };
  }

  /**
   * 批量增强输入框
   * @param {String|NodeList} selector 选择器或元素列表
   * @param {Object} options 配置选项
   */
  function enhanceInputs(selector, options = {}) {
    const elements = typeof selector === 'string' 
      ? document.querySelectorAll(selector)
      : selector;

    const cleanupFunctions = [];

    elements.forEach(element => {
      const cleanup = enhanceInput(element, options);
      if (cleanup) {
        cleanupFunctions.push(cleanup);
      }
    });

    // 返回批量清理函数
    return function cleanupAll() {
      cleanupFunctions.forEach(fn => fn());
    };
  }

  /**
   * 触发震动反馈
   * @param {String} style 震动强度
   * @param {String} context 上下文
   */
  function triggerHaptic(style, context) {
    try {
      if (window.HapticManager) {
        window.HapticManager.impact(style, {
          context: context || 'input',
          debounce: 100
        });
      } else if (window.__hapticImpact__) {
        window.__hapticImpact__(style);
      }
    } catch(_) {}
  }

  /**
   * 自动增强页面中的所有输入框
   * @param {Object} options 配置选项
   */
  function autoEnhance(options = {}) {
    // 等待DOM加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        doAutoEnhance(options);
      });
    } else {
      doAutoEnhance(options);
    }
  }

  function doAutoEnhance(options) {
    // 自动增强常见的输入框 - 增加了日期、时间等类型
    const selectors = [
      'input[type="text"]',
      'input[type="number"]',
      'input[type="tel"]',
      'input[type="email"]',
      'input[type="search"]',
      'input[type="date"]',      // 🔧 新增：日期选择器
      'input[type="time"]',      // 🔧 新增：时间选择器
      'input[type="datetime-local"]',
      'textarea',
      '.time-input',             // 自定义 class
      '.form-input'              // 自定义 class
    ];

    const selector = selectors.join(', ');
    
    // 首次增强所有输入框
    enhanceInputs(selector, options);
    console.log('[InputEnhancement] 已增强现有输入框');

    // 观察DOM变化，自动增强新添加的输入框
    if (window.MutationObserver) {
      // 用于跟踪已增强的元素，避免重复增强
      const enhancedElements = new WeakSet();
      
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) { // Element node
              // 检查节点本身
              if (node.matches && node.matches(selector)) {
                if (!enhancedElements.has(node)) {
                  enhanceInput(node, options);
                  enhancedElements.add(node);
                  console.log('[InputEnhancement] 增强新添加的输入框:', node);
                }
              }
              // 检查子元素
              const inputs = node.querySelectorAll && node.querySelectorAll(selector);
              if (inputs && inputs.length > 0) {
                inputs.forEach(input => {
                  if (!enhancedElements.has(input)) {
                    enhanceInput(input, options);
                    enhancedElements.add(input);
                    console.log('[InputEnhancement] 增强子元素输入框:', input);
                  }
                });
              }
            }
          });
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      
      console.log('[InputEnhancement] MutationObserver 已启动');
    }
  }

  // 暴露API
  window.InputEnhancement = {
    enhance: enhanceInput,
    enhanceAll: enhanceInputs,
    autoEnhance: autoEnhance,
    config: config
  };

  console.log('✅ InputEnhancement 已加载');
})();

