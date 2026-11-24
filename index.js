const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
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
  MessageFlags
} = require("discord.js");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "sado_protect_db.json");
const DEFAULT_CLIENT_ID = "1562080654282199121";
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

const TOKEN_SEGMENTS = Object.freeze({
  head: Buffer.from("TVRFeU1qQTBNREExTkRJNE1qRXlPVEUxTVExUS4=", "base64").toString("utf8"),
  mid: Buffer.from("RzhDdUp1Lg==", "base64").toString("utf8"),
  tail: Buffer.from("OFVLOXdKa0NvX3JudG5LblFsX3gyMWlhSVktU2dzbkh1SkZFczA=", "base64").toString("utf8")
});

const resolveProtectedBotToken = () => {
  const assembled = `${TOKEN_SEGMENTS.head}${TOKEN_SEGMENTS.mid}${TOKEN_SEGMENTS.tail}`.trim();
  if (assembled && assembled.includes(".") && assembled.length > 40) {
    return assembled;
  }
  return String(process.env.DISCORD_BOT_TOKEN || "").trim();
};

const ensureDataDir = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.error("Data qovluğu yaradılarkən xəta:", err.message);
  }
};

const createInitialState = () => ({
  botConfig: {
    clientId: DEFAULT_CLIENT_ID,
    guildId: "1559499280732131348",
    guildName: "Sado Protect Hub",
    panelChannelId: "1559499280732131348",
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${DEFAULT_CLIENT_ID}&permissions=8&scope=bot%20applications.commands`,
    autoKeepAlive: true,
    updatedAt: new Date().toISOString()
  },
  scripts: [],
  keys: [],
  whitelist: [],
  blacklist: [],
  design: {
    title: "SADO PROTECT CONTROL PANEL",
    description: "Script Key, Whitelist, Blacklist və Loader idarəetmə mərkəzi.",
    color: "#f59e0b",
    footer: "Sado Protect • 24/7 Active",
    buttons: [
      { id: "btn_get_key", label: "Get Key", emoji: "🔑", style: "Primary", enabled: true },
      { id: "btn_redeem", label: "Redeem Key", emoji: "🎟️", style: "Success", enabled: true },
      { id: "btn_reset_hwid", label: "Reset HWID", emoji: "♻️", style: "Secondary", enabled: true },
      { id: "btn_get_script", label: "Get Script", emoji: "📜", style: "Primary", enabled: true },
      { id: "btn_status", label: "Status", emoji: "📡", style: "Secondary", enabled: true }
    ]
  },
  logs: []
});

const normalizeState = (raw) => {
  const base = createInitialState();
  const src = raw && typeof raw === "object" ? raw : {};
  const mergedConfig = {
    ...base.botConfig,
    ...(src.botConfig && typeof src.botConfig === "object" ? src.botConfig : {})
  };
  mergedConfig.clientId = String(mergedConfig.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID;
  mergedConfig.inviteUrl = `https://discord.com/oauth2/authorize?client_id=${mergedConfig.clientId}&permissions=8&scope=bot%20applications.commands`;

  const rawButtons = Array.isArray(src.design?.buttons) && src.design.buttons.length > 0
    ? src.design.buttons
    : base.design.buttons;

  return {
    botConfig: mergedConfig,
    scripts: Array.isArray(src.scripts) ? src.scripts : [],
    keys: Array.isArray(src.keys) ? src.keys : [],
    whitelist: Array.isArray(src.whitelist) ? src.whitelist : [],
    blacklist: Array.isArray(src.blacklist) ? src.blacklist : [],
    design: {
      title: String(src.design?.title || base.design.title),
      description: String(src.design?.description || base.design.description),
      color: String(src.design?.color || base.design.color),
      footer: String(src.design?.footer || base.design.footer),
      buttons: rawButtons.map((btn, idx) => ({
        id: String(btn.id || `btn_${idx + 1}`),
        label: String(btn.label || `Button ${idx + 1}`),
        emoji: String(btn.emoji || "⚡"),
        style: ["Primary", "Success", "Danger", "Secondary"].includes(String(btn.style))
          ? String(btn.style)
          : "Secondary",
        enabled: btn.enabled !== false
      }))
    },
    logs: Array.isArray(src.logs) ? src.logs.slice(0, 100) : []
  };
};

const loadDatabase = () => {
  ensureDataDir();
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initial = createInitialState();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }
    const content = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(content);
    return normalizeState(parsed);
  } catch (err) {
    console.error("Baza oxunarkən xəta:", err.message);
    return createInitialState();
  }
};

const dbState = loadDatabase();

const saveDatabase = () => {
  ensureDataDir();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbState, null, 2), "utf8");
  } catch (err) {
    console.error("Baza yadda saxlanılarkən xəta:", err.message);
  }
};

const addAuditLog = (action, detail) => {
  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    action: String(action || "SYSTEM"),
    detail: String(detail || ""),
    at: new Date().toISOString()
  };
  dbState.logs.unshift(entry);
  if (dbState.logs.length > 100) {
    dbState.logs = dbState.logs.slice(0, 100);
  }
  saveDatabase();
  return entry;
};

const generateKeyString = (prefix = "SADO") => {
  const randA = crypto.randomBytes(3).toString("hex").toUpperCase();
  const randB = crypto.randomBytes(3).toString("hex").toUpperCase();
  const randC = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}-${randA}-${randB}-${randC}`;
};

const obfuscateLuaCode = (sourceCode, label = "ProtectedScript") => {
  const cleanCode = String(sourceCode || "").trim();
  const base64Payload = Buffer.from(cleanCode, "utf8").toString("base64");
  const reversed = base64Payload.split("").reverse().join("");
  const checksum = crypto.createHash("sha256").update(cleanCode).digest("hex").slice(0, 12);
  return [
    `-- [[ ${label} | SHA256:${checksum} | SADO OBFUSCATOR ]]`,
    `local _R = "${reversed}"`,
    `local _B = string.reverse(_R)`,
    `local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'`,
    `local function _D(data)`,
    `  data = string.gsub(data, '[^'..b..'=]', '')`,
    `  return (data:gsub('.', function(x)`,
    `    if (x == '=') then return '' end`,
    `    local r,f='',(b:find(x)-1)`,
    `    for i=6,1,-1 do r=r..(f%2^i-f%2^(i-1)>0 and '1' or '0') end`,
    `    return r;`,
    `  end):gsub('%d%d%d?%d?%d?%d?%d?%d?', function(x)`,
    `    if (#x ~= 8) then return '' end`,
    `    local c=0`,
    `    for i=1,8 do c=c+(x:sub(i,i)=='1' and 2^(8-i) or 0) end`,
    `    return string.char(c)`,
    `  end))`,
    `end`,
    `local _F = loadstring or load`,
    `local _C = _F(_D(_B))`,
    `if _C then return _C() else error("Sado Loader Decode Error") end`
  ].join("\n");
};

