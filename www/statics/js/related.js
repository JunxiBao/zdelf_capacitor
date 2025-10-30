(function() {
  // 与 calendar 一致的触觉反馈入口
  function addHapticFeedback(intensity = 'Light') {
    if (window.__hapticImpact__) {
      window.__hapticImpact__(intensity);
    } else if (window.HapticManager) {
      try { window.HapticManager.impact(intensity); } catch(_) {}
    }
  }
  function getApiBase() {
    try {
      const base = (window.__API_BASE__ || window.API_BASE || 'https://app.zdelf.cn').trim();
      return base.replace(/\/$/, '');
    } catch (_) { return 'https://app.zdelf.cn'; }
  }

  function normalizeUrl(u) {
    if (!u) return '';
    try {
      const s = String(u).trim();
      if (!s) return '';
      if (/^https?:\/\//i.test(s)) return s;
      return getApiBase() + s;
    } catch (_) { return ''; }
  }

  async function resolveUserIdentity() {
    let user_id = '';
    try {
      user_id = localStorage.getItem('userId') || sessionStorage.getItem('userId') || '';
    } catch(_) {}
    return { user_id };
  }

  function formatTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch(_) { return iso; }
  }

  function initials(name){
    if (!name) return '?';
    return (name.trim()[0] || '?').toUpperCase();
  }

  function render(items, currentUserId) {
    const list = document.getElementById('relatedList');
    const skeleton = document.getElementById('relatedSkeleton');
    const empty = document.getElementById('relatedEmpty');
    skeleton.style.display = 'none';
    list.innerHTML = '';
    document.getElementById('relatedCount').textContent = items ? items.length : 0;
    if (!items || !items.length) {
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    items.forEach((it, idx) => {
      const isMyPost = it.post_user_id === currentUserId;
      const isReplyToMe = !!it.parent_comment_id;
      const badgeText = isReplyToMe ? '回复了你' : (isMyPost ? '评论帖子' : '相关更新');

      const div = document.createElement('div');
      div.className = 'related-item enter-anim';
      div.style.animationDelay = (Math.min(idx, 8) * 60) + 'ms';
      const url = normalizeUrl(it.avatar_url);
      const avatarHTML = (url) ? `
        <div class="avatar-slot">
          <div class="avatar avatar-fallback">${initials(it.username || '匿')}</div>
          <img class="avatar-img" src="${url}" alt="avatar"
               onload="this.previousElementSibling.style.display='none'"
               onerror="this.style.display='none'; this.previousElementSibling.style.display='inline-flex'" />
        </div>
      ` : `
        <div class="avatar">${initials(it.username || '匿')}</div>
      `;
      div.innerHTML = `
        <div class="row">
          ${avatarHTML}
          <div>
            <div class="meta">
              <span class="badge">${badgeText}</span>
              <span>${it.username || '匿名用户'}</span>
              <span>•</span>
              <span>${formatTime(it.created_at)}</span>
            </div>
            <div class="text">${(it.text || '').replace(/</g,'&lt;')}</div>
          </div>
        </div>
      `;
      list.appendChild(div);
    });

    // Reveal on scroll
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('enter-anim');
          io.unobserve(e.target);
        }
      })
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
    list.querySelectorAll('.related-item').forEach(el => io.observe(el));
  }

  async function main() {
    const { user_id } = await resolveUserIdentity();
    const API_BASE = getApiBase();
    const resp = await fetch(API_BASE + '/square/related', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_user_id: user_id, limit: 500 })
    });
    const json = await resp.json();
    if (!json.success) throw new Error(json.message || '加载失败');
    // 过滤“自己回复自己”，并按时间倒序（最新在上）
    const rows = Array.isArray(json.data) ? json.data
      .filter(it => it && it.user_id !== user_id)
      .sort((a, b) => {
        const ta = a && a.created_at ? Date.parse(a.created_at) : 0;
        const tb = b && b.created_at ? Date.parse(b.created_at) : 0;
        return tb - ta;
      }) : [];
    render(rows, user_id);
  }

  document.addEventListener('DOMContentLoaded', () => {
    // 与其他页面一致：进入轻触感
    addHapticFeedback('Light');
    const refresh = () => main().catch(err => {
      document.getElementById('relatedSkeleton').style.display = 'none';
      const empty = document.getElementById('relatedEmpty');
      empty.style.display = '';
      empty.querySelector('h3').textContent = '加载失败，请稍后重试';
      console.error('[related] load error', err);
    });

    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      addHapticFeedback('Medium');
      const app = document.querySelector('main.app');
      if (app) app.classList.add('refreshing');
      document.getElementById('relatedEmpty').style.display = 'none';
      document.getElementById('relatedList').innerHTML = '';
      document.getElementById('relatedSkeleton').style.display = '';
      refresh().finally(() => { if (app) app.classList.remove('refreshing'); });
    });

    // Back button haptic feedback (align with calendar)
    const backBtn = document.querySelector('.back-btn');
    if (backBtn) {
      // Avoid double navigation if inline onclick exists
      try { backBtn.removeAttribute('onclick'); } catch(_) {}
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        addHapticFeedback('Medium');
        history.back();
      });
    }

    refresh();
  });
})();


