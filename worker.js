/**
 * Cloudflare Worker: Site Monitor (CRUD + persistent history)
 * 功能：登录监控 + 添加站点 + 删除站点 + 历史趋势持久化
 */
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

// ================= 默认配置 =================
// 注意：LOGIN_PASSWORD 必须通过环境变量设置，无默认值
const DEFAULT_GITHUB_URL = "https://github.com/";
const DEFAULT_BLOG_URL = "";
const DEFAULT_MONITOR_NAME = "站点监测控制台";
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const KV_KEY_SITES = "config_list_v1";
const KV_KEY_HISTORY = "status_history_v1";
const KV_KEY_RATE_LIMIT = "rate_limit_v1";
const KV_KEY_LAST_ALERT = "last_alert_v1";

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 300; // 5分钟
const PROBE_TIMEOUT_MS = 3000;
const PROBE_BATCH_SIZE = 10;
const MAX_HISTORY_POINTS = 30;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 同一站点告警冷却 10 分钟

// 默认站点列表（仅当 KV 为空时使用一次）
const DEFAULT_SITES = [
  { url: "https://www.baidu.com", name: "百度" },
  { url: "https://www.google.com", name: "谷歌" },
];

// ================= 工具函数 =================

function getRuntimeConfig(env) {
  const password = env.LOGIN_PASSWORD;
  if (!password || typeof password !== "string" || !password.trim()) {
    throw new Error("LOGIN_PASSWORD 环境变量未设置，请先在 Cloudflare Workers 设置中配置登录密码");
  }
  return {
    loginPassword: password.trim(),
    githubUrl: String(env.GITHUB_URL || DEFAULT_GITHUB_URL),
    blogUrl: String(env.BLOG_URL || DEFAULT_BLOG_URL),
    monitorName: String(env.MONITOR_NAME || DEFAULT_MONITOR_NAME),
    refreshIntervalMs: normalizeRefreshInterval(env.REFRESH_INTERVAL_MS),
  };
}

function normalizeRefreshInterval(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_INTERVAL_MS;
  if (n < 10_000 || n > 86_400_000) return DEFAULT_REFRESH_INTERVAL_MS;
  return Math.floor(n);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

// ================= 登录限流 =================
async function checkRateLimit(env, clientIp) {
  if (!hasStatusKV(env)) return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
  const key = `${KV_KEY_RATE_LIMIT}:${clientIp}`;
  try {
    const raw = await env.STATUS.get(key);
    if (!raw) return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
    const record = JSON.parse(raw);
    const now = Date.now();
    if (now - record.ts < LOGIN_LOCKOUT_SECONDS * 1000) {
      if (record.attempts >= LOGIN_MAX_ATTEMPTS) {
        const waitSec = Math.ceil((LOGIN_LOCKOUT_SECONDS * 1000 - (now - record.ts)) / 1000);
        return { allowed: false, remaining: 0, waitSec };
      }
      return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS - record.attempts };
    }
    return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
  } catch {
    return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
  }
}

async function recordFailedLogin(env, clientIp) {
  if (!hasStatusKV(env)) return;
  const key = `${KV_KEY_RATE_LIMIT}:${clientIp}`;
  try {
    const raw = await env.STATUS.get(key);
    let record = { attempts: 0, ts: Date.now() };
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < LOGIN_LOCKOUT_SECONDS * 1000) {
        record = { attempts: parsed.attempts + 1, ts: parsed.ts };
      }
    } else {
      record = { attempts: 1, ts: Date.now() };
    }
    await env.STATUS.put(key, JSON.stringify(record));
  } catch { /* ignore */ }
}