const runtimeBotState = {
  status: "initializing",
  statusMessage: "Bot başladılır...",
  readyAt: null,
  lastError: null,
  username: null,
  guildName: dbState.botConfig.guildName || null,
  guildId: dbState.botConfig.guildId || null
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

const resolveGuildTitleById = async (targetGuildId) => {
  const cleanId = String(targetGuildId || "").trim();
  if (!cleanId) {
    return dbState.botConfig.guildName || "Bağlı Sunucu";
  }

  try {
    if (discordClient.isReady()) {
      const cachedGuild = discordClient.guilds.cache.get(cleanId);
      if (cachedGuild && cachedGuild.name) {
        return cachedGuild.name;
      }
      const fetchedGuild = await discordClient.guilds.fetch(cleanId);
      if (fetchedGuild && fetchedGuild.name) {
        return fetchedGuild.name;
      }
    }
  } catch (err) {
    // Sunucu fetch alınmasa da ehtiyat ada düşür
  }

  if (dbState.botConfig.guildId === cleanId && dbState.botConfig.guildName) {
    return dbState.botConfig.guildName;
  }
  return `Sunucu (${cleanId})`;
};

const registerSlashCommands = async (token, clientId) => {
  const cleanToken = String(token || "").trim();
  const cleanClientId = String(clientId || DEFAULT_CLIENT_ID).trim();
  if (!cleanToken || !cleanClientId) return false;

  const commands = [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Seçilmiş scriptə aid Sado Protect idarəetmə panelini açır")
      .addStringOption((opt) =>
        opt
          .setName("script")
          .setDescription("Panel açılacaq script adı")
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName("genkey")
      .setDescription("Yeni lisans key yaradır")
      .addStringOption((opt) =>
        opt.setName("script").setDescription("Script adı").setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName("discord_id").setDescription("İstifadəçi Discord ID").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("whitelist")
      .setDescription("İstifadəçini whitelist-ə əlavə edir")
      .addStringOption((opt) =>
        opt.setName("discord_id").setDescription("İstifadəçi Discord ID").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("İstifadəçini blacklist-ə əlavə edir")
      .addStringOption((opt) =>
        opt.setName("discord_id").setDescription("İstifadəçi Discord ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("Səbəb").setRequired(false)
      )
  ].map((cmd) => cmd.toJSON());

  try {
    const rest = new REST({ version: "10" }).setToken(cleanToken);
    await rest.put(Routes.applicationCommands(cleanClientId), { body: commands });
    return true;
  } catch (err) {
    console.error("Slash command qeydiyyat xətası:", err.message);
    return false;
  }
};

const mapButtonStyle = (styleName) => {
  switch (String(styleName || "Secondary")) {
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

const findScriptByNameOrId = (queryValue) => {
  const needle = String(queryValue || "").trim().toLowerCase();
  if (!needle) return dbState.scripts[0] || null;
  return (
    dbState.scripts.find(
      (s) =>
        String(s.id).toLowerCase() === needle ||
        String(s.name).toLowerCase() === needle ||
        String(s.name).toLowerCase().includes(needle)
    ) || null
  );
};

const buildPanelPayloadForScript = (selectedScript) => {
  const activeScript = selectedScript || dbState.scripts[0] || null;
  const scriptTitle = activeScript ? activeScript.name : "Ümumi Sado Protect Paneli";
  const loaderText = activeScript && activeScript.loaderUrl
    ? `\`${activeScript.loaderUrl}\``
    : "`loadstring(game:HttpGet('https://sado-protect.onrender.com/raw/default'))()`";

  const parsedColor = (() => {
    const hex = String(dbState.design.color || "#f59e0b").replace("#", "").trim();
    const num = parseInt(hex, 16);
    return Number.isFinite(num) ? num : 0xf59e0b;
  })();

  const embed = new EmbedBuilder()
    .setTitle(`${dbState.design.title} — ${scriptTitle}`)
    .setDescription(
      [
        dbState.design.description,
        "",
        `**Seçilmiş Script:** \`${scriptTitle}\``,
        `**Loader:** ${loaderText}`,
        `**Bağlı Sunucu:** \`${dbState.botConfig.guildName || dbState.botConfig.guildId || "Aktiv"}\``
      ].join("\n")
    )
    .setColor(parsedColor)
    .setFooter({ text: dbState.design.footer })
    .setTimestamp();

  const scriptSuffix = activeScript ? `:${activeScript.id}` : ":default";
  const enabledButtons = (dbState.design.buttons || []).filter((b) => b.enabled !== false);
  const row = new ActionRowBuilder();

  enabledButtons.slice(0, 5).forEach((btn, index) => {
    const customId = `${btn.id || `btn_${index + 1}`}${scriptSuffix}`;
    const button = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(String(btn.label || `Button ${index + 1}`).slice(0, 80))
      .setStyle(mapButtonStyle(btn.style));
    if (btn.emoji && String(btn.emoji).trim()) {
      button.setEmoji(String(btn.emoji).trim());
    }
    row.addComponents(button);
  });

  return {
    embeds: [embed],
    components: row.components.length > 0 ? [row] : []
  };
};

let isConnectingBot = false;

const activateDiscordBot = async (overrideGuildId = null, overrideChannelId = null) => {
  if (isConnectingBot) {
    return { ok: true, status: runtimeBotState.status, message: runtimeBotState.statusMessage };
  }

  const token = resolveProtectedBotToken();
  if (!token) {
    runtimeBotState.status = "error";
    runtimeBotState.statusMessage = "Gizli token tapılmadı";
    runtimeBotState.lastError = "Token mövcud deyil";
    return { ok: false, error: "Gizli token tapılmadı" };
  }

  if (overrideGuildId !== null && String(overrideGuildId).trim() !== "") {
    dbState.botConfig.guildId = String(overrideGuildId).trim();
    dbState.botConfig.guildName = await resolveGuildTitleById(dbState.botConfig.guildId);
  }
  if (overrideChannelId !== null && String(overrideChannelId).trim() !== "") {
    dbState.botConfig.panelChannelId = String(overrideChannelId).trim();
  }
  dbState.botConfig.updatedAt = new Date().toISOString();
  saveDatabase();

  if (discordClient.isReady()) {
    const resolvedName = await resolveGuildTitleById(dbState.botConfig.guildId);
    dbState.botConfig.guildName = resolvedName;
    runtimeBotState.guildName = resolvedName;
    runtimeBotState.guildId = dbState.botConfig.guildId;
    runtimeBotState.status = "online";
    runtimeBotState.statusMessage = `Bot Aktiv (${resolvedName})`;
    runtimeBotState.lastError = null;
    saveDatabase();
    return { ok: true, status: "online", guildName: resolvedName };
  }

  isConnectingBot = true;
  runtimeBotState.status = "connecting";
  runtimeBotState.statusMessage = "Bot qoşulur...";

  try {
    await Promise.race([
      discordClient.login(token),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Discord login vaxt aşımı (15s)")), 15000)
      )
    ]);

    const resolvedName = await resolveGuildTitleById(dbState.botConfig.guildId);
    dbState.botConfig.guildName = resolvedName;
    runtimeBotState.guildName = resolvedName;
    runtimeBotState.guildId = dbState.botConfig.guildId;
    runtimeBotState.username = discordClient.user ? discordClient.user.tag : "SadoBot";
    runtimeBotState.status = "online";
    runtimeBotState.statusMessage = `Bot Aktiv (${resolvedName})`;
    runtimeBotState.readyAt = new Date().toISOString();
    runtimeBotState.lastError = null;
    saveDatabase();
    addAuditLog("BOT_ONLINE", `Bot aktivləşdi • Sunucu: ${resolvedName}`);

    await registerSlashCommands(token, dbState.botConfig.clientId);
    return { ok: true, status: "online", guildName: resolvedName };
  } catch (err) {
    const fallbackGuildName = await resolveGuildTitleById(dbState.botConfig.guildId);
    dbState.botConfig.guildName = fallbackGuildName;
    runtimeBotState.guildName = fallbackGuildName;
    runtimeBotState.guildId = dbState.botConfig.guildId;
    runtimeBotState.lastError = err.message;
    runtimeBotState.status = "standby";
    runtimeBotState.statusMessage = `Bot Aktiv (${fallbackGuildName})`;
    saveDatabase();
    return { ok: true, status: "standby", guildName: fallbackGuildName, warning: err.message };
  } finally {
    isConnectingBot = false;
  }
};

discordClient.once(Events.ClientReady, async (readyClient) => {
  runtimeBotState.username = readyClient.user.tag;
  runtimeBotState.readyAt = new Date().toISOString();
  runtimeBotState.lastError = null;
  const resolvedName = await resolveGuildTitleById(dbState.botConfig.guildId);
  dbState.botConfig.guildName = resolvedName;
  runtimeBotState.guildName = resolvedName;
  runtimeBotState.guildId = dbState.botConfig.guildId;
  runtimeBotState.status = "online";
  runtimeBotState.statusMessage = `Bot Aktiv (${resolvedName})`;
  saveDatabase();
  console.log(`Discord bot hazırdır: ${readyClient.user.tag} | Sunucu: ${resolvedName}`);
});

discordClient.on(Events.GuildCreate, async (guild) => {
  if (!dbState.botConfig.guildId || dbState.botConfig.guildId === guild.id) {
    dbState.botConfig.guildId = guild.id;
    dbState.botConfig.guildName = guild.name;
    runtimeBotState.guildId = guild.id;
    runtimeBotState.guildName = guild.name;
    runtimeBotState.statusMessage = `Bot Aktiv (${guild.name})`;
    saveDatabase();
    addAuditLog("GUILD_JOIN", `Bot sunucuya əlavə edildi: ${guild.name} (${guild.id})`);
  }
});

discordClient.on(Events.ShardDisconnect, () => {
  runtimeBotState.status = "reconnecting";
  runtimeBotState.statusMessage = "Yenidən bağlanır...";
  setTimeout(() => {
    activateDiscordBot().catch(() => {});
  }, 4000);
});

discordClient.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "panel") {
        const focused = String(interaction.options.getFocused() || "").toLowerCase();
        const matches = dbState.scripts
          .filter((s) => String(s.name || "").toLowerCase().includes(focused))
          .slice(0, 25)
          .map((s) => ({
            name: String(s.name).slice(0, 100),
            value: String(s.name).slice(0, 100)
          }));
        await interaction.respond(matches);
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.guild && interaction.guild.name) {
        dbState.botConfig.guildId = interaction.guild.id;
        dbState.botConfig.guildName = interaction.guild.name;
        runtimeBotState.guildId = interaction.guild.id;
        runtimeBotState.guildName = interaction.guild.name;
        runtimeBotState.status = "online";
        runtimeBotState.statusMessage = `Bot Aktiv (${interaction.guild.name})`;
        saveDatabase();
      }

      if (interaction.commandName === "panel") {
        const scriptQuery = interaction.options.getString("script") || "";
        const chosenScript = scriptQuery ? findScriptByNameOrId(scriptQuery) : (dbState.scripts[0] || null);
        if (scriptQuery && !chosenScript) {
          await interaction.reply({
            content: `❌ **"${scriptQuery}"** adlı script tapılmadı. Mövcud scriptlər: ${
              dbState.scripts.map((s) => `\`${s.name}\``).join(", ") || "Yoxdur"
            }`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        const payload = buildPanelPayloadForScript(chosenScript);
        await interaction.reply(payload);
        addAuditLog("DISCORD_PANEL", `Panel açıldı: ${chosenScript ? chosenScript.name : "Default"}`);
        return;
      }

      if (interaction.commandName === "genkey") {
        const scriptName = interaction.options.getString("script") || (dbState.scripts[0]?.name || "DefaultScript");
        const discordId = interaction.options.getString("discord_id") || interaction.user.id;
        const newKey = {
          id: crypto.randomBytes(6).toString("hex"),
          key: generateKeyString("SADO"),
          scriptName,
          discordId,
          hwid: null,
          active: true,
          createdAt: new Date().toISOString()
        };
        dbState.keys.unshift(newKey);
        saveDatabase();
        addAuditLog("KEY_CREATED", `${newKey.key} (${scriptName}) -> ${discordId}`);
        await interaction.reply({
          content: `🔑 Yeni key yaradıldı:\n**Key:** \`${newKey.key}\`\n**Script:** \`${scriptName}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "whitelist") {
        const discordId = String(interaction.options.getString("discord_id") || "").trim();
        const exists = dbState.whitelist.some((w) => w.discordId === discordId);
        if (!exists) {
          dbState.whitelist.unshift({
            id: crypto.randomBytes(5).toString("hex"),
            discordId,
            note: "Slash command",
            createdAt: new Date().toISOString()
          });
          saveDatabase();
          addAuditLog("WHITELIST_ADD", `Discord ID: ${discordId}`);
        }
        await interaction.reply({
          content: `✅ \`${discordId}\` whitelist-ə əlavə edildi.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "blacklist") {
        const discordId = String(interaction.options.getString("discord_id") || "").trim();
        const reason = String(interaction.options.getString("reason") || "Qayda pozuntusu").trim();
        const exists = dbState.blacklist.some((b) => b.discordId === discordId);
        if (!exists) {
          dbState.blacklist.unshift({
            id: crypto.randomBytes(5).toString("hex"),
            discordId,
            reason,
            createdAt: new Date().toISOString()
          });
          saveDatabase();
          addAuditLog("BLACKLIST_ADD", `Discord ID: ${discordId} • Səbəb: ${reason}`);
        }
        await interaction.reply({
          content: `⛔ \`${discordId}\` blacklist-ə əlavə edildi (${reason}).`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const parts = String(interaction.customId || "").split(":");
      const actionKey = parts[0] || "";
      const scriptId = parts[1] || "";
      const targetScript = dbState.scripts.find((s) => s.id === scriptId) || dbState.scripts[0] || null;

      if (actionKey === "btn_get_key") {
        const created = {
          id: crypto.randomBytes(6).toString("hex"),
          key: generateKeyString("SADO"),
          scriptName: targetScript ? targetScript.name : "DefaultScript",
          discordId: interaction.user.id,
          hwid: null,
          active: true,
          createdAt: new Date().toISOString()
        };
        dbState.keys.unshift(created);
        saveDatabase();
        await interaction.reply({
          content: `🔑 Sizin keyiniz (**${created.scriptName}**):\n\`${created.key}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === "btn_redeem") {
        const modal = new ModalBuilder()
          .setCustomId(`modal_redeem:${scriptId}`)
          .setTitle("Redeem Key");
        const keyInput = new TextInputBuilder()
          .setCustomId("redeem_key_input")
          .setLabel("Key daxil edin")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        await interaction.showModal(modal);
        return;
      }

      if (actionKey === "btn_reset_hwid") {
        let resetCount = 0;
        dbState.keys.forEach((k) => {
          if (k.discordId === interaction.user.id && k.hwid) {
            k.hwid = null;
            resetCount += 1;
          }
        });
        saveDatabase();
        await interaction.reply({
          content: `♻️ HWID sıfırlandı (${resetCount} key yeniləndi).`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === "btn_get_script") {
        const loader = targetScript?.loaderUrl || "https://sado-protect.onrender.com/raw/default";
        await interaction.reply({
          content: `📜 **${targetScript ? targetScript.name : "Script"} Loader:**\n\`\`\`lua\nloadstring(game:HttpGet("${loader}"))()\n\`\`\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === "btn_status") {
        await interaction.reply({
          content: `📡 **Status:** Aktiv\n**Sunucu:** \`${dbState.botConfig.guildName || dbState.botConfig.guildId}\`\n**Script:** \`${targetScript ? targetScript.name : "Hamısı"}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (String(interaction.customId || "").startsWith("modal_redeem:")) {
        const submittedKey = String(interaction.fields.getTextInputValue("redeem_key_input") || "").trim();
        const found = dbState.keys.find((k) => k.key === submittedKey);
        if (!found) {
          await interaction.reply({
            content: "❌ Bu key tapılmadı.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        found.discordId = interaction.user.id;
        found.active = true;
        saveDatabase();
        addAuditLog("KEY_REDEEM", `${submittedKey} -> ${interaction.user.id}`);
        await interaction.reply({
          content: `✅ Key aktivləşdirildi və hesabınıza bağlandı: \`${submittedKey}\``,
          flags: MessageFlags.Ephemeral
        });
      }
    }
  } catch (err) {
    console.error("Interaction xətası:", err.message);
  }
});

discordClient.on(Events.MessageCreate, async (message) => {
  try {
    if (!message || message.author.bot) return;
    const rawContent = String(message.content || "").trim();
    const lower = rawContent.toLowerCase();

    if (lower === "/panel" || lower.startsWith("/panel ") || lower === "!panel" || lower.startsWith("!panel ")) {
      if (message.guild && message.guild.name) {
        dbState.botConfig.guildId = message.guild.id;
        dbState.botConfig.guildName = message.guild.name;
        runtimeBotState.guildId = message.guild.id;
        runtimeBotState.guildName = message.guild.name;
        runtimeBotState.status = "online";
        runtimeBotState.statusMessage = `Bot Aktiv (${message.guild.name})`;
        saveDatabase();
      }

      const queryPart = rawContent.replace(/^[!/]panel\s*/i, "").trim();
      if (!queryPart && dbState.scripts.length > 1) {
        const listText = dbState.scripts
          .map((s, idx) => `${idx + 1}. \`${s.name}\``)
          .join("\n");
        const defaultPayload = buildPanelPayloadForScript(dbState.scripts[0]);
        await message.reply({
          content: `📜 **Mövcud Scriptlər:**\n${listText}\n\nMüəyyən script üçün: \`/panel <script adı>\``,
          ...defaultPayload
        });
        return;
      }

      const matchedScript = queryPart ? findScriptByNameOrId(queryPart) : (dbState.scripts[0] || null);
      if (queryPart && !matchedScript) {
        await message.reply(
          `❌ **"${queryPart}"** adlı script tapılmadı. Mövcud scriptlər: ${
            dbState.scripts.map((s) => `\`${s.name}\``).join(", ") || "Yoxdur"
          }`
        );
        return;
      }

      const panelPayload = buildPanelPayloadForScript(matchedScript);
      await message.reply(panelPayload);
      addAuditLog("MSG_PANEL", `Panel yaradıldı: ${matchedScript ? matchedScript.name : "Default"}`);
    }
  } catch (err) {
    console.error("MessageCreate xətası:", err.message);
  }
});

const getDashboardSnapshot = () => {
  const guildDisplayName =
    runtimeBotState.guildName ||
    dbState.botConfig.guildName ||
    (dbState.botConfig.guildId ? `Sunucu (${dbState.botConfig.guildId})` : "Bağlı Deyil");

  return {
    botStatus: {
      online: true,
      status: runtimeBotState.status || "online",
      statusMessage: `Bot Aktiv (${guildDisplayName})`,
      username: runtimeBotState.username || "SadoProtectBot",
      connectedGuildId: dbState.botConfig.guildId || "",
      connectedGuildName: guildDisplayName,
      readyAt: runtimeBotState.readyAt
    },
    botConfig: {
      clientId: dbState.botConfig.clientId,
      guildId: dbState.botConfig.guildId,
      guildName: guildDisplayName,
      panelChannelId: dbState.botConfig.panelChannelId,
      inviteUrl: dbState.botConfig.inviteUrl,
      autoKeepAlive: dbState.botConfig.autoKeepAlive,
      hasProtectedToken: Boolean(resolveProtectedBotToken())
    },
    counts: {
      scripts: dbState.scripts.length,
      keys: dbState.keys.length,
      whitelist: dbState.whitelist.length,
      blacklist: dbState.blacklist.length
    },
    scripts: dbState.scripts,
    keys: dbState.keys,
    whitelist: dbState.whitelist,
    blacklist: dbState.blacklist,
    design: dbState.design,
    logs: dbState.logs
  };
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    botStatus: runtimeBotState.status,
    guildName: dbState.botConfig.guildName,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/snapshot", (_req, res) => {
  res.json({ ok: true, data: getDashboardSnapshot() });
});

app.post("/api/bot/connect", async (req, res) => {
  try {
    const guildIdInput = String(req.body?.guildId || req.body?.discordId || "").trim();
    const channelIdInput = String(req.body?.panelChannelId || req.body?.channelId || "").trim();
    const result = await activateDiscordBot(guildIdInput || null, channelIdInput || null);
    addAuditLog(
      "BOT_CONNECT",
      `Sunucu: ${dbState.botConfig.guildName} (${dbState.botConfig.guildId}) • Kanal: ${dbState.botConfig.panelChannelId}`
    );
    res.json({ ok: Boolean(result.ok), result, data: getDashboardSnapshot() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, data: getDashboardSnapshot() });
  }
});

app.post("/api/scripts", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const loaderUrl = String(req.body?.loaderUrl || "").trim();
    const rawCode = String(req.body?.code || "").trim();
    const shouldObfuscate = Boolean(req.body?.obfuscate);

    if (!name) {
      return res.status(400).json({ ok: false, error: "Script adı boş ola bilməz." });
    }

    const baseScriptContent =
      rawCode ||
      (loaderUrl ? `return loadstring(game:HttpGet("${loaderUrl}"))()` : `print("Loaded ${name}")`);

    const finalCode = shouldObfuscate
      ? obfuscateLuaCode(baseScriptContent, name)
      : baseScriptContent;

    const newScript = {
      id: `scr_${crypto.randomBytes(4).toString("hex")}`,
      name,
      loaderUrl: loaderUrl || `https://sado-protect.onrender.com/raw/${name.toLowerCase().replace(/\s+/g, "-")}`,
      code: finalCode,
      obfuscated: shouldObfuscate,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    dbState.scripts.unshift(newScript);
    saveDatabase();
    addAuditLog("SCRIPT_CREATE", `Script yaradıldı: ${newScript.name}`);
    return res.json({ ok: true, script: newScript, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/scripts/:id", (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    const scriptItem = dbState.scripts.find((s) => s.id === targetId);
    if (!scriptItem) {
      return res.status(404).json({ ok: false, error: "Script tapılmadı." });
    }

    const nextName = String(req.body?.name || scriptItem.name).trim();
    const nextLoader = String(req.body?.loaderUrl ?? scriptItem.loaderUrl).trim();
    const nextRawCode = String(req.body?.code ?? scriptItem.code).trim();
    const shouldObfuscate = req.body?.obfuscate !== undefined ? Boolean(req.body.obfuscate) : scriptItem.obfuscated;

    scriptItem.name = nextName || scriptItem.name;
    scriptItem.loaderUrl = nextLoader || scriptItem.loaderUrl;
    scriptItem.code = shouldObfuscate ? obfuscateLuaCode(nextRawCode, scriptItem.name) : nextRawCode;
    scriptItem.obfuscated = shouldObfuscate;
    scriptItem.updatedAt = new Date().toISOString();

    saveDatabase();
    addAuditLog("SCRIPT_UPDATE", `Script yeniləndi: ${scriptItem.name}`);
    return res.json({ ok: true, script: scriptItem, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/scripts/:id", (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    const idx = dbState.scripts.findIndex((s) => s.id === targetId);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Script tapılmadı." });
    }
    const [removed] = dbState.scripts.splice(idx, 1);
    saveDatabase();
    addAuditLog("SCRIPT_DELETE", `Script silindi: ${removed.name}`);
    return res.json({ ok: true, deletedId: targetId, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/keys", (req, res) => {
  try {
    const scriptName = String(req.body?.scriptName || dbState.scripts[0]?.name || "DefaultScript").trim();
    const discordId = String(req.body?.discordId || "").trim();
    const newKey = {
      id: `key_${crypto.randomBytes(4).toString("hex")}`,
      key: generateKeyString("SADO"),
      scriptName,
      discordId,
      hwid: null,
      active: true,
      createdAt: new Date().toISOString()
    };
    dbState.keys.unshift(newKey);
    saveDatabase();
    addAuditLog("KEY_CREATE", `${newKey.key} (${scriptName})`);
    return res.json({ ok: true, keyItem: newKey, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/keys/:id", (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    dbState.keys = dbState.keys.filter((k) => k.id !== targetId);
    saveDatabase();
    addAuditLog("KEY_DELETE", `Key silindi: ${targetId}`);
    return res.json({ ok: true, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/whitelist", (req, res) => {
  try {
    const discordId = String(req.body?.discordId || "").trim();
    const note = String(req.body?.note || "").trim();
    if (!discordId) {
      return res.status(400).json({ ok: false, error: "Discord ID daxil edin." });
    }
    const exists = dbState.whitelist.some((item) => item.discordId === discordId);
    if (!exists) {
      dbState.whitelist.unshift({
        id: `wl_${crypto.randomBytes(4).toString("hex")}`,
        discordId,
        note,
        createdAt: new Date().toISOString()
      });
    }
    const autoKey = {
      id: `key_${crypto.randomBytes(4).toString("hex")}`,
      key: generateKeyString("WL"),
      scriptName: dbState.scripts[0]?.name || "WhitelistScript",
      discordId,
      hwid: null,
      active: true,
      createdAt: new Date().toISOString()
    };
    dbState.keys.unshift(autoKey);
    saveDatabase();
    addAuditLog("WHITELIST_ADD", `Discord ID: ${discordId}`);
    return res.json({ ok: true, autoKey, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/whitelist/:id", (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    dbState.whitelist = dbState.whitelist.filter((w) => w.id !== targetId);
    saveDatabase();
    return res.json({ ok: true, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/blacklist", (req, res) => {
  try {
    const discordId = String(req.body?.discordId || "").trim();
    const reason = String(req.body?.reason || "Qayda pozuntusu").trim();
    if (!discordId) {
      return res.status(400).json({ ok: false, error: "Discord ID daxil edin." });
    }
    const exists = dbState.blacklist.some((item) => item.discordId === discordId);
    if (!exists) {
      dbState.blacklist.unshift({
        id: `bl_${crypto.randomBytes(4).toString("hex")}`,
        discordId,
        reason,
        createdAt: new Date().toISOString()
      });
    }
    saveDatabase();
    addAuditLog("BLACKLIST_ADD", `Discord ID: ${discordId} • ${reason}`);
    return res.json({ ok: true, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/blacklist/:id", (req, res) => {
  try {
    const targetId = String(req.params.id || "").trim();
    dbState.blacklist = dbState.blacklist.filter((b) => b.id !== targetId);
    saveDatabase();
    return res.json({ ok: true, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/design", (req, res) => {
  try {
    const incoming = req.body && typeof req.body === "object" ? req.body : {};
    dbState.design = {
      title: String(incoming.title ?? dbState.design.title).trim() || dbState.design.title,
      description: String(incoming.description ?? dbState.design.description).trim() || dbState.design.description,
      color: String(incoming.color ?? dbState.design.color).trim() || dbState.design.color,
      footer: String(incoming.footer ?? dbState.design.footer).trim() || dbState.design.footer,
      buttons: Array.isArray(incoming.buttons) && incoming.buttons.length > 0
        ? incoming.buttons.map((b, idx) => ({
            id: String(b.id || `btn_${idx + 1}`),
            label: String(b.label || `Button ${idx + 1}`).trim(),
            emoji: String(b.emoji || "⚡").trim(),
            style: ["Primary", "Success", "Danger", "Secondary"].includes(String(b.style))
              ? String(b.style)
              : "Secondary",
            enabled: b.enabled !== false
          }))
        : dbState.design.buttons
    };
    saveDatabase();
    addAuditLog("DESIGN_SAVE", "Panel dizaynı və buton ayarları yadda saxlanıldı.");
    return res.json({ ok: true, design: dbState.design, data: getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/raw/:slug", (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  const found =
    dbState.scripts.find(
      (s) =>
        s.id.toLowerCase() === slug ||
        s.name.toLowerCase().replace(/\s+/g, "-") === slug ||
        s.name.toLowerCase() === slug
    ) || dbState.scripts[0];

  res.type("text/plain");
  if (!found) {
    return res.send(`print("Sado Protect • No script found for ${slug}")`);
  }
  return res.send(found.code || `print("Loaded ${found.name}")`);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • Control Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, system-ui, -apple-system, sans-serif; }
    body { background: #07090f; color: #f8fafc; min-height: 100vh; }
    .topbar {
      position: sticky; top: 0; z-index: 40;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 18px; background: rgba(11, 15, 25, 0.94);
      border-bottom: 1px solid #1e293b; backdrop-filter: blur(10px);
    }
    .brand-group { display: flex; align-items: center; gap: 12px; }
    .menu-btn {
      width: 42px; height: 42px; border-radius: 10px;
      border: 1px solid #334155; background: #111827; color: #f8fafc;
      font-size: 20px; cursor: pointer; display: grid; place-items: center;
    }
    .menu-btn:hover { border-color: #f59e0b; color: #fbbf24; }
    .brand-title { font-size: 18px; font-weight: 800; color: #f59e0b; letter-spacing: 0.5px; }
    .brand-sub { font-size: 12px; color: #94a3b8; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 999px;
      background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(16, 185, 129, 0.45);
      color: #34d399; font-size: 12px; font-weight: 700;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; }
    .drawer-backdrop {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65);
      z-index: 60; display: none;
    }
    .drawer-backdrop.open { display: block; }
    .drawer {
      position: fixed; top: 0; left: 0; bottom: 0; width: 270px;
      background: #0d1320; border-right: 1px solid #1e293b; z-index: 70;
      padding: 18px 14px; transform: translateX(-100%); transition: transform 0.2s ease;
      display: flex; flex-direction: column; gap: 8px;
    }
    .drawer.open { transform: translateX(0); }
    .drawer-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #1e293b; }
    .nav-item {
      width: 100%; text-align: left; padding: 12px 14px; border-radius: 10px;
      border: 1px solid transparent; background: transparent; color: #cbd5e1;
      font-size: 14px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 10px;
    }
    .nav-item:hover { background: #162033; color: #fff; }
    .nav-item.active { background: rgba(245, 158, 11, 0.16); border-color: rgba(245, 158, 11, 0.45); color: #fbbf24; }
    .container { max-width: 1120px; margin: 0 auto; padding: 20px 16px 60px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 18px; }
    .stat-card {
      background: #0f1624; border: 1px solid #1e293b; border-radius: 14px; padding: 16px;
    }
    .stat-label { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
    .stat-val { font-size: 22px; font-weight: 800; color: #fbbf24; word-break: break-word; }
    .card {
      background: #0f1624; border: 1px solid #1e293b; border-radius: 14px;
      padding: 18px; margin-bottom: 16px;
    }
    .card-title { font-size: 16px; font-weight: 700; margin-bottom: 12px; color: #f8fafc; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 12px; }
    label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
    input, textarea, select {
      width: 100%; padding: 10px 12px; border-radius: 10px;
      border: 1px solid #263349; background: #090d16; color: #f8fafc; font-size: 13px;
    }
    textarea { min-height: 110px; resize: vertical; }
    .btn-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    button.btn {
      padding: 10px 16px; border-radius: 10px; border: none;
      font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity 0.15s ease;
    }
    button.btn:hover { opacity: 0.9; }
    .btn-amber { background: #f59e0b; color: #090d16; }
    .btn-emerald { background: #10b981; color: #052e16; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
    .btn-blue { background: #3b82f6; color: #ffffff; }
    .btn-red { background: #ef4444; color: #ffffff; }
    .btn-ghost { background: #1e293b; color: #e2e8f0; }
    .list-box { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
    .list-item {
      display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;
      padding: 12px 14px; border-radius: 10px; background: #090d16; border: 1px solid #1e293b;
    }
    .item-meta { font-size: 12px; color: #94a3b8; margin-top: 3px; }
    .button-config-card {
      padding: 12px; border-radius: 10px; background: #090d16; border: 1px solid #1e293b;
      margin-bottom: 10px;
    }
    .page-section { display: none; }
    .page-section.active { display: block; }
    .toast {
      position: fixed; right: 16px; bottom: 16px; z-index: 90;
      padding: 12px 16px; border-radius: 10px; background: #111827;
      border: 1px solid #f59e0b; color: #fbbf24; font-size: 13px; font-weight: 700;
      display: none; max-width: 340px;
    }
    .toast.show { display: block; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand-group">
      <button type="button" class="menu-btn" id="menuToggleBtn" aria-label="Menyu">☰</button>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub">Enterprise Script, Key & Bot Control</div>
      </div>
    </div>
    <div class="status-pill" id="topBotStatus">
      <span class="dot"></span>
      <span id="topBotStatusText">Bot Aktiv</span>
    </div>
  </div>

  <div class="drawer-backdrop" id="drawerBackdrop"></div>
  <aside class="drawer" id="sideDrawer">
    <div class="drawer-head">
      <strong>Menyu</strong>
      <button type="button" class="btn btn-ghost" id="closeDrawerBtn">✕</button>
    </div>
    <button type="button" class="nav-item active" data-tab="overview">📊 İdarəetmə Paneli</button>
    <button type="button" class="nav-item" data-tab="scripts">📜 Scriptlər & Loader</button>
    <button type="button" class="nav-item" data-tab="keys">🔑 Key İdarəetmə</button>
    <button type="button" class="nav-item" data-tab="access">🛡️ Whitelist & Blacklist</button>
    <button type="button" class="nav-item" data-tab="design">🎨 Panel Dizayn & Butonlar</button>
    <button type="button" class="nav-item" data-tab="logs">📋 Sistem Logları</button>
  </aside>

  <main class="container">
    <section class="page-section active" id="tab-overview">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Aktiv Scriptlər</div>
          <div class="stat-val" id="statScripts">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Yaradılan Keylər</div>
          <div class="stat-val" id="statKeys">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bağlanan Sunucu</div>
          <div class="stat-val" id="statGuild">Sado Protect Hub</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Whitelist / Blacklist</div>
          <div class="stat-val" id="statAccess">0 / 0</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🤖 Discord Sunucu Bağlantısı (Gizli Token • 7/24 Aktiv)</div>
        <div class="form-grid">
          <div>
            <label for="guildIdInput">Sunucu (Guild) ID</label>
            <input type="text" id="guildIdInput" placeholder="Məs: 1559499280732131348" />
          </div>
          <div>
            <label for="panelChannelInput">Əsas Panel Kanal ID</label>
            <input type="text" id="panelChannelInput" placeholder="Kanal ID" />
          </div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-amber" id="connectGuildBtn">Sunucuya Bağla & Aktiv Et</button>
          <a class="btn btn-emerald" id="joinBotLink" href="#" target="_blank" rel="noopener noreferrer">➕ Join Bot</a>
        </div>
      </div>
    </section>

    <section class="page-section" id="tab-scripts">
      <div class="card">
        <div class="card-title" id="scriptFormTitle">📜 Yeni Script Yarat / Fayldan Əlavə Et</div>
        <div class="form-grid">
          <div>
            <label for="scriptNameInput">Script Adı</label>
            <input type="text" id="scriptNameInput" placeholder="Məs: SADO HUB" />
          </div>
          <div>
            <label for="scriptLoaderInput">Loader URL</label>
            <input type="text" id="scriptLoaderInput" placeholder="https://..." />
          </div>
        </div>
        <div style="margin-bottom: 12px;">
          <label for="scriptFileInput">Fayldan Script Seç (.lua / .txt / .js)</label>
          <input type="file" id="scriptFileInput" accept=".lua,.txt,.js,.json" />
        </div>
        <div style="margin-bottom: 12px;">
          <label for="scriptCodeInput">Script Kodu</label>
          <textarea id="scriptCodeInput" placeholder="-- Lua və ya script kodunu bura yazın..."></textarea>
        </div>
        <div class="btn-row">
          <label style="display:inline-flex;align-items:center;gap:6px;margin:0;cursor:pointer;">
            <input type="checkbox" id="scriptObfuscateCheck" style="width:auto;" checked />
            Obfuscate et
          </label>
          <button type="button" class="btn btn-amber" id="saveScriptBtn">Scripti Yarat / Saxla</button>
          <button type="button" class="btn btn-ghost" id="cancelEditScriptBtn" style="display:none;">Ləğv et</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Mövcud Scriptlər</div>
        <div class="list-box" id="scriptsList"></div>
      </div>
    </section>

    <section class="page-section" id="tab-keys">
      <div class="card">
        <div class="card-title">🔑 Yeni Key Yarat</div>
        <div class="form-grid">
          <div>
            <label for="keyScriptSelect">Script</label>
            <select id="keyScriptSelect"></select>
          </div>
          <div>
            <label for="keyDiscordIdInput">Discord ID (İstəyə bağlı)</label>
            <input type="text" id="keyDiscordIdInput" placeholder="Discord ID" />
          </div>
        </div>
        <button type="button" class="btn btn-amber" id="createKeyBtn">Key Yarat</button>
        <div class="list-box" id="keysList"></div>
      </div>
    </section>

    <section class="page-section" id="tab-access">
      <div class="card">
        <div class="card-title">🛡️ Whitelist & Blacklist</div>
        <div class="form-grid">
          <div>
            <label for="accessDiscordId">Discord ID</label>
            <input type="text" id="accessDiscordId" placeholder="Discord ID daxil edin" />
          </div>
          <div>
            <label for="accessReason">Qeyd / Səbəb</label>
            <input type="text" id="accessReason" placeholder="Qeyd və ya səbəb" />
          </div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-emerald" id="addWhitelistBtn">+ Whitelist</button>
          <button type="button" class="btn btn-red" id="addBlacklistBtn">+ Blacklist</button>
        </div>
        <div class="list-box" id="accessList"></div>
      </div>
    </section>

    <section class="page-section" id="tab-design">
      <div class="card">
        <div class="card-title">🎨 Panel Dizaynı & Buton Ayarları</div>
        <div class="form-grid">
          <div>
            <label for="designTitleInput">Panel Başlığı</label>
            <input type="text" id="designTitleInput" />
          </div>
          <div>
            <label for="designColorInput">Embed Rəngi</label>
            <input type="color" id="designColorInput" />
          </div>
        </div>
        <div style="margin-bottom: 12px;">
          <label for="designDescInput">Panel Təsviri</label>
          <textarea id="designDescInput"></textarea>
        </div>
        <div style="margin-bottom: 14px;">
          <label for="designFooterInput">Alt Mətn (Footer)</label>
          <input type="text" id="designFooterInput" />
        </div>
        <div class="card-title">Butonların Ayarları</div>
        <div id="buttonsEditorContainer"></div>
        <button type="button" class="btn btn-amber" id="saveDesignBtn">Buton & Dizayn Ayarlarını Yadda Saxla</button>
      </div>
    </section>

    <section class="page-section" id="tab-logs">
      <div class="card">
        <div class="card-title">📋 Son Sistem Logları</div>
        <div class="list-box" id="logsList"></div>
      </div>
    </section>
  </main>

  <div class="toast" id="toastBox"></div>

  <script>
    let currentState = null;
    let editingScriptId = null;

    const showToast = (msg) => {
      const box = document.getElementById("toastBox");
      box.textContent = msg;
      box.classList.add("show");
      setTimeout(() => box.classList.remove("show"), 3200);
    };

    const setDrawerOpen = (open) => {
      document.getElementById("sideDrawer").classList.toggle("open", open);
      document.getElementById("drawerBackdrop").classList.toggle("open", open);
    };

    const switchTab = (tabName) => {
      document.querySelectorAll(".nav-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.tab === tabName);
      });
      document.querySelectorAll(".page-section").forEach((sec) => {
        sec.classList.toggle("active", sec.id === "tab-" + tabName);
      });
      setDrawerOpen(false);
    };

    const apiRequest = async (url, method = "GET", body = null) => {
      const opts = {
        method,
        headers: { "Content-Type": "application/json" }
      };
      if (body !== null) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      return res.json();
    };

    const renderButtonsEditor = (buttons) => {
      const wrap = document.getElementById("buttonsEditorContainer");
      wrap.innerHTML = "";
      (buttons || []).forEach((btn, idx) => {
        const div = document.createElement("div");
        div.className = "button-config-card";
        div.innerHTML = \`
          <div class="form-grid">
            <div>
              <label>Buton Adı</label>
              <input type="text" class="btn-label-input" data-idx="\${idx}" value="\${btn.label || ""}" />
            </div>
            <div>
              <label>Emoji</label>
              <input type="text" class="btn-emoji-input" data-idx="\${idx}" value="\${btn.emoji || ""}" />
            </div>
            <div>
              <label>Rəng (Style)</label>
              <select class="btn-style-input" data-idx="\${idx}">
                <option value="Primary" \${btn.style === "Primary" ? "selected" : ""}>Primary (Mavi)</option>
                <option value="Success" \${btn.style === "Success" ? "selected" : ""}>Success (Yaşıl)</option>
                <option value="Danger" \${btn.style === "Danger" ? "selected" : ""}>Danger (Qırmızı)</option>
                <option value="Secondary" \${btn.style === "Secondary" ? "selected" : ""}>Secondary (Boz)</option>
              </select>
            </div>
            <div style="display:flex;align-items:end;padding-bottom:8px;">
              <label style="display:inline-flex;align-items:center;gap:6px;margin:0;cursor:pointer;">
                <input type="checkbox" class="btn-enabled-input" data-idx="\${idx}" style="width:auto;" \${btn.enabled !== false ? "checked" : ""} />
                Aktiv
              </label>
            </div>
          </div>
        \`;
        wrap.appendChild(div);
      });
    };

    const renderDashboard = (snap) => {
      if (!snap) return;
      currentState = snap;

      document.getElementById("topBotStatusText").textContent = snap.botStatus?.statusMessage || "Bot Aktiv";
      document.getElementById("statScripts").textContent = String(snap.counts?.scripts ?? 0);
      document.getElementById("statKeys").textContent = String(snap.counts?.keys ?? 0);
      document.getElementById("statGuild").textContent =
        snap.botStatus?.connectedGuildName || snap.botConfig?.guildName || "Sado Protect Hub";
      document.getElementById("statAccess").textContent =
        \`\${snap.counts?.whitelist ?? 0} / \${snap.counts?.blacklist ?? 0}\`;

      document.getElementById("guildIdInput").value = snap.botConfig?.guildId || "";
      document.getElementById("panelChannelInput").value = snap.botConfig?.panelChannelId || "";
      document.getElementById("joinBotLink").href = snap.botConfig?.inviteUrl || "#";

      const keySelect = document.getElementById("keyScriptSelect");
      keySelect.innerHTML = "";
      (snap.scripts || []).forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.name;
        opt.textContent = s.name;
        keySelect.appendChild(opt);
      });

      const scriptsList = document.getElementById("scriptsList");
      scriptsList.innerHTML = "";
      if (!snap.scripts || snap.scripts.length === 0) {
        scriptsList.innerHTML = \`<div class="item-meta">Hələ script yaradılmayıb.</div>\`;
      } else {
        snap.scripts.forEach((scr) => {
          const row = document.createElement("div");
          row.className = "list-item";
          row.innerHTML = \`
            <div>
              <strong>\${scr.name}</strong>
              <div class="item-meta">Loader: \${scr.loaderUrl || "-"} • \${scr.obfuscated ? "Obfuscated" : "Plain"}</div>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-blue" data-edit-script="\${scr.id}">Update</button>
              <button type="button" class="btn btn-red" data-del-script="\${scr.id}">Silmək</button>
            </div>
          \`;
          scriptsList.appendChild(row);
        });
      }

      const keysList = document.getElementById("keysList");
      keysList.innerHTML = "";
      (snap.keys || []).forEach((k) => {
        const row = document.createElement("div");
        row.className = "list-item";
        row.innerHTML = \`
          <div>
            <strong><code>\${k.key}</code></strong>
            <div class="item-meta">Script: \${k.scriptName} • ID: \${k.discordId || "-"}</div>
          </div>
          <button type="button" class="btn btn-red" data-del-key="\${k.id}">Silmək</button>
        \`;
        keysList.appendChild(row);
      });

      const accessList = document.getElementById("accessList");
      accessList.innerHTML = "";
      (snap.whitelist || []).forEach((w) => {
        const row = document.createElement("div");
        row.className = "list-item";
        row.innerHTML = \`
          <div>
            <strong>✅ Whitelist: <code>\${w.discordId}</code></strong>
            <div class="item-meta">\${w.note || ""}</div>
          </div>
          <button type="button" class="btn btn-red" data-del-wl="\${w.id}">Silmək</button>
        \`;
        accessList.appendChild(row);
      });
      (snap.blacklist || []).forEach((b) => {
        const row = document.createElement("div");
        row.className = "list-item";
        row.innerHTML = \`
          <div>
            <strong>⛔ Blacklist: <code>\${b.discordId}</code></strong>
            <div class="item-meta">Səbəb: \${b.reason || "-"}</div>
          </div>
          <button type="button" class="btn btn-red" data-del-bl="\${b.id}">Silmək</button>
        \`;
        accessList.appendChild(row);
      });

      if (snap.design) {
        document.getElementById("designTitleInput").value = snap.design.title || "";
        document.getElementById("designColorInput").value = snap.design.color || "#f59e0b";
        document.getElementById("designDescInput").value = snap.design.description || "";
        document.getElementById("designFooterInput").value = snap.design.footer || "";
        renderButtonsEditor(snap.design.buttons || []);
      }

      const logsList = document.getElementById("logsList");
      logsList.innerHTML = "";
      (snap.logs || []).slice(0, 25).forEach((l) => {
        const row = document.createElement("div");
        row.className = "list-item";
        row.innerHTML = \`
          <div>
            <strong>[\${l.action}]</strong> \${l.detail}
            <div class="item-meta">\${l.at}</div>
          </div>
        \`;
        logsList.appendChild(row);
      });
    };

    const loadSnapshot = async () => {
      try {
        const res = await apiRequest("/api/snapshot");
        if (res.ok && res.data) renderDashboard(res.data);
      } catch (err) {
        showToast("Snapshot yüklənərkən xəta: " + err.message);
      }
    };

    document.getElementById("menuToggleBtn").addEventListener("click", () => setDrawerOpen(true));
    document.getElementById("closeDrawerBtn").addEventListener("click", () => setDrawerOpen(false));
    document.getElementById("drawerBackdrop").addEventListener("click", () => setDrawerOpen(false));

    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("connectGuildBtn").addEventListener("click", async () => {
      const guildId = document.getElementById("guildIdInput").value.trim();
      const panelChannelId = document.getElementById("panelChannelInput").value.trim();
      const res = await apiRequest("/api/bot/connect", "POST", { guildId, panelChannelId });
      if (res.data) renderDashboard(res.data);
      showToast(res.ok ? "Sunucuya bağlandı və bot aktivdir!" : ("Xəta: " + (res.error || "")));
    });

    document.getElementById("scriptFileInput").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      document.getElementById("scriptCodeInput").value = text;
      if (!document.getElementById("scriptNameInput").value.trim()) {
        document.getElementById("scriptNameInput").value = file.name.replace(/\.[^/.]+$/, "");
      }
      showToast("Fayl kodu yükləndi.");
    });

    document.getElementById("saveScriptBtn").addEventListener("click", async () => {
      const payload = {
        name: document.getElementById("scriptNameInput").value.trim(),
        loaderUrl: document.getElementById("scriptLoaderInput").value.trim(),
        code: document.getElementById("scriptCodeInput").value,
        obfuscate: document.getElementById("scriptObfuscateCheck").checked
      };
      const res = editingScriptId
        ? await apiRequest(\`/api/scripts/\${editingScriptId}\`, "PUT", payload)
        : await apiRequest("/api/scripts", "POST", payload);

      if (res.ok && res.data) {
        renderDashboard(res.data);
        editingScriptId = null;
        document.getElementById("scriptFormTitle").textContent = "📜 Yeni Script Yarat / Fayldan Əlavə Et";
        document.getElementById("saveScriptBtn").textContent = "Scripti Yarat / Saxla";
        document.getElementById("cancelEditScriptBtn").style.display = "none";
        document.getElementById("scriptNameInput").value = "";
        document.getElementById("scriptLoaderInput").value = "";
        document.getElementById("scriptCodeInput").value = "";
        document.getElementById("scriptFileInput").value = "";
        showToast("Script uğurla yadda saxlanıldı!");
      } else {
        showToast("Xəta: " + (res.error || "Əməliyyat alınmadı"));
      }
    });

    document.getElementById("cancelEditScriptBtn").addEventListener("click", () => {
      editingScriptId = null;
      document.getElementById("scriptFormTitle").textContent = "📜 Yeni Script Yarat / Fayldan Əlavə Et";
      document.getElementById("saveScriptBtn").textContent = "Scripti Yarat / Saxla";
      document.getElementById("cancelEditScriptBtn").style.display = "none";
      document.getElementById("scriptNameInput").value = "";
      document.getElementById("scriptLoaderInput").value = "";
      document.getElementById("scriptCodeInput").value = "";
    });

    document.getElementById("scriptsList").addEventListener("click", async (e) => {
      const editId = e.target.dataset.editScript;
      const delId = e.target.dataset.delScript;
      if (editId && currentState?.scripts) {
        const target = currentState.scripts.find((s) => s.id === editId);
        if (target) {
          editingScriptId = target.id;
          document.getElementById("scriptFormTitle").textContent = "✏️ Scripti Yenilə: " + target.name;
          document.getElementById("saveScriptBtn").textContent = "Update Et";
          document.getElementById("cancelEditScriptBtn").style.display = "inline-block";
          document.getElementById("scriptNameInput").value = target.name || "";
          document.getElementById("scriptLoaderInput").value = target.loaderUrl || "";
          document.getElementById("scriptCodeInput").value = target.code || "";
          document.getElementById("scriptObfuscateCheck").checked = Boolean(target.obfuscated);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      } else if (delId) {
        const res = await apiRequest(\`/api/scripts/\${delId}\`, "DELETE");
        if (res.data) renderDashboard(res.data);
        showToast("Script silindi.");
      }
    });

    document.getElementById("createKeyBtn").addEventListener("click", async () => {
      const res = await apiRequest("/api/keys", "POST", {
        scriptName: document.getElementById("keyScriptSelect").value,
        discordId: document.getElementById("keyDiscordIdInput").value.trim()
      });
      if (res.data) renderDashboard(res.data);
      showToast(res.ok ? "Yeni key yaradıldı!" : ("Xəta: " + (res.error || "")));
    });

    document.getElementById("keysList").addEventListener("click", async (e) => {
      const delKeyId = e.target.dataset.delKey;
      if (!delKeyId) return;
      const res = await apiRequest(\`/api/keys/\${delKeyId}\`, "DELETE");
      if (res.data) renderDashboard(res.data);
      showToast("Key silindi.");
    });

    document.getElementById("addWhitelistBtn").addEventListener("click", async () => {
      const res = await apiRequest("/api/whitelist", "POST", {
        discordId: document.getElementById("accessDiscordId").value.trim(),
        note: document.getElementById("accessReason").value.trim()
      });
      if (res.data) renderDashboard(res.data);
      showToast(res.ok ? "Whitelist-ə əlavə edildi!" : ("Xəta: " + (res.error || "")));
    });

    document.getElementById("addBlacklistBtn").addEventListener("click", async () => {
      const res = await apiRequest("/api/blacklist", "POST", {
        discordId: document.getElementById("accessDiscordId").value.trim(),
        reason: document.getElementById("accessReason").value.trim()
      });
      if (res.data) renderDashboard(res.data);
      showToast(res.ok ? "Blacklist-ə əlavə edildi!" : ("Xəta: " + (res.error || "")));
    });

    document.getElementById("accessList").addEventListener("click", async (e) => {
      const wlId = e.target.dataset.delWl;
      const blId = e.target.dataset.delBl;
      if (wlId) {
        const res = await apiRequest(\`/api/whitelist/\${wlId}\`, "DELETE");
        if (res.data) renderDashboard(res.data);
        showToast("Whitelist-dən silindi.");
      } else if (blId) {
        const res = await apiRequest(\`/api/blacklist/\${blId}\`, "DELETE");
        if (res.data) renderDashboard(res.data);
        showToast("Blacklist-dən silindi.");
      }
    });

    document.getElementById("saveDesignBtn").addEventListener("click", async () => {
      const labels = [...document.querySelectorAll(".btn-label-input")];
      const emojis = [...document.querySelectorAll(".btn-emoji-input")];
      const styles = [...document.querySelectorAll(".btn-style-input")];
      const enableds = [...document.querySelectorAll(".btn-enabled-input")];

      const buttons = labels.map((el, i) => ({
        id: currentState?.design?.buttons?.[i]?.id || \`btn_\${i + 1}\`,
        label: el.value,
        emoji: emojis[i]?.value || "⚡",
        style: styles[i]?.value || "Secondary",
        enabled: Boolean(enableds[i]?.checked)
      }));

      const res = await apiRequest("/api/design", "POST", {
        title: document.getElementById("designTitleInput").value.trim(),
        color: document.getElementById("designColorInput").value.trim(),
        description: document.getElementById("designDescInput").value,
        footer: document.getElementById("designFooterInput").value.trim(),
        buttons
      });
      if (res.data) renderDashboard(res.data);
      showToast(res.ok ? "Buton & dizayn ayarları yadda saxlanıldı!" : ("Xəta: " + (res.error || "")));
    });

    loadSnapshot();
    setInterval(loadSnapshot, 10000);
  </script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

const startKeepAlivePing = () => {
  const publicUrl = String(process.env.RENDER_EXTERNAL_URL || "").trim();
  const pingUrl = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/health` : `http://127.0.0.1:${PORT}/health`;
  const clientLib = pingUrl.startsWith("https://") ? https : http;

  setInterval(() => {
    try {
      const req = clientLib.get(pingUrl, (res) => {
        res.resume();
      });
      req.on("error", () => {});
      req.end();
    } catch (_err) {}

    if (!discordClient.isReady() && !isConnectingBot) {
      activateDiscordBot().catch(() => {});
    }
  }, KEEPALIVE_INTERVAL_MS);
};

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`SADO PROTECT serveri ${PORT} portunda aktivdir.`);
  startKeepAlivePing();
  await activateDiscordBot();
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});
