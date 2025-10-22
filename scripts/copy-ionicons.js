#!/usr/bin/env node

/**
 * 复制Ionicons到本地静态资源目录
 * 用于构建时自动处理图标库
 */

const fs = require('fs');
const path = require('path');

function copyIonicons() {
  const sourceDir = path.join(__dirname, '../node_modules/ionicons/dist');
  const targetDir = path.join(__dirname, '../www/statics/libs/ionicons');
  
  console.log('📦 开始复制Ionicons到本地...');
  console.log('源目录:', sourceDir);
  console.log('目标目录:', targetDir);
  
  // 确保目标目录存在
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log('✅ 创建目标目录');
  }
  
  // 复制文件
  try {
    // 使用rsync或cp命令复制文件
    const { execSync } = require('child_process');
    
    // 在macOS/Linux上使用cp命令
    if (process.platform === 'darwin' || process.platform === 'linux') {
      execSync(`cp -r "${sourceDir}"/* "${targetDir}/"`, { stdio: 'inherit' });
    } else {
      // 在Windows上使用xcopy
      execSync(`xcopy "${sourceDir}\\*" "${targetDir}\\" /E /I /Y`, { stdio: 'inherit' });
    }
    
    console.log('✅ Ionicons复制完成');
    
    // 验证关键文件是否存在
    const keyFiles = [
      'ionicons.js',
      'ionicons/ionicons.esm.js'
    ];
    
    keyFiles.forEach(file => {
      const filePath = path.join(targetDir, file);
      if (fs.existsSync(filePath)) {
        console.log(`✅ 验证文件存在: ${file}`);
      } else {
        console.log(`❌ 文件缺失: ${file}`);
      }
    });
    
  } catch (error) {
    console.error('❌ 复制Ionicons失败:', error.message);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  copyIonicons();
}

module.exports = copyIonicons;
