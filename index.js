const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

let WebSocketClient = null;
try {
  WebSocketClient = require("ws");
} catch (_wsErr) {
  WebSocketClient = null;
}

const SERVER_PORT = Number(process.env.PORT || 3000);
const DATA_DIR_PATH = path.join(__dirname, "data");
const STATE_FILE_PATH = path.join(DATA_DIR_PATH, "sado-state.json");
const DISCORD_INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const DEFAULT_PANEL_DESIGN = {
  title: "SADO PROTECT • Lisenziya & Script Paneli",
  description:
    "Aşağıdakı düymələrdən istifadə edərək lisenziya açarınızı aktivləşdirə, HWID sıfırlaya və ya scriptinizi əldə edə bilərsiniz.",
  colorHex: "#6366f1",
  footerText: "SADO PROTECT • Premium Təhlükəsizlik Sistemi",
  imageUrl: "",
  buttons: [
    { id: "btn_redeem_key", label: "Reedem Key", emoji: "🔑", style: "Primary", enabled: true },
    { id: "btn_get_script", label: "Get Script", emoji: "📜", style: "Success", enabled: true },
    { id: "btn_reset_hwid", label: "Reset HWID", emoji: "⚙️", style: "Danger", enabled: true },
    { id: "btn_stats", label: "Statistikam", emoji: "📊", style: "Secondary", enabled: true }
  ]
};

const PLAN_CONFIGS = {
  free: {
    id: "free",
    label: "Free",
    priceLabel: "Pulsuz",
    scriptLimit: 1
  },
  premium_1: {
    id: "premium_1",
    label: "Premium (1$)",
    priceLabel: "1$",
    scriptLimit: 5
  },
  premium_2: {
    id: "premium_2",
    label: "Premium (2$)",
    priceLabel: "2$",
    scriptLimit: null
  }
};

const normalizePlanTier = (rawTier) => {
  const clean = String(rawTier || "").trim().toLowerCase();
  if (clean === "premium_2" || clean === "2$" || clean === "2" || clean === "lifetime" || clean === "unlimited") {
    return "premium_2";
  }
  if (clean === "premium_1" || clean === "1$" || clean === "1" || clean === "premium") {
    return "premium_1";
  }
  return "free";
};

const getPlanConfigByTier = (tierInput) => {
  const norm = normalizePlanTier(tierInput);
  return PLAN_CONFIGS[norm] || PLAN_CONFIGS.free;
};

const ensureStorageDirectory = () => {
  try {
    if (!fs.existsSync(DATA_DIR_PATH)) {
      fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    }
  } catch (_err) {}
};

const sanitizeText = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  return value.trim();
};

const sanitizeSnowflakeId = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{15,22}$/.test(digits) ? digits : "";
};

const generateUniqueId = (prefix = "id") => {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
};

const generateLicenseKeyString = () => {
  const partA = crypto.randomBytes(2).toString("hex").toUpperCase();
  const partB = crypto.randomBytes(2).toString("hex").toUpperCase();
  const partC = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `SADO-${partA}-${partB}-${partC}`;
};

const generateApiKeyString = () => {
  const p1 = crypto.randomBytes(3).toString("hex").toUpperCase();
  const p2 = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `SADO-API-${p1}-${p2}`;
};

const normalizeHexColor = (hexInput) => {
  const clean = String(hexInput || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) return clean;
  return "#6366f1";
};

const normalizeButtonStyle = (styleInput) => {
  const valid = ["Primary", "Secondary", "Success", "Danger"];
  return valid.includes(styleInput) ? styleInput : "Primary";
};

const normalizePanelDesign = (rawDesign) => {
  const source = rawDesign && typeof rawDesign === "object" ? rawDesign : {};
  const rawButtons = Array.isArray(source.buttons) ? source.buttons : DEFAULT_PANEL_DESIGN.buttons;
  const buttonMap = new Map();

  for (const btn of rawButtons) {
    if (!btn || !btn.id) continue;
    const defaultMatch = DEFAULT_PANEL_DESIGN.buttons.find((d) => d.id === btn.id);
    if (!defaultMatch) continue;
    buttonMap.set(btn.id, {
      id: btn.id,
      label: sanitizeText(btn.label, defaultMatch.label).slice(0, 40) || defaultMatch.label,
      emoji: sanitizeText(btn.emoji, defaultMatch.emoji).slice(0, 8),
      style: normalizeButtonStyle(btn.style || defaultMatch.style),
      enabled: typeof btn.enabled === "boolean" ? btn.enabled : true
    });
  }

  const orderedButtons = [];
  for (const btn of rawButtons) {
    if (btn && btn.id && buttonMap.has(btn.id)) {
      orderedButtons.push(buttonMap.get(btn.id));
      buttonMap.delete(btn.id);
    }
  }
  for (const defBtn of DEFAULT_PANEL_DESIGN.buttons) {
    if (buttonMap.has(defBtn.id)) {
      orderedButtons.push(buttonMap.get(defBtn.id));
    }
  }

  return {
    title: sanitizeText(source.title, DEFAULT_PANEL_DESIGN.title).slice(0, 120) || DEFAULT_PANEL_DESIGN.title,
    description:
      sanitizeText(source.description, DEFAULT_PANEL_DESIGN.description).slice(0, 600) ||
      DEFAULT_PANEL_DESIGN.description,
    colorHex: normalizeHexColor(source.colorHex),
    footerText:
      sanitizeText(source.footerText, DEFAULT_PANEL_DESIGN.footerText).slice(0, 120) ||
      DEFAULT_PANEL_DESIGN.footerText,
    imageUrl: sanitizeText(source.imageUrl, "").slice(0, 400),
    buttons: orderedButtons
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
    apiKeys: [],
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
    APP_STATE.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(APP_STATE, null, 2), "utf8");
  } catch (_err) {}
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
      planTier: "free",
      boundApiKey: "",
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
  if (!tenants[cleanGid].planTier) {
    tenants[cleanGid].planTier = "free";
  }
  if (tenants[cleanGid].boundApiKey === undefined) {
    tenants[cleanGid].boundApiKey = "";
  }
  return tenants[cleanGid];
};

const resolveTenantEffectivePlan = (tenantRec) => {
  if (!tenantRec) return getPlanConfigByTier("free");
  const apiList = Array.isArray(APP_STATE.apiKeys) ? APP_STATE.apiKeys : [];
  const boundKeyStr = sanitizeText(tenantRec.boundApiKey, "");
  if (boundKeyStr) {
    const matchedApi = apiList.find(
      (ak) => ak && ak.active !== false && sanitizeText(ak.key, "") === boundKeyStr
    );
    if (matchedApi) {
      return getPlanConfigByTier(matchedApi.planTier);
    }
  }
  return getPlanConfigByTier(tenantRec.planTier);
};

const syncTenantIntoGlobalIfPrimary = (tenantRec) => {
  if (!tenantRec) return;
  const primaryGid = sanitizeSnowflakeId(APP_STATE.guildId);
  if (primaryGid && primaryGid === tenantRec.guildId) {
    APP_STATE.guildName = tenantRec.guildName || APP_STATE.guildName;
    APP_STATE.panelChannelId = tenantRec.panelChannelId || APP_STATE.panelChannelId;
    APP_STATE.scripts = tenantRec.scripts;
    APP_STATE.keys = tenantRec.keys;
    APP_STATE.whitelist = tenantRec.whitelist;
    APP_STATE.blacklist = tenantRec.blacklist;
    APP_STATE.panelDesign = normalizePanelDesign(tenantRec.panelDesign);
    APP_STATE.auditLogs = tenantRec.auditLogs;
  }
};

const appendAuditLog = (action, detail, actor = "System", targetGuildId = "") => {
  const entry = {
    id: generateUniqueId("log"),
    action,
    detail,
    actor,
    guildId: sanitizeSnowflakeId(targetGuildId),
    createdAt: new Date().toISOString()
  };
  const cleanGid = sanitizeSnowflakeId(targetGuildId);
  if (cleanGid) {
    const tenant = getTenantRecordByGuildId(cleanGid);
    if (tenant) {
      tenant.auditLogs = [entry, ...(Array.isArray(tenant.auditLogs) ? tenant.auditLogs : [])].slice(0, 120);
      syncTenantIntoGlobalIfPrimary(tenant);
    }
  }
  APP_STATE.auditLogs = [entry, ...(Array.isArray(APP_STATE.auditLogs) ? APP_STATE.auditLogs : [])].slice(0, 120);
  saveAppStateToDisk();
};

const BOT_RUNTIME = {
  connected: false,
  botUserId: "",
  botUsername: "",
  lastError: "",
  lastConnectedAt: "",
  socket: null,
  heartbeatTimer: null,
  reconnectTimer: null,
  seq: null,
  sessionId: "",
  resumeGatewayUrl: "",
  guildNames: {}
};

const resolveDiscordBotToken = () => {
  const raw =
    process.env.DISCORD_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.DISCORD_TOKEN ||
    "";
  return String(raw).trim();
};

const discordRestRequest = (method, endpointPath, bodyPayload = null, customToken = "") => {
  return new Promise((resolve, reject) => {
    const token = String(customToken || resolveDiscordBotToken()).trim();
    if (!token) {
      reject(new Error("DISCORD_BOT_TOKEN təyin edilməyib"));
      return;
    }

    const fullUrl = new URL(`${DISCORD_API_BASE}${endpointPath}`);
    const payloadStr = bodyPayload !== null ? JSON.stringify(bodyPayload) : null;

    const options = {
      hostname: fullUrl.hostname,
      port: 443,
      path: `${fullUrl.pathname}${fullUrl.search}`,
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "SadoProtectBot (https://sado-protect.local, 1.0.0)"
      }
    };

    if (payloadStr !== null) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(payloadStr);
    }

    const req = https.request(options, (res) => {
      let rawChunks = "";
      res.on("data", (chunk) => {
        rawChunks += chunk.toString("utf8");
      });
      res.on("end", () => {
        let parsedJson = null;
        if (rawChunks) {
          try {
            parsedJson = JSON.parse(rawChunks);
          } catch (_e) {
            parsedJson = rawChunks;
          }
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsedJson);
        } else {
          const errMsg =
            parsedJson && typeof parsedJson === "object" && parsedJson.message
              ? `${parsedJson.message} (HTTP ${res.statusCode})`
              : `Discord API xətası (HTTP ${res.statusCode})`;
          reject(new Error(errMsg));
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (payloadStr !== null) {
      req.write(payloadStr);
    }
    req.end();
  });
};

const fetchGuildInfoFromDiscord = async (guildId) => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return null;
  try {
    const guildData = await discordRestRequest("GET", `/guilds/${cleanId}`);
    if (guildData && guildData.name) {
      BOT_RUNTIME.guildNames[cleanId] = String(guildData.name);
      return guildData;
    }
  } catch (_err) {}
  return null;
};

const resolveGuildDisplayName = async (guildId, fallbackName = "") => {
  const cleanId = sanitizeSnowflakeId(guildId);
  if (!cleanId) return "";
  if (BOT_RUNTIME.guildNames[cleanId]) {
    return BOT_RUNTIME.guildNames[cleanId];
  }
  const guildData = await fetchGuildInfoFromDiscord(cleanId);
  if (guildData && guildData.name) {
    return String(guildData.name);
  }
  return sanitizeText(fallbackName, "");
};

const getScriptsForGuild = (guildId) => {
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanGid) return [];
  const tenant = getTenantRecordByGuildId(cleanGid);
  if (tenant && Array.isArray(tenant.scripts)) {
    return tenant.scripts;
  }
  return [];
};

const getKeysForGuild = (guildId) => {
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanGid) return [];
  const tenant = getTenantRecordByGuildId(cleanGid);
  return tenant && Array.isArray(tenant.keys) ? tenant.keys : [];
};

const getWhitelistForGuild = (guildId) => {
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanGid) return [];
  const tenant = getTenantRecordByGuildId(cleanGid);
  return tenant && Array.isArray(tenant.whitelist) ? tenant.whitelist : [];
};

const getBlacklistForGuild = (guildId) => {
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanGid) return [];
  const tenant = getTenantRecordByGuildId(cleanGid);
  return tenant && Array.isArray(tenant.blacklist) ? tenant.blacklist : [];
};

const getDesignForGuild = (guildId) => {
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanGid) return normalizePanelDesign(DEFAULT_PANEL_DESIGN);
  const tenant = getTenantRecordByGuildId(cleanGid);
  return tenant ? normalizePanelDesign(tenant.panelDesign) : normalizePanelDesign(DEFAULT_PANEL_DESIGN);
};

const buildSlashCommandsPayloadForGuild = (guildId = "") => {
  const guildScripts = getScriptsForGuild(guildId).slice(0, 25);
  const scriptChoices = guildScripts.map((sc) => ({
    name: String(sc.name || "Script").slice(0, 100),
    value: String(sc.id)
  }));

  const scriptOptionBase = {
    name: "script",
    description: "Script seçin",
    type: 3,
    required: false,
    autocomplete: true
  };
  if (scriptChoices.length > 0) {
    scriptOptionBase.choices = scriptChoices;
  }

  const requiredScriptOption = {
    name: "script",
    description: "Hansı script üçün Whitelist edilsin?",
    type: 3,
    required: true,
    autocomplete: true
  };
  if (scriptChoices.length > 0) {
    requiredScriptOption.choices = scriptChoices;
  }

  return [
    {
      name: "panel",
      description: "Lisenziya və Script idarəetmə panelini göndər",
      options: [
        {
          name: "script",
          description: "Panel açılacaq mövcud scripti seçin",
          type: 3,
          required: false,
          autocomplete: true,
          ...(scriptChoices.length > 0 ? { choices: scriptChoices } : {})
        }
      ]
    },
    {
      name: "whitelist",
      description: "İstifadəçini seçilən scriptin Whitelist siyahısına əlavə et",
      options: [
        {
          name: "user",
          description: "Discord İstifadəçi ID və ya @mention",
          type: 3,
          required: true
        },
        requiredScriptOption
      ]
    },
    {
      name: "unwhitelist",
      description: "İstifadəçini Whitelist siyahısından çıxar",
      options: [
        {
          name: "user",
          description: "Discord İstifadəçi ID və ya @mention",
          type: 3,
          required: true
        },
        scriptOptionBase
      ]
    },
    {
      name: "key",
      description: "Lisenziya açarını aktivləşdir və HWID bağla",
      options: [
        {
          name: "key",
          description: "SADO-XXXX-XXXX-XXXX açarını daxil edin",
          type: 3,
          required: true
        },
        {
          name: "hwid",
          description: "Cihaz / Executor HWID (istəyə bağlı)",
          type: 3,
          required: false
        }
      ]
    },
    {
      name: "scripts",
      description: "Bu sunucudakı mövcud scriptləri göstər"
    },
    {
      name: "status",
      description: "SADO PROTECT sistem və bot statusunu göstər"
    }
  ];
};

