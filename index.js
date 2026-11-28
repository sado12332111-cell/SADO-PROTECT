const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "sado_protect_state.json");
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_CLIENT_ID = "1562080654282199121";
const DISCORD_INVITE_URL =
  process.env.DISCORD_INVITE_URL ||
  `https://discord.com/oauth2/authorize?client_id=${DEFAULT_CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;

const DEFAULT_PANEL_DESIGN = {
  title: "SADO PROTECT • Lisenziya & Script Paneli",
  description:
    "Aşağıdakı düymələrdən istifadə edərək lisenziya açarınızı aktivləşdirə, HWID sıfırlaya və ya scriptinizi əldə edə bilərsiniz.",
  color: 6323199,
  footerText: "SADO PROTECT • Premium Təhlükəsizlik Sistemi",
  imageUrl: "",
  buttons: [
    { id: "btn_redeem_key", label: "Reedem Key", style: 1, emoji: "🔑" },
    { id: "btn_get_script", label: "Get Script", style: 3, emoji: "📜" },
    { id: "btn_reset_hwid", label: "Reset HWID", style: 4, emoji: "⚙️" },
    { id: "btn_stats", label: "Statistikam", style: 2, emoji: "📊" }
  ]
};

const PLAN_CONFIGS = {
  free: {
    id: "free",
    name: "Free",
    priceLabel: "Pulsuz",
    scriptLimit: 1,
    badge: "FREE"
  },
  premium_1: {
    id: "premium_1",
    name: "Premium (1$)",
    priceLabel: "1$",
    scriptLimit: 5,
    badge: "PRO 1$"
  },
  premium_2: {
    id: "premium_2",
    name: "Premium (2$)",
    priceLabel: "2$",
    scriptLimit: null,
    badge: "UNLIMITED 2$"
  }
};

const sanitizeText = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : fallback;
};

const sanitizeSnowflakeId = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const str = String(value).trim();
  return /^\d{15,22}$/.test(str) ? str : "";
};

const normalizePlanId = (planId) => {
  const key = String(planId || "").trim().toLowerCase();
  if (key === "premium_1" || key === "1$" || key === "pro_1" || key === "premium1") {
    return "premium_1";
  }
  if (
    key === "premium_2" ||
    key === "2$" ||
    key === "pro_2" ||
    key === "premium2" ||
    key === "unlimited"
  ) {
    return "premium_2";
  }
  return "free";
};

const getPlanMeta = (planId) => {
  const norm = normalizePlanId(planId);
  return PLAN_CONFIGS[norm] || PLAN_CONFIGS.free;
};

const normalizeButtonStyle = (styleValue) => {
  const parsed = Number(styleValue);
  if (parsed >= 1 && parsed <= 4) return parsed;
  return 1;
};

const normalizePanelDesign = (rawDesign) => {
  const src = rawDesign && typeof rawDesign === "object" ? rawDesign : {};
  const rawButtons = Array.isArray(src.buttons) ? src.buttons : DEFAULT_PANEL_DESIGN.buttons;
  const knownMap = new Map(DEFAULT_PANEL_DESIGN.buttons.map((b) => [b.id, { ...b }]));
  const orderedButtons = [];

  for (const item of rawButtons) {
    if (!item || typeof item !== "object") continue;
    const id = sanitizeText(item.id, "");
    if (!knownMap.has(id)) continue;
    const base = knownMap.get(id);
    orderedButtons.push({
      id,
      label: sanitizeText(item.label, base.label).slice(0, 80),
      style: normalizeButtonStyle(item.style !== undefined ? item.style : base.style),
      emoji: sanitizeText(item.emoji, base.emoji).slice(0, 16)
    });
    knownMap.delete(id);
  }

  for (const remaining of knownMap.values()) {
    orderedButtons.push(remaining);
  }

  let parsedColor = Number(src.color);
  if (!Number.isFinite(parsedColor) || parsedColor < 0 || parsedColor > 16777215) {
    parsedColor = DEFAULT_PANEL_DESIGN.color;
  }

  return {
    title: sanitizeText(src.title, DEFAULT_PANEL_DESIGN.title).slice(0, 200),
    description: sanitizeText(src.description, DEFAULT_PANEL_DESIGN.description).slice(0, 1500),
    color: Math.floor(parsedColor),
    footerText: sanitizeText(src.footerText, DEFAULT_PANEL_DESIGN.footerText).slice(0, 200),
    imageUrl: sanitizeText(src.imageUrl, "").slice(0, 500),
    buttons: orderedButtons
  };
};

const ensureStorageDirectory = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (_err) {}
};

const createEmptyAccountWorkspace = (discordId = "", guildId = "") => {
  const uid = sanitizeSnowflakeId(discordId);
  const gid = sanitizeSnowflakeId(guildId);
  return {
    ownerDiscordId: uid,
    guildId: gid,
    guildName: "",
    panelChannelId: "",
    activePlan: "free",
    activeApiKeyCode: "",
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    panelDesign: normalizePanelDesign(DEFAULT_PANEL_DESIGN),
    auditLogs: []
  };
};

const loadInitialAppState = () => {
  ensureStorageDirectory();
  const baseState = {
    guildId: sanitizeSnowflakeId(process.env.DEFAULT_GUILD_ID || ""),
    guildName: "",
    panelChannelId: sanitizeSnowflakeId(process.env.DEFAULT_PANEL_CHANNEL_ID || ""),
    latestJoinedGuildId: "",
    connectedDiscordUser: null,
    accounts: {},
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    tenants: {},
    apiKeys: [],
    panelDesign: normalizePanelDesign(DEFAULT_PANEL_DESIGN),
    auditLogs: []
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          ...baseState,
          ...parsed,
          guildId: sanitizeSnowflakeId(parsed.guildId || baseState.guildId),
          guildName: sanitizeText(parsed.guildName, ""),
          panelChannelId: sanitizeSnowflakeId(parsed.panelChannelId || baseState.panelChannelId),
          latestJoinedGuildId: sanitizeSnowflakeId(parsed.latestJoinedGuildId || ""),
          connectedDiscordUser:
            parsed.connectedDiscordUser && typeof parsed.connectedDiscordUser === "object"
              ? parsed.connectedDiscordUser
              : null,
          accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
          scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
          keys: Array.isArray(parsed.keys) ? parsed.keys : [],
          whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
          blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [],
          tenants: parsed.tenants && typeof parsed.tenants === "object" ? parsed.tenants : {},
          apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
          panelDesign: normalizePanelDesign(parsed.panelDesign),
          auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : []
        };
      }
    }
  } catch (_err) {}

  return baseState;
};

const APP_STATE = loadInitialAppState();

const saveAppStateToDisk = () => {
  try {
    ensureStorageDirectory();
    fs.writeFileSync(STATE_FILE, JSON.stringify(APP_STATE, null, 2), "utf8");
  } catch (_err) {}
};

const getAccountWorkspace = (discordId = "", guildId = "", createIfMissing = true) => {
  const uid = sanitizeSnowflakeId(discordId || "");
  if (!uid) return null;
  if (!APP_STATE.accounts || typeof APP_STATE.accounts !== "object") {
    APP_STATE.accounts = {};
  }
  if (!APP_STATE.accounts[uid]) {
    if (!createIfMissing) return null;
    APP_STATE.accounts[uid] = createEmptyAccountWorkspace(uid, guildId);
    saveAppStateToDisk();
  }
  const acc = APP_STATE.accounts[uid];
  acc.ownerDiscordId = uid;
  if (guildId) {
    acc.guildId = sanitizeSnowflakeId(guildId);
  }
  acc.guildName = sanitizeText(acc.guildName, "");
  acc.panelChannelId = sanitizeSnowflakeId(acc.panelChannelId || "");
  acc.activePlan = normalizePlanId(acc.activePlan || "free");
  acc.activeApiKeyCode = sanitizeText(acc.activeApiKeyCode, "");
  acc.scripts = Array.isArray(acc.scripts) ? acc.scripts : [];
  acc.keys = Array.isArray(acc.keys) ? acc.keys : [];
  acc.whitelist = Array.isArray(acc.whitelist) ? acc.whitelist : [];
  acc.blacklist = Array.isArray(acc.blacklist) ? acc.blacklist : [];
  acc.panelDesign = normalizePanelDesign(acc.panelDesign);
  acc.auditLogs = Array.isArray(acc.auditLogs) ? acc.auditLogs : [];
  return acc;
};

const resolveOwnerDiscordIdForGuild = (guildId = "") => {
  const gid = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (!gid) return "";
  const t = APP_STATE.tenants && APP_STATE.tenants[gid] ? APP_STATE.tenants[gid] : null;
  const fromTenant = sanitizeSnowflakeId(
    (t && (t.ownerDiscordId || (t.botAddedBy && t.botAddedBy.userId))) || ""
  );
  if (fromTenant) return fromTenant;

  if (APP_STATE.accounts && typeof APP_STATE.accounts === "object") {
    for (const [uid, acc] of Object.entries(APP_STATE.accounts)) {
      if (acc && sanitizeSnowflakeId(acc.guildId) === gid) {
        return sanitizeSnowflakeId(uid);
      }
    }
  }
  return "";
};

const appendAuditLog = (action, details = "", guildId = "", ownerDiscordId = "") => {
  try {
    const cleanGid = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
    const cleanUid = sanitizeSnowflakeId(ownerDiscordId || resolveOwnerDiscordIdForGuild(cleanGid) || "");
    const entry = {
      id: `log_${crypto.randomBytes(6).toString("hex")}`,
      action: sanitizeText(action, "ACTION"),
      details: sanitizeText(details, ""),
      guildId: cleanGid,
      ownerDiscordId: cleanUid,
      timestamp: new Date().toISOString()
    };

    if (cleanUid) {
      const acc = getAccountWorkspace(cleanUid, cleanGid, true);
      if (acc) {
        acc.auditLogs.unshift(entry);
        if (acc.auditLogs.length > 150) {
          acc.auditLogs = acc.auditLogs.slice(0, 150);
        }
      }
    } else {
      APP_STATE.auditLogs.unshift(entry);
      if (APP_STATE.auditLogs.length > 250) {
        APP_STATE.auditLogs = APP_STATE.auditLogs.slice(0, 250);
      }
    }
    saveAppStateToDisk();
  } catch (_err) {}
};

const getTenantRecordByGuildId = (guildId, createIfMissing = true, ownerDiscordId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return null;
  if (!APP_STATE.tenants || typeof APP_STATE.tenants !== "object") {
    APP_STATE.tenants = {};
  }
  const explicitOwner = sanitizeSnowflakeId(ownerDiscordId || "");
  if (!APP_STATE.tenants[cleanId]) {
    if (!createIfMissing) return null;
    const ownerId = explicitOwner || "";
    const ownerAcc = ownerId ? getAccountWorkspace(ownerId, cleanId, true) : null;
    APP_STATE.tenants[cleanId] = {
      guildId: cleanId,
      guildName: ownerAcc ? sanitizeText(ownerAcc.guildName, "") : "",
      panelChannelId: ownerAcc ? sanitizeSnowflakeId(ownerAcc.panelChannelId) : "",
      ownerDiscordId: ownerId,
      botAddedBy: null,
      activePlan: ownerAcc ? normalizePlanId(ownerAcc.activePlan) : "free",
      activeApiKeyCode: ownerAcc ? sanitizeText(ownerAcc.activeApiKeyCode, "") : "",
      scripts: ownerAcc ? ownerAcc.scripts : [],
      keys: ownerAcc ? ownerAcc.keys : [],
      whitelist: ownerAcc ? ownerAcc.whitelist : [],
      blacklist: ownerAcc ? ownerAcc.blacklist : [],
      panelDesign: normalizePanelDesign(ownerAcc ? ownerAcc.panelDesign : DEFAULT_PANEL_DESIGN)
    };
    saveAppStateToDisk();
  } else {
    const rec = APP_STATE.tenants[cleanId];
    rec.guildId = cleanId;
    rec.guildName = sanitizeText(rec.guildName, "");
    rec.panelChannelId = sanitizeSnowflakeId(rec.panelChannelId || "");
    if (explicitOwner && !rec.ownerDiscordId) {
      rec.ownerDiscordId = explicitOwner;
    }
    rec.ownerDiscordId = sanitizeSnowflakeId(rec.ownerDiscordId || (rec.botAddedBy && rec.botAddedBy.userId) || "");
    rec.botAddedBy = rec.botAddedBy && typeof rec.botAddedBy === "object" ? rec.botAddedBy : null;
    rec.activePlan = normalizePlanId(rec.activePlan || "free");
    rec.activeApiKeyCode = sanitizeText(rec.activeApiKeyCode, "");
    rec.scripts = Array.isArray(rec.scripts) ? rec.scripts : [];
    rec.keys = Array.isArray(rec.keys) ? rec.keys : [];
    rec.whitelist = Array.isArray(rec.whitelist) ? rec.whitelist : [];
    rec.blacklist = Array.isArray(rec.blacklist) ? rec.blacklist : [];
    rec.panelDesign = normalizePanelDesign(rec.panelDesign);
  }
  return APP_STATE.tenants[cleanId];
};

const syncAccountAndTenant = (ownerDiscordId = "", guildId = "") => {
  const uid = sanitizeSnowflakeId(ownerDiscordId || "");
  const gid = sanitizeSnowflakeId(guildId || "");
  if (uid) {
    const acc = getAccountWorkspace(uid, gid, true);
    if (gid && acc) {
      acc.guildId = gid;
      const tenant = getTenantRecordByGuildId(gid, true, uid);
      if (tenant) {
        tenant.ownerDiscordId = uid;
        if (tenant.guildName) acc.guildName = tenant.guildName;
        if (tenant.panelChannelId) acc.panelChannelId = tenant.panelChannelId;
        tenant.scripts = acc.scripts;
        tenant.keys = acc.keys;
        tenant.whitelist = acc.whitelist;
        tenant.blacklist = acc.blacklist;
        tenant.panelDesign = normalizePanelDesign(acc.panelDesign);
        tenant.activePlan = normalizePlanId(acc.activePlan);
        tenant.activeApiKeyCode = sanitizeText(acc.activeApiKeyCode, "");
      }
    }
  } else if (gid) {
    const tenant = getTenantRecordByGuildId(gid, true, "");
    const ownerId = sanitizeSnowflakeId((tenant && tenant.ownerDiscordId) || "");
    if (ownerId && tenant) {
      const acc = getAccountWorkspace(ownerId, gid, true);
      if (acc) {
        acc.guildId = gid;
        if (tenant.guildName) acc.guildName = tenant.guildName;
        if (tenant.panelChannelId) acc.panelChannelId = tenant.panelChannelId;
      }
    }
  }
};

const getGuildOwnerId = (guildId = "") => {
  const gid = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (!gid) return "";
  return resolveOwnerDiscordIdForGuild(gid);
};

const isGuildIdValidAndAuthorized = (guildId = "", userId = "") => {
  const gid = sanitizeSnowflakeId(guildId || "");
  if (!gid) return false;
  const ownerId = getGuildOwnerId(gid);
  const uid = sanitizeSnowflakeId(userId || "");
  if (ownerId && uid && ownerId !== uid) {
    return false;
  }
  return true;
};

const isGuildAuthorized = (guildId = "", userId = "") => {
  const gid = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  const uid = sanitizeSnowflakeId(userId || "");
  if (!gid || !uid) return false;
  return isGuildIdValidAndAuthorized(gid, uid);
};

const isAdminOrOwnerUser = (guildId = "", userId = "") => {
  const uid = sanitizeSnowflakeId(userId || "");
  if (!uid) return false;
  const ownerId = getGuildOwnerId(guildId);
  if (ownerId && ownerId === uid) return true;
  const envAdmins = String(process.env.ADMIN_DISCORD_IDS || process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((x) => sanitizeSnowflakeId(x))
    .filter(Boolean);
  if (envAdmins.includes(uid)) return true;
  return !ownerId;
};

const formatDurationStatusText = (recordObj = null) => {
  if (!recordObj || typeof recordObj !== "object") return "Yoxdur";
  const rawExpires = recordObj.expiresAt || recordObj.expireAt || recordObj.expires_at || "";
  const rawDays = Number(recordObj.durationDays || recordObj.days || 0);

  if (rawExpires) {
    const expMs = Date.parse(String(rawExpires));
    if (Number.isFinite(expMs)) {
      const diffMs = expMs - Date.now();
      if (diffMs <= 0) return "Müddəti bitib ❌";
      const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (daysLeft >= 36500) return "Ömürlük (Lifetime) ♾️";
      return `${daysLeft} gün qalıb`;
    }
  }

  if (Number.isFinite(rawDays) && rawDays > 0) {
    if (rawDays >= 36500) return "Ömürlük (Lifetime) ♾️";
    return `${Math.ceil(rawDays)} günlük`;
  }

  return "Ömürlük (Lifetime) ♾️";
};

const getUserAccessSummary = (guildId = "", userId = "", ownerDiscordId = "") => {
  const uid = sanitizeSnowflakeId(userId || "");
  const wl = getWhitelistForGuild(guildId, ownerDiscordId);
  const keys = getKeysForGuild(guildId, ownerDiscordId);
  const userWl = wl.find((w) => String(w.discordId) === uid) || null;
  const userKeyObj =
    keys.find(
      (k) =>
        !k.revoked &&
        ((userWl &&
          userWl.keyCode &&
          userWl.keyCode !== "MANUAL-WL" &&
          String(k.code || "").toUpperCase() === String(userWl.keyCode || "").toUpperCase()) ||
          String(k.claimedBy || "") === uid)
    ) || null;

  const hasValidWl = Boolean(
    userWl &&
      (userWl.keyCode === "MANUAL-WL" ||
        userKeyObj ||
        (userWl.keyCode && String(userWl.keyCode).trim().length > 0))
  );
  const hasAccess = Boolean(userKeyObj || hasValidWl);
  const activeKeyCode =
    (userKeyObj && userKeyObj.code) ||
    (userWl && userWl.keyCode && userWl.keyCode !== "MANUAL-WL" ? userWl.keyCode : "");
  const resetCount = Number(
    (userWl && userWl.resetCount) || (userKeyObj && userKeyObj.resetCount) || 0
  );
  const durationLabel = formatDurationStatusText(userKeyObj || userWl);

  return {
    hasAccess,
    userWl,
    userKeyObj,
    activeKeyCode,
    resetCount: Number.isFinite(resetCount) && resetCount >= 0 ? Math.floor(resetCount) : 0,
    durationLabel
  };
};

const BOT_RUNTIME = {
  connected: false,
  botUserId: "",
  botUsername: "SADO PROTECT",
  sessionId: "",
  resumeGatewayUrl: "",
  seq: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  lastHeartbeatAt: 0,
  lastError: "",
  ws: null
};

const resolveDiscordBotToken = () => {
  return sanitizeText(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || "", "");
};

const parseRequestCookies = (req) => {
  const header = String((req && req.headers && req.headers.cookie) || "");
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (_e) {
        out[k] = v;
      }
    }
  }
  return out;
};

const DISCORD_SESSION_COOKIE = "sado_discord_user";

const getSessionDiscordUserFromRequest = (req) => {
  const cookies = parseRequestCookies(req);
  const raw = cookies[DISCORD_SESSION_COOKIE];
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    const cleanUid = sanitizeSnowflakeId(parsed && parsed.userId);
    if (parsed && typeof parsed === "object" && cleanUid) {
      return {
        userId: cleanUid,
        username: sanitizeText(parsed.username, cleanUid),
        displayName: sanitizeText(parsed.displayName || parsed.username, cleanUid),
        avatarUrl: sanitizeText(parsed.avatarUrl, ""),
        connectedAt: sanitizeText(parsed.connectedAt, new Date().toISOString())
      };
    }
  } catch (_err) {}
  return null;
};

const buildSessionCookieHeader = (userObj, baseUrl = "") => {
  const isSecure = String(baseUrl || "").startsWith("https://");
  const secureFlag = isSecure ? "; Secure" : "";
  if (!userObj) {
    return `${DISCORD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`;
  }
  const encoded = Buffer.from(JSON.stringify(userObj), "utf8").toString("base64url");
  return `${DISCORD_SESSION_COOKIE}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureFlag}`;
};

const getPublicServiceBaseUrl = () => {
  const envUrl = sanitizeText(
    process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "",
    ""
  ).replace(/\/$/, "");
  return envUrl || "https://sado-protect.onrender.com";
};

const discordApiRequest = (endpointPath, method = "GET", bodyPayload = null, overrideToken = "") => {
  return new Promise((resolve, reject) => {
    const botToken = overrideToken || resolveDiscordBotToken();
    if (!botToken) {
      reject(new Error("DISCORD_BOT_TOKEN təyin edilməyib."));
      return;
    }

    const fullUrl = new URL(`${DISCORD_API_BASE}${endpointPath}`);
    const payloadString = bodyPayload ? JSON.stringify(bodyPayload) : null;

    const options = {
      hostname: fullUrl.hostname,
      port: 443,
      path: `${fullUrl.pathname}${fullUrl.search}`,
      method,
      headers: {
        Authorization: `Bot ${botToken}`,
        "User-Agent": "SADO-PROTECT-Bot (https://sado-protect.onrender.com, 2.0.0)"
      }
    };

    if (payloadString) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(payloadString);
    }

    const req = https.request(options, (res) => {
      let rawData = "";
      res.on("data", (chunk) => {
        rawData += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = rawData ? JSON.parse(rawData) : null;
        } catch (_err) {
          parsed = rawData;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: parsed });
        } else {
          const errMsg =
            parsed && typeof parsed === "object" && parsed.message
              ? `Discord API (${res.statusCode}): ${parsed.message}`
              : `Discord API xətası (${res.statusCode})`;
          reject(new Error(errMsg));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Discord şəbəkə xətası: ${err.message}`));
    });

    req.setTimeout(12000, () => {
      req.destroy(new Error("Discord API sorğusu vaxt aşımına uğradı."));
    });

    if (payloadString) {
      req.write(payloadString);
    }
    req.end();
  });
};

