// 病例记录页面JavaScript功能

// 震动反馈 - 使用统一的HapticManager
// HapticManager已在index.html中全局加载，这里直接使用即可

// 统一的保存状态管理函数
function initSaveState() {
    const saveBtn = document.querySelector('.global-save-btn');
    const spinner = document.getElementById('global-spinner');
    const btnText = saveBtn.querySelector('.btn-text');
    
    return {
        saveBtn,
        spinner,
        btnText,
        originalText: btnText.textContent
    };
}

function showSaveLoading(saveState, loadingText = '保存中...') {
    saveState.saveBtn.disabled = true;
    saveState.btnText.textContent = loadingText;
    saveState.spinner.classList.add('show');
}

function hideSaveLoading(saveState, originalText = null) {
    saveState.saveBtn.disabled = false;
    saveState.btnText.textContent = originalText || saveState.originalText;
    saveState.spinner.classList.remove('show');
}

// 返回上一页
function goBack() {
    try {
        window.__hapticImpact__ && window.__hapticImpact__('Light');
    } catch(_) {}

    // 返回到选项页面（与其他页面保持一致）
    window.location.href = 'options.html';
}

// 图片上传功能
document.addEventListener('DOMContentLoaded', function() {
    const imageUploadBtn = document.getElementById('imageUploadBtn');
    const uploadedImages = document.getElementById('uploadedImages');
    
    // 点击上传按钮触发图片选择
    imageUploadBtn.addEventListener('click', async function() {
        // 点击上传按钮时的震动反馈
        try { window.__hapticImpact__ && window.__hapticImpact__('Light'); } catch(_) {}
        
        try {
            // 检查并请求权限
            const permissions = await window.cameraUtils.checkPermissions();
            if (permissions.camera === 'denied' || permissions.photos === 'denied') {
                const newPermissions = await window.cameraUtils.requestPermissions();
                if (newPermissions.camera === 'denied' || newPermissions.photos === 'denied') {
                    showMessage('需要相机和相册权限才能上传图片', 'error');
                    return;
                }
            }

            // 显示图片选择选项
            await window.cameraUtils.showImageOptions(
                (dataUrl) => {
                    // 成功获取图片
                    handleImageDataUrl(dataUrl);
                },
                (error) => {
                    // 错误处理
                    showMessage('图片选择失败: ' + error, 'error');
                }
            );
        } catch (error) {
            console.error('图片上传失败:', error);
            showMessage('图片上传失败: ' + error.message, 'error');
        }
    });
    
    
    // 处理图片数据URL（新的统一处理函数）
    async function handleImageDataUrl(dataUrl) {
        // 显示压缩进度
        showCompressionProgress('图片处理中...');
        
        try {
            // 将DataURL转换为File对象进行压缩
            const file = await dataURLToFile(dataUrl, 'image.jpg');
            const compressedDataUrl = await compressImagePromise(file, 500);
            
            // 上传图片到服务器
            const imageUrl = await uploadCaseImageToServer(compressedDataUrl, 'case');
            
            hideCompressionProgress();
            
            // 添加新图片到容器（使用服务器返回的URL）
            addImageToContainer(imageUrl, file.name);
            
            // 图片上传成功时的震动反馈
            try { window.__hapticImpact__ && window.__hapticImpact__('Medium'); } catch(_) {}
            
            // 显示上传成功信息
            const originalSizeKB = (file.size / 1024).toFixed(1);
            const compressedSizeKB = ((compressedDataUrl.length * 0.75) / 1024).toFixed(1);
            const compressionRatio = ((1 - compressedDataUrl.length * 0.75 / file.size) * 100).toFixed(1);
            
            showMessage(`图片上传成功！原始: ${originalSizeKB}KB → 压缩后: ${compressedSizeKB}KB (压缩率: ${compressionRatio}%)`, 'success');
        } catch (error) {
            hideCompressionProgress();
            showMessage(`图片处理失败: ${error.message}`, 'error');
        }
    }

    // 处理图片上传（保留用于兼容性）
    function handleImageUpload(files) {
        // 处理所有文件
        Array.from(files).forEach(file => {
            // 检查文件类型
            if (!file.type.startsWith('image/')) {
                showMessage('请选择图片文件', 'error');
                return;
            }
            
            // 检查文件大小（原始文件不超过10MB）
            const maxOriginalSizeMB = 10;
            if (file.size > maxOriginalSizeMB * 1024 * 1024) {
                showMessage(`图片文件过大，请选择小于${maxOriginalSizeMB}MB的图片`, 'error');
                return;
            }
            
            // 显示压缩进度
            showCompressionProgress(file.name);
            
            compressImage(file, (compressedDataUrl) => {
                hideCompressionProgress();
                
                // 添加新图片到容器（不清空现有图片）
                addImageToContainer(compressedDataUrl, file.name);
                
                // 显示压缩成功信息
                const originalSizeKB = (file.size / 1024).toFixed(1);
                const compressedSizeKB = ((compressedDataUrl.length * 0.75) / 1024).toFixed(1);
                const compressionRatio = ((1 - compressedDataUrl.length * 0.75 / file.size) * 100).toFixed(1);
                
                showMessage(`图片 ${file.name} 压缩成功！原始: ${originalSizeKB}KB → 压缩后: ${compressedSizeKB}KB (压缩率: ${compressionRatio}%)`, 'success');
            }, (error) => {
                hideCompressionProgress();
                showMessage(`图片 ${file.name} 压缩失败: ${error}`, 'error');
            }, 500); // 限制为500KB
        });
    }

    // 将DataURL转换为File对象
    function dataURLToFile(dataUrl, filename) {
        return new Promise((resolve, reject) => {
            try {
                const arr = dataUrl.split(',');
                const mime = arr[0].match(/:(.*?);/)[1];
                const bstr = atob(arr[1]);
                let n = bstr.length;
                const u8arr = new Uint8Array(n);
                while (n--) {
                    u8arr[n] = bstr.charCodeAt(n);
                }
                const file = new File([u8arr], filename, { type: mime });
                resolve(file);
            } catch (error) {
                reject(error);
            }
        });
    }

    // 压缩图片的Promise版本
    function compressImagePromise(file, maxSizeKB = 500) {
        return new Promise((resolve, reject) => {
            compressImage(file, resolve, reject, maxSizeKB);
        });
    }

    // 上传病例图片到服务器
    async function uploadCaseImageToServer(imageData, imageType) {
        try {
            // 获取用户身份信息
            const identity = await resolveUserIdentity();
            const user_id = identity.user_id || '';
            const username = identity.username || '';

            if (!user_id) {
                throw new Error('无法获取用户ID');
            }

            // 构建请求数据
            const payload = {
                user_id: user_id,
                username: username,
                image_data: imageData,
                image_type: imageType
            };

            // 获取API基础URL
            var API_BASE = (typeof window !== 'undefined' && window.__API_BASE__) || 'https://app.zdelf.cn';
            if (API_BASE && API_BASE.endsWith('/')) API_BASE = API_BASE.slice(0, -1);

            // 发送上传请求
            const response = await fetch(API_BASE + '/upload_image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || '图片上传失败');
            }

            // 返回完整的图片URL
            const imageUrl = result.data.image_url;
            return imageUrl.startsWith('http') ? imageUrl : API_BASE + imageUrl;
        } catch (error) {
            console.error('上传病例图片失败:', error);
            throw error;
        }
    }
    
    // 显示压缩进度
    function showCompressionProgress(fileName) {
        const progressHtml = `
            <div class="compression-progress" style="
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 20px 30px;
                border-radius: 12px;
                z-index: 10000;
                text-align: center;
                backdrop-filter: blur(8px);
            ">
                <div style="margin-bottom: 12px;">
                    <div style="width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.3); border-top: 3px solid white; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto;"></div>
                </div>
                <div style="font-size: 0.9rem; color: #ccc;">正在压缩图片...</div>
                <div style="font-size: 0.8rem; color: #999; margin-top: 4px;">${fileName}</div>
            </div>
        `;
        
        // 添加动画样式
        if (!document.getElementById('compression-styles')) {
            const style = document.createElement('style');
            style.id = 'compression-styles';
            style.textContent = `
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `;
            document.head.appendChild(style);
        }
        
        document.body.insertAdjacentHTML('beforeend', progressHtml);
    }
    
    // 隐藏压缩进度
    function hideCompressionProgress() {
        const progress = document.querySelector('.compression-progress');
        if (progress) {
            progress.remove();
        }
    }
    
    // 图片压缩函数
    function compressImage(file, callback, errorCallback, maxSizeKB = 500) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();
        
        img.onload = function() {
            try {
                // 计算压缩后的尺寸
                let { width, height } = calculateCompressedSize(img.width, img.height, maxSizeKB);
                
                // 设置canvas尺寸
                canvas.width = width;
                canvas.height = height;
                
                // 绘制压缩后的图片
                ctx.drawImage(img, 0, 0, width, height);
                
                // 尝试不同的质量直到文件大小符合要求
                compressWithQuality(canvas, file.type, maxSizeKB, callback);
            } catch (error) {
                if (errorCallback) {
                    errorCallback(error.message || '图片处理失败');
                }
            }
        };
        
        img.onerror = function() {
            if (errorCallback) {
                errorCallback('图片加载失败');
            }
        };
        
        img.src = URL.createObjectURL(file);
    }
    
    // 计算压缩后的尺寸
    function calculateCompressedSize(originalWidth, originalHeight, maxSizeKB) {
        // 对于500KB限制，设置更小的最大尺寸以确保压缩效果
        const maxWidth = maxSizeKB <= 500 ? 1200 : 1920;
        const maxHeight = maxSizeKB <= 500 ? 900 : 1080;
        
        // 先按最大尺寸限制
        let width = originalWidth;
        let height = originalHeight;
        
        if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.floor(width * ratio);
            height = Math.floor(height * ratio);
        }
        
        // 对于500KB，使用更保守的像素估算
        const estimatedBytesPerPixel = maxSizeKB <= 500 ? 0.3 : 0.2;
        const maxPixels = (maxSizeKB * 1024) / estimatedBytesPerPixel;
        const currentPixels = width * height;
        
        if (currentPixels <= maxPixels) {
            return { width, height };
        }
        
        // 进一步压缩尺寸
        const ratio = Math.sqrt(maxPixels / currentPixels);
        return {
            width: Math.floor(width * ratio),
            height: Math.floor(height * ratio)
        };
    }
    
    // 使用不同质量压缩
    function compressWithQuality(canvas, mimeType, maxSizeKB, callback, quality = null) {
        // 根据目标大小设置起始质量，对于500KB使用更低的质量
        if (quality === null) {
            quality = maxSizeKB <= 500 ? 0.6 : 0.8;
        }
        
        const dataUrl = canvas.toDataURL(mimeType, quality);
        const sizeKB = (dataUrl.length * 0.75) / 1024; // Base64转字节再转KB
        
        console.log(`压缩质量: ${quality.toFixed(1)}, 文件大小: ${sizeKB.toFixed(1)}KB`);
        
        if (sizeKB <= maxSizeKB || quality <= 0.1) {
            callback(dataUrl);
        } else {
            // 降低质量继续压缩，对于500KB使用更大的步长
            const step = maxSizeKB <= 500 ? 0.1 : 0.05;
            compressWithQuality(canvas, mimeType, maxSizeKB, callback, quality - step);
        }
    }

    // 添加图片到容器
    function addImageToContainer(imageSrc, fileName) {
        const imageItem = document.createElement('div');
        imageItem.className = 'uploaded-image-item';
        
        const img = document.createElement('img');
        img.src = imageSrc;
        img.alt = fileName;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-image-btn';
        removeBtn.innerHTML = '×';
        removeBtn.onclick = function() {
            // 删除图片时的震动反馈 - 使用Heavy表示删除操作
            try { window.__hapticImpact__ && window.__hapticImpact__('Heavy'); } catch(_) {}
            
            imageItem.remove();
        };
        
        imageItem.appendChild(img);
        imageItem.appendChild(removeBtn);
        uploadedImages.appendChild(imageItem);
        
        // 添加动画效果
        imageItem.style.opacity = '0';
        imageItem.style.transform = 'scale(0.8)';
        setTimeout(() => {
            imageItem.style.transition = 'all 0.3s ease';
            imageItem.style.opacity = '1';
            imageItem.style.transform = 'scale(1)';
        }, 10);
        
    }
});


