const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE_PATH = path.join(DATA_DIR, "sado_protect_state.json");
const DISCORD_INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot";

const DEFAULT_PANEL_DESIGN = {
  title: "SADO PROTECT • Lisenziya & Script Paneli",
  description:
    "Aşağıdakı düymələrdən istifadə edərək lisenziya açarınızı aktivləşdirə, HWID sıfırlaya və ya scriptinizi əldə edə bilərsiniz.",
  colorHex: "#5865F2",
  footerText: "SADO PROTECT • Premium Təhlükəsizlik Sistemi",
  thumbnailUrl: "",
  imageUrl: "",
  buttons: [
    {
      id: "btn_get_script",
      label: "Get Script",
      style: 3,
      emoji: "📜",
      responseText: "Whitelist yoxlanılır və script hazırlanır..."
    },
    {
      id: "btn_redeem_key",
      label: "Key Aktiv Et",
      style: 1,
      emoji: "🔑",
      responseText: "Zəhmət olmasa /key komandası ilə və ya paneldən açarınızı daxil edin."
    },
    {
      id: "btn_reset_hwid",
      label: "Reset HWID",
      style: 2,
      emoji: "🔄",
      responseText: "HWID sıfırlama sorğunuz qəbul edildi."
    },
    {
      id: "btn_my_stats",
      label: "Statistikam",
      style: 2,
      emoji: "📊",
      responseText: "Aktiv abunəlik və cihaz statusunuz yoxlanılır..."
    }
  ]
};

const ensureStorageDirectory = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (_err) {}
};

const sanitizeText = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeSnowflakeId = (value) => {
  const str = String(value || "").trim();
  return /^\d{15,22}$/.test(str) ? str : "";
};

const normalizeColorHex = (value) => {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
  return "#5865F2";
};

const hexColorToInt = (hexStr) => {
  const clean = normalizeColorHex(hexStr).replace("#", "");
  const parsed = parseInt(clean, 16);
  return Number.isNaN(parsed) ? 5793266 : parsed;
};

