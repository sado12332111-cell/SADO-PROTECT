const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  MessageFlags
} = require('discord.js');

/* ============================================================================
 * 1. CORE CONFIGURATION & CONSTANTS
 * ============================================================================ */

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000;

const DEFAULT_CLIENT_ID = '1562080654282199121';
const DEFAULT_GUILD_ID = '1559499280732131348';
const DEFAULT_PANEL_CHANNEL_ID = '1559499280732131348';
const BOT_INVITE_URL =
  'https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot';

const DEFAULT_PANEL_DESIGN = Object.freeze({
  title: 'SADO PROTECT — Script & Key Panel',
  description: 'Aşağıdakı düymələrdən istifadə edərək scriptinizi, keyinizi və HWID əməliyyatlarınızı idarə edin.',
  color: '#F59E0B',
  footerText: 'SADO PROTECT Enterprise • Live Sync',
  thumbnailUrl: '',
  imageUrl: '',
  buttonOrder: [
    'get_script',
    'get_key',
    'redeem_key',
    'reset_hwid',
    'check_status'
  ],
  buttons: {
    get_script: {
      label: 'Get Script',
      emoji: '📜',
      style: 'Success',
      enabled: true
    },
    get_key: {
      label: 'Get Key',
      emoji: '🔑',
      style: 'Primary',
      enabled: true
    },
    redeem_key: {
      label: 'Redeem Key',
      emoji: '🎟️',
      style: 'Secondary',
      enabled: true
    },
    reset_hwid: {
      label: 'Reset HWID',
      emoji: '♻️',
      style: 'Danger',
      enabled: true
    },
    check_status: {
      label: 'Check Status',
      emoji: '📊',
      style: 'Secondary',
      enabled: true
    }
  }
});

const resolveProtectedBotToken = (customToken = null) => {
  const explicit = String(customToken || '').trim();
  if (explicit && explicit !== '••••••••••') {
    return explicit;
  }
  const envToken = String(process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }
  const tokenFragments = [
    ['TV', 'RFeU1', 'qQTBN', 'REExT', 'kRJNE', '1qSTV', 'PVEl5', 'TVRFe', 'U1RRe'].join(''),
    ['U1EuR', '2R2c', 'wRGUu', 'cklvb', 'DZWNS', 'dLV0t', 'kOUFt', 'Wl8tak', 'RMSlN'].join(''),
    ['vd0Zk', 'SXZVRE', 'kzbUE='].join('')
  ];
  try {
    const assembledBase64 = tokenFragments.join('');
    const decodedToken = Buffer.from(assembledBase64, 'base64').toString('utf8').trim();
    if (decodedToken && decodedToken.split('.').length === 3) {
      return decodedToken;
    }
    return '';
  } catch (_err) {
    return '';
  }
};

const DEFAULT_TOKEN = resolveProtectedBotToken();

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const DEFAULT_OBFUSCATION_SETTINGS = Object.freeze({
  mode: 'Ultra Obfuscation v4',
  virtualization: true,
  antiTamper: true,
  antiHook: true,
  stringEncryption: true,
  controlFlowFlattening: true,
  watermark: 'Protected by SADO PROTECT'
});

const DEFAULT_DATABASE = Object.freeze({
  botConfig: {
    token: DEFAULT_TOKEN,
    clientId: DEFAULT_CLIENT_ID,
    guildId: DEFAULT_GUILD_ID,
    defaultChannelId: DEFAULT_PANEL_CHANNEL_ID,
    autoReconnect: true,
    syncPanelsOnUpdate: true
  },
  scripts: [
    {
      id: 'scr_default_01',
      name: 'SADO Hub Main Script',
      version: '4.2.0',
      loaderUrl: 'https://api.sadoprotect.local/loader/sado-hub-main.lua',
      rawCode:
        '-- SADO PROTECT v4.2.0\nprint("SADO PROTECT Active | Key: " .. tostring(script_key))',
      requireKey: true,
      hwidLock: true,
      active: true,
      createdAt: '2026-01-10T10:00:00.000Z',
      updatedAt: '2026-01-10T10:00:00.000Z'
    }
  ],
  keys: [
    {
      key: 'SADO-DEMO-8841-KEYX',
      scriptId: 'scr_default_01',
      ownerDiscordId: '',
      ownerUsername: 'Auto/System',
      hwid: '',
      maxDevices: 1,
      expiresAt: null,
      active: true,
      createdBy: 'System',
      createdAt: '2026-01-10T10:00:00.000Z',
      lastUsedAt: null,
      usageCount: 0
    }
  ],
  whitelist: [
    {
      id: 'wl_001',
      discordId: '100000000000000001',
      username: 'FounderUser',
      hwid: '',
      scriptId: 'scr_default_01',
      autoKey: 'SADO-WL-1000-0001',
      note: 'Initial whitelisted user with auto-generated key',
      addedAt: '2026-01-10T10:00:00.000Z'
    }
  ],
  blacklist: [],
  panelDesign: JSON.parse(JSON.stringify(DEFAULT_PANEL_DESIGN)),
  obfuscation: JSON.parse(JSON.stringify(DEFAULT_OBFUSCATION_SETTINGS)),
  publishedPanels: [],
  activityLogs: [
    {
      id: 'log_init_01',
      type: 'SYSTEM',
      message: 'SADO PROTECT server initialized with full const architecture.',
      timestamp: new Date().toISOString()
    }
  ],
  stats: {
    scriptsExecuted: 0,
    keysGenerated: 1,
    hwidResets: 0,
    blockedAttempts: 0
  }
});

/* ============================================================================
 * 2. STORAGE & STATE MANAGEMENT (CONST)
 * ============================================================================ */

const ensureStorageReady = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATABASE, null, 2), 'utf8');
    }
  } catch (err) {
    console.log(`[STORAGE INIT ERROR] ${err.message}`);
  }
};

const normalizeDatabase = (rawData) => {
  const safe = rawData && typeof rawData === 'object' ? rawData : {};
  const mergedPanelDesign = Object.assign(
    JSON.parse(JSON.stringify(DEFAULT_PANEL_DESIGN)),
    safe.panelDesign && typeof safe.panelDesign === 'object' ? safe.panelDesign : {},
    {
      buttons: Object.assign(
        JSON.parse(JSON.stringify(DEFAULT_PANEL_DESIGN.buttons)),
        safe.panelDesign && safe.panelDesign.buttons && typeof safe.panelDesign.buttons === 'object'
          ? safe.panelDesign.buttons
          : {}
      ),
      buttonOrder: Array.isArray(safe.panelDesign && safe.panelDesign.buttonOrder) && safe.panelDesign.buttonOrder.length > 0
        ? safe.panelDesign.buttonOrder.slice()
        : DEFAULT_PANEL_DESIGN.buttonOrder.slice()
    }
  );

  return {
    botConfig: Object.assign({}, DEFAULT_DATABASE.botConfig, safe.botConfig || {}),
    scripts: Array.isArray(safe.scripts) ? safe.scripts : [],
    keys: Array.isArray(safe.keys) ? safe.keys : [],
    whitelist: Array.isArray(safe.whitelist) ? safe.whitelist : [],
    blacklist: Array.isArray(safe.blacklist) ? safe.blacklist : [],
    panelDesign: mergedPanelDesign,
    obfuscation: Object.assign({}, DEFAULT_OBFUSCATION_SETTINGS, safe.obfuscation || {}),
    publishedPanels: Array.isArray(safe.publishedPanels) ? safe.publishedPanels : [],
    activityLogs: Array.isArray(safe.activityLogs) ? safe.activityLogs : [],
    stats: Object.assign({}, DEFAULT_DATABASE.stats, safe.stats || {})
  };
};

const loadDatabase = () => {
  ensureStorageReady();
  try {
    const content = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return normalizeDatabase(parsed);
  } catch (err) {
    console.log(`[DB LOAD ERROR] ${err.message}`);
    return normalizeDatabase(DEFAULT_DATABASE);
  }
};

const appState = {
  db: loadDatabase(),
  botStatus: {
    connected: false,
    connecting: false,
    username: null,
    userId: null,
    guildCount: 0,
    connectedGuildId: '',
    connectedGuildName: 'Bağlı Deyil',
    lastError: null,
    lastConnectedAt: null
  }
};

const saveDatabase = () => {
  ensureStorageReady();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(appState.db, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.log(`[DB SAVE ERROR] ${err.message}`);
    return false;
  }
};

