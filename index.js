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

const loadInitialAppState = () => {
  ensureStorageDirectory();
  const baseState = {
    guildId: sanitizeSnowflakeId(process.env.DEFAULT_GUILD_ID || ""),
    guildName: "",
    panelChannelId: sanitizeSnowflakeId(process.env.DEFAULT_PANEL_CHANNEL_ID || ""),
    latestJoinedGuildId: "",
    connectedDiscordUser: null,
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

const appendAuditLog = (action, details = "", guildId = "") => {
  try {
    APP_STATE.auditLogs.unshift({
      id: `log_${crypto.randomBytes(6).toString("hex")}`,
      action: sanitizeText(action, "ACTION"),
      details: sanitizeText(details, ""),
      guildId: sanitizeSnowflakeId(guildId || APP_STATE.guildId || ""),
      timestamp: new Date().toISOString()
    });
    if (APP_STATE.auditLogs.length > 250) {
      APP_STATE.auditLogs = APP_STATE.auditLogs.slice(0, 250);
    }
    saveAppStateToDisk();
  } catch (_err) {}
};

const getTenantRecordByGuildId = (guildId, createIfMissing = true) => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return null;
  if (!APP_STATE.tenants || typeof APP_STATE.tenants !== "object") {
    APP_STATE.tenants = {};
  }
  if (!APP_STATE.tenants[cleanId]) {
    if (!createIfMissing) return null;
    const isPrimary = APP_STATE.guildId === cleanId;
    APP_STATE.tenants[cleanId] = {
      guildId: cleanId,
      guildName: isPrimary ? sanitizeText(APP_STATE.guildName, "") : "",
      panelChannelId: isPrimary ? sanitizeSnowflakeId(APP_STATE.panelChannelId) : "",
      botAddedBy: isPrimary && APP_STATE.connectedDiscordUser ? APP_STATE.connectedDiscordUser : null,
      activePlan: "free",
      activeApiKeyCode: "",
      scripts: isPrimary && Array.isArray(APP_STATE.scripts) ? APP_STATE.scripts : [],
      keys: isPrimary && Array.isArray(APP_STATE.keys) ? APP_STATE.keys : [],
      whitelist: isPrimary && Array.isArray(APP_STATE.whitelist) ? APP_STATE.whitelist : [],
      blacklist: isPrimary && Array.isArray(APP_STATE.blacklist) ? APP_STATE.blacklist : [],
      panelDesign: normalizePanelDesign(isPrimary ? APP_STATE.panelDesign : DEFAULT_PANEL_DESIGN)
    };
    saveAppStateToDisk();
  } else {
    const rec = APP_STATE.tenants[cleanId];
    rec.guildId = cleanId;
    rec.guildName = sanitizeText(rec.guildName, "");
    rec.panelChannelId = sanitizeSnowflakeId(rec.panelChannelId || "");
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

const syncTenantIntoGlobalIfPrimary = (tenant) => {
  if (!tenant || !tenant.guildId) return;
  if (!APP_STATE.guildId) {
    APP_STATE.guildId = tenant.guildId;
  }
  if (APP_STATE.guildId === tenant.guildId) {
    APP_STATE.guildName = sanitizeText(tenant.guildName, APP_STATE.guildName || "");
    APP_STATE.panelChannelId = sanitizeSnowflakeId(tenant.panelChannelId || APP_STATE.panelChannelId || "");
    APP_STATE.scripts = Array.isArray(tenant.scripts) ? tenant.scripts : [];
    APP_STATE.keys = Array.isArray(tenant.keys) ? tenant.keys : [];
    APP_STATE.whitelist = Array.isArray(tenant.whitelist) ? tenant.whitelist : [];
    APP_STATE.blacklist = Array.isArray(tenant.blacklist) ? tenant.blacklist : [];
    APP_STATE.panelDesign = normalizePanelDesign(tenant.panelDesign);
  }
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

const getScriptsForGuild = (guildId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (cleanId) {
    const tenant = getTenantRecordByGuildId(cleanId, true);
    if (tenant && Array.isArray(tenant.scripts)) {
      return tenant.scripts;
    }
  }
  return Array.isArray(APP_STATE.scripts) ? APP_STATE.scripts : [];
};

const getKeysForGuild = (guildId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (cleanId) {
    const tenant = getTenantRecordByGuildId(cleanId, true);
    if (tenant && Array.isArray(tenant.keys)) {
      return tenant.keys;
    }
  }
  return Array.isArray(APP_STATE.keys) ? APP_STATE.keys : [];
};

const getWhitelistForGuild = (guildId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (cleanId) {
    const tenant = getTenantRecordByGuildId(cleanId, true);
    if (tenant && Array.isArray(tenant.whitelist)) {
      return tenant.whitelist;
    }
  }
  return Array.isArray(APP_STATE.whitelist) ? APP_STATE.whitelist : [];
};

const getBlacklistForGuild = (guildId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (cleanId) {
    const tenant = getTenantRecordByGuildId(cleanId, true);
    if (tenant && Array.isArray(tenant.blacklist)) {
      return tenant.blacklist;
    }
  }
  return Array.isArray(APP_STATE.blacklist) ? APP_STATE.blacklist : [];
};

const getPanelDesignForGuild = (guildId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (cleanId) {
    const tenant = getTenantRecordByGuildId(cleanId, true);
    if (tenant && tenant.panelDesign) {
      return normalizePanelDesign(tenant.panelDesign);
    }
  }
  return normalizePanelDesign(APP_STATE.panelDesign);
};

const getEffectivePlanForGuild = (guildId = "") => {
  const cleanId = sanitizeSnowflakeId(guildId || APP_STATE.guildId || "");
  if (cleanId) {
    const tenant = getTenantRecordByGuildId(cleanId, true);
    if (tenant) {
      const boundApiKey = sanitizeText(tenant.activeApiKeyCode, "");
      if (boundApiKey) {
        const keyRec = (APP_STATE.apiKeys || []).find(
          (k) => String(k.code || "").toUpperCase() === boundApiKey.toUpperCase()
        );
        if (keyRec && !keyRec.revoked) {
          const normalized = normalizePlanId(keyRec.planId);
          tenant.activePlan = normalized;
          return normalized;
        }
      }
      return normalizePlanId(tenant.activePlan || "free");
    }
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
          name: realName
        };
      }
    }
  } catch (_err) {}

  try {
    const gListRes = await discordApiRequest(`/users/@me/guilds?limit=200`, "GET");
    const guildArr = Array.isArray(gListRes && gListRes.data) ? gListRes.data : [];
    const matched = guildArr.find((g) => g && String(g.id) === cleanId);
    if (matched && sanitizeText(matched.name, "")) {
      return {
        id: cleanId,
        name: sanitizeText(matched.name, "")
      };
    }
  } catch (_err2) {}

  const existingTenant =
    APP_STATE.tenants && typeof APP_STATE.tenants === "object" ? APP_STATE.tenants[cleanId] : null;
  if (existingTenant && sanitizeText(existingTenant.guildName, "")) {
    const cachedName = sanitizeText(existingTenant.guildName, "");
    if (
      !/^Discord Sunucusu/i.test(cachedName) &&
      !/^Sunucu\s*\(/i.test(cachedName) &&
      !/^Sunucu\s*#/i.test(cachedName) &&
      !/^Sunucu$/i.test(cachedName)
    ) {
      return {
        id: cleanId,
        name: cachedName
      };
    }
  }

  const globalName = sanitizeText(APP_STATE.guildName, "");
  if (
    APP_STATE.guildId === cleanId &&
    globalName &&
    !/^Discord Sunucusu/i.test(globalName) &&
    !/^Sunucu\s*\(/i.test(globalName) &&
    !/^Sunucu\s*#/i.test(globalName) &&
    !/^Sunucu$/i.test(globalName)
  ) {
    return {
      id: cleanId,
      name: globalName
    };
  }

  return null;
};

const getScriptContentForUser = (guildId = "", userId = "", preferredScriptId = "", activeKeyCode = "") => {
  const scripts = getScriptsForGuild(guildId);
  const chosen =
    (preferredScriptId && scripts.find((s) => s.id === preferredScriptId)) ||
    scripts[0] ||
    null;

  const scriptName = chosen
    ? sanitizeText(chosen.name, "SADO PROTECT Script")
    : "SADO PROTECT Script";
  const safeKey = sanitizeText(activeKeyCode, "SADO-ACTIVE-KEY");
  const safeUserId = sanitizeText(userId, "0");

  if (chosen && chosen.mode === "url" && chosen.url) {
    return {
      scriptName,
      code: [
        `script_key = "${safeKey}";`,
        `-- ${scriptName} • SADO PROTECT Loader (Junkie / LuaArmor / LuaProtect style)`,
        `loadstring(game:HttpGet("${chosen.url}"))()`
      ].join("\n")
    };
  }

  if (chosen && chosen.code && chosen.code.trim().length > 0 && chosen.code.trim().length <= 420) {
    return {
      scriptName,
      code: [
        `script_key = "${safeKey}";`,
        `-- ${scriptName} • Protected by SADO PROTECT`,
        chosen.code.trim()
      ].join("\n")
    };
  }

  return {
    scriptName,
    code: [
      `script_key = "${safeKey}";`,
      `getgenv().SadoProtect = { User = "${safeUserId}", Script = "${scriptName}", Key = "${safeKey}" };`,
      `loadstring(game:HttpGet("https://api.sado-protect.local/loader/${encodeURIComponent(chosen ? chosen.id : "default")}?uid=${encodeURIComponent(safeUserId)}"))()`
    ].join("\n")
  };
};

const buildSafeCustomId = (baseId, scriptId = "") => {
  const cleanBase = sanitizeText(baseId, "btn").slice(0, 60);
  const cleanScript = sanitizeText(scriptId, "").slice(0, 32);
  if (!cleanScript) return cleanBase;
  const combined = `${cleanBase}::${cleanScript}`;
  return combined.length <= 100 ? combined : cleanBase;
};

const sendPanelMessageToChannel = async (channelId, guildId = "", scriptId = "") => {
  const targetChannelId = sanitizeSnowflakeId(channelId);
  if (!targetChannelId) {
    throw new Error("Panel göndəriləcək kanal ID-si düzgün deyil.");
  }

  const design = getPanelDesignForGuild(guildId);
  const scripts = getScriptsForGuild(guildId);
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
  const guildId = sanitizeSnowflakeId(interaction.guild_id || APP_STATE.guildId || "");
  const memberUser =
    (interaction.member && interaction.member.user) || interaction.user || {};
  const actorId = String(memberUser.id || "");
  const actorTag = sanitizeText(
    memberUser.global_name || memberUser.username || `User_${actorId}`,
    `User_${actorId}`
  );

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

      if (cmdName === "panel") {
        const chosenScriptId = sanitizeText(String(getOpt("script") || ""), "");
        const targetCh = sanitizeSnowflakeId(
          interaction.channel_id ||
            (guildId ? getTenantRecordByGuildId(guildId, true).panelChannelId : "") ||
            APP_STATE.panelChannelId ||
            ""
        );
        await sendPanelMessageToChannel(targetCh, guildId, chosenScriptId);
        const scripts = getScriptsForGuild(guildId);
        const sObj = scripts.find((s) => s.id === chosenScriptId);
        const labelText = sObj ? ` (**${sObj.name}**)` : "";
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `✅ Panel${labelText} <#${targetCh}> kanalına göndərildi.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "key") {
        const inputKey = sanitizeText(String(getOpt("key") || ""), "").toUpperCase();
        const keys = getKeysForGuild(guildId);
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

        foundKey.claimedBy = actorId;
        foundKey.claimedByTag = actorTag;
        foundKey.claimedAt = new Date().toISOString();

        const wl = getWhitelistForGuild(guildId);
        const existingIdx = wl.findIndex((w) => String(w.discordId) === actorId);
        const wlRecord = {
          discordId: actorId,
          tag: actorTag,
          keyCode: foundKey.code,
          scriptId: foundKey.scriptId || "",
          hwid: existingIdx >= 0 ? wl[existingIdx].hwid || "" : "",
          addedAt: new Date().toISOString()
        };
        if (existingIdx >= 0) {
          wl[existingIdx] = wlRecord;
        } else {
          wl.push(wlRecord);
        }

        const tenant = guildId ? getTenantRecordByGuildId(guildId, true) : null;
        if (tenant) {
          syncTenantIntoGlobalIfPrimary(tenant);
        }
        saveAppStateToDisk();

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `✅ Açar (\`${foundKey.code}\`) uğurla aktivləşdirildi və **${actorTag}** Whitelist-ə əlavə edildi!`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "whitelist") {
        const rawUserVal = getOpt("user");
        const targetUserId = sanitizeSnowflakeId(rawUserVal || actorId);
        if (!targetUserId) {
          await respondToDiscordInteraction(interactionId, interactionToken, {
            type: 4,
            data: {
              content: "❌ Zəhmət olmasa sunucudan bir istifadəçi seçin.",
              flags: 64
            }
          });
          return;
        }

        const resolvedUsersMap =
          (interaction.data && interaction.data.resolved && interaction.data.resolved.users) || {};
        const resolvedMembersMap =
          (interaction.data && interaction.data.resolved && interaction.data.resolved.members) || {};
        const pickedUserObj = resolvedUsersMap[targetUserId] || null;
        const pickedMemberObj = resolvedMembersMap[targetUserId] || null;
        const pickedUserTag = pickedUserObj
          ? sanitizeText(
              (pickedMemberObj && pickedMemberObj.nick) ||
                pickedUserObj.global_name ||
                pickedUserObj.username,
              `User_${targetUserId}`
            )
          : targetUserId === actorId
            ? actorTag
            : `User_${targetUserId}`;

        const targetScriptId = sanitizeText(String(getOpt("script") || ""), "");
        const scripts = getScriptsForGuild(guildId);
        const chosenScriptObj = scripts.find((s) => s.id === targetScriptId) || null;

        const wl = getWhitelistForGuild(guildId);
        const idx = wl.findIndex((w) => String(w.discordId) === targetUserId);
        const record = {
          discordId: targetUserId,
          tag: pickedUserTag,
          keyCode: idx >= 0 ? wl[idx].keyCode || "MANUAL-WL" : "MANUAL-WL",
          scriptId: targetScriptId || (idx >= 0 ? wl[idx].scriptId || "" : ""),
          hwid: idx >= 0 ? wl[idx].hwid || "" : "",
          addedAt: new Date().toISOString()
        };
        if (idx >= 0) wl[idx] = record;
        else wl.push(record);

        const tenant = guildId ? getTenantRecordByGuildId(guildId, true) : null;
        if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
        saveAppStateToDisk();

        const scriptText = chosenScriptObj ? ` (**${chosenScriptObj.name}** scriptinə)` : "";
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `🛡️ <@${targetUserId}>${scriptText} Whitelist-ə əlavə olundu.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "unwhitelist") {
        const targetUserId = sanitizeSnowflakeId(String(getOpt("user") || ""));
        const wl = getWhitelistForGuild(guildId);
        const nextWl = wl.filter((w) => String(w.discordId) !== targetUserId);
        if (guildId) {
          const tenant = getTenantRecordByGuildId(guildId, true);
          if (tenant) {
            tenant.whitelist = nextWl;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.whitelist = nextWl;
        }
        saveAppStateToDisk();

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `🗑️ <@${targetUserId}> Whitelist-dən çıxarıldı.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "resethwid") {
        const wl = getWhitelistForGuild(guildId);
        const entry = wl.find((w) => String(w.discordId) === actorId);
        if (entry) {
          entry.hwid = "";
          if (guildId) {
            const tenant = getTenantRecordByGuildId(guildId, true);
            if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
          }
          saveAppStateToDisk();
        }
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⚙️ **${actorTag}** üçün HWID sıfırlandı.`,
            flags: 64
          }
        });
        return;
      }
    }

    if (interactionType === 3) {
      const rawCustomId = sanitizeText(interaction.data && interaction.data.custom_id, "");
      const { baseId: customId, boundScriptId } = parseCustomIdAndScript(rawCustomId);

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
        const wl = getWhitelistForGuild(guildId);
        const keys = getKeysForGuild(guildId);
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
        const activeKeyLabel =
          userWl.keyCode === "MANUAL-WL" ? "WHITELIST-KEY" : String(userWl.keyCode || "");
        const scriptInfo = getScriptContentForUser(
          guildId,
          actorId,
          effectiveScriptId,
          activeKeyLabel
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
        const wl = getWhitelistForGuild(guildId);
        const userWl = wl.find((w) => String(w.discordId) === actorId);
        const scriptInfo = getScriptContentForUser(
          guildId,
          actorId,
          boundScriptId || (userWl ? userWl.scriptId || "" : ""),
          userWl ? userWl.keyCode || "" : ""
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
        const wl = getWhitelistForGuild(guildId);
        const entry = wl.find((w) => String(w.discordId) === actorId);
        if (entry) {
          entry.hwid = "";
          if (guildId) {
            const tenant = getTenantRecordByGuildId(guildId, true);
            if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
          }
          saveAppStateToDisk();
        }
        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `⚙️ **${actorTag}** üçün HWID uğurla sıfırlandı.`,
            flags: 64
          }
        });
        return;
      }

      if (customId === "btn_stats") {
        const wl = getWhitelistForGuild(guildId);
        const keys = getKeysForGuild(guildId);
        const userWl = wl.find((w) => String(w.discordId) === actorId);
        const userKeys = keys.filter((k) => String(k.claimedBy || "") === actorId && !k.revoked);
        const planMeta = getPlanMeta(getEffectivePlanForGuild(guildId));

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: [
              `📊 **${actorTag}** Statistikası`,
              `• Discord ID: \`${actorId}\``,
              `• Sunucu Planı: **${planMeta.name}**`,
              `• Whitelist Statusu: **${userWl ? "Aktiv ✅" : "Deaktiv ❌"}**`,
              `• Aktiv Açarlar: **${userKeys.length}**`,
              `• HWID Vəziyyəti: **${userWl && userWl.hwid ? "Bağlıdır 🔒" : "Boşdur 🔓"}**`
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

        const keys = getKeysForGuild(guildId);
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

        foundKey.claimedBy = actorId;
        foundKey.claimedByTag = actorTag;
        foundKey.claimedAt = new Date().toISOString();

        const wl = getWhitelistForGuild(guildId);
        const existingIdx = wl.findIndex((w) => String(w.discordId) === actorId);
        const nextWlEntry = {
          discordId: actorId,
          tag: actorTag,
          keyCode: foundKey.code,
          scriptId: boundScriptId || foundKey.scriptId || "",
          hwid: existingIdx >= 0 ? wl[existingIdx].hwid || "" : "",
          addedAt: new Date().toISOString()
        };
        if (existingIdx >= 0) {
          wl[existingIdx] = nextWlEntry;
        } else {
          wl.push(nextWlEntry);
        }

        if (guildId) {
          const tenant = getTenantRecordByGuildId(guildId, true);
          if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
        }
        saveAppStateToDisk();

        await respondToDiscordInteraction(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `✅ **${actorTag}**, \`${foundKey.code}\` açarı uğurla aktivləşdirildi! İndi **Get Script** düyməsinə basıb scriptinizi ala bilərsiniz.`,
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

const buildSlashCommandsPayload = (guildId = "") => {
  const scripts = getScriptsForGuild(guildId);
  const scriptChoices = scripts.slice(0, 25).map((s) => ({
    name: sanitizeText(s.name, s.id).slice(0, 100),
    value: s.id
  }));

  const whitelistOptions = [
    {
      name: "user",
      description: "Sunucudan istifadəçi seçin",
      type: 6,
      required: true
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
      description: "İstifadəçini seçilmiş scriptə Whitelist-ə əlavə et",
      type: 1,
      options: whitelistOptions
    },
    {
      name: "unwhitelist",
      description: "İstifadəçini Whitelist-dən çıxar",
      type: 1,
      options: [
        {
          name: "user",
          description: "Çıxarılacaq istifadəçi",
          type: 6,
          required: true
        }
      ]
    },
    {
      name: "resethwid",
      description: "Öz HWID məlumatınızı sıfırlayın",
      type: 1,
      options: []
    }
  ];
};

const syncSlashCommandsWithDiscord = async (guildId = "") => {
  const token = resolveDiscordBotToken();
  if (!token) return;
  if (!BOT_RUNTIME.botUserId) {
    await fetchBotUserIdentity();
  }
  if (!BOT_RUNTIME.botUserId) return;

  const commands = buildSlashCommandsPayload(guildId);
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
          const firstGuildId = sanitizeSnowflakeId(guildsArr[0].id);
          if (!APP_STATE.guildId && firstGuildId) {
            APP_STATE.guildId = firstGuildId;
          }
          for (const g of guildsArr) {
            const gid = sanitizeSnowflakeId(g && g.id);
            if (gid) {
              const tRec = getTenantRecordByGuildId(gid, true);
              const gInfo = await fetchGuildInfoFromDiscord(gid);
              if (tRec && gInfo && gInfo.name) {
                tRec.guildName = gInfo.name;
                if (APP_STATE.guildId === gid) {
                  APP_STATE.guildName = gInfo.name;
                }
              }
            }
          }
          saveAppStateToDisk();
        }

        await syncSlashCommandsWithDiscord(APP_STATE.guildId);
        return;
      }

      if (eventName === "GUILD_CREATE") {
        const gid = sanitizeSnowflakeId(eventData.id);
        if (gid) {
          const gName = sanitizeText(eventData.name, "");
          const tRec = getTenantRecordByGuildId(gid, true);
          if (tRec) {
            if (gName) {
              tRec.guildName = gName;
            }
            if (!tRec.botAddedBy) {
              const adder = await tryResolveBotAdderFromAuditLog(gid);
              if (adder) {
                tRec.botAddedBy = adder;
              } else if (APP_STATE.connectedDiscordUser) {
                tRec.botAddedBy = APP_STATE.connectedDiscordUser;
              }
            }
            if (!APP_STATE.latestJoinedGuildId || APP_STATE.latestJoinedGuildId !== gid) {
              APP_STATE.latestJoinedGuildId = gid;
            }
            if (!APP_STATE.guildId) {
              APP_STATE.guildId = gid;
              if (gName) APP_STATE.guildName = gName;
            }
            syncTenantIntoGlobalIfPrimary(tRec);
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
    scope: "identify"
  });
  if (redirectUri) {
    params.set("redirect_uri", redirectUri);
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
};

const buildDiscordAuthorizeUrl = () => {
  return DISCORD_INVITE_URL;
};

const resolveRequestGuildId = (req, reqUrl, bodyObj = null) => {
  const fromBody = bodyObj && bodyObj.guildId ? sanitizeSnowflakeId(bodyObj.guildId) : "";
  if (fromBody) return fromBody;

  const fromQuery = reqUrl && reqUrl.searchParams
    ? sanitizeSnowflakeId(reqUrl.searchParams.get("guildId") || "")
    : "";
  if (fromQuery) return fromQuery;

  const fromHeader = req && req.headers
    ? sanitizeSnowflakeId(req.headers["x-guild-id"] || "")
    : "";
  if (fromHeader) return fromHeader;

  if (APP_STATE.guildId) {
    return sanitizeSnowflakeId(APP_STATE.guildId);
  }

  if (APP_STATE.latestJoinedGuildId && APP_STATE.tenants && APP_STATE.tenants[APP_STATE.latestJoinedGuildId]) {
    return sanitizeSnowflakeId(APP_STATE.latestJoinedGuildId);
  }

  return "";
};

const buildPublicSnapshotPayload = async (requestedGuildId = "", isAdminView = false, baseUrl = "") => {
  const tokenPresent = Boolean(resolveDiscordBotToken());
  const cleanGuildId = sanitizeSnowflakeId(requestedGuildId || APP_STATE.guildId || "");
  const tenant = cleanGuildId ? getTenantRecordByGuildId(cleanGuildId, true) : null;

  let resolvedGuildName = tenant ? sanitizeText(tenant.guildName, "") : "";
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
      if (tenant) {
        tenant.guildName = info.name;
        syncTenantIntoGlobalIfPrimary(tenant);
        saveAppStateToDisk();
      }
    } else if (!resolvedGuildName && APP_STATE.guildId === cleanGuildId && sanitizeText(APP_STATE.guildName, "")) {
      const gFallback = sanitizeText(APP_STATE.guildName, "");
      if (
        !/^Sunucu\s*\(/i.test(gFallback) &&
        !/^Sunucu\s*#/i.test(gFallback) &&
        !/^Sunucu$/i.test(gFallback) &&
        !/^Discord Sunucusu/i.test(gFallback)
      ) {
        resolvedGuildName = gFallback;
      }
    }
  }

  let botAddedByInfo = tenant && tenant.botAddedBy ? tenant.botAddedBy : null;
  if (cleanGuildId && !botAddedByInfo && tokenPresent) {
    const detectedAdder = await tryResolveBotAdderFromAuditLog(cleanGuildId);
    if (detectedAdder) {
      botAddedByInfo = detectedAdder;
      if (tenant) {
        tenant.botAddedBy = detectedAdder;
        saveAppStateToDisk();
      }
    }
  }

  const connectedUser = APP_STATE.connectedDiscordUser || null;
  if (cleanGuildId && !botAddedByInfo && connectedUser) {
    botAddedByInfo = connectedUser;
    if (tenant) {
      tenant.botAddedBy = connectedUser;
      saveAppStateToDisk();
    }
  }

  const planId = getEffectivePlanForGuild(cleanGuildId);
  const planMeta = getPlanMeta(planId);
  const scriptsList = getScriptsForGuild(cleanGuildId);
  const keysList = getKeysForGuild(cleanGuildId);
  const wlList = getWhitelistForGuild(cleanGuildId);
  const blList = getBlacklistForGuild(cleanGuildId);
  const panelDesign = getPanelDesignForGuild(cleanGuildId);

  const guildList = Object.values(APP_STATE.tenants || {})
    .filter((t) => t && t.guildId)
    .map((t) => {
      const gNameClean = sanitizeText(t.guildName, "");
      return {
        guildId: t.guildId,
        guildName: gNameClean && !/^Sunucu\s*\(/i.test(gNameClean) ? gNameClean : "",
        planId: getEffectivePlanForGuild(t.guildId)
      };
    });

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
      panelChannelId: tenant ? sanitizeSnowflakeId(tenant.panelChannelId) : "",
      botAddedBy: botAddedByInfo
    },
    guilds: guildList,
    discordAccount: {
      connected: Boolean(connectedUser && connectedUser.userId),
      user: connectedUser,
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
      activeApiKeyCode: tenant ? sanitizeText(tenant.activeApiKeyCode, "") : ""
    },
    plansCatalog: Object.values(PLAN_CONFIGS),
    scripts: scriptsList,
    keys: keysList,
    whitelist: wlList,
    blacklist: blList,
    panelDesign,
    isAdminView: Boolean(isAdminView),
    apiKeys: isAdminView ? apiKeysSanitized : [],
    auditLogs: (APP_STATE.auditLogs || []).slice(0, 40)
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
          const arr = clientState.draftDesign.buttons;
          if (i < arr.length - 1) {
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
      clientState.snapshot = snap;
      const bot = snap.bot || {};
      const guild = snap.guild || {};
      const plan = snap.plan || {};

      if (guild.guildId) {
        clientState.deviceGuildId = guild.guildId;
        localStorage.setItem(CLIENT_GUILD_STORAGE_KEY, guild.guildId);
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
          "sadiq202020201212";
        if (document.getElementById("popoverUserName")) {
          document.getElementById("popoverUserName").textContent = displayAcctName;
        }
        if (document.getElementById("popoverUserId")) {
          document.getElementById("popoverUserId").textContent = accInfo.user.username ? "@" + accInfo.user.username : "";
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

      if (!clientState.draftDesign || !Array.isArray(clientState.draftDesign.buttons) || clientState.draftDesign.buttons.length === 0) {
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

    bindDashboardEvents();
    refreshDashboardSnapshot();
  </script>
</body>
</html>`;
};

const createHttpServer = () => {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const baseUrl = getBaseUrlFromRequest(req);
    const reqUrl = new URL(req.url || "/", baseUrl);
    const pathname = reqUrl.pathname;

    try {
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
        const hasSecret = Boolean(sanitizeText(process.env.DISCORD_CLIENT_SECRET || "", ""));
        if (!hasSecret) {
          const fallbackName = "sadiq202020201212";
          APP_STATE.connectedDiscordUser = {
            userId: fallbackName,
            username: fallbackName,
            displayName: fallbackName,
            avatarUrl: "",
            connectedAt: new Date().toISOString()
          };
          saveAppStateToDisk();
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }
        const clientId = sanitizeText(process.env.DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID, "");
        const directOauthUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
          clientId
        )}&response_type=code&scope=identify&redirect_uri=${encodeURIComponent(callbackUrl)}`;
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
          const fallbackName = "sadiq202020201212";
          oauthAccount = {
            userId: fallbackName,
            username: fallbackName,
            displayName: fallbackName,
            avatarUrl: "",
            connectedAt: new Date().toISOString()
          };
        }
        APP_STATE.connectedDiscordUser = oauthAccount;
        const targetGid = sanitizeSnowflakeId(APP_STATE.latestJoinedGuildId || APP_STATE.guildId || "");
        if (targetGid) {
          const tRec = getTenantRecordByGuildId(targetGid, true);
          if (tRec) {
            tRec.botAddedBy = oauthAccount;
            syncTenantIntoGlobalIfPrimary(tRec);
          }
        }
        saveAppStateToDisk();
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }

      if (method === "POST" && pathname === "/api/auth/discord/logout") {
        APP_STATE.connectedDiscordUser = null;
        saveAppStateToDisk();
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/health") {
        sendJsonResponse(res, 200, { ok: true, botConnected: BOT_RUNTIME.connected });
        return;
      }

      if (method === "GET" && pathname === "/api/snapshot") {
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
        const isAdminReq = reqUrl.searchParams.get("admin") === "1";
        const snapshot = await buildPublicSnapshotPayload(targetGuildId, isAdminReq, baseUrl);
        sendJsonResponse(res, 200, snapshot);
        return;
      }

      if (method === "POST" && pathname === "/api/guild/settings") {
        const body = await readJsonBody(req);
        const guildId = sanitizeSnowflakeId(body.guildId || "");
        const panelChannelId = sanitizeSnowflakeId(body.panelChannelId || "");
        let resolvedName = "";
        if (guildId) {
          APP_STATE.guildId = guildId;
          const tenant = getTenantRecordByGuildId(guildId, true);
          if (tenant) {
            if (panelChannelId) tenant.panelChannelId = panelChannelId;
            const info = await fetchGuildInfoFromDiscord(guildId);
            if (info && info.name) {
              resolvedName = info.name;
              tenant.guildName = resolvedName;
              APP_STATE.guildName = resolvedName;
            } else {
              const prevName = sanitizeText(tenant.guildName || APP_STATE.guildName || "", "");
              if (
                prevName &&
                !/^Sunucu\s*#/i.test(prevName) &&
                !/^Sunucu$/i.test(prevName) &&
                !/^Discord Sunucusu/i.test(prevName)
              ) {
                resolvedName = prevName;
                tenant.guildName = resolvedName;
                APP_STATE.guildName = resolvedName;
              } else {
                resolvedName = `Sunucu (${guildId.slice(-4)})`;
                tenant.guildName = resolvedName;
                APP_STATE.guildName = resolvedName;
              }
            }
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        }
        if (panelChannelId) {
          APP_STATE.panelChannelId = panelChannelId;
        }
        saveAppStateToDisk();
        appendAuditLog(
          "GUILD_SETTINGS",
          `Guild=${resolvedName || guildId || "-"} Channel=${panelChannelId || "-"}`,
          guildId
        );
        sendJsonResponse(res, 200, { ok: true, guildId, guildName: resolvedName });
        return;
      }

      if (method === "POST" && pathname === "/api/panel/send") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const channelId = sanitizeSnowflakeId(
          body.channelId ||
            (targetGuildId ? getTenantRecordByGuildId(targetGuildId, true).panelChannelId : "") ||
            APP_STATE.panelChannelId ||
            ""
        );
        const sent = await sendPanelMessageToChannel(channelId, targetGuildId);
        appendAuditLog("SEND_PANEL", `Channel=${channelId}`, targetGuildId);
        sendJsonResponse(res, 200, { ok: true, messageId: sent && sent.id ? sent.id : "" });
        return;
      }

      if (method === "POST" && pathname === "/api/scripts") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const planMeta = getPlanMeta(getEffectivePlanForGuild(targetGuildId));
        const scripts = getScriptsForGuild(targetGuildId);

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
          createdAt: new Date().toISOString()
        };

        scripts.push(newScript);
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.scripts = scripts;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.scripts = scripts;
        }
        saveAppStateToDisk();
        appendAuditLog("CREATE_SCRIPT", name, targetGuildId);
        await syncSlashCommandsWithDiscord(targetGuildId);
        sendJsonResponse(res, 201, { ok: true, script: newScript });
        return;
      }

      if (method === "PUT" && pathname.startsWith("/api/scripts/")) {
        const scriptId = decodeURIComponent(pathname.replace("/api/scripts/", ""));
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const scripts = getScriptsForGuild(targetGuildId);
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

        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.scripts = scripts;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.scripts = scripts;
        }
        saveAppStateToDisk();
        appendAuditLog("UPDATE_SCRIPT", updatedScript.name, targetGuildId);
        await syncSlashCommandsWithDiscord(targetGuildId);
        sendJsonResponse(res, 200, { ok: true, script: updatedScript });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/scripts/")) {
        const scriptId = decodeURIComponent(pathname.replace("/api/scripts/", ""));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
        const nextScripts = getScriptsForGuild(targetGuildId).filter((s) => s.id !== scriptId);
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.scripts = nextScripts;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.scripts = nextScripts;
        }
        saveAppStateToDisk();
        appendAuditLog("DELETE_SCRIPT", scriptId, targetGuildId);
        await syncSlashCommandsWithDiscord(targetGuildId);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/keys") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const keys = getKeysForGuild(targetGuildId);
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
          revoked: false,
          createdAt: new Date().toISOString()
        };

        keys.push(newKey);
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.keys = keys;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.keys = keys;
        }
        saveAppStateToDisk();
        appendAuditLog("CREATE_KEY", code, targetGuildId);
        sendJsonResponse(res, 201, { ok: true, key: newKey });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/keys/")) {
        const keyId = decodeURIComponent(pathname.replace("/api/keys/", ""));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
        const keys = getKeysForGuild(targetGuildId);
        const removedKey = keys.find((k) => k.id === keyId);
        const nextKeys = keys.filter((k) => k.id !== keyId);

        let wl = getWhitelistForGuild(targetGuildId);
        if (removedKey && removedKey.code) {
          wl = wl.filter(
            (w) => String(w.keyCode || "").toUpperCase() !== String(removedKey.code || "").toUpperCase()
          );
        }

        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.keys = nextKeys;
            tenant.whitelist = wl;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.keys = nextKeys;
          APP_STATE.whitelist = wl;
        }
        saveAppStateToDisk();
        appendAuditLog("DELETE_KEY", removedKey ? removedKey.code : keyId, targetGuildId);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/panel-design") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const normalized = normalizePanelDesign(body.panelDesign || body);
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.panelDesign = normalized;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.panelDesign = normalized;
        }
        saveAppStateToDisk();
        appendAuditLog("SAVE_PANEL_DESIGN", normalized.title, targetGuildId);
        sendJsonResponse(res, 200, { ok: true, panelDesign: normalized });
        return;
      }

      if (method === "POST" && pathname === "/api/whitelist") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const discordId = sanitizeSnowflakeId(body.discordId || "");
        if (!discordId) {
          sendJsonResponse(res, 400, { error: "Düzgün Discord ID daxil edin." });
          return;
        }
        const wl = getWhitelistForGuild(targetGuildId);
        const idx = wl.findIndex((w) => String(w.discordId) === discordId);
        const entry = {
          discordId,
          tag: `User_${discordId}`,
          keyCode: idx >= 0 ? wl[idx].keyCode || "MANUAL-WL" : "MANUAL-WL",
          scriptId: sanitizeText(body.scriptId, ""),
          hwid: idx >= 0 ? wl[idx].hwid || "" : "",
          addedAt: new Date().toISOString()
        };
        if (idx >= 0) wl[idx] = entry;
        else wl.push(entry);

        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.whitelist = wl;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.whitelist = wl;
        }
        saveAppStateToDisk();
        appendAuditLog("ADD_WHITELIST", discordId, targetGuildId);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/whitelist/")) {
        const targetUserId = sanitizeSnowflakeId(decodeURIComponent(pathname.replace("/api/whitelist/", "")));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
        const nextWl = getWhitelistForGuild(targetGuildId).filter(
          (w) => String(w.discordId) !== targetUserId
        );
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.whitelist = nextWl;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.whitelist = nextWl;
        }
        saveAppStateToDisk();
        appendAuditLog("REMOVE_WHITELIST", targetUserId, targetGuildId);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/blacklist") {
        const body = await readJsonBody(req);
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
        const discordId = sanitizeSnowflakeId(body.discordId || "");
        if (!discordId) {
          sendJsonResponse(res, 400, { error: "Düzgün Discord ID daxil edin." });
          return;
        }
        const bl = getBlacklistForGuild(targetGuildId);
        if (!bl.some((b) => String(b.discordId) === discordId)) {
          bl.push({ discordId, addedAt: new Date().toISOString() });
        }
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.blacklist = bl;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.blacklist = bl;
        }
        saveAppStateToDisk();
        appendAuditLog("ADD_BLACKLIST", discordId, targetGuildId);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/blacklist/")) {
        const targetUserId = sanitizeSnowflakeId(decodeURIComponent(pathname.replace("/api/blacklist/", "")));
        const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
        const nextBl = getBlacklistForGuild(targetGuildId).filter(
          (b) => String(b.discordId) !== targetUserId
        );
        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.blacklist = nextBl;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        } else {
          APP_STATE.blacklist = nextBl;
        }
        saveAppStateToDisk();
        appendAuditLog("REMOVE_BLACKLIST", targetUserId, targetGuildId);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/admin/api-keys") {
        const body = await readJsonBody(req);
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
        appendAuditLog("CREATE_API_KEY", `${code} (${planId})`);
        sendJsonResponse(res, 201, { ok: true, apiKey: record });
        return;
      }

      if (method === "DELETE" && pathname.startsWith("/api/admin/api-keys/")) {
        const id = decodeURIComponent(pathname.replace("/api/admin/api-keys/", ""));
        APP_STATE.apiKeys = (APP_STATE.apiKeys || []).filter((k) => k.id !== id);
        saveAppStateToDisk();
        appendAuditLog("DELETE_API_KEY", id);
        sendJsonResponse(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/plan/activate-api") {
        const body = await readJsonBody(req);
        const apiKeyCode = sanitizeText(String(body.apiKey || ""), "").toUpperCase();
        const targetGuildId = resolveRequestGuildId(req, reqUrl, body);
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
          : APP_STATE.connectedDiscordUser || null;

        foundApi.usedByUser = actorInfo;
        foundApi.usedByGuildId = targetGuildId || "";
        foundApi.usedAt = new Date().toISOString();

        if (targetGuildId) {
          const tenant = getTenantRecordByGuildId(targetGuildId, true);
          if (tenant) {
            tenant.activePlan = normPlan;
            tenant.activeApiKeyCode = foundApi.code;
            syncTenantIntoGlobalIfPrimary(tenant);
          }
        }

        saveAppStateToDisk();
        appendAuditLog("ACTIVATE_API_PLAN", `${foundApi.code} -> ${normPlan}`, targetGuildId);
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
