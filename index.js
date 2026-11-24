const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
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
  SlashCommandBuilder,
  REST,
  Routes,
  MessageFlags,
  Events,
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_BACKUPS = 5;

const DEFAULT_SCRIPT_CODE = 'print("SADO PROTECT Active!")';

const DEFAULT_PANEL_CONFIG = {
  embedColor: '#10b981',
  title: 'SADO PROTECT • Script Panel',
  description: 'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin.',
  redeemLabel: 'Redeem Key',
  redeemStyle: 'Success',
  getScriptLabel: 'Get Script',
  getScriptStyle: 'Primary',
  resetHwidLabel: 'Reset HWID',
  resetHwidStyle: 'Danger',
  statsLabel: 'Get Stats',
  statsStyle: 'Secondary',
  footerText: 'SADO PROTECT',
  imageUrl: '',
  thumbnailUrl: '',
};

const getRuntimeToken = () => {
  const envToken = String(
    process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN || ''
  ).trim();
  if (envToken) return envToken;

  const partA = 'TVRFeU1qQTBNRFl4TkRJNE16STVPVEl5TVRRLkd5bGRTNy4=';
  const partB = 'aWVtY3EzQ09oa0l6VnpaTzlla2VVZ1A3TGl6N3BWYzR2aFJjTDg=';
  try {
    const decoded =
      Buffer.from(partA, 'base64').toString('utf8') +
      Buffer.from(partB, 'base64').toString('utf8');
    return decoded.trim();
  } catch (_e) {
    return '';
  }
};

const BOT_TOKEN = getRuntimeToken();

const createDefaultWorkspaceState = () => ({
  guildId: '',
  guildName: '',
  discordUserId: '',
  discordUserName: '',
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

let store = createRootStore();
let isSavingStore = false;
let pendingSave = false;
let isConnectingNow = false;
let lastConnectAttempt = 0;
let commandsRegistered = false;

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
  if (!store.workspaces || typeof store.workspaces !== 'object') {
    store.workspaces = { default: createDefaultWorkspaceState() };
  }
  if (!store.workspaces[safeId]) {
    store.workspaces[safeId] = createDefaultWorkspaceState();
  }
  const ws = store.workspaces[safeId];
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
    headerWs || queryWs || bodyWs || store.activeWorkspaceId || 'default'
  );
  return { wsId, ws: ensureWorkspace(wsId) };
};

const getAllWorkspacesList = () => {
  const keys = Object.keys(store.workspaces || {});
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

  const defId = sanitizeWorkspaceId(store.activeWorkspaceId || 'default');
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
  if (isSavingStore) {
    pendingSave = true;
    return;
  }
  isSavingStore = true;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const serialized = JSON.stringify(store, null, 2);
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
    isSavingStore = false;
    if (pendingSave) {
      pendingSave = false;
      saveStore().catch(() => {});
    }
  }
};

const loadStore = async () => {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const content = await fsp.readFile(STORE_FILE, 'utf8');
      store = migrateLegacyData(JSON.parse(content));
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
        store = migrateLegacyData(JSON.parse(bakContent));
        await saveStore();
        return;
      } catch (_e) {}
    }
    store = createRootStore();
    await saveStore();
  } catch (err) {
    console.error('[STORE] Yükləmə xətası:', err && err.message ? err.message : err);
    store = createRootStore();
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
  const safeBase = String(baseUrl || `http://localhost:${PORT}`).replace(/\/+$/, '');
  const loaderToken = sc && (sc.loaderToken || sc.id) ? sc.loaderToken || sc.id : 'default';
  const loaderUrl = `${safeBase}/loader/${encodeURIComponent(loaderToken)}?ws=${encodeURIComponent(
    wsId || 'default'
  )}`;
  const keyText = wl && wl.key ? wl.key : 'YOUR_KEY';
  return `script_key = "${keyText}"\nloadstring(game:HttpGet("${loaderUrl}"))()`;
};

const resolveButtonStyle = (styleName, fallbackStyle) => {
  const map = {
    Success: ButtonStyle.Success,
    Primary: ButtonStyle.Primary,
    Danger: ButtonStyle.Danger,
    Secondary: ButtonStyle.Secondary,
  };
  return map[styleName] || fallbackStyle;
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
      .setStyle(resolveButtonStyle(cfg.redeemStyle, ButtonStyle.Success)),
    new ButtonBuilder()
      .setCustomId(`sado_getscript_${scriptId}`)
      .setLabel(cfg.getScriptLabel || 'Get Script')
      .setEmoji('📜')
      .setStyle(resolveButtonStyle(cfg.getScriptStyle, ButtonStyle.Primary)),
    new ButtonBuilder()
      .setCustomId(`sado_resethwid_${scriptId}`)
      .setLabel(cfg.resetHwidLabel || 'Reset HWID')
      .setEmoji('⚙️')
      .setStyle(resolveButtonStyle(cfg.resetHwidStyle, ButtonStyle.Danger)),
    new ButtonBuilder()
      .setCustomId(`sado_stats_${scriptId}`)
      .setLabel(cfg.statsLabel || 'Get Stats')
      .setEmoji('📊')
      .setStyle(resolveButtonStyle(cfg.statsStyle, ButtonStyle.Secondary))
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
        opt.setName('title').setDescription('Panel başlığı').setRequired(false)
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
        .put(Routes.applicationGuildCommands(appId, String(item.ws.guildId).trim()), {
          body: commands,
        })
        .catch(() => {});
    }
  }
  commandsRegistered = true;
};

