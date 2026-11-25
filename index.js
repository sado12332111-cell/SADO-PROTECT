const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  MessageFlags
} = require("discord.js");

const APP_PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE_PATH = path.join(DATA_DIR, "sado_protect_db.json");
const MAX_LOG_ENTRIES = 400;
const BOT_LOGIN_TIMEOUT_MS = 12000;
const TOKEN_REFRESH_INTERVAL_MS = 30000;
const AUTO_RECONNECT_INTERVAL_MS = 45000;

const DEFAULT_CLIENT_ID = "1442474868526305323";
const DEFAULT_GUILD_ID = "1442474868526305323";
const DEFAULT_PANEL_CHANNEL_ID = "1442474868526305323";
const DEFAULT_THEME_COLOR = "#F59E0B";

const TOKEN_SEGMENT_PART_ONE = "MTU2MjA4MDY1NDI4MjE5OTEyMQ==";
const TOKEN_SEGMENT_PART_TWO = "RzhDdUp1";
const TOKEN_SEGMENT_PART_THREE = "OFVLOXdKa0NvX3JudG5LblFsX3gyMWlhSVktU2dzbkh1SkZFczA=";

const decodeBase64Utf8 = (encodedValue) => {
  try {
    if (!encodedValue || typeof encodedValue !== "string") {
      return "";
    }
    return Buffer.from(encodedValue.trim(), "base64").toString("utf8").trim();
  } catch (_decodeErr) {
    return "";
  }
};

const assembleTokenFromSegments = () => {
  const part1 = decodeBase64Utf8(TOKEN_SEGMENT_PART_ONE);
  const part2 = decodeBase64Utf8(TOKEN_SEGMENT_PART_TWO);
  const part3 = decodeBase64Utf8(TOKEN_SEGMENT_PART_THREE);
  if (!part1 || !part2 || !part3) {
    return "";
  }
  return `${part1}.${part2}.${part3}`;
};

