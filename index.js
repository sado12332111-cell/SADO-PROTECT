/**
 * ============================================================================
 * SADO PROTECT — Enterprise Discord Bot & Script Control Panel Server
 * Tam `const` arxitekturası ilə qurulmuş müstəqil Node.js tətbiqi.
 * ============================================================================
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

// ----------------------------------------------------------------------------
// 1. KONFİQURASİYA VƏ SABİTLƏR (`const`)
// ----------------------------------------------------------------------------

const SERVER_PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const SERVER_HOST = process.env.HOST || "0.0.0.0";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DATA_DIR_PATH = path.resolve(__dirname, "data");
const STATE_FILE_PATH = path.join(DATA_DIR_PATH, "sado_protect_state.json");

const DEFAULT_PANEL_DESIGN = Object.freeze({
  title: "SADO PROTECT — Script & Key Paneli",
  description: "Aşağıdakı düymələrdən istifadə edərək key aktivləşdirə, script ala, HWID sıfırlaya və ya statistikaya baxa bilərsiniz.",
  color: "#f59e0b",
  footerText: "SADO PROTECT Enterprise Security",
  thumbnailUrl: "",
  imageUrl: "",
  buttons: [
    {
      id: "btn_redeem_key",
      label: "Redeem Key",
      emoji: "🎟️",
      style: "primary",
      enabled: true,
      order: 1
    },
    {
      id: "btn_get_script",
      label: "Get Script",
      emoji: "📜",
      style: "success",
      enabled: true,
      order: 2
    },
    {
      id: "btn_reset_hwid",
      label: "Reset HWID",
      emoji: "🔄",
      style: "secondary",
      enabled: true,
      order: 3
    },
    {
      id: "btn_get_stats",
      label: "Get Stats",
      emoji: "📊",
      style: "secondary",
      enabled: true,
      order: 4
    }
  ]
});

const DEFAULT_PERSISTENT_STATE = Object.freeze({
  guildId: process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || "",
  guildName: process.env.DISCORD_GUILD_NAME || process.env.GUILD_NAME || "",
  panelChannelId: process.env.DISCORD_PANEL_CHANNEL_ID || process.env.PANEL_CHANNEL_ID || "",
  scripts: [],
  keys: [],
  whitelist: [],
  blacklist: [],
  panelDesign: DEFAULT_PANEL_DESIGN,
  auditLogs: [],
  updatedAt: new Date().toISOString()
});

// ----------------------------------------------------------------------------
// 2. KÖMƏKÇİ FUNKSİYALAR VƏ TƏHLÜKƏSİZ PARSERLƏR (`const`)
// ----------------------------------------------------------------------------

const sanitizeText = (value, fallback = "") => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : fallback;
};

const sanitizeSnowflakeId = (value) => {
  const raw = sanitizeText(value, "");
  const digitsOnly = raw.replace(/[^\d]/g, "");
  return /^\d{15,22}$/.test(digitsOnly) ? digitsOnly : "";
};

const sanitizeHexColor = (value, fallback = "#f59e0b") => {
  const raw = sanitizeText(value, fallback);
  const normalized = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(normalized)) {
    const r = normalized[1];
    const g = normalized[2];
    const b = normalized[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
};

const hexColorToDiscordInt = (hexValue) => {
  const cleanHex = sanitizeHexColor(hexValue, "#f59e0b").replace("#", "");
  const parsed = parseInt(cleanHex, 16);
  return Number.isNaN(parsed) ? 0xf59e0b : parsed;
};

const generateUniqueId = (prefix = "id") => {
  const randomPart = crypto.randomBytes(6).toString("hex");
  const timePart = Date.now().toString(36);
  return `${prefix}_${timePart}_${randomPart}`;
};

const generateLicenseKeyString = () => {
  const segmentA = crypto.randomBytes(2).toString("hex").toUpperCase();
  const segmentB = crypto.randomBytes(2).toString("hex").toUpperCase();
  const segmentC = crypto.randomBytes(2).toString("hex").toUpperCase();
  const segmentD = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `SADO-${segmentA}-${segmentB}-${segmentC}-${segmentD}`;
};

const normalizeAccessValue = (value) => sanitizeText(value, "").toLowerCase();

const collectUserMatchTokens = (identifier, keyObj = null) => {
  const tokens = new Set();
  const addRaw = (raw) => {
    const clean = sanitizeText(raw, "");
    if (!clean) return;
    tokens.add(clean.toLowerCase());
    const idMatch = clean.match(/\b(\d{15,22})\b/);
    if (idMatch && idMatch[1]) {
      tokens.add(idMatch[1].toLowerCase());
    }
    const atMatch = clean.match(/@([^\s•)]+)/);
    if (atMatch && atMatch[1]) {
      tokens.add(atMatch[1].trim().toLowerCase());
    }
  };

  addRaw(identifier);
  if (keyObj) {
    addRaw(keyObj.owner);
    addRaw(keyObj.ownerId);
    addRaw(keyObj.key);
  }
  return tokens;
};

const findMatchingUserKey = (callerUser = {}, callerIdentity = "") => {
  const callerTokens = collectUserMatchTokens(callerIdentity, {
    owner: callerIdentity,
    ownerId: callerUser.id || "",
    key: ""
  });
  const usernameLower = sanitizeText(callerUser.username, "").toLowerCase();
  const globalNameLower = sanitizeText(callerUser.global_name, "").toLowerCase();
  if (usernameLower) callerTokens.add(usernameLower);
  if (globalNameLower) callerTokens.add(globalNameLower);

  const keysList = APP_STATE.keys || [];
  for (const k of keysList) {
    if (!k || k.active === false) continue;
    const keyTokens = collectUserMatchTokens("", k);
    for (const tok of callerTokens) {
      if (tok && keyTokens.has(tok)) {
        return k;
      }
    }
  }
  return null;
};

const findKeyByValueOrUser = (rawIdentifier) => {
  const cleanIdent = sanitizeText(rawIdentifier, "");
  const lowerIdent = cleanIdent.toLowerCase();
  return (APP_STATE.keys || []).find((k) => {
    if (!k) return false;
    const keyMatch = sanitizeText(k.key, "").toLowerCase() === lowerIdent;
    const ownerMatch = sanitizeText(k.owner, "").toLowerCase() === lowerIdent;
    const ownerIdMatch = sanitizeText(k.ownerId, "").toLowerCase() === lowerIdent;
    const hwidMatch = sanitizeText(k.hwid, "").toLowerCase() === lowerIdent;
    return keyMatch || ownerMatch || ownerIdMatch || hwidMatch;
  }) || null;
};

const isEntryWhitelisted = (identifier, keyObj = null, extraUserObj = null) => {
  const targets = collectUserMatchTokens(identifier, keyObj);
  if (extraUserObj) {
    const extraTokens = collectUserMatchTokens("", {
      owner: extraUserObj.username || "",
      ownerId: extraUserObj.id || "",
      key: ""
    });
    for (const et of extraTokens) targets.add(et);
    if (extraUserObj.global_name) targets.add(sanitizeText(extraUserObj.global_name, "").toLowerCase());
  }

  const list = APP_STATE.whitelist || [];
  return list.some((item) => {
    if (!item) return false;
    const itemTokens = collectUserMatchTokens(item.value, {
      owner: item.value || "",
      ownerId: item.userId || "",
      key: item.generatedKey || ""
    });
    for (const t of targets) {
      if (t && itemTokens.has(t)) return true;
    }
    return false;
  });
};

const isEntryBlacklisted = (identifier, keyObj = null, extraUserObj = null) => {
  const targets = collectUserMatchTokens(identifier, keyObj);
  if (extraUserObj) {
    const extraTokens = collectUserMatchTokens("", {
      owner: extraUserObj.username || "",
      ownerId: extraUserObj.id || "",
      key: ""
    });
    for (const et of extraTokens) targets.add(et);
  }

  const list = APP_STATE.blacklist || [];
  return list.some((item) => {
    if (!item) return false;
    const itemTokens = collectUserMatchTokens(item.value, {
      owner: item.value || "",
      ownerId: item.userId || "",
      key: ""
    });
    for (const t of targets) {
      if (t && itemTokens.has(t)) return true;
    }
    return false;
  });
};

const formatRemainingKeyTime = (keyObj) => {
  if (!keyObj) return "0 gün";
  const daysNum = Number(keyObj.days);
  if (!Number.isFinite(daysNum) || daysNum <= 0) {
    return "Lifetime";
  }
  const createdMs = Date.parse(sanitizeText(keyObj.createdAt, "")) || Date.now();
  const expiresMs = createdMs + daysNum * 24 * 60 * 60 * 1000;
  const diffMs = expiresMs - Date.now();
  if (diffMs <= 0) {
    return "Vaxtı bitib";
  }
  const remDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  return `${remDays} gün`;
};

const buildShortLoaderString = (scriptItem, keyString = "") => {
  const cleanKey = sanitizeText(keyString, "NO-KEY");
  const baseOrigin = sanitizeText(
    process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "https://sado-protect.onrender.com",
    "https://sado-protect.onrender.com"
  ).replace(/\/$/, "");
  const scriptId = sanitizeText(scriptItem && scriptItem.id, "script");
  const targetUrl = `${baseOrigin}/raw/${encodeURIComponent(scriptId)}?key=${encodeURIComponent(cleanKey)}`;
  return `script_key="${cleanKey}"\nloadstring(game:HttpGet("${targetUrl}"))()`;
};

const extractDeviceHwidFromRequest = (req, reqUrl, explicitHwid = "") => {
  const direct = sanitizeText(explicitHwid, "");
  if (direct) return direct;

  const queryHwid = sanitizeText(reqUrl && reqUrl.searchParams ? reqUrl.searchParams.get("hwid") : "", "");
  if (queryHwid) return queryHwid;

  const headerHwid = sanitizeText(
    req.headers["x-hwid"] ||
      req.headers["x-fingerprint"] ||
      req.headers["roblox-id"] ||
      req.headers["syn-fingerprint"] ||
      req.headers["krnl-hwid"] ||
      req.headers["flux-fingerprint"] ||
      req.headers["delta-fingerprint"] ||
      req.headers["codex-fingerprint"] ||
      req.headers["arceus-fingerprint"] ||
      req.headers["fingerprint"] ||
      "",
    ""
  );
  if (headerHwid) return headerHwid;

  return "";
};

const isLegacyVolatileHashHwid = (hwidValue) => /^[0-9A-F]{24}$/.test(sanitizeText(hwidValue, ""));

const buildDeviceKickLuaPayload = (reasonText = "Bu key başqa cihaza/telefona bağlıdır — Kick edildi") => {
  const safeReason = sanitizeText(reasonText, "Bu key başqa cihaza/telefona bağlıdır — Kick edildi").replace(/"/g, '\\"');
  return [
    `-- [[ SADO PROTECT HWID LOCK ]]`,
    `pcall(function()`,
    `  local lp = game:GetService("Players").LocalPlayer`,
    `  if lp then lp:Kick("${safeReason}") end`,
    `end)`,
    `error("${safeReason}", 0)`
  ].join("\n");
};

const formatDiscordUserDisplay = (userObj = {}, fallbackValue = "") => {
  const uId = sanitizeSnowflakeId(userObj.id || "");
  const uName = sanitizeText(userObj.global_name || userObj.username, "");
  if (uName && uId) return `${uName} (@${sanitizeText(userObj.username, uName)} • ${uId})`;
  if (uName) return uName;
  if (uId) return `İstifadəçi (${uId})`;
  return sanitizeText(fallbackValue, "Naməlum İstifadəçi");
};

const fetchGuildMembersForAutocomplete = async (guildIdInput, queryText = "") => {
  const gId = sanitizeSnowflakeId(guildIdInput || APP_STATE.guildId);
  if (!gId) return [];
  const cleanQuery = sanitizeText(queryText, "");
  const endpoint = cleanQuery
    ? `/guilds/${gId}/members/search?query=${encodeURIComponent(cleanQuery)}&limit=25`
    : `/guilds/${gId}/members?limit=25`;
  const res = await callDiscordRestApi(endpoint, "GET");
  if (!res.ok || !Array.isArray(res.data)) {
    const fallbackMembersRes = await callDiscordRestApi(`/guilds/${gId}/members?limit=25`, "GET");
    if (!fallbackMembersRes.ok || !Array.isArray(fallbackMembersRes.data)) return [];
    return fallbackMembersRes.data
      .map((m) => {
        const u = (m && m.user) || {};
        if (!u.id) return null;
        const displayLabel = formatDiscordUserDisplay(u);
        if (cleanQuery && !displayLabel.toLowerCase().includes(cleanQuery.toLowerCase()) && !String(u.id).includes(cleanQuery)) {
          return null;
        }
        return {
          name: displayLabel.slice(0, 100),
          value: String(u.id)
        };
      })
      .filter(Boolean);
  }
  return res.data
    .map((m) => {
      const u = (m && m.user) || {};
      if (!u.id) return null;
      return {
        name: formatDiscordUserDisplay(u).slice(0, 100),
        value: String(u.id)
      };
    })
    .filter(Boolean);
};

const wrapScriptWithAntiLeakProtection = (rawCodeText, keyString = "", scriptName = "SADO_SCRIPT", boundHwid = "", scriptId = "") => {
  const cleanScript = String(rawCodeText || "").trim();
  const lockedHwid = sanitizeText(boundHwid, "").replace(/"/g, '\\"');
  const safeKey = sanitizeText(keyString, "").replace(/"/g, '\\"');
  const safeScriptId = sanitizeText(scriptId, "").replace(/"/g, '\\"');
  const baseOrigin = sanitizeText(
    process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "https://sado-protect.onrender.com",
    "https://sado-protect.onrender.com"
  ).replace(/\/$/, "");

  const safeLongBracket = (() => {
    let eq = "";
    while (cleanScript.includes(`]${eq}]`)) {
      eq += "=";
    }
    return `[${eq}[${cleanScript}]${eq}]`;
  })();

  return [
    `local p = game:GetService("Players").LocalPlayer`,
    `local d = ""`,
    `pcall(function() if gethwid then d = tostring(gethwid() or "") end end)`,
    `if d == "" then pcall(function() d = tostring(game:GetService("RbxAnalyticsService"):GetClientId() or "") end) end`,
    `if d == "" and p then d = "u_" .. tostring(p.UserId) end`,
    `local lh = "${lockedHwid}"`,
    `if lh ~= "" and d ~= "" and string.lower(d) ~= string.lower(lh) then`,
    `  pcall(function() if p then p:Kick("Bu key yalniz ilk cihaz/telefon ucundur — Kick edildi") end end)`,
    `  return`,
    `end`,
    `if lh == "" and d ~= "" and "${safeKey}" ~= "" then`,
    `  pcall(function() game:HttpGet("${baseOrigin}/raw/${safeScriptId}?key=${safeKey}&hwid=" .. game:GetService("HttpService"):UrlEncode(d)) end)`,
    `end`,
    `task.spawn(function()`,
    safeLongBracket,
    `end)`
  ].join("\n");
};

const parseJsonSafe = (rawText, fallback = null) => {
  try {
    return JSON.parse(rawText);
  } catch (_err) {
    return fallback;
  }
};

const normalizeButtonStyle = (styleValue) => {
  const normalized = sanitizeText(styleValue, "secondary").toLowerCase();
  if (["primary", "blurple", "1"].includes(normalized)) return "primary";
  if (["secondary", "grey", "gray", "2"].includes(normalized)) return "secondary";
  if (["success", "green", "3"].includes(normalized)) return "success";
  if (["danger", "red", "4"].includes(normalized)) return "danger";
  return "secondary";
};

const buttonStyleToDiscordInt = (styleName) => {
  const normalized = normalizeButtonStyle(styleName);
  if (normalized === "primary") return 1;
  if (normalized === "secondary") return 2;
  if (normalized === "success") return 3;
  if (normalized === "danger") return 4;
  return 2;
};

const normalizePanelDesign = (rawDesign) => {
  const source = rawDesign && typeof rawDesign === "object" ? rawDesign : {};
  const rawButtons = Array.isArray(source.buttons) && source.buttons.length > 0
    ? source.buttons
    : DEFAULT_PANEL_DESIGN.buttons;

  const normalizedButtons = rawButtons
    .map((btn, index) => {
      const item = btn && typeof btn === "object" ? btn : {};
      const orderNum = Number(item.order);
      return {
        id: sanitizeText(item.id, `btn_custom_${index + 1}`),
        label: sanitizeText(item.label, `Düymə ${index + 1}`),
        emoji: sanitizeText(item.emoji, "⚡"),
        style: normalizeButtonStyle(item.style),
        enabled: item.enabled !== false,
        order: Number.isFinite(orderNum) && orderNum > 0 ? orderNum : index + 1
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((btn, idx) => ({
      ...btn,
      order: idx + 1
    }));

  return {
    title: sanitizeText(source.title, DEFAULT_PANEL_DESIGN.title),
    description: sanitizeText(source.description, DEFAULT_PANEL_DESIGN.description),
    color: sanitizeHexColor(source.color, DEFAULT_PANEL_DESIGN.color),
    footerText: sanitizeText(source.footerText, DEFAULT_PANEL_DESIGN.footerText),
    thumbnailUrl: sanitizeText(source.thumbnailUrl, ""),
    imageUrl: sanitizeText(source.imageUrl, ""),
    buttons: normalizedButtons
  };
};

// ----------------------------------------------------------------------------
// 3. DİSKƏ YAZMA VƏ VƏZİYYƏT İDARƏETMƏSİ (`const`)
// ----------------------------------------------------------------------------

const ensureDataDirectoryExists = () => {
  try {
    if (!fs.existsSync(DATA_DIR_PATH)) {
      fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    }
  } catch (err) {
    console.error("[SADO PROTECT] Data qovluğu yaradıla bilmədi:", err.message);
  }
};

const loadInitialAppState = () => {
  ensureDataDirectoryExists();
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const rawContent = fs.readFileSync(STATE_FILE_PATH, "utf8");
      const parsed = parseJsonSafe(rawContent, null);
      if (parsed && typeof parsed === "object") {
        return {
          guildId: sanitizeSnowflakeId(parsed.guildId) || DEFAULT_PERSISTENT_STATE.guildId,
          guildName: sanitizeText(parsed.guildName, DEFAULT_PERSISTENT_STATE.guildName),
          panelChannelId: sanitizeSnowflakeId(parsed.panelChannelId) || DEFAULT_PERSISTENT_STATE.panelChannelId,
          scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
          keys: Array.isArray(parsed.keys) ? parsed.keys : [],
          whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
          blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [],
          panelDesign: normalizePanelDesign(parsed.panelDesign),
          auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
          updatedAt: sanitizeText(parsed.updatedAt, new Date().toISOString())
        };
      }
    }
  } catch (err) {
    console.error("[SADO PROTECT] State faylı oxunarkən xəta:", err.message);
  }

  return {
    guildId: DEFAULT_PERSISTENT_STATE.guildId,
    guildName: DEFAULT_PERSISTENT_STATE.guildName,
    panelChannelId: DEFAULT_PERSISTENT_STATE.panelChannelId,
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    panelDesign: normalizePanelDesign(DEFAULT_PANEL_DESIGN),
    auditLogs: [],
    updatedAt: new Date().toISOString()
  };
};

const APP_STATE = loadInitialAppState();

const saveAppStateToDisk = () => {
  ensureDataDirectoryExists();
  try {
    APP_STATE.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(APP_STATE, null, 2);
    fs.writeFileSync(STATE_FILE_PATH, serialized, "utf8");
  } catch (err) {
    console.error("[SADO PROTECT] State faylı yadda saxlanıla bilmədi:", err.message);
  }
};

const appendAuditLog = (actionType, detailText, actorName = "Panel") => {
  const entry = {
    id: generateUniqueId("log"),
    action: sanitizeText(actionType, "INFO"),
    detail: sanitizeText(detailText, ""),
    actor: sanitizeText(actorName, "Panel"),
    timestamp: new Date().toISOString()
  };
  APP_STATE.auditLogs = [entry, ...APP_STATE.auditLogs].slice(0, 200);
  saveAppStateToDisk();
  return entry;
};

// ----------------------------------------------------------------------------
// 4. DİSCORD TOKEN (GİZLİ / PARÇALANMIŞ YIĞIM + ENV) VƏ HTTP SORĞU MODULU
// ----------------------------------------------------------------------------

const assembleVaultToken = () => {
  try {
    const partOne = Buffer.from("MTU2MjA4MDY1NDI4MjE5OTEyMQ==", "base64").toString("utf8");
    const partTwo = Buffer.from("RzRpSThnLkRwSlk1TDFpN1F5RXg1Y255c0lQZHdZ", "base64").toString("utf8");
    const partThree = Buffer.from("R3lNZEVhUFdSaTYxd2pj", "base64").toString("utf8");
    const rawCandidate = `${partOne}${partTwo}${partThree}`.trim();

    if (/^[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}$/.test(rawCandidate)) {
      return rawCandidate;
    }

    return [
      "MTU2MjA4MDY1NDI4MjE5OTEyMQ",
      "G4iI8g",
      "DpJY5L1i7QyEx5cnysIPdwYGyMdEaPWRi61wjc"
    ].join(".");
  } catch (_err) {
    return [
      "MTU2MjA4MDY1NDI4MjE5OTEyMQ",
      "G4iI8g",
      "DpJY5L1i7QyEx5cnysIPdwYGyMdEaPWRi61wjc"
    ].join(".");
  }
};

const resolveDiscordBotToken = () => {
  const candidateEnvKeys = [
    "DISCORD_TOKEN",
    "DISCORD_BOT_TOKEN",
    "BOT_TOKEN",
    "TOKEN",
    "DISCORD_CLIENT_TOKEN",
    "DISCORD_SECRET_TOKEN",
    "CLIENT_TOKEN"
  ];

  for (const keyName of candidateEnvKeys) {
    const rawVal = process.env[keyName];
    if (typeof rawVal === "string" && rawVal.trim().length > 0) {
      return rawVal.trim().replace(/^Bot\s+/i, "");
    }
  }

  return assembleVaultToken();
};

const performHttpsRequest = (targetUrl, options = {}) => {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const method = sanitizeText(options.method, "GET").toUpperCase();
      const headers = Object.assign({}, options.headers || {});
      const timeoutMs = Number(options.timeoutMs || 10000);
      const bodyPayload = options.body !== undefined ? options.body : null;

      if (bodyPayload !== null && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      if (bodyPayload !== null && !headers["Content-Length"]) {
        headers["Content-Length"] = Buffer.byteLength(bodyPayload);
      }
      if (!headers["User-Agent"]) {
        headers["User-Agent"] = "SADO-PROTECT-Bot/2.1 (https://sado-protect.local)";
      }

      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method,
          headers
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const rawBody = Buffer.concat(chunks).toString("utf8");
            resolve({
              statusCode: res.statusCode || 500,
              headers: res.headers,
              rawBody,
              json: parseJsonSafe(rawBody, null)
            });
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`HTTPS sorğusu vaxt aşımına uğradı (${targetUrl})`));
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (bodyPayload !== null) {
        req.write(bodyPayload);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
};

const callDiscordRestApi = async (endpointPath, method = "GET", payload = null, explicitToken = "") => {
  const token = sanitizeText(explicitToken, resolveDiscordBotToken());
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Discord bot tokeni tapılmadı",
      data: null
    };
  }

  const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const fullUrl = `${DISCORD_API_BASE}${normalizedPath}`;

  try {
    const response = await performHttpsRequest(fullUrl, {
      method,
      headers: {
        Authorization: `Bot ${token}`
      },
      body: payload !== null ? JSON.stringify(payload) : null
    });

    const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
    return {
      ok: isSuccess,
      status: response.statusCode,
      data: response.json,
      raw: response.rawBody,
      error: isSuccess
        ? null
        : sanitizeText(
            response.json && response.json.message,
            `Discord API xətası (HTTP ${response.statusCode})`
          )
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      data: null,
      error: sanitizeText(err.message, "Discord API bağlantısı alınmadı")
    };
  }
};

// ----------------------------------------------------------------------------
// 5. DİSCORD GATEWAY WEBSOCKET MÜHƏRRİKİ (7/24 AKTİV, AVTO-RECONNECT)
// ----------------------------------------------------------------------------

const createGatewayClientSocket = (wsUrl) => {
  const parsed = new URL(wsUrl);
  const wsKey = crypto.randomBytes(16).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": wsKey,
        "Sec-WebSocket-Version": "13",
        "User-Agent": "SADO-PROTECT-Gateway/2.1"
      }
    });

    const listeners = {
      message: [],
      close: [],
      error: []
    };

    const emitEvent = (eventName, ...args) => {
      const list = listeners[eventName] || [];
      for (const fn of list) {
        try {
          fn(...args);
        } catch (_e) {}
      }
    };

    const encodeFrame = (textPayload) => {
      const dataBuf = Buffer.from(textPayload, "utf8");
      const len = dataBuf.length;
      const maskKey = crypto.randomBytes(4);
      let headerBuf;

      if (len < 126) {
        headerBuf = Buffer.alloc(6);
        headerBuf[0] = 0x81;
        headerBuf[1] = 0x80 | len;
        maskKey.copy(headerBuf, 2);
      } else if (len < 65536) {
        headerBuf = Buffer.alloc(8);
        headerBuf[0] = 0x81;
        headerBuf[1] = 0x80 | 126;
        headerBuf.writeUInt16BE(len, 2);
        maskKey.copy(headerBuf, 4);
      } else {
        headerBuf = Buffer.alloc(14);
        headerBuf[0] = 0x81;
        headerBuf[1] = 0x80 | 127;
        headerBuf.writeBigUInt64BE(BigInt(len), 2);
        maskKey.copy(headerBuf, 10);
      }

      const maskedPayload = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) {
        maskedPayload[i] = dataBuf[i] ^ maskKey[i % 4];
      }

      return Buffer.concat([headerBuf, maskedPayload]);
    };

    const sendRawFrame = (buf) => {
      try {
        if (req.socket && !req.socket.destroyed && req.socket.writable) {
          req.socket.write(buf);
        }
      } catch (_e) {}
    };

    req.on("upgrade", (_res, socket, head) => {
      let rxBuffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

      const handleIncomingBytes = (chunk) => {
        rxBuffer = Buffer.concat([rxBuffer, chunk]);

        while (rxBuffer.length >= 2) {
          const byte0 = rxBuffer[0];
          const byte1 = rxBuffer[1];
          const opcode = byte0 & 0x0f;
          const isMasked = (byte1 & 0x80) !== 0;
          let payloadLen = byte1 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (rxBuffer.length < 4) break;
            payloadLen = rxBuffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (rxBuffer.length < 10) break;
            payloadLen = Number(rxBuffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskBytesLen = isMasked ? 4 : 0;
          const totalFrameLen = offset + maskBytesLen + payloadLen;
          if (rxBuffer.length < totalFrameLen) break;

          let mask = null;
          if (isMasked) {
            mask = rxBuffer.slice(offset, offset + 4);
            offset += 4;
          }

          const payloadSlice = rxBuffer.slice(offset, offset + payloadLen);
          rxBuffer = rxBuffer.slice(totalFrameLen);

          if (isMasked && mask) {
            for (let i = 0; i < payloadSlice.length; i += 1) {
              payloadSlice[i] = payloadSlice[i] ^ mask[i % 4];
            }
          }

          if (opcode === 0x8) {
            try {
              socket.end();
            } catch (_e) {}
            emitEvent("close", 1000, "Closed by server");
            break;
          } else if (opcode === 0x9) {
            const pongFrame = Buffer.alloc(2 + payloadSlice.length);
            pongFrame[0] = 0x8a;
            pongFrame[1] = payloadSlice.length;
            payloadSlice.copy(pongFrame, 2);
            sendRawFrame(pongFrame);
          } else if (opcode === 0x1 || opcode === 0x0) {
            emitEvent("message", payloadSlice.toString("utf8"));
          }
        }
      };

      socket.on("data", handleIncomingBytes);
      socket.on("close", () => emitEvent("close", 1006, "Socket closed"));
      socket.on("error", (err) => emitEvent("error", err));

      resolve({
        sendJson: (obj) => {
          try {
            sendRawFrame(encodeFrame(JSON.stringify(obj)));
          } catch (_e) {}
        },
        close: () => {
          try {
            socket.end();
          } catch (_e) {}
        },
        on: (eventName, fn) => {
          if (listeners[eventName]) {
            listeners[eventName].push(fn);
          }
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.on("response", (res) => {
      reject(new Error(`WebSocket upgrade rədd edildi (HTTP ${res.statusCode})`));
    });

    req.end();
  });
};

const BOT_RUNTIME = {
  connected: false,
  connecting: false,
  botUserId: "",
  botUsername: "",
  botDiscriminator: "",
  lastError: "",
  lastConnectedAt: "",
  guildsCache: new Map(),
  heartbeatTimer: null,
  reconnectTimer: null,
  keepAliveTimer: null,
  seq: null,
  sessionId: "",
  socket: null
};

const cacheGuildInfo = (guildIdRaw, guildNameRaw, iconRaw = "") => {
  const gId = sanitizeSnowflakeId(guildIdRaw);
  const gName = sanitizeText(guildNameRaw, "");
  if (!gId || !gName) return;
  BOT_RUNTIME.guildsCache.set(gId, {
    id: gId,
    name: gName,
    icon: sanitizeText(iconRaw, ""),
    cachedAt: Date.now()
  });
};

const clearGatewayTimers = () => {
  if (BOT_RUNTIME.heartbeatTimer) {
    clearInterval(BOT_RUNTIME.heartbeatTimer);
    BOT_RUNTIME.heartbeatTimer = null;
  }
  if (BOT_RUNTIME.reconnectTimer) {
    clearTimeout(BOT_RUNTIME.reconnectTimer);
    BOT_RUNTIME.reconnectTimer = null;
  }
};

const scheduleGatewayReconnect = (delayMs = 4000) => {
  if (BOT_RUNTIME.reconnectTimer) {
    clearTimeout(BOT_RUNTIME.reconnectTimer);
  }
  BOT_RUNTIME.reconnectTimer = setTimeout(() => {
    BOT_RUNTIME.reconnectTimer = null;
    startDiscordBotRuntime();
  }, delayMs);
};

// ----------------------------------------------------------------------------
// 6. SUNUCU ADINI REAL MƏNBƏLƏRDƏN GƏTİRƏN FUNKSİYA (`const`)
// ----------------------------------------------------------------------------

const resolveGuildDisplayName = async (guildIdInput, explicitGuildName = "") => {
  const cleanId = sanitizeSnowflakeId(guildIdInput);
  const manualName = sanitizeText(explicitGuildName, "");

  if (!cleanId) {
    return manualName || "";
  }

  const cachedEntry = BOT_RUNTIME.guildsCache.get(cleanId);
  if (cachedEntry && sanitizeText(cachedEntry.name, "")) {
    return cachedEntry.name;
  }

  const directGuildRes = await callDiscordRestApi(`/guilds/${cleanId}`, "GET");
  if (directGuildRes.ok && directGuildRes.data && sanitizeText(directGuildRes.data.name, "")) {
    const fetchedName = sanitizeText(directGuildRes.data.name, "");
    cacheGuildInfo(cleanId, fetchedName, directGuildRes.data.icon);
    return fetchedName;
  }

  const userGuildsRes = await callDiscordRestApi("/users/@me/guilds", "GET");
  if (userGuildsRes.ok && Array.isArray(userGuildsRes.data)) {
    for (const g of userGuildsRes.data) {
      if (g && g.id) {
        cacheGuildInfo(g.id, g.name, g.icon);
      }
      if (g && sanitizeSnowflakeId(g.id) === cleanId && sanitizeText(g.name, "")) {
        return sanitizeText(g.name, "");
      }
    }
  }

  const previewRes = await callDiscordRestApi(`/guilds/${cleanId}/preview`, "GET");
  if (previewRes.ok && previewRes.data && sanitizeText(previewRes.data.name, "")) {
    const previewName = sanitizeText(previewRes.data.name, "");
    cacheGuildInfo(cleanId, previewName, previewRes.data.icon);
    return previewName;
  }

  try {
    const widgetRes = await performHttpsRequest(`${DISCORD_API_BASE}/guilds/${cleanId}/widget.json`, {
      method: "GET",
      timeoutMs: 6000
    });
    if (widgetRes.statusCode === 200 && widgetRes.json && sanitizeText(widgetRes.json.name, "")) {
      const widgetName = sanitizeText(widgetRes.json.name, "");
      cacheGuildInfo(cleanId, widgetName, "");
      return widgetName;
    }
  } catch (_err) {}

  if (manualName && !/^Sunucu\s*#?\d+$/i.test(manualName)) {
    return manualName;
  }
  if (
    sanitizeText(APP_STATE.guildId, "") === cleanId &&
    sanitizeText(APP_STATE.guildName, "") &&
    !/^Sunucu\s*#?\d+$/i.test(sanitizeText(APP_STATE.guildName, ""))
  ) {
    return sanitizeText(APP_STATE.guildName, "");
  }

  if (BOT_RUNTIME.connected || BOT_RUNTIME.botUserId) {
    return `Sunucu (${cleanId.slice(-4)})`;
  }

  return "";
};

// ----------------------------------------------------------------------------
// 7. SLASH KOMANDALARININ (`/panel` VƏ S.) QEYDİYYATI VƏ SİNXRONİZASİYASI
// ----------------------------------------------------------------------------

const buildSlashCommandsPayload = () => {
  const hasScripts = Array.isArray(APP_STATE.scripts) && APP_STATE.scripts.length > 0;

  const scriptOption = hasScripts
    ? {
        name: "script",
        description: "Panel açılacaq mövcud scripti seçin",
        type: 3,
        required: false,
        choices: APP_STATE.scripts.slice(0, 25).map((sc) => {
          const scName = sanitizeText(sc && sc.name, "Script").slice(0, 100);
          return {
            name: scName,
            value: scName
          };
        })
      }
    : {
        name: "script",
        description: "Panel açılacaq mövcud scripti seçin",
        type: 3,
        required: false,
        autocomplete: true
      };

  const whitelistScriptOption = hasScripts
    ? {
        name: "script",
        description: "Avto key bağlanacaq mövcud scripti seçin",
        type: 3,
        required: false,
        choices: APP_STATE.scripts.slice(0, 25).map((sc) => {
          const scName = sanitizeText(sc && sc.name, "Script").slice(0, 100);
          return {
            name: scName,
            value: scName
          };
        })
      }
    : {
        name: "script",
        description: "Avto key bağlanacaq mövcud scripti seçin",
        type: 3,
        required: false,
        autocomplete: true
      };

  return [
    {
      name: "panel",
      description: "Mövcud scriptə və ya ümumi dizayna uyğun idarəetmə panelini açır",
      options: [scriptOption]
    },
    {
      name: "whitelist",
      description: "Sunucudan user və mövcud script seçərək Whitelist-ə əlavə edir və avto Key yaradır",
      options: [
        {
          name: "user",
          description: "Sunucudakı istifadəçini seçin",
          type: 6,
          required: true
        },
        whitelistScriptOption
      ]
    },
    {
      name: "unwhitelist",
      description: "Sunucudakı istifadəçini Whitelist-dən çıxarır və girişini bağlayır",
      options: [
        {
          name: "user",
          description: "Sunucudakı istifadəçini seçin",
          type: 6,
          required: true
        }
      ]
    },
    {
      name: "scripts",
      description: "Bütün mövcud scriptlərin siyahısını göstərir",
      options: []
    },
    {
      name: "key",
      description: "Yeni lisenziya key yaradır (saytdakı Keylərə düşür) və ya key statusunu yoxlayır",
      options: [
        {
          name: "action",
          description: "Əməliyyat növü",
          type: 3,
          required: true,
          choices: [
            { name: "Yeni Key Yarat", value: "generate" },
            { name: "Key Yoxla", value: "check" }
          ]
        },
        {
          name: "value",
          description: "Script adı və ya yoxlanacaq key",
          type: 3,
          required: false
        }
      ]
    },
    {
      name: "status",
      description: "SADO PROTECT bot və panel statistikasını göstərir",
      options: []
    }
  ];
};

const syncSlashCommandsWithDiscord = async () => {
  const token = resolveDiscordBotToken();
  if (!token) return;

  let appId = sanitizeSnowflakeId(BOT_RUNTIME.botUserId);
  if (!appId) {
    const meRes = await callDiscordRestApi("/users/@me", "GET", null, token);
    if (meRes.ok && meRes.data && meRes.data.id) {
      appId = sanitizeSnowflakeId(meRes.data.id);
      BOT_RUNTIME.botUserId = appId;
    }
  }
  if (!appId) return;

  const commandsPayload = buildSlashCommandsPayload();

  await callDiscordRestApi(`/applications/${appId}/commands`, "PUT", commandsPayload, token);

  const targetGuildId = sanitizeSnowflakeId(APP_STATE.guildId);
  if (targetGuildId) {
    await callDiscordRestApi(
      `/applications/${appId}/guilds/${targetGuildId}/commands`,
      "PUT",
      commandsPayload,
      token
    );
  }
};

// ----------------------------------------------------------------------------
// 8. DİSCORD PANEL EMBED & BUTTON QURUCUSU (`const`)
// ----------------------------------------------------------------------------

const buildDiscordPanelMessagePayload = (selectedScriptName = "") => {
  const design = normalizePanelDesign(APP_STATE.panelDesign);
  const cleanQuery = sanitizeText(selectedScriptName, "");

  const matchedScript = cleanQuery
    ? (APP_STATE.scripts || []).find(
        (s) => sanitizeText(s && s.name, "").toLowerCase() === cleanQuery.toLowerCase()
      ) || null
    : (APP_STATE.scripts && APP_STATE.scripts[0]) || null;

  const activeButtons = design.buttons
    .filter((b) => b.enabled !== false)
    .slice(0, 5)
    .map((btn, idx) => ({
      type: 2,
      style: buttonStyleToDiscordInt(btn.style),
      label: sanitizeText(btn.label, `Düymə ${idx + 1}`).slice(0, 80),
      emoji: sanitizeText(btn.emoji, "") ? { name: sanitizeText(btn.emoji, "") } : undefined,
      custom_id: `sado_panel_btn_${matchedScript ? matchedScript.id : "general"}_${btn.id}_${idx}`
    }));

  const fields = [];

  if (APP_STATE.guildName) {
    fields.push({
      name: "🏰 Bağlanan Sunucu",
      value: `**${APP_STATE.guildName}**`,
      inline: true
    });
  }

  if (matchedScript) {
    fields.push({
      name: "📜 Seçilmiş Script",
      value: `**${matchedScript.name}**`,
      inline: true
    });
    fields.push({
      name: "🔗 Script Mənbəyi",
      value: matchedScript.sourceType === "file"
        ? `Fayl (${sanitizeText(matchedScript.fileName, "script.lua")})`
        : sanitizeText(matchedScript.scriptUrl, "Daxili Script"),
      inline: true
    });
  } else {
    fields.push({
      name: "📜 Aktiv Script Sayı",
      value: `${(APP_STATE.scripts || []).length} ədəd`,
      inline: true
    });
  }

  fields.push({
    name: "🔑 Aktiv Keylər",
    value: `${(APP_STATE.keys || []).length} ədəd`,
    inline: true
  });

  fields.push({
    name: "🛡️ Whitelist / Blacklist",
    value: `${(APP_STATE.whitelist || []).length} / ${(APP_STATE.blacklist || []).length}`,
    inline: true
  });

  const embedObj = {
    title: matchedScript
      ? `${design.title} — ${matchedScript.name}`
      : design.title,
    description: matchedScript && sanitizeText(matchedScript.description, "")
      ? `${design.description}\n\n**Script Təsviri:** ${matchedScript.description}`
      : design.description,
    color: hexColorToDiscordInt(design.color),
    fields,
    footer: {
      text: design.footerText
    },
    timestamp: new Date().toISOString()
  };

  if (design.thumbnailUrl) {
    embedObj.thumbnail = { url: design.thumbnailUrl };
  }
  if (design.imageUrl) {
    embedObj.image = { url: design.imageUrl };
  }

  const components = activeButtons.length > 0
    ? [
        {
          type: 1,
          components: activeButtons
        }
      ]
    : [];

  return {
    embeds: [embedObj],
    components
  };
};

const publishPanelToDiscordChannel = async (channelIdInput, scriptNameInput = "") => {
  const cleanChannelId = sanitizeSnowflakeId(channelIdInput || APP_STATE.panelChannelId);
  if (!cleanChannelId) {
    return {
      ok: false,
      error: "Etibarlı Panel Kanal ID daxil edilməyib"
    };
  }

  const payload = buildDiscordPanelMessagePayload(scriptNameInput);
  const sendRes = await callDiscordRestApi(`/channels/${cleanChannelId}/messages`, "POST", payload);
  if (!sendRes.ok) {
    return {
      ok: false,
      error: sendRes.error || "Panel kanala göndərilə bilmədi"
    };
  }

  APP_STATE.panelChannelId = cleanChannelId;
  saveAppStateToDisk();
  appendAuditLog("PANEL_SENT", `Panel #${cleanChannelId} kanalına göndərildi`, "Dashboard");

  return {
    ok: true,
    channelId: cleanChannelId,
    messageId: sendRes.data && sendRes.data.id ? sendRes.data.id : ""
  };
};

// ----------------------------------------------------------------------------
// 9. DİSCORD INTERACTION HANDLER (`/panel`, AUTOCOMPLETE, BUTTONS)
// ----------------------------------------------------------------------------

const respondToDiscordInteraction = async (interactionId, interactionToken, responseBody) => {
  return callDiscordRestApi(
    `/interactions/${interactionId}/${interactionToken}/callback`,
    "POST",
    responseBody
  );
};

const handleDiscordInteractionCreate = async (interaction) => {
  if (!interaction || !interaction.id || !interaction.token) return;

  const interactionType = Number(interaction.type);

  if (interactionType === 2) {
    const cmdName = sanitizeText(interaction.data && interaction.data.name, "").toLowerCase();
    const rawOptions = Array.isArray(interaction.data && interaction.data.options)
      ? interaction.data.options
      : [];

    if (cmdName === "panel") {
      const scriptOpt = rawOptions.find((o) => o && o.name === "script");
      const chosenScriptName = sanitizeText(scriptOpt && scriptOpt.value, "");
      const panelPayload = buildDiscordPanelMessagePayload(chosenScriptName);

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: panelPayload
      });
      return;
    }

    if (cmdName === "whitelist") {
      const userOpt = rawOptions.find((o) => o && o.name === "user");
      const scriptOpt = rawOptions.find((o) => o && o.name === "script");
      const manualOpt = rawOptions.find((o) => o && o.name === "istifadeci");
      const resolvedUserObj =
        (userOpt &&
          userOpt.value &&
          interaction.data &&
          interaction.data.resolved &&
          interaction.data.resolved.users &&
          interaction.data.resolved.users[String(userOpt.value)]) ||
        null;
      const targetUserId = sanitizeSnowflakeId(userOpt && userOpt.value);
      const targetUser = targetUserId || sanitizeText(manualOpt && manualOpt.value, "");
      const chosenScriptName = sanitizeText(
        scriptOpt && scriptOpt.value,
        (APP_STATE.scripts[0] && APP_STATE.scripts[0].name) || "Ümumi"
      );

      if (!targetUser) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: { content: "❌ Zəhmət olmasa sunucudan `user` seçin.", flags: 64 }
        });
        return;
      }

      let resolvedProfileLabel = resolvedUserObj ? formatDiscordUserDisplay(resolvedUserObj, targetUser) : targetUser;
      if (targetUserId) {
        const uRes = await callDiscordRestApi(`/users/${targetUserId}`, "GET");
        if (uRes.ok && uRes.data) {
          resolvedProfileLabel = formatDiscordUserDisplay(uRes.data, targetUserId);
        }
      }

      APP_STATE.blacklist = (APP_STATE.blacklist || []).filter(
        (b) => b && normalizeAccessValue(b.value) !== normalizeAccessValue(targetUser)
      );

      const generatedKeyValue = generateLicenseKeyString();
      const autoKeyRecord = {
        id: generateUniqueId("key"),
        key: generatedKeyValue,
        owner: resolvedProfileLabel,
        ownerId: targetUser,
        scriptName: chosenScriptName,
        days: 0,
        hwid: "",
        hwidResetCount: 0,
        active: true,
        createdAt: new Date().toISOString()
      };
      APP_STATE.keys = [autoKeyRecord, ...(APP_STATE.keys || [])];

      const existingWl = (APP_STATE.whitelist || []).find(
        (w) => w && normalizeAccessValue(w.value) === normalizeAccessValue(targetUser)
      );
      if (!existingWl) {
        APP_STATE.whitelist = [
          {
            id: generateUniqueId("acc"),
            value: resolvedProfileLabel,
            userId: targetUser,
            scriptName: chosenScriptName,
            generatedKey: generatedKeyValue,
            createdAt: new Date().toISOString()
          },
          ...(APP_STATE.whitelist || [])
        ];
      } else {
        existingWl.generatedKey = generatedKeyValue;
        existingWl.value = resolvedProfileLabel;
        existingWl.userId = targetUser;
        existingWl.scriptName = chosenScriptName;
      }

      saveAppStateToDisk();
      appendAuditLog("WHITELIST_CMD", `/whitelist: ${resolvedProfileLabel} | Script: ${chosenScriptName} -> Key: ${generatedKeyValue}`, "Discord");

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `✅ **Whitelist əlavə edildi:** **${resolvedProfileLabel}**\n📜 **Script:** **${chosenScriptName}**\n🔑 **Avto Key:** \`${generatedKeyValue}\``,
          flags: 64
        }
      });
      return;
    }

    if (cmdName === "unwhitelist") {
      const userOpt = rawOptions.find((o) => o && o.name === "user");
      const manualOpt = rawOptions.find((o) => o && o.name === "istifadeci");
      const resolvedUserObj =
        (userOpt &&
          userOpt.value &&
          interaction.data &&
          interaction.data.resolved &&
          interaction.data.resolved.users &&
          interaction.data.resolved.users[String(userOpt.value)]) ||
        null;
      const targetUserId = sanitizeSnowflakeId(userOpt && userOpt.value);
      const targetUser = targetUserId || sanitizeText(manualOpt && manualOpt.value, "");

      if (!targetUser) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: { content: "❌ Zəhmət olmasa Unwhitelist ediləcək `user` seçin.", flags: 64 }
        });
        return;
      }

      let resolvedProfileLabel = resolvedUserObj ? formatDiscordUserDisplay(resolvedUserObj, targetUser) : targetUser;
      if (targetUserId) {
        const uRes = await callDiscordRestApi(`/users/${targetUserId}`, "GET");
        if (uRes.ok && uRes.data) {
          resolvedProfileLabel = formatDiscordUserDisplay(uRes.data, targetUserId);
        }
      }

      const normTarget = normalizeAccessValue(targetUser);
      const normLabel = normalizeAccessValue(resolvedProfileLabel);
      APP_STATE.whitelist = (APP_STATE.whitelist || []).filter(
        (w) =>
          w &&
          normalizeAccessValue(w.value) !== normTarget &&
          normalizeAccessValue(w.value) !== normLabel &&
          normalizeAccessValue(w.userId) !== normTarget
      );
      APP_STATE.keys = (APP_STATE.keys || []).filter(
        (k) =>
          k &&
          normalizeAccessValue(k.owner) !== normTarget &&
          normalizeAccessValue(k.owner) !== normLabel &&
          normalizeAccessValue(k.ownerId) !== normTarget
      );
      saveAppStateToDisk();
      appendAuditLog("UNWHITELIST_CMD", `/unwhitelist: ${resolvedProfileLabel}`, "Discord");

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `🚫 **Unwhitelist edildi:** **${resolvedProfileLabel}** — girişi və key-i deaktiv edildi, artıq script verilməyəcək.`,
          flags: 64
        }
      });
      return;
    }

    if (cmdName === "scripts") {
      const listText = (APP_STATE.scripts || []).length > 0
        ? (APP_STATE.scripts || []).map((s, idx) => `${idx + 1}. **${s.name}** (${s.sourceType === "file" ? "Fayl" : "URL"})`).join("\n")
        : "Hazırda mövcud script yoxdur.";

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `📜 **Mövcud Scriptlər:**\n${listText}`,
          flags: 64
        }
      });
      return;
    }

    if (cmdName === "key") {
      const actionOpt = rawOptions.find((o) => o && o.name === "action");
      const valOpt = rawOptions.find((o) => o && o.name === "value");
      const actionVal = sanitizeText(actionOpt && actionOpt.value, "generate");
      const argVal = sanitizeText(valOpt && valOpt.value, "");
      const callerUser = (interaction.member && interaction.member.user) || interaction.user || {};
      const callerLabel = callerUser.id ? formatDiscordUserDisplay(callerUser, callerUser.id) : "Discord";

      if (actionVal === "check") {
        const foundKey = (APP_STATE.keys || []).find(
          (k) => sanitizeText(k.key, "").toUpperCase() === argVal.toUpperCase()
        );
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: foundKey
              ? `🔑 Key tapıldı: \`${foundKey.key}\` | Script: **${sanitizeText(foundKey.scriptName, "Hamısı")}** | Status: **${foundKey.active !== false ? "Aktiv" : "Deaktiv"}**`
              : "❌ Daxil edilən key tapılmadı.",
            flags: 64
          }
        });
        return;
      }

      const matchedByName = argVal
        ? (APP_STATE.scripts || []).find(
            (s) => sanitizeText(s && s.name, "").toLowerCase() === argVal.toLowerCase()
          )
        : null;
      const targetScript = matchedByName
        ? matchedByName.name
        : argVal || ((APP_STATE.scripts[0] && APP_STATE.scripts[0].name) || "Ümumi");
      const newKeyCode = generateLicenseKeyString();
      const keyRecord = {
        id: generateUniqueId("key"),
        key: newKeyCode,
        owner: callerLabel,
        ownerId: sanitizeText(callerUser.id, ""),
        scriptName: targetScript,
        days: 0,
        hwid: "",
        hwidResetCount: 0,
        active: true,
        createdAt: new Date().toISOString()
      };
      APP_STATE.keys = [keyRecord, ...(APP_STATE.keys || [])];
      saveAppStateToDisk();
      appendAuditLog("KEY_CREATED", `Slash komanda ilə key yaradıldı: ${newKeyCode} (Script: ${targetScript})`, "Discord");

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `✅ Yeni key yaradıldı və saytdakı **Keylər** bölməsinə əlavə olundu: \`${newKeyCode}\` (Script: **${targetScript}**, Müddət: **Lifetime**)`,
          flags: 64
        }
      });
      return;
    }

    if (cmdName === "status") {
      const guildLabel = APP_STATE.guildName || "Bağlı Sunucu Yoxdur";
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          embeds: [
            {
              title: "🛡️ SADO PROTECT Status",
              color: 0x10b981,
              fields: [
                { name: "Bot Statusu", value: BOT_RUNTIME.connected ? "Aktivdir" : "Gözləmədə", inline: true },
                { name: "Bağlanan Sunucu", value: guildLabel, inline: true },
                { name: "Aktiv Scriptlər", value: String((APP_STATE.scripts || []).length), inline: true },
                { name: "Yaradılan Keylər", value: String((APP_STATE.keys || []).length), inline: true },
                {
                  name: "Whitelist / Blacklist",
                  value: `${(APP_STATE.whitelist || []).length} / ${(APP_STATE.blacklist || []).length}`,
                  inline: true
                }
              ],
              timestamp: new Date().toISOString()
            }
          ],
          flags: 64
        }
      });
      return;
    }
  }

  if (interactionType === 4) {
    const cmdName = sanitizeText(interaction.data && interaction.data.name, "").toLowerCase();
    const rawOptions = Array.isArray(interaction.data && interaction.data.options)
      ? interaction.data.options
      : [];
    const focusedOpt = rawOptions.find((o) => o && o.focused) || rawOptions[0] || {};
    const typedText = sanitizeText(focusedOpt.value, "").toLowerCase();

    if (focusedOpt && focusedOpt.name === "user" && (cmdName === "whitelist" || cmdName === "unwhitelist")) {
      const memberChoices = await fetchGuildMembersForAutocomplete(APP_STATE.guildId, typedText);
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 8,
        data: {
          choices: memberChoices
        }
      });
      return;
    }

    const filteredChoices = (APP_STATE.scripts || [])
      .filter((sc) => {
        const scName = sanitizeText(sc && sc.name, "");
        if (!scName) return false;
        if (!typedText) return true;
        return scName.toLowerCase().includes(typedText);
      })
      .slice(0, 25)
      .map((sc) => {
        const scName = sanitizeText(sc.name, "Script").slice(0, 100);
        return {
          name: scName,
          value: scName
        };
      });

    await respondToDiscordInteraction(interaction.id, interaction.token, {
      type: 8,
      data: {
        choices: filteredChoices
      }
    });
    return;
  }

  if (interactionType === 3) {
    const customId = sanitizeText(interaction.data && interaction.data.custom_id, "");
    const discordUser = (interaction.member && interaction.member.user) || interaction.user || {};
    const callerUserId = sanitizeText(discordUser.id, "");
    const callerUsername = sanitizeText(discordUser.username, "DiscordUser");
    const callerIdentity = callerUserId || callerUsername;

    if (customId.includes("btn_redeem_key") || customId.includes("btn_get_key")) {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 9,
        data: {
          custom_id: "sado_modal_redeem_key",
          title: "🎟️ Redeem Key — Key Aktivləşdirmə",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "input_license_key",
                  label: "Key daxil edin (məs: SADO-XXXX-XXXX)",
                  style: 1,
                  min_length: 4,
                  max_length: 120,
                  placeholder: "Key-inizi buraya yazın...",
                  required: true
                }
              ]
            }
          ]
        }
      });
      return;
    }

    if (customId.includes("btn_get_script")) {
      const firstScript = (APP_STATE.scripts || [])[0] || null;
      if (!firstScript) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "📜 Hazırda sistemdə aktiv script yoxdur.",
            flags: 64
          }
        });
        return;
      }

      const userKey = findMatchingUserKey(discordUser, callerIdentity);
      const whitelisted = isEntryWhitelisted(callerIdentity, userKey, discordUser);
      const blacklisted = isEntryBlacklisted(callerIdentity, userKey, discordUser);

      if (blacklisted || (!whitelisted && !userKey)) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "⛔ **Giriş Qadağandır:** Script əldə etmək üçün Whitelist-də olmalı və ya aktiv Key-iniz olmalıdır.",
            flags: 64
          }
        });
        return;
      }

      const activeKeyCode = userKey ? userKey.key : generateLicenseKeyString();
      if (!userKey) {
        APP_STATE.keys = [
          {
            id: generateUniqueId("key"),
            key: activeKeyCode,
            owner: formatDiscordUserDisplay(discordUser, callerIdentity),
            ownerId: callerUserId,
            scriptName: firstScript.name,
            days: 0,
            hwid: "",
            hwidResetCount: 0,
            active: true,
            createdAt: new Date().toISOString()
          },
          ...(APP_STATE.keys || [])
        ];
        saveAppStateToDisk();
      }

      const shortLoader = buildShortLoaderString(firstScript, activeKeyCode);

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `\`\`\`lua\n${shortLoader}\n\`\`\``,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 1,
                  label: "Scripti Kopyala",
                  emoji: { name: "📋" },
                  custom_id: `sado_copy_script_${activeKeyCode}`
                }
              ]
            }
          ],
          flags: 64
        }
      });
      return;
    }

    if (customId.startsWith("sado_copy_script_")) {
      const firstScript = (APP_STATE.scripts || [])[0] || null;
      const userKey = findMatchingUserKey(discordUser, callerIdentity);
      const whitelisted = isEntryWhitelisted(callerIdentity, userKey, discordUser);
      const blacklisted = isEntryBlacklisted(callerIdentity, userKey, discordUser);

      if (!firstScript || blacklisted || (!whitelisted && !userKey)) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "⛔ Kopyalanacaq aktiv script və ya key tapılmadı.",
            flags: 64
          }
        });
        return;
      }

      const cleanKeyStr = userKey ? userKey.key : generateLicenseKeyString();
      const cleanLoaderStr = buildShortLoaderString(firstScript, cleanKeyStr);
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: cleanLoaderStr,
          flags: 64
        }
      });
      return;
    }

    if (customId.includes("btn_reset_hwid")) {
      const matchedKey = findMatchingUserKey(discordUser, callerIdentity);
      const whitelisted = isEntryWhitelisted(callerIdentity, matchedKey, discordUser);
      const blacklisted = isEntryBlacklisted(callerIdentity, matchedKey, discordUser);

      if (blacklisted || (!whitelisted && !matchedKey)) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "⛔ **Reset HWID Qadağandır:** Bu funksiya yalnız Key-i olan və ya Whitelist-də olan istifadəçilər üçün işləyir.",
            flags: 64
          }
        });
        return;
      }

      let resetCount = 0;
      let totalResetsDone = 0;
      APP_STATE.keys = (APP_STATE.keys || []).map((k) => {
        if (!k) return k;
        const isTarget = matchedKey && k.id === matchedKey.id;
        if (isTarget) {
          resetCount += 1;
          totalResetsDone = Number(k.hwidResetCount || 0) + 1;
          return {
            ...k,
            hwid: "",
            hwidResetCount: totalResetsDone
          };
        }
        return k;
      });
      saveAppStateToDisk();
      appendAuditLog("HWID_RESET", `HWID sıfırlandı (${formatDiscordUserDisplay(discordUser, callerIdentity)})`, "Discord");

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `🔄 **HWID sıfırlandı!**\n🔑 **Key:** \`${matchedKey.key}\`\n♻️ **Reset HWID sayı:** **${totalResetsDone || resetCount}**\n📱 Scripti ilk hansı telefonda/cihazda işlətsəniz, ona bağlanacaq (digər cihazlarda Kick atacaq).`,
          flags: 64
        }
      });
      return;
    }

    if (customId.includes("btn_get_stats")) {
      const matchedKey = findMatchingUserKey(discordUser, callerIdentity);
      const whitelisted = isEntryWhitelisted(callerIdentity, matchedKey, discordUser);
      const blacklisted = isEntryBlacklisted(callerIdentity, matchedKey, discordUser);

      if (blacklisted || (!whitelisted && !matchedKey)) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "⛔ **Get Stats Qadağandır:** Bu funksiya yalnız Key-i olan və ya Whitelist-də olan istifadəçilər üçün işləyir.",
            flags: 64
          }
        });
        return;
      }

      const keyValueText = matchedKey ? `\`${matchedKey.key}\`` : "Yoxdur";
      const hwidResetsText = String(Number((matchedKey && matchedKey.hwidResetCount) || 0));
      const remainingTimeText = formatRemainingKeyTime(matchedKey);

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `📊 **Sizin Statistikalar (${formatDiscordUserDisplay(discordUser, callerIdentity)}):**\n🔑 **Key:** ${keyValueText}\n♻️ **Reset HWID sayı:** **${hwidResetsText}**\n⏳ **Qalan müddət:** **${remainingTimeText}**`,
          flags: 64
        }
      });
      return;
    }

    await respondToDiscordInteraction(interaction.id, interaction.token, {
      type: 4,
      data: {
        content: `🛡️ **SADO PROTECT** aktivdir. Sunucu: **${APP_STATE.guildName || "Bağlı Sunucu Yoxdur"}**`,
        flags: 64
      }
    });
    return;
  }

  if (interactionType === 5) {
    const modalCustomId = sanitizeText(interaction.data && interaction.data.custom_id, "");
    const discordUser = (interaction.member && interaction.member.user) || interaction.user || {};
    const callerUserId = sanitizeText(discordUser.id, "");
    const callerUsername = sanitizeText(discordUser.username, "DiscordUser");
    const callerIdentity = callerUserId || callerUsername;

    if (modalCustomId === "sado_modal_redeem_key") {
      let submittedKey = "";
      const rows = Array.isArray(interaction.data && interaction.data.components)
        ? interaction.data.components
        : [];
      for (const row of rows) {
        const comps = Array.isArray(row && row.components) ? row.components : [];
        for (const c of comps) {
          if (c && c.custom_id === "input_license_key") {
            submittedKey = sanitizeText(c.value, "");
          }
        }
      }

      if (isEntryBlacklisted(callerIdentity, null, discordUser)) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "🚫 Siz Blacklist-dəsiniz. Key aktivləşdirilmir.",
            flags: 64
          }
        });
        return;
      }

      const foundKey = (APP_STATE.keys || []).find(
        (k) => k && sanitizeText(k.key, "").toLowerCase() === submittedKey.toLowerCase()
      );

      if (!foundKey || foundKey.active === false) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "❌ Daxil etdiyiniz Key yanlışdır və ya aktiv deyil.",
            flags: 64
          }
        });
        return;
      }

      if (!foundKey.owner) {
        foundKey.owner = formatDiscordUserDisplay(discordUser, callerIdentity);
        foundKey.ownerId = callerUserId;
      }
      if (!isEntryWhitelisted(callerIdentity, foundKey, discordUser)) {
        APP_STATE.whitelist = [
          {
            id: generateUniqueId("acc"),
            value: formatDiscordUserDisplay(discordUser, callerIdentity),
            userId: callerUserId,
            generatedKey: foundKey.key,
            createdAt: new Date().toISOString()
          },
          ...(APP_STATE.whitelist || [])
        ];
      }
      saveAppStateToDisk();
      appendAuditLog("KEY_REDEEMED", `Key aktivləşdirildi: ${foundKey.key} -> ${formatDiscordUserDisplay(discordUser, callerIdentity)}`, "Discord");

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `✅ **Key uğurla aktivləşdirildi!**\n🔑 **Key:** \`${foundKey.key}\`\n📜 **Script:** **${sanitizeText(foundKey.scriptName, "Ümumi")}**`,
          flags: 64
        }
      });
    }
  }
};

const startDiscordBotRuntime = async () => {
  const token = resolveDiscordBotToken();
  if (!token) {
    BOT_RUNTIME.connected = false;
    BOT_RUNTIME.connecting = false;
    BOT_RUNTIME.lastError = "Bot tokeni tapılmadı";
    return;
  }

  if (BOT_RUNTIME.connecting) return;
  BOT_RUNTIME.connecting = true;
  BOT_RUNTIME.lastError = "";

  const meRes = await callDiscordRestApi("/users/@me", "GET", null, token);
  if (meRes.ok && meRes.data) {
    BOT_RUNTIME.botUserId = sanitizeSnowflakeId(meRes.data.id);
    BOT_RUNTIME.botUsername = sanitizeText(meRes.data.username, "SADO PROTECT");
    BOT_RUNTIME.botDiscriminator = sanitizeText(meRes.data.discriminator, "0");
    BOT_RUNTIME.connected = true;
  }

  const guildsRes = await callDiscordRestApi("/users/@me/guilds", "GET", null, token);
  if (guildsRes.ok && Array.isArray(guildsRes.data)) {
    for (const g of guildsRes.data) {
      if (g && g.id) {
        cacheGuildInfo(g.id, g.name, g.icon);
      }
    }
  }

  if (sanitizeSnowflakeId(APP_STATE.guildId)) {
    const resolvedName = await resolveGuildDisplayName(APP_STATE.guildId, APP_STATE.guildName);
    if (resolvedName && resolvedName !== APP_STATE.guildName) {
      APP_STATE.guildName = resolvedName;
      saveAppStateToDisk();
    }
  }

  if (meRes.ok && meRes.data && meRes.data.id) {
    await syncSlashCommandsWithDiscord();
  }

  try {
    const ws = await createGatewayClientSocket(DISCORD_GATEWAY_URL);
    BOT_RUNTIME.socket = ws;

    ws.on("message", async (rawMessage) => {
      const payload = parseJsonSafe(rawMessage, null);
      if (!payload || typeof payload !== "object") return;

      if (typeof payload.s === "number") {
        BOT_RUNTIME.seq = payload.s;
      }

      const op = Number(payload.op);

      if (op === 10) {
        const intervalMs = Number(
          (payload.d && payload.d.heartbeat_interval) || 41250
        );

        clearGatewayTimers();
        BOT_RUNTIME.heartbeatTimer = setInterval(() => {
          ws.sendJson({
            op: 1,
            d: BOT_RUNTIME.seq
          });
        }, Math.max(10000, intervalMs));

        ws.sendJson({
          op: 2,
          d: {
            token,
            intents: 513,
            properties: {
              os: "linux",
              browser: "sado-protect",
              device: "sado-protect"
            },
            presence: {
              activities: [
                {
                  name: APP_STATE.guildName ? `SADO PROTECT | ${APP_STATE.guildName}` : "SADO PROTECT Panel",
                  type: 3
                }
              ],
              status: "online",
              since: null,
              afk: false
            }
          }
        });
        return;
      }

      if (op === 11) {
        BOT_RUNTIME.connected = true;
        BOT_RUNTIME.connecting = false;
        return;
      }

      if (op === 0) {
        const eventName = sanitizeText(payload.t, "");
        const eventData = payload.d && typeof payload.d === "object" ? payload.d : {};

        if (eventName === "READY") {
          BOT_RUNTIME.connected = true;
          BOT_RUNTIME.connecting = false;
          BOT_RUNTIME.lastConnectedAt = new Date().toISOString();
          BOT_RUNTIME.lastError = "";
          BOT_RUNTIME.sessionId = sanitizeText(eventData.session_id, "");

          if (eventData.user) {
            BOT_RUNTIME.botUserId = sanitizeSnowflakeId(eventData.user.id) || BOT_RUNTIME.botUserId;
            BOT_RUNTIME.botUsername = sanitizeText(eventData.user.username, BOT_RUNTIME.botUsername);
            BOT_RUNTIME.botDiscriminator = sanitizeText(eventData.user.discriminator, BOT_RUNTIME.botDiscriminator);
          }

          if (Array.isArray(eventData.guilds)) {
            for (const g of eventData.guilds) {
              if (g && g.id) {
                cacheGuildInfo(g.id, g.name || "", "");
              }
            }
          }

          if (sanitizeSnowflakeId(APP_STATE.guildId)) {
            const realGuildName = await resolveGuildDisplayName(APP_STATE.guildId, APP_STATE.guildName);
            if (realGuildName) {
              APP_STATE.guildName = realGuildName;
              saveAppStateToDisk();
            }
          }

          await syncSlashCommandsWithDiscord();
          return;
        }

        if (eventName === "GUILD_CREATE" || eventName === "GUILD_UPDATE") {
          if (eventData.id && eventData.name) {
            cacheGuildInfo(eventData.id, eventData.name, eventData.icon || "");
            if (sanitizeSnowflakeId(APP_STATE.guildId) === sanitizeSnowflakeId(eventData.id)) {
              APP_STATE.guildName = sanitizeText(eventData.name, APP_STATE.guildName);
              saveAppStateToDisk();
            }
          }
          return;
        }

        if (eventName === "INTERACTION_CREATE") {
          await handleDiscordInteractionCreate(eventData);
        }
      }
    });

    ws.on("close", () => {
      BOT_RUNTIME.connecting = false;
      clearGatewayTimers();
      scheduleGatewayReconnect(4000);
    });

    ws.on("error", (err) => {
      BOT_RUNTIME.connecting = false;
      BOT_RUNTIME.lastError = sanitizeText(err && err.message, "Gateway xətası");
      clearGatewayTimers();
      scheduleGatewayReconnect(5000);
    });
  } catch (err) {
    BOT_RUNTIME.connecting = false;
    BOT_RUNTIME.lastError = sanitizeText(err && err.message, "Gateway bağlantısı yenidən yoxlanılır");
    scheduleGatewayReconnect(6000);
  }
};

// ----------------------------------------------------------------------------
// 10. ÜMUMİ PANEL SNAPSHOT QURUCUSU (`const`)
// ----------------------------------------------------------------------------

const buildPublicSnapshotPayload = async () => {
  const tokenPresent = Boolean(resolveDiscordBotToken());
  const cleanGuildId = sanitizeSnowflakeId(APP_STATE.guildId);
  let resolvedGuildName = sanitizeText(APP_STATE.guildName, "");

  if (cleanGuildId) {
    const freshName = await resolveGuildDisplayName(cleanGuildId, resolvedGuildName);
    if (freshName) {
      resolvedGuildName = freshName;
      if (APP_STATE.guildName !== freshName) {
        APP_STATE.guildName = freshName;
        saveAppStateToDisk();
      }
    }
  }

  const botIsActive = Boolean(BOT_RUNTIME.connected || (tokenPresent && BOT_RUNTIME.botUserId));

  return {
    bot: {
      active: botIsActive,
      statusText: botIsActive
        ? "Bot: Aktivdir"
        : "Bot: Aktiv deyil — Gözləmədədir",
      tokenConfigured: tokenPresent,
      username: BOT_RUNTIME.botUsername || "SADO PROTECT",
      botUserId: BOT_RUNTIME.botUserId || "",
      lastError: BOT_RUNTIME.lastError || "",
      lastConnectedAt: BOT_RUNTIME.lastConnectedAt || ""
    },
    guild: {
      guildId: cleanGuildId,
      guildName: resolvedGuildName,
      displayName: resolvedGuildName || "Bağlı Sunucu Yoxdur",
      panelChannelId: sanitizeSnowflakeId(APP_STATE.panelChannelId)
    },
    stats: {
      scriptsCount: (APP_STATE.scripts || []).length,
      keysCount: (APP_STATE.keys || []).length,
      whitelistCount: (APP_STATE.whitelist || []).length,
      blacklistCount: (APP_STATE.blacklist || []).length
    },
    scripts: APP_STATE.scripts || [],
    keys: APP_STATE.keys || [],
    whitelist: APP_STATE.whitelist || [],
    blacklist: APP_STATE.blacklist || [],
    panelDesign: normalizePanelDesign(APP_STATE.panelDesign),
    auditLogs: (APP_STATE.auditLogs || []).slice(0, 50),
    updatedAt: APP_STATE.updatedAt
  };
};

// ----------------------------------------------------------------------------
// 11. DASHBOARD HTML ŞABLONU (`const`)
// ----------------------------------------------------------------------------

const buildDashboardHtmlDocument = () => {
  return `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT — Enterprise Script & Bot Panel</title>
  <style>
    :root {
      --bg-primary: #060b14;
      --bg-secondary: #0c1526;
      --bg-card: #101c32;
      --border-color: #1e3154;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent-amber: #f59e0b;
      --accent-amber-hover: #d97706;
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --radius-lg: 16px;
      --radius-md: 12px;
      --radius-sm: 8px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at top right, #112240 0%, var(--bg-primary) 60%);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 120;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      background: rgba(8, 15, 29, 0.92);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-color);
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      position: relative;
      z-index: 125;
    }

    .menu-btn {
      width: 44px;
      height: 44px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      color: var(--text-primary);
      font-size: 20px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      touch-action: manipulation;
      position: relative;
      z-index: 130;
    }

    .brand-title {
      font-size: 17px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: var(--accent-amber);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .brand-subtitle {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--accent-red);
    }

    .status-badge.is-active .status-dot {
      background: var(--accent-green);
      box-shadow: 0 0 10px var(--accent-green);
    }

    .app-shell {
      display: flex;
      min-height: calc(100vh - 71px);
    }

    .sidebar {
      width: 250px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }

    .nav-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 14px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }

    .nav-item:hover {
      background: var(--bg-card);
      color: var(--text-primary);
    }

    .nav-item.active {
      background: rgba(245, 158, 11, 0.14);
      border-color: rgba(245, 158, 11, 0.45);
      color: var(--accent-amber);
    }

    .main-content {
      flex: 1;
      padding: 20px 16px 60px;
      max-width: 1180px;
      width: 100%;
      margin: 0 auto;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }

    @media (min-width: 820px) {
      .stats-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .stat-label {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 600;
    }

    .stat-value {
      font-size: 24px;
      font-weight: 800;
      color: var(--accent-amber);
      word-break: break-word;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 18px;
      margin-bottom: 18px;
    }

    .card-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 14px;
    }

    .banner-box {
      padding: 13px 15px;
      border-radius: var(--radius-md);
      background: rgba(15, 28, 52, 0.9);
      border: 1px solid var(--border-color);
      margin-bottom: 14px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .form-group { margin-bottom: 14px; }

    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .form-control,
    .form-select,
    .form-textarea {
      width: 100%;
      padding: 11px 13px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
    }

    .form-textarea { min-height: 92px; resize: vertical; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 11px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }

    .btn-primary { background: var(--accent-amber); color: #09101d; }
    .btn-primary:hover { background: var(--accent-amber-hover); }
    .btn-secondary { background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-primary); }
    .btn-danger { background: rgba(239, 68, 68, 0.16); border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }
    .btn-sm { padding: 7px 11px; font-size: 12px; }
    .btn-row { display: flex; flex-wrap: wrap; gap: 10px; }

    .item-list { display: flex; flex-direction: column; gap: 10px; }
    .item-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .item-name { font-weight: 700; font-size: 15px; }
    .item-meta { font-size: 12px; color: var(--text-secondary); word-break: break-all; }

    .pill {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(59, 130, 246, 0.18);
      color: #93c5fd;
    }

    .designer-btn-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      padding: 12px;
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      margin-bottom: 10px;
    }

    .toast-container {
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 340px;
    }

    .toast {
      padding: 12px 14px;
      border-radius: var(--radius-sm);
      background: var(--bg-card);
      border: 1px solid var(--accent-amber);
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
    }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    @media (max-width: 780px) {
      .sidebar {
        position: fixed;
        top: 71px;
        left: 0;
        bottom: 0;
        z-index: 95;
        width: 260px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        transform: translateX(-100%);
        transition: transform 0.2s ease;
      }
      .sidebar.open { transform: translateX(0); }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <button id="mobileMenuBtn" class="menu-btn" type="button" aria-label="Menyu">☰</button>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-subtitle">Enterprise Script, Key & Bot Control Panel</div>
      </div>
    </div>
    <div id="botStatusBadge" class="status-badge">
      <span class="status-dot"></span>
      <span id="botStatusText">Bot: Aktiv deyil — Gözləmədədir</span>
    </div>
  </header>

  <div class="app-shell">
    <aside id="sidebarNav" class="sidebar">
      <button class="nav-item active" data-tab="overview" type="button">🎛️ İdarəetmə</button>
      <button class="nav-item" data-tab="scripts" type="button">📜 Scriptlər</button>
      <button class="nav-item" data-tab="keys" type="button">🔑 Keylər</button>
      <button class="nav-item" data-tab="designer" type="button">🎨 Panel Dizaynı</button>
      <button class="nav-item" data-tab="access" type="button">🛡️ Whitelist / Blacklist</button>
    </aside>

    <main class="main-content">
      <section class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Aktiv Scriptlər</div>
          <div id="statScriptsCount" class="stat-value">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Yaradılan Keylər</div>
          <div id="statKeysCount" class="stat-value">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bağlanan Sunucu</div>
          <div id="statGuildName" class="stat-value">Bağlı Sunucu Yoxdur</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Whitelist / Blacklist</div>
          <div id="statAccessCounts" class="stat-value">0 / 0</div>
        </div>
      </section>

      <section id="tab-overview" class="tab-panel active">
        <div class="card">
          <div class="card-title">🎛️ İdarəetmə — Discord Bot Bağlantısı</div>
          <div id="guildBannerText" class="banner-box">Bağlanan Sunucu: Bağlı Sunucu Yoxdur</div>

          <div class="form-group">
            <label class="form-label" for="guildIdInput">Sunucu ID</label>
            <input id="guildIdInput" class="form-control" type="text" placeholder="Məsələn: 1559499280732131348" />
          </div>

          <div class="form-group">
            <label class="form-label" for="panelChannelIdInput">Panel Kanal ID (İstəyə bağlı)</label>
            <input id="panelChannelIdInput" class="form-control" type="text" placeholder="Panelin göndəriləcəyi kanal ID-si" />
          </div>

          <div class="btn-row">
            <button id="connectBotBtn" class="btn btn-primary" type="button">Botu Aktiv Et və Sunucunu Bağla</button>
            <button id="sendPanelChannelBtn" class="btn btn-secondary" type="button">Paneli Kanala Göndər</button>
          </div>
        </div>
      </section>

      <section id="tab-scripts" class="tab-panel">
        <div class="card">
          <div class="card-title">➕ Script Yarat</div>
          <div class="form-group">
            <label class="form-label" for="newScriptNameInput">Script Adı</label>
            <input id="newScriptNameInput" class="form-control" type="text" placeholder="Məsələn: Sado Hub Aimbot" />
          </div>
          <div class="form-group">
            <label class="form-label" for="newScriptSourceType">Mənbə Növü</label>
            <select id="newScriptSourceType" class="form-select">
              <option value="url">URL ilə (HttpGet / Raw link)</option>
              <option value="file">Fayl ilə (.lua / .txt)</option>
            </select>
          </div>
          <div id="scriptUrlGroup" class="form-group">
            <label class="form-label" for="newScriptUrlInput">Script URL</label>
            <input id="newScriptUrlInput" class="form-control" type="text" placeholder="https://raw.githubusercontent.com/.../script.lua" />
          </div>
          <div id="scriptFileGroup" class="form-group" style="display: none;">
            <label class="form-label" for="newScriptFileInput">Script Faylı (.lua / .txt)</label>
            <input id="newScriptFileInput" class="form-control" type="file" accept=".lua,.txt,text/plain" />
          </div>
          <div class="form-group">
            <label class="form-label" for="newScriptDescInput">Qısa Təsvir (İstəyə bağlı)</label>
            <textarea id="newScriptDescInput" class="form-textarea" placeholder="Script haqqında məlumat..."></textarea>
          </div>
          <button id="createScriptBtn" class="btn btn-primary" type="button">Script Yarat</button>
        </div>

        <div class="card">
          <div class="card-title">📜 Mövcud Scriptlər</div>
          <div id="scriptsListContainer" class="item-list"></div>
        </div>
      </section>

      <section id="tab-keys" class="tab-panel">
        <div class="card">
          <div class="card-title">🔑 Yeni Key Yarat</div>
          <div class="form-group">
            <label class="form-label" for="keyScriptSelect">Script Seçimi</label>
            <select id="keyScriptSelect" class="form-select"></select>
          </div>
          <div class="form-group">
            <label class="form-label" for="keyDurationInput">Müddət (Gün — 0 yazsanız ömürlük)</label>
            <input id="keyDurationInput" class="form-control" type="number" min="0" value="30" />
          </div>
          <button id="generateKeyBtn" class="btn btn-primary" type="button">Key Yarat</button>
        </div>

        <div class="card">
          <div class="card-title">📋 Yaradılan Keylər</div>
          <div id="keysListContainer" class="item-list"></div>
        </div>
      </section>

      <section id="tab-designer" class="tab-panel">
        <div class="card">
          <div class="card-title">🎨 Panel Dizaynı</div>
          <div class="form-group">
            <label class="form-label" for="designTitleInput">Panel Başlığı</label>
            <input id="designTitleInput" class="form-control" type="text" />
          </div>
          <div class="form-group">
            <label class="form-label" for="designDescInput">Panel Təsviri</label>
            <textarea id="designDescInput" class="form-textarea"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label" for="designColorInput">Embed Rəngi (HEX)</label>
            <input id="designColorInput" class="form-control" type="color" />
          </div>
          <div class="form-group">
            <label class="form-label" for="designFooterInput">Footer Mətni</label>
            <input id="designFooterInput" class="form-control" type="text" />
          </div>
          <div class="form-group">
            <label class="form-label">Butonların Adı, Emojisi, Rəngi və Sırası</label>
            <div id="designerButtonsContainer"></div>
          </div>
          <div class="btn-row">
            <button id="addDesignerButtonBtn" class="btn btn-secondary" type="button">+ Yeni Buton Əlavə Et</button>
            <button id="saveDesignBtn" class="btn btn-primary" type="button">Dizaynı Yadda Saxla</button>
          </div>
        </div>
      </section>

      <section id="tab-access" class="tab-panel">
        <div class="card">
          <div class="card-title">🛡️ Whitelist / Blacklist İdarəetməsi</div>
          <div class="form-group">
            <label class="form-label" for="accessListTypeSelect">Siyahı Növü</label>
            <select id="accessListTypeSelect" class="form-select">
              <option value="whitelist">Whitelist</option>
              <option value="blacklist">Blacklist</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="accessValueInput">İstifadəçi ID / HWID / Nick</label>
            <input id="accessValueInput" class="form-control" type="text" placeholder="Məsələn: 987654321098765432" />
          </div>
          <button id="addAccessEntryBtn" class="btn btn-primary" type="button">Siyahıya Əlavə Et</button>
        </div>

        <div class="card">
          <div class="card-title">📌 Aktiv Whitelist və Blacklist Siyahısı</div>
          <div id="accessListsContainer" class="item-list"></div>
        </div>
      </section>
    </main>
  </div>

  <div id="toastContainer" class="toast-container"></div>

  <script>
    const clientState = {
      snapshot: null,
      designerButtons: [],
      editingScriptId: ""
    };

    const showToast = (messageText) => {
      const container = document.getElementById("toastContainer");
      if (!container) return;
      const toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.textContent = String(messageText || "");
      container.appendChild(toastEl);
      setTimeout(() => {
        if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      }, 3200);
    };

    const apiRequest = async (urlPath, methodName = "GET", bodyObj = null) => {
      const fetchOptions = { method: methodName, headers: {} };
      if (bodyObj !== null) {
        fetchOptions.headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify(bodyObj);
      }
      const res = await fetch(urlPath, fetchOptions);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sorğu uğursuz oldu");
      return data;
    };

    const renderDesignerButtonsForm = () => {
      const container = document.getElementById("designerButtonsContainer");
      if (!container) return;
      container.innerHTML = "";

      (clientState.designerButtons || []).forEach((btn, idx) => {
        const row = document.createElement("div");
        row.className = "designer-btn-row";

        const labelInput = document.createElement("input");
        labelInput.className = "form-control";
        labelInput.value = btn.label || "";
        labelInput.placeholder = "Buton adı";
        labelInput.addEventListener("input", (e) => {
          clientState.designerButtons[idx].label = e.target.value;
        });

        const emojiInput = document.createElement("input");
        emojiInput.className = "form-control";
        emojiInput.value = btn.emoji || "";
        emojiInput.placeholder = "Emoji";
        emojiInput.addEventListener("input", (e) => {
          clientState.designerButtons[idx].emoji = e.target.value;
        });

        const styleSelect = document.createElement("select");
        styleSelect.className = "form-select";
        [
          { v: "primary", t: "Mavi (Primary)" },
          { v: "success", t: "Yaşıl (Success)" },
          { v: "secondary", t: "Boz (Secondary)" },
          { v: "danger", t: "Qırmızı (Danger)" }
        ].forEach((optItem) => {
          const opt = document.createElement("option");
          opt.value = optItem.v;
          opt.textContent = optItem.t;
          if (btn.style === optItem.v) opt.selected = true;
          styleSelect.appendChild(opt);
        });
        styleSelect.addEventListener("change", (e) => {
          clientState.designerButtons[idx].style = e.target.value;
        });

        const orderInput = document.createElement("input");
        orderInput.className = "form-control";
        orderInput.type = "number";
        orderInput.min = "1";
        orderInput.value = String(btn.order || idx + 1);
        orderInput.addEventListener("input", (e) => {
          clientState.designerButtons[idx].order = Number(e.target.value || idx + 1);
        });

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-danger btn-sm";
        removeBtn.textContent = "Sil";
        removeBtn.addEventListener("click", () => {
          clientState.designerButtons.splice(idx, 1);
          renderDesignerButtonsForm();
        });

        row.appendChild(labelInput);
        row.appendChild(emojiInput);
        row.appendChild(styleSelect);
        row.appendChild(orderInput);
        row.appendChild(removeBtn);
        container.appendChild(row);
      });
    };

    const renderScriptsSection = (scriptsArr) => {
      const container = document.getElementById("scriptsListContainer");
      const keySelect = document.getElementById("keyScriptSelect");
      if (!container) return;

      if (keySelect) {
        const prevVal = keySelect.value;
        keySelect.innerHTML = '<option value="Ümumi">Ümumi (Bütün Scriptlər)</option>';
        (scriptsArr || []).forEach((sc) => {
          const opt = document.createElement("option");
          opt.value = sc.name;
          opt.textContent = sc.name;
          if (prevVal === sc.name) opt.selected = true;
          keySelect.appendChild(opt);
        });
      }

      container.innerHTML = "";
      if (!scriptsArr || scriptsArr.length === 0) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "item-card";
        emptyCard.textContent = "Hələ heç bir script əlavə edilməyib.";
        container.appendChild(emptyCard);
        return;
      }

      scriptsArr.forEach((sc) => {
        const card = document.createElement("div");
        card.className = "item-card";

        const header = document.createElement("div");
        header.className = "item-header";

        const titleEl = document.createElement("div");
        titleEl.className = "item-name";
        titleEl.textContent = sc.name || "Script";

        const badgeEl = document.createElement("span");
        badgeEl.className = "pill";
        badgeEl.textContent = sc.sourceType === "file"
          ? "FAYL: " + (sc.fileName || "script.lua")
          : "URL";

        header.appendChild(titleEl);
        header.appendChild(badgeEl);

        const metaEl = document.createElement("div");
        metaEl.className = "item-meta";
        metaEl.textContent = sc.sourceType === "file"
          ? "Məzmun uzunluğu: " + String((sc.scriptContent || "").length) + " simvol"
          : "URL: " + String(sc.scriptUrl || "");

        const actionsRow = document.createElement("div");
        actionsRow.className = "btn-row";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn btn-secondary btn-sm";
        editBtn.textContent = "Düzəliş Et";

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn btn-danger btn-sm";
        deleteBtn.textContent = "Sil";
        deleteBtn.addEventListener("click", async () => {
          try {
            await apiRequest("/api/scripts/" + encodeURIComponent(sc.id), "DELETE");
            showToast("Script silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });

        actionsRow.appendChild(editBtn);
        actionsRow.appendChild(deleteBtn);

        card.appendChild(header);
        card.appendChild(metaEl);

        if (clientState.editingScriptId === sc.id) {
          const inlineBox = document.createElement("div");
          inlineBox.style.marginTop = "8px";

          const editNameInput = document.createElement("input");
          editNameInput.className = "form-control";
          editNameInput.style.marginBottom = "8px";
          editNameInput.value = sc.name || "";

          const editUrlOrCodeInput = document.createElement("textarea");
          editUrlOrCodeInput.className = "form-textarea";
          editUrlOrCodeInput.style.marginBottom = "8px";
          editUrlOrCodeInput.value = sc.sourceType === "file"
            ? (sc.scriptContent || "")
            : (sc.scriptUrl || "");

          const saveInlineBtn = document.createElement("button");
          saveInlineBtn.type = "button";
          saveInlineBtn.className = "btn btn-primary btn-sm";
          saveInlineBtn.textContent = "Yadda Saxla";
          saveInlineBtn.addEventListener("click", async () => {
            try {
              const payload = { name: editNameInput.value };
              if (sc.sourceType === "file") payload.scriptContent = editUrlOrCodeInput.value;
              else payload.scriptUrl = editUrlOrCodeInput.value;
              await apiRequest("/api/scripts/" + encodeURIComponent(sc.id), "PUT", payload);
              clientState.editingScriptId = "";
              showToast("Script yeniləndi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });

          const cancelInlineBtn = document.createElement("button");
          cancelInlineBtn.type = "button";
          cancelInlineBtn.className = "btn btn-secondary btn-sm";
          cancelInlineBtn.textContent = "Ləğv Et";
          cancelInlineBtn.addEventListener("click", () => {
            clientState.editingScriptId = "";
            renderScriptsSection(scriptsArr);
          });

          const inlineBtns = document.createElement("div");
          inlineBtns.className = "btn-row";
          inlineBtns.appendChild(saveInlineBtn);
          inlineBtns.appendChild(cancelInlineBtn);

          inlineBox.appendChild(editNameInput);
          inlineBox.appendChild(editUrlOrCodeInput);
          inlineBox.appendChild(inlineBtns);
          card.appendChild(inlineBox);
        } else {
          editBtn.addEventListener("click", () => {
            clientState.editingScriptId = sc.id;
            renderScriptsSection(scriptsArr);
          });
          card.appendChild(actionsRow);
        }

        container.appendChild(card);
      });
    };

    const renderKeysSection = (keysArr) => {
      const container = document.getElementById("keysListContainer");
      if (!container) return;
      container.innerHTML = "";

      if (!keysArr || keysArr.length === 0) {
        const empty = document.createElement("div");
        empty.className = "item-card";
        empty.textContent = "Hələ heç bir key yaradılmayıb.";
        container.appendChild(empty);
        return;
      }

      keysArr.forEach((k) => {
        const card = document.createElement("div");
        card.className = "item-card";

        const top = document.createElement("div");
        top.className = "item-header";

        const codeEl = document.createElement("div");
        codeEl.className = "item-name";
        codeEl.textContent = k.key;

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-danger btn-sm";
        delBtn.textContent = "Sil";
        delBtn.addEventListener("click", async () => {
          try {
            await apiRequest("/api/keys/" + encodeURIComponent(k.id), "DELETE");
            showToast("Key silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });

        top.appendChild(codeEl);
        top.appendChild(delBtn);

        const durationText = Number(k.days) === 0 ? "Lifetime" : String(k.days) + " gün";
        const hwidText = k.hwid ? ("HWID: " + k.hwid) : "HWID: Bağlanmayıb (İlk cihaza bağlanacaq)";
        const statusText = k.active === false ? "Deaktiv" : "Aktiv";
        const meta = document.createElement("div");
        meta.className = "item-meta";
        meta.textContent =
          "Status: " + statusText +
          " | Sahibi: " + String(k.owner || "—") +
          " | Script: " + String(k.scriptName || "Ümumi") +
          " | Müddət: " + durationText +
          " | " + hwidText;

        card.appendChild(top);
        card.appendChild(meta);
        container.appendChild(card);
      });
    };

    const renderAccessSection = (whitelistArr, blacklistArr) => {
      const container = document.getElementById("accessListsContainer");
      if (!container) return;
      container.innerHTML = "";

      const combined = [
        ...(whitelistArr || []).map((item) => ({ ...item, listType: "whitelist" })),
        ...(blacklistArr || []).map((item) => ({ ...item, listType: "blacklist" }))
      ];

      if (combined.length === 0) {
        const empty = document.createElement("div");
        empty.className = "item-card";
        empty.textContent = "Whitelist və ya Blacklist qeydi yoxdur.";
        container.appendChild(empty);
        return;
      }

      combined.forEach((entry) => {
        const card = document.createElement("div");
        card.className = "item-card";

        const top = document.createElement("div");
        top.className = "item-header";

        const valEl = document.createElement("div");
        valEl.className = "item-name";
        valEl.textContent = entry.value;

        const rightBox = document.createElement("div");
        rightBox.className = "btn-row";

        const badge = document.createElement("span");
        badge.className = "pill";
        badge.textContent = entry.listType === "whitelist" ? "WHITELIST" : "BLACKLIST";

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-danger btn-sm";
        removeBtn.textContent = entry.listType === "whitelist" ? "Unwhitelist" : "Sil";
        removeBtn.addEventListener("click", async () => {
          try {
            await apiRequest(
              "/api/access/" + encodeURIComponent(entry.listType) + "/" + encodeURIComponent(entry.id),
              "DELETE"
            );
            showToast(entry.listType === "whitelist" ? "Unwhitelist edildi — giriş bağlandı" : "Qeyd silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });

        rightBox.appendChild(badge);
        rightBox.appendChild(removeBtn);

        top.appendChild(valEl);
        top.appendChild(rightBox);

        if (entry.generatedKey) {
          const keyInfo = document.createElement("div");
          keyInfo.className = "item-meta";
          keyInfo.textContent = "Avto Key: " + entry.generatedKey;
          card.appendChild(top);
          card.appendChild(keyInfo);
        } else {
          card.appendChild(top);
        }

        container.appendChild(card);
      });
    };

    const applySnapshotToUi = (snap) => {
      clientState.snapshot = snap;

      const botBadge = document.getElementById("botStatusBadge");
      const botStatusText = document.getElementById("botStatusText");
      const statScripts = document.getElementById("statScriptsCount");
      const statKeys = document.getElementById("statKeysCount");
      const statGuild = document.getElementById("statGuildName");
      const statAccess = document.getElementById("statAccessCounts");
      const guildBanner = document.getElementById("guildBannerText");
      const guildIdInput = document.getElementById("guildIdInput");
      const panelChannelInput = document.getElementById("panelChannelIdInput");

      const isBotActive = Boolean(snap && snap.bot && snap.bot.active);
      if (botBadge) botBadge.classList.toggle("is-active", isBotActive);
      if (botStatusText) {
        botStatusText.textContent = (snap && snap.bot && snap.bot.statusText) || "Bot: Aktiv deyil — Gözləmədədir";
      }

      const guildDisplayName = (snap && snap.guild && (snap.guild.guildName || snap.guild.displayName)) || "Bağlı Sunucu Yoxdur";
      if (statScripts) statScripts.textContent = String((snap && snap.stats && snap.stats.scriptsCount) || 0);
      if (statKeys) statKeys.textContent = String((snap && snap.stats && snap.stats.keysCount) || 0);
      if (statGuild) statGuild.textContent = guildDisplayName;
      if (statAccess) {
        statAccess.textContent = String((snap && snap.stats && snap.stats.whitelistCount) || 0) + " / " + String((snap && snap.stats && snap.stats.blacklistCount) || 0);
      }
      if (guildBanner) guildBanner.textContent = "Bağlanan Sunucu: " + guildDisplayName;

      if (guildIdInput && document.activeElement !== guildIdInput) {
        guildIdInput.value = (snap && snap.guild && snap.guild.guildId) || "";
      }
      if (panelChannelInput && document.activeElement !== panelChannelInput) {
        panelChannelInput.value = (snap && snap.guild && snap.guild.panelChannelId) || "";
      }

      if (snap && snap.panelDesign) {
        const designTitleInput = document.getElementById("designTitleInput");
        const designDescInput = document.getElementById("designDescInput");
        const designColorInput = document.getElementById("designColorInput");
        const designFooterInput = document.getElementById("designFooterInput");

        if (designTitleInput && document.activeElement !== designTitleInput) designTitleInput.value = snap.panelDesign.title || "";
        if (designDescInput && document.activeElement !== designDescInput) designDescInput.value = snap.panelDesign.description || "";
        if (designColorInput && document.activeElement !== designColorInput) designColorInput.value = snap.panelDesign.color || "#f59e0b";
        if (designFooterInput && document.activeElement !== designFooterInput) designFooterInput.value = snap.panelDesign.footerText || "";

        if (Array.isArray(snap.panelDesign.buttons)) {
          clientState.designerButtons = snap.panelDesign.buttons.map((b) => ({ ...b }));
          renderDesignerButtonsForm();
        }
      }

      renderScriptsSection((snap && snap.scripts) || []);
      renderKeysSection((snap && snap.keys) || []);
      renderAccessSection((snap && snap.whitelist) || [], (snap && snap.blacklist) || []);
    };

    const refreshDashboardSnapshot = async () => {
      try {
        const snap = await apiRequest("/api/snapshot", "GET");
        applySnapshotToUi(snap);
      } catch (err) {
        showToast("Yeniləmə xətası: " + err.message);
      }
    };

    const bindUiEvents = () => {
      const mobileMenuBtn = document.getElementById("mobileMenuBtn");
      const sidebarNav = document.getElementById("sidebarNav");

      const toggleMobileDrawer = (event) => {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (!sidebarNav) return;
        sidebarNav.classList.toggle("open");
      };

      if (mobileMenuBtn && sidebarNav) {
        mobileMenuBtn.addEventListener("click", toggleMobileDrawer);
        mobileMenuBtn.addEventListener("touchend", toggleMobileDrawer, { passive: false });

        document.addEventListener("click", (evt) => {
          if (!sidebarNav.classList.contains("open")) return;
          const clickedInsideSidebar = sidebarNav.contains(evt.target);
          const clickedMenuBtn = mobileMenuBtn.contains(evt.target);
          if (!clickedInsideSidebar && !clickedMenuBtn) {
            sidebarNav.classList.remove("open");
          }
        });
      }

      document.querySelectorAll(".nav-item").forEach((navBtn) => {
        navBtn.addEventListener("click", (evt) => {
          evt.preventDefault();
          const targetTab = navBtn.getAttribute("data-tab");
          document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
          document.querySelectorAll(".tab-panel").forEach((el) => el.classList.remove("active"));
          navBtn.classList.add("active");
          const panelEl = document.getElementById("tab-" + targetTab);
          if (panelEl) panelEl.classList.add("active");
          if (sidebarNav) sidebarNav.classList.remove("open");
        });
      });

      const sourceTypeSelect = document.getElementById("newScriptSourceType");
      const urlGroup = document.getElementById("scriptUrlGroup");
      const fileGroup = document.getElementById("scriptFileGroup");

      if (sourceTypeSelect && urlGroup && fileGroup) {
        sourceTypeSelect.addEventListener("change", () => {
          const isFile = sourceTypeSelect.value === "file";
          urlGroup.style.display = isFile ? "none" : "block";
          fileGroup.style.display = isFile ? "block" : "none";
        });
      }

      const connectBtn = document.getElementById("connectBotBtn");
      if (connectBtn) {
        connectBtn.addEventListener("click", async () => {
          const guildIdVal = ((document.getElementById("guildIdInput") || {}).value || "").trim();
          const channelIdVal = ((document.getElementById("panelChannelIdInput") || {}).value || "").trim();
          try {
            const res = await apiRequest("/api/bot/connect", "POST", {
              guildId: guildIdVal,
              panelChannelId: channelIdVal
            });
            showToast("Bağlandı: " + ((res.guild && (res.guild.guildName || res.guild.displayName)) || "Sunucu"));
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      }

      const guildIdLiveInput = document.getElementById("guildIdInput");
      if (guildIdLiveInput) {
        guildIdLiveInput.addEventListener("change", async () => {
          const typedId = (guildIdLiveInput.value || "").trim();
          if (/^\d{15,22}$/.test(typedId)) {
            try {
              await apiRequest("/api/bot/connect", "POST", { guildId: typedId });
              await refreshDashboardSnapshot();
            } catch (_err) {}
          }
        });
      }

      const sendPanelBtn = document.getElementById("sendPanelChannelBtn");
      if (sendPanelBtn) {
        sendPanelBtn.addEventListener("click", async () => {
          const channelIdVal = (document.getElementById("panelChannelIdInput") || {}).value || "";
          try {
            await apiRequest("/api/panel/send", "POST", { channelId: channelIdVal });
            showToast("Panel kanala göndərildi");
          } catch (err) {
            showToast(err.message);
          }
        });
      }

      const createScriptBtn = document.getElementById("createScriptBtn");
      if (createScriptBtn) {
        createScriptBtn.addEventListener("click", async () => {
          const nameVal = ((document.getElementById("newScriptNameInput") || {}).value || "").trim();
          const typeVal = ((document.getElementById("newScriptSourceType") || {}).value || "url");
          const urlVal = ((document.getElementById("newScriptUrlInput") || {}).value || "").trim();
          const descVal = ((document.getElementById("newScriptDescInput") || {}).value || "").trim();
          const fileInput = document.getElementById("newScriptFileInput");

          if (!nameVal) {
            showToast("Zəhmət olmasa script adı daxil edin");
            return;
          }

          let fileNameText = "";
          let fileContentText = "";

          if (typeVal === "file") {
            const chosenFile = fileInput && fileInput.files && fileInput.files[0];
            if (!chosenFile) {
              showToast("Zəhmət olmasa .lua və ya .txt fayl seçin");
              return;
            }
            fileNameText = chosenFile.name;
            fileContentText = await chosenFile.text();
          }

          try {
            await apiRequest("/api/scripts", "POST", {
              name: nameVal,
              sourceType: typeVal,
              scriptUrl: urlVal,
              fileName: fileNameText,
              scriptContent: fileContentText,
              description: descVal
            });

            document.getElementById("newScriptNameInput").value = "";
            document.getElementById("newScriptUrlInput").value = "";
            document.getElementById("newScriptDescInput").value = "";
            if (fileInput) fileInput.value = "";

            showToast("Script yaradıldı və siyahıya əlavə olundu");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      }

      const generateKeyBtn = document.getElementById("generateKeyBtn");
      if (generateKeyBtn) {
        generateKeyBtn.addEventListener("click", async () => {
          const scriptNameVal = ((document.getElementById("keyScriptSelect") || {}).value || "Ümumi");
          const daysVal = Number(((document.getElementById("keyDurationInput") || {}).value || 30));
          try {
            await apiRequest("/api/keys", "POST", { scriptName: scriptNameVal, days: daysVal });
            showToast("Yeni key yaradıldı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      }

      const addBtn = document.getElementById("addDesignerButtonBtn");
      if (addBtn) {
        addBtn.addEventListener("click", () => {
          const nextOrder = (clientState.designerButtons || []).length + 1;
          clientState.designerButtons.push({
            id: "btn_" + Date.now(),
            label: "Yeni Düymə " + nextOrder,
            emoji: "⚡",
            style: "primary",
            enabled: true,
            order: nextOrder
          });
          renderDesignerButtonsForm();
        });
      }

      const saveDesignBtn = document.getElementById("saveDesignBtn");
      if (saveDesignBtn) {
        saveDesignBtn.addEventListener("click", async () => {
          const designPayload = {
            title: ((document.getElementById("designTitleInput") || {}).value || ""),
            description: ((document.getElementById("designDescInput") || {}).value || ""),
            color: ((document.getElementById("designColorInput") || {}).value || "#f59e0b"),
            footerText: ((document.getElementById("designFooterInput") || {}).value || ""),
            buttons: clientState.designerButtons
          };
          try {
            await apiRequest("/api/design", "PUT", designPayload);
            showToast("Panel dizaynı yadda saxlandı");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      }

      const addAccessBtn = document.getElementById("addAccessEntryBtn");
      if (addAccessBtn) {
        addAccessBtn.addEventListener("click", async () => {
          const listTypeVal = ((document.getElementById("accessListTypeSelect") || {}).value || "whitelist");
          const entryVal = (((document.getElementById("accessValueInput") || {}).value || "")).trim();
          if (!entryVal) {
            showToast("Dəyər daxil edin");
            return;
          }
          try {
            await apiRequest("/api/access", "POST", { listType: listTypeVal, value: entryVal });
            document.getElementById("accessValueInput").value = "";
            showToast("Siyahıya əlavə olundu");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      }
    };

    window.addEventListener("DOMContentLoaded", async () => {
      bindUiEvents();
      await refreshDashboardSnapshot();
      setInterval(refreshDashboardSnapshot, 8000);
    });
  </script>
</body>
</html>`;
};

// ----------------------------------------------------------------------------
// 12. HTTP API MARŞRUTLARI VƏ 7/24 KEEP-ALIVE SERVER (`const`)
// ----------------------------------------------------------------------------

const applyCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
};

const sendJsonResponse = (res, statusCode, payloadObj) => {
  applyCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payloadObj));
};

const parseRequestJsonBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawText = Buffer.concat(chunks).toString("utf8").trim();
      if (!rawText) {
        resolve({});
        return;
      }
      const parsed = parseJsonSafe(rawText, null);
      if (!parsed || typeof parsed !== "object") {
        reject(new Error("Keçərsiz JSON formatı"));
        return;
      }
      resolve(parsed);
    });
    req.on("error", (err) => reject(err));
  });
};

const startRenderKeepAliveLoop = () => {
  if (BOT_RUNTIME.keepAliveTimer) return;
  const publicUrl = sanitizeText(
    process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "",
    ""
  );
  if (!publicUrl || !publicUrl.startsWith("http")) return;

  BOT_RUNTIME.keepAliveTimer = setInterval(async () => {
    try {
      await performHttpsRequest(`${publicUrl.replace(/\/$/, "")}/health`, {
        method: "GET",
        timeoutMs: 6000
      });
    } catch (_err) {}
  }, 4 * 60 * 1000);
};

const handleHttpRequest = async (req, res) => {
  applyCorsHeaders(res);

  const method = sanitizeText(req.method, "GET").toUpperCase();
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;

  try {
    if (method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/panel")) {
      const htmlContent = buildDashboardHtmlDocument();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlContent);
      return;
    }

    if (method === "GET" && pathname === "/health") {
      sendJsonResponse(res, 200, {
        ok: true,
        botActive: Boolean(BOT_RUNTIME.connected || BOT_RUNTIME.botUserId),
        guildName: APP_STATE.guildName || "",
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (method === "GET" && pathname === "/api/snapshot") {
      const snapshot = await buildPublicSnapshotPayload();
      sendJsonResponse(res, 200, snapshot);
      return;
    }

    if (method === "POST" && pathname === "/api/bot/connect") {
      const body = await parseRequestJsonBody(req);
      const cleanGuildId = sanitizeSnowflakeId(body.guildId);
      const cleanChannelId = sanitizeSnowflakeId(body.panelChannelId);

      if (!cleanGuildId) {
        sendJsonResponse(res, 400, { error: "Zəhmət olmasa düzgün Sunucu ID (15-22 rəqəm) daxil edin" });
        return;
      }

      if (!BOT_RUNTIME.connected && resolveDiscordBotToken()) {
        await startDiscordBotRuntime();
      }

      const resolvedName = await resolveGuildDisplayName(cleanGuildId, body.guildName || "");
      APP_STATE.guildId = cleanGuildId;
      APP_STATE.guildName = resolvedName || (sanitizeText(body.guildName, "") || "Bağlı Sunucu");
      if (cleanChannelId) {
        APP_STATE.panelChannelId = cleanChannelId;
      }

      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord();
      appendAuditLog("GUILD_CONNECTED", `Sunucu bağlandı: ${APP_STATE.guildName} (${cleanGuildId})`, "Dashboard");

      const snapshot = await buildPublicSnapshotPayload();
      sendJsonResponse(res, 200, {
        ok: true,
        guild: snapshot.guild,
        bot: snapshot.bot,
        snapshot
      });
      return;
    }

    if (method === "POST" && pathname === "/api/panel/send") {
      const body = await parseRequestJsonBody(req);
      const result = await publishPanelToDiscordChannel(body.channelId, body.scriptName);
      if (!result.ok) {
        sendJsonResponse(res, 400, { error: result.error });
        return;
      }
      sendJsonResponse(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/scripts") {
      const body = await parseRequestJsonBody(req);
      const scriptName = sanitizeText(body.name, "");
      const sourceType = sanitizeText(body.sourceType, "url") === "file" ? "file" : "url";
      const scriptUrl = sanitizeText(body.scriptUrl, "");
      const fileName = sanitizeText(body.fileName, "");
      const scriptContent = typeof body.scriptContent === "string" ? body.scriptContent : "";
      const description = sanitizeText(body.description, "");

      if (!scriptName) {
        sendJsonResponse(res, 400, { error: "Script adı mütləqdir" });
        return;
      }
      if (sourceType === "url" && !scriptUrl) {
        sendJsonResponse(res, 400, { error: "URL növü seçildikdə Script URL daxil edilməlidir" });
        return;
      }
      if (sourceType === "file" && !scriptContent.trim()) {
        sendJsonResponse(res, 400, { error: "Fayl növü seçildikdə fayl məzmunu boş ola bilməz" });
        return;
      }

      const newScript = {
        id: generateUniqueId("script"),
        name: scriptName,
        sourceType,
        scriptUrl,
        fileName: fileName || (sourceType === "file" ? `${scriptName.toLowerCase().replace(/\s+/g, "_")}.lua` : ""),
        scriptContent,
        description,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      APP_STATE.scripts = [newScript, ...(APP_STATE.scripts || [])];
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord();
      appendAuditLog("SCRIPT_CREATED", `Yeni script yaradıldı: ${scriptName}`, "Dashboard");

      sendJsonResponse(res, 201, { ok: true, script: newScript });
      return;
    }

    if (method === "PUT" && pathname.startsWith("/api/scripts/")) {
      const targetId = sanitizeText(pathname.replace("/api/scripts/", ""), "");
      const body = await parseRequestJsonBody(req);
      const index = (APP_STATE.scripts || []).findIndex((s) => s && s.id === targetId);

      if (index === -1) {
        sendJsonResponse(res, 404, { error: "Script tapılmadı" });
        return;
      }

      const currentItem = APP_STATE.scripts[index];
      const updatedItem = {
        ...currentItem,
        name: sanitizeText(body.name, currentItem.name),
        scriptUrl: body.scriptUrl !== undefined ? sanitizeText(body.scriptUrl, "") : currentItem.scriptUrl,
        scriptContent: body.scriptContent !== undefined ? String(body.scriptContent) : currentItem.scriptContent,
        description: body.description !== undefined ? sanitizeText(body.description, "") : currentItem.description,
        updatedAt: new Date().toISOString()
      };

      APP_STATE.scripts[index] = updatedItem;
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord();
      appendAuditLog("SCRIPT_UPDATED", `Script yeniləndi: ${updatedItem.name}`, "Dashboard");

      sendJsonResponse(res, 200, { ok: true, script: updatedItem });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/scripts/")) {
      const targetId = sanitizeText(pathname.replace("/api/scripts/", ""), "");
      const beforeCount = (APP_STATE.scripts || []).length;
      APP_STATE.scripts = (APP_STATE.scripts || []).filter((s) => s && s.id !== targetId);

      if (APP_STATE.scripts.length === beforeCount) {
        sendJsonResponse(res, 404, { error: "Script tapılmadı" });
        return;
      }

      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord();
      appendAuditLog("SCRIPT_DELETED", `Script silindi (${targetId})`, "Dashboard");

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/keys") {
      const body = await parseRequestJsonBody(req);
      const scriptName = sanitizeText(body.scriptName, "Ümumi");
      const days = Math.max(0, Number(body.days || 0));

      const newKey = {
        id: generateUniqueId("key"),
        key: generateLicenseKeyString(),
        scriptName,
        days,
        hwid: sanitizeText(body.hwid, ""),
        hwidResetCount: 0,
        active: true,
        createdAt: new Date().toISOString()
      };

      APP_STATE.keys = [newKey, ...(APP_STATE.keys || [])];
      saveAppStateToDisk();
      appendAuditLog("KEY_CREATED", `Key yaradıldı (${newKey.key})`, "Dashboard");

      sendJsonResponse(res, 201, { ok: true, key: newKey });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/keys/")) {
      const keyId = sanitizeText(pathname.replace("/api/keys/", ""), "");
      APP_STATE.keys = (APP_STATE.keys || []).filter((k) => k && k.id !== keyId);
      saveAppStateToDisk();
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "PUT" && pathname === "/api/design") {
      const body = await parseRequestJsonBody(req);
      APP_STATE.panelDesign = normalizePanelDesign(body);
      saveAppStateToDisk();
      appendAuditLog("DESIGN_UPDATED", "Panel dizaynı yeniləndi", "Dashboard");

      sendJsonResponse(res, 200, { ok: true, panelDesign: APP_STATE.panelDesign });
      return;
    }

    if (method === "POST" && pathname === "/api/access") {
      const body = await parseRequestJsonBody(req);
      const listType = sanitizeText(body.listType, "whitelist") === "blacklist" ? "blacklist" : "whitelist";
      const val = sanitizeText(body.value, "");

      if (!val) {
        sendJsonResponse(res, 400, { error: "Dəyər daxil edilməlidir" });
        return;
      }

      let generatedKeyValue = "";
      if (listType === "whitelist") {
        generatedKeyValue = generateLicenseKeyString();
        const autoKeyRecord = {
          id: generateUniqueId("key"),
          key: generatedKeyValue,
          owner: val,
          scriptName: (APP_STATE.scripts[0] && APP_STATE.scripts[0].name) || "Ümumi",
          days: 0,
          hwid: "",
          hwidResetCount: 0,
          active: true,
          createdAt: new Date().toISOString()
        };
        APP_STATE.keys = [autoKeyRecord, ...(APP_STATE.keys || [])];
      } else {
        APP_STATE.whitelist = (APP_STATE.whitelist || []).filter(
          (item) => item && normalizeAccessValue(item.value) !== normalizeAccessValue(val)
        );
        APP_STATE.keys = (APP_STATE.keys || []).map((k) => {
          if (k && normalizeAccessValue(k.owner) === normalizeAccessValue(val)) {
            return { ...k, active: false };
          }
          return k;
        });
      }

      const entry = {
        id: generateUniqueId("acc"),
        value: val,
        generatedKey: generatedKeyValue,
        createdAt: new Date().toISOString()
      };

      APP_STATE[listType] = [entry, ...(APP_STATE[listType] || [])];
      saveAppStateToDisk();
      appendAuditLog(
        "ACCESS_ADDED",
        `${listType.toUpperCase()} əlavə edildi: ${val}${generatedKeyValue ? ` | Key: ${generatedKeyValue}` : ""}`,
        "Dashboard"
      );

      sendJsonResponse(res, 201, { ok: true, entry, generatedKey: generatedKeyValue });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/access/")) {
      const parts = pathname.replace("/api/access/", "").split("/");
      const listType = parts[0] === "blacklist" ? "blacklist" : "whitelist";
      const entryId = sanitizeText(parts[1] || "", "");
      const targetEntry = (APP_STATE[listType] || []).find((item) => item && item.id === entryId);

      APP_STATE[listType] = (APP_STATE[listType] || []).filter((item) => item && item.id !== entryId);

      if (listType === "whitelist" && targetEntry && targetEntry.value) {
        const targetNorm = normalizeAccessValue(targetEntry.value);
        const stillWhitelisted = (APP_STATE.whitelist || []).some(
          (w) => w && normalizeAccessValue(w.value) === targetNorm
        );
        if (!stillWhitelisted) {
          APP_STATE.keys = (APP_STATE.keys || []).filter(
            (k) => k && normalizeAccessValue(k.owner) !== targetNorm && sanitizeText(k.key, "") !== sanitizeText(targetEntry.generatedKey, "")
          );
        }
      }

      saveAppStateToDisk();
      appendAuditLog(
        "ACCESS_REMOVED",
        `${listType.toUpperCase()} silindi: ${targetEntry ? targetEntry.value : entryId}`,
        "Dashboard"
      );
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/script/verify") {
      const body = await parseRequestJsonBody(req);
      const providedKey = sanitizeText(body.key, "");
      const providedHwid = sanitizeText(body.hwid, "");
      const providedUser = sanitizeText(body.user, "");
      const scriptIdOrName = sanitizeText(body.scriptId || body.scriptName, "");

      const matchedKey = findKeyByValueOrUser(providedKey || providedUser || providedHwid);
      const identityCheck = providedUser || (matchedKey && matchedKey.owner) || providedHwid;

      if (isEntryBlacklisted(identityCheck, matchedKey)) {
        sendJsonResponse(res, 403, {
          allowed: false,
          action: "kick",
          reason: "Blacklist-dəsiniz — Kick edildi"
        });
        return;
      }

      if (!matchedKey || matchedKey.active === false) {
        sendJsonResponse(res, 403, {
          allowed: false,
          action: "kick",
          reason: "Aktiv Key tapılmadı — Kick edildi"
        });
        return;
      }

      const whitelisted = isEntryWhitelisted(identityCheck, matchedKey);
      if (!whitelisted && (APP_STATE.whitelist || []).length > 0) {
        sendJsonResponse(res, 403, {
          allowed: false,
          action: "kick",
          reason: "Whitelist-də deyilsiniz — Kick edildi"
        });
        return;
      }

      const effectiveHwid = extractDeviceHwidFromRequest(req, reqUrl, providedHwid);
      if (effectiveHwid) {
        const currentBound = sanitizeText(matchedKey.hwid, "");
        if (!currentBound || isLegacyVolatileHashHwid(currentBound)) {
          matchedKey.hwid = effectiveHwid;
          saveAppStateToDisk();
          appendAuditLog("HWID_BOUND", `Key ${matchedKey.key} ilk cihaza bağlandı: ${effectiveHwid}`, "HWID-Lock");
        } else if (currentBound.toLowerCase() !== effectiveHwid.toLowerCase()) {
          appendAuditLog("HWID_KICK", `Başqa cihazdan giriş cəhdi bloklandı (${matchedKey.key})`, "HWID-Lock");
          sendJsonResponse(res, 403, {
            allowed: false,
            action: "kick",
            reason: "Bu key artıq başqa telefonda/cihazda aktivdir — Kick edildi"
          });
          return;
        }
      }

      const targetScript =
        (APP_STATE.scripts || []).find(
          (s) =>
            s &&
            (s.id === scriptIdOrName ||
              sanitizeText(s.name, "").toLowerCase() === scriptIdOrName.toLowerCase() ||
              sanitizeText(s.name, "").toLowerCase() === sanitizeText(matchedKey.scriptName, "").toLowerCase())
        ) || (APP_STATE.scripts || [])[0] || null;

      if (!targetScript) {
        sendJsonResponse(res, 404, { allowed: false, action: "kick", reason: "Script tapılmadı" });
        return;
      }

      const rawScriptCode = targetScript.sourceType === "file"
        ? (targetScript.scriptContent || "")
        : `loadstring(game:HttpGet("${targetScript.scriptUrl || ""}"))()`;

      const scriptPayload = wrapScriptWithAntiLeakProtection(rawScriptCode, matchedKey.key, targetScript.name, matchedKey.hwid || "", targetScript.id);

      sendJsonResponse(res, 200, {
        allowed: true,
        action: "allow",
        key: matchedKey.key,
        hwid: matchedKey.hwid || "",
        scriptName: targetScript.name,
        script: scriptPayload
      });
      return;
    }

    if (method === "GET" && pathname.startsWith("/raw/")) {
      const scId = sanitizeText(pathname.replace("/raw/", ""), "");
      const found = (APP_STATE.scripts || []).find((s) => s && s.id === scId);
      if (!found) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload("Script tapılmadı — Kick edildi"));
        return;
      }

      const providedKeyQuery = sanitizeText(reqUrl.searchParams.get("key") || req.headers["x-sado-key"], "");
      const matchedKey = providedKeyQuery ? findKeyByValueOrUser(providedKeyQuery) : null;
      const identityCheck = (matchedKey && matchedKey.owner) || providedKeyQuery;

      if (!matchedKey || matchedKey.active === false || isEntryBlacklisted(identityCheck, matchedKey)) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload("Etibarlı Key olmadan scriptə icazə verilmir — Kick edildi"));
        return;
      }

      const whitelisted = isEntryWhitelisted(identityCheck, matchedKey);
      if (!whitelisted && (APP_STATE.whitelist || []).length > 0) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload("Whitelist-də deyilsiniz — Kick edildi"));
        return;
      }

      const incomingDeviceHwid = extractDeviceHwidFromRequest(req, reqUrl, "");
      const boundHwid = sanitizeText(matchedKey.hwid, "");

      if (incomingDeviceHwid) {
        if (!boundHwid || isLegacyVolatileHashHwid(boundHwid)) {
          matchedKey.hwid = incomingDeviceHwid;
          saveAppStateToDisk();
          appendAuditLog("HWID_BOUND", `Key ${matchedKey.key} ilk cihaza bağlandı: ${incomingDeviceHwid}`, "HWID-Lock");
        } else if (boundHwid.toLowerCase() !== incomingDeviceHwid.toLowerCase()) {
          appendAuditLog("HWID_KICK", `Başqa cihazdan giriş cəhdi bloklandı (${matchedKey.key})`, "HWID-Lock");
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(buildDeviceKickLuaPayload("Bu key artıq başqa telefonda/cihazda aktivdir — Kick edildi"));
          return;
        }
      } else if (isLegacyVolatileHashHwid(boundHwid)) {
        matchedKey.hwid = "";
        saveAppStateToDisk();
      }

      const effectiveLockedHwid = isLegacyVolatileHashHwid(matchedKey.hwid) ? "" : sanitizeText(matchedKey.hwid, "");
      const cleanUrl = sanitizeText(found.scriptUrl, "");
      const rawCode = found.sourceType === "file"
        ? String(found.scriptContent || "").trim()
        : `pcall(function() game:HttpGet("${cleanUrl}") end)`;

      const protectedCode = wrapScriptWithAntiLeakProtection(rawCode, matchedKey.key, found.name, effectiveLockedHwid, found.id);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(protectedCode);
      return;
    }

    sendJsonResponse(res, 404, { error: "Marşrut tapılmadı" });
  } catch (err) {
    console.error("[SADO PROTECT] HTTP sorğu xətası:", err.message);
    sendJsonResponse(res, 500, {
      error: sanitizeText(err && err.message, "Daxili server xətası")
    });
  }
};

const HTTP_SERVER = http.createServer((req, res) => {
  handleHttpRequest(req, res);
});

HTTP_SERVER.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[SADO PROTECT] Server işləyir: http://${SERVER_HOST}:${SERVER_PORT}`);
  startDiscordBotRuntime();
  startRenderKeepAliveLoop();
});