const syncSlashCommandsWithDiscord = async (targetGuildId = "") => {
  const token = resolveDiscordBotToken();
  if (!token || !BOT_RUNTIME.botUserId) return;

  const cleanGuildId = sanitizeSnowflakeId(targetGuildId);
  const commandsPayload = buildSlashCommandsPayloadForGuild(cleanGuildId);

  try {
    if (cleanGuildId) {
      await discordRestRequest(
        "PUT",
        `/applications/${BOT_RUNTIME.botUserId}/guilds/${cleanGuildId}/commands`,
        commandsPayload
      );
    } else {
      await discordRestRequest(
        "PUT",
        `/applications/${BOT_RUNTIME.botUserId}/commands`,
        commandsPayload
      );
    }
  } catch (_err) {}
};

const mapButtonStyleToDiscordInt = (styleStr) => {
  switch (styleStr) {
    case "Secondary":
      return 2;
    case "Success":
      return 3;
    case "Danger":
      return 4;
    case "Primary":
    default:
      return 1;
  }
};

const hexColorToDiscordInt = (hexStr) => {
  const clean = normalizeHexColor(hexStr).replace("#", "");
  const parsed = parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : 0x6366f1;
};

const resolveScriptSourceLabel = (scriptObj) => {
  if (!scriptObj) return "Təyin edilməyib";
  if (scriptObj.sourceType === "file") {
    return `Fayl (${scriptObj.fileName || "script.lua"})`;
  }
  return scriptObj.scriptUrl ? `URL (${scriptObj.scriptUrl})` : "URL";
};

const buildDiscordPanelMessagePayload = async (guildIdInput = "", selectedScriptIdInput = "") => {
  const cleanGuildId = sanitizeSnowflakeId(guildIdInput);
  const tenant = cleanGuildId ? getTenantRecordByGuildId(cleanGuildId) : null;
  const design = cleanGuildId ? getDesignForGuild(cleanGuildId) : normalizePanelDesign(DEFAULT_PANEL_DESIGN);
  const guildScripts = cleanGuildId ? getScriptsForGuild(cleanGuildId) : [];
  const guildKeys = cleanGuildId ? getKeysForGuild(cleanGuildId) : [];
  const guildWhitelist = cleanGuildId ? getWhitelistForGuild(cleanGuildId) : [];
  const guildBlacklist = cleanGuildId ? getBlacklistForGuild(cleanGuildId) : [];
  const activePlan = resolveTenantEffectivePlan(tenant);

  const chosenScript =
    guildScripts.find((s) => s.id === selectedScriptIdInput) ||
    guildScripts.find((s) => s.name === selectedScriptIdInput) ||
    guildScripts[0] ||
    null;

  const guildName = cleanGuildId
    ? await resolveGuildDisplayName(cleanGuildId, tenant ? tenant.guildName : "")
    : "";

  const activeScriptTitle = chosenScript ? chosenScript.name : "Script Seçilməyib";
  const panelHeading = chosenScript ? `${design.title} — ${chosenScript.name}` : design.title;

  const embedObj = {
    title: panelHeading,
    description: design.description,
    color: hexColorToDiscordInt(design.colorHex),
    fields: [
      {
        name: "🏰 Bağlanan Sunucu",
        value: guildName || (cleanGuildId ? `ID: ${cleanGuildId}` : "Bağlı Sunucu Yoxdur"),
        inline: true
      },
      {
        name: "📜 Seçilmiş Script",
        value: activeScriptTitle,
        inline: true
      },
      {
        name: "💎 Plan",
        value: activePlan.label,
        inline: true
      },
      {
        name: "🔗 Script Mənbəyi",
        value: resolveScriptSourceLabel(chosenScript),
        inline: false
      },
      {
        name: "🔑 Aktiv Keylər",
        value: `${guildKeys.length} ədəd`,
        inline: true
      },
      {
        name: "🛡️ Whitelist / Blacklist",
        value: `${guildWhitelist.length} / ${guildBlacklist.length}`,
        inline: true
      }
    ],
    footer: {
      text: design.footerText
    },
    timestamp: new Date().toISOString()
  };

  if (design.imageUrl && /^https?:\/\//i.test(design.imageUrl)) {
    embedObj.image = { url: design.imageUrl };
  }

  const activeButtons = (design.buttons || []).filter((b) => b.enabled !== false);
  const discordButtons = activeButtons.slice(0, 5).map((btn) => {
    const customId = chosenScript ? `${btn.id}::${chosenScript.id}` : btn.id;
    const component = {
      type: 2,
      style: mapButtonStyleToDiscordInt(btn.style),
      label: btn.label,
      custom_id: customId
    };
    if (btn.emoji) {
      component.emoji = { name: btn.emoji };
    }
    return component;
  });

  const components = [];
  if (discordButtons.length > 0) {
    components.push({
      type: 1,
      components: discordButtons
    });
  }

  return {
    embeds: [embedObj],
    components
  };
};

const getBasePublicUrl = (req) => {
  const envUrl = sanitizeText(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "", "");
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }
  const host = req.headers.host || `localhost:${SERVER_PORT}`;
  const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
};

const buildLoaderScriptForRawId = (rawId, baseUrl) => {
  const rawEndpoint = `${baseUrl}/raw/${encodeURIComponent(rawId)}`;
  return `loadstring(game:HttpGet("${rawEndpoint}", true))()`;
};

const buildCopyReadyScriptText = (scriptObj, baseUrl, guildId = "") => {
  if (!scriptObj) return "";
  const rawEndpoint = `${baseUrl}/raw/${encodeURIComponent(scriptObj.id)}${
    guildId ? `?guildId=${encodeURIComponent(guildId)}` : ""
  }`;
  return `loadstring(game:HttpGet("${rawEndpoint}", true))()`;
};

const parseCustomIdParts = (customIdStr) => {
  const raw = String(customIdStr || "");
  const idx = raw.indexOf("::");
  if (idx === -1) {
    return { actionId: raw, scriptId: "" };
  }
  return {
    actionId: raw.slice(0, idx),
    scriptId: raw.slice(idx + 2)
  };
};

const extractDiscordUserId = (rawInput) => {
  const match = String(rawInput || "").match(/\d{15,22}/);
  return match ? match[0] : "";
};

const findScriptByIdentifier = (identifier, guildId = "") => {
  const cleanIdent = sanitizeText(identifier, "");
  if (!cleanIdent) return null;
  const guildScripts = getScriptsForGuild(guildId);
  return (
    guildScripts.find(
      (s) =>
        s.id === cleanIdent ||
        s.name.toLowerCase() === cleanIdent.toLowerCase()
    ) || null
  );
};

const isUserBlacklisted = (userId, guildId = "") => {
  const cleanUid = extractDiscordUserId(userId);
  if (!cleanUid) return false;
  const bl = getBlacklistForGuild(guildId);
  return bl.some((item) => extractDiscordUserId(item.userId || item.value || item) === cleanUid);
};

const isUserWhitelisted = (userId, guildId = "", scriptId = "") => {
  const cleanUid = extractDiscordUserId(userId);
  if (!cleanUid) return false;
  const wl = getWhitelistForGuild(guildId);
  const cleanScriptId = sanitizeText(scriptId, "");
  return wl.some((item) => {
    const itemUid = extractDiscordUserId(item.userId || item.value || item);
    if (itemUid !== cleanUid) return false;
    if (!cleanScriptId) return true;
    const itemScriptId = sanitizeText(item.scriptId || "", "");
    return !itemScriptId || itemScriptId === cleanScriptId;
  });
};

const addUserToWhitelist = (userId, guildId = "", scriptId = "", scriptName = "", actor = "Discord") => {
  const cleanUid = extractDiscordUserId(userId);
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanUid || !cleanGid) return null;
  const tenant = getTenantRecordByGuildId(cleanGid);
  if (!tenant) return null;

  const cleanScriptId = sanitizeText(scriptId, "");
  const matchedScript = cleanScriptId ? findScriptByIdentifier(cleanScriptId, cleanGid) : null;
  const finalScriptId = matchedScript ? matchedScript.id : cleanScriptId;
  const finalScriptName = matchedScript ? matchedScript.name : sanitizeText(scriptName, "");

  tenant.whitelist = (Array.isArray(tenant.whitelist) ? tenant.whitelist : []).filter((item) => {
    const sameUser = extractDiscordUserId(item.userId || item.value || item) === cleanUid;
    if (!sameUser) return true;
    if (!finalScriptId) return false;
    const existingSid = sanitizeText(item.scriptId || "", "");
    return existingSid !== "" && existingSid !== finalScriptId;
  });

  const record = {
    id: generateUniqueId("wl"),
    userId: cleanUid,
    scriptId: finalScriptId,
    scriptName: finalScriptName,
    addedBy: actor,
    createdAt: new Date().toISOString()
  };
  tenant.whitelist.unshift(record);
  syncTenantIntoGlobalIfPrimary(tenant);
  saveAppStateToDisk();
  return record;
};

const removeUserFromWhitelist = (userId, guildId = "", scriptId = "") => {
  const cleanUid = extractDiscordUserId(userId);
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanUid || !cleanGid) return 0;
  const tenant = getTenantRecordByGuildId(cleanGid);
  if (!tenant) return 0;

  const cleanScriptId = sanitizeText(scriptId, "");
  const beforeLen = (tenant.whitelist || []).length;
  tenant.whitelist = (tenant.whitelist || []).filter((item) => {
    const sameUser = extractDiscordUserId(item.userId || item.value || item) === cleanUid;
    if (!sameUser) return true;
    if (!cleanScriptId) return false;
    const existingSid = sanitizeText(item.scriptId || "", "");
    return existingSid !== "" && existingSid !== cleanScriptId;
  });
  const removedCount = beforeLen - tenant.whitelist.length;
  syncTenantIntoGlobalIfPrimary(tenant);
  saveAppStateToDisk();
  return removedCount;
};

const redeemKeyForDiscordUser = (rawKey, discordUserId, hwidInput = "", guildId = "") => {
  const cleanKey = sanitizeText(rawKey, "").toUpperCase();
  const cleanUid = extractDiscordUserId(discordUserId);
  const cleanGid = sanitizeSnowflakeId(guildId);
  if (!cleanKey) {
    return { ok: false, message: "❌ Zəhmət olmasa etibarlı açar daxil edin." };
  }
  if (isUserBlacklisted(cleanUid, cleanGid)) {
    return { ok: false, message: "⛔ Siz Blacklist siyahısındasınız, açar aktivləşdirilə bilməz." };
  }

  const tenant = cleanGid ? getTenantRecordByGuildId(cleanGid) : null;
  const keysArr = tenant ? tenant.keys || [] : [];
  const keyRecord = keysArr.find((k) => String(k.key || "").toUpperCase() === cleanKey);

  if (!keyRecord) {
    return { ok: false, message: "❌ Bu açar tapılmadı və ya silinib." };
  }
  if (keyRecord.status === "revoked" || keyRecord.status === "banned") {
    return { ok: false, message: "⛔ Bu açar ləğv edilib." };
  }
  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt).getTime() < Date.now()) {
    return { ok: false, message: "⌛ Bu açarın vaxtı bitib." };
  }

  if (keyRecord.discordUserId && keyRecord.discordUserId !== cleanUid) {
    return {
      ok: false,
      message: `🔒 Bu açar artıq başqa istifadəçiyə (<@${keyRecord.discordUserId}>) bağlıdır.`
    };
  }

  const providedHwid = sanitizeText(hwidInput, "");
  if (providedHwid) {
    if (keyRecord.hwid && keyRecord.hwid !== providedHwid) {
      return {
        ok: false,
        message: "🔒 Bu açar fərqli HWID cihazına bağlıdır. Əvvəlcə Reset HWID edin."
      };
    }
    keyRecord.hwid = providedHwid;
  }

  keyRecord.discordUserId = cleanUid;
  keyRecord.redeemedAt = keyRecord.redeemedAt || new Date().toISOString();
  keyRecord.status = "active";

  if (cleanGid) {
    addUserToWhitelist(
      cleanUid,
      cleanGid,
      keyRecord.scriptId || "",
      keyRecord.scriptName || "",
      "Key Redeem"
    );
  }

  if (tenant) {
    syncTenantIntoGlobalIfPrimary(tenant);
  }
  saveAppStateToDisk();
  appendAuditLog(
    "KEY_REDEEMED",
    `Açar aktivləşdirildi: ${keyRecord.key} → İstifadəçi ${cleanUid}`,
    cleanUid,
    cleanGid
  );

  return {
    ok: true,
    keyRecord,
    message: `✅ Açar uğurla aktivləşdirildi!\n🔑 **Açar:** \`${keyRecord.key}\`\n👤 **İstifadəçi:** <@${cleanUid}>\n💻 **HWID:** \`${keyRecord.hwid || "İlk script açılışında bağlanacaq"}\``
  };
};