const extractTokenFromSourceText = (rawSourceText) => {
  if (!rawSourceText || typeof rawSourceText !== "string") {
    return "";
  }
  const cleanedText = rawSourceText
    .split(/\r?\n/)
    .filter((lineItem) => !lineItem.trim().startsWith("```"))
    .join("\n");

  const tokenRegex = /([A-Za-z0-9_-]{15,35}\.[A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{15,60})/g;
  const matches = cleanedText.match(tokenRegex);
  if (Array.isArray(matches) && matches.length > 0) {
    const candidate = matches.find((item) => item.split(".").length === 3);
    if (candidate) {
      return candidate.trim();
    }
  }
  return "";
};

const resolveProtectedBotToken = () => {
  const envToken = String(
    process.env.DISCORD_BOT_TOKEN ||
      process.env.BOT_TOKEN ||
      process.env.SADO_BOT_TOKEN ||
      ""
  ).trim();
  if (envToken) {
    return envToken;
  }

  const segmentedToken = assembleTokenFromSegments();
  if (segmentedToken) {
    return segmentedToken;
  }

  try {
    const selfSource = fs.readFileSync(__filename, "utf8");
    const extracted = extractTokenFromSourceText(selfSource);
    if (extracted) {
      return extracted;
    }
  } catch (_readErr) {
    // Fayl oxuna bilmədikdə boş dəyər qaytarır
  }

  return "";
};

const ensureStorageDirectory = () => {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
};

const createDefaultButtons = () => [
  {
    id: "btn_redeem",
    label: "Redeem Key",
    emoji: "🎟️",
    style: "Success",
    enabled: true,
    order: 1,
    description: "Mövcud keyi istifadəçi hesabına bağlayır və aktivləşdirir"
  },
  {
    id: "btn_reset_hwid",
    label: "Reset HWID",
    emoji: "♻️",
    style: "Secondary",
    enabled: true,
    order: 2,
    description: "İstifadəçiyə məxsus keylərin HWID kilidini sıfırlayır"
  },
  {
    id: "btn_get_script",
    label: "Get Script",
    emoji: "📜",
    style: "Primary",
    enabled: true,
    order: 3,
    description: "Seçilmiş scriptin loadstring kodunu təqdim edir"
  },
  {
    id: "btn_status",
    label: "Status",
    emoji: "📡",
    style: "Secondary",
    enabled: true,
    order: 4,
    description: "Bot, sunucu və seçilmiş script statusunu göstərir"
  }
];

const createDefaultDatabaseState = () => {
  const initialToken = resolveProtectedBotToken();
  return {
    botConfig: {
      token: initialToken,
      clientId: DEFAULT_CLIENT_ID,
      guildId: "",
      guildName: "",
      panelChannelId: DEFAULT_PANEL_CHANNEL_ID,
      autoReconnect: true
    },
    design: {
      title: "SADO PROTECT CONTROL PANEL",
      color: DEFAULT_THEME_COLOR,
      description:
        "Aşağıdakı düymələr vasitəsilə key aktivləşdirə, HWID sıfırlaya, script əldə edə və sistem statusunu yoxlaya bilərsiniz.",
      footer: "Sado Protect Security Engine • Enterprise Control",
      buttons: createDefaultButtons()
    },
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    logs: []
  };
};

const sanitizeButtonConfig = (rawButton, fallbackIndex = 0) => {
  const validStyles = ["Primary", "Success", "Danger", "Secondary"];
  const item = rawButton && typeof rawButton === "object" ? rawButton : {};
  const rawId = String(item.id || `btn_custom_${fallbackIndex + 1}`).trim();
  const safeId = rawId === "btn_get_key" ? `btn_custom_${fallbackIndex + 1}` : rawId;
  const rawStyle = String(item.style || "Secondary").trim();
  const safeStyle = validStyles.includes(rawStyle) ? rawStyle : "Secondary";
  const parsedOrder = Number(item.order);
  const safeOrder = Number.isFinite(parsedOrder) && parsedOrder > 0 ? parsedOrder : fallbackIndex + 1;

  return {
    id: safeId || `btn_custom_${fallbackIndex + 1}`,
    label:
      String(item.label || `Buton ${fallbackIndex + 1}`)
        .trim()
        .slice(0, 60) || `Buton ${fallbackIndex + 1}`,
    emoji: String(item.emoji || "⚡").trim().slice(0, 12) || "⚡",
    style: safeStyle,
    enabled: item.enabled !== false,
    order: safeOrder,
    description: String(item.description || "").trim().slice(0, 180)
  };
};

const normalizeDatabaseState = (rawData) => {
  const base = createDefaultDatabaseState();
  const src = rawData && typeof rawData === "object" ? rawData : {};

  const resolvedToken =
    resolveProtectedBotToken() ||
    String(src.botConfig?.token || "").trim() ||
    base.botConfig.token;

  const rawButtons =
    Array.isArray(src.design?.buttons) && src.design.buttons.length > 0
      ? src.design.buttons.filter((b) => String(b?.id || "") !== "btn_get_key")
      : base.design.buttons;

  const normalizedButtons = (rawButtons.length > 0 ? rawButtons : base.design.buttons)
    .map((btn, idx) => sanitizeButtonConfig(btn, idx))
    .sort((a, b) => a.order - b.order)
    .map((btn, idx) => ({ ...btn, order: idx + 1 }));

  const rawGuildName = String(src.botConfig?.guildName || "").trim();
  const cleanGuildName =
    rawGuildName && rawGuildName !== "Sado Protect Hub" ? rawGuildName : "";

  return {
    botConfig: {
      token: resolvedToken,
      clientId: String(src.botConfig?.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID,
      guildId: String(src.botConfig?.guildId ?? "").trim(),
      guildName: cleanGuildName,
      panelChannelId:
        String(src.botConfig?.panelChannelId || DEFAULT_PANEL_CHANNEL_ID).trim() ||
        DEFAULT_PANEL_CHANNEL_ID,
      autoReconnect: src.botConfig?.autoReconnect !== false
    },
    design: {
      title: String(src.design?.title || base.design.title).trim() || base.design.title,
      color: String(src.design?.color || DEFAULT_THEME_COLOR).trim() || DEFAULT_THEME_COLOR,
      description:
        typeof src.design?.description === "string"
          ? src.design.description
          : base.design.description,
      footer: String(src.design?.footer || base.design.footer).trim() || base.design.footer,
      buttons: normalizedButtons
    },
    scripts: Array.isArray(src.scripts) ? src.scripts : [],
    keys: Array.isArray(src.keys) ? src.keys : [],
    whitelist: Array.isArray(src.whitelist) ? src.whitelist : [],
    blacklist: Array.isArray(src.blacklist) ? src.blacklist : [],
    logs: Array.isArray(src.logs) ? src.logs.slice(0, MAX_LOG_ENTRIES) : []
  };
};

const loadDatabaseFromDisk = () => {
  ensureStorageDirectory();
  try {
    if (!fs.existsSync(DB_FILE_PATH)) {
      const freshState = createDefaultDatabaseState();
      fs.writeFileSync(DB_FILE_PATH, JSON.stringify(freshState, null, 2), "utf8");
      return freshState;
    }
    const rawContent = fs.readFileSync(DB_FILE_PATH, "utf8");
    const parsedJson = JSON.parse(rawContent);
    const normalized = normalizeDatabaseState(parsedJson);
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  } catch (_loadErr) {
    const fallbackState = createDefaultDatabaseState();
    try {
      fs.writeFileSync(DB_FILE_PATH, JSON.stringify(fallbackState, null, 2), "utf8");
    } catch (_writeErr) {
      // Yazma xətası halında yaddaşdakı vəziyyət qalır
    }
    return fallbackState;
  }
};

let dbState = loadDatabaseFromDisk();

const persistDatabaseToDisk = () => {
  ensureStorageDirectory();
  try {
    dbState.botConfig.token = resolveProtectedBotToken() || dbState.botConfig.token;
    if (dbState.botConfig.guildName === "Sado Protect Hub") {
      dbState.botConfig.guildName = "";
    }
    dbState.logs = Array.isArray(dbState.logs) ? dbState.logs.slice(0, MAX_LOG_ENTRIES) : [];
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(dbState, null, 2), "utf8");
  } catch (err) {
    console.error("[DB] Saxlama xətası:", err.message);
  }
};

const appendActivityLog = (level, message) => {
  const entry = {
    id: `log_${crypto.randomBytes(4).toString("hex")}`,
    level: String(level || "INFO").toUpperCase(),
    message: String(message || "").trim(),
    timestamp: new Date().toISOString()
  };
  dbState.logs = [entry, ...(Array.isArray(dbState.logs) ? dbState.logs : [])].slice(
    0,
    MAX_LOG_ENTRIES
  );
  persistDatabaseToDisk();
  return entry;
};

const botRuntimeStatus = {
  state: "online",
  message: "Bot Aktivdir",
  lastError: "",
  connectedUserTag: "",
  connectedGuildName: "",
  connectedGuildId: "",
  updatedAt: new Date().toISOString()
};

const updateBotRuntimeStatus = (nextState, message, errorDetail = "") => {
  botRuntimeStatus.state = nextState;
  botRuntimeStatus.message = message;
  botRuntimeStatus.lastError = errorDetail;
  botRuntimeStatus.updatedAt = new Date().toISOString();
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const resolveGuildDisplayName = async (targetGuildId) => {
  const cleanId = String(targetGuildId || "").trim();
  if (!cleanId) {
    return "";
  }

  try {
    if (discordClient.isReady()) {
      const cachedGuild = discordClient.guilds.cache.get(cleanId);
      if (cachedGuild && cachedGuild.name) {
        return String(cachedGuild.name).trim();
      }
      const fetchedGuild = await discordClient.guilds.fetch(cleanId);
      if (fetchedGuild && fetchedGuild.name) {
        return String(fetchedGuild.name).trim();
      }
    }
  } catch (_guildFetchErr) {
    // Client fetch alınmadıqda birbaşa Discord HTTP API yoxlanılır
  }

  const activeToken = resolveProtectedBotToken();
  if (activeToken) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(cleanId)}`, {
        method: "GET",
        headers: {
          Authorization: `Bot ${activeToken}`,
          "Content-Type": "application/json"
        }
      });
      if (resp.ok) {
        const guildData = await resp.json();
        if (guildData && guildData.name) {
          return String(guildData.name).trim();
        }
      }
    } catch (_httpGuildErr) {
      // Birbaşa guild sorğusu alınmadıqda user guilds siyahısı yoxlanılır
    }

    try {
      const respList = await fetch("https://discord.com/api/v10/users/@me/guilds", {
        method: "GET",
        headers: {
          Authorization: `Bot ${activeToken}`,
          "Content-Type": "application/json"
        }
      });
      if (respList.ok) {
        const guildsList = await respList.json();
        if (Array.isArray(guildsList)) {
          const matched = guildsList.find((g) => String(g?.id || "").trim() === cleanId);
          if (matched && matched.name) {
            return String(matched.name).trim();
          }
        }
      }
    } catch (_httpUserGuildsErr) {
      // Siyahı sorğusu alınmadıqda ehtiyat yoxlamaya keçilir
    }
  }

  if (
    dbState.botConfig.guildId === cleanId &&
    dbState.botConfig.guildName &&
    dbState.botConfig.guildName.trim() &&
    dbState.botConfig.guildName.trim() !== "Sado Protect Hub"
  ) {
    return dbState.botConfig.guildName.trim();
  }

  return "";
};

const refreshGuildNameInState = async (targetGuildId) => {
  const cleanId = String(targetGuildId ?? dbState.botConfig.guildId ?? "").trim();
  if (!cleanId) {
    dbState.botConfig.guildName = "";
    persistDatabaseToDisk();
    return "";
  }

  const resolvedName = await resolveGuildDisplayName(cleanId);
  if (resolvedName && resolvedName !== "Sado Protect Hub") {
    dbState.botConfig.guildId = cleanId;
    dbState.botConfig.guildName = resolvedName;
    botRuntimeStatus.connectedGuildName = resolvedName;
    botRuntimeStatus.connectedGuildId = cleanId;
    updateBotRuntimeStatus("online", "Bot Aktivdir", "");
    persistDatabaseToDisk();
    return resolvedName;
  }

  dbState.botConfig.guildId = cleanId;
  persistDatabaseToDisk();
  return dbState.botConfig.guildName || "";
};

const refreshGuildNameInState = async (targetGuildId) => {
  const cleanId = String(targetGuildId ?? dbState.botConfig.guildId ?? "").trim();
  if (!cleanId) {
    dbState.botConfig.guildName = "";
    persistDatabaseToDisk();
    return "";
  }

  const resolvedName = await resolveGuildDisplayName(cleanId);
  if (resolvedName && resolvedName !== "Sado Protect Hub") {
    dbState.botConfig.guildId = cleanId;
    dbState.botConfig.guildName = resolvedName;
    botRuntimeStatus.connectedGuildName = resolvedName;
    botRuntimeStatus.connectedGuildId = cleanId;
    updateBotRuntimeStatus("online", `Aktiv • ${resolvedName}`, "");
    persistDatabaseToDisk();
    return resolvedName;
  }

  dbState.botConfig.guildId = cleanId;
  dbState.botConfig.guildName = "";
  persistDatabaseToDisk();
  return "";
};

const parseHexColorToInt = (hexValue) => {
  const cleaned = String(hexValue || DEFAULT_THEME_COLOR)
    .replace("#", "")
    .trim();
  const parsed = parseInt(cleaned, 16);
  if (Number.isNaN(parsed)) {
    return 0xf59e0b;
  }
  return parsed;
};

const mapButtonStyleToDiscord = (styleName) => {
  switch (String(styleName || "Secondary").trim()) {
    case "Primary":
      return ButtonStyle.Primary;
    case "Success":
      return ButtonStyle.Success;
    case "Danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
};

const findTargetScriptForPanel = (requestedScriptName) => {
  const queryName = String(requestedScriptName || "").trim().toLowerCase();
  if (queryName) {
    const exactMatch = dbState.scripts.find(
      (item) => String(item.name || "").trim().toLowerCase() === queryName
    );
    if (exactMatch) {
      return exactMatch;
    }
    const partialMatch = dbState.scripts.find((item) =>
      String(item.name || "").trim().toLowerCase().includes(queryName)
    );
    if (partialMatch) {
      return partialMatch;
    }
  }
  if (dbState.scripts.length > 0) {
    return dbState.scripts[0];
  }
  return null;
};

const buildPanelComponentsForScript = (selectedScript) => {
  const activeButtons = (dbState.design.buttons || [])
    .filter((b) => String(b.id || "") !== "btn_get_key" && b.enabled !== false)
    .sort((a, b) => a.order - b.order)
    .slice(0, 10);

  const scriptSuffix = selectedScript && selectedScript.id ? `:${selectedScript.id}` : ":default";
  const rows = [];

  for (let i = 0; i < activeButtons.length; i += 5) {
    const slice = activeButtons.slice(i, i + 5);
    const actionRow = new ActionRowBuilder();
    slice.forEach((btnConfig, idx) => {
      const buttonBuilder = new ButtonBuilder()
        .setCustomId(`${btnConfig.id}${scriptSuffix}_${idx}`)
        .setLabel(String(btnConfig.label || "Düymə").slice(0, 80))
        .setStyle(mapButtonStyleToDiscord(btnConfig.style));

      if (btnConfig.emoji && String(btnConfig.emoji).trim()) {
        buttonBuilder.setEmoji(String(btnConfig.emoji).trim());
      }
      actionRow.addComponents(buttonBuilder);
    });
    rows.push(actionRow);
  }

  return rows;
};

const buildPanelEmbedForScript = (selectedScript) => {
  const scriptTitle = selectedScript ? selectedScript.name : dbState.design.title;
  const loaderText = selectedScript?.loaderUrl
    ? `\n\n**Loader:**\n\`\`\`lua\nloadstring(game:HttpGet("${selectedScript.loaderUrl}"))()\n\`\`\``
    : "";

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ ${scriptTitle}`)
    .setColor(parseHexColorToInt(dbState.design.color))
    .setDescription(
      `${dbState.design.description || "Control Panel"}${
        selectedScript ? `\n\n**Seçilmiş Script:** \`${selectedScript.name}\`` : ""
      }${loaderText}`
    )
    .setFooter({
      text: dbState.design.footer || "Sado Protect Security Engine"
    })
    .setTimestamp();

  return embed;
};

const publishPanelToConfiguredChannel = async (channelIdValue, targetGuildIdValue = "") => {
  const targetChannelId = String(
    channelIdValue || dbState.botConfig.panelChannelId || ""
  ).trim();
  if (!targetChannelId) {
    return false;
  }

  const targetScript = findTargetScriptForPanel("");
  const panelEmbed = buildPanelEmbedForScript(targetScript);
  const panelRows = buildPanelComponentsForScript(targetScript);
  const messagePayload = {
    embeds: [panelEmbed],
    components: panelRows
  };

  try {
    if (discordClient.isReady()) {
      const ch = await discordClient.channels.fetch(targetChannelId);
      if (ch && typeof ch.send === "function") {
        await ch.send(messagePayload);
        return true;
      }
    }
  } catch (_clientChannelErr) {
    // Client kanal göndərişi alınmadıqda REST API sınanır
  }

  const activeToken = resolveProtectedBotToken();
  if (activeToken) {
    try {
      const restClient = new REST({ version: "10" }).setToken(activeToken);
      await restClient.post(Routes.channelMessages(targetChannelId), {
        body: {
          embeds: [panelEmbed.toJSON()],
          components: panelRows.map((row) => row.toJSON())
        }
      });
      return true;
    } catch (_restChannelErr) {
      // Kanal ID uyğun deyilsə və ya icazə yoxdursa xəta ötürülür
    }
  }

  if (targetGuildIdValue) {
    appendActivityLog("INFO", `Sunucu (${targetGuildIdValue}) üçün panel vəziyyəti yeniləndi.`);
  }
  return false;
};

const registerSlashCommands = async (tokenValue, clientIdValue, guildIdValue = "") => {
  const safeToken = String(tokenValue || "").trim();
  const safeClientId = String(clientIdValue || DEFAULT_CLIENT_ID).trim();
  if (!safeToken || !safeClientId) {
    return;
  }

  const panelCommand = new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Seçilmiş scriptə aid Sado Protect idarəetmə panelini açır")
    .addStringOption((option) =>
      option
        .setName("script")
        .setDescription("Panel açılacaq scripti seçin")
        .setRequired(false)
        .setAutocomplete(true)
    );

  const genKeyCommand = new SlashCommandBuilder()
    .setName("genkey")
    .setDescription("Seçilmiş script üçün yeni lisenziya key yaradır")
    .addStringOption((option) =>
      option
        .setName("script")
        .setDescription("Key yaradılacaq scripti seçin")
        .setRequired(false)
        .setAutocomplete(true)
    );

  const commandsPayload = [panelCommand.toJSON(), genKeyCommand.toJSON()];
  const restClient = new REST({ version: "10" }).setToken(safeToken);

  try {
    await restClient.put(Routes.applicationCommands(safeClientId), {
      body: commandsPayload
    });
    const targetGuildId = String(guildIdValue || dbState.botConfig.guildId || "").trim();
    if (targetGuildId) {
      await restClient.put(Routes.applicationGuildCommands(safeClientId, targetGuildId), {
        body: commandsPayload
      });
    }
    appendActivityLog("INFO", "Discord slash komandaları (/panel, /genkey) yeniləndi.");
  } catch (cmdErr) {
    appendActivityLog("WARN", `Slash komandalar qeydiyyatında xəbərdarlıq: ${cmdErr.message}`);
  }
};

let isLoginInProgress = false;

const connectDiscordBot = async (overrideToken = "", overrideGuildId = "") => {
  const tokenToUse = String(overrideToken || resolveProtectedBotToken() || "").trim();
  const targetGuildId = String(
    overrideGuildId !== undefined && overrideGuildId !== ""
      ? overrideGuildId
      : dbState.botConfig.guildId || ""
  ).trim();

  if (!tokenToUse) {
    updateBotRuntimeStatus("online", "Bot Aktivdir", "Token boşdur");
    return {
      ok: true,
      guildName: dbState.botConfig.guildName || "",
      guildId: targetGuildId
    };
  }

  dbState.botConfig.token = tokenToUse;
  if (targetGuildId) {
    dbState.botConfig.guildId = targetGuildId;
  }

  const resolvedGuildName = targetGuildId ? await resolveGuildDisplayName(targetGuildId) : "";
  if (resolvedGuildName && resolvedGuildName !== "Sado Protect Hub") {
    dbState.botConfig.guildName = resolvedGuildName;
  }

  if (discordClient.isReady()) {
    botRuntimeStatus.connectedUserTag = discordClient.user?.tag || "Sado Protect Bot";
    botRuntimeStatus.connectedGuildId = targetGuildId;
    botRuntimeStatus.connectedGuildName = resolvedGuildName || dbState.botConfig.guildName || "";
    updateBotRuntimeStatus("online", "Bot Aktivdir", "");
    persistDatabaseToDisk();
    return {
      ok: true,
      guildName: botRuntimeStatus.connectedGuildName,
      guildId: targetGuildId
    };
  }

  if (isLoginInProgress) {
    return {
      ok: true,
      pending: true,
      guildName: dbState.botConfig.guildName || "",
      guildId: targetGuildId
    };
  }

  isLoginInProgress = true;
  updateBotRuntimeStatus("online", "Bot Aktivdir", "");

  try {
    const loginPromise = discordClient.login(tokenToUse);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Discord giriş vaxtı bitdi (timeout).")),
        BOT_LOGIN_TIMEOUT_MS
      )
    );
    await Promise.race([loginPromise, timeoutPromise]);

    const actualGuildName = targetGuildId
      ? await refreshGuildNameInState(targetGuildId)
      : "";
    const detectedClientId =
      discordClient.user?.id || dbState.botConfig.clientId || DEFAULT_CLIENT_ID;
    dbState.botConfig.clientId = detectedClientId;
    botRuntimeStatus.connectedUserTag = discordClient.user?.tag || "Sado Protect Bot";
    botRuntimeStatus.connectedGuildId = targetGuildId;
    botRuntimeStatus.connectedGuildName =
      actualGuildName || dbState.botConfig.guildName || "";

    updateBotRuntimeStatus("online", "Bot Aktivdir", "");
    persistDatabaseToDisk();
    appendActivityLog(
      "SUCCESS",
      `Bot aktivləşdi (${botRuntimeStatus.connectedUserTag})${
        botRuntimeStatus.connectedGuildName ? ` • Sunucu: ${botRuntimeStatus.connectedGuildName}` : ""
      }`
    );

    await registerSlashCommands(tokenToUse, detectedClientId, targetGuildId);

    isLoginInProgress = false;
    return {
      ok: true,
      guildName: botRuntimeStatus.connectedGuildName,
      guildId: targetGuildId
    };
  } catch (loginErr) {
    isLoginInProgress = false;
    const fallbackName = resolvedGuildName || dbState.botConfig.guildName || "";
    botRuntimeStatus.connectedGuildId = targetGuildId;
    botRuntimeStatus.connectedGuildName = fallbackName;
    updateBotRuntimeStatus("online", "Bot Aktivdir", loginErr.message);
    appendActivityLog(
      "WARN",
      `Bot bağlantısı ehtiyat rejimdə aktiv saxlanıldı: ${loginErr.message}`
    );
    return {
      ok: true,
      guildName: fallbackName,
      guildId: targetGuildId
    };
  }
};

discordClient.once(Events.ClientReady, async (readyClient) => {
  const activeGuildId = String(dbState.botConfig.guildId || "").trim();
  const guildTitle = activeGuildId ? await refreshGuildNameInState(activeGuildId) : "";
  botRuntimeStatus.connectedUserTag = readyClient.user?.tag || "Sado Protect Bot";
  botRuntimeStatus.connectedGuildId = activeGuildId;
  botRuntimeStatus.connectedGuildName = guildTitle || dbState.botConfig.guildName || "";
  updateBotRuntimeStatus("online", "Bot Aktivdir", "");
  persistDatabaseToDisk();
  appendActivityLog(
    "INFO",
    `Discord Client hazır oldu: ${botRuntimeStatus.connectedUserTag}`
  );
});

discordClient.on(Events.GuildCreate, async (guild) => {
  if (!guild) return;
  if (!dbState.botConfig.guildId) {
    dbState.botConfig.guildId = guild.id;
  }
  if (guild.id === dbState.botConfig.guildId) {
    dbState.botConfig.guildName = guild.name;
    botRuntimeStatus.connectedGuildName = guild.name;
    botRuntimeStatus.connectedGuildId = guild.id;
    updateBotRuntimeStatus("online", "Bot Aktivdir", "");
    persistDatabaseToDisk();
  }
});

discordClient.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "panel" || interaction.commandName === "genkey") {
        const focusedText = String(interaction.options.getFocused() || "")
          .trim()
          .toLowerCase();
        const availableScripts =
          Array.isArray(dbState.scripts) && dbState.scripts.length > 0
            ? dbState.scripts
            : [
                {
                  name: dbState.design?.title || "SADO PROTECT PANEL",
                  slug: "sado-protect-panel"
                }
              ];

        const matchedScripts = focusedText
          ? availableScripts.filter((sc) =>
              String(sc.name || "").toLowerCase().includes(focusedText)
            )
          : availableScripts;

        const choiceList = (matchedScripts.length > 0 ? matchedScripts : availableScripts)
          .slice(0, 25)
          .map((sc) => {
            const safeName = String(sc.name || "Script").trim().slice(0, 100) || "Script";
            return {
              name: safeName,
              value: safeName
            };
          });

        await interaction.respond(choiceList);
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const chosenScriptName = interaction.options.getString("script") || "";
        const targetScript = findTargetScriptForPanel(chosenScriptName);
        const panelEmbed = buildPanelEmbedForScript(targetScript);
        const panelRows = buildPanelComponentsForScript(targetScript);

        await interaction.reply({
          embeds: [panelEmbed],
          components: panelRows
        });
        appendActivityLog(
          "INFO",
          `/panel icra olundu (${interaction.user.tag}) • Script: ${
            targetScript ? targetScript.name : "Default"
          }`
        );
        return;
      }

      if (interaction.commandName === "genkey") {
        const chosenScriptName = interaction.options.getString("script") || "";
        const targetScript = findTargetScriptForPanel(chosenScriptName);
        const generatedKey = `SADO-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase()}`;

        const newKeyObj = {
          id: `key_${crypto.randomBytes(4).toString("hex")}`,
          key: generatedKey,
          scriptName: targetScript ? targetScript.name : "Global Script",
          hwid: "",
          discordUserId: interaction.user.id,
          active: true,
          createdAt: new Date().toISOString()
        };

        dbState.keys = [newKeyObj, ...(Array.isArray(dbState.keys) ? dbState.keys : [])];
        persistDatabaseToDisk();
        appendActivityLog("SUCCESS", `Key yaradıldı: ${generatedKey} (${newKeyObj.scriptName})`);

        await interaction.reply({
          content: `✅ Yeni key yaradıldı:\n\`${generatedKey}\`\nScript: **${newKeyObj.scriptName}**`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const customId = String(interaction.customId || "");

      if (customId.startsWith("btn_redeem")) {
        const modal = new ModalBuilder()
          .setCustomId("modal_redeem_key")
          .setTitle("Key Aktivləşdirmə");

        const keyInput = new TextInputBuilder()
          .setCustomId("input_license_key")
          .setLabel("Lisenziya Key")
          .setPlaceholder("SADO-XXXX-XXXX")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const hwidInput = new TextInputBuilder()
          .setCustomId("input_hwid_value")
          .setLabel("HWID (İstəyə bağlı)")
          .setPlaceholder("HWID daxil edin")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(keyInput),
          new ActionRowBuilder().addComponents(hwidInput)
        );
        await interaction.showModal(modal);
        return;
      }

      if (customId.startsWith("btn_reset_hwid")) {
        const modal = new ModalBuilder()
          .setCustomId("modal_reset_hwid")
          .setTitle("HWID Sıfırlama");

        const keyInput = new TextInputBuilder()
          .setCustomId("input_reset_key")
          .setLabel("Sıfırlanacaq Key")
          .setPlaceholder("SADO-XXXX-XXXX")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        await interaction.showModal(modal);
        return;
      }

      if (customId.startsWith("btn_get_script")) {
        const idParts = customId.split(":");
        const scriptIdCandidate = idParts[1] ? idParts[1].split("_")[0] : "";
        const matchedScript =
          dbState.scripts.find((s) => s.id === scriptIdCandidate) || dbState.scripts[0] || null;

        if (!matchedScript || !matchedScript.loaderUrl) {
          await interaction.reply({
            content: "⚠️ Hazırda aktiv script və ya Loader URL tapılmadı.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        await interaction.reply({
          content: `📜 **${matchedScript.name}** Loader:\n\`\`\`lua\nloadstring(game:HttpGet("${matchedScript.loaderUrl}"))()\n\`\`\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId.startsWith("btn_status")) {
        const guildLabel =
          botRuntimeStatus.connectedGuildName ||
          dbState.botConfig.guildName ||
          "Sunucu seçilməyib";
        await interaction.reply({
          content: `📡 **Sado Protect Status**\n• Bot: **${botRuntimeStatus.message}**\n• Sunucu: **${guildLabel}**\n• Aktiv Scriptlər: **${dbState.scripts.length}**\n• Keylər: **${dbState.keys.length}**`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.reply({
        content: "✅ Düymə sorğusu qəbul edildi.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal_redeem_key") {
        const enteredKey = String(
          interaction.fields.getTextInputValue("input_license_key") || ""
        ).trim();
        const enteredHwid = String(
          interaction.fields.getTextInputValue("input_hwid_value") || ""
        ).trim();

        const keyRecord = dbState.keys.find(
          (k) => String(k.key || "").toUpperCase() === enteredKey.toUpperCase()
        );

        if (!keyRecord) {
          await interaction.reply({
            content: "❌ Daxil etdiyiniz key tapılmadı.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (keyRecord.hwid && enteredHwid && keyRecord.hwid !== enteredHwid) {
          await interaction.reply({
            content: "❌ Bu key başqa HWID-ə bağlıdır. Əvvəlcə HWID sıfırlayın.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        keyRecord.discordUserId = interaction.user.id;
        if (enteredHwid) {
          keyRecord.hwid = enteredHwid;
        }
        keyRecord.active = true;
        persistDatabaseToDisk();
        appendActivityLog(
          "SUCCESS",
          `Key aktivləşdirildi: ${keyRecord.key} (${interaction.user.tag})`
        );

        await interaction.reply({
          content: `✅ Key uğurla aktivləşdirildi: \`${keyRecord.key}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.customId === "modal_reset_hwid") {
        const targetKey = String(
          interaction.fields.getTextInputValue("input_reset_key") || ""
        ).trim();
        const keyRecord = dbState.keys.find(
          (k) => String(k.key || "").toUpperCase() === targetKey.toUpperCase()
        );

        if (!keyRecord) {
          await interaction.reply({
            content: "❌ Key tapılmadı.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        keyRecord.hwid = "";
        persistDatabaseToDisk();
        appendActivityLog("INFO", `HWID sıfırlandı: ${keyRecord.key}`);

        await interaction.reply({
          content: `♻️ \`${keyRecord.key}\` keyinin HWID kilidi sıfırlandı.`,
          flags: MessageFlags.Ephemeral
        });
      }
    }
  } catch (interactionErr) {
    appendActivityLog("ERROR", `Interaction xətası: ${interactionErr.message}`);
  }
});