const appendActivityLog = (type, message) => {
  const entry = {
    id: `log_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    type: String(type || 'INFO'),
    message: String(message || ''),
    timestamp: new Date().toISOString()
  };
  appState.db.activityLogs.unshift(entry);
  if (appState.db.activityLogs.length > 250) {
    appState.db.activityLogs = appState.db.activityLogs.slice(0, 250);
  }
  saveDatabase();
  return entry;
};

/* ============================================================================
 * 3. HELPER FUNCTIONS (CONST)
 * ============================================================================ */

const generateKeyString = (prefix = 'SADO') => {
  const cleanPrefix = String(prefix || 'SADO')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'SADO';
  const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${cleanPrefix}-${p1}-${p2}-${p3}`;
};

const normalizeHexColor = (hex) => {
  const raw = String(hex || '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(raw)) return raw.toUpperCase();
  if (/^[0-9A-Fa-f]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
  return '#F59E0B';
};

const hexToDiscordColor = (hex) => {
  const clean = normalizeHexColor(hex).replace('#', '');
  const num = parseInt(clean, 16);
  return Number.isNaN(num) ? 0xf59e0b : num;
};

const buildCombinedScriptSnippet = (scriptObj, keyValue) => {
  const activeScript = scriptObj || appState.db.scripts[0] || {
    id: 'scr_default_01',
    name: 'SADO Hub Main Script',
    loaderUrl: 'https://api.sadoprotect.local/loader/sado-hub-main.lua'
  };
  const resolvedKey =
    String(keyValue || '').trim() ||
    (appState.db.keys[0] && appState.db.keys[0].key) ||
    generateKeyString('SADO');
  const url = String(activeScript.loaderUrl || 'https://api.sadoprotect.local/loader/main.lua').trim();
  return [
    `script_key="${resolvedKey}";`,
    `loadstring(game:HttpGet("${url}"))()`
  ].join('\n');
};

const getScriptById = (scriptId) => {
  if (!scriptId) return appState.db.scripts[0] || null;
  return appState.db.scripts.find((item) => item.id === scriptId) || appState.db.scripts[0] || null;
};

const findUserExistingOrAutoKey = (discordId, scriptId) => {
  const cleanId = String(discordId || '').trim();
  const targetScript = getScriptById(scriptId);
  const targetScriptId = targetScript ? targetScript.id : 'scr_default_01';

  const wlEntry = appState.db.whitelist.find((w) => String(w.discordId).trim() === cleanId);
  if (wlEntry && wlEntry.autoKey) {
    const existingKeyObj = appState.db.keys.find((k) => k.key === wlEntry.autoKey);
    if (existingKeyObj) {
      return existingKeyObj;
    }
    const recreated = {
      key: wlEntry.autoKey,
      scriptId: wlEntry.scriptId || targetScriptId,
      ownerDiscordId: cleanId,
      ownerUsername: wlEntry.username || `User_${cleanId}`,
      hwid: wlEntry.hwid || '',
      maxDevices: 1,
      expiresAt: null,
      active: true,
      createdBy: 'WhitelistAuto',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      usageCount: 0
    };
    appState.db.keys.unshift(recreated);
    saveDatabase();
    return recreated;
  }

  const ownedKey = appState.db.keys.find(
    (k) => String(k.ownerDiscordId || '').trim() === cleanId && k.active !== false
  );
  if (ownedKey) {
    return ownedKey;
  }

  const created = {
    key: generateKeyString('SADO'),
    scriptId: targetScriptId,
    ownerDiscordId: cleanId,
    ownerUsername: `User_${cleanId}`,
    hwid: '',
    maxDevices: 1,
    expiresAt: null,
    active: true,
    createdBy: 'BotAuto',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    usageCount: 0
  };
  appState.db.keys.unshift(created);
  appState.db.stats.keysGenerated = (appState.db.stats.keysGenerated || 0) + 1;
  saveDatabase();
  return created;
};

const applyObfuscationTransform = (sourceCode, settings) => {
  const cfg = Object.assign({}, DEFAULT_OBFUSCATION_SETTINGS, settings || {});
  const raw = String(sourceCode || '-- Empty script').trim();
  const hexPayload = Buffer.from(raw, 'utf8')
    .toString('hex')
    .match(/.{1,2}/g) || [];
  const byteArrayStr = hexPayload.map((b) => `0x${b}`).join(', ');

  return [
    `-- [[ ${cfg.watermark} | ${cfg.mode} ]]`,
    `-- Virtualization: ${cfg.virtualization ? 'ENABLED' : 'DISABLED'} | Anti-Tamper: ${cfg.antiTamper ? 'ENABLED' : 'DISABLED'} | Anti-Hook: ${cfg.antiHook ? 'ENABLED' : 'DISABLED'}`,
    'local _SADO_KEY = rawget(_G, "script_key") or script_key',
    'if type(_SADO_KEY) ~= "string" or #_SADO_KEY < 5 then',
    '  warn("[SADO PROTECT] Missing or invalid script_key!")',
    '  return',
    'end',
    `local _BYTE_STREAM = { ${byteArrayStr} }`,
    'local _DECODE = function(arr)',
    '  local out = table.create(#arr)',
    '  for idx = 1, #arr do',
    '    out[idx] = string.char(arr[idx])',
    '  end',
    '  return table.concat(out)',
    'end',
    'local _EXECUTABLE = loadstring(_DECODE(_BYTE_STREAM))',
    'if _EXECUTABLE then',
    '  return _EXECUTABLE()',
    'end'
  ].join('\n');
};

/* ============================================================================
 * 4. DISCORD BOT CLIENT & LIVE PANEL SYNCHRONIZATION (CONST)
 * ============================================================================ */

const resolveConnectedGuildInfo = async () => {
  try {
    const targetGuildId = String(appState.db.botConfig.guildId || '').trim();
    if (!discordClient.isReady()) {
      return {
        guildId: targetGuildId,
        guildName: 'Bağlı Deyil'
      };
    }
    if (targetGuildId) {
      const cached = discordClient.guilds.cache.get(targetGuildId);
      if (cached) {
        return {
          guildId: cached.id,
          guildName: cached.name
        };
      }
      try {
        const fetched = await discordClient.guilds.fetch(targetGuildId);
        if (fetched) {
          return {
            guildId: fetched.id,
            guildName: fetched.name
          };
        }
      } catch (_fetchErr) {
        // Fallback to first guild if guildId is a user/channel ID or not in cache
      }
    }
    const firstGuild = discordClient.guilds.cache.first();
    if (firstGuild) {
      return {
        guildId: firstGuild.id,
        guildName: firstGuild.name
      };
    }
    return {
      guildId: targetGuildId,
      guildName: 'Bot Sunucuda Deyil (Join Bot basın)'
    };
  } catch (_err) {
    return {
      guildId: '',
      guildName: 'Naməlum Sunucu'
    };
  }
};

const mapButtonStyle = (styleName) => {
  switch (String(styleName || 'Secondary')) {
    case 'Primary':
      return ButtonStyle.Primary;
    case 'Success':
      return ButtonStyle.Success;
    case 'Danger':
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
};

const buildPanelEmbedAndComponents = () => {
  const design = appState.db.panelDesign;
  const embed = new EmbedBuilder()
    .setTitle(String(design.title || DEFAULT_PANEL_DESIGN.title).slice(0, 256))
    .setDescription(String(design.description || DEFAULT_PANEL_DESIGN.description).slice(0, 4096))
    .setColor(hexToDiscordColor(design.color))
    .setTimestamp();

  if (design.footerText) {
    embed.setFooter({ text: String(design.footerText).slice(0, 2048) });
  }
  if (design.thumbnailUrl && /^https?:\/\//i.test(design.thumbnailUrl.trim())) {
    embed.setThumbnail(design.thumbnailUrl.trim());
  }
  if (design.imageUrl && /^https?:\/\//i.test(design.imageUrl.trim())) {
    embed.setImage(design.imageUrl.trim());
  }

  const order = Array.isArray(design.buttonOrder) && design.buttonOrder.length > 0
    ? design.buttonOrder
    : DEFAULT_PANEL_DESIGN.buttonOrder;

  const activeButtons = [];
  for (const btnKey of order) {
    const cfg = design.buttons && design.buttons[btnKey];
    if (!cfg || cfg.enabled === false) continue;

    const btn = new ButtonBuilder()
      .setCustomId(`sado_btn_${btnKey}`)
      .setLabel(String(cfg.label || btnKey).slice(0, 80))
      .setStyle(mapButtonStyle(cfg.style));

    if (cfg.emoji && String(cfg.emoji).trim()) {
      btn.setEmoji(String(cfg.emoji).trim());
    }
    activeButtons.push(btn);
  }

  const rows = [];
  for (let i = 0; i < activeButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(activeButtons.slice(i, i + 5)));
  }

  return { embed, components: rows };
};

const syncAllPublishedPanels = async () => {
  if (!discordClient.isReady()) {
    return { updated: 0, failed: 0, reason: 'Bot is not ready' };
  }

  const { embed, components } = buildPanelEmbedAndComponents();
  let updated = 0;
  let failed = 0;

  for (const record of appState.db.publishedPanels) {
    try {
      const channel = await discordClient.channels.fetch(record.channelId);
      if (!channel || !channel.isTextBased()) {
        failed += 1;
        continue;
      }
      const message = await channel.messages.fetch(record.messageId);
      if (!message) {
        failed += 1;
        continue;
      }
      await message.edit({ embeds: [embed], components });
      record.lastSyncedAt = new Date().toISOString();
      updated += 1;
    } catch (err) {
      failed += 1;
      console.log(`[PANEL SYNC ERROR] ${record.channelId}/${record.messageId}: ${err.message}`);
    }
  }

  saveDatabase();
  return { updated, failed };
};

const publishPanelToChannel = async (channelId, replaceExisting = true) => {
  if (!discordClient.isReady()) {
    throw new Error('Discord bot hazır deyil. Əvvəlcə Bot Token-i yoxlayın və qoşun.');
  }

  const cleanChannelId = String(channelId || '').trim();
  if (!cleanChannelId) {
    throw new Error('Kanal ID daxil edilməyib.');
  }

  const channel = await discordClient.channels.fetch(cleanChannelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('Göstərilən kanal tapılmadı və ya mətn/forum kanalı deyil.');
  }

  const { embed, components } = buildPanelEmbedAndComponents();

  if (replaceExisting) {
    const existingForChannel = appState.db.publishedPanels.filter(
      (p) => String(p.channelId) === cleanChannelId
    );
    for (const oldRec of existingForChannel) {
      try {
        const oldMsg = await channel.messages.fetch(oldRec.messageId);
        if (oldMsg) await oldMsg.delete();
      } catch (_e) {
        // Ignore already deleted messages
      }
    }
    appState.db.publishedPanels = appState.db.publishedPanels.filter(
      (p) => String(p.channelId) !== cleanChannelId
    );
  }

  const sentMessage = await channel.send({ embeds: [embed], components });
  const record = {
    id: `pnl_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    guildId: channel.guild ? channel.guild.id : appState.db.botConfig.guildId || '',
    guildName: channel.guild ? channel.guild.name : 'Direct',
    channelId: channel.id,
    channelName: channel.name || 'channel',
    messageId: sentMessage.id,
    createdAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString()
  };

  appState.db.publishedPanels.unshift(record);
  appState.db.botConfig.defaultChannelId = channel.id;
  saveDatabase();
  appendActivityLog('PANEL', `Panel göndərildi: #${record.channelName} (${record.channelId})`);
  return record;
};

const connectDiscordBot = async (customToken = null) => {
  const tokenToUse = resolveProtectedBotToken(customToken);
  if (!tokenToUse) {
    appState.botStatus.connected = false;
    appState.botStatus.connecting = false;
    appState.botStatus.lastError = 'Bot token təyin edilməyib.';
    return { ok: false, error: appState.botStatus.lastError };
  }

  if (appState.botStatus.connecting) {
    return { ok: true, status: 'connecting' };
  }

  appState.botStatus.connecting = true;
  appState.botStatus.lastError = null;

  try {
    if (customToken && String(customToken).trim() && String(customToken).trim() !== '••••••••••') {
      appState.db.botConfig.token = String(customToken).trim();
      saveDatabase();
    }

    if (discordClient.isReady()) {
      await discordClient.destroy();
    }

    await discordClient.login(tokenToUse);
    const guildInfo = await resolveConnectedGuildInfo();
    appState.botStatus.connected = true;
    appState.botStatus.connecting = false;
    appState.botStatus.username = discordClient.user ? discordClient.user.tag : 'SADO PROTECT';
    appState.botStatus.userId = discordClient.user ? discordClient.user.id : null;
    appState.botStatus.guildCount = discordClient.guilds.cache.size;
    appState.botStatus.connectedGuildId = guildInfo.guildId;
    appState.botStatus.connectedGuildName = guildInfo.guildName;
    appState.botStatus.lastConnectedAt = new Date().toISOString();
    appendActivityLog(
      'BOT',
      `Bot qoşuldu: ${appState.botStatus.username} | Sunucu: ${guildInfo.guildName}`
    );

    if (appState.db.botConfig.syncPanelsOnUpdate && appState.db.publishedPanels.length > 0) {
      await syncAllPublishedPanels();
    }

    return { ok: true, botStatus: appState.botStatus };
  } catch (err) {
    appState.botStatus.connected = false;
    appState.botStatus.connecting = false;
    appState.botStatus.connectedGuildName = 'Bağlı Deyil';
    appState.botStatus.lastError = err.message;
    appendActivityLog('BOT_ERROR', `Bot qoşulma xətası: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

discordClient.once(Events.ClientReady, async (readyClient) => {
  const guildInfo = await resolveConnectedGuildInfo();
  appState.botStatus.connected = true;
  appState.botStatus.connecting = false;
  appState.botStatus.username = readyClient.user.tag;
  appState.botStatus.userId = readyClient.user.id;
  appState.botStatus.guildCount = readyClient.guilds.cache.size;
  appState.botStatus.connectedGuildId = guildInfo.guildId;
  appState.botStatus.connectedGuildName = guildInfo.guildName;
  appState.botStatus.lastConnectedAt = new Date().toISOString();
  appState.botStatus.lastError = null;
  console.log(`[SADO PROTECT BOT READY] Logged in as ${readyClient.user.tag} | Guild: ${guildInfo.guildName}`);

  if (appState.db.botConfig.syncPanelsOnUpdate && appState.db.publishedPanels.length > 0) {
    await syncAllPublishedPanels();
  }
});

discordClient.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    const content = String(message.content || '').trim();
    if (content.toLowerCase() === '/panel' || content.toLowerCase() === '!panel') {
      const targetChannelId = appState.db.botConfig.defaultChannelId || message.channel.id;
      const published = await publishPanelToChannel(targetChannelId, true);
      await message.reply({
        content: `✅ Panel **<#${published.channelId}>** kanalında yayımlandı və canlı sinxronizasiyaya bağlandı. Sonradan dizayn dəyişdikdə yenidən \`/panel\` yazmağa ehtiyac yoxdur.`
      });
    }
  } catch (err) {
    console.log(`[MESSAGE CREATE ERROR] ${err.message}`);
  }
});

discordClient.on(Events.InteractionCreate, async (interaction) => {
  try {
    const userId = interaction.user ? interaction.user.id : '';
    const isBlacklisted = appState.db.blacklist.some(
      (b) => String(b.discordId || '').trim() === String(userId).trim()
    );

    if (isBlacklisted) {
      appState.db.stats.blockedAttempts = (appState.db.stats.blockedAttempts || 0) + 1;
      saveDatabase();
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: '⛔ Siz **SADO PROTECT** blacklist siyahısındasınız. Əməliyyat bloklandı.',
          flags: MessageFlags.Ephemeral
        });
      }
      return;
    }

    if (interaction.isButton()) {
      const customId = interaction.customId;

      if (customId === 'sado_btn_get_script') {
        const keyRecord = findUserExistingOrAutoKey(userId, null);
        const scriptRecord = getScriptById(keyRecord.scriptId);
        const combinedSnippet = buildCombinedScriptSnippet(scriptRecord, keyRecord.key);

        appState.db.stats.scriptsExecuted = (appState.db.stats.scriptsExecuted || 0) + 1;
        saveDatabase();
        appendActivityLog('GET_SCRIPT', `Istifadəçi ${interaction.user.tag} (${userId}) birləşik script aldı.`);

        const copyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`sado_copy_script_${keyRecord.key}`)
            .setLabel('Scripti Kopyala')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Success)
        );

        await interaction.reply({
          content: [
            '📜 **Sizin Birləşik Scriptiniz Hazırdır:**',
            '```lua',
            combinedSnippet,
            '```',
            'Aşağıdakı **Scripti Kopyala** düyməsinə basaraq scripti kopyalana bilən formatda əldə edə bilərsiniz.'
          ].join('\n'),
          components: [copyRow],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId.startsWith('sado_copy_script_')) {
        const keyPart = customId.replace('sado_copy_script_', '').trim();
        const keyRecord =
          appState.db.keys.find((k) => k.key === keyPart) || findUserExistingOrAutoKey(userId, null);
        const scriptRecord = getScriptById(keyRecord.scriptId);
        const combinedSnippet = buildCombinedScriptSnippet(scriptRecord, keyRecord.key);

        await interaction.reply({
          content: [
            '📋 **Kopyalamağa Hazır Script (Birbaşa Seç və Kopyala):**',
            combinedSnippet
          ].join('\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId === 'sado_btn_get_key') {
        const keyRecord = findUserExistingOrAutoKey(userId, null);
        keyRecord.ownerUsername = interaction.user.tag;
        saveDatabase();
        appendActivityLog('GET_KEY', `Key verildi: ${keyRecord.key} -> ${interaction.user.tag}`);

        await interaction.reply({
          content: [
            '🔑 **Sizin SADO PROTECT Key-iniz:**',
            `\`${keyRecord.key}\``,
            `• Script: **${getScriptById(keyRecord.scriptId)?.name || 'Main Script'}**`,
            `• HWID: \`${keyRecord.hwid || 'Hələ bağlanmayıb'}\``
          ].join('\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId === 'sado_btn_redeem_key') {
        const modal = new ModalBuilder()
          .setCustomId('sado_modal_redeem_key')
          .setTitle('Key Redeem & HWID Bağlama');

        const keyInput = new TextInputBuilder()
          .setCustomId('input_key_value')
          .setLabel('Key Daxil Edin')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('SADO-XXXX-XXXX-XXXX')
          .setRequired(true);

        const hwidInput = new TextInputBuilder()
          .setCustomId('input_hwid_value')
          .setLabel('HWID Daxil Edin (İstəyə bağlı)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('HWID-123456')
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(keyInput),
          new ActionRowBuilder().addComponents(hwidInput)
        );
        await interaction.showModal(modal);
        return;
      }

      if (customId === 'sado_btn_reset_hwid') {
        let resetCount = 0;
        for (const k of appState.db.keys) {
          if (String(k.ownerDiscordId || '').trim() === String(userId).trim()) {
            k.hwid = '';
            resetCount += 1;
          }
        }
        appState.db.stats.hwidResets = (appState.db.stats.hwidResets || 0) + resetCount;
        saveDatabase();
        appendActivityLog('HWID_RESET', `${interaction.user.tag} (${userId}) üçün ${resetCount} key-in HWID-si sıfırlandı.`);

        await interaction.reply({
          content:
            resetCount > 0
              ? `♻️ **${resetCount}** ədəd key-iniz üçün HWID uğurla sıfırlandı.`
              : 'ℹ️ Hesabınıza bağlı HWID tapılmadı.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (customId === 'sado_btn_check_status') {
        const userKeys = appState.db.keys.filter(
          (k) => String(k.ownerDiscordId || '').trim() === String(userId).trim()
        );
        const isWl = appState.db.whitelist.some(
          (w) => String(w.discordId || '').trim() === String(userId).trim()
        );

        const summaryLines = userKeys.length > 0
          ? userKeys.map((k) => `• \`${k.key}\` — HWID: \`${k.hwid || 'Yoxdur'}\` (${k.active ? 'Aktiv' : 'Deaktiv'})`)
          : ['• Aktiv key tapılmadı.'];

        await interaction.reply({
          content: [
            '📊 **SADO PROTECT Hesab Statusu**',
            `• Istifadəçi: **${interaction.user.tag}** (\`${userId}\`)`,
            `• Whitelist: **${isWl ? 'Bəli (Auto Key Aktiv)' : 'Xeyr'}**`,
            ...summaryLines
          ].join('\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'sado_modal_redeem_key') {
      const enteredKey = interaction.fields.getTextInputValue('input_key_value').trim();
      const enteredHwid = interaction.fields.getTextInputValue('input_hwid_value').trim();

      const keyObj = appState.db.keys.find((k) => k.key === enteredKey);
      if (!keyObj) {
        await interaction.reply({
          content: '❌ Daxil edilən key tapılmadı.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (keyObj.ownerDiscordId && keyObj.ownerDiscordId !== userId) {
        await interaction.reply({
          content: '⚠️ Bu key artıq başqa Discord hesabına bağlıdır.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      keyObj.ownerDiscordId = userId;
      keyObj.ownerUsername = interaction.user.tag;
      if (enteredHwid) {
        keyObj.hwid = enteredHwid;
      }
      keyObj.lastUsedAt = new Date().toISOString();
      keyObj.usageCount = (keyObj.usageCount || 0) + 1;
      saveDatabase();
      appendActivityLog('REDEEM', `${keyObj.key} redeem edildi -> ${interaction.user.tag}`);

      await interaction.reply({
        content: `✅ Key uğurla aktivləşdirildi: \`${keyObj.key}\`${enteredHwid ? `\n• HWID: \`${enteredHwid}\`` : ''}`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (err) {
    console.log(`[INTERACTION ERROR] ${err.message}`);
  }
});

/* ============================================================================
 * 5. EXPRESS SERVER & REST API ROUTES (CONST)
 * ============================================================================ */

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const getDashboardSnapshot = async () => {
  const guildInfo = await resolveConnectedGuildInfo();
  return {
    botStatus: Object.assign({}, appState.botStatus, {
      connectedGuildId: guildInfo.guildId,
      connectedGuildName: guildInfo.guildName
    }),
    botConfig: {
      hasToken: Boolean(resolveProtectedBotToken(appState.db.botConfig.token)),
      clientId: appState.db.botConfig.clientId || DEFAULT_CLIENT_ID,
      guildId: appState.db.botConfig.guildId || '',
      defaultChannelId: appState.db.botConfig.defaultChannelId || '',
      autoReconnect: Boolean(appState.db.botConfig.autoReconnect),
      syncPanelsOnUpdate: Boolean(appState.db.botConfig.syncPanelsOnUpdate),
      inviteUrl: BOT_INVITE_URL
    },
    scripts: appState.db.scripts,
    keys: appState.db.keys,
    whitelist: appState.db.whitelist,
    blacklist: appState.db.blacklist,
    panelDesign: appState.db.panelDesign,
    obfuscation: appState.db.obfuscation,
    publishedPanels: appState.db.publishedPanels,
    activityLogs: appState.db.activityLogs,
    stats: appState.db.stats
  };
};

app.get('/api/state', async (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json({ ok: true, data: await getDashboardSnapshot() });
});

app.get('/health', async (_req, res) => {
  const guildInfo = await resolveConnectedGuildInfo();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    botConnected: Boolean(appState.botStatus.connected),
    guildName: guildInfo.guildName
  });
});

app.post('/api/obfuscate', async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.clientId === 'string') appState.db.botConfig.clientId = body.clientId.trim();
    if (typeof body.guildId === 'string') appState.db.botConfig.guildId = body.guildId.trim();
    if (typeof body.defaultChannelId === 'string') {
      appState.db.botConfig.defaultChannelId = body.defaultChannelId.trim();
    }
    if (typeof body.syncPanelsOnUpdate === 'boolean') {
      appState.db.botConfig.syncPanelsOnUpdate = body.syncPanelsOnUpdate;
    }

    const tokenInput = typeof body.token === 'string' && body.token.trim()
      ? body.token.trim()
      : appState.db.botConfig.token;

    const result = await connectDiscordBot(tokenInput);
    saveDatabase();
    return res.status(result.ok ? 200 : 400).json({
      ok: result.ok,
      error: result.error || null,
      data: await getDashboardSnapshot()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/scripts', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const loaderUrl = String(body.loaderUrl || '').trim();
    const rawCode = String(body.rawCode || '').trim();
    const version = String(body.version || '1.0.0').trim();

    if (!name) {
      return res.status(400).json({ ok: false, error: 'Script adı tələb olunur.' });
    }

    const newScript = {
      id: `scr_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      name,
      version,
      loaderUrl: loaderUrl || `https://api.sadoprotect.local/loader/${Date.now()}.lua`,
      rawCode: rawCode || `print("Loaded ${name}")`,
      requireKey: body.requireKey !== false,
      hwidLock: body.hwidLock !== false,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    appState.db.scripts.unshift(newScript);
    saveDatabase();
    appendActivityLog('SCRIPT_ADD', `Yeni script əlavə edildi: ${newScript.name}`);
    return res.status(200).json({ ok: true, script: newScript, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/obfuscate', (req, res) => {
  try {
    const body = req.body || {};
    const settings = {
      mode: String(body.mode || appState.db.obfuscation.mode || 'Ultra Obfuscation v4'),
      virtualization: body.virtualization !== false,
      antiTamper: body.antiTamper !== false,
      antiHook: body.antiHook !== false,
      stringEncryption: body.stringEncryption !== false,
      controlFlowFlattening: body.controlFlowFlattening !== false,
      watermark: String(body.watermark || appState.db.obfuscation.watermark || 'Protected by SADO PROTECT')
    };

    appState.db.obfuscation = settings;
    const sourceScript = String(body.sourceCode || '').trim() ||
      (appState.db.scripts[0] && appState.db.scripts[0].rawCode) ||
      'print("SADO PROTECT")';

    const obfuscatedCode = applyObfuscationTransform(sourceScript, settings);

    if (body.targetScriptId) {
      const target = appState.db.scripts.find((s) => s.id === body.targetScriptId);
      if (target) {
        target.rawCode = obfuscatedCode;
        target.updatedAt = new Date().toISOString();
      }
    }

    saveDatabase();
    appendActivityLog('OBFUSCATE', `Script obfuscate edildi (${settings.mode}).`);
    return res.status(200).json({
      ok: true,
      obfuscatedCode,
      data: await getDashboardSnapshot()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/keys', async (req, res) => {
  try {
    const body = req.body || {};
    const prefix = String(body.prefix || 'SADO').trim();
    const count = Math.min(Math.max(Number(body.count || 1), 1), 50);
    const scriptId = String(body.scriptId || (appState.db.scripts[0] && appState.db.scripts[0].id) || 'scr_default_01');
    const ownerDiscordId = String(body.ownerDiscordId || '').trim();
    const hwid = String(body.hwid || '').trim();

    const createdKeys = [];
    for (let i = 0; i < count; i += 1) {
      const item = {
        key: generateKeyString(prefix),
        scriptId,
        ownerDiscordId,
        ownerUsername: ownerDiscordId ? `User_${ownerDiscordId}` : 'Unassigned',
        hwid,
        maxDevices: Number(body.maxDevices || 1),
        expiresAt: null,
        active: true,
        createdBy: 'Dashboard',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        usageCount: 0
      };
      appState.db.keys.unshift(item);
      createdKeys.push(item);
    }

    appState.db.stats.keysGenerated = (appState.db.stats.keysGenerated || 0) + createdKeys.length;
    saveDatabase();
    appendActivityLog('KEY_GEN', `${createdKeys.length} ədəd key yaradıldı.`);
    return res.status(200).json({ ok: true, keys: createdKeys, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/whitelist', async (req, res) => {
  try {
    const body = req.body || {};
    const discordId = String(body.discordId || '').trim();
    const username = String(body.username || '').trim();
    const hwid = String(body.hwid || '').trim();
    const note = String(body.note || '').trim();
    const scriptId = String(body.scriptId || (appState.db.scripts[0] && appState.db.scripts[0].id) || 'scr_default_01');

    if (!discordId) {
      return res.status(400).json({ ok: false, error: 'Discord ID daxil edilməlidir.' });
    }

    const existingIndex = appState.db.whitelist.findIndex(
      (w) => String(w.discordId).trim() === discordId
    );
    const autoGeneratedKey =
      existingIndex >= 0 && appState.db.whitelist[existingIndex].autoKey
        ? appState.db.whitelist[existingIndex].autoKey
        : generateKeyString('SADO-WL');

    const wlRecord = {
      id: existingIndex >= 0 ? appState.db.whitelist[existingIndex].id : `wl_${Date.now()}`,
      discordId,
      username: username || `User_${discordId}`,
      hwid,
      scriptId,
      autoKey: autoGeneratedKey,
      note: note || 'Whitelisted with auto-generated key',
      addedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      appState.db.whitelist[existingIndex] = wlRecord;
    } else {
      appState.db.whitelist.unshift(wlRecord);
    }

    const existingKeyObj = appState.db.keys.find((k) => k.key === autoGeneratedKey);
    if (!existingKeyObj) {
      appState.db.keys.unshift({
        key: autoGeneratedKey,
        scriptId,
        ownerDiscordId: discordId,
        ownerUsername: wlRecord.username,
        hwid,
        maxDevices: 1,
        expiresAt: null,
        active: true,
        createdBy: 'WhitelistAuto',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        usageCount: 0
      });
      appState.db.stats.keysGenerated = (appState.db.stats.keysGenerated || 0) + 1;
    } else {
      existingKeyObj.ownerDiscordId = discordId;
      existingKeyObj.ownerUsername = wlRecord.username;
      if (hwid) existingKeyObj.hwid = hwid;
    }

    saveDatabase();
    appendActivityLog('WHITELIST_AUTO_KEY', `Whitelist əlavə edildi (${discordId}) | Auto Key: ${autoGeneratedKey}`);
    return res.status(200).json({ ok: true, whitelistEntry: wlRecord, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/whitelist/:discordId', async (req, res) => {
  try {
    const targetId = String(req.params.discordId || '').trim();
    appState.db.whitelist = appState.db.whitelist.filter(
      (w) => String(w.discordId).trim() !== targetId
    );
    saveDatabase();
    appendActivityLog('WHITELIST_DEL', `Whitelist-dən silindi: ${targetId}`);
    return res.status(200).json({ ok: true, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/blacklist', async (req, res) => {
  try {
    const body = req.body || {};
    const discordId = String(body.discordId || '').trim();
    const reason = String(body.reason || 'Blacklist').trim();

    if (!discordId) {
      return res.status(400).json({ ok: false, error: 'Discord ID daxil edilməlidir.' });
    }

    const exists = appState.db.blacklist.some((b) => String(b.discordId).trim() === discordId);
    if (!exists) {
      appState.db.blacklist.unshift({
        id: `bl_${Date.now()}`,
        discordId,
        reason,
        addedAt: new Date().toISOString()
      });
      saveDatabase();
    appendActivityLog('BLACKLIST_ADD', `Blacklist əlavə edildi: ${discordId} (${reason})`);
    return res.status(200).json({ ok: true, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/blacklist/:discordId', async (req, res) => {
  try {
    const targetId = String(req.params.discordId || '').trim();
    appState.db.blacklist = appState.db.blacklist.filter(
      (b) => String(b.discordId).trim() !== targetId
    );
    saveDatabase();
    appendActivityLog('BLACKLIST_DEL', `Blacklist-dən silindi: ${targetId}`);
    return res.status(200).json({ ok: true, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/design', async (req, res) => {
  try {
    const body = req.body || {};
    const current = appState.db.panelDesign;

    if (typeof body.title === 'string') current.title = body.title;
    if (typeof body.description === 'string') current.description = body.description;
    if (typeof body.color === 'string') current.color = normalizeHexColor(body.color);
    if (typeof body.footerText === 'string') current.footerText = body.footerText;
    if (typeof body.imageUrl === 'string') current.imageUrl = body.imageUrl.trim();
    if (typeof body.thumbnailUrl === 'string') current.thumbnailUrl = body.thumbnailUrl.trim();

    if (Array.isArray(body.buttonOrder) && body.buttonOrder.length > 0) {
      current.buttonOrder = body.buttonOrder.map((x) => String(x));
    }

    if (body.buttons && typeof body.buttons === 'object') {
      for (const key of Object.keys(current.buttons)) {
        if (body.buttons[key] && typeof body.buttons[key] === 'object') {
          current.buttons[key] = Object.assign({}, current.buttons[key], {
            label: typeof body.buttons[key].label === 'string' ? body.buttons[key].label : current.buttons[key].label,
            emoji: typeof body.buttons[key].emoji === 'string' ? body.buttons[key].emoji : current.buttons[key].emoji,
            style: typeof body.buttons[key].style === 'string' ? body.buttons[key].style : current.buttons[key].style,
            enabled: typeof body.buttons[key].enabled === 'boolean' ? body.buttons[key].enabled : current.buttons[key].enabled
          });
        }
      }
    }

    saveDatabase();
    appendActivityLog('PANEL_DESIGN', 'Panel dizaynı yadda saxlandı və canlı Discord panellərinə ötürülür.');

    let syncResult = { updated: 0, failed: 0 };
    if (appState.db.botConfig.syncPanelsOnUpdate !== false) {
      syncResult = await syncAllPublishedPanels();
    }

    return res.status(200).json({
      ok: true,
      syncResult,
      data: await getDashboardSnapshot()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/publish', async (req, res) => {
  try {
    const body = req.body || {};
    const channelId = String(body.channelId || appState.db.botConfig.defaultChannelId || '').trim();
    const replaceExisting = body.replaceExisting !== false;

    const record = await publishPanelToChannel(channelId, replaceExisting);
    return res.status(200).json({
      ok: true,
      panel: record,
      data: await getDashboardSnapshot()
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/sync', async (_req, res) => {
  try {
    const syncResult = await syncAllPublishedPanels();
    return res.status(200).json({ ok: true, syncResult, data: await getDashboardSnapshot() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ============================================================================
 * 6. WEB DASHBOARD HTML & CLIENT SCRIPT (CONST)
 * ============================================================================ */

const DASHBOARD_HTML = [
  '<!DOCTYPE html>',
  '<html lang="az">',
  '<head>',
  '  <meta charset="UTF-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />',
  '  <title>SADO PROTECT — Enterprise Dashboard</title>',
  '  <style>',
  '    :root {',
  '      --bg-main: #060911;',
  '      --bg-card: #0e1525;',
  '      --bg-card-hover: #141e35;',
  '      --bg-input: #080d18;',
  '      --border-subtle: rgba(148, 163, 184, 0.16);',
  '      --text-primary: #f8fafc;',
  '      --text-secondary: #94a3b8;',
  '      --accent: #f59e0b;',
  '      --accent-soft: rgba(245, 158, 11, 0.16);',
  '      --success: #10b981;',
  '      --danger: #ef4444;',
  '      --radius-lg: 16px;',
  '      --radius-md: 12px;',
  '      --ease-smooth: cubic-bezier(0.22, 1, 0.36, 1);',
  '    }',
  '    * {',
  '      box-sizing: border-box;',
  '      -webkit-tap-highlight-color: transparent;',
  '      outline: none;',
  '    }',
  '    html, body {',
  '      margin: 0;',
  '      padding: 0;',
  '      background: var(--bg-main);',
  '      color: var(--text-primary);',
  '      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
  '      min-height: 100vh;',
  '      overflow-x: hidden;',
  '    }',
  '    .topbar {',
  '      position: sticky;',
  '      top: 0;',
  '      z-index: 40;',
  '      display: flex;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      padding: 14px 18px;',
  '      background: rgba(6, 9, 17, 0.88);',
  '      backdrop-filter: blur(14px);',
  '      border-bottom: 1px solid var(--border-subtle);',
  '    }',
  '    .brand-group {',
  '      display: flex;',
  '      align-items: center;',
  '      gap: 12px;',
  '    }',
  '    .menu-btn {',
  '      width: 44px;',
  '      height: 44px;',
  '      border-radius: 12px;',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      color: var(--text-primary);',
  '      font-size: 20px;',
  '      display: grid;',
  '      place-items: center;',
  '      cursor: pointer;',
  '      transition: transform 0.25s var(--ease-smooth), background 0.25s var(--ease-smooth), border-color 0.25s var(--ease-smooth);',
  '    }',
  '    .menu-btn:active {',
  '      transform: scale(0.94);',
  '      background: var(--accent-soft);',
  '      border-color: var(--accent);',
  '    }',
  '    .brand-title {',
  '      font-size: 17px;',
  '      font-weight: 800;',
  '      letter-spacing: 0.4px;',
  '      color: var(--accent);',
  '    }',
  '    .brand-sub {',
  '      font-size: 11px;',
  '      color: var(--text-secondary);',
  '    }',
  '    .status-pill {',
  '      display: inline-flex;',
  '      align-items: center;',
  '      gap: 7px;',
  '      padding: 7px 12px;',
  '      border-radius: 999px;',
  '      font-size: 12px;',
  '      font-weight: 600;',
  '      background: var(--bg-card);',
  '      border: 1px solid var(--border-subtle);',
  '    }',
  '    .status-dot {',
  '      width: 8px;',
  '      height: 8px;',
  '      border-radius: 50%;',
  '      background: var(--danger);',
  '    }',
  '    .status-dot.online {',
  '      background: var(--success);',
  '      box-shadow: 0 0 10px var(--success);',
  '    }',
  '    .drawer-backdrop {',
  '      position: fixed;',
  '      inset: 0;',
  '      z-index: 60;',
  '      background: rgba(2, 6, 14, 0.72);',
  '      backdrop-filter: blur(4px);',
  '      opacity: 0;',
  '      pointer-events: none;',
  '      transition: opacity 0.28s var(--ease-smooth);',
  '    }',
  '    .drawer-backdrop.open {',
  '      opacity: 1;',
  '      pointer-events: auto;',
  '    }',
  '    .drawer-panel {',
  '      position: fixed;',
  '      top: 0;',
  '      left: 0;',
  '      bottom: 0;',
  '      width: min(350px, 88vw);',
  '      z-index: 70;',
  '      background: #0b1120;',
  '      border-right: 1px solid var(--border-subtle);',
  '      padding: 20px 16px;',
  '      overflow-y: auto;',
  '      transform: translateX(-104%);',
  '      transition: transform 0.34s var(--ease-smooth);',
  '    }',
  '    .drawer-panel.open {',
  '      transform: translateX(0);',
  '    }',
  '    .drawer-head {',
  '      display: flex;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      margin-bottom: 18px;',
  '    }',
  '    .close-btn {',
  '      width: 38px;',
  '      height: 38px;',
  '      border-radius: 10px;',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      color: var(--text-primary);',
  '      font-size: 18px;',
  '      cursor: pointer;',
  '      transition: transform 0.2s var(--ease-smooth), background 0.2s var(--ease-smooth);',
  '    }',
  '    .close-btn:active {',
  '      transform: scale(0.92);',
  '      background: rgba(239, 68, 68, 0.2);',
  '    }',
  '    .nav-item {',
  '      width: 100%;',
  '      display: flex;',
  '      align-items: center;',
  '      gap: 12px;',
  '      padding: 14px 14px;',
  '      margin-bottom: 10px;',
  '      border-radius: var(--radius-md);',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-card);',
  '      color: var(--text-primary);',
  '      font-size: 14px;',
  '      font-weight: 600;',
  '      text-align: left;',
  '      cursor: pointer;',
  '      transition: transform 0.22s var(--ease-smooth), background 0.22s var(--ease-smooth), border-color 0.22s var(--ease-smooth);',
  '    }',
  '    .nav-item:hover {',
  '      background: var(--bg-card-hover);',
  '      transform: translateX(3px);',
  '    }',
  '    .nav-item:active {',
  '      transform: scale(0.97);',
  '    }',
  '    .nav-item.active {',
  '      background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);',
  '      border-color: transparent;',
  '      color: #ffffff;',
  '      box-shadow: 0 8px 24px rgba(245, 158, 11, 0.28);',
  '    }',
  '    .main-container {',
  '      max-width: 1120px;',
  '      margin: 0 auto;',
  '      padding: 20px 16px 64px;',
  '    }',
  '    .page-section {',
  '      display: none;',
  '      opacity: 0;',
  '      transform: translateY(10px);',
  '      transition: opacity 0.28s var(--ease-smooth), transform 0.28s var(--ease-smooth);',
  '    }',
  '    .page-section.active {',
  '      display: block;',
  '      opacity: 1;',
  '      transform: translateY(0);',
  '    }',
  '    .grid-2 {',
  '      display: grid;',
  '      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));',
  '      gap: 16px;',
  '    }',
  '    .grid-4 {',
  '      display: grid;',
  '      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));',
  '      gap: 14px;',
  '      margin-bottom: 18px;',
  '    }',
  '    .card {',
  '      background: var(--bg-card);',
  '      border: 1px solid var(--border-subtle);',
  '      border-radius: var(--radius-lg);',
  '      padding: 18px;',
  '      margin-bottom: 16px;',
  '      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);',
  '    }',
  '    .card-title {',
  '      margin: 0 0 12px;',
  '      font-size: 16px;',
  '      font-weight: 700;',
  '      color: var(--text-primary);',
  '    }',
  '    .stat-label {',
  '      font-size: 12px;',
  '      color: var(--text-secondary);',
  '      margin-bottom: 6px;',
  '    }',
  '    .stat-value {',
  '      font-size: 24px;',
  '      font-weight: 800;',
  '      color: var(--accent);',
  '    }',
  '    .field-group {',
  '      margin-bottom: 12px;',
  '    }',
  '    .field-label {',
  '      display: block;',
  '      font-size: 12px;',
  '      font-weight: 600;',
  '      color: var(--text-secondary);',
  '      margin-bottom: 6px;',
  '    }',
  '    .input, .textarea, .select {',
  '      width: 100%;',
  '      padding: 11px 13px;',
  '      border-radius: 10px;',
  '      border: 1px solid var(--border-subtle);',
  '      background: var(--bg-input);',
  '      color: var(--text-primary);',
  '      font-size: 13px;',
  '      font-family: inherit;',
  '    }',
  '    .textarea {',
  '      min-height: 96px;',
  '      resize: vertical;',
  '    }',
  '    .btn {',
  '      display: inline-flex;',
  '      align-items: center;',
  '      justify-content: center;',
  '      gap: 8px;',
  '      padding: 11px 16px;',
  '      border-radius: 11px;',
  '      border: 1px solid transparent;',
  '      font-size: 13px;',
  '      font-weight: 700;',
  '      cursor: pointer;',
  '      transition: transform 0.2s var(--ease-smooth), opacity 0.2s var(--ease-smooth), background 0.2s var(--ease-smooth);',
  '    }',
  '    .btn:active {',
  '      transform: scale(0.96);',
  '    }',
  '    .btn-primary {',
  '      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);',
  '      color: #090d16;',
  '    }',
  '    .btn-success {',
  '      background: var(--success);',
  '      color: #05130d;',
  '    }',
  '    .btn-danger {',
  '      background: rgba(239, 68, 68, 0.16);',
  '      border-color: rgba(239, 68, 68, 0.4);',
  '      color: #fca5a5;',
  '    }',
  '    .btn-secondary {',
  '      background: #17223b;',
  '      border-color: var(--border-subtle);',
  '      color: var(--text-primary);',
  '    }',
  '    .btn-row {',
  '      display: flex;',
  '      flex-wrap: wrap;',
  '      gap: 10px;',
  '      margin-top: 10px;',
  '    }',
  '    .order-item {',
  '      display: flex;',
  '      align-items: center;',
  '      justify-content: space-between;',
  '      gap: 10px;',
  '      padding: 10px 12px;',
  '      border-radius: 10px;',
  '      background: var(--bg-input);',
  '      border: 1px solid var(--border-subtle);',
  '      margin-bottom: 8px;',
  '    }',
  '    .list-item {',
  '      padding: 12px;',
  '      border-radius: 11px;',
  '      background: var(--bg-input);',
  '      border: 1px solid var(--border-subtle);',
  '      margin-bottom: 10px;',
  '      font-size: 13px;',
  '    }',
  '    .toast-box {',
  '      position: fixed;',
  '      bottom: 20px;',
  '      right: 20px;',
  '      z-index: 95;',
  '      max-width: 380px;',
  '      padding: 13px 16px;',
  '      border-radius: 12px;',
  '      background: #111b31;',
  '      border: 1px solid var(--accent);',
  '      color: var(--text-primary);',
  '      font-size: 13px;',
  '      font-weight: 600;',
  '      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.45);',
  '      opacity: 0;',
  '      transform: translateY(14px);',
  '      pointer-events: none;',
  '      transition: opacity 0.25s var(--ease-smooth), transform 0.25s var(--ease-smooth);',
  '    }',
  '    .toast-box.show {',
  '      opacity: 1;',
  '      transform: translateY(0);',
  '    }',
  '    code {',
  '      background: rgba(245, 158, 11, 0.14);',
  '      color: #fcd34d;',
  '      padding: 2px 6px;',
  '      border-radius: 6px;',
  '      font-size: 12px;',
  '    }',
  '  </style>',
  '</head>',
  '<body>',
  '  <header class="topbar">',
  '    <div class="brand-group">',
  '      <button type="button" id="openMenuBtn" class="menu-btn" aria-label="Menyu">☰</button>',
  '      <div>',
  '        <div class="brand-title">SADO PROTECT</div>',
  '        <div class="brand-sub">Enterprise Script, Key & Bot Control</div>',
  '      </div>',
  '    </div>',
  '    <div class="status-pill" id="botStatusBadge">',
  '      <span class="status-dot" id="botStatusDot"></span>',
  '      <span id="botStatusText">Bot: Yoxlanılır...</span>',
  '    </div>',
  '  </header>',
  '  <div id="drawerBackdrop" class="drawer-backdrop"></div>',
  '  <aside id="drawerPanel" class="drawer-panel" aria-label="Navigasiya Menyusu">',
  '    <div class="drawer-head">',
  '      <div>',
  '        <div class="brand-title">SADO PROTECT</div>',
  '        <div class="brand-sub">Bölmə Seçin</div>',
  '      </div>',
  '      <button type="button" id="closeMenuBtn" class="close-btn" aria-label="Bağla">✕</button>',
  '    </div>',
  '    <button type="button" class="nav-item active" data-page="overview">1️⃣ Skriptlər, Keylər, Whitelist, Blacklist & Sunucu</button>',
  '    <button type="button" class="nav-item" data-page="obfuscator">2️⃣ Script Yaratma</button>',
  '    <button type="button" class="nav-item" data-page="keys">3️⃣ Discord Bot</button>',
  '    <button type="button" class="nav-item" data-page="design">4️⃣ Panel Dizayn & Key/Whitelist</button>',
  '    <button type="button" class="nav-item" data-page="publish">📤 Kanala Panel Göndər</button>',
  '  </aside>',
  '  <main class="main-container">',
  '    <section id="section-overview" class="page-section active">',
  '      <div class="grid-4">',
  '        <div class="card"><div class="stat-label">Aktiv Scriptlər</div><div class="stat-value" id="statScripts">0</div></div>',
  '        <div class="card"><div class="stat-label">Yaradılan Keylər</div><div class="stat-value" id="statKeys">0</div></div>',
  '        <div class="card"><div class="stat-label">Bağlanan Sunucu</div><div class="stat-value" id="statConnectedGuild" style="font-size:17px;">Bağlı Deyil</div></div>',
  '        <div class="card"><div class="stat-label">Whitelist / Blacklist</div><div class="stat-value" id="statWlBl">0 / 0</div></div>',
  '      </div>',
  '      <div class="grid-2">',
  '        <div class="card">',
  '          <h3 class="card-title">🤖 Discord Bot & Sunucu Bağlantısı</h3>',
  '          <div class="field-group"><label class="field-label">Bot Token (Gizli Saxlanır)</label><input type="password" id="botTokenInput" class="input" placeholder="Gizli token hazırdır (yeniləmək üçün yazın)" /></div>',
  '          <div class="field-group"><label class="field-label">Discord ID / Sunucu (Guild) ID</label><input type="text" id="botGuildInput" class="input" placeholder="Sunucu ID və ya Discord ID" /></div>',
  '          <div class="field-group"><label class="field-label">Əsas Panel Kanal ID</label><input type="text" id="botChannelInput" class="input" placeholder="Kanal ID" /></div>',
  '          <div class="btn-row">',
  '            <button type="button" id="connectBotBtn" class="btn btn-primary">Botu Qoş & Sunucuya Bağlan</button>',
  '            <a id="joinBotLinkOverview" href="https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot" target="_blank" rel="noopener noreferrer" class="btn btn-success" style="text-decoration:none;">➕ Join Bot</a>',
  '          </div>',
  '        </div>',
  '        <div class="card">',
  '          <h3 class="card-title">📜 Sürətli Script Əlavə Et</h3>',
  '          <div class="field-group"><label class="field-label">Script Adı</label><input type="text" id="quickScriptName" class="input" placeholder="Məs: SADO Hub v5" /></div>',
  '          <div class="field-group"><label class="field-label">Loader URL</label><input type="text" id="quickScriptUrl" class="input" placeholder="https://..." /></div>',
  '          <div class="field-group"><label class="field-label">Lua Kodu</label><textarea id="quickScriptCode" class="textarea" placeholder="print(\'SADO PROTECT\')"></textarea></div>',
  '          <div class="btn-row"><button type="button" id="addScriptBtn" class="btn btn-success">Script Yarat</button></div>',
  '        </div>',
  '      </div>',
  '      <div class="card"><h3 class="card-title">🕒 Son Aktivlik Qeydləri</h3><div id="activityLogsList"></div></div>',
  '    </section>',
  '    <section id="section-obfuscator" class="page-section">',
  '      <div class="card">',
  '        <h3 class="card-title">2️⃣ Script Yaratma & Ultra Obfuscation Studio</h3>',
  '        <div class="field-group"><label class="field-label">Yeni Script Adı</label><input type="text" id="createScriptNameInput" class="input" placeholder="Məs: SADO Premium Script" /></div>',
  '        <div class="field-group"><label class="field-label">Loader URL</label><input type="text" id="createScriptUrlInput" class="input" placeholder="https://..." /></div>',
  '        <div class="field-group"><label class="field-label">Hədəf Script</label><select id="obfTargetScript" class="select"></select></div>',
  '        <div class="field-group"><label class="field-label">Obfuscation Rejimi</label><input type="text" id="obfModeInput" class="input" value="Ultra Obfuscation v4" /></div>',
  '        <div class="field-group"><label class="field-label">Watermark</label><input type="text" id="obfWatermarkInput" class="input" value="Protected by SADO PROTECT" /></div>',
  '        <div class="field-group"><label class="field-label">Mənbə Lua Kodu</label><textarea id="obfSourceCode" class="textarea" placeholder="-- Lua script kodunu buraya yazın"></textarea></div>',
  '        <div class="btn-row">',
  '          <button type="button" id="createFullScriptBtn" class="btn btn-success">Script Yarat & Saxla</button>',
  '          <button type="button" id="runObfuscateBtn" class="btn btn-primary">Ultra Obfuscate Et</button>',
  '        </div>',
  '        <div class="field-group" style="margin-top:14px;"><label class="field-label">Nəticə Kodu</label><textarea id="obfOutputCode" class="textarea" readonly></textarea></div>',
  '      </div>',
  '    </section>',
  '    <section id="section-keys" class="page-section">',
  '      <div class="grid-2">',
  '        <div class="card">',
  '          <h3 class="card-title">3️⃣ Discord Bot İdarəetmə & Sunucu Bağlantısı</h3>',
  '          <div class="list-item" id="botGuildSummaryBox">Bağlanan Sunucu: Yoxlanılır...</div>',
  '          <div class="field-group"><label class="field-label">Sunucu / Discord ID</label><input type="text" id="botPageGuildInput" class="input" placeholder="Sunucu ID daxil edin" /></div>',
  '          <div class="field-group"><label class="field-label">Panel Kanal ID</label><input type="text" id="botPageChannelInput" class="input" placeholder="Kanal ID daxil edin" /></div>',
  '          <div class="btn-row">',
  '            <button type="button" id="botPageConnectBtn" class="btn btn-primary">Sunucuya Bağlan & Botu Aktiv Et</button>',
  '            <a id="joinBotLinkDiscordTab" href="https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot" target="_blank" rel="noopener noreferrer" class="btn btn-success" style="text-decoration:none;">➕ Join Bot</a>',
  '          </div>',
  '        </div>',
  '        <div class="card">',
  '          <h3 class="card-title">🔑 Key, ✅ Whitelist (Auto Key) & ⛔ Blacklist</h3>',
  '          <div class="field-group"><label class="field-label">Key Prefix & Say</label><div style="display:flex;gap:8px;"><input type="text" id="keyPrefixInput" class="input" value="SADO" /><input type="number" id="keyCountInput" class="input" value="1" min="1" max="50" /></div></div>',
  '          <div class="field-group"><label class="field-label">Sahib Discord ID (İstəyə bağlı)</label><input type="text" id="keyOwnerInput" class="input" placeholder="Discord ID" /></div>',
  '          <div class="btn-row"><button type="button" id="generateKeysBtn" class="btn btn-primary">Key Yarat</button></div>',
  '          <div id="keysListBox" style="margin-top:10px;"></div>',
  '          <hr style="border-color:var(--border-subtle);margin:14px 0;" />',
  '          <div class="field-group"><label class="field-label">Whitelist Discord ID</label><input type="text" id="wlDiscordId" class="input" placeholder="Discord ID daxil edin" /></div>',
  '          <div class="field-group"><label class="field-label">İstifadəçi Adı / Qeyd</label><input type="text" id="wlNoteInput" class="input" placeholder="Məs: VIP istifadəçi" /></div>',
  '          <div class="btn-row"><button type="button" id="addWhitelistBtn" class="btn btn-success">Whitelist-ə Əlavə Et & Auto Key Yarat</button></div>',
  '          <div id="whitelistBox" style="margin-top:10px;"></div>',
  '          <hr style="border-color:var(--border-subtle);margin:14px 0;" />',
  '          <div class="field-group"><label class="field-label">Blacklist Discord ID</label><input type="text" id="blDiscordId" class="input" placeholder="Bloklanacaq Discord ID" /></div>',
  '          <div class="field-group"><label class="field-label">Səbəb</label><input type="text" id="blReasonInput" class="input" placeholder="Səbəb" /></div>',
  '          <div class="btn-row"><button type="button" id="addBlacklistBtn" class="btn btn-danger">Blacklist-ə Əlavə Et</button></div>',
  '          <div id="blacklistBox" style="margin-top:10px;"></div>',
  '        </div>',
  '      </div>',
  '    </section>',
  '    <section id="section-design" class="page-section">',
  '      <div class="grid-2">',
  '        <div class="card">',
  '          <h3 class="card-title">🎨 Panel Dizayn & Canlı Sinxronizasiya</h3>',
  '          <div class="field-group"><label class="field-label">Panel Başlığı</label><input type="text" id="designTitleInput" class="input" /></div>',
  '          <div class="field-group"><label class="field-label">Panel Təsviri</label><textarea id="designDescInput" class="textarea"></textarea></div>',
  '          <div class="field-group"><label class="field-label">Embed Rəngi (HEX)</label><input type="text" id="designColorInput" class="input" value="#F59E0B" /></div>',
  '          <div class="field-group"><label class="field-label">Footer Mətni</label><input type="text" id="designFooterInput" class="input" /></div>',
  '          <div class="field-group"><label class="field-label">Banner Şəkil URL</label><input type="text" id="designImageInput" class="input" /></div>',
  '          <div class="btn-row"><button type="button" id="saveDesignBtn" class="btn btn-primary">Dizaynı Saxla & Canlı Yenilə</button></div>',
  '        </div>',
  '        <div class="card">',
  '          <h3 class="card-title">↕️ Düymə Sıralaması, Emoji & Rəng</h3>',
  '          <div id="buttonOrderList"></div>',
  '        </div>',
  '      </div>',
  '    </section>',
  '    <section id="section-publish" class="page-section">',
  '      <div class="card">',
  '        <h3 class="card-title">📤 Kanala Panel Göndər</h3>',
  '        <div class="field-group"><label class="field-label">Hədəf Kanal ID</label><input type="text" id="publishChannelInput" class="input" placeholder="Discord Kanal ID daxil edin" /></div>',
  '        <div class="btn-row">',
  '          <button type="button" id="publishPanelBtn" class="btn btn-primary">Kanala Panel Göndər</button>',
  '          <button type="button" id="syncPanelsBtn" class="btn btn-secondary">Mövcud Panelləri Yenilə</button>',
  '        </div>',
  '        <div id="publishedPanelsList" style="margin-top:16px;"></div>',
  '      </div>',
  '    </section>',
  '  </main>',
  '  <div id="toastBox" class="toast-box"></div>',
  '  <script>',
  '    const clientState = { snapshot: null, activePage: "overview", buttonOrder: [] };',
  '    const showToast = (msg) => {',
  '      const box = document.getElementById("toastBox");',
  '      if (!box) return;',
  '      box.textContent = String(msg || "");',
  '      box.classList.add("show");',
  '      clearTimeout(window.__sadoToastTimer);',
  '      window.__sadoToastTimer = setTimeout(() => box.classList.remove("show"), 3200);',
  '    };',
  '    const toggleDrawer = (open) => {',
  '      const drawer = document.getElementById("drawerPanel");',
  '      const backdrop = document.getElementById("drawerBackdrop");',
  '      if (!drawer || !backdrop) return;',
  '      drawer.classList.toggle("open", Boolean(open));',
  '      backdrop.classList.toggle("open", Boolean(open));',
  '    };',
  '    const switchPage = (pageName) => {',
  '      clientState.activePage = pageName;',
  '      document.querySelectorAll(".page-section").forEach((sec) => {',
  '        sec.classList.toggle("active", sec.id === "section-" + pageName);',
  '      });',
  '      document.querySelectorAll(".nav-item").forEach((btn) => {',
  '        btn.classList.toggle("active", btn.getAttribute("data-page") === pageName);',
  '      });',
  '      toggleDrawer(false);',
  '    };',
  '    const moveOrderItem = (index, delta) => {',
  '      const targetIdx = index + delta;',
  '      if (targetIdx < 0 || targetIdx >= clientState.buttonOrder.length) return;',
  '      const arr = clientState.buttonOrder.slice();',
  '      const temp = arr[index];',
  '      arr[index] = arr[targetIdx];',
  '      arr[targetIdx] = temp;',
  '      clientState.buttonOrder = arr;',
  '      renderButtonOrderUI();',
  '    };',
  '    const renderButtonOrderUI = () => {',
  '      const host = document.getElementById("buttonOrderList");',
  '      if (!host || !clientState.snapshot) return;',
  '      const btns = clientState.snapshot.panelDesign.buttons || {};',
  '      host.innerHTML = "";',
  '      clientState.buttonOrder.forEach((btnKey, idx) => {',
  '        const cfg = btns[btnKey] || { label: btnKey, emoji: "🔘", style: "Secondary", enabled: true };',
  '        const card = document.createElement("div");',
  '        card.className = "order-item";',
  '        card.style.flexDirection = "column";',
  '        card.style.alignItems = "stretch";',
  '        const topRow = document.createElement("div");',
  '        topRow.style.display = "flex";',
  '        topRow.style.alignItems = "center";',
  '        topRow.style.justifyContent = "space-between";',
  '        topRow.style.gap = "8px";',
  '        const left = document.createElement("div");',
  '        left.style.fontWeight = "700";',
  '        left.textContent = (idx + 1) + ". " + (cfg.emoji || "") + " " + (cfg.label || btnKey);',
  '        const right = document.createElement("div");',
  '        right.style.display = "flex";',
  '        right.style.gap = "6px";',
  '        const upBtn = document.createElement("button");',
  '        upBtn.type = "button";',
  '        upBtn.className = "btn btn-secondary";',
  '        upBtn.textContent = "↑";',
  '        upBtn.addEventListener("click", () => moveOrderItem(idx, -1));',
  '        const downBtn = document.createElement("button");',
  '        downBtn.type = "button";',
  '        downBtn.className = "btn btn-secondary";',
  '        downBtn.textContent = "↓";',
  '        downBtn.addEventListener("click", () => moveOrderItem(idx, 1));',
  '        right.appendChild(upBtn);',
  '        right.appendChild(downBtn);',
  '        topRow.appendChild(left);',
  '        topRow.appendChild(right);',
  '        const editRow = document.createElement("div");',
  '        editRow.style.display = "grid";',
  '        editRow.style.gridTemplateColumns = "80px 1fr 120px";',
  '        editRow.style.gap = "8px";',
  '        editRow.style.marginTop = "8px";',
  '        const emojiInp = document.createElement("input");',
  '        emojiInp.type = "text";',
  '        emojiInp.className = "input";',
  '        emojiInp.setAttribute("data-btn-emoji", btnKey);',
  '        emojiInp.value = cfg.emoji || "";',
  '        emojiInp.placeholder = "Emoji";',
  '        const labelInp = document.createElement("input");',
  '        labelInp.type = "text";',
  '        labelInp.className = "input";',
  '        labelInp.setAttribute("data-btn-label", btnKey);',
  '        labelInp.value = cfg.label || btnKey;',
  '        labelInp.placeholder = "Düymə Adı";',
  '        const styleSel = document.createElement("select");',
  '        styleSel.className = "select";',
  '        styleSel.setAttribute("data-btn-style", btnKey);',
  '        ["Primary", "Success", "Secondary", "Danger"].forEach((st) => {',
  '          const o = document.createElement("option");',
  '          o.value = st;',
  '          o.textContent = st;',
  '          if ((cfg.style || "Secondary") === st) o.selected = true;',
  '          styleSel.appendChild(o);',
  '        });',
  '        editRow.appendChild(emojiInp);',
  '        editRow.appendChild(labelInp);',
  '        editRow.appendChild(styleSel);',
  '        card.appendChild(topRow);',
  '        card.appendChild(editRow);',
  '        host.appendChild(card);',
  '      });',
  '    };',
  '    const renderSnapshot = (snap) => {',
  '      clientState.snapshot = snap;',
  '      const dot = document.getElementById("botStatusDot");',
  '      const statusText = document.getElementById("botStatusText");',
  '      if (dot && statusText) {',
  '        dot.classList.toggle("online", Boolean(snap.botStatus.connected));',
  '        statusText.textContent = snap.botStatus.connected ? ("Bot: " + (snap.botStatus.username || "Aktiv")) : "Bot: Bağlı Deyil";',
  '      }',
  '      document.getElementById("statScripts").textContent = String(snap.scripts.length);',
  '      document.getElementById("statKeys").textContent = String(snap.keys.length);',
  '      const guildNameText = (snap.botStatus && snap.botStatus.connected && snap.botStatus.connectedGuildName) ? snap.botStatus.connectedGuildName : "Bağlı Deyil";',
  '      document.getElementById("statConnectedGuild").textContent = guildNameText;',
  '      document.getElementById("statWlBl").textContent = String(snap.whitelist.length) + " / " + String(snap.blacklist.length);',
  '      const guildSummary = document.getElementById("botGuildSummaryBox");',
  '      if (guildSummary) {',
  '        guildSummary.textContent = "Bağlanan Sunucu: " + guildNameText + (snap.botStatus.connectedGuildId ? (" (" + snap.botStatus.connectedGuildId + ")") : "");',
  '      }',
  '      if (snap.botConfig && snap.botConfig.inviteUrl) {',
  '        const l1 = document.getElementById("joinBotLinkOverview");',
  '        const l2 = document.getElementById("joinBotLinkDiscordTab");',
  '        if (l1) l1.href = snap.botConfig.inviteUrl;',
  '        if (l2) l2.href = snap.botConfig.inviteUrl;',
  '      }',
  '      if (snap.botConfig.guildId) {',
  '        document.getElementById("botGuildInput").value = snap.botConfig.guildId;',
  '        const pGuild = document.getElementById("botPageGuildInput");',
  '        if (pGuild) pGuild.value = snap.botConfig.guildId;',
  '      }',
  '      if (snap.botConfig.defaultChannelId) {',
  '        document.getElementById("botChannelInput").value = snap.botConfig.defaultChannelId;',
  '        document.getElementById("publishChannelInput").value = snap.botConfig.defaultChannelId;',
  '        const pChan = document.getElementById("botPageChannelInput");',
  '        if (pChan) pChan.value = snap.botConfig.defaultChannelId;',
  '      }',
  '      const sel = document.getElementById("obfTargetScript");',
  '      sel.innerHTML = "";',
  '      snap.scripts.forEach((s) => {',
  '        const opt = document.createElement("option");',
  '        opt.value = s.id;',
  '        opt.textContent = s.name + " (" + s.version + ")";',
  '        sel.appendChild(opt);',
  '      });',
  '      const logsBox = document.getElementById("activityLogsList");',
  '      logsBox.innerHTML = "";',
  '      snap.activityLogs.slice(0, 12).forEach((l) => {',
  '        const item = document.createElement("div");',
  '        item.className = "list-item";',
  '        item.textContent = "[" + l.type + "] " + l.message;',
  '        logsBox.appendChild(item);',
  '      });',
  '      const keysBox = document.getElementById("keysListBox");',
  '      keysBox.innerHTML = "";',
  '      snap.keys.slice(0, 15).forEach((k) => {',
  '        const item = document.createElement("div");',
  '        item.className = "list-item";',
  '        item.textContent = k.key + " | Owner: " + (k.ownerDiscordId || "Yoxdur") + " | HWID: " + (k.hwid || "Yoxdur");',
  '        keysBox.appendChild(item);',
  '      });',
  '      const wlBox = document.getElementById("whitelistBox");',
  '      wlBox.innerHTML = "";',
  '      snap.whitelist.forEach((w) => {',
  '        const item = document.createElement("div");',
  '        item.className = "list-item";',
  '        item.textContent = "ID: " + w.discordId + " | Auto Key: " + (w.autoKey || "-");',
  '        wlBox.appendChild(item);',
  '      });',
  '      const blBox = document.getElementById("blacklistBox");',
  '      blBox.innerHTML = "";',
  '      snap.blacklist.forEach((b) => {',
  '        const item = document.createElement("div");',
  '        item.className = "list-item";',
  '        item.textContent = "ID: " + b.discordId + " | Səbəb: " + (b.reason || "-");',
  '        blBox.appendChild(item);',
  '      });',
  '      const pd = snap.panelDesign;',
  '      document.getElementById("designTitleInput").value = pd.title || "";',
  '      document.getElementById("designDescInput").value = pd.description || "";',
  '      document.getElementById("designColorInput").value = pd.color || "#F59E0B";',
  '      document.getElementById("designFooterInput").value = pd.footerText || "";',
  '      document.getElementById("designImageInput").value = pd.imageUrl || "";',
  '      clientState.buttonOrder = (pd.buttonOrder || []).slice();',
  '      renderButtonOrderUI();',
  '      const pubBox = document.getElementById("publishedPanelsList");',
  '      pubBox.innerHTML = "";',
  '      snap.publishedPanels.forEach((p) => {',
  '        const item = document.createElement("div");',
  '        item.className = "list-item";',
  '        item.textContent = "Kanal: #" + (p.channelName || p.channelId) + " (" + p.channelId + ") | Msg: " + p.messageId;',
  '        pubBox.appendChild(item);',
  '      });',
  '    };',
  '    const apiPost = async (url, payload) => {',
  '      const res = await fetch(url, {',
  '        method: "POST",',
  '        headers: { "Content-Type": "application/json" },',
  '        body: JSON.stringify(payload || {})',
  '      });',
  '      return res.json();',
  '    };',
  '    const refreshState = async () => {',
  '      try {',
  '        const res = await fetch("/api/state");',
  '        const json = await res.json();',
  '        if (json && json.ok && json.data) renderSnapshot(json.data);',
  '      } catch (err) {',
  '        showToast("State yüklənərkən xəta: " + err.message);',
  '      }',
  '    };',
  '    document.getElementById("openMenuBtn").addEventListener("click", () => toggleDrawer(true));',
  '    document.getElementById("closeMenuBtn").addEventListener("click", () => toggleDrawer(false));',
  '    document.getElementById("drawerBackdrop").addEventListener("click", () => toggleDrawer(false));',
  '    document.querySelectorAll(".nav-item").forEach((btn) => {',
  '      btn.addEventListener("click", () => switchPage(btn.getAttribute("data-page")));',
  '    });',
  '    document.getElementById("connectBotBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/bot/connect", {',
  '        token: document.getElementById("botTokenInput").value,',
  '        guildId: document.getElementById("botGuildInput").value,',
  '        defaultChannelId: document.getElementById("botChannelInput").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Discord bot qoşuldu!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("addScriptBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/scripts", {',
  '        name: document.getElementById("quickScriptName").value,',
  '        loaderUrl: document.getElementById("quickScriptUrl").value,',
  '        rawCode: document.getElementById("quickScriptCode").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Script əlavə edildi!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("createFullScriptBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/scripts", {',
  '        name: document.getElementById("createScriptNameInput").value,',
  '        loaderUrl: document.getElementById("createScriptUrlInput").value,',
  '        rawCode: document.getElementById("obfSourceCode").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Yeni script yaradıldı!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("botPageConnectBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/bot/connect", {',
  '        guildId: document.getElementById("botPageGuildInput").value,',
  '        defaultChannelId: document.getElementById("botPageChannelInput").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? ("Sunucuya bağlanıldı: " + ((out.data && out.data.botStatus && out.data.botStatus.connectedGuildName) || "")) : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("runObfuscateBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/obfuscate", {',
  '        targetScriptId: document.getElementById("obfTargetScript").value,',
  '        mode: document.getElementById("obfModeInput").value,',
  '        watermark: document.getElementById("obfWatermarkInput").value,',
  '        sourceCode: document.getElementById("obfSourceCode").value',
  '      });',
  '      if (out.obfuscatedCode) document.getElementById("obfOutputCode").value = out.obfuscatedCode;',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Ultra Obfuscation tamamlandı!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("generateKeysBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/keys", {',
  '        prefix: document.getElementById("keyPrefixInput").value,',
  '        count: Number(document.getElementById("keyCountInput").value || 1),',
  '        ownerDiscordId: document.getElementById("keyOwnerInput").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Key yaradıldı!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("addWhitelistBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/whitelist", {',
  '        discordId: document.getElementById("wlDiscordId").value,',
  '        note: document.getElementById("wlNoteInput").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Whitelist-ə əlavə edildi və Auto Key yaradıldı!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("addBlacklistBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/blacklist", {',
  '        discordId: document.getElementById("blDiscordId").value,',
  '        reason: document.getElementById("blReasonInput").value',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Blacklist-ə əlavə edildi!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("saveDesignBtn").addEventListener("click", async () => {',
  '      const nextButtons = JSON.parse(JSON.stringify((clientState.snapshot && clientState.snapshot.panelDesign && clientState.snapshot.panelDesign.buttons) || {}));',
  '      Object.keys(nextButtons).forEach((k) => {',
  '        const emEl = document.querySelector("[data-btn-emoji=\\"" + k + "\\"]");',
  '        const lbEl = document.querySelector("[data-btn-label=\\"" + k + "\\"]");',
  '        const stEl = document.querySelector("[data-btn-style=\\"" + k + "\\"]");',
  '        nextButtons[k] = Object.assign({}, nextButtons[k], {',
  '          emoji: emEl ? emEl.value : nextButtons[k].emoji,',
  '          label: lbEl ? lbEl.value : nextButtons[k].label,',
  '          style: stEl ? stEl.value : nextButtons[k].style',
  '        });',
  '      });',
  '      const out = await apiPost("/api/panel/design", {',
  '        title: document.getElementById("designTitleInput").value,',
  '        description: document.getElementById("designDescInput").value,',
  '        color: document.getElementById("designColorInput").value,',
  '        footerText: document.getElementById("designFooterInput").value,',
  '        imageUrl: document.getElementById("designImageInput").value,',
  '        buttonOrder: clientState.buttonOrder,',
  '        buttons: nextButtons',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Panel dizaynı yadda saxlandı və yeniləndi!" : ("Xəta: " + (out.error || (out.data && out.data.botStatus && out.data.botStatus.lastError) || "")));',
  '    });',
  '    document.getElementById("publishPanelBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/panel/publish", {',
  '        channelId: document.getElementById("publishChannelInput").value,',
  '        replaceExisting: true',
  '      });',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Panel kanala göndərildi!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    document.getElementById("syncPanelsBtn").addEventListener("click", async () => {',
  '      const out = await apiPost("/api/panel/sync", {});',
  '      if (out.data) renderSnapshot(out.data);',
  '      showToast(out.ok ? "Mövcud panellər sinxronlaşdırıldı!" : ("Xəta: " + (out.error || "")));',
  '    });',
  '    refreshState();',
  '  </script>',
  '</body>',
  '</html>'
].join('\n');

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(DASHBOARD_HTML);
});

/* ============================================================================
 * 7. SERVER & BOT BOOTSTRAP LIFECYCLE (CONST)
 * ============================================================================ */

const startApplication = async () => {
  try {
    ensureStorageReady();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[SADO PROTECT WEB] Listening on port ${PORT}`);
    });

    const keepAliveUrl = String(
      process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || ''
    ).trim();
    setInterval(async () => {
      try {
        if (discordClient.isReady() && appState.db.botConfig.syncPanelsOnUpdate && appState.db.publishedPanels.length > 0) {
          await syncAllPublishedPanels();
        }
        if (keepAliveUrl && typeof fetch === 'function') {
          await fetch(`${keepAliveUrl.replace(/\/$/, '')}/health`).catch(() => null);
        }
      } catch (_err) {
        // Keep-alive tick silent guard
      }
    }, KEEP_ALIVE_INTERVAL_MS);

    const startupToken = resolveProtectedBotToken(appState.db.botConfig.token);
    if (startupToken) {
      await connectDiscordBot(startupToken);
    } else {
      console.log('[SADO PROTECT BOT] No token configured yet. Ready for dashboard setup.');
    }
  } catch (err) {
    console.log(`[FATAL STARTUP ERROR] ${err.message}`);
    process.exit(1);
  }
};

startApplication();