const respondToDiscordInteraction = async (interactionId, interactionToken, responseBody) => {
  return await discordApiRequest(
    `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
    "POST",
    responseBody
  );
};

const httpsJsonRequest = (urlStr, method = "GET", bodyObj = null, extraHeaders = {}) => {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const bodyText = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      "User-Agent": "SADO-PROTECT (https://sado-protect.onrender.com, 2.0.0)",
      ...extraHeaders
    };
    if (bodyText && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyText);
    }

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        headers
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (_err) {
            parsed = raw;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.setTimeout(10000, () => req.destroy(new Error("Timeout")));
    if (bodyText) req.write(bodyText);
    req.end();
  });
};

const fetchBotUserIdentity = async () => {
  try {
    const res = await discordApiRequest("/users/@me", "GET");
    if (res && res.data && res.data.id) {
      BOT_RUNTIME.botUserId = String(res.data.id);
      BOT_RUNTIME.botUsername = sanitizeText(
        res.data.global_name || res.data.username,
        "SADO PROTECT"
      );
      BOT_RUNTIME.connected = true;
    }
  } catch (_err) {
    if (resolveDiscordBotToken()) {
      BOT_RUNTIME.connected = true;
    }
  }
};

const tryResolveBotAdderFromAuditLog = async (guildId) => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return null;
  try {
    if (!BOT_RUNTIME.botUserId) {
      await fetchBotUserIdentity();
    }
    const res = await discordApiRequest(`/guilds/${cleanId}/audit-logs?action_type=28&limit=10`, "GET");
    const entries = res && res.data && Array.isArray(res.data.audit_log_entries)
      ? res.data.audit_log_entries
      : [];
    const users = res && res.data && Array.isArray(res.data.users)
      ? res.data.users
      : [];
    const match = entries.find(
      (e) =>
        e &&
        String(e.target_id || "") === String(BOT_RUNTIME.botUserId || "") &&
        e.user_id
    );
    if (match && match.user_id) {
      const foundUser = users.find((u) => String(u && u.id) === String(match.user_id)) || {};
      const uid = String(match.user_id);
      const uname = sanitizeText(foundUser.username, `User_${uid}`);
      const dname = sanitizeText(foundUser.global_name || foundUser.username, uname);
      const avUrl = foundUser.avatar
        ? `https://cdn.discordapp.com/avatars/${uid}/${foundUser.avatar}.png?size=128`
        : "";
      return {
        userId: uid,
        username: uname,
        displayName: dname,
        avatarUrl: avUrl,
        connectedAt: new Date().toISOString()
      };
    }
  } catch (_err) {}
  return null;
};

const resolveScopedWorkspace = (guildId = "", ownerDiscordId = "") => {
  const cleanUid = sanitizeSnowflakeId(ownerDiscordId || "");
  const cleanGid = sanitizeSnowflakeId(guildId || "");
  const resolvedUid = cleanUid || (cleanGid ? resolveOwnerDiscordIdForGuild(cleanGid) : "");

  if (resolvedUid) {
    const acc = getAccountWorkspace(resolvedUid, cleanGid, true);
    const tenant = cleanGid ? getTenantRecordByGuildId(cleanGid, true, resolvedUid) : null;
    return { ownerId: resolvedUid, guildId: cleanGid || (acc ? acc.guildId : ""), acc, tenant };
  }

  if (cleanGid) {
    const tenant = getTenantRecordByGuildId(cleanGid, true, "");
    return { ownerId: "", guildId: cleanGid, acc: null, tenant };
  }

  return { ownerId: "", guildId: "", acc: null, tenant: null };
};

const getScriptsForGuild = (guildId = "", ownerDiscordId = "") => {
  const { acc, tenant } = resolveScopedWorkspace(guildId, ownerDiscordId);
  if (acc) return acc.scripts;
  if (tenant && Array.isArray(tenant.scripts)) return tenant.scripts;
  return [];
};

const getKeysForGuild = (guildId = "", ownerDiscordId = "") => {
  const { acc, tenant } = resolveScopedWorkspace(guildId, ownerDiscordId);
  if (acc) return acc.keys;
  if (tenant && Array.isArray(tenant.keys)) return tenant.keys;
  return [];
};

const getWhitelistForGuild = (guildId = "", ownerDiscordId = "") => {
  const { acc, tenant } = resolveScopedWorkspace(guildId, ownerDiscordId);
  if (acc) return acc.whitelist;
  if (tenant && Array.isArray(tenant.whitelist)) return tenant.whitelist;
  return [];
};

const getBlacklistForGuild = (guildId = "", ownerDiscordId = "") => {
  const { acc, tenant } = resolveScopedWorkspace(guildId, ownerDiscordId);
  if (acc) return acc.blacklist;
  if (tenant && Array.isArray(tenant.blacklist)) return tenant.blacklist;
  return [];
};

const getPanelDesignForGuild = (guildId = "", ownerDiscordId = "") => {
  const { acc, tenant } = resolveScopedWorkspace(guildId, ownerDiscordId);
  if (acc && acc.panelDesign) return normalizePanelDesign(acc.panelDesign);
  if (tenant && tenant.panelDesign) return normalizePanelDesign(tenant.panelDesign);
  return normalizePanelDesign(DEFAULT_PANEL_DESIGN);
};

const getEffectivePlanForGuild = (guildId = "", ownerDiscordId = "") => {
  const { acc, tenant } = resolveScopedWorkspace(guildId, ownerDiscordId);
  const source = acc || tenant;
  if (source) {
    const boundApiKey = sanitizeText(source.activeApiKeyCode, "");
    if (boundApiKey) {
      const keyRec = (APP_STATE.apiKeys || []).find(
        (k) => String(k.code || "").toUpperCase() === boundApiKey.toUpperCase()
      );
      if (keyRec && !keyRec.revoked) {
        const normalized = normalizePlanId(keyRec.planId);
        source.activePlan = normalized;
        return normalized;
      }
    }
    return normalizePlanId(source.activePlan || "free");
  }
  return "free";
};

const exchangeOAuthCodeForDiscordAccount = async (code, redirectUri) => {
  const clientId = sanitizeText(process.env.DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID, "");
  const clientSecret = sanitizeText(process.env.DISCORD_CLIENT_SECRET || "", "");
  if (!code || !clientId || !clientSecret || !redirectUri) {
    return null;
  }

  try {
    const formParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    }).toString();

    const tokenData = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "discord.com",
          port: 443,
          path: "/api/v10/oauth2/token",
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(formParams),
            "User-Agent": "SADO-PROTECT-OAuth2"
          }
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(buf));
              } catch (_e) {
                resolve(null);
              }
            } else {
              reject(new Error(`Token exchange ${res.statusCode}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(formParams);
      req.end();
    });

    if (tokenData && tokenData.access_token) {
      const userData = await httpsJsonRequest("https://discord.com/api/v10/users/@me", "GET", null, {
        Authorization: `Bearer ${tokenData.access_token}`
      });

      if (userData && userData.id) {
        const userId = String(userData.id);
        const username = sanitizeText(userData.username, "Discord User");
        const displayName = sanitizeText(userData.global_name || userData.username, username);
        const avatarUrl = userData.avatar
          ? `https://cdn.discordapp.com/avatars/${userId}/${userData.avatar}.png?size=128`
          : "";

        return {
          userId,
          username,
          displayName,
          avatarUrl,
          connectedAt: new Date().toISOString()
        };
      }
    }
  } catch (_err) {}

  return null;
};

const fetchGuildInfoFromDiscord = async (guildId) => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return null;

  try {
    const res = await discordApiRequest(`/guilds/${cleanId}`, "GET");
    if (res && res.data && res.data.id) {
      const realName = sanitizeText(res.data.name, "");
      if (realName) {
        return {
          id: String(res.data.id),
          name: realName,
          icon: res.data.icon || ""
        };
      }
    }
  } catch (_err) {}
  return null;
};

const getScriptContentForUser = (
  guildId = "",
  userId = "",
  preferredScriptId = "",
  activeKeyCode = "",
  baseUrlOverride = "",
  ownerDiscordId = ""
) => {
  const scripts = getScriptsForGuild(guildId, ownerDiscordId);
  const chosen =
    (preferredScriptId && scripts.find((s) => s.id === preferredScriptId)) ||
    scripts[0] ||
    null;

  const scriptName = chosen
    ? sanitizeText(chosen.name, "SADO Script")
    : "SADO Script";
  const scriptIdForUrl = chosen ? chosen.id : "default";
  const baseUrl = sanitizeText(baseUrlOverride, "") || getPublicServiceBaseUrl();

  const qParams = new URLSearchParams();
  if (activeKeyCode) qParams.set("key", String(activeKeyCode));
  if (userId) qParams.set("uid", String(userId));
  if (guildId) qParams.set("gid", String(guildId));

  const loaderUrl = `${baseUrl}/loader/${encodeURIComponent(scriptIdForUrl)}?${qParams.toString()}`;
  const safeUrl = loaderUrl.replace(/"/g, '\\"');
  const safeKey = sanitizeText(activeKeyCode, "").replace(/"/g, '\\"');

  return {
    scriptName,
    code: `script_key="${safeKey}"\nloadstring(game:HttpGet("${safeUrl}"))()`
  };
};

const fetchRemoteLuaText = (targetUrlStr, redirectDepth = 0) => {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 4) {
      reject(new Error("Həddindən artıq yönləndirmə."));
      return;
    }
    let parsed;
    try {
      parsed = new URL(targetUrlStr);
    } catch (_e) {
      reject(new Error("Script URL düzgün deyil."));
      return;
    }
    const clientMod = parsed.protocol === "http:" ? http : https;
    const req = clientMod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          "User-Agent": "SADO-PROTECT-Loader/2.0"
        }
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers &&
          res.headers.location
        ) {
          const nextUrl = new URL(res.headers.location, parsed).toString();
          resolve(fetchRemoteLuaText(nextUrl, redirectDepth + 1));
          return;
        }
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Uzaq server xətası (${res.statusCode})`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Uzaq script vaxt aşımına uğradı.")));
  });
};

const generateUniqueLicenseKeyCode = () => {
  return `SADO-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto
    .randomBytes(2)
    .toString("hex")
    .toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
};

const buildSafeCustomId = (baseId, scriptId = "") => {
  const cleanBase = sanitizeText(baseId, "btn").slice(0, 60);
  const cleanScript = sanitizeText(scriptId, "").slice(0, 32);
  if (!cleanScript) return cleanBase;
  const combined = `${cleanBase}::${cleanScript}`;
  return combined.length <= 100 ? combined : cleanBase;
};

const sendPanelMessageToChannel = async (channelId, guildId = "", scriptId = "", ownerDiscordId = "") => {
  const targetChannelId = sanitizeSnowflakeId(channelId);
  if (!targetChannelId) {
    throw new Error("Panel göndəriləcək kanal ID-si düzgün deyil.");
  }

  const design = getPanelDesignForGuild(guildId, ownerDiscordId);
  const scripts = getScriptsForGuild(guildId, ownerDiscordId);
  const selectedScript = scriptId ? scripts.find((s) => s.id === scriptId) : null;

  const rowsMap = new Map();
  (design.buttons || []).forEach((btn, index) => {
    const rowIdx = Math.min(4, Math.floor(index / 5));
    if (!rowsMap.has(rowIdx)) rowsMap.set(rowIdx, []);
    const btnObj = {
      type: 2,
      custom_id: buildSafeCustomId(btn.id, selectedScript ? selectedScript.id : ""),
      label: sanitizeText(btn.label, "Button").slice(0, 80),
      style: normalizeButtonStyle(btn.style)
    };
    if (btn.emoji) {
      btnObj.emoji = { name: btn.emoji };
    }
    rowsMap.get(rowIdx).push(btnObj);
  });

  const components = Array.from(rowsMap.values()).map((comps) => ({
    type: 1,
    components: comps
  }));

  const embed = {
    title: selectedScript
      ? `${design.title} • ${selectedScript.name}`.slice(0, 256)
      : design.title.slice(0, 256),
    description: (selectedScript
      ? `**Seçilmiş Script:** \`${selectedScript.name}\`\n\n${design.description}`
      : design.description
    ).slice(0, 4000),
    color: design.color,
    footer: { text: design.footerText.slice(0, 2048) }
  };
  if (design.imageUrl) {
    embed.image = { url: design.imageUrl };
  }

  const res = await discordApiRequest(`/channels/${targetChannelId}/messages`, "POST", {
    embeds: [embed],
    components
  });
  return res && res.data ? res.data : null;
};

const parseCustomIdAndScript = (rawCustomId = "") => {
  const parts = String(rawCustomId || "").split("::");
  return {
    baseId: sanitizeText(parts[0], ""),
    boundScriptId: sanitizeText(parts[1] || "", "")
  };
};