const resetHwidForDiscordUser = (discordUserId, guildId = "") => {
  const cleanUid = extractDiscordUserId(discordUserId);
  const cleanGid = sanitizeSnowflakeId(guildId);
  const tenant = cleanGid ? getTenantRecordByGuildId(cleanGid) : null;
  const keysArr = tenant ? tenant.keys || [] : [];
  const userKeys = keysArr.filter((k) => k.discordUserId === cleanUid);

  if (!userKeys.length) {
    return {
      ok: false,
      message: "❌ Adınıza bağlı aktiv açar tapılmadı. Əvvəlcə açar aktivləşdirin."
    };
  }

  for (const k of userKeys) {
    k.hwid = "";
    k.hwidResetAt = new Date().toISOString();
  }

  if (tenant) {
    syncTenantIntoGlobalIfPrimary(tenant);
  }
  saveAppStateToDisk();
  appendAuditLog("HWID_RESET", `HWID sıfırlandı (${cleanUid})`, cleanUid, cleanGid);

  return {
    ok: true,
    message:
      "⚙️ **HWID uğurla sıfırlandı!**\nİndi scripti açdığınız yeni telefon/cihaz avtomatik olaraq açarınıza bağlanacaq."
  };
};

const getScriptForDiscordUser = (discordUserId, guildId = "", scriptIdHint = "", baseUrl = "") => {
  const cleanUid = extractDiscordUserId(discordUserId);
  const cleanGid = sanitizeSnowflakeId(guildId);

  if (isUserBlacklisted(cleanUid, cleanGid)) {
    return {
      ok: false,
      message: "⛔ Siz Blacklist siyahısındasınız, scriptə giriş qadağandır."
    };
  }

  const tenant = cleanGid ? getTenantRecordByGuildId(cleanGid) : null;
  const keysArr = tenant ? tenant.keys || [] : [];
  const scriptsArr = tenant ? tenant.scripts || [] : [];

  const matchedKey = keysArr.find(
    (k) =>
      k.discordUserId === cleanUid &&
      k.status !== "revoked" &&
      k.status !== "banned" &&
      (!k.expiresAt || new Date(k.expiresAt).getTime() >= Date.now())
  );

  const chosenScript =
    (scriptIdHint && scriptsArr.find((s) => s.id === scriptIdHint)) ||
    (matchedKey && matchedKey.scriptId && scriptsArr.find((s) => s.id === matchedKey.scriptId)) ||
    scriptsArr[0] ||
    null;

  if (!chosenScript) {
    return {
      ok: false,
      message: "❌ Bu sunucuda hələ script yaradılmayıb."
    };
  }

  const whitelistedForScript = isUserWhitelisted(cleanUid, cleanGid, chosenScript.id);
  if (!matchedKey && !whitelistedForScript) {
    return {
      ok: false,
      message:
        `🔒 **${chosenScript.name}** scriptini almaq üçün aktiv açarınız və ya bu scriptə Whitelist icazəniz olmalıdır.\n` +
        "Əvvəlcə **Reedem Key** ilə açarınızı daxil edin."
    };
  }

  const copyScriptText = buildCopyReadyScriptText(chosenScript, baseUrl, cleanGid);
  return {
    ok: true,
    script: chosenScript,
    copyScriptText,
    message:
      `📜 **${chosenScript.name}** hazırdır!\n` +
      "Aşağıdakı kodu kopyalayıb executor-da işlədə və ya altdakı **Scripti Kopyala** düyməsinə basa bilərsiniz:\n" +
      "```lua\n" +
      copyScriptText +
      "\n```"
  };
};

const getStatsForDiscordUser = (discordUserId, guildId = "") => {
  const cleanUid = extractDiscordUserId(discordUserId);
  const cleanGid = sanitizeSnowflakeId(guildId);
  const tenant = cleanGid ? getTenantRecordByGuildId(cleanGid) : null;
  const keysArr = tenant ? tenant.keys || [] : [];
  const userKeys = keysArr.filter((k) => k.discordUserId === cleanUid);
  const activeKey = userKeys[0] || null;
  const wlStatus = isUserWhitelisted(cleanUid, cleanGid) ? "Bəli ✅" : "Xeyr ❌";
  const blStatus = isUserBlacklisted(cleanUid, cleanGid) ? "Bəli ⛔" : "Xeyr ✅";

  return (
    `📊 **İstifadəçi Statistikası** (<@${cleanUid}>)\n` +
    `• **Aktiv Açar:** ${activeKey ? `\`${activeKey.key}\`` : "Yoxdur"}\n` +
    `• **Bağlı HWID:** ${activeKey && activeKey.hwid ? `\`${activeKey.hwid}\`` : "Bağlanmayıb"}\n` +
    `• **Whitelist:** ${wlStatus}\n` +
    `• **Blacklist:** ${blStatus}`
  );
};

const sendInteractionResponse = async (interactionId, interactionToken, payload) => {
  await discordRestRequest("POST", `/interactions/${interactionId}/${interactionToken}/callback`, payload);
};

const sendChannelMessage = async (channelId, payload) => {
  const cleanChId = sanitizeSnowflakeId(channelId);
  if (!cleanChId) {
    throw new Error("Kanal ID-si düzgün deyil");
  }
  return discordRestRequest("POST", `/channels/${cleanChId}/messages`, payload);
};

const handleDiscordInteraction = async (interaction, baseUrl = "") => {
  if (!interaction || !interaction.id || !interaction.token) return;
  const interactionId = interaction.id;
  const interactionToken = interaction.token;
  const interactionType = Number(interaction.type);
  const guildId = sanitizeSnowflakeId(interaction.guild_id || "");
  const memberUser =
    (interaction.member && interaction.member.user) || interaction.user || {};
  const actorUserId = extractDiscordUserId(memberUser.id || "");
  const actorTag = memberUser.username || actorUserId || "DiscordUser";

  if (guildId) {
    const tenant = getTenantRecordByGuildId(guildId);
    if (tenant) {
      if (interaction.channel_id && !tenant.panelChannelId) {
        tenant.panelChannelId = sanitizeSnowflakeId(interaction.channel_id);
      }
      if (!APP_STATE.guildId) {
        APP_STATE.guildId = guildId;
      }
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
    }
  }

  try {
    if (interactionType === 1) {
      await sendInteractionResponse(interactionId, interactionToken, { type: 1 });
      return;
    }

    if (interactionType === 4) {
      const data = interaction.data || {};
      const options = Array.isArray(data.options) ? data.options : [];
      const focusedOpt = options.find((o) => o && o.focused) || {};
      const typedQuery = String(focusedOpt.value || "").trim().toLowerCase();
      const guildScripts = getScriptsForGuild(guildId);
      const filtered = guildScripts
        .filter((sc) => !typedQuery || String(sc.name || "").toLowerCase().includes(typedQuery))
        .slice(0, 25)
        .map((sc) => ({
          name: String(sc.name || "Script").slice(0, 100),
          value: String(sc.id)
        }));

      await sendInteractionResponse(interactionId, interactionToken, {
        type: 8,
        data: { choices: filtered }
      });
      return;
    }

    if (interactionType === 2) {
      const data = interaction.data || {};
      const cmdName = String(data.name || "").toLowerCase();
      const opts = Array.isArray(data.options) ? data.options : [];
      const getOptVal = (optName) => {
        const found = opts.find((o) => o && o.name === optName);
        return found ? found.value : "";
      };

      if (cmdName === "panel") {
        const chosenScriptArg = sanitizeText(String(getOptVal("script") || ""), "");
        const panelPayload = await buildDiscordPanelMessagePayload(guildId, chosenScriptArg);
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: panelPayload
        });
        return;
      }

      if (cmdName === "whitelist") {
        const targetUid = extractDiscordUserId(getOptVal("user"));
        const chosenScriptArg = sanitizeText(String(getOptVal("script") || ""), "");
        if (!targetUid) {
          await sendInteractionResponse(interactionId, interactionToken, {
            type: 4,
            data: { content: "❌ Düzgün Discord İstifadəçi ID və ya @mention daxil edin.", flags: 64 }
          });
          return;
        }
        if (!guildId) {
          await sendInteractionResponse(interactionId, interactionToken, {
            type: 4,
            data: { content: "❌ Bu əmr yalnız sunucu daxilində işləyir.", flags: 64 }
          });
          return;
        }
        const matchedScript = findScriptByIdentifier(chosenScriptArg, guildId);
        if (!matchedScript) {
          await sendInteractionResponse(interactionId, interactionToken, {
            type: 4,
            data: { content: "❌ Zəhmət olmasa mövcud script seçin.", flags: 64 }
          });
          return;
        }
        addUserToWhitelist(targetUid, guildId, matchedScript.id, matchedScript.name, actorTag);
        appendAuditLog(
          "WHITELIST_ADD",
          `Whitelist əlavə edildi: ${targetUid} → ${matchedScript.name}`,
          actorTag,
          guildId
        );
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `✅ <@${targetUid}> (\`${targetUid}\`) istifadəçisi yalnız **${matchedScript.name}** scriptinin Whitelist siyahısına əlavə edildi.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "unwhitelist") {
        const targetUid = extractDiscordUserId(getOptVal("user"));
        const chosenScriptArg = sanitizeText(String(getOptVal("script") || ""), "");
        if (!targetUid) {
          await sendInteractionResponse(interactionId, interactionToken, {
            type: 4,
            data: { content: "❌ Düzgün Discord İstifadəçi ID və ya @mention daxil edin.", flags: 64 }
          });
          return;
        }
        if (!guildId) {
          await sendInteractionResponse(interactionId, interactionToken, {
            type: 4,
            data: { content: "❌ Bu əmr yalnız sunucu daxilində işləyir.", flags: 64 }
          });
          return;
        }
        const matchedScript = chosenScriptArg ? findScriptByIdentifier(chosenScriptArg, guildId) : null;
        const removed = removeUserFromWhitelist(
          targetUid,
          guildId,
          matchedScript ? matchedScript.id : chosenScriptArg
        );
        appendAuditLog(
          "WHITELIST_REMOVE",
          `Whitelist silindi: ${targetUid} (${matchedScript ? matchedScript.name : "Bütün scriptlər"})`,
          actorTag,
          guildId
        );
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: {
            content:
              removed > 0
                ? `🗑️ <@${targetUid}> istifadəçisi ${
                    matchedScript ? `**${matchedScript.name}** scriptinin` : "bütün scriptlərin"
                  } Whitelist siyahısından çıxarıldı.`
                : `ℹ️ <@${targetUid}> həmin siyahıda tapılmadı.`,
            flags: 64
          }
        });
        return;
      }

      if (cmdName === "key") {
        const keyInput = sanitizeText(String(getOptVal("key") || ""), "");
        const hwidInput = sanitizeText(String(getOptVal("hwid") || ""), "");
        const result = redeemKeyForDiscordUser(keyInput, actorUserId, hwidInput, guildId);
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: { content: result.message, flags: 64 }
        });
        return;
      }

      if (cmdName === "scripts") {
        const guildScripts = getScriptsForGuild(guildId);
        const text = guildScripts.length
          ? "📜 **Bu sunucudakı scriptlər:**\n" +
            guildScripts
              .map((s, idx) => `${idx + 1}. **${s.name}** — ${resolveScriptSourceLabel(s)}`)
              .join("\n")
          : "ℹ️ Bu sunucuda hələ script yaradılmayıb.";
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: { content: text, flags: 64 }
        });
        return;
      }

      if (cmdName === "status") {
        const tenant = guildId ? getTenantRecordByGuildId(guildId) : null;
        const planInfo = resolveTenantEffectivePlan(tenant);
        const scriptsCount = getScriptsForGuild(guildId).length;
        const keysCount = getKeysForGuild(guildId).length;
        const wlCount = getWhitelistForGuild(guildId).length;
        const statusText =
          "🛡️ **SADO PROTECT Status**\n" +
          `• **Bot:** ${BOT_RUNTIME.connected ? "Aktiv ✅" : "Gözləmədə ⚠️"}\n` +
          `• **Plan:** ${planInfo.label}\n` +
          `• **Sunucu ID:** \`${guildId || "Yoxdur"}\`\n` +
          `• **Scriptlər:** ${scriptsCount}\n` +
          `• **Keylər:** ${keysCount}\n` +
          `• **Whitelist:** ${wlCount}`;
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: { content: statusText, flags: 64 }
        });
        return;
      }
    }

    if (interactionType === 3) {
      const customId = (interaction.data && interaction.data.custom_id) || "";
      const { actionId, scriptId } = parseCustomIdParts(customId);

      if (actionId === "btn_redeem_key") {
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 9,
          data: {
            custom_id: `modal_redeem_key::${scriptId || ""}`,
            title: "Lisenziya Açarını Aktivləşdir",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "input_license_key",
                    label: "Açarınız (SADO-XXXX-XXXX-XXXX)",
                    style: 1,
                    min_length: 4,
                    max_length: 80,
                    placeholder: "SADO-XXXX-XXXX-XXXX",
                    required: true
                  }
                ]
              }
            ]
          }
        });
        return;
      }

      if (actionId === "btn_get_script") {
        const scriptRes = getScriptForDiscordUser(actorUserId, guildId, scriptId, baseUrl);
        if (!scriptRes.ok) {
          await sendInteractionResponse(interactionId, interactionToken, {
            type: 4,
            data: { content: scriptRes.message, flags: 64 }
          });
          return;
        }

        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: {
            content: scriptRes.message,
            flags: 64,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 2,
                    label: "Scripti Kopyala",
                    emoji: { name: "📋" },
                    custom_id: `btn_copy_script::${scriptRes.script.id}`
                  }
                ]
              }
            ]
          }
        });
        return;
      }

      if (actionId === "btn_copy_script") {
        const scriptRes = getScriptForDiscordUser(actorUserId, guildId, scriptId, baseUrl);
        const textToCopy = scriptRes.ok
          ? scriptRes.copyScriptText
          : buildLoaderScriptForRawId(scriptId || "script", baseUrl);
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: {
            content: `📋 **Kopyalanacaq Script:**\n\`\`\`lua\n${textToCopy}\n\`\`\``,
            flags: 64
          }
        });
        return;
      }

      if (actionId === "btn_reset_hwid") {
        const resetRes = resetHwidForDiscordUser(actorUserId, guildId);
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: { content: resetRes.message, flags: 64 }
        });
        return;
      }

      if (actionId === "btn_stats") {
        const statsText = getStatsForDiscordUser(actorUserId, guildId);
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: { content: statsText, flags: 64 }
        });
        return;
      }
    }

    if (interactionType === 5) {
      const modalData = interaction.data || {};
      const customId = String(modalData.custom_id || "");
      const { actionId } = parseCustomIdParts(customId);

      if (actionId === "modal_redeem_key") {
        let submittedKey = "";
        const rows = Array.isArray(modalData.components) ? modalData.components : [];
        for (const row of rows) {
          const comps = Array.isArray(row.components) ? row.components : [];
          for (const c of comps) {
            if (c && c.custom_id === "input_license_key") {
              submittedKey = String(c.value || "").trim();
            }
          }
        }
        const redeemRes = redeemKeyForDiscordUser(submittedKey, actorUserId, "", guildId);
        await sendInteractionResponse(interactionId, interactionToken, {
          type: 4,
          data: { content: redeemRes.message, flags: 64 }
        });
        return;
      }
    }
  } catch (_err) {}
};

