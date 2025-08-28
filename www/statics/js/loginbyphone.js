/**
 * SMS login frontend controller (CN mainland) — works with /sms/send and /sms/verify
 * - Auto-detects backend API base (direct :5000 or reverse-proxy path)
 * - Normalizes phone to E.164 (+86) and validates 11-digit segments
 * - Minimal UI feedback: toast, loading overlay, 60s resend countdown
 *
 * 短信登录前端控制器（中国大陆）— 对接 /sms/send 与 /sms/verify
 * - 自动探测后端 API 基址（直连 :5000 或反向代理）
 * - 统一手机号为 E.164（+86），校验 11 位
 * - 轻量交互：弹窗、加载遮罩、60s 重发倒计时
 */
(function () {
  const phone = document.getElementById("phone");
  const code = document.getElementById("smsCode");
  const sendBtn = document.getElementById("sendCodeBtn");
  const loginBtn = document.getElementById("smsLoginBtn");
  const popup = document.getElementById("popup");
  const popupText = document.getElementById("popupText");

  // Ensure loading overlay exists (same as register.js)
  let loadingOverlay = document.getElementById("loading-overlay");
  if (!loadingOverlay) {
    loadingOverlay = document.createElement("div");
    loadingOverlay.id = "loading-overlay";
    loadingOverlay.innerHTML =
      '<div class="spinner" role="status" aria-live="polite" aria-label="正在加载"></div>';
    document.body.appendChild(loadingOverlay);
  }
  (function ensureStyle() {
    var id = "register-runtime-style";
    if (document.getElementById(id)) return;
    var style = document.createElement("style");
    style.id = id;
    style.textContent = `
#loading-overlay{position:fixed;inset:0;width:100%;height:100%;background:rgba(255,255,255,0.8);z-index:9999;display:none;align-items:center;justify-content:center;transition:background .3s ease}
@media (prefers-color-scheme: dark){#loading-overlay{background:rgba(0,0,0,0.6)}.spinner{border:6px solid #444;border-top-color:#b197fc}}
.spinner{width:50px;height:50px;border:6px solid #ccc;border-top-color:#7b2cbf;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(style);
  })();

  function showLoading() {
    loadingOverlay.style.display = "flex";
  }
  function hideLoading() {
    loadingOverlay.style.display = "none";
  }

  // 同源请求，交给 Nginx 反代；如需覆盖，可提前设置 window.__API_BASE__
  const API_BASE = "";
  const BASE = (typeof window !== "undefined" && window.__API_BASE__) || API_BASE;
  const API_SEND = `${BASE}/sms/send`;
  const API_VERIFY = `${BASE}/sms/verify`;

  /** Show a lightweight toast popup (falls back to alert if popup DOM missing). */
  function toast(text) {
    if (!popup || !popupText) return alert(text);
    popupText.textContent = text;
    popup.classList.add("show");
    setTimeout(() => popup.classList.remove("show"), 1800);
  }

  /** Validate CN mainland mobile: 11 digits starting with 1, allows +86/86 prefixes. */
  function validPhone(v) {
    const raw = (v || "").trim().replace(/\s|-/g, "");
    let num = raw;
    if (raw.startsWith("+86")) num = raw.slice(3);
    else if (raw.startsWith("86")) num = raw.slice(2);
    return /^1[3-9]\d{9}$/.test(num);
  }

  /** Normalize to E.164 (+86XXXXXXXXXXX) regardless of input prefix. */
  function normalizeE164(v) {
    const raw = (v || "").trim().replace(/\s|-/g, "");
    if (raw.startsWith("+86")) return raw;
    if (raw.startsWith("86")) return "+" + raw;
    return "+86" + raw;
  }

  let ticking = false;
  let remain = 60;
  let timer = null;

  function setSendState(disabled) {
    sendBtn.disabled = disabled;
    sendBtn.textContent = disabled
      ? "重新发送 (" + remain + "s)"
      : "获取验证码";
  }

  /** 60s resend cooldown (UI only). */
  function startCountdown() {
    ticking = true;
    remain = 60;
    setSendState(true);
    timer = setInterval(() => {
      remain -= 1;
      if (remain <= 0) {
        clearInterval(timer);
        ticking = false;
        setSendState(false);
      } else {
        setSendState(true);
      }
    }, 1000);
  }

  sendBtn.addEventListener("click", async () => {
    const v = phone.value;
    if (!validPhone(v)) {
      toast("请填写有效手机号");
      return;
    }

    // 视觉反馈
    sendBtn.animate(
      [
        { transform: "translateY(-50%) scale(1)" },
        { transform: "translateY(-50%) scale(0.96)" },
        { transform: "translateY(-50%) scale(1)" },
      ],
      { duration: 140, easing: "ease-out" }
    );

    const normalized = normalizeE164(v);

    try {
      sendBtn.classList.add("loading");
      const res = await fetch(API_SEND, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: normalized }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.success === false) {
        const msg = (data && data.message) || "发送失败，请稍后重试";
        toast(msg);
        return;
      }
      toast((data && data.message) || "验证码已发送");
      if (!ticking) startCountdown();
    } catch (e) {
      toast("网络异常，请检查连接");
    } finally {
      sendBtn.classList.remove("loading");
    }
  });

  loginBtn.addEventListener("click", async () => {
    const v = phone.value;
    const c = (code.value || "").trim();

    if (!validPhone(v)) {
      toast("请填写有效手机号");
      return;
    }
    if (!/^\d{6}$/.test(c)) {
      toast("请填写6位验证码");
      return;
    }

    const normalized = normalizeE164(v);

    showLoading();
    try {
      loginBtn.classList.add("loading");
      const res = await fetch(API_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: normalized, code: c }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.success === false) {
        const msg = (data && data.message) || "验证码校验失败";
        toast(msg);
        return;
      }

      // 校验通过：如果返回了 user_id/userId 则写入本地并进入首页；否则提示错误
      try {
        var uid = data && (data.user_id || data.userId);
        if (uid) {
          localStorage.setItem("loggedInPhone", normalized);
          localStorage.setItem("loggedInUserId", uid);
          localStorage.setItem("userId", uid);
          toast("登录成功，正在进入...");
          setTimeout(function () {
            // 相对路径更稳：避免不同部署子路径下 “/index.html” 指向错误
            window.location.href = "/index.html";
          }, 300);
        } else {
          toast("未获取到用户ID，请先注册或稍后重试");
        }
      } catch (_) {}
    } catch (e) {
      toast("网络异常，请检查连接");
    } finally {
      loginBtn.classList.remove("loading");
      hideLoading();
    }
  });
})();
