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

const TOKEN_SEGMENTS = [
  'MTU2MjA4MDY1NDI4MjE5OTEyMQ',
  'G9sGiP',
  'dI5vhnMsfDB8CInbnxzeGcDX6WV7GODNsHu2NI',
];
const BOT_TOKEN = String(
  process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || TOKEN_SEGMENTS.join('.')
).trim();
const DEFAULT_INVITE_URL = 'https://discord.gg/sado-protect';

const DEFAULT_BUTTON_ORDER = ['redeem', 'getscript', 'resethwid', 'stats'];

const DEFAULT_PANEL_CONFIG = {
  embedColor: '#10b981',
  title: 'SADO PROTECT • Script Panel',
  description:
    'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin.',
  redeemLabel: 'Redeem Key',
  redeemEmoji: '🔑',
  redeemStyle: 'Success',
  getScriptLabel: 'Get Script',
  getScriptEmoji: '📜',
  getScriptStyle: 'Primary',
  resetHwidLabel: 'Reset HWID',
  resetHwidEmoji: '⚙️',
  resetHwidStyle: 'Danger',
  statsLabel: 'Get Stats',
  statsEmoji: '📊',
  statsStyle: 'Secondary',
  buttonOrder: [...DEFAULT_BUTTON_ORDER],
  footerText: 'SADO PROTECT • Ultra Shield & Loader',
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
  panelConfig: { ...DEFAULT_PANEL_CONFIG, buttonOrder: [...DEFAULT_BUTTON_ORDER] },
  scripts: [
    {
      id: 'sado-hub',
      name: 'SADO HUB',
      loaderToken: 'sado_hub_loader',
      code: DEFAULT_SCRIPT_CODE,
      obfuscated: true,
      obfuscateLevel: 3,
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

const normalizeButtonOrder = (rawOrder) => {
  const allowed = new Set(DEFAULT_BUTTON_ORDER);
  const list = Array.isArray(rawOrder)
    ? rawOrder.map((x) => String(x || '').trim().toLowerCase()).filter((x) => allowed.has(x))
    : [];
  const unique = Array.from(new Set(list));
  for (const item of DEFAULT_BUTTON_ORDER) {
    if (!unique.includes(item)) unique.push(item);
  }
  return unique;
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
  ws.panelConfig = {
    ...DEFAULT_PANEL_CONFIG,
    ...(ws.panelConfig || {}),
    buttonOrder: normalizeButtonOrder(ws.panelConfig && ws.panelConfig.buttonOrder),
  };
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
  const raw = String(durationInput).trim().toLowerCase();
  if (!raw || raw === 'lifetime' || raw === 'perm' || raw === 'unlimited' || raw === '0') {
    return null;
  }
  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/months?|mo/g, 'mo')
    .replace(/days?|d/g, 'd')
    .replace(/hours?|hrs?|h/g, 'h')
    .replace(/minutes?|mins?|m/g, 'm')
    .replace(/seconds?|secs?|s/g, 's');

  const match = normalized.match(/^(\d+)(mo|d|h|m|s)?$/);
  if (!match) {
    const num = Number(normalized);
    if (!Number.isNaN(num) && num > 0) return num * 86400000;
    return null;
  }
  const val = Number(match[1]);
  const unit = match[2] || 'd';
  if (unit === 's') return val * 1000;
  if (unit === 'm') return val * 60000;
  if (unit === 'h') return val * 3600000;
  if (unit === 'mo') return val * 30 * 86400000;
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

const obfuscateLuaCode = (sourceCode, level = 3) => {
  const cleanCode = String(sourceCode || DEFAULT_SCRIPT_CODE);
  const guardPrefix = [
    'local _LP = game:GetService("Players").LocalPlayer',
    'if not _LP or type(hookfunction) == "table" then return end',
  ].join('\n');
  const wrappedSource = `${guardPrefix}\n${cleanCode}`;
  const bytes = Array.from(Buffer.from(wrappedSource, 'utf8'));
  const keyByte = (crypto.randomBytes(1)[0] % 130) + 23;
  const saltByte = (crypto.randomBytes(1)[0] % 89) + 11;
  const xored = bytes.map((b, idx) => ((b ^ ((keyByte + idx * 3 + saltByte) % 255)) % 256));
  const varData = `_s_${crypto.randomBytes(2).toString('hex')}`;
  const varKey = `_k_${crypto.randomBytes(2).toString('hex')}`;
  const varSalt = `_m_${crypto.randomBytes(2).toString('hex')}`;
  const varOut = `_o_${crypto.randomBytes(2).toString('hex')}`;

  if (Number(level) === 1) {
    const b64 = Buffer.from(wrappedSource, 'utf8').toString('base64');
    return [
      '--[[ SADO PROTECT LITE SHIELD ]]--',
      `local ${varOut} = "${b64}"`,
      'local _ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"',
      'local function _d(data)',
      '  data = string.gsub(data, "[^".._ch.."=]", "")',
      '  return (data:gsub(".", function(x)',
      '    if x == "=" then return "" end',
      '    local r,f = "", (_ch:find(x,1,1)-1)',
      '    for i=6,1,-1 do r=r..(f%2^i-f%2^(i-1)>0 and "1" or "0") end',
      '    return r',
      '  end):gsub("%d%d%d?%d?%d?%d?%d?%d?", function(x)',
      '    if #x ~= 8 then return "" end',
      '    local c=0',
      '    for i=1,8 do c=c+(x:sub(i,i)=="1" and 2^(8-i) or 0) end',
      '    return string.char(c)',
      '  end))',
      'end',
      `local _fn = (loadstring or load)(_d(${varOut}))`,
      'if type(_fn) == "function" then return _fn() end',
    ].join('\n');
  }

  if (Number(level) === 2) {
    const hexStream = xored.map((n) => `\\${n}`).join('');
    return [
      '--[[ SADO PROTECT PRO SHIELD ]]--',
      `local ${varKey} = ${keyByte}`,
      `local ${varSalt} = ${saltByte}`,
      `local _raw = "${hexStream}"`,
      `local ${varOut} = {}`,
      `for _i = 1, #_raw do`,
      `  local _c = string.byte(_raw, _i)`,
      `  local _mask = (${varKey} + (_i - 1) * 3 + ${varSalt}) % 255`,
      `  local _v = bit32 and bit32.bxor(_c, _mask) or _c`,
      `  table.insert(${varOut}, string.char(_v))`,
      `end`,
      `local _fn = (loadstring or load)(table.concat(${varOut}))`,
      'if type(_fn) == "function" then return _fn() end',
    ].join('\n');
  }

  const chunkSize = 16;
  const chunks = [];
  for (let i = 0; i < xored.length; i += chunkSize) {
    const part = xored.slice(i, i + chunkSize).join(',');
    chunks.push(`{${part}}`);
  }

  return [
    '--[[ SADO PROTECT ULTRA VM SHIELD ]]--',
    `local ${varKey} = ${keyByte}`,
    `local ${varSalt} = ${saltByte}`,
    `local ${varData} = {${chunks.join(',')}}`,
    `local ${varOut} = {}`,
    'local function _xor(a, b)',
    '  if bit32 and bit32.bxor then return bit32.bxor(a, b) end',
    '  local res, bit = 0, 1',
    '  while a > 0 or b > 0 do',
    '    local pa, pb = a % 2, b % 2',
    '    if pa ~= pb then res = res + bit end',
    '    a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2',
    '  end',
    '  return res',
    'end',
    `for _b = 1, #${varData} do`,
    `  for _i = 1, #${varData}[_b] do`,
    `    local _idx = ((_b - 1) * ${chunkSize}) + _i - 1`,
    `    local _m = (${varKey} + _idx * 3 + ${varSalt}) % 255`,
    `    table.insert(${varOut}, string.char(_xor(${varData}[_b][_i], _m)))`,
    '  end',
    'end',
    `local _exec = (loadstring or load)(table.concat(${varOut}))`,
    'if type(_exec) == "function" then return _exec() end',
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
    const cached =
      client && client.guilds && client.guilds.cache ? client.guilds.cache.get(cleanGuildId) : null;
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

const resolveDiscordProfile = async (discordUserId) => {
  const cleanId = String(discordUserId || '').trim();
  if (!cleanId) return { username: 'Unknown', avatarUrl: '' };
  if (client && client.users && client.users.cache) {
    const u = client.users.cache.get(cleanId);
    if (u && (u.globalName || u.username)) {
      return {
        username: u.globalName || u.username,
        avatarUrl: typeof u.displayAvatarURL === 'function' ? u.displayAvatarURL({ size: 64 }) : '',
      };
    }
  }
  if (BOT_TOKEN && /^\d{15,22}$/.test(cleanId)) {
    try {
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      const userObj = await rest.get(Routes.user(cleanId));
      if (userObj && (userObj.global_name || userObj.username)) {
        const avatarUrl = userObj.avatar
          ? `https://cdn.discordapp.com/avatars/${cleanId}/${userObj.avatar}.png?size=64`
          : '';
        return {
          username: userObj.global_name || userObj.username,
          avatarUrl,
        };
      }
    } catch (_e) {}
  }
  return { username: `User_${cleanId.slice(-4)}`, avatarUrl: '' };
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
  const loaderUrl = `${baseUrl}/loader/${encodeURIComponent(
    sc.loaderToken || sc.id
  )}?ws=${encodeURIComponent(wsId)}`;
  return [
    `script_key = "${keyVal}"`,
    `loadstring(game:HttpGet("${loaderUrl}"))()`,
  ].join('\n');
};

const buildPanelEmbedAndButtons = (ws, sc) => {
  const cfg = {
    ...DEFAULT_PANEL_CONFIG,
    ...(ws.panelConfig || {}),
    buttonOrder: normalizeButtonOrder(ws.panelConfig && ws.panelConfig.buttonOrder),
  };
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

  const buttonDefinitions = {
    redeem: new ButtonBuilder()
      .setCustomId(`sado_redeem_${scriptId}`)
      .setLabel(cfg.redeemLabel || 'Redeem Key')
      .setEmoji(cfg.redeemEmoji || '🔑')
      .setStyle(mapButtonStyle(cfg.redeemStyle, ButtonStyle.Success)),
    getscript: new ButtonBuilder()
      .setCustomId(`sado_getscript_${scriptId}`)
      .setLabel(cfg.getScriptLabel || 'Get Script')
      .setEmoji(cfg.getScriptEmoji || '📜')
      .setStyle(mapButtonStyle(cfg.getScriptStyle, ButtonStyle.Primary)),
    resethwid: new ButtonBuilder()
      .setCustomId(`sado_resethwid_${scriptId}`)
      .setLabel(cfg.resetHwidLabel || 'Reset HWID')
      .setEmoji(cfg.resetHwidEmoji || '⚙️')
      .setStyle(mapButtonStyle(cfg.resetHwidStyle, ButtonStyle.Danger)),
    stats: new ButtonBuilder()
      .setCustomId(`sado_stats_${scriptId}`)
      .setLabel(cfg.statsLabel || 'Get Stats')
      .setEmoji(cfg.statsEmoji || '📊')
      .setStyle(mapButtonStyle(cfg.statsStyle, ButtonStyle.Secondary)),
  };

  const orderedButtons = cfg.buttonOrder
    .map((key) => buttonDefinitions[key])
    .filter(Boolean);

  const row = new ActionRowBuilder().addComponents(...orderedButtons);
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
          .setDescription('Müddət (lifetime, 1 month, 7 day, 3 day, 24 hours, 5 hours, 1 hours, 30 minutes)')
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
        opt
          .setName('duration')
          .setDescription('Müddət (lifetime, 1 month, 7 day, 3 day, 24 hours, 5 hours, 1 hours, 30 minutes)')
          .setRequired(false)
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
        .put(Routes.applicationGuildCommands(appId, String(item.ws.guildId).trim()), {
          body: commands,
        })
        .catch(() => {});
    }
  }
  runtimeState.commandsRegistered = true;
  return true;
};

const ensureBotOnline = async () => {
  if (!BOT_TOKEN) return false;
  if (client.isReady()) return true;
  if (runtimeState.isConnectingNow) return false;
  const now = Date.now();
  if (now - runtimeState.lastConnectAttempt < 4000) return false;
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

  setTimeout(pulse, 10000);
  setInterval(pulse, 40000);
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
  }, 12000);
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
      const invokerAvatar =
        typeof interaction.user.displayAvatarURL === 'function'
          ? interaction.user.displayAvatarURL({ size: 64 })
          : '';
      const selectedScriptArg = interaction.options.getString('script') || '';
      const { ws } = resolveWorkspaceForDiscord({
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
            createdByAvatar: invokerAvatar,
            usedByDiscordId: null,
            usedByName: null,
            usedByAvatar: '',
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
        const targetAvatar =
          typeof targetUser.displayAvatarURL === 'function'
            ? targetUser.displayAvatarURL({ size: 64 })
            : '';

        const existingIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === targetUser.id && w.scriptId === (sc ? sc.id : 'default')
        );
        const entry = {
          id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
          discordUserId: targetUser.id,
          username: targetUser.globalName || targetUser.username,
          avatarUrl: targetAvatar,
          addedByDiscordId: invokerId,
          addedByName: invokerName,
          scriptId: sc ? sc.id : 'default',
          key:
            existingIdx >= 0 && ws.whitelists[existingIdx].key
              ? ws.whitelists[existingIdx].key
              : generateRandomKeyCode(),
          hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
          hwidLocked: true,
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
          content: `✅ <@${targetUser.id}> (**${sc ? sc.name : 'SADO HUB'}**, ${durationStr}) whitelist-ə əlavə olundu. Key: \`${entry.key}\``,
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
            w.hwidLocked = true;
            resetCount += 1;
          }
        }
        ws.stats.hwidResets += resetCount;
        await saveStore();

        await interaction.editReply({
          content:
            resetCount > 0
              ? `🔄 <@${targetUser.id}> istifadəçisinin HWID-si sıfırlandı (${resetCount} qeyd). İlk işlədən cihaza yenidən bağlanacaq.`
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
          .setTitle(`📜 ${sc.name} • Get Script`)
          .setDescription(`\`\`\`lua\n${snippet}\n\`\`\``)
          .addFields(
            { name: '🔑 Script Key', value: `\`${wl.key}\``, inline: true },
            {
              name: '📱 İlk Bağlı Cihaz (HWID)',
              value: wl.hwid ? `\`${wl.hwid}\`` : '`Hələ bağlanmayıb (İlk açan cihaza bağlanacaq)`',
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
          await interaction.editReply({
            content: '❌ HWID sıfırlamaq üçün aktiv key/whitelist tapılmadı.',
          });
          return;
        }
        for (const w of matching) {
          w.hwid = '';
          w.hwidLocked = true;
        }
        ws.stats.hwidResets += matching.length;
        await saveStore();

        await interaction.editReply({
          content: `🔄 HWID uğurla sıfırlandı (${matching.length} qeyd). Skripti növbəti dəfə ilk işlədən cihaza/telefona bağlanacaq.`,
        });
        return;
      }

      if (cid.startsWith('sado_stats_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const userKeys = ws.keys.filter((k) => k.usedByDiscordId === userId);
        const userWl = ws.whitelists.filter(
          (w) => w.discordUserId === userId && !isExpired(w.expiresAt)
        );
        const statsEmbed = new EmbedBuilder()
          .setColor('#8b5cf6')
          .setTitle('📊 Get Stats • İstifadəçi Məlumatı')
          .addFields(
            { name: '👤 İstifadəçi', value: `<@${userId}>`, inline: true },
            { name: '🔑 Aktiv Key / Whitelist', value: String(userWl.length), inline: true },
            { name: '📥 Aktivləşdirilən Keylər', value: String(userKeys.length), inline: true },
            {
              name: '📱 Bağlı HWID-lər',
              value: userWl.length
                ? userWl
                    .map(
                      (w) =>
                        `\`${w.scriptId}\`: ${w.hwid ? `\`${w.hwid}\`` : '_Sıfır / İlk cihaza bağlı deyil_'}`
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
        const userAvatar =
          typeof interaction.user.displayAvatarURL === 'function'
            ? interaction.user.displayAvatarURL({ size: 64 })
            : '';
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
          await interaction.editReply({
            content: '❌ Bu key artıq başqa istifadəçi tərəfindən işlədilib.',
          });
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
        keyObj.usedByAvatar = userAvatar;
        keyObj.usedAt = new Date().toISOString();

        const existingWlIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === userId && w.scriptId === targetScriptId
        );
        const wlRecord = {
          id: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].id : crypto.randomUUID(),
          discordUserId: userId,
          username,
          avatarUrl: userAvatar,
          addedByDiscordId: keyObj.createdByDiscordId || userId,
          addedByName: keyObj.createdByName || username,
          scriptId: targetScriptId,
          key: keyObj.key,
          hwid: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwid || '' : '',
          hwidLocked: true,
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
        await interaction
          .editReply({ content: '⚠️ Əməliyyat zamanı xəta baş verdi.' })
          .catch(() => {});
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
    redeemLabel:
      String(body.redeemLabel || ws.panelConfig.redeemLabel).trim() || 'Redeem Key',
    redeemEmoji:
      String(body.redeemEmoji !== undefined ? body.redeemEmoji : ws.panelConfig.redeemEmoji).trim() ||
      '🔑',
    redeemStyle: String(body.redeemStyle || ws.panelConfig.redeemStyle || 'Success').trim(),
    getScriptLabel:
      String(body.getScriptLabel || ws.panelConfig.getScriptLabel).trim() || 'Get Script',
    getScriptEmoji:
      String(
        body.getScriptEmoji !== undefined ? body.getScriptEmoji : ws.panelConfig.getScriptEmoji
      ).trim() || '📜',
    getScriptStyle: String(
      body.getScriptStyle || ws.panelConfig.getScriptStyle || 'Primary'
    ).trim(),
    resetHwidLabel:
      String(body.resetHwidLabel || ws.panelConfig.resetHwidLabel).trim() || 'Reset HWID',
    resetHwidEmoji:
      String(
        body.resetHwidEmoji !== undefined ? body.resetHwidEmoji : ws.panelConfig.resetHwidEmoji
      ).trim() || '⚙️',
    resetHwidStyle: String(
      body.resetHwidStyle || ws.panelConfig.resetHwidStyle || 'Danger'
    ).trim(),
    statsLabel: String(body.statsLabel || ws.panelConfig.statsLabel).trim() || 'Get Stats',
    statsEmoji:
      String(body.statsEmoji !== undefined ? body.statsEmoji : ws.panelConfig.statsEmoji).trim() ||
      '📊',
    statsStyle: String(body.statsStyle || ws.panelConfig.statsStyle || 'Secondary').trim(),
    buttonOrder: normalizeButtonOrder(body.buttonOrder || ws.panelConfig.buttonOrder),
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
  const level = Number((req.body && req.body.level) || 3);
  const obfuscated = obfuscateLuaCode(code, level);
  res.json({
    ok: true,
    level,
    obfuscated,
    message: 'Lua skripti ultra qoruma ilə şifrələndi!',
  });
});

app.post('/api/scripts', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const name = String((req.body && req.body.name) || '').trim();
  const rawCode = String((req.body && req.body.code) || DEFAULT_SCRIPT_CODE);
  const shouldObf = Boolean(req.body && req.body.obfuscate);
  const obfLevel = Number((req.body && req.body.obfuscateLevel) || 3);
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
    obfuscateLevel: obfLevel,
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
  const creatorId = String(
    (req.body && req.body.createdByDiscordId) || ws.discordUserId || ''
  ).trim();
  const creatorProf = creatorId
    ? await resolveDiscordProfile(creatorId)
    : { username: 'Dashboard Admin', avatarUrl: '' };
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
      createdByName: creatorProf.username,
      createdByAvatar: creatorProf.avatarUrl,
      usedByDiscordId: null,
      usedByName: null,
      usedByAvatar: '',
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
  const hwidLocked =
    req.body && req.body.hwidLocked !== undefined ? Boolean(req.body.hwidLocked) : true;
  const adderId = String(
    (req.body && req.body.addedByDiscordId) || ws.discordUserId || ''
  ).trim();
  if (!discordUserId) {
    res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    return;
  }
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;
  const resolvedUser = await resolveDiscordProfile(discordUserId);
  const resolvedAdder = adderId
    ? await resolveDiscordProfile(adderId)
    : { username: 'Dashboard Admin', avatarUrl: '' };

  const existingIdx = ws.whitelists.findIndex(
    (w) => w.discordUserId === discordUserId && w.scriptId === scriptId
  );
  const entry = {
    id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
    discordUserId,
    username: resolvedUser.username,
    avatarUrl: resolvedUser.avatarUrl,
    addedByDiscordId: adderId || null,
    addedByName: resolvedAdder.username,
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
  wl.hwidLocked = true;
  ws.stats.hwidResets += 1;
  await saveStore();
  res.json({
    ok: true,
    workspaceId: wsId,
    message: 'HWID sıfırlandı! İlk açan cihaza bağlanacaq.',
  });
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
  const prof = await resolveDiscordProfile(discordUserId);
  const blItem = {
    id: crypto.randomUUID(),
    discordUserId,
    username: prof.username,
    avatarUrl: prof.avatarUrl,
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
    'end)',
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
    '  local fn = (loadstring or load)(parsed.code)',
    '  if type(fn) == "function" then fn() end',
    'else',
    '  local reason = (type(parsed) == "table" and parsed.message) or "SADO PROTECT: HWID Mismatch / Unauthorized"',
    '  if LocalPlayer then pcall(function() LocalPlayer:Kick(tostring(reason)) end) end',
    'end',
  ].join('\n');

  res.type('text/plain').send(luaLoader);
});

app.all('/api/verify', async (req, res) => {
  try {
    const wsId = sanitizeWorkspaceId(
      req.query.ws ||
        (req.body && req.body.workspaceId) ||
        runtimeState.store.activeWorkspaceId ||
        'default'
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
          (req.body &&
            req.body.playerId &&
            String(w.discordUserId) === String(req.body.playerId)))
    );

    if (!wl) {
      ws.stats.authBlocked += 1;
      await saveStore();
      res
        .status(403)
        .json({ ok: false, message: 'SADO PROTECT: Key və ya Whitelist tapılmadı. Kick!' });
      return;
    }

    const isBl = ws.blacklist.some(
      (b) => b.discordUserId === wl.discordUserId && (!b.scriptId || b.scriptId === targetScriptId)
    );
    if (isBl) {
      ws.stats.authBlocked += 1;
      await saveStore();
      res
        .status(403)
        .json({ ok: false, message: 'SADO PROTECT: Siz Blacklist olunmusunuz. Kick!' });
      return;
    }

    if (isExpired(wl.expiresAt)) {
      ws.stats.authBlocked += 1;
      await saveStore();
      res
        .status(403)
        .json({ ok: false, message: 'SADO PROTECT: Lisenziya müddəti bitib. Kick!' });
      return;
    }

    if (hwidInput && wl.hwidLocked !== false) {
      if (!wl.hwid || String(wl.hwid).trim() === '') {
        wl.hwid = hwidInput;
        await saveStore();
      } else if (String(wl.hwid).trim() !== hwidInput) {
        ws.stats.authBlocked += 1;
        await saveStore();
        res.status(403).json({
          ok: false,
          message: 'SADO PROTECT: Bu key başqa cihaza bağlıdır! Kick!',
        });
        return;
      }
    }

    ws.stats.authSuccess += 1;
    await saveStore();

    const payloadCode =
      sc && sc.obfuscated
        ? obfuscateLuaCode(sc.code, sc.obfuscateLevel || 3)
        : sc
        ? sc.code
        : DEFAULT_SCRIPT_CODE;

    res.json({
      ok: true,
      scriptId: targetScriptId,
      code: payloadCode,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Verify xətası' });
  }
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <title>SADO PROTECT • Cyber Command V3</title>
  <style>
    :root {
      --bg-base: #04060b;
      --bg-surface: #0b0f19;
      --bg-card: #101726;
      --line: rgba(255, 255, 255, 0.09);
      --gold: #f59e0b;
      --teal: #14b8a6;
      --sky: #38bdf8;
      --rose: #fb7185;
      --txt: #f8fafc;
      --sub: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    body {
      background:
        radial-gradient(circle at 0% 0%, rgba(245, 158, 11, 0.13), transparent 38%),
        radial-gradient(circle at 100% 100%, rgba(20, 184, 166, 0.14), transparent 42%),
        var(--bg-base);
      color: var(--txt);
      min-height: 100vh;
    }
    .shell { max-width: 1140px; margin: 0 auto; padding: 14px 14px 44px; display: grid; gap: 16px; }
    .topbar {
      background: rgba(11, 15, 25, 0.94);
      border: 1px solid rgba(245, 158, 11, 0.28);
      border-radius: 22px;
      padding: 12px 15px;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    }
    .brand-group { display: flex; align-items: center; gap: 12px; }
    .menu-trigger {
      width: 48px; height: 48px; border-radius: 15px;
      border: 1px solid rgba(245, 158, 11, 0.55);
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #090d16; font-size: 23px; font-weight: 900;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; touch-action: manipulation;
    }
    .brand-name { font-size: 18px; font-weight: 900; letter-spacing: 0.6px; color: #fbbf24; }
    .brand-meta { font-size: 12px; color: var(--sub); margin-top: 2px; }
    .status-pill {
      padding: 7px 12px; border-radius: 999px; font-size: 12px; font-weight: 800;
      background: rgba(20, 184, 166, 0.14); color: #2dd4bf;
      border: 1px solid rgba(20, 184, 166, 0.35); white-space: nowrap;
    }

    /* Fullscreen Command Menu Modal */
    #navOverlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(4, 6, 11, 0.95);
      padding: 20px 16px;
      display: none; flex-direction: column; gap: 12px;
      overflow-y: auto;
    }
    .nav-top { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    .close-nav {
      width: 42px; height: 42px; border-radius: 12px;
      border: 1px solid var(--line); background: var(--bg-card);
      color: #fff; font-size: 18px; font-weight: 900; cursor: pointer;
    }
    .menu-card-btn {
      width: 100%; text-align: left; padding: 15px 16px; border-radius: 16px;
      border: 1px solid var(--line); background: var(--bg-card);
      color: var(--txt); font-size: 14px; font-weight: 800; cursor: pointer;
      display: flex; align-items: center; gap: 12px;
    }
    .menu-card-btn.active {
      background: linear-gradient(135deg, #f59e0b, #ea580c);
      color: #090d16; border-color: #fde68a;
    }

    .page-panel { display: none; gap: 16px; }
    .page-panel.active { display: grid; }

    .bento-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 12px; }
    .bento-tile {
      background: var(--bg-card); border: 1px solid var(--line);
      border-radius: 20px; padding: 16px;
      border-left: 4px solid var(--gold);
    }
    .bento-label { font-size: 12px; color: var(--sub); font-weight: 700; }
    .bento-val { font-size: 24px; font-weight: 900; margin-top: 8px; color: #fff; word-break: break-word; }

    .card-block {
      background: var(--bg-surface); border: 1px solid var(--line);
      border-radius: 22px; padding: 18px; display: grid; gap: 14px;
    }
    .card-block h2 { font-size: 16px; font-weight: 900; color: #fde68a; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(235px, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; font-size: 12px; font-weight: 700; color: var(--sub); }
    input, select, textarea {
      width: 100%; background: #060912; border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 13px; padding: 11px 13px; color: #fff; font-size: 14px; outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--gold); }
    textarea { min-height: 110px; font-family: ui-monospace, monospace; }

    .btn {
      border: none; border-radius: 13px; padding: 11px 16px; font-size: 13px; font-weight: 800;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      text-decoration: none;
    }
    .btn-gold { background: linear-gradient(135deg, #f59e0b, #d97706); color: #090d16; }
    .btn-teal { background: linear-gradient(135deg, #14b8a6, #0d9488); color: #042f2e; }
    .btn-sky { background: linear-gradient(135deg, #38bdf8, #0284c7); color: #fff; }
    .btn-rose { background: linear-gradient(135deg, #fb7185, #e11d48); color: #fff; }
    .btn-dark { background: #1e293b; color: #f8fafc; border: 1px solid var(--line); }
    .btn-sm { padding: 7px 10px; font-size: 12px; border-radius: 9px; }

    .script-box {
      background: #070b14; border: 1px solid var(--line);
      border-radius: 16px; padding: 14px; display: grid; gap: 10px;
    }
    .script-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
    .loader-box {
      background: #03050a; border: 1px solid rgba(20, 184, 166, 0.3);
      border-radius: 12px; padding: 11px; font-family: ui-monospace, monospace;
      font-size: 12px; color: #2dd4bf; word-break: break-all; line-height: 1.5;
    }
    .prof-chip { display: inline-flex; align-items: center; gap: 7px; }
    .prof-img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; background: #1e293b; }
    .order-list { display: grid; gap: 8px; }
    .order-row {
      display: flex; align-items: center; justify-content: space-between;
      background: #070b14; border: 1px solid var(--line);
      border-radius: 12px; padding: 10px 12px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 6px; text-align: left; }
    th { color: var(--sub); }
    .toast {
      position: fixed; bottom: 18px; right: 18px; z-index: 10000;
      background: linear-gradient(135deg, #f59e0b, #14b8a6); color: #090d16;
      font-weight: 900; padding: 12px 18px; border-radius: 14px;
      display: none;
    }
  </style>
</head>
<body>
  <div id="navOverlay">
    <div class="nav-top">
      <div>
        <div class="brand-name">SADO PROTECT</div>
        <div class="brand-meta">Bölmə Seçin</div>
      </div>
      <button type="button" class="close-nav" id="closeMenuBtn" onclick="document.getElementById('navOverlay').style.display='none'">✕</button>
    </div>

    <button type="button" class="menu-card-btn active" data-page="overview" onclick="window.__sadoSwitchPage && window.__sadoSwitchPage('overview')">
      <span>1️⃣</span><span>Skriptlər, Keylər, Whitelist, Blacklist &amp; Sunucu</span>
    </button>
    <button type="button" class="menu-card-btn" data-page="scripts" onclick="window.__sadoSwitchPage && window.__sadoSwitchPage('scripts')">
      <span>2️⃣</span><span>Script Yaratma &amp; Ultra Obfuscation</span>
    </button>
    <button type="button" class="menu-card-btn" data-page="keys" onclick="window.__sadoSwitchPage && window.__sadoSwitchPage('keys')">
      <span>3️⃣</span><span>Key, Whitelist &amp; Blacklist</span>
    </button>
    <button type="button" class="menu-card-btn" data-page="discord" onclick="window.__sadoSwitchPage && window.__sadoSwitchPage('discord')">
      <span>4️⃣</span><span>Discord Bot &amp; Panel Dizayn</span>
    </button>
    <button type="button" class="menu-card-btn" data-page="sendpanel" onclick="window.__sadoSwitchPage && window.__sadoSwitchPage('sendpanel')">
      <span>📤</span><span>Kanala Panel Göndər</span>
    </button>
  </div>

  <div class="shell">
    <header class="topbar">
      <div class="brand-group">
        <button type="button" class="menu-trigger" id="openMenuBtn" aria-label="Menyu" onclick="document.getElementById('navOverlay').style.display='flex'">☰</button>
        <div>
          <div class="brand-name">SADO PROTECT</div>
          <div class="brand-meta" id="headerSub">Cyber Command • Qoşulan Sunucu: Seçilməyib</div>
        </div>
      </div>
      <div class="status-pill" id="botStatusChip">Bot: Qoşulur...</div>
    </header>

    <!-- 1-Cİ BÖLMƏ -->
    <section class="page-panel active" id="page-overview">
      <div class="bento-stats">
        <div class="bento-tile"><div class="bento-label">Skriptlər</div><div class="bento-val" id="statScripts">0</div></div>
        <div class="bento-tile"><div class="bento-label">Keylər</div><div class="bento-val" id="statKeys">0</div></div>
        <div class="bento-tile"><div class="bento-label">Whitelist</div><div class="bento-val" id="statWl">0</div></div>
        <div class="bento-tile"><div class="bento-label">Blacklist</div><div class="bento-val" id="statBl">0</div></div>
        <div class="bento-tile"><div class="bento-label">Qoşulan Sunucu</div><div class="bento-val" id="statGuild">Seçilməyib</div></div>
      </div>

      <div class="card-block">
        <h2>🕒 Son Key-lər (Yaradan &amp; İşlədən Profil)</h2>
        <div id="recentKeysTable" class="brand-meta">Hələ key yaradılmayıb.</div>
      </div>
    </section>

    <!-- 2-Cİ BÖLMƏ -->
    <section class="page-panel" id="page-scripts">
      <div class="card-block">
        <h2>📜 Yeni Skript Yarat &amp; Dosyadan Yüklə</h2>
        <div class="grid-2">
          <label>Skript Adı<input id="scNameInput" placeholder="Məs: SADO HUB V3" /></label>
          <label>Dosyadan Yüklə (.lua / .txt)<input type="file" id="scFileInput" accept=".lua,.txt,text/plain" /></label>
        </div>
        <label>Lua Skript Kodu<textarea id="scCodeInput" placeholder="print('SADO PROTECT')"></textarea></label>
        <div class="grid-2">
          <label>Ultra Qoruma Səviyyəsi
            <select id="scObfLevel">
              <option value="1">Level 1 — Base64 Shield</option>
              <option value="2">Level 2 — XOR Byte Shield</option>
              <option value="3" selected>Level 3 — Ultra VM Shield</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding-top:20px;cursor:pointer;">
            <input type="checkbox" id="scObfToggle" checked style="width:18px;height:18px;" />
            <span>Obfuscation Açıq / Bağlı</span>
          </label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" class="btn btn-gold" id="createScriptBtn">➕ Skript Yarat</button>
          <button type="button" class="btn btn-sky" id="testObfBtn">🛡️ Kodu Şifrələ (Preview)</button>
        </div>
        <label>Şifrələnmiş Kod Nəticəsi<textarea id="scObfPreview" readonly></textarea></label>
      </div>

      <div class="card-block">
        <h2>📂 Mövcud Skriptlər (Get Script: Əvvəl Script Key, Sonra Loadstring)</h2>
        <div id="existingScriptsList"></div>
      </div>
    </section>

    <!-- 3-CÜ BÖLMƏ -->
    <section class="page-panel" id="page-keys">
      <div class="card-block">
        <h2>🔑 Key Yarat (Müddət Seçimi ilə)</h2>
        <div class="grid-2">
          <label>Skript<select id="keyScSelect"></select></label>
          <label>Vaxt Seçimi
            <select id="keyDurSelect">
              <option value="lifetime" selected>lifetime</option>
              <option value="1 month">1 month</option>
              <option value="7 day">7 day</option>
              <option value="3 day">3 day</option>
              <option value="24 hours">24 hours</option>
              <option value="5 hours">5 hours</option>
              <option value="1 hours">1 hours</option>
              <option value="30 minutes">30 minutes</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label>Key Sayı<input id="keyCountInput" type="number" min="1" max="50" value="1" /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="button" class="btn btn-gold" id="genKeysBtn">🔑 Key Yarat</button>
          </div>
        </div>
        <div id="allKeysTable"></div>
      </div>

      <div class="card-block">
        <h2>✅ Whitelist (Vaxt &amp; İlk Cihaz HWID Kilidi)</h2>
        <div class="grid-2">
          <label>Discord User ID<input id="wlDiscordInput" placeholder="Məs: 987654321098765432" /></label>
          <label>Skript<select id="wlScSelect"></select></label>
        </div>
        <div class="grid-2">
          <label>Vaxt Seçimi
            <select id="wlDurSelect">
              <option value="lifetime" selected>lifetime</option>
              <option value="1 month">1 month</option>
              <option value="7 day">7 day</option>
              <option value="3 day">3 day</option>
              <option value="24 hours">24 hours</option>
              <option value="5 hours">5 hours</option>
              <option value="1 hours">1 hours</option>
              <option value="30 minutes">30 minutes</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding-top:20px;cursor:pointer;">
            <input type="checkbox" id="wlHwidCheck" checked style="width:18px;height:18px;" />
            <span>İlk işlədən telefona/cihaza HWID kilidlə</span>
          </label>
        </div>
        <div>
          <button type="button" class="btn btn-teal" id="addWlBtn">➕ Whitelist-ə Əlavə Et</button>
        </div>
        <div id="allWlTable"></div>
      </div>

      <div class="card-block">
        <h2>🚫 Blacklist</h2>
        <div class="grid-2">
          <label>Discord User ID<input id="blDiscordInput" placeholder="Discord User ID" /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="button" class="btn btn-rose" id="addBlBtn">🚫 Blacklist-ə At</button>
          </div>
        </div>
        <div id="allBlTable"></div>
      </div>
    </section>

    <!-- 4-CÜ BÖLMƏ -->
    <section class="page-panel" id="page-discord">
      <div class="card-block">
        <h2>🤖 1. Join Discord &amp; 2. Sunucu ID Bağlantısı</h2>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
          <a id="inviteBotAnchor" href="https://discord.gg/sado-protect" target="_blank" rel="noopener noreferrer" class="btn btn-sky">💬 Join Discord (Botu Dəvət Et)</a>
          <span class="status-pill" id="guildNameLiveBadge">Sunucu Adı: Seçilməyib</span>
        </div>
        <div class="grid-2">
          <label>Botun Olduğu Sunucular<select id="botGuildDropdown"></select></label>
          <label>Sunucu (Guild) ID<input id="inputGuildId" placeholder="Sunucu ID yazın..." /></label>
        </div>
        <div class="grid-2">
          <label>Sahib Discord User ID<input id="inputOwnerDiscordId" placeholder="Discord User ID..." /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="button" class="btn btn-gold" id="saveWsLinkBtn">🔗 Sunucuya Bağla</button>
          </div>
        </div>
      </div>

      <div class="card-block">
        <h2>🎨 Panel Dizaynı (Düymə Adı, Emoji, Rəng &amp; Sıra)</h2>
        <div class="grid-2">
          <label>Embed Rəngi (Hex)<input id="cfgEmbedColor" value="#10B981" /></label>
          <label>Rəng Seçici<input type="color" id="cfgColorPicker" value="#10b981" style="height:44px;padding:4px;" /></label>
        </div>
        <div class="grid-2">
          <label>Panel Başlığı<input id="cfgTitle" value="SADO PROTECT • Script Panel" /></label>
          <label>Panel Təsviri<input id="cfgDesc" value="Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin." /></label>
        </div>

        <div class="grid-2">
          <label>1. Düymə Adı (Redeem)<input id="cfgRedeemLabel" value="Redeem Key" /></label>
          <label>Emoji<input id="cfgRedeemEmoji" value="🔑" /></label>
          <label>Rəngi
            <select id="cfgRedeemStyle">
              <option value="Success" selected>Yaşıl (Success)</option>
              <option value="Primary">Mavi (Primary)</option>
              <option value="Secondary">Boz (Secondary)</option>
              <option value="Danger">Qırmızı (Danger)</option>
            </select>
          </label>
        </div>

        <div class="grid-2">
          <label>2. Düymə Adı (Get Script)<input id="cfgGetScriptLabel" value="Get Script" /></label>
          <label>Emoji<input id="cfgGetScriptEmoji" value="📜" /></label>
          <label>Rəngi
            <select id="cfgGetScriptStyle">
              <option value="Primary" selected>Mavi (Primary)</option>
              <option value="Success">Yaşıl (Success)</option>
              <option value="Secondary">Boz (Secondary)</option>
              <option value="Danger">Qırmızı (Danger)</option>
            </select>
          </label>
        </div>

        <div class="grid-2">
          <label>3. Düymə Adı (Reset HWID)<input id="cfgResetHwidLabel" value="Reset HWID" /></label>
          <label>Emoji<input id="cfgResetHwidEmoji" value="⚙️" /></label>
          <label>Rəngi
            <select id="cfgResetHwidStyle">
              <option value="Danger" selected>Qırmızı (Danger)</option>
              <option value="Primary">Mavi (Primary)</option>
              <option value="Success">Yaşıl (Success)</option>
              <option value="Secondary">Boz (Secondary)</option>
            </select>
          </label>
        </div>

        <div class="grid-2">
          <label>4. Düymə Adı (Get Stats)<input id="cfgStatsLabel" value="Get Stats" /></label>
          <label>Emoji<input id="cfgStatsEmoji" value="📊" /></label>
          <label>Rəngi
            <select id="cfgStatsStyle">
              <option value="Secondary" selected>Boz (Secondary)</option>
              <option value="Primary">Mavi (Primary)</option>
              <option value="Success">Yaşıl (Success)</option>
              <option value="Danger">Qırmızı (Danger)</option>
            </select>
          </label>
        </div>

        <div>
          <label style="margin-bottom:8px;">Butonların Yerini Dəyiş (Sıralama)</label>
          <div class="order-list" id="btnOrderStack"></div>
        </div>

        <div>
          <button type="button" class="btn btn-gold" id="saveDesignBtn">💾 Dizaynı Saxla &amp; Aktiv Paneldə Yenilə</button>
        </div>
      </div>
    </section>

    <!-- KANALA PANEL GÖNDƏR -->
    <section class="page-panel" id="page-sendpanel">
      <div class="card-block">
        <h2>📤 Discord Kanalına Skript Paneli Göndər</h2>
        <div class="grid-2">
          <label>Discord Channel ID<input id="sendChannelIdInput" placeholder="Kanal ID yazın..." /></label>
          <label>Mövcud Skript<select id="sendScriptSelect"></select></label>
        </div>
        <div>
          <button type="button" class="btn btn-teal" id="sendPanelBtn">📤 Paneli Göndər</button>
        </div>
      </div>
    </section>
  </div>

  <div class="toast" id="toastBox"></div>

  <script>
    const BTN_NAMES = {
      redeem: 'Redeem Key',
      getscript: 'Get Script',
      resethwid: 'Reset HWID',
      stats: 'Get Stats',
    };

    const uiState = {
      hydrated: false,
      buttonOrder: ['redeem', 'getscript', 'resethwid', 'stats'],
    };

    const getWsId = () => {
      try {
        const saved = localStorage.getItem('sado_cyber_ws');
        if (saved) return saved;
        const fresh = 'ws_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('sado_cyber_ws', fresh);
        return fresh;
      } catch (_e) {
        return 'default';
      }
    };

    const wsId = getWsId();

    const apiCall = (url, opts) => {
      const options = opts || {};
      const headers = Object.assign({ 'X-Client-Workspace': wsId }, options.headers || {});
      return fetch(url, Object.assign({}, options, { headers }));
    };

    const showToast = (msg) => {
      const el = document.getElementById('toastBox');
      if (!el) return;
      el.textContent = String(msg || '');
      el.style.display = 'block';
      setTimeout(() => {
        el.style.display = 'none';
      }, 2400);
    };

    const setMenuVisible = (visible) => {
      const overlay = document.getElementById('navOverlay');
      if (overlay) overlay.style.display = visible ? 'flex' : 'none';
    };

    const activatePage = (pageKey) => {
      const targetKey = String(pageKey || 'overview');
      document.querySelectorAll('.page-panel').forEach((panel) => {
        const match = panel.id === 'page-' + targetKey;
        panel.classList.toggle('active', match);
        panel.style.display = match ? 'grid' : 'none';
      });
      document.querySelectorAll('.menu-card-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-page') === targetKey);
      });
      setMenuVisible(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    window.__sadoSwitchPage = activatePage;
    window.__sadoCloseMenu = () => setMenuVisible(false);

    const renderButtonOrderList = () => {
      const box = document.getElementById('btnOrderStack');
      if (!box) return;
      box.innerHTML = uiState.buttonOrder
        .map((key, idx) => {
          return (
            '<div class="order-row"><strong>#' +
            (idx + 1) +
            ' • ' +
            (BTN_NAMES[key] || key) +
            '</strong><div style="display:flex;gap:6px;">' +
            '<button type="button" class="btn btn-dark btn-sm" data-move-key="' +
            key +
            '" data-move-dir="-1">⬆️</button>' +
            '<button type="button" class="btn btn-dark btn-sm" data-move-key="' +
            key +
            '" data-move-dir="1">⬇️</button>' +
            '</div></div>'
          );
        })
        .join('');
    };

    const renderProfile = (name, avatarUrl, fallback) => {
      const txt = name || fallback || '-';
      const img = avatarUrl ? '<img class="prof-img" src="' + avatarUrl + '" alt="" />' : '';
      return '<span class="prof-chip">' + img + '<span>' + txt + '</span></span>';
    };

    const loadAllData = async () => {
      try {
        const [stRes, stateRes] = await Promise.all([apiCall('/api/status'), apiCall('/api/state')]);
        const st = await stRes.json();
        const data = await stateRes.json();
        if (!data || !data.ok) return;

        const setText = (id, val) => {
          const el = document.getElementById(id);
          if (el) el.textContent = String(val);
        };
        const setHtml = (id, val) => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = String(val);
        };

        const gName = data.guildName || 'Seçilməyib';
        setText('botStatusChip', st && st.botReady ? 'Bot: Online ✅' : 'Bot: Qoşulur...');
        setText('headerSub', 'Cyber Command • Qoşulan Sunucu: ' + gName);
        setText('statScripts', (data.scripts || []).length);
        setText('statKeys', (data.keys || []).length);
        setText('statWl', (data.whitelists || []).length);
        setText('statBl', (data.blacklist || []).length);
        setText('statGuild', gName);

        const invEl = document.getElementById('inviteBotAnchor');
        if (invEl && data.inviteUrl) invEl.href = data.inviteUrl;

        const gDrop = document.getElementById('botGuildDropdown');
        if (gDrop) {
          const opts = (data.guilds || [])
            .map((g) => '<option value="' + g.id + '">' + g.name + ' (' + g.id + ')</option>')
            .join('');
          gDrop.innerHTML = '<option value="">-- Botun olduğu sunucunu seçin</option>' + opts;
          if (data.guildId) gDrop.value = data.guildId;
        }

        const scOpts = (data.scripts || [])
          .map((s) => '<option value="' + s.id + '">' + s.name + '</option>')
          .join('');
        ['keyScSelect', 'wlScSelect', 'sendScriptSelect'].forEach((id) => {
          setHtml(id, scOpts);
        });

        const recentList = (data.keys || []).slice(0, 8);
        setHtml(
          'recentKeysTable',
          recentList.length
            ? '<table><tr><th>Key</th><th>Vaxt</th><th>Yaradan</th><th>İşlədən</th></tr>' +
                recentList
                  .map(
                    (k) =>
                      '<tr><td><code>' +
                      k.key +
                      '</code></td><td>' +
                      (k.duration || 'lifetime') +
                      '</td><td>' +
                      renderProfile(k.createdByName, k.createdByAvatar, '-') +
                      '</td><td>' +
                      (k.used
                        ? renderProfile(k.usedByName, k.usedByAvatar, k.usedByDiscordId)
                        : 'Hələ işlənməyib') +
                      '</td></tr>'
                  )
                  .join('') +
                '</table>'
            : 'Hələ key yaradılmayıb.'
        );

        const origin = window.location.origin;
        setHtml(
          'existingScriptsList',
          (data.scripts || [])
            .map((s) => {
              const loaderUrl = origin + '/loader/' + s.loaderToken + '?ws=' + wsId;
              const snippet = 'script_key = "YOUR_KEY"\nloadstring(game:HttpGet("' + loaderUrl + '"))()';
              const badge = s.obfuscated
                ? '🛡️ Obfuscation Açıq (Lv.' + (s.obfuscateLevel || 3) + ')'
                : 'Obfuscation Bağlı';
              return (
                '<div class="script-box"><div class="script-head"><div><strong>📜 ' +
                s.name +
                '</strong><div class="brand-meta">' +
                badge +
                '</div></div><div style="display:flex;gap:8px;">' +
                '<button type="button" class="btn btn-teal btn-sm" data-copy-snippet="' +
                encodeURIComponent(snippet) +
                '">📋 Get Script Kopyala</button>' +
                '<button type="button" class="btn btn-rose btn-sm" data-del-script="' +
                s.id +
                '">🗑️ Sil</button></div></div>' +
                '<div class="loader-box">' +
                snippet.replace(/\n/g, '<br/>') +
                '</div></div>'
              );
            })
            .join('')
        );

        setHtml(
          'allKeysTable',
          (data.keys || []).length
            ? '<table><tr><th>Key</th><th>Skript</th><th>Vaxt</th><th>Yaradan</th><th>İşlədən</th><th>Sil</th></tr>' +
                (data.keys || [])
                  .map(
                    (k) =>
                      '<tr><td><code>' +
                      k.key +
                      '</code></td><td>' +
                      (k.scriptName || '-') +
                      '</td><td>' +
                      (k.duration || 'lifetime') +
                      '</td><td>' +
                      renderProfile(k.createdByName, k.createdByAvatar, '-') +
                      '</td><td>' +
                      (k.used
                        ? renderProfile(k.usedByName, k.usedByAvatar, k.usedByDiscordId)
                        : 'Boş') +
                      '</td><td><button type="button" class="btn btn-rose btn-sm" data-del-key="' +
                      encodeURIComponent(k.key) +
                      '">Sil</button></td></tr>'
                  )
                  .join('') +
                '</table>'
            : '<div class="brand-meta">Hələ key yaradılmayıb.</div>'
        );

        setHtml(
          'allWlTable',
          (data.whitelists || []).length
            ? '<table><tr><th>İstifadəçi</th><th>Bağlı HWID</th><th>Kilid</th><th>Əməliyyat</th></tr>' +
                (data.whitelists || [])
                  .map(
                    (w) =>
                      '<tr><td>' +
                      renderProfile(w.username, w.avatarUrl, w.discordUserId) +
                      '<div class="brand-meta">Edən: ' +
                      (w.addedByName || '-') +
                      '</div></td><td><code>' +
                      (w.hwid || 'İlk cihaza bağlanacaq') +
                      '</code></td><td>' +
                      (w.hwidLocked === false ? 'Açıq' : 'Kilidli') +
                      '</td><td><div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                      '<button type="button" class="btn btn-sky btn-sm" data-lock-wl="' +
                      w.id +
                      '">Kilid</button>' +
                      '<button type="button" class="btn btn-gold btn-sm" data-reset-wl="' +
                      w.id +
                      '">Reset HWID</button>' +
                      '<button type="button" class="btn btn-rose btn-sm" data-del-wl="' +
                      w.id +
                      '">Sil</button></div></td></tr>'
                  )
                  .join('') +
                '</table>'
            : '<div class="brand-meta">Aktiv whitelist yoxdur.</div>'
        );

        setHtml(
          'allBlTable',
          (data.blacklist || []).length
            ? '<table><tr><th>İstifadəçi</th><th>ID</th><th>Sil</th></tr>' +
                (data.blacklist || [])
                  .map(
                    (b) =>
                      '<tr><td>' +
                      renderProfile(b.username, b.avatarUrl, b.discordUserId) +
                      '</td><td>' +
                      b.discordUserId +
                      '</td><td><button type="button" class="btn btn-rose btn-sm" data-del-bl="' +
                      b.id +
                      '">Çıxar</button></td></tr>'
                  )
                  .join('') +
                '</table>'
            : '<div class="brand-meta">Blacklist boşdur.</div>'
        );

        if (!uiState.hydrated) {
          const gInp = document.getElementById('inputGuildId');
          const oInp = document.getElementById('inputOwnerDiscordId');
          if (gInp) gInp.value = data.guildId || '';
          if (oInp) oInp.value = data.discordUserId || '';
          setText('guildNameLiveBadge', 'Sunucu Adı: ' + (data.guildName || 'Seçilməyib'));
          const cfg = data.panelConfig || {};
          if (cfg.embedColor) {
            const hexEl = document.getElementById('cfgEmbedColor');
            const pickEl = document.getElementById('cfgColorPicker');
            if (hexEl) hexEl.value = cfg.embedColor.toUpperCase();
            if (pickEl) pickEl.value = cfg.embedColor;
          }
          const fieldMap = {
            cfgTitle: cfg.title,
            cfgDesc: cfg.description,
            cfgRedeemLabel: cfg.redeemLabel,
            cfgRedeemEmoji: cfg.redeemEmoji,
            cfgRedeemStyle: cfg.redeemStyle,
            cfgGetScriptLabel: cfg.getScriptLabel,
            cfgGetScriptEmoji: cfg.getScriptEmoji,
            cfgGetScriptStyle: cfg.getScriptStyle,
            cfgResetHwidLabel: cfg.resetHwidLabel,
            cfgResetHwidEmoji: cfg.resetHwidEmoji,
            cfgResetHwidStyle: cfg.resetHwidStyle,
            cfgStatsLabel: cfg.statsLabel,
            cfgStatsEmoji: cfg.statsEmoji,
            cfgStatsStyle: cfg.statsStyle,
          };
          Object.entries(fieldMap).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el && val !== undefined && val !== null) el.value = val;
          });
          if (Array.isArray(cfg.buttonOrder) && cfg.buttonOrder.length) {
            uiState.buttonOrder = cfg.buttonOrder.slice();
          }
          renderButtonOrderList();
          uiState.hydrated = true;
        }
      } catch (_e) {}
    };

    document.getElementById('openMenuBtn').addEventListener('click', () => setMenuVisible(true));
    document.getElementById('closeMenuBtn').addEventListener('click', () => setMenuVisible(false));

    document.querySelectorAll('.menu-card-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activatePage(btn.getAttribute('data-page'));
      });
    });

    document.getElementById('scFileInput').addEventListener('change', (ev) => {
      const f = ev.target && ev.target.files && ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        document.getElementById('scCodeInput').value = String(r.result || '');
        const n = document.getElementById('scNameInput');
        if (n && !n.value.trim()) n.value = f.name.replace(/\.(lua|txt)$/i, '');
      };
      r.readAsText(f);
    });

    document.getElementById('createScriptBtn').addEventListener('click', async () => {
      const name = document.getElementById('scNameInput').value.trim();
      const code = document.getElementById('scCodeInput').value;
      const obfuscate = document.getElementById('scObfToggle').checked;
      const obfuscateLevel = Number(document.getElementById('scObfLevel').value || 3);
      const r = await apiCall('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, code, obfuscate, obfuscateLevel }),
      });
      const j = await r.json();
      if (j && j.ok) document.getElementById('scNameInput').value = '';
      showToast((j && j.message) || 'Skript yaradıldı');
      await loadAllData();
    });

    document.getElementById('testObfBtn').addEventListener('click', async () => {
      const code = document.getElementById('scCodeInput').value;
      const level = Number(document.getElementById('scObfLevel').value || 3);
      const r = await apiCall('/api/obfuscate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, level }),
      });
      const j = await r.json();
      if (j && j.obfuscated) document.getElementById('scObfPreview').value = j.obfuscated;
      showToast((j && j.message) || 'Şifrələndi');
    });

    document.getElementById('genKeysBtn').addEventListener('click', async () => {
      const scriptId = document.getElementById('keyScSelect').value;
      const duration = document.getElementById('keyDurSelect').value;
      const amount = Number(document.getElementById('keyCountInput').value || 1);
      const createdByDiscordId = document.getElementById('inputOwnerDiscordId').value.trim();
      const r = await apiCall('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptId, duration, amount, createdByDiscordId }),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Key yaradıldı');
      await loadAllData();
    });

    document.getElementById('addWlBtn').addEventListener('click', async () => {
      const discordUserId = document.getElementById('wlDiscordInput').value.trim();
      const scriptId = document.getElementById('wlScSelect').value;
      const duration = document.getElementById('wlDurSelect').value;
      const hwidLocked = document.getElementById('wlHwidCheck').checked;
      const addedByDiscordId = document.getElementById('inputOwnerDiscordId').value.trim();
      const r = await apiCall('/api/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordUserId, scriptId, duration, hwidLocked, addedByDiscordId }),
      });
      const j = await r.json();
      if (j && j.ok) document.getElementById('wlDiscordInput').value = '';
      showToast((j && j.message) || 'Whitelist yeniləndi');
      await loadAllData();
    });

    document.getElementById('addBlBtn').addEventListener('click', async () => {
      const discordUserId = document.getElementById('blDiscordInput').value.trim();
      const r = await apiCall('/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordUserId }),
      });
      const j = await r.json();
      if (j && j.ok) document.getElementById('blDiscordInput').value = '';
      showToast((j && j.message) || 'Blacklist yeniləndi');
      await loadAllData();
    });

    const syncGuildLive = async () => {
      const guildId = document.getElementById('inputGuildId').value.trim();
      const discordUserId = document.getElementById('inputOwnerDiscordId').value.trim();
      if (!guildId && !discordUserId) return;
      const r = await apiCall('/api/workspace/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, discordUserId }),
      });
      const j = await r.json();
      if (j && j.guildName) {
        document.getElementById('statGuild').textContent = j.guildName;
        document.getElementById('headerSub').textContent = 'Cyber Command • Qoşulan Sunucu: ' + j.guildName;
        document.getElementById('guildNameLiveBadge').textContent = 'Sunucu Adı: ' + j.guildName;
      }
    };

    document.getElementById('botGuildDropdown').addEventListener('change', (ev) => {
      if (!ev.target.value) return;
      document.getElementById('inputGuildId').value = ev.target.value;
      syncGuildLive();
    });

    document.getElementById('inputGuildId').addEventListener('input', syncGuildLive);
    document.getElementById('inputOwnerDiscordId').addEventListener('input', syncGuildLive);

    document.getElementById('saveWsLinkBtn').addEventListener('click', async () => {
      const guildId = document.getElementById('inputGuildId').value.trim();
      const discordUserId = document.getElementById('inputOwnerDiscordId').value.trim();
      const r = await apiCall('/api/workspace/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, discordUserId }),
      });
      const j = await r.json();
      uiState.hydrated = false;
      showToast((j && j.message) || 'Sunucu bağlandı');
      await loadAllData();
    });

    document.getElementById('cfgColorPicker').addEventListener('input', (ev) => {
      document.getElementById('cfgEmbedColor').value = ev.target.value.toUpperCase();
    });

    document.getElementById('cfgEmbedColor').addEventListener('input', (ev) => {
      const val = ev.target.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        document.getElementById('cfgColorPicker').value = val;
      }
    });

    document.getElementById('saveDesignBtn').addEventListener('click', async () => {
      const payload = {
        embedColor: document.getElementById('cfgEmbedColor').value.trim(),
        title: document.getElementById('cfgTitle').value.trim(),
        description: document.getElementById('cfgDesc').value.trim(),
        redeemLabel: document.getElementById('cfgRedeemLabel').value.trim(),
        redeemEmoji: document.getElementById('cfgRedeemEmoji').value.trim(),
        redeemStyle: document.getElementById('cfgRedeemStyle').value,
        getScriptLabel: document.getElementById('cfgGetScriptLabel').value.trim(),
        getScriptEmoji: document.getElementById('cfgGetScriptEmoji').value.trim(),
        getScriptStyle: document.getElementById('cfgGetScriptStyle').value,
        resetHwidLabel: document.getElementById('cfgResetHwidLabel').value.trim(),
        resetHwidEmoji: document.getElementById('cfgResetHwidEmoji').value.trim(),
        resetHwidStyle: document.getElementById('cfgResetHwidStyle').value,
        statsLabel: document.getElementById('cfgStatsLabel').value.trim(),
        statsEmoji: document.getElementById('cfgStatsEmoji').value.trim(),
        statsStyle: document.getElementById('cfgStatsStyle').value,
        buttonOrder: uiState.buttonOrder.slice(),
      };
      const r = await apiCall('/api/panel-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Panel dizaynı yeniləndi');
      await loadAllData();
    });

    document.getElementById('sendPanelBtn').addEventListener('click', async () => {
      const channelId = document.getElementById('sendChannelIdInput').value.trim();
      const scriptId = document.getElementById('sendScriptSelect').value;
      const r = await apiCall('/api/send-panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, scriptId }),
      });
      const j = await r.json();
      showToast((j && j.message) || 'Panel göndərildi');
      await loadAllData();
    });

    document.addEventListener('click', async (ev) => {
      const target = ev.target.closest('button');
      if (!target) return;

      if (target.hasAttribute('data-copy-snippet')) {
        const raw = decodeURIComponent(target.getAttribute('data-copy-snippet') || '');
        const ta = document.createElement('textarea');
        ta.value = raw;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Get Script kodu kopyalandı!');
        return;
      }

      if (target.hasAttribute('data-del-script')) {
        const r = await apiCall('/api/scripts/' + target.getAttribute('data-del-script'), { method: 'DELETE' });
        const j = await r.json();
        showToast((j && j.message) || 'Skript silindi');
        await loadAllData();
        return;
      }

      if (target.hasAttribute('data-del-key')) {
        const r = await apiCall('/api/keys/' + target.getAttribute('data-del-key'), { method: 'DELETE' });
        const j = await r.json();
        showToast((j && j.message) || 'Key silindi');
        await loadAllData();
        return;
      }

      if (target.hasAttribute('data-lock-wl')) {
        const r = await apiCall('/api/whitelist/' + target.getAttribute('data-lock-wl') + '/toggle-lock', { method: 'POST' });
        const j = await r.json();
        showToast((j && j.message) || 'Kilid dəyişdi');
        await loadAllData();
        return;
      }

      if (target.hasAttribute('data-reset-wl')) {
        const r = await apiCall('/api/whitelist/' + target.getAttribute('data-reset-wl') + '/reset-hwid', { method: 'POST' });
        const j = await r.json();
        showToast((j && j.message) || 'HWID sıfırlandı');
        await loadAllData();
        return;
      }

      if (target.hasAttribute('data-del-wl')) {
        const r = await apiCall('/api/whitelist/' + target.getAttribute('data-del-wl'), { method: 'DELETE' });
        const j = await r.json();
        showToast((j && j.message) || 'Whitelist silindi');
        await loadAllData();
        return;
      }

      if (target.hasAttribute('data-del-bl')) {
        const r = await apiCall('/api/blacklist/' + target.getAttribute('data-del-bl'), { method: 'DELETE' });
        const j = await r.json();
        showToast((j && j.message) || 'Blacklist silindi');
        await loadAllData();
        return;
      }

      if (target.hasAttribute('data-move-key')) {
        const key = target.getAttribute('data-move-key');
        const dir = Number(target.getAttribute('data-move-dir') || 0);
        const idx = uiState.buttonOrder.indexOf(key);
        const next = idx + dir;
        if (idx >= 0 && next >= 0 && next < uiState.buttonOrder.length) {
          const copy = uiState.buttonOrder.slice();
          const tmp = copy[idx];
          copy[idx] = copy[next];
          copy[next] = tmp;
          uiState.buttonOrder = copy;
          renderButtonOrderList();
        }
      }
    });

    renderButtonOrderList();
    loadAllData();
    setInterval(loadAllData, 6500);
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
