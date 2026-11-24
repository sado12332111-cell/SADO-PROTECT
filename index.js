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
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  Events,
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_BACKUPS = 5;

const TOKEN_PARTS = [
  'MTU2MjA4MDY1NDI4MjE5OTEyMQ',
  'GezNfm',
  'uOsxre1d-X2aUXZ55ua1vaumADoI-JbvNxXOg0',
];
const BOT_TOKEN = String(
  process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || TOKEN_PARTS.join('.')
).trim();
const DEFAULT_INVITE_URL = 'https://discord.gg/sado-protect';

const DEFAULT_PANEL_CONFIG = {
  embedColor: '#10b981',
  title: 'SADO PROTECT • Script Panel',
  description:
    'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin.',
  redeemLabel: 'Redeem Key',
  redeemStyle: 'Success',
  getScriptLabel: 'Get Script',
  getScriptStyle: 'Primary',
  resetHwidLabel: 'Reset HWID',
  resetHwidStyle: 'Danger',
  statsLabel: 'Get Stats',
  statsStyle: 'Secondary',
  footerText: 'SADO PROTECT • Secure Loader & Key System',
  imageUrl: '',
  thumbnailUrl: '',
};

const DEFAULT_SCRIPT_CODE = [
  'local Players = game:GetService("Players")',
  'local LocalPlayer = Players.LocalPlayer',
  'print("[SADO PROTECT] Verified & Loaded for:", LocalPlayer and LocalPlayer.Name or "Player")',
].join('\n');

const createDefaultWorkspaceState = () => ({
  guildId: '',
  guildName: '',
  discordUserId: '',
  inviteUrl: DEFAULT_INVITE_URL,
  panelConfig: { ...DEFAULT_PANEL_CONFIG },
  scripts: [
    {
      id: 'sado-hub',
      name: 'SADO HUB',
      loaderToken: 'sado_hub_loader',
      code: DEFAULT_SCRIPT_CODE,
      createdAt: new Date().toISOString(),
    },
  ],
  keys: [],
  whitelists: [],
  blacklist: [],
  panels: [],
  stats: {
    redeems: 0,
    scriptFetches: 0,
    hwidResets: 0,
    authSuccess: 0,
    authBlocked: 0,
  },
});

const createRootStore = () => ({
  activeWorkspaceId: 'default',
  workspaces: {
    default: createDefaultWorkspaceState(),
  },
});

const runtimeState = {
  store: createRootStore(),
  isSavingStore: false,
  pendingSave: false,
  isConnectingNow: false,
  lastConnectAttempt: 0,
  commandsRegistered: false,
  watchdogStarted: false,
  keepAliveStarted: false,
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const sanitizeWorkspaceId = (raw) => {
  if (!raw || typeof raw !== 'string') return 'default';
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'default';
};

const ensureWorkspace = (wsId) => {
  const safeId = sanitizeWorkspaceId(wsId);
  if (!runtimeState.store.workspaces || typeof runtimeState.store.workspaces !== 'object') {
    runtimeState.store.workspaces = { default: createDefaultWorkspaceState() };
  }
  if (!runtimeState.store.workspaces[safeId]) {
    runtimeState.store.workspaces[safeId] = createDefaultWorkspaceState();
  }
  const ws = runtimeState.store.workspaces[safeId];
  ws.guildId = String(ws.guildId || '').trim();
  ws.guildName = String(ws.guildName || '').trim();
  ws.discordUserId = String(ws.discordUserId || '').trim();
  ws.inviteUrl = String(ws.inviteUrl || DEFAULT_INVITE_URL).trim() || DEFAULT_INVITE_URL;
  ws.panelConfig = { ...DEFAULT_PANEL_CONFIG, ...(ws.panelConfig || {}) };
  if (!Array.isArray(ws.scripts) || !ws.scripts.length) {
    ws.scripts = createDefaultWorkspaceState().scripts;
  }
  ws.keys = Array.isArray(ws.keys) ? ws.keys : [];
  ws.whitelists = Array.isArray(ws.whitelists) ? ws.whitelists : [];
  ws.blacklist = Array.isArray(ws.blacklist) ? ws.blacklist : [];
  ws.panels = Array.isArray(ws.panels) ? ws.panels : [];
  ws.stats = {
    redeems: Number(ws.stats && ws.stats.redeems) || 0,
    scriptFetches: Number(ws.stats && ws.stats.scriptFetches) || 0,
    hwidResets: Number(ws.stats && ws.stats.hwidResets) || 0,
    authSuccess: Number(ws.stats && ws.stats.authSuccess) || 0,
    authBlocked: Number(ws.stats && ws.stats.authBlocked) || 0,
  };
  return ws;
};

const getWorkspaceFromReq = (req) => {
  const headerWs = req.headers['x-client-workspace'];
  const queryWs = req.query && req.query.ws;
  const bodyWs = req.body && req.body.workspaceId;
  const wsId = sanitizeWorkspaceId(
    headerWs || queryWs || bodyWs || runtimeState.store.activeWorkspaceId || 'default'
  );
  return { wsId, ws: ensureWorkspace(wsId) };
};

const getAllWorkspacesList = () => {
  const keys = Object.keys(runtimeState.store.workspaces || {});
  if (!keys.length) return [{ wsId: 'default', ws: ensureWorkspace('default') }];
  return keys.map((k) => ({ wsId: k, ws: ensureWorkspace(k) }));
};

const findWorkspaceByGuildId = (guildId) => {
  if (!guildId) return null;
  for (const item of getAllWorkspacesList()) {
    if (String(item.ws.guildId || '').trim() === String(guildId).trim()) {
      return item;
    }
  }
  return null;
};

const findWorkspaceByDiscordUser = (discordUserId) => {
  if (!discordUserId) return null;
  for (const item of getAllWorkspacesList()) {
    if (String(item.ws.discordUserId || '').trim() === String(discordUserId).trim()) {
      return item;
    }
  }
  return null;
};

const resolveWorkspaceForDiscord = ({ guildId, discordUserId, scriptId }) => {
  const byGuild = findWorkspaceByGuildId(guildId);
  if (byGuild) return byGuild;

  if (scriptId) {
    for (const item of getAllWorkspacesList()) {
      if (item.ws.scripts.some((s) => s.id === scriptId || s.loaderToken === scriptId)) {
        return item;
      }
    }
  }

  const byUser = findWorkspaceByDiscordUser(discordUserId);
  if (byUser) return byUser;

  const defId = sanitizeWorkspaceId(runtimeState.store.activeWorkspaceId || 'default');
  return { wsId: defId, ws: ensureWorkspace(defId) };
};

const migrateLegacyData = (raw) => {
  if (!raw || typeof raw !== 'object') return createRootStore();
  if (raw.workspaces && typeof raw.workspaces === 'object') {
    const root = createRootStore();
    root.activeWorkspaceId = sanitizeWorkspaceId(raw.activeWorkspaceId || 'default');
    for (const [k, v] of Object.entries(raw.workspaces)) {
      root.workspaces[sanitizeWorkspaceId(k)] = {
        ...createDefaultWorkspaceState(),
        ...(v || {}),
      };
    }
    ensureWorkspace(root.activeWorkspaceId);
    return root;
  }
  const root = createRootStore();
  root.workspaces.default = {
    ...createDefaultWorkspaceState(),
    ...raw,
  };
  ensureWorkspace('default');
  return root;
};

const saveStore = async () => {
  if (runtimeState.isSavingStore) {
    runtimeState.pendingSave = true;
    return false;
  }
  runtimeState.isSavingStore = true;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const serialized = JSON.stringify(runtimeState.store, null, 2);
    const tmpFile = `${STORE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmpFile, serialized, 'utf8');
    await fsp.rename(tmpFile, STORE_FILE);

    const backupFile = path.join(DATA_DIR, `store.bak.${Date.now()}.json`);
    await fsp.writeFile(backupFile, serialized, 'utf8').catch(() => {});
    const entries = await fsp.readdir(DATA_DIR);
    const baks = entries
      .filter((f) => f.startsWith('store.bak.') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const oldBak of baks.slice(MAX_BACKUPS)) {
      await fsp.unlink(path.join(DATA_DIR, oldBak)).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('[STORE] Saxlama xətası:', err && err.message ? err.message : err);
    return false;
  } finally {
    runtimeState.isSavingStore = false;
    if (runtimeState.pendingSave) {
      runtimeState.pendingSave = false;
      saveStore().catch(() => {});
    }
  }
};

const loadStore = async () => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const content = await fsp.readFile(STORE_FILE, 'utf8');
      runtimeState.store = migrateLegacyData(JSON.parse(content));
      await saveStore();
      return true;
    }
    const entries = await fsp.readdir(DATA_DIR);
    const baks = entries
      .filter((f) => f.startsWith('store.bak.') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const bak of baks) {
      try {
        const bakContent = await fsp.readFile(path.join(DATA_DIR, bak), 'utf8');
        runtimeState.store = migrateLegacyData(JSON.parse(bakContent));
        await saveStore();
        return true;
      } catch (_e) {}
    }
    runtimeState.store = createRootStore();
    await saveStore();
    return true;
  } catch (err) {
    console.error('[STORE] Yükləmə xətası:', err && err.message ? err.message : err);
    runtimeState.store = createRootStore();
    return false;
  }
};

const isExpired = (expiresAt) => {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return !Number.isNaN(ts) && Date.now() > ts;
};

const parseDurationToMs = (durationInput) => {
  if (!durationInput) return null;
  const str = String(durationInput).trim().toLowerCase();
  if (!str || str === 'lifetime' || str === 'perm' || str === 'unlimited' || str === '0') {
    return null;
  }
  const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day|w|wk)?$/);
  if (!match) {
    const num = Number(str);
    if (!Number.isNaN(num) && num > 0) return num * 86400000;
    return null;
  }
  const val = Number(match[1]);
  const unit = match[2] || 'd';
  if (unit.startsWith('s')) return val * 1000;
  if (unit.startsWith('m')) return val * 60000;
  if (unit.startsWith('h')) return val * 3600000;
  if (unit.startsWith('w')) return val * 604800000;
  return val * 86400000;
};

const generateRandomKeyCode = () => {
  const part1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SADO-${part1}-${part2}`;
};

const slugifyId = (name, fallbackPrefix = 'item') => {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const suffix = crypto.randomBytes(2).toString('hex');
  return base ? `${base}-${suffix}` : `${fallbackPrefix}-${suffix}`;
};

const normalizeHexColor = (hex) => {
  if (!hex || typeof hex !== 'string') return '#10b981';
  const trimmed = hex.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash : '#10b981';
};

const mapButtonStyle = (styleName, fallbackStyle) => {
  const map = {
    Success: ButtonStyle.Success,
    Primary: ButtonStyle.Primary,
    Danger: ButtonStyle.Danger,
    Secondary: ButtonStyle.Secondary,
  };
  return map[String(styleName || '').trim()] || fallbackStyle;
};

const obfuscateLuaCode = (sourceCode, level = 2) => {
  const cleanCode = String(sourceCode || DEFAULT_SCRIPT_CODE);
  const bytes = Array.from(Buffer.from(cleanCode, 'utf8'));
  const keyByte = (crypto.randomBytes(1)[0] % 120) + 17;
  const xored = bytes.map((b, idx) => ((b ^ ((keyByte + idx) % 255)) % 256));
  const hexStream = xored.map((n) => `\\${n}`).join('');
  const varData = `_s_${crypto.randomBytes(2).toString('hex')}`;
  const varKey = `_k_${crypto.randomBytes(2).toString('hex')}`;
  const varOut = `_o_${crypto.randomBytes(2).toString('hex')}`;

  if (Number(level) >= 3) {
    const chunkSize = 18;
    const chunks = [];
    for (let i = 0; i < xored.length; i += chunkSize) {
      const part = xored.slice(i, i + chunkSize).join(',');
      chunks.push(`{${part}}`);
    }
    return [
      '--[[ SADO PROTECT ULTRA LUA VM ]]--',
      `local ${varKey} = ${keyByte}`,
      `local ${varData} = {${chunks.join(',')}}`,
      `local ${varOut} = {}`,
      `for _b = 1, #${varData} do`,
      `  for _i = 1, #${varData}[_b] do`,
      `    local _idx = ((_b - 1) * ${chunkSize}) + _i - 1`,
      `    local _val = bit32 and bit32.bxor(${varData}[_b][_i], (${varKey} + _idx) % 255) or (${varData}[_b][_i] - ((${varKey} + _idx) % 255))`,
      `    table.insert(${varOut}, string.char(_val))`,
      `  end`,
      `end`,
      `local _fn = (loadstring or load)(table.concat(${varOut}))`,
      `if type(_fn) == "function" then return _fn() end`,
    ].join('\n');
  }

  if (Number(level) === 1) {
    const b64 = Buffer.from(cleanCode, 'utf8').toString('base64');
    return [
      '--[[ SADO PROTECT LITE ]]--',
      `local _b = "${b64}"`,
      'local _chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"',
      'local function _dec(data)',
      '  data = string.gsub(data, "[^".._chars.."=]", "")',
      '  return (data:gsub(".", function(x)',
      '    if (x == "=") then return "" end',
      '    local r,f="",(_chars:find(x,1,1)-1)',
      '    for i=6,1,-1 do r=r..(f%2^i-f%2^(i-1)>0 and "1" or "0") end',
      '    return r;',
      '  end):gsub("%d%d%d?%d?%d?%d?%d?%d?", function(x)',
      '    if (#x ~= 8) then return "" end',
      '    local c=0',
      '    for i=1,8 do c=c+(x:sub(i,i)=="1" and 2^(8-i) or 0) end',
      '    return string.char(c)',
      '  end))',
      'end',
      'local _fn = (loadstring or load)(_dec(_b))',
      'if type(_fn) == "function" then return _fn() end',
    ].join('\n');
  }

  return [
    '--[[ SADO PROTECT PRO SHIELD ]]--',
    `local ${varKey} = ${keyByte}`,
    `local _raw = "${hexStream}"`,
    `local ${varOut} = {}`,
    `for _i = 1, #_raw do`,
    `  local _c = string.byte(_raw, _i)`,
    `  local _d = bit32 and bit32.bxor(_c, (${varKey} + (_i - 1)) % 255) or _c`,
    `  table.insert(${varOut}, string.char(_d))`,
    `end`,
    `local _fn = (loadstring or load)(table.concat(${varOut}))`,
    `if type(_fn) == "function" then return _fn() end`,
  ].join('\n');
};

const lookupGuildInfo = async (guildId, discordUserId) => {
  const cleanGuildId = String(guildId || '').trim();
  const cleanUserId = String(discordUserId || '').trim();
  const botGuilds = [];
  if (client && client.guilds && client.guilds.cache) {
    client.guilds.cache.forEach((g) => {
      botGuilds.push({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount || 0,
      });
    });
  }

  let resolvedName = '';
  let resolvedGuildId = cleanGuildId;

  if (cleanGuildId) {
    const cached = client && client.guilds && client.guilds.cache ? client.guilds.cache.get(cleanGuildId) : null;
    if (cached && cached.name) {
      resolvedName = cached.name;
    } else if (BOT_TOKEN && /^\d{15,22}$/.test(cleanGuildId)) {
      try {
        const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
        const guildData = await rest.get(Routes.guild(cleanGuildId));
        if (guildData && guildData.name) {
          resolvedName = guildData.name;
        }
      } catch (_e) {}
    }
  }

  if (!resolvedName && cleanUserId && client && client.guilds && client.guilds.cache) {
    for (const [, g] of client.guilds.cache) {
      if (g.ownerId === cleanUserId) {
        resolvedName = g.name;
        if (!resolvedGuildId) resolvedGuildId = g.id;
        break;
      }
    }
  }

  if (!resolvedName && cleanGuildId) {
    resolvedName = `Server (${cleanGuildId})`;
  }

  return {
    guildId: resolvedGuildId,
    guildName: resolvedName,
    guilds: botGuilds,
  };
};

const resolveDiscordUsername = async (discordUserId) => {
  const cleanId = String(discordUserId || '').trim();
  if (!cleanId) return 'Unknown';
  if (client && client.users && client.users.cache) {
    const u = client.users.cache.get(cleanId);
    if (u && (u.globalName || u.username)) {
      return u.globalName || u.username;
    }
  }
  if (BOT_TOKEN && /^\d{15,22}$/.test(cleanId)) {
    try {
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      const userObj = await rest.get(Routes.user(cleanId));
      if (userObj && (userObj.global_name || userObj.username)) {
        return userObj.global_name || userObj.username;
      }
    } catch (_e) {}
  }
  return `User_${cleanId.slice(-4)}`;
};

const buildPublicBaseUrl = (req) => {
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  }
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${req.headers.host}`;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
  }
  return `http://localhost:${PORT}`;
};