async function clearRateLimit(env, clientIp) {
  if (!hasStatusKV(env)) return;
  const key = `${KV_KEY_RATE_LIMIT}:${clientIp}`;
  try {
    await env.STATUS.delete(key);
  } catch { /* ignore */ }
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    || "unknown";
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function textResponse(text, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(text, {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}

function errorResponse(message, status = 400, extra = {}) {
  return jsonResponse({ success: false, message, ...extra }, status);
}

function parseCookies(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookiePairs = cookieHeader.split(";");
  const cookieMap = {};
  for (const pair of cookiePairs) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (key) cookieMap[key] = value;
  }
  return cookieMap;
}

function checkAuth(request, loginPassword) {
  const cookies = parseCookies(request);
  const token = cookies.auth_password;
  if (!token) return false;
  try {
    return decodeURIComponent(token) === loginPassword;
  } catch {
    return false;
  }
}

function getLoginCookie(password) {
  const encoded = encodeURIComponent(password);
  return `auth_password=${encoded}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`;
}

function getLogoutCookie() {
  return "auth_password=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

function hasStatusKV(env) {
  return Boolean(env && env.STATUS && typeof env.STATUS.get === "function" && typeof env.STATUS.put === "function");
}

function normalizeSiteUrl(input) {
  try {
    const parsed = new URL(String(input).trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    let normalized = parsed.toString();
    if (parsed.pathname === "/" && !parsed.search) {
      normalized = normalized.replace(/\/$/, "");
    }
    return normalized;
  } catch {
    return null;
  }
}

function normalizeSiteEntry(rawSite) {
  if (!rawSite || typeof rawSite !== "object") return null;
  const normalizedUrl = normalizeSiteUrl(rawSite.url);
  if (!normalizedUrl) return null;

  const rawName = typeof rawSite.name === "string" ? rawSite.name.trim() : "";
  let fallbackName = "未命名站点";
  try {
    fallbackName = new URL(normalizedUrl).hostname;
  } catch {
    // ignore
  }

  const name = (rawName || fallbackName).slice(0, 80);
  return { name, url: normalizedUrl };
}

function sanitizeSites(inputList) {
  if (!Array.isArray(inputList)) return [];
  const seen = new Set();
  const output = [];
  for (const rawSite of inputList) {
    const site = normalizeSiteEntry(rawSite);
    if (!site) continue;
    if (seen.has(site.url)) continue;
    seen.add(site.url);
    output.push(site);
  }
  return output;
}

function sanitizeHistoryMap(rawMap) {
  const cleanMap = {};
  if (!rawMap || typeof rawMap !== "object") return cleanMap;

  for (const [rawUrl, rawHistory] of Object.entries(rawMap)) {
    const siteUrl = normalizeSiteUrl(rawUrl);
    if (!siteUrl || !Array.isArray(rawHistory)) continue;
    const normalizedHistory = rawHistory
      .map((value) => (value === 1 ? 1 : 0))
      .slice(-MAX_HISTORY_POINTS);
    cleanMap[siteUrl] = normalizedHistory;
  }

  return cleanMap;
}

function appendHistory(historyMap, siteUrl, isUp) {
  const prev = Array.isArray(historyMap[siteUrl]) ? historyMap[siteUrl].slice(-(MAX_HISTORY_POINTS - 1)) : [];
  const next = [...prev, isUp ? 1 : 0];
  historyMap[siteUrl] = next;
  return next;
}

function cleanupHistory(historyMap, sites) {
  const validUrls = new Set(sites.map((site) => site.url));
  for (const key of Object.keys(historyMap)) {
    if (!validUrls.has(key)) delete historyMap[key];
  }
}

// ================= KV 读写 =================

async function getSites(env) {
  const fallbackSites = sanitizeSites(DEFAULT_SITES);
  if (!hasStatusKV(env)) return fallbackSites;

  try {
    const raw = await env.STATUS.get(KV_KEY_SITES);
    if (!raw) {
      await env.STATUS.put(KV_KEY_SITES, JSON.stringify(fallbackSites));
      return fallbackSites;
    }

    const parsed = JSON.parse(raw);
    const sites = sanitizeSites(parsed);
    if (!sites.length) {
      await env.STATUS.put(KV_KEY_SITES, JSON.stringify(fallbackSites));
      return fallbackSites;
    }

    return sites;
  } catch (error) {
    console.error("Read sites from KV failed:", error);
    return fallbackSites;
  }
}

async function saveSites(env, sites) {
  if (!hasStatusKV(env)) return false;
  try {
    const normalized = sanitizeSites(sites);
    await env.STATUS.put(KV_KEY_SITES, JSON.stringify(normalized));
    return true;
  } catch (error) {
    console.error("Save sites failed:", error);
    return false;
  }
}

async function getHistoryMap(env) {
  if (!hasStatusKV(env)) return {};
  try {
    const raw = await env.STATUS.get(KV_KEY_HISTORY);
    if (!raw) return {};
    return sanitizeHistoryMap(JSON.parse(raw));
  } catch (error) {
    console.error("Read history from KV failed:", error);
    return {};
  }
}

async function saveHistoryMap(env, historyMap) {
  if (!hasStatusKV(env)) return false;
  try {
    const cleaned = sanitizeHistoryMap(historyMap);
    await env.STATUS.put(KV_KEY_HISTORY, JSON.stringify(cleaned));
    return true;
  } catch (error) {
    console.error("Save history failed:", error);
    return false;
  }
}

// ================= 监控逻辑 =================

const MONITOR_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; CF-SiteMonitor/1.1)",
};

function isReachableStatus(statusCode) {
  return statusCode >= 200 && statusCode < 500;
}

async function fetchWithTimeout(url, options, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeSite(siteUrl) {
  try {
    const headResp = await fetchWithTimeout(
      siteUrl,
      { method: "HEAD", headers: MONITOR_HEADERS },
      PROBE_TIMEOUT_MS
    );
    if (isReachableStatus(headResp.status)) return true;
  } catch {
    // HEAD 失败后回退 GET
  }

  try {
    const getResp = await fetchWithTimeout(
      siteUrl,
      {
        method: "GET",
        headers: { ...MONITOR_HEADERS, Range: "bytes=0-0" },
      },
      PROBE_TIMEOUT_MS + 1000
    );
    return isReachableStatus(getResp.status);
  } catch {
    return false;
  }
}

async function getStatusResults(env) {
  const sites = await getSites(env);
  const historyMap = await getHistoryMap(env);
  const nextHistoryMap = { ...historyMap };
  const results = [];

  for (let i = 0; i < sites.length; i += PROBE_BATCH_SIZE) {
    const batch = sites.slice(i, i + PROBE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(async (site) => {
        const isUp = await probeSite(site.url);
        return { site, isUp };
      })
    );

    for (const item of settled) {
      if (item.status !== "fulfilled") continue;
      const { site, isUp } = item.value;
      const history = appendHistory(nextHistoryMap, site.url, isUp);
      results.push({
        url: site.url,
        name: site.name,
        isUp,
        history,
      });
    }
  }

  cleanupHistory(nextHistoryMap, sites);
  await saveHistoryMap(env, nextHistoryMap);
  await checkAndAlert(env, results, historyMap);

  return results;
}

// ================= Webhook 告警 =================
async function sendWebhookAlert(env, site, isUp) {
  const webhookUrl = env.WEBHOOK_URL;
  if (!webhookUrl || typeof webhookUrl !== "string") return;

  const key = `${KV_KEY_LAST_ALERT}:${site.url}`;
  const now = Date.now();

  try {
    const lastAlert = await env.STATUS.get(key);
    if (lastAlert) {
      const { ts } = JSON.parse(lastAlert);
      if (now - ts < ALERT_COOLDOWN_MS) return; // 冷却期内不重复告警
    }
  } catch { /* ignore */ }

  try {
    const payload = {
      event: isUp ? "site_recovered" : "site_down",
      site: { name: site.name, url: site.url },
      timestamp: new Date().toISOString(),
      message: isUp
        ? `✅ 站点已恢复：${site.name} (${site.url})`
        : `❌ 站点离线：${site.name} (${site.url})`,
    };

    const webhookTarget = new URL(webhookUrl);
    await fetchWithTimeout(
      webhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "CF-SiteMonitor/1.2",
        },
        body: JSON.stringify(payload),
      },
      5000
    );

    await env.STATUS.put(key, JSON.stringify({ ts: now }));
  } catch (error) {
    console.error("Webhook alert failed:", error);
  }
}

async function checkAndAlert(env, results, prevHistoryMap) {
  const webhookUrl = env.WEBHOOK_URL;
  if (!webhookUrl) return;

  for (const result of results) {
    const prev = prevHistoryMap[result.url];
    const wasUp = prev && prev.length > 0 && prev[prev.length - 1] === 1;
    if (wasUp === false && result.isUp === true) {
      await sendWebhookAlert(env, result, true);
    } else if (wasUp === true && result.isUp === false) {
      await sendWebhookAlert(env, result, false);
    }
  }
}

// ================= 主请求处理 =================

async function handleRequest(request, env, ctx) {
  let config;
  try {
    config = getRuntimeConfig(env);
  } catch (err) {
    return htmlResponse(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;color:#333">
      <h2 style="color:#dc2626">配置错误</h2>
      <p>${escapeHtml(err.message)}</p>
    </body></html>`, 500);
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // 1) 登录
  if (path === "/api/login" && request.method === "POST") {
    const clientIp = getClientIp(request);
    const rateLimit = await checkRateLimit(env, clientIp);
    if (!rateLimit.allowed) {
      return errorResponse(`登录过于频繁，请 ${rateLimit.waitSec} 秒后重试`, 429);
    }

    const body = await readJsonBody(request);
    if (!body || typeof body.password !== "string") {
      return errorResponse("请求体格式错误", 400);
    }
    if (body.password !== config.loginPassword) {
      await recordFailedLogin(env, clientIp);
      return errorResponse(`密码错误，还剩 ${rateLimit.remaining - 1} 次尝试机会`, 401);
    }
    await clearRateLimit(env, clientIp);
    return jsonResponse(
      { success: true },
      200,
      { "Set-Cookie": getLoginCookie(config.loginPassword) }
    );
  }

  // 2) 登出
  if (path === "/api/logout" && request.method === "POST") {
    return jsonResponse(
      { success: true },
      200,
      { "Set-Cookie": getLogoutCookie() }
    );
  }

  // 3) 认证
  const authed = checkAuth(request, config.loginPassword);
  if (!authed && path === "/") {
    return htmlResponse(getLoginHTML(config.monitorName));
  }
  if (!authed) {
    if (path.startsWith("/api/")) return errorResponse("Unauthorized", 401);
    return textResponse("Unauthorized", 401);
  }

  // 4) API: 获取站点列表（便于后续扩展）
  if (path === "/api/sites" && request.method === "GET") {
    const sites = await getSites(env);
    return jsonResponse({ success: true, sites });
  }

  // 5) API: 添加站点
  if (path === "/api/add-site" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body) return errorResponse("请求体格式错误", 400);
    if (typeof body.name !== "string" || !body.name.trim()) {
      return errorResponse("站点名称不能为空", 400);
    }

    const newSite = normalizeSiteEntry(body);
    if (!newSite) return errorResponse("URL 无效，仅支持 http/https", 400);

    const currentSites = await getSites(env);
    if (currentSites.some((site) => site.url === newSite.url)) {
      return errorResponse("站点已存在", 409);
    }

    currentSites.push(newSite);
    const ok = await saveSites(env, currentSites);
    if (!ok) return errorResponse("保存站点失败", 500);

    const historyMap = await getHistoryMap(env);
    if (!historyMap[newSite.url]) historyMap[newSite.url] = [];
    await saveHistoryMap(env, historyMap);

    return jsonResponse({ success: true, site: newSite });
  }

  // 6) API: 删除站点
  if (path === "/api/del-site" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body) return errorResponse("请求体格式错误", 400);

    const normalizedUrl = normalizeSiteUrl(body.url);
    if (!normalizedUrl) return errorResponse("URL 无效", 400);

    const currentSites = await getSites(env);
    const newSites = currentSites.filter((site) => site.url !== normalizedUrl);
    if (newSites.length === currentSites.length) {
      return errorResponse("站点不存在", 404);
    }

    const ok = await saveSites(env, newSites);
    if (!ok) return errorResponse("删除站点失败", 500);

    const historyMap = await getHistoryMap(env);
    delete historyMap[normalizedUrl];
    await saveHistoryMap(env, historyMap);

    return jsonResponse({ success: true });
  }

  // 6.5) API: 编辑站点
  if (path === "/api/edit-site" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body) return errorResponse("请求体格式错误", 400);

    const oldUrl = normalizeSiteUrl(body.oldUrl);
    if (!oldUrl) return errorResponse("原 URL 无效", 400);

    if (typeof body.newName !== "string" || !body.newName.trim()) {
      return errorResponse("站点名称不能为空", 400);
    }
    const newName = body.newName.trim().slice(0, 80);

    let newUrl = oldUrl;
    if (body.newUrl && typeof body.newUrl === "string") {
      const normalized = normalizeSiteUrl(body.newUrl);
      if (!normalized) return errorResponse("新 URL 无效，仅支持 http/https", 400);
      newUrl = normalized;
    }

    const currentSites = await getSites(env);
    const siteIndex = currentSites.findIndex((site) => site.url === oldUrl);
    if (siteIndex === -1) return errorResponse("站点不存在", 404);

    // 如果 URL 变了，检查新 URL 是否已被占用
    if (newUrl !== oldUrl && currentSites.some((s) => s.url === newUrl)) {
      return errorResponse("站点 URL 已存在", 409);
    }

    const oldSite = currentSites[siteIndex];
    currentSites[siteIndex] = { name: newName, url: newUrl };
    const ok = await saveSites(env, currentSites);
    if (!ok) return errorResponse("保存站点失败", 500);

    // 处理 URL 变更：迁移历史记录
    const historyMap = await getHistoryMap(env);
    if (newUrl !== oldUrl) {
      if (historyMap[oldUrl]) {
        historyMap[newUrl] = historyMap[oldUrl];
        delete historyMap[oldUrl];
        await saveHistoryMap(env, historyMap);
      }
    } else {
      await saveHistoryMap(env, historyMap);
    }

    return jsonResponse({ success: true, site: { name: newName, url: newUrl } });
  }

  // 6.6) API: 拖拽排序保存
  if (path === "/api/reorder-sites" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body || !Array.isArray(body.sites)) {
      return errorResponse("请求体格式错误", 400);
    }
    const normalized = sanitizeSites(body.sites);
    // 校验提交的 URL 必须全部属于已有站点，防止注入
    const currentSites = await getSites(env);
    const currentUrls = new Set(currentSites.map((s) => s.url));
    for (const s of normalized) {
      if (!currentUrls.has(s.url)) {
        return errorResponse(`站点 ${s.url} 不存在`, 400);
      }
    }
    const ok = await saveSites(env, normalized);
    if (!ok) return errorResponse("保存排序失败", 500);
    return jsonResponse({ success: true });
  }

  // 7) API: 获取状态
  if (path === "/api/status" && request.method === "GET") {
    try {
      const results = await getStatusResults(env);
      return jsonResponse(results);
    } catch (error) {
      console.error("Get status failed:", error);
      return errorResponse("状态获取失败: " + error.message, 500);
    }
  }

  // 8) API: 健康检查（无需认证）
  if (path === "/api/health" && request.method === "GET") {
    const kvOk = hasStatusKV(env);
    let sitesCount = 0;
    if (kvOk) {
      try {
        const sites = await getSites(env);
        sitesCount = sites.length;
      } catch { /* ignore */ }
    }
    return jsonResponse({
      success: true,
      status: "ok",
      timestamp: new Date().toISOString(),
      kv_bound: kvOk,
      sites_count: sitesCount,
    });
  }

  // 9) 页面资源
  if (path === "/script.js") {
    return textResponse(
      getScript(config.refreshIntervalMs),
      200,
      "application/javascript; charset=utf-8"
    );
  }
  if (path === "/style.css") {
    return textResponse(getStyle(), 200, "text/css; charset=utf-8");
  }
  if (path === "/") {
    return htmlResponse(getIndexHTML(config));
  }

  return textResponse("Not Found", 404);
}

// ================= 前端模板 =================

function getLoginHTML(monitorName) {
  const safeName = escapeHtml(monitorName);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - ${safeName}</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; font-family: "Segoe UI", "PingFang SC", sans-serif; background: linear-gradient(135deg, #f3f4f6 0%, #e7eef8 100%); }
    .login-box { width:320px; background:#fff; border-radius:12px; box-shadow:0 12px 30px rgba(15,23,42,0.12); padding:28px; }
    h2 { margin:0 0 16px; color:#1f2937; font-size:22px; }
    p { margin:0 0 14px; color:#6b7280; font-size:13px; }
    input { width:100%; box-sizing:border-box; margin-bottom:12px; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; }
    button { width:100%; border:none; background:#2563eb; color:#fff; border-radius:8px; padding:10px; font-size:15px; cursor:pointer; }
    button:hover { background:#1d4ed8; }
    .error { margin-top:10px; color:#b91c1c; font-size:13px; min-height:18px; }
  </style>
</head>
<body>
  <div class="login-box">
    <h2>系统登录</h2>
    <p>${safeName}</p>
    <input type="password" id="password" placeholder="请输入管理密码" />
    <button id="loginBtn">登录</button>
    <div id="errorMsg" class="error"></div>
  </div>
  <script>
    async function tryLogin() {
      const pwdInput = document.getElementById("password");
      const errorMsg = document.getElementById("errorMsg");
      const password = pwdInput.value;
      errorMsg.textContent = "";
      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          location.reload();
          return;
        }
        errorMsg.textContent = data.message || "登录失败";
      } catch (e) {
        errorMsg.textContent = "网络错误，请稍后重试";
      }
    }
    document.getElementById("loginBtn").addEventListener("click", tryLogin);
    document.getElementById("password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryLogin();
    });
  </script>
</body>
</html>`;
}

function getIndexHTML(config) {
  const safeMonitorName = escapeHtml(config.monitorName);
  const safeGitHub = escapeHtml(config.githubUrl || "#");
  const safeBlog = config.blogUrl ? escapeHtml(config.blogUrl) : "";
  const blogButton = safeBlog
    ? `<a href="${safeBlog}" target="_blank" class="button blog-button"><i class="fas fa-rss"></i> Blog</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>${safeMonitorName}</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="monitor-name">
        <i class="fas fa-server"></i> ${safeMonitorName}
        <a href="#" id="logoutBtn" onclick="logout();return false;" class="logout-link">[退出]</a>
      </div>
      <div class="countdown" id="countdown"></div>
      <div class="buttons">
        <a href="${safeGitHub}" target="_blank" class="button github-button"><i class="fab fa-github"></i> GitHub</a>
        ${blogButton}
        <button id="manageBtn" class="button manage-button"><i class="fas fa-cog"></i> 管理</button>
        <button id="darkModeBtn" class="button" style="background:#374151;padding:8px 10px" title="切换深色模式"><i class="fas fa-moon"></i></button>
      </div>
    </div>

    <div id="managePanel" class="manage-panel" style="display:none;">
      <h3><i class="fas fa-plus-circle"></i> 添加新站点</h3>
      <div class="add-form">
        <input type="text" id="newSiteName" placeholder="站点名称（如：我的站点）">
        <input type="text" id="newSiteUrl" placeholder="站点 URL（如：https://example.com）">
        <button id="addSiteBtn">添加</button>
        <button id="deleteAllBtn" style="background:#dc2626;margin-left:auto">清空全部</button>
      </div>
    </div>

    <div id="status-list"></div>
  </div>

  <script src="/script.js"></script>
</body>
</html>`;
}

function getStyle() {
  return `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:linear-gradient(180deg,#f4f6f9 0%,#eef2f7 100%);margin:0;padding:0;color:#1f2937}
.container{max-width:980px;margin:20px auto;padding:18px}
.header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:18px;background:#fff;padding:14px 18px;border-radius:12px;box-shadow:0 6px 20px rgba(15,23,42,.06);flex-wrap:wrap}
.monitor-name{font-size:22px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px}
.logout-link{font-size:12px;color:#6b7280;text-decoration:none}
.logout-link:hover{color:#111827}
.countdown{font-size:13px;color:#4b5563;background:#f8fafc;padding:5px 10px;border-radius:20px;border:1px solid #e5e7eb}
.buttons{display:flex;gap:10px;flex-wrap:wrap}
.button{padding:8px 14px;border-radius:8px;text-decoration:none;color:#fff;font-weight:600;font-size:13px;transition:opacity .2s;cursor:pointer;border:none}
.button:hover{opacity:.9}
.github-button{background:#24292e}
.blog-button{background:#2563eb}
.manage-button{background:#6b7280}

.manage-panel{background:#fff;padding:16px;border-radius:12px;margin-bottom:16px;border-left:4px solid #6b7280;box-shadow:0 6px 20px rgba(15,23,42,.06)}
.manage-panel h3{margin:0 0 12px;font-size:16px;color:#374151}
.add-form{display:flex;gap:10px;flex-wrap:wrap}
.add-form input{flex:1;min-width:220px;padding:9px;border:1px solid #d1d5db;border-radius:8px}
.add-form button{background:#16a34a;color:#fff;padding:9px 16px;border-radius:8px;border:none;cursor:pointer;font-weight:700}
.add-form button:hover{background:#15803d}
.edit-btn{color:#2563eb;background:rgba(37,99,235,.1);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .2s;margin-left:4px;border:none;flex-shrink:0}
.edit-btn:hover{background:#2563eb;color:#fff}

.status-summary{background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:12px;color:#334155;font-size:13px}
.status-item{position:relative;display:flex;flex-direction:row;align-items:center;background:#fff;margin-bottom:12px;padding:14px;border-radius:10px;border-left:4px solid transparent;box-shadow:0 3px 10px rgba(15,23,42,.04);transition:transform .18s}
.status-item:hover{transform:translateY(-2px)}
.status-item.status-up{border-left-color:#16a34a}
.status-item.status-down{border-left-color:#dc2626}
.status-indicator{width:12px;height:12px;border-radius:50%;margin-right:14px;flex-shrink:0}
.status-up .status-indicator{background:#16a34a;box-shadow:0 0 10px rgba(22,163,74,.35)}
.status-down .status-indicator{background:#dc2626;box-shadow:0 0 10px rgba(220,38,38,.35)}
.info-group{flex-grow:1;display:flex;flex-direction:column;margin-right:12px;min-width:0}
.website-name{font-size:15px;font-weight:700;color:#111827;word-break:break-all}
.site-url{font-size:12px;color:#6b7280;margin-top:4px;font-family:Consolas,Monaco,monospace;word-break:break-all}
.status-link{text-decoration:none;font-size:12px;padding:4px 10px;border-radius:5px;font-weight:700;margin-right:10px;white-space:nowrap}
.status-up .status-link{color:#166534;background:rgba(22,163,74,.12)}
.status-down .status-link{color:#991b1b;background:rgba(220,38,38,.12)}
.status-bars{display:flex;align-items:center;height:20px;gap:2px;margin-right:12px;flex-shrink:0}
.status-bar{width:4px;height:100%;border-radius:2px;background:#e5e7eb}
.status-bar.up{background:#16a34a}
.status-bar.down{background:#dc2626}
.percentage-display{font-size:13px;font-weight:800;width:46px;text-align:right;flex-shrink:0}
.text-success{color:#15803d}
.text-danger{color:#b91c1c}
.delete-btn{color:#dc2626;background:rgba(220,38,38,.1);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .2s;margin-left:8px;border:none;flex-shrink:0}
.delete-btn:hover{background:#dc2626;color:#fff}
.progress-bar-container{display:none}
.error{text-align:center;padding:16px;color:#991b1b;background:#fee2e2;border:1px solid #fecaca;border-radius:8px}

@media (max-width: 700px){
  .container{padding:10px}
  .header{flex-direction:column;align-items:flex-start}
  .buttons{width:100%}
  .countdown{display:none}
  .add-form{flex-direction:column}
  .status-item{padding:12px 10px;align-items:flex-start;flex-direction:column}
  .status-indicator{margin-bottom:8px;margin-right:0}
  .info-group{width:100%;margin-right:0;margin-bottom:8px}
  .status-link{margin-bottom:8px}
  .status-bars{width:100%;margin-right:0;margin-bottom:8px}
  .status-bar{flex:1}
  .percentage-display{position:absolute;top:12px;right:42px;font-size:12px}
  .delete-btn,.edit-btn{width:40px;height:40px}
  .delete-btn{position:absolute;top:8px;right:8px}
  .edit-btn{position:absolute;top:8px;right:54px}
}
.loading-status{padding:20px;text-align:center;color:#6b7280;font-size:14px}
.loading-text{display:flex;align-items:center;justify-content:center;gap:8px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:1000}
.modal-box{background:#fff;border-radius:12px;padding:24px;width:90%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.15)}
.modal-box h3{margin:0 0 16px;font-size:18px;color:#111827}
.modal-box .form-row{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.modal-box input{padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;width:100%;box-sizing:border-box}
.modal-box .btn-row{display:flex;gap:10px;justify-content:flex-end}
.modal-box button{padding:9px 16px;border-radius:8px;border:none;font-weight:600;cursor:pointer}
.modal-box .btn-save{background:#16a34a;color:#fff}
.modal-box .btn-cancel{background:#6b7280;color:#fff}
.dragging{opacity:.5}
.sortable-ghost{opacity:.3}
.sortable-chosen{box-shadow:0 8px 24px rgba(0,0,0,.15)}

:root[data-theme=light]{--bg:#eef2f7;--card:#fff;--text:#1f2937;--text2:#6b7280;--border:#e5e7eb;--input-bg:#fff;--input-border:#d1d5db;--manage-border:#6b7280;--success:#16a34a;--danger:#dc2626}
:root[data-theme=dark]{--bg:#0f172a;--card:#1e293b;--text:#f1f5f9;--text2:#94a3b8;--border:#334155;--input-bg:#0f172a;--input-border:#475569;--manage-border:#3b82f6;--success:#22c55e;--danger:#ef4444}
[data-theme=dark] body{background:var(--bg);color:var(--text)}
[data-theme=dark] .header{background:var(--card);box-shadow:0 6px 20px rgba(0,0,0,.3)}
[data-theme=dark] .monitor-name{color:var(--text)}
[data-theme=dark] .logout-link{color:var(--text2)}
[data-theme=dark] .countdown{background:#1e293b;border-color:#334155;color:var(--text2)}
[data-theme=dark] .manage-panel{background:var(--card);box-shadow:0 6px 20px rgba(0,0,0,.3)}
[data-theme=dark] .manage-panel h3{color:var(--text)}
[data-theme=dark] .add-form input{background:var(--input-bg);border-color:var(--input-border);color:var(--text)}
[data-theme=dark] .status-item{background:var(--card)}
[data-theme=dark] .status-item.status-up{border-left-color:var(--success)}
[data-theme=dark] .status-item.status-down{border-left-color:var(--danger)}
[data-theme=dark] .website-name{color:var(--text)}
[data-theme=dark] .site-url{color:var(--text2)}
[data-theme=dark] .status-summary{background:var(--card);border-color:var(--border);color:var(--text2)}
[data-theme=dark] .status-indicator{background:var(--text2)}
[data-theme=dark] .status-up .status-indicator{background:var(--success);box-shadow:0 0 10px rgba(34,197,94,.35)}
[data-theme=dark] .status-down .status-indicator{background:var(--danger);box-shadow:0 0 10px rgba(239,68,68,.35)}
[data-theme=dark] .modal-box{background:var(--card)}
[data-theme=dark] .modal-box h3{color:var(--text)}
[data-theme=dark] .modal-box input{background:var(--input-bg);border-color:var(--input-border);color:var(--text)}
[data-theme=dark] .modal-overlay{background:rgba(0,0,0,.6)}
[data-theme=dark] .error{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.3);color:#fca5a5}
[data-theme=dark] .loading-status{color:var(--text2)}
[data-theme=dark] .loading-text i{color:var(--text2)}
}`;
}

function getScript(refreshIntervalMs) {
  return `const statusList=document.getElementById("status-list");
const countdownDisplay=document.getElementById("countdown");
const manageBtn=document.getElementById("manageBtn");
const managePanel=document.getElementById("managePanel");
const nameInput=document.getElementById("newSiteName");
const urlInput=document.getElementById("newSiteUrl");
const addSiteBtn=document.getElementById("addSiteBtn");
const refreshInterval=${refreshIntervalMs};
let nextRefreshTime=Date.now()+refreshInterval;
let isFetching=false;
let isDarkMode=localStorage.getItem("darkMode")==="1";

function applyDarkMode(){
  document.documentElement.setAttribute("data-theme",isDarkMode?"dark":"light");
}
applyDarkMode();

function showLoading(){
  statusList.innerHTML="";
  const container=document.createElement("div");
  container.className="loading-status";
  container.innerHTML='<div class="loading-text"><i class="fas fa-spinner fa-spin"></i> 正在检测站点...</div>';
  statusList.appendChild(container);
}

async function parseResponse(res){
  const text=await res.text();
  if(!text) return {};
  try{return JSON.parse(text);}catch{return {message:text};}
}

async function api(url,options){
  const res=await fetch(url,options||{});
  const body=await parseResponse(res);
  if(!res.ok){
    throw new Error(body.message||("请求失败("+res.status+")"));
  }
  return body;
}

function validateUrl(value){
  try{
    const u=new URL(value);
    return u.protocol==="http:"||u.protocol==="https:";
  }catch{
    return false;
  }
}

async function logout(){
  try{
    await api("/api/logout",{method:"POST"});
  }catch(e){
    // ignore
  }
  location.reload();
}
window.logout=logout;

const darkModeBtn=document.getElementById("darkModeBtn");
if(darkModeBtn){
  darkModeBtn.addEventListener("click",()=>{
    isDarkMode=!isDarkMode;
    localStorage.setItem("darkMode",isDarkMode?"1":"0");
    applyDarkMode();
    darkModeBtn.innerHTML=isDarkMode?'<i class="fas fa-sun"></i>':'<i class="fas fa-moon"></i>';
  });
  darkModeBtn.innerHTML=isDarkMode?'<i class="fas fa-sun"></i>':'<i class="fas fa-moon"></i>';
}

const deleteAllBtn=document.getElementById("deleteAllBtn");
if(deleteAllBtn){
  deleteAllBtn.addEventListener("click",async ()=>{
    const count=document.querySelectorAll(".status-item").length;
    if(!count){alert("没有站点可删除");return;}
    if(!confirm("确定要清空全部 "+count+" 个站点吗？此操作不可恢复！")) return;
    if(!confirm("再次确认：删除全部站点？")) return;
    try{
      const sites=await api("/api/sites");
      for(const site of (sites.sites||[])){
        await api("/api/del-site",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({url:site.url})
        });
      }
      await fetchStatus(true);
      alert("已清空全部站点");
    }catch(e){
      alert(e.message||"删除失败");
    }
  });
}

if(manageBtn&&managePanel){
  manageBtn.addEventListener("click",()=>{
    const show=managePanel.style.display==="none";
    managePanel.style.display=show?"block":"none";
    manageBtn.style.background=show?"#f59e0b":"#6b7280";
  });
}

async function addNewSite(){
  const name=nameInput.value.trim();
  const url=urlInput.value.trim();
  if(!name){alert("请输入站点名称");return;}
  if(!validateUrl(url)){alert("请输入有效的 http/https URL");return;}

  try{
    await api("/api/add-site",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name,url})
    });
    nameInput.value="";
    urlInput.value="";
    await fetchStatus(true);
    alert("添加成功");
  }catch(e){
    alert(e.message||"添加失败");
  }
}

if(addSiteBtn) addSiteBtn.addEventListener("click",addNewSite);
if(nameInput) nameInput.addEventListener("keydown",(e)=>{if(e.key==="Enter") addNewSite();});
if(urlInput) urlInput.addEventListener("keydown",(e)=>{if(e.key==="Enter") addNewSite();});

async function deleteSite(url){
  if(!confirm("确定要删除此站点吗？")) return;
  try{
    await api("/api/del-site",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({url})
    });
    await fetchStatus(true);
  }catch(e){
    alert(e.message||"删除失败");
  }
}

let editModalVisible = false;
function openEditModal(site){
  if(editModalVisible) return;
  editModalVisible=true;
  const overlay=document.createElement("div");
  overlay.className="modal-overlay";
  overlay.innerHTML=`
  <div class="modal-box">
    <h3><i class="fas fa-edit"></i> 编辑站点</h3>
    <div class="form-row">
      <input type="text" id="editSiteName2" placeholder="站点名称" value="${(site.name||"").replace(/"/g,"&quot;")}">
      <input type="text" id="editSiteUrl2" placeholder="站点 URL" value="${(site.url||"").replace(/"/g,"&quot;")}">
    </div>
    <div class="btn-row">
      <button class="btn-cancel" id="modalCancelBtn">取消</button>
      <button class="btn-save" id="modalSaveBtn">保存</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const nameInput=document.getElementById("editSiteName2");
  const urlInput=document.getElementById("editSiteUrl2");
  nameInput.focus();
  nameInput.select();

  const closeModal=()=>{
    document.body.removeChild(overlay);
    editModalVisible=false;
  };

  document.getElementById("modalCancelBtn").addEventListener("click",closeModal);
  overlay.addEventListener("click",(e)=>{if(e.target===overlay) closeModal();});

  document.getElementById("modalSaveBtn").addEventListener("click",async ()=>{
    const name=nameInput.value.trim();
    const newUrl=urlInput.value.trim();
    if(!name){alert("请输入站点名称");return;}
    if(!validateUrl(newUrl)){alert("请输入有效的 http/https URL");return;}
    try{
      await api("/api/edit-site",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({oldUrl:site.url,name,newUrl})
      });
      closeModal();
      await fetchStatus(true);
      alert("修改成功");
    }catch(e){
      alert(e.message||"修改失败");
    }
  });
}
window.openEditModal=openEditModal;

