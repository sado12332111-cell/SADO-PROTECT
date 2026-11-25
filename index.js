const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
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
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const resolveEnvToken = () => {
  const directCandidates = [
    process.env.DISCORD_TOKEN,
    process.env.BOT_TOKEN,
    process.env.TOKEN,
    process.env.DISCORD_BOT_TOKEN,
    process.env.SADO_BOT_TOKEN
  ];
  for (let i = 0; i < directCandidates.length; i += 1) {
    const cleaned = String(directCandidates[i] || "")
      .replace(/^Bot\s+/i, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (cleaned.length > 20 && cleaned.includes(".")) {
      return cleaned;
    }
  }
  const envKeys = Object.keys(process.env || {});
  for (let i = 0; i < envKeys.length; i += 1) {
    const k = envKeys[i];
    if (/token/i.test(k) && !/webhook/i.test(k)) {
      const candidateVal = String(process.env[k] || "")
        .replace(/^Bot\s+/i, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}$/.test(candidateVal)) {
        return candidateVal;
      }
    }
  }
  return "";
};

const APP_CONFIG = Object.freeze({
  PORT: Number(process.env.PORT || 3000),
  DISCORD_TOKEN: resolveEnvToken(),
  CLIENT_ID: String(
    process.env.DISCORD_CLIENT_ID ||
      process.env.CLIENT_ID ||
      process.env.APPLICATION_ID ||
      ""
  ).trim(),
  DEFAULT_GUILD_ID: String(process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || "").trim(),
  DEFAULT_CHANNEL_ID: String(process.env.PANEL_CHANNEL_ID || "").trim(),
  DATA_DIR: path.join(__dirname, "sado_protect_data"),
  STATE_FILE: path.join(__dirname, "sado_protect_data", "sado_state.json"),
  UPLOADS_DIR: path.join(__dirname, "sado_protect_data", "uploads"),
  DEFAULT_ACCENT: "#F59E0B",
  DEFAULT_TITLE: "SADO PROTECT",
  DEFAULT_FOOTER: "SADO PROTECT • Enterprise Security & Key System",
  MAX_SCRIPT_SIZE_BYTES: 2 * 1024 * 1024,
  API_VERSION: "v10"
});

const BUTTON_STYLE_MAP = Object.freeze({
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger
});

const DEFAULT_PANEL_BUTTONS = Object.freeze([
  Object.freeze({
    id: "btn_redeem_key",
    customId: "sado_btn_redeem_key",
    label: "Redeem Key",
    emoji: "🔑",
    style: "Success",
    order: 0
  }),
  Object.freeze({
    id: "btn_get_script",
    customId: "sado_btn_get_script",
    label: "Get Script",
    emoji: "📜",
    style: "Primary",
    order: 1
  }),
  Object.freeze({
    id: "btn_reset_hwid",
    customId: "sado_btn_reset_hwid",
    label: "Reset HWID",
    emoji: "🔄",
    style: "Secondary",
    order: 2
  }),
  Object.freeze({
    id: "btn_check_stats",
    customId: "sado_btn_check_stats",
    label: "Check Status",
    emoji: "📊",
    style: "Secondary",
    order: 3
  })
]);

const ensureDirectoryExists = (dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch (err) {
    console.error("[FS_DIR_ERROR]", err.message);
    return false;
  }
};

const createInitialState = () => {
  return {
    meta: {
      version: "4.4.0-const",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    bot: {
      guildId: APP_CONFIG.DEFAULT_GUILD_ID,
      guildName: APP_CONFIG.DEFAULT_GUILD_ID ? "Bağlı Sunucu" : "Sunucu seçilməyib",
      panelChannelId: APP_CONFIG.DEFAULT_CHANNEL_ID,
      panelMessageId: "",
      activeScriptId: "",
      connected: Boolean(APP_CONFIG.DEFAULT_GUILD_ID),
      lastConnectedAt: ""
    },
    design: {
      title: APP_CONFIG.DEFAULT_TITLE,
      color: APP_CONFIG.DEFAULT_ACCENT,
      description:
        "Aşağıdakı düymələrdən istifadə edərək key aktivləşdirə, skriptinizi əldə edə və HWID sıfırlaya bilərsiniz.",
      footer: APP_CONFIG.DEFAULT_FOOTER,
      bannerUrl: "",
      thumbnailUrl: "",
      buttons: DEFAULT_PANEL_BUTTONS.map((btn) => ({ ...btn }))
    },
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    guildCache: {}
  };
};

const normalizeButtonList = (rawButtons) => {
  if (!Array.isArray(rawButtons) || rawButtons.length === 0) {
    return DEFAULT_PANEL_BUTTONS.map((b) => ({ ...b }));
  }
  const filtered = rawButtons
    .filter((b) => b && b.id !== "btn_get_key" && b.customId !== "sado_btn_get_key")
    .map((b, idx) => {
      const safeStyle = Object.prototype.hasOwnProperty.call(BUTTON_STYLE_MAP, b.style)
        ? b.style
        : "Secondary";
      const safeLabel = String(b.label || "Button").trim().slice(0, 70) || "Button";
      const safeEmoji = String(b.emoji || "").trim().slice(0, 16);
      const safeCustomId = String(b.customId || b.id || `sado_btn_${idx}`).trim();
      return {
        id: String(b.id || `btn_${idx}`),
        customId: safeCustomId,
        label: safeLabel,
        emoji: safeEmoji,
        style: safeStyle,
        order: idx
      };
    });
  if (filtered.length === 0) {
    return DEFAULT_PANEL_BUTTONS.map((b) => ({ ...b }));
  }
  return filtered;
};

const loadPersistentState = () => {
  ensureDirectoryExists(APP_CONFIG.DATA_DIR);
  ensureDirectoryExists(APP_CONFIG.UPLOADS_DIR);
  const fallback = createInitialState();
  try {
    if (!fs.existsSync(APP_CONFIG.STATE_FILE)) {
      fs.writeFileSync(APP_CONFIG.STATE_FILE, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const rawText = fs.readFileSync(APP_CONFIG.STATE_FILE, "utf8");
    const parsed = JSON.parse(rawText);
    const merged = {
      meta: {
        ...fallback.meta,
        ...(parsed.meta || {})
      },
      bot: {
        ...fallback.bot,
        ...(parsed.bot || {})
      },
      design: {
        ...fallback.design,
        ...(parsed.design || {}),
        buttons: normalizeButtonList(parsed.design && parsed.design.buttons)
      },
      scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
      blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [],
      guildCache: parsed.guildCache && typeof parsed.guildCache === "object" ? parsed.guildCache : {}
    };
    return merged;
  } catch (err) {
    console.error("[STATE_LOAD_ERROR]", err.message);
    return fallback;
  }
};

const APP_STATE = loadPersistentState();

const savePersistentState = () => {
  try {
    ensureDirectoryExists(APP_CONFIG.DATA_DIR);
    APP_STATE.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(APP_STATE.STATE_FILE || APP_CONFIG.STATE_FILE, JSON.stringify(APP_STATE, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[STATE_SAVE_ERROR]", err.message);
    return false;
  }
};

const generateUniqueId = (prefix = "id") => {
  const rand = crypto.randomBytes(6).toString("hex");
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}_${rand}`;
};

const generateLicenseKeyString = (prefix = "SADO") => {
  const seg1 = crypto.randomBytes(2).toString("hex").toUpperCase();
  const seg2 = crypto.randomBytes(2).toString("hex").toUpperCase();
  const seg3 = crypto.randomBytes(2).toString("hex").toUpperCase();
  const seg4 = crypto.randomBytes(2).toString("hex").toUpperCase();
  const cleanPrefix = String(prefix || "SADO")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 10) || "SADO";
  return `${cleanPrefix}-${seg1}-${seg2}-${seg3}-${seg4}`;
};

const sanitizeHexColor = (inputColor) => {
  const raw = String(inputColor || "").trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(raw)) {
    return raw.toUpperCase();
  }
  if (/^[0-9A-Fa-f]{6}$/.test(raw)) {
    return `#${raw.toUpperCase()}`;
  }
  return APP_CONFIG.DEFAULT_ACCENT;
};

const fetchDiscordJsonViaHttps = (apiPath, token, useBotAuth = true) => {
  return new Promise((resolve) => {
    const headers = {
      "User-Agent": "SadoProtectEnterprise/4.4",
      "Content-Type": "application/json"
    };
    if (useBotAuth && token) {
      headers.Authorization = `Bot ${token}`;
    }
    const options = {
      hostname: "discord.com",
      port: 443,
      path: `/api/${APP_CONFIG.API_VERSION}${apiPath}`,
      method: "GET",
      headers
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : null;
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data: parsed
          });
        } catch (_parseErr) {
          resolve({ ok: false, status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", () => {
      resolve({ ok: false, status: 0, data: null });
    });
    req.setTimeout(6000, () => {
      req.destroy();
      resolve({ ok: false, status: 408, data: null });
    });
    req.end();
  });
};

const extractBotIdFromToken = (rawToken) => {
  try {
    const clean = String(rawToken || "").trim();
    const firstPart = clean.split(".")[0] || "";
    if (!firstPart) return "";
    const normalized = firstPart.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
    return /^\d{15,22}$/.test(decoded) ? decoded : "";
  } catch (_err) {
    return "";
  }
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ],
  partials: [Partials.Channel, Partials.Message]
});

const BOT_RUNTIME = {
  isReady: true,
  gatewayReady: false,
  botTag: "SADO PROTECT#5929",
  botId: extractBotIdFromToken(APP_CONFIG.DISCORD_TOKEN),
  lastError: ""
};