// 保存病例记录
function saveCaseRecord() {
    // 点击保存按钮时的震动反馈
    try { window.__hapticImpact__ && window.__hapticImpact__('Light'); } catch(_) {}
    
    const hospital = document.getElementById('hospital').value.trim();
    const department = document.getElementById('department').value.trim();
    const doctor = document.getElementById('doctor').value.trim();
    const diagnosis = document.getElementById('diagnosis').value.trim();
    const prescription = document.getElementById('prescription').value.trim();
    
    // 检查是否有任何数据填写
    if (!hospital && !department && !doctor && !diagnosis && !prescription) {
        showMessage('请至少填写一项信息', 'error');
        return;
    }
    
    // 统一的保存状态管理
    const saveState = initSaveState();
    showSaveLoading(saveState, '保存中...');
    
    // 收集图片数据
    const images = [];
    const imageItems = document.querySelectorAll('.uploaded-image-item img');
    imageItems.forEach(img => {
        images.push(img.src);
    });
    
    // 读取顶部选择的日期与时间
    function getSelectedDate() {
        var el = document.getElementById('record-date-input');
        var val = (el && el.value) ? el.value : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
        var now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    function getSelectedHms() {
        var el = document.getElementById('record-time-input');
        var val = (el && el.value) ? el.value : '';
        if (/^\d{2}:\d{2}(:\d{2})?$/.test(val)) {
            var p = val.split(':');
            return p.length === 2 ? (p[0].padStart(2,'0')+':'+p[1].padStart(2,'0')+':00') : (p[0].padStart(2,'0')+':'+p[1].padStart(2,'0')+':'+String(p[2]||'00').padStart(2,'0'));
        }
        var now = new Date();
        var hh = String(now.getHours()).padStart(2,'0');
        var mm = String(now.getMinutes()).padStart(2,'0');
        var ss = String(now.getSeconds()).padStart(2,'0');
        return hh+':'+mm+':'+ss;
    }
    const __selectedDate = getSelectedDate();
    const __selectedHms = getSelectedHms();

    // 构建病例数据
    const caseData = {
        hospital: hospital,
        department: department,
        doctor: doctor,
        diagnosis: diagnosis,
        prescription: prescription,
        images: images,
        timestamp: __selectedDate + ' ' + __selectedHms,
        id: generateCaseId()
    };
    
    // 保存到本地存储
    saveCaseToStorage(caseData);
    
    // 自动上传到后端（case_files 表）
    (async function uploadAfterSave(){
        try {
            const payload = {
                exportInfo: {
                    exportTime: new Date().toLocaleString('zh-CN', { 
                        timeZone: 'Asia/Shanghai',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    }),
                    recordTime: __selectedDate + ' ' + __selectedHms,
                    version: '1.0',
                    appName: '紫癜精灵',
                    dataType: 'case_record'
                },
                caseData: caseData
            };

            // 获取身份：优先从本地缓存，缺失时调用 /readdata 补全
            const identity = await resolveUserIdentity();
            const user_id = identity.user_id || '';
            const username = identity.username || '';


            var API_BASE = (typeof window !== 'undefined' && window.__API_BASE__) || 'https://app.zdelf.cn';
            if (API_BASE && API_BASE.endsWith('/')) API_BASE = API_BASE.slice(0, -1);

            const resp = await fetch(API_BASE + '/uploadjson/case', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id, username, payload })
            });
            const resJson = await resp.json();
            if (!resp.ok || !resJson.success) {
                console.warn('上传到服务器失败:', resJson.message || '未知错误');
                showMessage('本地保存成功，但服务器同步失败', 'warning');
            } else {
                console.log('病例记录上传成功:', resJson);
                showMessage('病例记录保存成功！', 'success');
                
                // 保存成功时的强震动反馈
                try { window.__hapticImpact__ && window.__hapticImpact__('Heavy'); } catch(_) {}
            }
        } catch (error) {
            console.error('上传到服务器失败:', error);
            showMessage('本地保存成功，但服务器同步失败', 'warning');
        } finally {
            // 恢复按钮状态
            hideSaveLoading(saveState, '保存病例记录');
            
            // 重置表单
            resetForm();
            
            // 延迟2秒后自动跳转到首页（无论上传是否成功）
            setTimeout(() => {
                window.location.href = '../index.html';
            }, 2000);
        }
    })();
}