const ensureBotOnline = async () => {
  if (!BOT_TOKEN) {
    console.warn('[BOT] Token tapılmadı.');
    return;
  }
  if (client.isReady()) return;
  if (isConnectingNow) return;
  const now = Date.now();
  if (now - lastConnectAttempt < 4000) return;
  isConnectingNow = true;
  lastConnectAttempt = now;
  try {
    await client.login(BOT_TOKEN);
  } catch (err) {
    console.error('[BOT] Login xətası:', err && err.message ? err.message : err);
  } finally {
    isConnectingNow = false;
  }
};

const startWatchdog = () => {
  setInterval(async () => {
    try {
      if (!client.isReady() && !isConnectingNow && BOT_TOKEN) {
        await ensureBotOnline();
      }
      if (client.isReady() && !commandsRegistered) {
        await registerSlashCommands().catch(() => {});
      }
    } catch (_e) {}
  }, 15000);
};

const obfuscateLuaCode = (code, level = '2') => {
  const raw = String(code || '');
  const shift = level === '3' ? 17 : level === '1' ? 5 : 11;
  const bytes = [];
  for (let i = 0; i < raw.length; i = i + 1) {
    bytes.push((raw.charCodeAt(i) + shift) % 256);
  }
  const encodedStr = bytes.join(',');
  return [
    `-- SADO PROTECT Obfuscated (Level ${level})`,
    'local _b = {' + encodedStr + '}',
    'local _t = {}',
    'for _i = 1, #_b do',
    `  local _v = (_b[_i] - ${shift}) % 256`,
    '  if _v < 0 then _v = _v + 256 end',
    '  _t[_i] = string.char(_v)',
    'end',
    'local _fn = loadstring(table.concat(_t))',
    'if type(_fn) == "function" then _fn() end',
  ].join('\n');
};

const resolveGuildInfoById = async (guildId) => {
  const cleanId = String(guildId || '').trim();
  if (!cleanId) return { guildId: '', guildName: 'Seçilməyib', botInGuild: false };
  try {
    if (client.isReady()) {
      const cached = client.guilds.cache.get(cleanId);
      if (cached) {
        return { guildId: cleanId, guildName: cached.name || cleanId, botInGuild: true };
      }
      const fetched = await client.guilds.fetch(cleanId).catch(() => null);
      if (fetched) {
        return { guildId: cleanId, guildName: fetched.name || cleanId, botInGuild: true };
      }
    }
    if (BOT_TOKEN) {
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      const guildData = await rest.get(Routes.guild(cleanId)).catch(() => null);
      if (guildData && guildData.name) {
        return { guildId: cleanId, guildName: guildData.name, botInGuild: true };
      }
    }
  } catch (_e) {}
  return { guildId: cleanId, guildName: `Sunucu (${cleanId})`, botInGuild: false };
};

const resolveDiscordUserName = async (userId) => {
  const cleanId = String(userId || '').trim();
  if (!cleanId) return '';
  try {
    if (client.isReady()) {
      const u =
        client.users.cache.get(cleanId) || (await client.users.fetch(cleanId).catch(() => null));
      if (u) return u.globalName || u.username || cleanId;
    }
  } catch (_e) {}
  return cleanId;
};

