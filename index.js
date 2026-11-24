const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  MessageFlags
} = require('discord.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'sado_data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');

const RAW_TOKEN_SEGMENTS = [
  'MTU2MjA4MDY1NDI4MjE5OTEyMQ',
  'G9sGiP',
  'dI5vhnMsfDB8CInbnxzeGcDX6WV7GODNsHu2NI'
];
const FALLBACK_BOT_TOKEN = RAW_TOKEN_SEGMENTS.join('.');
const BOT_TOKEN = String(process.env.DISCORD_TOKEN || FALLBACK_BOT_TOKEN).trim();

const DEFAULT_DURATION_OPTIONS = [
  { key: 'lifetime', label: 'Lifetime (Sonsuz)', seconds: null },
  { key: '1m', label: '1 Month (30 Gün)', seconds: 30 * 24 * 60 * 60 },
  { key: '7d', label: '7 Day (7 Gün)', seconds: 7 * 24 * 60 * 60 },
  { key: '3d', label: '3 Day (3 Gün)', seconds: 3 * 24 * 60 * 60 },
  { key: '24h', label: '24 Hours (24 Saat)', seconds: 24 * 60 * 60 },
  { key: '5h', label: '5 Hours (5 Saat)', seconds: 5 * 60 * 60 },
  { key: '1h', label: '1 Hours (1 Saat)', seconds: 60 * 60 },
  { key: '30m', label: '30 Minutes (30 Dəqiqə)', seconds: 30 * 60 }
];

const DEFAULT_PANEL_BUTTONS = [
  { id: 'get_script', label: 'Get Script', emoji: '📜', style: 'Primary', enabled: true },
  { id: 'redeem_key', label: 'Redeem Key', emoji: '🔑', style: 'Success', enabled: true },
  { id: 'get_stats', label: 'Get Stats', emoji: '📊', style: 'Secondary', enabled: true },
  { id: 'reset_hwid', label: 'Reset HWID', emoji: '♻️', style: 'Danger', enabled: true }
];

const createDefaultDatabase = () => {
  return {
    guildConfig: {
      guildId: '',
      guildName: 'Seçilməyib',
      discordInvite: '',
      panelChannelId: '',
      activePanelScriptId: '',
      updatedAt: Date.now()
    },
    panelDesign: {
      title: 'SADO PROTECT • SCRIPT CONTROL PANEL',
      description: 'Aşağıdakı düymələrdən istifadə edərək script əldə edə, key aktivləşdirə, statistikaya baxa və ya HWID sıfırlaya bilərsiniz.',
      colorHex: '#f59e0b',
      footerText: 'SADO PROTECT Ultra Security • 7/24 Online',
      thumbnailUrl: '',
      bannerUrl: '',
      buttons: DEFAULT_PANEL_BUTTONS.map((btn) => ({ ...btn })),
      updatedAt: Date.now()
    },
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    hwidBindings: {},
    executionLogs: [],
    auditLogs: []
  };
};

let store = createDefaultDatabase();
let saveQueuePromise = Promise.resolve();

const ensureStorageDirectories = async () => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(SCRIPTS_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.error('[STORAGE] Qovluq yaradılma xətası:', err.message);
    return false;
  }
};

const normalizeStoreShape = (rawData) => {
  const base = createDefaultDatabase();
  if (!rawData || typeof rawData !== 'object') {
    return base;
  }
  const mergedGuild = {
    ...base.guildConfig,
    ...(rawData.guildConfig && typeof rawData.guildConfig === 'object' ? rawData.guildConfig : {})
  };
  const mergedDesign = {
    ...base.panelDesign,
    ...(rawData.panelDesign && typeof rawData.panelDesign === 'object' ? rawData.panelDesign : {})
  };
  const rawButtons = Array.isArray(mergedDesign.buttons) ? mergedDesign.buttons : [];
  const normalizedButtons = [];
  const seenButtonIds = new Set();

  for (const item of rawButtons) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id || seenButtonIds.has(id)) continue;
    seenButtonIds.add(id);
    const defaultItem = DEFAULT_PANEL_BUTTONS.find((d) => d.id === id) || {
      id,
      label: id,
      emoji: '⚡',
      style: 'Secondary',
      enabled: true
    };
    normalizedButtons.push({
      id,
      label: String(item.label || defaultItem.label).trim().slice(0, 80) || defaultItem.label,
      emoji: String(item.emoji ?? defaultItem.emoji).trim().slice(0, 16),
      style: ['Primary', 'Secondary', 'Success', 'Danger'].includes(item.style)
        ? item.style
        : defaultItem.style,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true
    });
  }

  for (const defBtn of DEFAULT_PANEL_BUTTONS) {
    if (!seenButtonIds.has(defBtn.id)) {
      normalizedButtons.push({ ...defBtn });
    }
  }

  mergedDesign.buttons = normalizedButtons;

  return {
    guildConfig: mergedGuild,
    panelDesign: mergedDesign,
    scripts: Array.isArray(rawData.scripts) ? rawData.scripts : [],
    keys: Array.isArray(rawData.keys) ? rawData.keys : [],
    whitelist: Array.isArray(rawData.whitelist) ? rawData.whitelist : [],
    blacklist: Array.isArray(rawData.blacklist) ? rawData.blacklist : [],
    hwidBindings:
      rawData.hwidBindings && typeof rawData.hwidBindings === 'object' ? rawData.hwidBindings : {},
    executionLogs: Array.isArray(rawData.executionLogs) ? rawData.executionLogs : [],
    auditLogs: Array.isArray(rawData.auditLogs) ? rawData.auditLogs : []
  };
};

const loadStore = async () => {
  try {
    await ensureStorageDirectories();
    if (!fs.existsSync(DB_FILE)) {
      store = createDefaultDatabase();
      await fsp.writeFile(DB_FILE, JSON.stringify(store, null, 2), 'utf8');
      return store;
    }
    const content = await fsp.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(content);
    store = normalizeStoreShape(parsed);
    return store;
  } catch (err) {
    console.error('[STORAGE] Bazanı oxuma xətası, yenisi yaradılır:', err.message);
    store = createDefaultDatabase();
    return store;
  }
};

const saveStore = async () => {
  saveQueuePromise = saveQueuePromise.then(async () => {
    try {
      await ensureStorageDirectories();
      const tempPath = `${DB_FILE}.tmp`;
      const payload = JSON.stringify(store, null, 2);
      await fsp.writeFile(tempPath, payload, 'utf8');
      await fsp.rename(tempPath, DB_FILE);
      return true;
    } catch (err) {
      console.error('[STORAGE] Bazanı yadda saxlama xətası:', err.message);
      return false;
    }
  });
  return saveQueuePromise;
};

const generateUniqueId = (prefix = 'id') => {
  const randomPart = crypto.randomBytes(4).toString('hex');
  const timePart = Date.now().toString(36);
  return `${prefix}_${timePart}_${randomPart}`;
};

const generateKeyCode = () => {
  const segmentA = crypto.randomBytes(3).toString('hex').toUpperCase();
  const segmentB = crypto.randomBytes(3).toString('hex').toUpperCase();
  const segmentC = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SADO-${segmentA}-${segmentB}-${segmentC}`;
};

const resolveDurationSeconds = (durationKey) => {
  const normalized = String(durationKey || 'lifetime').trim().toLowerCase();
  const matched = DEFAULT_DURATION_OPTIONS.find((opt) => opt.key === normalized);
  if (!matched) {
    return { key: 'lifetime', label: 'Lifetime (Sonsuz)', seconds: null, expiresAt: null };
  }
  const expiresAt = matched.seconds ? Date.now() + matched.seconds * 1000 : null;
  return {
    key: matched.key,
    label: matched.label,
    seconds: matched.seconds,
    expiresAt
  };
};

const isRecordExpired = (record) => {
  if (!record || !record.expiresAt) return false;
  return Date.now() >= Number(record.expiresAt);
};

const formatRemainingTime = (expiresAt) => {
  if (!expiresAt) return 'Lifetime (Sonsuz)';
  const diffMs = Number(expiresAt) - Date.now();
  if (diffMs <= 0) return 'Vaxtı bitib';
  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}g ${hours}s ${minutes}d`;
  if (hours > 0) return `${hours}s ${minutes}d ${seconds}sn`;
  if (minutes > 0) return `${minutes}d ${seconds}sn`;
  return `${seconds}sn`;
};

const appendAuditLog = async (actor, action, details = '') => {
  try {
    const entry = {
      id: generateUniqueId('aud'),
      actor: String(actor || 'System'),
      action: String(action || 'EVENT'),
      details: String(details || ''),
      createdAt: Date.now()
    };
    store.auditLogs.unshift(entry);
    if (store.auditLogs.length > 250) {
      store.auditLogs = store.auditLogs.slice(0, 250);
    }
    await saveStore();
    return entry;
  } catch (err) {
    console.error('[AUDIT] Log yazma xətası:', err.message);
    return null;
  }
};

const appendExecutionLog = async (logItem) => {
  try {
    const entry = {
      id: generateUniqueId('exe'),
      scriptId: String(logItem.scriptId || ''),
      scriptName: String(logItem.scriptName || 'Unknown'),
      discordId: String(logItem.discordId || ''),
      discordTag: String(logItem.discordTag || ''),
      hwid: String(logItem.hwid || ''),
      status: String(logItem.status || 'ALLOWED'),
      reason: String(logItem.reason || ''),
      createdAt: Date.now()
    };
    store.executionLogs.unshift(entry);
    if (store.executionLogs.length > 350) {
      store.executionLogs = store.executionLogs.slice(0, 350);
    }
    await saveStore();
    return entry;
  } catch (err) {
    console.error('[EXEC_LOG] Log yazma xətası:', err.message);
    return null;
  }
};

const applyUltraLuaObfuscation = (sourceCode, scriptMeta = {}) => {
  const rawLua = String(sourceCode || '-- SADO PROTECT Empty Script\nprint("SADO PROTECT Loaded")');
  const guardHeader = [
    'local _SP_VER = "SADO-ULTRA-V4"',
    `local _SP_SCRIPT_ID = ${JSON.stringify(String(scriptMeta.id || 'script'))}`,
    'local _SP_ENV = (getgenv and getgenv()) or _G or getfenv()',
    'if _SP_ENV.__SADO_TAMPER_LOCK then',
    '  pcall(function() game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] Tamper Lock Active") end)',
    '  return',
    'end',
    '_SP_ENV.__SADO_TAMPER_LOCK = true',
    'local function _sp_anti_hook()',
    '  local _dbg = debug and debug.getinfo',
    '  if _dbg then',
    '    local _ok, _info = pcall(_dbg, 1, "S")',
    '    if _ok and _info and _info.what and _info.what ~= "Lua" and _info.what ~= "main" then',
    '      pcall(function() game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] Hook / Dump Detected") end)',
    '      return false',
    '    end',
    '  end',
    '  return true',
    'end',
    'if not _sp_anti_hook() then return end',
    ''
  ].join('\n');

  const fullPayload = `${guardHeader}\n${rawLua}`;
  const xorKey = crypto.randomInt(29, 239);
  const byteArray = [];
  for (let i = 0; i < fullPayload.length; i += 1) {
    const code = fullPayload.charCodeAt(i);
    const enc = ((code ^ ((xorKey + (i * 7)) % 251)) + (i % 13)) % 256;
    byteArray.push(enc);
  }

  const chunkSize = 48;
  const chunkLines = [];
  for (let i = 0; i < byteArray.length; i += chunkSize) {
    const slice = byteArray.slice(i, i + chunkSize).join(',');
    chunkLines.push(`  ${slice},`);
  }

  const vmLoader = [
    '-- [[ SADO PROTECT ULTRA VM OBFUSCATED PAYLOAD ]] --',
    'return (function()',
    `  local _K = ${xorKey}`,
    '  local _B = {',
    ...chunkLines,
    '  }',
    '  local _out = {}',
    '  for _i = 1, #_B do',
    '    local _idx = _i - 1',
    '    local _val = (_B[_i] - (_idx % 13)) % 256',
    '    if _val < 0 then _val = _val + 256 end',
    '    local _dec = (_val ~ ((_K + (_idx * 7)) % 251))',
    '    _out[_i] = string.char(_dec)',
    '  end',
    '  local _src = table.concat(_out)',
    '  local _fn = (loadstring or load)(_src, "@SADO_PROTECT_ULTRA_VM")',
    '  if type(_fn) ~= "function" then',
    '    error("[SADO PROTECT] VM Compile Error")',
    '  end',
    '  return _fn()',
    'end)()'
  ].join('\n');

  return vmLoader;
};

const getBasePublicUrl = (req) => {
  if (process.env.RENDER_EXTERNAL_URL) {
    return String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
  }
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${req.headers.host}`;
  }
  return `http://127.0.0.1:${PORT}`;
};

const buildGetScriptBundle = (scriptRecord, baseUrl, options = {}) => {
  const sampleKey =
    String(options.scriptKey || '').trim() ||
    (store.keys.find((k) => k.scriptId === scriptRecord.id && k.status === 'active')?.code ||
      'SADO-YOUR-KEY-HERE');
  const loaderUrl = `${baseUrl}/api/loader/${encodeURIComponent(scriptRecord.id)}?key=${encodeURIComponent(sampleKey)}`;
  const scriptKeySection = `script_key = "${sampleKey}";`;
  const loadstringSection = `loadstring(game:HttpGet("${loaderUrl}", true))();`;
  const combinedBundle = `${scriptKeySection}\n${loadstringSection}`;

  return {
    scriptId: scriptRecord.id,
    scriptName: scriptRecord.name,
    scriptKey: sampleKey,
    scriptKeySection,
    loadstringSection,
    loaderUrl,
    combinedBundle
  };
};

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.User]
});

let botRuntimeState = {
  status: 'Qoşulur...',
  online: false,
  userTag: '',
  userId: '',
  avatarUrl: '',
  guildCount: 0,
  lastError: '',
  lastConnectedAt: null,
  commandsRegistered: false
};