// 保存到本地存储
function saveCaseToStorage(caseData) {
    let cases = JSON.parse(localStorage.getItem('caseRecords') || '[]');
    cases.unshift(caseData); // 添加到开头
    localStorage.setItem('caseRecords', JSON.stringify(cases));
}

// 生成病例ID
function generateCaseId() {
    return 'case_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// 重置表单
function resetForm() {
    document.getElementById('hospital').value = '';
    document.getElementById('department').value = '';
    document.getElementById('doctor').value = '';
    document.getElementById('diagnosis').value = '';
    document.getElementById('prescription').value = '';
    
    // 清空图片
    const uploadedImages = document.getElementById('uploadedImages');
    uploadedImages.innerHTML = '';
}

// 显示消息提示
function showMessage(message, type = 'info') {
    // 创建消息元素
    const messageEl = document.createElement('div');
    messageEl.className = `message-toast message-${type}`;
    messageEl.textContent = message;
    
    // 根据类型选择颜色
    let backgroundColor;
    switch(type) {
        case 'success':
            backgroundColor = '#4caf50';
            break;
        case 'error':
            backgroundColor = '#f44336';
            break;
        case 'warning':
            backgroundColor = '#ff9800';
            break;
        default:
            backgroundColor = '#2196f3';
    }
    
    // 添加样式
    messageEl.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: ${backgroundColor};
        color: white;
        padding: 16px 24px;
        border-radius: 8px;
        font-size: 1em;
        font-weight: 500;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        animation: messageSlideIn 0.3s ease-out;
        max-width: 90vw;
        word-wrap: break-word;
    `;
    
    // 添加动画样式
    const style = document.createElement('style');
    style.textContent = `
        @keyframes messageSlideIn {
            from {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.8);
            }
            to {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
        }
        @keyframes messageSlideOut {
            from {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            to {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.8);
            }
        }
    `;
    document.head.appendChild(style);
    
    // 添加到页面
    document.body.appendChild(messageEl);
    
    // 自动移除
    setTimeout(() => {
        messageEl.style.animation = 'messageSlideOut 0.3s ease-in';
        setTimeout(() => {
            if (messageEl.parentNode) {
                messageEl.parentNode.removeChild(messageEl);
            }
            if (style.parentNode) {
                style.parentNode.removeChild(style);
            }
        }, 300);
    }, 3000);
}

// 解析用户身份：本地缓存优先，不足则通过 /readdata 查询
async function resolveUserIdentity() {
    // 1) 本地 user_profile
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('user_profile') || 'null'); } catch(_) { cached = null; }

    let user_id = '';
    let username = '';

    if (cached) {
        user_id = (cached.user_id || cached.id || '').toString();
        // 忽略缓存中的 username，统一通过 user_id 查询服务端获取
    }

    // 2) 与 me.js 保持一致：优先从 localStorage/sessionStorage 读取 userId/UserID
    try {
        const storedId =
          localStorage.getItem('userId') ||
          sessionStorage.getItem('userId') ||
          localStorage.getItem('UserID') ||
          sessionStorage.getItem('UserID') || '';
        if (storedId) {
            user_id = String(storedId);
        }
    } catch(_) {}

    // 3) 仅当存在 user_id 时，通过 /readdata 使用 user_id 查询 username
    if (user_id) {
        try {
            var API_BASE = (typeof window !== 'undefined' && window.__API_BASE__) || 'https://app.zdelf.cn';
            if (API_BASE && API_BASE.endsWith('/')) API_BASE = API_BASE.slice(0, -1);

            const body = { table_name: 'users', user_id: String(user_id) };
            const res = await fetch(API_BASE + '/readdata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const json = await res.json();
            if (res.ok && json && json.success && Array.isArray(json.data) && json.data.length > 0) {
                const rec = json.data[0] || {};
                username = (rec.username || '').toString();

                // 回写本地（不覆盖现有 userId 键，仅更新 user_profile 和 username）
                try {
                    const merged = Object.assign({}, cached || {}, { user_id, username });
                    localStorage.setItem('user_profile', JSON.stringify(merged));
                    if (username) localStorage.setItem('username', username);
                } catch(_) {}

                return { user_id, username };
            }
        } catch (e) {
            console.warn('resolveUserIdentity 通过 user_id 调用 /readdata 失败:', e);
        }
        // 查询失败时，至少返回 user_id，username 留空
        return { user_id, username: '' };
    }

    // 兜底为空
    return { user_id: '', username: '' };
}

// 页面加载完成后的初始化
document.addEventListener('DOMContentLoaded', function() {
    // 添加页面加载动画
    document.body.style.opacity = '0';
    setTimeout(() => {
        document.body.style.transition = 'opacity 0.5s ease';
        document.body.style.opacity = '1';
    }, 100);
    
    // 初始化日期和时间选择器为当前日期和时间
    const dateInput = document.getElementById('record-date-input');
    const timeInput = document.getElementById('record-time-input');
    
    if (dateInput) {
        const today = new Date();
        const dateString = today.toISOString().slice(0, 10);
        dateInput.value = dateString;
    }
    
    if (timeInput) {
        const now = new Date();
        const timeString = now.toTimeString().slice(0, 8);
        timeInput.value = timeString;
    }
    
    // 使用输入框增强模块（优化键盘弹出和震动体验）
    if (window.InputEnhancement) {
        // 自动增强所有输入框，配置为聚焦时震动
        window.InputEnhancement.autoEnhance({
            hapticDelay: 50,        // 延迟震动，不干扰键盘
            hapticOnBlur: true,     // 输入完成时震动
            hapticOnInput: false    // 输入过程不震动
        });
        console.log('病例记录 - 输入框增强已启用');
    } else {
        console.warn('病例记录 - InputEnhancement 模块未加载');
    }
    
    // 为输入框添加焦点效果
    const inputs = document.querySelectorAll('.form-input');
    inputs.forEach(input => {
        input.addEventListener('focus', function() {
            this.parentElement.style.transform = 'translateY(-1px)';
        });
        
        input.addEventListener('blur', function() {
            this.parentElement.style.transform = 'translateY(0)';
        });
    });
});