const handleDiscordInteraction = async (interaction) => {
  if (!interaction || !interaction.id || !interaction.token) return;
  const interactionId = String(interaction.id);
  const interactionToken = String(interaction.token);
  const interactionType = Number(interaction.type);
  const guildId = sanitizeSnowflakeId(interaction.guild_id || "");
  const memberUser =
    (interaction.member && interaction.member.user) || interaction.user || {};
  const actorId = sanitizeSnowflakeId(memberUser.id || "");
  const actorTag = sanitizeText(
    memberUser.global_name || memberUser.username || `User_${actorId}`,
    `User_${actorId}`
  );

  const guildOwnerId = guildId ? resolveOwnerDiscordIdForGuild(guildId) : "";
  const effectiveOwnerId = guildOwnerId || actorId || "";

  if (guildId && actorId && !guildOwnerId) {
    const tRec = getTenantRecordByGuildId(guildId, true, actorId);
    if (tRec && !tRec.ownerDiscordId) {
      tRec.ownerDiscordId = actorId;
      syncAccountAndTenant(actorId, guildId);
      saveAppStateToDisk();
    }
  }

  try {
    if (interactionType === 2) {
      const cmdName = sanitizeText(interaction.data && interaction.data.name, "").toLowerCase();
      const optionsArr = Array.isArray(interaction.data && interaction.data.options)
        ? interaction.data.options
        : [];
      const getOpt = (optName) => {
        const found = optionsArr.find((o) => o && o.name === optName);
        return found ? found.value : undefined;
      };

      if (!actorId) {
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: "❌ İstifadəçi ID-si (User ID) müəyyən edilə bilmədi.",
            flags: 64
          }
        });
        return;
      }

      const bl = getBlacklistForGuild(guildId, effectiveOwnerId);
      if (bl.some((b) => String(b.discordId) === actorId)) {
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⛔ Sizin ID (\`${actorId}\`) Blacklist-dədir, bütün əmrlər bloklandı.`,
            flags: 64
          }
        });
        return;
      }

      if (guildId && guildOwnerId && guildOwnerId !== actorId) {
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⛔ Sunucu ID (\`${guildId}\`) nəzarəti: bu sunucu \`${guildOwnerId}\` ID-li hesaba bağlıdır, sizin ID (\`${actorId}\`) fərqlidir.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "panel") {
        if (!isAdminOrOwnerUser(guildId, actorId)) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: `⛔ Bu əmr yalnız hesab/sunucu sahibi ID-si (\`${getGuildOwnerId(guildId)}\`) üçündür.`,
              flags: 64
            }
          });
          return;
        }

        const chosenScriptId = sanitizeText(String(getOpt("script") || ""), "");
        const scoped = resolveScopedWorkspace(guildId, effectiveOwnerId);
        const targetCh = sanitizeSnowflakeId(
          interaction.channel_id ||
            (scoped.acc ? scoped.acc.panelChannelId : "") ||
            (scoped.tenant ? scoped.tenant.panelChannelId : "") ||
            ""
        );

        if (!targetCh) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Panel göndəriləcək kanal ID-si tapılmadı.",
              flags: 64
            }
          });
          return;
        }

        appendAuditLog("CMD_PANEL", `UserID=${actorId} ChannelID=${targetCh}`, guildId, effectiveOwnerId);
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⏳ Panel (<@${actorId}> / ID: \`${actorId}\`) <#${targetCh}> kanalına göndərilir...`,
            flags: 64
          }
        });
        await sendPanelMessageToChannel(targetCh, guildId, chosenScriptId, effectiveOwnerId);
        return;
      }

      if (cmdName === "key") {
        const inputKey = sanitizeText(String(getOpt("key") || ""), "").toUpperCase();
        if (!inputKey) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Zəhmət olmasa düzgün lisenziya açarı daxil edin.",
              flags: 64
            }
          });
          return;
        }

        const keys = getKeysForGuild(guildId, effectiveOwnerId);
        const foundKey = keys.find(
          (k) => String(k.code || "").toUpperCase() === inputKey && !k.revoked
        );
        if (!foundKey) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Daxil etdiyiniz açar yanlışdır, etibarsızdır və ya silinib.",
              flags: 64
            }
          });
          return;
        }

        if (foundKey.claimedBy && String(foundKey.claimedBy) !== actorId) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: `❌ Bu açar artıq başqa istifadəçi ID-sinə (\`${foundKey.claimedBy}\`) bağlıdır.`,
              flags: 64
            }
          });
          return;
        }

        foundKey.claimedBy = actorId;
        foundKey.claimedByTag = actorTag;
        foundKey.claimedAt = new Date().toISOString();

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const existingIdx = wl.findIndex((w) => String(w.discordId) === actorId);
        const wlRecord = {
          discordId: actorId,
          tag: actorTag,
          keyCode: foundKey.code,
          scriptId: foundKey.scriptId || "",
          hwid: existingIdx >= 0 ? wl[existingIdx].hwid || "" : "",
          lockedHwid: existingIdx >= 0 ? wl[existingIdx].lockedHwid || "" : "",
          resetCount: existingIdx >= 0 ? Number(wl[existingIdx].resetCount || 0) : 0,
          addedAt: new Date().toISOString()
        };
        if (existingIdx >= 0) {
          wl[existingIdx] = wlRecord;
        } else {
          wl.push(wlRecord);
        }

        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();
        appendAuditLog("CMD_REDEEM_KEY", `UserID=${actorId} Key=${foundKey.code}`, guildId, effectiveOwnerId);

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `✅ Açar (\`${foundKey.code}\`) uğurla aktivləşdirildi və **${actorTag}** (\`ID: ${actorId}\`) Whitelist-ə əlavə edildi!`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "whitelist") {
        if (!isAdminOrOwnerUser(guildId, actorId)) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: `⛔ Whitelist əlavə etmək yalnız hesab/sunucu sahibi ID-si (\`${getGuildOwnerId(guildId)}\`) üçündür.`,
              flags: 64
            }
          });
          return;
        }

        const rawUserVal = getOpt("user");
        const rawRoleVal = getOpt("role");
        const targetUserId = sanitizeSnowflakeId(rawUserVal || "");
        const targetRoleId = sanitizeSnowflakeId(rawRoleVal || "");

        if (!targetUserId && !targetRoleId) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Zəhmət olmasa ya istifadəçi (`user`), ya da rol (`role`) seçin.",
              flags: 64
            }
          });
          return;
        }

        const targetScriptId = sanitizeText(String(getOpt("script") || ""), "");
        const scripts = getScriptsForGuild(guildId, effectiveOwnerId);
        const chosenScriptObj = scripts.find((s) => s.id === targetScriptId) || scripts[0] || null;
        const effectiveScriptId = chosenScriptObj ? chosenScriptObj.id : targetScriptId;

        const resolvedUsersMap =
          (interaction.data && interaction.data.resolved && interaction.data.resolved.users) || {};
        const resolvedMembersMap =
          (interaction.data && interaction.data.resolved && interaction.data.resolved.members) || {};

        const candidateMembers = [];
        const seenCandidateIds = new Set();

        const pushCandidate = (uidRaw, fallbackTag = "") => {
          const cleanUid = sanitizeSnowflakeId(uidRaw || "");
          if (!cleanUid || seenCandidateIds.has(cleanUid)) return;
          seenCandidateIds.add(cleanUid);
          const uObj = resolvedUsersMap[cleanUid] || null;
          const mObj = resolvedMembersMap[cleanUid] || null;
          const computedTag = uObj
            ? sanitizeText(
                (mObj && mObj.nick) || uObj.global_name || uObj.username,
                `User_${cleanUid}`
              )
            : fallbackTag || (cleanUid === actorId ? actorTag : `User_${cleanUid}`);
          candidateMembers.push({ discordId: cleanUid, tag: computedTag });
        };

        if (targetUserId) {
          pushCandidate(targetUserId);
        }

        if (targetRoleId && guildId) {
          for (const [mId, mObj] of Object.entries(resolvedMembersMap)) {
            const rolesArr = Array.isArray(mObj && mObj.roles) ? mObj.roles : [];
            if (rolesArr.includes(targetRoleId)) {
              pushCandidate(mId);
            }
          }

          try {
            let afterId = "";
            let fetchedTotal = 0;
            while (fetchedTotal < 1000) {
              const qStr = afterId ? `?limit=1000&after=${encodeURIComponent(afterId)}` : "?limit=1000";
              const mRes = await discordApiRequest(`/guilds/${guildId}/members${qStr}`, "GET");
              const mList = Array.isArray(mRes && mRes.data) ? mRes.data : [];
              if (mList.length === 0) break;
              for (const mem of mList) {
                const memUser = mem && mem.user ? mem.user : null;
                const memId = sanitizeSnowflakeId(memUser && memUser.id);
                const memRoles = Array.isArray(mem && mem.roles) ? mem.roles : [];
                if (memId && memRoles.includes(targetRoleId)) {
                  const tagName = sanitizeText(
                    (mem && mem.nick) ||
                      (memUser && (memUser.global_name || memUser.username)),
                    `User_${memId}`
                  );
                  pushCandidate(memId, tagName);
                }
              }
              fetchedTotal += mList.length;
              const lastMem = mList[mList.length - 1];
              const nextAfter = sanitizeSnowflakeId(lastMem && lastMem.user && lastMem.user.id);
              if (!nextAfter || mList.length < 1000) break;
              afterId = nextAfter;
            }
          } catch (_roleFetchErr) {}
        }

        if (candidateMembers.length === 0) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content:
                "❌ Seçilən istifadəçi/rol üzrə ID tapılmadı (botun sunucuda `Server Members Intent` / üzv oxuma icazəsi olduğundan əmin olun).",
              flags: 64
            }
          });
          return;
        }

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const keys = getKeysForGuild(guildId, effectiveOwnerId);
        const bl = getBlacklistForGuild(guildId, effectiveOwnerId);
        const blacklistedIds = new Set(bl.map((b) => String(b.discordId)));

        const addedSummary = [];
        const skippedBlacklist = [];

        for (const cand of candidateMembers) {
          if (blacklistedIds.has(cand.discordId)) {
            skippedBlacklist.push(cand.discordId);
            continue;
          }

          const idx = wl.findIndex((w) => String(w.discordId) === cand.discordId);
          let existingValidKey =
            idx >= 0 && wl[idx].keyCode && wl[idx].keyCode !== "MANUAL-WL"
              ? keys.find(
                  (k) =>
                    String(k.code || "").toUpperCase() ===
                      String(wl[idx].keyCode || "").toUpperCase() && !k.revoked
                )
              : null;

          if (!existingValidKey) {
            const autoKeyCode = generateUniqueLicenseKeyCode();
            existingValidKey = {
              id: `key_${crypto.randomBytes(5).toString("hex")}`,
              code: autoKeyCode,
              scriptId: effectiveScriptId,
              claimedBy: cand.discordId,
              claimedByTag: cand.tag,
              claimedAt: new Date().toISOString(),
              revoked: false,
              createdAt: new Date().toISOString()
            };
            keys.push(existingValidKey);
          } else {
            existingValidKey.claimedBy = cand.discordId;
            existingValidKey.claimedByTag = cand.tag;
            if (effectiveScriptId) existingValidKey.scriptId = effectiveScriptId;
          }

          const record = {
            discordId: cand.discordId,
            tag: cand.tag,
            keyCode: existingValidKey.code,
            scriptId: effectiveScriptId,
            hwid: "",
            lockedHwid: "",
            resetCount: idx >= 0 ? Number(wl[idx].resetCount || 0) : 0,
            addedAt: new Date().toISOString()
          };
          if (idx >= 0) wl[idx] = record;
          else wl.push(record);

          addedSummary.push(`<@${cand.discordId}> (\`ID: ${cand.discordId}\`) → \`${existingValidKey.code}\``);
        }

        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();
        appendAuditLog(
          "AUTO_WHITELIST_KEY",
          `Count=${addedSummary.length} RoleID=${targetRoleId || "-"} UserID=${targetUserId || "-"} Script=${effectiveScriptId || "default"}`,
          guildId,
          effectiveOwnerId
        );

        const scriptText = chosenScriptObj ? ` (**${chosenScriptObj.name}** scriptinə)` : "";
        const roleText = targetRoleId ? ` • Rol: <@&${targetRoleId}> (\`ID: ${targetRoleId}\`)` : "";
        const lines = [
          `🛡️ **${addedSummary.length}** nəfər${scriptText}${roleText} Whitelist-ə əlavə olundu!`,
          ...addedSummary.slice(0, 15)
        ];
        if (addedSummary.length > 15) {
          lines.push(`... və daha **${addedSummary.length - 15}** nəfər.`);
        }
        if (skippedBlacklist.length > 0) {
          lines.push(`⛔ Blacklist səbəbilə keçilən ID-lər: ${skippedBlacklist.map((id) => `\`${id}\``).join(", ")}`);
        }

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: lines.join("\n").slice(0, 1950),
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "unwhitelist") {
        if (!isAdminOrOwnerUser(guildId, actorId)) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: `⛔ Whitelist-dən silmək yalnız hesab/sunucu sahibi ID-si (\`${getGuildOwnerId(guildId)}\`) üçündür.`,
              flags: 64
            }
          });
          return;
        }

        const targetUserId = sanitizeSnowflakeId(String(getOpt("user") || ""));
        const targetRoleId = sanitizeSnowflakeId(String(getOpt("role") || ""));
        const targetScriptId = sanitizeText(String(getOpt("script") || ""), "");

        if (!targetUserId && !targetRoleId) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Zəhmət olmasa silinəcək istifadəçini (`user`) və ya rolu (`role`) seçin.",
              flags: 64
            }
          });
          return;
        }

        const idsToRemove = new Set();
        if (targetUserId) {
          idsToRemove.add(targetUserId);
        }

        if (targetRoleId && guildId) {
          const resolvedMembersMap =
            (interaction.data && interaction.data.resolved && interaction.data.resolved.members) || {};
          for (const [mId, mObj] of Object.entries(resolvedMembersMap)) {
            const rolesArr = Array.isArray(mObj && mObj.roles) ? mObj.roles : [];
            if (rolesArr.includes(targetRoleId)) {
              const cleanMId = sanitizeSnowflakeId(mId);
              if (cleanMId) idsToRemove.add(cleanMId);
            }
          }
          try {
            let afterId = "";
            while (true) {
              const qStr = afterId ? `?limit=1000&after=${encodeURIComponent(afterId)}` : "?limit=1000";
              const mRes = await discordApiRequest(`/guilds/${guildId}/members${qStr}`, "GET");
              const mList = Array.isArray(mRes && mRes.data) ? mRes.data : [];
              if (mList.length === 0) break;
              for (const mem of mList) {
                const memId = sanitizeSnowflakeId(mem && mem.user && mem.user.id);
                const memRoles = Array.isArray(mem && mem.roles) ? mem.roles : [];
                if (memId && memRoles.includes(targetRoleId)) {
                  idsToRemove.add(memId);
                }
              }
              const lastMem = mList[mList.length - 1];
              const nextAfter = sanitizeSnowflakeId(lastMem && lastMem.user && lastMem.user.id);
              if (!nextAfter || mList.length < 1000) break;
              afterId = nextAfter;
            }
          } catch (_unwlRoleErr) {}
        }

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        let removedCount = 0;
        const nextWl = wl.filter((w) => {
          const wUid = sanitizeSnowflakeId(w && w.discordId);
          const idMatches = idsToRemove.has(wUid);
          const scriptMatches = !targetScriptId || String(w && w.scriptId || "") === targetScriptId;
          if (idMatches && scriptMatches) {
            removedCount += 1;
            return false;
          }
          return true;
        });

        const { acc, tenant } = resolveScopedWorkspace(guildId, effectiveOwnerId);
        if (acc) acc.whitelist = nextWl;
        if (tenant) tenant.whitelist = nextWl;
        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();
        appendAuditLog(
          "CMD_UNWHITELIST",
          `Removed=${removedCount} RoleID=${targetRoleId || "-"} UserID=${targetUserId || "-"} Script=${targetScriptId || "ALL"} ByID=${actorId}`,
          guildId,
          effectiveOwnerId
        );

        const scriptInfo = targetScriptId ? ` (\`${targetScriptId}\` scriptindən)` : "";
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content:
              removedCount > 0
                ? `🗑️ **${removedCount}** istifadəçi${scriptInfo} Whitelist-dən çıxarıldı.`
                : `ℹ️ Seçilən meyar üzrə Whitelist-də uyğun ID tapılmadı.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "unwhitelist") {
        if (!isAdminOrOwnerUser(guildId, actorId)) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: `⛔ Whitelist-dən silmək yalnız hesab/sunucu sahibi ID-si (\`${getGuildOwnerId(guildId)}\`) üçündür.`,
              flags: 64
            }
          });
          return;
        }

        const targetUserId = sanitizeSnowflakeId(String(getOpt("user") || ""));
        if (!targetUserId) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Zəhmət olmasa silinəcək istifadəçinin düzgün User ID-sini seçin.",
              flags: 64
            }
          });
          return;
        }

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const existed = wl.some((w) => String(w.discordId) === targetUserId);
        const nextWl = wl.filter((w) => String(w.discordId) !== targetUserId);
        const { acc, tenant } = resolveScopedWorkspace(guildId, effectiveOwnerId);
        if (acc) acc.whitelist = nextWl;
        if (tenant) tenant.whitelist = nextWl;
        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();
        appendAuditLog("CMD_UNWHITELIST", `TargetID=${targetUserId} ByID=${actorId}`, guildId, effectiveOwnerId);

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: existed
              ? `🗑️ <@${targetUserId}> (\`ID: ${targetUserId}\`) Whitelist-dən çıxarıldı.`
              : `ℹ️ \`ID: ${targetUserId}\` artıq Whitelist-də deyildi.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "resethwid") {
        const access = getUserAccessSummary(guildId, actorId, effectiveOwnerId);
        if (!access.hasAccess) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ HWID sıfırlamaq üçün əvvəlcə aktiv **Key** və ya **Whitelist**-iniz olmalıdır!",
              flags: 64
            }
          });
          return;
        }

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const keys = getKeysForGuild(guildId, effectiveOwnerId);
        const nextResetCount = access.resetCount + 1;
        const entry = wl.find((w) => String(w.discordId) === actorId);
        if (entry) {
          entry.hwid = "";
          entry.lockedHwid = "";
          entry.resetCount = nextResetCount;
        }
        for (const k of keys) {
          if (
            String(k.claimedBy || "") === actorId ||
            (access.activeKeyCode &&
              String(k.code || "").toUpperCase() === String(access.activeKeyCode).toUpperCase())
          ) {
            k.hwid = "";
            k.lockedHwid = "";
            k.resetCount = nextResetCount;
          }
        }
        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();
        appendAuditLog("RESET_HWID_CMD", `UserID=${actorId} Count=${nextResetCount}`, guildId, effectiveOwnerId);
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⚙️ **${actorTag}** (\`ID: ${actorId}\`) üçün HWID sıfırlandı! (Ümumi Reset: **${nextResetCount}**)\nNövbəti dəfə ilk açdığınız cihaza kilidlənəcək.`,
            flags: 64
          }
        });
        return;
      }
    }

    if (interactionType === 3) {
      const rawCustomId = sanitizeText(interaction.data && interaction.data.custom_id, "");
      const { baseId: customId, boundScriptId } = parseCustomIdAndScript(rawCustomId);

      if (!actorId) {
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: "❌ İstifadəçi ID-si müəyyən edilə bilmədi.",
            flags: 64
          }
        });
        return;
      }

      const blBtn = getBlacklistForGuild(guildId, effectiveOwnerId);
      if (blBtn.some((b) => String(b.discordId) === actorId)) {
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⛔ Sizin ID (\`${actorId}\`) Blacklist-dədir, düymələr bloklandı.`,
            flags: 64
          }
        });
        return;
      }

      if (customId === "btn_redeem_key") {
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 9,
          data: {
            custom_id: buildSafeCustomId("modal_redeem_key", boundScriptId),
            title: "Lisenziya Açarını Daxil Edin",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "input_license_key",
                    label: "Açarınız (Key)",
                    style: 1,
                    placeholder: "SADO-XXXX-XXXX-XXXX",
                    required: true,
                    max_length: 64
                  }
                ]
              }
            ]
          }
        });
        return;
      }

      if (customId === "btn_get_script") {
        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const keys = getKeysForGuild(guildId, effectiveOwnerId);
        const userWl = wl.find(
          (w) =>
            String(w.discordId) === actorId &&
            (!boundScriptId || !w.scriptId || w.scriptId === boundScriptId)
        );
        const matchedKeyObj = userWl
          ? keys.find(
              (k) =>
                String(k.code || "").toUpperCase() === String(userWl.keyCode || "").toUpperCase() &&
                !k.revoked
            )
          : null;
        const hasValidKey = Boolean(
          userWl &&
            userWl.keyCode &&
            (userWl.keyCode === "MANUAL-WL" || matchedKeyObj)
        );

        if (!userWl || !hasValidKey) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content:
                "❌ Əvvəlcə aktiv Key daxil edin! **Reedem Key** düyməsinə basıb açarınızı yazın, sonra **Get Script** ilə qısa scriptinizi əldə edin.",
              flags: 64
            }
          });
          return;
        }

        const effectiveScriptId = boundScriptId || userWl.scriptId || "";
        let activeKeyLabel = String(userWl.keyCode || "");
        if (!activeKeyLabel || activeKeyLabel === "MANUAL-WL") {
          const autoKeyCode = generateUniqueLicenseKeyCode();
          keys.push({
            id: `key_${crypto.randomBytes(5).toString("hex")}`,
            code: autoKeyCode,
            scriptId: effectiveScriptId,
            claimedBy: actorId,
            claimedByTag: actorTag,
            claimedAt: new Date().toISOString(),
            revoked: false,
            createdAt: new Date().toISOString()
          });
          userWl.keyCode = autoKeyCode;
          activeKeyLabel = autoKeyCode;
          syncAccountAndTenant(effectiveOwnerId, guildId);
          saveAppStateToDisk();
        }
        const scriptInfo = getScriptContentForUser(
          guildId,
          actorId,
          effectiveScriptId,
          activeKeyLabel,
          getPublicServiceBaseUrl(),
          effectiveOwnerId
        );
        const safeCode = String(scriptInfo.code || "").slice(0, 1800);
        const copyBtnCustomId = buildSafeCustomId("btn_copy_script", effectiveScriptId);

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `🔑 Key təsdiqləndi (\`${activeKeyLabel}\`) • **${scriptInfo.scriptName}** üçün qısa script:\n\`\`\`lua\n${safeCode}\n\`\`\``,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    custom_id: copyBtnCustomId,
                    label: "Scripti Kopyala",
                    style: 2,
                    emoji: { name: "📋" }
                  }
                ]
              }
            ],
            flags: 64
          }
        });
        return;
      }

      if (customId === "btn_copy_script") {
        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const userWl = wl.find((w) => String(w.discordId) === actorId);
        const scriptInfo = getScriptContentForUser(
          guildId,
          actorId,
          boundScriptId || (userWl ? userWl.scriptId || "" : ""),
          userWl ? userWl.keyCode || "" : "",
          getPublicServiceBaseUrl(),
          effectiveOwnerId
        );
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: String(scriptInfo.code || "").slice(0, 1950),
            flags: 64
          }
        });
        return;
      }

      if (customId === "btn_reset_hwid") {
        const access = getUserAccessSummary(guildId, actorId, effectiveOwnerId);
        if (!access.hasAccess) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ HWID sıfırlamaq üçün əvvəlcə aktiv **Key** və ya **Whitelist**-iniz olmalıdır!",
              flags: 64
            }
          });
          return;
        }

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const keys = getKeysForGuild(guildId, effectiveOwnerId);
        const nextResetCount = access.resetCount + 1;
        const entry = wl.find((w) => String(w.discordId) === actorId);
        if (entry) {
          entry.hwid = "";
          entry.lockedHwid = "";
          entry.resetCount = nextResetCount;
        }
        for (const k of keys) {
          if (
            String(k.claimedBy || "") === actorId ||
            (access.activeKeyCode &&
              String(k.code || "").toUpperCase() === String(access.activeKeyCode).toUpperCase())
          ) {
            k.hwid = "";
            k.lockedHwid = "";
            k.resetCount = nextResetCount;
          }
        }
        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();
        appendAuditLog("RESET_HWID_BTN", `${actorTag} (Count: ${nextResetCount})`, guildId, effectiveOwnerId);
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⚙️ **${actorTag}** üçün HWID sıfırlandı! (Reset sayı: **${nextResetCount}**)\nİlk hansı cihazda işlətsəniz, həmin cihaza kilidlənəcək.`,
            flags: 64
          }
        });
        return;
      }

      if (customId === "btn_stats") {
        const access = getUserAccessSummary(guildId, actorId, effectiveOwnerId);
        const planMeta = getPlanMeta(getEffectivePlanForGuild(guildId, effectiveOwnerId));

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: [
              `📊 **${actorTag}** Statistikası`,
              `• Discord ID: \`${actorId}\``,
              `• Key: **${access.activeKeyCode ? `\`${access.activeKeyCode}\`` : "Yoxdur ❌"}**`,
              `• Whitelist Statusu: **${access.userWl ? "Aktiv ✅" : "Deaktiv ❌"}**`,
              `• Müddət: **${access.hasAccess ? access.durationLabel : "Aktiv deyil ❌"}**`,
              `• HWID Reset Sayı: **${access.resetCount}**`,
              `• HWID Vəziyyəti: **${access.userWl && access.userWl.hwid ? "Bağlıdır 🔒" : "Boşdur 🔓"}**`,
              `• Plan: **${planMeta.name}**`
            ].join("\n"),
            flags: 64
          }
        });
        return;
      }
    }

    if (interactionType === 5) {
      const rawModalId = sanitizeText(interaction.data && interaction.data.custom_id, "");
      const { baseId: modalId, boundScriptId } = parseCustomIdAndScript(rawModalId);
      if (modalId === "modal_redeem_key") {
        let rawInput = "";
        const rows = Array.isArray(interaction.data && interaction.data.components)
          ? interaction.data.components
          : [];
        for (const row of rows) {
          const comps = Array.isArray(row && row.components) ? row.components : [];
          for (const comp of comps) {
            if (comp && comp.custom_id === "input_license_key") {
              rawInput = sanitizeText(String(comp.value || ""), "").toUpperCase();
            }
          }
        }

        const keys = getKeysForGuild(guildId, effectiveOwnerId);
        const foundKey = keys.find(
          (k) => String(k.code || "").toUpperCase() === rawInput && !k.revoked
        );

        if (!foundKey) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Açar tapılmadı və ya etibarsızdır. Zəhmət olmasa düzgün açar daxil edin.",
              flags: 64
            }
          });
          return;
        }

        if (foundKey.claimedBy && String(foundKey.claimedBy) !== actorId) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: `❌ Bu açar artıq başqa istifadəçi ID-sinə (\`${foundKey.claimedBy}\`) bağlıdır.`,
              flags: 64
            }
          });
          return;
        }

        foundKey.claimedBy = actorId;
        foundKey.claimedByTag = actorTag;
        foundKey.claimedAt = new Date().toISOString();

        const wl = getWhitelistForGuild(guildId, effectiveOwnerId);
        const existingIdx = wl.findIndex((w) => String(w.discordId) === actorId);
        const nextWlEntry = {
          discordId: actorId,
          tag: actorTag,
          keyCode: foundKey.code,
          scriptId: boundScriptId || foundKey.scriptId || "",
          hwid: existingIdx >= 0 ? wl[existingIdx].hwid || "" : "",
          lockedHwid: existingIdx >= 0 ? wl[existingIdx].lockedHwid || "" : "",
          resetCount: existingIdx >= 0 ? Number(wl[existingIdx].resetCount || 0) : 0,
          addedAt: new Date().toISOString()
        };
        if (existingIdx >= 0) {
          wl[existingIdx] = nextWlEntry;
        } else {
          wl.push(nextWlEntry);
        }

        syncAccountAndTenant(effectiveOwnerId, guildId);
        saveAppStateToDisk();

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `✅ **${actorTag}** (\`ID: ${actorId}\`), \`${foundKey.code}\` açarı uğurla aktivləşdirildi! İndi **Get Script** düyməsinə basıb scriptinizi ala bilərsiniz.`,
            flags: 64
          }
        });
      }
    }
  } catch (err) {
    try {
      await respondToDiscordInteraction(interactionId, interactionToken, {
        type: 4,
        data: {
          content: `❌ Xəta baş verdi: ${err.message}`,
          flags: 64
        }
      });
    } catch (_e) {}
  }
};

