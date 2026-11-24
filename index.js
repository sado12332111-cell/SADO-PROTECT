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

const TOKEN_PARTS = [
  'MTU2MjA4MDY1NDI4MjE5OTEyMQ',
  'GezNfm',
  'uOsxre1d-X2aUXZ55ua1vaumADoI-JbvNxXOg0',
];
const BOT_TOKEN = TOKEN_PARTS.join('.');

const DEFAULT_PANEL_CONFIG = {
  embedColor: '#10b981',
  title: 'SADO PROTECT • Script Panel',
  description:
    'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin.',
  redeemLabel: 'Redeem Key',
  getScriptLabel: 'Get Script',
  resetHwidLabel: 'Reset HWID',
  statsLabel: 'Get Stats',
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
  const wsId = sanitizeWorkspaceId(headerWs || queryWs || bodyWs || store.activeWorkspaceId || 'default');
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
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`sado_getscript_${scriptId}`)
      .setLabel(cfg.getScriptLabel || 'Get Script')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sado_resethwid_${scriptId}`)
      .setLabel(cfg.resetHwidLabel || 'Reset HWID')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`sado_stats_${scriptId}`)
      .setLabel(cfg.statsLabel || 'Get Stats')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Secondary)
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
  commandsRegistered = true;
};

const ensureBotOnline = async () => {
  if (!BOT_TOKEN) return;
  if (client.isReady()) return;
  if (isConnectingNow) return;
  const now = Date.now();
  if (now - lastConnectAttempt < 12000) return;
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
      if (!client.isReady() && !isConnectingNow) {
        await ensureBotOnline();
      }
      if (client.isReady() && !commandsRegistered) {
        await registerSlashCommands().catch(() => {});
      }
    } catch (_e) {}
  }, 45000);
};

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BOT] ${readyClient.user.tag} aktivdir!`);
  commandsRegistered = false;
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
            channelId: interaction.channelId || (sentMsg.channel_id || ''),
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
          scriptId: sc ? sc.id : 'default',
          key: existingIdx >= 0 && ws.whitelists[existingIdx].key ? ws.whitelists[existingIdx].key : generateRandomKeyCode(),
          hwid: '',
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
        keyObj.usedAt = new Date().toISOString();

        const existingWlIdx = ws.whitelists.findIndex(
          (w) => w.discordUserId === userId && w.scriptId === targetScriptId
        );
        const wlRecord = {
          id: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].id : crypto.randomUUID(),
          discordUserId: userId,
          username: interaction.user.username,
          scriptId: targetScriptId,
          key: keyObj.key,
          hwid: existingWlIdx >= 0 ? ws.whitelists[existingWlIdx].hwid || '' : '',
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
  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId || '',
    discordUserId: ws.discordUserId || '',
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
  ws.guildId = guildId;
  ws.discordUserId = discordUserId;
  await saveStore();
  if (BOT_TOKEN && client.isReady()) {
    await registerSlashCommands().catch(() => {});
  }
  res.json({
    ok: true,
    workspaceId: wsId,
    guildId: ws.guildId,
    discordUserId: ws.discordUserId,
    message: 'Sunucu və Discord ID yadda saxlandı!',
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
      String(body.description !== undefined ? body.description : ws.panelConfig.description).trim() ||
      DEFAULT_PANEL_CONFIG.description,
    redeemLabel: String(body.redeemLabel || ws.panelConfig.redeemLabel).trim() || 'Redeem Key',
    getScriptLabel:
      String(body.getScriptLabel || ws.panelConfig.getScriptLabel).trim() || 'Get Script',
    resetHwidLabel:
      String(body.resetHwidLabel || ws.panelConfig.resetHwidLabel).trim() || 'Reset HWID',
    statsLabel: String(body.statsLabel || ws.panelConfig.statsLabel).trim() || 'Get Stats',
    footerText:
      String(body.footerText || ws.panelConfig.footerText).trim() ||
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

app.post('/api/scripts', async (req, res) => {
  const { wsId, ws } = getWorkspaceFromReq(req);
  const name = String((req.body && req.body.name) || '').trim();
  const code = String((req.body && req.body.code) || DEFAULT_SCRIPT_CODE);
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
  if (!discordUserId) {
    res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    return;
  }
  const durMs = parseDurationToMs(duration);
  const expiresAt = durMs ? new Date(Date.now() + durMs).toISOString() : null;

  const existingIdx = ws.whitelists.findIndex(
    (w) => w.discordUserId === discordUserId && w.scriptId === scriptId
  );
  const entry = {
    id: existingIdx >= 0 ? ws.whitelists[existingIdx].id : crypto.randomUUID(),
    discordUserId,
    username: `User_${discordUserId.slice(-4)}`,
    scriptId,
    key:
      existingIdx >= 0 && ws.whitelists[existingIdx].key
        ? ws.whitelists[existingIdx].key
        : generateRandomKeyCode(),
    hwid: existingIdx >= 0 ? ws.whitelists[existingIdx].hwid || '' : '',
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
  const blItem = {
    id: crypto.randomUUID(),
    discordUserId,
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
    res.json({ ok: true, workspaceId: wsId, messageId: msg.id, message: 'Panel kanala göndərildi!' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Panel göndərilə bilmədi.' });
  }
});

app.get('/loader/:token', (req, res) => {
  const tokenParam = decodeURIComponent(req.params.token || '');
  const wsId = sanitizeWorkspaceId(req.query.ws || store.activeWorkspaceId || 'default');
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
      req.query.ws || (req.body && req.body.workspaceId) || store.activeWorkspaceId || 'default'
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

    if (hwidInput) {
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
<title>SADO PROTECT • Control Panel</title>
<style>
  :root {
    --bg: #070b14;
    --panel: #0e1525;
    --panel-2: #131d33;
    --border: rgba(148, 163, 184, 0.14);
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #10b981;
    --accent-2: #3b82f6;
    --danger: #ef4444;
    --warn: #f59e0b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, system-ui, -apple-system, sans-serif; }
  body {
    background: radial-gradient(circle at top right, rgba(16, 185, 129, 0.11), transparent 45%),
                radial-gradient(circle at bottom left, rgba(59, 130, 246, 0.11), transparent 45%),
                var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 18px;
  }
  .wrap { max-width: 1160px; margin: 0 auto; display: grid; gap: 16px; }
  .box {
    background: rgba(14, 21, 37, 0.92);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 18px;
    display: grid;
    gap: 14px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  }
  .top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
  .title-group h1 { font-size: 21px; font-weight: 800; letter-spacing: -0.02em; }
  .title-group p { color: var(--muted); font-size: 13px; margin-top: 3px; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill {
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .pill.on { color: #34d399; border-color: rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.12); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; }
  .stat {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
  }
  .stat span { font-size: 12px; color: var(--muted); display: block; }
  .stat strong { font-size: 21px; font-weight: 800; margin-top: 4px; display: block; }
  h2 { font-size: 16px; font-weight: 700; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  label { display: grid; gap: 6px; font-size: 12px; color: var(--muted); font-weight: 600; }
  input, textarea, select {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
    outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent); }
  textarea { min-height: 104px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .btns { display: flex; flex-wrap: wrap; gap: 10px; }
  button {
    background: var(--accent);
    color: #042f2e;
    border: none;
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 800;
    cursor: pointer;
  }
  button.blue { background: var(--accent-2); color: #fff; }
  button.ghost { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
  button.red { background: var(--danger); color: #fff; }
  .rows { display: grid; gap: 8px; }
  .item {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 11px;
    padding: 10px 12px;
    font-size: 13px;
  }
  code { background: rgba(15, 23, 42, 0.85); padding: 2px 6px; border-radius: 6px; color: #93c5fd; }
  .toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    background: var(--accent);
    color: #042f2e;
    font-weight: 800;
    padding: 11px 16px;
    border-radius: 11px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
    z-index: 100;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="wrap">
  <div class="box">
    <div class="top">
      <div class="title-group">
        <h1>🛡️ SADO PROTECT • Control Panel</h1>
        <p>Hər cihaz üçün ayrı workspace, canlı Discord panel yeniləmə və HWID Kick mühafizəsi</p>
      </div>
      <div class="pills">
        <div id="botPill" class="pill">Bot yoxlanılır...</div>
        <div id="wsPill" class="pill">Cihaz ID: yüklənir...</div>
      </div>
    </div>
    <div id="statsRow" class="stats"></div>
  </div>

  <div class="box">
    <h2>🔗 Discord Sunucu & İstifadəçi ID Bağlantısı</h2>
    <div class="grid2">
      <label>Discord Server (Guild) ID
        <input id="guildIdInput" placeholder="Məs: 123456789012345678" />
      </label>
      <label>Discord User ID
        <input id="discordUserIdInput" placeholder="Məs: 987654321098765432" />
      </label>
    </div>
    <div class="btns">
      <button id="saveLinkBtn">ID-ləri Yadda Saxla</button>
    </div>
  </div>

  <div class="box">
    <h2>🎨 Panel Dizaynı (Aktiv Panelləri Dərhal Yeniləyir)</h2>
    <div class="grid2">
      <label>Embed Rəngi (Hex)
        <input id="cfgColor" placeholder="#10b981" />
      </label>
      <label>Panel Başlığı
        <input id="cfgTitle" placeholder="SADO PROTECT • Script Panel" />
      </label>
      <label>Redeem Düyməsi
        <input id="cfgRedeem" placeholder="Redeem Key" />
      </label>
      <label>Get Script Düyməsi
        <input id="cfgScript" placeholder="Get Script" />
      </label>
      <label>Reset HWID Düyməsi
        <input id="cfgHwid" placeholder="Reset HWID" />
      </label>
      <label>Stats Düyməsi
        <input id="cfgStats" placeholder="Get Stats" />
      </label>
      <label>Footer Mətni
        <input id="cfgFooter" placeholder="SADO PROTECT • Secure Loader & Key System" />
      </label>
      <label>Şəkil URL (İstəyə bağlı)
        <input id="cfgImage" placeholder="https://..." />
      </label>
    </div>
    <label>Panel Təsviri
      <textarea id="cfgDesc"></textarea>
    </label>
    <div class="btns">
      <button id="saveDesignBtn">Dizaynı Yadda Saxla & Aktiv Panelləri Yenilə</button>
    </div>
  </div>

  <div class="box">
    <h2>📜 Skriptlər & Loader</h2>
    <div class="grid2">
      <label>Yeni Skript Adı
        <input id="scriptNameInput" placeholder="SADO HUB" />
      </label>
      <label>Aktiv Skript Seçimi
        <select id="scriptSelect"></select>
      </label>
    </div>
    <label>Lua Skript Kodu
      <textarea id="scriptCodeInput"></textarea>
    </label>
    <div class="btns">
      <button id="addScriptBtn" class="blue">Skript Əlavə Et</button>
    </div>
    <div id="scriptsBox" class="rows"></div>
  </div>

  <div class="box">
    <h2>🔑 Key Yaradılması & Whitelist / HWID</h2>
    <div class="grid2">
      <label>Müddət (1d, 7d, 30d, lifetime)
        <input id="keyDurInput" value="lifetime" />
      </label>
      <label>Key Sayı
        <input id="keyAmtInput" type="number" min="1" max="50" value="1" />
      </label>
    </div>
    <div class="btns">
      <button id="genKeyBtn">Key Yarat</button>
    </div>
    <div id="keysBox" class="rows"></div>

    <div class="grid2" style="margin-top:6px;">
      <label>Whitelist Discord User ID
        <input id="wlUserInput" placeholder="Discord User ID" />
      </label>
      <label>Müddət
        <input id="wlDurInput" value="lifetime" />
      </label>
    </div>
    <div class="btns">
      <button id="addWlBtn" class="blue">Whitelist-ə Əlavə Et</button>
    </div>
    <div id="wlBox" class="rows"></div>
  </div>

  <div class="box">
    <h2>🚫 Blacklist & Panel Göndər</h2>
    <div class="grid2">
      <label>Blacklist Discord User ID
        <input id="blUserInput" placeholder="Discord User ID" />
      </label>
      <label>Kanal ID
        <input id="channelInput" placeholder="Discord Channel ID" />
      </label>
    </div>
    <div class="btns">
      <button id="addBlBtn" class="red">Blacklist-ə Əlavə Et</button>
      <button id="sendPanelBtn" class="ghost">Paneli Kanala Göndər</button>
    </div>
    <div id="blBox" class="rows"></div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
  const getDeviceWorkspaceId = () => {
    try {
      let id = localStorage.getItem('sado_device_ws_v1');
      if (!id) {
        id = 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
        localStorage.setItem('sado_device_ws_v1', id);
      }
      return id;
    } catch (_e) {
      return 'default';
    }
  };

  const DEVICE_WS = getDeviceWorkspaceId();
  document.getElementById('wsPill').textContent = 'Cihaz ID: ' + DEVICE_WS;

  const reqApi = (url, opts = {}) => {
    const headers = Object.assign({ 'X-Client-Workspace': DEVICE_WS }, opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers }));
  };

  const notify = (msg) => {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  };

  let hydrated = false;

  const refreshUI = async () => {
    const stRes = await reqApi('/api/status');
    const st = await stRes.json();

    const botPill = document.getElementById('botPill');
    if (st.botReady) {
      botPill.textContent = '🟢 Bot Aktiv: ' + (st.botTag || 'Online');
      botPill.className = 'pill on';
    } else {
      botPill.textContent = '🔴 Bot Bağlanır...';
      botPill.className = 'pill';
    }

    const stats = st.stats || {};
    const counts = st.counts || {};
    document.getElementById('statsRow').innerHTML = [
      ['Skriptlər', counts.scripts || 0],
      ['Keylər', counts.keys || 0],
      ['Whitelist', counts.whitelists || 0],
      ['Uğurlu Auth', stats.authSuccess || 0],
      ['Kick / Blok', stats.authBlocked || 0],
    ]
      .map(([label, val]) => '<div class="stat"><span>' + label + '</span><strong>' + val + '</strong></div>')
      .join('');

    const stateRes = await reqApi('/api/state');
    const stateData = await stateRes.json();
    if (!stateData.ok) return;

    if (!hydrated) {
      document.getElementById('guildIdInput').value = stateData.guildId || '';
      document.getElementById('discordUserIdInput').value = stateData.discordUserId || '';
      const cfg = stateData.panelConfig || {};
      document.getElementById('cfgColor').value = cfg.embedColor || '#10b981';
      document.getElementById('cfgTitle').value = cfg.title || '';
      document.getElementById('cfgDesc').value = cfg.description || '';
      document.getElementById('cfgRedeem').value = cfg.redeemLabel || 'Redeem Key';
      document.getElementById('cfgScript').value = cfg.getScriptLabel || 'Get Script';
      document.getElementById('cfgHwid').value = cfg.resetHwidLabel || 'Reset HWID';
      document.getElementById('cfgStats').value = cfg.statsLabel || 'Get Stats';
      document.getElementById('cfgFooter').value = cfg.footerText || '';
      document.getElementById('cfgImage').value = cfg.imageUrl || '';
      hydrated = true;
    }

    const sel = document.getElementById('scriptSelect');
    const prev = sel.value;
    sel.innerHTML = (stateData.scripts || [])
      .map((s) => '<option value="' + s.id + '">' + s.name + ' (' + s.id + ')</option>')
      .join('');
    if (prev) sel.value = prev;

    document.getElementById('scriptsBox').innerHTML = (stateData.scripts || [])
      .map(
        (s) =>
          '<div class="item"><div><strong>' +
          s.name +
          '</strong> <code>' +
          s.id +
          '</code></div><button class="red" onclick="removeScript(\\'' +
          s.id +
          '\\')">Sil</button></div>'
      )
      .join('');

    document.getElementById('keysBox').innerHTML = (stateData.keys || [])
      .slice(0, 20)
      .map(
        (k) =>
          '<div class="item"><div><code>' +
          k.key +
          '</code> • ' +
          k.scriptName +
          ' • ' +
          (k.used ? 'İstifadə olunub (' + (k.usedByDiscordId || '') + ')' : 'Aktiv') +
          '</div><button class="red" onclick="removeKey(\\'' +
          encodeURIComponent(k.key) +
          '\\')">Sil</button></div>'
      )
      .join('');

    document.getElementById('wlBox').innerHTML = (stateData.whitelists || [])
      .map(
        (w) =>
          '<div class="item"><div><strong>' +
          w.discordUserId +
          '</strong> • <code>' +
          w.scriptId +
          '</code> • HWID: <code>' +
          (w.hwid || 'Sıfır') +
          '</code></div><div class="btns"><button class="ghost" onclick="resetUserHwid(\\'' +
          w.id +
          '\\')">Reset HWID</button><button class="red" onclick="removeWl(\\'' +
          w.id +
          '\\')">Sil</button></div></div>'
      )
      .join('');

    document.getElementById('blBox').innerHTML = (stateData.blacklist || [])
      .map(
        (b) =>
          '<div class="item"><div><strong>' +
          b.discordUserId +
          '</strong> ' +
          (b.scriptId ? '• <code>' + b.scriptId + '</code>' : '• Bütün skriptlər') +
          '</div><button class="red" onclick="removeBl(\\'' +
          b.id +
          '\\')">Sil</button></div>'
      )
      .join('');
  };

  window.removeScript = async (id) => {
    const r = await reqApi('/api/scripts/' + id, { method: 'DELETE' });
    const j = await r.json();
    notify(j.message || 'Yeniləndi');
    refreshUI();
  };
  window.removeKey = async (k) => {
    const r = await reqApi('/api/keys/' + k, { method: 'DELETE' });
    const j = await r.json();
    notify(j.message || 'Yeniləndi');
    refreshUI();
  };
  window.resetUserHwid = async (id) => {
    const r = await reqApi('/api/whitelist/' + id + '/reset-hwid', { method: 'POST' });
    const j = await r.json();
    notify(j.message || 'Yeniləndi');
    refreshUI();
  };
  window.removeWl = async (id) => {
    const r = await reqApi('/api/whitelist/' + id, { method: 'DELETE' });
    const j = await r.json();
    notify(j.message || 'Yeniləndi');
    refreshUI();
  };
  window.removeBl = async (id) => {
    const r = await reqApi('/api/blacklist/' + id, { method: 'DELETE' });
    const j = await r.json();
    notify(j.message || 'Yeniləndi');
    refreshUI();
  };

  document.getElementById('saveLinkBtn').addEventListener('click', async () => {
    const guildId = document.getElementById('guildIdInput').value.trim();
    const discordUserId = document.getElementById('discordUserIdInput').value.trim();
    const r = await reqApi('/api/workspace/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId, discordUserId }),
    });
    const j = await r.json();
    notify(j.message || 'Yadda saxlandı');
    refreshUI();
  });

  document.getElementById('saveDesignBtn').addEventListener('click', async () => {
    const payload = {
      embedColor: document.getElementById('cfgColor').value.trim(),
      title: document.getElementById('cfgTitle').value.trim(),
      description: document.getElementById('cfgDesc').value.trim(),
      redeemLabel: document.getElementById('cfgRedeem').value.trim(),
      getScriptLabel: document.getElementById('cfgScript').value.trim(),
      resetHwidLabel: document.getElementById('cfgHwid').value.trim(),
      statsLabel: document.getElementById('cfgStats').value.trim(),
      footerText: document.getElementById('cfgFooter').value.trim(),
      imageUrl: document.getElementById('cfgImage').value.trim(),
    };
    const r = await reqApi('/api/panel-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    notify(j.message || 'Panel dizaynı yeniləndi');
    refreshUI();
  });

  document.getElementById('addScriptBtn').addEventListener('click', async () => {
    const name = document.getElementById('scriptNameInput').value.trim();
    const code = document.getElementById('scriptCodeInput').value;
    const r = await reqApi('/api/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    const j = await r.json();
    if (j.ok) document.getElementById('scriptNameInput').value = '';
    notify(j.message || 'Skript yaradıldı');
    refreshUI();
  });

  document.getElementById('genKeyBtn').addEventListener('click', async () => {
    const scriptId = document.getElementById('scriptSelect').value;
    const duration = document.getElementById('keyDurInput').value.trim();
    const amount = Number(document.getElementById('keyAmtInput').value || 1);
    const r = await reqApi('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptId, duration, amount }),
    });
    const j = await r.json();
    notify(j.message || 'Key yaradıldı');
    refreshUI();
  });

  document.getElementById('addWlBtn').addEventListener('click', async () => {
    const discordUserId = document.getElementById('wlUserInput').value.trim();
    const scriptId = document.getElementById('scriptSelect').value;
    const duration = document.getElementById('wlDurInput').value.trim();
    const r = await reqApi('/api/whitelist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordUserId, scriptId, duration }),
    });
    const j = await r.json();
    if (j.ok) document.getElementById('wlUserInput').value = '';
    notify(j.message || 'Whitelist yeniləndi');
    refreshUI();
  });

  document.getElementById('addBlBtn').addEventListener('click', async () => {
    const discordUserId = document.getElementById('blUserInput').value.trim();
    const r = await reqApi('/api/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordUserId }),
    });
    const j = await r.json();
    if (j.ok) document.getElementById('blUserInput').value = '';
    notify(j.message || 'Blacklist yeniləndi');
    refreshUI();
  });

  document.getElementById('sendPanelBtn').addEventListener('click', async () => {
    const channelId = document.getElementById('channelInput').value.trim();
    const scriptId = document.getElementById('scriptSelect').value;
    const r = await reqApi('/api/send-panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, scriptId }),
    });
    const j = await r.json();
    notify(j.message || 'Panel göndərildi');
    refreshUI();
  });

  refreshUI();
  setInterval(refreshUI, 8000);
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
    if (!client.isReady() && !isConnectingNow) {
      ensureBotOnline().catch(() => {});
    }
  }, 4 * 60 * 1000);
});