const isGenericGuildLabel = (nameStr) => {
  const val = String(nameStr || "").trim();
  if (!val) return true;
  if (val === "Bağlı Sunucu" || val === "Sunucu seçilməyib" || val === "Bağlanır...") return true;
  if (/^Sunucu\s*\(/i.test(val)) return true;
  if (/^\d{15,22}$/.test(val)) return true;
  return false;
};

const resolveGuildDisplayName = async (guildIdInput, preferredNameInput = "") => {
  const cleanId = String(guildIdInput || "").trim();
  const cleanPreferred = String(preferredNameInput || "").trim();
  if (!cleanId) {
    return cleanPreferred && !isGenericGuildLabel(cleanPreferred)
      ? cleanPreferred
      : "Sunucu seçilməyib";
  }

  try {
    if (discordClient && discordClient.guilds && discordClient.guilds.cache) {
      const cachedGuild = discordClient.guilds.cache.get(cleanId);
      if (cachedGuild && cachedGuild.name && !isGenericGuildLabel(cachedGuild.name)) {
        APP_STATE.guildCache[cleanId] = cachedGuild.name;
        return cachedGuild.name;
      }
    }

    if (discordClient && BOT_RUNTIME.gatewayReady) {
      const fetchedGuild = await discordClient.guilds.fetch(cleanId).catch(() => null);
      if (fetchedGuild && fetchedGuild.name && !isGenericGuildLabel(fetchedGuild.name)) {
        APP_STATE.guildCache[cleanId] = fetchedGuild.name;
        return fetchedGuild.name;
      }
    }
  } catch (_err) {
    // Fallback to HTTP lookups below
  }

  if (APP_CONFIG.DISCORD_TOKEN) {
    const restResult = await fetchDiscordJsonViaHttps(`/guilds/${cleanId}`, APP_CONFIG.DISCORD_TOKEN, true);
    if (restResult.ok && restResult.data && restResult.data.name && !isGenericGuildLabel(restResult.data.name)) {
      APP_STATE.guildCache[cleanId] = restResult.data.name;
      return restResult.data.name;
    }

    const userGuildsResult = await fetchDiscordJsonViaHttps("/users/@me/guilds", APP_CONFIG.DISCORD_TOKEN, true);
    if (userGuildsResult.ok && Array.isArray(userGuildsResult.data)) {
      userGuildsResult.data.forEach((g) => {
        if (g && g.id && g.name && !isGenericGuildLabel(g.name)) {
          APP_STATE.guildCache[g.id] = g.name;
        }
      });
      if (APP_STATE.guildCache[cleanId] && !isGenericGuildLabel(APP_STATE.guildCache[cleanId])) {
        return APP_STATE.guildCache[cleanId];
      }
    }
  }

  const previewResult = await fetchDiscordJsonViaHttps(`/guilds/${cleanId}/preview`, "", false);
  if (previewResult.ok && previewResult.data && previewResult.data.name && !isGenericGuildLabel(previewResult.data.name)) {
    APP_STATE.guildCache[cleanId] = previewResult.data.name;
    return previewResult.data.name;
  }

  const widgetResult = await fetchDiscordJsonViaHttps(`/guilds/${cleanId}/widget.json`, "", false);
  if (widgetResult.ok && widgetResult.data && widgetResult.data.name && !isGenericGuildLabel(widgetResult.data.name)) {
    APP_STATE.guildCache[cleanId] = widgetResult.data.name;
    return widgetResult.data.name;
  }

  const inviteResult = await fetchDiscordJsonViaHttps(`/guilds/${cleanId}/invites`, APP_CONFIG.DISCORD_TOKEN, Boolean(APP_CONFIG.DISCORD_TOKEN));
  if (inviteResult.ok && Array.isArray(inviteResult.data) && inviteResult.data[0]?.guild?.name) {
    const invGuildName = String(inviteResult.data[0].guild.name).trim();
    if (!isGenericGuildLabel(invGuildName)) {
      APP_STATE.guildCache[cleanId] = invGuildName;
      return invGuildName;
    }
  }

  if (APP_CONFIG.DISCORD_TOKEN) {
    const channelsResult = await fetchDiscordJsonViaHttps(`/guilds/${cleanId}/channels`, APP_CONFIG.DISCORD_TOKEN, true);
    if (channelsResult.ok && Array.isArray(channelsResult.data)) {
      const guildNamedItem = channelsResult.data.find(
        (ch) => ch && ch.guild && ch.guild.name && !isGenericGuildLabel(ch.guild.name)
      );
      if (guildNamedItem) {
        const extractedGuildName = String(guildNamedItem.guild.name).trim();
        APP_STATE.guildCache[cleanId] = extractedGuildName;
        return extractedGuildName;
      }
    }

    const activeChanId = String(APP_STATE.bot.panelChannelId || "").trim();
    if (activeChanId) {
      const chanInfo = await fetchDiscordJsonViaHttps(`/channels/${activeChanId}`, APP_CONFIG.DISCORD_TOKEN, true);
      if (chanInfo.ok && chanInfo.data && chanInfo.data.guild_id === cleanId && chanInfo.data.guild?.name) {
        const chGuildName = String(chanInfo.data.guild.name).trim();
        if (!isGenericGuildLabel(chGuildName)) {
          APP_STATE.guildCache[cleanId] = chGuildName;
          return chGuildName;
        }
      }
    }
  }

  if (cleanPreferred && !isGenericGuildLabel(cleanPreferred)) {
    APP_STATE.guildCache[cleanId] = cleanPreferred;
    return cleanPreferred;
  }

  if (APP_STATE.guildCache && APP_STATE.guildCache[cleanId] && !isGenericGuildLabel(APP_STATE.guildCache[cleanId])) {
    return APP_STATE.guildCache[cleanId];
  }

  return "Bağlı Sunucu";
};

const syncActiveGuildName = async (targetGuildId, preferredName = "") => {
  const idToUse = String(targetGuildId || APP_STATE.bot.guildId || "").trim();
  if (!idToUse) {
    APP_STATE.bot.guildId = "";
    APP_STATE.bot.guildName = "Sunucu seçilməyib";
    APP_STATE.bot.connected = false;
    savePersistentState();
    return APP_STATE.bot.guildName;
  }
  const resolved = await resolveGuildDisplayName(idToUse, preferredName);
  APP_STATE.bot.guildId = idToUse;
  APP_STATE.bot.guildName = resolved;
  APP_STATE.bot.connected = true;
  APP_STATE.bot.lastConnectedAt = new Date().toISOString();
  savePersistentState();
  return resolved;
};

const buildPanelEmbedPayload = (overrideScriptId) => {
  const chosenScriptId = String(overrideScriptId || APP_STATE.bot.activeScriptId || "").trim();
  const activeScript =
    APP_STATE.scripts.find((s) => s.id === chosenScriptId) ||
    APP_STATE.scripts[0] ||
    null;

  const titleText = activeScript
    ? `${APP_STATE.design.title} — ${activeScript.name}`
    : APP_STATE.design.title;

  const embed = new EmbedBuilder()
    .setTitle(titleText.slice(0, 256))
    .setColor(sanitizeHexColor(APP_STATE.design.color))
    .setDescription(
      String(
        APP_STATE.design.description ||
          "Aşağıdakı düymələrdən istifadə edərək key aktivləşdirə və skripti əldə edə bilərsiniz."
      ).slice(0, 4000)
    )
    .addFields(
      {
        name: "📜 Aktiv Script",
        value: activeScript ? `\`${activeScript.name}\`` : "`Təyin edilməyib`",
        inline: true
      },
      {
        name: "🌐 Sunucu",
        value: `\`${APP_STATE.bot.guildName || "SADO PROTECT"}\``,
        inline: true
      },
      {
        name: "🛡️ Status",
        value: "`Aktiv & Qorunur`",
        inline: true
      }
    )
    .setFooter({
      text: String(APP_STATE.design.footer || APP_CONFIG.DEFAULT_FOOTER).slice(0, 2048)
    })
    .setTimestamp();

  const orderedButtons = normalizeButtonList(APP_STATE.design.buttons);
  const actionRows = [];
  for (let i = 0; i < orderedButtons.length; i += 5) {
    const slice = orderedButtons.slice(i, i + 5);
    const row = new ActionRowBuilder();
    slice.forEach((btn) => {
      const builder = new ButtonBuilder()
        .setCustomId(btn.customId)
        .setLabel(String(btn.label || "Button").slice(0, 80))
        .setStyle(BUTTON_STYLE_MAP[btn.style] || ButtonStyle.Secondary);
      if (btn.emoji && String(btn.emoji).trim().length > 0) {
        try {
          builder.setEmoji(String(btn.emoji).trim());
        } catch (_emojiErr) {
          // Ignore invalid custom emoji format
        }
      }
      row.addComponents(builder);
    });
    actionRows.push(row);
  }

  return {
    embeds: [embed],
    components: actionRows
  };
};

const deployOrRefreshDiscordPanel = async (channelIdInput, scriptIdInput) => {
  const targetChannelId = String(channelIdInput || APP_STATE.bot.panelChannelId || "").trim();
  if (!targetChannelId) {
    return { ok: false, error: "Kanal ID daxil edilməyib" };
  }
  if (!BOT_RUNTIME.gatewayReady) {
    return { ok: false, error: "Discord bot hələ gateway bağlantısı qurur" };
  }
  try {
    const channel = await discordClient.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return { ok: false, error: "Göstərilən kanal tapılmadı və ya mətn kanalı deyil" };
    }
    const payload = buildPanelEmbedPayload(scriptIdInput);
    if (APP_STATE.bot.panelMessageId && APP_STATE.bot.panelChannelId === targetChannelId) {
      const existingMsg = await channel.messages
        .fetch(APP_STATE.bot.panelMessageId)
        .catch(() => null);
      if (existingMsg) {
        await existingMsg.edit(payload);
        APP_STATE.bot.panelChannelId = targetChannelId;
        savePersistentState();
        return { ok: true, messageId: existingMsg.id, updated: true };
      }
    }
    const sentMsg = await channel.send(payload);
    APP_STATE.bot.panelChannelId = targetChannelId;
    APP_STATE.bot.panelMessageId = sentMsg.id;
    savePersistentState();
    return { ok: true, messageId: sentMsg.id, updated: false };
  } catch (err) {
    return { ok: false, error: err.message || "Panel göndərilərkən xəta baş verdi" };
  }
};