const buildSlashCommandsPayload = (guildId = "", ownerDiscordId = "") => {
  const scripts = getScriptsForGuild(guildId, ownerDiscordId);
  const scriptChoices = scripts.slice(0, 25).map((s) => ({
    name: sanitizeText(s.name, s.id).slice(0, 100),
    value: s.id
  }));

  const whitelistOptions = [
    {
      name: "user",
      description: "İstifadəçi seçin (istəyə bağlı)",
      type: 6,
      required: false
    },
    {
      name: "role",
      description: "Rol seçin (istəyə bağlı — roldakı hər kəs ID ilə əlavə olunur)",
      type: 8,
      required: false
    }
  ];

  if (scriptChoices.length > 0) {
    whitelistOptions.push({
      name: "script",
      description: "Whitelist veriləcək scripti seçin",
      type: 3,
      required: true,
      choices: scriptChoices
    });
  }

  const unwhitelistOptions = [
    {
      name: "user",
      description: "Silinəcək istifadəçi (istəyə bağlı)",
      type: 6,
      required: false
    },
    {
      name: "role",
      description: "Silinəcək rol (istəyə bağlı)",
      type: 8,
      required: false
    }
  ];

  if (scriptChoices.length > 0) {
    unwhitelistOptions.push({
      name: "script",
      description: "Hansı scriptdən silinsin (istəyə bağlı)",
      type: 3,
      required: false,
      choices: scriptChoices
    });
  }

  return [
    {
      name: "panel",
      description: "Lisenziya və script panelini kanala göndər",
      type: 1,
      options: [
        {
          name: "script",
          description: "Mövcud scriptlərdən birini seçin",
          type: 3,
          required: true,
          choices:
            scriptChoices.length > 0
              ? scriptChoices
              : [{ name: "Default Script", value: "default" }]
        }
      ]
    },
    {
      name: "key",
      description: "Lisenziya açarını aktivləşdir",
      type: 1,
      options: [
        {
          name: "key",
          description: "Aktivləşdiriləcək açar kodu",
          type: 3,
          required: true
        }
      ]
    },
    {
      name: "whitelist",
      description: "İstifadəçini və ya roldakı üzvləri seçilmiş scriptə Whitelist-ə əlavə et",
      type: 1,
      options: whitelistOptions
    },
    {
      name: "unwhitelist",
      description: "İstifadəçini və ya roldakı üzvləri Whitelist-dən çıxar",
      type: 1,
      options: unwhitelistOptions
    },
    {
      name: "resethwid",
      description: "Öz HWID məlumatınızı sıfırlayın",
      type: 1,
      options: []
    }
  ];
};

const syncSlashCommandsWithDiscord = async (guildId = "", ownerDiscordId = "") => {
  const token = resolveDiscordBotToken();
  if (!token) return;
  if (!BOT_RUNTIME.botUserId) {
    await fetchBotUserIdentity();
  }
  if (!BOT_RUNTIME.botUserId) return;

  const commands = buildSlashCommandsPayload(guildId, ownerDiscordId);
  try {
    await discordApiRequest(`/applications/${BOT_RUNTIME.botUserId}/commands`, "PUT", commands);
  } catch (_err) {}
};

const startDiscordGatewayListener = () => {
  const token = resolveDiscordBotToken();
  if (!token) {
    BOT_RUNTIME.connected = false;
    return;
  }

  BOT_RUNTIME.connected = true;

  let WebSocketCtor = null;
  try {
    WebSocketCtor = require("ws");
  } catch (_err) {
    return;
  }

  if (BOT_RUNTIME.ws) {
    try {
      BOT_RUNTIME.ws.terminate();
    } catch (_err) {}
    BOT_RUNTIME.ws = null;
  }

  const gatewayEndpoint = BOT_RUNTIME.resumeGatewayUrl || DISCORD_GATEWAY_URL;
  const socket = new WebSocketCtor(gatewayEndpoint);
  BOT_RUNTIME.ws = socket;

  const clearHeartbeat = () => {
    if (BOT_RUNTIME.heartbeatTimer) {
      clearInterval(BOT_RUNTIME.heartbeatTimer);
      BOT_RUNTIME.heartbeatTimer = null;
    }
  };

  socket.on("open", () => {
    BOT_RUNTIME.connected = true;
    BOT_RUNTIME.lastError = "";
  });

  socket.on("message", async (rawData) => {
    let payload = null;
    try {
      payload = JSON.parse(String(rawData));
    } catch (_err) {
      return;
    }

    if (!payload || typeof payload !== "object") return;
    if (typeof payload.s === "number") {
      BOT_RUNTIME.seq = payload.s;
    }

    const op = Number(payload.op);
    if (op === 10) {
      const intervalMs = Number(payload.d && payload.d.heartbeat_interval) || 41250;
      clearHeartbeat();
      BOT_RUNTIME.heartbeatTimer = setInterval(() => {
        if (socket.readyState === 1) {
          BOT_RUNTIME.lastHeartbeatAt = Date.now();
          socket.send(JSON.stringify({ op: 1, d: BOT_RUNTIME.seq }));
        }
      }, intervalMs);

      if (BOT_RUNTIME.sessionId && BOT_RUNTIME.resumeGatewayUrl && BOT_RUNTIME.seq !== null) {
        socket.send(
          JSON.stringify({
            op: 6,
            d: {
              token,
              session_id: BOT_RUNTIME.sessionId,
              seq: BOT_RUNTIME.seq
            }
          })
        );
      } else {
        socket.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: 1 | 2,
              properties: {
                os: "linux",
                browser: "sado-protect",
                device: "sado-protect"
              }
            }
          })
        );
      }
      return;
    }

    if (op === 11) {
      BOT_RUNTIME.lastHeartbeatAt = Date.now();
      return;
    }

    if (op === 7 || op === 9) {
      if (op === 9) {
        BOT_RUNTIME.sessionId = "";
        BOT_RUNTIME.resumeGatewayUrl = "";
      }
      try {
        socket.close(4000);
      } catch (_err) {}
      return;
    }

    if (op === 0) {
      const eventName = String(payload.t || "");
      const eventData = payload.d || {};

      if (eventName === "READY") {
        BOT_RUNTIME.connected = true;
        BOT_RUNTIME.sessionId = String(eventData.session_id || "");
        BOT_RUNTIME.resumeGatewayUrl = eventData.resume_gateway_url
          ? `${eventData.resume_gateway_url}?v=10&encoding=json`
          : "";
        if (eventData.user && eventData.user.id) {
          BOT_RUNTIME.botUserId = String(eventData.user.id);
          BOT_RUNTIME.botUsername = sanitizeText(
            eventData.user.global_name || eventData.user.username,
            "SADO PROTECT"
          );
        }

        const guildsArr = Array.isArray(eventData.guilds) ? eventData.guilds : [];
        if (guildsArr.length > 0) {
          for (const g of guildsArr) {
            const gid = sanitizeSnowflakeId(g && g.id);
            if (gid) {
              const tRec = getTenantRecordByGuildId(gid, true, "");
              const gInfo = await fetchGuildInfoFromDiscord(gid);
              if (tRec && gInfo && gInfo.name) {
                tRec.guildName = gInfo.name;
                if (tRec.ownerDiscordId) {
                  const acc = getAccountWorkspace(tRec.ownerDiscordId, gid, false);
                  if (acc) acc.guildName = gInfo.name;
                }
              }
            }
          }
          saveAppStateToDisk();
        }

        await syncSlashCommandsWithDiscord();
        return;
      }

      if (eventName === "GUILD_CREATE") {
        const gid = sanitizeSnowflakeId(eventData.id);
        if (gid) {
          const gName = sanitizeText(eventData.name, "");
          const tRec = getTenantRecordByGuildId(gid, true, "");
          if (tRec) {
            if (gName) {
              tRec.guildName = gName;
            }
            if (!tRec.botAddedBy) {
              const adder = await tryResolveBotAdderFromAuditLog(gid);
              if (adder && adder.userId) {
                tRec.botAddedBy = adder;
                if (!tRec.ownerDiscordId) {
                  tRec.ownerDiscordId = sanitizeSnowflakeId(adder.userId);
                }
              }
            }
            if (!APP_STATE.latestJoinedGuildId || APP_STATE.latestJoinedGuildId !== gid) {
              APP_STATE.latestJoinedGuildId = gid;
            }
            if (tRec.ownerDiscordId) {
              const acc = getAccountWorkspace(tRec.ownerDiscordId, gid, true);
              if (acc && gName) acc.guildName = gName;
            }
            saveAppStateToDisk();
          }
        }
        return;
      }

      if (eventName === "INTERACTION_CREATE") {
        await handleDiscordInteraction(eventData);
      }
    }
  });

  socket.on("close", () => {
    clearHeartbeat();
    BOT_RUNTIME.connected = Boolean(resolveDiscordBotToken());
    if (BOT_RUNTIME.reconnectTimer) {
      clearTimeout(BOT_RUNTIME.reconnectTimer);
    }
    BOT_RUNTIME.reconnectTimer = setTimeout(() => {
      startDiscordGatewayListener();
    }, 3000);
  });

  socket.on("error", (err) => {
    BOT_RUNTIME.lastError = err ? err.message : "Gateway error";
  });
};

const getBaseUrlFromRequest = (req) => {
  const proto = sanitizeText(req.headers["x-forwarded-proto"], "https");
  const host = sanitizeText(req.headers["x-forwarded-host"] || req.headers.host, `localhost:${PORT}`);
  return `${proto}://${host}`;
};

const buildDiscordLoginUrl = (redirectUri = "") => {
  const clientId = sanitizeText(process.env.DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID, "");
  if (!clientId) return "";
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "identify",
    prompt: "consent"
  });
  if (redirectUri) {
    params.set("redirect_uri", redirectUri);
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
};

const buildDiscordAuthorizeUrl = () => {
  return DISCORD_INVITE_URL;
};

const resolveRequestGuildId = (req, reqUrl, bodyObj = null, sessionUser = null) => {
  const uid = sanitizeSnowflakeId(sessionUser && sessionUser.userId);
  const rawCandidate =
    (bodyObj && bodyObj.guildId ? String(bodyObj.guildId).trim() : "") ||
    (reqUrl && reqUrl.searchParams ? String(reqUrl.searchParams.get("guildId") || "").trim() : "") ||
    (req && req.headers ? String(req.headers["x-guild-id"] || "").trim() : "");

  const cleanCandidate = sanitizeSnowflakeId(rawCandidate);
  if (cleanCandidate) {
    const ownerOfCandidate = resolveOwnerDiscordIdForGuild(cleanCandidate);
    if (!uid || !ownerOfCandidate || ownerOfCandidate === uid) {
      return cleanCandidate;
    }
    return "";
  }

  if (uid && APP_STATE.accounts && APP_STATE.accounts[uid]) {
    const accGid = sanitizeSnowflakeId(APP_STATE.accounts[uid].guildId || "");
    if (accGid) return accGid;
  }

  return "";
};

const buildPublicSnapshotPayload = async (
  requestedGuildId = "",
  isAdminView = false,
  baseUrl = "",
  sessionUser = null
) => {
  const tokenPresent = Boolean(resolveDiscordBotToken());
  const sessionUid = sanitizeSnowflakeId(sessionUser && sessionUser.userId);
  const acc = sessionUid ? getAccountWorkspace(sessionUid, requestedGuildId, true) : null;

  const cleanGuildId = sanitizeSnowflakeId(
    requestedGuildId || (acc ? acc.guildId : "") || ""
  );
  const tenant = cleanGuildId ? getTenantRecordByGuildId(cleanGuildId, true, sessionUid) : null;

  if (sessionUid && cleanGuildId && acc) {
    acc.guildId = cleanGuildId;
    if (tenant && !tenant.ownerDiscordId) {
      tenant.ownerDiscordId = sessionUid;
    }
  }

  let resolvedGuildName =
    (acc && sanitizeText(acc.guildName, "")) ||
    (tenant && sanitizeText(tenant.guildName, "")) ||
    "";
  if (
    resolvedGuildName &&
    (/^Sunucu\s*\(/i.test(resolvedGuildName) ||
      /^Sunucu\s*#/i.test(resolvedGuildName) ||
      /^Sunucu$/i.test(resolvedGuildName) ||
      /^Discord Sunucusu/i.test(resolvedGuildName))
  ) {
    resolvedGuildName = "";
  }
  if (cleanGuildId) {
    const info = await fetchGuildInfoFromDiscord(cleanGuildId);
    if (info && info.name) {
      resolvedGuildName = info.name;
      if (tenant) tenant.guildName = info.name;
      if (acc) acc.guildName = info.name;
      saveAppStateToDisk();
    }
  }

  const planId = getEffectivePlanForGuild(cleanGuildId, sessionUid);
  const planMeta = getPlanMeta(planId);
  const scriptsList = getScriptsForGuild(cleanGuildId, sessionUid);
  const keysList = getKeysForGuild(cleanGuildId, sessionUid);
  const wlList = getWhitelistForGuild(cleanGuildId, sessionUid);
  const blList = getBlacklistForGuild(cleanGuildId, sessionUid);
  const panelDesign = getPanelDesignForGuild(cleanGuildId, sessionUid);

  const logsList = acc
    ? acc.auditLogs || []
    : cleanGuildId
      ? (APP_STATE.auditLogs || []).filter((l) => sanitizeSnowflakeId(l.guildId) === cleanGuildId)
      : APP_STATE.auditLogs || [];

  const apiKeysSanitized = (APP_STATE.apiKeys || []).map((k) => ({
    id: k.id,
    code: k.code,
    planId: normalizePlanId(k.planId),
    planName: getPlanMeta(k.planId).name,
    label: sanitizeText(k.label, ""),
    revoked: Boolean(k.revoked),
    createdAt: k.createdAt || "",
    usedByUser: k.usedByUser || null,
    usedByGuildId: k.usedByGuildId || "",
    usedAt: k.usedAt || ""
  }));

  const resolvedChannelId = sanitizeSnowflakeId(
    (acc && acc.panelChannelId) || (tenant && tenant.panelChannelId) || ""
  );

  return {
    bot: {
      connected: Boolean(BOT_RUNTIME.connected || tokenPresent),
      tokenConfigured: tokenPresent,
      botUserId: BOT_RUNTIME.botUserId,
      botUsername: BOT_RUNTIME.botUsername,
      lastError: BOT_RUNTIME.lastError || ""
    },
    guild: {
      guildId: cleanGuildId,
      guildName: resolvedGuildName,
      displayName: resolvedGuildName || "Bağlı Sunucu Yoxdur",
      ownerDiscordId: sessionUid || (tenant ? sanitizeSnowflakeId(tenant.ownerDiscordId || "") : ""),
      panelChannelId: resolvedChannelId
    },
    discordAccount: {
      connected: Boolean(sessionUid),
      user: sessionUser && sessionUid ? sessionUser : null,
      loginUrl: buildDiscordLoginUrl(baseUrl ? `${baseUrl}/auth/discord/callback` : "")
    },
    oauth: {
      authorizeUrl: buildDiscordAuthorizeUrl()
    },
    plan: {
      id: planMeta.id,
      name: planMeta.name,
      priceLabel: planMeta.priceLabel,
      scriptLimit: planMeta.scriptLimit,
      scriptCount: scriptsList.length,
      activeApiKeyCode: (acc && acc.activeApiKeyCode) || (tenant && tenant.activeApiKeyCode) || ""
    },
    plansCatalog: Object.values(PLAN_CONFIGS),
    scripts: scriptsList,
    keys: keysList,
    whitelist: wlList,
    blacklist: blList,
    panelDesign,
    isAdminView: Boolean(isAdminView),
    apiKeys: isAdminView ? apiKeysSanitized : [],
    auditLogs: logsList.slice(0, 40)
  };
};

const sendJsonResponse = (res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
};

const readJsonBody = (req) => {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Sorğu ölçüsü çox böyükdür."));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        reject(new Error("JSON formatı düzgün deyil."));
      }
    });
    req.on("error", reject);
  });
};