const normalizePanelDesign = (rawDesign) => {
  const src = rawDesign && typeof rawDesign === "object" ? rawDesign : {};
  const rawButtons = Array.isArray(src.buttons) ? src.buttons : DEFAULT_PANEL_DESIGN.buttons;
  const normalizedButtons = rawButtons.slice(0, 5).map((btn, idx) => {
    const safeBtn = btn && typeof btn === "object" ? btn : {};
    const styleNum = Number(safeBtn.style);
    const validStyle = [1, 2, 3, 4].includes(styleNum) ? styleNum : 1;
    return {
      id: sanitizeText(safeBtn.id, `custom_btn_${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60),
      label: sanitizeText(safeBtn.label, `Düymə ${idx + 1}`).slice(0, 40),
      style: validStyle,
      emoji: sanitizeText(safeBtn.emoji, "").slice(0, 12),
      responseText: sanitizeText(safeBtn.responseText, "Əməliyyat icra edildi.").slice(0, 400)
    };
  });

  return {
    title: sanitizeText(src.title, DEFAULT_PANEL_DESIGN.title).slice(0, 180),
    description: sanitizeText(src.description, DEFAULT_PANEL_DESIGN.description).slice(0, 2000),
    colorHex: normalizeColorHex(src.colorHex),
    footerText: sanitizeText(src.footerText, DEFAULT_PANEL_DESIGN.footerText).slice(0, 150),
    thumbnailUrl: sanitizeText(src.thumbnailUrl, "").slice(0, 500),
    imageUrl: sanitizeText(src.imageUrl, "").slice(0, 500),
    buttons: normalizedButtons.length > 0 ? normalizedButtons : [...DEFAULT_PANEL_DESIGN.buttons]
  };
};

const loadInitialAppState = () => {
  ensureStorageDirectory();
  const baseState = {
    guildId: sanitizeSnowflakeId(process.env.DEFAULT_GUILD_ID || ""),
    guildName: "",
    panelChannelId: sanitizeSnowflakeId(process.env.DEFAULT_PANEL_CHANNEL_ID || ""),
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    tenants: {},
    panelDesign: { ...DEFAULT_PANEL_DESIGN, buttons: [...DEFAULT_PANEL_DESIGN.buttons] },
    auditLogs: [],
    updatedAt: new Date().toISOString()
  };

  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = fs.readFileSync(STATE_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          ...baseState,
          ...parsed,
          scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
          keys: Array.isArray(parsed.keys) ? parsed.keys : [],
          whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
          blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [],
          tenants: parsed.tenants && typeof parsed.tenants === "object" ? parsed.tenants : {},
          panelDesign: normalizePanelDesign(parsed.panelDesign),
          auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : []
        };
      }
    }
  } catch (_err) {}

  return baseState;
};

const APP_STATE = loadInitialAppState();

const generateUniqueId = (prefix = "id") => {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}_${Date.now().toString(36).toUpperCase()}_${rand}`;
};

const generateLicenseKeyString = () => {
  const partA = crypto.randomBytes(2).toString("hex").toUpperCase();
  const partB = crypto.randomBytes(2).toString("hex").toUpperCase();
  const partC = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `SADO-${partA}-${partB}-${partC}`;
};

const normalizeAccessValue = (value) =>
  String(value || "")
    .trim()
    .replace(/^<@!?(\d+)>$/, "$1")
    .replace(/^@+/, "")
    .toLowerCase();

const formatDiscordUserDisplay = (userObj, fallbackId = "") => {
  if (!userObj || typeof userObj !== "object") {
    return fallbackId ? `ID: ${fallbackId}` : "Naməlum İstifadəçi";
  }
  const uid = sanitizeSnowflakeId(userObj.id || fallbackId);
  const username = sanitizeText(userObj.username, "");
  const globalName = sanitizeText(userObj.global_name, "");
  const discrim = sanitizeText(userObj.discriminator, "");
  const tag = username
    ? discrim && discrim !== "0"
      ? `${username}#${discrim}`
      : `@${username}`
    : "";

  if (globalName && tag && globalName.toLowerCase() !== username.toLowerCase()) {
    return uid ? `${globalName} (${tag} • ${uid})` : `${globalName} (${tag})`;
  }
  if (tag) {
    return uid ? `${tag} (${uid})` : tag;
  }
  return uid ? `ID: ${uid}` : "Naməlum İstifadəçi";
};

const collectUserMatchTokens = (rawStr, extraUserObj = null) => {
  const tokens = new Set();
  const addToken = (val) => {
    const clean = normalizeAccessValue(val);
    if (clean) tokens.add(clean);
  };

  const str = String(rawStr || "").trim();
  if (str) {
    addToken(str);
    const idMatches = str.match(/\d{15,22}/g);
    if (idMatches) {
      idMatches.forEach((idPart) => addToken(idPart));
    }
    const atMatches = str.match(/@([a-zA-Z0-9_.]{2,32})/g);
    if (atMatches) {
      atMatches.forEach((atPart) => addToken(atPart));
    }
    const beforeParen = str.split("(")[0].trim();
    if (beforeParen) addToken(beforeParen);
  }

  if (extraUserObj && typeof extraUserObj === "object") {
    addToken(extraUserObj.id);
    addToken(extraUserObj.userId);
    addToken(extraUserObj.ownerId);
    addToken(extraUserObj.username);
    addToken(extraUserObj.global_name);
    addToken(extraUserObj.owner);
    addToken(extraUserObj.value);
    addToken(extraUserObj.key);
    addToken(extraUserObj.generatedKey);
  }

  return tokens;
};

const buildShortLoaderString = (rawEndpointUrl) => {
  const cleanUrl = sanitizeText(rawEndpointUrl, "");
  return `local u="${cleanUrl}" loadstring(game:HttpGet(u))()`;
};

const buildDeviceKickLuaPayload = (reasonText = "Cihaz uyğunsuzluğu səbəbilə giriş bloklandı") => {
  const safeReason = String(reasonText || "Giriş bloklandı").replace(/["\\\r\n]/g, " ");
  return [
    `local p=game:GetService("Players").LocalPlayer`,
    `if p then pcall(function() p:Kick("[SADO PROTECT] ${safeReason}") end) end`
  ].join("\n");
};

const isRobloxExecutorRequest = (req) => {
  const headers = (req && req.headers) || {};
  const ua = String(headers["user-agent"] || "").toLowerCase();
  const accept = String(headers["accept"] || "").toLowerCase();
  const secFetchMode = String(headers["sec-fetch-mode"] || "").toLowerCase();
  const secFetchDest = String(headers["sec-fetch-dest"] || "").toLowerCase();

  if (secFetchMode === "navigate" || secFetchDest === "document") {
    return false;
  }
  if (accept.includes("text/html") && !ua.includes("roblox")) {
    return false;
  }
  if (
    (ua.includes("mozilla/5.0") ||
      ua.includes("chrome/") ||
      ua.includes("safari/") ||
      ua.includes("firefox/") ||
      ua.includes("edg/")) &&
    !ua.includes("roblox")
  ) {
    return false;
  }
  if (!ua || ua.includes("curl/") || ua.includes("wget/") || ua.includes("python-requests") || ua.includes("postman")) {
    return false;
  }
  return true;
};

const buildAntiLeakBlockedLua = () => {
  return [
    `-- [SADO PROTECT] Anti-Leak Protection Active`,
    `local p=game:GetService("Players").LocalPlayer`,
    `if p then pcall(function() p:Kick("[SADO PROTECT] Sızdırma cəhdi bloklandı!") end) end`
  ].join("\n");
};

const wrapScriptWithAntiLeakProtection = (rawLuaCode, boundHwid = "", rawEndpointUrl = "", activeKeyStr = "") => {
  const cleanCode = String(rawLuaCode || "");
  const safeBoundHwid = String(boundHwid || "").replace(/["\\\r\n]/g, "");
  const safeEndpoint = String(rawEndpointUrl || "").replace(/["\\\r\n]/g, "");
  const safeKey = String(activeKeyStr || "").replace(/["\\\r\n]/g, "");

  const xorKey = (crypto.randomBytes(1)[0] % 200) + 27;
  const rawBytes = Buffer.from(cleanCode, "utf8");
  const encodedNums = new Array(rawBytes.length);
  for (let i = 0; i < rawBytes.length; i += 1) {
    encodedNums[i] = rawBytes[i] ^ ((xorKey + (i % 31)) & 255);
  }
  const encodedArrayLiteral = `{${encodedNums.join(",")}}`;

  return [
    `local _P=game:GetService("Players")`,
    `local _R=game:GetService("RbxAnalyticsService")`,
    `local _H=game:GetService("HttpService")`,
    `local function _gid()`,
    `  local s,r=pcall(function() return _R:GetClientId() end)`,
    `  if s and type(r)=="string" and #r>3 then return r end`,
    `  local s2,r2=pcall(function() if gethwid then return gethwid() end end)`,
    `  if s2 and type(r2)=="string" and #r2>3 then return r2 end`,
    `  local lp=_P.LocalPlayer`,
    `  return lp and ("UID_"..tostring(lp.UserId)) or "UNKNOWN"`,
    `end`,
    `local function _kick(m)`,
    `  local lp=_P.LocalPlayer`,
    `  if lp then pcall(function() lp:Kick("[SADO PROTECT] "..tostring(m)) end) end`,
    `end`,
    `local _bh="${safeBoundHwid}"`,
    `local _ch=_gid()`,
    `if _bh~="" and _ch~="UNKNOWN" and _bh~=_ch then`,
    `  _kick("Bu açar başqa cihaza bağlıdır — Kick edildi")`,
    `  return`,
    `end`,
    `if _bh=="" and "${safeEndpoint}"~="" and _ch~="UNKNOWN" then`,
    `  pcall(function()`,
    `    local sep=string.find("${safeEndpoint}","?",1,true) and "&" or "?"`,
    `    game:HttpGet("${safeEndpoint}"..sep.."key=".._H:UrlEncode("${safeKey}").."&hwid=".._H:UrlEncode(_ch))`,
    `  end)`,
    `end`,
    `local function _bxor(a,b)`,
    `  if bit32 and bit32.bxor then return bit32.bxor(a,b) end`,
    `  local res,bit=0,1`,
    `  while a>0 or b>0 do`,
    `    local aa,bb=a%2,b%2`,
    `    if aa~=bb then res=res+bit end`,
    `    a=(a-aa)/2`,
    `    b=(b-bb)/2`,
    `    bit=bit*2`,
    `  end`,
    `  return res`,
    `end`,
    `local _enc=${encodedArrayLiteral}`,
    `local _k=${xorKey}`,
    `local _out={}`,
    `for _i=1,#_enc do`,
    `  _out[_i]=string.char(_bxor(_enc[_i],(_k+((_i-1)%31))%256))`,
    `end`,
    `local _src=table.concat(_out)`,
    `local _ld=loadstring or load`,
    `local _fn=_ld and _ld(_src)`,
    `if type(_fn)=="function" then`,
    `  task.spawn(_fn)`,
    `end`
  ].join("\n");
};

const ensureTenantStore = () => {
  if (!APP_STATE.tenants || typeof APP_STATE.tenants !== "object") {
    APP_STATE.tenants = {};
  }
  return APP_STATE.tenants;
};

const getTenantRecordByGuildId = (guildIdInput) => {
  const cleanGid = sanitizeSnowflakeId(guildIdInput);
  if (!cleanGid) return null;
  const tenants = ensureTenantStore();
  if (!tenants[cleanGid]) {
    const isPrimaryGuild = sanitizeSnowflakeId(APP_STATE.guildId) === cleanGid;
    const primaryScripts = Array.isArray(APP_STATE.scripts) ? APP_STATE.scripts : [];
    const belongsToPrimary =
      isPrimaryGuild &&
      primaryScripts.some((sc) => sanitizeSnowflakeId(sc && sc.guildId) === cleanGid);
    tenants[cleanGid] = {
      guildId: cleanGid,
      guildName: isPrimaryGuild ? sanitizeText(APP_STATE.guildName, "") : "",
      panelChannelId: isPrimaryGuild ? sanitizeSnowflakeId(APP_STATE.panelChannelId) : "",
      scripts: belongsToPrimary ? [...primaryScripts] : [],
      keys: isPrimaryGuild ? [...(APP_STATE.keys || [])] : [],
      whitelist: isPrimaryGuild ? [...(APP_STATE.whitelist || [])] : [],
      blacklist: isPrimaryGuild ? [...(APP_STATE.blacklist || [])] : [],
      panelDesign: isPrimaryGuild
        ? normalizePanelDesign(APP_STATE.panelDesign)
        : normalizePanelDesign(DEFAULT_PANEL_DESIGN),
      auditLogs: isPrimaryGuild ? [...(APP_STATE.auditLogs || [])] : []
    };
  }
  return tenants[cleanGid];
};

const syncTenantIntoGlobalIfPrimary = (tenantRec) => {
  if (!tenantRec) return;
  const primaryGid = sanitizeSnowflakeId(APP_STATE.guildId);
  if (!primaryGid || primaryGid === tenantRec.guildId) {
    APP_STATE.guildId = tenantRec.guildId;
    APP_STATE.guildName = tenantRec.guildName;
    APP_STATE.panelChannelId = tenantRec.panelChannelId;
    APP_STATE.scripts = tenantRec.scripts;
    APP_STATE.keys = tenantRec.keys;
    APP_STATE.whitelist = tenantRec.whitelist;
    APP_STATE.blacklist = tenantRec.blacklist;
    APP_STATE.panelDesign = tenantRec.panelDesign;
    APP_STATE.auditLogs = tenantRec.auditLogs;
  }
};

const resolveRequestGuildId = (req, reqUrl = null, bodyObj = null) => {
  const fromBody = bodyObj && sanitizeSnowflakeId(bodyObj.guildId);
  if (fromBody) return fromBody;
  const fromQuery = reqUrl && reqUrl.searchParams && sanitizeSnowflakeId(reqUrl.searchParams.get("guildId"));
  if (fromQuery) return fromQuery;
  const fromHeader = req && req.headers && sanitizeSnowflakeId(req.headers["x-guild-id"]);
  if (fromHeader) return fromHeader;
  return "";
};

const saveAppStateToDisk = () => {
  try {
    ensureStorageDirectory();
    APP_STATE.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(APP_STATE, null, 2), "utf8");
  } catch (_err) {}
};

const appendAuditLog = (actionType, summaryText, actorLabel = "Sistem", guildIdInput = "") => {
  const entry = {
    id: generateUniqueId("log"),
    action: sanitizeText(actionType, "INFO"),
    summary: sanitizeText(summaryText, ""),
    actor: sanitizeText(actorLabel, "Sistem"),
    createdAt: new Date().toISOString()
  };

  const tenant = getTenantRecordByGuildId(guildIdInput);
  if (tenant) {
    tenant.auditLogs = [entry, ...(tenant.auditLogs || [])].slice(0, 60);
    syncTenantIntoGlobalIfPrimary(tenant);
  } else {
    APP_STATE.auditLogs = [entry, ...(APP_STATE.auditLogs || [])].slice(0, 60);
  }
  saveAppStateToDisk();
};

const BOT_RUNTIME = {
  connected: false,
  connecting: false,
  botUserId: "",
  botUsername: "",
  lastError: "",
  lastConnectedAt: "",
  ws: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  keepAliveTimer: null,
  seq: null,
  sessionId: ""
};

const resolveDiscordBotToken = () => {
  const candidates = [
    process.env.DISCORD_BOT_TOKEN,
    process.env.BOT_TOKEN,
    process.env.DISCORD_TOKEN,
    process.env.TOKEN
  ];
  for (const item of candidates) {
    const clean = sanitizeText(item, "").replace(/^Bot\s+/i, "");
    if (clean.length > 20) return clean;
  }
  return "";
};

const callDiscordRestApi = (apiPath, method = "GET", bodyPayload = null, tokenOverride = "") =>
  new Promise((resolve) => {
    const token = tokenOverride || resolveDiscordBotToken();
    if (!token) {
      resolve({ ok: false, status: 401, error: "Render Environment-də DISCORD_BOT_TOKEN tapılmadı" });
      return;
    }

    const serializedBody = bodyPayload ? JSON.stringify(bodyPayload) : "";
    const headers = {
      Authorization: `Bot ${token}`,
      "User-Agent": "SadoProtectBot (https://sadoprotect.local, 1.0)"
    };
    if (serializedBody) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(serializedBody);
    }

    const req = https.request(
      {
        hostname: "discord.com",
        port: 443,
        path: `/api/v10${apiPath}`,
        method,
        headers
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => {
          chunks += d;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = chunks ? JSON.parse(chunks) : {};
          } catch (_err) {
            parsed = { raw: chunks };
          }
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({
            ok,
            status: res.statusCode,
            data: parsed,
            error: ok
              ? ""
              : sanitizeText(parsed && parsed.message, `Discord API xətası (${res.statusCode})`)
          });
        });
      }
    );

    req.on("error", (err) => {
      resolve({ ok: false, status: 0, error: err.message || "Şəbəkə xətası" });
    });

    if (serializedBody) {
      req.write(serializedBody);
    }
    req.end();
  });

const resolveGuildDisplayName = async (guildId, fallbackName = "") => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return "";
  const guildRes = await callDiscordRestApi(`/guilds/${cleanId}`, "GET");
  if (guildRes.ok && guildRes.data && guildRes.data.name) {
    return sanitizeText(guildRes.data.name, fallbackName || "Bağlı Sunucu");
  }
  return sanitizeText(fallbackName, "Bağlı Sunucu");
};

const buildSlashCommandsPayloadForGuild = (guildIdInput = "") => {
  const scriptOption = {
    name: "script",
    description: "Panel açılacaq mövcud scripti seçin",
    type: 3,
    required: false,
    autocomplete: true
  };

  const whitelistScriptOption = {
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
      description: "Sunucudakı istifadəçini seçilən script üzrə Whitelist-dən çıxarır və girişini bağlayır",
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

const buildSlashCommandsPayload = () => buildSlashCommandsPayloadForGuild(APP_STATE.guildId);

const syncSlashCommandsWithDiscord = async (specificGuildId = "") => {
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

  await callDiscordRestApi(`/applications/${appId}/commands`, "PUT", buildSlashCommandsPayload(), token);

  const guildIdsToSync = new Set();
  const primaryGid = sanitizeSnowflakeId(APP_STATE.guildId);
  const explicitGid = sanitizeSnowflakeId(specificGuildId);
  if (primaryGid) guildIdsToSync.add(primaryGid);
  if (explicitGid) guildIdsToSync.add(explicitGid);
  for (const tid of Object.keys(ensureTenantStore())) {
    const cleanTid = sanitizeSnowflakeId(tid);
    if (cleanTid) guildIdsToSync.add(cleanTid);
  }

  for (const gId of guildIdsToSync) {
    const guildPayload = buildSlashCommandsPayloadForGuild(gId);
    await callDiscordRestApi(`/applications/${appId}/guilds/${gId}/commands`, "PUT", guildPayload, token);
  }
};

const buildDiscordPanelMessagePayload = (selectedScriptName = "", guildIdInput = "") => {
  const cleanGuildId = sanitizeSnowflakeId(guildIdInput);
  const tenant = cleanGuildId ? getTenantRecordByGuildId(cleanGuildId) : null;
  const design = normalizePanelDesign(tenant ? tenant.panelDesign : DEFAULT_PANEL_DESIGN);
  const scriptsPool = tenant ? tenant.scripts || [] : [];
  const keysPool = tenant ? tenant.keys || [] : [];
  const whitelistPool = tenant ? tenant.whitelist || [] : [];
  const blacklistPool = tenant ? tenant.blacklist || [] : [];
  const activeGuildName = tenant ? tenant.guildName : "";
  const cleanQuery = sanitizeText(selectedScriptName, "");

  const matchedScript = cleanQuery
    ? scriptsPool.find((s) => sanitizeText(s && s.name, "").toLowerCase() === cleanQuery.toLowerCase()) || null
    : scriptsPool[0] || null;

  const fields = [];

  if (activeGuildName) {
    fields.push({
      name: "🏰 Bağlanan Sunucu",
      value: `**${activeGuildName}**`,
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
      value:
        matchedScript.sourceType === "file"
          ? `Fayl (${sanitizeText(matchedScript.fileName, "script.lua")})`
          : sanitizeText(matchedScript.scriptUrl, "Daxili Script"),
      inline: true
    });
  } else {
    fields.push({
      name: "📜 Aktiv Script Sayı",
      value: `${scriptsPool.length} ədəd`,
      inline: true
    });
  }

  fields.push({
    name: "🔑 Aktiv Keylər",
    value: `${keysPool.length} ədəd`,
    inline: true
  });

  fields.push({
    name: "🛡️ Whitelist / Blacklist",
    value: `${whitelistPool.length} / ${blacklistPool.length}`,
    inline: true
  });

  if (matchedScript && matchedScript.description) {
    fields.push({
      name: "📝 Script Haqqında",
      value: matchedScript.description.slice(0, 400),
      inline: false
    });
  }

  const embed = {
    title: matchedScript ? `${design.title} — ${matchedScript.name}` : design.title,
    description: design.description,
    color: hexColorToInt(design.colorHex),
    fields,
    footer: {
      text: design.footerText
    },
    timestamp: new Date().toISOString()
  };

  if (design.thumbnailUrl && /^https?:\/\//i.test(design.thumbnailUrl)) {
    embed.thumbnail = { url: design.thumbnailUrl };
  }
  if (design.imageUrl && /^https?:\/\//i.test(design.imageUrl)) {
    embed.image = { url: design.imageUrl };
  }

  const actionButtons = design.buttons.slice(0, 5).map((btn, index) => {
    const baseId = sanitizeText(btn.id, `btn_${index + 1}`);
    const encodedCustomId = matchedScript
      ? `sado_panel:${baseId}:${matchedScript.id}`
      : `sado_panel:${baseId}:general`;

    const component = {
      type: 2,
      style: [1, 2, 3, 4].includes(Number(btn.style)) ? Number(btn.style) : 1,
      label: sanitizeText(btn.label, `Düymə ${index + 1}`).slice(0, 80),
      custom_id: encodedCustomId.slice(0, 100)
    };

    if (btn.emoji) {
      component.emoji = { name: btn.emoji };
    }

    return component;
  });

  return {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: actionButtons
      }
    ]
  };
};

const publishPanelToDiscordChannel = async (channelIdInput, scriptNameInput = "", guildIdInput = "") => {
  const tenant = getTenantRecordByGuildId(guildIdInput);
  const cleanChannelId = sanitizeSnowflakeId(
    channelIdInput || (tenant && tenant.panelChannelId) || APP_STATE.panelChannelId
  );
  if (!cleanChannelId) {
    return {
      ok: false,
      error: "Etibarlı Panel Kanal ID daxil edilməyib"
    };
  }

  const payload = buildDiscordPanelMessagePayload(scriptNameInput, guildIdInput);
  const sendRes = await callDiscordRestApi(`/channels/${cleanChannelId}/messages`, "POST", payload);
  if (!sendRes.ok) {
    return {
      ok: false,
      error: sendRes.error || "Panel kanala göndərilə bilmədi"
    };
  }

  if (tenant) {
    tenant.panelChannelId = cleanChannelId;
    syncTenantIntoGlobalIfPrimary(tenant);
  } else {
    APP_STATE.panelChannelId = cleanChannelId;
  }
  saveAppStateToDisk();
  appendAuditLog("PANEL_SENT", `Panel #${cleanChannelId} kanalına göndərildi`, "Dashboard", guildIdInput);

  return {
    ok: true,
    channelId: cleanChannelId,
    messageId: sendRes.data && sendRes.data.id ? sendRes.data.id : ""
  };
};

const respondToDiscordInteraction = async (interactionId, interactionToken, responseBody) => {
  return callDiscordRestApi(`/interactions/${interactionId}/${interactionToken}/callback`, "POST", responseBody);
};

const deferDiscordInteraction = async (interactionId, interactionToken, ephemeral = true) => {
  return respondToDiscordInteraction(interactionId, interactionToken, {
    type: 5,
    data: ephemeral ? { flags: 64 } : {}
  });
};

const editDeferredDiscordResponse = async (applicationId, interactionToken, messagePayload) => {
  const cleanAppId = sanitizeSnowflakeId(applicationId || BOT_RUNTIME.botUserId);
  if (!cleanAppId || !interactionToken) return { ok: false };
  return callDiscordRestApi(
    `/webhooks/${cleanAppId}/${interactionToken}/messages/@original`,
    "PATCH",
    messagePayload
  );
};

const handleDiscordInteractionCreate = async (interaction) => {
  if (!interaction || !interaction.id || !interaction.token) return;

  const appId = sanitizeSnowflakeId(interaction.application_id || BOT_RUNTIME.botUserId);
  const interactionGuildId = sanitizeSnowflakeId(interaction.guild_id || "");
  const tenantCtx = getTenantRecordByGuildId(interactionGuildId);
  const ctxScripts = tenantCtx ? tenantCtx.scripts : APP_STATE.scripts;
  const ctxKeys = tenantCtx ? tenantCtx.keys : APP_STATE.keys;
  const ctxWhitelist = tenantCtx ? tenantCtx.whitelist : APP_STATE.whitelist;
  const ctxBlacklist = tenantCtx ? tenantCtx.blacklist : APP_STATE.blacklist;
  const commitCtxState = () => {
    if (tenantCtx) {
      tenantCtx.scripts = ctxScripts;
      tenantCtx.keys = ctxKeys;
      tenantCtx.whitelist = ctxWhitelist;
      tenantCtx.blacklist = ctxBlacklist;
      syncTenantIntoGlobalIfPrimary(tenantCtx);
    }
    saveAppStateToDisk();
  };

  const interactionType = Number(interaction.type);

  if (interactionType === 2) {
    const cmdName = sanitizeText(interaction.data && interaction.data.name, "").toLowerCase();
    const rawOptions = Array.isArray(interaction.data && interaction.data.options)
      ? interaction.data.options
      : [];

    if (cmdName === "panel") {
      const scriptOpt = rawOptions.find((o) => o && o.name === "script");
      const chosenScriptName = sanitizeText(scriptOpt && scriptOpt.value, "");
      const panelPayload = buildDiscordPanelMessagePayload(chosenScriptName, interactionGuildId);

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: panelPayload
      });
      return;
    }

    if (cmdName === "whitelist") {
      await deferDiscordInteraction(interaction.id, interaction.token, true);
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
        (ctxScripts[0] && ctxScripts[0].name) || "Ümumi"
      );

      if (!targetUser) {
        await editDeferredDiscordResponse(appId, interaction.token, {
          content: "❌ Zəhmət olmasa sunucudan `user` seçin."
        });
        return;
      }

      let resolvedProfileLabel = resolvedUserObj
        ? formatDiscordUserDisplay(resolvedUserObj, targetUser)
        : targetUser;
      if (targetUserId && !resolvedUserObj) {
        const uRes = await callDiscordRestApi(`/users/${targetUserId}`, "GET");
        if (uRes.ok && uRes.data) {
          resolvedProfileLabel = formatDiscordUserDisplay(uRes.data, targetUserId);
        }
      }

      ctxBlacklist.splice(
        0,
        ctxBlacklist.length,
        ...ctxBlacklist.filter((b) => b && normalizeAccessValue(b.value) !== normalizeAccessValue(targetUser))
      );

      const generatedKeyValue = generateLicenseKeyString();
      const autoKeyRecord = {
        id: generateUniqueId("key"),
        key: generatedKeyValue,
        owner: resolvedProfileLabel,
        ownerId: targetUser,
        scriptName: chosenScriptName,
        guildId: interactionGuildId,
        days: 0,
        hwid: "",
        hwidResetCount: 0,
        active: true,
        createdAt: new Date().toISOString()
      };
      ctxKeys.unshift(autoKeyRecord);

      const existingWl = ctxWhitelist.find(
        (w) =>
          w &&
          normalizeAccessValue(w.value) === normalizeAccessValue(targetUser) &&
          normalizeAccessValue(w.scriptName) === normalizeAccessValue(chosenScriptName)
      );
      if (!existingWl) {
        ctxWhitelist.unshift({
          id: generateUniqueId("acc"),
          value: resolvedProfileLabel,
          userId: targetUser,
          scriptName: chosenScriptName,
          generatedKey: generatedKeyValue,
          createdAt: new Date().toISOString()
        });
      } else {
        existingWl.generatedKey = generatedKeyValue;
        existingWl.value = resolvedProfileLabel;
        existingWl.userId = targetUser;
        existingWl.scriptName = chosenScriptName;
      }

      commitCtxState();
      appendAuditLog(
        "WHITELIST_CMD",
        `/whitelist: ${resolvedProfileLabel} | Script: ${chosenScriptName} -> Key: ${generatedKeyValue}`,
        "Discord",
        interactionGuildId
      );

      await editDeferredDiscordResponse(appId, interaction.token, {
        embeds: [
          {
            title: "✅ Whitelist & Avtomatik Key Yaradıldı",
            color: 2278750,
            description: [
              `**İstifadəçi:** ${targetUserId ? `<@${targetUserId}> • ` : ""}${resolvedProfileLabel}`,
              `**Script:** \`${chosenScriptName}\``,
              `**Avtomatik Key:** \`${generatedKeyValue}\``,
              `Bu açar saytdakı **Keylər** bölməsinə əlavə edildi. İstifadəçi \`/panel\` üzərindən **Get Script** kliklədikdə bu açar ona avtomatik veriləcək.`
            ].join("\n"),
            footer: { text: "SADO PROTECT • Avto Lisenziya Sistemi" },
            timestamp: new Date().toISOString()
          }
        ]
      });
      return;
    }

    if (cmdName === "unwhitelist") {
      await deferDiscordInteraction(interaction.id, interaction.token, true);
      const userOpt = rawOptions.find((o) => o && o.name === "user");
      const scriptOpt = rawOptions.find((o) => o && o.name === "script");
      const resolvedUserObj =
        (userOpt &&
          userOpt.value &&
          interaction.data &&
          interaction.data.resolved &&
          interaction.data.resolved.users &&
          interaction.data.resolved.users[String(userOpt.value)]) ||
        null;
      const targetUserId = sanitizeSnowflakeId(userOpt && userOpt.value);
      const selectedScriptFilter = sanitizeText(scriptOpt && scriptOpt.value, "");

      if (!targetUserId) {
        await editDeferredDiscordResponse(appId, interaction.token, {
          content: "❌ Zəhmət olmasa sunucudan `user` seçin."
        });
        return;
      }

      let resolvedProfileLabel = resolvedUserObj
        ? formatDiscordUserDisplay(resolvedUserObj, targetUserId)
        : `ID: ${targetUserId}`;
      if (!resolvedUserObj) {
        const uRes = await callDiscordRestApi(`/users/${targetUserId}`, "GET");
        if (uRes.ok && uRes.data) {
          resolvedProfileLabel = formatDiscordUserDisplay(uRes.data, targetUserId);
        }
      }

      const targetTokens = collectUserMatchTokens(targetUserId, resolvedUserObj);

      const matchesTargetUser = (rawVal, extraObj) => {
        const entryTokens = collectUserMatchTokens(rawVal, extraObj);
        for (const tk of targetTokens) {
          if (entryTokens.has(tk)) return true;
        }
        return false;
      };

      const matchesSelectedScript = (entryScriptName) => {
        if (!selectedScriptFilter) return true;
        return normalizeAccessValue(entryScriptName) === normalizeAccessValue(selectedScriptFilter);
      };

      const beforeWlCount = ctxWhitelist.length;
      const filteredWl = ctxWhitelist.filter(
        (w) =>
          !(
            w &&
            matchesTargetUser(w.value, { owner: w.value, ownerId: w.userId || "" }) &&
            matchesSelectedScript(w.scriptName)
          )
      );
      ctxWhitelist.splice(0, ctxWhitelist.length, ...filteredWl);

      const beforeKeysCount = ctxKeys.length;
      const filteredKeys = ctxKeys.filter(
        (k) => !(k && matchesTargetUser(k.owner, k) && matchesSelectedScript(k.scriptName))
      );
      ctxKeys.splice(0, ctxKeys.length, ...filteredKeys);

      const removedWlCount = beforeWlCount - ctxWhitelist.length;
      const removedKeysCount = beforeKeysCount - ctxKeys.length;

      commitCtxState();
      appendAuditLog(
        "UNWHITELIST_CMD",
        `/unwhitelist: ${resolvedProfileLabel}${
          selectedScriptFilter ? ` | Script: ${selectedScriptFilter}` : ""
        } (Whitelist: -${removedWlCount}, Key: -${removedKeysCount})`,
        "Discord",
        interactionGuildId
      );

      await editDeferredDiscordResponse(appId, interaction.token, {
        embeds: [
          {
            title: "🚫 Whitelist-dən Çıxarıldı",
            color: 15548997,
            description: [
              `**İstifadəçi:** <@${targetUserId}> • ${resolvedProfileLabel}`,
              selectedScriptFilter ? `**Script:** \`${selectedScriptFilter}\`` : "**Script:** Bütün scriptlər",
              `**Silinən Whitelist qeydi:** ${removedWlCount} ədəd`,
              `**Ləğv edilən Key:** ${removedKeysCount} ədəd`,
              selectedScriptFilter
                ? `İstifadəçinin \`${selectedScriptFilter}\` scriptinə girişi bağlandı.`
                : "İstifadəçinin scriptlərə girişi bağlandı."
            ].join("\n"),
            footer: { text: "SADO PROTECT • Giriş Nəzarəti" },
            timestamp: new Date().toISOString()
          }
        ]
      });
      return;
    }

    if (cmdName === "scripts") {
      const listText =
        ctxScripts.length > 0
          ? ctxScripts
              .map(
                (s, idx) =>
                  `**${idx + 1}. ${s.name}** — ${
                    s.sourceType === "file"
                      ? `Fayl (${sanitizeText(s.fileName, "script.lua")})`
                      : sanitizeText(s.scriptUrl, "Daxili")
                  }`
              )
              .join("\n")
          : "Hələ heç bir script əlavə edilməyib.";

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          embeds: [
            {
              title: "📜 SADO PROTECT • Aktiv Scriptlər",
              description: listText,
              color: hexColorToInt((tenantCtx ? tenantCtx.panelDesign : APP_STATE.panelDesign).colorHex),
              footer: { text: `Cəmi ${ctxScripts.length} script` }
            }
          ],
          flags: 64
        }
      });
      return;
    }

    if (cmdName === "key") {
      const actionOpt = rawOptions.find((o) => o && o.name === "action");
      const valOpt = rawOptions.find((o) => o && o.name === "value");
      const actionVal = sanitizeText(actionOpt && actionOpt.value, "check");
      const valStr = sanitizeText(valOpt && valOpt.value, "");

      if (actionVal === "generate") {
        const senderObj = (interaction.member && interaction.member.user) || interaction.user || {};
        const senderId = sanitizeSnowflakeId(senderObj.id || "");
        const senderLabel = formatDiscordUserDisplay(senderObj, senderId);
        const generated = generateLicenseKeyString();
        const newKeyObj = {
          id: generateUniqueId("key"),
          key: generated,
          owner: senderLabel,
          ownerId: senderId,
          scriptName: valStr || (ctxScripts[0] && ctxScripts[0].name) || "Ümumi",
          guildId: interactionGuildId,
          days: 0,
          hwid: "",
          hwidResetCount: 0,
          active: true,
          createdAt: new Date().toISOString()
        };
        ctxKeys.unshift(newKeyObj);
        commitCtxState();
        appendAuditLog(
          "KEY_GENERATED",
          `Discord /key ilə yeni key yaradıldı (${generated})`,
          senderLabel,
          interactionGuildId
        );

        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: `✅ Yeni Key Yaradıldı və saytdakı **Keylər** bölməsinə əlavə olundu:\n🔑 **Key:** \`${generated}\`\n📜 **Script:** \`${newKeyObj.scriptName}\``,
            flags: 64
          }
        });
        return;
      }

      const foundKey = ctxKeys.find((k) => k && k.key.toLowerCase() === valStr.toLowerCase());
      if (!foundKey) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "❌ Daxil edilən açar tapılmadı.",
            flags: 64
          }
        });
        return;
      }

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `🔑 **Key:** \`${foundKey.key}\`\n📜 **Script:** ${foundKey.scriptName}\n💻 **HWID:** ${
            foundKey.hwid || "Təyin edilməyib"
          }\n📌 **Status:** ${foundKey.active ? "Aktiv" : "Deaktiv"}`,
          flags: 64
        }
      });
      return;
    }

    if (cmdName === "status") {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          embeds: [
            {
              title: "⚡ SADO PROTECT • Sistem Statusu",
              color: 2278750,
              fields: [
                { name: "Bot Vəziyyəti", value: "Aktivdir", inline: true },
                {
                  name: "Sunucu",
                  value: (tenantCtx && tenantCtx.guildName) || APP_STATE.guildName || "Bağlı Sunucu",
                  inline: true
                },
                { name: "Scriptlər", value: `${ctxScripts.length}`, inline: true },
                { name: "Keylər", value: `${ctxKeys.length}`, inline: true },
                { name: "Whitelist", value: `${ctxWhitelist.length}`, inline: true },
                { name: "Blacklist", value: `${ctxBlacklist.length}`, inline: true }
              ]
            }
          ],
          flags: 64
        }
      });
      return;
    }
  }

  if (interactionType === 4) {
    const focusedOpt = Array.isArray(interaction.data && interaction.data.options)
      ? interaction.data.options.find((o) => o && o.focused)
      : null;
    const query = sanitizeText(focusedOpt && focusedOpt.value, "").toLowerCase();
    const choices = ctxScripts
      .filter((s) => !query || sanitizeText(s.name, "").toLowerCase().includes(query))
      .slice(0, 25)
      .map((s) => ({
        name: sanitizeText(s.name, "Script").slice(0, 100),
        value: sanitizeText(s.name, "Script").slice(0, 100)
      }));

    await respondToDiscordInteraction(interaction.id, interaction.token, {
      type: 8,
      data: { choices }
    });
    return;
  }

  if (interactionType === 3) {
    const customId = sanitizeText(interaction.data && interaction.data.custom_id, "");
    const parts = customId.split(":");
    const btnId = parts[1] || "";
    const scriptId = parts[2] || "";
    const senderObj = (interaction.member && interaction.member.user) || interaction.user || {};
    const userId = sanitizeSnowflakeId(senderObj.id || "0");
    const username = sanitizeText(senderObj.username, "İstifadəçi");
    const userDisplayLabel = formatDiscordUserDisplay(senderObj, userId);

    const activeDesign = tenantCtx ? tenantCtx.panelDesign : APP_STATE.panelDesign;
    const matchedBtn = activeDesign.buttons.find((b) => b.id === btnId);
    const matchedScript = ctxScripts.find((s) => s.id === scriptId) || ctxScripts[0] || null;

    if (btnId === "btn_redeem_key") {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 9,
        data: {
          custom_id: `sado_redeem_modal:${matchedScript ? matchedScript.id : "general"}`.slice(0, 100),
          title: "🔑 Lisenziya Açarı Aktiv Et",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "redeem_key_input",
                  label: "Lisenziya Açarınızı Daxil Edin",
                  style: 1,
                  min_length: 4,
                  max_length: 64,
                  placeholder: "Məs: SADO-XXXX-XXXX-XXXX",
                  required: true
                }
              ]
            }
          ]
        }
      });
      return;
    }

    if (btnId === "btn_reset_hwid") {
      const userTokens = collectUserMatchTokens(userId, senderObj);
      const userMatchedKeys = ctxKeys.filter((k) => {
        if (!k) return false;
        const kTokens = collectUserMatchTokens(k.owner, k);
        for (const tk of userTokens) {
          if (kTokens.has(tk)) return true;
        }
        return false;
      });

      if (userMatchedKeys.length === 0) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "❌ Sizin adınıza bağlı aktiv Key tapılmadı. Əvvəlcə **Reedem Key** ilə açarınızı aktivləşdirin və ya `/whitelist` ilə qeydiyyatdan keçin.",
            flags: 64
          }
        });
        return;
      }

      for (const kItem of userMatchedKeys) {
        kItem.hwid = "";
        kItem.hwidResetCount = Number(kItem.hwidResetCount || 0) + 1;
        kItem.lastHwidResetAt = new Date().toISOString();
      }
      commitCtxState();
      appendAuditLog(
        "HWID_RESET",
        `${userDisplayLabel} tərəfindən HWID sıfırlandı (${userMatchedKeys.length} key)`,
        userDisplayLabel,
        interactionGuildId
      );

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `🔄 **HWID Uğurla Sıfırlandı!**\n🔑 **Yenilənən Key sayı:** ${userMatchedKeys.length} ədəd\n📱 İndi scripti yeni cihazınızda işlətdikdə həmin cihaza avtomatik bağlanacaq.`,
          flags: 64
        }
      });
      return;
    }

    if (btnId === "btn_get_script") {
      const userTokens = collectUserMatchTokens(userId, senderObj);

      const userInBlacklist = ctxBlacklist.some((item) => {
        if (!item) return false;
        const itemTokens = collectUserMatchTokens(item.value, {
          owner: item.value,
          ownerId: item.userId || ""
        });
        for (const tk of userTokens) {
          if (itemTokens.has(tk)) return true;
        }
        return false;
      });

      const userInWhitelist = ctxWhitelist.some((item) => {
        if (!item) return false;
        const itemScriptLower = sanitizeText(item.scriptName, "").toLowerCase();
        if (
          matchedScript &&
          itemScriptLower &&
          itemScriptLower !== "ümumi" &&
          itemScriptLower !== "hamısı" &&
          itemScriptLower !== sanitizeText(matchedScript.name, "").toLowerCase()
        ) {
          return false;
        }
        const itemTokens = collectUserMatchTokens(item.value, {
          owner: item.value,
          ownerId: item.userId || "",
          key: item.generatedKey || ""
        });
        for (const tk of userTokens) {
          if (itemTokens.has(tk)) return true;
        }
        return false;
      });

      if (userInBlacklist) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "⛔ Siz **Blacklist** siyahısındasınız. Scriptə girişiniz qadağandır.",
            flags: 64
          }
        });
        return;
      }

      if (!userInWhitelist) {
        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: matchedScript
              ? `🚫 **${matchedScript.name}** scripti üçün **Whitelist** icazəniz yoxdur. Əgər açarınız varsa **Reedem Key** düyməsi ilə aktiv edin.`
              : "🚫 **Whitelist** icazəniz yoxdur. Əgər açarınız varsa **Reedem Key** düyməsi ilə aktiv edin.",
            flags: 64
          }
        });
        return;
      }

      const userKeyRecord =
        ctxKeys.find((k) => {
          if (!k || k.active === false) return false;
          const kScriptLower = sanitizeText(k.scriptName, "").toLowerCase();
          if (
            matchedScript &&
            kScriptLower &&
            kScriptLower !== "ümumi" &&
            kScriptLower !== "hamısı" &&
            kScriptLower !== sanitizeText(matchedScript.name, "").toLowerCase()
          ) {
            return false;
          }
          const kTokens = collectUserMatchTokens(k.owner, k);
          for (const tk of userTokens) {
            if (kTokens.has(tk)) return true;
          }
          return false;
        }) || null;

      if (!userKeyRecord) {
        const updatedWl = ctxWhitelist.filter((item) => {
          if (!item) return false;
          const itemScriptLower = sanitizeText(item.scriptName, "").toLowerCase();
          if (
            matchedScript &&
            itemScriptLower &&
            itemScriptLower !== "ümumi" &&
            itemScriptLower !== "hamısı" &&
            itemScriptLower !== sanitizeText(matchedScript.name, "").toLowerCase()
          ) {
            return true;
          }
          const itemTokens = collectUserMatchTokens(item.value, {
            owner: item.value,
            ownerId: item.userId || "",
            key: item.generatedKey || ""
          });
          for (const tk of userTokens) {
            if (itemTokens.has(tk)) return false;
          }
          return true;
        });
        ctxWhitelist.splice(0, ctxWhitelist.length, ...updatedWl);
        commitCtxState();

        await respondToDiscordInteraction(interaction.id, interaction.token, {
          type: 4,
          data: {
            content: "❌ Aktiv lisenziya açarınız silinib və ya mövcud deyil. Yeni açarınız varsa **Reedem Key** düyməsi ilə aktiv edin.",
            flags: 64
          }
        });
        return;
      }

      const basePublicUrl = sanitizeText(process.env.RENDER_EXTERNAL_URL, `http://localhost:${PORT}`).replace(
        /\/+$/,
        ""
      );
      const rawScriptLink = matchedScript
        ? `${basePublicUrl}/raw/${matchedScript.id}?key=${encodeURIComponent(userKeyRecord.key)}`
        : `${basePublicUrl}/raw/default?key=${encodeURIComponent(userKeyRecord.key)}`;
      const loaderCode = buildShortLoaderString(rawScriptLink);

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          embeds: [
            {
              title: `📜 ${matchedScript ? matchedScript.name : "SADO PROTECT Script"}`,
              color: 2278750,
              description: [
                `✅ **Whitelist təsdiqləndi!**`,
                `🔑 **Sizin Key:** \`${userKeyRecord.key}\``,
                `🔒 **Cihaz Kilidi:** İlk açılan cihaza avtomatik bağlanır`,
                "",
                "**Loader Kodu:**",
                `\`\`\`lua\n${loaderCode}\n\`\`\``
              ].join("\n"),
              footer: { text: "SADO PROTECT • Şəxsi Loader (Başqa cihazda işləmir)" }
            }
          ],
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 2,
                  label: "Scripti Kopyala",
                  emoji: { name: "📋" },
                  custom_id: `sado_copy_script:${matchedScript ? matchedScript.id : "general"}:${userKeyRecord.key}`.slice(0, 100)
                }
              ]
            }
          ],
          flags: 64
        }
      });
      return;
    }

    if (btnId === "sado_copy_script" || customId.startsWith("sado_copy_script:")) {
      const copyParts = customId.split(":");
      const copyScriptId = copyParts[1] || "";
      const copyKeyVal = copyParts[2] || "";
      const targetScript = ctxScripts.find((s) => s.id === copyScriptId) || matchedScript || ctxScripts[0] || null;
      const basePublicUrl = sanitizeText(process.env.RENDER_EXTERNAL_URL, `http://localhost:${PORT}`).replace(
        /\/+$/,
        ""
      );
      const rawScriptLink = targetScript
        ? `${basePublicUrl}/raw/${targetScript.id}?key=${encodeURIComponent(copyKeyVal)}`
        : `${basePublicUrl}/raw/default?key=${encodeURIComponent(copyKeyVal)}`;
      const cleanCopyLoader = buildShortLoaderString(rawScriptLink);

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: cleanCopyLoader,
          flags: 64
        }
      });
      return;
    }

    if (btnId === "btn_my_stats") {
      const userTokens = collectUserMatchTokens(userId, senderObj);
      const myKeys = ctxKeys.filter((k) => {
        if (!k) return false;
        const kTokens = collectUserMatchTokens(k.owner, k);
        for (const tk of userTokens) {
          if (kTokens.has(tk)) return true;
        }
        return false;
      });
      const statsLines = myKeys.length
        ? myKeys.map(
            (k, i) =>
              `**${i + 1}.** \`${k.key}\` • Script: **${k.scriptName || "Ümumi"}** • HWID: \`${k.hwid || "Bağlanmayıb"}\``
          )
        : ["Adınıza bağlı aktiv açar tapılmadı."];

      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          embeds: [
            {
              title: "📊 SADO PROTECT • İstifadəçi Statistikası",
              color: 5793266,
              description: [`**İstifadəçi:** <@${userId}>`, `**Aktiv Key Sayı:** ${myKeys.length}`, "", ...statsLines].join(
                "\n"
              )
            }
          ],
          flags: 64
        }
      });
      return;
    }

    const replyMessage = matchedBtn
      ? matchedBtn.responseText
      : `Salam ${username}, əməliyyat qeydə alındı.`;

    await respondToDiscordInteraction(interaction.id, interaction.token, {
      type: 4,
      data: {
        content: `✅ **${matchedBtn ? matchedBtn.label : "Panel"}** (${userId}): ${replyMessage}`,
        flags: 64
      }
    });
    return;
  }

  if (interactionType === 5) {
    const modalCustomId = sanitizeText(interaction.data && interaction.data.custom_id, "");
    if (!modalCustomId.startsWith("sado_redeem_modal")) return;

    const modalParts = modalCustomId.split(":");
    const targetScriptId = modalParts[1] || "";
    const targetScript = ctxScripts.find((s) => s.id === targetScriptId) || ctxScripts[0] || null;
    const senderObj = (interaction.member && interaction.member.user) || interaction.user || {};
    const userId = sanitizeSnowflakeId(senderObj.id || "0");
    const userDisplayLabel = formatDiscordUserDisplay(senderObj, userId);

    const modalRows = Array.isArray(interaction.data && interaction.data.components)
      ? interaction.data.components
      : [];
    let enteredKeyRaw = "";
    for (const row of modalRows) {
      const comps = Array.isArray(row && row.components) ? row.components : [];
      for (const comp of comps) {
        if (comp && comp.custom_id === "redeem_key_input") {
          enteredKeyRaw = sanitizeText(comp.value, "");
        }
      }
    }

    if (!enteredKeyRaw) {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: "❌ Zəhmət olmasa etibarlı lisenziya açarı daxil edin.",
          flags: 64
        }
      });
      return;
    }

    const foundKeyObj =
      ctxKeys.find((k) => k && sanitizeText(k.key, "").toLowerCase() === enteredKeyRaw.toLowerCase()) || null;

    if (!foundKeyObj) {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: `❌ \`${enteredKeyRaw}\` açarı tapılmadı. Düzgün yazdığınızdan əmin olun.`,
          flags: 64
        }
      });
      return;
    }

    if (foundKeyObj.active === false) {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: "⛔ Bu açar deaktiv edilib və ya bloklanıb.",
          flags: 64
        }
      });
      return;
    }

    const existingOwnerId = sanitizeSnowflakeId(foundKeyObj.ownerId || "");
    if (existingOwnerId && existingOwnerId !== userId) {
      await respondToDiscordInteraction(interaction.id, interaction.token, {
        type: 4,
        data: {
          content: "⚠️ Bu lisenziya açarı artıq başqa istifadəçi tərəfindən aktivləşdirilib.",
          flags: 64
        }
      });
      return;
    }

    const resolvedScriptName =
      sanitizeText(foundKeyObj.scriptName, "") || (targetScript ? targetScript.name : "Ümumi");

    foundKeyObj.owner = userDisplayLabel;
    foundKeyObj.ownerId = userId;
    foundKeyObj.scriptName = resolvedScriptName;
    foundKeyObj.redeemedAt = new Date().toISOString();

    const existingWl = ctxWhitelist.find(
      (w) =>
        w &&
        normalizeAccessValue(w.userId || w.value) === normalizeAccessValue(userId) &&
        normalizeAccessValue(w.scriptName) === normalizeAccessValue(resolvedScriptName)
    );

    if (!existingWl) {
      ctxWhitelist.unshift({
        id: generateUniqueId("acc"),
        value: userDisplayLabel,
        userId,
        scriptName: resolvedScriptName,
        generatedKey: foundKeyObj.key,
        createdAt: new Date().toISOString()
      });
    } else {
      existingWl.value = userDisplayLabel;
      existingWl.userId = userId;
      existingWl.generatedKey = foundKeyObj.key;
    }

    commitCtxState();
    appendAuditLog(
      "KEY_REDEEMED",
      `${userDisplayLabel} açar aktiv etdi: ${foundKeyObj.key} (${resolvedScriptName})`,
      userDisplayLabel,
      interactionGuildId
    );

    await respondToDiscordInteraction(interaction.id, interaction.token, {
      type: 4,
      data: {
        embeds: [
          {
            title: "✅ Lisenziya Açarı Uğurla Aktiv Edildi!",
            color: 2278750,
            description: [
              `**İstifadəçi:** <@${userId}>`,
              `**Aktiv Edilən Key:** \`${foundKeyObj.key}\``,
              `**Script:** \`${resolvedScriptName}\``,
              "",
              "İndi **Get Script** düyməsinə basaraq scriptinizi əldə edə bilərsiniz."
            ].join("\n"),
            footer: { text: "SADO PROTECT • Lisenziya Sistemi" },
            timestamp: new Date().toISOString()
          }
        ],
        flags: 64
      }
    });
    return;
  }
};

