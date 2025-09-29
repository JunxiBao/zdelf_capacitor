/**
 * page-transitions.js — 页面转场动画增强
 * 为页面切换提供流畅的转场效果
 */

(function() {
  'use strict';

  // 页面转场管理器
  class PageTransitionManager {
    constructor() {
      this.isTransitioning = false;
      this.transitionDuration = 300;
      this.currentPage = null;
      this.previousPage = null;
      
      this.init();
    }

    init() {
      // 监听页面切换事件
      this.observePageChanges();
      
      // 为所有页面添加初始状态
      this.setupInitialStates();
    }

    observePageChanges() {
      // 监听导航点击
      document.addEventListener('click', (e) => {
        const navItem = e.target.closest('.nav-item');
        if (navItem && !this.isTransitioning) {
          const index = Array.from(document.querySelectorAll('.nav-item')).indexOf(navItem);
          this.handlePageTransition(index);
        }
      });
    }

    setupInitialStates() {
      const content = document.getElementById('content');
      if (content) {
        content.style.opacity = '1';
        content.style.transform = 'translateY(0)';
        content.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      }
    }

    async handlePageTransition(targetIndex) {
      if (this.isTransitioning) return;
      
      this.isTransitioning = true;
      const content = document.getElementById('content');
      
      if (!content) {
        this.isTransitioning = false;
        return;
      }

      try {
        // 阶段1：淡出当前内容
        await this.fadeOutContent(content);
        
        // 阶段2：等待新内容加载（这里会被原有的loadPage处理）
        // 我们只是添加一个短暂的延迟来确保内容更新
        await this.wait(50);
        
        // 阶段3：淡入新内容
        await this.fadeInContent(content);
        
      } catch (error) {
        console.warn('Page transition error:', error);
      } finally {
        this.isTransitioning = false;
      }
    }

    fadeOutContent(element) {
      return new Promise(resolve => {
        if (!element) {
          resolve();
          return;
        }

        // 检查是否支持动画
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          element.style.opacity = '0';
          resolve();
          return;
        }

        element.style.opacity = '0';
        element.style.transform = 'translateY(-10px)';
        
        setTimeout(resolve, this.transitionDuration / 2);
      });
    }

    fadeInContent(element) {
      return new Promise(resolve => {
        if (!element) {
          resolve();
          return;
        }

        // 检查是否支持动画
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          element.style.opacity = '1';
          element.style.transform = 'translateY(0)';
          resolve();
          return;
        }

        // 设置初始状态
        element.style.opacity = '0';
        element.style.transform = 'translateY(20px)';
        
        // 强制重排
        element.offsetHeight;
        
        // 执行动画
        element.style.opacity = '1';
        element.style.transform = 'translateY(0)';
        
        setTimeout(resolve, this.transitionDuration);
      });
    }

    wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 为特定页面添加自定义入场动画
    addCustomPageAnimation(pageSelector, animationClass) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1 && node.matches && node.matches(pageSelector)) {
              this.applyCustomAnimation(node, animationClass);
            }
          });
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      return observer;
    }

    applyCustomAnimation(element, animationClass) {
      if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      element.classList.add(animationClass);
      
      // 清理动画类
      element.addEventListener('animationend', () => {
        element.classList.remove(animationClass);
      }, { once: true });
    }
  }

  // 卡片堆叠动画
  class CardStackAnimation {
    constructor(containerSelector = '.timeline-container, .reminders-container, .data-cards-container') {
      this.containers = document.querySelectorAll(containerSelector);
      this.init();
    }

    init() {
      this.containers.forEach(container => {
        this.setupCardAnimations(container);
      });

      // 监听新卡片的添加
      this.observeNewCards();
    }

    setupCardAnimations(container) {
      const cards = container.querySelectorAll('.timeline-item, .reminder-card, .unified-card, .metric-card, .form-group');
      
      cards.forEach((card, index) => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          return;
        }

        // 设置初始状态
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px) scale(0.95)';
        card.style.transition = 'all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';

        // 延迟动画
        setTimeout(() => {
          card.style.opacity = '1';
          card.style.transform = 'translateY(0) scale(1)';
        }, index * 100 + 200);
      });
    }

    observeNewCards() {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              const newCards = node.querySelectorAll ? 
                node.querySelectorAll('.timeline-item, .reminder-card, .unified-card, .metric-card, .form-group') : 
                [];
              
              if (node.matches && node.matches('.timeline-item, .reminder-card, .unified-card, .metric-card, .form-group')) {
                this.animateNewCard(node);
              }

              newCards.forEach(card => this.animateNewCard(card));
            }
          });
        });
      });

      this.containers.forEach(container => {
        observer.observe(container, {
          childList: true,
          subtree: true
        });
      });
    }

    animateNewCard(card) {
      if (!card || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      // 设置初始状态
      card.style.opacity = '0';
      card.style.transform = 'translateY(30px) scale(0.95)';
      card.style.transition = 'all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';

      // 强制重排
      card.offsetHeight;

      // 执行动画
      requestAnimationFrame(() => {
        card.style.opacity = '1';
        card.style.transform = 'translateY(0) scale(1)';
      });
    }
  }

  // 滚动视差效果
  class ScrollParallax {
    constructor() {
      this.elements = [];
      this.isScrolling = false;
      this.init();
    }

    init() {
      this.findParallaxElements();
      this.bindScrollEvent();
    }

    findParallaxElements() {
      // 查找具有parallax属性的元素
      const parallaxElements = document.querySelectorAll('[data-parallax]');
      
      parallaxElements.forEach(element => {
        const speed = parseFloat(element.dataset.parallax) || 0.5;
        this.elements.push({
          element,
          speed,
          offset: element.getBoundingClientRect().top + window.pageYOffset
        });
      });
    }

    bindScrollEvent() {
      let ticking = false;

      const updateParallax = () => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          return;
        }

        const scrolled = window.pageYOffset;

        this.elements.forEach(({ element, speed, offset }) => {
          const yPos = -(scrolled - offset) * speed;
          element.style.transform = `translate3d(0, ${yPos}px, 0)`;
        });

        ticking = false;
      };

      window.addEventListener('scroll', () => {
        if (!ticking) {
          requestAnimationFrame(updateParallax);
          ticking = true;
        }
      }, { passive: true });
    }
  }

  // 微交互增强
  class MicroInteractions {
    constructor() {
      this.init();
    }

    init() {
      this.setupHoverEffects();
      this.setupClickEffects();
      this.setupFocusEffects();
    }

    setupHoverEffects() {
      // 为按钮添加磁性效果
      document.addEventListener('mousemove', (e) => {
        const buttons = document.querySelectorAll('.btn, .center-button, .nav-item .icon');
        
        buttons.forEach(button => {
          const rect = button.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const deltaX = e.clientX - centerX;
          const deltaY = e.clientY - centerY;
          const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
          
          if (distance < 100) { // 100px 范围内
            const strength = (100 - distance) / 100;
            const moveX = deltaX * strength * 0.1;
            const moveY = deltaY * strength * 0.1;
            
            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
              button.style.transform = `translate(${moveX}px, ${moveY}px)`;
            }
          } else {
            button.style.transform = '';
          }
        });
      });
    }

    setupClickEffects() {
      // 点击波纹效果增强
      document.addEventListener('click', (e) => {
        const target = e.target.closest('.btn, .reminder-card, .timeline-content, .unified-card');
        
        if (target && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          this.createClickRipple(e, target);
        }
      });
    }

    setupFocusEffects() {
      // 焦点环增强
      document.addEventListener('focusin', (e) => {
        if (e.target.matches('input, button, select, textarea, [tabindex]')) {
          this.enhanceFocusRing(e.target);
        }
      });

      document.addEventListener('focusout', (e) => {
        this.removeFocusEnhancement(e.target);
      });
    }

    createClickRipple(event, element) {
      const ripple = document.createElement('div');
      const rect = element.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = event.clientX - rect.left - size / 2;
      const y = event.clientY - rect.top - size / 2;

      ripple.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        left: ${x}px;
        top: ${y}px;
        background: rgba(255, 255, 255, 0.4);
        border-radius: 50%;
        pointer-events: none;
        z-index: 1000;
        animation: clickRipple 0.6s ease-out forwards;
      `;

      // 确保元素有相对定位
      const computedStyle = getComputedStyle(element);
      if (computedStyle.position === 'static') {
        element.style.position = 'relative';
      }

      element.appendChild(ripple);

      ripple.addEventListener('animationend', () => {
        ripple.remove();
      });
    }

    enhanceFocusRing(element) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      element.style.boxShadow = '0 0 0 3px rgba(98, 0, 234, 0.3), 0 0 0 6px rgba(98, 0, 234, 0.1)';
      element.style.transition = 'box-shadow 0.2s ease';
    }

    removeFocusEnhancement(element) {
      element.style.boxShadow = '';
    }
  }

  // CSS动画注入
  const injectAnimationCSS = () => {
    if (document.getElementById('page-transitions-css')) return;

    const style = document.createElement('style');
    style.id = 'page-transitions-css';
    style.textContent = `
      @keyframes clickRipple {
        0% {
          transform: scale(0);
          opacity: 0.8;
        }
        100% {
          transform: scale(4);
          opacity: 0;
        }
      }

      .page-transition-enter {
        animation: pageEnter 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both;
      }

      .page-transition-exit {
        animation: pageExit 0.3s cubic-bezier(0.4, 0, 0.2, 1) both;
      }

      @keyframes pageEnter {
        from {
          opacity: 0;
          transform: translateY(20px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      @keyframes pageExit {
        from {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        to {
          opacity: 0;
          transform: translateY(-10px) scale(1.02);
        }
      }

      /* 减少动画支持 */
      @media (prefers-reduced-motion: reduce) {
        .page-transition-enter,
        .page-transition-exit {
          animation: none !important;
        }
        
        @keyframes clickRipple {
          0%, 100% { opacity: 0; }
        }
      }
    `;
    document.head.appendChild(style);
  };

  // 初始化
  document.addEventListener('DOMContentLoaded', () => {
    injectAnimationCSS();
    
    // 初始化各个组件
    window.pageTransitionManager = new PageTransitionManager();
    window.cardStackAnimation = new CardStackAnimation();
    window.scrollParallax = new ScrollParallax();
    window.microInteractions = new MicroInteractions();
    
    console.log('🎨 页面转场动画系统已初始化');
  });

  // 导出到全局
  window.PageTransitions = {
    PageTransitionManager,
    CardStackAnimation,
    ScrollParallax,
    MicroInteractions
  };

})();
