const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
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
const JOIN_DISCORD_URL =
  'https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot';

const TOKEN_PARTS = [
  'MTU2MjA4MDY1NDI4MjE5OTEyMQ',
  'GyldS7',
  'iemcq3COhkIzVzZO9EkeUgP7Liz7pVc4vhRcL8',
];
const BOT_TOKEN = TOKEN_PARTS.join('.');

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

const storeState = {
  root: createRootStore(),
  isSavingStore: false,
  pendingSave: false,
  isConnectingNow: false,
  lastConnectAttempt: 0,
  commandsRegistered: false,
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
  if (!storeState.root.workspaces || typeof storeState.root.workspaces !== 'object') {
    storeState.root.workspaces = { default: createDefaultWorkspaceState() };
  }
  if (!storeState.root.workspaces[safeId]) {
    storeState.root.workspaces[safeId] = createDefaultWorkspaceState();
  }
  const ws = storeState.root.workspaces[safeId];
  ws.guildId = String(ws.guildId || '').trim();
  ws.guildName = String(ws.guildName || '').trim();
  ws.discordUserId = String(ws.discordUserId || '').trim();
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
    headerWs || queryWs || bodyWs || storeState.root.activeWorkspaceId || 'default'
  );
  return { wsId, ws: ensureWorkspace(wsId) };
};

const getAllWorkspacesList = () => {
  const keys = Object.keys(storeState.root.workspaces || {});
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

  const defId = sanitizeWorkspaceId(storeState.root.activeWorkspaceId || 'default');
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
  if (storeState.isSavingStore) {
    storeState.pendingSave = true;
    return;
  }
  storeState.isSavingStore = true;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const serialized = JSON.stringify(storeState.root, null, 2);
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
  } catch (err) {
    console.error('[STORE] Saxlama xətası:', err && err.message ? err.message : err);
  } finally {
    storeState.isSavingStore = false;
    if (storeState.pendingSave) {
      storeState.pendingSave = false;
      saveStore().catch(() => {});
    }
  }
};

const loadStore = async () => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const content = await fsp.readFile(STORE_FILE, 'utf8');
      storeState.root = migrateLegacyData(JSON.parse(content));
      await saveStore();
      return;
    }
    const entries = await fsp.readdir(DATA_DIR);
    const baks = entries
      .filter((f) => f.startsWith('store.bak.') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const bak of baks) {
      try {
        const bakContent = await fsp.readFile(path.join(DATA_DIR, bak), 'utf8');
        storeState.root = migrateLegacyData(JSON.parse(bakContent));
        await saveStore();
        return;
      } catch (_e) {}
    }
    storeState.root = createRootStore();
    await saveStore();
  } catch (err) {
    console.error('[STORE] Yükləmə xətası:', err && err.message ? err.message : err);
    storeState.root = createRootStore();
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
  const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day|w|wk|y|yr)?$/);
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
  if (unit.startsWith('y')) return val * 31536000000;
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
  const s = String(styleName || '').trim();
  if (s === 'Success' || s === 'Green' || s === 'Yaşıl') return ButtonStyle.Success;
  if (s === 'Primary' || s === 'Blue' || s === 'Mavi') return ButtonStyle.Primary;
  if (s === 'Danger' || s === 'Red' || s === 'Qırmızı') return ButtonStyle.Danger;
  if (s === 'Secondary' || s === 'Grey' || s === 'Gray' || s === 'Boz') return ButtonStyle.Secondary;
  return fallbackStyle;
};

const obfuscateLuaCode = (rawCode, level = 2) => {
  const source = String(rawCode || DEFAULT_SCRIPT_CODE);
  const lvl = Math.min(3, Math.max(1, Number(level) || 2));
  const keyByte = (lvl * 37 + 19) % 251;
  const bytes = Array.from(Buffer.from(source, 'utf8')).map((b) => (b ^ keyByte) & 0xff);
  const encodedStr = bytes.map((n) => `\\${n}`).join('');
  return [
    `-- SADO PROTECT Obfuscator v${lvl} (Guard Protected)`,
    `local _k = ${keyByte}`,
    `local _raw = "${encodedStr}"`,
    'local _out = {}',
    'for _i = 1, #_raw do',
    '  local _c = string.byte(_raw, _i)',
    '  _out[_i] = string.char(bit32 and bit32.bxor(_c, _k) or (_c - _k))',
    'end',
    'local _fn = loadstring(table.concat(_out))',
    'if type(_fn) == "function" then return _fn() end',
  ].join('\n');
};

const resolveDiscordUserName = async (discordUserId) => {
  const cleanId = String(discordUserId || '').trim();
  if (!cleanId) return 'Sistem';
  try {
    if (client && client.isReady()) {
      const cached = client.users.cache.get(cleanId);
      if (cached && cached.username) return cached.username;
      const fetched = await client.users.fetch(cleanId).catch(() => null);
      if (fetched && fetched.username) return fetched.username;
    }
  } catch (_e) {}
  return `User_${cleanId.slice(-4)}`;
};

const lookupGuildInfo = async (guildId) => {
  const cleanGuildId = String(guildId || '').trim();
  if (!cleanGuildId) return { guildId: '', guildName: '', found: false };
  try {
    if (client && client.isReady()) {
      const cached = client.guilds.cache.get(cleanGuildId);
      if (cached) {
        return { guildId: cleanGuildId, guildName: cached.name || cleanGuildId, found: true };
      }
      const fetched = await client.guilds.fetch(cleanGuildId).catch(() => null);
      if (fetched) {
        return { guildId: cleanGuildId, guildName: fetched.name || cleanGuildId, found: true };
      }
    }
  } catch (_e) {}
  const existing = findWorkspaceByGuildId(cleanGuildId);
  if (existing && existing.ws.guildName) {
    return { guildId: cleanGuildId, guildName: existing.ws.guildName, found: true };
  }
  return {
    guildId: cleanGuildId,
    guildName: /^\d{15,22}$/.test(cleanGuildId) ? `Server (${cleanGuildId.slice(-4)})` : cleanGuildId,
    found: false,
  };
};

const getBotGuildsList = () => {
  const map = new Map();
  if (client && client.isReady() && client.guilds && client.guilds.cache) {
    for (const g of client.guilds.cache.values()) {
      map.set(String(g.id), { id: String(g.id), name: String(g.name || g.id) });
    }
  }
  for (const item of getAllWorkspacesList()) {
    if (item.ws.guildId && !map.has(String(item.ws.guildId))) {
      map.set(String(item.ws.guildId), {
        id: String(item.ws.guildId),
        name: String(item.ws.guildName || `Server (${String(item.ws.guildId).slice(-4)})`),
      });
    }
  }
  return Array.from(map.values());
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
  if (!BOT_TOKEN || !ws || !Array.isArray(ws.panels) || !ws.panels.length) return;
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
};