const clearBotTimers = () => {
  if (BOT_RUNTIME.heartbeatTimer) {
    clearInterval(BOT_RUNTIME.heartbeatTimer);
    BOT_RUNTIME.heartbeatTimer = null;
  }
  if (BOT_RUNTIME.reconnectTimer) {
    clearTimeout(BOT_RUNTIME.reconnectTimer);
    BOT_RUNTIME.reconnectTimer = null;
  }
};

const scheduleBotReconnect = () => {
  if (BOT_RUNTIME.reconnectTimer) return;
  BOT_RUNTIME.reconnectTimer = setTimeout(() => {
    BOT_RUNTIME.reconnectTimer = null;
    startDiscordBotRuntime();
  }, 3000);
};

const startSelfKeepAliveLoop = () => {
  if (BOT_RUNTIME.keepAliveTimer) return;
  const externalUrl = sanitizeText(process.env.RENDER_EXTERNAL_URL, "");
  if (!externalUrl) return;
  const pingTarget = `${externalUrl.replace(/\/+$/, "")}/health`;
  BOT_RUNTIME.keepAliveTimer = setInterval(() => {
    try {
      const clientMod = pingTarget.startsWith("https://") ? https : http;
      const req = clientMod.get(pingTarget, (res) => {
        res.resume();
      });
      req.on("error", () => {});
    } catch (_err) {}
  }, 4 * 60 * 1000);
};