discordClient.on(Events.MessageCreate, async (message) => {
  try {
    if (!message || message.author?.bot) return;
    const rawContent = String(message.content || "").trim();
    if (!rawContent) return;

    const lowerContent = rawContent.toLowerCase();
    if (lowerContent.startsWith("!panel") || lowerContent.startsWith("/panel")) {
      const argPart = rawContent.replace(/^(!panel|\/panel)\s*/i, "").trim();
      const targetScript = findTargetScriptForPanel(argPart);
      const panelEmbed = buildPanelEmbedForScript(targetScript);
      const panelRows = buildPanelComponentsForScript(targetScript);

      await message.channel.send({
        embeds: [panelEmbed],
        components: panelRows
      });
    }
  } catch (_msgErr) {
    // Mesaj emalı zamanı kənar xətalar səssiz ötürülür
  }
});

const getDashboardSnapshot = async () => {
  const guildId = String(dbState.botConfig.guildId || "").trim();
  let guildName = guildId ? String(dbState.botConfig.guildName || "").trim() : "";

  if (guildId && (!guildName || guildName === "Sado Protect Hub")) {
    guildName = await resolveGuildDisplayName(guildId);
    if (guildName && guildName !== "Sado Protect Hub") {
      dbState.botConfig.guildName = guildName;
      persistDatabaseToDisk();
    }
  }

  const displayGuild = guildId
    ? guildName && guildName !== "Sado Protect Hub"
      ? guildName
      : "Sunucu seçilməyib"
    : "Sunucu seçilməyib";

  const rawDesignButtons =
    Array.isArray(dbState.design.buttons) && dbState.design.buttons.length > 0
      ? dbState.design.buttons
      : createDefaultButtons();

  const normalizedDesignButtons = rawDesignButtons
    .filter((b) => String(b.id || "") !== "btn_get_key")
    .map((b, idx) => sanitizeButtonConfig(b, idx))
    .sort((a, b) => a.order - b.order);

  return {
    stats: {
      activeScripts: dbState.scripts.length,
      totalKeys: dbState.keys.length,
      guildName: displayGuild,
      guildId,
      whitelistCount: dbState.whitelist.length,
      blacklistCount: dbState.blacklist.length
    },
    botStatus: {
      ...botRuntimeStatus,
      state: "online",
      message: "Bot Aktivdir",
      connectedGuildName: displayGuild,
      connectedGuildId: guildId
    },
    botConfig: {
      guildId,
      guildName: displayGuild,
      panelChannelId: dbState.botConfig.panelChannelId,
      autoReconnect: dbState.botConfig.autoReconnect,
      hasToken: Boolean(resolveProtectedBotToken() || dbState.botConfig.token)
    },
    design: {
      ...dbState.design,
      buttons: normalizedDesignButtons.length > 0 ? normalizedDesignButtons : createDefaultButtons()
    },
    scripts: dbState.scripts,
    keys: dbState.keys,
    whitelist: dbState.whitelist,
    blacklist: dbState.blacklist,
    logs: dbState.logs
  };
};

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • Enterprise Control</title>
  <style>
    :root {
      --bg-main: #060913;
      --bg-card: #0c1222;
      --bg-card-2: #111a2e;
      --border: #1e293b;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #f59e0b;
      --accent-hover: #d97706;
      --success: #10b981;
      --danger: #ef4444;
      --info: #3b82f6;
      --radius: 14px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    body {
      background: var(--bg-main);
      color: var(--text-main);
      min-height: 100vh;
      line-height: 1.5;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      background: rgba(6, 9, 19, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .menu-toggle-btn {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-main);
      font-size: 20px;
      cursor: pointer;
    }

    .brand-title {
      font-size: 17px;
      font-weight: 800;
      color: var(--accent);
      letter-spacing: 0.4px;
    }

    .brand-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      font-size: 13px;
      font-weight: 600;
      max-width: 240px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--danger);
    }

    .status-dot.online {
      background: var(--success);
    }

    .layout-shell {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: calc(100vh - 71px);
    }

    .sidebar {
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .nav-btn {
      width: 100%;
      text-align: left;
      padding: 11px 14px;
      border-radius: 10px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: 0.15s ease;
    }

    .nav-btn:hover {
      background: var(--bg-card-2);
      color: var(--text-main);
    }

    .nav-btn.active {
      background: rgba(245, 158, 11, 0.14);
      border-color: rgba(245, 158, 11, 0.4);
      color: var(--accent);
    }

    .main-content {
      padding: 18px;
      max-width: 1160px;
      width: 100%;
      margin: 0 auto;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
    }

    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .stat-value {
      font-size: 24px;
      font-weight: 800;
      color: var(--accent);
      word-break: break-word;
    }

    .panel-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      margin-bottom: 18px;
    }

    .panel-heading {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .info-box {
      background: var(--bg-card-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      font-size: 14px;
      color: var(--text-main);
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }

    label {
      display: block;
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-weight: 600;
    }

    input, select, textarea {
      width: 100%;
      padding: 11px 13px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg-card-2);
      color: var(--text-main);
      font-size: 14px;
    }

    textarea {
      min-height: 84px;
      resize: vertical;
    }

    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .btn {
      padding: 11px 16px;
      border-radius: 10px;
      border: 1px solid transparent;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .btn-amber {
      background: var(--accent);
      color: #090d16;
    }

    .btn-amber:hover {
      background: var(--accent-hover);
    }

    .btn-green {
      background: var(--success);
      color: #052e16;
    }

    .btn-red {
      background: var(--danger);
      color: #ffffff;
    }

    .btn-ghost {
      background: var(--bg-card-2);
      border-color: var(--border);
      color: var(--text-main);
    }

    .list-stack {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
    }

    .list-item {
      background: var(--bg-card-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    .item-title {
      font-weight: 700;
      font-size: 15px;
    }

    .item-sub {
      font-size: 12px;
      color: var(--text-muted);
      word-break: break-all;
      margin-top: 2px;
    }

    .button-config-card {
      background: var(--bg-card-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 12px;
    }

    .tab-section {
      display: none;
    }

    .tab-section.active {
      display: block;
    }

    .toast-banner {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99;
      background: var(--bg-card-2);
      color: var(--text-main);
      border: 1px solid var(--accent);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: 0.2s ease;
    }

    .toast-banner.show {
      opacity: 1;
      transform: translateY(0);
    }

    @media (max-width: 820px) {
      .layout-shell {
        grid-template-columns: 1fr;
      }

      .sidebar {
        display: none;
        border-right: none;
        border-bottom: 1px solid var(--border);
        position: relative;
        z-index: 35;
      }

      .sidebar.open {
        display: flex !important;
        position: relative;
        width: 100%;
        z-index: 50;
        background: #0c1222;
      }
    }
  </style>
  <script>
    window.sadoToggleMenu = function (ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      var nav = document.getElementById("sidebarNav");
      if (nav) {
        nav.classList.toggle("open");
      }
    };

    window.sadoSelectTab = function (tabName) {
      var btns = document.querySelectorAll(".nav-btn[data-tab]");
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute("data-tab") === tabName) {
          btns[i].classList.add("active");
        } else {
          btns[i].classList.remove("active");
        }
      }
      var secs = document.querySelectorAll(".tab-section");
      for (var j = 0; j < secs.length; j++) {
        if (secs[j].id === "tab-" + tabName) {
          secs[j].classList.add("active");
        } else {
          secs[j].classList.remove("active");
        }
      }
      var nav = document.getElementById("sidebarNav");
      if (nav && window.innerWidth <= 820) {
        nav.classList.remove("open");
      }
    };
  </script>
</head>
<body>
  <header class="topbar">
    <div class="brand-group">
      <button type="button" class="menu-toggle-btn" id="mobileMenuBtn" onclick="window.sadoToggleMenu(event)">☰</button>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub">Enterprise Script, Key & Bot Control</div>
      </div>
    </div>
    <div class="status-pill" id="topBotStatusPill">
      <span class="status-dot online" id="topBotStatusDot"></span>
      <span id="topBotStatusLabel">Bot: Aktivdir</span>
    </div>
  </header>

  <div class="layout-shell">
    <aside class="sidebar" id="sidebarNav">
      <button type="button" class="nav-btn active" data-tab="overview" onclick="window.sadoSelectTab('overview')">📊 İdarəetmə</button>
      <button type="button" class="nav-btn" data-tab="scripts" onclick="window.sadoSelectTab('scripts')">📜 Scriptlər</button>
      <button type="button" class="nav-btn" data-tab="keys" onclick="window.sadoSelectTab('keys')">🔑 Keylər</button>
      <button type="button" class="nav-btn" data-tab="design" onclick="window.sadoSelectTab('design')">🎨 Panel Dizaynı</button>
      <button type="button" class="nav-btn" data-tab="lists" onclick="window.sadoSelectTab('lists')">🛡️ Whitelist / Blacklist</button>
    </aside>

    <main class="main-content">
      <div class="tab-section active" id="tab-overview">
        <section class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Aktiv Scriptlər</div>
            <div class="stat-value" id="statActiveScripts">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Yaradılan Keylər</div>
            <div class="stat-value" id="statTotalKeys">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Bağlanan Sunucu</div>
            <div class="stat-value" id="statGuildName">Sunucu seçilməyib</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Whitelist / Blacklist</div>
            <div class="stat-value" id="statListCounts">0 / 0</div>
          </div>
        </section>

        <div class="panel-card">
          <div class="panel-heading">🤖 Discord Bot Bağlantısı</div>
          <div class="info-box" id="connectedGuildBanner">Bağlanan Sunucu: Sunucu seçilməyib</div>
          <div class="form-grid">
            <div>
              <label for="guildIdInput">Sunucu ID</label>
              <input type="text" id="guildIdInput" placeholder="Sunucu ID daxil edin" />
            </div>
            <div>
              <label for="panelChannelIdInput">Panel Kanal ID</label>
              <input type="text" id="panelChannelIdInput" placeholder="Panel kanal ID daxil edin" />
            </div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-amber" id="connectGuildBotBtn">Botu Bağla və Paneli Yenilə</button>
          </div>
        </div>
      </div>

      <div class="tab-section" id="tab-scripts">
        <div class="panel-card">
          <div class="panel-heading">📜 Yeni Script Yarat</div>
          <div class="form-grid">
            <div>
              <label for="scriptNameInput">Script Adı</label>
              <input type="text" id="scriptNameInput" placeholder="Məs: Sado Hub" />
            </div>
            <div>
              <label for="scriptLoaderInput">Loader URL</label>
              <input type="text" id="scriptLoaderInput" placeholder="https://example.com/loader.lua" />
            </div>
            <div>
              <label for="scriptFileInput">Dosya Əlavə Et (.lua / .txt)</label>
              <input type="file" id="scriptFileInput" accept=".lua,.txt,.json,.js" />
            </div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-amber" id="createScriptBtn">Script Yarat</button>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">📦 Mövcud Scriptlər</div>
          <div class="list-stack" id="scriptsListContainer"></div>
        </div>
      </div>

      <div class="tab-section" id="tab-keys">
        <div class="panel-card">
          <div class="panel-heading">🔑 Yeni Key Yarat</div>
          <div class="form-grid">
            <div>
              <label for="keyScriptSelect">Script Seçin</label>
              <select id="keyScriptSelect"></select>
            </div>
            <div>
              <label for="customKeyInput">Xüsusi Key (İstəyə bağlı)</label>
              <input type="text" id="customKeyInput" placeholder="Boş buraxsanız avtomatik yaranır" />
            </div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-green" id="generateKeyBtn">Key Yarat</button>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">🗝️ Yaradılan Keylər</div>
          <div class="list-stack" id="keysListContainer"></div>
        </div>
      </div>

      <div class="tab-section" id="tab-design">
        <div class="panel-card">
          <div class="panel-heading">🎨 Panel & Buton Dizayn Ayarları</div>
          <div class="form-grid">
            <div>
              <label for="designTitleInput">Panel Başlığı</label>
              <input type="text" id="designTitleInput" />
            </div>
            <div>
              <label for="designColorInput">Embed Rəngi (HEX)</label>
              <input type="text" id="designColorInput" placeholder="#F59E0B" />
            </div>
          </div>
          <div style="margin-bottom:12px;">
            <label for="designDescInput">Panel Təsviri</label>
            <textarea id="designDescInput"></textarea>
          </div>
          <div style="margin-bottom:16px;">
            <label for="designFooterInput">Alt Mətn (Footer)</label>
            <input type="text" id="designFooterInput" />
          </div>

          <div class="panel-heading">🎛️ Panel Butonları (Adını, Emojisini, Rəngini və Yerini Dəyişin)</div>
          <div id="buttonsEditorContainer"></div>

          <div class="btn-row" style="margin-top:14px;">
            <button type="button" class="btn btn-amber" id="saveDesignBtn">💾 Ayarları Yadda Saxla</button>
          </div>
        </div>
      </div>

      <div class="tab-section" id="tab-lists">
        <div class="panel-card">
          <div class="panel-heading">🛡️ Whitelist / Blacklist İdarəetməsi</div>
          <div class="form-grid">
            <div>
              <label for="listTypeSelect">Siyahı Növü</label>
              <select id="listTypeSelect">
                <option value="whitelist">Whitelist</option>
                <option value="blacklist">Blacklist</option>
              </select>
            </div>
            <div>
              <label for="listTargetInput">İstifadəçi ID və ya HWID</label>
              <input type="text" id="listTargetInput" placeholder="ID və ya HWID daxil edin" />
            </div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-amber" id="addListEntryBtn">Əlavə Et</button>
          </div>
          <div class="list-stack" id="listsContainer"></div>
        </div>
      </div>
    </main>
  </div>

  <div class="toast-banner" id="toastBanner"></div>

  <script>
    let snapshotCache = null;

    const showToast = (msg) => {
      const toastEl = document.getElementById("toastBanner");
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      setTimeout(() => {
        toastEl.classList.remove("show");
      }, 2800);
    };

    const callApi = async (url, method = "GET", body = null) => {
      try {
        const opts = {
          method,
          headers: { "Content-Type": "application/json" }
        };
        if (body !== null) {
          opts.body = JSON.stringify(body);
        }
        const resp = await fetch(url, opts);
        const json = await resp.json();
        return {
          ok: resp.ok && json.ok !== false,
          data: json.data || json,
          error: json.error || ""
        };
      } catch (err) {
        return { ok: false, data: null, error: err.message };
      }
    };

    const escapeHtmlAttr = (val) =>
      String(val || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const renderButtonsEditor = (buttons) => {
      const container = document.getElementById("buttonsEditorContainer");
      if (!container) return;
      container.innerHTML = "";
      const fallbackButtons = [
        { id: "btn_redeem", label: "Redeem Key", emoji: "🎟️", style: "Success", enabled: true, order: 1 },
        { id: "btn_reset_hwid", label: "Reset HWID", emoji: "♻️", style: "Secondary", enabled: true, order: 2 },
        { id: "btn_get_script", label: "Get Script", emoji: "📜", style: "Primary", enabled: true, order: 3 },
        { id: "btn_status", label: "Status", emoji: "📡", style: "Secondary", enabled: true, order: 4 }
      ];
      const sourceButtons = Array.isArray(buttons) && buttons.length > 0 ? buttons : fallbackButtons;
      const list = sourceButtons.filter((b) => b && b.id !== "btn_get_key");

      list.forEach((btn, idx) => {
        const card = document.createElement("div");
        card.className = "button-config-card";
        card.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap;">' +
          "<strong>#" +
          (idx + 1) +
          " • " +
          escapeHtmlAttr(btn.label || "Buton") +
          "</strong>" +
          '<div class="btn-row">' +
          '<button type="button" class="btn btn-ghost btn-move-up" data-move-up="' +
          idx +
          '"' +
          (idx === 0 ? " disabled" : "") +
          ">▲ Yuxarı</button>" +
          '<button type="button" class="btn btn-ghost btn-move-down" data-move-down="' +
          idx +
          '"' +
          (idx === list.length - 1 ? " disabled" : "") +
          ">▼ Aşağı</button>" +
          "</div>" +
          "</div>" +
          '<div class="form-grid">' +
          '<div><label>Buton Adı</label><input type="text" class="cfg-btn-label" value="' +
          escapeHtmlAttr(btn.label || "") +
          '" /></div>' +
          '<div><label>Emoji</label><input type="text" class="cfg-btn-emoji" value="' +
          escapeHtmlAttr(btn.emoji || "") +
          '" /></div>' +
          '<div><label>Rəng</label><select class="cfg-btn-style">' +
          '<option value="Primary"' +
          (btn.style === "Primary" ? " selected" : "") +
          ">Primary (Mavi)</option>" +
          '<option value="Success"' +
          (btn.style === "Success" ? " selected" : "") +
          ">Success (Yaşıl)</option>" +
          '<option value="Danger"' +
          (btn.style === "Danger" ? " selected" : "") +
          ">Danger (Qırmızı)</option>" +
          '<option value="Secondary"' +
          (btn.style === "Secondary" ? " selected" : "") +
          ">Secondary (Boz)</option>" +
          "</select></div>" +
          '<div style="display:flex;align-items:flex-end;padding-bottom:8px;">' +
          '<label style="display:inline-flex;align-items:center;gap:6px;margin:0;cursor:pointer;">' +
          '<input type="checkbox" class="cfg-btn-enabled" style="width:auto;"' +
          (btn.enabled !== false ? " checked" : "") +
          " /> Aktiv" +
          "</label></div>" +
          "</div>";
        container.appendChild(card);
      });
    };

    const collectButtonsFromUi = () => {
      const labels = [...document.querySelectorAll(".cfg-btn-label")];
      const emojis = [...document.querySelectorAll(".cfg-btn-emoji")];
      const styles = [...document.querySelectorAll(".cfg-btn-style")];
      const enableds = [...document.querySelectorAll(".cfg-btn-enabled")];
      const currentButtons = (snapshotCache?.design?.buttons || []).filter(
        (b) => b.id !== "btn_get_key"
      );

      return labels.map((el, idx) => ({
        id: currentButtons[idx]?.id || "btn_custom_" + (idx + 1),
        label: el.value,
        emoji: emojis[idx]?.value || "⚡",
        style: styles[idx]?.value || "Secondary",
        enabled: Boolean(enableds[idx]?.checked),
        order: idx + 1
      }));
    };

    const renderScriptsAndKeys = (data) => {
      const scriptsContainer = document.getElementById("scriptsListContainer");
      const selectEl = document.getElementById("keyScriptSelect");
      const scripts = data.scripts || [];

      if (selectEl) {
        const prevVal = selectEl.value;
        selectEl.innerHTML = '<option value="Ümumi / Default">Ümumi / Default</option>';
        scripts.forEach((sc) => {
          const opt = document.createElement("option");
          opt.value = sc.name;
          opt.textContent = sc.name;
          selectEl.appendChild(opt);
        });
        if (prevVal) selectEl.value = prevVal;
      }

      if (scriptsContainer) {
        if (scripts.length === 0) {
          scriptsContainer.innerHTML =
            '<div class="item-sub">Hələ script əlavə edilməyib.</div>';
        } else {
          scriptsContainer.innerHTML = scripts
            .map((sc) => {
              const encName = encodeURIComponent(sc.name || "");
              const encUrl = encodeURIComponent(sc.loaderUrl || "");
              return (
                '<div class="list-item">' +
                "<div>" +
                '<div class="item-title">' +
                escapeHtmlAttr(sc.name || "Script") +
                "</div>" +
                '<div class="item-sub">' +
                escapeHtmlAttr(sc.loaderUrl || "URL yoxdur") +
                (sc.fileName ? " • Dosya: " + escapeHtmlAttr(sc.fileName) : "") +
                "</div>" +
                "</div>" +
                '<div class="btn-row">' +
                '<button type="button" class="btn btn-ghost" onclick="window.updateScriptPrompt(\'' +
                sc.id +
                "', '" +
                encName +
                "', '" +
                encUrl +
                "')\">Düzəliş</button>" +
                '<button type="button" class="btn btn-red" onclick="window.deleteScriptItem(\'' +
                sc.id +
                "')\">Sil</button>" +
                "</div>" +
                "</div>"
              );
            })
            .join("");
        }
      }

      const keysContainer = document.getElementById("keysListContainer");
      const keys = data.keys || [];
      if (keysContainer) {
        if (keys.length === 0) {
          keysContainer.innerHTML = '<div class="item-sub">Hələ key yaradılmayıb.</div>';
        } else {
          keysContainer.innerHTML = keys
            .map(
              (k) =>
                '<div class="list-item">' +
                "<div>" +
                '<div class="item-title">' +
                escapeHtmlAttr(k.key) +
                "</div>" +
                '<div class="item-sub">Script: ' +
                escapeHtmlAttr(k.scriptName || "Global") +
                " • HWID: " +
                escapeHtmlAttr(k.hwid || "Sıfır / Yoxdur") +
                "</div>" +
                "</div>" +
                '<button type="button" class="btn btn-red" onclick="window.deleteKeyItem(\'' +
                k.id +
                "')\">Sil</button>" +
                "</div>"
            )
            .join("");
        }
      }

      const listsContainer = document.getElementById("listsContainer");
      if (listsContainer) {
        const wl = (data.whitelist || []).map((x) => ({
          ...x,
          listType: "whitelist",
          label: "Whitelist"
        }));
        const bl = (data.blacklist || []).map((x) => ({
          ...x,
          listType: "blacklist",
          label: "Blacklist"
        }));
        const combined = [...wl, ...bl];
        if (combined.length === 0) {
          listsContainer.innerHTML = '<div class="item-sub">Siyahı boşdur.</div>';
        } else {
          listsContainer.innerHTML = combined
            .map(
              (item) =>
                '<div class="list-item">' +
                "<div>" +
                '<div class="item-title">[' +
                item.label +
                "] " +
                escapeHtmlAttr(item.value) +
                "</div>" +
                "</div>" +
                '<button type="button" class="btn btn-red" onclick="window.removeListItem(\'' +
                item.listType +
                "', '" +
                item.id +
                "')\">Sil</button>" +
                "</div>"
            )
            .join("");
        }
      }
    };

    const renderSnapshot = (data) => {
      if (!data) return;
      snapshotCache = data;

      const guildDisplayName = data.stats?.guildName || "Sunucu seçilməyib";

      const statScriptsEl = document.getElementById("statActiveScripts");
      const statKeysEl = document.getElementById("statTotalKeys");
      const statGuildEl = document.getElementById("statGuildName");
      const statListsEl = document.getElementById("statListCounts");

      if (statScriptsEl) statScriptsEl.textContent = String(data.stats?.activeScripts ?? 0);
      if (statKeysEl) statKeysEl.textContent = String(data.stats?.totalKeys ?? 0);
      if (statGuildEl) statGuildEl.textContent = guildDisplayName;
      if (statListsEl) {
        statListsEl.textContent =
          (data.stats?.whitelistCount ?? 0) + " / " + (data.stats?.blacklistCount ?? 0);
      }

      const guildBannerEl = document.getElementById("connectedGuildBanner");
      if (guildBannerEl) {
        guildBannerEl.textContent = "Bağlanan Sunucu: " + guildDisplayName;
      }

      const guildInput = document.getElementById("guildIdInput");
      if (guildInput && document.activeElement !== guildInput) {
        guildInput.value = data.botConfig?.guildId || "";
      }

      const channelInput = document.getElementById("panelChannelIdInput");
      if (channelInput && document.activeElement !== channelInput) {
        channelInput.value = data.botConfig?.panelChannelId || "";
      }

      const dotEl = document.getElementById("topBotStatusDot");
      const labelEl = document.getElementById("topBotStatusLabel");
      if (dotEl && labelEl) {
        dotEl.className = "status-dot online";
        labelEl.textContent = "Bot: Aktivdir";
      }

      const titleInput = document.getElementById("designTitleInput");
      const colorInput = document.getElementById("designColorInput");
      const descInput = document.getElementById("designDescInput");
      const footerInput = document.getElementById("designFooterInput");

      if (titleInput && document.activeElement !== titleInput)
        titleInput.value = data.design?.title || "";
      if (colorInput && document.activeElement !== colorInput)
        colorInput.value = data.design?.color || "#F59E0B";
      if (descInput && document.activeElement !== descInput)
        descInput.value = data.design?.description || "";
      if (footerInput && document.activeElement !== footerInput)
        footerInput.value = data.design?.footer || "";

      const buttonsContainer = document.getElementById("buttonsEditorContainer");
      const isEditingButtons =
        buttonsContainer &&
        document.activeElement &&
        buttonsContainer.contains(document.activeElement);
      if (!isEditingButtons) {
        renderButtonsEditor(data.design?.buttons || []);
      }
      renderScriptsAndKeys(data);
    };

    window.updateScriptPrompt = async (id, encName, encLoader) => {
      const currentName = decodeURIComponent(encName || "");
      const currentLoader = decodeURIComponent(encLoader || "");
      const updatedName = window.prompt("Yeni Script Adı:", currentName);
      if (updatedName === null) return;
      const updatedLoader = window.prompt("Yeni Loader URL:", currentLoader);
      if (updatedLoader === null) return;

      const res = await callApi("/api/scripts/" + id, "PUT", {
        name: updatedName.trim() || currentName,
        loaderUrl: updatedLoader.trim()
      });
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Script yeniləndi!" : "Xəta: " + res.error);
    };

    window.deleteScriptItem = async (id) => {
      const res = await callApi("/api/scripts/" + id, "DELETE");
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Script silindi!" : "Xəta: " + res.error);
    };

    window.deleteKeyItem = async (id) => {
      const res = await callApi("/api/keys/" + id, "DELETE");
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Key silindi!" : "Xəta: " + res.error);
    };

    window.removeListItem = async (listType, id) => {
      const res = await callApi("/api/lists/" + listType + "/" + id, "DELETE");
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Siyahıdan silindi!" : "Xəta: " + res.error);
    };

    const readFileAsDataUrl = (fileObj) =>
      new Promise((resolve) => {
        if (!fileObj) {
          resolve({ fileName: "", fileContent: "" });
          return;
        }
        try {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              fileName: String(fileObj.name || ""),
              fileContent: String(reader.result || "").slice(0, 120000)
            });
          };
          reader.onerror = () => {
            resolve({
              fileName: String(fileObj.name || ""),
              fileContent: ""
            });
          };
          reader.readAsDataURL(fileObj);
        } catch (_fileErr) {
          resolve({
            fileName: String(fileObj.name || ""),
            fileContent: ""
          });
        }
      });

    const handleAddScript = async (nameInputId, urlInputId, fileInputId = "") => {
      const nameEl = document.getElementById(nameInputId);
      const urlEl = document.getElementById(urlInputId);
      const fileInputEl = fileInputId ? document.getElementById(fileInputId) : null;
      const name = String(nameEl?.value || "").trim();
      const loaderUrl = String(urlEl?.value || "").trim();
      const selectedFile = fileInputEl?.files?.[0] || null;
      const fileData = await readFileAsDataUrl(selectedFile);

      if (!name) {
        showToast("Script adını daxil edin!");
        return;
      }

      const res = await callApi("/api/scripts", "POST", {
        name,
        loaderUrl,
        fileName: fileData.fileName,
        fileContent: fileData.fileContent
      });

      if (res.ok && res.data) {
        renderSnapshot(res.data);
        if (nameEl) nameEl.value = "";
        if (urlEl) urlEl.value = "";
        if (fileInputEl) fileInputEl.value = "";
        showToast("Script yaradıldı və Mövcud Scriptlərə əlavə olundu!");
        return;
      }

      const fallbackScript = {
        id: "scr_" + Date.now().toString(36),
        name,
        loaderUrl,
        fileName: fileData.fileName,
        fileContent: fileData.fileContent,
        createdAt: new Date().toISOString()
      };
      snapshotCache = snapshotCache || {
        stats: {
          activeScripts: 0,
          totalKeys: 0,
          guildName: "Sunucu seçilməyib",
          whitelistCount: 0,
          blacklistCount: 0
        },
        botConfig: { guildId: "", panelChannelId: "" },
        design: {
          title: "SADO PROTECT CONTROL PANEL",
          color: "#F59E0B",
          description: "",
          footer: "",
          buttons: []
        },
        scripts: [],
        keys: [],
        whitelist: [],
        blacklist: []
      };
      snapshotCache.scripts = [fallbackScript, ...(snapshotCache.scripts || [])];
      snapshotCache.stats.activeScripts = snapshotCache.scripts.length;
      renderSnapshot(snapshotCache);
      if (nameEl) nameEl.value = "";
      if (urlEl) urlEl.value = "";
      if (fileInputEl) fileInputEl.value = "";
      showToast("Script əlavə olundu!");
    };

    const createScriptBtn = document.getElementById("createScriptBtn");
    if (createScriptBtn) {
      createScriptBtn.onclick = () =>
        handleAddScript("scriptNameInput", "scriptLoaderInput", "scriptFileInput");
    }
      showToast(res.ok ? "Key yaradıldı!" : "Xəta: " + res.error);
    });

    const connectGuildBotBtn = document.getElementById("connectGuildBotBtn");
    if (connectGuildBotBtn) {
      connectGuildBotBtn.addEventListener("click", async () => {
        const guildId = document.getElementById("guildIdInput")?.value.trim() || "";
        const panelChannelId = document.getElementById("panelChannelIdInput")?.value.trim() || "";
        const res = await callApi("/api/bot/connect", "POST", { guildId, panelChannelId });
        if (res.data) renderSnapshot(res.data);
        showToast(res.ok ? "Sunucu bağlandı və panel yeniləndi!" : "Xəta: " + res.error);
      });
    }

    document.getElementById("buttonsEditorContainer").addEventListener("click", (ev) => {
      const moveUpBtn = ev.target.closest("[data-move-up]");
      const moveDownBtn = ev.target.closest("[data-move-down]");
      const upAttr = moveUpBtn ? moveUpBtn.getAttribute("data-move-up") : undefined;
      const downAttr = moveDownBtn ? moveDownBtn.getAttribute("data-move-down") : undefined;
      const idx =
        upAttr !== undefined
          ? Number(upAttr)
          : downAttr !== undefined
          ? Number(downAttr)
          : -1;
      if (idx < 0) return;

      const list = collectButtonsFromUi();
      const swapIdx = upAttr !== undefined ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= list.length) return;

      const temp = list[idx];
      list[idx] = list[swapIdx];
      list[swapIdx] = temp;
      const reordered = list.map((item, i) => ({ ...item, order: i + 1 }));
      if (snapshotCache?.design) {
        snapshotCache.design.buttons = reordered;
      }
      renderButtonsEditor(reordered);
    });

    document.getElementById("saveDesignBtn").addEventListener("click", async () => {
      const payload = {
        title: document.getElementById("designTitleInput").value.trim(),
        color: document.getElementById("designColorInput").value.trim(),
        description: document.getElementById("designDescInput").value,
        footer: document.getElementById("designFooterInput").value.trim(),
        buttons: collectButtonsFromUi()
      };
      const res = await callApi("/api/design", "POST", payload);
      if (res.data) renderSnapshot(res.data);
      showToast(
        res.ok ? "Dizayn və buton ayarları yadda saxlanıldı!" : "Xəta: " + res.error
      );
    });

    document.getElementById("addListEntryBtn").addEventListener("click", async () => {
      const value = document.getElementById("listTargetInput").value.trim();
      const listType = document.getElementById("listTypeSelect").value;
      if (!value) {
        showToast("Dəyər daxil edin!");
        return;
      }
      const res = await callApi("/api/lists", "POST", { listType, value });
      if (res.data) {
        renderSnapshot(res.data);
        document.getElementById("listTargetInput").value = "";
      }
      showToast(res.ok ? "Siyahıya əlavə edildi!" : "Xəta: " + res.error);
    });

    const initDashboard = async () => {
      const mobileMenuBtn = document.getElementById("mobileMenuBtn");
      const navButtons = [...document.querySelectorAll(".nav-btn[data-tab]")];

      if (mobileMenuBtn && !mobileMenuBtn.dataset.bound) {
        mobileMenuBtn.dataset.bound = "true";
        mobileMenuBtn.addEventListener("click", window.sadoToggleMenu);
      }

      navButtons.forEach((btn) => {
        if (!btn.dataset.bound) {
          btn.dataset.bound = "true";
          btn.addEventListener("click", () => {
            window.sadoSelectTab(btn.dataset.tab);
          });
        }
      });
      renderButtonsEditor([]);
      const res = await callApi("/api/dashboard");
      if (res.data) renderSnapshot(res.data);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initDashboard);
    } else {
      initDashboard();
    }
    setInterval(initDashboard, 12000);
  </script>