const buildLoaderSnippet = (wsId, sc, wl, baseUrl) => {
  const keyVal = wl && wl.key ? wl.key : 'YOUR_KEY';
  const loaderUrl = `${baseUrl}/loader/${encodeURIComponent(sc.loaderToken || sc.id)}?ws=${encodeURIComponent(wsId)}`;
  return [
    `script_key = "${keyVal}"`,
    `loadstring(game:HttpGet("${loaderUrl}"))()`,
  ].join('\n');
};

const buildPanelEmbedAndButtons = (ws, sc) => {
  const cfg = { ...DEFAULT_PANEL_CONFIG, ...(ws.panelConfig || {}) };
  const scriptName = sc ? sc.name : 'SADO HUB';
  const scriptId = sc ? sc.id : 'default';

  const embed = new EmbedBuilder()
    .setColor(normalizeHexColor(cfg.embedColor))
    .setTitle(cfg.title || DEFAULT_PANEL_CONFIG.title)
    .setDescription(
      `${cfg.description || DEFAULT_PANEL_CONFIG.description}\n\n📌 **Script:** \`${scriptName}\``
    )
    .setFooter({ text: `${cfg.footerText || DEFAULT_PANEL_CONFIG.footerText} • ${scriptName}` })
    .setTimestamp();

  if (cfg.imageUrl && /^https?:\/\//i.test(cfg.imageUrl.trim())) {
    embed.setImage(cfg.imageUrl.trim());
  }
  if (cfg.thumbnailUrl && /^https?:\/\//i.test(cfg.thumbnailUrl.trim())) {
    embed.setThumbnail(cfg.thumbnailUrl.trim());
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sado_redeem_${scriptId}`)
      .setLabel(cfg.redeemLabel || 'Redeem Key')
      .setEmoji('🔑')
      .setStyle(mapButtonStyle(cfg.redeemStyle, ButtonStyle.Success)),
    new ButtonBuilder()
      .setCustomId(`sado_getscript_${scriptId}`)
      .setLabel(cfg.getScriptLabel || 'Get Script')
      .setEmoji('📜')
      .setStyle(mapButtonStyle(cfg.getScriptStyle, ButtonStyle.Primary)),
    new ButtonBuilder()
      .setCustomId(`sado_resethwid_${scriptId}`)
      .setLabel(cfg.resetHwidLabel || 'Reset HWID')
      .setEmoji('⚙️')
      .setStyle(mapButtonStyle(cfg.resetHwidStyle, ButtonStyle.Danger)),
    new ButtonBuilder()
      .setCustomId(`sado_stats_${scriptId}`)
      .setLabel(cfg.statsLabel || 'Get Stats')
      .setEmoji('📊')
      .setStyle(mapButtonStyle(cfg.statsStyle, ButtonStyle.Secondary))
  );

  return { embed, row };
};

const refreshExistingDiscordPanels = async (ws) => {
  if (!BOT_TOKEN || !ws || !Array.isArray(ws.panels) || !ws.panels.length) return false;
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const seen = new Set();
  for (const pnl of ws.panels) {
    try {
      if (!pnl || !pnl.channelId || !pnl.messageId) continue;
      const key = `${pnl.channelId}:${pnl.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sc = ws.scripts.find((s) => s.id === pnl.scriptId) || ws.scripts[0];
      const { embed, row } = buildPanelEmbedAndButtons(ws, sc);
      await rest.patch(Routes.channelMessage(pnl.channelId, pnl.messageId), {
        body: {
          content: '',
          embeds: [embed.toJSON()],
          components: [row.toJSON()],
        },
      });
    } catch (_e) {}
  }
  return true;
};

const refreshAllWorkspacesDiscordPanels = async () => {
  if (!BOT_TOKEN) return false;
  const all = getAllWorkspacesList();
  for (const item of all) {
    await refreshExistingDiscordPanels(item.ws);
  }
  return true;
};

const registerSlashCommands = async () => {
  if (!BOT_TOKEN) return false;
  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Skript key & loader panelini kanala göndər')
      .addStringOption((opt) =>
        opt
          .setName('script')
          .setDescription('Panelin bağlı olacağı skript')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('title')
          .setDescription('Panel başlığı')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('genkey')
      .setDescription('Yeni lisenziya key-i yaradır')
      .addStringOption((opt) =>
        opt
          .setName('script')
          .setDescription('Key-in aid olduğu skript')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription('Müddət (məs: 1d, 7d, 30d, lifetime)')
          .setRequired(false)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('amount')
          .setDescription('Yaradılacaq key sayı (1-25)')
          .setMinValue(1)
          .setMaxValue(25)
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('İstifadəçini birbaşa whitelist-ə əlavə edir')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('script')
          .setDescription('Skript')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('duration').setDescription('Müddət (məs: 7d, 30d, lifetime)').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('unwhitelist')
      .setDescription('İstifadəçini whitelist-dən çıxarır')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('script')
          .setDescription('Skript (boş buraxılsa hamısı)')
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName('resethwid')
      .setDescription('İstifadəçinin HWID kilidini sıfırlayır')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('script')
          .setDescription('Skript (boş buraxılsa hamısı)')
          .setRequired(false)
          .setAutocomplete(true)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const appId = client.application && client.application.id ? client.application.id : null;
  if (!appId) return false;

  await rest.put(Routes.applicationCommands(appId), { body: commands });

  for (const item of getAllWorkspacesList()) {
    if (item.ws.guildId && /^\d{15,22}$/.test(String(item.ws.guildId).trim())) {
      await rest
        .put(Routes.applicationGuildCommands(appId, String(item.ws.guildId).trim()), { body: commands })
        .catch(() => {});
    }
  }
  runtimeState.commandsRegistered = true;
  return true;
};

const ensureBotOnline = async () => {
  if (!BOT_TOKEN) {
    console.warn('[BOT] BOT_TOKEN tapılmadı.');
    return false;
  }
  if (client.isReady()) return true;
  if (runtimeState.isConnectingNow) return false;
  const now = Date.now();
  if (now - runtimeState.lastConnectAttempt < 5000) return false;
  runtimeState.isConnectingNow = true;
  runtimeState.lastConnectAttempt = now;
  try {
    await client.login(BOT_TOKEN);
    return Boolean(client.isReady());
  } catch (err) {
    console.error('[BOT] Login xətası:', err && err.message ? err.message : err);
    return false;
  } finally {
    runtimeState.isConnectingNow = false;
  }
};

const pingUrlQuietly = (targetUrl) =>
  new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const clientLib = parsed.protocol === 'https:' ? https : http;
      const req = clientLib.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          timeout: 8000,
          headers: { 'User-Agent': 'SADO-PROTECT-7x24-KeepAlive' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode || 200);
        }
      );
      req.on('error', () => resolve(0));
      req.on('timeout', () => {
        req.destroy();
        resolve(0);
      });
    } catch (_e) {
      resolve(0);
    }
  });

const startRenderKeepAlive = () => {
  if (runtimeState.keepAliveStarted) return true;
  runtimeState.keepAliveStarted = true;
  const targets = Array.from(
    new Set(
      [
        process.env.RENDER_EXTERNAL_URL,
        process.env.PUBLIC_BASE_URL,
        'https://sado-protect.onrender.com',
        `http://127.0.0.1:${PORT}/health`,
      ]
        .filter(Boolean)
        .map((u) => String(u).trim())
    )
  );
  const pulse = async () => {
    try {
      for (const base of targets) {
        const healthUrl = base.endsWith('/health') ? base : `${base.replace(/\/+$/, '')}/health`;
        await pingUrlQuietly(healthUrl);
      }
    } catch (_e) {}
  };

  setTimeout(pulse, 15000);
  setInterval(pulse, 45000);
  return true;
};