const startDiscordBotRuntime = async () => {
  const token = resolveDiscordBotToken();
  if (!token) {
    BOT_RUNTIME.connected = false;
    BOT_RUNTIME.connecting = false;
    BOT_RUNTIME.lastError = "Render Environment-də DISCORD_BOT_TOKEN tapılmadı";
    return;
  }

  if (BOT_RUNTIME.connecting || BOT_RUNTIME.connected) return;
  BOT_RUNTIME.connecting = true;
  BOT_RUNTIME.lastError = "";

  const gatewayRes = await callDiscordRestApi("/gateway/bot", "GET", null, token);
  const gatewayBaseUrl =
    gatewayRes.ok && gatewayRes.data && gatewayRes.data.url
      ? gatewayRes.data.url
      : "wss://gateway.discord.gg";

  try {
    if (BOT_RUNTIME.ws) {
      try {
        BOT_RUNTIME.ws.terminate();
      } catch (_err) {}
    }

    const wsUrl = `${gatewayBaseUrl.replace(/\/+$/, "")}/?v=10&encoding=json`;
    const ws = new WebSocket(wsUrl);
    BOT_RUNTIME.ws = ws;

    ws.on("open", () => {
      BOT_RUNTIME.lastError = "";
    });

    ws.on("message", async (rawData) => {
      let packet = null;
      try {
        packet = JSON.parse(String(rawData));
      } catch (_err) {
        return;
      }

      if (packet.s !== null && packet.s !== undefined) {
        BOT_RUNTIME.seq = packet.s;
      }

      if (packet.op === 10 && packet.d && packet.d.heartbeat_interval) {
        const intervalMs = Number(packet.d.heartbeat_interval) || 41250;
        if (BOT_RUNTIME.heartbeatTimer) clearInterval(BOT_RUNTIME.heartbeatTimer);
        BOT_RUNTIME.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: BOT_RUNTIME.seq }));
          }
        }, intervalMs);

        ws.send(
          JSON.stringify({
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
                status: "online",
                activities: [
                  {
                    name: "SADO PROTECT • /panel",
                    type: 3
                  }
                ]
              }
            }
          })
        );
        return;
      }

      if (packet.op === 0) {
        if (packet.t === "READY" && packet.d) {
          BOT_RUNTIME.connected = true;
          BOT_RUNTIME.connecting = false;
          BOT_RUNTIME.lastError = "";
          BOT_RUNTIME.lastConnectedAt = new Date().toISOString();
          BOT_RUNTIME.sessionId = sanitizeText(packet.d.session_id, "");
          if (packet.d.user) {
            BOT_RUNTIME.botUserId = sanitizeSnowflakeId(packet.d.user.id);
            BOT_RUNTIME.botUsername = sanitizeText(packet.d.user.username, "SADO PROTECT");
          }

          await syncSlashCommandsWithDiscord();

          if (APP_STATE.guildId) {
            const gName = await resolveGuildDisplayName(APP_STATE.guildId, APP_STATE.guildName);
            if (gName) {
              APP_STATE.guildName = gName;
              const pTenant = getTenantRecordByGuildId(APP_STATE.guildId);
              if (pTenant) pTenant.guildName = gName;
              saveAppStateToDisk();
            }
          }
          return;
        }

        if (packet.t === "INTERACTION_CREATE") {
          handleDiscordInteractionCreate(packet.d).catch(() => {});
        }
      }
    });

    ws.on("close", (code) => {
      clearBotTimers();
      BOT_RUNTIME.connected = false;
      BOT_RUNTIME.connecting = false;
      if (code === 4004) {
        BOT_RUNTIME.lastError = "Bot Token yanlışdır (Discord 4004 Authentication Failed)";
        return;
      }
      scheduleBotReconnect();
    });

    ws.on("error", (err) => {
      BOT_RUNTIME.connected = false;
      BOT_RUNTIME.connecting = false;
      BOT_RUNTIME.lastError = err.message || "Gateway bağlantı xətası";
    });
  } catch (err) {
    BOT_RUNTIME.connected = false;
    BOT_RUNTIME.connecting = false;
    BOT_RUNTIME.lastError = err.message || "Bot başladılarkən xəta baş verdi";
    scheduleBotReconnect();
  }
};

const parseRequestJsonBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        raw = raw.slice(0, 5 * 1024 * 1024);
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
        resolve({});
      }
    });
  });

const sendJsonResponse = (res, statusCode, payload) => {
  const jsonText = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(jsonText);
};