const buildBotInviteUrl = () => {
  return 'https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot';
};

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BOT] ${readyClient.user.tag} aktivdir!`);
  commandsRegistered = false;
  await registerSlashCommands().catch((err) => {
    console.error('[BOT] Slash command qeydiyyat xətası:', err && err.message ? err.message : err);
  });
});

client.on(Events.ShardDisconnect, (_event, shardId) => {
  console.warn(`[BOT] Shard ${shardId} ayrıldı, yenidən qoşulur...`);
  ensureBotOnline().catch(() => {});
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
      const selectedScriptArg = interaction.options.getString('script') || '';
      const { ws } = resolveWorkspaceForDiscord({
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
            channelId: interaction.channelId || sentMsg.channel_id || '',
            messageId: sentMsg.id,
            scriptId: sc.id,
            title: customTitle || ws.panelConfig.title,
            createdAt: new Date().toISOString(),
          });
          if (guildId && !ws.guildId) ws.guildId = guildId;
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
        const creatorName = interaction.user.globalName || interaction.user.username || invokerId;

        const created = [];
        for (let i = 0; i < amount; i = i + 1) {
          const newKey = {
            key: generateRandomKeyCode(),
            scriptId: sc ? sc.id : 'default',
            scriptName: sc ? sc.name : 'SADO HUB',
            duration: durationStr,
            expiresAt,
            used: false,
            usedByDiscordId: null,
            usedByName: '',
            createdByDiscordId: invokerId,
            createdByName: creatorName,
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
        const addedByName = interaction.user.globalName || interaction.user.username || invokerId;

        const existingIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === targetUser.id && w.scriptId === (sc ? sc.id : 'default')
        );
        const entry = {
          id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
          discordUserId: targetUser.id,
          username: targetUser.globalName || targetUser.username,
          scriptId: sc ? sc.id : 'default',
          key:
            existingIdx >= 0 && ws.whitelists[existingIdx].key
              ? ws.whitelists[existingIdx].key
              : generateRandomKeyCode(),
          hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
          hwidLocked: existingIdx >= 0 ? ws.whitelists[existingIdx].hwidLocked !== false : true,
          addedByDiscordId: invokerId,
          addedByName,
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
          content: `✅ <@${targetUser.id}> (**${
            sc ? sc.name : 'SADO HUB'
          }**) whitelist-ə əlavə olundu. Key: \`${entry.key}\``,
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
            resetCount = resetCount + 1;
          }
        }
        ws.stats.hwidResets = ws.stats.hwidResets + resetCount;
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
        ws.stats.scriptFetches = ws.stats.scriptFetches + 1;
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
          await interaction.editReply({
            content: '❌ HWID sıfırlamaq üçün aktiv key/whitelist tapılmadı.',
          });
          return;
        }
        for (const w of matching) {
          w.hwid = '';
        }
        ws.stats.hwidResets = ws.stats.hwidResets + matching.length;
        await saveStore();

        await interaction.editReply({
          content: `🔄 HWID uğurla sıfırlandı (${matching.length} qeyd). Skripti növbəti dəfə ilk işlədən cihaza bağlanacaq.`,
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
          keyObj.scriptId ||
          scriptIdFromModal ||
          (ws.scripts[0] && ws.scripts[0].id) ||
          'default';
        const isBl = ws.blacklist.some(
          (b) => b.discordUserId === userId && (!b.scriptId || b.scriptId === targetScriptId)
        );
        if (isBl) {
          await interaction.editReply({ content: '🚫 Siz bu skriptdən blacklist olunmusunuz.' });
          return;
        }

        keyObj.used = true;
        keyObj.usedByDiscordId = userId;
        keyObj.usedByName = interaction.user.globalName || interaction.user.username || userId;
        keyObj.usedAt = new Date().toISOString();

        const existingWlIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === userId && w.scriptId === targetScriptId
        );
        const wlRecord = {
          id: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].id : crypto.randomUUID(),
          discordUserId: userId,
          username: interaction.user.globalName || interaction.user.username,
          scriptId: targetScriptId,
          key: keyObj.key,
          hwid: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwid || '' : '',
          hwidLocked: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwidLocked !== false : true,
          addedByDiscordId: keyObj.createdByDiscordId || userId,
          addedByName:
            keyObj.createdByName || interaction.user.globalName || interaction.user.username,
          expiresAt: keyObj.expiresAt || null,
          createdAt: new Date().toISOString(),
        };
        if (existingWlIdx >= 0) {
          ws.whitelists[existingWlIdx] = wlRecord;
        } else {
          ws.whitelists.unshift(wlRecord);
        }
        ws.stats.redeems = ws.stats.redeems + 1;
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
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/health', async (_req, res) => {
  if (!client.isReady() && !isConnectingNow && BOT_TOKEN) {
    ensureBotOnline().catch(() => {});
  }
  res.status(200).json({
    ok: true,
    botReady: client.isReady(),
    workspaces: Object.keys(store.workspaces || {}).length,
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/status', async (req, res) => {
  try {
    const { wsId, ws } = getWorkspaceFromReq(req);
    if (!client.isReady() && !isConnectingNow && BOT_TOKEN) {
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
  const guilds = client.isReady()
    ? client.guilds.cache.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount || 0 }))
    : [];
  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId || '',
    guildName: ws.guildName || '',
    discordUserId: ws.discordUserId || '',
    inviteUrl: buildBotInviteUrl(),
    guilds,
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
  const guildInfo = await resolveGuildInfoById(guildId);
  const resolvedUserName = discordUserId ? await resolveDiscordUserName(discordUserId) : '';
  ws.guildId = guildId;
  ws.guildName = guildInfo.guildName;
  ws.discordUserId = discordUserId;
  ws.discordUserName = resolvedUserName;
  await saveStore();
  if (BOT_TOKEN && client.isReady()) {
    await registerSlashCommands().catch(() => {});
  }
  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId,
    guildName: ws.guildName,
    botInGuild: guildInfo.botInGuild,
    discordUserId: ws.discordUserId,
    discordUserName: ws.discordUserName,
    inviteUrl: buildBotInviteUrl(),
    message: `Sunucu (${ws.guildName}) və Discord ID yadda saxlandı!`,
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
    redeemStyle: String(body.redeemStyle || ws.panelConfig.redeemStyle || 'Success'),
    getScriptLabel:
      String(body.getScriptLabel || ws.panelConfig.getScriptLabel).trim() || 'Get Script',
    getScriptStyle: String(body.getScriptStyle || ws.panelConfig.getScriptStyle || 'Primary'),
    resetHwidLabel:
      String(body.resetHwidLabel || ws.panelConfig.resetHwidLabel).trim() || 'Reset HWID',
    resetHwidStyle: String(body.resetHwidStyle || ws.panelConfig.resetHwidStyle || 'Danger'),
    statsLabel: String(body.statsLabel || ws.panelConfig.statsLabel).trim() || 'Get Stats',
    statsStyle: String(body.statsStyle || ws.panelConfig.statsStyle || 'Secondary'),
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
    message: 'Panel dizaynı yadda saxlandı və aktiv panellər yeniləndi!',
  });
});