const startWatchdog = () => {
  if (runtimeState.watchdogStarted) return true;
  runtimeState.watchdogStarted = true;
  setInterval(async () => {
    try {
      if (!client.isReady() && !runtimeState.isConnectingNow) {
        await ensureBotOnline();
      }
      if (client.isReady() && !runtimeState.commandsRegistered) {
        await registerSlashCommands().catch(() => {});
      }
    } catch (_e) {}
  }, 15000);
  return true;
};

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BOT] ${readyClient.user.tag} aktivdir!`);
  runtimeState.commandsRegistered = false;
  await registerSlashCommands().catch((err) => {
    console.error('[BOT] Slash command qeydiyyat xətası:', err && err.message ? err.message : err);
  });
  await refreshAllWorkspacesDiscordPanels().catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      const { ws } = resolveWorkspaceForDiscord({
        guildId: interaction.guildId,
        discordUserId: interaction.user && interaction.user.id,
      });
      const query = String(focused && focused.value ? focused.value : '').toLowerCase();
      const choices = (ws.scripts || [])
        .filter((s) => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query))
        .slice(0, 25)
        .map((s) => ({ name: `${s.name} (${s.id})`, value: s.id }));
      await interaction.respond(choices).catch(() => {});
      return;
    }

    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      const guildId = interaction.guildId || '';
      const guildName = interaction.guild && interaction.guild.name ? interaction.guild.name : '';
      const invokerId = interaction.user.id;
      const invokerName = interaction.user.globalName || interaction.user.username || invokerId;
      const selectedScriptArg = interaction.options.getString('script') || '';
      const { wsId, ws } = resolveWorkspaceForDiscord({
        guildId,
        discordUserId: invokerId,
        scriptId: selectedScriptArg,
      });

      if (guildId && !ws.guildId) ws.guildId = guildId;
      if (guildName && !ws.guildName) ws.guildName = guildName;

      if (cmd === 'panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const customTitle = interaction.options.getString('title');
        const sc =
          ws.scripts.find((s) => s.id === selectedScriptArg || s.loaderToken === selectedScriptArg) ||
          ws.scripts[0];

        if (!sc) {
          await interaction.editReply({ content: '❌ Bu workspace-də skript tapılmadı.' });
          return;
        }

        const panelWs = customTitle
          ? { ...ws, panelConfig: { ...ws.panelConfig, title: customTitle } }
          : ws;
        const { embed, row } = buildPanelEmbedAndButtons(panelWs, sc);

        let sentMsg = null;
        if (interaction.channel && typeof interaction.channel.send === 'function') {
          sentMsg = await interaction.channel.send({ embeds: [embed], components: [row] });
        } else if (interaction.channelId) {
          const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
          sentMsg = await rest.post(Routes.channelMessages(interaction.channelId), {
            body: { embeds: [embed.toJSON()], components: [row.toJSON()] },
          });
        }

        if (sentMsg) {
          ws.panels.push({
            id: crypto.randomUUID(),
            channelId: interaction.channelId || sentMsg.channel_id || '',
            messageId: sentMsg.id,
            scriptId: sc.id,
            title: customTitle || ws.panelConfig.title,
            createdAt: new Date().toISOString(),
          });
          await saveStore();
        }

        await interaction.editReply({
          content: `✅ **${sc.name}** skripti üçün panel göndərildi!`,
        });
        return;
      }

      if (cmd === 'genkey') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const durationStr = interaction.options.getString('duration') || 'lifetime';
        const amount = Math.min(25, Math.max(1, interaction.options.getInteger('amount') || 1));
        const sc =
          ws.scripts.find((s) => s.id === selectedScriptArg || s.loaderToken === selectedScriptArg) ||
          ws.scripts[0];
        const durMs = parseDurationToMs(durationStr);
        const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

        const created = [];
        for (let i = 0; i < amount; i++) {
          const newKey = {
            key: generateRandomKeyCode(),
            scriptId: sc ? sc.id : 'default',
            scriptName: sc ? sc.name : 'SADO HUB',
            duration: durationStr,
            expiresAt,
            used: false,
            createdByDiscordId: invokerId,
            createdByName: invokerName,
            usedByDiscordId: null,
            usedByName: null,
            createdAt: new Date().toISOString(),
          };
          ws.keys.unshift(newKey);
          created.push(newKey);
        }
        await saveStore();

        const keyLines = created.map(
          (k) => `• \`${k.key}\` — **${k.scriptName}** (${k.duration})`
        );
        await interaction.editReply({
          content: `🔑 **${created.length} ədəd key yaradıldı:**\n${keyLines.join('\n')}`,
        });
        return;
      }

      if (cmd === 'whitelist') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('user');
        const durationStr = interaction.options.getString('duration') || 'lifetime';
        const sc =
          ws.scripts.find((s) => s.id === selectedScriptArg || s.loaderToken === selectedScriptArg) ||
          ws.scripts[0];
        const durMs = parseDurationToMs(durationStr);
        const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

        const existingIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === targetUser.id && w.scriptId === (sc ? sc.id : 'default')
        );
        const entry = {
          id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
          discordUserId: targetUser.id,
          username: targetUser.globalName || targetUser.username,
          addedByDiscordId: invokerId,
          addedByName: invokerName,
          scriptId: sc ? sc.id : 'default',
          key:
            existingIdx >= 0 && ws.whitelists[existingIdx].key
              ? ws.whitelists[existingIdx].key
              : generateRandomKeyCode(),
          hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
          hwidLocked: existingIdx >= 0 ? ws.whitelists[existingIdx].hwidLocked !== false : true,
          expiresAt,
          createdAt: new Date().toISOString(),
        };

        if (existingIdx >= 0) {
          ws.whitelists[existingIdx] = entry;
        } else {
          ws.whitelists.unshift(entry);
        }
        await saveStore();

        await interaction.editReply({
          content: `✅ <@${targetUser.id}> (**${sc ? sc.name : 'SADO HUB'}**) whitelist-ə əlavə olundu. Key: \`${entry.key}\``,
        });
        return;
      }

      if (cmd === 'unwhitelist') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('user');
        const beforeCount = ws.whitelists.length;
        ws.whitelists = ws.whitelists.filter((w) => {
          if (w.discordUserId !== targetUser.id) return true;
          if (!selectedScriptArg) return false;
          return w.scriptId !== selectedScriptArg;
        });
        const removed = beforeCount - ws.whitelists.length;
        await saveStore();

        await interaction.editReply({
          content:
            removed > 0
              ? `🗑️ <@${targetUser.id}> whitelist-dən silindi (${removed} qeyd).`
              : `⚠️ <@${targetUser.id}> üçün uyğun whitelist qeydi tapılmadı.`,
        });
        return;
      }

      if (cmd === 'resethwid') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('user');
        let resetCount = 0;
        for (const w of ws.whitelists) {
          if (
            w.discordUserId === targetUser.id &&
            (!selectedScriptArg || w.scriptId === selectedScriptArg)
          ) {
            w.hwid = '';
            resetCount += 1;
          }
        }
        ws.stats.hwidResets += resetCount;
        await saveStore();

        await interaction.editReply({
          content:
            resetCount > 0
              ? `🔄 <@${targetUser.id}> istifadəçisinin HWID-si sıfırlandı (${resetCount} qeyd).`
              : `⚠️ <@${targetUser.id}> üçün sıfırlanacaq whitelist qeydi tapılmadı.`,
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const cid = interaction.customId || '';
      const userId = interaction.user.id;
      const scriptIdFromCid = cid.replace(/^sado_(redeem|getscript|resethwid|stats|copyscript)_/, '');
      const { wsId, ws } = resolveWorkspaceForDiscord({
        guildId: interaction.guildId,
        discordUserId: userId,
        scriptId: scriptIdFromCid,
      });

      if (cid.startsWith('sado_redeem_')) {
        const modal = new ModalBuilder()
          .setCustomId(`sado_redeem_modal_${scriptIdFromCid}`)
          .setTitle('Key Aktivləşdir (Redeem Key)');

        const keyInput = new TextInputBuilder()
          .setCustomId('redeem_key_input')
          .setLabel('Lisenziya Key-inizi daxil edin')
          .setPlaceholder('SADO-XXXXXX-XXXXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        await interaction.showModal(modal);
        return;
      }

      if (cid.startsWith('sado_copyscript_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const sc = ws.scripts.find((s) => s.id === scriptIdFromCid) || ws.scripts[0];
        const wl = ws.whitelists.find(
          (w) =>
            w.discordUserId === userId &&
            (!sc || w.scriptId === sc.id) &&
            !isExpired(w.expiresAt)
        );
        const snippet = buildLoaderSnippet(wsId, sc, wl, buildPublicBaseUrl());
        const copyEmbed = new EmbedBuilder()
          .setColor('#10b981')
          .setTitle(`📋 ${sc ? sc.name : 'SADO HUB'} • Loader Code`)
          .setDescription(`\`\`\`lua\n${snippet}\n\`\`\``)
          .setFooter({ text: 'SADO PROTECT • Script Copy Panel' });
        await interaction.editReply({ content: snippet, embeds: [copyEmbed] });
        return;
      }

      if (cid.startsWith('sado_getscript_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const sc = ws.scripts.find((s) => s.id === scriptIdFromCid) || ws.scripts[0];
        if (!sc) {
          await interaction.editReply({ content: '❌ Bu panel üçün aktiv skript tapılmadı.' });
          return;
        }
        const isBl = ws.blacklist.some(
          (b) => b.discordUserId === userId && (!b.scriptId || b.scriptId === sc.id)
        );
        if (isBl) {
          await interaction.editReply({ content: '🚫 Siz bu skriptdən blacklist olunmusunuz.' });
          return;
        }
        const wl = ws.whitelists.find(
          (w) => w.discordUserId === userId && w.scriptId === sc.id && !isExpired(w.expiresAt)
        );
        if (!wl) {
          await interaction.editReply({
            content:
              '⚠️ Sizin bu skript üçün aktiv whitelist/key qeydiniz yoxdur. Əvvəl **Redeem Key** düyməsi ilə key aktivləşdirin.',
          });
          return;
        }
        ws.stats.scriptFetches += 1;
        await saveStore();

        const snippet = buildLoaderSnippet(wsId, sc, wl, buildPublicBaseUrl());
        const scriptPanelEmbed = new EmbedBuilder()
          .setColor('#3b82f6')
          .setTitle(`📜 ${sc.name} • Loader`)
          .setDescription(`\`\`\`lua\n${snippet}\n\`\`\``)
          .addFields(
            { name: '🔑 Key', value: `\`${wl.key}\``, inline: true },
            {
              name: '🖥️ HWID',
              value: wl.hwid ? `\`${wl.hwid}\`` : '`Bağlanmayıb (İlk girişdə bağlanacaq)`',
              inline: true,
            }
          )
          .setTimestamp();

        const copyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`sado_copyscript_${sc.id}`)
            .setLabel('Skripti Kopyala')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Success)
        );

        await interaction.editReply({ embeds: [scriptPanelEmbed], components: [copyRow] });
        return;
      }

      if (cid.startsWith('sado_resethwid_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const matching = ws.whitelists.filter(
          (w) =>
            w.discordUserId === userId &&
            (scriptIdFromCid === 'default' || !w.scriptId || w.scriptId === scriptIdFromCid)
        );
        if (!matching.length) {
          await interaction.editReply({ content: '❌ HWID sıfırlamaq üçün aktiv key/whitelist tapılmadı.' });
          return;
        }
        for (const w of matching) {
          w.hwid = '';
        }
        ws.stats.hwidResets += matching.length;
        await saveStore();

        await interaction.editReply({
          content: `🔄 HWID uğurla sıfırlandı (${matching.length} qeyd). Skripti növbəti dəfə ilk işlədən cihaza bağlanacaq.`,
        });
        return;
      }

      if (cid.startsWith('sado_stats_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userKeys = ws.keys.filter((k) => k.usedByDiscordId === userId);
        const userWl = ws.whitelists.filter((w) => w.discordUserId === userId && !isExpired(w.expiresAt));
        const statsEmbed = new EmbedBuilder()
          .setColor('#8b5cf6')
          .setTitle('📊 İstifadəçi Statistikası')
          .addFields(
            { name: '👤 İstifadəçi', value: `<@${userId}>`, inline: true },
            { name: '🔑 Aktiv Key / Whitelist', value: String(userWl.length), inline: true },
            { name: '📥 Aktivləşdirilən Keylər', value: String(userKeys.length), inline: true },
            {
              name: '🖥️ Bağlı HWID-lər',
              value: userWl.length
                ? userWl
                    .map(
                      (w) =>
                        `\`${w.scriptId}\`: ${w.hwid ? `\`${w.hwid}\`` : '_Sıfır / Gözlənilir_'}`
                    )
                    .join('\n')
                : 'Yoxdur',
              inline: false,
            }
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [statsEmbed] });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const cid = interaction.customId || '';
      if (cid.startsWith('sado_redeem_modal_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const scriptIdFromModal = cid.replace('sado_redeem_modal_', '');
        const userId = interaction.user.id;
        const username = interaction.user.globalName || interaction.user.username || userId;
        const enteredKey = interaction.fields.getTextInputValue('redeem_key_input').trim();
        const { ws } = resolveWorkspaceForDiscord({
          guildId: interaction.guildId,
          discordUserId: userId,
          scriptId: scriptIdFromModal,
        });

        const keyObj = ws.keys.find((k) => k.key.toUpperCase() === enteredKey.toUpperCase());
        if (!keyObj) {
          await interaction.editReply({ content: '❌ Bu key tapılmadı və ya etibarsızdır.' });
          return;
        }
        if (keyObj.used && keyObj.usedByDiscordId && keyObj.usedByDiscordId !== userId) {
          await interaction.editReply({ content: '❌ Bu key artıq başqa istifadəçi tərəfindən işlədilib.' });
          return;
        }
        if (isExpired(keyObj.expiresAt)) {
          await interaction.editReply({ content: '⏰ Bu key-in vaxtı bitib.' });
          return;
        }

        const targetScriptId =
          keyObj.scriptId || scriptIdFromModal || (ws.scripts[0] && ws.scripts[0].id) || 'default';
        const isBl = ws.blacklist.some(
          (b) => b.discordUserId === userId && (!b.scriptId || b.scriptId === targetScriptId)
        );
        if (isBl) {
          await interaction.editReply({ content: '🚫 Siz bu skriptdən blacklist olunmusunuz.' });
          return;
        }

        keyObj.used = true;
        keyObj.usedByDiscordId = userId;
        keyObj.usedByName = username;
        keyObj.usedAt = new Date().toISOString();

        const existingWlIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === userId && w.scriptId === targetScriptId
        );
        const wlRecord = {
          id: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].id : crypto.randomUUID(),
          discordUserId: userId,
          username,
          addedByDiscordId: keyObj.createdByDiscordId || userId,
          addedByName: keyObj.createdByName || username,
          scriptId: targetScriptId,
          key: keyObj.key,
          hwid: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwid || '' : '',
          hwidLocked: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwidLocked !== false : true,
          expiresAt: keyObj.expiresAt || null,
          createdAt: new Date().toISOString(),
        };
        if (existingWlIdx >= 0) {
          ws.whitelists[existingWlIdx] = wlRecord;
        } else {
          ws.whitelists.unshift(wlRecord);
        }
        ws.stats.redeems += 1;
        await saveStore();

        await interaction.editReply({
          content:
            '✅ Key uğurla aktivləşdirildi! İndi **Get Script** düyməsinə basıb skripti götürə bilərsiniz.',
        });
      }
    }
  } catch (err) {
    console.error('[BOT] Interaction xətası:', err && err.message ? err.message : err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '⚠️ Əməliyyat zamanı xəta baş verdi.' }).catch(() => {});
      } else if (typeof interaction.reply === 'function') {
        await interaction
          .reply({ content: '⚠️ Əməliyyat zamanı xəta baş verdi.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    } catch (_e) {}
  }
});

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    botReady: client.isReady(),
    workspaces: Object.keys(runtimeState.store.workspaces || {}).length,
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/status', async (req, res) => {
  try {
    const { wsId, ws } = getWorkspaceFromReq(req);
    if (!client.isReady() && !runtimeState.isConnectingNow && BOT_TOKEN) {
      await ensureBotOnline();
    }
    res.json({
      ok: true,
      workspaceId: wsId,
      botReady: client.isReady(),
      botTag: client.user ? client.user.tag : null,
      guildId: ws.guildId || '',
      guildName: ws.guildName || '',
      discordUserId: ws.discordUserId || '',
      inviteUrl: ws.inviteUrl || DEFAULT_INVITE_URL,
      panelConfig: ws.panelConfig,
      counts: {
        scripts: ws.scripts.length,
        keys: ws.keys.length,
        whitelists: ws.whitelists.length,
        blacklist: ws.blacklist.length,
        panels: ws.panels.length,
      },
      stats: ws.stats,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Status xətası' });
  }
});

app.get('/api/state', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const info = await lookupGuildInfo(ws.guildId, ws.discordUserId);
  if (info.guildName && ws.guildName !== info.guildName) {
    ws.guildName = info.guildName;
    await saveStore();
  }
  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId || '',
    guildName: ws.guildName || info.guildName || '',
    discordUserId: ws.discordUserId || '',
    inviteUrl: ws.inviteUrl || DEFAULT_INVITE_URL,
    guilds: info.guilds,
    panelConfig: ws.panelConfig,
    scripts: ws.scripts,
    keys: ws.keys,
    whitelists: ws.whitelists,
    blacklist: ws.blacklist,
    panels: ws.panels,
    stats: ws.stats,
  });
});

app.post('/api/workspace/link', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const rawGuildId = String((req.body && req.body.guildId) || '').trim();
  const rawDiscordUserId = String((req.body && req.body.discordUserId) || '').trim();
  const info = await lookupGuildInfo(rawGuildId, rawDiscordUserId);

  ws.guildId = info.guildId || rawGuildId;
  ws.guildName = info.guildName || ws.guildName || '';
  ws.discordUserId = rawDiscordUserId;

  await saveStore();
  if (BOT_TOKEN && client.isReady()) {
    await registerSlashCommands().catch(() => {});
  }

  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId,
    guildName: ws.guildName,
    discordUserId: ws.discordUserId,
    guilds: info.guilds,
    message: ws.guildName
      ? `Sunucu tapıldı və bağlandı: ${ws.guildName}`
      : 'Sunucu və Discord ID yadda saxlandı!',
  });
});

app.post('/api/panel-config', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const body = req.body || {};
  ws.panelConfig = {
    embedColor: normalizeHexColor(body.embedColor || ws.panelConfig.embedColor),
    title:
      String(body.title !== undefined ? body.title : ws.panelConfig.title).trim() ||
      DEFAULT_PANEL_CONFIG.title,
    description:
      String(
        body.description !== undefined ? body.description : ws.panelConfig.description
      ).trim() || DEFAULT_PANEL_CONFIG.description,
    redeemLabel: String(body.redeemLabel || ws.panelConfig.redeemLabel).trim() || 'Redeem Key',
    redeemStyle: String(body.redeemStyle || ws.panelConfig.redeemStyle || 'Success').trim(),
    getScriptLabel:
      String(body.getScriptLabel || ws.panelConfig.getScriptLabel).trim() || 'Get Script',
    getScriptStyle: String(body.getScriptStyle || ws.panelConfig.getScriptStyle || 'Primary').trim(),
    resetHwidLabel:
      String(body.resetHwidLabel || ws.panelConfig.resetHwidLabel).trim() || 'Reset HWID',
    resetHwidStyle: String(body.resetHwidStyle || ws.panelConfig.resetHwidStyle || 'Danger').trim(),
    statsLabel: String(body.statsLabel || ws.panelConfig.statsLabel).trim() || 'Get Stats',
    statsStyle: String(body.statsStyle || ws.panelConfig.statsStyle || 'Secondary').trim(),
    footerText:
      String(body.footerText !== undefined ? body.footerText : ws.panelConfig.footerText).trim() ||
      DEFAULT_PANEL_CONFIG.footerText,
    imageUrl: String(body.imageUrl !== undefined ? body.imageUrl : ws.panelConfig.imageUrl).trim(),
    thumbnailUrl: String(
      body.thumbnailUrl !== undefined ? body.thumbnailUrl : ws.panelConfig.thumbnailUrl
    ).trim(),
  };
  await saveStore();
  await refreshExistingDiscordPanels(ws).catch(() => {});
  res.json({
    ok: true,
    workspaceId: wsId,
    panelConfig: ws.panelConfig,
    message: 'Panel dizaynı yeniləndi və aktiv panellərə tətbiq olundu!',
  });
});

app.post('/api/obfuscate', (req, res) => {
  const code = String((req.body && req.body.code) || DEFAULT_SCRIPT_CODE);
  const level = Number((req.body && req.body.level) || 2);
  const obfuscated = obfuscateLuaCode(code, level);
  res.json({
    ok: true,
    level,
    obfuscated,
    message: 'Lua skripti uğurla şifrələndi!',
  });
});

app.post('/api/scripts', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const name = String((req.body && req.body.name) || '').trim();
  const rawCode = String((req.body && req.body.code) || DEFAULT_SCRIPT_CODE);
  const shouldObf = Boolean(req.body && req.body.obfuscate);
  const obfLevel = Number((req.body && req.body.obfuscateLevel) || 2);
  if (!name) {
    res.status(400).json({ ok: false, message: 'Skript adı tələb olunur.' });
    return;
  }
  const finalCode = shouldObf ? obfuscateLuaCode(rawCode, obfLevel) : rawCode;
  const id = slugifyId(name, 'script');
  const scriptObj = {
    id,
    name,
    loaderToken: `${id}_${crypto.randomBytes(3).toString('hex')}`,
    code: finalCode,
    obfuscated: shouldObf,
    createdAt: new Date().toISOString(),
  };
  ws.scripts.unshift(scriptObj);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, script: scriptObj, message: 'Skript yaradıldı!' });
});

app.delete('/api/scripts/:id', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const targetId = req.params.id;
  if (ws.scripts.length <= 1) {
    res.status(400).json({ ok: false, message: 'Ən azı 1 skript qalmalıdır.' });
    return;
  }
  ws.scripts = ws.scripts.filter((s) => s.id !== targetId);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, message: 'Skript silindi.' });
});

app.post('/api/keys', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const scriptId = String(
    (req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default'
  );
  const duration = String((req.body && req.body.duration) || 'lifetime').trim() || 'lifetime';
  const amount = Math.min(100, Math.max(1, Number((req.body && req.body.amount) || 1)));
  const creatorId = String((req.body && req.body.createdByDiscordId) || ws.discordUserId || '').trim();
  const creatorName = creatorId ? await resolveDiscordUsername(creatorId) : 'Dashboard Admin';
  const sc = ws.scripts.find((s) => s.id === scriptId) || ws.scripts[0];
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

  const created = [];
  for (let i = 0; i < amount; i++) {
    const item = {
      key: generateRandomKeyCode(),
      scriptId: sc ? sc.id : scriptId,
      scriptName: sc ? sc.name : 'SADO HUB',
      duration,
      expiresAt,
      used: false,
      createdByDiscordId: creatorId || null,
      createdByName: creatorName,
      usedByDiscordId: null,
      usedByName: null,
      createdAt: new Date().toISOString(),
    };
    ws.keys.unshift(item);
    created.push(item);
  }
  await saveStore();
  res.json({
    ok: true,
    workspaceId: wsId,
    keys: created,
    message: `${created.length} key yaradıldı!`,
  });
});

app.delete('/api/keys/:key', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const targetKey = decodeURIComponent(req.params.key || '');
  ws.keys = ws.keys.filter((k) => k.key !== targetKey);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, message: 'Key silindi.' });
});

app.post('/api/whitelist', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const discordUserId = String((req.body && req.body.discordUserId) || '').trim();
  const scriptId = String(
    (req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default'
  );
  const duration = String((req.body && req.body.duration) || 'lifetime').trim() || 'lifetime';
  const hwidLocked = req.body && req.body.hwidLocked !== undefined ? Boolean(req.body.hwidLocked) : true;
  const adderId = String((req.body && req.body.addedByDiscordId) || ws.discordUserId || '').trim();
  if (!discordUserId) {
    res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    return;
  }
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;
  const resolvedUser = await resolveDiscordUsername(discordUserId);
  const resolvedAdder = adderId ? await resolveDiscordUsername(adderId) : 'Dashboard Admin';

  const existingIdx = ws.whitelists.findIndex(
    (w) => w.discordUserId === discordUserId && w.scriptId === scriptId
  );
  const entry = {
    id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
    discordUserId,
    username: resolvedUser,
    addedByDiscordId: adderId || null,
    addedByName: resolvedAdder,
    scriptId,
    key:
      existingIdx >= 0 && ws.whitelists[existingIdx].key
        ? ws.whitelists[existingIdx].key
        : generateRandomKeyCode(),
    hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
    hwidLocked,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) {
    ws.whitelists[existingIdx] = entry;
  } else {
    ws.whitelists.unshift(entry);
  }
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, entry, message: 'Whitelist yeniləndi!' });
});

app.post('/api/whitelist/:id/toggle-lock', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const wl = ws.whitelists.find((w) => w.id === req.params.id);
  if (!wl) {
    res.status(404).json({ ok: false, message: 'Qeyd tapılmadı.' });
    return;
  }
  wl.hwidLocked = wl.hwidLocked === false ? true : false;
  await saveStore();
  res.json({
    ok: true,
    workspaceId: wsId,
    hwidLocked: wl.hwidLocked,
    message: wl.hwidLocked ? 'HWID kilidləndi!' : 'HWID kilidi açıldı!',
  });
});

app.post('/api/whitelist/:id/reset-hwid', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const wl = ws.whitelists.find((w) => w.id === req.params.id);
  if (!wl) {
    res.status(404).json({ ok: false, message: 'Qeyd tapılmadı.' });
    return;
  }
  wl.hwid = '';
  ws.stats.hwidResets += 1;
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, message: 'HWID sıfırlandı!' });
});

app.delete('/api/whitelist/:id', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  ws.whitelists = ws.whitelists.filter((w) => w.id !== req.params.id);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, message: 'Whitelist qeydi silindi.' });
});

app.post('/api/blacklist', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const discordUserId = String((req.body && req.body.discordUserId) || '').trim();
  const scriptId = String((req.body && req.body.scriptId) || '').trim();
  if (!discordUserId) {
    res.status(400).json({ ok: false, message: 'Discord User ID tələb olunur.' });
    return;
  }
  const username = await resolveDiscordUsername(discordUserId);
  const blItem = {
    id: crypto.randomUUID(),
    discordUserId,
    username,
    scriptId,
    createdAt: new Date().toISOString(),
  };
  ws.blacklist.unshift(blItem);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, entry: blItem, message: 'Blacklist-ə əlavə olundu!' });
});

app.delete('/api/blacklist/:id', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  ws.blacklist = ws.blacklist.filter((b) => b.id !== req.params.id);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, message: 'Blacklist-dən silindi.' });
});

app.post('/api/send-panel', async (req, res) => {
  try {
    const { wsId, ws } = getWorkspaceFromReq(req);
    const channelId = String((req.body && req.body.channelId) || '').trim();
    const scriptId = String(
      (req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default'
    );
    if (!channelId) {
      res.status(400).json({ ok: false, message: 'Kanal ID daxil edin.' });
      return;
    }
    if (!BOT_TOKEN) {
      res.status(400).json({ ok: false, message: 'Bot token təyin edilməyib.' });
      return;
    }
    if (!client.isReady()) {
      await ensureBotOnline();
    }
    const sc = ws.scripts.find((s) => s.id === scriptId) || ws.scripts[0];
    const { embed, row } = buildPanelEmbedAndButtons(ws, sc);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const msg = await rest.post(Routes.channelMessages(channelId), {
      body: { embeds: [embed.toJSON()], components: [row.toJSON()] },
    });
    ws.panels.push({
      id: crypto.randomUUID(),
      channelId,
      messageId: msg.id,
      scriptId: sc ? sc.id : scriptId,
      createdAt: new Date().toISOString(),
    });
    await saveStore();
    res.json({
      ok: true,
      workspaceId: wsId,
      messageId: msg.id,
      message: 'Panel kanala göndərildi!',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Panel göndərilə bilmədi.' });
  }
});

app.get('/loader/:token', (req, res) => {
  const tokenParam = decodeURIComponent(req.params.token || '');
  const wsId = sanitizeWorkspaceId(
    req.query.ws || runtimeState.store.activeWorkspaceId || 'default'
  );
  const ws = ensureWorkspace(wsId);
  const sc =
    ws.scripts.find((s) => s.loaderToken === tokenParam || s.id === tokenParam) || ws.scripts[0];
  const verifyUrl = `${buildPublicBaseUrl(req)}/api/verify?ws=${encodeURIComponent(
    wsId
  )}&script=${encodeURIComponent(sc ? sc.id : 'default')}`;

  const luaLoader = [
    'local HttpService = game:GetService("HttpService")',
    'local Players = game:GetService("Players")',
    'local RbxAnalyticsService = game:GetService("RbxAnalyticsService")',
    'local LocalPlayer = Players.LocalPlayer',
    'local keyVal = tostring(script_key or "")',
    'local hwidVal = ""',
    'pcall(function()',
    '  if type(gethwid) == "function" then hwidVal = tostring(gethwid()) end',
    'end)',
    'if hwidVal == "" or hwidVal == "nil" then',
    '  pcall(function()',
    '    hwidVal = tostring(RbxAnalyticsService:GetClientId())',
    '  end)',
    'end',
    'if hwidVal == "" or hwidVal == "nil" then',
    '  hwidVal = tostring((LocalPlayer and LocalPlayer.UserId) or "unknown")',
    'end',
    'local reqFunc = (syn and syn.request) or (http and http.request) or http_request or request',
    'local rawBody = ""',
    'if reqFunc then',
    '  local ok, resp = pcall(function()',
    '    return reqFunc({',
    `      Url = "${verifyUrl}",`,
    '      Method = "POST",',
    '      Headers = { ["Content-Type"] = "application/json" },',
    '      Body = HttpService:JSONEncode({ key = keyVal, hwid = hwidVal, playerId = LocalPlayer and tostring(LocalPlayer.UserId) or "" })',
    '    })',
    '  end)',
    '  if ok and resp and resp.Body then rawBody = tostring(resp.Body) end',
    'end',
    'if rawBody == "" then',
    `  pcall(function() rawBody = tostring(game:HttpGet("${verifyUrl}&key=" .. HttpService:UrlEncode(keyVal) .. "&hwid=" .. HttpService:UrlEncode(hwidVal))) end)`,
    'end',
    'local parsed = nil',
    'pcall(function() parsed = HttpService:JSONDecode(rawBody) end)',
    'if type(parsed) == "table" and parsed.ok == true and type(parsed.code) == "string" then',
    '  local fn = loadstring(parsed.code)',
    '  if type(fn) == "function" then fn() end',
    'else',
    '  local reason = (type(parsed) == "table" and parsed.message) or "SADO PROTECT: Unauthorized or HWID Mismatch"',
    '  if LocalPlayer then pcall(function() LocalPlayer:Kick(tostring(reason)) end) end',
    'end',
  ].join('\n');

  res.type('text/plain').send(luaLoader);
});

app.all('/api/verify', async (req, res) => {
  try {
    const wsId = sanitizeWorkspaceId(
      req.query.ws || (req.body && req.body.workspaceId) || runtimeState.store.activeWorkspaceId || 'default'
    );
    const ws = ensureWorkspace(wsId);
    const scriptParam = String(req.query.script || (req.body && req.body.scriptId) || '').trim();
    const keyInput = String((req.body && req.body.key) || req.query.key || '').trim();
    const hwidInput = String((req.body && req.body.hwid) || req.query.hwid || '').trim();

    const sc =
      ws.scripts.find((s) => s.id === scriptParam || s.loaderToken === scriptParam) || ws.scripts[0];
    const targetScriptId = sc ? sc.id : 'default';

    const wl = ws.whitelists.find(
      (w) =>
        w.scriptId === targetScriptId &&
        (String(w.key || '').trim().toUpperCase() === keyInput.toUpperCase() ||
          (req.body && req.body.playerId && String(w.discordUserId) === String(req.body.playerId)))
    );

    if (!wl) {
      ws.stats.authBlocked += 1;
      await saveStore();
      res.status(403).json({ ok: false, message: 'SADO PROTECT: Key və ya Whitelist tapılmadı.' });
      return;
    }

    const isBl = ws.blacklist.some(
      (b) => b.discordUserId === wl.discordUserId && (!b.scriptId || b.scriptId === targetScriptId)
    );
    if (isBl) {
      ws.stats.authBlocked += 1;
      await saveStore();
      res.status(403).json({ ok: false, message: 'SADO PROTECT: Siz Blacklist olunmusunuz.' });
      return;
    }

    if (isExpired(wl.expiresAt)) {
      ws.stats.authBlocked += 1;
      await saveStore();
      res.status(403).json({ ok: false, message: 'SADO PROTECT: Lisenziya müddəti bitib.' });
      return;
    }

    if (hwidInput && wl.hwidLocked !== false) {
      if (!wl.hwid || String(wl.hwid).trim() === '') {
        wl.hwid = hwidInput;
        await saveStore();
      } else if (String(wl.hwid).trim() !== hwidInput) {
        ws.stats.authBlocked += 1;
        await saveStore();
        res
          .status(403)
          .json({ ok: false, message: 'SADO PROTECT: HWID başqa cihaza bağlıdır! Kick.' });
        return;
      }
    }

    ws.stats.authSuccess += 1;
    await saveStore();

    res.json({
      ok: true,
      scriptId: targetScriptId,
      code: sc ? sc.code : DEFAULT_SCRIPT_CODE,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Verify xətası' });
  }
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • Control Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, system-ui, -apple-system, sans-serif; }
    body { background: #070b14; color: #f3f4f6; min-height: 100vh; padding: 18px; }
    .shell { max-width: 1120px; margin: 0 auto; display: grid; gap: 16px; }
    .topbar { background: #101727; border: 1px solid #1f2a44; border-radius: 16px; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .brand-row { display: flex; align-items: center; gap: 12px; }
    .menu-btn { width: 44px; height: 44px; border-radius: 12px; border: 1px solid #2b3b5e; background: #17223b; color: #ffffff; font-size: 20px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .menu-btn:hover { background: #223254; }
    .brand-title { font-size: 18px; font-weight: 800; letter-spacing: 0.4px; color: #38bdf8; }
    .brand-sub { font-size: 12px; color: #9ca3af; margin-top: 2px; }
    .status-pill { padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; background: rgba(16, 185, 129, 0.14); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }
    .drawer-nav { display: none; background: #101727; border: 1px solid #1f2a44; border-radius: 16px; padding: 14px; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
    .drawer-nav.open { display: grid; }
    .nav-chip { background: #162036; color: #e5e7eb; border: 1px solid #263554; border-radius: 11px; padding: 11px 14px; font-size: 13px; font-weight: 700; cursor: pointer; text-align: left; }
    .nav-chip.active { background: #7c3aed; color: #ffffff; border-color: #8b5cf6; }
    .page-section { display: none; gap: 16px; }
    .page-section.active { display: grid; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .kpi-card { background: #101727; border: 1px solid #1f2a44; border-top: 3px solid #10b981; border-radius: 14px; padding: 16px; }
    .kpi-label { font-size: 12px; color: #9ca3af; }
    .kpi-val { font-size: 24px; font-weight: 800; color: #ffffff; margin-top: 6px; word-break: break-word; }
    .card { background: #101727; border: 1px solid #1f2a44; border-radius: 16px; padding: 18px; display: grid; gap: 14px; }
    .card h2 { font-size: 16px; font-weight: 800; color: #f9fafb; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; font-size: 12px; color: #9ca3af; font-weight: 600; }
    input, textarea, select { width: 100%; background: #090e1a; border: 1px solid #263554; color: #f9fafb; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
    textarea { min-height: 110px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .btn { border: none; border-radius: 10px; padding: 10px 15px; font-size: 13px; font-weight: 800; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; }
    .btn:hover { filter: brightness(1.08); }
    .btn-green { background: #10b981; color: #042f2e; }
    .btn-blue { background: #2563eb; color: #ffffff; }
    .btn-purple { background: #7c3aed; color: #ffffff; }
    .btn-red { background: #ef4444; color: #ffffff; }
    .btn-gray { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; }
    .btn-sm { padding: 7px 11px; font-size: 12px; }
    .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
    .chart-item { background: #090e1a; border: 1px solid #1e293b; border-radius: 12px; padding: 12px; display: grid; gap: 8px; }
    .chart-meta { display: flex; justify-content: space-between; font-size: 12px; color: #d1d5db; }
    .chart-track { width: 100%; height: 9px; background: #1e293b; border-radius: 999px; overflow: hidden; }
    .chart-fill { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
    .script-item { background: #090e1a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; display: grid; gap: 10px; }
    .script-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
    .loader-box { background: #050811; border: 1px solid #182235; border-radius: 10px; padding: 10px; font-family: ui-monospace, monospace; font-size: 12px; color: #34d399; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
    th, td { border-bottom: 1px solid #1e293b; padding: 8px 6px; text-align: left; }
    th { color: #9ca3af; font-weight: 700; }
    .toast { position: fixed; right: 16px; bottom: 16px; background: #10b981; color: #042f2e; font-weight: 800; padding: 11px 16px; border-radius: 11px; opacity: 0; pointer-events: none; transition: opacity 0.2s ease; z-index: 999; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand-row">
        <button type="button" class="menu-btn" id="menuToggleBtn" aria-label="Menyu">&#9776;</button>
        <div>
          <div class="brand-title">SADO PROTECT</div>
          <div class="brand-sub" id="subStatus">Control Dashboard • Seçilməyib</div>
        </div>
      </div>
      <div class="status-pill" id="botBadge">Bot: Qoşulur...</div>
    </div>

    <div class="drawer-nav" id="drawerNav">
      <button type="button" class="nav-chip active" data-page="overview">📊 Overview</button>
      <button type="button" class="nav-chip" data-page="charts">📈 Qrafiklər</button>
      <button type="button" class="nav-chip" data-page="scripts">📜 Skriptlər</button>
      <button type="button" class="nav-chip" data-page="panel">📤 Panel Göndər</button>
      <button type="button" class="nav-chip" data-page="obf">🛡️ Obfuscator</button>
      <button type="button" class="nav-chip" data-page="keys">🔑 Key &amp; Whitelist</button>
      <button type="button" class="nav-chip" data-page="discord">🤖 Join Discord &amp; Server</button>
      <button type="button" class="nav-chip" data-page="design">🎨 Panel Dizaynı</button>
    </div>

    <div class="page-section active" id="page-overview">
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Skriptlər</div><div class="kpi-val" id="kpiScripts">0</div></div>
        <div class="kpi-card"><div class="kpi-label">Yaradılmış Key-lər</div><div class="kpi-val" id="kpiKeys">0</div></div>
        <div class="kpi-card"><div class="kpi-label">Aktiv Whitelist</div><div class="kpi-val" id="kpiWl">0</div></div>
        <div class="kpi-card"><div class="kpi-label">Qoşulu Sunucu</div><div class="kpi-val" id="kpiGuild">Seçilməyib</div></div>
      </div>
      <div class="card">
        <h2>🕒 Son Key-lər (Yaradan & İşlədən)</h2>
        <div id="recentKeysBox" class="brand-sub">Hələ key yaradılmayıb.</div>
      </div>
    </div>

    <div class="page-section" id="page-charts">
      <div class="card">
        <h2>📈 Sistem Göstəriciləri & Qrafiklər</h2>
        <div class="charts-grid" id="chartsArea"></div>
      </div>
    </div>

    <div class="page-section" id="page-scripts">
      <div class="card">
        <h2>📜 Yeni Skript Yarat</h2>
        <div class="grid-2">
          <label>Skript Adı<input id="scriptNameInput" placeholder="Məs: SADO HUB" /></label>
          <label>Fayldan Yüklə (.lua / .txt)<input type="file" id="scriptFileInput" accept=".lua,.txt,text/plain" /></label>
        </div>
        <label>Lua Skript Kodu<textarea id="scriptCodeInput"></textarea></label>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="createObfCheckbox" style="width:auto;" />
            <span>Yaradarkən Obfuscate et</span>
          </label>
          <button type="button" class="btn btn-green" id="createScriptBtn">➕ Skript Yarat</button>
        </div>
        <div id="scriptsList"></div>
      </div>
    </div>

    <div class="page-section" id="page-panel">
      <div class="card">
        <h2>📤 Discord Kanalına Panel Göndər</h2>
        <div class="grid-2">
          <label>Discord Channel ID<input id="panelChannelIdInput" placeholder="Məs: 123456789012345678" /></label>
          <label>Skript Seçimi<select id="panelScriptSelect"></select></label>
        </div>
        <div><button type="button" class="btn btn-blue" id="sendPanelBtn">📤 Panel Göndər</button></div>
      </div>
    </div>

    <div class="page-section" id="page-obf">
      <div class="card">
        <h2>🛡️ Lua Obfuscator</h2>
        <div class="grid-2">
          <label>Şifrələmə Səviyyəsi
            <select id="obfLevelSelect">
              <option value="1">Level 1 — Base64 Shield</option>
              <option value="2" selected>Level 2 — XOR Byte Shield</option>
              <option value="3">Level 3 — Multi-Chunk VM</option>
            </select>
          </label>
          <label>Yeni Skript Adı (Saxlamaq üçün)<input id="obfSaveNameInput" placeholder="SADO Protected" /></label>
        </div>
        <label>Orijinal Lua Kodu<textarea id="obfInputCode" placeholder="print('Hello SADO')"></textarea></label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" class="btn btn-purple" id="runObfBtn">🛡️ Şifrələ</button>
          <button type="button" class="btn btn-blue" id="copyObfBtn">📋 Kopyala</button>
          <button type="button" class="btn btn-green" id="saveObfBtn">💾 Skript Kimi Saxla</button>
        </div>
        <label>Şifrələnmiş Nəticə<textarea id="obfResultBox" readonly></textarea></label>
      </div>
    </div>

    <div class="page-section" id="page-keys">
      <div class="card">
        <h2>🔑 Key Yaradılması</h2>
        <div class="grid-2">
          <label>Skript<select id="keyScriptSelect"></select></label>
          <label>Müddət (1d, 7d, 30d, lifetime)<input id="keyDurationInput" value="lifetime" /></label>
        </div>
        <div class="grid-2">
          <label>Key Sayı<input id="keyAmountInput" type="number" min="1" max="50" value="1" /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="button" class="btn btn-green" id="genKeysBtn">🔑 Key Yarat</button>
          </div>
        </div>
        <div id="keysList"></div>
      </div>

      <div class="card">
        <h2>👤 Whitelist & HWID İdarəetməsi</h2>
        <div class="grid-2">
          <label>Discord User ID<input id="wlUserIdInput" placeholder="Məs: 987654321098765432" /></label>
          <label>Skript<select id="wlScriptSelect"></select></label>
        </div>
        <div class="grid-2">
          <label>Müddət<input id="wlDurationInput" value="lifetime" /></label>
          <label style="display:flex;align-items:center;gap:8px;padding-top:18px;cursor:pointer;">
            <input type="checkbox" id="wlLockCheckbox" checked style="width:auto;" />
            <span>HWID Kilidli Olsun</span>
          </label>
        </div>
        <div><button type="button" class="btn btn-blue" id="addWhitelistBtn">➕ Whitelist-ə Əlavə Et</button></div>
        <div id="wlList"></div>
      </div>

      <div class="card">
        <h2>🚫 Blacklist</h2>
        <div class="grid-2">
          <label>Discord User ID<input id="blUserIdInput" placeholder="Discord User ID" /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="button" class="btn btn-red" id="addBlacklistBtn">🚫 Blacklist-ə At</button>
          </div>
        </div>
        <div id="blList"></div>
      </div>
    </div>

    <div class="page-section" id="page-discord">
      <div class="card">
        <h2>🤖 Join Discord & Server Bağlantısı</h2>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <a id="joinDiscordLink" href="https://discord.gg/sado-protect" target="_blank" rel="noopener noreferrer" class="btn btn-purple">💬 Join Discord</a>
          <span class="brand-sub" id="liveGuildPreview"></span>
        </div>
        <div class="grid-2">
          <label>Botun Olduğu Sunucular<select id="guildSelect"></select></label>
          <label>Discord Server (Guild) ID<input id="guildIdInput" placeholder="Sunucu ID yazın..." /></label>
        </div>
        <div class="grid-2">
          <label>Sahib Discord User ID<input id="discordUserIdInput" placeholder="Discord User ID yazın..." /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="button" class="btn btn-green" id="linkWorkspaceBtn">🔗 Sunucuya Bağlan</button>
          </div>
        </div>
      </div>
    </div>

    <div class="page-section" id="page-design">
      <div class="card">
        <h2>🎨 Panel Embed & Buton Dizaynı</h2>
        <div class="grid-2">
          <label>Embed Rəngi (Hex)<input id="embedColorInput" value="#10B981" /></label>
          <label>Rəng Seçici<input type="color" id="embedColorPicker" value="#10b981" style="height:42px;padding:4px;" /></label>
        </div>
        <div class="grid-2">
          <label>Panel Başlığı<input id="panelTitleInput" value="SADO PROTECT • Script Panel" /></label>
          <label>Panel Təsviri<input id="panelDescInput" value="Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin." /></label>
        </div>
        <div class="grid-2">
          <label>Redeem Düymə Mətni<input id="redeemLabelInput" value="Redeem Key" /></label>
          <label>Redeem Düymə Rəngi
            <select id="redeemStyleInput">
              <option value="Success" selected>Yaşıl (Success)</option>
              <option value="Primary">Mavi (Primary)</option>
              <option value="Secondary">Boz (Secondary)</option>
              <option value="Danger">Qırmızı (Danger)</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>Get Script Düymə Mətni<input id="getScriptLabelInput" value="Get Script" /></label>
          <label>Get Script Düymə Rəngi
            <select id="getScriptStyleInput">
              <option value="Primary" selected>Mavi (Primary)</option>
              <option value="Success">Yaşıl (Success)</option>
              <option value="Secondary">Boz (Secondary)</option>
              <option value="Danger">Qırmızı (Danger)</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>Reset HWID Düymə Mətni<input id="resetHwidLabelInput" value="Reset HWID" /></label>
          <label>Reset HWID Düymə Rəngi
            <select id="resetHwidStyleInput">
              <option value="Danger" selected>Qırmızı (Danger)</option>
              <option value="Primary">Mavi (Primary)</option>
              <option value="Success">Yaşıl (Success)</option>
              <option value="Secondary">Boz (Secondary)</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>Stats Düymə Mətni<input id="statsLabelInput" value="Get Stats" /></label>
          <label>Stats Düymə Rəngi
            <select id="statsStyleInput">
              <option value="Secondary" selected>Boz (Secondary)</option>
              <option value="Primary">Mavi (Primary)</option>
              <option value="Success">Yaşıl (Success)</option>
              <option value="Danger">Qırmızı (Danger)</option>
            </select>
          </label>
        </div>
        <div><button type="button" class="btn btn-green" id="savePanelDesignBtn">💾 Dizaynı Saxla & Yenilə</button></div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const uiState = {
      initialLoaded: false,
      menuOpen: false,
    };

    const getOrCreateWorkspaceId = () => {
      try {
        const saved = localStorage.getItem('sado_ws_id');
        if (saved) return saved;
        const fresh = 'ws_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
        localStorage.setItem('sado_ws_id', fresh);
        return fresh;
      } catch (_e) {
        return 'default';
      }
    };

    const wsId = getOrCreateWorkspaceId();

    const apiFetch = (url, opts) => {
      const safeOpts = opts || {};
      const headers = Object.assign({ 'X-Client-Workspace': wsId }, safeOpts.headers || {});
      return fetch(url, Object.assign({}, safeOpts, { headers: headers }));
    };

    const showToast = (msg) => {
      const t = document.getElementById('toast');
      if (!t) return;
      t.textContent = String(msg || '');
      t.classList.add('show');
      setTimeout(() => {
        t.classList.remove('show');
      }, 2600);
    };

    const toggleMenu = (forceState) => {
      const nav = document.getElementById('drawerNav');
      if (!nav) return;
      const isCurrentlyOpen = nav.classList.contains('open');
      const nextOpen = typeof forceState === 'boolean' ? forceState : !isCurrentlyOpen;
      uiState.menuOpen = nextOpen;
      nav.classList.toggle('open', nextOpen);
    };

    const openPage = (pageId) => {
      const pages = Array.from(document.querySelectorAll('.page-section'));
      const chips = Array.from(document.querySelectorAll('.nav-chip'));
      pages.forEach((sec) => {
        sec.classList.toggle('active', sec.id === 'page-' + pageId);
      });
      chips.forEach((ch) => {
        ch.classList.toggle('active', ch.getAttribute('data-page') === pageId);
      });
      toggleMenu(false);
    };

    const syncPickerFromHex = (hexVal) => {
      const picker = document.getElementById('embedColorPicker');
      const clean = /^#[0-9a-fA-F]{6}$/.test(String(hexVal || '').trim())
        ? String(hexVal).trim()
        : '#10b981';
      if (picker) picker.value = clean;
    };

    const loadScriptFile = (inputEl) => {
      const file = inputEl && inputEl.files && inputEl.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const box = document.getElementById('scriptCodeInput');
        if (box) box.value = String(reader.result || '');
      };
      reader.readAsText(file);
    };

    const renderCharts = (data) => {
      const st = (data && data.stats) || {};
      const keysArr = (data && data.keys) || [];
      const wlArr = (data && data.whitelists) || [];
      const blArr = (data && data.blacklist) || [];
      const scArr = (data && data.scripts) || [];
      const pnlArr = (data && data.panels) || [];
      const usedCount = keysArr.filter((k) => k.used).length;
      const freeCount = keysArr.length - usedCount;
      const lockedCount = wlArr.filter((w) => w.hwidLocked !== false).length;
      const hwidBoundCount = wlArr.filter((w) => Boolean(w.hwid)).length;
      const area = document.getElementById('chartsArea');
      if (!area) return;

      const items = [
        { label: 'Auth Uğurlu Giriş', val: Number(st.authSuccess || 0), color: '#10b981' },
        { label: 'Auth Bloklanan Cəhd', val: Number(st.authBlocked || 0), color: '#ef4444' },
        { label: 'Key Redeem Sayı', val: Number(st.redeems || 0), color: '#3b82f6' },
        { label: 'Script Fetch Sayı', val: Number(st.scriptFetches || 0), color: '#8b5cf6' },
        { label: 'HWID Sıfırlama', val: Number(st.hwidResets || 0), color: '#f59e0b' },
        { label: 'Ümumi Keylər', val: keysArr.length, color: '#06b6d4' },
        { label: 'İşlənmiş Keylər', val: usedCount, color: '#ec4899' },
        { label: 'Aktiv / Boş Keylər', val: freeCount, color: '#22c55e' },
        { label: 'Aktiv Whitelist', val: wlArr.length, color: '#6366f1' },
        { label: 'HWID Bağlı İstifadəçi', val: hwidBoundCount, color: '#14b8a6' },
        { label: 'HWID Kilidli Qeyd', val: lockedCount, color: '#eab308' },
        { label: 'Blacklist İstifadəçi', val: blArr.length, color: '#dc2626' },
        { label: 'Skript Sayı', val: scArr.length, color: '#a855f7' },
        { label: 'Göndərilmiş Panellər', val: pnlArr.length, color: '#0ea5e9' },
      ];

      const maxVal = Math.max(1, ...items.map((i) => i.val));
      area.innerHTML = items
        .map((i) => {
          const pct = Math.max(2, Math.round((i.val / maxVal) * 100));
          return (
            '<div class="chart-item"><div class="chart-meta"><span>' +
            i.label +
            '</span><strong>' +
            i.val +
            '</strong></div>' +
            '<div class="chart-track"><div class="chart-fill" style="width:' +
            pct +
            '%;background:' +
            i.color +
            '"></div></div></div>'
          );
        })
        .join('');
    };

    const lookupGuildLive = async () => {
      const guildIdInput = document.getElementById('guildIdInput');
      const discordUserIdInput = document.getElementById('discordUserIdInput');
      const kpiGuild = document.getElementById('kpiGuild');
      const subStatus = document.getElementById('subStatus');
      const preview = document.getElementById('liveGuildPreview');
      const guildId = guildIdInput ? guildIdInput.value.trim() : '';
      const discordUserId = discordUserIdInput ? discordUserIdInput.value.trim() : '';
      if (!guildId && !discordUserId) {
        if (preview) preview.textContent = '';
        return;
      }
      const r = await apiFetch('/api/workspace/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: guildId, discordUserId: discordUserId }),
      });
      const j = await r.json();
      if (j && j.guildName) {
        if (kpiGuild) kpiGuild.textContent = j.guildName;
        if (subStatus) subStatus.textContent = 'Control Dashboard • ' + j.guildName;
        if (preview) {
          preview.textContent =
            'Qoşulmuş Sunucu: ' + j.guildName + (j.guildId ? ' (' + j.guildId + ')' : '');
        }
      }
    };

    const renderAll = async () => {
      try {
        const stRes = await apiFetch('/api/status');
        const st = await stRes.json();
        const badge = document.getElementById('botBadge');
        const subStatus = document.getElementById('subStatus');
        const kpiScripts = document.getElementById('kpiScripts');
        const kpiKeys = document.getElementById('kpiKeys');
        const kpiWl = document.getElementById('kpiWl');
        const kpiGuild = document.getElementById('kpiGuild');

        const res = await apiFetch('/api/state');
        const data = await res.json();
        if (!data || !data.ok) return;

        const guildLabel = data.guildName || 'Seçilməyib';
        if (badge) badge.textContent = st && st.botReady ? 'Bot: Online ✅' : 'Bot: Qoşulur...';
        if (subStatus) subStatus.textContent = 'Control Dashboard • ' + guildLabel;
        if (kpiScripts) kpiScripts.textContent = String((data.scripts || []).length);
        if (kpiKeys) kpiKeys.textContent = String((data.keys || []).length);
        if (kpiWl) kpiWl.textContent = String((data.whitelists || []).length);
        if (kpiGuild) kpiGuild.textContent = guildLabel;

        const joinLink = document.getElementById('joinDiscordLink');
        const guildIdInput = document.getElementById('guildIdInput');
        const discordUserIdInput = document.getElementById('discordUserIdInput');
        const liveGuildPreview = document.getElementById('liveGuildPreview');
        if (joinLink && data.inviteUrl) joinLink.href = data.inviteUrl;

        const gSel = document.getElementById('guildSelect');
        if (gSel) {
          const gOpts = (data.guilds || [])
            .map((g) => '<option value="' + g.id + '">' + g.name + ' (' + g.id + ')</option>')
            .join('');
          gSel.innerHTML = '<option value="">-- Sunucu seçin və ya aşağıya ID yazın</option>' + gOpts;
          if (data.guildId) gSel.value = data.guildId;
        }

        const recentKeys = (data.keys || []).slice(0, 5);
        const recentBox = document.getElementById('recentKeysBox');
        if (recentBox) {
          const recentRows = recentKeys
            .map(
              (k) =>
                '<tr><td>' +
                k.key +
                '</td><td>' +
                (k.createdByName || '-') +
                '</td><td>' +
                (k.usedByName || (k.used ? k.usedByDiscordId : 'Hələ işlənməyib')) +
                '</td></tr>'
            )
            .join('');
          recentBox.innerHTML = recentKeys.length
            ? '<table><tr><th>Key</th><th>Yaradan</th><th>İşlədən</th></tr>' + recentRows + '</table>'
            : 'Hələ key yaradılmayıb.';
        }

        renderCharts(data);

        const scriptOpts = (data.scripts || [])
          .map((s) => '<option value="' + s.id + '">' + s.name + '</option>')
          .join('');
        ['panelScriptSelect', 'keyScriptSelect', 'wlScriptSelect'].forEach((selId) => {
          const el = document.getElementById(selId);
          if (el) el.innerHTML = scriptOpts;
        });

        const scriptsListEl = document.getElementById('scriptsList');
        if (scriptsListEl) {
          const loaderBaseOrigin = window.location.origin;
          scriptsListEl.innerHTML = (data.scripts || [])
            .map((s) => {
              const loaderUrl = loaderBaseOrigin + '/loader/' + s.loaderToken + '?ws=' + wsId;
              const loaderCode =
                'script_key = "YOUR_KEY"\nloadstring(game:HttpGet("' + loaderUrl + '"))()';
              return (
                '<div class="script-item"><div class="script-head"><div><strong>📜 ' +
                s.name +
                '</strong><div class="brand-sub">' +
                s.name +
                '.lua</div></div>' +
                '<div><button type="button" class="btn btn-blue btn-sm" data-copy-code="' +
                encodeURIComponent(loaderCode) +
                '">📋 Kopyala</button>' +
                '<button type="button" class="btn btn-red btn-sm" data-del-script="' +
                s.id +
                '">🗑️ Sil</button></div></div>' +
                '<div class="loader-box">' +
                loaderCode.replace(/\n/g, '<br/>') +
                '</div></div>'
              );
            })
            .join('');
        }

        const keysListEl = document.getElementById('keysList');
        if (keysListEl) {
          const keyRows = (data.keys || [])
            .map(
              (k) =>
                '<tr><td>' +
                k.key +
                '</td><td>' +
                (k.createdByName || '-') +
                '</td><td>' +
                (k.usedByName || (k.used ? k.usedByDiscordId : 'Boş')) +
                '</td><td><button type="button" class="btn btn-red btn-sm" data-del-key="' +
                encodeURIComponent(k.key) +
                '">Sil</button></td></tr>'
            )
            .join('');
          keysListEl.innerHTML = (data.keys || []).length
            ? '<table><tr><th>Key</th><th>Yaradan</th><th>İşlədən</th><th>Sil</th></tr>' + keyRows + '</table>'
            : '<div class="brand-sub" style="margin-top:6px;">Hələ key yoxdur.</div>';
        }

        const wlListEl = document.getElementById('wlList');
        if (wlListEl) {
          const wlRows = (data.whitelists || [])
            .map(
              (w) =>
                '<tr><td>' +
                (w.username || w.discordUserId) +
                '<br/><span style="color:#9ca3af">Edən: ' +
                (w.addedByName || '-') +
                '</span></td><td>' +
                (w.hwid || 'Yoxdur') +
                '</td><td>' +
                (w.hwidLocked === false ? 'Açıq' : 'Kilidli') +
                '</td><td>' +
                '<button type="button" class="btn btn-blue btn-sm" data-lock-wl="' +
                w.id +
                '">Kilid</button>' +
                '<button type="button" class="btn btn-purple btn-sm" data-reset-wl="' +
                w.id +
                '">Reset HWID</button>' +
                '<button type="button" class="btn btn-red btn-sm" data-del-wl="' +
                w.id +
                '">Sil</button></td></tr>'
            )
            .join('');
          wlListEl.innerHTML = (data.whitelists || []).length
            ? '<table><tr><th>İstifadəçi</th><th>HWID</th><th>Kilid</th><th>Əməliyyat</th></tr>' + wlRows + '</table>'
            : '<div class="brand-sub" style="margin-top:6px;">Aktiv whitelist yoxdur.</div>';
        }

        const blListEl = document.getElementById('blList');
        if (blListEl) {
          const blRows = (data.blacklist || [])
            .map(
              (b) =>
                '<tr><td>' +
                b.discordUserId +
                '</td><td>' +
                (b.username || '-') +
                '</td><td><button type="button" class="btn btn-red btn-sm" data-del-bl="' +
                b.id +
                '">Çıxar</button></td></tr>'
            )
            .join('');
          blListEl.innerHTML = (data.blacklist || []).length
            ? '<table><tr><th>ID</th><th>Ad</th><th>Sil</th></tr>' + blRows + '</table>'
            : '<div class="brand-sub" style="margin-top:6px;">Blacklist boşdur.</div>';
        }

        if (!uiState.initialLoaded) {
          if (guildIdInput) guildIdInput.value = data.guildId || '';
          if (discordUserIdInput) discordUserIdInput.value = data.discordUserId || '';
          if (liveGuildPreview) {
            liveGuildPreview.textContent = data.guildName
              ? 'Qoşulmuş Sunucu: ' + data.guildName + (data.guildId ? ' (' + data.guildId + ')' : '')
              : '';
          }
          const cfg = data.panelConfig || {};
          if (cfg.embedColor && document.getElementById('embedColorInput')) {
            document.getElementById('embedColorInput').value = cfg.embedColor.toUpperCase();
            syncPickerFromHex(cfg.embedColor);
          }
          if (cfg.title && document.getElementById('panelTitleInput')) {
            document.getElementById('panelTitleInput').value = cfg.title;
          }
          if (cfg.description && document.getElementById('panelDescInput')) {
            document.getElementById('panelDescInput').value = cfg.description;
          }
          if (cfg.redeemLabel && document.getElementById('redeemLabelInput')) {
            document.getElementById('redeemLabelInput').value = cfg.redeemLabel;
          }
          if (cfg.redeemStyle && document.getElementById('redeemStyleInput')) {
            document.getElementById('redeemStyleInput').value = cfg.redeemStyle;
          }
          if (cfg.getScriptLabel && document.getElementById('getScriptLabelInput')) {
            document.getElementById('getScriptLabelInput').value = cfg.getScriptLabel;
          }
          if (cfg.getScriptStyle && document.getElementById('getScriptStyleInput')) {
            document.getElementById('getScriptStyleInput').value = cfg.getScriptStyle;
          }
          if (cfg.resetHwidLabel && document.getElementById('resetHwidLabelInput')) {
            document.getElementById('resetHwidLabelInput').value = cfg.resetHwidLabel;
          }
          if (cfg.resetHwidStyle && document.getElementById('resetHwidStyleInput')) {
            document.getElementById('resetHwidStyleInput').value = cfg.resetHwidStyle;
          }
          if (cfg.statsLabel && document.getElementById('statsLabelInput')) {
            document.getElementById('statsLabelInput').value = cfg.statsLabel;
          }
          if (cfg.statsStyle && document.getElementById('statsStyleInput')) {
            document.getElementById('statsStyleInput').value = cfg.statsStyle;
          }
          uiState.initialLoaded = true;
        }
      } catch (_err) {}
    };

    const copyText = (txt) => {
      const ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Kopyalandı!');
    };

    const createScript = async () => {
      const name = document.getElementById('scriptNameInput').value.trim();
      const code = document.getElementById('scriptCodeInput').value;
      const obfuscate = document.getElementById('createObfCheckbox').checked;
      const obfuscateLevel = Number(document.getElementById('obfLevelSelect').value || 2);
      const r = await apiFetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, code: code, obfuscate: obfuscate, obfuscateLevel: obfuscateLevel }),
      });
      const j = await r.json();
      if (j && j.ok) document.getElementById('scriptNameInput').value = '';
      showToast((j && j.message) || 'Skript yaradıldı');
      await renderAll();
    };

    const deleteScript = async (id) => {
      const r = await apiFetch('/api/scripts/' + id, { method: 'DELETE' });
      const j = await r.json();
      showToast((j && j.message) || 'Silindi');
      await renderAll();
    };

    const runStandaloneObf = async () => {
      const code = document.getElementById('obfInputCode').value;
      const level = Number(document.getElementById('obfLevelSelect').value || 2);
      const r = await apiFetch('/api/obfuscate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, level: level }),
      });
      const j = await r.json();
      if (j && j.obfuscated) document.getElementById('obfResultBox').value = j.obfuscated;
      showToast((j && j.message) || 'Şifrələndi');
    };

    const copyObfCode = () => {
      const val = document.getElementById('obfResultBox').value;
      if (!val) {
        showToast('Şifrələnmiş kod boşdur');
        return;
      }
      copyText(val);
    };

    const saveObfAsScript = async () => {
      const code = document.getElementById('obfResultBox').value;
      const rawName = document.getElementById('obfSaveNameInput').value.trim();
      const name = rawName || 'SADO Protected';
      if (!code) {
        showToast('Əvvəl kodu şifrələyin');
        return;
      }
      const r = await apiFetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, code: code, obfuscate: false }),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Skript kimi saxlandı');
      await renderAll();
    };

    const generateKeys = async () => {
      const scriptId = document.getElementById('keyScriptSelect').value;
      const duration = document.getElementById('keyDurationInput').value.trim();
      const amount = Number(document.getElementById('keyAmountInput').value || 1);
      const createdByDiscordId = document.getElementById('discordUserIdInput').value.trim();
      const r = await apiFetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scriptId: scriptId,
          duration: duration,
          amount: amount,
          createdByDiscordId: createdByDiscordId,
        }),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Key yaradıldı');
      await renderAll();
    };

    const deleteKey = async (k) => {
      const r = await apiFetch('/api/keys/' + k, { method: 'DELETE' });
      const j = await r.json();
      showToast((j && j.message) || 'Silindi');
      await renderAll();
    };

    const addWhitelist = async () => {
      const discordUserId = document.getElementById('wlUserIdInput').value.trim();
      const scriptId = document.getElementById('wlScriptSelect').value;
      const duration = document.getElementById('wlDurationInput').value.trim();
      const hwidLocked = document.getElementById('wlLockCheckbox').checked;
      const addedByDiscordId = document.getElementById('discordUserIdInput').value.trim();
      const r = await apiFetch('/api/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discordUserId: discordUserId,
          scriptId: scriptId,
          duration: duration,
          hwidLocked: hwidLocked,
          addedByDiscordId: addedByDiscordId,
        }),
      });
      const j = await r.json();
      if (j && j.ok) document.getElementById('wlUserIdInput').value = '';
      showToast((j && j.message) || 'Whitelist yeniləndi');
      await renderAll();
    };

    const toggleLock = async (id) => {
      const r = await apiFetch('/api/whitelist/' + id + '/toggle-lock', { method: 'POST' });
      const j = await r.json();
      showToast((j && j.message) || 'Kilid dəyişdi');
      await renderAll();
    };

    const resetHw = async (id) => {
      const r = await apiFetch('/api/whitelist/' + id + '/reset-hwid', { method: 'POST' });
      const j = await r.json();
      showToast((j && j.message) || 'HWID sıfırlandı');
      await renderAll();
    };

    const delWl = async (id) => {
      const r = await apiFetch('/api/whitelist/' + id, { method: 'DELETE' });
      const j = await r.json();
      showToast((j && j.message) || 'Silindi');
      await renderAll();
    };

    const addBlacklist = async () => {
      const discordUserId = document.getElementById('blUserIdInput').value.trim();
      const r = await apiFetch('/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordUserId: discordUserId }),
      });
      const j = await r.json();
      if (j && j.ok) document.getElementById('blUserIdInput').value = '';
      showToast((j && j.message) || 'Blacklist yeniləndi');
      await renderAll();
    };

    const delBl = async (id) => {
      const r = await apiFetch('/api/blacklist/' + id, { method: 'DELETE' });
      const j = await r.json();
      showToast((j && j.message) || 'Silindi');
      await renderAll();
    };

    const linkWorkspace = async () => {
      const guildId = document.getElementById('guildIdInput').value.trim();
      const discordUserId = document.getElementById('discordUserIdInput').value.trim();
      const r = await apiFetch('/api/workspace/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: guildId, discordUserId: discordUserId }),
      });
      const j = await r.json();
      uiState.initialLoaded = false;
      showToast((j && j.message) || 'Yadda saxlandı');
      await renderAll();
    };

    const sendPanelToChannel = async () => {
      const channelId = document.getElementById('panelChannelIdInput').value.trim();
      const scriptId = document.getElementById('panelScriptSelect').value;
      const r = await apiFetch('/api/send-panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channelId, scriptId: scriptId }),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Panel göndərildi');
      await renderAll();
    };

    const savePanelDesign = async () => {
      const payload = {
        embedColor: document.getElementById('embedColorInput').value.trim(),
        title: document.getElementById('panelTitleInput').value.trim(),
        description: document.getElementById('panelDescInput').value.trim(),
        redeemLabel: document.getElementById('redeemLabelInput').value.trim(),
        redeemStyle: document.getElementById('redeemStyleInput').value,
        getScriptLabel: document.getElementById('getScriptLabelInput').value.trim(),
        getScriptStyle: document.getElementById('getScriptStyleInput').value,
        resetHwidLabel: document.getElementById('resetHwidLabelInput').value.trim(),
        resetHwidStyle: document.getElementById('resetHwidStyleInput').value,
        statsLabel: document.getElementById('statsLabelInput').value.trim(),
        statsStyle: document.getElementById('statsStyleInput').value,
      };
      const r = await apiFetch('/api/panel-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Panel dizaynı yeniləndi');
      await renderAll();
    };

    const menuBtn = document.getElementById('menuToggleBtn');
    if (menuBtn) {
      menuBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleMenu();
      });
    }

    document.querySelectorAll('.nav-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const p = chip.getAttribute('data-page');
        if (p) openPage(p);
      });
    });

    document.addEventListener('click', (ev) => {
      const clickedBtn = ev.target && ev.target.closest ? ev.target.closest('#menuToggleBtn, button') : null;
      if (clickedBtn && clickedBtn.id === 'menuToggleBtn') {
        ev.preventDefault();
        ev.stopPropagation();
        toggleMenu();
        return;
      }
      const target = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!target) return;
      if (target.hasAttribute('data-copy-code')) {
        copyText(decodeURIComponent(target.getAttribute('data-copy-code') || ''));
      } else if (target.hasAttribute('data-del-script')) {
        deleteScript(target.getAttribute('data-del-script') || '');
      } else if (target.hasAttribute('data-del-key')) {
        deleteKey(target.getAttribute('data-del-key') || '');
      } else if (target.hasAttribute('data-lock-wl')) {
        toggleLock(target.getAttribute('data-lock-wl') || '');
      } else if (target.hasAttribute('data-reset-wl')) {
        resetHw(target.getAttribute('data-reset-wl') || '');
      } else if (target.hasAttribute('data-del-wl')) {
        delWl(target.getAttribute('data-del-wl') || '');
      } else if (target.hasAttribute('data-del-bl')) {
        delBl(target.getAttribute('data-del-bl') || '');
      }
    });

    const pickerEl = document.getElementById('embedColorPicker');
    const hexEl = document.getElementById('embedColorInput');
    if (pickerEl && hexEl) {
      pickerEl.addEventListener('input', () => {
        hexEl.value = pickerEl.value.toUpperCase();
      });
      hexEl.addEventListener('input', () => {
        syncPickerFromHex(hexEl.value);
      });
    }

    const fileEl = document.getElementById('scriptFileInput');
    if (fileEl) {
      fileEl.addEventListener('change', () => loadScriptFile(fileEl));
    }

    const guildInputEl = document.getElementById('guildIdInput');
    const discordInputEl = document.getElementById('discordUserIdInput');
    const guildSelectEl = document.getElementById('guildSelect');
    if (guildInputEl) guildInputEl.addEventListener('input', lookupGuildLive);
    if (discordInputEl) discordInputEl.addEventListener('input', lookupGuildLive);
    if (guildSelectEl) {
      guildSelectEl.addEventListener('change', () => {
        if (guildInputEl && guildSelectEl.value) {
          guildInputEl.value = guildSelectEl.value;
          lookupGuildLive();
        }
      });
    }

    const actionMap = {
      createScriptBtn: createScript,
      sendPanelBtn: sendPanelToChannel,
      runObfBtn: runStandaloneObf,
      copyObfBtn: copyObfCode,
      saveObfBtn: saveObfAsScript,
      genKeysBtn: generateKeys,
      addWhitelistBtn: addWhitelist,
      addBlacklistBtn: addBlacklist,
      linkWorkspaceBtn: linkWorkspace,
      savePanelDesignBtn: savePanelDesign,
    };

    Object.keys(actionMap).forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', actionMap[id]);
    });

    renderAll();
    setInterval(renderAll, 8000);
  </script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

app.use((err, _req, res, _next) => {
  console.error('[HTTP ERROR]', err && err.message ? err.message : err);
  res.status(500).json({ ok: false, message: 'Daxili server xətası baş verdi.' });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[WEB] SADO PROTECT http://0.0.0.0:${PORT} ünvanında işləyir`);
  const loaded = await loadStore();
  const watchdog = startWatchdog();
  const keepAlive = startRenderKeepAlive();
  const initialLogin = await ensureBotOnline();
  return { loaded, watchdog, keepAlive, initialLogin };
});