const buildPublicSnapshotPayload = async (requestedGuildId = "") => {
  const tokenPresent = Boolean(resolveDiscordBotToken());
  const cleanGuildId = sanitizeSnowflakeId(requestedGuildId);
  const tenant = cleanGuildId ? getTenantRecordByGuildId(cleanGuildId) : null;
  let resolvedGuildName = tenant ? sanitizeText(tenant.guildName, "") : "";

  if (cleanGuildId) {
    const freshName = await resolveGuildDisplayName(cleanGuildId, resolvedGuildName);
    if (freshName) {
      resolvedGuildName = freshName;
      if (tenant && tenant.guildName !== freshName) {
        tenant.guildName = freshName;
        syncTenantIntoGlobalIfPrimary(tenant);
        saveAppStateToDisk();
      }
    }
  }

  const botIsActive = Boolean(BOT_RUNTIME.connected || (tokenPresent && BOT_RUNTIME.botUserId));
  const scriptsList = tenant ? tenant.scripts || [] : [];
  const keysList = tenant ? tenant.keys || [] : [];
  const whitelistList = tenant ? tenant.whitelist || [] : [];
  const blacklistList = tenant ? tenant.blacklist || [] : [];
  const designObj = tenant
    ? normalizePanelDesign(tenant.panelDesign)
    : normalizePanelDesign(APP_STATE.panelDesign);
  const logsList = tenant ? tenant.auditLogs || [] : [];

  return {
    bot: {
      active: botIsActive,
      statusText: botIsActive ? "Bot: Aktivdir" : "Bot: Aktiv deyil — Gözləmədədir",
      tokenConfigured: tokenPresent,
      username: BOT_RUNTIME.botUsername || "SADO PROTECT",
      botUserId: BOT_RUNTIME.botUserId || "",
      inviteUrl: DISCORD_INVITE_URL,
      lastError: BOT_RUNTIME.lastError || "",
      lastConnectedAt: BOT_RUNTIME.lastConnectedAt || ""
    },
    guild: {
      guildId: cleanGuildId,
      guildName: resolvedGuildName,
      displayName: resolvedGuildName || "Bağlı Sunucu Yoxdur",
      panelChannelId: tenant ? sanitizeSnowflakeId(tenant.panelChannelId) : ""
    },
    stats: {
      scriptsCount: scriptsList.length,
      keysCount: keysList.length,
      whitelistCount: whitelistList.length,
      blacklistCount: blacklistList.length
    },
    scripts: scriptsList,
    keys: keysList,
    whitelist: whitelistList,
    blacklist: blacklistList,
    panelDesign: designObj,
    auditLogs: logsList.slice(0, 50),
    updatedAt: APP_STATE.updatedAt
  };
};