const cleanupGatewayTimers = () => {
  if (BOT_RUNTIME.heartbeatTimer) {
    clearInterval(BOT_RUNTIME.heartbeatTimer);
    BOT_RUNTIME.heartbeatTimer = null;
  }
  if (BOT_RUNTIME.reconnectTimer) {
    clearTimeout(BOT_RUNTIME.reconnectTimer);
    BOT_RUNTIME.reconnectTimer = null;
  }
};

const scheduleGatewayReconnect = (delayMs = 3000) => {
  if (BOT_RUNTIME.reconnectTimer) return;
  BOT_RUNTIME.reconnectTimer = setTimeout(() => {
    BOT_RUNTIME.reconnectTimer = null;
    connectDiscordGateway();
  }, delayMs);
};

const connectDiscordGateway = () => {
  const token = resolveDiscordBotToken();
  if (!token) {
    BOT_RUNTIME.connected = false;
    BOT_RUNTIME.lastError = "DISCORD_BOT_TOKEN təyin edilməyib";
    return;
  }
  if (!WebSocketClient) {
    BOT_RUNTIME.connected = false;
    BOT_RUNTIME.lastError = "'ws' paketi quraşdırılmayıb";
    return;
  }

  cleanupGatewayTimers();
  if (BOT_RUNTIME.socket) {
    try {
      BOT_RUNTIME.socket.terminate();
    } catch (_e) {}
    BOT_RUNTIME.socket = null;
  }

  const gatewayEndpoint = BOT_RUNTIME.resumeGatewayUrl || DISCORD_GATEWAY_URL;
  const ws = new WebSocketClient(gatewayEndpoint);
  BOT_RUNTIME.socket = ws;

  ws.on("open", () => {
    BOT_RUNTIME.lastError = "";
  });

  ws.on("message", async (rawData) => {
    let payload = null;
    try {
      payload = JSON.parse(rawData.toString("utf8"));
    } catch (_e) {
      return;
    }
    if (!payload || typeof payload !== "object") return;

    if (typeof payload.s === "number") {
      BOT_RUNTIME.seq = payload.s;
    }

    const op = Number(payload.op);
    if (op === 10) {
      const intervalMs =
        payload.d && typeof payload.d.heartbeat_interval === "number"
          ? payload.d.heartbeat_interval
          : 41250;

      BOT_RUNTIME.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocketClient.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: BOT_RUNTIME.seq }));
        }
      }, intervalMs);

      if (BOT_RUNTIME.sessionId && BOT_RUNTIME.resumeGatewayUrl) {
        ws.send(
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
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: 1,
              properties: {
                os: "linux",
                browser: "sado-protect",
                device: "sado-protect"
              },
              presence: {
                activities: [{ name: "SADO PROTECT • License Guard", type: 0 }],
                status: "online",
                afk: false
              }
            }
          })
        );
      }
      return;
    }

    if (op === 7 || op === 9) {
      if (op === 9 && !payload.d) {
        BOT_RUNTIME.sessionId = "";
        BOT_RUNTIME.resumeGatewayUrl = "";
      }
      BOT_RUNTIME.connected = false;
      scheduleGatewayReconnect(1500);
      return;
    }

    if (op === 0) {
      const eventName = payload.t;
      const eventData = payload.d || {};

      if (eventName === "READY") {
        BOT_RUNTIME.connected = true;
        BOT_RUNTIME.lastConnectedAt = new Date().toISOString();
        BOT_RUNTIME.lastError = "";
        BOT_RUNTIME.sessionId = eventData.session_id || "";
        BOT_RUNTIME.resumeGatewayUrl = eventData.resume_gateway_url || DISCORD_GATEWAY_URL;
        if (eventData.user) {
          BOT_RUNTIME.botUserId = String(eventData.user.id || "");
          BOT_RUNTIME.botUsername = String(eventData.user.username || "SADO PROTECT");
        }
        await syncSlashCommandsWithDiscord("");
        if (APP_STATE.guildId) {
          await syncSlashCommandsWithDiscord(APP_STATE.guildId);
          await fetchGuildInfoFromDiscord(APP_STATE.guildId);
        }
        const tenantIds = Object.keys(ensureTenantStore());
        for (const tid of tenantIds) {
          await syncSlashCommandsWithDiscord(tid);
          await fetchGuildInfoFromDiscord(tid);
        }
        return;
      }

      if (eventName === "GUILD_CREATE") {
        const gid = sanitizeSnowflakeId(eventData.id);
        if (gid) {
          if (eventData.name) {
            BOT_RUNTIME.guildNames[gid] = String(eventData.name);
          }
          const tenant = getTenantRecordByGuildId(gid);
          if (tenant && eventData.name) {
            tenant.guildName = String(eventData.name);
            syncTenantIntoGlobalIfPrimary(tenant);
            saveAppStateToDisk();
          }
          await syncSlashCommandsWithDiscord(gid);
        }
        return;
      }

      if (eventName === "INTERACTION_CREATE") {
        await handleDiscordInteraction(eventData, "");
      }
    }
  });

  ws.on("close", () => {
    BOT_RUNTIME.connected = false;
    cleanupGatewayTimers();
    scheduleGatewayReconnect(3000);
  });

  ws.on("error", (err) => {
    BOT_RUNTIME.connected = false;
    BOT_RUNTIME.lastError = err && err.message ? err.message : "Gateway bağlantı xətası";
  });
};

const resolveRequestGuildId = (req, reqUrl, bodyObj = null) => {
  const fromQuery = sanitizeSnowflakeId(reqUrl.searchParams.get("guildId") || "");
  if (fromQuery) return fromQuery;

  const fromHeader = sanitizeSnowflakeId(req.headers["x-guild-id"] || "");
  if (fromHeader) return fromHeader;

  const fromBody = bodyObj ? sanitizeSnowflakeId(bodyObj.guildId || "") : "";
  if (fromBody) return fromBody;

  return "";
};