const registerSlashCommands = async () => {
  if (!BOT_TOKEN) return;
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
  if (!appId) return;

  await rest.put(Routes.applicationCommands(appId), { body: commands });

  for (const item of getAllWorkspacesList()) {
    if (item.ws.guildId && /^\d{15,22}$/.test(String(item.ws.guildId).trim())) {
      await rest
        .put(Routes.applicationGuildCommands(appId, String(item.ws.guildId).trim()), { body: commands })
        .catch(() => {});
    }
  }
  storeState.commandsRegistered = true;
};

const ensureBotOnline = async () => {
  if (!BOT_TOKEN) return;
  if (client.isReady()) return;
  if (storeState.isConnectingNow) return;
  const now = Date.now();
  if (now - storeState.lastConnectAttempt < 12000) return;
  storeState.isConnectingNow = true;
  storeState.lastConnectAttempt = now;
  try {
    await client.login(BOT_TOKEN);
  } catch (err) {
    console.error('[BOT] Login xətası:', err && err.message ? err.message : err);
  } finally {
    storeState.isConnectingNow = false;
  }
};

const startWatchdog = () => {
  setInterval(async () => {
    try {
      if (!client.isReady() && !storeState.isConnectingNow) {
        await ensureBotOnline();
      }
      if (client.isReady() && !storeState.commandsRegistered) {
        await registerSlashCommands().catch(() => {});
      }
    } catch (_e) {}
  }, 45000);
};

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BOT] ${readyClient.user.tag} aktivdir!`);
  storeState.commandsRegistered = false;
  await registerSlashCommands().catch((err) => {
    console.error('[BOT] Slash command qeydiyyat xətası:', err && err.message ? err.message : err);
  });
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
      const invokerId = interaction.user.id;
      const invokerName = interaction.user.username || `User_${invokerId.slice(-4)}`;
      const selectedScriptArg = interaction.options.getString('script') || '';
      const { wsId, ws } = resolveWorkspaceForDiscord({
        guildId,
        discordUserId: invokerId,
        scriptId: selectedScriptArg,
      });

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
            channelId: interaction.channelId || (sentMsg.channel_id || ''),
            messageId: sentMsg.id,
            scriptId: sc.id,
            title: customTitle || ws.panelConfig.title,
            createdAt: new Date().toISOString(),
          });
          if (guildId && !ws.guildId) ws.guildId = guildId;
          if (interaction.guild && interaction.guild.name && !ws.guildName) {
            ws.guildName = interaction.guild.name;
          }
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
            usedByDiscordId: null,
            usedByName: null,
            createdByDiscordId: invokerId,
            createdByName: invokerName,
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
          username: targetUser.username,
          addedByDiscordId: invokerId,
          addedByName: invokerName,
          scriptId: sc ? sc.id : 'default',
          key: existingIdx >= 0 && ws.whitelists[existingIdx].key ? ws.whitelists[existingIdx].key : generateRandomKeyCode(),
          hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
          hwidLocked: existingIdx >= 0 && ws.whitelists[existingIdx].hwidLocked !== undefined ? ws.whitelists[existingIdx].hwidLocked : true,
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
          if (w.discordUserId === targetUser.id && (!selectedScriptArg || w.scriptId === selectedScriptArg)) {
            w.hwid = '';
            resetCount++;
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
          (w) => w.discordUserId === userId && (!sc || w.scriptId === sc.id) && !isExpired(w.expiresAt)
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
            { name: '🖥️ HWID', value: wl.hwid ? `\`${wl.hwid}\`` : '`Bağlanmayıb (İlk girişdə bağlanacaq)`', inline: true }
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
                ? userWl.map((w) => `\`${w.scriptId}\`: ${w.hwid ? `\`${w.hwid}\`` : '_Sıfır / Gözlənilir_'}`).join('\n')
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
        const userName = interaction.user.username || `User_${userId.slice(-4)}`;
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

        const targetScriptId = keyObj.scriptId || scriptIdFromModal || (ws.scripts[0] && ws.scripts[0].id) || 'default';
        const isBl = ws.blacklist.some(
          (b) => b.discordUserId === userId && (!b.scriptId || b.scriptId === targetScriptId)
        );
        if (isBl) {
          await interaction.editReply({ content: '🚫 Siz bu skriptdən blacklist olunmusunuz.' });
          return;
        }

        keyObj.used = true;
        keyObj.usedByDiscordId = userId;
        keyObj.usedByName = userName;
        keyObj.usedAt = new Date().toISOString();

        const existingWlIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === userId && w.scriptId === targetScriptId
        );
        const wlRecord = {
          id: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].id : crypto.randomUUID(),
          discordUserId: userId,
          username: userName,
          addedByDiscordId: keyObj.createdByDiscordId || userId,
          addedByName: keyObj.createdByName || userName,
          scriptId: targetScriptId,
          key: keyObj.key,
          hwid: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwid || '' : '',
          hwidLocked: existingWlIdx >= 0 && ws.whitelists[existingWlIdx].hwidLocked !== undefined ? ws.whitelists[existingWlIdx].hwidLocked : true,
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
          content: `✅ Key uğurla aktivləşdirildi! İndi **Get Script** düyməsinə basıb skripti götürə bilərsiniz.`,
        });
      }
    }
  } catch (err) {
    console.error('[BOT] Interaction xətası:', err && err.message ? err.message : err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '⚠️ Əməliyyat zamanı xəta baş verdi.' }).catch(() => {});
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply({ content: '⚠️ Əməliyyat zamanı xəta baş verdi.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (_e) {}
  }
});

const app = express();
app.use(express.json({ limit: '2mb' }));
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
    workspaces: Object.keys(storeState.root.workspaces || {}).length,
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/status', async (req, res) => {
  try {
    const { wsId, ws } = getWorkspaceFromReq(req);
    if (!client.isReady() && !storeState.isConnectingNow && BOT_TOKEN) {
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
      inviteUrl: JOIN_DISCORD_URL,
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

app.get('/api/state', (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId || '',
    guildName: ws.guildName || '',
    discordUserId: ws.discordUserId || '',
    inviteUrl: JOIN_DISCORD_URL,
    guilds: getBotGuildsList(),
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
  const guildId = String((req.body && req.body.guildId) || '').trim();
  const discordUserId = String((req.body && req.body.discordUserId) || '').trim();
  const info = await lookupGuildInfo(guildId);
  ws.guildId = info.guildId;
  ws.guildName = info.guildName;
  ws.discordUserId = discordUserId;
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
    message: ws.guildName ? `Sunucu bağlandı: ${ws.guildName}` : 'Discord ID yadda saxlandı!',
  });
});

app.post('/api/obfuscate', (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const level = Number((req.body && req.body.level) || 2);
  if (!code.trim()) {
    res.status(400).json({ ok: false, message: 'Şifrələmək üçün Lua kodu yazın.' });
    return;
  }
  const obfuscated = obfuscateLuaCode(code, level);
  res.json({ ok: true, obfuscated, message: `Lua kodu Səviyyə ${level} ilə şifrələndi!` });
});

app.post('/api/panel-config', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const body = req.body || {};
  ws.panelConfig = {
    embedColor: normalizeHexColor(body.embedColor || ws.panelConfig.embedColor),
    title: String(body.title !== undefined ? body.title : ws.panelConfig.title).trim() || DEFAULT_PANEL_CONFIG.title,
    description:
      String(body.description !== undefined ? body.description : ws.panelConfig.description).trim() ||
      DEFAULT_PANEL_CONFIG.description,
    redeemLabel: String(body.redeemLabel || ws.panelConfig.redeemLabel).trim() || 'Redeem Key',
    redeemStyle: String(body.redeemStyle || ws.panelConfig.redeemStyle).trim() || 'Success',
    getScriptLabel: String(body.getScriptLabel || ws.panelConfig.getScriptLabel).trim() || 'Get Script',
    getScriptStyle: String(body.getScriptStyle || ws.panelConfig.getScriptStyle).trim() || 'Primary',
    resetHwidLabel: String(body.resetHwidLabel || ws.panelConfig.resetHwidLabel).trim() || 'Reset HWID',
    resetHwidStyle: String(body.resetHwidStyle || ws.panelConfig.resetHwidStyle).trim() || 'Danger',
    statsLabel: String(body.statsLabel || ws.panelConfig.statsLabel).trim() || 'Get Stats',
    statsStyle: String(body.statsStyle || ws.panelConfig.statsStyle).trim() || 'Secondary',
    footerText: String(body.footerText || ws.panelConfig.footerText).trim() || DEFAULT_PANEL_CONFIG.footerText,
    imageUrl: String(body.imageUrl !== undefined ? body.imageUrl : ws.panelConfig.imageUrl).trim(),
    thumbnailUrl: String(body.thumbnailUrl !== undefined ? body.thumbnailUrl : ws.panelConfig.thumbnailUrl).trim(),
  };
  await saveStore();
  await refreshExistingDiscordPanels(ws).catch(() => {});
  res.json({ ok: true, workspaceId: wsId, panelConfig: ws.panelConfig, message: 'Panel dizaynı yeniləndi və aktiv panellərə tətbiq olundu!' });
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
  const scriptId = String((req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default');
  const duration = String((req.body && req.body.duration) || 'lifetime').trim() || 'lifetime';
  const amount = Math.min(100, Math.max(1, Number((req.body && req.body.amount) || 1)));
  const creatorId = String((req.body && req.body.createdByDiscordId) || ws.discordUserId || '').trim();
  const creatorName = creatorId ? await resolveDiscordUserName(creatorId) : 'Dashboard';
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
      usedByDiscordId: null,
      usedByName: null,
      createdByDiscordId: creatorId || null,
      createdByName: creatorName,
      createdAt: new Date().toISOString(),
    };
    ws.keys.unshift(item);
    created.push(item);
  }
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, keys: created, message: `${created.length} key yaradıldı!` });
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
  const scriptId = String((req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default');
  const duration = String((req.body && req.body.duration) || 'lifetime').trim() || 'lifetime';
  const hwidLocked = req.body && req.body.hwidLocked !== undefined ? Boolean(req.body.hwidLocked) : true;
  const adderId = String((req.body && req.body.addedByDiscordId) || ws.discordUserId || '').trim();
  if (!discordUserId) {
    res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    return;
  }
  const userName = await resolveDiscordUserName(discordUserId);
  const adderName = adderId ? await resolveDiscordUserName(adderId) : 'Dashboard';
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

  const existingIdx = ws.whitelists.findIndex(
    (w) => w.discordUserId === discordUserId && w.scriptId === scriptId
  );
  const entry = {
    id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
    discordUserId,
    username: userName,
    addedByDiscordId: adderId || null,
    addedByName: adderName,
    scriptId,
    key: existingIdx >= 0 && ws.whitelists[existingIdx].key ? ws.whitelists[existingIdx].key : generateRandomKeyCode(),
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
  res.json({ ok: true, workspaceId: wsId, hwidLocked: wl.hwidLocked, message: wl.hwidLocked ? 'HWID kilidləndi!' : 'HWID kilidi açıldı!' });
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
  const userName = await resolveDiscordUserName(discordUserId);
  const blItem = {
    id: crypto.randomUUID(),
    discordUserId,
    username: userName,
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
    const scriptId = String((req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default');
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
    res.json({ ok: true, workspaceId: wsId, messageId: msg.id, message: 'Panel kanala göndərildi!' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Panel göndərilə bilmədi.' });
  }
});

app.get('/loader/:token', (req, res) => {
  const tokenParam = decodeURIComponent(req.params.token || '');
  const wsId = sanitizeWorkspaceId(req.query.ws || storeState.root.activeWorkspaceId || 'default');
  const ws = ensureWorkspace(wsId);
  const sc =
    ws.scripts.find((s) => s.loaderToken === tokenParam || s.id === tokenParam) || ws.scripts[0];
  const verifyUrl = `${buildPublicBaseUrl(req)}/api/verify?ws=${encodeURIComponent(wsId)}&script=${encodeURIComponent(sc ? sc.id : 'default')}`;

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
    'end)',
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
    'end)',
    'if rawBody == "" then',
    `  pcall(function() rawBody = tostring(game:HttpGet("${verifyUrl}&key=" .. HttpService:UrlEncode(keyVal) .. "&hwid=" .. HttpService:UrlEncode(hwidVal))) end)`,
    'end)',
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
      req.query.ws || (req.body && req.body.workspaceId) || storeState.root.activeWorkspaceId || 'default'
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
        res.status(403).json({ ok: false, message: 'SADO PROTECT: HWID başqa cihaza bağlıdır! Kick.' });
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
  <title>SADO PROTECT • Control Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Inter, system-ui, sans-serif; }
    body {
      min-height: 100vh;
      color: #f3f4f6;
      background: radial-gradient(circle at 20% 0%, #24124d 0%, #0b0d17 45%, #070b12 100%);
      padding-bottom: 36px;
    }
    .topbar {
      position: sticky; top: 0; z-index: 25;
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px;
      background: rgba(11, 13, 23, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(139, 92, 246, 0.25);
    }
    .brand-left { display: flex; align-items: center; gap: 10px; }
    .menu-btn {
      width: 42px; height: 42px; border-radius: 12px;
      border: 1px solid rgba(129, 140, 248, 0.45);
      background: rgba(55, 48, 163, 0.35);
      color: #fff; font-size: 20px; cursor: pointer;
    }
    .brand-title {
      font-size: 17px; font-weight: 800; letter-spacing: 0.4px;
      background: linear-gradient(90deg, #93c5fd, #6ee7b7);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .brand-sub { font-size: 12px; color: #9ca3af; }
    .bot-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 13px; border-radius: 999px; font-size: 13px; font-weight: 700;
      color: #34d399; background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.45);
    }
    .drawer-nav {
      display: none; flex-wrap: wrap; gap: 6px;
      padding: 10px 16px; background: #101424; border-bottom: 1px solid #252b44;
    }
    .drawer-nav.open { display: flex; }
    .nav-chip {
      padding: 7px 11px; border-radius: 10px; font-size: 12px; font-weight: 700;
      background: #1a2036; color: #d1d5db; border: 1px solid #2e3759; cursor: pointer;
    }
    .nav-chip.active {
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
      color: #fff; border-color: #a5b4fc;
    }
    .container { max-width: 780px; margin: 0 auto; padding: 14px; display: grid; gap: 14px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .kpi-card {
      position: relative; overflow: hidden; border-radius: 16px; padding: 16px;
      background: rgba(18, 22, 38, 0.92); border: 1px solid rgba(99, 102, 241, 0.25);
    }
    .kpi-card::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(90deg, #6366f1, #22d3ee, #10b981);
    }
    .kpi-label { font-size: 13px; color: #9ca3af; margin-bottom: 8px; }
    .kpi-val { font-size: 24px; font-weight: 800; color: #fff; word-break: break-word; }
    .card {
      border-radius: 18px; padding: 16px;
      background: rgba(17, 21, 36, 0.92); border: 1px solid rgba(129, 140, 248, 0.22);
      display: grid; gap: 8px;
    }
    .card h3 { font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 4px; }
    .field-label { display: block; font-size: 13px; font-weight: 700; color: #d1d5db; margin-top: 6px; }
    input[type="text"], input[type="number"], select, textarea {
      width: 100%; border-radius: 12px; padding: 11px 12px; font-size: 14px;
      color: #f9fafb; background: #0c101d; border: 1px solid #2b3352;
    }
    .btn {
      width: 100%; border: 0; border-radius: 12px; padding: 12px 14px;
      font-size: 14px; font-weight: 800; color: #fff; cursor: pointer; margin-top: 6px;
    }
    .btn-green { background: linear-gradient(90deg, #10b981, #059669); }
    .btn-purple { background: linear-gradient(90deg, #8b5cf6, #7c3aed); }
    .btn-blue { background: linear-gradient(90deg, #3b82f6, #2563eb); }
    .btn-red { background: linear-gradient(90deg, #ef4444, #dc2626); }
    .btn-sm { width: auto; padding: 6px 10px; font-size: 12px; margin: 2px; border-radius: 8px; }
    .script-item {
      border-radius: 14px; padding: 12px; margin-top: 8px;
      background: #0d1221; border: 1px solid #262f4d;
    }
    .script-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .loader-box {
      margin-top: 8px; padding: 10px; border-radius: 10px;
      background: #070a13; border: 1px solid #1e2640;
      font-family: monospace; font-size: 12px; color: #93c5fd; word-break: break-all;
    }
    .chart-item { margin-bottom: 10px; }
    .chart-meta { display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1; margin-bottom: 4px; }
    .chart-track { width: 100%; height: 10px; border-radius: 999px; background: #0a0e1a; overflow: hidden; border: 1px solid #222a47; }
    .chart-fill { height: 100%; border-radius: 999px; }
    .row-inline { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .color-pair { display: flex; align-items: center; gap: 10px; }
    .color-pair input[type="color"] { width: 54px; height: 42px; padding: 2px; border-radius: 10px; border: 1px solid #2b3352; background: #0c101d; }
    .style-pair { display: grid; grid-template-columns: 1.4fr 1fr; gap: 8px; }
    .page-section { display: none; gap: 14px; }
    .page-section.active-page { display: grid; }
    .toast-box {
      position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
      z-index: 40; padding: 10px 16px; border-radius: 12px; font-size: 13px; font-weight: 700;
      background: #1e1b4b; color: #e0e7ff; border: 1px solid #6366f1; display: none;
    }
    .toast-box.show { display: block; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #232b47; padding: 7px 5px; font-size: 12px; text-align: left; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand-left">
      <button type="button" class="menu-btn" onclick="toggleMenu()">☰</button>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub" id="subStatus">Control Dashboard • Qoşulur...</div>
      </div>
    </div>
    <div class="bot-pill" id="botBadge">Bot: Online ✅</div>
  </header>

  <nav class="drawer-nav open" id="drawerNav">
    <button type="button" class="nav-chip active" data-page="secOverview" onclick="openPage('secOverview')">📊 Overview</button>
    <button type="button" class="nav-chip" data-page="secCharts" onclick="openPage('secCharts')">📈 Qrafiklər</button>
    <button type="button" class="nav-chip" data-page="secScripts" onclick="openPage('secScripts')">📜 Skriptlər</button>
    <button type="button" class="nav-chip" data-page="secPanelSend" onclick="openPage('secPanelSend')">📤 Panel Göndər</button>
    <button type="button" class="nav-chip" data-page="secObf" onclick="openPage('secObf')">🛡️ Obfuscator</button>
    <button type="button" class="nav-chip" data-page="secKeys" onclick="openPage('secKeys')">🔑 Key &amp; Whitelist</button>
    <button type="button" class="nav-chip" data-page="secGuild" onclick="openPage('secGuild')">🤖 Join Discord &amp; Server</button>
    <button type="button" class="nav-chip" data-page="secDesign" onclick="openPage('secDesign')">🎨 Panel Dizaynı</button>
  </nav>

  <main class="container">
    <section id="secOverview" class="page-section active-page">
      <div class="grid-2">
        <div class="kpi-card">
          <div class="kpi-label">Skriptlər</div>
          <div class="kpi-val" id="kpiScripts">0</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Yaradılmış Key-lər</div>
          <div class="kpi-val" id="kpiKeys">0</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Aktiv Whitelist</div>
          <div class="kpi-val" id="kpiWl">0</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Qoşulu Sunucu</div>
          <div class="kpi-val" id="kpiGuild">Seçilməyib</div>
        </div>
      </div>

      <div class="card">
        <h3>🕒 Son Key-lər (Yaradan &amp; İşlədən)</h3>
        <div id="recentKeysBox">Hələ key yaradılmayıb.</div>
      </div>
    </section>

    <section id="secCharts" class="page-section">
      <div class="card">
        <h3>📈 Canlı Qrafiklər (14 Göstərici)</h3>
        <div id="chartsArea"></div>
      </div>
    </section>

    <section id="secScripts" class="page-section">
      <div class="card">
        <h3>➕ Yeni Skript Yarat</h3>
        <label class="field-label">Skript Adı</label>
        <input id="scriptNameInput" type="text" placeholder="Məs: SADO HUB" />

        <label class="field-label">Lua / TXT Dosya Seç (istəyə bağlı)</label>
        <input id="scriptFileInput" type="file" accept=".lua,.txt" onchange="loadScriptFile(this)" />

        <label class="field-label">Skript Kodu</label>
        <textarea id="scriptCodeInput" rows="5" placeholder="-- Lua skript kodunu bura yazın və ya dosya seçin"></textarea>

        <label class="row-inline">
          <input id="createObfCheckbox" type="checkbox" />
          <span>Skripti yadda saxlayanda avtomatik Lua Obfuscate et (kodu şifrələ)</span>
        </label>

        <button type="button" class="btn btn-green" onclick="createScript()">💾 Skripti Yadda Saxla</button>
      </div>

      <div class="card">
        <h3>📂 Mövcud Skriptlər</h3>
        <div id="scriptsList"></div>
      </div>
    </section>

    <section id="secPanelSend" class="page-section">
      <div class="card">
        <h3>📤 Discord Kanalına Panel Göndər</h3>
        <label class="field-label">Discord Kanal ID</label>
        <input id="panelChannelIdInput" type="text" placeholder="Məs: 123456789012345678" />
        <label class="field-label">Panel Skripti Seç</label>
        <select id="panelScriptSelect"></select>
        <button type="button" class="btn btn-purple" onclick="sendPanelToChannel()">🚀 Paneli Kanala Göndər</button>
      </div>
    </section>

    <section id="secObf" class="page-section">
      <div class="card">
        <h3>🛡️ Lua Obfuscator</h3>
        <div class="brand-sub">Lua kodunuzu şifrələyin, nəticəni kopyalayın və ya birbaşa skript kimi yadda saxlayın.</div>

        <label class="field-label">Şifrələmə Səviyyəsi</label>
        <select id="obfLevelSelect">
          <option value="1">Səviyyə 1 — Fast Byte Guard</option>
          <option value="2" selected>Səviyyə 2 — VM Bytecode + Anti-Tamper</option>
          <option value="3">Səviyyə 3 — Ultra Guard VM + Anti-Dump</option>
        </select>

        <label class="field-label">Orijinal Lua Kodu</label>
        <textarea id="obfInputCode" rows="4" placeholder="print('Hello SADO PROTECT')"></textarea>

        <button type="button" class="btn btn-purple" onclick="runStandaloneObf()">⚡ Kodu Şifrələ (Obfuscate)</button>

        <label class="field-label">Şifrələnmiş Nəticə</label>
        <textarea id="obfResultBox" rows="4" placeholder="Şifrələnmiş kod burada görünəcək..."></textarea>

        <button type="button" class="btn btn-blue" onclick="copyObfCode()">📋 Şifrəli Kodu Kopyala</button>

        <label class="field-label">Yadda Saxlanacaq Skript Adı (istəyə bağlı)</label>
        <input id="obfSaveNameInput" type="text" placeholder="Məs: SADO Protected" />
        <button type="button" class="btn btn-green" onclick="saveObfAsScript()">💾 Skript Kimi Yadda Saxla</button>
      </div>
    </section>

    <section id="secKeys" class="page-section">
      <div class="card">
        <h3>🔑 Yeni Key Yarat</h3>
        <label class="field-label">Skript Seç</label>
        <select id="keyScriptSelect"></select>

        <label class="field-label">Müddət (0 = Lifetime, məs: 1d, 7d, 30d, 1y)</label>
        <input id="keyDurationInput" type="text" value="0" />

        <label class="field-label">Say (1 - 100)</label>
        <input id="keyAmountInput" type="number" min="1" max="100" value="1" />

        <button type="button" class="btn btn-purple" onclick="generateKeys()">✨ Key Yarat</button>
        <div id="keysList">Hələ key yoxdur.</div>
      </div>

      <div class="card">
        <h3>✅ Whitelist Əlavə Et</h3>
        <label class="field-label">Discord User ID</label>
        <input id="wlUserIdInput" type="text" placeholder="Məs: 123456789012345678" />

        <label class="field-label">Skript Seç</label>
        <select id="wlScriptSelect"></select>

        <label class="field-label">Müddət (0 = Lifetime, məs: 7d, 30d)</label>
        <input id="wlDurationInput" type="text" value="0" />

        <label class="row-inline">
          <input id="wlLockCheckbox" type="checkbox" checked />
          <span>HWID Kilidli (Kick Qoruması)</span>
        </label>

        <button type="button" class="btn btn-green" onclick="addWhitelist()">➕ Whitelist-ə Əlavə Et</button>
        <div id="wlList">Aktiv whitelist yoxdur.</div>
      </div>

      <div class="card">
        <h3>🚫 Blacklist İdarəetməsi</h3>
        <label class="field-label">Discord User ID</label>
        <input id="blUserIdInput" type="text" placeholder="Məs: 123456789012345678" />
        <button type="button" class="btn btn-red" onclick="addBlacklist()">⛔ Blacklist-ə Sal</button>
        <div id="blList">Blacklist boşdur.</div>
      </div>
    </section>

    <section id="secGuild" class="page-section">
      <div class="card">
        <h3>🤖 SADO PROTECT Botunu Sunucuna Əlavə Et (Join Discord)</h3>
        <div class="brand-sub" style="line-height:1.5;">
          1. Aşağıdakı düymə ilə SADO PROTECT botunu öz Discord sunucunuza əlavə edin.<br/>
          2. Bot sunucuya girdikdən sonra aşağıdan öz sunucunuzu seçin (və ya Sunucu ID-ni yazın) — yuxarıda öz sunucunuzun adı görünəcək və bu telefon/cihaz üçün tam müstəqil idarəetmə paneli açılacaq.
        </div>

        <a id="joinDiscordLink" href="${JOIN_DISCORD_URL}" target="_blank" style="text-decoration:none;">
          <button type="button" class="btn btn-green">➕ SADO PROTECT Botunu Sunucuna Əlavə Et</button>
        </a>

        <label class="field-label">Botun Olduğu Sunuculardan Öz Sunucunu Seç</label>
        <select id="guildSelect"></select>

        <label class="field-label">Və ya Discord Sunucu ID (Server ID)</label>
        <input id="guildIdInput" type="text" placeholder="1559499280732131348" />

        <label class="field-label">Discord User ID (istəyə bağlı)</label>
        <input id="discordUserIdInput" type="text" placeholder="Məs: 123456789012345678" />

        <div class="brand-sub" id="liveGuildPreview" style="color:#6ee7b7;font-weight:700;"></div>

        <button type="button" class="btn btn-purple" onclick="linkWorkspace()">✅ Sunucunu İdarəetmə Panelinə Bağla</button>
      </div>
    </section>

    <section id="secDesign" class="page-section">
      <div class="card">
        <h3>🎨 Panel Buton və Embed Dizaynı</h3>

        <label class="field-label">Embed Rəngi (HEX &amp; Rəng Seçici)</label>
        <div class="color-pair">
          <input id="embedColorPicker" type="color" value="#00ff00" oninput="document.getElementById('embedColorInput').value=this.value.toUpperCase()" />
          <input id="embedColorInput" type="text" value="#00FF00" oninput="syncPickerFromHex(this.value)" />
        </div>

        <label class="field-label">Panel Başlığı</label>
        <input id="panelTitleInput" type="text" value="SADO PROTECT • Script Panel" />

        <label class="field-label">Panel Açıqlaması</label>
        <input id="panelDescInput" type="text" value="Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin." />

        <label class="field-label">Redeem Key Düymə Mətni və Rəngi</label>
        <div class="style-pair">
          <input id="redeemLabelInput" type="text" value="Redeem Key" />
          <select id="redeemStyleInput">
            <option value="Success" selected>🟢 Yaşıl</option>
            <option value="Primary">🔵 Mavi</option>
            <option value="Danger">🔴 Qırmızı</option>
            <option value="Secondary">⚪ Boz</option>
          </select>
        </div>

        <label class="field-label">Get Script Düymə Mətni və Rəngi</label>
        <div class="style-pair">
          <input id="getScriptLabelInput" type="text" value="Get Script" />
          <select id="getScriptStyleInput">
            <option value="Primary" selected>🔵 Mavi</option>
            <option value="Success">🟢 Yaşıl</option>
            <option value="Danger">🔴 Qırmızı</option>
            <option value="Secondary">⚪ Boz</option>
          </select>
        </div>

        <label class="field-label">Reset HWID Düymə Mətni və Rəngi</label>
        <div class="style-pair">
          <input id="resetHwidLabelInput" type="text" value="Reset HWID" />
          <select id="resetHwidStyleInput">
            <option value="Danger" selected>🔴 Qırmızı</option>
            <option value="Success">🟢 Yaşıl</option>
            <option value="Primary">🔵 Mavi</option>
            <option value="Secondary">⚪ Boz</option>
          </select>
        </div>

        <label class="field-label">Stats Düymə Mətni və Rəngi</label>
        <div class="style-pair">
          <input id="statsLabelInput" type="text" value="Get Stats" />
          <select id="statsStyleInput">
            <option value="Secondary" selected>⚪ Boz</option>
            <option value="Success">🟢 Yaşıl</option>
            <option value="Primary">🔵 Mavi</option>
            <option value="Danger">🔴 Qırmızı</option>
          </select>
        </div>

        <button type="button" class="btn btn-purple" onclick="savePanelDesign()">💾 Panel Dizaynını Yadda Saxla</button>
      </div>
    </section>
  </main>

  <div class="toast-box" id="toastBox"></div>

  <script>
    const getOrCreateWorkspaceId = () => {
      const saved = localStorage.getItem('sado_ws_id');
      const created = 'ws_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
      const chosen = saved || created;
      const persisted = localStorage.setItem('sado_ws_id', chosen);
      return persisted ? chosen : chosen;
    };

    const wsId = getOrCreateWorkspaceId();
    const uiFlags = { initialLoaded: false, activePage: 'secOverview' };

    const apiFetch = (url, opts = {}) => {
      const headers = Object.assign({ 'X-Client-Workspace': wsId }, opts.headers || {});
      const call = fetch(url, Object.assign({}, opts, { headers }));
      return call;
    };

    const showToast = (msg) => {
      const t = document.getElementById('toastBox');
      const setTxt = t.textContent = msg;
      const addCls = t.classList.add('show');
      const timer = setTimeout(() => t.classList.remove('show'), 2600);
      return { setTxt, addCls, timer };
    };

    const toggleMenu = () => {
      const nav = document.getElementById('drawerNav');
      const res = nav.classList.toggle('open');
      return res;
    };

    const openPage = (pageId) => {
      const pages = Array.from(document.querySelectorAll('.page-section'));
      const chips = Array.from(document.querySelectorAll('.nav-chip'));
      const setActive = uiFlags.activePage = pageId;
      const hidePages = pages.map((p) => p.classList.toggle('active-page', p.id === pageId));
      const markChips = chips.map((c) => c.classList.toggle('active', c.getAttribute('data-page') === pageId));
      const topScroll = window.scrollTo({ top: 0, behavior: 'smooth' });
      return { setActive, hidePages, markChips, topScroll };
    };

    const syncPickerFromHex = (val) => {
      const clean = String(val || '').trim();
      const picker = document.getElementById('embedColorPicker');
      const ok = /^#[0-9a-fA-F]{6}$/.test(clean);
      const updated = ok ? (picker.value = clean) : null;
      return updated;
    };

    const loadScriptFile = (input) => {
      const file = input && input.files && input.files[0];
      if (!file) return null;
      const reader = new FileReader();
      const nameInput = document.getElementById('scriptNameInput');
      const codeInput = document.getElementById('scriptCodeInput');
      reader.onload = (ev) => {
        const text = String((ev && ev.target && ev.target.result) || '');
        const setC = codeInput.value = text;
        const setN = nameInput.value.trim() ? null : (nameInput.value = file.name.replace(/\.(lua|txt)$/i, ''));
        const msg = showToast('Fayl yükləndi: ' + file.name);
        return { setC, setN, msg };
      };
      const done = reader.readAsText(file);
      return done;
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
      const htmlOut = items
        .map((i) => {
          const pct = Math.max(2, Math.round((i.val / maxVal) * 100));
          const bar = '<div class="chart-item"><div class="chart-meta"><span>' + i.label + '</span><strong>' + i.val + '</strong></div>' +
            '<div class="chart-track"><div class="chart-fill" style="width:' + pct + '%;background:' + i.color + '"></div></div></div>';
          return bar;
        })
        .join('');
      const rendered = area.innerHTML = htmlOut;
      return rendered;
    };

    const lookupGuildLive = async () => {
      const guildId = document.getElementById('guildIdInput').value.trim();
      const discordUserId = document.getElementById('discordUserIdInput').value.trim();
      const kpiGuild = document.getElementById('kpiGuild');
      const subStatus = document.getElementById('subStatus');
      const preview = document.getElementById('liveGuildPreview');
      if (!guildId && !discordUserId) {
        preview.textContent = '';
        return null;
      }
      const r = await apiFetch('/api/workspace/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, discordUserId }),
      });
      const j = await r.json();
      const gName = j && j.guildName ? j.guildName : '';
      const setK = gName ? (kpiGuild.textContent = gName) : null;
      const setS = gName ? (subStatus.textContent = 'Control Dashboard • ' + gName) : null;
      const setP = gName
        ? (preview.textContent = 'Qoşulmuş Sunucu: ' + gName + (j.guildId ? ' (' + j.guildId + ')' : ''))
        : null;
      return { setK, setS, setP };
    };

    const renderAll = async () => {
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
      if (!data.ok) return null;

      const guildLabel = data.guildName || 'Seçilməyib';
      const setBadge = badge.textContent = st.botReady ? 'Bot: Online ✅' : 'Bot: Qoşulur...';
      const setSub = subStatus.textContent = 'Control Dashboard • ' + guildLabel;
      const setKs = kpiScripts.textContent = String((data.scripts || []).length);
      const setKk = kpiKeys.textContent = String((data.keys || []).length);
      const setKw = kpiWl.textContent = String((data.whitelists || []).length);
      const setKg = kpiGuild.textContent = guildLabel;

      const joinLink = document.getElementById('joinDiscordLink');
      const guildIdInput = document.getElementById('guildIdInput');
      const discordUserIdInput = document.getElementById('discordUserIdInput');
      const liveGuildPreview = document.getElementById('liveGuildPreview');
      const setHref = data.inviteUrl ? (joinLink.href = data.inviteUrl) : null;
      guildIdInput.oninput = lookupGuildLive;
      discordUserIdInput.oninput = lookupGuildLive;

      const gSel = document.getElementById('guildSelect');
      const gOpts = (data.guilds || []).map((g) => '<option value="' + g.id + '">' + g.name + ' (' + g.id + ')</option>').join('');
      gSel.innerHTML = '<option value="">-- Sunucu seçin və ya aşağıya ID yazın</option>' + gOpts;
      if (data.guildId) gSel.value = data.guildId;
      gSel.onchange = () => {
        const picked = gSel.value;
        const setVal = picked ? (guildIdInput.value = picked) : null;
        const looked = picked ? lookupGuildLive() : null;
        return { setVal, looked };
      };

      const recentKeys = (data.keys || []).slice(0, 5);
      const recentBox = document.getElementById('recentKeysBox');
      const recentRows = recentKeys
        .map((k) => '<tr><td>' + k.key + '</td><td>' + (k.createdByName || '-') + '</td><td>' + (k.usedByName || (k.used ? k.usedByDiscordId : 'Hələ işlənməyib')) + '</td></tr>')
        .join('');
      recentBox.innerHTML = recentKeys.length
        ? '<table><tr><th>Key</th><th>Yaradan</th><th>İşlədən</th></tr>' + recentRows + '</table>'
        : 'Hələ key yaradılmayıb.';

      const chartsDone = renderCharts(data);

      const scriptOpts = (data.scripts || []).map((s) => '<option value="' + s.id + '">' + s.name + '</option>').join('');
      const panelScriptSelect = document.getElementById('panelScriptSelect');
      const keyScriptSelect = document.getElementById('keyScriptSelect');
      const wlScriptSelect = document.getElementById('wlScriptSelect');
      panelScriptSelect.innerHTML = scriptOpts;
      keyScriptSelect.innerHTML = scriptOpts;
      wlScriptSelect.innerHTML = scriptOpts;

      const scriptsListEl = document.getElementById('scriptsList');
      const scriptsHtml = (data.scripts || [])
        .map((s) => {
          const loaderCode = 'script_key = "YOUR_KEY"\nloadstring(game:HttpGet("' + location.origin + '/loader/' + s.loaderToken + '?ws=' + wsId + '"))()';
          const block = '<div class="script-item"><div class="script-head"><div><strong>📜 ' + s.name + '</strong><div class="brand-sub">' + s.name + '.lua</div></div>' +
            '<div><button type="button" class="btn btn-blue btn-sm" onclick="copyText(' + JSON.stringify(loaderCode) + ')">📋 Kopyala</button>' +
            '<button type="button" class="btn btn-red btn-sm" onclick="deleteScript(\'' + s.id + '\')">🗑️ Sil</button></div></div>' +
            '<div class="loader-box">' + loaderCode.replace(/\n/g, '<br/>') + '</div></div>';
          return block;
        })
        .join('');
      scriptsListEl.innerHTML = scriptsHtml;

      const keysListEl = document.getElementById('keysList');
      const keyRows = (data.keys || [])
        .map((k) => '<tr><td>' + k.key + '</td><td>' + (k.createdByName || '-') + '</td><td>' + (k.usedByName || (k.used ? k.usedByDiscordId : 'Boş')) + '</td><td><button type="button" class="btn btn-red btn-sm" onclick="deleteKey(\'' + encodeURIComponent(k.key) + '\')">Sil</button></td></tr>')
        .join('');
      keysListEl.innerHTML = (data.keys || []).length
        ? '<table><tr><th>Key</th><th>Yaradan</th><th>İşlədən</th><th>Sil</th></tr>' + keyRows + '</table>'
        : '<div class="brand-sub" style="margin-top:6px;">Hələ key yoxdur.</div>';

      const wlListEl = document.getElementById('wlList');
      const wlRows = (data.whitelists || [])
        .map((w) => '<tr><td>' + (w.username || w.discordUserId) + '<br/><span style="color:#9ca3af">Edən: ' + (w.addedByName || '-') + '</span></td><td>' + (w.hwid || 'Yoxdur') + '</td><td>' + (w.hwidLocked === false ? 'Açıq' : 'Kilidli') + '</td><td>' +
          '<button type="button" class="btn btn-blue btn-sm" onclick="toggleLock(\'' + w.id + '\')">Kilid</button>' +
          '<button type="button" class="btn btn-purple btn-sm" onclick="resetHw(\'' + w.id + '\')">Reset HWID</button>' +
          '<button type="button" class="btn btn-red btn-sm" onclick="delWl(\'' + w.id + '\')">Sil</button></td></tr>')
        .join('');
      wlListEl.innerHTML = (data.whitelists || []).length
        ? '<table><tr><th>İstifadəçi</th><th>HWID</th><th>Kilid</th><th>Əməliyyat</th></tr>' + wlRows + '</table>'
        : '<div class="brand-sub" style="margin-top:6px;">Aktiv whitelist yoxdur.</div>';

      const blListEl = document.getElementById('blList');
      const blRows = (data.blacklist || [])
        .map((b) => '<tr><td>' + b.discordUserId + '</td><td>' + (b.username || '-') + '</td><td><button type="button" class="btn btn-red btn-sm" onclick="delBl(\'' + b.id + '\')">Çıxar</button></td></tr>')
        .join('');
      blListEl.innerHTML = (data.blacklist || []).length
        ? '<table><tr><th>ID</th><th>Ad</th><th>Sil</th></tr>' + blRows + '</table>'
        : '<div class="brand-sub" style="margin-top:6px;">Blacklist boşdur.</div>';

      if (!uiFlags.initialLoaded) {
        guildIdInput.value = data.guildId || '';
        discordUserIdInput.value = data.discordUserId || '';
        liveGuildPreview.textContent = data.guildName
          ? 'Qoşulmuş Sunucu: ' + data.guildName + (data.guildId ? ' (' + data.guildId + ')' : '')
          : '';
        const cfg = data.panelConfig || {};
        if (cfg.embedColor) {
          document.getElementById('embedColorInput').value = cfg.embedColor.toUpperCase();
          syncPickerFromHex(cfg.embedColor);
        }
        if (cfg.title) document.getElementById('panelTitleInput').value = cfg.title;
        if (cfg.description) document.getElementById('panelDescInput').value = cfg.description;
        if (cfg.redeemLabel) document.getElementById('redeemLabelInput').value = cfg.redeemLabel;
        if (cfg.redeemStyle) document.getElementById('redeemStyleInput').value = cfg.redeemStyle;
        if (cfg.getScriptLabel) document.getElementById('getScriptLabelInput').value = cfg.getScriptLabel;
        if (cfg.getScriptStyle) document.getElementById('getScriptStyleInput').value = cfg.getScriptStyle;
        if (cfg.resetHwidLabel) document.getElementById('resetHwidLabelInput').value = cfg.resetHwidLabel;
        if (cfg.resetHwidStyle) document.getElementById('resetHwidStyleInput').value = cfg.resetHwidStyle;
        if (cfg.statsLabel) document.getElementById('statsLabelInput').value = cfg.statsLabel;
        if (cfg.statsStyle) document.getElementById('statsStyleInput').value = cfg.statsStyle;
        uiFlags.initialLoaded = true;
      }

      return { setBadge, setSub, setKs, setKk, setKw, setKg, setHref, chartsDone };
    };

    const copyText = (txt) => {
      const ta = document.createElement('textarea');
      const body = document.body;
      const setV = ta.value = txt;
      const app = body.appendChild(ta);
      const sel = ta.select();
      const cp = document.execCommand('copy');
      const rem = body.removeChild(ta);
      const msg = showToast('Kopyalandı!');
      return { setV, app, sel, cp, rem, msg };
    };

    const createScript = async () => {
      const name = document.getElementById('scriptNameInput').value.trim();
      const code = document.getElementById('scriptCodeInput').value;
      const obfuscate = document.getElementById('createObfCheckbox').checked;
      const obfuscateLevel = Number(document.getElementById('obfLevelSelect').value || 2);
      const r = await apiFetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, code, obfuscate, obfuscateLevel }),
      });
      const j = await r.json();
      const clearN = j && j.ok ? (document.getElementById('scriptNameInput').value = '') : null;
      const msg = showToast((j && j.message) || 'Skript yaradıldı');
      const ref = await renderAll();
      return { clearN, msg, ref };
    };

    const deleteScript = async (id) => {
      const r = await apiFetch('/api/scripts/' + id, { method: 'DELETE' });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Silindi');
      const ref = await renderAll();
      return { msg, ref };
    };

    const runStandaloneObf = async () => {
      const code = document.getElementById('obfInputCode').value;
      const level = Number(document.getElementById('obfLevelSelect').value || 2);
      const outBox = document.getElementById('obfResultBox');
      const r = await apiFetch('/api/obfuscate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, level }),
      });
      const j = await r.json();
      const setO = j && j.obfuscated ? (outBox.value = j.obfuscated) : null;
      const msg = showToast((j && j.message) || 'Şifrələndi');
      return { setO, msg };
    };

    const copyObfCode = () => {
      const val = document.getElementById('obfResultBox').value;
      const res = val ? copyText(val) : showToast('Şifrələnmiş kod boşdur');
      return res;
    };

    const saveObfAsScript = async () => {
      const code = document.getElementById('obfResultBox').value;
      const rawName = document.getElementById('obfSaveNameInput').value.trim();
      const name = rawName || 'SADO Protected';
      if (!code) return showToast('Əvvəl kodu şifrələyin');
      const r = await apiFetch('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, code, obfuscate: false }),
      });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Skript kimi saxlandı');
      const ref = await renderAll();
      return { msg, ref };
    };

    const generateKeys = async () => {
      const scriptId = document.getElementById('keyScriptSelect').value;
      const duration = document.getElementById('keyDurationInput').value.trim();
      const amount = Number(document.getElementById('keyAmountInput').value || 1);
      const createdByDiscordId = document.getElementById('discordUserIdInput').value.trim();
      const r = await apiFetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptId, duration, amount, createdByDiscordId }),
      });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Key yaradıldı');
      const ref = await renderAll();
      return { msg, ref };
    };

    const deleteKey = async (k) => {
      const r = await apiFetch('/api/keys/' + k, { method: 'DELETE' });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Silindi');
      const ref = await renderAll();
      return { msg, ref };
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
        body: JSON.stringify({ discordUserId, scriptId, duration, hwidLocked, addedByDiscordId }),
      });
      const j = await r.json();
      const clearU = j && j.ok ? (document.getElementById('wlUserIdInput').value = '') : null;
      const msg = showToast((j && j.message) || 'Whitelist yeniləndi');
      const ref = await renderAll();
      return { clearU, msg, ref };
    };

    const toggleLock = async (id) => {
      const r = await apiFetch('/api/whitelist/' + id + '/toggle-lock', { method: 'POST' });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Kilid dəyişdi');
      const ref = await renderAll();
      return { msg, ref };
    };

    const resetHw = async (id) => {
      const r = await apiFetch('/api/whitelist/' + id + '/reset-hwid', { method: 'POST' });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'HWID sıfırlandı');
      const ref = await renderAll();
      return { msg, ref };
    };

    const delWl = async (id) => {
      const r = await apiFetch('/api/whitelist/' + id, { method: 'DELETE' });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Silindi');
      const ref = await renderAll();
      return { msg, ref };
    };

    const addBlacklist = async () => {
      const discordUserId = document.getElementById('blUserIdInput').value.trim();
      const r = await apiFetch('/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordUserId }),
      });
      const j = await r.json();
      const clearB = j && j.ok ? (document.getElementById('blUserIdInput').value = '') : null;
      const msg = showToast((j && j.message) || 'Blacklist yeniləndi');
      const ref = await renderAll();
      return { clearB, msg, ref };
    };

    const delBl = async (id) => {
      const r = await apiFetch('/api/blacklist/' + id, { method: 'DELETE' });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Silindi');
      const ref = await renderAll();
      return { msg, ref };
    };

    const linkWorkspace = async () => {
      const guildId = document.getElementById('guildIdInput').value.trim();
      const discordUserId = document.getElementById('discordUserIdInput').value.trim();
      const r = await apiFetch('/api/workspace/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, discordUserId }),
      });
      const j = await r.json();
      const resetFlag = uiFlags.initialLoaded = false;
      const msg = showToast((j && j.message) || 'Yadda saxlandı');
      const ref = await renderAll();
      return { resetFlag, msg, ref };
    };

    const sendPanelToChannel = async () => {
      const channelId = document.getElementById('panelChannelIdInput').value.trim();
      const scriptId = document.getElementById('panelScriptSelect').value;
      const r = await apiFetch('/api/send-panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, scriptId }),
      });
      const j = await r.json();
      const msg = showToast((j && j.message) || 'Panel göndərildi');
      const ref = await renderAll();
      return { msg, ref };
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
      const msg = showToast((j && j.message) || 'Panel dizaynı yeniləndi');
      const ref = await renderAll();
      return { msg, ref };
    };

    const startDashboardLoop = () => {
      const first = renderAll();
      const poll = setInterval(renderAll, 8000);
      return { first, poll };
    };

    const bootUi = startDashboardLoop();
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
  await loadStore();
  startWatchdog();
  await ensureBotOnline();
  const selfPingUrl = process.env.RENDER_EXTERNAL_URL || 'https://sado-protect.onrender.com';
  setInterval(() => {
    fetch(`${selfPingUrl}/health`).catch(() => {});
    if (!client.isReady() && !storeState.isConnectingNow) {
      ensureBotOnline().catch(() => {});
    }
  }, 4 * 60 * 1000);
});