const renderDashboardHtmlPage = () => `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • İdarəetmə Paneli</title>
  <style>
    :root {
      --bg-main: #070b14;
      --bg-sidebar: #0b1120;
      --bg-card: #0f172a;
      --bg-input: #141e33;
      --border: #1e293b;
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #5865F2;
      --accent-hover: #4752c4;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    }

    body {
      background: var(--bg-main);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
    }

    .sidebar {
      width: 265px;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 20px 14px;
      gap: 18px;
      position: sticky;
      top: 0;
      height: 100vh;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
    }

    .brand-logo {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #5865F2, #38bdf8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 16px;
      color: #fff;
      box-shadow: 0 8px 20px rgba(88, 101, 242, 0.35);
    }

    .brand-title {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.4px;
    }

    .brand-sub {
      font-size: 11px;
      color: var(--text-muted);
    }

    .nav-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 14px;
      border-radius: 10px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      transition: all 0.16s ease;
    }

    .nav-item:hover {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-main);
    }

    .nav-item.active {
      background: rgba(88, 101, 242, 0.16);
      border-color: rgba(88, 101, 242, 0.4);
      color: #fff;
    }

    .main-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .topbar {
      background: rgba(11, 17, 32, 0.9);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      position: sticky;
      top: 0;
      z-index: 20;
    }

    .status-pills {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 13px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      background: var(--bg-card);
      border: 1px solid var(--border);
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--warning);
    }

    .dot.active {
      background: var(--success);
      box-shadow: 0 0 10px rgba(34, 197, 94, 0.7);
    }

    .content {
      padding: 24px;
      max-width: 1320px;
      width: 100%;
      margin: 0 auto;
    }

    .tab-section {
      display: none;
    }

    .tab-section.active {
      display: block;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin-bottom: 22px;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
    }

    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 26px;
      font-weight: 800;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 18px;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 18px;
    }

    .card-title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .card-sub {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 16px;
      line-height: 1.45;
    }

    .form-group {
      margin-bottom: 14px;
    }

    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    input[type="text"],
    input[type="number"],
    select,
    textarea {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text-main);
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--accent);
    }

    textarea {
      min-height: 92px;
      resize: vertical;
    }

    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }

    .btn {
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid transparent;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      text-decoration: none;
      transition: all 0.15s ease;
    }

    .btn-primary {
      background: var(--accent);
      color: #fff;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
    }

    .btn-success {
      background: #16a34a;
      color: #fff;
    }

    .btn-secondary {
      background: #1e293b;
      color: var(--text-main);
      border-color: #334155;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.16);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.35);
    }

    .btn-sm {
      padding: 6px 11px;
      font-size: 12px;
      border-radius: 8px;
    }

    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th,
    td {
      text-align: left;
      padding: 11px 10px;
      border-bottom: 1px solid var(--border);
    }

    th {
      color: var(--text-muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(88, 101, 242, 0.2);
      color: #c7d2fe;
    }

    .badge-green {
      background: rgba(34, 197, 94, 0.2);
      color: #86efac;
    }

    .discord-preview {
      background: #2b2d31;
      border-radius: 10px;
      padding: 14px;
      border-left: 4px solid #5865F2;
    }

    .discord-preview-title {
      font-weight: 700;
      font-size: 15px;
      color: #fff;
      margin-bottom: 6px;
    }

    .discord-preview-desc {
      font-size: 13px;
      color: #dbdee1;
      line-height: 1.45;
      margin-bottom: 10px;
      white-space: pre-wrap;
    }

    .discord-preview-footer {
      font-size: 11px;
      color: #949ba4;
      margin-top: 8px;
    }

    .preview-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .preview-btn {
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      background: #5865F2;
    }

    .preview-btn.style-2 { background: #4e5058; }
    .preview-btn.style-3 { background: #248046; }
    .preview-btn.style-4 { background: #da373c; }

    .btn-editor-row {
      display: grid;
      grid-template-columns: 70px 1fr 120px 1.3fr auto;
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }

    .btn-order-actions {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .toast-container {
      position: fixed;
      right: 18px;
      bottom: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 9999;
    }

    .toast {
      background: #0f172a;
      border: 1px solid #334155;
      color: #fff;
      padding: 11px 15px;
      border-radius: 10px;
      font-size: 13px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45);
    }

    @media (max-width: 860px) {
      body { flex-direction: column; }
      .sidebar {
        width: 100%;
        height: auto;
        position: static;
      }
      .nav-list {
        flex-direction: row;
        flex-wrap: wrap;
      }
      .btn-editor-row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-logo">SP</div>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub">Tam İdarəetmə Paneli</div>
      </div>
    </div>

    <nav class="nav-list">
      <button class="nav-item active" data-tab="overview">📊 İdarəetmə</button>
      <button class="nav-item" data-tab="scripts">📜 Scriptlər</button>
      <button class="nav-item" data-tab="keys">🔑 Keylər</button>
      <button class="nav-item" data-tab="designer">🎨 Panel Dizaynı</button>
      <button class="nav-item" data-tab="access">🛡️ Whitelist / Blacklist</button>
    </nav>
  </aside>

  <main class="main-area">
    <header class="topbar">
      <div class="status-pills">
        <div class="pill">
          <span id="botStatusDot" class="dot"></span>
          <span id="botStatusLabel">Bot: Aktiv deyil — Gözləmədədir</span>
        </div>
        <div class="pill">
          <span>🏰 Sunucu:</span>
          <strong id="guildNameLabel">Bağlı Sunucu Yoxdur</strong>
        </div>
      </div>
      <div class="row">
        <a
          id="joinDiscordTopBtn"
          href="${DISCORD_INVITE_URL}"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-primary btn-sm"
        >➕ Join Discord</a>
        <button id="refreshSnapshotBtn" class="btn btn-secondary btn-sm">🔄 Yenilə</button>
      </div>
    </header>

    <div class="content">
      <section id="tab-overview" class="tab-section active">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Aktiv Scriptlər</div>
            <div id="statScriptsCount" class="stat-value">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Yaradılmış Keylər</div>
            <div id="statKeysCount" class="stat-value">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Whitelist</div>
            <div id="statWhitelistCount" class="stat-value">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Blacklist</div>
            <div id="statBlacklistCount" class="stat-value">0</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-title">🤖 Sunucu Bağlantısı (Bu Cihaz Üçün)</div>
            <div class="card-sub">
              Əvvəlcə <strong>Join Discord</strong> düyməsi ilə botu serverinizə əlavə edin, sonra aşağıya öz <strong>Sunucu ID</strong>-nizi yazın.
            </div>
            <div class="form-group">
              <label>Sunucu ID (Guild ID)</label>
              <input id="guildIdInput" type="text" placeholder="Sunucu ID-ni buraya yazın (Məs: 123456789012345678)" />
            </div>
            <div class="form-group">
              <label>Panel Kanal ID (İstəyə bağlı)</label>
              <input id="panelChannelIdInput" type="text" placeholder="Məs: 123456789012345678" />
            </div>
            <div class="row">
              <a
                id="joinDiscordCardBtn"
                href="${DISCORD_INVITE_URL}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-primary"
              >➕ Join Discord</a>
              <button id="connectBotBtn" class="btn btn-success">🔗 Sunucunu Bağla</button>
              <button id="sendPanelQuickBtn" class="btn btn-secondary">📨 Paneli Kanala Göndər</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">📋 Son Əməliyyatlar</div>
            <div class="card-sub">Bu sunucuda edilən son dəyişikliklər</div>
            <div id="auditLogList" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto;"></div>
          </div>
        </div>
      </section>

      <section id="tab-scripts" class="tab-section">
        <div class="grid-2">
          <div class="card">
            <div class="card-title">➕ Yeni Script Əlavə Et</div>
            <div class="card-sub">
              Burada yaratdığınız hər script öz sunucunuzun <code>/panel</code>, <code>/whitelist</code> və <code>/unwhitelist</code> siyahısına düşür.
            </div>
            <div class="form-group">
              <label>Script Adı</label>
              <input id="newScriptName" type="text" placeholder="Məs: Blox Fruits VIP" />
            </div>
            <div class="form-group">
              <label>Mənbə Növü</label>
              <select id="newScriptSourceType">
                <option value="url">URL (Link ilə)</option>
                <option value="file">Fayl (.lua / .txt yüklə)</option>
              </select>
            </div>
            <div id="newScriptUrlGroup" class="form-group">
              <label>Script URL</label>
              <input id="newScriptUrl" type="text" placeholder="https://raw.githubusercontent.com/..." />
            </div>
            <div id="newScriptFileGroup" class="form-group" style="display:none;">
              <label>Lua / TXT Fayl Seçin</label>
              <input id="newScriptFileInput" type="file" accept=".lua,.txt,text/plain" />
              <div id="newScriptFileInfo" style="font-size:12px;color:#94a3b8;margin-top:6px;">Hələ fayl seçilməyib</div>
            </div>
            <div class="form-group">
              <label>Açıqlama</label>
              <textarea id="newScriptDesc" placeholder="Script haqqında qısa məlumat..."></textarea>
            </div>
            <button id="createScriptBtn" class="btn btn-primary">💾 Scripti Yarat</button>
          </div>

          <div class="card">
            <div class="card-title">✏️ Mövcud Scriptə Düzəliş Et</div>
            <div class="card-sub">
              Cədvəldən "Düzəliş Et" düyməsini seçərək həm URL, həm də Fayl (.lua/.txt) ilə yeniləyə bilərsiniz.
            </div>
            <input id="editScriptId" type="hidden" />
            <div class="form-group">
              <label>Script Adı</label>
              <input id="editScriptName" type="text" placeholder="Seçilmiş script adı" />
            </div>
            <div class="form-group">
              <label>Mənbə Növü</label>
              <select id="editScriptSourceType">
                <option value="url">URL (Link ilə)</option>
                <option value="file">Fayl (.lua / .txt ilə yenilə)</option>
              </select>
            </div>
            <div id="editScriptUrlGroup" class="form-group">
              <label>Script URL</label>
              <input id="editScriptUrl" type="text" placeholder="https://..." />
            </div>
            <div id="editScriptFileGroup" class="form-group" style="display:none;">
              <label>Yeni Lua / TXT Fayl Seçin (Faylı yeniləmək üçün)</label>
              <input id="editScriptFileInput" type="file" accept=".lua,.txt,text/plain" />
              <div id="editScriptFileInfo" style="font-size:12px;color:#94a3b8;margin-top:6px;">Mövcud fayl saxlanılacaq</div>
            </div>
            <div class="form-group">
              <label>Açıqlama</label>
              <textarea id="editScriptDesc" placeholder="Açıqlama..."></textarea>
            </div>
            <button id="updateScriptBtn" class="btn btn-success">✅ Dəyişiklikləri Saxla</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">📜 Mövcud Scriptlər</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Mənbə</th>
                  <th>Açıqlama</th>
                  <th>Əməliyyat</th>
                </tr>
              </thead>
              <tbody id="scriptsTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-keys" class="tab-section">
        <div class="card">
          <div class="card-title">🔑 Yeni Lisenziya Key Yarat</div>
          <div class="card-sub">
            Yaradılan key avtomatik olaraq öz sunucunuzun siyahısına düşür.
          </div>
          <div class="row">
            <div style="flex:1;min-width:200px;">
              <label>Script Seçimi</label>
              <select id="keyScriptSelect"></select>
            </div>
            <div style="width:160px;">
              <label>Müddət (Gün)</label>
              <input id="keyDaysInput" type="number" min="0" value="30" />
            </div>
            <div style="flex:1;min-width:200px;">
              <label>HWID (İstəyə bağlı)</label>
              <input id="keyHwidInput" type="text" placeholder="Boş buraxıla bilər" />
            </div>
            <div style="align-self:flex-end;">
              <button id="createKeyBtn" class="btn btn-primary">➕ Key Yarat</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">📋 Aktiv Key Siyahısı</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Sahibi</th>
                  <th>Script</th>
                  <th>Müddət</th>
                  <th>HWID</th>
                  <th>Əməliyyat</th>
                </tr>
              </thead>
              <tbody id="keysTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-designer" class="tab-section">
        <div class="grid-2">
          <div class="card">
            <div class="card-title">🎨 Discord Panel Dizaynı</div>
            <div class="card-sub">
              Embed rəngi, başlığı, açıqlaması və düymələri bu sunucu üçün yadda saxlanılır.
            </div>
            <div class="form-group">
              <label>Embed Başlığı</label>
              <input id="designTitleInput" type="text" />
            </div>
            <div class="form-group">
              <label>Embed Açıqlaması</label>
              <textarea id="designDescInput"></textarea>
            </div>
            <div class="row">
              <div class="form-group" style="flex:1;">
                <label>Embed Rəngi (Hex)</label>
                <input id="designColorInput" type="text" placeholder="#5865F2" />
              </div>
              <div class="form-group" style="flex:1;">
                <label>Footer Mətni</label>
                <input id="designFooterInput" type="text" />
              </div>
            </div>
            <div class="row">
              <div class="form-group" style="flex:1;">
                <label>Thumbnail URL</label>
                <input id="designThumbInput" type="text" placeholder="https://..." />
              </div>
              <div class="form-group" style="flex:1;">
                <label>Böyük Şəkil URL</label>
                <input id="designImageInput" type="text" placeholder="https://..." />
              </div>
            </div>

            <div class="form-group">
              <label>Panel Düymələri (Maksimum 5 ədəd)</label>
              <div id="designButtonsEditor"></div>
              <button id="addDesignButtonBtn" class="btn btn-secondary btn-sm" type="button">➕ Düymə Əlavə Et</button>
            </div>

            <div class="row">
              <button id="saveDesignBtn" class="btn btn-primary">💾 Dizaynı Saxla</button>
              <button id="sendDesignedPanelBtn" class="btn btn-success">📨 Kanala Göndər</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">👁️ Canlı Discord Panel Önizləməsi</div>
            <div class="card-sub">Discord kanalında görünəcək real görünüş</div>
            <div id="discordLivePreview" class="discord-preview">
              <div id="previewTitle" class="discord-preview-title"></div>
              <div id="previewDesc" class="discord-preview-desc"></div>
              <div id="previewButtons" class="preview-buttons"></div>
              <div id="previewFooter" class="discord-preview-footer"></div>
            </div>
          </div>
        </div>
      </section>

      <section id="tab-access" class="tab-section">
        <div class="grid-2">
          <div class="card">
            <div class="card-title">✅ Whitelist (İcazəli İstifadəçilər)</div>
            <div class="card-sub">
              Whitelist-ə əlavə edilən istifadəçi yalnız seçilmiş script üçün avtomatik lisenziya açarı qazanır.
            </div>
            <div class="row" style="margin-bottom:12px;">
              <input id="whitelistValueInput" type="text" placeholder="Discord ID və ya istifadəçi adı" style="flex:1;min-width:170px;" />
              <select id="whitelistScriptSelect" style="min-width:165px;"></select>
              <button id="addWhitelistBtn" class="btn btn-success">Əlavə Et + Avto Key</button>
            </div>
            <div id="whitelistContainer"></div>
          </div>

          <div class="card">
            <div class="card-title">⛔ Blacklist (Qadağan Edilənlər)</div>
            <div class="card-sub">Bloklanmış istifadəçi və ya HWID siyahısı</div>
            <div class="row" style="margin-bottom:12px;">
              <input id="blacklistValueInput" type="text" placeholder="Discord ID və ya HWID" style="flex:1;" />
              <button id="addBlacklistBtn" class="btn btn-danger">Blokla</button>
            </div>
            <div id="blacklistContainer"></div>
          </div>
        </div>
      </section>
    </div>
  </main>

  <div id="toastContainer" class="toast-container"></div>

  <script>
    const CLIENT_GUILD_STORAGE_KEY = "sado_protect_device_guild_id";
    const clientState = {
      snapshot: null,
      designerButtons: [],
      editingScriptId: "",
      deviceGuildId: localStorage.getItem(CLIENT_GUILD_STORAGE_KEY) || "",
      newScriptFilePayload: { fileName: "", content: "" },
      editScriptFilePayload: { fileName: "", content: "" }
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
      if (clientState.deviceGuildId) {
        fetchOptions.headers["x-guild-id"] = clientState.deviceGuildId;
      }
      if (bodyObj !== null) {
        fetchOptions.headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify({
          guildId: clientState.deviceGuildId || undefined,
          ...bodyObj
        });
      }
      const res = await fetch(urlPath, fetchOptions);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sorğu uğursuz oldu");
      return data;
    };

    const escapeHtml = (unsafe) =>
      String(unsafe || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const renderLivePreview = () => {
      const title = (document.getElementById("designTitleInput") || {}).value || "SADO PROTECT";
      const desc = (document.getElementById("designDescInput") || {}).value || "";
      const color = (document.getElementById("designColorInput") || {}).value || "#5865F2";
      const footer = (document.getElementById("designFooterInput") || {}).value || "";

      const box = document.getElementById("discordLivePreview");
      if (box) {
        box.style.borderLeftColor = /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : "#5865F2";
      }
      document.getElementById("previewTitle").textContent = title;
      document.getElementById("previewDesc").textContent = desc;
      document.getElementById("previewFooter").textContent = footer;

      const btnWrap = document.getElementById("previewButtons");
      btnWrap.innerHTML = clientState.designerButtons
        .map((b) => {
          const emojiPart = b.emoji ? escapeHtml(b.emoji) + " " : "";
          return '<span class="preview-btn style-' + Number(b.style || 1) + '">' + emojiPart + escapeHtml(b.label || "Düymə") + "</span>";
        })
        .join("");
    };

    const renderDesignButtonsEditor = () => {
      const container = document.getElementById("designButtonsEditor");
      if (!container) return;
      container.innerHTML = clientState.designerButtons
        .map((btn, idx) => {
          return (
            '<div class="btn-editor-row" data-idx="' + idx + '">' +
            '<input type="text" class="btn-emoji-inp" placeholder="Emoji" value="' + escapeHtml(btn.emoji || "") + '" />' +
            '<input type="text" class="btn-label-inp" placeholder="Düymə adı" value="' + escapeHtml(btn.label || "") + '" />' +
            '<select class="btn-style-inp">' +
            '<option value="1"' + (Number(btn.style) === 1 ? " selected" : "") + '>Mavi</option>' +
            '<option value="2"' + (Number(btn.style) === 2 ? " selected" : "") + '>Boz</option>' +
            '<option value="3"' + (Number(btn.style) === 3 ? " selected" : "") + '>Yaşıl</option>' +
            '<option value="4"' + (Number(btn.style) === 4 ? " selected" : "") + '>Qırmızı</option>' +
            "</select>" +
            '<input type="text" class="btn-resp-inp" placeholder="Cavab mesajı" value="' + escapeHtml(btn.responseText || "") + '" />' +
            '<div class="btn-order-actions">' +
            '<button type="button" class="btn btn-secondary btn-sm btn-move-up" title="Yuxarı daşı"' + (idx === 0 ? " disabled" : "") + ">▲</button>" +
            '<button type="button" class="btn btn-secondary btn-sm btn-move-down" title="Aşağı daşı"' + (idx === clientState.designerButtons.length - 1 ? " disabled" : "") + ">▼</button>" +
            '<button type="button" class="btn btn-danger btn-sm btn-remove-design">Sil</button>' +
            "</div>" +
            "</div>"
          );
        })
        .join("");

      container.querySelectorAll(".btn-editor-row").forEach((rowEl) => {
        const idx = Number(rowEl.getAttribute("data-idx"));
        const syncRow = () => {
          if (!clientState.designerButtons[idx]) return;
          clientState.designerButtons[idx].emoji = rowEl.querySelector(".btn-emoji-inp").value;
          clientState.designerButtons[idx].label = rowEl.querySelector(".btn-label-inp").value;
          clientState.designerButtons[idx].style = Number(rowEl.querySelector(".btn-style-inp").value);
          clientState.designerButtons[idx].responseText = rowEl.querySelector(".btn-resp-inp").value;
          renderLivePreview();
        };
        rowEl.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", syncRow));

        const moveUpBtn = rowEl.querySelector(".btn-move-up");
        if (moveUpBtn) {
          moveUpBtn.addEventListener("click", () => {
            if (idx <= 0) return;
            const tempItem = clientState.designerButtons[idx - 1];
            clientState.designerButtons[idx - 1] = clientState.designerButtons[idx];
            clientState.designerButtons[idx] = tempItem;
            renderDesignButtonsEditor();
          });
        }

        const moveDownBtn = rowEl.querySelector(".btn-move-down");
        if (moveDownBtn) {
          moveDownBtn.addEventListener("click", () => {
            if (idx >= clientState.designerButtons.length - 1) return;
            const tempItem = clientState.designerButtons[idx + 1];
            clientState.designerButtons[idx + 1] = clientState.designerButtons[idx];
            clientState.designerButtons[idx] = tempItem;
            renderDesignButtonsEditor();
          });
        }

        rowEl.querySelector(".btn-remove-design").addEventListener("click", () => {
          if (clientState.designerButtons.length <= 1) {
            showToast("Ən azı 1 düymə qalmalıdır");
            return;
          }
          clientState.designerButtons.splice(idx, 1);
          renderDesignButtonsEditor();
          renderLivePreview();
        });
      });

      renderLivePreview();
    };

    const populateEditScriptForm = (scriptObj) => {
      if (!scriptObj) return;
      clientState.editingScriptId = scriptObj.id;
      clientState.editScriptFilePayload = {
        fileName: scriptObj.fileName || "",
        content: scriptObj.scriptContent || ""
      };
      document.getElementById("editScriptId").value = scriptObj.id;
      document.getElementById("editScriptName").value = scriptObj.name || "";
      const srcTypeEl = document.getElementById("editScriptSourceType");
      if (srcTypeEl) {
        srcTypeEl.value = scriptObj.sourceType === "file" ? "file" : "url";
        toggleEditScriptSourceInputs();
      }
      document.getElementById("editScriptUrl").value = scriptObj.scriptUrl || "";
      const editFileInfo = document.getElementById("editScriptFileInfo");
      if (editFileInfo) {
        editFileInfo.textContent = scriptObj.fileName
          ? "Mövcud fayl: " + scriptObj.fileName
          : "Mövcud fayl saxlanılacaq";
      }
      document.getElementById("editScriptDesc").value = scriptObj.description || "";
    };

    const applySnapshotToUi = (snap) => {
      clientState.snapshot = snap;

      const inviteHref = (snap.bot && snap.bot.inviteUrl) || "${DISCORD_INVITE_URL}";
      const topJoinBtn = document.getElementById("joinDiscordTopBtn");
      const cardJoinBtn = document.getElementById("joinDiscordCardBtn");
      if (topJoinBtn) topJoinBtn.href = inviteHref;
      if (cardJoinBtn) cardJoinBtn.href = inviteHref;

      const dotEl = document.getElementById("botStatusDot");
      const labelEl = document.getElementById("botStatusLabel");
      if (snap.bot && snap.bot.active) {
        dotEl.classList.add("active");
        labelEl.textContent = "Bot: Aktivdir";
      } else {
        dotEl.classList.remove("active");
        labelEl.textContent = "Bot: Aktiv deyil — Gözləmədədir";
      }

      document.getElementById("guildNameLabel").textContent =
        (snap.guild && (snap.guild.guildName || snap.guild.displayName)) || "Bağlı Sunucu Yoxdur";

      const guildIdInput = document.getElementById("guildIdInput");
      if (guildIdInput && document.activeElement !== guildIdInput) {
        guildIdInput.value = clientState.deviceGuildId || (snap.guild && snap.guild.guildId) || "";
      }

      const channelIdInput = document.getElementById("panelChannelIdInput");
      if (channelIdInput && !channelIdInput.value && snap.guild && snap.guild.panelChannelId) {
        channelIdInput.value = snap.guild.panelChannelId;
      }

      document.getElementById("statScriptsCount").textContent = String((snap.stats && snap.stats.scriptsCount) || 0);
      document.getElementById("statKeysCount").textContent = String((snap.stats && snap.stats.keysCount) || 0);
      document.getElementById("statWhitelistCount").textContent = String((snap.stats && snap.stats.whitelistCount) || 0);
      document.getElementById("statBlacklistCount").textContent = String((snap.stats && snap.stats.blacklistCount) || 0);

      const scripts = Array.isArray(snap.scripts) ? snap.scripts : [];
      const scriptsBody = document.getElementById("scriptsTableBody");
      scriptsBody.innerHTML = scripts.length
        ? scripts
            .map((sc) => {
              const sourceLabel = sc.sourceType === "file"
                ? "Fayl: " + escapeHtml(sc.fileName || "script.lua")
                : escapeHtml(sc.scriptUrl || "Daxili");
              return (
                "<tr>" +
                "<td><strong>" + escapeHtml(sc.name) + "</strong></td>" +
                "<td><span class='badge'>" + sourceLabel + "</span></td>" +
                "<td>" + escapeHtml(sc.description || "-") + "</td>" +
                "<td class='row'>" +
                "<button class='btn btn-secondary btn-sm btn-edit-sc' data-id='" + escapeHtml(sc.id) + "'>✏️ Düzəliş Et</button>" +
                "<button class='btn btn-danger btn-sm btn-del-sc' data-id='" + escapeHtml(sc.id) + "'>🗑️ Sil</button>" +
                "</td>" +
                "</tr>"
              );
            })
            .join("")
        : "<tr><td colspan='4' style='color:#94a3b8;'>Hələ script əlavə edilməyib.</td></tr>";

      scriptsBody.querySelectorAll(".btn-edit-sc").forEach((btn) => {
        btn.addEventListener("click", () => {
          const targetId = btn.getAttribute("data-id");
          const found = scripts.find((item) => item.id === targetId);
          populateEditScriptForm(found);
          showToast("Script redaktə formuna yükləndi");
        });
      });

      scriptsBody.querySelectorAll(".btn-del-sc").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const targetId = btn.getAttribute("data-id");
          try {
            await apiRequest("/api/scripts/" + encodeURIComponent(targetId), "DELETE");
            showToast("Script silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      });

      const keySelect = document.getElementById("keyScriptSelect");
      if (keySelect) {
        const prevVal = keySelect.value;
        const optionsHtml = scripts.length
          ? scripts.map((s) => "<option value='" + escapeHtml(s.name) + "'>" + escapeHtml(s.name) + "</option>").join("")
          : "<option value='Ümumi'>Ümumi</option>";
        keySelect.innerHTML = optionsHtml;
        if (prevVal) keySelect.value = prevVal;
      }

      const wlScriptSelect = document.getElementById("whitelistScriptSelect");
      if (wlScriptSelect) {
        const prevWlVal = wlScriptSelect.value;
        const wlOptionsHtml = scripts.length
          ? scripts.map((s) => "<option value='" + escapeHtml(s.name) + "'>" + escapeHtml(s.name) + "</option>").join("")
          : "<option value='Ümumi'>Ümumi</option>";
        wlScriptSelect.innerHTML = wlOptionsHtml;
        if (prevWlVal) wlScriptSelect.value = prevWlVal;
      }

      const keys = Array.isArray(snap.keys) ? snap.keys : [];
      const keysBody = document.getElementById("keysTableBody");
      keysBody.innerHTML = keys.length
        ? keys
            .map((k) => {
              return (
                "<tr>" +
                "<td><code>" + escapeHtml(k.key) + "</code></td>" +
                "<td>" + escapeHtml(k.owner || "Ümumi") + "</td>" +
                "<td>" + escapeHtml(k.scriptName || "Ümumi") + "</td>" +
                "<td>" + (Number(k.days) > 0 ? escapeHtml(k.days) + " gün" : "Limitsiz") + "</td>" +
                "<td>" + escapeHtml(k.hwid || "Boş") + "</td>" +
                "<td><button class='btn btn-danger btn-sm btn-del-key' data-id='" + escapeHtml(k.id) + "'>Sil</button></td>" +
                "</tr>"
              );
            })
            .join("")
        : "<tr><td colspan='6' style='color:#94a3b8;'>Hələ key yaradılmayıb.</td></tr>";

      keysBody.querySelectorAll(".btn-del-key").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const targetId = btn.getAttribute("data-id");
          try {
            await apiRequest("/api/keys/" + encodeURIComponent(targetId), "DELETE");
            showToast("Key silindi");
            await refreshDashboardSnapshot();
          } catch (err) {
            showToast(err.message);
          }
        });
      });

      const renderAccessRows = (items, typeName, containerId) => {
        const box = document.getElementById(containerId);
        if (!box) return;
        box.innerHTML = items.length
          ? items
              .map((it) => {
                const keyBadge = it.generatedKey ? " <span class='badge badge-green'>Key: " + escapeHtml(it.generatedKey) + "</span>" : "";
                const scriptBadge = it.scriptName ? " <span class='badge'>Script: " + escapeHtml(it.scriptName) + "</span>" : "";
                return (
                  "<div class='row' style='justify-content:space-between;padding:8px 10px;border:1px solid #1e293b;border-radius:9px;margin-bottom:7px;'>" +
                  "<span>" + escapeHtml(it.value) + scriptBadge + keyBadge + "</span>" +
                  "<button class='btn btn-danger btn-sm btn-del-acc' data-type='" + typeName + "' data-id='" + escapeHtml(it.id) + "'>Sil</button>" +
                  "</div>"
                );
              })
              .join("")
          : "<div style='color:#94a3b8;font-size:13px;'>Siyahı boşdur.</div>";

        box.querySelectorAll(".btn-del-acc").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const t = btn.getAttribute("data-type");
            const id = btn.getAttribute("data-id");
            try {
              await apiRequest("/api/access/" + encodeURIComponent(t) + "/" + encodeURIComponent(id), "DELETE");
              showToast("Qeyd silindi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });
      };

      renderAccessRows(Array.isArray(snap.whitelist) ? snap.whitelist : [], "whitelist", "whitelistContainer");
      renderAccessRows(Array.isArray(snap.blacklist) ? snap.blacklist : [], "blacklist", "blacklistContainer");

      const logs = Array.isArray(snap.auditLogs) ? snap.auditLogs : [];
      const logBox = document.getElementById("auditLogList");
      logBox.innerHTML = logs.length
        ? logs
            .slice(0, 15)
            .map(
              (lg) =>
                "<div style='padding:8px 10px;border:1px solid #1e293b;border-radius:9px;font-size:12px;'>" +
                "<strong>" + escapeHtml(lg.summary) + "</strong>" +
                "<div style='color:#94a3b8;margin-top:3px;'>" + escapeHtml(lg.actor) + " • " + escapeHtml(lg.createdAt) + "</div>" +
                "</div>"
            )
            .join("")
        : "<div style='color:#94a3b8;font-size:13px;'>Hələ əməliyyat qeydi yoxdur.</div>";

      if (snap.panelDesign) {
        const d = snap.panelDesign;
        const activeId = document.activeElement && document.activeElement.id;
        if (activeId !== "designTitleInput") document.getElementById("designTitleInput").value = d.title || "";
        if (activeId !== "designDescInput") document.getElementById("designDescInput").value = d.description || "";
        if (activeId !== "designColorInput") document.getElementById("designColorInput").value = d.colorHex || "#5865F2";
        if (activeId !== "designFooterInput") document.getElementById("designFooterInput").value = d.footerText || "";
        if (activeId !== "designThumbInput") document.getElementById("designThumbInput").value = d.thumbnailUrl || "";
        if (activeId !== "designImageInput") document.getElementById("designImageInput").value = d.imageUrl || "";

        if (!document.getElementById("designButtonsEditor").contains(document.activeElement)) {
          clientState.designerButtons = Array.isArray(d.buttons) ? JSON.parse(JSON.stringify(d.buttons)) : [];
          renderDesignButtonsEditor();
        }
      }
    };

    const refreshDashboardSnapshot = async () => {
      try {
        const querySuffix = clientState.deviceGuildId
          ? "?guildId=" + encodeURIComponent(clientState.deviceGuildId)
          : "";
        const snap = await apiRequest("/api/snapshot" + querySuffix, "GET");
        applySnapshotToUi(snap);
      } catch (err) {
        showToast("Yeniləmə xətası: " + err.message);
      }
    };

    const toggleNewScriptSourceInputs = () => {
      const mode = (document.getElementById("newScriptSourceType") || {}).value || "url";
      const urlGrp = document.getElementById("newScriptUrlGroup");
      const fileGrp = document.getElementById("newScriptFileGroup");
      if (urlGrp) urlGrp.style.display = mode === "file" ? "none" : "block";
      if (fileGrp) fileGrp.style.display = mode === "file" ? "block" : "none";
    };

    const toggleEditScriptSourceInputs = () => {
      const mode = (document.getElementById("editScriptSourceType") || {}).value || "url";
      const urlGrp = document.getElementById("editScriptUrlGroup");
      const fileGrp = document.getElementById("editScriptFileGroup");
      if (urlGrp) urlGrp.style.display = mode === "file" ? "none" : "block";
      if (fileGrp) fileGrp.style.display = mode === "file" ? "block" : "none";
    };

    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll(".nav-item").forEach((navBtn) => {
        navBtn.addEventListener("click", () => {
          document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
          document.querySelectorAll(".tab-section").forEach((sec) => sec.classList.remove("active"));
          navBtn.classList.add("active");
          const tabName = navBtn.getAttribute("data-tab");
          const targetSec = document.getElementById("tab-" + tabName);
          if (targetSec) targetSec.classList.add("active");
        });
      });

      const newSrcSel = document.getElementById("newScriptSourceType");
      if (newSrcSel) {
        newSrcSel.addEventListener("change", toggleNewScriptSourceInputs);
      }

      const editSrcSel = document.getElementById("editScriptSourceType");
      if (editSrcSel) {
        editSrcSel.addEventListener("change", toggleEditScriptSourceInputs);
      }

      const newFileInp = document.getElementById("newScriptFileInput");
      if (newFileInp) {
        newFileInp.addEventListener("change", () => {
          const f = newFileInp.files && newFileInp.files[0];
          const infoEl = document.getElementById("newScriptFileInfo");
          if (!f) {
            clientState.newScriptFilePayload = { fileName: "", content: "" };
            if (infoEl) infoEl.textContent = "Hələ fayl seçilməyib";
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            clientState.newScriptFilePayload = {
              fileName: f.name,
              content: String(reader.result || "")
            };
            if (infoEl) infoEl.textContent = "Seçildi: " + f.name;
          };
          reader.readAsText(f);
        });
      }

      const editFileInp = document.getElementById("editScriptFileInput");
      if (editFileInp) {
        editFileInp.addEventListener("change", () => {
          const f = editFileInp.files && editFileInp.files[0];
          const infoEl = document.getElementById("editScriptFileInfo");
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            clientState.editScriptFilePayload = {
              fileName: f.name,
              content: String(reader.result || "")
            };
            if (infoEl) infoEl.textContent = "Yeni fayl seçildi: " + f.name;
          };
          reader.readAsText(f);
        });
      }

      document.getElementById("refreshSnapshotBtn").addEventListener("click", refreshDashboardSnapshot);

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
            if (res && res.guild && res.guild.guildId) {
              clientState.deviceGuildId = res.guild.guildId;
              localStorage.setItem(CLIENT_GUILD_STORAGE_KEY, res.guild.guildId);
            }
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
              const res = await apiRequest("/api/bot/connect", "POST", { guildId: typedId });
              if (res && res.guild && res.guild.guildId) {
                clientState.deviceGuildId = res.guild.guildId;
                localStorage.setItem(CLIENT_GUILD_STORAGE_KEY, res.guild.guildId);
              }
              await refreshDashboardSnapshot();
            } catch (_err) {}
          }
        });
      }

      const sendQuickPanel = async () => {
        const channelIdVal = document.getElementById("panelChannelIdInput").value.trim();
        try {
          await apiRequest("/api/panel/send", "POST", { channelId: channelIdVal });
          showToast("Panel Discord kanalına göndərildi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      };

      document.getElementById("sendPanelQuickBtn").addEventListener("click", sendQuickPanel);
      document.getElementById("sendDesignedPanelBtn").addEventListener("click", sendQuickPanel);

      document.getElementById("createScriptBtn").addEventListener("click", async () => {
        const name = document.getElementById("newScriptName").value.trim();
        const sourceType = (document.getElementById("newScriptSourceType") || {}).value || "url";
        const scriptUrl = document.getElementById("newScriptUrl").value.trim();
        const description = document.getElementById("newScriptDesc").value.trim();
        try {
          await apiRequest("/api/scripts", "POST", {
            name,
            sourceType,
            scriptUrl,
            fileName: clientState.newScriptFilePayload.fileName,
            scriptContent: clientState.newScriptFilePayload.content,
            description
          });
          document.getElementById("newScriptName").value = "";
          document.getElementById("newScriptUrl").value = "";
          document.getElementById("newScriptDesc").value = "";
          clientState.newScriptFilePayload = { fileName: "", content: "" };
          const fInp = document.getElementById("newScriptFileInput");
          if (fInp) fInp.value = "";
          const fInfo = document.getElementById("newScriptFileInfo");
          if (fInfo) fInfo.textContent = "Hələ fayl seçilməyib";
          showToast("Yeni script yaradıldı");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("updateScriptBtn").addEventListener("click", async () => {
        const id = document.getElementById("editScriptId").value.trim();
        if (!id) {
          showToast("Əvvəlcə cədvəldən Düzəliş Et seçin");
          return;
        }
        const name = document.getElementById("editScriptName").value.trim();
        const sourceType = (document.getElementById("editScriptSourceType") || {}).value || "url";
        const scriptUrl = document.getElementById("editScriptUrl").value.trim();
        const description = document.getElementById("editScriptDesc").value.trim();
        const payload = {
          name,
          sourceType,
          scriptUrl,
          description
        };
        if (sourceType === "file" && clientState.editScriptFilePayload.content) {
          payload.fileName = clientState.editScriptFilePayload.fileName;
          payload.scriptContent = clientState.editScriptFilePayload.content;
        }
        try {
          await apiRequest("/api/scripts/" + encodeURIComponent(id), "PUT", payload);
          showToast("Script yeniləndi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("createKeyBtn").addEventListener("click", async () => {
        const scriptName = document.getElementById("keyScriptSelect").value;
        const days = Number(document.getElementById("keyDaysInput").value || 0);
        const hwid = document.getElementById("keyHwidInput").value.trim();
        try {
          const res = await apiRequest("/api/keys", "POST", { scriptName, days, hwid });
          showToast("Yeni Key yaradıldı: " + (res.key && res.key.key ? res.key.key : ""));
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      ["designTitleInput", "designDescInput", "designColorInput", "designFooterInput", "designThumbInput", "designImageInput"].forEach(
        (inpId) => {
          const el = document.getElementById(inpId);
          if (el) el.addEventListener("input", renderLivePreview);
        }
      );

      document.getElementById("addDesignButtonBtn").addEventListener("click", () => {
        if (clientState.designerButtons.length >= 5) {
          showToast("Maksimum 5 düymə əlavə edilə bilər");
          return;
        }
        clientState.designerButtons.push({
          id: "custom_btn_" + (clientState.designerButtons.length + 1),
          label: "Yeni Düymə",
          style: 1,
          emoji: "✨",
          responseText: "Əməliyyat icra edildi."
        });
        renderDesignButtonsEditor();
      });

      document.getElementById("saveDesignBtn").addEventListener("click", async () => {
        try {
          await apiRequest("/api/design", "PUT", {
            title: document.getElementById("designTitleInput").value,
            description: document.getElementById("designDescInput").value,
            colorHex: document.getElementById("designColorInput").value,
            footerText: document.getElementById("designFooterInput").value,
            thumbnailUrl: document.getElementById("designThumbInput").value,
            imageUrl: document.getElementById("designImageInput").value,
            buttons: clientState.designerButtons
          });
          showToast("Panel dizaynı yadda saxlanıldı");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("addWhitelistBtn").addEventListener("click", async () => {
        const val = document.getElementById("whitelistValueInput").value.trim();
        const scriptName = (document.getElementById("whitelistScriptSelect") || {}).value || "Ümumi";
        try {
          const res = await apiRequest("/api/access", "POST", { listType: "whitelist", value: val, scriptName });
          document.getElementById("whitelistValueInput").value = "";
          showToast("Whitelist + Key yaradıldı (" + scriptName + "): " + (res.generatedKey || ""));
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("addBlacklistBtn").addEventListener("click", async () => {
        const val = document.getElementById("blacklistValueInput").value.trim();
        try {
          await apiRequest("/api/access", "POST", { listType: "blacklist", value: val });
          document.getElementById("blacklistValueInput").value = "";
          showToast("Blacklist-ə əlavə edildi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      refreshDashboardSnapshot();
      setInterval(refreshDashboardSnapshot, 8000);
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(renderDashboardHtmlPage());
      return;
    }

    if (method === "GET" && pathname === "/health") {
      sendJsonResponse(res, 200, {
        ok: true,
        botConnected: BOT_RUNTIME.connected,
        guildId: APP_STATE.guildId,
        guildName: APP_STATE.guildName
      });
      return;
    }

    if (method === "GET" && pathname === "/api/snapshot") {
      const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
      const snapshot = await buildPublicSnapshotPayload(targetGuildId);
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
      const tenant = getTenantRecordByGuildId(cleanGuildId);
      tenant.guildName = resolvedName || sanitizeText(body.guildName, "") || "Bağlı Sunucu";
      if (cleanChannelId) {
        tenant.panelChannelId = cleanChannelId;
      }

      if (!sanitizeSnowflakeId(APP_STATE.guildId)) {
        APP_STATE.guildId = cleanGuildId;
      }
      syncTenantIntoGlobalIfPrimary(tenant);

      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(cleanGuildId);
      appendAuditLog(
        "GUILD_CONNECTED",
        `Sunucu bağlandı: ${tenant.guildName} (${cleanGuildId})`,
        "Dashboard",
        cleanGuildId
      );

      const snapshot = await buildPublicSnapshotPayload(cleanGuildId);
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
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const result = await publishPanelToDiscordChannel(body.channelId, body.scriptName, reqGuildId);
      if (!result.ok) {
        sendJsonResponse(res, 400, { error: result.error });
        return;
      }
      sendJsonResponse(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/scripts") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə İdarəetmə bölməsindən öz Sunucu ID-nizi bağlayın" });
        return;
      }

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
        guildId: tenant.guildId,
        name: scriptName,
        sourceType,
        scriptUrl,
        fileName:
          fileName || (sourceType === "file" ? `${scriptName.toLowerCase().replace(/\s+/g, "_")}.lua` : ""),
        scriptContent,
        description,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      tenant.scripts = [newScript, ...(tenant.scripts || [])];
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(tenant.guildId);
      appendAuditLog(
        "SCRIPT_CREATED",
        `Yeni script yaradıldı: ${scriptName} (${tenant.guildName})`,
        "Dashboard",
        tenant.guildId
      );

      sendJsonResponse(res, 201, { ok: true, script: newScript });
      return;
    }

    if (method === "PUT" && pathname.startsWith("/api/scripts/")) {
      const targetId = sanitizeText(pathname.replace("/api/scripts/", ""), "");
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      const scriptsTarget = tenant ? tenant.scripts || [] : APP_STATE.scripts || [];
      const index = scriptsTarget.findIndex((s) => s && s.id === targetId);

      if (index === -1) {
        sendJsonResponse(res, 404, { error: "Script tapılmadı" });
        return;
      }

      const currentItem = scriptsTarget[index];
      const nextSourceType =
        body.sourceType === "file" ? "file" : body.sourceType === "url" ? "url" : currentItem.sourceType;
      const updatedItem = {
        ...currentItem,
        name: sanitizeText(body.name, currentItem.name),
        sourceType: nextSourceType,
        fileName:
          body.fileName !== undefined
            ? sanitizeText(body.fileName, currentItem.fileName)
            : nextSourceType === "file" && !currentItem.fileName
            ? `${sanitizeText(body.name, currentItem.name).toLowerCase().replace(/\s+/g, "_")}.lua`
            : currentItem.fileName,
        scriptUrl: body.scriptUrl !== undefined ? sanitizeText(body.scriptUrl, "") : currentItem.scriptUrl,
        scriptContent:
          body.scriptContent !== undefined ? String(body.scriptContent) : currentItem.scriptContent,
        description:
          body.description !== undefined ? sanitizeText(body.description, "") : currentItem.description,
        updatedAt: new Date().toISOString()
      };

      scriptsTarget[index] = updatedItem;
      if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(tenant ? tenant.guildId : "");
      appendAuditLog(
        "SCRIPT_UPDATED",
        `Script yeniləndi: ${updatedItem.name}`,
        "Dashboard",
        tenant ? tenant.guildId : ""
      );

      sendJsonResponse(res, 200, { ok: true, script: updatedItem });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/scripts/")) {
      const targetId = sanitizeText(pathname.replace("/api/scripts/", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      const scriptsTarget = tenant ? tenant.scripts || [] : APP_STATE.scripts || [];
      const beforeCount = scriptsTarget.length;
      const filteredScripts = scriptsTarget.filter((s) => s && s.id !== targetId);

      if (filteredScripts.length === beforeCount) {
        sendJsonResponse(res, 404, { error: "Script tapılmadı" });
        return;
      }

      if (tenant) {
        tenant.scripts = filteredScripts;
        syncTenantIntoGlobalIfPrimary(tenant);
      } else {
        APP_STATE.scripts = filteredScripts;
      }
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(tenant ? tenant.guildId : "");
      appendAuditLog(
        "SCRIPT_DELETED",
        `Script silindi (${targetId})`,
        "Dashboard",
        tenant ? tenant.guildId : ""
      );

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/keys") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə İdarəetmə bölməsindən öz Sunucu ID-nizi bağlayın" });
        return;
      }

      const scriptName = sanitizeText(body.scriptName, "Ümumi");
      const days = Math.max(0, Number(body.days || 0));

      const newKey = {
        id: generateUniqueId("key"),
        guildId: tenant.guildId,
        key: generateLicenseKeyString(),
        scriptName,
        days,
        hwid: sanitizeText(body.hwid, ""),
        hwidResetCount: 0,
        active: true,
        createdAt: new Date().toISOString()
      };

      tenant.keys = [newKey, ...(tenant.keys || [])];
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("KEY_CREATED", `Key yaradıldı (${newKey.key})`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 201, { ok: true, key: newKey });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/keys/")) {
      const keyId = sanitizeText(pathname.replace("/api/keys/", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      const keysArr = tenant ? tenant.keys || [] : APP_STATE.keys || [];
      const targetKeyObj = keysArr.find((k) => k && k.id === keyId) || null;
      const filteredKeys = keysArr.filter((k) => k && k.id !== keyId);

      if (tenant) {
        tenant.keys = filteredKeys;
      } else {
        APP_STATE.keys = filteredKeys;
      }

      if (targetKeyObj) {
        const targetKeyCode = sanitizeText(targetKeyObj.key, "");
        const targetOwnerTokens = collectUserMatchTokens(targetKeyObj.owner, targetKeyObj);
        const targetScriptLower = sanitizeText(targetKeyObj.scriptName, "").toLowerCase();
        const wlArr = tenant ? tenant.whitelist || [] : APP_STATE.whitelist || [];

        const cleanedWl = wlArr.filter((w) => {
          if (!w) return false;
          if (targetKeyCode && sanitizeText(w.generatedKey, "") === targetKeyCode) {
            return false;
          }
          const wScriptLower = sanitizeText(w.scriptName, "").toLowerCase();
          const sameScript =
            !targetScriptLower ||
            targetScriptLower === "ümumi" ||
            !wScriptLower ||
            wScriptLower === "ümumi" ||
            wScriptLower === targetScriptLower;
          if (!sameScript) return true;

          const wTokens = collectUserMatchTokens(w.value, {
            owner: w.value,
            ownerId: w.userId || "",
            key: w.generatedKey || ""
          });
          for (const tk of targetOwnerTokens) {
            if (wTokens.has(tk)) {
              const hasAnotherActiveKey = filteredKeys.some((otherK) => {
                if (!otherK || otherK.active === false) return false;
                const otherScriptLower = sanitizeText(otherK.scriptName, "").toLowerCase();
                if (
                  wScriptLower &&
                  wScriptLower !== "ümumi" &&
                  otherScriptLower &&
                  otherScriptLower !== "ümumi" &&
                  otherScriptLower !== wScriptLower
                ) {
                  return false;
                }
                const otherTokens = collectUserMatchTokens(otherK.owner, otherK);
                return otherTokens.has(tk);
              });
              if (!hasAnotherActiveKey) return false;
            }
          }
          return true;
        });

        if (tenant) {
          tenant.whitelist = cleanedWl;
        } else {
          APP_STATE.whitelist = cleanedWl;
        }
      }

      if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog(
        "KEY_DELETED",
        `Key silindi: ${targetKeyObj ? targetKeyObj.key : keyId}`,
        "Dashboard",
        tenant ? tenant.guildId : ""
      );
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "PUT" && pathname === "/api/design") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə İdarəetmə bölməsindən öz Sunucu ID-nizi bağlayın" });
        return;
      }

      tenant.panelDesign = normalizePanelDesign(body);
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("DESIGN_UPDATED", "Panel dizaynı yeniləndi", "Dashboard", tenant.guildId);

      sendJsonResponse(res, 200, { ok: true, panelDesign: tenant.panelDesign });
      return;
    }

    if (method === "POST" && pathname === "/api/access") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə İdarəetmə bölməsindən öz Sunucu ID-nizi bağlayın" });
        return;
      }

      const listType = sanitizeText(body.listType, "whitelist") === "blacklist" ? "blacklist" : "whitelist";
      const val = sanitizeText(body.value, "");
      const chosenScriptName = sanitizeText(body.scriptName, "Ümumi");

      if (!val) {
        sendJsonResponse(res, 400, { error: "Dəyər daxil edilməlidir" });
        return;
      }

      let generatedKeyValue = "";
      if (listType === "whitelist") {
        generatedKeyValue = generateLicenseKeyString();
        const autoKeyRecord = {
          id: generateUniqueId("key"),
          guildId: tenant.guildId,
          key: generatedKeyValue,
          owner: val,
          scriptName: chosenScriptName,
          days: 0,
          hwid: "",
          hwidResetCount: 0,
          active: true,
          createdAt: new Date().toISOString()
        };
        tenant.keys = [autoKeyRecord, ...(tenant.keys || [])];
      } else {
        tenant.whitelist = (tenant.whitelist || []).filter(
          (item) => item && normalizeAccessValue(item.value) !== normalizeAccessValue(val)
        );
        tenant.keys = (tenant.keys || []).map((k) => {
          if (k && normalizeAccessValue(k.owner) === normalizeAccessValue(val)) {
            return { ...k, active: false };
          }
          return k;
        });
      }

      const entry = {
        id: generateUniqueId("acc"),
        value: val,
        scriptName: listType === "whitelist" ? chosenScriptName : "",
        generatedKey: generatedKeyValue,
        createdAt: new Date().toISOString()
      };

      tenant[listType] = [entry, ...(tenant[listType] || [])];
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog(
        "ACCESS_ADDED",
        `${listType.toUpperCase()} əlavə edildi: ${val}${
          listType === "whitelist" ? ` | Script: ${chosenScriptName}` : ""
        }${generatedKeyValue ? ` | Key: ${generatedKeyValue}` : ""}`,
        "Dashboard",
        tenant.guildId
      );

      sendJsonResponse(res, 201, { ok: true, entry, generatedKey: generatedKeyValue });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/access/")) {
      const parts = pathname.replace("/api/access/", "").split("/");
      const listType = parts[0] === "blacklist" ? "blacklist" : "whitelist";
      const entryId = sanitizeText(parts[1] || "", "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      const listArr = tenant ? tenant[listType] || [] : APP_STATE[listType] || [];
      const targetEntry = listArr.find((item) => item && item.id === entryId);
      const updatedListArr = listArr.filter((item) => item && item.id !== entryId);

      if (tenant) {
        tenant[listType] = updatedListArr;
      } else {
        APP_STATE[listType] = updatedListArr;
      }

      if (listType === "whitelist" && targetEntry && targetEntry.value) {
        const targetNorm = normalizeAccessValue(targetEntry.value);
        const wlCheck = tenant ? tenant.whitelist : APP_STATE.whitelist;
        const stillWhitelisted = (wlCheck || []).some((w) => w && normalizeAccessValue(w.value) === targetNorm);
        if (!stillWhitelisted) {
          const keysArr = tenant ? tenant.keys || [] : APP_STATE.keys || [];
          const filteredKeys = keysArr.filter(
            (k) =>
              k &&
              normalizeAccessValue(k.owner) !== targetNorm &&
              sanitizeText(k.key, "") !== sanitizeText(targetEntry.generatedKey, "")
          );
          if (tenant) tenant.keys = filteredKeys;
          else APP_STATE.keys = filteredKeys;
        }
      }

      if (tenant) syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog(
        "ACCESS_REMOVED",
        `${listType.toUpperCase()} silindi: ${targetEntry ? targetEntry.value : entryId}`,
        "Dashboard",
        tenant ? tenant.guildId : ""
      );
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname.startsWith("/raw/")) {
      if (!isRobloxExecutorRequest(req)) {
        res.writeHead(403, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(buildAntiLeakBlockedLua());
        return;
      }

      const scId = sanitizeText(pathname.replace("/raw/", ""), "");
      let ownerTenant = null;
      let found = (APP_STATE.scripts || []).find((s) => s && s.id === scId) || null;
      if (!found) {
        for (const tRec of Object.values(ensureTenantStore())) {
          const matchInTenant = (tRec.scripts || []).find((s) => s && s.id === scId);
          if (matchInTenant) {
            found = matchInTenant;
            ownerTenant = tRec;
            break;
          }
        }
      } else if (found.guildId) {
        ownerTenant = getTenantRecordByGuildId(found.guildId);
      }

      if (!found) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload("Script tapılmadı — Kick edildi"));
        return;
      }

      const activeKeysPool = ownerTenant ? ownerTenant.keys || [] : APP_STATE.keys || [];
      const activeWhitelistPool = ownerTenant ? ownerTenant.whitelist || [] : APP_STATE.whitelist || [];
      const activeBlacklistPool = ownerTenant ? ownerTenant.blacklist || [] : APP_STATE.blacklist || [];

      const providedKeyQuery = sanitizeText(reqUrl.searchParams.get("key") || req.headers["x-sado-key"], "");
      const cleanLowerQuery = providedKeyQuery.toLowerCase();
      const matchedKey = providedKeyQuery
        ? activeKeysPool.find(
            (k) =>
              k &&
              (sanitizeText(k.key, "").toLowerCase() === cleanLowerQuery ||
                sanitizeText(k.owner, "").toLowerCase() === cleanLowerQuery ||
                sanitizeText(k.ownerId, "").toLowerCase() === cleanLowerQuery)
          ) || null
        : null;
      const identityCheck = (matchedKey && matchedKey.owner) || providedKeyQuery;

      const isBlacklistedInPool = activeBlacklistPool.some((item) => {
        if (!item) return false;
        const tks = collectUserMatchTokens(item.value, { owner: item.value, ownerId: item.userId || "" });
        return (
          tks.has(normalizeAccessValue(identityCheck)) ||
          (matchedKey && matchedKey.ownerId && tks.has(normalizeAccessValue(matchedKey.ownerId)))
        );
      });

      if (!matchedKey || matchedKey.active === false || isBlacklistedInPool) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload("Etibarlı Key olmadan scriptə icazə verilmir — Kick edildi"));
        return;
      }

      const rawKeyScriptLower = sanitizeText(matchedKey.scriptName, "").toLowerCase();
      if (
        rawKeyScriptLower &&
        rawKeyScriptLower !== "ümumi" &&
        rawKeyScriptLower !== "hamısı" &&
        rawKeyScriptLower !== sanitizeText(found.name, "").toLowerCase()
      ) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload(`Bu Key yalnız ${matchedKey.scriptName} scripti ucundur — Kick edildi`));
        return;
      }

      const whitelisted = activeWhitelistPool.some((item) => {
        if (!item) return false;
        const itemScriptLower = sanitizeText(item.scriptName, "").toLowerCase();
        if (
          itemScriptLower &&
          itemScriptLower !== "ümumi" &&
          itemScriptLower !== "hamısı" &&
          itemScriptLower !== sanitizeText(found.name, "").toLowerCase()
        ) {
          return false;
        }
        const tks = collectUserMatchTokens(item.value, {
          owner: item.value,
          ownerId: item.userId || "",
          key: item.generatedKey || ""
        });
        return (
          tks.has(normalizeAccessValue(identityCheck)) ||
          (matchedKey.ownerId && tks.has(normalizeAccessValue(matchedKey.ownerId))) ||
          tks.has(normalizeAccessValue(matchedKey.key))
        );
      });
      if (!whitelisted && activeWhitelistPool.length > 0) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload(`${found.name} scripti ucun Whitelist-de deyilsiniz — Kick edildi`));
        return;
      }

      const incomingDeviceHwid = sanitizeText(
        reqUrl.searchParams.get("hwid") ||
          req.headers["x-sado-hwid"] ||
          req.headers["syn-fingerprint"] ||
          req.headers["exploit-guid"],
        ""
      );

      if (matchedKey.hwid && incomingDeviceHwid && matchedKey.hwid !== incomingDeviceHwid) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildDeviceKickLuaPayload("Bu açar başqa cihaza bağlıdır — Kick edildi"));
        return;
      }

      if (!matchedKey.hwid && incomingDeviceHwid) {
        matchedKey.hwid = incomingDeviceHwid;
        matchedKey.boundAt = new Date().toISOString();
        if (ownerTenant) syncTenantIntoGlobalIfPrimary(ownerTenant);
        saveAppStateToDisk();
      }

      const basePublicUrl = sanitizeText(process.env.RENDER_EXTERNAL_URL, `http://localhost:${PORT}`).replace(
        /\/+$/,
        ""
      );
      const rawSelfUrl = `${basePublicUrl}/raw/${found.id}`;
      const effectiveBoundHwid = matchedKey.hwid || incomingDeviceHwid || "";

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache"
      });
      if (found.sourceType === "file" && found.scriptContent) {
        res.end(
          wrapScriptWithAntiLeakProtection(found.scriptContent, effectiveBoundHwid, rawSelfUrl, matchedKey.key)
        );
        return;
      }
      const remoteLoaderCode = `loadstring(game:HttpGet("${sanitizeText(found.scriptUrl, "")}"))()`;
      res.end(
        wrapScriptWithAntiLeakProtection(remoteLoaderCode, effectiveBoundHwid, rawSelfUrl, matchedKey.key)
      );
      return;
    }

    sendJsonResponse(res, 404, { error: "Səhifə tapılmadı" });
  } catch (err) {
    sendJsonResponse(res, 500, { error: err.message || "Server xətası" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  startDiscordBotRuntime();
  startSelfKeepAliveLoop();
});