const buildPublicSnapshotPayload = async (requestedGuildId = "", isAdminView = false) => {
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
    : normalizePanelDesign(DEFAULT_PANEL_DESIGN);
  const logsList = tenant ? tenant.auditLogs || [] : [];
  const activePlan = resolveTenantEffectivePlan(tenant);

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
    plan: {
      tier: activePlan.id,
      label: activePlan.label,
      priceLabel: activePlan.priceLabel,
      scriptLimit: activePlan.scriptLimit,
      scriptsUsed: scriptsList.length,
      boundApiKey: tenant ? sanitizeText(tenant.boundApiKey, "") : "",
      plansCatalog: [PLAN_CONFIGS.free, PLAN_CONFIGS.premium_1, PLAN_CONFIGS.premium_2]
    },
    isAdminView: Boolean(isAdminView),
    adminApiKeys: isAdminView && Array.isArray(APP_STATE.apiKeys) ? APP_STATE.apiKeys : [],
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

const renderDashboardHtml = () => {
  return `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • İdarəetmə Paneli</title>
  <style>
    :root {
      --bg-main: #090d16;
      --bg-card: #111827;
      --bg-soft: #1e293b;
      --border: rgba(148, 163, 184, 0.16);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at top right, rgba(99, 102, 241, 0.14), transparent 45%), var(--bg-main);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
    }
    .sidebar {
      width: 255px;
      background: rgba(15, 23, 42, 0.92);
      border-right: 1px solid var(--border);
      padding: 20px 14px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand-box {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 14px;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.28);
    }
    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 16px;
      color: #fff;
    }
    .brand-title { font-weight: 700; font-size: 15px; letter-spacing: 0.4px; }
    .brand-sub { font-size: 11px; color: var(--text-muted); }
    .nav-list { display: flex; flex-direction: column; gap: 6px; }
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
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: all 0.18s ease;
    }
    .nav-item:hover { background: rgba(255,255,255,0.04); color: var(--text-main); }
    .nav-item.active {
      background: rgba(99, 102, 241, 0.18);
      border-color: rgba(99, 102, 241, 0.45);
      color: #fff;
    }
    .main-area {
      flex: 1;
      padding: 24px 28px 48px;
      max-width: 1320px;
      margin: 0 auto;
      width: 100%;
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 24px;
      padding: 14px 18px;
      border-radius: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 13px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.14);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .status-pill.offline {
      background: rgba(245, 158, 11, 0.14);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .topbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .guild-chip {
      padding: 7px 12px;
      border-radius: 10px;
      background: var(--bg-soft);
      border: 1px solid var(--border);
      font-size: 13px;
      color: #e2e8f0;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 9px 15px;
      border-radius: 10px;
      border: 1px solid transparent;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.16s ease;
      color: #fff;
    }
    .btn-primary { background: var(--accent); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-success { background: var(--success); color: #04130d; }
    .btn-danger { background: var(--danger); }
    .btn-ghost { background: var(--bg-soft); border-color: var(--border); color: var(--text-main); }
    .btn-sm { padding: 6px 11px; font-size: 12px; border-radius: 8px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin-bottom: 22px;
    }
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
    }
    .stat-label { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
    .stat-value { font-size: 24px; font-weight: 700; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 18px;
    }
    .card-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .card-sub { font-size: 13px; color: var(--text-muted); margin-bottom: 16px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; font-weight: 500; }
    input, select, textarea {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #0b1120;
      color: var(--text-main);
      font-size: 13px;
      outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); }
    textarea { min-height: 90px; resize: vertical; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid var(--border); text-align: left; }
    th { color: var(--text-muted); font-weight: 600; font-size: 12px; }
    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(99, 102, 241, 0.16);
      color: #a5b4fc;
    }
    .badge-green { background: rgba(16, 185, 129, 0.16); color: #34d399; }
    .badge-red { background: rgba(239, 68, 68, 0.16); color: #f87171; }
    .tab-section { display: none; }
    .tab-section.active { display: block; }
    .btn-designer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #0b1120;
      border: 1px solid var(--border);
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .preview-embed {
      border-left: 4px solid #6366f1;
      background: #0b1120;
      border-radius: 12px;
      padding: 16px;
      border-top: 1px solid var(--border);
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    .preview-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .mock-btn {
      padding: 7px 13px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      border: none;
    }
    .mock-Primary { background: #5865f2; }
    .mock-Secondary { background: #4e5058; }
    .mock-Success { background: #248046; }
    .mock-Danger { background: #da373c; }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #1e293b;
      color: #fff;
      border: 1px solid rgba(99, 102, 241, 0.45);
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 13px;
      box-shadow: 0 12px 28px rgba(0,0,0,0.45);
      z-index: 9999;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 860px) {
      body { flex-direction: column; }
      .sidebar { width: 100%; height: auto; position: static; flex-direction: row; flex-wrap: wrap; }
      .nav-list { flex-direction: row; flex-wrap: wrap; }
      .main-area { padding: 16px; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand-box">
      <div class="brand-icon">SP</div>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub">License & Script Guard</div>
      </div>
    </div>

    <nav class="nav-list">
      <button class="nav-item active" data-tab="overview">📊 İdarəetmə</button>
      <button class="nav-item" data-tab="plans">💎 Planlar & API</button>
      <button class="nav-item" data-tab="scripts">📜 Scriptlər</button>
      <button class="nav-item" data-tab="keys">🔑 Keylər</button>
      <button class="nav-item" data-tab="designer">🎨 Panel Dizaynı</button>
      <button class="nav-item" data-tab="access">🛡️ Whitelist / Blacklist</button>
    </nav>
  </aside>

  <main class="main-area">
    <header class="topbar">
      <div class="row">
        <div id="botStatusPill" class="status-pill offline">
          <span class="dot"></span>
          <span id="botStatusText">Bot: Aktiv deyil — Gözləmədədir</span>
        </div>
        <div class="guild-chip">🏰 Sunucu: <strong id="headerGuildName">Bağlı Sunucu Yoxdur</strong></div>
        <div class="guild-chip">💎 Plan: <strong id="headerPlanLabel">Free</strong></div>
      </div>

      <div class="topbar-right">
        <a id="topJoinDiscordLink" class="btn btn-primary btn-sm" href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer">
          ➕ Join Discord
        </a>
        <button id="refreshSnapshotBtn" class="btn btn-ghost btn-sm">🔄 Yenilə</button>
      </div>
    </header>

    <section id="tab-overview" class="tab-section active">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Scriptlər</div>
          <div id="statScriptsCount" class="stat-value">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Lisenziya Keyləri</div>
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
          <div class="card-title">🔗 Sunucu Bağlantısı & Panel Göndərimi</div>
          <div class="card-sub">
            Hər cihaz öz Sunucu ID-sini bağlaya bilər. Botu sunucuya əlavə etmək üçün Join Discord düyməsindən istifadə edin.
          </div>

          <div class="form-group">
            <label>Discord Sunucu ID (Guild ID)</label>
            <input id="guildIdInput" type="text" placeholder="Məs: 123456789012345678" />
          </div>

          <div class="form-group">
            <label>Panel Göndəriləcək Kanal ID (İstəyə bağlı)</label>
            <input id="panelChannelIdInput" type="text" placeholder="Boş buraxılsa aktiv kanal seçilir" />
          </div>

          <div class="form-group">
            <label>Panel Scripti</label>
            <select id="quickPanelScriptSelect"></select>
          </div>

          <div class="row">
            <button id="saveGuildSettingsBtn" class="btn btn-primary">💾 Sunucunu Bağla</button>
            <button id="sendPanelQuickBtn" class="btn btn-success">📨 Paneli Göndər</button>
            <a class="btn btn-ghost" href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer">
              🤖 Join Discord
            </a>
          </div>
        </div>

        <div class="card">
          <div class="card-title">📋 Son Əməliyyatlar</div>
          <div class="card-sub">Bu sunucuda edilən son dəyişikliklər</div>
          <div id="auditLogList" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto;"></div>
        </div>
      </div>
    </section>

    <section id="tab-plans" class="tab-section">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Free (Pulsuz)</div>
          <div class="stat-value">1 Script</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:6px;">Başlanğıc plan</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Premium (1$)</div>
          <div class="stat-value">5 Script</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:6px;">API açarla aktivləşir</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Premium (2$)</div>
          <div class="stat-value">Sonsuz</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:6px;">Limitsiz script • API açarla aktivləşir</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Aktiv Planınız</div>
          <div id="currentPlanBadgeText" class="stat-value">Free</div>
          <div id="currentPlanUsageText" style="font-size:12px;color:#94a3b8;margin-top:6px;">0 / 1 script</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">🔑 API Açar İlə Plan Aktiv Et</div>
          <div class="card-sub">
            Yönetici tərəfindən verilən API açarı daxil edin. Aktivləşdirildikdə planınız həmişəlik bu sunucuya bağlanır.
          </div>
          <div class="form-group">
            <label>API Açarınız</label>
            <input id="redeemApiKeyInput" type="text" placeholder="Məs: SADO-API-XXXXXX-XXXXXX" />
          </div>
          <button id="activateApiKeyBtn" class="btn btn-primary">✅ API Açarı Bağla</button>
        </div>

        <div id="adminApiManagerCard" class="card" style="display:none;">
          <div class="card-title">👑 Yönetici API Açar Yaradıcısı</div>
          <div class="card-sub">
            Bu bölmə yalnız sizdə görünür. İstifadəçi plan aldıqda buradan API açar yaradıb verin.
          </div>
          <div class="row" style="margin-bottom:12px;">
            <select id="adminNewApiPlanSelect" style="flex:1;min-width:160px;">
              <option value="free">Free (1 Script)</option>
              <option value="premium_1" selected>Premium 1$ (5 Script)</option>
              <option value="premium_2">Premium 2$ (Sonsuz Script)</option>
            </select>
            <input id="adminNewApiNoteInput" type="text" placeholder="Qeyd / Alıcı adı (istəyə bağlı)" style="flex:1;min-width:170px;" />
            <button id="adminGenerateApiKeyBtn" class="btn btn-success">➕ API Açar Yarat</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>API Açar</th>
                  <th>Plan</th>
                  <th>Qeyd</th>
                  <th>Əməliyyat</th>
                </tr>
              </thead>
              <tbody id="adminApiKeysTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section id="tab-scripts" class="tab-section">
      <div class="card">
        <div class="card-title">➕ Yeni Script Yarat</div>
        <div class="card-sub">Script adını daxil edin və mənbə kimi URL və ya .lua/.txt fayl seçin.</div>
        <div class="grid-2">
          <div class="form-group">
            <label>Script Adı</label>
            <input id="newScriptNameInput" type="text" placeholder="Məs: SADO HUB" />
          </div>
          <div class="form-group">
            <label>Mənbə Növü</label>
            <select id="newScriptSourceType">
              <option value="url">URL (Raw Link)</option>
              <option value="file">Fayl (.lua / .txt)</option>
            </select>
          </div>
        </div>
        <div id="newScriptUrlGroup" class="form-group">
          <label>Script URL</label>
          <input id="newScriptUrlInput" type="text" placeholder="https://..." />
        </div>
        <div id="newScriptFileGroup" class="form-group" style="display:none;">
          <label>Script Faylı (.lua / .txt)</label>
          <input id="newScriptFileInput" type="file" accept=".lua,.txt" />
        </div>
        <button id="createScriptBtn" class="btn btn-primary">➕ Script Əlavə Et</button>
      </div>

      <div id="editScriptCard" class="card" style="display:none;">
        <div class="card-title">✏️ Scriptə Düzəliş Et</div>
        <div class="card-sub">Mövcud scripti URL və ya yeni fayl (.lua / .txt) ilə yeniləyin.</div>
        <div class="grid-2">
          <div class="form-group">
            <label>Script Adı</label>
            <input id="editScriptNameInput" type="text" />
          </div>
          <div class="form-group">
            <label>Yeniləmə Mənbəyi</label>
            <select id="editScriptSourceType">
              <option value="url">URL (Raw Link)</option>
              <option value="file">Fayl (.lua / .txt)</option>
            </select>
          </div>
        </div>
        <div id="editScriptUrlGroup" class="form-group">
          <label>Yeni Script URL</label>
          <input id="editScriptUrlInput" type="text" />
        </div>
        <div id="editScriptFileGroup" class="form-group" style="display:none;">
          <label>Yeni Script Faylı (.lua / .txt)</label>
          <input id="editScriptFileInput" type="file" accept=".lua,.txt" />
        </div>
        <div class="row">
          <button id="saveEditScriptBtn" class="btn btn-success">💾 Yadda Saxla</button>
          <button id="cancelEditScriptBtn" class="btn btn-ghost">Ləğv Et</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">📜 Yaradılmış Scriptlər</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ad</th>
                <th>Mənbə</th>
                <th>Loader</th>
                <th>Əməliyyatlar</th>
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
        <div class="row">
          <select id="newKeyScriptSelect" style="flex:1;min-width:180px;"></select>
          <input id="newKeyDaysInput" type="number" min="0" placeholder="Müddət (gün, 0 = limitsiz)" style="width:190px;" />
          <input id="newKeyNoteInput" type="text" placeholder="Qeyd (istəyə bağlı)" style="flex:1;min-width:180px;" />
          <button id="createKeyBtn" class="btn btn-primary">➕ Key Yarat</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🗝️ Aktiv Keylər</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Script</th>
                <th>Discord User</th>
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
          <div class="card-title">🎨 Panel Mətni və Görünüşü</div>
          <div class="form-group">
            <label>Panel Başlığı</label>
            <input id="designTitleInput" type="text" />
          </div>
          <div class="form-group">
            <label>Panel Təsviri</label>
            <textarea id="designDescInput"></textarea>
          </div>
          <div class="grid-2">
            <div class="form-group">
              <label>Embed Rəngi</label>
              <input id="designColorInput" type="color" />
            </div>
            <div class="form-group">
              <label>Footer Mətni</label>
              <input id="designFooterInput" type="text" />
            </div>
          </div>
          <div class="form-group">
            <label>Şəkil URL (İstəyə bağlı)</label>
            <input id="designImageInput" type="text" placeholder="https://..." />
          </div>

          <div class="card-title" style="margin-top:14px;">🔘 Düymə Sıralaması və Parametrləri</div>
          <div id="designerButtonsList"></div>

          <div class="row" style="margin-top:14px;">
            <button id="saveDesignBtn" class="btn btn-primary">💾 Dizaynı Saxla</button>
            <button id="sendDesignedPanelBtn" class="btn btn-success">📨 Paneli Kanala Göndər</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">👁️ Canlı Önizləmə</div>
          <div id="previewEmbedBox" class="preview-embed">
            <div id="previewTitleText" style="font-weight:700;font-size:16px;margin-bottom:8px;"></div>
            <div id="previewDescText" style="font-size:13px;color:#cbd5e1;white-space:pre-line;"></div>
            <div id="previewButtonsBox" class="preview-buttons"></div>
            <div id="previewFooterText" style="font-size:11px;color:#94a3b8;margin-top:14px;"></div>
          </div>
        </div>
      </div>
    </section>

    <section id="tab-access" class="tab-section">
      <div class="grid-2">
        <div class="card">
          <div class="card-title">✅ Whitelist (Seçilən Scriptə Özəl)</div>
          <div class="row" style="margin-bottom:12px;">
            <input id="whitelistUserInput" type="text" placeholder="Discord User ID" style="flex:1;min-width:150px;" />
            <select id="whitelistScriptSelect" style="flex:1;min-width:150px;"></select>
            <button id="addWhitelistBtn" class="btn btn-success">Əlavə Et</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Script</th>
                  <th>Sil</th>
                </tr>
              </thead>
              <tbody id="whitelistTableBody"></tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">⛔ Blacklist</div>
          <div class="row" style="margin-bottom:12px;">
            <input id="blacklistUserInput" type="text" placeholder="Discord User ID" style="flex:1;min-width:170px;" />
            <button id="addBlacklistBtn" class="btn btn-danger">Blokla</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Sil</th>
                </tr>
              </thead>
              <tbody id="blacklistTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </main>

  <div id="toastBanner" class="toast"></div>

  <script>
    const CLIENT_GUILD_STORAGE_KEY = "sado_protect_device_guild_id";
    const CLIENT_ADMIN_FLAG = new URLSearchParams(window.location.search).get("admin") === "1";
    const clientState = {
      snapshot: null,
      designerButtons: [],
      editingScriptId: "",
      deviceGuildId: localStorage.getItem(CLIENT_GUILD_STORAGE_KEY) || "",
      newScriptFilePayload: { fileName: "", content: "" },
      editScriptFilePayload: { fileName: "", content: "" }
    };

    const escapeHtml = (str) => {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    };

    const showToast = (msg) => {
      const el = document.getElementById("toastBanner");
      if (!el) return;
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(window.__sadoToastTimer);
      window.__sadoToastTimer = setTimeout(() => {
        el.classList.remove("show");
      }, 2800);
    };

    const apiRequest = async (urlPath, method = "GET", bodyPayload = null) => {
      const headers = {};
      if (clientState.deviceGuildId) {
        headers["X-Guild-Id"] = clientState.deviceGuildId;
      }
      const opts = { method, headers };
      if (bodyPayload !== null) {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(bodyPayload);
      }
      const res = await fetch(urlPath, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Sorğu xətası");
      }
      return data;
    };

    const renderDesignerPreview = () => {
      const titleVal = (document.getElementById("designTitleInput") || {}).value || "";
      const descVal = (document.getElementById("designDescInput") || {}).value || "";
      const colorVal = (document.getElementById("designColorInput") || {}).value || "#6366f1";
      const footerVal = (document.getElementById("designFooterInput") || {}).value || "";

      const embedBox = document.getElementById("previewEmbedBox");
      if (embedBox) embedBox.style.borderLeftColor = colorVal;
      if (document.getElementById("previewTitleText")) {
        document.getElementById("previewTitleText").textContent = titleVal;
      }
      if (document.getElementById("previewDescText")) {
        document.getElementById("previewDescText").textContent = descVal;
      }
      if (document.getElementById("previewFooterText")) {
        document.getElementById("previewFooterText").textContent = footerVal;
      }

      const btnBox = document.getElementById("previewButtonsBox");
      if (btnBox) {
        btnBox.innerHTML = (clientState.designerButtons || [])
          .filter((b) => b.enabled !== false)
          .map((b) => {
            return (
              "<button type='button' class='mock-btn mock-" +
              escapeHtml(b.style || "Primary") +
              "'>" +
              (b.emoji ? escapeHtml(b.emoji) + " " : "") +
              escapeHtml(b.label) +
              "</button>"
            );
          })
          .join("");
      }
    };

    const renderDesignerButtonsEditor = () => {
      const listEl = document.getElementById("designerButtonsList");
      if (!listEl) return;
      const btns = clientState.designerButtons || [];
      listEl.innerHTML = btns
        .map((btn, idx) => {
          const currentStyle = btn.style || "Primary";
          return (
            "<div class='btn-designer-row'>" +
            "<div style='display:flex;align-items:center;gap:8px;flex:1;min-width:190px;flex-wrap:wrap;'>" +
            "<span style='font-size:15px;'>" +
            escapeHtml(btn.emoji || "🔘") +
            "</span>" +
            "<input type='text' class='btn-label-input' data-idx='" +
            idx +
            "' value='" +
            escapeHtml(btn.label || "") +
            "' placeholder='Düymə adı' style='flex:1;min-width:120px;padding:7px 10px;' />" +
            "<select class='btn-style-select' data-idx='" +
            idx +
            "' style='width:125px;padding:7px 8px;'>" +
            "<option value='Primary'" +
            (currentStyle === "Primary" ? " selected" : "") +
            ">Primary (Mavi)</option>" +
            "<option value='Secondary'" +
            (currentStyle === "Secondary" ? " selected" : "") +
            ">Secondary (Boz)</option>" +
            "<option value='Success'" +
            (currentStyle === "Success" ? " selected" : "") +
            ">Success (Yaşıl)</option>" +
            "<option value='Danger'" +
            (currentStyle === "Danger" ? " selected" : "") +
            ">Danger (Qırmızı)</option>" +
            "</select>" +
            "</div>" +
            "<div class='row'>" +
            "<button type='button' class='btn btn-ghost btn-sm btn-move-up' data-idx='" +
            idx +
            "'>▲</button>" +
            "<button type='button' class='btn btn-ghost btn-sm btn-move-down' data-idx='" +
            idx +
            "'>▼</button>" +
            "<button type='button' class='btn btn-ghost btn-sm btn-toggle-btn' data-idx='" +
            idx +
            "'>" +
            (btn.enabled !== false ? "Aktiv" : "Gizli") +
            "</button>" +
            "</div>" +
            "</div>"
          );
        })
        .join("");

      listEl.querySelectorAll(".btn-label-input").forEach((inp) => {
        inp.addEventListener("input", () => {
          const i = Number(inp.getAttribute("data-idx"));
          if (clientState.designerButtons[i]) {
            clientState.designerButtons[i].label = inp.value;
            renderDesignerPreview();
          }
        });
      });

      listEl.querySelectorAll(".btn-style-select").forEach((sel) => {
        sel.addEventListener("change", () => {
          const i = Number(sel.getAttribute("data-idx"));
          if (clientState.designerButtons[i]) {
            clientState.designerButtons[i].style = sel.value;
            renderDesignerPreview();
          }
        });
      });

      listEl.querySelectorAll(".btn-move-up").forEach((b) => {
        b.addEventListener("click", () => {
          const i = Number(b.getAttribute("data-idx"));
          if (i > 0) {
            const temp = clientState.designerButtons[i - 1];
            clientState.designerButtons[i - 1] = clientState.designerButtons[i];
            clientState.designerButtons[i] = temp;
            renderDesignerButtonsEditor();
            renderDesignerPreview();
          }
        });
      });

      listEl.querySelectorAll(".btn-move-down").forEach((b) => {
        b.addEventListener("click", () => {
          const i = Number(b.getAttribute("data-idx"));
          if (i < clientState.designerButtons.length - 1) {
            const temp = clientState.designerButtons[i + 1];
            clientState.designerButtons[i + 1] = clientState.designerButtons[i];
            clientState.designerButtons[i] = temp;
            renderDesignerButtonsEditor();
            renderDesignerPreview();
          }
        });
      });

      listEl.querySelectorAll(".btn-toggle-btn").forEach((b) => {
        b.addEventListener("click", () => {
          const i = Number(b.getAttribute("data-idx"));
          if (clientState.designerButtons[i]) {
            clientState.designerButtons[i].enabled = clientState.designerButtons[i].enabled === false;
            renderDesignerButtonsEditor();
            renderDesignerPreview();
          }
        });
      });
    };

    const applySnapshotToUi = (snap) => {
      clientState.snapshot = snap;

      const planInfo = snap.plan || { label: "Free", scriptLimit: 1, scriptsUsed: 0, boundApiKey: "" };
      if (document.getElementById("headerPlanLabel")) {
        document.getElementById("headerPlanLabel").textContent = planInfo.label || "Free";
      }
      if (document.getElementById("currentPlanBadgeText")) {
        document.getElementById("currentPlanBadgeText").textContent = planInfo.label || "Free";
      }
      if (document.getElementById("currentPlanUsageText")) {
        const limitText =
          planInfo.scriptLimit === null || planInfo.scriptLimit === undefined
            ? "∞"
            : String(planInfo.scriptLimit);
        document.getElementById("currentPlanUsageText").textContent =
          String(planInfo.scriptsUsed || 0) + " / " + limitText + " script";
      }

      const redeemApiInp = document.getElementById("redeemApiKeyInput");
      if (redeemApiInp && document.activeElement !== redeemApiInp && planInfo.boundApiKey) {
        redeemApiInp.value = planInfo.boundApiKey;
      }

      const adminCard = document.getElementById("adminApiManagerCard");
      if (adminCard) {
        const showAdmin = Boolean(CLIENT_ADMIN_FLAG && snap.isAdminView);
        adminCard.style.display = showAdmin ? "block" : "none";
        if (showAdmin) {
          const adminKeys = Array.isArray(snap.adminApiKeys) ? snap.adminApiKeys : [];
          const adminBody = document.getElementById("adminApiKeysTableBody");
          if (adminBody) {
            adminBody.innerHTML = adminKeys.length
              ? adminKeys
                  .map((ak) => {
                    return (
                      "<tr>" +
                      "<td><code>" +
                      escapeHtml(ak.key) +
                      "</code></td>" +
                      "<td><span class='badge badge-green'>" +
                      escapeHtml(ak.planLabel || ak.planTier) +
                      "</span></td>" +
                      "<td>" +
                      escapeHtml(ak.note || "-") +
                      "</td>" +
                      "<td><button class='btn btn-danger btn-sm btn-del-api' data-id='" +
                      escapeHtml(ak.id) +
                      "'>Sil</button></td>" +
                      "</tr>"
                    );
                  })
                  .join("")
              : "<tr><td colspan='4' style='color:#94a3b8;'>Hələ API açar yaradılmayıb.</td></tr>";

            adminBody.querySelectorAll(".btn-del-api").forEach((btn) => {
              btn.addEventListener("click", async () => {
                const apiId = btn.getAttribute("data-id");
                try {
                  await apiRequest("/api/admin/api-keys/" + encodeURIComponent(apiId), "DELETE");
                  showToast("API açar silindi");
                  await refreshDashboardSnapshot();
                } catch (err) {
                  showToast(err.message);
                }
              });
            });
          }
        }
      }

      const bot = snap.bot || {};
      const pillEl = document.getElementById("botStatusPill");
      const statusTextEl = document.getElementById("botStatusText");
      if (pillEl && statusTextEl) {
        statusTextEl.textContent = bot.statusText || "Bot: Aktiv deyil — Gözləmədədir";
        pillEl.classList.toggle("offline", !bot.active);
      }

      const guild = snap.guild || {};
      if (document.getElementById("headerGuildName")) {
        document.getElementById("headerGuildName").textContent = guild.displayName || "Bağlı Sunucu Yoxdur";
      }
      const guildInp = document.getElementById("guildIdInput");
      if (guildInp && document.activeElement !== guildInp) {
        guildInp.value = clientState.deviceGuildId || guild.guildId || "";
      }
      const chInp = document.getElementById("panelChannelIdInput");
      if (chInp && document.activeElement !== chInp) {
        chInp.value = guild.panelChannelId || "";
      }

      const stats = snap.stats || {};
      if (document.getElementById("statScriptsCount")) {
        document.getElementById("statScriptsCount").textContent = String(stats.scriptsCount || 0);
      }
      if (document.getElementById("statKeysCount")) {
        document.getElementById("statKeysCount").textContent = String(stats.keysCount || 0);
      }
      if (document.getElementById("statWhitelistCount")) {
        document.getElementById("statWhitelistCount").textContent = String(stats.whitelistCount || 0);
      }
      if (document.getElementById("statBlacklistCount")) {
        document.getElementById("statBlacklistCount").textContent = String(stats.blacklistCount || 0);
      }

      const scriptsList = Array.isArray(snap.scripts) ? snap.scripts : [];
      const scriptSelectOptions =
        "<option value=''>Script seçin</option>" +
        scriptsList
          .map((s) => "<option value='" + escapeHtml(s.id) + "'>" + escapeHtml(s.name) + "</option>")
          .join("");

      if (document.getElementById("quickPanelScriptSelect")) {
        document.getElementById("quickPanelScriptSelect").innerHTML = scriptSelectOptions;
      }
      if (document.getElementById("newKeyScriptSelect")) {
        document.getElementById("newKeyScriptSelect").innerHTML = scriptSelectOptions;
      }
      if (document.getElementById("whitelistScriptSelect")) {
        document.getElementById("whitelistScriptSelect").innerHTML = scriptSelectOptions;
      }

      const scriptsBody = document.getElementById("scriptsTableBody");
      if (scriptsBody) {
        scriptsBody.innerHTML = scriptsList.length
          ? scriptsList
              .map((sc) => {
                const sourceText =
                  sc.sourceType === "file"
                    ? "Fayl (" + (sc.fileName || "script.lua") + ")"
                    : sc.scriptUrl || "URL";
                const loaderStr =
                  'loadstring(game:HttpGet("' +
                  window.location.origin +
                  "/raw/" +
                  encodeURIComponent(sc.id) +
                  '", true))()';
                return (
                  "<tr>" +
                  "<td><strong>" +
                  escapeHtml(sc.name) +
                  "</strong></td>" +
                  "<td>" +
                  escapeHtml(sourceText) +
                  "</td>" +
                  "<td><code style='font-size:11px;'>" +
                  escapeHtml(loaderStr) +
                  "</code></td>" +
                  "<td class='row'>" +
                  "<button class='btn btn-ghost btn-sm btn-edit-script' data-id='" +
                  escapeHtml(sc.id) +
                  "'>Düzəliş Et</button>" +
                  "<button class='btn btn-danger btn-sm btn-del-script' data-id='" +
                  escapeHtml(sc.id) +
                  "'>Sil</button>" +
                  "</td>" +
                  "</tr>"
                );
              })
              .join("")
          : "<tr><td colspan='4' style='color:#94a3b8;'>Bu sunucuda hələ script yoxdur.</td></tr>";

        scriptsBody.querySelectorAll(".btn-edit-script").forEach((btn) => {
          btn.addEventListener("click", () => {
            const sid = btn.getAttribute("data-id");
            const found = scriptsList.find((x) => x.id === sid);
            if (!found) return;
            clientState.editingScriptId = found.id;
            clientState.editScriptFilePayload = { fileName: "", content: "" };
            document.getElementById("editScriptNameInput").value = found.name || "";
            document.getElementById("editScriptSourceType").value = found.sourceType || "url";
            document.getElementById("editScriptUrlInput").value = found.scriptUrl || "";
            const isFileMode = (found.sourceType || "url") === "file";
            document.getElementById("editScriptUrlGroup").style.display = isFileMode ? "none" : "block";
            document.getElementById("editScriptFileGroup").style.display = isFileMode ? "block" : "none";
            document.getElementById("editScriptCard").style.display = "block";
          });
        });

        scriptsBody.querySelectorAll(".btn-del-script").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const sid = btn.getAttribute("data-id");
            try {
              await apiRequest("/api/scripts/" + encodeURIComponent(sid), "DELETE");
              showToast("Script silindi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });
      }

      const keysList = Array.isArray(snap.keys) ? snap.keys : [];
      const keysBody = document.getElementById("keysTableBody");
      if (keysBody) {
        keysBody.innerHTML = keysList.length
          ? keysList
              .map((k) => {
                return (
                  "<tr>" +
                  "<td><code>" +
                  escapeHtml(k.key) +
                  "</code></td>" +
                  "<td>" +
                  escapeHtml(k.scriptName || "Hamısı") +
                  "</td>" +
                  "<td>" +
                  escapeHtml(k.discordUserId || "-") +
                  "</td>" +
                  "<td>" +
                  escapeHtml(k.hwid || "-") +
                  "</td>" +
                  "<td class='row'>" +
                  "<button class='btn btn-ghost btn-sm btn-reset-key-hwid' data-id='" +
                  escapeHtml(k.id) +
                  "'>Reset HWID</button>" +
                  "<button class='btn btn-danger btn-sm btn-del-key' data-id='" +
                  escapeHtml(k.id) +
                  "'>Sil</button>" +
                  "</td>" +
                  "</tr>"
                );
              })
              .join("")
          : "<tr><td colspan='5' style='color:#94a3b8;'>Key yaradılmayıb.</td></tr>";

        keysBody.querySelectorAll(".btn-reset-key-hwid").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const kid = btn.getAttribute("data-id");
            try {
              await apiRequest("/api/keys/" + encodeURIComponent(kid) + "/reset-hwid", "POST");
              showToast("HWID sıfırlandı");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });

        keysBody.querySelectorAll(".btn-del-key").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const kid = btn.getAttribute("data-id");
            try {
              await apiRequest("/api/keys/" + encodeURIComponent(kid), "DELETE");
              showToast("Key silindi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });
      }

      const wlList = Array.isArray(snap.whitelist) ? snap.whitelist : [];
      const wlBody = document.getElementById("whitelistTableBody");
      if (wlBody) {
        wlBody.innerHTML = wlList.length
          ? wlList
              .map((w) => {
                return (
                  "<tr>" +
                  "<td><code>" +
                  escapeHtml(w.userId) +
                  "</code></td>" +
                  "<td>" +
                  escapeHtml(w.scriptName || "Seçilən Script") +
                  "</td>" +
                  "<td><button class='btn btn-danger btn-sm btn-del-wl' data-id='" +
                  escapeHtml(w.id) +
                  "'>Sil</button></td>" +
                  "</tr>"
                );
              })
              .join("")
          : "<tr><td colspan='3' style='color:#94a3b8;'>Whitelist boşdur.</td></tr>";

        wlBody.querySelectorAll(".btn-del-wl").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const wid = btn.getAttribute("data-id");
            try {
              await apiRequest("/api/whitelist/" + encodeURIComponent(wid), "DELETE");
              showToast("Whitelist-dən silindi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });
      }

      const blList = Array.isArray(snap.blacklist) ? snap.blacklist : [];
      const blBody = document.getElementById("blacklistTableBody");
      if (blBody) {
        blBody.innerHTML = blList.length
          ? blList
              .map((b) => {
                return (
                  "<tr>" +
                  "<td><code>" +
                  escapeHtml(b.userId) +
                  "</code></td>" +
                  "<td><button class='btn btn-danger btn-sm btn-del-bl' data-id='" +
                  escapeHtml(b.id) +
                  "'>Sil</button></td>" +
                  "</tr>"
                );
              })
              .join("")
          : "<tr><td colspan='2' style='color:#94a3b8;'>Blacklist boşdur.</td></tr>";

        blBody.querySelectorAll(".btn-del-bl").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const bid = btn.getAttribute("data-id");
            try {
              await apiRequest("/api/blacklist/" + encodeURIComponent(bid), "DELETE");
              showToast("Blacklist-dən silindi");
              await refreshDashboardSnapshot();
            } catch (err) {
              showToast(err.message);
            }
          });
        });
      }

      const design = snap.panelDesign || {};
      if (document.activeElement !== document.getElementById("designTitleInput")) {
        document.getElementById("designTitleInput").value = design.title || "";
      }
      if (document.activeElement !== document.getElementById("designDescInput")) {
        document.getElementById("designDescInput").value = design.description || "";
      }
      if (document.activeElement !== document.getElementById("designColorInput")) {
        document.getElementById("designColorInput").value = design.colorHex || "#6366f1";
      }
      if (document.activeElement !== document.getElementById("designFooterInput")) {
        document.getElementById("designFooterInput").value = design.footerText || "";
      }
      if (document.activeElement !== document.getElementById("designImageInput")) {
        document.getElementById("designImageInput").value = design.imageUrl || "";
      }
      if (Array.isArray(design.buttons)) {
        clientState.designerButtons = design.buttons.map((b) => ({ ...b }));
      }
      renderDesignerButtonsEditor();
      renderDesignerPreview();

      const logsList = Array.isArray(snap.auditLogs) ? snap.auditLogs : [];
      const logsEl = document.getElementById("auditLogList");
      if (logsEl) {
        logsEl.innerHTML = logsList.length
          ? logsList
              .slice(0, 20)
              .map((lg) => {
                return (
                  "<div style='padding:8px 10px;border-radius:10px;background:#0b1120;border:1px solid rgba(148,163,184,0.14);font-size:12px;'>" +
                  "<strong>" +
                  escapeHtml(lg.action) +
                  "</strong>: " +
                  escapeHtml(lg.detail) +
                  "</div>"
                );
              })
              .join("")
          : "<div style='color:#94a3b8;font-size:12px;'>Hələ qeyd yoxdur.</div>";
      }
    };

    const refreshDashboardSnapshot = async () => {
      try {
        const params = new URLSearchParams();
        if (clientState.deviceGuildId) params.set("guildId", clientState.deviceGuildId);
        if (CLIENT_ADMIN_FLAG) params.set("admin", "1");
        const querySuffix = params.toString() ? "?" + params.toString() : "";
        const snap = await apiRequest("/api/snapshot" + querySuffix, "GET");
        applySnapshotToUi(snap);
      } catch (err) {
        showToast("Yeniləmə xətası: " + err.message);
      }
    };

    const sendQuickPanel = async () => {
      try {
        const gid = (document.getElementById("guildIdInput") || {}).value || clientState.deviceGuildId;
        const chId = (document.getElementById("panelChannelIdInput") || {}).value || "";
        const scriptId = (document.getElementById("quickPanelScriptSelect") || {}).value || "";
        await apiRequest("/api/panel/send", "POST", {
          guildId: gid,
          channelId: chId,
          scriptId
        });
        showToast("Panel Discord kanalına göndərildi");
      } catch (err) {
        showToast(err.message);
      }
    };

    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll(".nav-item").forEach((navBtn) => {
        navBtn.addEventListener("click", () => {
          const targetTab = navBtn.getAttribute("data-tab");
          document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
          document.querySelectorAll(".tab-section").forEach((sec) => sec.classList.remove("active"));
          navBtn.classList.add("active");
          const activeSec = document.getElementById("tab-" + targetTab);
          if (activeSec) activeSec.classList.add("active");
        });
      });

      document.getElementById("refreshSnapshotBtn").addEventListener("click", refreshDashboardSnapshot);
      document.getElementById("sendPanelQuickBtn").addEventListener("click", sendQuickPanel);
      document.getElementById("sendDesignedPanelBtn").addEventListener("click", sendQuickPanel);

      document.getElementById("activateApiKeyBtn").addEventListener("click", async () => {
        const apiKeyStr = ((document.getElementById("redeemApiKeyInput") || {}).value || "").trim();
        try {
          const res = await apiRequest("/api/plan/activate-api", "POST", { apiKey: apiKeyStr });
          showToast("Plan aktivləşdirildi: " + ((res.plan && res.plan.label) || ""));
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("adminGenerateApiKeyBtn").addEventListener("click", async () => {
        const planTier = ((document.getElementById("adminNewApiPlanSelect") || {}).value || "premium_1").trim();
        const note = ((document.getElementById("adminNewApiNoteInput") || {}).value || "").trim();
        try {
          const res = await apiRequest("/api/admin/api-keys", "POST", { planTier, note });
          if (document.getElementById("adminNewApiNoteInput")) {
            document.getElementById("adminNewApiNoteInput").value = "";
          }
          showToast("Yeni API Açar yaradıldı: " + ((res.apiKey && res.apiKey.key) || ""));
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("saveGuildSettingsBtn").addEventListener("click", async () => {
        const gid = ((document.getElementById("guildIdInput") || {}).value || "").replace(/\D/g, "");
        const chId = ((document.getElementById("panelChannelIdInput") || {}).value || "").replace(/\D/g, "");
        if (!/^\d{15,22}$/.test(gid)) {
          showToast("Düzgün Sunucu ID daxil edin");
          return;
        }
        clientState.deviceGuildId = gid;
        localStorage.setItem(CLIENT_GUILD_STORAGE_KEY, gid);
        try {
          await apiRequest("/api/settings/guild", "POST", { guildId: gid, panelChannelId: chId });
          showToast("Sunucu bağlandı");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("newScriptSourceType").addEventListener("change", (e) => {
        const isFile = e.target.value === "file";
        document.getElementById("newScriptUrlGroup").style.display = isFile ? "none" : "block";
        document.getElementById("newScriptFileGroup").style.display = isFile ? "block" : "none";
      });

      document.getElementById("newScriptFileInput").addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          clientState.newScriptFilePayload = {
            fileName: file.name,
            content: String(reader.result || "")
          };
        };
        reader.readAsText(file);
      });

      document.getElementById("createScriptBtn").addEventListener("click", async () => {
        const name = ((document.getElementById("newScriptNameInput") || {}).value || "").trim();
        const sourceType = ((document.getElementById("newScriptSourceType") || {}).value || "url").trim();
        const scriptUrl = ((document.getElementById("newScriptUrlInput") || {}).value || "").trim();
        try {
          await apiRequest("/api/scripts", "POST", {
            name,
            sourceType,
            scriptUrl,
            fileName: clientState.newScriptFilePayload.fileName,
            scriptContent: clientState.newScriptFilePayload.content
          });
          document.getElementById("newScriptNameInput").value = "";
          document.getElementById("newScriptUrlInput").value = "";
          document.getElementById("newScriptFileInput").value = "";
          clientState.newScriptFilePayload = { fileName: "", content: "" };
          showToast("Script yaradıldı");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("editScriptSourceType").addEventListener("change", (e) => {
        const isFile = e.target.value === "file";
        document.getElementById("editScriptUrlGroup").style.display = isFile ? "none" : "block";
        document.getElementById("editScriptFileGroup").style.display = isFile ? "block" : "none";
      });

      document.getElementById("editScriptFileInput").addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          clientState.editScriptFilePayload = {
            fileName: file.name,
            content: String(reader.result || "")
          };
        };
        reader.readAsText(file);
      });

      document.getElementById("cancelEditScriptBtn").addEventListener("click", () => {
        clientState.editingScriptId = "";
        document.getElementById("editScriptCard").style.display = "none";
      });

      document.getElementById("saveEditScriptBtn").addEventListener("click", async () => {
        if (!clientState.editingScriptId) return;
        const name = ((document.getElementById("editScriptNameInput") || {}).value || "").trim();
        const sourceType = ((document.getElementById("editScriptSourceType") || {}).value || "url").trim();
        const scriptUrl = ((document.getElementById("editScriptUrlInput") || {}).value || "").trim();
        try {
          await apiRequest("/api/scripts/" + encodeURIComponent(clientState.editingScriptId), "PUT", {
            name,
            sourceType,
            scriptUrl,
            fileName: clientState.editScriptFilePayload.fileName,
            scriptContent: clientState.editScriptFilePayload.content
          });
          clientState.editingScriptId = "";
          document.getElementById("editScriptCard").style.display = "none";
          showToast("Script yeniləndi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("createKeyBtn").addEventListener("click", async () => {
        const scriptId = ((document.getElementById("newKeyScriptSelect") || {}).value || "").trim();
        const days = Number(((document.getElementById("newKeyDaysInput") || {}).value || "0").trim());
        const note = ((document.getElementById("newKeyNoteInput") || {}).value || "").trim();
        try {
          await apiRequest("/api/keys", "POST", { scriptId, days, note });
          document.getElementById("newKeyNoteInput").value = "";
          showToast("Yeni Key yaradıldı");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      ["designTitleInput", "designDescInput", "designColorInput", "designFooterInput"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", renderDesignerPreview);
      });

      document.getElementById("saveDesignBtn").addEventListener("click", async () => {
        const payload = {
          title: ((document.getElementById("designTitleInput") || {}).value || "").trim(),
          description: ((document.getElementById("designDescInput") || {}).value || "").trim(),
          colorHex: ((document.getElementById("designColorInput") || {}).value || "#6366f1").trim(),
          footerText: ((document.getElementById("designFooterInput") || {}).value || "").trim(),
          imageUrl: ((document.getElementById("designImageInput") || {}).value || "").trim(),
          buttons: clientState.designerButtons
        };
        try {
          await apiRequest("/api/design", "POST", payload);
          showToast("Panel dizaynı yadda saxlandı");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("addWhitelistBtn").addEventListener("click", async () => {
        const userId = ((document.getElementById("whitelistUserInput") || {}).value || "").trim();
        const scriptId = ((document.getElementById("whitelistScriptSelect") || {}).value || "").trim();
        try {
          await apiRequest("/api/whitelist", "POST", { userId, scriptId });
          document.getElementById("whitelistUserInput").value = "";
          showToast("Whitelist-ə əlavə edildi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      document.getElementById("addBlacklistBtn").addEventListener("click", async () => {
        const userId = ((document.getElementById("blacklistUserInput") || {}).value || "").trim();
        try {
          await apiRequest("/api/blacklist", "POST", { userId });
          document.getElementById("blacklistUserInput").value = "";
          showToast("Blacklist-ə əlavə edildi");
          await refreshDashboardSnapshot();
        } catch (err) {
          showToast(err.message);
        }
      });

      refreshDashboardSnapshot();
    });
  </script>
</body>
</html>`;
};

const parseRequestJsonBody = (req) => {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (_e) {
        resolve({});
      }
    });
  });
};

