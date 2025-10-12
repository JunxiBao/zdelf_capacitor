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
      // 确保键盘能够正常弹出
      requestAnimationFrame(() => {
        // 延迟震动，不干扰键盘弹出
        setTimeout(() => {
          if (document.activeElement === element) {
            triggerHaptic('Light', 'input-focus');
            hasInteracted = true;
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
      
      // 输入完成，有内容时给予确认反馈
      if (element.value && element.value.trim()) {
        triggerHaptic('Medium', 'input-complete');
      }
    };

    // 阻止可能的双击问题
    const handleTouchStart = function(e) {
      // 如果已经有焦点，不做处理
      if (document.activeElement === element) {
        return;
      }
      
      // 主动聚焦（某些设备需要）
      element.focus();
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
    // 自动增强常见的输入框
    const selectors = [
      'input[type="text"]',
      'input[type="number"]',
      'input[type="tel"]',
      'input[type="email"]',
      'input[type="search"]',
      'textarea'
    ];

    const selector = selectors.join(', ');
    enhanceInputs(selector, options);

    // 观察DOM变化，自动增强新添加的输入框
    if (window.MutationObserver) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) { // Element node
              if (node.matches && node.matches(selector)) {
                enhanceInput(node, options);
              }
              // 也检查子元素
              const inputs = node.querySelectorAll && node.querySelectorAll(selector);
              if (inputs && inputs.length > 0) {
                enhanceInputs(inputs, options);
              }
            }
          });
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
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