const renderDashboardHtml = () => {
  return `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • License & Script Guard</title>
  <style>
    :root {
      --bg: #070b14;
      --surface: #0f172a;
      --surface-2: #162033;
      --border: rgba(148, 163, 184, 0.16);
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #6366f1;
      --primary-2: #4f46e5;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at top right, rgba(99, 102, 241, 0.14), transparent 45%), var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
    }
    .sidebar {
      width: 260px;
      background: rgba(15, 23, 42, 0.94);
      border-right: 1px solid var(--border);
      padding: 18px 14px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .sidebar-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .corner-profile-btn {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: 1px solid rgba(99, 102, 241, 0.45);
      background: rgba(30, 41, 59, 0.95);
      color: #f8fafc;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 15px;
      font-weight: 700;
      overflow: hidden;
      flex-shrink: 0;
      padding: 0;
    }
    .corner-profile-btn img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .account-popover {
      position: fixed;
      top: 64px;
      right: 18px;
      width: 265px;
      background: #111827;
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55);
      z-index: 9500;
      display: none;
    }
    .account-popover.open {
      display: block;
    }
    .brand-box {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 14px;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.28);
      flex: 1;
    }
    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 11px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: grid;
      place-items: center;
      font-weight: 800;
      font-size: 15px;
      flex-shrink: 0;
    }
    .brand-title { font-weight: 700; font-size: 14px; }
    .brand-sub { font-size: 11px; color: var(--muted); }
    .nav-list { display: flex; flex-direction: column; gap: 6px; }
    .nav-btn {
      width: 100%;
      text-align: left;
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      padding: 10px 12px;
      border-radius: 11px;
      font-size: 13.5px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: 0.15s ease;
    }
    .nav-btn:hover { background: rgba(255,255,255,0.04); color: var(--text); }
    .nav-btn.active {
      background: rgba(99, 102, 241, 0.16);
      border-color: rgba(99, 102, 241, 0.35);
      color: #fff;
    }
    .main-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 22px;
      border-bottom: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.72);
      backdrop-filter: blur(10px);
    }
    .topbar-left { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .topbar-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 11px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }
    .pill-ok { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.35); color: #6ee7b7; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 9px 14px;
      border-radius: 10px;
      border: 1px solid transparent;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: 0.15s ease;
    }
    .btn-sm { padding: 6px 11px; font-size: 12px; border-radius: 8px; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-2); }
    .btn-success { background: var(--success); color: #04130d; }
    .btn-danger { background: rgba(239, 68, 68, 0.16); color: #fca5a5; border-color: rgba(239, 68, 68, 0.35); }
    .btn-ghost { background: var(--surface-2); color: var(--text); border-color: var(--border); }
    .content { padding: 22px; display: flex; flex-direction: column; gap: 18px; max-width: 1280px; width: 100%; margin: 0 auto; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .card-title { font-size: 15px; font-weight: 700; }
    .stat-label { font-size: 12px; color: var(--muted); }
    .stat-value { font-size: 24px; font-weight: 800; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .field-group { display: flex; flex-direction: column; gap: 6px; }
    label { font-size: 12px; color: var(--muted); font-weight: 600; }
    input, select, textarea {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 10px;
      padding: 9px 11px;
      font-size: 13px;
      font-family: inherit;
    }
    textarea { min-height: 92px; resize: vertical; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-size: 12px; font-weight: 600; }
    .tab-pane { display: none; flex-direction: column; gap: 16px; }
    .tab-pane.active { display: flex; }
    .design-btn-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px;
      border-radius: 12px;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }
    .preview-box {
      background: #1e1f22;
      border-left: 4px solid #6366f1;
      border-radius: 10px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .preview-btns { display: flex; flex-wrap: wrap; gap: 8px; }
    .preview-btn-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.14);
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #1e293b;
      color: #fff;
      border: 1px solid rgba(99, 102, 241, 0.45);
      padding: 11px 16px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
      opacity: 0;
      transform: translateY(10px);
      transition: 0.2s ease;
      z-index: 9999;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 820px) {
      body { flex-direction: column; }
      .sidebar { width: 100%; height: auto; position: static; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-top-row">
      <div class="brand-box">
        <div class="brand-icon">SP</div>
        <div>
          <div class="brand-title">SADO PROTECT</div>
          <div class="brand-sub">License & Script Guard</div>
        </div>
      </div>
      <button id="cornerProfileBtn" type="button" class="corner-profile-btn" title="Discord Profili" aria-label="Discord Profili">
        👤
      </button>
    </div>

    <div id="discordAccountPopover" class="account-popover">
      <div id="accountPopoverConnected" style="display:none;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <img id="popoverUserAvatar" src="" alt="" style="width:38px;height:38px;border-radius:50%;display:none;object-fit:cover;" />
          <div>
            <div id="popoverUserName" style="font-size:14px;font-weight:700;color:#f8fafc;"></div>
            <div id="popoverUserId" style="font-size:11px;color:#94a3b8;"></div>
          </div>
        </div>
        <button id="disconnectDiscordBtn" type="button" class="btn btn-ghost btn-sm" style="width:100%;">Hesabı Ayır</button>
      </div>
      <div id="accountPopoverGuest">
        <div style="font-size:13px;font-weight:700;color:#f8fafc;margin-bottom:4px;">Discord to continue</div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:10px;">Discord hesabınızı bağlayıb profilinizi görün.</div>
        <a id="discordLoginContinueBtn" href="/auth/discord" class="btn btn-primary btn-sm" style="width:100%;">Discord to continue</a>
      </div>
    </div>

    <nav class="nav-list">
      <button class="nav-btn active" data-tab="overview">📊 İdarəetmə</button>
      <button class="nav-btn" data-tab="plans">💎 Planlar & API</button>
      <button class="nav-btn" data-tab="scripts">📜 Scriptlər</button>
      <button class="nav-btn" data-tab="keys">🔑 Keylər</button>
      <button class="nav-btn" data-tab="design">🎨 Panel Dizaynı</button>
      <button class="nav-btn" data-tab="access">🛡️ Whitelist / Blacklist</button>
    </nav>
  </aside>

  <div class="main-area">
    <header class="topbar">
      <div class="topbar-left">
        <span id="botStatusPill" class="pill pill-ok">● Bot: Aktivdir</span>
        <span class="pill">🏰 Sunucu: <strong id="headerGuildName">Bağlı Sunucu Yoxdur</strong></span>
        <span class="pill">💎 Plan: <strong id="headerPlanName">Free</strong></span>
      </div>
      <div class="topbar-right">
        <a id="topJoinDiscordLink" class="btn btn-primary btn-sm" href="https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=8&scope=bot%20applications.commands" target="_blank" rel="noopener noreferrer">
          ➕ Join Discord
        </a>
        <button id="refreshSnapshotBtn" class="btn btn-ghost btn-sm">🔄 Yenilə</button>
      </div>
    </header>

    <main class="content">
      <section id="tab-overview" class="tab-pane active">
        <div class="stats-grid">
          <div class="card">
            <div class="stat-label">Scriptlər</div>
            <div class="stat-value" id="statScriptsCount">0</div>
          </div>
          <div class="card">
            <div class="stat-label">Lisenziya Keyləri</div>
            <div class="stat-value" id="statKeysCount">0</div>
          </div>
          <div class="card">
            <div class="stat-label">Whitelist</div>
            <div class="stat-value" id="statWlCount">0</div>
          </div>
          <div class="card">
            <div class="stat-label">Blacklist</div>
            <div class="stat-value" id="statBlCount">0</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">🏰 Sunucu & Kanal Bağlantısı</div>
            <div class="field-group">
              <label for="guildIdInput">Sunucu ID (Guild ID)</label>
              <input id="guildIdInput" type="text" placeholder="Məsələn: 123456789012345678" />
            </div>
            <div class="field-group">
              <label for="panelChannelInput">Panel Kanal ID</label>
              <input id="panelChannelInput" type="text" placeholder="Məsələn: 123456789012345679" />
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button id="saveGuildSettingsBtn" class="btn btn-primary">Yadda Saxla</button>
              <button id="sendPanelQuickBtn" class="btn btn-success">📤 Paneli Kanala Göndər</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">📋 Son Əməliyyatlar</div>
            <div style="max-height:220px;overflow:auto;">
              <table>
                <thead>
                  <tr><th>Əməliyyat</th><th>Detal</th><th>Vaxt</th></tr>
                </thead>
                <tbody id="auditLogsBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section id="tab-plans" class="tab-pane">
        <div class="grid-3">
          <div class="card">
            <div class="stat-label">Free (Pulsuz)</div>
            <div class="stat-value">1 Script</div>
            <div class="stat-label">Başlanğıc plan</div>
          </div>
          <div class="card">
            <div class="stat-label">Premium (1$)</div>
            <div class="stat-value">5 Script</div>
            <div class="stat-label">API açarla aktivləşir</div>
          </div>
          <div class="card">
            <div class="stat-label">Premium (2$)</div>
            <div class="stat-value">Sonsuz Script</div>
            <div class="stat-label">API açarla aktivləşir</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">🔑 API Açar İlə Planı Aktivləşdir</div>
          <div class="field-group">
            <label for="userApiKeyInput">API Açarınız</label>
            <input id="userApiKeyInput" type="text" placeholder="SADO-API-XXXX-XXXX-XXXX" />
          </div>
          <div class="field-group">
            <label for="apiUserDiscordNameInput">Discord Adınız / İstifadəçi (istəyə bağlı)</label>
            <input id="apiUserDiscordNameInput" type="text" placeholder="Məsələn: sado / ID" />
          </div>
          <div>
            <button id="activateUserApiKeyBtn" class="btn btn-primary">Planı Bağla</button>
          </div>
        </div>

        <div id="adminApiKeySection" class="card" style="display:none;">
          <div class="card-title">👑 Yönetici API Açar Yaradıcısı</div>
          <div class="grid-2">
            <div class="field-group">
              <label for="adminApiPlanSelect">Plan Seçimi</label>
              <select id="adminApiPlanSelect">
                <option value="free">Free (1 Script)</option>
                <option value="premium_1" selected>Premium 1$ (5 Script)</option>
                <option value="premium_2">Premium 2$ (Sonsuz Script)</option>
              </select>
            </div>
            <div class="field-group">
              <label for="adminApiLabelInput">Qeyd / Etiket</label>
              <input id="adminApiLabelInput" type="text" placeholder="Məsələn: Müştəri 1" />
            </div>
          </div>
          <div>
            <button id="createAdminApiKeyBtn" class="btn btn-success">➕ Yeni API Açar Yarat</button>
          </div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th>API Açar</th>
                  <th>Plan</th>
                  <th>Etiket</th>
                  <th>Kim İşlədib</th>
                  <th>Status</th>
                  <th>Əməliyyat</th>
                </tr>
              </thead>
              <tbody id="adminApiKeysBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-scripts" class="tab-pane">
        <div class="card">
          <div class="card-title">📜 Yeni Script Əlavə Et</div>
          <div class="grid-2">
            <div class="field-group">
              <label for="scriptNameInput">Script Adı</label>
              <input id="scriptNameInput" type="text" placeholder="Məsələn: SADO HUB" />
            </div>
            <div class="field-group">
              <label for="scriptModeSelect">Mənbə Növü</label>
              <select id="scriptModeSelect">
                <option value="code">Lua Kodu</option>
                <option value="url">Raw URL</option>
                <option value="file">Dosya Yüklə (.lua / .txt)</option>
              </select>
            </div>
          </div>
          <div id="scriptFileRow" class="field-group" style="display:none;">
            <label for="scriptFileInput">Dosya Seç</label>
            <input id="scriptFileInput" type="file" accept=".lua,.txt,.js,.json,text/*" />
          </div>
          <div class="field-group">
            <label for="scriptUrlInput">Raw URL (URL seçildikdə)</label>
            <input id="scriptUrlInput" type="text" placeholder="https://..." />
          </div>
          <div class="field-group">
            <label for="scriptCodeInput">Lua Script Kodu / Dosya Məzmunu</label>
            <textarea id="scriptCodeInput" placeholder="-- Lua script kodunu bura yazın və ya dosya seçin"></textarea>
          </div>
          <div>
            <button id="createScriptBtn" class="btn btn-primary">Script Yarat</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Mövcud Scriptlər</div>
          <div id="editScriptModalBox" style="display:none;padding:12px;border:1px solid rgba(99,102,241,0.4);border-radius:12px;background:rgba(22,32,51,0.85);flex-direction:column;gap:10px;">
            <div style="font-size:13px;font-weight:700;">✏️ Scripti Yenilə (Update)</div>
            <input id="editScriptIdInput" type="hidden" />
            <div class="grid-2">
              <div class="field-group">
                <label for="editScriptNameInput">Script Adı</label>
                <input id="editScriptNameInput" type="text" />
              </div>
              <div class="field-group">
                <label for="editScriptModeSelect">Mənbə Növü</label>
                <select id="editScriptModeSelect">
                  <option value="code">Lua Kodu</option>
                  <option value="url">Raw URL</option>
                  <option value="file">Dosya (.lua / .txt)</option>
                </select>
              </div>
            </div>
            <div class="field-group">
              <label for="editScriptFileInput">Dosyadan Yüklə (.lua / .txt)</label>
              <input id="editScriptFileInput" type="file" accept=".lua,.txt,.js,.json,text/*" />
            </div>
            <div class="field-group">
              <label for="editScriptUrlInput">Raw URL</label>
              <input id="editScriptUrlInput" type="text" placeholder="https://..." />
            </div>
            <div class="field-group">
              <label for="editScriptCodeInput">Lua Script Kodu</label>
              <textarea id="editScriptCodeInput"></textarea>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button id="saveUpdatedScriptBtn" type="button" class="btn btn-success btn-sm">💾 Update Et</button>
              <button id="cancelEditScriptBtn" type="button" class="btn btn-ghost btn-sm">Ləğv Et</button>
            </div>
          </div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>Ad</th><th>Növ</th><th>Əməliyyat</th></tr>
              </thead>
              <tbody id="scriptsTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-keys" class="tab-pane">
        <div class="card">
          <div class="card-title">🔑 Yeni Lisenziya Keyi Yarat</div>
          <div class="grid-2">
            <div class="field-group">
              <label for="keyCustomCodeInput">Xüsusi Key (boş buraxılsa avtomatik yaranır)</label>
              <input id="keyCustomCodeInput" type="text" placeholder="SADO-XXXX-XXXX-XXXX" />
            </div>
            <div class="field-group">
              <label for="keyScriptSelect">Bağlı Script</label>
              <select id="keyScriptSelect"></select>
            </div>
          </div>
          <div>
            <button id="createLicenseKeyBtn" class="btn btn-success">Key Yarat</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Keylər Siyahısı</div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>Key</th><th>Script</th><th>İstifadəçi</th><th>Əməliyyat</th></tr>
              </thead>
              <tbody id="keysTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-design" class="tab-pane">
        <div class="grid-2">
          <div class="card">
            <div class="card-title">🎨 Panel Dizaynı & Düymə Sıralaması</div>
            <div class="field-group">
              <label for="designTitleInput">Başlıq</label>
              <input id="designTitleInput" type="text" />
            </div>
            <div class="field-group">
              <label for="designDescInput">Təsvir</label>
              <textarea id="designDescInput"></textarea>
            </div>
            <div class="field-group">
              <label for="designFooterInput">Alt Mətn (Footer)</label>
              <input id="designFooterInput" type="text" />
            </div>
            <div id="designButtonsEditor" style="display:flex;flex-direction:column;gap:8px;"></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button id="savePanelDesignBtn" class="btn btn-primary">Dizaynı Yadda Saxla</button>
              <button id="sendDesignedPanelBtn" class="btn btn-success">📤 Paneli Göndər</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">👁️ Canlı Önizləmə</div>
            <div id="panelLivePreview" class="preview-box"></div>
          </div>
        </div>
      </section>

      <section id="tab-access" class="tab-pane">
        <div class="grid-2">
          <div class="card">
            <div class="card-title">🛡️ Whitelist Əlavə Et</div>
            <div class="field-group">
              <label for="wlDiscordIdInput">Discord İstifadəçi ID</label>
              <input id="wlDiscordIdInput" type="text" placeholder="123456789012345678" />
            </div>
            <div class="field-group">
              <label for="wlScriptSelect">Script Seçimi</label>
              <select id="wlScriptSelect"></select>
            </div>
            <div>
              <button id="addWhitelistBtn" class="btn btn-success">Whitelist-ə Əlavə Et</button>
            </div>
            <div style="overflow:auto;">
              <table>
                <thead><tr><th>Discord ID</th><th>Script</th><th>Əməliyyat</th></tr></thead>
                <tbody id="whitelistTableBody"></tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-title">⛔ Blacklist Əlavə Et</div>
            <div class="field-group">
              <label for="blDiscordIdInput">Discord İstifadəçi ID</label>
              <input id="blDiscordIdInput" type="text" placeholder="123456789012345678" />
            </div>
            <div>
              <button id="addBlacklistBtn" class="btn btn-danger">Blacklist-ə Əlavə Et</button>
            </div>
            <div style="overflow:auto;">
              <table>
                <thead><tr><th>Discord ID</th><th>Əməliyyat</th></tr></thead>
                <tbody id="blacklistTableBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div id="toastEl" class="toast"></div>

  <script>
    const CLIENT_GUILD_STORAGE_KEY = "sado_protect_active_guild_id";
    const urlParams = new URLSearchParams(window.location.search);
    const isAdminQuery = urlParams.get("admin") === "1";

    const clientState = {
      deviceGuildId: localStorage.getItem(CLIENT_GUILD_STORAGE_KEY) || "",
      snapshot: null,
      draftDesign: null
    };

    const escapeHtmlClient = (str) => {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    };

    const showToast = (msg) => {
      const el = document.getElementById("toastEl");
      if (!el) return;
      el.textContent = msg;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 2600);
    };

    const apiRequest = async (endpoint, method = "GET", payload = null) => {
      const headers = { "Content-Type": "application/json" };
      if (clientState.deviceGuildId) {
        headers["x-guild-id"] = clientState.deviceGuildId;
      }
      const opts = { method, headers };
      if (payload !== null) {
        opts.body = JSON.stringify(payload);
      }
      const res = await fetch(endpoint, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Sorğu xətası (" + res.status + ")");
      }
      return data;
    };

    const styleLabelMap = {
      1: "Primary (Mavi)",
      2: "Secondary (Boz)",
      3: "Success (Yaşıl)",
      4: "Danger (Qırmızı)"
    };

    const renderDesignEditor = () => {
      const editorEl = document.getElementById("designButtonsEditor");
      const previewEl = document.getElementById("panelLivePreview");
      if (!editorEl || !previewEl || !clientState.draftDesign) return;

      const d = clientState.draftDesign;
      document.getElementById("designTitleInput").value = d.title || "";
      document.getElementById("designDescInput").value = d.description || "";
      document.getElementById("designFooterInput").value = d.footerText || "";

      editorEl.innerHTML = "";
      (d.buttons || []).forEach((btn, idx) => {
        const row = document.createElement("div");
        row.className = "design-btn-row";
        row.innerHTML =
          "<span style='font-size:12px;color:#94a3b8;min-width:22px;'>#" +
          (idx + 1) +
          "</span>" +
          "<input type='text' data-btn-idx='" +
          idx +
          "' data-field='emoji' value='" +
          escapeHtmlClient(btn.emoji || "") +
          "' placeholder='Emoji' style='width:62px;text-align:center;' />" +
          "<input type='text' data-btn-idx='" +
          idx +
          "' data-field='label' value='" +
          escapeHtmlClient(btn.label) +
          "' placeholder='Buton adı' style='flex:1;min-width:120px;' />" +
          "<select data-btn-idx='" +
          idx +
          "' data-field='style' style='width:155px;'>" +
          "<option value='1' " +
          (btn.style === 1 ? "selected" : "") +
          ">" +
          styleLabelMap[1] +
          "</option>" +
          "<option value='2' " +
          (btn.style === 2 ? "selected" : "") +
          ">" +
          styleLabelMap[2] +
          "</option>" +
          "<option value='3' " +
          (btn.style === 3 ? "selected" : "") +
          ">" +
          styleLabelMap[3] +
          "</option>" +
          "<option value='4' " +
          (btn.style === 4 ? "selected" : "") +
          ">" +
          styleLabelMap[4] +
          "</option>" +
          "</select>" +
          "<button type='button' class='btn btn-ghost btn-sm' data-move-up='" +
          idx +
          "' " +
          (idx === 0 ? "disabled" : "") +
          ">▲</button>" +
          "<button type='button' class='btn btn-ghost btn-sm' data-move-down='" +
          idx +
          "' " +
          (idx === d.buttons.length - 1 ? "disabled" : "") +
          ">▼</button>";
        editorEl.appendChild(row);
      });

      editorEl.querySelectorAll("input, select").forEach((el) => {
        el.addEventListener("input", () => {
          const i = Number(el.getAttribute("data-btn-idx"));
          const f = el.getAttribute("data-field");
          if (clientState.draftDesign.buttons[i]) {
            clientState.draftDesign.buttons[i][f] = f === "style" ? Number(el.value) : el.value;
            renderLivePreview();
          }
        });
      });

      editorEl.querySelectorAll("[data-move-up]").forEach((el) => {
        el.addEventListener("click", () => {
          const i = Number(el.getAttribute("data-move-up"));
          if (i > 0) {
            const arr = clientState.draftDesign.buttons;
            const tmp = arr[i - 1];
            arr[i - 1] = arr[i];
            arr[i] = tmp;
            renderDesignEditor();
          }
        });
      });

      editorEl.querySelectorAll("[data-move-down]").forEach((el) => {
        el.addEventListener("click", () => {
          const i = Number(el.getAttribute("data-move-down"));
          if (i < arr.length - 1) {
            const arr = clientState.draftDesign.buttons;
            const tmp = arr[i + 1];
            arr[i + 1] = arr[i];
            arr[i] = tmp;
            renderDesignEditor();
          }
        });
      });

      renderLivePreview();
    };

    const renderLivePreview = () => {
      const previewEl = document.getElementById("panelLivePreview");
      if (!previewEl || !clientState.draftDesign) return;
      const d = clientState.draftDesign;
      const styleColorMap = {
        1: "#5865f2",
        2: "#4e5058",
        3: "#248046",
        4: "#da373c"
      };
      const btnsHtml = (d.buttons || [])
        .map((b) => {
          const stNum = Number(b.style || 1);
          const bgVal = styleColorMap[stNum] || styleColorMap[1];
          return (
            "<span class='preview-btn-item' style='background:" +
            bgVal +
            ";'>" +
            escapeHtmlClient(b.emoji || "") +
            " " +
            escapeHtmlClient(b.label) +
            "</span>"
          );
        })
        .join("");

      previewEl.innerHTML =
        "<div style='font-weight:700;font-size:15px;'>" +
        escapeHtmlClient(d.title) +
        "</div>" +
        "<div style='font-size:13px;color:#cbd5e1;'>" +
        escapeHtmlClient(d.description) +
        "</div>" +
        "<div class='preview-btns'>" +
        btnsHtml +
        "</div>" +
        "<div style='font-size:11px;color:#94a3b8;'>" +
        escapeHtmlClient(d.footerText) +
        "</div>";
    };

    const applySnapshotToUi = (snap) => {
      const prevOwnerId =
        clientState.snapshot &&
        clientState.snapshot.discordAccount &&
        clientState.snapshot.discordAccount.user
          ? clientState.snapshot.discordAccount.user.userId
          : "";
      const nextOwnerId =
        snap && snap.discordAccount && snap.discordAccount.user
          ? snap.discordAccount.user.userId
          : "";

      clientState.snapshot = snap;
      const guild = snap.guild || {};
      const plan = snap.plan || {};

      if (guild.guildId) {
        clientState.deviceGuildId = guild.guildId;
        localStorage.setItem(CLIENT_GUILD_STORAGE_KEY, guild.guildId);
      } else if (prevOwnerId !== nextOwnerId) {
        clientState.deviceGuildId = "";
        localStorage.removeItem(CLIENT_GUILD_STORAGE_KEY);
      }

      const botPill = document.getElementById("botStatusPill");
      if (botPill) {
        botPill.className = "pill pill-ok";
        botPill.textContent = "● Bot: Aktivdir";
      }

      if (document.getElementById("headerGuildName")) {
        const gText =
          guild.guildName &&
          !/^Discord Sunucusu/i.test(guild.guildName) &&
          !/^Sunucu\\s*#/i.test(guild.guildName) &&
          !/^Sunucu$/i.test(guild.guildName)
            ? guild.guildName
            : guild.guildId
              ? "Sunucu (" + String(guild.guildId).slice(-4) + ")"
              : "Bağlı Sunucu Yoxdur";
        document.getElementById("headerGuildName").textContent = gText;
      }
      if (document.getElementById("headerPlanName")) {
        document.getElementById("headerPlanName").textContent = plan.name || "Free";
      }

      const accInfo = snap.discordAccount || {};
      const cornerBtn = document.getElementById("cornerProfileBtn");
      const connBox = document.getElementById("accountPopoverConnected");
      const guestBox = document.getElementById("accountPopoverGuest");
      const loginLink = document.getElementById("discordLoginContinueBtn");
      if (loginLink) {
        loginLink.href = "/auth/discord";
      }

      if (accInfo.connected && accInfo.user) {
        if (cornerBtn) {
          if (accInfo.user.avatarUrl) {
            cornerBtn.innerHTML = "<img src='" + escapeHtmlClient(accInfo.user.avatarUrl) + "' alt='Avatar' />";
          } else {
            const ch = (accInfo.user.displayName || accInfo.user.username || "D").charAt(0).toUpperCase();
            cornerBtn.textContent = ch;
          }
        }
        if (connBox) connBox.style.display = "block";
        if (guestBox) guestBox.style.display = "none";
        const displayAcctName =
          accInfo.user.displayName ||
          accInfo.user.username ||
          accInfo.user.userId ||
          "Discord User";
        if (document.getElementById("popoverUserName")) {
          document.getElementById("popoverUserName").textContent = displayAcctName;
        }
        if (document.getElementById("popoverUserId")) {
          document.getElementById("popoverUserId").textContent =
            "ID: " + accInfo.user.userId + (accInfo.user.username ? " (@" + accInfo.user.username + ")" : "");
        }
        const avImg = document.getElementById("popoverUserAvatar");
        if (avImg) {
          if (accInfo.user.avatarUrl) {
            avImg.src = accInfo.user.avatarUrl;
            avImg.style.display = "block";
          } else {
            avImg.style.display = "none";
          }
        }
      } else {
        if (cornerBtn) cornerBtn.innerHTML = "👤";
        if (connBox) connBox.style.display = "none";
        if (guestBox) guestBox.style.display = "block";
      }

      const guildInp = document.getElementById("guildIdInput");
      if (guildInp && document.activeElement !== guildInp) {
        guildInp.value = guild.guildId || "";
      }
      const chInp = document.getElementById("panelChannelInput");
      if (chInp && document.activeElement !== chInp) {
        chInp.value = guild.panelChannelId || "";
      }

      const scripts = snap.scripts || [];
      const keys = snap.keys || [];
      const wl = snap.whitelist || [];
      const bl = snap.blacklist || [];

      document.getElementById("statScriptsCount").textContent = String(scripts.length);
      document.getElementById("statKeysCount").textContent = String(keys.length);
      document.getElementById("statWlCount").textContent = String(wl.length);
      document.getElementById("statBlCount").textContent = String(bl.length);

      const scriptOptionsHtml =
        "<option value=''>Default / İlk Script</option>" +
        scripts.map((s) => "<option value='" + escapeHtmlClient(s.id) + "'>" + escapeHtmlClient(s.name) + "</option>").join("");
      document.getElementById("keyScriptSelect").innerHTML = scriptOptionsHtml;
      document.getElementById("wlScriptSelect").innerHTML = scriptOptionsHtml;

      document.getElementById("scriptsTableBody").innerHTML = scripts
        .map(function (s) {
          const modeLabel = s.mode === "url" ? "URL" : s.mode === "file" ? "Dosya" : "Kod";
          return (
            "<tr>" +
            "<td>" +
            escapeHtmlClient(s.name) +
            "</td>" +
            "<td>" +
            escapeHtmlClient(modeLabel) +
            "</td>" +
            "<td style='display:flex;gap:6px;flex-wrap:wrap;'>" +
            "<button type='button' class='btn btn-primary btn-sm' data-edit-script='" +
            escapeHtmlClient(s.id) +
            "'>Update</button>" +
            "<button type='button' class='btn btn-danger btn-sm' data-del-script='" +
            escapeHtmlClient(s.id) +
            "'>Sil</button>" +
            "</td>" +
            "</tr>"
          );
        })
        .join("");

      document.querySelectorAll("[data-edit-script]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const targetId = btn.getAttribute("data-edit-script");
          const foundScript = (clientState.snapshot && clientState.snapshot.scripts || []).find(
            (item) => item.id === targetId
          );
          const box = document.getElementById("editScriptModalBox");
          if (foundScript && box) {
            document.getElementById("editScriptIdInput").value = foundScript.id;
            document.getElementById("editScriptNameInput").value = foundScript.name || "";
            document.getElementById("editScriptModeSelect").value = foundScript.mode || "code";
            document.getElementById("editScriptUrlInput").value = foundScript.url || "";
            document.getElementById("editScriptCodeInput").value = foundScript.code || "";
            const editFileInp = document.getElementById("editScriptFileInput");
            if (editFileInp) editFileInp.value = "";
            box.style.display = "flex";
            box.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        });
      });

      document.querySelectorAll("[data-del-script]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await apiRequest("/api/scripts/" + encodeURIComponent(btn.getAttribute("data-del-script")), "DELETE");
            showToast("Script silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      });

      document.getElementById("keysTableBody").innerHTML = keys
        .map(function (k) {
          return (
            "<tr>" +
            "<td><code>" +
            escapeHtmlClient(k.code) +
            "</code></td>" +
            "<td>" +
            escapeHtmlClient(k.scriptId || "Default") +
            "</td>" +
            "<td>" +
            escapeHtmlClient(k.claimedByTag || "Gözləyir") +
            "</td>" +
            "<td><button class='btn btn-danger btn-sm' data-del-key='" +
            escapeHtmlClient(k.id) +
            "'>Sil</button></td>" +
            "</tr>"
          );
        })
        .join("");

      document.querySelectorAll("[data-del-key]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await apiRequest("/api/keys/" + encodeURIComponent(btn.getAttribute("data-del-key")), "DELETE");
            showToast("Key silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      });

      document.getElementById("whitelistTableBody").innerHTML = wl
        .map(function (w) {
          const matchedScript = scripts.find((sc) => sc.id === w.scriptId);
          const scriptLabel = matchedScript ? matchedScript.name : w.scriptId || "Default";
          return (
            "<tr>" +
            "<td>" +
            escapeHtmlClient(w.discordId) +
            "</td>" +
            "<td>" +
            escapeHtmlClient(scriptLabel) +
            "</td>" +
            "<td><button class='btn btn-danger btn-sm' data-del-wl='" +
            escapeHtmlClient(w.discordId) +
            "'>Sil</button></td>" +
            "</tr>"
          );
        })
        .join("");

      document.querySelectorAll("[data-del-wl]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await apiRequest("/api/whitelist/" + encodeURIComponent(btn.getAttribute("data-del-wl")), "DELETE");
            showToast("Whitelist-dən silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      });

      document.getElementById("blacklistTableBody").innerHTML = bl
        .map(function (b) {
          return (
            "<tr>" +
            "<td>" +
            escapeHtmlClient(b.discordId) +
            "</td>" +
            "<td><button class='btn btn-danger btn-sm' data-del-bl='" +
            escapeHtmlClient(b.discordId) +
            "'>Sil</button></td>" +
            "</tr>"
          );
        })
        .join("");

      document.querySelectorAll("[data-del-bl]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await apiRequest("/api/blacklist/" + encodeURIComponent(btn.getAttribute("data-del-bl")), "DELETE");
            showToast("Blacklist-dən silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      });

      document.getElementById("auditLogsBody").innerHTML = (snap.auditLogs || [])
        .slice(0, 12)
        .map(function (l) {
          return (
            "<tr>" +
            "<td>" +
            escapeHtmlClient(l.action) +
            "</td>" +
            "<td>" +
            escapeHtmlClient(l.details) +
            "</td>" +
            "<td>" +
            escapeHtmlClient(l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : "") +
            "</td>" +
            "</tr>"
          );
        })
        .join("");

      const adminSection = document.getElementById("adminApiKeySection");
      if (adminSection) {
        adminSection.style.display = snap.isAdminView ? "flex" : "none";
      }
      if (snap.isAdminView) {
        document.getElementById("adminApiKeysBody").innerHTML = (snap.apiKeys || [])
          .map(function (ak) {
            const whoUsed = ak.usedByUser
              ? ak.usedByUser.displayName || ak.usedByUser.username || ak.usedByUser.userId || ""
              : "Hələ işlədilməyib";
            return (
              "<tr>" +
              "<td><code>" +
              escapeHtmlClient(ak.code) +
              "</code></td>" +
              "<td>" +
              escapeHtmlClient(ak.planName) +
              "</td>" +
              "<td>" +
              escapeHtmlClient(ak.label || "-") +
              "</td>" +
              "<td>" +
              escapeHtmlClient(whoUsed) +
              "</td>" +
              "<td>" +
              (ak.revoked ? "Ləğv edilib" : "Aktiv") +
              "</td>" +
              "<td><button class='btn btn-danger btn-sm' data-revoke-api='" +
              escapeHtmlClient(ak.id) +
              "'>Sil</button></td>" +
              "</tr>"
            );
          })
          .join("");

        document.querySelectorAll("[data-revoke-api]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            try {
              await apiRequest(
                "/api/admin/api-keys/" + encodeURIComponent(btn.getAttribute("data-revoke-api")),
                "DELETE"
              );
              showToast("API açar silindi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });
      }

      const defaultDesignFallback = {
        title: "SADO PROTECT • Lisenziya & Script Paneli",
        description:
          "Aşağıdakı düymələrdən istifadə edərək lisenziya açarınızı aktivləşdirə, HWID sıfırlaya və ya scriptinizi əldə edə bilərsiniz.",
        color: 6323199,
        footerText: "SADO PROTECT • Premium Təhlükəsizlik Sistemi",
        imageUrl: "",
        buttons: [
          { id: "btn_redeem_key", label: "Reedem Key", style: 1, emoji: "🔑" },
          { id: "btn_get_script", label: "Get Script", style: 3, emoji: "📜" },
          { id: "btn_reset_hwid", label: "Reset HWID", style: 4, emoji: "⚙️" },
          { id: "btn_stats", label: "Statistikam", style: 2, emoji: "📊" }
        ]
      };

      const incomingDesign =
        snap.panelDesign && typeof snap.panelDesign === "object" && Array.isArray(snap.panelDesign.buttons) && snap.panelDesign.buttons.length > 0
          ? snap.panelDesign
          : defaultDesignFallback;

      if (
        prevOwnerId !== nextOwnerId ||
        !clientState.draftDesign ||
        !Array.isArray(clientState.draftDesign.buttons) ||
        clientState.draftDesign.buttons.length === 0
      ) {
        clientState.draftDesign = JSON.parse(JSON.stringify(incomingDesign));
        renderDesignEditor();
      }
    };

    const refreshDashboardSnapshot = async () => {
      try {
        const queryStr = isAdminQuery ? "?admin=1" : "";
        const snap = await apiRequest("/api/snapshot" + queryStr, "GET");
        applySnapshotToUi(snap);
      } catch (err) {
        showToast(err.message);
      }
    };

    const bindDashboardEvents = () => {
      document.querySelectorAll(".nav-btn").forEach((btn) => {
        btn.onclick = () => {
          document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const tabName = btn.getAttribute("data-tab");
          document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
          const pane = document.getElementById("tab-" + tabName);
          if (pane) pane.classList.add("active");
          if (pane && window.innerWidth <= 820) pane.scrollIntoView({ behavior: "smooth" });
        };
      });

      const cornerProfileBtn = document.getElementById("cornerProfileBtn");
      const accountPopover = document.getElementById("discordAccountPopover");
      if (cornerProfileBtn && accountPopover) {
        cornerProfileBtn.onclick = (ev) => {
          ev.stopPropagation();
          accountPopover.classList.toggle("open");
        };
        document.addEventListener("click", (ev) => {
          if (!accountPopover.contains(ev.target) && ev.target !== cornerProfileBtn) {
            accountPopover.classList.remove("open");
          }
        });
      }

      const disconnectBtn = document.getElementById("disconnectDiscordBtn");
      if (disconnectBtn) {
        disconnectBtn.onclick = async () => {
          try {
            await apiRequest("/api/auth/discord/logout", "POST", {});
            clientState.deviceGuildId = "";
            localStorage.removeItem(CLIENT_GUILD_STORAGE_KEY);
            showToast("Discord hesabı ayrıldı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const refreshBtn = document.getElementById("refreshSnapshotBtn");
      if (refreshBtn) refreshBtn.onclick = refreshDashboardSnapshot;

      const saveGuildBtn = document.getElementById("saveGuildSettingsBtn");
      if (saveGuildBtn) {
        saveGuildBtn.onclick = async () => {
          try {
            const guildId = document.getElementById("guildIdInput").value.trim();
            const panelChannelId = document.getElementById("panelChannelInput").value.trim();
            if (guildId) {
              clientState.deviceGuildId = guildId;
              localStorage.setItem(CLIENT_GUILD_STORAGE_KEY, guildId);
            }
            const saveRes = await apiRequest("/api/guild/settings", "POST", { guildId, panelChannelId });
            if (saveRes && saveRes.guildName && document.getElementById("headerGuildName")) {
              document.getElementById("headerGuildName").textContent = saveRes.guildName;
            }
            showToast("Sunucu və kanal yadda saxlandı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const triggerSendPanel = async () => {
        try {
          const guildId = document.getElementById("guildIdInput").value.trim();
          const channelId = document.getElementById("panelChannelInput").value.trim();
          await apiRequest("/api/panel/send", "POST", { guildId, channelId });
          showToast("Panel kanala göndərildi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      };

      const sendPanelQuickBtn = document.getElementById("sendPanelQuickBtn");
      if (sendPanelQuickBtn) sendPanelQuickBtn.onclick = triggerSendPanel;

      const sendDesignedPanelBtn = document.getElementById("sendDesignedPanelBtn");
      if (sendDesignedPanelBtn) sendDesignedPanelBtn.onclick = triggerSendPanel;

      const scriptModeSelect = document.getElementById("scriptModeSelect");
      const scriptFileRow = document.getElementById("scriptFileRow");
      const scriptFileInput = document.getElementById("scriptFileInput");
      if (scriptModeSelect && scriptFileRow) {
        scriptModeSelect.onchange = () => {
          scriptFileRow.style.display = scriptModeSelect.value === "file" ? "flex" : "none";
        };
      }
      if (scriptFileInput) {
        scriptFileInput.onchange = async () => {
          const file = scriptFileInput.files && scriptFileInput.files[0];
          if (!file) return;
          const text = await file.text();
          document.getElementById("scriptCodeInput").value = text;
          const nameInp = document.getElementById("scriptNameInput");
          if (nameInp && !nameInp.value.trim()) {
            nameInp.value = file.name.replace(/\\.[^/.]+$/, "");
          }
          showToast("Dosya yükləndi: " + file.name);
        };
      }

      const createScriptBtn = document.getElementById("createScriptBtn");
      if (createScriptBtn) {
        createScriptBtn.onclick = async () => {
          try {
            const name = document.getElementById("scriptNameInput").value.trim();
            const mode = document.getElementById("scriptModeSelect").value;
            const url = document.getElementById("scriptUrlInput").value.trim();
            const code = document.getElementById("scriptCodeInput").value;
            const fileName =
              scriptFileInput && scriptFileInput.files && scriptFileInput.files[0]
                ? scriptFileInput.files[0].name
                : "";
            await apiRequest("/api/scripts", "POST", { name, mode, url, code, fileName });
            document.getElementById("scriptNameInput").value = "";
            document.getElementById("scriptUrlInput").value = "";
            document.getElementById("scriptCodeInput").value = "";
            if (scriptFileInput) scriptFileInput.value = "";
            showToast("Script yaradıldı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const editScriptFileInput = document.getElementById("editScriptFileInput");
      if (editScriptFileInput) {
        editScriptFileInput.onchange = async () => {
          const file = editScriptFileInput.files && editScriptFileInput.files[0];
          if (!file) return;
          const text = await file.text();
          document.getElementById("editScriptCodeInput").value = text;
          document.getElementById("editScriptModeSelect").value = "file";
          const editNameInp = document.getElementById("editScriptNameInput");
          if (editNameInp && !editNameInp.value.trim()) {
            editNameInp.value = file.name.replace(/\\.[^/.]+$/, "");
          }
          showToast("Dosya yükləndi: " + file.name);
        };
      }

      const saveUpdatedScriptBtn = document.getElementById("saveUpdatedScriptBtn");
      const cancelEditScriptBtn = document.getElementById("cancelEditScriptBtn");
      if (cancelEditScriptBtn) {
        cancelEditScriptBtn.onclick = () => {
          const box = document.getElementById("editScriptModalBox");
          if (box) box.style.display = "none";
        };
      }
      if (saveUpdatedScriptBtn) {
        saveUpdatedScriptBtn.onclick = async () => {
          try {
            const scriptId = document.getElementById("editScriptIdInput").value.trim();
            const name = document.getElementById("editScriptNameInput").value.trim();
            const mode = document.getElementById("editScriptModeSelect").value;
            const url = document.getElementById("editScriptUrlInput").value.trim();
            const code = document.getElementById("editScriptCodeInput").value;
            const fileName =
              editScriptFileInput && editScriptFileInput.files && editScriptFileInput.files[0]
                ? editScriptFileInput.files[0].name
                : "";
            await apiRequest("/api/scripts/" + encodeURIComponent(scriptId), "PUT", {
              name,
              mode,
              url,
              code,
              fileName
            });
            const box = document.getElementById("editScriptModalBox");
            if (box) box.style.display = "none";
            showToast("Script yeniləndi (Update)");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const createLicenseKeyBtn = document.getElementById("createLicenseKeyBtn");
      if (createLicenseKeyBtn) {
        createLicenseKeyBtn.onclick = async () => {
          try {
            const code = document.getElementById("keyCustomCodeInput").value.trim();
            const scriptId = document.getElementById("keyScriptSelect").value;
            await apiRequest("/api/keys", "POST", { code, scriptId });
            document.getElementById("keyCustomCodeInput").value = "";
            showToast("Lisenziya keyi yaradıldı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const savePanelDesignBtn = document.getElementById("savePanelDesignBtn");
      if (savePanelDesignBtn) {
        savePanelDesignBtn.onclick = async () => {
          try {
            if (!clientState.draftDesign) return;
            clientState.draftDesign.title = document.getElementById("designTitleInput").value.trim();
            clientState.draftDesign.description = document.getElementById("designDescInput").value.trim();
            clientState.draftDesign.footerText = document.getElementById("designFooterInput").value.trim();
            await apiRequest("/api/panel-design", "POST", { panelDesign: clientState.draftDesign });
            showToast("Panel dizaynı yadda saxlandı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const addWhitelistBtn = document.getElementById("addWhitelistBtn");
      if (addWhitelistBtn) {
        addWhitelistBtn.onclick = async () => {
          try {
            const discordId = document.getElementById("wlDiscordIdInput").value.trim();
            const scriptId = document.getElementById("wlScriptSelect").value;
            await apiRequest("/api/whitelist", "POST", { discordId, scriptId });
            document.getElementById("wlDiscordIdInput").value = "";
            showToast("Whitelist-ə əlavə edildi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const addBlacklistBtn = document.getElementById("addBlacklistBtn");
      if (addBlacklistBtn) {
        addBlacklistBtn.onclick = async () => {
          try {
            const discordId = document.getElementById("blDiscordIdInput").value.trim();
            await apiRequest("/api/blacklist", "POST", { discordId });
            document.getElementById("blDiscordIdInput").value = "";
            showToast("Blacklist-ə əlavə edildi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const activateUserApiKeyBtn = document.getElementById("activateUserApiKeyBtn");
      if (activateUserApiKeyBtn) {
        activateUserApiKeyBtn.onclick = async () => {
          try {
            const apiKey = document.getElementById("userApiKeyInput").value.trim();
            const discordUserInput = document.getElementById("apiUserDiscordNameInput").value.trim();
            await apiRequest("/api/plan/activate-api", "POST", { apiKey, discordUserInput });
            document.getElementById("userApiKeyInput").value = "";
            showToast("Plan API açarla bağlandı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }

      const createAdminApiBtn = document.getElementById("createAdminApiKeyBtn");
      if (createAdminApiBtn) {
        createAdminApiBtn.onclick = async () => {
          try {
            const planId = document.getElementById("adminApiPlanSelect").value;
            const label = document.getElementById("adminApiLabelInput").value.trim();
            await apiRequest("/api/admin/api-keys", "POST", { planId, label });
            document.getElementById("adminApiLabelInput").value = "";
            showToast("Yeni API açar yaradıldı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        };
      }
    };

    document.addEventListener("DOMContentLoaded", () => {
      bindDashboardEvents();
      refreshDashboardSnapshot();
    });
  </script>
</body>
</html>`;
};