function buildBars(history){
  const bars=document.createElement("div");
  bars.className="status-bars";
  const h=Array.isArray(history)?history.slice(-30):[];
  const padded=new Array(Math.max(30-h.length,0)).fill(null).concat(h);
  for(const point of padded){
    const item=document.createElement("div");
    item.className="status-bar";
    if(point===1) item.classList.add("up");
    if(point===0) item.classList.add("down");
    bars.appendChild(item);
  }
  return bars;
}

function renderStatus(items){
  statusList.innerHTML="";
  const list=Array.isArray(items)?items:[];
  list.sort((a,b)=>a.isUp===b.isUp?0:(a.isUp?-1:1));

  const upCount=list.filter((x)=>x.isUp).length;
  const summary=document.createElement("div");
  summary.className="status-summary";
  summary.textContent="总站点: "+list.length+" | 在线: "+upCount+" | 离线: "+(list.length-upCount);
  statusList.appendChild(summary);

  for(const site of list){
    const row=document.createElement("div");
    row.classList.add("status-item",site.isUp?"status-up":"status-down");
    row.setAttribute("draggable","true");
    row.dataset.url=site.url;

    const dot=document.createElement("div");
    dot.className="status-indicator";

    const info=document.createElement("div");
    info.className="info-group";
    const name=document.createElement("div");
    name.className="website-name";
    name.textContent=site.name||"未命名站点";
    const linkText=document.createElement("div");
    linkText.className="site-url";
    linkText.textContent=site.url||"-";
    info.appendChild(name);
    info.appendChild(linkText);

    const access=document.createElement("a");
    access.href=site.url;
    access.target="_blank";
    access.className="status-link";
    access.textContent=site.isUp?"正常访问":"无法访问";

    const bars=buildBars(site.history);
    const history=Array.isArray(site.history)?site.history:[];
    const okCount=history.filter((x)=>x===1).length;
    const percent=history.length?Math.round((okCount/history.length)*100):0;
    const p=document.createElement("div");
    p.className="percentage-display "+(site.isUp?"text-success":"text-danger");
    p.textContent=(history.length?percent:"--")+"%";

    const delBtn=document.createElement("button");
    delBtn.type="button";
    delBtn.className="delete-btn";
    delBtn.title="删除站点";
    delBtn.innerHTML='<i class="fas fa-trash"></i>';
    delBtn.addEventListener("click",(e)=>{
      e.preventDefault();
      e.stopPropagation();
      deleteSite(site.url);
    });

    const editBtn=document.createElement("button");
    editBtn.type="button";
    editBtn.className="edit-btn";
    editBtn.title="编辑站点";
    editBtn.innerHTML='<i class="fas fa-pen"></i>';
    editBtn.addEventListener("click",(e)=>{
      e.preventDefault();
      e.stopPropagation();
      openEditModal(site);
    });

    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(access);
    row.appendChild(bars);
    row.appendChild(p);
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    statusList.appendChild(row);
  }

  initDragDrop();
}

