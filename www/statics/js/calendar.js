/**
 * calendar.js - Calendar page functionality
 * 日历页面功能实现
 */

(function() {
    'use strict';

    // 震动反馈初始化（兼容性处理）
    if (!window.__hapticImpact__) {
        var isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
        function getHaptics() {
            var C = window.Capacitor || {};
            return (C.Plugins && C.Plugins.Haptics) || window.Haptics || C.Haptics || null;
        }
        window.__hapticImpact__ = function(style){
            if (!isNative) {
                // 在非原生环境中，尝试使用Web Vibration API作为fallback
                if (navigator.vibrate) {
                    const patterns = {
                        'Light': 50,
                        'Medium': 100,
                        'Heavy': 200
                    };
                    navigator.vibrate(patterns[style] || 50);
                    console.log(`🔔 振动反馈: ${style} (${patterns[style] || 50}ms)`);
                }
                return;
            }
            var h = getHaptics();
            if (!h) return;
            try { 
                h.impact && h.impact({ style: style }); 
                console.log(`🔔 原生振动反馈: ${style}`);
            } catch(_) {}
        };
    }

    // 月份名称
    const monthNames = [
        '一月', '二月', '三月', '四月', '五月', '六月',
        '七月', '八月', '九月', '十月', '十一月', '十二月'
    ];

    // 当前显示的年月
    let currentYear = new Date().getFullYear();
    let currentMonth = new Date().getMonth();
    let selectedDate = null;

    // DOM 元素
    let yearElement, monthElement, calendarGrid, selectedDateText;
    let prevMonthBtn, nextMonthBtn, backBtn;

    /**
     * 初始化日历
     */
    function initCalendar() {
        // 获取DOM元素
        yearElement = document.getElementById('current-year');
        monthElement = document.getElementById('current-month');
        calendarGrid = document.getElementById('calendar-grid');
        selectedDateText = document.getElementById('selected-date-text');
        prevMonthBtn = document.getElementById('prev-month');
        nextMonthBtn = document.getElementById('next-month');
        backBtn = document.getElementById('back-btn');

        if (!yearElement || !monthElement || !calendarGrid || !selectedDateText) {
            console.error('❌ 日历页面DOM元素未找到');
            return;
        }

        // 绑定事件监听器
        if (prevMonthBtn) {
            prevMonthBtn.addEventListener('click', () => {
                addHapticFeedback('Light');
                navigateMonth(-1);
            });
        }

        if (nextMonthBtn) {
            nextMonthBtn.addEventListener('click', () => {
                addHapticFeedback('Light');
                navigateMonth(1);
            });
        }

        if (backBtn) {
            backBtn.addEventListener('click', () => {
                addHapticFeedback('Medium');
                goBack();
            });
        }

        // 初始化显示
        updateCalendarDisplay();
        
        console.log('✅ 日历初始化完成');
    }

    /**
     * 导航到上/下个月
     */
    function navigateMonth(direction) {
        currentMonth += direction;
        
        if (currentMonth > 11) {
            currentMonth = 0;
            currentYear++;
        } else if (currentMonth < 0) {
            currentMonth = 11;
            currentYear--;
        }
        
        updateCalendarDisplay();
    }

    /**
     * 更新日历显示
     */
    function updateCalendarDisplay() {
        // 更新年月显示
        yearElement.textContent = currentYear;
        monthElement.textContent = monthNames[currentMonth];

        // 生成日历网格
        generateCalendarGrid();
    }

    /**
     * 生成日历网格
     */
    function generateCalendarGrid() {
        calendarGrid.innerHTML = '';

        // 获取当月第一天和最后一天
        const firstDay = new Date(currentYear, currentMonth, 1);
        const lastDay = new Date(currentYear, currentMonth + 1, 0);
        const daysInMonth = lastDay.getDate();
        
        // 获取第一天是星期几 (0=Sunday, 1=Monday, ...)
        let firstDayOfWeek = firstDay.getDay();
        // 转换为 Monday = 0 的格式
        firstDayOfWeek = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

        // 获取上个月的天数
        const prevMonth = new Date(currentYear, currentMonth, 0);
        const daysInPrevMonth = prevMonth.getDate();

        // 获取今天的日期
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() === currentMonth;
        const todayDate = today.getDate();

        // 添加上个月的尾部日期
        for (let i = firstDayOfWeek - 1; i >= 0; i--) {
            const dayNum = daysInPrevMonth - i;
            const dayElement = createDayElement(dayNum, true, false);
            calendarGrid.appendChild(dayElement);
        }

        // 添加当月日期
        for (let day = 1; day <= daysInMonth; day++) {
            const isToday = isCurrentMonth && day === todayDate;
            const dayElement = createDayElement(day, false, isToday);
            calendarGrid.appendChild(dayElement);
        }

        // 添加下个月的开头日期
        const totalCells = calendarGrid.children.length;
        const remainingCells = 42 - totalCells; // 6行 × 7列 = 42个格子
        
        for (let day = 1; day <= remainingCells && day <= 14; day++) {
            const dayElement = createDayElement(day, true, false);
            calendarGrid.appendChild(dayElement);
        }
    }

    /**
     * 创建日期元素
     */
    function createDayElement(dayNum, isOtherMonth, isToday) {
        const dayElement = document.createElement('button');
        dayElement.className = 'calendar-day';
        dayElement.textContent = dayNum;

        if (isOtherMonth) {
            dayElement.classList.add('other-month');
        }

        if (isToday) {
            dayElement.classList.add('today');
        }

        // 判断是否为周末
        const dayIndex = Array.from(calendarGrid.children).length % 7;
        if (dayIndex === 5 || dayIndex === 6) { // Saturday or Sunday
            dayElement.classList.add('weekend');
        }

        // 添加点击事件
        dayElement.addEventListener('click', () => {
            addHapticFeedback('Light');
            selectDate(dayElement, dayNum, isOtherMonth);
        });

        return dayElement;
    }

    /**
     * 选择日期
     */
    function selectDate(dayElement, dayNum, isOtherMonth) {
        // 移除之前选中的状态
        const prevSelected = calendarGrid.querySelector('.selected');
        if (prevSelected) {
            prevSelected.classList.remove('selected');
        }

        // 添加选中状态
        dayElement.classList.add('selected');
        
        // 添加选中振动反馈
        addHapticFeedback('Medium');

        // 计算实际日期
        let actualYear = currentYear;
        let actualMonth = currentMonth;

        if (isOtherMonth) {
            const dayIndex = Array.from(calendarGrid.children).indexOf(dayElement);
            if (dayIndex < 15) { // 上个月
                actualMonth = currentMonth - 1;
                if (actualMonth < 0) {
                    actualMonth = 11;
                    actualYear--;
                }
            } else { // 下个月
                actualMonth = currentMonth + 1;
                if (actualMonth > 11) {
                    actualMonth = 0;
                    actualYear++;
                }
            }
        }

        selectedDate = new Date(actualYear, actualMonth, dayNum);
        
        // 更新选中日期显示
        updateSelectedDateDisplay();
    }

    /**
     * 更新选中日期显示
     */
    function updateSelectedDateDisplay() {
        if (selectedDate) {
            const year = selectedDate.getFullYear();
            const month = selectedDate.getMonth() + 1;
            const day = selectedDate.getDate();
            selectedDateText.textContent = `${year}年${month}月${day}日`;
        } else {
            selectedDateText.textContent = '选择一个日期';
        }
    }

    /**
     * 返回上一页
     */
    function goBack() {
        // 如果有选中的日期，可以传递给父页面
        if (selectedDate && window.opener) {
            // 通知父页面选中的日期
            window.opener.postMessage({
                type: 'dateSelected',
                date: selectedDate.toISOString().split('T')[0]
            }, '*');
        }
        
        // 返回上一页
        if (window.history.length > 1) {
            window.history.back();
        } else {
            // 如果没有历史记录，跳转到日常页面
            const dailyUrl = window.location.href.replace('/src/calendar.html', '/index.html');
            console.log('🔗 返回到日常页面:', dailyUrl);
            window.location.href = dailyUrl;
        }
    }

    /**
     * 添加触觉反馈
     */
    function addHapticFeedback(intensity = 'Light') {
        if (window.__hapticImpact__) {
            window.__hapticImpact__(intensity);
        }
    }

    /**
     * 监听键盘事件
     */
    function initKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    addHapticFeedback('Light');
                    navigateMonth(-1);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    addHapticFeedback('Light');
                    navigateMonth(1);
                    break;
                case 'Escape':
                    e.preventDefault();
                    addHapticFeedback('Medium');
                    goBack();
                    break;
            }
        });
    }

    /**
     * 页面加载完成后初始化
     */
    document.addEventListener('DOMContentLoaded', () => {
        initCalendar();
        initKeyboardNavigation();
        
        // 检查URL参数中是否有指定日期
        const urlParams = new URLSearchParams(window.location.search);
        const dateParam = urlParams.get('date');
        
        if (dateParam) {
            const date = new Date(dateParam);
            if (!isNaN(date.getTime())) {
                currentYear = date.getFullYear();
                currentMonth = date.getMonth();
                updateCalendarDisplay();
                
                // 选中对应日期
                setTimeout(() => {
                    const dayElements = calendarGrid.querySelectorAll('.calendar-day:not(.other-month)');
                    const targetDay = date.getDate();
                    const targetElement = Array.from(dayElements).find(el => 
                        parseInt(el.textContent) === targetDay
                    );
                    if (targetElement) {
                        targetElement.click();
                    }
                }, 100);
                return;
            }
        }
        
        // 默认设置初始选中日期为今天
        setTimeout(() => {
            const todayElement = calendarGrid.querySelector('.today');
            if (todayElement) {
                todayElement.click();
            }
        }, 100);
    });

    // 监听来自父页面的消息
    window.addEventListener('message', (event) => {
        if (event.data.type === 'setDate' && event.data.date) {
            const date = new Date(event.data.date);
            currentYear = date.getFullYear();
            currentMonth = date.getMonth();
            updateCalendarDisplay();
            
            // 选中对应日期
            setTimeout(() => {
                const dayElements = calendarGrid.querySelectorAll('.calendar-day:not(.other-month)');
                const targetDay = date.getDate();
                const targetElement = Array.from(dayElements).find(el => 
                    parseInt(el.textContent) === targetDay
                );
                if (targetElement) {
                    targetElement.click();
                }
            }, 100);
        }
    });

})();