const registerSlashCommands = async () => {
  if (!APP_CONFIG.DISCORD_TOKEN) {
    return;
  }
  if (!BOT_RUNTIME.botId) {
    const meInfo = await fetchDiscordJsonViaHttps("/users/@me", APP_CONFIG.DISCORD_TOKEN, true);
    if (meInfo.ok && meInfo.data && meInfo.data.id) {
      BOT_RUNTIME.botId = String(meInfo.data.id).trim();
    }
  }
  const appId = APP_CONFIG.CLIENT_ID || BOT_RUNTIME.botId;
  if (!appId) {
    return;
  }

  const scriptChoices = Array.isArray(APP_STATE.scripts)
    ? APP_STATE.scripts
        .filter((s) => s && s.id && s.name)
        .slice(0, 25)
        .map((s) => ({
          name: String(s.name).slice(0, 100),
          value: String(s.id)
        }))
    : [];

  const buildPanelSlashCommand = (useChoices) => {
    const cmd = new SlashCommandBuilder()
      .setName("panel")
      .setDescription("SADO PROTECT skript və key idarəetmə panelini açır")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((opt) => {
        const optionBuilder = opt
          .setName("script")
          .setDescription("Mövcud script seçin (boş buraxsanız aktiv script açılır)")
          .setRequired(false);
        if (useChoices && scriptChoices.length > 0) {
          optionBuilder.addChoices(...scriptChoices);
          optionBuilder.setAutocomplete(false);
        } else {
          optionBuilder.setAutocomplete(true);
        }
        return optionBuilder;
      });
    return cmd.toJSON();
  };

  const guildCommandsPayload = [
    buildPanelSlashCommand(true),
    new SlashCommandBuilder()
      .setName("genkey")
      .setDescription("Yeni lisenziya açarı yaradır")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addIntegerOption((opt) =>
        opt
          .setName("days")
          .setDescription("Müddət (gün ilə, 0 = ömürlük)")
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName("note")
          .setDescription("Key üçün qeyd")
          .setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("whitelist")
      .setDescription("İstifadəçini whitelist siyahısına əlavə edir")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((opt) =>
        opt.setName("user").setDescription("Discord istifadəçisi").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("İstifadəçini blacklist siyahısına əlavə edir")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((opt) =>
        opt.setName("user").setDescription("Discord istifadəçisi").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("Səbəb").setRequired(false)
      )
      .toJSON()
  ];

  const globalCommandsPayload = guildCommandsPayload.map((c) =>
    c.name === "panel" ? buildPanelSlashCommand(false) : c
  );

  const rest = new REST({ version: "10" }).setToken(APP_CONFIG.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(appId), { body: globalCommandsPayload });
    const targetGuildIds = new Set(
      [
        APP_STATE.bot.guildId,
        APP_CONFIG.DEFAULT_GUILD_ID,
        ...(discordClient && discordClient.guilds && discordClient.guilds.cache
          ? Array.from(discordClient.guilds.cache.keys())
          : [])
      ]
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    for (const gId of targetGuildIds) {
      await rest
        .put(Routes.applicationGuildCommands(appId, gId), { body: guildCommandsPayload })
        .catch(() => null);
    }
  } catch (err) {
    console.error("[SLASH_REGISTER_ERROR]", err.message);
  }
};

const formatScriptLoaderOutput = (scriptObj, originBaseUrl) => {
  if (!scriptObj) {
    return '-- SADO PROTECT: Script tapilmadi';
  }
  if (scriptObj.loaderUrl && String(scriptObj.loaderUrl).trim().length > 0) {
    return `loadstring(game:HttpGet("${String(scriptObj.loaderUrl).trim()}"))()`;
  }
  const safeHost = originBaseUrl || `http://localhost:${APP_CONFIG.PORT}`;
  return `loadstring(game:HttpGet("${safeHost}/raw/${scriptObj.id}"))()`;
};

const handleDiscordInteraction = async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = String(interaction.options.getFocused() || "").trim().toLowerCase();
      const filteredScripts = APP_STATE.scripts.filter((s) => {
        const n = String(s.name || "").toLowerCase();
        return !focused || n.includes(focused);
      });
      const choices = (filteredScripts.length > 0 ? filteredScripts : APP_STATE.scripts)
        .slice(0, 25)
        .map((s) => ({
          name: String(s.name || "Script").slice(0, 100),
          value: String(s.id || "")
        }));
      await interaction.respond(choices);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const cmdName = interaction.commandName;

      if (cmdName === "panel") {
        const rawScriptOption = String(interaction.options.getString("script") || "").trim();
        const matchedScript =
          APP_STATE.scripts.find(
            (s) =>
              s.id === rawScriptOption ||
              String(s.name || "").toLowerCase() === rawScriptOption.toLowerCase()
          ) || null;
        const chosenScript = matchedScript ? matchedScript.id : rawScriptOption || APP_STATE.bot.activeScriptId;
        if (chosenScript) {
          APP_STATE.bot.activeScriptId = chosenScript;
        }
        if (interaction.guildId) {
          const liveGuildName = interaction.guild && interaction.guild.name ? interaction.guild.name : "";
          if (liveGuildName) {
            APP_STATE.guildCache[interaction.guildId] = liveGuildName;
          }
          await syncActiveGuildName(interaction.guildId, liveGuildName);
        }
        APP_STATE.bot.panelChannelId = interaction.channelId;
        const payload = buildPanelEmbedPayload(chosenScript);
        const replyMsg = await interaction.reply({
          ...payload,
          fetchReply: true
        });
        if (replyMsg && replyMsg.id) {
          APP_STATE.bot.panelMessageId = replyMsg.id;
        }
        savePersistentState();
        return;
      }

      if (cmdName === "genkey") {
        const days = Math.max(0, Number(interaction.options.getInteger("days") || 30));
        const note = String(interaction.options.getString("note") || "Discord Slash").trim();
        const expiresAt =
          days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
        const newKey = {
          id: generateUniqueId("key"),
          key: generateLicenseKeyString("SADO"),
          days,
          expiresAt,
          note,
          claimedBy: "",
          claimedTag: "",
          hwid: "",
          active: true,
          createdAt: new Date().toISOString()
        };
        APP_STATE.keys.unshift(newKey);
        savePersistentState();
        await interaction.reply({
          content: `✅ Yeni Key Yaradıldı:\n\`${newKey.key}\`\nMüddət: **${days === 0 ? "Ömürlük" : `${days} gün`}**`,
          ephemeral: true
        });
        return;
      }

      if (cmdName === "whitelist") {
        const targetUser = interaction.options.getUser("user");
        const exists = APP_STATE.whitelist.find((u) => u.userId === targetUser.id);
        if (!exists) {
          APP_STATE.whitelist.unshift({
            id: generateUniqueId("wl"),
            userId: targetUser.id,
            username: targetUser.tag || targetUser.username,
            addedAt: new Date().toISOString()
          });
          APP_STATE.blacklist = APP_STATE.blacklist.filter((u) => u.userId !== targetUser.id);
          savePersistentState();
        }
        await interaction.reply({
          content: `✅ **${targetUser.tag}** whitelist siyahısına əlavə edildi.`,
          ephemeral: true
        });
        return;
      }

      if (cmdName === "blacklist") {
        const targetUser = interaction.options.getUser("user");
        const reason = String(interaction.options.getString("reason") || "Qayda pozuntusu").trim();
        const exists = APP_STATE.blacklist.find((u) => u.userId === targetUser.id);
        if (!exists) {
          APP_STATE.blacklist.unshift({
            id: generateUniqueId("bl"),
            userId: targetUser.id,
            username: targetUser.tag || targetUser.username,
            reason,
            addedAt: new Date().toISOString()
          });
          APP_STATE.whitelist = APP_STATE.whitelist.filter((u) => u.userId !== targetUser.id);
          savePersistentState();
        }
        await interaction.reply({
          content: `⛔ **${targetUser.tag}** blacklist siyahısına əlavə edildi. Səbəb: ${reason}`,
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId;
      const userId = interaction.user.id;
      const isBlacklisted = APP_STATE.blacklist.some((b) => b.userId === userId);
      if (isBlacklisted) {
        await interaction.reply({
          content: "⛔ Siz blacklist siyahısındasınız və paneldən istifadə edə bilməzsiniz.",
          ephemeral: true
        });
        return;
      }

      if (cid === "sado_btn_redeem_key") {
        const modal = new ModalBuilder()
          .setCustomId("sado_modal_redeem")
          .setTitle("SADO PROTECT • Key Aktivləşdirmə");
        const input = new TextInputBuilder()
          .setCustomId("sado_input_key_code")
          .setLabel("Lisenziya Açarı (Key)")
          .setPlaceholder("SADO-XXXX-XXXX-XXXX-XXXX")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (cid === "sado_btn_get_script") {
        const hasWhitelist = APP_STATE.whitelist.some((w) => w.userId === userId);
        const userKey = APP_STATE.keys.find(
          (k) => k.claimedBy === userId && k.active !== false
        );
        if (!hasWhitelist && !userKey) {
          await interaction.reply({
            content: "❌ Aktiv key və ya whitelist icazəniz yoxdur. Əvvəlcə **Redeem Key** düyməsi ilə açarınızı daxil edin.",
            ephemeral: true
          });
          return;
        }
        if (userKey && userKey.expiresAt && new Date(userKey.expiresAt).getTime() < Date.now()) {
          await interaction.reply({
            content: "⏳ Sizin key müddətiniz bitmişdir.",
            ephemeral: true
          });
          return;
        }
        const activeScript =
          APP_STATE.scripts.find((s) => s.id === APP_STATE.bot.activeScriptId) ||
          APP_STATE.scripts[0] ||
          null;
        if (!activeScript) {
          await interaction.reply({
            content: "⚠️ Hazırda sistemdə aktiv skript tapılmadı.",
            ephemeral: true
          });
          return;
        }
        const loaderLine = formatScriptLoaderOutput(activeScript, "");
        await interaction.reply({
          content: `📜 **${activeScript.name}** Loader Kodu:\n\`\`\`lua\n${loaderLine}\n\`\`\``,
          ephemeral: true
        });
        return;
      }

      if (cid === "sado_btn_reset_hwid") {
        const userKey = APP_STATE.keys.find((k) => k.claimedBy === userId);
        if (!userKey) {
          await interaction.reply({
            content: "❌ Hesabınıza bağlı key tapılmadı.",
            ephemeral: true
          });
          return;
        }
        userKey.hwid = "";
        savePersistentState();
        await interaction.reply({
          content: `🔄 **${userKey.key}** üçün HWID uğurla sıfırlandı!`,
          ephemeral: true
        });
        return;
      }

      if (cid === "sado_btn_check_stats") {
        const hasWhitelist = APP_STATE.whitelist.some((w) => w.userId === userId);
        const userKey = APP_STATE.keys.find((k) => k.claimedBy === userId);
        const statusLines = [
          `👤 İstifadəçi: **${interaction.user.tag}**`,
          `🛡️ Whitelist: **${hasWhitelist ? "Bəli" : "Xeyr"}**`,
          `🔑 Key: **${userKey ? userKey.key : "Bağlanmayıb"}**`,
          `⏳ Müddət: **${
            userKey
              ? userKey.expiresAt
                ? new Date(userKey.expiresAt).toLocaleDateString("az-AZ")
                : "Ömürlük"
              : "-"
          }**`
        ];
        await interaction.reply({
          content: statusLines.join("\n"),
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "sado_modal_redeem") {
      const enteredCode = String(
        interaction.fields.getTextInputValue("sado_input_key_code") || ""
      )
        .trim()
        .toUpperCase();
      const foundKey = APP_STATE.keys.find((k) => k.key.toUpperCase() === enteredCode);
      if (!foundKey) {
        await interaction.reply({
          content: "❌ Daxil etdiyiniz key tapılmadı və ya yanlışdır.",
          ephemeral: true
        });
        return;
      }
      if (foundKey.claimedBy && foundKey.claimedBy !== interaction.user.id) {
        await interaction.reply({
          content: "⛔ Bu key artıq başqa istifadəçi tərəfindən aktivləşdirilib.",
          ephemeral: true
        });
        return;
      }
      foundKey.claimedBy = interaction.user.id;
      foundKey.claimedTag = interaction.user.tag || interaction.user.username;
      if (!APP_STATE.whitelist.some((w) => w.userId === interaction.user.id)) {
        APP_STATE.whitelist.unshift({
          id: generateUniqueId("wl"),
          userId: interaction.user.id,
          username: interaction.user.tag || interaction.user.username,
          addedAt: new Date().toISOString()
        });
      }
      savePersistentState();
      await interaction.reply({
        content: `✅ Key uğurla aktivləşdirildi! İndi **Get Script** düyməsinə basaraq skriptinizi götürə bilərsiniz.`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error("[INTERACTION_ERROR]", err.message);
  }
};

discordClient.once("ready", async () => {
  BOT_RUNTIME.isReady = true;
  BOT_RUNTIME.gatewayReady = true;
  BOT_RUNTIME.botTag = discordClient.user ? discordClient.user.tag : "SADO PROTECT#5929";
  BOT_RUNTIME.botId = discordClient.user ? discordClient.user.id : "";
  BOT_RUNTIME.lastError = "";
  console.log(`[DISCORD_READY] Logged in as ${BOT_RUNTIME.botTag}`);

  discordClient.guilds.cache.forEach((g) => {
    APP_STATE.guildCache[g.id] = g.name;
  });

  if (APP_STATE.bot.guildId) {
    await syncActiveGuildName(APP_STATE.bot.guildId);
  } else if (discordClient.guilds.cache.size > 0) {
    const firstGuild = discordClient.guilds.cache.first();
    if (firstGuild) {
      await syncActiveGuildName(firstGuild.id);
    }
  } else {
    savePersistentState();
  }

  await registerSlashCommands();
});

discordClient.on("shardDisconnect", () => {
  BOT_RUNTIME.gatewayReady = false;
});

discordClient.on("shardReconnecting", () => {
  BOT_RUNTIME.gatewayReady = false;
});

discordClient.on("shardResume", () => {
  BOT_RUNTIME.gatewayReady = true;
});

discordClient.on("guildCreate", async (guild) => {
  if (guild && guild.id && guild.name) {
    APP_STATE.guildCache[guild.id] = guild.name;
    if (APP_STATE.bot.guildId === guild.id) {
      APP_STATE.bot.guildName = guild.name;
    }
    savePersistentState();
  }
});

discordClient.on("interactionCreate", handleDiscordInteraction);

const startDiscordBot = async () => {
  if (!APP_CONFIG.DISCORD_TOKEN) {
    BOT_RUNTIME.isReady = true;
    BOT_RUNTIME.gatewayReady = false;
    BOT_RUNTIME.lastError = "DISCORD_TOKEN tapılmadı";
    console.warn("[DISCORD_WARN] DISCORD_TOKEN missing; bot is offline on Discord.");
    return;
  }
  try {
    const meCheck = await fetchDiscordJsonViaHttps("/users/@me", APP_CONFIG.DISCORD_TOKEN, true);
    if (meCheck.ok && meCheck.data) {
      BOT_RUNTIME.isReady = true;
      BOT_RUNTIME.botId = meCheck.data.id || BOT_RUNTIME.botId;
      BOT_RUNTIME.botTag = meCheck.data.discriminator && meCheck.data.discriminator !== "0"
        ? `${meCheck.data.username}#${meCheck.data.discriminator}`
        : meCheck.data.username || BOT_RUNTIME.botTag;
    }
    await discordClient.login(APP_CONFIG.DISCORD_TOKEN);
  } catch (err) {
    BOT_RUNTIME.gatewayReady = false;
    BOT_RUNTIME.lastError = err.message;
    console.error("[DISCORD_LOGIN_ERROR]", err.message);
    setTimeout(() => {
      startDiscordBot().catch(() => null);
    }, 10000);
  }
};

const buildPublicSnapshot = () => {
  const rawGuildName =
    APP_STATE.bot.guildId && APP_STATE.bot.guildName
      ? APP_STATE.bot.guildName
      : APP_STATE.bot.guildId && APP_STATE.guildCache
      ? APP_STATE.guildCache[APP_STATE.bot.guildId] || ""
      : "";
  const activeGuildName = APP_STATE.bot.guildId
    ? rawGuildName && !isGenericGuildLabel(rawGuildName)
      ? rawGuildName
      : "Bağlı Sunucu"
    : "Sunucu seçilməyib";

  return {
    botStatus: {
      isReady: true,
      discordConnected: BOT_RUNTIME.gatewayReady,
      botTag: BOT_RUNTIME.botTag || "SADO PROTECT#5929",
      guildId: APP_STATE.bot.guildId || "",
      guildName: activeGuildName,
      panelChannelId: APP_STATE.bot.panelChannelId || "",
      panelMessageId: APP_STATE.bot.panelMessageId || "",
      activeScriptId: APP_STATE.bot.activeScriptId || "",
      lastError: BOT_RUNTIME.lastError || ""
    },
    stats: {
      scriptsCount: APP_STATE.scripts.length,
      keysCount: APP_STATE.keys.length,
      activeKeysCount: APP_STATE.keys.filter((k) => k.active !== false).length,
      whitelistCount: APP_STATE.whitelist.length,
      blacklistCount: APP_STATE.blacklist.length
    },
    design: {
      ...APP_STATE.design,
      buttons: normalizeButtonList(APP_STATE.design.buttons)
    },
    scripts: APP_STATE.scripts.map((s) => ({
      id: s.id,
      name: s.name,
      loaderUrl: s.loaderUrl || "",
      sourceType: s.sourceType || "url",
      fileName: s.fileName || "",
      hasContent: Boolean(s.scriptContent),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt || s.createdAt
    })),
    keys: APP_STATE.keys,
    whitelist: APP_STATE.whitelist,
    blacklist: APP_STATE.blacklist
  };
};

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>SADO PROTECT • Enterprise Control Panel</title>
  <style>
    :root {
      --bg-main: #070b14;
      --bg-card: #0d1424;
      --bg-input: #111b30;
      --border-subtle: #1e293b;
      --accent: #f59e0b;
      --accent-hover: #d97706;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
      --danger: #ef4444;
      --primary: #3b82f6;
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
      overflow-x: hidden;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 60;
      background: rgba(7, 11, 20, 0.96);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-subtle);
      padding: 14px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .menu-toggle {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      border: 1px solid #283548;
      background: #11192c;
      color: #f8fafc;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s ease, transform 0.1s ease;
    }

    .menu-toggle:active {
      transform: scale(0.95);
    }

    .brand-box {
      min-width: 0;
    }

    .brand-title {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: var(--accent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .brand-sub {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      background: #0f172a;
      border: 1px solid #1e293b;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
    }

    .status-dot.offline {
      background: var(--danger);
      box-shadow: 0 0 10px var(--danger);
    }

    .layout-shell {
      display: flex;
      min-height: calc(100vh - 71px);
    }

    .sidebar {
      width: 260px;
      background: #0a101d;
      border-right: 1px solid var(--border-subtle);
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }

    .nav-btn {
      width: 100%;
      text-align: left;
      padding: 13px 15px;
      border-radius: 12px;
      border: 1px solid transparent;
      background: transparent;
      color: #cbd5e1;
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .nav-btn:hover {
      background: #111a2e;
      color: #ffffff;
    }

    .nav-btn.active {
      background: rgba(245, 158, 11, 0.14);
      border-color: rgba(245, 158, 11, 0.45);
      color: var(--accent);
    }

    .main-area {
      flex: 1;
      padding: 20px;
      max-width: 1080px;
      margin: 0 auto;
      width: 100%;
    }

    .tab-section {
      display: none;
      flex-direction: column;
      gap: 18px;
    }

    .tab-section.active {
      display: flex;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 800;
      color: var(--accent);
      word-break: break-word;
    }

    .stat-value.guild-name {
      font-size: 21px;
      line-height: 1.3;
    }

    .panel-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 18px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .panel-heading {
      font-size: 18px;
      font-weight: 700;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .info-banner {
      background: #111a2e;
      border: 1px solid #22304a;
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 14px;
      color: #e2e8f0;
      font-weight: 600;
    }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }

    .field-group {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    label {
      font-size: 13px;
      font-weight: 600;
      color: #cbd5e1;
    }

    input[type="text"],
    input[type="number"],
    textarea,
    select {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid #24324d;
      border-radius: 12px;
      padding: 12px 14px;
      color: #f8fafc;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    input:focus,
    textarea:focus,
    select:focus {
      border-color: var(--accent);
    }

    textarea {
      min-height: 92px;
      resize: vertical;
    }

    .file-input-wrap {
      background: var(--bg-input);
      border: 1px dashed #334155;
      border-radius: 12px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .file-input-wrap input[type="file"] {
      color: #cbd5e1;
      font-size: 13px;
      width: 100%;
    }

    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .btn {
      border: none;
      border-radius: 12px;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: opacity 0.15s ease, transform 0.1s ease;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-amber {
      background: var(--accent);
      color: #090d16;
    }

    .btn-primary {
      background: var(--primary);
      color: #ffffff;
    }

    .btn-success {
      background: var(--success);
      color: #052e16;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.16);
      border: 1px solid rgba(239, 68, 68, 0.45);
      color: #fca5a5;
    }

    .btn-ghost {
      background: #152036;
      border: 1px solid #263552;
      color: #e2e8f0;
    }

    .btn-sm {
      padding: 8px 12px;
      font-size: 12px;
      border-radius: 9px;
    }

    .list-stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .item-card {
      background: #10182b;
      border: 1px solid #212e47;
      border-radius: 14px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .item-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .item-title {
      font-size: 15px;
      font-weight: 700;
      color: #f8fafc;
    }

    .item-sub {
      font-size: 12px;
      color: var(--text-muted);
      word-break: break-all;
      margin-top: 3px;
    }

    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(245, 158, 11, 0.16);
      color: var(--accent);
      border: 1px solid rgba(245, 158, 11, 0.35);
    }

    .badge-green {
      background: rgba(16, 185, 129, 0.16);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.35);
    }

    .btn-designer-row {
      background: #10182b;
      border: 1px solid #23314d;
      border-radius: 14px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .btn-designer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .btn-designer-fields {
      display: grid;
      grid-template-columns: 80px 1fr 130px;
      gap: 8px;
    }

    .toast-box {
      position: fixed;
      bottom: 20px;
      right: 20px;
      left: 20px;
      max-width: 420px;
      margin: 0 auto;
      background: #111b30;
      border: 1px solid var(--accent);
      color: #f8fafc;
      padding: 13px 16px;
      border-radius: 14px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 14px 35px rgba(0, 0, 0, 0.55);
      z-index: 999;
      display: none;
      text-align: center;
    }

    @media (max-width: 820px) {
      .layout-shell {
        flex-direction: column;
      }
      .sidebar {
        display: none;
        width: 100%;
        border-right: none;
        border-bottom: 1px solid var(--border-subtle);
        padding: 12px 16px;
      }
      .sidebar.open {
        display: flex;
      }
      .main-area {
        padding: 14px;
      }
      .btn-designer-fields {
        grid-template-columns: 72px 1fr;
      }
      .btn-designer-fields select {
        grid-column: span 2;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <button
        type="button"
        class="menu-toggle"
        id="mobileMenuBtn"
        aria-label="Menyu"
        onclick="window.sadoToggleMenu()"
      >☰</button>
      <div class="brand-box">
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub">Enterprise Script, Key &amp; Bot Control</div>
      </div>
    </div>
    <div class="status-pill">
      <span class="status-dot" id="botStatusDot"></span>
      <span id="botStatusText">Bot: Aktivdir</span>
    </div>
  </header>

  <div class="layout-shell">
    <aside class="sidebar" id="sidebarNav">
      <button type="button" class="nav-btn active" data-tab="overview" onclick="window.sadoSelectTab('overview')">
        <span>📊</span><span>İdarəetmə</span>
      </button>
      <button type="button" class="nav-btn" data-tab="scripts" onclick="window.sadoSelectTab('scripts')">
        <span>📜</span><span>Scriptlər</span>
      </button>
      <button type="button" class="nav-btn" data-tab="keys" onclick="window.sadoSelectTab('keys')">
        <span>🔑</span><span>Keylər</span>
      </button>
      <button type="button" class="nav-btn" data-tab="design" onclick="window.sadoSelectTab('design')">
        <span>🎨</span><span>Panel Dizaynı</span>
      </button>
      <button type="button" class="nav-btn" data-tab="access" onclick="window.sadoSelectTab('access')">
        <span>🛡️</span><span>Whitelist / Blacklist</span>
      </button>
    </aside>

    <main class="main-area">
      <!-- TAB 1: İDARƏETMƏ -->
      <section class="tab-section active" id="tab-overview">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Aktiv Scriptlər</div>
            <div class="stat-value" id="statScriptsCount">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Yaradılan Keylər</div>
            <div class="stat-value" id="statKeysCount">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Bağlanan Sunucu</div>
            <div class="stat-value guild-name" id="statGuildName">Sunucu seçilməyib</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Whitelist / Blacklist</div>
            <div class="stat-value" id="statAccessRatio">0 / 0</div>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">🤖 Discord Bot Bağlantısı</div>
          <div class="info-banner" id="connectedGuildBanner">Bağlanan Sunucu: Sunucu seçilməyib</div>
          <div class="form-grid">
            <div class="field-group">
              <label for="guildIdInput">Sunucu ID</label>
              <input
                type="text"
                id="guildIdInput"
                placeholder="Məsələn: 1442474868526305323"
                autocomplete="off"
              />
            </div>
            <div class="field-group">
              <label for="panelChannelIdInput">Panel Kanal ID (İstəyə bağlı)</label>
              <input
                type="text"
                id="panelChannelIdInput"
                placeholder="Panelin göndəriləcəyi kanal ID-si"
                autocomplete="off"
              />
            </div>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn-amber"
                id="connectGuildBtn"
                onclick="window.sadoConnectGuild()"
              >Botu Bağla və Paneli Yenilə</button>
            </div>
          </div>
        </div>
      </section>

      <!-- TAB 2: SCRIPTLƏR -->
      <section class="tab-section" id="tab-scripts">
        <div class="panel-card">
          <div class="panel-heading">📜 Yeni Script Yarat</div>
          <div class="form-grid">
            <div class="field-group">
              <label for="newScriptNameInput">Script Adı</label>
              <input
                type="text"
                id="newScriptNameInput"
                placeholder="Script adını daxil edin (Məsələn: SADO HUB)"
                autocomplete="off"
              />
            </div>
            <div class="field-group">
              <label for="newScriptUrlInput">Loader URL (və ya aşağıdan dosya seçin)</label>
              <input
                type="text"
                id="newScriptUrlInput"
                placeholder="https://example.com/loader.lua"
                autocomplete="off"
              />
            </div>
            <div class="field-group">
              <label for="newScriptFileInput">Dosya Əlavə Et (.lua / .txt)</label>
              <div class="file-input-wrap">
                <input
                  type="file"
                  id="newScriptFileInput"
                  accept=".lua,.txt,text/plain"
                />
              </div>
            </div>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn-amber"
                id="createScriptBtn"
                onclick="window.sadoCreateScript()"
              >Script Yarat</button>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">📦 Mövcud Scriptlər</div>
          <div id="inlineScriptEditBox" style="display:none;background:#111a2e;border:1px solid #f59e0b;border-radius:14px;padding:14px;">
            <input type="hidden" id="editScriptIdHidden" />
            <div class="form-grid">
              <div class="field-group">
                <label for="editScriptNameInput">Yeni Script Adı</label>
                <input type="text" id="editScriptNameInput" />
              </div>
              <div class="field-group">
                <label for="editScriptLoaderInput">Yeni Loader URL</label>
                <input type="text" id="editScriptLoaderInput" />
              </div>
              <div class="field-group">
                <label for="editScriptFileInput">Yeni Dosya Yüklə (İstəyə bağlı)</label>
                <div class="file-input-wrap">
                  <input type="file" id="editScriptFileInput" accept=".lua,.txt,text/plain" />
                </div>
              </div>
              <div class="btn-row">
                <button type="button" class="btn btn-amber btn-sm" onclick="window.sadoSubmitInlineScriptEdit()">Yadda Saxla</button>
                <button type="button" class="btn btn-ghost btn-sm" onclick="window.sadoCancelInlineScriptEdit()">Ləğv Et</button>
              </div>
            </div>
          </div>
          <div class="list-stack" id="scriptsListContainer"></div>
        </div>
      </section>

      <!-- TAB 3: KEYLƏR -->
      <section class="tab-section" id="tab-keys">
        <div class="panel-card">
          <div class="panel-heading">🔑 Yeni Key Yarat</div>
          <div class="form-grid">
            <div class="field-group">
              <label for="keyPrefixInput">Key Prefiksi</label>
              <input type="text" id="keyPrefixInput" value="SADO" placeholder="SADO" />
            </div>
            <div class="field-group">
              <label for="keyDaysInput">Müddət (Gün ilə, 0 = Ömürlük)</label>
              <input type="number" id="keyDaysInput" value="30" min="0" />
            </div>
            <div class="field-group">
              <label for="keyNoteInput">Qeyd (İstəyə bağlı)</label>
              <input type="text" id="keyNoteInput" placeholder="VIP müştəri üçün" />
            </div>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn-amber"
                id="generateKeyBtn"
                onclick="window.sadoGenerateKey()"
              >Key Yarat</button>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">🗂️ Mövcud Keylər</div>
          <div class="list-stack" id="keysListContainer"></div>
        </div>
      </section>

      <!-- TAB 4: PANEL DİZAYNI -->
      <section class="tab-section" id="tab-design">
        <div class="panel-card">
          <div class="panel-heading">🎨 Panel &amp; Buton Dizayn Ayarları</div>
          <div class="form-grid">
            <div class="field-group">
              <label for="designTitleInput">Panel Başlığı</label>
              <input type="text" id="designTitleInput" placeholder="SADO PROTECT" />
            </div>
            <div class="field-group">
              <label for="designColorInput">Embed Rəngi (HEX)</label>
              <input type="text" id="designColorInput" placeholder="#F59E0B" />
            </div>
            <div class="field-group">
              <label for="designDescInput">Panel Təsviri</label>
              <textarea id="designDescInput" placeholder="Panel açıqlaması..."></textarea>
            </div>
            <div class="field-group">
              <label for="designFooterInput">Alt Mətn (Footer)</label>
              <input type="text" id="designFooterInput" placeholder="SADO PROTECT" />
            </div>

            <div class="field-group">
              <label>🎛️ Panel Butonları (Adını, Emojisini, Rəngini və Yerini Dəyişin)</label>
              <div class="list-stack" id="buttonDesignerContainer"></div>
            </div>

            <div class="btn-row">
              <button
                type="button"
                class="btn btn-amber"
                id="saveDesignBtn"
                onclick="window.sadoSaveDesign()"
              >💾 Ayarları Yadda Saxla</button>
              <button
                type="button"
                class="btn btn-ghost"
                onclick="window.sadoResetButtonsDefault()"
              >Butonları Sıfırla</button>
            </div>
          </div>
        </div>
      </section>

      <!-- TAB 5: WHITELIST / BLACKLIST -->
      <section class="tab-section" id="tab-access">
        <div class="panel-card">
          <div class="panel-heading">🛡️ Whitelist / Blacklist İdarəetməsi</div>
          <div class="form-grid">
            <div class="field-group">
              <label for="accessUserIdInput">Discord İstifadəçi ID</label>
              <input type="text" id="accessUserIdInput" placeholder="123456789012345678" />
            </div>
            <div class="field-group">
              <label for="accessUserNameInput">İstifadəçi Adı / Qeyd</label>
              <input type="text" id="accessUserNameInput" placeholder="İstifadəçi adı və ya səbəb" />
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-success" onclick="window.sadoAddAccess('whitelist')">✅ Whitelist Əlavə Et</button>
              <button type="button" class="btn btn-danger" onclick="window.sadoAddAccess('blacklist')">⛔ Blacklist Əlavə Et</button>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">✅ Whitelist Siyahısı</div>
          <div class="list-stack" id="whitelistContainer"></div>
        </div>

        <div class="panel-card">
          <div class="panel-heading">⛔ Blacklist Siyahısı</div>
          <div class="list-stack" id="blacklistContainer"></div>
        </div>
      </section>
    </main>
  </div>

  <div class="toast-box" id="toastBox"></div>

  <script>
    const CLIENT_STATE = {
      snapshot: null,
      draftButtons: [
        { id: "btn_redeem_key", customId: "sado_btn_redeem_key", label: "Redeem Key", emoji: "🔑", style: "Success", order: 0 },
        { id: "btn_get_script", customId: "sado_btn_get_script", label: "Get Script", emoji: "📜", style: "Primary", order: 1 },
        { id: "btn_reset_hwid", customId: "sado_btn_reset_hwid", label: "Reset HWID", emoji: "🔄", style: "Secondary", order: 2 },
        { id: "btn_check_stats", customId: "sado_btn_check_stats", label: "Check Status", emoji: "📊", style: "Secondary", order: 3 }
      ]
    };

    const showToast = (msg) => {
      const box = document.getElementById("toastBox");
      if (!box) return;
      box.textContent = String(msg || "");
      box.style.display = "block";
      clearTimeout(window.__sadoToastTimer);
      window.__sadoToastTimer = setTimeout(() => {
        box.style.display = "none";
      }, 3200);
    };

    const escapeHtml = (str) => {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    const callApi = async (url, method = "GET", bodyObj = null) => {
      try {
        const opts = {
          method,
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          }
        };
        if (bodyObj !== null) {
          opts.body = JSON.stringify(bodyObj);
        }
        const response = await fetch(url, opts);
        const text = await response.text();
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch (_e) {
          parsed = { ok: false, error: "Server cavabı oxunmadı" };
        }
        return {
          ok: response.ok && parsed.ok !== false,
          status: response.status,
          ...parsed
        };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: err.message || "Şəbəkə xətası"
        };
      }
    };

    const readFileAsText = (fileObj) => {
      return new Promise((resolve, reject) => {
        if (!fileObj) {
          resolve("");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Fayl oxuna bilmədi"));
        reader.readAsText(fileObj);
      });
    };

    window.sadoToggleMenu = () => {
      const nav = document.getElementById("sidebarNav");
      if (!nav) return;
      nav.classList.toggle("open");
    };

    window.sadoSelectTab = (tabName) => {
      const buttons = document.querySelectorAll(".nav-btn");
      buttons.forEach((btn) => {
        if (btn.getAttribute("data-tab") === tabName) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });

      const sections = document.querySelectorAll(".tab-section");
      sections.forEach((sec) => {
        if (sec.id === "tab-" + tabName) {
          sec.classList.add("active");
        } else {
          sec.classList.remove("active");
        }
      });

      const nav = document.getElementById("sidebarNav");
      if (nav && nav.classList.contains("open")) {
        nav.classList.remove("open");
      }
    };

    const renderButtonDesignerList = () => {
      const container = document.getElementById("buttonDesignerContainer");
      if (!container) return;
      if (!Array.isArray(CLIENT_STATE.draftButtons) || CLIENT_STATE.draftButtons.length === 0) {
        container.innerHTML = '<div class="item-sub">Buton tapılmadı.</div>';
        return;
      }

      container.innerHTML = CLIENT_STATE.draftButtons
        .map((btn, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === CLIENT_STATE.draftButtons.length - 1;
          const rowParts = [
            '<div class="btn-designer-row">',
            '<div class="btn-designer-header">',
            '<span class="badge">#' + (idx + 1) + ' • ' + escapeHtml(btn.label || 'Button') + '</span>',
            '<div class="btn-row">',
            '<button type="button" class="btn btn-ghost btn-sm" ' + (isFirst ? 'disabled' : '') + ' onclick="window.sadoMoveButton(' + idx + ', -1)" title="Yuxarı">▲</button>',
            '<button type="button" class="btn btn-ghost btn-sm" ' + (isLast ? 'disabled' : '') + ' onclick="window.sadoMoveButton(' + idx + ', 1)" title="Aşağı">▼</button>',
            '</div>',
            '</div>',
            '<div class="btn-designer-fields">',
            '<input type="text" value="' + escapeHtml(btn.emoji || '') + '" placeholder="Emoji" onchange="window.sadoUpdateDraftButton(' + idx + ', \'emoji\', this.value)" oninput="window.sadoUpdateDraftButton(' + idx + ', \'emoji\', this.value)" />',
            '<input type="text" value="' + escapeHtml(btn.label || '') + '" placeholder="Buton adı" onchange="window.sadoUpdateDraftButton(' + idx + ', \'label\', this.value)" oninput="window.sadoUpdateDraftButton(' + idx + ', \'label\', this.value)" />',
            '<select onchange="window.sadoUpdateDraftButton(' + idx + ', \'style\', this.value)">',
            '<option value="Success" ' + (btn.style === 'Success' ? 'selected' : '') + '>Yaşıl (Success)</option>',
            '<option value="Primary" ' + (btn.style === 'Primary' ? 'selected' : '') + '>Mavi (Primary)</option>',
            '<option value="Secondary" ' + (btn.style === 'Secondary' ? 'selected' : '') + '>Boz (Secondary)</option>',
            '<option value="Danger" ' + (btn.style === 'Danger' ? 'selected' : '') + '>Qırmızı (Danger)</option>',
            '</select>',
            '</div>',
            '</div>'
          ];
          return rowParts.join('');
        })
        .join('');
    };

    window.sadoUpdateDraftButton = (index, field, value) => {
      if (!CLIENT_STATE.draftButtons[index]) return;
      CLIENT_STATE.draftButtons[index][field] = value;
    };

    window.sadoMoveButton = (index, direction) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= CLIENT_STATE.draftButtons.length) return;
      const copy = [...CLIENT_STATE.draftButtons];
      const temp = copy[index];
      copy[index] = copy[targetIndex];
      copy[targetIndex] = temp;
      CLIENT_STATE.draftButtons = copy.map((b, idx) => ({ ...b, order: idx }));
      renderButtonDesignerList();
    };

    window.sadoResetButtonsDefault = () => {
      CLIENT_STATE.draftButtons = [
        { id: "btn_redeem_key", customId: "sado_btn_redeem_key", label: "Redeem Key", emoji: "🔑", style: "Success", order: 0 },
        { id: "btn_get_script", customId: "sado_btn_get_script", label: "Get Script", emoji: "📜", style: "Primary", order: 1 },
        { id: "btn_reset_hwid", customId: "sado_btn_reset_hwid", label: "Reset HWID", emoji: "🔄", style: "Secondary", order: 2 },
        { id: "btn_check_stats", customId: "sado_btn_check_stats", label: "Check Status", emoji: "📊", style: "Secondary", order: 3 }
      ];
      renderButtonDesignerList();
      showToast("Butonlar ilkin vəziyyətə qaytarıldı (Yadda saxla düyməsinə basın)");
    };

    const renderScriptsList = (scripts, activeScriptId) => {
      const container = document.getElementById("scriptsListContainer");
      if (!container) return;
      if (!Array.isArray(scripts) || scripts.length === 0) {
        container.innerHTML = '<div class="item-sub">Hələ heç bir script yaradılmayıb.</div>';
        return;
      }

      container.innerHTML = scripts
        .map((sc) => {
          const isActive = sc.id === activeScriptId;
          const loaderDisplay = sc.loaderUrl
            ? sc.loaderUrl
            : `${window.location.origin}/raw/${sc.id}`;
          const encName = encodeURIComponent(sc.name || "");
          const encUrl = encodeURIComponent(sc.loaderUrl || "");
          return `
            <div class="item-card">
              <div class="item-top">
                <div>
                  <div class="item-title">
                    ${escapeHtml(sc.name)}
                    ${isActive ? '<span class="badge badge-green">Aktiv Panel Scripti</span>' : ""}
                    ${sc.sourceType === "file" ? `<span class="badge">Dosya: ${escapeHtml(sc.fileName || "script.lua")}</span>` : ""}
                  </div>
                  <div class="item-sub">Loader: ${escapeHtml(loaderDisplay)}</div>
                </div>
                <div class="btn-row">
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    onclick="window.sadoSetActiveScript('${sc.id}')"
                  >Panelə Bağla</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onclick="window.updateScriptPrompt('${sc.id}', '${encName}', '${encUrl}')"
                  >Düzəliş Et</button>
                  <button
                    type="button"
                    class="btn btn-danger btn-sm"
                    onclick="window.sadoDeleteScript('${sc.id}')"
                  >Sil</button>
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    };

    const renderKeysList = (keys) => {
      const container = document.getElementById("keysListContainer");
      if (!container) return;
      if (!Array.isArray(keys) || keys.length === 0) {
        container.innerHTML = '<div class="item-sub">Hələ heç bir key yaradılmayıb.</div>';
        return;
      }

      container.innerHTML = keys
        .map((k) => {
          const durationText = Number(k.days) === 0 ? "Ömürlük" : `${k.days} gün`;
          const ownerText = k.claimedTag
            ? `İstifadəçi: ${k.claimedTag} (${k.claimedBy})`
            : "İstifadə edilməyib";
          return `
            <div class="item-card">
              <div class="item-top">
                <div>
                  <div class="item-title">${escapeHtml(k.key)} <span class="badge">${durationText}</span></div>
                  <div class="item-sub">${escapeHtml(ownerText)} • Qeyd: ${escapeHtml(k.note || "-")}</div>
                </div>
                <div class="btn-row">
                  <button type="button" class="btn btn-ghost btn-sm" onclick="window.sadoCopyText('${escapeHtml(k.key)}')">Kopyala</button>
                  <button type="button" class="btn btn-ghost btn-sm" onclick="window.sadoResetKeyHwid('${k.id}')">HWID Sıfırla</button>
                  <button type="button" class="btn btn-danger btn-sm" onclick="window.sadoDeleteKey('${k.id}')">Sil</button>
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    };

    const renderAccessLists = (whitelist, blacklist) => {
      const wlBox = document.getElementById("whitelistContainer");
      const blBox = document.getElementById("blacklistContainer");
      if (wlBox) {
        if (!Array.isArray(whitelist) || whitelist.length === 0) {
          wlBox.innerHTML = '<div class="item-sub">Whitelist boşdur.</div>';
        } else {
          wlBox.innerHTML = whitelist
            .map(
              (w) => `
              <div class="item-card">
                <div class="item-top">
                  <div>
                    <div class="item-title">${escapeHtml(w.username || w.userId)}</div>
                    <div class="item-sub">ID: ${escapeHtml(w.userId)}</div>
                  </div>
                  <button type="button" class="btn btn-danger btn-sm" onclick="window.sadoRemoveAccess('whitelist', '${escapeHtml(w.userId)}')">Sil</button>
                </div>
              </div>
            `
            )
            .join("");
        }
      }

      if (blBox) {
        if (!Array.isArray(blacklist) || blacklist.length === 0) {
          blBox.innerHTML = '<div class="item-sub">Blacklist boşdur.</div>';
        } else {
          blBox.innerHTML = blacklist
            .map(
              (b) => `
              <div class="item-card">
                <div class="item-top">
                  <div>
                    <div class="item-title">${escapeHtml(b.username || b.userId)}</div>
                    <div class="item-sub">ID: ${escapeHtml(b.userId)} • Səbəb: ${escapeHtml(b.reason || "-")}</div>
                  </div>
                  <button type="button" class="btn btn-danger btn-sm" onclick="window.sadoRemoveAccess('blacklist', '${escapeHtml(b.userId)}')">Sil</button>
                </div>
              </div>
            `
            )
            .join("");
        }
      }
    };

    const renderSnapshot = (snap) => {
      if (!snap) return;
      CLIENT_STATE.snapshot = snap;

      const dot = document.getElementById("botStatusDot");
      const statusText = document.getElementById("botStatusText");
      if (dot && statusText) {
        dot.classList.remove("offline");
        statusText.textContent = "Bot: Aktivdir";
      }

      const guildDisplay =
        (snap.botStatus && snap.botStatus.guildName) || "Sunucu seçilməyib";

      const statScripts = document.getElementById("statScriptsCount");
      const statKeys = document.getElementById("statKeysCount");
      const statGuild = document.getElementById("statGuildName");
      const statAccess = document.getElementById("statAccessRatio");
      const banner = document.getElementById("connectedGuildBanner");

      if (statScripts) statScripts.textContent = String(snap.stats?.scriptsCount ?? 0);
      if (statKeys) statKeys.textContent = String(snap.stats?.keysCount ?? 0);
      if (statGuild) statGuild.textContent = guildDisplay;
      if (statAccess) {
        statAccess.textContent = `${snap.stats?.whitelistCount ?? 0} / ${snap.stats?.blacklistCount ?? 0}`;
      }
      if (banner) {
        banner.textContent = `Bağlanan Sunucu: ${guildDisplay}`;
      }

      const guildInput = document.getElementById("guildIdInput");
      const chanInput = document.getElementById("panelChannelIdInput");
      if (guildInput && !guildInput.value && snap.botStatus?.guildId) {
        guildInput.value = snap.botStatus.guildId;
      }
      if (chanInput && !chanInput.value && snap.botStatus?.panelChannelId) {
        chanInput.value = snap.botStatus.panelChannelId;
      }

      if (snap.design) {
        const tIn = document.getElementById("designTitleInput");
        const cIn = document.getElementById("designColorInput");
        const dIn = document.getElementById("designDescInput");
        const fIn = document.getElementById("designFooterInput");
        if (tIn && document.activeElement !== tIn) tIn.value = snap.design.title || "";
        if (cIn && document.activeElement !== cIn) cIn.value = snap.design.color || "#F59E0B";
        if (dIn && document.activeElement !== dIn) dIn.value = snap.design.description || "";
        if (fIn && document.activeElement !== fIn) fIn.value = snap.design.footer || "";

        if (Array.isArray(snap.design.buttons) && snap.design.buttons.length > 0) {
          CLIENT_STATE.draftButtons = snap.design.buttons.map((b, i) => ({
            ...b,
            order: i
          }));
        }
      }

      renderButtonDesignerList();
      renderScriptsList(snap.scripts || [], snap.botStatus?.activeScriptId || "");
      renderKeysList(snap.keys || []);
      renderAccessLists(snap.whitelist || [], snap.blacklist || []);
    };

    const loadInitialSnapshot = async () => {
      const res = await callApi("/api/state", "GET");
      if (res.ok && res.data) {
        renderSnapshot(res.data);
      } else {
        renderButtonDesignerList();
      }
    };

    window.sadoConnectGuild = async () => {
      const guildId = document.getElementById("guildIdInput")?.value.trim() || "";
      const panelChannelId = document.getElementById("panelChannelIdInput")?.value.trim() || "";
      if (!guildId) {
        showToast("Zəhmət olmasa Sunucu ID daxil edin!");
        return;
      }
      const btn = document.getElementById("connectGuildBtn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Bağlanır...";
      }
      const res = await callApi("/api/bot/connect", "POST", {
        guildId,
        panelChannelId
      });
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Botu Bağla və Paneli Yenilə";
      }
      if (res.data) {
        renderSnapshot(res.data);
      }
      if (res.ok) {
        const resolvedName = res.data?.botStatus?.guildName || "Sunucu";
        showToast(`Bağlandı: ${resolvedName}`);
      } else {
        showToast("Xəta: " + (res.error || "Sunucu bağlanmadı"));
      }
    };

    window.sadoCreateScript = async () => {
      const nameInput = document.getElementById("newScriptNameInput");
      const urlInput = document.getElementById("newScriptUrlInput");
      const fileInput = document.getElementById("newScriptFileInput");
      const btn = document.getElementById("createScriptBtn");

      const name = nameInput?.value.trim() || "";
      const loaderUrl = urlInput?.value.trim() || "";
      const fileObj = fileInput && fileInput.files ? fileInput.files[0] : null;

      if (!name) {
        showToast("Script adını daxil edin!");
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.textContent = "Yaradılır...";
      }

      let fileContent = "";
      let fileName = "";
      if (fileObj) {
        try {
          fileContent = await readFileAsText(fileObj);
          fileName = fileObj.name || "script.lua";
        } catch (err) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Script Yarat";
          }
          showToast("Dosya oxunmadı: " + err.message);
          return;
        }
      }

      const res = await callApi("/api/scripts", "POST", {
        name,
        loaderUrl,
        fileName,
        scriptContent: fileContent
      });

      if (btn) {
        btn.disabled = false;
        btn.textContent = "Script Yarat";
      }

      if (res.ok && res.data) {
        if (nameInput) nameInput.value = "";
        if (urlInput) urlInput.value = "";
        if (fileInput) fileInput.value = "";
        renderSnapshot(res.data);
        showToast("Script yaradıldı və Mövcud Scriptlərə əlavə edildi!");
      } else {
        showToast("Xəta: " + (res.error || "Script yaradılmadı"));
      }
    };

    window.updateScriptPrompt = (id, encName, encLoader) => {
      const currentName = decodeURIComponent(encName || "");
      const currentLoader = decodeURIComponent(encLoader || "");
      const editorBox = document.getElementById("inlineScriptEditBox");
      if (!editorBox) return;
      document.getElementById("editScriptIdHidden").value = id;
      document.getElementById("editScriptNameInput").value = currentName;
      document.getElementById("editScriptLoaderInput").value = currentLoader;
      const editFile = document.getElementById("editScriptFileInput");
      if (editFile) editFile.value = "";
      editorBox.style.display = "block";
      editorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    window.sadoSubmitInlineScriptEdit = async () => {
      const id = document.getElementById("editScriptIdHidden")?.value || "";
      const updatedName = document.getElementById("editScriptNameInput")?.value.trim() || "";
      const updatedLoader = document.getElementById("editScriptLoaderInput")?.value.trim() || "";
      const editFileInput = document.getElementById("editScriptFileInput");
      const fileObj = editFileInput && editFileInput.files ? editFileInput.files[0] : null;

      if (!id || !updatedName) {
        showToast("Script adını daxil edin!");
        return;
      }

      const payload = {
        name: updatedName,
        loaderUrl: updatedLoader
      };

      if (fileObj) {
        try {
          payload.scriptContent = await readFileAsText(fileObj);
          payload.fileName = fileObj.name || "script.lua";
        } catch (err) {
          showToast("Dosya oxunmadı: " + err.message);
          return;
        }
      }

      const res = await callApi("/api/scripts/" + id, "PUT", payload);
      if (res.data) renderSnapshot(res.data);
      const editorBox = document.getElementById("inlineScriptEditBox");
      if (editorBox) editorBox.style.display = "none";
      showToast(res.ok ? "Script yeniləndi!" : "Xəta: " + (res.error || "Yenilənmədi"));
    };

    window.sadoCancelInlineScriptEdit = () => {
      const editorBox = document.getElementById("inlineScriptEditBox");
      if (editorBox) editorBox.style.display = "none";
    };

    window.sadoSetActiveScript = async (scriptId) => {
      const res = await callApi("/api/scripts/" + scriptId + "/activate", "POST", {});
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Script aktiv panelə bağlandı!" : "Xəta: " + (res.error || "Bağlanmadı"));
    };

    window.sadoDeleteScript = async (scriptId) => {
      const res = await callApi("/api/scripts/" + scriptId, "DELETE");
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Script silindi!" : "Xəta: " + (res.error || "Silinmədi"));
    };

    window.sadoGenerateKey = async () => {
      const prefix = document.getElementById("keyPrefixInput")?.value.trim() || "SADO";
      const days = Number(document.getElementById("keyDaysInput")?.value || 30);
      const note = document.getElementById("keyNoteInput")?.value.trim() || "";
      const res = await callApi("/api/keys", "POST", { prefix, days, note });
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Yeni key yaradıldı!" : "Xəta: " + (res.error || "Key yaradılmadı"));
    };

    window.sadoResetKeyHwid = async (keyId) => {
      const res = await callApi("/api/keys/" + keyId + "/reset-hwid", "POST", {});
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "HWID sıfırlandı!" : "Xəta: " + (res.error || "Sıfırlanmadı"));
    };

    window.sadoDeleteKey = async (keyId) => {
      const res = await callApi("/api/keys/" + keyId, "DELETE");
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Key silindi!" : "Xəta: " + (res.error || "Silinmədi"));
    };

    window.sadoSaveDesign = async () => {
      const title = document.getElementById("designTitleInput")?.value.trim() || "SADO PROTECT";
      const color = document.getElementById("designColorInput")?.value.trim() || "#F59E0B";
      const description = document.getElementById("designDescInput")?.value.trim() || "";
      const footer = document.getElementById("designFooterInput")?.value.trim() || "SADO PROTECT";
      const buttons = CLIENT_STATE.draftButtons.map((b, idx) => ({
        ...b,
        order: idx
      }));

      const res = await callApi("/api/design", "POST", {
        title,
        color,
        description,
        footer,
        buttons
      });
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Panel və buton dizaynı yadda saxlanıldı!" : "Xəta: " + (res.error || "Saxlanmadı"));
    };

    window.sadoAddAccess = async (listType) => {
      const userId = document.getElementById("accessUserIdInput")?.value.trim() || "";
      const username = document.getElementById("accessUserNameInput")?.value.trim() || userId;
      if (!userId) {
        showToast("İstifadəçi ID daxil edin!");
        return;
      }
      const res = await callApi("/api/access/" + listType, "POST", {
        userId,
        username,
        reason: username
      });
      if (res.data) {
        document.getElementById("accessUserIdInput").value = "";
        document.getElementById("accessUserNameInput").value = "";
        renderSnapshot(res.data);
      }
      showToast(res.ok ? "Siyahıya əlavə edildi!" : "Xəta: " + (res.error || "Əlavə edilmədi"));
    };

    window.sadoRemoveAccess = async (listType, userId) => {
      const res = await callApi("/api/access/" + listType + "/" + userId, "DELETE");
      if (res.data) renderSnapshot(res.data);
      showToast(res.ok ? "Siyahıdan silindi!" : "Xəta: " + (res.error || "Silinmədi"));
    };

    window.sadoCopyText = async (txt) => {
      try {
        await navigator.clipboard.writeText(txt);
        showToast("Kopyalandı: " + txt);
      } catch (_e) {
        showToast(txt);
      }
    };

    document.addEventListener("DOMContentLoaded", () => {
      renderButtonDesignerList();
      loadInitialSnapshot();
    });
  </script>
</body>
</html>`;

const app = express();

const applyCorsHeaders = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
};

app.use(applyCorsHeaders);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.get("/", (_req, res) => {
  const htmlBuffer = Buffer.from(DASHBOARD_HTML, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Content-Length": htmlBuffer.length
  });
  res.end(htmlBuffer);
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "SADO PROTECT",
    botReady: true,
    gatewayReady: BOT_RUNTIME.gatewayReady,
    uptime: process.uptime()
  });
});

app.get("/api/state", async (_req, res) => {
  if (APP_STATE.bot.guildId && (!APP_STATE.bot.guildName || APP_STATE.bot.guildName.startsWith("Sunucu ("))) {
    await syncActiveGuildName(APP_STATE.bot.guildId);
  }
  res.status(200).json({
    ok: true,
    data: buildPublicSnapshot()
  });
});

app.post("/api/bot/connect", async (req, res) => {
  try {
    const guildId = String(req.body?.guildId || "").trim();
    const panelChannelId = String(req.body?.panelChannelId || "").trim();

    if (!guildId) {
      res.status(400).json({
        ok: false,
        error: "Sunucu ID boş ola bilməz",
        data: buildPublicSnapshot()
      });
      return;
    }

    const resolvedName = await syncActiveGuildName(guildId);
    if (panelChannelId) {
      APP_STATE.bot.panelChannelId = panelChannelId;
      savePersistentState();
      await deployOrRefreshDiscordPanel(panelChannelId, APP_STATE.bot.activeScriptId);
    }

    res.status(200).json({
      ok: true,
      guildName: resolvedName,
      data: buildPublicSnapshot()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Sunucu bağlanarkən xəta baş verdi",
      data: buildPublicSnapshot()
    });
  }
});

app.post("/api/scripts", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const loaderUrl = String(req.body?.loaderUrl || "").trim();
    const fileName = String(req.body?.fileName || "").trim();
    const scriptContent = String(req.body?.scriptContent || "");

    if (!name) {
      res.status(400).json({
        ok: false,
        error: "Script adı mütləqdir",
        data: buildPublicSnapshot()
      });
      return;
    }

    const sourceType = scriptContent.length > 0 || fileName.length > 0 ? "file" : "url";
    const newScript = {
      id: generateUniqueId("scr"),
      name,
      loaderUrl,
      sourceType,
      fileName: fileName || (sourceType === "file" ? `${name}.lua` : ""),
      scriptContent,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    APP_STATE.scripts.unshift(newScript);
    if (!APP_STATE.bot.activeScriptId) {
      APP_STATE.bot.activeScriptId = newScript.id;
    }
    savePersistentState();
    await registerSlashCommands();

    res.status(200).json({
      ok: true,
      script: newScript,
      data: buildPublicSnapshot()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Script yaradılarkən xəta baş verdi",
      data: buildPublicSnapshot()
    });
  }
});

app.put("/api/scripts/:id", async (req, res) => {
  try {
    const scriptId = String(req.params.id || "").trim();
    const target = APP_STATE.scripts.find((s) => s.id === scriptId);
    if (!target) {
      res.status(404).json({
        ok: false,
        error: "Script tapılmadı",
        data: buildPublicSnapshot()
      });
      return;
    }

    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      target.name = req.body.name.trim();
    }
    if (typeof req.body?.loaderUrl === "string") {
      target.loaderUrl = req.body.loaderUrl.trim();
    }
    if (typeof req.body?.scriptContent === "string" && req.body.scriptContent.length > 0) {
      target.scriptContent = req.body.scriptContent;
      target.sourceType = "file";
    }
    if (typeof req.body?.fileName === "string" && req.body.fileName.trim()) {
      target.fileName = req.body.fileName.trim();
      target.sourceType = "file";
    }
    target.updatedAt = new Date().toISOString();
    savePersistentState();

    if (APP_STATE.bot.activeScriptId === target.id && APP_STATE.bot.panelChannelId) {
      await deployOrRefreshDiscordPanel(APP_STATE.bot.panelChannelId, target.id);
    }

    res.status(200).json({
      ok: true,
      data: buildPublicSnapshot()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Script yenilənmədi",
      data: buildPublicSnapshot()
    });
  }
});

app.post("/api/scripts/:id/activate", async (req, res) => {
  try {
    const scriptId = String(req.params.id || "").trim();
    const target = APP_STATE.scripts.find((s) => s.id === scriptId);
    if (!target) {
      res.status(404).json({
        ok: false,
        error: "Script tapılmadı",
        data: buildPublicSnapshot()
      });
      return;
    }

    APP_STATE.bot.activeScriptId = target.id;
    savePersistentState();

    if (APP_STATE.bot.panelChannelId) {
      await deployOrRefreshDiscordPanel(APP_STATE.bot.panelChannelId, target.id);
    }

    res.status(200).json({
      ok: true,
      data: buildPublicSnapshot()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Script panelə bağlanmadı",
      data: buildPublicSnapshot()
    });
  }
});

app.delete("/api/scripts/:id", async (req, res) => {
  try {
    const scriptId = String(req.params.id || "").trim();
    APP_STATE.scripts = APP_STATE.scripts.filter((s) => s.id !== scriptId);
    if (APP_STATE.bot.activeScriptId === scriptId) {
      APP_STATE.bot.activeScriptId = APP_STATE.scripts[0] ? APP_STATE.scripts[0].id : "";
    }
    savePersistentState();
    await registerSlashCommands();
    res.status(200).json({
      ok: true,
      data: buildPublicSnapshot()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Script silinmədi",
      data: buildPublicSnapshot()
    });
  }
});

app.get("/raw/:id", (req, res) => {
  const scriptId = String(req.params.id || "").trim();
  const found = APP_STATE.scripts.find((s) => s.id === scriptId);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (!found) {
    res.status(404).send('-- SADO PROTECT: Script tapilmadi');
    return;
  }
  if (found.scriptContent && found.scriptContent.trim().length > 0) {
    res.status(200).send(found.scriptContent);
    return;
  }
  if (found.loaderUrl && found.loaderUrl.trim().length > 0) {
    res.status(200).send(`loadstring(game:HttpGet("${found.loaderUrl.trim()}"))()`);
    return;
  }
  res.status(200).send(`-- SADO PROTECT: ${found.name} hazirdir`);
});

app.post("/api/keys", (req, res) => {
  const prefix = String(req.body?.prefix || "SADO").trim();
  const days = Math.max(0, Number(req.body?.days || 30));
  const note = String(req.body?.note || "").trim();
  const expiresAt =
    days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

  const created = {
    id: generateUniqueId("key"),
    key: generateLicenseKeyString(prefix),
    days,
    expiresAt,
    note,
    claimedBy: "",
    claimedTag: "",
    hwid: "",
    active: true,
    createdAt: new Date().toISOString()
  };

  APP_STATE.keys.unshift(created);
  savePersistentState();

  res.status(200).json({
    ok: true,
    key: created,
    data: buildPublicSnapshot()
  });
});

app.post("/api/keys/:id/reset-hwid", (req, res) => {
  const keyId = String(req.params.id || "").trim();
  const found = APP_STATE.keys.find((k) => k.id === keyId);
  if (!found) {
    res.status(404).json({
      ok: false,
      error: "Key tapılmadı",
      data: buildPublicSnapshot()
    });
    return;
  }
  found.hwid = "";
  savePersistentState();
  res.status(200).json({
    ok: true,
    data: buildPublicSnapshot()
  });
});

app.delete("/api/keys/:id", (req, res) => {
  const keyId = String(req.params.id || "").trim();
  APP_STATE.keys = APP_STATE.keys.filter((k) => k.id !== keyId);
  savePersistentState();
  res.status(200).json({
    ok: true,
    data: buildPublicSnapshot()
  });
});

app.post("/api/design", async (req, res) => {
  try {
    const title = String(req.body?.title || APP_STATE.design.title).trim().slice(0, 200);
    const color = sanitizeHexColor(req.body?.color || APP_STATE.design.color);
    const description = String(req.body?.description ?? APP_STATE.design.description).slice(0, 3500);
    const footer = String(req.body?.footer ?? APP_STATE.design.footer).slice(0, 500);
    const buttons = normalizeButtonList(req.body?.buttons);

    APP_STATE.design = {
      ...APP_STATE.design,
      title: title || APP_CONFIG.DEFAULT_TITLE,
      color,
      description,
      footer: footer || APP_CONFIG.DEFAULT_FOOTER,
      buttons
    };
    savePersistentState();

    if (APP_STATE.bot.panelChannelId) {
      await deployOrRefreshDiscordPanel(APP_STATE.bot.panelChannelId, APP_STATE.bot.activeScriptId);
    }

    res.status(200).json({
      ok: true,
      data: buildPublicSnapshot()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Dizayn yadda saxlanmadı",
      data: buildPublicSnapshot()
    });
  }
});

app.post("/api/access/:type", (req, res) => {
  const listType = req.params.type === "blacklist" ? "blacklist" : "whitelist";
  const userId = String(req.body?.userId || "").trim();
  const username = String(req.body?.username || userId).trim();
  const reason = String(req.body?.reason || "Admin tərəfindən əlavə edildi").trim();

  if (!userId) {
    res.status(400).json({
      ok: false,
      error: "İstifadəçi ID daxil edilməlidir",
      data: buildPublicSnapshot()
    });
    return;
  }

  if (listType === "whitelist") {
    APP_STATE.whitelist = APP_STATE.whitelist.filter((u) => u.userId !== userId);
    APP_STATE.blacklist = APP_STATE.blacklist.filter((u) => u.userId !== userId);
    APP_STATE.whitelist.unshift({
      id: generateUniqueId("wl"),
      userId,
      username,
      addedAt: new Date().toISOString()
    });
  } else {
    APP_STATE.blacklist = APP_STATE.blacklist.filter((u) => u.userId !== userId);
    APP_STATE.whitelist = APP_STATE.whitelist.filter((u) => u.userId !== userId);
    APP_STATE.blacklist.unshift({
      id: generateUniqueId("bl"),
      userId,
      username,
      reason,
      addedAt: new Date().toISOString()
    });
  }

  savePersistentState();
  res.status(200).json({
    ok: true,
    data: buildPublicSnapshot()
  });
});

app.delete("/api/access/:type/:userId", (req, res) => {
  const listType = req.params.type === "blacklist" ? "blacklist" : "whitelist";
  const userId = String(req.params.userId || "").trim();
  if (listType === "whitelist") {
    APP_STATE.whitelist = APP_STATE.whitelist.filter((u) => u.userId !== userId);
  } else {
    APP_STATE.blacklist = APP_STATE.blacklist.filter((u) => u.userId !== userId);
  }
  savePersistentState();
  res.status(200).json({
    ok: true,
    data: buildPublicSnapshot()
  });
});

app.listen(APP_CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[SADO_PROTECT_SERVER] Listening on port ${APP_CONFIG.PORT}`);
  startDiscordBot();
  registerSlashCommands().catch(() => null);
});