const sendJsonResponse = (res, statusCode, dataObj) => {
  const bodyStr = JSON.stringify(dataObj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(bodyStr)
  });
  res.end(bodyStr);
};

const sendTextResponse = (res, statusCode, textStr, contentType = "text/plain; charset=utf-8") => {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(textStr)
  });
  res.end(textStr);
};

const server = http.createServer(async (req, res) => {
  const method = (req.method || "GET").toUpperCase();
  const baseUrl = getBasePublicUrl(req);
  const reqUrl = new URL(req.url || "/", baseUrl);
  const pathname = reqUrl.pathname;

  try {
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      sendTextResponse(res, 200, renderDashboardHtml(), "text/html; charset=utf-8");
      return;
    }

    if (method === "GET" && pathname === "/health") {
      sendJsonResponse(res, 200, { ok: true, botConnected: BOT_RUNTIME.connected });
      return;
    }

    if (method === "GET" && pathname === "/api/snapshot") {
      const targetGuildId = resolveRequestGuildId(req, reqUrl, null);
      const isAdminReq = reqUrl.searchParams.get("admin") === "1";
      const snapshot = await buildPublicSnapshotPayload(targetGuildId, isAdminReq);
      sendJsonResponse(res, 200, snapshot);
      return;
    }

    if (method === "POST" && pathname === "/api/plan/activate-api") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə İdarəetmə bölməsindən öz Sunucu ID-nizi bağlayın" });
        return;
      }

      const inputApiKey = sanitizeText(body.apiKey, "").toUpperCase();
      if (!inputApiKey) {
        sendJsonResponse(res, 400, { error: "Zəhmət olmasa API açar daxil edin" });
        return;
      }

      const apiKeysList = Array.isArray(APP_STATE.apiKeys) ? APP_STATE.apiKeys : [];
      const foundApiKey = apiKeysList.find(
        (ak) => ak && ak.active !== false && sanitizeText(ak.key, "").toUpperCase() === inputApiKey
      );
      if (!foundApiKey) {
        sendJsonResponse(res, 404, { error: "Yanlış və ya aktiv olmayan API açar" });
        return;
      }

      const planCfg = getPlanConfigByTier(foundApiKey.planTier);
      tenant.planTier = planCfg.id;
      tenant.boundApiKey = foundApiKey.key;
      foundApiKey.boundGuildId = tenant.guildId;
      foundApiKey.boundAt = new Date().toISOString();

      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog(
        "PLAN_ACTIVATED",
        `API açar ilə plan bağlandı: ${planCfg.label} (${foundApiKey.key})`,
        "Dashboard",
        tenant.guildId
      );

      sendJsonResponse(res, 200, {
        ok: true,
        plan: {
          tier: planCfg.id,
          label: planCfg.label,
          scriptLimit: planCfg.scriptLimit,
          boundApiKey: foundApiKey.key
        }
      });
      return;
    }

    if (method === "POST" && pathname === "/api/admin/api-keys") {
      const body = await parseRequestJsonBody(req);
      const planCfg = getPlanConfigByTier(body.planTier);
      const note = sanitizeText(body.note, "");
      const createdKey = {
        id: generateUniqueId("apikey"),
        key: generateApiKeyString(),
        planTier: planCfg.id,
        planLabel: planCfg.label,
        note,
        active: true,
        boundGuildId: "",
        createdAt: new Date().toISOString()
      };

      APP_STATE.apiKeys = [createdKey, ...(Array.isArray(APP_STATE.apiKeys) ? APP_STATE.apiKeys : [])];
      saveAppStateToDisk();
      appendAuditLog("ADMIN_API_CREATED", `Yönetici API açar yaratdı (${planCfg.label}): ${createdKey.key}`, "Admin");

      sendJsonResponse(res, 201, { ok: true, apiKey: createdKey });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/admin/api-keys/")) {
      const apiKeyId = sanitizeText(pathname.replace("/api/admin/api-keys/", ""), "");
      const currentKeys = Array.isArray(APP_STATE.apiKeys) ? APP_STATE.apiKeys : [];
      const targetAk = currentKeys.find((ak) => ak && ak.id === apiKeyId) || null;
      APP_STATE.apiKeys = currentKeys.filter((ak) => ak && ak.id !== apiKeyId);

      if (targetAk && targetAk.key) {
        const allTenants = Object.values(ensureTenantStore());
        for (const tObj of allTenants) {
          if (tObj && sanitizeText(tObj.boundApiKey, "") === sanitizeText(targetAk.key, "")) {
            tObj.boundApiKey = "";
            tObj.planTier = "free";
            syncTenantIntoGlobalIfPrimary(tObj);
          }
        }
      }

      saveAppStateToDisk();
      appendAuditLog("ADMIN_API_DELETED", `Yönetici API açar sildi: ${targetAk ? targetAk.key : apiKeyId}`, "Admin");
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/settings/guild") {
      const body = await parseRequestJsonBody(req);
      const cleanGid = sanitizeSnowflakeId(body.guildId);
      const cleanChId = sanitizeSnowflakeId(body.panelChannelId);
      if (!cleanGid) {
        sendJsonResponse(res, 400, { error: "Düzgün Sunucu ID daxil edin" });
        return;
      }

      const tenant = getTenantRecordByGuildId(cleanGid);
      if (cleanChId) {
        tenant.panelChannelId = cleanChId;
      }
      const freshName = await resolveGuildDisplayName(cleanGid, tenant.guildName);
      if (freshName) {
        tenant.guildName = freshName;
      }
      if (!APP_STATE.guildId) {
        APP_STATE.guildId = cleanGid;
      }
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(cleanGid);
      appendAuditLog("GUILD_BOUND", `Sunucu bağlandı: ${cleanGid}`, "Dashboard", cleanGid);

      sendJsonResponse(res, 200, { ok: true, guildId: cleanGid });
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

      const activePlan = resolveTenantEffectivePlan(tenant);
      const existingScriptsCount = Array.isArray(tenant.scripts) ? tenant.scripts.length : 0;
      if (activePlan.scriptLimit !== null && existingScriptsCount >= activePlan.scriptLimit) {
        sendJsonResponse(res, 403, {
          error: `${activePlan.label} planında maksimum ${activePlan.scriptLimit} script yarada bilərsiniz. Daha çox script üçün planı yüksəldin.`
        });
        return;
      }

      const scriptName = sanitizeText(body.name, "");
      if (!scriptName) {
        sendJsonResponse(res, 400, { error: "Script adı boş ola bilməz" });
        return;
      }

      const sourceType = body.sourceType === "file" ? "file" : "url";
      const scriptUrl = sanitizeText(body.scriptUrl, "");
      const fileName = sanitizeText(body.fileName, "script.lua");
      const scriptContent = typeof body.scriptContent === "string" ? body.scriptContent : "";

      if (sourceType === "url" && !scriptUrl) {
        sendJsonResponse(res, 400, { error: "Script URL daxil edin" });
        return;
      }
      if (sourceType === "file" && !scriptContent) {
        sendJsonResponse(res, 400, { error: "Zəhmət olmasa .lua və ya .txt fayl seçin" });
        return;
      }

      const newScript = {
        id: generateUniqueId("scr"),
        guildId: tenant.guildId,
        name: scriptName,
        sourceType,
        scriptUrl: sourceType === "url" ? scriptUrl : "",
        fileName: sourceType === "file" ? fileName : "",
        scriptContent: sourceType === "file" ? scriptContent : "",
        createdAt: new Date().toISOString()
      };

      tenant.scripts = [newScript, ...(tenant.scripts || [])];
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(tenant.guildId);
      appendAuditLog("SCRIPT_CREATED", `Script yaradıldı: ${newScript.name}`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 201, { ok: true, script: newScript });
      return;
    }

    if (method === "PUT" && pathname.startsWith("/api/scripts/")) {
      const scriptId = sanitizeText(pathname.replace("/api/scripts/", ""), "");
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Sunucu tapılmadı" });
        return;
      }

      const targetScript = (tenant.scripts || []).find((s) => s.id === scriptId);
      if (!targetScript) {
        sendJsonResponse(res, 404, { error: "Script tapılmadı" });
        return;
      }

      if (body.name) {
        targetScript.name = sanitizeText(body.name, targetScript.name);
      }
      const nextSourceType = body.sourceType === "file" ? "file" : "url";
      targetScript.sourceType = nextSourceType;
      if (nextSourceType === "file") {
        if (typeof body.scriptContent === "string" && body.scriptContent.length > 0) {
          targetScript.scriptContent = body.scriptContent;
        }
        if (body.fileName) {
          targetScript.fileName = sanitizeText(body.fileName, targetScript.fileName || "script.lua");
        }
      } else if (body.scriptUrl) {
        targetScript.scriptUrl = sanitizeText(body.scriptUrl, targetScript.scriptUrl);
      }

      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(tenant.guildId);
      appendAuditLog("SCRIPT_UPDATED", `Script yeniləndi: ${targetScript.name}`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 200, { ok: true, script: targetScript });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/scripts/")) {
      const scriptId = sanitizeText(pathname.replace("/api/scripts/", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Sunucu tapılmadı" });
        return;
      }

      tenant.scripts = (tenant.scripts || []).filter((s) => s.id !== scriptId);
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      await syncSlashCommandsWithDiscord(tenant.guildId);
      appendAuditLog("SCRIPT_DELETED", `Script silindi: ${scriptId}`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/keys") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə Sunucu ID bağlayın" });
        return;
      }

      const scriptId = sanitizeText(body.scriptId, "");
      const matchedScript = scriptId ? (tenant.scripts || []).find((s) => s.id === scriptId) : null;
      const days = Math.max(0, Number(body.days || 0));
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : "";

      const newKey = {
        id: generateUniqueId("key"),
        key: generateLicenseKeyString(),
        scriptId: matchedScript ? matchedScript.id : "",
        scriptName: matchedScript ? matchedScript.name : "Hamısı",
        note: sanitizeText(body.note, ""),
        discordUserId: "",
        hwid: "",
        status: "active",
        expiresAt,
        createdAt: new Date().toISOString()
      };

      tenant.keys = [newKey, ...(tenant.keys || [])];
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("KEY_CREATED", `Yeni key yaradıldı: ${newKey.key}`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 201, { ok: true, key: newKey });
      return;
    }

    if (method === "POST" && pathname.endsWith("/reset-hwid") && pathname.startsWith("/api/keys/")) {
      const keyId = sanitizeText(pathname.replace("/api/keys/", "").replace("/reset-hwid", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Sunucu tapılmadı" });
        return;
      }

      const targetKey = (tenant.keys || []).find((k) => k.id === keyId);
      if (!targetKey) {
        sendJsonResponse(res, 404, { error: "Key tapılmadı" });
        return;
      }

      targetKey.hwid = "";
      targetKey.hwidResetAt = new Date().toISOString();
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("KEY_HWID_RESET", `Key HWID sıfırlandı: ${targetKey.key}`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/keys/")) {
      const keyId = sanitizeText(pathname.replace("/api/keys/", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Sunucu tapılmadı" });
        return;
      }

      const targetKey = (tenant.keys || []).find((k) => k.id === keyId) || null;
      tenant.keys = (tenant.keys || []).filter((k) => k.id !== keyId);
      if (targetKey && targetKey.discordUserId) {
        removeUserFromWhitelist(targetKey.discordUserId, tenant.guildId, targetKey.scriptId || "");
      }
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("KEY_DELETED", `Key silindi: ${targetKey ? targetKey.key : keyId}`, "Dashboard", tenant.guildId);

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/design") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə Sunucu ID bağlayın" });
        return;
      }

      tenant.panelDesign = normalizePanelDesign(body);
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("DESIGN_UPDATED", "Panel dizaynı yeniləndi", "Dashboard", tenant.guildId);

      sendJsonResponse(res, 200, { ok: true, panelDesign: tenant.panelDesign });
      return;
    }

    if (method === "POST" && pathname === "/api/panel/send") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      if (!reqGuildId) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə Sunucu ID daxil edin" });
        return;
      }

      const tenant = getTenantRecordByGuildId(reqGuildId);
      const channelId = sanitizeSnowflakeId(body.channelId || (tenant && tenant.panelChannelId) || "");
      if (!channelId) {
        sendJsonResponse(res, 400, { error: "Panel göndəriləcək Kanal ID daxil edin" });
        return;
      }

      if (tenant) {
        tenant.panelChannelId = channelId;
        syncTenantIntoGlobalIfPrimary(tenant);
        saveAppStateToDisk();
      }

      const panelPayload = await buildDiscordPanelMessagePayload(reqGuildId, sanitizeText(body.scriptId, ""));
      await sendChannelMessage(channelId, panelPayload);
      appendAuditLog("PANEL_SENT", `Panel göndərildi → Kanal ${channelId}`, "Dashboard", reqGuildId);

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/whitelist") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə Sunucu ID bağlayın" });
        return;
      }

      const uid = extractDiscordUserId(body.userId);
      const scriptId = sanitizeText(body.scriptId, "");
      if (!uid) {
        sendJsonResponse(res, 400, { error: "Düzgün Discord User ID daxil edin" });
        return;
      }
      if (!scriptId) {
        sendJsonResponse(res, 400, { error: "Whitelist üçün script seçin" });
        return;
      }

      const matchedScript = (tenant.scripts || []).find((s) => s.id === scriptId);
      if (!matchedScript) {
        sendJsonResponse(res, 404, { error: "Seçilən script tapılmadı" });
        return;
      }

      addUserToWhitelist(uid, tenant.guildId, matchedScript.id, matchedScript.name, "Dashboard");
      appendAuditLog("WHITELIST_ADD", `Whitelist: ${uid} → ${matchedScript.name}`, "Dashboard", tenant.guildId);
      sendJsonResponse(res, 201, { ok: true });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/whitelist/")) {
      const wid = sanitizeText(pathname.replace("/api/whitelist/", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Sunucu tapılmadı" });
        return;
      }

      tenant.whitelist = (tenant.whitelist || []).filter((w) => w.id !== wid);
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/blacklist") {
      const body = await parseRequestJsonBody(req);
      const reqGuildId = resolveRequestGuildId(req, reqUrl, body);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Əvvəlcə Sunucu ID bağlayın" });
        return;
      }

      const uid = extractDiscordUserId(body.userId);
      if (!uid) {
        sendJsonResponse(res, 400, { error: "Düzgün Discord User ID daxil edin" });
        return;
      }

      tenant.blacklist = [
        {
          id: generateUniqueId("bl"),
          userId: uid,
          createdAt: new Date().toISOString()
        },
        ...(tenant.blacklist || [])
      ];
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      appendAuditLog("BLACKLIST_ADD", `Blacklist: ${uid}`, "Dashboard", tenant.guildId);
      sendJsonResponse(res, 201, { ok: true });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/blacklist/")) {
      const bid = sanitizeText(pathname.replace("/api/blacklist/", ""), "");
      const reqGuildId = resolveRequestGuildId(req, reqUrl, null);
      const tenant = getTenantRecordByGuildId(reqGuildId);
      if (!tenant) {
        sendJsonResponse(res, 400, { error: "Sunucu tapılmadı" });
        return;
      }

      tenant.blacklist = (tenant.blacklist || []).filter((b) => b.id !== bid);
      syncTenantIntoGlobalIfPrimary(tenant);
      saveAppStateToDisk();
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname.startsWith("/raw/")) {
      const scriptId = sanitizeText(pathname.replace("/raw/", ""), "");
      const queryGuildId = sanitizeSnowflakeId(reqUrl.searchParams.get("guildId") || "");
      const allTenants = Object.values(ensureTenantStore());

      let foundScript = null;
      if (queryGuildId) {
        const tObj = getTenantRecordByGuildId(queryGuildId);
        foundScript = (tObj && tObj.scripts ? tObj.scripts : []).find((s) => s.id === scriptId) || null;
      }
      if (!foundScript) {
        for (const tObj of allTenants) {
          const hit = (tObj && Array.isArray(tObj.scripts) ? tObj.scripts : []).find((s) => s.id === scriptId);
          if (hit) {
            foundScript = hit;
            break;
          }
        }
      }

      if (!foundScript) {
        sendTextResponse(res, 404, "-- Script tapılmadı");
        return;
      }

      if (foundScript.sourceType === "file" && foundScript.scriptContent) {
        sendTextResponse(res, 200, foundScript.scriptContent, "text/plain; charset=utf-8");
        return;
      }

      if (foundScript.scriptUrl) {
        sendTextResponse(
          res,
          200,
          `loadstring(game:HttpGet("${foundScript.scriptUrl}", true))()`,
          "text/plain; charset=utf-8"
        );
        return;
      }

      sendTextResponse(res, 404, "-- Script məzmunu boşdur");
      return;
    }

    sendJsonResponse(res, 404, { error: "Tapılmadı" });
  } catch (err) {
    sendJsonResponse(res, 500, { error: err && err.message ? err.message : "Daxili server xətası" });
  }
});

server.listen(SERVER_PORT, () => {
  connectDiscordGateway();
  setInterval(() => {
    try {
      http.get(`http://127.0.0.1:${SERVER_PORT}/health`, () => {}).on("error", () => {});
    } catch (_e) {}
  }, 4 * 60 * 1000);
});