function initDragDrop(){
  const rows=document.querySelectorAll(".status-item");
  rows.forEach(row=>{
    row.addEventListener("dragstart",(e)=>{
      row.classList.add("dragging");
      e.dataTransfer.setData("text/plain",row.dataset.url||"");
    });
    row.addEventListener("dragend",()=>{
      document.querySelectorAll(".status-item").forEach(r=>r.classList.remove("dragging","sortable-ghost","sortable-chosen"));
    });
    row.addEventListener("dragover",(e)=>{
      e.preventDefault();
      const dragging=document.querySelector(".dragging");
      if(!dragging||dragging===row) return;
      const rect=row.getBoundingClientRect();
      const midY=rect.top+rect.height/2;
      document.querySelectorAll(".status-item").forEach(r=>r.classList.remove("sortable-ghost","sortable-chosen"));
      if(e.clientY<midY){
        row.classList.add("sortable-ghost");
        row.parentNode.insertBefore(dragging,row);
      }else{
        row.classList.add("sortable-chosen");
        row.parentNode.insertBefore(dragging,row.nextSibling);
      }
    });
    row.addEventListener("drop",(e)=>{
      e.preventDefault();
      document.querySelectorAll(".status-item").forEach(r=>r.classList.remove("dragging","sortable-ghost","sortable-chosen"));
      const newOrder=Array.from(document.querySelectorAll(".status-item")).map(r=>({url:r.dataset.url}));
      if(newOrder.length>0){
        api("/api/reorder-sites",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({sites:newOrder})
        }).catch(()=>{});
      }
    });
  });
}

async function fetchStatus(force){
  if(isFetching&&!force) return;
  isFetching=true;
  showLoading();
  try{
    const data=await api("/api/status");
    if(Array.isArray(data)) renderStatus(data);
    else renderStatus([]);
    nextRefreshTime=Date.now()+refreshInterval;
  }catch(e){
    if(String(e.message||"").includes("Unauthorized")){
      location.reload();
      return;
    }
    statusList.innerHTML='<div class="error">状态加载失败: '+(e.message||"未知错误")+"</div>";
  }finally{
    isFetching=false;
  }
}

function updateCountdown(){
  if(!countdownDisplay) return;
  const left=nextRefreshTime-Date.now();
  if(left<=0){
    countdownDisplay.textContent="正在刷新...";
    fetchStatus(false);
    return;
  }
  const min=Math.floor(left/60000);
  const sec=Math.floor((left%60000)/1000);
  countdownDisplay.textContent="下次刷新: "+(min>0?min+"分":"")+sec+"秒";
}

fetchStatus(true);
setInterval(updateCountdown,1000);`;
}