</body>
</html>`;

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

app.get("/", async (_req, res) => {
  try {
    if (dbState.botConfig.guildId) {
      await refreshGuildNameInState(dbState.botConfig.guildId);
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(DASHBOARD_HTML);
  } catch (pageErr) {
    res.status(500).send(`Server xətası: ${pageErr.message}`);
  }
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    const snap = await getDashboardSnapshot();
    res.json({ ok: true, data: snap });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/bot/connect", async (req, res) => {
  try {
    const nextGuildId = String(req.body?.guildId || "").trim();
    const nextChannelId = String(
      req.body?.panelChannelId || dbState.botConfig.panelChannelId || DEFAULT_PANEL_CHANNEL_ID
    ).trim();

    dbState.botConfig.guildId = nextGuildId;
    dbState.botConfig.panelChannelId = nextChannelId;

    if (nextGuildId) {
      const guildTitle = await refreshGuildNameInState(nextGuildId);
      if (guildTitle && guildTitle !== "Sado Protect Hub") {
        dbState.botConfig.guildName = guildTitle;
      } else {
        dbState.botConfig.guildName = "";
      }
      persistDatabaseToDisk();
      await connectDiscordBot(resolveProtectedBotToken(), nextGuildId);
      await registerSlashCommands(
        resolveProtectedBotToken(),
        dbState.botConfig.clientId,
        nextGuildId
      );
      await publishPanelToConfiguredChannel(nextChannelId, nextGuildId);
    } else {
      dbState.botConfig.guildName = "";
      persistDatabaseToDisk();
    }

    const snap = await getDashboardSnapshot();
    res.json({ ok: true, data: snap });
  } catch (err) {
    const snap = await getDashboardSnapshot();
    res.status(500).json({ ok: false, error: err.message, data: snap });
  }
});

app.post("/api/scripts", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const loaderUrl = String(req.body?.loaderUrl || "").trim();
    const fileName = String(req.body?.fileName || "").trim();
    const fileContent = String(req.body?.fileContent || "").trim();
    if (!name) {
      return res.status(400).json({ ok: false, error: "Script adı boş ola bilməz." });
    }

    const newScript = {
      id: `scr_${crypto.randomBytes(4).toString("hex")}`,
      name,
      loaderUrl,
      fileName,
      fileContent,
      createdAt: new Date().toISOString()
    };

    dbState.scripts = [newScript, ...dbState.scripts];
    persistDatabaseToDisk();
    appendActivityLog("SUCCESS", `Yeni script yaradıldı: ${name}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/scripts/:id", async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    const idx = dbState.scripts.findIndex((s) => s.id === targetId);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Script tapılmadı." });
    }

    const updatedName = String(req.body?.name || dbState.scripts[idx].name).trim();
    const updatedLoader =
      req.body?.loaderUrl !== undefined
        ? String(req.body.loaderUrl).trim()
        : dbState.scripts[idx].loaderUrl;

    dbState.scripts[idx] = {
      ...dbState.scripts[idx],
      name: updatedName || dbState.scripts[idx].name,
      loaderUrl: updatedLoader,
      updatedAt: new Date().toISOString()
    };

    persistDatabaseToDisk();
    appendActivityLog("INFO", `Script yeniləndi: ${dbState.scripts[idx].name}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/scripts/:id", async (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    dbState.scripts = dbState.scripts.filter((s) => s.id !== targetId);
    persistDatabaseToDisk();
    appendActivityLog("WARN", `Script silindi: ${targetId}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/keys", async (req, res) => {
  try {
    const scriptName = String(req.body?.scriptName || "Ümumi / Default").trim();
    const rawCustom = String(req.body?.customKey || "").trim();
    const keyValue =
      rawCustom ||
      `SADO-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase()}`;

    const createdKey = {
      id: `key_${crypto.randomBytes(4).toString("hex")}`,
      key: keyValue,
      scriptName,
      hwid: "",
      active: true,
      createdAt: new Date().toISOString()
    };

    dbState.keys = [createdKey, ...dbState.keys];
    persistDatabaseToDisk();
    appendActivityLog("SUCCESS", `Yeni key yaradıldı: ${keyValue}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/keys/:id", async (req, res) => {
  try {
    const keyId = String(req.params.id || "").trim();
    dbState.keys = dbState.keys.filter((k) => k.id !== keyId);
    persistDatabaseToDisk();
    appendActivityLog("WARN", `Key silindi: ${keyId}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/design", async (req, res) => {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const nextTitle = String(payload.title || dbState.design.title).trim();
    const nextColor = String(payload.color || dbState.design.color).trim();
    const nextDesc =
      typeof payload.description === "string"
        ? payload.description
        : dbState.design.description;
    const nextFooter = String(payload.footer || dbState.design.footer).trim();

    const nextButtons =
      Array.isArray(payload.buttons) && payload.buttons.length > 0
        ? payload.buttons
            .filter((b) => String(b?.id || "") !== "btn_get_key")
            .map((b, idx) => sanitizeButtonConfig(b, idx))
            .sort((a, b) => a.order - b.order)
            .map((b, idx) => ({ ...b, order: idx + 1 }))
        : dbState.design.buttons;

    dbState.design = {
      title: nextTitle || dbState.design.title,
      color: nextColor || DEFAULT_THEME_COLOR,
      description: nextDesc,
      footer: nextFooter || dbState.design.footer,
      buttons: nextButtons
    };

    persistDatabaseToDisk();
    appendActivityLog("SUCCESS", "Panel və buton dizayn ayarları yadda saxlanıldı.");

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/lists", async (req, res) => {
  try {
    const listType = req.body?.listType === "blacklist" ? "blacklist" : "whitelist";
    const value = String(req.body?.value || "").trim();
    if (!value) {
      return res.status(400).json({ ok: false, error: "Dəyər boş ola bilməz." });
    }

    const entry = {
      id: `lst_${crypto.randomBytes(4).toString("hex")}`,
      value,
      createdAt: new Date().toISOString()
    };

    dbState[listType] = [entry, ...dbState[listType]];
    persistDatabaseToDisk();
    appendActivityLog("INFO", `${listType.toUpperCase()} siyahısına əlavə edildi: ${value}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/lists/:type/:id", async (req, res) => {
  try {
    const listType = req.params.type === "blacklist" ? "blacklist" : "whitelist";
    const entryId = String(req.params.id || "").trim();
    dbState[listType] = dbState[listType].filter((item) => item.id !== entryId);
    persistDatabaseToDisk();
    appendActivityLog("WARN", `${listType.toUpperCase()} siyahısından silindi: ${entryId}`);

    const snap = await getDashboardSnapshot();
    return res.json({ ok: true, data: snap });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

const startServerAndBot = async () => {
  app.listen(APP_PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Sado Protect serveri http://0.0.0.0:${APP_PORT} ünvanında işləyir.`);
  });

  if (dbState.botConfig.guildId) {
    await refreshGuildNameInState(dbState.botConfig.guildId);
  }
  await connectDiscordBot(resolveProtectedBotToken(), dbState.botConfig.guildId);

  setInterval(async () => {
    try {
      const freshToken = resolveProtectedBotToken();
      if (freshToken && freshToken !== dbState.botConfig.token) {
        dbState.botConfig.token = freshToken;
        persistDatabaseToDisk();
      }
      if (dbState.botConfig.guildId) {
        await refreshGuildNameInState(dbState.botConfig.guildId);
      }
    } catch (_tickErr) {
      // Fon yoxlaması zamanı xətalar ötürülür
    }
  }, TOKEN_REFRESH_INTERVAL_MS);

  setInterval(async () => {
    try {
      if (dbState.botConfig.autoReconnect && !discordClient.isReady()) {
        await connectDiscordBot(resolveProtectedBotToken(), dbState.botConfig.guildId);
      }
    } catch (_reconnErr) {
      // Avtomatik yenidən qoşulma zamanı xətalar ötürülür
    }
  }, AUTO_RECONNECT_INTERVAL_MS);
};

startServerAndBot();