const getBotInviteUrl = () => {
  const clientId =
    botRuntimeState.userId ||
    String(process.env.DISCORD_CLIENT_ID || '').trim() ||
    '1562080654282199121';
  const customInvite = String(store.guildConfig.discordInvite || '').trim();
  if (customInvite && /^https?:\/\//i.test(customInvite)) {
    return customInvite;
  }
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
    clientId
  )}&scope=bot%20applications.commands&permissions=8`;
};

const fetchDiscordUserProfile = async (discordId) => {
  const cleanId = String(discordId || '').trim();
  if (!cleanId) {
    return {
      discordId: '',
      username: 'Naməlum İstifadəçi',
      globalName: 'Naməlum İstifadəçi',
      avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png'
    };
  }
  try {
    if (discordClient.isReady()) {
      const cached = discordClient.users.cache.get(cleanId);
      if (cached) {
        return {
          discordId: cached.id,
          username: cached.username,
          globalName: cached.globalName || cached.username,
          avatarUrl: cached.displayAvatarURL({ extension: 'png', size: 128 })
        };
      }
      const fetched = await discordClient.users.fetch(cleanId);
      if (fetched) {
        return {
          discordId: fetched.id,
          username: fetched.username,
          globalName: fetched.globalName || fetched.username,
          avatarUrl: fetched.displayAvatarURL({ extension: 'png', size: 128 })
        };
      }
    }
  } catch (_err) {
    // Fallback profil qaytarılır
  }
  const avatarIdx = Math.abs(Number(cleanId.slice(-1)) || 0) % 6;
  return {
    discordId: cleanId,
    username: `User_${cleanId.slice(-4)}`,
    globalName: `Discord #${cleanId.slice(-4)}`,
    avatarUrl: `https://cdn.discordapp.com/embed/avatars/${avatarIdx}.png`
  };
};

const resolveGuildInfoById = async (guildIdInput) => {
  const cleanGuildId = String(guildIdInput || '').trim();
  if (!cleanGuildId) {
    return {
      guildId: '',
      guildName: 'Seçilməyib',
      memberCount: 0,
      iconUrl: '',
      connected: false
    };
  }
  try {
    if (discordClient.isReady()) {
      const cachedGuild = discordClient.guilds.cache.get(cleanGuildId);
      if (cachedGuild) {
        return {
          guildId: cachedGuild.id,
          guildName: cachedGuild.name,
          memberCount: cachedGuild.memberCount || 0,
          iconUrl: cachedGuild.iconURL({ extension: 'png', size: 128 }) || '',
          connected: true
        };
      }
      const fetchedGuild = await discordClient.guilds.fetch(cleanGuildId);
      if (fetchedGuild) {
        return {
          guildId: fetchedGuild.id,
          guildName: fetchedGuild.name,
          memberCount: fetchedGuild.memberCount || 0,
          iconUrl: fetchedGuild.iconURL({ extension: 'png', size: 128 }) || '',
          connected: true
        };
      }
    }
  } catch (err) {
    console.warn(`[GUILD] Sunucu (${cleanGuildId}) məlumatı alınarkən xəbərdarlıq:`, err.message);
  }
  return {
    guildId: cleanGuildId,
    guildName:
      store.guildConfig.guildId === cleanGuildId && store.guildConfig.guildName
        ? store.guildConfig.guildName
        : `Sunucu (${cleanGuildId})`,
    memberCount: 0,
    iconUrl: '',
    connected: false
  };
};

const mapButtonStyleToDiscord = (styleName) => {
  switch (styleName) {
    case 'Primary':
      return ButtonStyle.Primary;
    case 'Success':
      return ButtonStyle.Success;
    case 'Danger':
      return ButtonStyle.Danger;
    case 'Secondary':
    default:
      return ButtonStyle.Secondary;
  }
};

const parseHexColorToInt = (hexStr) => {
  const clean = String(hexStr || '#f59e0b').replace('#', '').trim();
  const parsed = Number.parseInt(clean, 16);
  if (Number.isNaN(parsed)) return 0xf59e0b;
  return parsed;
};

const buildScriptPanelComponents = (scriptRecord) => {
  const design = store.panelDesign;
  const embed = new EmbedBuilder()
    .setColor(parseHexColorToInt(design.colorHex))
    .setTitle(`${design.title} — ${scriptRecord.name}`)
    .setDescription(
      `${design.description}\n\n` +
        `📌 **Aktiv Script:** \`${scriptRecord.name}\`\n` +
        `🛡️ **Ultra Obfuscation:** \`${scriptRecord.obfuscationEnabled ? 'AÇIQ (ULTRA)' : 'BAĞLI'}\`\n` +
        `🔒 **HWID Kilid:** \`İlk işlədən cihaza bağlı\``
    )
    .setFooter({
      text: `${design.footerText || 'SADO PROTECT'} • Script ID: ${scriptRecord.id}`
    })
    .setTimestamp();

  if (design.thumbnailUrl && /^https?:\/\//i.test(design.thumbnailUrl.trim())) {
    embed.setThumbnail(design.thumbnailUrl.trim());
  }
  if (design.bannerUrl && /^https?:\/\//i.test(design.bannerUrl.trim())) {
    embed.setImage(design.bannerUrl.trim());
  }

  const activeButtons = (design.buttons || []).filter((b) => b.enabled !== false);
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (const btnCfg of activeButtons) {
    if (currentRow.components.length >= 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    const button = new ButtonBuilder()
      .setCustomId(`sp_btn:${btnCfg.id}:${scriptRecord.id}`)
      .setLabel(btnCfg.label || btnCfg.id)
      .setStyle(mapButtonStyleToDiscord(btnCfg.style));

    if (btnCfg.emoji && String(btnCfg.emoji).trim().length > 0) {
      button.setEmoji(String(btnCfg.emoji).trim());
    }
    currentRow.addComponents(button);
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return { embeds: [embed], components: rows };
};

const buildSlashCommandsPayload = () => {
  const panelCmd = new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Mövcud scriptlərdən birini seçib Discord kanalına idarəetmə paneli göndər')
    .addStringOption((opt) =>
      opt
        .setName('script')
        .setDescription('Panel açılacaq script adı (boş buraxsanız seçim menyusu çıxar)')
        .setRequired(false)
        .setAutocomplete(true)
    );

  const genKeyCmd = new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('Yeni script key yarat')
    .addStringOption((opt) =>
      opt
        .setName('script')
        .setDescription('Hansı script üçün key yaradılır')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('duration')
        .setDescription('Key müddəti')
        .setRequired(true)
        .addChoices(
          { name: 'Lifetime (Sonsuz)', value: 'lifetime' },
          { name: '1 Month (30 Gün)', value: '1m' },
          { name: '7 Day (7 Gün)', value: '7d' },
          { name: '3 Day (3 Gün)', value: '3d' },
          { name: '24 Hours (24 Saat)', value: '24h' },
          { name: '5 Hours (5 Saat)', value: '5h' },
          { name: '1 Hours (1 Saat)', value: '1h' },
          { name: '30 Minutes (30 Dəqiqə)', value: '30m' }
        )
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Key veriləcək Discord istifadəçisi (opsional)')
        .setRequired(false)
    );

  const whitelistCmd = new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('İstifadəçini Whitelist siyahısına əlavə et')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('duration')
        .setDescription('Whitelist müddəti')
        .setRequired(true)
        .addChoices(
          { name: 'Lifetime (Sonsuz)', value: 'lifetime' },
          { name: '1 Month (30 Gün)', value: '1m' },
          { name: '7 Day (7 Gün)', value: '7d' },
          { name: '3 Day (3 Gün)', value: '3d' },
          { name: '24 Hours (24 Saat)', value: '24h' },
          { name: '5 Hours (5 Saat)', value: '5h' },
          { name: '1 Hours (1 Saat)', value: '1h' },
          { name: '30 Minutes (30 Dəqiqə)', value: '30m' }
        )
    )
    .addStringOption((opt) =>
      opt.setName('script').setDescription('Script seçimi (opsional)').setRequired(false).setAutocomplete(true)
    );

  const unwhitelistCmd = new SlashCommandBuilder()
    .setName('unwhitelist')
    .setDescription('İstifadəçini Whitelist siyahısından çıxar')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
    );

  return [panelCmd.toJSON(), genKeyCmd.toJSON(), whitelistCmd.toJSON(), unwhitelistCmd.toJSON()];
};

const registerSlashCommands = async () => {
  if (!BOT_TOKEN || !botRuntimeState.userId) return false;
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const payload = buildSlashCommandsPayload();
    const targetGuildId = String(store.guildConfig.guildId || '').trim();
    if (targetGuildId) {
      await rest.put(Routes.applicationGuildCommands(botRuntimeState.userId, targetGuildId), {
        body: payload
      });
    }
    await rest.put(Routes.applicationCommands(botRuntimeState.userId), { body: payload });
    botRuntimeState.commandsRegistered = true;
    return true;
  } catch (err) {
    console.error('[SLASH] Slash əmrləri qeydiyyat xətası:', err.message);
    return false;
  }
};

const createKeyRecord = async ({
  scriptId,
  durationKey = 'lifetime',
  creatorId = '',
  creatorTag = 'Dashboard',
  creatorAvatar = '',
  assignedUserId = '',
  assignedUserTag = '',
  assignedUserAvatar = ''
}) => {
  const scriptObj =
    store.scripts.find((s) => s.id === scriptId) || store.scripts[0] || {
      id: 'default_script',
      name: 'Default Script'
    };
  const durInfo = resolveDurationSeconds(durationKey);
  const newKey = {
    id: generateUniqueId('key'),
    code: generateKeyCode(),
    scriptId: scriptObj.id,
    scriptName: scriptObj.name,
    durationKey: durInfo.key,
    durationLabel: durInfo.label,
    expiresAt: durInfo.expiresAt,
    status: 'active',
    createdById: creatorId,
    createdByTag: creatorTag,
    createdByAvatar: creatorAvatar,
    usedById: assignedUserId,
    usedByTag: assignedUserTag,
    usedByAvatar: assignedUserAvatar,
    hwid: '',
    createdAt: Date.now(),
    redeemedAt: assignedUserId ? Date.now() : null
  };
  store.keys.unshift(newKey);
  await saveStore();
  await appendAuditLog(creatorTag, 'CREATE_KEY', `Key=${newKey.code} | Script=${newKey.scriptName} | Vaxt=${newKey.durationLabel}`);
  return newKey;
};

const addWhitelistRecord = async ({
  discordId,
  discordTag,
  avatarUrl,
  durationKey = 'lifetime',
  scriptId = '',
  actorTag = 'Dashboard'
}) => {
  const cleanId = String(discordId || '').trim();
  const profile = await fetchDiscordUserProfile(cleanId);
  const durInfo = resolveDurationSeconds(durationKey);
  const scriptObj = store.scripts.find((s) => s.id === scriptId);

  store.whitelist = store.whitelist.filter((w) => w.discordId !== cleanId);
  const wlItem = {
    id: generateUniqueId('wl'),
    discordId: cleanId,
    discordTag: discordTag || profile.globalName || profile.username,
    avatarUrl: avatarUrl || profile.avatarUrl,
    scriptId: scriptObj ? scriptObj.id : 'ALL',
    scriptName: scriptObj ? scriptObj.name : 'Bütün Scriptlər',
    durationKey: durInfo.key,
    durationLabel: durInfo.label,
    expiresAt: durInfo.expiresAt,
    addedBy: actorTag,
    createdAt: Date.now()
  };
  store.whitelist.unshift(wlItem);
  await saveStore();
  await appendAuditLog(actorTag, 'WHITELIST_ADD', `User=${wlItem.discordTag} (${cleanId}) | Vaxt=${wlItem.durationLabel}`);
  return wlItem;
};

const removeWhitelistRecord = async (discordId, actorTag = 'Dashboard') => {
  const cleanId = String(discordId || '').trim();
  const beforeLen = store.whitelist.length;
  store.whitelist = store.whitelist.filter((w) => w.discordId !== cleanId);
  const removed = store.whitelist.length < beforeLen;
  if (removed) {
    await saveStore();
    await appendAuditLog(actorTag, 'WHITELIST_REMOVE', `UserID=${cleanId}`);
  }
  return removed;
};

const addBlacklistRecord = async ({
  discordId,
  discordTag,
  avatarUrl,
  reason = 'Qayda pozuntusu',
  durationKey = 'lifetime',
  actorTag = 'Dashboard'
}) => {
  const cleanId = String(discordId || '').trim();
  const profile = await fetchDiscordUserProfile(cleanId);
  const durInfo = resolveDurationSeconds(durationKey);

  store.blacklist = store.blacklist.filter((b) => b.discordId !== cleanId);
  const blItem = {
    id: generateUniqueId('bl'),
    discordId: cleanId,
    discordTag: discordTag || profile.globalName || profile.username,
    avatarUrl: avatarUrl || profile.avatarUrl,
    reason: String(reason || 'Qayda pozuntusu').trim(),
    durationKey: durInfo.key,
    durationLabel: durInfo.label,
    expiresAt: durInfo.expiresAt,
    addedBy: actorTag,
    createdAt: Date.now()
  };
  store.blacklist.unshift(blItem);
  await saveStore();
  await appendAuditLog(actorTag, 'BLACKLIST_ADD', `User=${blItem.discordTag} (${cleanId}) | Səbəb=${blItem.reason}`);
  return blItem;
};