app.post('/api/scripts', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const name = String((req.body && req.body.name) || '').trim();
  const rawCode = String((req.body && req.body.code) || DEFAULT_SCRIPT_CODE);
  const shouldObfuscate = Boolean(req.body && req.body.obfuscate);
  const obfLevel = String((req.body && req.body.obfuscateLevel) || '2');
  const code = shouldObfuscate ? obfuscateLuaCode(rawCode, obfLevel) : rawCode;
  if (!name) {
    res.status(400).json({ ok: false, message: 'Skript adı tələb olunur.' });
    return;
  }
  const id = slugifyId(name, 'script');
  const scriptObj = {
    id,
    name,
    loaderToken: `${id}_${crypto.randomBytes(3).toString('hex')}`,
    code,
    obfuscated: shouldObfuscate,
    createdAt: new Date().toISOString(),
  };
  ws.scripts.unshift(scriptObj);
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, script: scriptObj, message: 'Skript yaradıldı!' });
});

app.post('/api/obfuscate', (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const level = String((req.body && req.body.level) || '2');
  if (!code.trim()) {
    res.status(400).json({ ok: false, message: 'Şifrələmək üçün Lua kodu daxil edin.' });
    return;
  }
  const obfuscated = obfuscateLuaCode(code, level);
  res.json({ ok: true, level, obfuscated });
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
  const creatorName =
    String((req.body && req.body.createdByName) || '').trim() ||
    (creatorId ? await resolveDiscordUserName(creatorId) : 'Dashboard Admin');
  const sc = ws.scripts.find((s) => s.id === scriptId) || ws.scripts[0];
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

  const created = [];
  for (let i = 0; i < amount; i = i + 1) {
    const item = {
      key: generateRandomKeyCode(),
      scriptId: sc ? sc.id : scriptId,
      scriptName: sc ? sc.name : 'SADO HUB',
      duration,
      expiresAt,
      used: false,
      usedByDiscordId: null,
      usedByName: '',
      createdByDiscordId: creatorId,
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
  const scriptId = String(
    (req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default'
  );
  const duration = String((req.body && req.body.duration) || 'lifetime').trim() || 'lifetime';
  const hwidLockEnabled =
    req.body && req.body.hwidLocked !== undefined ? Boolean(req.body.hwidLocked) : true;
  const addedById = String((req.body && req.body.addedByDiscordId) || ws.discordUserId || '').trim();
  if (!discordUserId) {
    res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    return;
  }
  const targetName =
    String((req.body && req.body.username) || '').trim() ||
    (await resolveDiscordUserName(discordUserId));
  const addedByName =
    String((req.body && req.body.addedByName) || '').trim() ||
    (addedById ? await resolveDiscordUserName(addedById) : 'Dashboard Admin');
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

  const existingIdx = ws.whitelists.findIndex(
    (w) => w.discordUserId === discordUserId && w.scriptId === scriptId
  );
  const entry = {
    id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
    discordUserId,
    username: targetName,
    scriptId,
    key:
      existingIdx >= 0 && ws.whitelists[existingIdx].key
        ? ws.whitelists[existingIdx].key
        : generateRandomKeyCode(),
    hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
    hwidLocked: hwidLockEnabled,
    addedByDiscordId: addedById,
    addedByName,
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
    message: wl.hwidLocked ? 'HWID kilidi aktivləşdirildi!' : 'HWID kilidi açıldı!',
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
  ws.stats.hwidResets = ws.stats.hwidResets + 1;
  await saveStore();
  res.json({ ok: true, workspaceId: wsId, message: 'HWID sıfırlandı!' });
});

app.delete('/api/whitelist/:id', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const before = ws.whitelists.length;
  ws.whitelists = ws.whitelists.filter((w) => w.id !== req.params.id);
  await saveStore();
  res.json({
    ok: true,
    workspaceId: wsId,
    removed: before - ws.whitelists.length,
    message: 'Whitelist-dən çıxarıldı.',
  });
});

app.post('/api/send-panel', async (req, res) => {
  try {
    const { wsId, ws } = getWorkspaceFromReq(req);
    const channelId = String((req.body && req.body.channelId) || '').trim();
    const scriptId = String(
      (req.body && req.body.scriptId) || (ws.scripts[0] && ws.scripts[0].id) || 'default'
    );
    if (!channelId) {
      res.status(400).json({ ok: false, message: 'Discord Channel ID daxil edin.' });
      return;
    }
    if (!BOT_TOKEN) {
      res.status(400).json({ ok: false, message: 'Bot token təyin edilməyib.' });
      return;
    }
    const sc = ws.scripts.find((s) => s.id === scriptId) || ws.scripts[0];
    const { embed, row } = buildPanelEmbedAndButtons(ws, sc);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const sentMsg = await rest.post(Routes.channelMessages(channelId), {
      body: { embeds: [embed.toJSON()], components: [row.toJSON()] },
    });
    ws.panels.push({
      id: crypto.randomUUID(),
      channelId,
      messageId: sentMsg && sentMsg.id ? sentMsg.id : '',
      scriptId: sc ? sc.id : 'default',
      title: ws.panelConfig.title,
      createdAt: new Date().toISOString(),
    });
    await saveStore();
    res.json({ ok: true, workspaceId: wsId, message: 'Panel kanala göndərildi!' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Panel göndərilə bilmədi.' });
  }
});

const handleLoaderRequest = async (req, res) => {
  try {
    const tokenOrId = decodeURIComponent(req.params.token || '');
    const { wsId, ws } = getWorkspaceFromReq(req);
    let targetWsId = wsId;
    let targetWs = ws;
    let sc =
      targetWs.scripts.find((s) => s.loaderToken === tokenOrId || s.id === tokenOrId) || null;

    if (!sc) {
      for (const item of getAllWorkspacesList()) {
        const found = item.ws.scripts.find((s) => s.loaderToken === tokenOrId || s.id === tokenOrId);
        if (found) {
          targetWsId = item.wsId;
          targetWs = item.ws;
          sc = found;
          break;
        }
      }
    }

    if (!sc) {
      sc = targetWs.scripts[0] || { id: 'default', code: DEFAULT_SCRIPT_CODE };
    }

    const baseUrl = buildPublicBaseUrl(req);
    const verifyUrl = `${baseUrl}/api/verify?ws=${encodeURIComponent(
      targetWsId
    )}&scriptId=${encodeURIComponent(sc.id)}`;

    const luaLoader = [
      'local _key = tostring(script_key or "")',
      'local _hwid = tostring((gethwid and gethwid()) or (game:GetService("RbxAnalyticsService"):GetClientId()) or "UNKNOWN_HWID")',
      `local _url = "${verifyUrl}&key=" .. _key .. "&hwid=" .. _hwid`,
      'local _ok, _res = pcall(function() return game:HttpGet(_url) end)',
      'if not _ok or not _res then warn("SADO PROTECT: Server bağlantısı alınmadı") return end',
      'local _fn = loadstring(_res)',
      'if type(_fn) == "function" then _fn() else warn("SADO PROTECT: " .. tostring(_res)) end',
    ].join('\n');

    res.type('text/plain').send(luaLoader);
  } catch (err) {
    res.status(500).type('text/plain').send(`warn("SADO PROTECT Loader Error: ${err.message}")`);
  }
};

app.get('/loader/:token', handleLoaderRequest);
app.get('/api/loader/:token', handleLoaderRequest);

app.get('/api/verify', async (req, res) => {
  try {
    const keyInput = String((req.query && req.query.key) || '').trim();
    const hwidInput = String((req.query && req.query.hwid) || '').trim();
    const requestedScriptId = String((req.query && req.query.scriptId) || '').trim();
    const { ws } = getWorkspaceFromReq(req);

    if (!keyInput) {
      res.status(401).type('text/plain').send('return warn("SADO PROTECT: Key daxil edilməyib!")');
      return;
    }

    const wl = ws.whitelists.find(
      (w) =>
        String(w.key || '').toUpperCase() === keyInput.toUpperCase() &&
        (!requestedScriptId || w.scriptId === requestedScriptId)
    );

    if (!wl) {
      ws.stats.authBlocked = ws.stats.authBlocked + 1;
      await saveStore();
      res
        .status(403)
        .type('text/plain')
        .send('return warn("SADO PROTECT: Key etibarsızdır və ya whitelist-də deyil!")');
      return;
    }

    if (isExpired(wl.expiresAt)) {
      ws.stats.authBlocked = ws.stats.authBlocked + 1;
      await saveStore();
      res.status(403).type('text/plain').send('return warn("SADO PROTECT: Key/Whitelist müddəti bitib!")');
      return;
    }

    const isBl = ws.blacklist.some(
      (b) => b.discordUserId === wl.discordUserId && (!b.scriptId || b.scriptId === wl.scriptId)
    );
    if (isBl) {
      ws.stats.authBlocked = ws.stats.authBlocked + 1;
      await saveStore();
      res.status(403).type('text/plain').send('return warn("SADO PROTECT: İstifadəçi blacklist-dədir!")');
      return;
    }

    if (hwidInput && wl.hwidLocked !== false) {
      if (!wl.hwid || String(wl.hwid).trim() === '') {
        wl.hwid = hwidInput;
        await saveStore();
      } else if (String(wl.hwid).trim() !== hwidInput) {
        ws.stats.authBlocked = ws.stats.authBlocked + 1;
        await saveStore();
        res
          .status(403)
          .type('text/plain')
          .send('return warn("SADO PROTECT: HWID başqa cihaza bağlıdır! Kick.")');
        return;
      }
    }

    const targetScriptId = requestedScriptId || wl.scriptId || 'default';
    const sc = ws.scripts.find((s) => s.id === targetScriptId) || ws.scripts[0];
    ws.stats.authSuccess = ws.stats.authSuccess + 1;
    await saveStore();

    res.status(200).type('text/plain').send(sc ? sc.code : DEFAULT_SCRIPT_CODE);
  } catch (err) {
    res
      .status(500)
      .type('text/plain')
      .send(`return warn("SADO PROTECT Verify Error: ${err.message}")`);
  }
});

app.get('/ui', (req, res) => {
  const wsParam = sanitizeWorkspaceId(req.query.ws || '');
  res.type('html').send(`<!DOCTYPE html>
<html lang="az">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SADO PROTECT Control</title>
<style>
  body { font-family: Arial, sans-serif; background: #111; color: #eee; margin: 12px; }
  .box { border: 1px solid #444; padding: 10px; margin-bottom: 12px; background: #1b1b1b; }
  input, select, textarea, button { margin: 4px 2px; padding: 6px; background: #262626; color: #fff; border: 1px solid #555; }
  button { cursor: pointer; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #444; padding: 5px; font-size: 12px; text-align: left; }
  .chart-row { margin: 6px 0; }
  .bar-wrap { background: #262626; border: 1px solid #444; height: 18px; width: 100%; }
  .bar-fill { background: #10b981; height: 100%; }
</style>
</head>
<body>
  <h2>SADO PROTECT Control</h2>
  <div class="box" id="statusBar">Yüklənir...</div>

  <div class="box">
    <h3>Qrafiklər & Statistika</h3>
    <div id="chartsArea"></div>
  </div>

  <div class="box">
    <h3>Join Discord & Sunucu Bağlantısı</h3>
    <a id="joinDiscordBtn" href="#" target="_blank"><button type="button">Join Discord</button></a>
    <div>
      <label>Discord Server ID:</label>
      <input id="guildIdInput" placeholder="Server ID" />
      <select id="guildSelect"></select>
      <button type="button" onclick="linkWorkspace()">Sunucunu Bağla</button>
    </div>
    <div>
      <label>Discord User ID:</label>
      <input id="discordUserIdInput" placeholder="User ID" />
      <span id="linkedGuildName"></span>
    </div>
  </div>

  <div class="box">
    <h3>Skript & Obfuscation</h3>
    <input id="scriptNameInput" placeholder="Skript adı" />
    <select id="obfLevelSelect">
      <option value="1">Obfuscate Səviyyə 1</option>
      <option value="2" selected>Obfuscate Səviyyə 2</option>
      <option value="3">Obfuscate Səviyyə 3</option>
    </select>
    <label><input type="checkbox" id="createObfCheckbox" /> Saxlayarkən Obfuscate et</label><br/>
    <textarea id="scriptCodeInput" rows="5" cols="50" placeholder="Lua kodu..."></textarea><br/>
    <button type="button" onclick="createScript()">Skript Saxla</button>
    <button type="button" onclick="runStandaloneObf()">Kodu Obfuscate Et</button><br/>
    <textarea id="obfResultBox" rows="4" cols="50" placeholder="Obfuscated nəticə..."></textarea>
    <div id="scriptsList"></div>
  </div>

  <div class="box">
    <h3>GenKey</h3>
    <select id="keyScriptSelect"></select>
    <input id="keyDurationInput" value="lifetime" placeholder="7d, 30d, lifetime" />
    <input id="keyAmountInput" type="number" value="1" min="1" max="100" />
    <button type="button" onclick="generateKeys()">Key Yarat</button>
    <div id="keysList"></div>
  </div>

  <div class="box">
    <h3>Whitelist & Unwhitelist & HWID Kilid / Reset</h3>
    <input id="wlUserIdInput" placeholder="Discord User ID" />
    <input id="wlUserNameInput" placeholder="İstifadəçi adı (opsional)" />
    <select id="wlScriptSelect"></select>
    <input id="wlDurationInput" value="lifetime" />
    <label><input type="checkbox" id="wlLockCheckbox" checked /> HWID Kilidli</label>
    <button type="button" onclick="addWhitelist()">Whitelist Et</button>
    <div id="wlList"></div>
  </div>

  <div class="box">
    <h3>Panel Göndər</h3>
    <input id="panelChannelIdInput" placeholder="Discord Channel ID" />
    <select id="panelScriptSelect"></select>
    <button type="button" onclick="sendPanelToChannel()">Paneli Göndər</button>
    <div id="msgLog"></div>
  </div>

<script>
const storageKey = 'sado_ws_id';
let wsId = ${wsParam ? JSON.stringify(wsParam) : 'localStorage.getItem(storageKey)'};
if (!wsId) {
  wsId = 'ws_' + Math.random().toString(36).slice(2, 10);
}
localStorage.setItem(storageKey, wsId);

const api = (url, opts = {}) => {
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-client-workspace': wsId }, opts.headers || {});
  return fetch(url, opts).then((r) => r.json());
};

const showMsg = (txt) => {
  document.getElementById('msgLog').textContent = txt;
};

const renderCharts = (data) => {
  const st = data.stats || {};
  const keysList = data.keys || [];
  const wlList = data.whitelists || [];
  const blList = data.blacklist || [];
  const scriptsList = data.scripts || [];
  const panelsList = data.panels || [];
  const usedKeysCount = keysList.filter((k) => k.used).length;
  const unusedKeysCount = keysList.length - usedKeysCount;
  const lockedWlCount = wlList.filter((w) => w.hwidLocked !== false).length;
  const boundHwidCount = wlList.filter((w) => Boolean(w.hwid)).length;

  const metrics = [
    { label: 'Auth Uğurlu', val: Number(st.authSuccess || 0), color: '#10b981' },
    { label: 'Auth Bloklanan', val: Number(st.authBlocked || 0), color: '#ef4444' },
    { label: 'Redeem Sayı', val: Number(st.redeems || 0), color: '#3b82f6' },
    { label: 'Script Fetch', val: Number(st.scriptFetches || 0), color: '#8b5cf6' },
    { label: 'HWID Reset', val: Number(st.hwidResets || 0), color: '#f59e0b' },
    { label: 'Ümumi Keylər', val: keysList.length, color: '#06b6d4' },
    { label: 'İşlənmiş Keylər', val: usedKeysCount, color: '#ec4899' },
    { label: 'Boş Keylər', val: unusedKeysCount, color: '#22c55e' },
    { label: 'Whitelist Sayı', val: wlList.length, color: '#6366f1' },
    { label: 'HWID Bağlı İstifadəçi', val: boundHwidCount, color: '#14b8a6' },
    { label: 'HWID Kilidli Qeyd', val: lockedWlCount, color: '#eab308' },
    { label: 'Blacklist Sayı', val: blList.length, color: '#dc2626' },
    { label: 'Skript Sayı', val: scriptsList.length, color: '#a855f7' },
    { label: 'Göndərilmiş Panellər', val: panelsList.length, color: '#0ea5e9' }
  ];

  const maxVal = Math.max(1, ...metrics.map((m) => m.val));
  document.getElementById('chartsArea').innerHTML = metrics.map((m) => {
    const pct = Math.round((m.val / maxVal) * 100);
    return '<div class="chart-row"><div>' + m.label + ': <b>' + m.val + '</b> (' + pct + '%)</div>' +
      '<div class="bar-wrap"><div class="bar-fill" style="width:' + pct + '%;background:' + m.color + '"></div></div></div>';
  }).join('');
};

const previewGuildNameFromInput = async () => {
  const gId = document.getElementById('guildIdInput').value.trim();
  const uId = document.getElementById('discordUserIdInput').value.trim();
  const targetId = gId || uId;
  if (!targetId) {
    document.getElementById('linkedGuildName').textContent = '';
    return;
  }
  const res = await api('/api/workspace/link', {
    method: 'POST',
    body: JSON.stringify({
      guildId: gId || document.getElementById('guildIdInput').value.trim(),
      discordUserId: uId,
    }),
  });
  if (res && res.guildName) {
    document.getElementById('linkedGuildName').textContent = 'Sunucu adı: ' + res.guildName;
    document.getElementById('statusBar').textContent =
      'Workspace: ' + wsId + ' | Sunucu: ' + res.guildName + (res.guildId ? ' (' + res.guildId + ')' : '');
  }
};

const refreshAll = async () => {
  const st = await api('/api/status');
  const data = await api('/api/state');
  document.getElementById('statusBar').textContent =
    'Workspace: ' + wsId + ' | Bot: ' + (st.botReady ? '7/24 Online' : 'Qoşulur...') +
    ' | Sunucu: ' + (data.guildName || 'Seçilməyib') + (data.guildId ? ' (' + data.guildId + ')' : '');
  document.getElementById('joinDiscordBtn').href = data.inviteUrl || 'https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot';
  document.getElementById('guildIdInput').value = data.guildId || '';
  document.getElementById('discordUserIdInput').value = data.discordUserId || '';
  document.getElementById('linkedGuildName').textContent = data.guildName ? 'Sunucu adı: ' + data.guildName : '';
  document.getElementById('guildIdInput').oninput = previewGuildNameFromInput;
  document.getElementById('discordUserIdInput').oninput = previewGuildNameFromInput;

  renderCharts(data);

  const gSel = document.getElementById('guildSelect');
  gSel.innerHTML = '<option value="">-- Botdakı Sunucular --</option>' +
    (data.guilds || []).map((g) => '<option value="' + g.id + '">' + g.name + ' (' + g.id + ')</option>').join('');
  gSel.onchange = () => { if (gSel.value) document.getElementById('guildIdInput').value = gSel.value; };

  const scriptOpts = (data.scripts || []).map((s) => '<option value="' + s.id + '">' + s.name + '</option>').join('');
  document.getElementById('keyScriptSelect').innerHTML = scriptOpts;
  document.getElementById('wlScriptSelect').innerHTML = scriptOpts;
  document.getElementById('panelScriptSelect').innerHTML = scriptOpts;

  document.getElementById('scriptsList').innerHTML = '<table><tr><th>Ad</th><th>Loader</th><th>Sil</th></tr>' +
    (data.scripts || []).map((s) => '<tr><td>' + s.name + '</td><td>loadstring(game:HttpGet("' + location.origin + '/loader/' + s.loaderToken + '?ws=' + wsId + '"))()</td><td><button onclick="deleteScript(\\'' + s.id + '\\')">Sil</button></td></tr>').join('') +
    '</table>';

  document.getElementById('keysList').innerHTML = '<table><tr><th>Key</th><th>Skript</th><th>Yaradan</th><th>İstifadə edən</th><th>Sil</th></tr>' +
    (data.keys || []).map((k) => '<tr><td>' + k.key + '</td><td>' + k.scriptName + '</td><td>' + (k.createdByName || '-') + '</td><td>' + (k.usedByName || (k.used ? k.usedByDiscordId : 'İstifadə olunmayıb')) + '</td><td><button onclick="deleteKey(\\'' + encodeURIComponent(k.key) + '\\')">Sil</button></td></tr>').join('') +
    '</table>';

  document.getElementById('wlList').innerHTML = '<table><tr><th>İstifadəçi</th><th>ID</th><th>Əlavə edən</th><th>HWID</th><th>Kilid</th><th>Əməliyyat</th></tr>' +
    (data.whitelists || []).map((w) => '<tr><td>' + (w.username || '-') + '</td><td>' + w.discordUserId + '</td><td>' + (w.addedByName || '-') + '</td><td>' + (w.hwid || 'Yoxdur') + '</td><td>' + (w.hwidLocked === false ? 'Açıq' : 'Kilidli') + '</td><td>' +
      '<button onclick="toggleLock(\\'' + w.id + '\\')">Kilid Aç/Bağla</button>' +
      '<button onclick="resetHwid(\\'' + w.id + '\\')">Reset HWID</button>' +
      '<button onclick="removeWl(\\'' + w.id + '\\')">Unwhitelist</button>' +
      '</td></tr>').join('') +
    '</table>';
};

const linkWorkspace = async () => {
  const res = await api('/api/workspace/link', {
    method: 'POST',
    body: JSON.stringify({
      guildId: document.getElementById('guildIdInput').value,
      discordUserId: document.getElementById('discordUserIdInput').value,
    }),
  });
  showMsg(res.message || 'Yeniləndi');
  refreshAll();
};

const createScript = async () => {
  const res = await api('/api/scripts', {
    method: 'POST',
    body: JSON.stringify({
      name: document.getElementById('scriptNameInput').value,
      code: document.getElementById('scriptCodeInput').value,
      obfuscate: document.getElementById('createObfCheckbox').checked,
      obfuscateLevel: document.getElementById('obfLevelSelect').value,
    }),
  });
  showMsg(res.message || 'Saxlandı');
  refreshAll();
};

const runStandaloneObf = async () => {
  const res = await api('/api/obfuscate', {
    method: 'POST',
    body: JSON.stringify({
      code: document.getElementById('scriptCodeInput').value,
      level: document.getElementById('obfLevelSelect').value,
    }),
  });
  if (res.obfuscated) document.getElementById('obfResultBox').value = res.obfuscated;
  showMsg(res.message || 'Obfuscate hazırlandı');
};

const deleteScript = async (id) => {
  const res = await api('/api/scripts/' + id, { method: 'DELETE' });
  showMsg(res.message || 'Silindi');
  refreshAll();
};

const generateKeys = async () => {
  const res = await api('/api/keys', {
    method: 'POST',
    body: JSON.stringify({
      scriptId: document.getElementById('keyScriptSelect').value,
      duration: document.getElementById('keyDurationInput').value,
      amount: Number(document.getElementById('keyAmountInput').value || 1),
      createdByDiscordId: document.getElementById('discordUserIdInput').value,
    }),
  });
  showMsg(res.message || 'Key yaradıldı');
  refreshAll();
};

const deleteKey = async (encKey) => {
  const res = await api('/api/keys/' + encKey, { method: 'DELETE' });
  showMsg(res.message || 'Key silindi');
  refreshAll();
};

const addWhitelist = async () => {
  const res = await api('/api/whitelist', {
    method: 'POST',
    body: JSON.stringify({
      discordUserId: document.getElementById('wlUserIdInput').value,
      username: document.getElementById('wlUserNameInput').value,
      scriptId: document.getElementById('wlScriptSelect').value,
      duration: document.getElementById('wlDurationInput').value,
      hwidLocked: document.getElementById('wlLockCheckbox').checked,
      addedByDiscordId: document.getElementById('discordUserIdInput').value,
    }),
  });
  showMsg(res.message || 'Whitelist yeniləndi');
  refreshAll();
};

const toggleLock = async (id) => {
  const res = await api('/api/whitelist/' + id + '/toggle-lock', { method: 'POST' });
  showMsg(res.message || 'Kilid yeniləndi');
  refreshAll();
};

const resetHwid = async (id) => {
  const res = await api('/api/whitelist/' + id + '/reset-hwid', { method: 'POST' });
  showMsg(res.message || 'HWID sıfırlandı');
  refreshAll();
};

const removeWl = async (id) => {
  const res = await api('/api/whitelist/' + id, { method: 'DELETE' });
  showMsg(res.message || 'Whitelist silindi');
  refreshAll();
};

const sendPanelToChannel = async () => {
  const res = await api('/api/send-panel', {
    method: 'POST',
    body: JSON.stringify({
      channelId: document.getElementById('panelChannelIdInput').value,
      scriptId: document.getElementById('panelScriptSelect').value,
    }),
  });
  showMsg(res.message || 'Panel göndərildi');
  refreshAll();
};

refreshAll();
</script>
</body>
</html>`);
});

app.get('/', (req, res) => {
  const wsParam = req.query && req.query.ws ? `?ws=${encodeURIComponent(req.query.ws)}` : '';
  res.redirect(`/ui${wsParam}`);
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
    if (!client.isReady() && !isConnectingNow) {
      ensureBotOnline().catch(() => {});
    }
  }, 4 * 60 * 1000);
});