const createHttpServer = () => {
  return http.createServer(async (req, res) => {
    try {
      const baseUrl = getBaseUrlFromRequest(req);
      const reqUrl = new URL(req.url || "/", baseUrl);
      const pathname = reqUrl.pathname;
      const method = String(req.method || "GET").toUpperCase();
      const sessionUser = getSessionDiscordUserFromRequest(req);
      const sessionUid = sanitizeSnowflakeId(sessionUser && sessionUser.userId);

      if (method === "GET" && pathname === "/loader-report") {
        const repUid = sanitizeSnowflakeId(reqUrl.searchParams.get("uid") || "");
        const repGid = sanitizeSnowflakeId(reqUrl.searchParams.get("gid") || "");
        const repReason = sanitizeText(reqUrl.searchParams.get("reason") || "ANTI_LEAK", "ANTI_LEAK").slice(0, 80);
        const ownerId = repGid ? resolveOwnerDiscordIdForGuild(repGid) : "";
        if (repUid) {
          const bl = getBlacklistForGuild(repGid, ownerId);
          if (!bl.some((b) => String(b.discordId) === repUid)) {
            bl.push({
              discordId: repUid,
              reason: `Auto-Blacklist (${repReason})`,
              addedAt: new Date().toISOString()
            });
            syncAccountAndTenant(ownerId, repGid);
            saveAppStateToDisk();
            appendAuditLog("AUTO_BLACKLIST_LEAK", `${repUid} -> ${repReason}`, repGid, ownerId);
          }
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("-- blocked");
        return;
      }

      if (method === "GET" && pathname.startsWith("/loader/")) {
        const requestedScriptId = decodeURIComponent(pathname.replace("/loader/", "")).trim();
        const providedKey = sanitizeText(reqUrl.searchParams.get("key") || "", "").toUpperCase();
        const providedUid = sanitizeSnowflakeId(reqUrl.searchParams.get("uid") || "");
        const providedGid = sanitizeSnowflakeId(reqUrl.searchParams.get("gid") || "");

        const uaHeader = String(req.headers["user-agent"] || "").toLowerCase();
        const acceptHeader = String(req.headers["accept"] || "").toLowerCase();
        const isBrowserRequest =
          acceptHeader.includes("text/html") &&
          !uaHeader.includes("roblox") &&
          /mozilla|chrome|safari|firefox|edge|opera/.test(uaHeader);

        if (isBrowserRequest) {
          res.writeHead(403, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, private"
          });
          res.end("-- Protected by SADO PROTECT");
          return;
        }

        const sendLuaError = (reasonText) => {
          const safeReason = String(reasonText || "Access Denied").replace(/"/g, '\\"');
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store"
          });
          res.end(`warn("[SADO PROTECT] ${safeReason}")`);
        };

        const sendLuaKick = (kickReason) => {
          const safeKick = String(kickReason || "HWID basqa cihaza baglidir!")
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
          const luaKickCode = [
            "(function()",
            "  local Players = game:GetService('Players')",
            "  local lp = Players.LocalPlayer",
            `  local msg = "[SADO PROTECT] ${safeKick}"`,
            "  local function _doKick(p)",
            "    if p then pcall(function() p:Kick(msg) end) end",
            "  end",
            "  if lp then _doKick(lp) end",
            "  Players.PlayerAdded:Connect(function(p)",
            "    if p == Players.LocalPlayer then _doKick(p) end",
            "  end)",
            "  task.spawn(function()",
            "    for _ = 1, 20 do",
            "      lp = Players.LocalPlayer",
            "      if lp then _doKick(lp) end",
            "      task.wait(0.25)",
            "    end",
            "  end)",
            "end)()"
          ].join("\n");
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store"
          });
          res.end(luaKickCode);
        };

        const rawHeaderHwid = sanitizeText(
          String(
            req.headers["syn-fingerprint"] ||
              req.headers["sw-fingerprint"] ||
              req.headers["exploit-guid"] ||
              req.headers["flux-fingerprint"] ||
              req.headers["krnl-hwid"] ||
              req.headers["x-hwid"] ||
              req.headers["fingerprint"] ||
              reqUrl.searchParams.get("hwid") ||
              ""
          ),
          ""
        ).slice(0, 180);

        const clientIp = sanitizeText(
          String(
            req.headers["x-forwarded-for"] ||
              (req.socket && req.socket.remoteAddress) ||
              ""
          )
            .split(",")[0]
            .trim(),
          ""
        );

        const effectiveHwid =
          rawHeaderHwid ||
          `DEV-${crypto
            .createHash("sha256")
            .update(`${clientIp || "local"}|${uaHeader || "exec"}`)
            .digest("hex")
            .slice(0, 24)}`;

        let matchedGuildId = providedGid;
        let matchedOwnerId = providedGid ? resolveOwnerDiscordIdForGuild(providedGid) : "";
        let matchedKey = null;

        const searchKeyInList = (list = []) => {
          if (!Array.isArray(list)) return null;
          if (providedKey) {
            return list.find(
              (k) => String(k.code || "").toUpperCase() === providedKey && !k.revoked
            );
          }
          if (providedUid) {
            return list.find(
              (k) => String(k.claimedBy || "") === providedUid && !k.revoked
            );
          }
          return null;
        };

        if (matchedGuildId || matchedOwnerId) {
          matchedKey = searchKeyInList(getKeysForGuild(matchedGuildId, matchedOwnerId));
        }

        if (!matchedKey && APP_STATE.accounts && typeof APP_STATE.accounts === "object") {
          for (const [accUid, accRec] of Object.entries(APP_STATE.accounts)) {
            const found = searchKeyInList((accRec && accRec.keys) || []);
            if (found) {
              matchedOwnerId = accUid;
              matchedGuildId = matchedGuildId || sanitizeSnowflakeId(accRec && accRec.guildId);
              matchedKey = found;
              break;
            }
          }
        }

        if (!matchedKey && APP_STATE.tenants && typeof APP_STATE.tenants === "object") {
          for (const [gid, tRec] of Object.entries(APP_STATE.tenants)) {
            const found = searchKeyInList((tRec && tRec.keys) || []);
            if (found) {
              matchedGuildId = gid;
              matchedOwnerId = matchedOwnerId || sanitizeSnowflakeId(tRec && tRec.ownerDiscordId);
              matchedKey = found;
              break;
            }
          }
        }

        const wlList = getWhitelistForGuild(matchedGuildId, matchedOwnerId);
        let wlEntry = wlList.find(
          (w) =>
            (providedUid && String(w.discordId) === providedUid) ||
            (providedKey && String(w.keyCode || "").toUpperCase() === providedKey) ||
            (matchedKey && String(w.keyCode || "").toUpperCase() === String(matchedKey.code || "").toUpperCase())
        );

        if (!matchedKey && !wlEntry) {
          sendLuaError("Acar ve ya Whitelist tapilmadi!");
          return;
        }

        const effectiveKey =
          providedKey ||
          (matchedKey && matchedKey.code) ||
          (wlEntry && wlEntry.keyCode && wlEntry.keyCode !== "MANUAL-WL"
            ? wlEntry.keyCode
            : "SADO-ACTIVE-KEY");
        const effectiveUid =
          providedUid ||
          sanitizeSnowflakeId((matchedKey && matchedKey.claimedBy) || (wlEntry && wlEntry.discordId) || "");

        const blList = getBlacklistForGuild(matchedGuildId, matchedOwnerId);
        if (effectiveUid && blList.some((b) => String(b.discordId) === effectiveUid)) {
          sendLuaError("Siz Blacklist-desiniz!");
          return;
        }

        if (matchedKey && matchedKey.claimedBy && effectiveUid && String(matchedKey.claimedBy) !== effectiveUid) {
          sendLuaKick("Bu Key basqa Discord ID-sine baglidir!");
          return;
        }

        if (wlEntry && wlEntry.discordId && effectiveUid && String(wlEntry.discordId) !== effectiveUid) {
          sendLuaKick("Bu Whitelist basqa Discord ID-sine aiddir!");
          return;
        }

        if (!wlEntry && effectiveUid) {
          wlEntry = {
            discordId: effectiveUid,
            tag: (matchedKey && matchedKey.claimedByTag) || `User_${effectiveUid}`,
            keyCode: effectiveKey,
            scriptId: (matchedKey && matchedKey.scriptId) || "",
            hwid: "",
            lockedHwid: "",
            resetCount: 0,
            addedAt: new Date().toISOString()
          };
          wlList.push(wlEntry);
        }

        const boundHwid = sanitizeText(
          (wlEntry && (wlEntry.lockedHwid || wlEntry.hwid)) ||
            (matchedKey && (matchedKey.lockedHwid || matchedKey.hwid)) ||
            "",
          ""
        );

        const isNewBindSession = !boundHwid;
        if (isNewBindSession) {
          const lockIdToSave = effectiveHwid || `LOCK-${crypto.randomBytes(6).toString("hex")}`;
          if (wlEntry) {
            wlEntry.hwid = lockIdToSave;
            wlEntry.lockedHwid = lockIdToSave;
            wlEntry.lastBoundAt = new Date().toISOString();
          }
          if (matchedKey) {
            matchedKey.hwid = lockIdToSave;
            matchedKey.lockedHwid = lockIdToSave;
            matchedKey.lastBoundAt = new Date().toISOString();
          }
          appendAuditLog(
            "HWID_BOUND_FIRST_RUN",
            `UserID=${effectiveUid || "-"} Key=${effectiveKey} -> ${lockIdToSave.slice(0, 14)}`,
            matchedGuildId,
            matchedOwnerId
          );
        } else if (boundHwid !== effectiveHwid) {
          appendAuditLog(
            "HWID_MISMATCH_KICK",
            `UserID=${effectiveUid || "-"} Key=${effectiveKey} blocked on another device`,
            matchedGuildId,
            matchedOwnerId
          );
          sendLuaKick("HWID basqa cihaza kilidlenib! Yeniden baglamaq ucun Reset HWID edin.");
          return;
        }

        syncAccountAndTenant(matchedOwnerId, matchedGuildId);
        saveAppStateToDisk();

        const scripts = getScriptsForGuild(matchedGuildId, matchedOwnerId);
        const targetScript =
          (requestedScriptId &&
            requestedScriptId !== "default" &&
            scripts.find((s) => s.id === requestedScriptId)) ||
          (matchedKey && matchedKey.scriptId && scripts.find((s) => s.id === matchedKey.scriptId)) ||
          (wlEntry && wlEntry.scriptId && scripts.find((s) => s.id === wlEntry.scriptId)) ||
          scripts[0] ||
          null;

        if (!targetScript) {
          sendLuaError("Bu key ucun hec bir script tapilmadi!");
          return;
        }

        const safeKeyEsc = String(effectiveKey).replace(/"/g, '\\"');
        let bodyText = "";
        if (targetScript.mode === "url" && targetScript.url) {
          try {
            bodyText = await fetchRemoteLuaText(targetScript.url);
          } catch (remoteErr) {
            sendLuaError(remoteErr.message || "Uzaq script yuklenmedi!");
            return;
          }
        } else {
          bodyText =
            typeof targetScript.code === "string" && targetScript.code.trim()
              ? targetScript.code.trim()
              : `print("${sanitizeText(targetScript.name, "SADO Script").replace(/"/g, '\\"')} Loaded")`;
        }

        const xorKey = crypto.randomBytes(12).toString("hex");
        const rawBuf = Buffer.from(bodyText, "utf8");
        const encBytes = new Array(rawBuf.length);
        for (let i = 0; i < rawBuf.length; i++) {
          const kVal = xorKey.charCodeAt(i % xorKey.length);
          encBytes[i] = (rawBuf[i] ^ kVal ^ ((i * 7 + 11) & 255)) & 255;
        }

        const protectedPayload = [
          `local _k = "${xorKey}"`,
          `local _d = {${encBytes.join(",")}}`,
          "local function _bxor(a, b)",
          "  if bit32 and bit32.bxor then return bit32.bxor(a, b) end",
          "  local r, p = 0, 1",
          "  while a > 0 or b > 0 do",
          "    local aa, bb = a % 2, b % 2",
          "    if aa ~= bb then r = r + p end",
          "    a = (a - aa) / 2",
          "    b = (b - bb) / 2",
          "    p = p * 2",
          "  end",
          "  return r",
          "end",
          "local _t = {}",
          "for i = 1, #_d do",
          "  local kb = string.byte(_k, ((i - 1) % #_k) + 1)",
          "  local rv = ((i - 1) * 7 + 11) % 256",
          "  _t[i] = string.char(_bxor(_bxor(_d[i], kb), rv))",
          "end",
          `script_key = "${safeKeyEsc}"`,
          `if getgenv then getgenv().script_key = "${safeKeyEsc}" end`,
          "local _src = table.concat(_t)",
          "_d = nil; _t = nil",
          "local _f, _err = loadstring(_src)",
          "_src = nil",
          "if not _f then warn('[SADO PROTECT] Compile: ' .. tostring(_err)) return end",
          "local _ok, _rerr = pcall(_f)",
          "if not _ok then warn('[SADO PROTECT] Run: ' .. tostring(_rerr)) end"
        ].join("\n");

        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(protectedPayload);
        return;
      }

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = renderDashboardHtml();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname === "/auth/discord") {
        const callbackUrl = `${baseUrl}/auth/discord/callback`;
        const clientId = sanitizeText(process.env.DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID, "");
        const directOauthUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
          clientId
        )}&response_type=code&scope=identify&prompt=consent&redirect_uri=${encodeURIComponent(callbackUrl)}`;
        res.writeHead(302, { Location: directOauthUrl });
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/auth/discord/callback") {
        const oauthCode = sanitizeText(reqUrl.searchParams.get("code") || "", "");
        const callbackUrl = `${baseUrl}/auth/discord/callback`;
        let oauthAccount = null;
        if (oauthCode) {
          oauthAccount = await exchangeOAuthCodeForDiscordAccount(oauthCode, callbackUrl);
        }
        if (!oauthAccount) {
          res.writeHead(302, { Location: "/?oauth_error=1" });
          res.end();
          return;
        }
        const oauthUid = sanitizeSnowflakeId(oauthAccount.userId);
        if (oauthUid) {
          const acc = getAccountWorkspace(oauthUid, "", true);
          if (acc && acc.guildId) {
            const tRec = getTenantRecordByGuildId(acc.guildId, true, oauthUid);
            if (tRec && !tRec.ownerDiscordId) {
              tRec.ownerDiscordId = oauthUid;
            }
          }
        }
        saveAppStateToDisk();
        res.writeHead(302, {
          Location: "/",
          "Set-Cookie": buildSessionCookieHeader(oauthAccount, baseUrl)
        });
        res.end();
        return;
      }

      if (method === "POST" && pathname === "/api/auth/discord/logout") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": buildSessionCookieHeader(null, baseUrl)
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "GET" && pathname === "/health") {
        sendJsonResponse(res, 200, { ok: true, botConnected: BOT_RUNTIME.connected });
        return;
      }

      if (method === "GET" && pathname === "/api/snapshot") {
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null, sessionUser);
        const isAdminReq = reqUrl.searchParams.get("admin") === "1";
        const snapshot = await buildPublicSnapshotPayload(
          targetGuildId,
          isAdminReq,
          baseUrl,
          sessionUser
        );
        sendJsonResponse(res, 200, snapshot);
        return;
      }

      if (method === "POST" && pathname === "/api/guild/settings") {
        const body = await readJsonBody(req);
        const rawGuildInput = String(body.guildId || "").trim();
        const guildId = sanitizeSnowflakeId(rawGuildInput);
        const panelChannelId = sanitizeSnowflakeId(body.panelChannelId || "");

        if (rawGuildInput && !guildId) {
          sendJsonResponse(res, 400, {
            error: "Sunucu ID (Guild ID) düzgün deyil! Yalnız 15-22 rəqəmli Discord Sunucu ID daxil edin."
          });
          return;
        }

        if (guildId && sessionUid) {
          const existingOwner = resolveOwnerDiscordIdForGuild(guildId);
          if (existingOwner && existingOwner !== sessionUid) {
            sendJsonResponse(res, 403, {
              error: `Bu Sunucu ID (\`${guildId}\`) artıq başqa Discord hesabına (\`${existingOwner}\`) bağlıdır.`
            });
            return;
          }
        }

        let resolvedName = "";
        const acc = sessionUid ? getAccountWorkspace(sessionUid, guildId, true) : null;

        if (guildId) {
          const tenant = getTenantRecordByGuildId(guildId, true, sessionUid);
          if (tenant) {
            if (sessionUid && !tenant.ownerDiscordId) {
              tenant.ownerDiscordId = sessionUid;
            }
            if (panelChannelId) tenant.panelChannelId = panelChannelId;
            const info = await fetchGuildInfoFromDiscord(guildId);
            if (info && info.name) {
              resolvedName = info.name;
              tenant.guildName = resolvedName;
            } else {
              resolvedName = `Sunucu (${guildId.slice(-4)})`;
              tenant.guildName = resolvedName;
            }
          }
          if (acc) {
            acc.guildId = guildId;
            if (panelChannelId) acc.panelChannelId = panelChannelId;
            if (resolvedName) acc.guildName = resolvedName;
          }
        } else if (acc && panelChannelId) {
          acc.panelChannelId = panelChannelId;
        }
        saveAppStateToDisk();
        appendAuditLog(
          "GUILD_SETTINGS",
          `Guild=${resolvedName || guildId || "-"} Channel=${panelChannelId || "-"}`,
          guildId,
          sessionUid
        );
        sendJsonResponse(res, 200, { ok: true, guildId, guildName: resolvedName });
        return;
      }

      if (method === "POST" && pathname === "/api/panel/send") {
        const body = await readJsonBody(req);
        const rawGuildInput = String(body.guildId || "").trim();
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);

        if (rawGuildInput && !targetGuildId) {
          sendJsonResponse(res, 403, {
            error: "Daxil edilən Sunucu ID düzgün deyil və ya sizin hesabınıza aid deyil."
          });
          return;
        }

        const scoped = resolveScopedWorkspace(targetGuildId, sessionUid);
        const channelId = sanitizeSnowflakeId(
          body.channelId ||
            (scoped.acc ? scoped.acc.panelChannelId : "") ||
            (scoped.tenant ? scoped.tenant.panelChannelId : "") ||
            ""
        );
        if (!channelId) {
          sendJsonResponse(res, 400, {
            error: "Panel Kanal ID daxil edin və ya əvvəlcə sunucu/kanal parametrlərini yadda saxlayın."
          });
          return;
        }
        const sent = await sendPanelMessageToChannel(channelId, targetGuildId, "", sessionUid);
        appendAuditLog("SEND_PANEL", `Guild=${targetGuildId || "-"} Channel=${channelId}`, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true, messageId: sent && sent.id ? sent.id : "" });
        return;
      }

      if (method === "POST" && pathname === "/api/scripts") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const planMeta = getPlanMeta(getEffectivePlanForGuild(targetGuildId, sessionUid));
        const scripts = getScriptsForGuild(targetGuildId, sessionUid);

        if (planMeta.scriptLimit !== null && scripts.length >= planMeta.scriptLimit) {
          sendJsonResponse(res, 400, {
            error: `${planMeta.name} planı maksimum ${planMeta.scriptLimit} scriptə icazə verir.`
          });
          return;
        }

        const name = sanitizeText(body.name, "");
        if (!name) {
          sendJsonResponse(res, 400, { error: "Script adı daxil edin." });
          return;
        }
        const mode = body.mode === "url" ? "url" : body.mode === "file" ? "file" : "code";
        const url = sanitizeText(body.url, "");
        const code = typeof body.code === "string" ? body.code : "";
        const fileName = sanitizeText(body.fileName, "");

        const newScript = {
          id: `scr_${crypto.randomBytes(5).toString("hex")}`,
          name,
          mode,
          url,
          code,
          fileName,
          ownerDiscordId: sessionUid,
          createdAt: new Date().toISOString()
        };

        scripts.push(newScript);
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("CREATE_SCRIPT", name, targetGuildId, sessionUid);
        await syncSlashCommandsWithDiscord(targetGuildId, sessionUid);
        sendJsonResponse(res, 201, { ok: true, script: newScript });
        return;
      }

      if (method === "PUT" && pathname.startsWith("/api/scripts/")) {
        const scriptId = decodeURIComponent(pathname.replace("/api/scripts/", ""));
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const scripts = getScriptsForGuild(targetGuildId, sessionUid);
        const idx = scripts.findIndex((s) => s.id === scriptId);
        if (idx === -1) {
          sendJsonResponse(res, 404, { error: "Script tapılmadı." });
          return;
        }
        const current = scripts[idx];
        const nextName = sanitizeText(body.name, current.name);
        if (!nextName) {
          sendJsonResponse(res, 400, { error: "Script adı boş ola bilməz." });
          return;
        }
        const nextMode =
          body.mode === "url" || body.mode === "file" || body.mode === "code"
            ? body.mode
            : current.mode || "code";
        const updatedScript = {
          ...current,
          name: nextName,
          mode: nextMode,
          url: typeof body.url === "string" ? sanitizeText(body.url, "") : current.url || "",
          code: typeof body.code === "string" ? body.code : current.code || "",
          fileName:
            typeof body.fileName === "string" && body.fileName.trim()
              ? sanitizeText(body.fileName, "")
              : current.fileName || "",
          updatedAt: new Date().toISOString()
        };
        scripts[idx] = updatedScript;

        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("UPDATE_SCRIPT", updatedScript.name, targetGuildId, sessionUid);
        await syncSlashCommandsWithDiscord(targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true, script: updatedScript });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/scripts/")) {
        const scriptId = decodeURIComponent(pathname.replace("/api/scripts/", ""));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null, sessionUser);
        const nextScripts = getScriptsForGuild(targetGuildId, sessionUid).filter((s) => s.id !== scriptId);
        const { acc, tenant } = resolveScopedWorkspace(targetGuildId, sessionUid);
        if (acc) acc.scripts = nextScripts;
        if (tenant) tenant.scripts = nextScripts;
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("DELETE_SCRIPT", scriptId, targetGuildId, sessionUid);
        await syncSlashCommandsWithDiscord(targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/keys") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const keys = getKeysForGuild(targetGuildId, sessionUid);
        const customCode = sanitizeText(String(body.code || ""), "").toUpperCase();
        const code =
          customCode ||
          `SADO-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto
            .randomBytes(2)
            .toString("hex")
            .toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

        const newKey = {
          id: `key_${crypto.randomBytes(5).toString("hex")}`,
          code,
          scriptId: sanitizeText(body.scriptId, ""),
          claimedBy: "",
          claimedByTag: "",
          resetCount: 0,
          revoked: false,
          ownerDiscordId: sessionUid,
          createdAt: new Date().toISOString()
        };

        keys.push(newKey);
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("CREATE_KEY", code, targetGuildId, sessionUid);
        sendJsonResponse(res, 201, { ok: true, key: newKey });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/keys/")) {
        const keyId = decodeURIComponent(pathname.replace("/api/keys/", ""));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null, sessionUser);
        const keys = getKeysForGuild(targetGuildId, sessionUid);
        const removedKey = keys.find((k) => k.id === keyId);
        const nextKeys = keys.filter((k) => k.id !== keyId);

        let wl = getWhitelistForGuild(targetGuildId, sessionUid);
        if (removedKey && removedKey.code) {
          wl = wl.filter(
            (w) => String(w.keyCode || "").toUpperCase() !== String(removedKey.code || "").toUpperCase()
          );
        }

        const { acc, tenant } = resolveScopedWorkspace(targetGuildId, sessionUid);
        if (acc) {
          acc.keys = nextKeys;
          acc.whitelist = wl;
        }
        if (tenant) {
          tenant.keys = nextKeys;
          tenant.whitelist = wl;
        }
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("DELETE_KEY", removedKey ? removedKey.code : keyId, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/panel-design") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const normalized = normalizePanelDesign(body.panelDesign || body);
        const { acc, tenant } = resolveScopedWorkspace(targetGuildId, sessionUid);
        if (acc) acc.panelDesign = normalized;
        if (tenant) tenant.panelDesign = normalized;
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("SAVE_PANEL_DESIGN", normalized.title, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true, panelDesign: normalized });
        return;
      }

      if (method === "POST" && pathname === "/api/whitelist") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const discordId = sanitizeSnowflakeId(body.discordId || "");
        if (!discordId) {
          sendJsonResponse(res, 400, { error: "Düzgün Discord ID daxil edin." });
          return;
        }
        const wl = getWhitelistForGuild(targetGuildId, sessionUid);
        const keys = getKeysForGuild(targetGuildId, sessionUid);
        const idx = wl.findIndex((w) => String(w.discordId) === discordId);
        const chosenScriptId = sanitizeText(body.scriptId, "");

        let keyRec =
          idx >= 0 && wl[idx].keyCode && wl[idx].keyCode !== "MANUAL-WL"
            ? keys.find(
                (k) =>
                  String(k.code || "").toUpperCase() === String(wl[idx].keyCode || "").toUpperCase() &&
                  !k.revoked
              )
            : null;

        if (!keyRec) {
          keyRec = {
            id: `key_${crypto.randomBytes(5).toString("hex")}`,
            code: generateUniqueLicenseKeyCode(),
            scriptId: chosenScriptId,
            claimedBy: discordId,
            claimedByTag: `User_${discordId}`,
            claimedAt: new Date().toISOString(),
            resetCount: 0,
            revoked: false,
            ownerDiscordId: sessionUid,
            createdAt: new Date().toISOString()
          };
          keys.push(keyRec);
        }

        const entry = {
          discordId,
          tag: `User_${discordId}`,
          keyCode: keyRec.code,
          scriptId: chosenScriptId,
          hwid: idx >= 0 ? wl[idx].hwid || "" : "",
          lockedHwid: idx >= 0 ? wl[idx].lockedHwid || "" : "",
          resetCount: idx >= 0 ? Number(wl[idx].resetCount || 0) : 0,
          addedAt: new Date().toISOString()
        };
        if (idx >= 0) wl[idx] = entry;
        else wl.push(entry);

        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("ADD_WHITELIST", `${discordId} (Key: ${keyRec.code})`, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true, keyCode: keyRec.code });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/whitelist/")) {
        const targetUserId = sanitizeSnowflakeId(decodeURIComponent(pathname.replace("/api/whitelist/", "")));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null, sessionUser);
        const nextWl = getWhitelistForGuild(targetGuildId, sessionUid).filter(
          (w) => String(w.discordId) !== targetUserId
        );
        const { acc, tenant } = resolveScopedWorkspace(targetGuildId, sessionUid);
        if (acc) acc.whitelist = nextWl;
        if (tenant) tenant.whitelist = nextWl;
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("REMOVE_WHITELIST", targetUserId, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/blacklist") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const discordId = sanitizeSnowflakeId(body.discordId || "");
        if (!discordId) {
          sendJsonResponse(res, 400, { error: "Düzgün Discord ID daxil edin." });
          return;
        }
        const bl = getBlacklistForGuild(targetGuildId, sessionUid);
        if (!bl.some((b) => String(b.discordId) === discordId)) {
          bl.push({ discordId, addedAt: new Date().toISOString() });
        }
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("ADD_BLACKLIST", discordId, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/blacklist/")) {
        const targetUserId = sanitizeSnowflakeId(decodeURIComponent(pathname.replace("/api/blacklist/", "")));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null, sessionUser);
        const nextBl = getBlacklistForGuild(targetGuildId, sessionUid).filter(
          (b) => String(b.discordId) !== targetUserId
        );
        const { acc, tenant } = resolveScopedWorkspace(targetGuildId, sessionUid);
        if (acc) acc.blacklist = nextBl;
        if (tenant) tenant.blacklist = nextBl;
        syncAccountAndTenant(sessionUid, targetGuildId);
        saveAppStateToDisk();
        appendAuditLog("REMOVE_BLACKLIST", targetUserId, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/admin/api-keys") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const planId = normalizePlanId(body.planId || "premium_1");
        const label = sanitizeText(body.label, "");
        const code = `SADO-API-${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto
          .randomBytes(2)
          .toString("hex")
          .toUpperCase()}`;

        const record = {
          id: `ak_${crypto.randomBytes(5).toString("hex")}`,
          code,
          planId,
          label,
          revoked: false,
          createdAt: new Date().toISOString(),
          usedByUser: null,
          usedByGuildId: "",
          usedAt: ""
        };

        APP_STATE.apiKeys.unshift(record);
        saveAppStateToDisk();
        appendAuditLog("CREATE_API_KEY", `${code} (${planId})`, targetGuildId || "", sessionUid);
        sendJsonResponse(res, 201, { ok: true, apiKey: record });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/admin/api-keys/")) {
        const id = decodeURIComponent(pathname.replace("/api/admin/api-keys/", ""));
        const removedApiKey = (APP_STATE.apiKeys || []).find((k) => k.id === id) || null;
        APP_STATE.apiKeys = (APP_STATE.apiKeys || []).filter((k) => k.id !== id);

        if (removedApiKey && removedApiKey.code) {
          const targetCodeUpper = String(removedApiKey.code).toUpperCase();
          if (APP_STATE.accounts && typeof APP_STATE.accounts === "object") {
            for (const acc of Object.values(APP_STATE.accounts)) {
              if (acc && String(acc.activeApiKeyCode || "").toUpperCase() === targetCodeUpper) {
                acc.activeApiKeyCode = "";
                acc.activePlan = "free";
              }
            }
          }
          if (APP_STATE.tenants && typeof APP_STATE.tenants === "object") {
            for (const tenant of Object.values(APP_STATE.tenants)) {
              if (tenant && String(tenant.activeApiKeyCode || "").toUpperCase() === targetCodeUpper) {
                tenant.activeApiKeyCode = "";
                tenant.activePlan = "free";
              }
            }
          }
        }

        saveAppStateToDisk();
        appendAuditLog(
          "DELETE_API_KEY",
          removedApiKey ? `${removedApiKey.code} (Plan -> free)` : id,
          removedApiKey && removedApiKey.usedByGuildId ? removedApiKey.usedByGuildId : "",
          sessionUid
        );
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/plan/activate-api") {
        const body = await readJsonBody(req);
        const apiKeyCode = sanitizeText(String(body.apiKey || ""), "").toUpperCase();
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body, sessionUser);
        const foundApi = (APP_STATE.apiKeys || []).find(
          (k) => String(k.code || "").toUpperCase() === apiKeyCode && !k.revoked
        );

        if (!foundApi) {
          sendJsonResponse(res, 400, { error: "API açar tapılmadı və ya etibarsızdır." });
          return;
        }

        const normPlan = normalizePlanId(foundApi.planId);
        const customUserText = sanitizeText(String(body.discordUserInput || ""), "");
        const actorInfo = customUserText
          ? { userId: customUserText, username: customUserText, displayName: customUserText }
          : sessionUser || null;
        foundApi.usedByUser = actorInfo;
        foundApi.usedByGuildId = targetGuildId || "";
        foundApi.usedAt = new Date().toISOString();

        const { acc, tenant } = resolveScopedWorkspace(targetGuildId, sessionUid);
        if (acc) {
          acc.activePlan = normPlan;
          acc.activeApiKeyCode = foundApi.code;
        }
        if (tenant) {
          tenant.activePlan = normPlan;
          tenant.activeApiKeyCode = foundApi.code;
        }
        syncAccountAndTenant(sessionUid, targetGuildId);

        saveAppStateToDisk();
        appendAuditLog("ACTIVATE_API_PLAN", `${foundApi.code} -> ${normPlan}`, targetGuildId, sessionUid);
        sendJsonResponse(res, 200, { ok: true, plan: getPlanMeta(normPlan) });
        return;
      }

      sendJsonResponse(res, 404, { error: "Tapılmadı" });
    } catch (err) {
      sendJsonResponse(res, 500, { error: err.message || "Daxili server xətası" });
    }
  });
};

const startKeepAlivePing = () => {
  const selfUrl = sanitizeText(process.env.RENDER_EXTERNAL_URL || "", "");
  if (!selfUrl) return;
  setInterval(() => {
    httpsJsonRequest(`${selfUrl.replace(/\/$/, "")}/health`, "GET").catch(() => {});
  }, 4 * 60 * 1000);
};

const httpServer = createHttpServer();
httpServer.listen(PORT, "0.0.0.0", () => {
  fetchBotUserIdentity();
  startDiscordGatewayListener();
  startKeepAlivePing();
});