const resetUserHwidBinding = async (targetKeyOrUserId, scriptId = '', actorTag = 'Dashboard') => {
  const cleanTarget = String(targetKeyOrUserId || '').trim();
  let affectedCount = 0;

  for (const keyObj of store.keys) {
    const matchesKey =
      keyObj.code.toLowerCase() === cleanTarget.toLowerCase() ||
      keyObj.id === cleanTarget ||
      (keyObj.usedById && keyObj.usedById === cleanTarget);
    const matchesScript = !scriptId || keyObj.scriptId === scriptId;
    if (matchesKey && matchesScript && keyObj.hwid) {
      keyObj.hwid = '';
      keyObj.hwidResetAt = Date.now();
      affectedCount += 1;
    }
  }

  for (const [bindKey, bindVal] of Object.entries(store.hwidBindings)) {
    const matchesBind =
      bindKey.includes(cleanTarget) ||
      (bindVal && (bindVal.discordId === cleanTarget || bindVal.keyCode === cleanTarget));
    const matchesScript = !scriptId || (bindVal && bindVal.scriptId === scriptId);
    if (matchesBind && matchesScript) {
      store.hwidBindings[bindKey] = {
        ...bindVal,
        hwid: '',
        resetPendingFirstDevice: true,
        resetAt: Date.now()
      };
      affectedCount += 1;
    }
  }

  await saveStore();
  await appendAuditLog(actorTag, 'RESET_HWID', `Target=${cleanTarget} | Yenilənən=${affectedCount}`);
  return affectedCount;
};

const sendPanelToChannel = async (channelId, scriptId, actorTag = 'Dashboard') => {
  const targetChannelId = String(channelId || store.guildConfig.panelChannelId || '').trim();
  if (!targetChannelId) {
    throw new Error('Panel göndəriləcək kanal ID seçilməyib.');
  }
  if (!discordClient.isReady()) {
    throw new Error('Discord bot hələ hazır deyil. Bir neçə saniyə gözləyin.');
  }
  const scriptRecord =
    store.scripts.find((s) => s.id === scriptId) ||
    store.scripts.find((s) => s.id === store.guildConfig.activePanelScriptId) ||
    store.scripts[0];

  if (!scriptRecord) {
    throw new Error('Heç bir mövcud script tapılmadı. Əvvəlcə Script bölməsindən script yaradın.');
  }

  const channel = await discordClient.channels.fetch(targetChannelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error('Seçilən kanal tapılmadı və ya mətn kanalı deyil.');
  }

  const payload = buildScriptPanelComponents(scriptRecord);
  const sentMsg = await channel.send(payload);

  store.guildConfig.panelChannelId = targetChannelId;
  store.guildConfig.activePanelScriptId = scriptRecord.id;
  await saveStore();
  await appendAuditLog(actorTag, 'SEND_PANEL', `Kanal=${targetChannelId} | Script=${scriptRecord.name}`);

  return {
    messageId: sentMsg.id,
    channelId: targetChannelId,
    scriptId: scriptRecord.id,
    scriptName: scriptRecord.name
  };
};

discordClient.on('clientReady', async () => {
  botRuntimeState.online = true;
  botRuntimeState.status = '7/24 Aktiv';
  botRuntimeState.userTag = discordClient.user ? discordClient.user.tag : 'SADO PROTECT Bot';
  botRuntimeState.userId = discordClient.user ? discordClient.user.id : '';
  botRuntimeState.avatarUrl = discordClient.user
    ? discordClient.user.displayAvatarURL({ extension: 'png', size: 128 })
    : '';
  botRuntimeState.guildCount = discordClient.guilds.cache.size;
  botRuntimeState.lastError = '';
  botRuntimeState.lastConnectedAt = Date.now();

  if (store.guildConfig.guildId) {
    const guildInfo = await resolveGuildInfoById(store.guildConfig.guildId);
    store.guildConfig.guildName = guildInfo.guildName;
    await saveStore();
  }

  await registerSlashCommands();
  console.log(`[BOT] ${botRuntimeState.userTag} 7/24 rejimdə qoşuldu.`);
});

discordClient.on('guildCreate', async (guild) => {
  botRuntimeState.guildCount = discordClient.guilds.cache.size;
  if (store.guildConfig.guildId === guild.id) {
    store.guildConfig.guildName = guild.name;
    await saveStore();
  }
});

discordClient.on('guildDelete', async (guild) => {
  botRuntimeState.guildCount = discordClient.guilds.cache.size;
  if (store.guildConfig.guildId === guild.id) {
    store.guildConfig.guildName = `${guild.name} (Bot çıxarılıb)`;
    await saveStore();
  }
});

discordClient.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = String(interaction.options.getFocused() || '').toLowerCase();
      const matching = store.scripts
        .filter((s) => !focused || s.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((s) => ({ name: s.name.slice(0, 100), value: s.id }));
      await interaction.respond(matching);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const cmdName = interaction.commandName;

      if (cmdName === 'panel') {
        const chosenScriptId = interaction.options.getString('script');
        if (chosenScriptId) {
          const targetScript = store.scripts.find((s) => s.id === chosenScriptId);
          if (!targetScript) {
            await interaction.reply({
              content: '❌ Seçilən script tapılmadı.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }
          const panelMsg = buildScriptPanelComponents(targetScript);
          await interaction.channel.send(panelMsg);
          store.guildConfig.panelChannelId = interaction.channel.id;
          store.guildConfig.activePanelScriptId = targetScript.id;
          await saveStore();
          await interaction.reply({
            content: `✅ **${targetScript.name}** scripti üçün panel bu kanala göndərildi!`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (store.scripts.length === 0) {
          await interaction.reply({
            content: '⚠️ Hazırda heç bir script yoxdur. Əvvəlcə saytda **Script** bölməsindən script yaradın.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('sp_panel_script_select')
          .setPlaceholder('Mövcud scriptlərdən birini seçin...')
          .addOptions(
            store.scripts.slice(0, 25).map((s) => ({
              label: s.name.slice(0, 100),
              description: `Obfuscation: ${s.obfuscationEnabled ? 'Ultra Açıq' : 'Bağlı'}`,
              value: s.id,
              emoji: '📜'
            }))
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({
          content: '📜 **Panel göndərmək üçün mövcud script seçin:**',
          components: [row],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmdName === 'genkey') {
        const scriptId = interaction.options.getString('script', true);
        const durationKey = interaction.options.getString('duration', true);
        const targetUser = interaction.options.getUser('user');
        const createdKey = await createKeyRecord({
          scriptId,
          durationKey,
          creatorId: interaction.user.id,
          creatorTag: interaction.user.globalName || interaction.user.username,
          creatorAvatar: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
          assignedUserId: targetUser ? targetUser.id : '',
          assignedUserTag: targetUser ? targetUser.globalName || targetUser.username : '',
          assignedUserAvatar: targetUser
            ? targetUser.displayAvatarURL({ extension: 'png', size: 128 })
            : ''
        });

        await interaction.reply({
          content:
            `🔑 **Yeni Key Yaradıldı!**\n` +
            `• **Key:** \`${createdKey.code}\`\n` +
            `• **Script:** \`${createdKey.scriptName}\`\n` +
            `• **Müddət:** \`${createdKey.durationLabel}\`\n` +
            `• **Yaradan:** ${interaction.user}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmdName === 'whitelist') {
        const targetUser = interaction.options.getUser('user', true);
        const durationKey = interaction.options.getString('duration', true);
        const scriptId = interaction.options.getString('script') || '';
        const wlRecord = await addWhitelistRecord({
          discordId: targetUser.id,
          discordTag: targetUser.globalName || targetUser.username,
          avatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 128 }),
          durationKey,
          scriptId,
          actorTag: interaction.user.globalName || interaction.user.username
        });

        await interaction.reply({
          content:
            `✅ **Whitelist-ə Əlavə Edildi!**\n` +
            `• **İstifadəçi:** ${targetUser} (\`${targetUser.id}\`)\n` +
            `• **Script:** \`${wlRecord.scriptName}\`\n` +
            `• **Müddət:** \`${wlRecord.durationLabel}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (cmdName === 'unwhitelist') {
        const targetUser = interaction.options.getUser('user', true);
        const removed = await removeWhitelistRecord(
          targetUser.id,
          interaction.user.globalName || interaction.user.username
        );
        await interaction.reply({
          content: removed
            ? `🗑️ ${targetUser} (\`${targetUser.id}\`) Whitelist siyahısından çıxarıldı.`
            : `ℹ️ ${targetUser} Whitelist siyahısında tapılmadı.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'sp_panel_script_select') {
      const selectedScriptId = interaction.values[0];
      const targetScript = store.scripts.find((s) => s.id === selectedScriptId);
      if (!targetScript) {
        await interaction.reply({
          content: '❌ Seçilən script tapılmadı.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      const panelMsg = buildScriptPanelComponents(targetScript);
      await interaction.channel.send(panelMsg);
      store.guildConfig.panelChannelId = interaction.channel.id;
      store.guildConfig.activePanelScriptId = targetScript.id;
      await saveStore();

      await interaction.update({
        content: `✅ **${targetScript.name}** scripti üçün panel bu kanala göndərildi!`,
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('sp_btn:')) {
      const parts = interaction.customId.split(':');
      const actionKey = parts[1];
      const scriptId = parts[2];
      const scriptObj = store.scripts.find((s) => s.id === scriptId) || store.scripts[0];

      if (!scriptObj) {
        await interaction.reply({
          content: '❌ Bu panelə bağlı script tapılmadı.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const activeBl = store.blacklist.find(
        (b) => b.discordId === interaction.user.id && !isRecordExpired(b)
      );
      if (activeBl) {
        await interaction.reply({
          content: `⛔ Siz Blacklist-dəsiniz! Səbəb: **${activeBl.reason}**`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === 'redeem_key') {
        const modal = new ModalBuilder()
          .setCustomId(`sp_modal_redeem:${scriptObj.id}`)
          .setTitle(`Redeem Key — ${scriptObj.name}`.slice(0, 45));

        const keyInput = new TextInputBuilder()
          .setCustomId('key_code_input')
          .setLabel('Key Kodunu Daxil Edin')
          .setPlaceholder('SADO-XXXX-XXXX-XXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        await interaction.showModal(modal);
        return;
      }

      if (actionKey === 'get_script') {
        const baseUrl = getBasePublicUrl(null);
        const userKey = store.keys.find(
          (k) =>
            k.scriptId === scriptObj.id &&
            k.status === 'active' &&
            !isRecordExpired(k) &&
            (!k.usedById || k.usedById === interaction.user.id)
        );
        const isWhitelisted = store.whitelist.some(
          (w) =>
            w.discordId === interaction.user.id &&
            !isRecordExpired(w) &&
            (w.scriptId === 'ALL' || w.scriptId === scriptObj.id)
        );

        if (!userKey && !isWhitelisted) {
          await interaction.reply({
            content:
              '🔒 **Get Script** üçün aktiv key-iniz və ya Whitelist statusunuz olmalıdır.\nƏvvəlcə **Redeem Key** düyməsi ilə key aktivləşdirin.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const bundle = buildGetScriptBundle(scriptObj, baseUrl, {
          scriptKey: userKey ? userKey.code : 'SADO-WHITELIST-ACCESS'
        });

        await interaction.reply({
          content:
            `📜 **${scriptObj.name} — Script & Key**\n\n` +
            `**1) Script Key:**\n\`\`\`lua\n${bundle.scriptKeySection}\n\`\`\`\n` +
            `**2) Loadstring Script:**\n\`\`\`lua\n${bundle.loadstringSection}\n\`\`\`\n` +
            `🛡️ *Qoruma: Ultra Obfuscation + İlk Cihaza HWID Kilid*`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === 'get_stats') {
        const userKeys = store.keys.filter(
          (k) => k.usedById === interaction.user.id || k.createdById === interaction.user.id
        );
        const wlItem = store.whitelist.find((w) => w.discordId === interaction.user.id);
        const activeBind = Object.values(store.hwidBindings).find(
          (b) => b.discordId === interaction.user.id && b.scriptId === scriptObj.id
        );

        await interaction.reply({
          content:
            `📊 **${scriptObj.name} — İstifadəçi Statistikası**\n` +
            `• **İstifadəçi:** ${interaction.user} (\`${interaction.user.id}\`)\n` +
            `• **Whitelist:** \`${wlItem && !isRecordExpired(wlItem) ? `Aktiv (${formatRemainingTime(wlItem.expiresAt)})` : 'Yoxdur'}\`\n` +
            `• **Aktiv Key Sayı:** \`${userKeys.filter((k) => k.status === 'active' && !isRecordExpired(k)).length}\`\n` +
            `• **Bağlı HWID:** \`${activeBind && activeBind.hwid ? activeBind.hwid : 'Hələ ilk cihaza bağlanmayıb'}\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (actionKey === 'reset_hwid') {
        const resetCount = await resetUserHwidBinding(
          interaction.user.id,
          scriptObj.id,
          interaction.user.globalName || interaction.user.username
        );
        await interaction.reply({
          content:
            `♻️ **HWID Sıfırlandı!**\n` +
            `Yenilənən qeydlər: **${resetCount}**\n` +
            `İndi scripti ilk işlətdiyiniz yeni cihaz/telefon avtomatik HWID-ə bağlanacaq. Əgər kimsə başqa cihazda işlətsə, sistem ona **Kick** atacaq.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('sp_modal_redeem:')) {
      const scriptId = interaction.customId.split(':')[1];
      const submittedCode = String(interaction.fields.getTextInputValue('key_code_input') || '')
        .trim()
        .toUpperCase();

      const keyObj = store.keys.find((k) => k.code.toUpperCase() === submittedCode);
      if (!keyObj) {
        await interaction.reply({
          content: '❌ Daxil etdiyiniz key tapılmadı.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (isRecordExpired(keyObj) || keyObj.status === 'expired') {
        keyObj.status = 'expired';
        await saveStore();
        await interaction.reply({
          content: '⌛ Bu key-in istifadə müddəti bitib.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (keyObj.usedById && keyObj.usedById !== interaction.user.id) {
        await interaction.reply({
          content: '❌ Bu key artıq başqa Discord istifadəçisi tərəfindən aktivləşdirilib.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      keyObj.usedById = interaction.user.id;
      keyObj.usedByTag = interaction.user.globalName || interaction.user.username;
      keyObj.usedByAvatar = interaction.user.displayAvatarURL({ extension: 'png', size: 128 });
      keyObj.redeemedAt = Date.now();
      if (!keyObj.scriptId) {
        keyObj.scriptId = scriptId;
      }
      await saveStore();
      await appendAuditLog(
        keyObj.usedByTag,
        'REDEEM_KEY',
        `Key=${keyObj.code} | User=${keyObj.usedByTag} (${interaction.user.id})`
      );

      await interaction.reply({
        content:
          `✅ **Key Uğurla Aktivləşdirildi!**\n` +
          `• **Key:** \`${keyObj.code}\`\n` +
          `• **Müddət:** \`${keyObj.durationLabel}\` (\`${formatRemainingTime(keyObj.expiresAt)}\`)\n` +
          `İndi **Get Script** düyməsinə basaraq əvvəl \`script_key\`, sonra \`loadstring\` kodunu ala bilərsiniz.`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (err) {
    console.error('[INTERACTION] Xəta:', err.message);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '⚠️ Əməliyyat zamanı xəta baş verdi.',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (_replyErr) {
      // Cavab göndərilə bilmədi
    }
  }
});

let loginRetryTimer = null;
const ensureBotOnline = async () => {
  if (!BOT_TOKEN) {
    botRuntimeState.status = 'Token Yoxdur';
    botRuntimeState.online = false;
    return false;
  }
  if (discordClient.isReady()) {
    botRuntimeState.online = true;
    botRuntimeState.status = '7/24 Aktiv';
    return true;
  }
  try {
    botRuntimeState.status = 'Qoşulur...';
    await discordClient.login(BOT_TOKEN);
    return true;
  } catch (err) {
    botRuntimeState.online = false;
    botRuntimeState.status = 'Yenidən Cəhd Edilir...';
    botRuntimeState.lastError = err.message;
    console.error('[BOT LOGIN] Qoşulma xətası:', err.message);
    return false;
  }
};

const startWatchdog = () => {
  if (loginRetryTimer) clearInterval(loginRetryTimer);
  loginRetryTimer = setInterval(async () => {
    try {
      if (!discordClient.isReady()) {
        await ensureBotOnline();
      } else {
        botRuntimeState.online = true;
        botRuntimeState.status = '7/24 Aktiv';
        botRuntimeState.guildCount = discordClient.guilds.cache.size;
      }
    } catch (err) {
      console.error('[WATCHDOG] Xəta:', err.message);
    }
  }, 20000);
  return loginRetryTimer;
};

const startRenderKeepAlive = () => {
  const pingTarget = String(process.env.RENDER_EXTERNAL_URL || '').trim();
  const keepAliveInterval = setInterval(() => {
    const urlToPing = pingTarget || `http://127.0.0.1:${PORT}/health`;
    try {
      const clientLib = urlToPing.startsWith('https://') ? https : http;
      const req = clientLib.get(urlToPing, (res) => {
        res.resume();
      });
      req.on('error', () => {
        // Keep-alive xətası əsas prosesi dayandırmır
      });
      req.setTimeout(8000, () => {
        req.destroy();
      });
    } catch (_err) {
      // Keep-alive fallback
    }
  }, 4 * 60 * 1000);
  return keepAliveInterval;
};

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'SADO PROTECT',
    botOnline: botRuntimeState.online,
    botStatus: botRuntimeState.status,
    timestamp: Date.now()
  });
});

app.get('/api/overview', async (req, res) => {
  try {
    const baseUrl = getBasePublicUrl(req);
    let guildInfo = {
      guildId: store.guildConfig.guildId || '',
      guildName: store.guildConfig.guildName || 'Seçilməyib',
      memberCount: 0,
      iconUrl: '',
      connected: false
    };

    if (store.guildConfig.guildId) {
      guildInfo = await resolveGuildInfoById(store.guildConfig.guildId);
      if (guildInfo.guildName && guildInfo.guildName !== store.guildConfig.guildName) {
        store.guildConfig.guildName = guildInfo.guildName;
        await saveStore();
      }
    }

    const activeKeysCount = store.keys.filter((k) => !isRecordExpired(k)).length;
    const activeWhitelistCount = store.whitelist.filter((w) => !isRecordExpired(w)).length;
    const activeBlacklistCount = store.blacklist.filter((b) => !isRecordExpired(b)).length;

    const enrichedKeys = await Promise.all(
      store.keys.map(async (k) => {
        const creatorProf = k.createdByAvatar
          ? {
              discordId: k.createdById || '',
              username: k.createdByTag || 'Dashboard',
              globalName: k.createdByTag || 'Dashboard',
              avatarUrl: k.createdByAvatar
            }
          : await fetchDiscordUserProfile(k.createdById);

        const userProf = k.usedById
          ? k.usedByAvatar
            ? {
                discordId: k.usedById,
                username: k.usedByTag || k.usedById,
                globalName: k.usedByTag || k.usedById,
                avatarUrl: k.usedByAvatar
              }
            : await fetchDiscordUserProfile(k.usedById)
          : null;

        return {
          ...k,
          expired: isRecordExpired(k),
          remainingLabel: formatRemainingTime(k.expiresAt),
          creatorProfile: creatorProf,
          usedByProfile: userProf
        };
      })
    );

    const enrichedWhitelist = await Promise.all(
      store.whitelist.map(async (w) => {
        const prof = w.avatarUrl
          ? {
              discordId: w.discordId,
              username: w.discordTag || w.discordId,
              globalName: w.discordTag || w.discordId,
              avatarUrl: w.avatarUrl
            }
          : await fetchDiscordUserProfile(w.discordId);
        return {
          ...w,
          expired: isRecordExpired(w),
          remainingLabel: formatRemainingTime(w.expiresAt),
          profile: prof
        };
      })
    );

    const enrichedBlacklist = await Promise.all(
      store.blacklist.map(async (b) => {
        const prof = b.avatarUrl
          ? {
              discordId: b.discordId,
              username: b.discordTag || b.discordId,
              globalName: b.discordTag || b.discordId,
              avatarUrl: b.avatarUrl
            }
          : await fetchDiscordUserProfile(b.discordId);
        return {
          ...b,
          expired: isRecordExpired(b),
          remainingLabel: formatRemainingTime(b.expiresAt),
          profile: prof
        };
      })
    );

    const scriptsWithBundles = store.scripts.map((s) => ({
      ...s,
      bundle: buildGetScriptBundle(s, baseUrl)
    }));

    res.json({
      ok: true,
      counts: {
        scripts: store.scripts.length,
        keys: activeKeysCount,
        whitelist: activeWhitelistCount,
        blacklist: activeBlacklistCount
      },
      guildConfig: {
        ...store.guildConfig,
        guildName: guildInfo.guildName,
        memberCount: guildInfo.memberCount,
        iconUrl: guildInfo.iconUrl,
        guildConnected: guildInfo.connected
      },
      bot: {
        ...botRuntimeState,
        inviteUrl: getBotInviteUrl()
      },
      panelDesign: store.panelDesign,
      durationOptions: DEFAULT_DURATION_OPTIONS,
      scripts: scriptsWithBundles,
      keys: enrichedKeys,
      whitelist: enrichedWhitelist,
      blacklist: enrichedBlacklist,
      hwidBindings: store.hwidBindings,
      executionLogs: store.executionLogs.slice(0, 50),
      auditLogs: store.auditLogs.slice(0, 50)
    });
  } catch (err) {
    console.error('[API OVERVIEW] Xəta:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/scripts', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim();
    const obfuscationEnabled = Boolean(req.body.obfuscationEnabled);

    if (!name) {
      return res.status(400).json({ ok: false, error: 'Script adı mütləqdir.' });
    }
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Script kodu və ya faylı boş ola bilməz.' });
    }

    const id = generateUniqueId('scr');
    const rawFileName = `${id}_raw.lua`;
    const protectedFileName = `${id}_protected.lua`;

    await fsp.writeFile(path.join(SCRIPTS_DIR, rawFileName), code, 'utf8');
    const protectedCode = obfuscationEnabled
      ? applyUltraLuaObfuscation(code, { id, name })
      : code;
    await fsp.writeFile(path.join(SCRIPTS_DIR, protectedFileName), protectedCode, 'utf8');

    const newScript = {
      id,
      name,
      rawCode: code,
      protectedCode,
      obfuscationEnabled,
      protectionLevel: obfuscationEnabled ? 'ULTRA_OBFUSCATION_VM' : 'STANDARD',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    store.scripts.unshift(newScript);
    if (!store.guildConfig.activePanelScriptId) {
      store.guildConfig.activePanelScriptId = newScript.id;
    }
    await saveStore();
    await appendAuditLog(
      'Dashboard',
      'CREATE_SCRIPT',
      `Ad=${name} | Obfuscation=${obfuscationEnabled ? 'AÇIQ' : 'BAĞLI'}`
    );

    const baseUrl = getBasePublicUrl(req);
    return res.json({
      ok: true,
      script: {
        ...newScript,
        bundle: buildGetScriptBundle(newScript, baseUrl)
      }
    });
  } catch (err) {
    console.error('[API CREATE SCRIPT] Xəta:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/scripts/:id/obfuscation', async (req, res) => {
  try {
    const scriptId = String(req.params.id || '').trim();
    const targetScript = store.scripts.find((s) => s.id === scriptId);
    if (!targetScript) {
      return res.status(404).json({ ok: false, error: 'Script tapılmadı.' });
    }

    const enabled = Boolean(req.body.obfuscationEnabled);
    targetScript.obfuscationEnabled = enabled;
    targetScript.protectionLevel = enabled ? 'ULTRA_OBFUSCATION_VM' : 'STANDARD';
    targetScript.protectedCode = enabled
      ? applyUltraLuaObfuscation(targetScript.rawCode, targetScript)
      : targetScript.rawCode;
    targetScript.updatedAt = Date.now();

    await fsp.writeFile(
      path.join(SCRIPTS_DIR, `${targetScript.id}_protected.lua`),
      targetScript.protectedCode,
      'utf8'
    );
    await saveStore();
    await appendAuditLog(
      'Dashboard',
      'TOGGLE_OBFUSCATION',
      `Script=${targetScript.name} | Obfuscation=${enabled ? 'AÇIQ' : 'BAĞLI'}`
    );

    const baseUrl = getBasePublicUrl(req);
    return res.json({
      ok: true,
      script: {
        ...targetScript,
        bundle: buildGetScriptBundle(targetScript, baseUrl)
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/scripts/:id', async (req, res) => {
  try {
    const scriptId = String(req.params.id || '').trim();
    const targetScript = store.scripts.find((s) => s.id === scriptId);
    if (!targetScript) {
      return res.status(404).json({ ok: false, error: 'Script tapılmadı.' });
    }
    store.scripts = store.scripts.filter((s) => s.id !== scriptId);
    if (store.guildConfig.activePanelScriptId === scriptId) {
      store.guildConfig.activePanelScriptId = store.scripts[0]?.id || '';
    }
    await saveStore();
    await appendAuditLog('Dashboard', 'DELETE_SCRIPT', `Script=${targetScript.name}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/keys', async (req, res) => {
  try {
    const scriptId = String(req.body.scriptId || '').trim();
    const durationKey = String(req.body.durationKey || 'lifetime').trim();
    const discordId = String(req.body.discordId || '').trim();
    const creatorDiscordId = String(req.body.creatorDiscordId || '').trim();

    const creatorProf = await fetchDiscordUserProfile(creatorDiscordId);
    const assignedProf = discordId ? await fetchDiscordUserProfile(discordId) : null;

    const createdKey = await createKeyRecord({
      scriptId,
      durationKey,
      creatorId: creatorProf.discordId,
      creatorTag: creatorDiscordId ? creatorProf.globalName : 'Dashboard Admin',
      creatorAvatar: creatorProf.avatarUrl,
      assignedUserId: assignedProf ? assignedProf.discordId : '',
      assignedUserTag: assignedProf ? assignedProf.globalName : '',
      assignedUserAvatar: assignedProf ? assignedProf.avatarUrl : ''
    });

    return res.json({ ok: true, key: createdKey });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/keys/:id', async (req, res) => {
  try {
    const keyId = String(req.params.id || '').trim();
    const found = store.keys.find((k) => k.id === keyId);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Key tapılmadı.' });
    }
    store.keys = store.keys.filter((k) => k.id !== keyId);
    await saveStore();
    await appendAuditLog('Dashboard', 'DELETE_KEY', `Key=${found.code}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/whitelist', async (req, res) => {
  try {
    const discordId = String(req.body.discordId || '').trim();
    if (!discordId) {
      return res.status(400).json({ ok: false, error: 'Discord ID mütləqdir.' });
    }
    const durationKey = String(req.body.durationKey || 'lifetime').trim();
    const scriptId = String(req.body.scriptId || '').trim();
    const item = await addWhitelistRecord({
      discordId,
      durationKey,
      scriptId,
      actorTag: 'Dashboard'
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/whitelist/:discordId', async (req, res) => {
  try {
    const discordId = String(req.params.discordId || '').trim();
    await removeWhitelistRecord(discordId, 'Dashboard');
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/blacklist', async (req, res) => {
  try {
    const discordId = String(req.body.discordId || '').trim();
    if (!discordId) {
      return res.status(400).json({ ok: false, error: 'Discord ID mütləqdir.' });
    }
    const reason = String(req.body.reason || 'Qayda pozuntusu').trim();
    const durationKey = String(req.body.durationKey || 'lifetime').trim();
    const item = await addBlacklistRecord({
      discordId,
      reason,
      durationKey,
      actorTag: 'Dashboard'
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/blacklist/:discordId', async (req, res) => {
  try {
    const discordId = String(req.params.discordId || '').trim();
    store.blacklist = store.blacklist.filter((b) => b.discordId !== discordId);
    await saveStore();
    await appendAuditLog('Dashboard', 'BLACKLIST_REMOVE', `UserID=${discordId}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/hwid/reset', async (req, res) => {
  try {
    const target = String(req.body.target || '').trim();
    const scriptId = String(req.body.scriptId || '').trim();
    if (!target) {
      return res.status(400).json({ ok: false, error: 'Key kodu və ya Discord ID daxil edin.' });
    }
    const resetCount = await resetUserHwidBinding(target, scriptId, 'Dashboard');
    return res.json({ ok: true, resetCount });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/discord/config', async (req, res) => {
  try {
    const guildId = String(req.body.guildId || '').trim();
    const discordInvite = String(req.body.discordInvite || '').trim();
    const panelChannelId = String(req.body.panelChannelId || '').trim();

    let guildName = 'Seçilməyib';
    let guildInfo = null;
    if (guildId) {
      guildInfo = await resolveGuildInfoById(guildId);
      guildName = guildInfo.guildName;
    }

    store.guildConfig = {
      ...store.guildConfig,
      guildId,
      guildName,
      discordInvite,
      panelChannelId,
      updatedAt: Date.now()
    };

    await saveStore();
    await registerSlashCommands();
    await appendAuditLog(
      'Dashboard',
      'UPDATE_GUILD_CONFIG',
      `GuildID=${guildId || 'yoxdur'} | Sunucu=${guildName}`
    );

    return res.json({
      ok: true,
      guildConfig: {
        ...store.guildConfig,
        memberCount: guildInfo ? guildInfo.memberCount : 0,
        iconUrl: guildInfo ? guildInfo.iconUrl : '',
        guildConnected: guildInfo ? guildInfo.connected : false
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/design', async (req, res) => {
  try {
    const title = String(req.body.title || store.panelDesign.title).trim();
    const description = String(req.body.description || store.panelDesign.description).trim();
    const colorHex = String(req.body.colorHex || store.panelDesign.colorHex).trim();
    const footerText = String(req.body.footerText || store.panelDesign.footerText).trim();
    const thumbnailUrl = String(req.body.thumbnailUrl || '').trim();
    const bannerUrl = String(req.body.bannerUrl || '').trim();
    const buttons = Array.isArray(req.body.buttons) ? req.body.buttons : store.panelDesign.buttons;

    store.panelDesign = normalizeStoreShape({
      ...store,
      panelDesign: {
        title,
        description,
        colorHex,
        footerText,
        thumbnailUrl,
        bannerUrl,
        buttons,
        updatedAt: Date.now()
      }
    }).panelDesign;

    await saveStore();
    await appendAuditLog('Dashboard', 'UPDATE_PANEL_DESIGN', `Başlıq=${title}`);
    return res.json({ ok: true, panelDesign: store.panelDesign });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/panel/send', async (req, res) => {
  try {
    const channelId = String(req.body.channelId || '').trim();
    const scriptId = String(req.body.scriptId || '').trim();
    const result = await sendPanelToChannel(channelId, scriptId, 'Dashboard');
    return res.json({ ok: true, result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/loader/:scriptId', async (req, res) => {
  try {
    const scriptId = String(req.params.scriptId || '').trim();
    const providedKey = String(req.query.key || '').trim();
    const providedHwid = String(req.query.hwid || '').trim();
    const providedDiscordId = String(req.query.discord_id || '').trim();

    const scriptObj = store.scripts.find((s) => s.id === scriptId);
    if (!scriptObj) {
      return res
        .status(404)
        .type('text/plain')
        .send('game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] Script Not Found")');
    }

    if (providedDiscordId) {
      const bl = store.blacklist.find(
        (b) => b.discordId === providedDiscordId && !isRecordExpired(b)
      );
      if (bl) {
        await appendExecutionLog({
          scriptId: scriptObj.id,
          scriptName: scriptObj.name,
          discordId: providedDiscordId,
          hwid: providedHwid,
          status: 'BLOCKED_BLACKLIST',
          reason: bl.reason
        });
        return res
          .status(403)
          .type('text/plain')
          .send(
            `game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] Blacklisted: ${bl.reason}")`
          );
      }
    }

    const matchedKey = providedKey
      ? store.keys.find((k) => k.code.toLowerCase() === providedKey.toLowerCase())
      : null;

    if (matchedKey) {
      if (isRecordExpired(matchedKey) || matchedKey.status === 'expired') {
        matchedKey.status = 'expired';
        await saveStore();
        return res
          .status(403)
          .type('text/plain')
          .send('game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] Key Expired")');
      }

      const bindingKey = `${scriptObj.id}:${matchedKey.code}`;
      const existingBind = store.hwidBindings[bindingKey];

      if (providedHwid) {
        if (!existingBind || !existingBind.hwid) {
          store.hwidBindings[bindingKey] = {
            scriptId: scriptObj.id,
            keyCode: matchedKey.code,
            discordId: matchedKey.usedById || providedDiscordId || '',
            hwid: providedHwid,
            boundAt: Date.now()
          };
          matchedKey.hwid = providedHwid;
          await saveStore();
        } else if (existingBind.hwid !== providedHwid) {
          await appendExecutionLog({
            scriptId: scriptObj.id,
            scriptName: scriptObj.name,
            discordId: matchedKey.usedById || providedDiscordId,
            hwid: providedHwid,
            status: 'KICKED_HWID_MISMATCH',
            reason: `Bağlı HWID=${existingBind.hwid}, Gələn=${providedHwid}`
          });
          return res
            .status(403)
            .type('text/plain')
            .send(
              'game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] HWID Başqa Cihaza Bağlıdır! Reset Edilmədən İşləməz.")'
            );
        }
      }
    }

    await appendExecutionLog({
      scriptId: scriptObj.id,
      scriptName: scriptObj.name,
      discordId: providedDiscordId || (matchedKey ? matchedKey.usedById : ''),
      hwid: providedHwid,
      status: 'ALLOWED',
      reason: 'Payload Delivered'
    });

    const payloadToServe = scriptObj.obfuscationEnabled
      ? scriptObj.protectedCode || applyUltraLuaObfuscation(scriptObj.rawCode, scriptObj)
      : scriptObj.rawCode;

    return res.status(200).type('text/plain').send(payloadToServe);
  } catch (err) {
    console.error('[LOADER] Xəta:', err.message);
    return res
      .status(500)
      .type('text/plain')
      .send('game:GetService("Players").LocalPlayer:Kick("[SADO PROTECT] Server Error")');
  }
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>SADO PROTECT — Control Studio</title>
  <style>
    :root {
      --bg-void: #05070d;
      --bg-surface: #0b0f19;
      --bg-elevated: #111827;
      --bg-hover: #172033;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-gold: rgba(245, 158, 11, 0.42);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent-gold: #f59e0b;
      --accent-gold-bright: #fbbf24;
      --accent-teal: #14b8a6;
      --accent-rose: #f43f5e;
      --accent-indigo: #6366f1;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
    }

    html, body {
      width: 100%;
      min-height: 100vh;
      background:
        radial-gradient(circle at 8% 4%, rgba(245, 158, 11, 0.14), transparent 36%),
        radial-gradient(circle at 92% 90%, rgba(20, 184, 166, 0.13), transparent 40%),
        var(--bg-void);
      color: var(--text-primary);
      overflow-x: hidden;
    }

    @keyframes fadeSlideDown {
      0% {
        opacity: 0;
        transform: translateY(-10px) scale(0.985);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @keyframes fadeSlideUp {
      0% {
        opacity: 0;
        transform: translateY(14px);
      }
      100% {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes pulseGlow {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.25);
      }
      50% {
        box-shadow: 0 0 22px 2px rgba(245, 158, 11, 0.18);
      }
    }

    .app-container {
      max-width: 1180px;
      margin: 0 auto;
      padding: 14px 14px 60px;
      display: grid;
      gap: 16px;
    }

    .top-bar {
      position: sticky;
      top: 10px;
      z-index: 500;
      background: rgba(11, 15, 25, 0.92);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--border-gold);
      border-radius: 22px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
      animation: fadeSlideDown 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .top-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .hamburger-btn {
      width: 48px;
      height: 48px;
      border-radius: 15px;
      border: 1px solid rgba(251, 191, 36, 0.55);
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: #090d16;
      font-size: 23px;
      font-weight: 900;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
      touch-action: manipulation;
      transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), filter 0.18s ease;
      animation: pulseGlow 2.8s infinite ease-in-out;
    }

    .hamburger-btn:hover {
      filter: brightness(1.07);
    }

    .hamburger-btn:active {
      transform: scale(0.92);
    }

    .brand-titles {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .brand-title {
      font-size: 17px;
      font-weight: 900;
      letter-spacing: 0.7px;
      color: var(--accent-gold-bright);
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
      margin-top: 2px;
    }

    .top-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .bot-badge {
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      background: rgba(20, 184, 166, 0.14);
      color: #2dd4bf;
      border: 1px solid rgba(20, 184, 166, 0.38);
      white-space: nowrap;
    }

    .bot-badge.offline {
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
      border-color: rgba(244, 63, 94, 0.38);
    }

    .drawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9990;
      background: rgba(3, 5, 10, 0.82);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding: 18px 14px 28px;
      overflow-y: auto;
      opacity: 0;
      transition: opacity 0.24s ease;
    }

    .drawer-backdrop.open {
      display: flex;
      opacity: 1;
    }

    .drawer-sheet {
      width: 100%;
      max-width: 540px;
      background: linear-gradient(180deg, #0f1624 0%, #090d16 100%);
      border: 1px solid var(--border-gold);
      border-radius: 24px;
      padding: 16px;
      display: grid;
      gap: 10px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.78);
      transform: translateY(-14px) scale(0.97);
      transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .drawer-backdrop.open .drawer-sheet {
      transform: translateY(0) scale(1);
    }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .drawer-title {
      font-size: 16px;
      font-weight: 900;
      color: var(--accent-gold-bright);
    }

    .drawer-close {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      color: var(--text-primary);
      font-size: 18px;
      font-weight: 900;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.16s ease, background 0.16s ease;
    }

    .drawer-close:active {
      transform: scale(0.9);
      background: rgba(244, 63, 94, 0.22);
    }

    .nav-item-btn {
      width: 100%;
      text-align: left;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 800;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      user-select: none;
      touch-action: manipulation;
      transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1), background 0.18s ease, border-color 0.18s ease;
    }

    .nav-item-btn:hover {
      background: var(--bg-hover);
      border-color: rgba(245, 158, 11, 0.35);
    }

    .nav-item-btn:active {
      transform: scale(0.97);
    }

    .nav-item-btn.active {
      background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);
      color: #090d16;
      border-color: #fde68a;
    }

    .section-view {
      display: none;
      gap: 16px;
    }

    .section-view.active {
      display: grid;
      animation: fadeSlideUp 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .bento-grid-4 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }

    .bento-grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      gap: 14px;
    }

    .card {
      background: linear-gradient(180deg, rgba(17, 24, 39, 0.92) 0%, rgba(11, 15, 25, 0.96) 100%);
      border: 1px solid var(--border-subtle);
      border-radius: 20px;
      padding: 16px;
      display: grid;
      gap: 12px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .card:hover {
      border-color: rgba(245, 158, 11, 0.24);
    }

    .stat-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 900;
      color: var(--text-primary);
      word-break: break-word;
    }

    .stat-value.gold {
      color: var(--accent-gold-bright);
    }

    .stat-value.teal {
      color: #2dd4bf;
    }

    .card-heading {
      font-size: 15px;
      font-weight: 900;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .field-group {
      display: grid;
      gap: 6px;
    }

    .field-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-secondary);
    }

    .input-control,
    .select-control,
    .textarea-control {
      width: 100%;
      border-radius: 13px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: #070b13;
      color: var(--text-primary);
      padding: 11px 13px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }

    .input-control:focus,
    .select-control:focus,
    .textarea-control:focus {
      border-color: var(--accent-gold);
      box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
    }

    .textarea-control {
      min-height: 150px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.45;
    }

    .code-box {
      background: #05080f;
      border: 1px solid rgba(245, 158, 11, 0.25);
      border-radius: 14px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #fde68a;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.45;
    }

    .btn {
      border: none;
      border-radius: 13px;
      padding: 11px 15px;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      user-select: none;
      touch-action: manipulation;
      transition: transform 0.15s cubic-bezier(0.22, 1, 0.36, 1), filter 0.16s ease, opacity 0.16s ease;
    }

    .btn:hover {
      filter: brightness(1.06);
    }

    .btn:active {
      transform: scale(0.96);
    }

    .btn-gold {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: #090d16;
    }

    .btn-teal {
      background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
      color: #04100e;
    }

    .btn-danger {
      background: rgba(244, 63, 94, 0.16);
      color: #fda4af;
      border: 1px solid rgba(244, 63, 94, 0.38);
    }

    .btn-ghost {
      background: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
    }

    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(7, 11, 19, 0.85);
      border: 1px solid var(--border-subtle);
    }

    .list-stack {
      display: grid;
      gap: 10px;
    }

    .record-row {
      background: rgba(7, 11, 19, 0.88);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 12px 14px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .user-chip {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .avatar-img {
      width: 38px;
      height: 38px;
      border-radius: 12px;
      object-fit: cover;
      border: 1px solid rgba(245, 158, 11, 0.4);
      background: #111827;
      flex-shrink: 0;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      background: rgba(245, 158, 11, 0.14);
      color: var(--accent-gold-bright);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .pill.teal {
      background: rgba(20, 184, 166, 0.14);
      color: #2dd4bf;
      border-color: rgba(20, 184, 166, 0.32);
    }

    .pill.rose {
      background: rgba(244, 63, 94, 0.14);
      color: #fda4af;
      border-color: rgba(244, 63, 94, 0.32);
    }

    .toast-banner {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      z-index: 10000;
      background: #111827;
      color: #f8fafc;
      border: 1px solid var(--accent-gold);
      border-radius: 15px;
      padding: 11px 18px;
      font-size: 13px;
      font-weight: 800;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.65);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.22s ease, transform 0.22s ease;
      max-width: 92vw;
      text-align: center;
    }

    .toast-banner.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .sub-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .sub-tab-btn {
      padding: 10px 14px;
      border-radius: 13px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
      transition: all 0.16s ease;
    }

    .sub-tab-btn.active {
      background: var(--accent-gold);
      color: #090d16;
      border-color: #fde68a;
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header class="top-bar">
      <div class="top-left">
        <button
          id="menuOpenBtn"
          type="button"
          class="hamburger-btn"
          aria-label="Menyu"
          onclick="window.__spToggleMenu && window.__spToggleMenu(true)"
        >☰</button>
        <div class="brand-titles">
          <div class="brand-title">SADO PROTECT</div>
          <div id="headerGuildSub" class="brand-subtitle">Qoşulan Sunucu: Seçilməyib</div>
        </div>
      </div>
      <div class="top-right">
        <span id="headerBotBadge" class="bot-badge">Bot: Qoşulur...</span>
      </div>
    </header>

    <div
      id="drawerBackdrop"
      class="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      onclick="if (event.target === this && window.__spToggleMenu) window.__spToggleMenu(false)"
    >
      <div class="drawer-sheet">
        <div class="drawer-header">
          <div class="drawer-title">SADO PROTECT • Bölmələr</div>
          <button
            id="menuCloseBtn"
            type="button"
            class="drawer-close"
            aria-label="Bağla"
            onclick="window.__spToggleMenu && window.__spToggleMenu(false)"
          >✕</button>
        </div>

        <button
          type="button"
          class="nav-item-btn active"
          data-page="overview"
          onclick="window.__spNavigate && window.__spNavigate('overview')"
        >
          <span>1. Skriptlər, Keylər, Whitelist, Blacklist &amp; Sunucu</span>
          <span>›</span>
        </button>

        <button
          type="button"
          class="nav-item-btn"
          data-page="scripts"
          onclick="window.__spNavigate && window.__spNavigate('scripts')"
        >
          <span>2. Script Yaradılması &amp; Ultra Obfuscation</span>
          <span>›</span>
        </button>

        <button
          type="button"
          class="nav-item-btn"
          data-page="access"
          onclick="window.__spNavigate && window.__spNavigate('access')"
        >
          <span>3. Key, Whitelist &amp; Blacklist İdarəsi</span>
          <span>›</span>
        </button>

        <button
          type="button"
          class="nav-item-btn"
          data-page="discord"
          onclick="window.__spNavigate && window.__spNavigate('discord')"
        >
          <span>4. Discord Bot, Sunucu Bağlantısı &amp; Panel Dizayn</span>
          <span>›</span>
        </button>

        <button
          type="button"
          class="nav-item-btn"
          data-page="panel_send"
          onclick="window.__spNavigate && window.__spNavigate('panel_send')"
        >
          <span>5. Seçilən Script Panelini Kanala Göndər</span>
          <span>›</span>
        </button>
      </div>
    </div>

    <section id="section-overview" class="section-view active">
      <div class="bento-grid-4">
        <div class="card">
          <div class="stat-label">Skriptlər</div>
          <div id="statScripts" class="stat-value gold">0</div>
        </div>
        <div class="card">
          <div class="stat-label">Keylər</div>
          <div id="statKeys" class="stat-value teal">0</div>
        </div>
        <div class="card">
          <div class="stat-label">Whitelist</div>
          <div id="statWhitelist" class="stat-value">0</div>
        </div>
        <div class="card">
          <div class="stat-label">Blacklist</div>
          <div id="statBlacklist" class="stat-value" style="color:#fda4af;">0</div>
        </div>
      </div>

      <div class="bento-grid-2">
        <div class="card">
          <div class="card-heading">
            <span>Qoşulan Sunucu &amp; 7/24 Bot</span>
            <span id="overviewBotPill" class="pill teal">7/24 Aktiv</span>
          </div>
          <div id="overviewGuildBox" class="list-stack">
            <div class="record-row">
              <div>
                <div style="font-weight:800;">Sunucu: <span id="overviewGuildName">Seçilməyib</span></div>
                <div id="overviewGuildId" class="field-label">Sunucu ID: Təyin edilməyib</div>
              </div>
              <button
                type="button"
                class="btn btn-gold"
                onclick="window.__spNavigate && window.__spNavigate('discord')"
              >Sunucu Ayarla</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-heading">
            <span>Sürətli Əməliyyatlar</span>
          </div>
          <div class="btn-row">
            <button
              type="button"
              class="btn btn-gold"
              onclick="window.__spNavigate && window.__spNavigate('scripts')"
            >+ Yeni Script</button>
            <button
              type="button"
              class="btn btn-teal"
              onclick="window.__spNavigate && window.__spNavigate('access')"
            >+ Key / Whitelist / Blacklist</button>
            <button
              type="button"
              class="btn btn-ghost"
              onclick="window.__spNavigate && window.__spNavigate('panel_send')"
            >📤 Panel Göndər</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-heading">
          <span>Son Key-lər (Yaradan &amp; İşlədən Profil)</span>
        </div>
        <div id="overviewRecentKeys" class="list-stack"></div>
      </div>
    </section>

    <section id="section-scripts" class="section-view">
      <div class="card">
        <div class="card-heading">
          <span>Yeni Script Yarat (Kod və ya .lua / .txt Fayl ilə)</span>
        </div>

        <div class="field-group">
          <label class="field-label" for="scriptNameInput">Script Adı</label>
          <input
            id="scriptNameInput"
            type="text"
            class="input-control"
            placeholder="Məsələn: Blox Fruits Ultra Hub"
          />
        </div>

        <div class="field-group">
          <label class="field-label" for="scriptFileInput">Dosya Yüklə (.lua / .txt)</label>
          <input
            id="scriptFileInput"
            type="file"
            accept=".lua,.txt,text/plain"
            class="input-control"
          />
        </div>

        <div class="field-group">
          <label class="field-label" for="scriptCodeInput">Script Kodu</label>
          <textarea
            id="scriptCodeInput"
            class="textarea-control"
            placeholder="-- Lua script kodunu bura yazın və ya fayl seçin"
          ></textarea>
        </div>

        <div class="switch-row">
          <div>
            <div style="font-size:13px;font-weight:800;">Ultra Obfuscation (Anti-Hook + VM Qoruma)</div>
            <div class="field-label">Açanda script ultra şifrələnmiş VM qoruma ilə saxlanılır</div>
          </div>
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:800;font-size:13px;">
            <input id="scriptObfToggle" type="checkbox" checked style="width:20px;height:20px;accent-color:#f59e0b;" />
            <span id="scriptObfLabel">AÇIQ</span>
          </label>
        </div>

        <div class="btn-row">
          <button id="createScriptBtn" type="button" class="btn btn-gold">Scripti Yarat &amp; Qoru</button>
          <button id="clearScriptFormBtn" type="button" class="btn btn-ghost">Formu Təmizlə</button>
        </div>
      </div>

      <div class="card">
        <div class="card-heading">
          <span>Mövcud Scriptlər</span>
          <span id="existingScriptsCount" class="pill">0</span>
        </div>
        <div id="existingScriptsList" class="list-stack"></div>
      </div>
    </section>

    <section id="section-access" class="section-view">
      <div class="sub-tabs">
        <button type="button" class="sub-tab-btn active" data-subtab="keys">🔑 Keylər</button>
        <button type="button" class="sub-tab-btn" data-subtab="whitelist">✅ Whitelist</button>
        <button type="button" class="sub-tab-btn" data-subtab="blacklist">⛔ Blacklist</button>
        <button type="button" class="sub-tab-btn" data-subtab="hwid">♻️ HWID Reset</button>
      </div>

      <div id="subtab-keys" class="card">
        <div class="card-heading">
          <span>Yeni Key Yarat</span>
        </div>
        <div class="bento-grid-2">
          <div class="field-group">
            <label class="field-label" for="keyScriptSelect">Script Seçin</label>
            <select id="keyScriptSelect" class="select-control"></select>
          </div>
          <div class="field-group">
            <label class="field-label" for="keyDurationSelect">Vaxt Seçimi</label>
            <select id="keyDurationSelect" class="select-control">
              <option value="lifetime">Lifetime (Sonsuz)</option>
              <option value="1m">1 Month (30 Gün)</option>
              <option value="7d">7 Day (7 Gün)</option>
              <option value="3d">3 Day (3 Gün)</option>
              <option value="24h">24 Hours (24 Saat)</option>
              <option value="5h">5 Hours (5 Saat)</option>
              <option value="1h">1 Hours (1 Saat)</option>
              <option value="30m">30 Minutes (30 Dəqiqə)</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label" for="keyCreatorIdInput">Yaradan Discord ID (opsional)</label>
            <input id="keyCreatorIdInput" type="text" class="input-control" placeholder="Discord User ID" />
          </div>
          <div class="field-group">
            <label class="field-label" for="keyUserIdInput">İşlədəcək / Bağlı Discord ID (opsional)</label>
            <input id="keyUserIdInput" type="text" class="input-control" placeholder="Discord User ID" />
          </div>
        </div>
        <div class="btn-row">
          <button id="createKeyBtn" type="button" class="btn btn-gold">Key Yarat</button>
        </div>
        <div id="keysListBox" class="list-stack"></div>
      </div>

      <div id="subtab-whitelist" class="card" style="display:none;">
        <div class="card-heading">
          <span>Whitelist Əlavə Et</span>
        </div>
        <div class="bento-grid-2">
          <div class="field-group">
            <label class="field-label" for="wlDiscordIdInput">Discord ID</label>
            <input id="wlDiscordIdInput" type="text" class="input-control" placeholder="Məsələn: 123456789012345678" />
          </div>
          <div class="field-group">
            <label class="field-label" for="wlDurationSelect">Whitelist Vaxtı</label>
            <select id="wlDurationSelect" class="select-control">
              <option value="lifetime">Lifetime (Sonsuz)</option>
              <option value="1m">1 Month (30 Gün)</option>
              <option value="7d">7 Day (7 Gün)</option>
              <option value="3d">3 Day (3 Gün)</option>
              <option value="24h">24 Hours (24 Saat)</option>
              <option value="5h">5 Hours (5 Saat)</option>
              <option value="1h">1 Hours (1 Saat)</option>
              <option value="30m">30 Minutes (30 Dəqiqə)</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label" for="wlScriptSelect">Script (opsional)</label>
            <select id="wlScriptSelect" class="select-control"></select>
          </div>
        </div>
        <div class="btn-row">
          <button id="addWhitelistBtn" type="button" class="btn btn-teal">Whitelist-ə Əlavə Et</button>
        </div>
        <div id="whitelistBox" class="list-stack"></div>
      </div>

      <div id="subtab-blacklist" class="card" style="display:none;">
        <div class="card-heading">
          <span>Blacklist Əlavə Et</span>
        </div>
        <div class="bento-grid-2">
          <div class="field-group">
            <label class="field-label" for="blDiscordIdInput">Discord ID</label>
            <input id="blDiscordIdInput" type="text" class="input-control" placeholder="Discord User ID" />
          </div>
          <div class="field-group">
            <label class="field-label" for="blDurationSelect">Blacklist Vaxtı</label>
            <select id="blDurationSelect" class="select-control">
              <option value="lifetime">Lifetime (Sonsuz)</option>
              <option value="1m">1 Month (30 Gün)</option>
              <option value="7d">7 Day (7 Gün)</option>
              <option value="3d">3 Day (3 Gün)</option>
              <option value="24h">24 Hours (24 Saat)</option>
              <option value="5h">5 Hours (5 Saat)</option>
              <option value="1h">1 Hours (1 Saat)</option>
              <option value="30m">30 Minutes (30 Dəqiqə)</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label" for="blReasonInput">Səbəb</label>
            <input id="blReasonInput" type="text" class="input-control" placeholder="Məsələn: Key paylaşımı / Bypass" />
          </div>
        </div>
        <div class="btn-row">
          <button id="addBlacklistBtn" type="button" class="btn btn-danger">Blacklist-ə Sal</button>
        </div>
        <div id="blacklistBox" class="list-stack"></div>
      </div>

      <div id="subtab-hwid" class="card" style="display:none;">
        <div class="card-heading">
          <span>HWID Reset (İlk Cihaza Bağlanma &amp; Başqasına Kick)</span>
        </div>
        <p class="field-label">
          Reset etdikdən sonra scripti ilk işlədən cihaz/telefon HWID-ə bağlanır. Reset edilmədən başqa cihazda işlədiləndə sistem avtomatik Kick atır.
        </p>
        <div class="bento-grid-2">
          <div class="field-group">
            <label class="field-label" for="hwidTargetInput">Key Kodu və ya Discord ID</label>
            <input id="hwidTargetInput" type="text" class="input-control" placeholder="SADO-... və ya Discord ID" />
          </div>
          <div class="field-group">
            <label class="field-label" for="hwidScriptSelect">Script Seçimi (opsional)</label>
            <select id="hwidScriptSelect" class="select-control"></select>
          </div>
        </div>
        <div class="btn-row">
          <button id="resetHwidBtn" type="button" class="btn btn-gold">HWID Sıfırla</button>
        </div>
      </div>
    </section>

    <section id="section-discord" class="section-view">
      <div class="bento-grid-2">
        <div class="card">
          <div class="card-heading">
            <span>1) Join Discord &amp; 7/24 Bot Status</span>
            <span id="discordTabBotStatus" class="pill teal">7/24 Aktiv</span>
          </div>
          <p class="field-label">
            Bot 7/24 aktiv saxlanılır. Aşağıdakı düymə ilə botu sunucunuza dəvət edə bilərsiniz.
          </p>
          <div class="btn-row">
            <a id="joinDiscordBtn" href="#" target="_blank" rel="noopener noreferrer" class="btn btn-gold">
              Join Discord (Botu Dəvət Et)
            </a>
          </div>
        </div>

        <div class="card">
          <div class="card-heading">
            <span>2) Sunucu ID Bağlantısı</span>
          </div>
          <div class="field-group">
            <label class="field-label" for="guildIdInput">Discord Sunucu ID</label>
            <input
              id="guildIdInput"
              type="text"
              class="input-control"
              placeholder="Sunucu ID yazın (məs: 123456789012345678)"
            />
          </div>
          <div class="field-group">
            <label class="field-label" for="guildInviteInput">Xüsusi Dəvət Linki (opsional)</label>
            <input
              id="guildInviteInput"
              type="text"
              class="input-control"
              placeholder="https://discord.gg/..."
            />
          </div>
          <div class="record-row">
            <div>
              <div class="field-label">Tapılan Sunucu Adı</div>
              <div id="resolvedGuildNameText" style="font-size:15px;font-weight:900;color:#fbbf24;">Seçilməyib</div>
            </div>
            <button id="saveGuildConfigBtn" type="button" class="btn btn-teal">Sunucunu Bağla</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-heading">
          <span>3) Panel Dizayn (Ad, Emoji, Rəng, Sıra &amp; Canlı Panel)</span>
        </div>

        <div class="bento-grid-2">
          <div class="field-group">
            <label class="field-label" for="panelTitleInput">Panel Başlığı</label>
            <input id="panelTitleInput" type="text" class="input-control" />
          </div>
          <div class="field-group">
            <label class="field-label" for="panelColorInput">Embed Rəngi (HEX)</label>
            <input id="panelColorInput" type="color" class="input-control" style="height:44px;padding:4px;" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="panelDescInput">Panel Təsviri</label>
          <textarea id="panelDescInput" class="textarea-control" style="min-height:85px;"></textarea>
        </div>

        <div class="field-group">
          <div class="field-label">Panel Butonları (Ad, Emoji, Rəng, Aktivlik və Sıra — Yuxarı/Aşağı)</div>
          <div id="panelButtonsEditor" class="list-stack"></div>
        </div>

        <div class="btn-row">
          <button id="savePanelDesignBtn" type="button" class="btn btn-gold">Panel Dizaynını Yadda Saxla</button>
        </div>
      </div>
    </section>

    <section id="section-panel_send" class="section-view">
      <div class="card">
        <div class="card-heading">
          <span>Mövcud Script Seç və Discord Kanalına Panel Göndər</span>
        </div>

        <div class="bento-grid-2">
          <div class="field-group">
            <label class="field-label" for="sendPanelScriptSelect">Mövcud Scriptlər</label>
            <select id="sendPanelScriptSelect" class="select-control"></select>
          </div>
          <div class="field-group">
            <label class="field-label" for="sendPanelChannelInput">Discord Kanal ID</label>
            <input
              id="sendPanelChannelInput"
              type="text"
              class="input-control"
              placeholder="Panel göndəriləcək kanalın ID-si"
            />
          </div>
        </div>

        <div id="selectedScriptPreviewBox" class="code-box">Script seçin...</div>

        <div class="btn-row">
          <button id="sendPanelNowBtn" type="button" class="btn btn-gold">📤 Kanalа Panel Göndər</button>
        </div>
      </div>
    </section>
  </div>

  <div id="toastBanner" class="toast-banner"></div>

  <script>
    (function () {
      const state = {
        currentPage: 'overview',
        data: null,
        panelButtonsDraft: []
      };

      const showToast = (msg) => {
        const toast = document.getElementById('toastBanner');
        if (!toast) return;
        toast.textContent = String(msg || '');
        toast.classList.add('show');
        clearTimeout(window.__spToastTimer);
        window.__spToastTimer = setTimeout(() => {
          toast.classList.remove('show');
        }, 2800);
      };

      const toggleMenu = (forceOpen) => {
        const backdrop = document.getElementById('drawerBackdrop');
        if (!backdrop) return;
        const shouldOpen =
          typeof forceOpen === 'boolean' ? forceOpen : !backdrop.classList.contains('open');
        if (shouldOpen) {
          backdrop.classList.add('open');
        } else {
          backdrop.classList.remove('open');
        }
      };

      const navigateToPage = (pageName) => {
        state.currentPage = pageName;
        const sections = document.querySelectorAll('.section-view');
        sections.forEach((sec) => {
          sec.classList.toggle('active', sec.id === ('section-' + pageName));
        });

        const navButtons = document.querySelectorAll('.nav-item-btn');
        navButtons.forEach((btn) => {
          btn.classList.toggle('active', btn.getAttribute('data-page') === pageName);
        });

        toggleMenu(false);
        if (pageName === 'panel_send') {
          updatePanelSendPreview();
        }
      };

      window.__spToggleMenu = toggleMenu;
      window.__spNavigate = navigateToPage;

      const apiRequest = async (url, options = {}) => {
        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
          ...options
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          throw new Error(json.error || 'Sorğu uğursuz oldu.');
        }
        return json;
      };

      const populateScriptSelects = (scripts) => {
        const selectIds = [
          'keyScriptSelect',
          'wlScriptSelect',
          'hwidScriptSelect',
          'sendPanelScriptSelect'
        ];
        selectIds.forEach((id) => {
          const el = document.getElementById(id);
          if (!el) return;
          const prevVal = el.value;
          const allowAll = id === 'wlScriptSelect' || id === 'hwidScriptSelect';
          const optionsHtml = [];
          if (allowAll) {
            optionsHtml.push('<option value="">Bütün Scriptlər</option>');
          }
          (scripts || []).forEach((s) => {
            optionsHtml.push(`<option value="${s.id}">${escapeHtml(s.name)}</option>`);
          });
          if (optionsHtml.length === 0) {
            optionsHtml.push('<option value="">Script yoxdur</option>');
          }
          el.innerHTML = optionsHtml.join('');
          if (prevVal && Array.from(el.options).some((o) => o.value === prevVal)) {
            el.value = prevVal;
          }
        });
      };

      const escapeHtml = (str) => {
        return String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      };

      const renderPanelButtonsEditor = (buttons) => {
        state.panelButtonsDraft = (buttons || []).map((b) => ({ ...b }));
        const box = document.getElementById('panelButtonsEditor');
        if (!box) return;

        box.innerHTML = state.panelButtonsDraft
          .map((btn, idx) => {
            return `
              <div class="record-row">
                <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;">
                  <span class="pill">#${idx + 1}</span>
                  <input
                    type="text"
                    class="input-control"
                    style="width:76px;"
                    value="${escapeHtml(btn.emoji)}"
                    placeholder="Emoji"
                    onchange="window.__spEditBtn(${idx}, 'emoji', this.value)"
                  />
                  <input
                    type="text"
                    class="input-control"
                    style="width:170px;"
                    value="${escapeHtml(btn.label)}"
                    placeholder="Buton adı"
                    onchange="window.__spEditBtn(${idx}, 'label', this.value)"
                  />
                  <select
                    class="select-control"
                    style="width:130px;"
                    onchange="window.__spEditBtn(${idx}, 'style', this.value)"
                  >
                    <option value="Primary" ${btn.style === 'Primary' ? 'selected' : ''}>Mavi (Primary)</option>
                    <option value="Success" ${btn.style === 'Success' ? 'selected' : ''}>Yaşıl (Success)</option>
                    <option value="Danger" ${btn.style === 'Danger' ? 'selected' : ''}>Qırmızı (Danger)</option>
                    <option value="Secondary" ${btn.style === 'Secondary' ? 'selected' : ''}>Boz (Secondary)</option>
                  </select>
                  <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;">
                    <input
                      type="checkbox"
                      ${btn.enabled !== false ? 'checked' : ''}
                      onchange="window.__spEditBtn(${idx}, 'enabled', this.checked)"
                    />
                    Aktiv
                  </label>
                </div>
                <div class="btn-row">
                  <button type="button" class="btn btn-ghost" onclick="window.__spMoveBtn(${idx}, -1)">↑</button>
                  <button type="button" class="btn btn-ghost" onclick="window.__spMoveBtn(${idx}, 1)">↓</button>
                </div>
              </div>
            `;
          })
          .join('');
      };

      window.__spEditBtn = (index, field, val) => {
        if (!state.panelButtonsDraft[index]) return;
        state.panelButtonsDraft[index][field] = val;
      };

      window.__spMoveBtn = (index, delta) => {
        const nextIdx = index + delta;
        if (nextIdx < 0 || nextIdx >= state.panelButtonsDraft.length) return;
        const copy = [...state.panelButtonsDraft];
        const temp = copy[index];
        copy[index] = copy[nextIdx];
        copy[nextIdx] = temp;
        renderPanelButtonsEditor(copy);
      };

      const updatePanelSendPreview = () => {
        const preview = document.getElementById('selectedScriptPreviewBox');
        const sel = document.getElementById('sendPanelScriptSelect');
        if (!preview || !sel || !state.data) return;
        const found = (state.data.scripts || []).find((s) => s.id === sel.value);
        if (!found || !found.bundle) {
          preview.textContent = 'Mövcud script seçin...';
          return;
        }
        preview.textContent =
          `--- 1) SCRIPT KEY ---\n${found.bundle.scriptKeySection}\n\n` +
          `--- 2) LOADSTRING SCRIPT ---\n${found.bundle.loadstringSection}`;
      };

      const renderDashboard = (data) => {
        state.data = data;

        const guildName = data.guildConfig?.guildName || 'Seçilməyib';
        const guildId = data.guildConfig?.guildId || '';

        const headerGuildSub = document.getElementById('headerGuildSub');
        if (headerGuildSub) {
          headerGuildSub.textContent = `Qoşulan Sunucu: ${guildName}`;
        }

        const badge = document.getElementById('headerBotBadge');
        if (badge) {
          badge.textContent = `Bot: ${data.bot?.status || 'Aktiv'}`;
          badge.classList.toggle('offline', !data.bot?.online);
        }

        const statScripts = document.getElementById('statScripts');
        const statKeys = document.getElementById('statKeys');
        const statWhitelist = document.getElementById('statWhitelist');
        const statBlacklist = document.getElementById('statBlacklist');
        if (statScripts) statScripts.textContent = String(data.counts?.scripts ?? 0);
        if (statKeys) statKeys.textContent = String(data.counts?.keys ?? 0);
        if (statWhitelist) statWhitelist.textContent = String(data.counts?.whitelist ?? 0);
        if (statBlacklist) statBlacklist.textContent = String(data.counts?.blacklist ?? 0);

        const ovGuildName = document.getElementById('overviewGuildName');
        const ovGuildId = document.getElementById('overviewGuildId');
        if (ovGuildName) ovGuildName.textContent = guildName;
        if (ovGuildId) ovGuildId.textContent = `Sunucu ID: ${guildId || 'Təyin edilməyib'}`;

        const recentKeysBox = document.getElementById('overviewRecentKeys');
        if (recentKeysBox) {
          const keys = data.keys || [];
          if (keys.length === 0) {
            recentKeysBox.innerHTML = '<div class="field-label">Hələ key yaradılmayıb.</div>';
          } else {
            recentKeysBox.innerHTML = keys
              .slice(0, 8)
              .map((k) => {
                const whoProf = k.usedByProfile || k.creatorProfile || {};
                return `
                  <div class="record-row">
                    <div class="user-chip">
                      <img class="avatar-img" src="${escapeHtml(whoProf.avatarUrl || '')}" alt="avatar" />
                      <div>
                        <div style="font-weight:800;font-size:13px;">${escapeHtml(k.code)}</div>
                        <div class="field-label">
                          Yaradan: ${escapeHtml(k.creatorProfile?.globalName || k.createdByTag || 'Dashboard')} •
                          İşlədən: ${escapeHtml(k.usedByProfile?.globalName || k.usedByTag || 'Hələ işlədilməyib')} •
                          Vaxt: ${escapeHtml(k.remainingLabel || k.durationLabel || 'Lifetime')}
                        </div>
                      </div>
                    </div>
                    <span class="pill ${k.expired ? 'rose' : 'teal'}">${escapeHtml(k.durationLabel || 'Lifetime')}</span>
                  </div>
                `;
              })
              .join('');
          }
        }

        populateScriptSelects(data.scripts || []);

        const existingScriptsCount = document.getElementById('existingScriptsCount');
        if (existingScriptsCount) existingScriptsCount.textContent = String((data.scripts || []).length);

        const existingScriptsList = document.getElementById('existingScriptsList');
        if (existingScriptsList) {
          const scripts = data.scripts || [];
          if (scripts.length === 0) {
            existingScriptsList.innerHTML = '<div class="field-label">Hələ heç bir script yaradılmayıb.</div>';
          } else {
            existingScriptsList.innerHTML = scripts
              .map((s) => {
                const bundle = s.bundle || {};
                return `
                  <div class="card" style="background:#080c15;">
                    <div class="card-heading">
                      <span>📜 ${escapeHtml(s.name)}</span>
                      <span class="pill ${s.obfuscationEnabled ? 'teal' : 'rose'}">
                        Obfuscation: ${s.obfuscationEnabled ? 'AÇIQ (ULTRA)' : 'BAĞLI'}
                      </span>
                    </div>
                    <div class="code-box">${escapeHtml((bundle.scriptKeySection || '') + '\n' + (bundle.loadstringSection || ''))}</div>
                    <div class="btn-row">
                      <button
                        type="button"
                        class="btn btn-gold"
                        onclick="window.__spCopyText(${JSON.stringify((bundle.scriptKeySection || '') + '\n' + (bundle.loadstringSection || ''))})"
                      >Get Script Kopyala</button>
                      <button
                        type="button"
                        class="btn btn-teal"
                        onclick="window.__spToggleScriptObf('${s.id}', ${!s.obfuscationEnabled})"
                      >Obfuscation ${s.obfuscationEnabled ? 'Bağla' : 'Aç'}</button>
                      <button
                        type="button"
                        class="btn btn-danger"
                        onclick="window.__spDeleteScript('${s.id}')"
                      >Sil</button>
                    </div>
                  </div>
                `;
              })
              .join('');
          }
        }

        const keysListBox = document.getElementById('keysListBox');
        if (keysListBox) {
          const keys = data.keys || [];
          keysListBox.innerHTML =
            keys.length === 0
              ? '<div class="field-label">Key siyahısı boşdur.</div>'
              : keys
                  .map((k) => {
                    const prof = k.usedByProfile || k.creatorProfile || {};
                    return `
                      <div class="record-row">
                        <div class="user-chip">
                          <img class="avatar-img" src="${escapeHtml(prof.avatarUrl || '')}" alt="avatar" />
                          <div>
                            <div style="font-weight:900;font-size:13px;color:#fbbf24;">${escapeHtml(k.code)}</div>
                            <div class="field-label">
                              Script: ${escapeHtml(k.scriptName || '-')} •
                              Vaxt: ${escapeHtml(k.durationLabel)} (${escapeHtml(k.remainingLabel)}) •
                              Profil: ${escapeHtml(prof.globalName || prof.username || 'Dashboard')}
                            </div>
                          </div>
                        </div>
                        <button type="button" class="btn btn-danger" onclick="window.__spDeleteKey('${k.id}')">Sil</button>
                      </div>
                    `;
                  })
                  .join('');
        }

        const whitelistBox = document.getElementById('whitelistBox');
        if (whitelistBox) {
          const wl = data.whitelist || [];
          whitelistBox.innerHTML =
            wl.length === 0
              ? '<div class="field-label">Whitelist boşdur.</div>'
              : wl
                  .map((w) => {
                    const prof = w.profile || {};
                    return `
                      <div class="record-row">
                        <div class="user-chip">
                          <img class="avatar-img" src="${escapeHtml(prof.avatarUrl || '')}" alt="avatar" />
                          <div>
                            <div style="font-weight:800;font-size:13px;">${escapeHtml(prof.globalName || w.discordTag || w.discordId)}</div>
                            <div class="field-label">ID: ${escapeHtml(w.discordId)} • Vaxt: ${escapeHtml(w.durationLabel)} (${escapeHtml(w.remainingLabel)})</div>
                          </div>
                        </div>
                        <button type="button" class="btn btn-danger" onclick="window.__spRemoveWhitelist('${escapeHtml(w.discordId)}')">Çıxar</button>
                      </div>
                    `;
                  })
                  .join('');
        }

        const blacklistBox = document.getElementById('blacklistBox');
        if (blacklistBox) {
          const bl = data.blacklist || [];
          blacklistBox.innerHTML =
            bl.length === 0
              ? '<div class="field-label">Blacklist boşdur.</div>'
              : bl
                  .map((b) => {
                    const prof = b.profile || {};
                    return `
                      <div class="record-row">
                        <div class="user-chip">
                          <img class="avatar-img" src="${escapeHtml(prof.avatarUrl || '')}" alt="avatar" />
                          <div>
                            <div style="font-weight:800;font-size:13px;color:#fda4af;">${escapeHtml(prof.globalName || b.discordTag || b.discordId)}</div>
                            <div class="field-label">ID: ${escapeHtml(b.discordId)} • Səbəb: ${escapeHtml(b.reason)} • Vaxt: ${escapeHtml(b.durationLabel)}</div>
                          </div>
                        </div>
                        <button type="button" class="btn btn-danger" onclick="window.__spRemoveBlacklist('${escapeHtml(b.discordId)}')">Sil</button>
                      </div>
                    `;
                  })
                  .join('');
        }

        const joinBtn = document.getElementById('joinDiscordBtn');
        if (joinBtn && data.bot?.inviteUrl) {
          joinBtn.href = data.bot.inviteUrl;
        }

        const guildIdInput = document.getElementById('guildIdInput');
        const guildInviteInput = document.getElementById('guildInviteInput');
        const resolvedGuildNameText = document.getElementById('resolvedGuildNameText');
        const sendPanelChannelInput = document.getElementById('sendPanelChannelInput');

        if (guildIdInput && document.activeElement !== guildIdInput) {
          guildIdInput.value = guildId;
        }
        if (guildInviteInput && document.activeElement !== guildInviteInput) {
          guildInviteInput.value = data.guildConfig?.discordInvite || '';
        }
        if (resolvedGuildNameText) {
          resolvedGuildNameText.textContent = guildName;
        }
        if (sendPanelChannelInput && document.activeElement !== sendPanelChannelInput) {
          sendPanelChannelInput.value = data.guildConfig?.panelChannelId || '';
        }

        const panelTitleInput = document.getElementById('panelTitleInput');
        const panelColorInput = document.getElementById('panelColorInput');
        const panelDescInput = document.getElementById('panelDescInput');

        if (panelTitleInput && document.activeElement !== panelTitleInput) {
          panelTitleInput.value = data.panelDesign?.title || '';
        }
        if (panelColorInput && document.activeElement !== panelColorInput) {
          panelColorInput.value = data.panelDesign?.colorHex || '#f59e0b';
        }
        if (panelDescInput && document.activeElement !== panelDescInput) {
          panelDescInput.value = data.panelDesign?.description || '';
        }

        renderPanelButtonsEditor(data.panelDesign?.buttons || []);
        updatePanelSendPreview();
      };

      const refreshOverview = async (silent = false) => {
        try {
          const json = await apiRequest('/api/overview');
          renderDashboard(json);
        } catch (err) {
          if (!silent) {
            showToast(`Yenilənmə xətası: ${err.message}`);
          }
        }
      };

      window.__spCopyText = async (txt) => {
        try {
          await navigator.clipboard.writeText(String(txt || ''));
          showToast('Kopyalandı!');
        } catch (_e) {
          showToast('Kopyalama mümkün olmadı.');
        }
      };

      window.__spToggleScriptObf = async (scriptId, nextEnabled) => {
        try {
          await apiRequest(`/api/scripts/${encodeURIComponent(scriptId)}/obfuscation`, {
            method: 'PATCH',
            body: JSON.stringify({ obfuscationEnabled: Boolean(nextEnabled) })
          });
          showToast(`Obfuscation ${nextEnabled ? 'açıldı' : 'bağlandı'}.`);
          await refreshOverview(true);
        } catch (err) {
          showToast(err.message);
        }
      };

      window.__spDeleteScript = async (scriptId) => {
        try {
          await apiRequest(`/api/scripts/${encodeURIComponent(scriptId)}`, { method: 'DELETE' });
          showToast('Script silindi.');
          await refreshOverview(true);
        } catch (err) {
          showToast(err.message);
        }
      };

      window.__spDeleteKey = async (keyId) => {
        try {
          await apiRequest(`/api/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
          showToast('Key silindi.');
          await refreshOverview(true);
        } catch (err) {
          showToast(err.message);
        }
      };

      window.__spRemoveWhitelist = async (discordId) => {
        try {
          await apiRequest(`/api/whitelist/${encodeURIComponent(discordId)}`, { method: 'DELETE' });
          showToast('Whitelist-dən çıxarıldı.');
          await refreshOverview(true);
        } catch (err) {
          showToast(err.message);
        }
      };

      window.__spRemoveBlacklist = async (discordId) => {
        try {
          await apiRequest(`/api/blacklist/${encodeURIComponent(discordId)}`, { method: 'DELETE' });
          showToast('Blacklist-dən silindi.');
          await refreshOverview(true);
        } catch (err) {
          showToast(err.message);
        }
      };

      document.addEventListener('DOMContentLoaded', () => {
        const fileInput = document.getElementById('scriptFileInput');
        const codeInput = document.getElementById('scriptCodeInput');
        const nameInput = document.getElementById('scriptNameInput');
        const obfToggle = document.getElementById('scriptObfToggle');
        const obfLabel = document.getElementById('scriptObfLabel');

        if (obfToggle && obfLabel) {
          obfToggle.addEventListener('change', () => {
            obfLabel.textContent = obfToggle.checked ? 'AÇIQ' : 'BAĞLI';
          });
        }

        if (fileInput && codeInput) {
          fileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (nameInput && !nameInput.value.trim()) {
              nameInput.value = file.name.replace(/\.(lua|txt)$/i, '');
            }
            const reader = new FileReader();
            reader.onload = (ev) => {
              codeInput.value = String(ev.target?.result || '');
              showToast(`Fayl yükləndi: ${file.name}`);
            };
            reader.readAsText(file);
          });
        }

        const createScriptBtn = document.getElementById('createScriptBtn');
        if (createScriptBtn) {
          createScriptBtn.addEventListener('click', async () => {
            try {
              const name = String(nameInput?.value || '').trim();
              const code = String(codeInput?.value || '').trim();
              const obfuscationEnabled = Boolean(obfToggle?.checked);
              await apiRequest('/api/scripts', {
                method: 'POST',
                body: JSON.stringify({ name, code, obfuscationEnabled })
              });
              showToast('Script uğurla yaradıldı!');
              if (nameInput) nameInput.value = '';
              if (codeInput) codeInput.value = '';
              if (fileInput) fileInput.value = '';
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const clearScriptFormBtn = document.getElementById('clearScriptFormBtn');
        if (clearScriptFormBtn) {
          clearScriptFormBtn.addEventListener('click', () => {
            if (nameInput) nameInput.value = '';
            if (codeInput) codeInput.value = '';
            if (fileInput) fileInput.value = '';
          });
        }

        document.querySelectorAll('.sub-tab-btn').forEach((tabBtn) => {
          tabBtn.addEventListener('click', () => {
            const subKey = tabBtn.getAttribute('data-subtab');
            document.querySelectorAll('.sub-tab-btn').forEach((b) => b.classList.remove('active'));
            tabBtn.classList.add('active');
            ['keys', 'whitelist', 'blacklist', 'hwid'].forEach((k) => {
              const el = document.getElementById(`subtab-${k}`);
              if (el) el.style.display = k === subKey ? 'grid' : 'none';
            });
          });
        });

        const createKeyBtn = document.getElementById('createKeyBtn');
        if (createKeyBtn) {
          createKeyBtn.addEventListener('click', async () => {
            try {
              const scriptId = document.getElementById('keyScriptSelect')?.value || '';
              const durationKey = document.getElementById('keyDurationSelect')?.value || 'lifetime';
              const creatorDiscordId = document.getElementById('keyCreatorIdInput')?.value || '';
              const discordId = document.getElementById('keyUserIdInput')?.value || '';
              await apiRequest('/api/keys', {
                method: 'POST',
                body: JSON.stringify({ scriptId, durationKey, creatorDiscordId, discordId })
              });
              showToast('Yeni Key yaradıldı!');
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const addWhitelistBtn = document.getElementById('addWhitelistBtn');
        if (addWhitelistBtn) {
          addWhitelistBtn.addEventListener('click', async () => {
            try {
              const discordId = document.getElementById('wlDiscordIdInput')?.value || '';
              const durationKey = document.getElementById('wlDurationSelect')?.value || 'lifetime';
              const scriptId = document.getElementById('wlScriptSelect')?.value || '';
              await apiRequest('/api/whitelist', {
                method: 'POST',
                body: JSON.stringify({ discordId, durationKey, scriptId })
              });
              showToast('Whitelist-ə əlavə edildi!');
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const addBlacklistBtn = document.getElementById('addBlacklistBtn');
        if (addBlacklistBtn) {
          addBlacklistBtn.addEventListener('click', async () => {
            try {
              const discordId = document.getElementById('blDiscordIdInput')?.value || '';
              const durationKey = document.getElementById('blDurationSelect')?.value || 'lifetime';
              const reason = document.getElementById('blReasonInput')?.value || 'Qayda pozuntusu';
              await apiRequest('/api/blacklist', {
                method: 'POST',
                body: JSON.stringify({ discordId, durationKey, reason })
              });
              showToast('Blacklist-ə əlavə edildi!');
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const resetHwidBtn = document.getElementById('resetHwidBtn');
        if (resetHwidBtn) {
          resetHwidBtn.addEventListener('click', async () => {
            try {
              const target = document.getElementById('hwidTargetInput')?.value || '';
              const scriptId = document.getElementById('hwidScriptSelect')?.value || '';
              const res = await apiRequest('/api/hwid/reset', {
                method: 'POST',
                body: JSON.stringify({ target, scriptId })
              });
              showToast(`HWID sıfırlandı (${res.resetCount} qeyd).`);
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const saveGuildConfigBtn = document.getElementById('saveGuildConfigBtn');
        if (saveGuildConfigBtn) {
          saveGuildConfigBtn.addEventListener('click', async () => {
            try {
              const guildId = document.getElementById('guildIdInput')?.value || '';
              const discordInvite = document.getElementById('guildInviteInput')?.value || '';
              await apiRequest('/api/discord/config', {
                method: 'POST',
                body: JSON.stringify({ guildId, discordInvite })
              });
              showToast('Sunucu bağlantısı yeniləndi!');
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const savePanelDesignBtn = document.getElementById('savePanelDesignBtn');
        if (savePanelDesignBtn) {
          savePanelDesignBtn.addEventListener('click', async () => {
            try {
              const title = document.getElementById('panelTitleInput')?.value || '';
              const colorHex = document.getElementById('panelColorInput')?.value || '#f59e0b';
              const description = document.getElementById('panelDescInput')?.value || '';
              await apiRequest('/api/panel/design', {
                method: 'POST',
                body: JSON.stringify({
                  title,
                  colorHex,
                  description,
                  buttons: state.panelButtonsDraft
                })
              });
              showToast('Panel dizaynı yadda saxlandı!');
              await refreshOverview(true);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        const sendPanelScriptSelect = document.getElementById('sendPanelScriptSelect');
        if (sendPanelScriptSelect) {
          sendPanelScriptSelect.addEventListener('change', updatePanelSendPreview);
        }

        const sendPanelNowBtn = document.getElementById('sendPanelNowBtn');
        if (sendPanelNowBtn) {
          sendPanelNowBtn.addEventListener('click', async () => {
            try {
              const scriptId = document.getElementById('sendPanelScriptSelect')?.value || '';
              const channelId = document.getElementById('sendPanelChannelInput')?.value || '';
              const res = await apiRequest('/api/panel/send', {
                method: 'POST',
                body: JSON.stringify({ scriptId, channelId })
              });
              showToast(`Panel göndərildi: ${res.result?.scriptName || 'Script'}`);
            } catch (err) {
              showToast(err.message);
            }
          });
        }

        refreshOverview(false);
        setInterval(() => refreshOverview(true), 8000);
      });
    })();
  </script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.status(200).type('html').send(DASHBOARD_HTML);
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[WEB] SADO PROTECT http://0.0.0.0:${PORT} ünvanında işləyir`);
  const loaded = await loadStore();
  const watchdog = startWatchdog();
  const keepAlive = startRenderKeepAlive();
  const initialLogin = await ensureBotOnline();
  return { loaded, watchdog, keepAlive, initialLogin };
});
