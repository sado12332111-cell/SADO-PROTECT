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
  embedColor: '#00FF00',
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
    message: 'Panel dizaynı yadda saxlandı və aktiv panellər yeniləndi!',
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
<title>SADO PROTECT • Control Dashboard</title>
<style>
  :root {
    --bg: #050814;
    --card: #0b1022;
    --card-2: #101730;
    --line: rgba(139, 92, 246, 0.2);
    --text: #f8fafc;
    --muted: #94a3b8;
    --green: #10b981;
    --blue: #3b82f6;
    --red: #ef4444;
    --purple: #8b5cf6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
  body {
    background:
      radial-gradient(circle at 12% 10%, rgba(139, 92, 246, 0.22), transparent 36%),
      radial-gradient(circle at 88% 18%, rgba(16, 185, 129, 0.16), transparent 38%),
      radial-gradient(circle at 50% 90%, rgba(59, 130, 246, 0.14), transparent 45%),
      var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 16px;
  }
  .shell { max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
  .topbar {
    position: sticky;
    top: 10px;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: rgba(11, 16, 34, 0.88);
    backdrop-filter: blur(14px);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 12px 14px;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.45);
  }
  .brand-left { display: flex; align-items: center; gap: 11px; }
  .menu-btn {
    width: 44px;
    height: 44px;
    border-radius: 13px;
    border: 1px solid rgba(139, 92, 246, 0.4);
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.28), rgba(59, 130, 246, 0.18));
    color: #fff;
    font-size: 19px;
    font-weight: 800;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .brand-title { font-size: 17px; font-weight: 900; letter-spacing: 0.3px; color: #7dd3fc; }
  .brand-sub { font-size: 12px; color: var(--muted); }
  .bot-badge {
    padding: 8px 13px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 800;
    background: rgba(16, 185, 129, 0.14);
    border: 1px solid rgba(16, 185, 129, 0.45);
    color: #34d399;
    white-space: nowrap;
  }
  .bot-badge.off {
    background: rgba(239, 68, 68, 0.14);
    border-color: rgba(239, 68, 68, 0.45);
    color: #fca5a5;
  }
  .drawer {
    display: none;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 12px;
  }
  .drawer.open { display: grid; }
  .nav-pill {
    padding: 10px 12px;
    border-radius: 11px;
    border: 1px solid var(--line);
    background: var(--card-2);
    color: var(--text);
    font-size: 13px;
    font-weight: 700;
    text-align: center;
    cursor: pointer;
  }
  .kpi-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .kpi {
    position: relative;
    overflow: hidden;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 18px 16px;
  }
  .kpi::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(90deg, #38bdf8, #a855f7, #10b981);
  }
  .kpi span { font-size: 13px; color: var(--muted); display: block; }
  .kpi strong { font-size: 28px; font-weight: 900; margin-top: 8px; display: block; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 18px 16px;
    display: grid;
    gap: 14px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
  }
  .card h2 { font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
  .hint { font-size: 13px; color: var(--muted); line-height: 1.5; }
  label.field { display: grid; gap: 7px; font-size: 13px; font-weight: 700; color: #e2e8f0; }
  input[type="text"], input[type="number"], textarea, select {
    width: 100%;
    background: var(--card-2);
    border: 1px solid rgba(148, 163, 184, 0.22);
    color: #fff;
    border-radius: 12px;
    padding: 12px 13px;
    font-size: 14px;
    outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--purple); }
  textarea { min-height: 120px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .check-row { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #cbd5e1; }
  .check-row input { width: 18px; height: 18px; accent-color: var(--purple); }
  .btn {
    width: 100%;
    border: none;
    border-radius: 13px;
    padding: 13px 16px;
    font-size: 14px;
    font-weight: 800;
    color: #fff;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .btn-green { background: linear-gradient(135deg, #10b981, #059669); color: #042f2e; }
  .btn-purple { background: linear-gradient(135deg, #8b5cf6, #6366f1); color: #fff; }
  .btn-blue { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
  .btn-red { background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff; }
  .btn-sm { width: auto; padding: 8px 13px; font-size: 12px; border-radius: 10px; }
  .script-card {
    background: var(--card-2);
    border: 1px solid var(--line);
    border-radius: 15px;
    padding: 14px;
    display: grid;
    gap: 10px;
  }
  .script-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .script-actions { display: flex; gap: 8px; }
  .loader-box {
    background: #060914;
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 12px;
    padding: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #e2e8f0;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .color-pair { display: grid; grid-template-columns: 64px 1fr; gap: 10px; align-items: center; }
  input[type="color"] { width: 64px; height: 46px; padding: 3px; border-radius: 11px; border: 1px solid var(--line); background: var(--card-2); cursor: pointer; }
  .style-pair { display: grid; grid-template-columns: 1.3fr 1fr; gap: 10px; }
  .list-stack { display: grid; gap: 8px; }
  .row-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    background: var(--card-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font-size: 13px;
  }
  code { background: rgba(15, 23, 42, 0.9); padding: 2px 6px; border-radius: 6px; color: #93c5fd; }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    background: #10b981;
    color: #042f2e;
    font-weight: 900;
    padding: 11px 18px;
    border-radius: 12px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
    z-index: 100;
    max-width: 92vw;
    text-align: center;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div class="brand-left">
      <button id="drawerToggle" class="menu-btn" aria-label="Menyu">☰</button>
      <div>
        <div class="brand-title">SADO PROTECT</div>
        <div class="brand-sub">Control Dashboard</div>
      </div>
    </div>
    <div id="botBadge" class="bot-badge">Bot: Online ✅</div>
  </div>

  <div id="navDrawer" class="drawer">
    <button class="nav-pill" onclick="jumpTo('secOverview')">📊 İcmal</button>
    <button class="nav-pill" onclick="jumpTo('secScripts')">📜 Skriptlər</button>
    <button class="nav-pill" onclick="jumpTo('secPanelSend')">📤 Panel Göndər</button>
    <button class="nav-pill" onclick="jumpTo('secObfuscator')">🛡️ Obfuscator</button>
    <button class="nav-pill" onclick="jumpTo('secKeys')">🔑 Key & Whitelist</button>
    <button class="nav-pill" onclick="jumpTo('secServer')">🤖 Sunucu Bağla</button>
    <button class="nav-pill" onclick="jumpTo('secDesign')">🎨 Panel Dizaynı</button>
  </div>

  <div id="secOverview" class="kpi-grid">
    <div class="kpi"><span>Skriptlər</span><strong id="kpiScripts">0</strong></div>
    <div class="kpi"><span>Yaradılmış Key-lər</span><strong id="kpiKeys">0</strong></div>
    <div class="kpi"><span>Aktiv Whitelist</span><strong id="kpiWl">0</strong></div>
    <div class="kpi"><span>Qoşulu Sunucu</span><strong id="kpiGuild" style="font-size:20px;">Seçilməyib</strong></div>
  </div>

  <div class="card">
    <h2>🕒 Son Key-lər (Yaradan & İşlədən)</h2>
    <div id="recentKeysBox" class="hint">Hələ key yaradılmayıb.</div>
  </div>

  <div id="secScripts" class="card">
    <h2>➕ Yeni Skript Yarat</h2>
    <label class="field">Skript Adı
      <input id="newScriptName" type="text" placeholder="Məs: SADO HUB" />
    </label>
    <label class="field">Lua / TXT Dosya Seç (istəyə bağlı)
      <div>
        <input id="scriptFileInput" type="file" accept=".lua,.txt" style="display:none;" />
        <button type="button" id="pickFileBtn" class="btn-sm" style="background:#e2e8f0;color:#0f172a;border:none;font-weight:800;cursor:pointer;">Fayl seçin</button>
        <span id="pickedFileName" class="hint" style="margin-left:8px;">Heç bir fayl seçilməyib</span>
      </div>
    </label>
    <label class="field">Skript Kodu
      <textarea id="newScriptCode" placeholder="-- Lua skript kodunu bura yazın və ya dosya seçin"></textarea>
    </label>
    <label class="check-row">
      <input id="obfuscateOnSave" type="checkbox" />
      <span>Skripti yadda saxlayanda avtomatik Lua Obfuscate et (kodu şifrələ)</span>
    </label>
    <button id="saveScriptBtn" class="btn btn-green">💾 Skripti Yadda Saxla</button>

    <h2 style="margin-top:6px;">📂 Mövcud Skriptlər</h2>
    <div id="existingScriptsBox" class="list-stack"></div>
  </div>

  <div id="secPanelSend" class="card">
    <h2>📤 Discord Kanalına Panel Göndər</h2>
    <label class="field">Discord Kanal ID
      <input id="panelChannelId" type="text" placeholder="Məs: 123456789012345678" />
    </label>
    <label class="field">Panel Skripti Seç
      <select id="panelScriptSelect"></select>
    </label>
    <button id="sendPanelBtn" class="btn btn-purple">🚀 Paneli Kanala Göndər</button>
  </div>

  <div id="secObfuscator" class="card">
    <h2>🛡️ Lua Obfuscator</h2>
    <p class="hint">Lua kodunuzu şifrələyin, nəticəni kopyalayın və ya birbaşa skript kimi yadda saxlayın.</p>
    <label class="field">Şifrələmə Səviyyəsi
      <select id="obfLevel">
        <option value="level1">Səviyyə 1 — String Encode + Junk Guard</option>
        <option value="level2">Səviyyə 2 — Bytecode Table + Anti-Tamper</option>
        <option value="level3" selected>Səviyyə 3 — Ultra Guard VM + Anti-Dump</option>
      </select>
    </label>
    <label class="field">Orijinal Lua Kodu
      <textarea id="obfInput" placeholder="print('Hello SADO PROTECT')"></textarea>
    </label>
    <button id="runObfBtn" class="btn btn-purple">⚡ Kodu Şifrələ (Obfuscate)</button>
    <label class="field">Şifrələnmiş Nəticə
      <textarea id="obfOutput" placeholder="Şifrələnmiş kod burada görünəcək..."></textarea>
    </label>
    <button id="copyObfBtn" class="btn btn-blue">📋 Şifrəli Kodu Kopyala</button>
    <button id="saveObfAsScriptBtn" class="btn btn-green">💾 Skript Kimi Yadda Saxla</button>
    <label class="field">Yadda Saxlanacaq Skript Adı (istəyə bağlı)
      <input id="obfSaveName" type="text" placeholder="Məs: SADO Protected" />
    </label>
  </div>

  <div id="secKeys" class="card">
    <h2>🔑 Yeni Key Yarat</h2>
    <label class="field">Skript Seç
      <select id="keyScriptSelect"></select>
    </label>
    <label class="field">Müddət (0 = Lifetime, məs: 1d, 7d, 30d, 1y)
      <input id="keyDuration" type="text" value="0" />
    </label>
    <label class="field">Say (1 - 100)
      <input id="keyAmount" type="number" min="1" max="100" value="1" />
    </label>
    <button id="createKeyBtn" class="btn btn-purple">✨ Key Yarat</button>
    <div id="keyListBox" class="hint">Hələ key yoxdur.</div>

    <h2 style="margin-top:8px;">✅ Whitelist Əlavə Et</h2>
    <label class="field">Discord User ID
      <input id="wlUserId" type="text" placeholder="Məs: 123456789012345678" />
    </label>
    <label class="field">Skript Seç
      <select id="wlScriptSelect"></select>
    </label>
    <label class="field">Müddət (0 = Lifetime, məs: 7d, 30d)
      <input id="wlDuration" type="text" value="0" />
    </label>
    <button id="addWlBtn" class="btn btn-green">➕ Whitelist-ə Əlavə Et</button>
    <div id="wlListBox" class="hint">Aktiv whitelist yoxdur.</div>

    <h2 style="margin-top:8px;">🚫 Blacklist İdarəetməsi</h2>
    <label class="field">Discord User ID
      <input id="blUserId" type="text" placeholder="Məs: 123456789012345678" />
    </label>
    <button id="addBlBtn" class="btn btn-red">⛔ Blacklist-ə Sal</button>
    <div id="blListBox" class="hint">Blacklist boşdur.</div>
  </div>

  <div id="secServer" class="card">
    <h2>🤖 SADO PROTECT Botunu Sunucuna Əlavə Et (Join Discord)</h2>
    <p class="hint">
      1. Aşağıdakı düymə ilə <b>SADO PROTECT</b> botunu öz Discord sunucunuza əlavə edin.<br />
      2. Bot sunucuya girdikdən sonra aşağıdan öz sunucunuzu seçin (və ya Sunucu ID-ni yazın) — bu telefon/cihaz üçün müstəqil idarəetmə paneli bağlanacaq.
    </p>
    <button id="inviteBotBtn" class="btn btn-green">➕ SADO PROTECT Botunu Sunucuna Əlavə Et</button>
    <label class="field">Botun Olduğu Sunuculardan Öz Sunucunu Seç
      <select id="guildPickerSelect">
        <option value="">-- Sunucu seçin və ya aşağıya ID yazın</option>
      </select>
    </label>
    <label class="field">Və ya Discord Sunucu ID (Server ID)
      <input id="serverGuildIdInput" type="text" placeholder="Məs: 1559499280732131348" />
    </label>
    <label class="field">Discord User ID (istəyə bağlı)
      <input id="serverUserIdInput" type="text" placeholder="Məs: 123456789012345678" />
    </label>
    <button id="linkServerBtn" class="btn btn-purple">✅ Sunucunu İdarəetmə Panelinə Bağla</button>
  </div>

  <div id="secDesign" class="card">
    <h2>🎨 Panel Buton və Embed Dizaynı</h2>
    <label class="field">Embed Rəngi (HEX & Rəng Seçici)
      <div class="color-pair">
        <input id="designColorPicker" type="color" value="#00ff00" />
        <input id="designColorHex" type="text" value="#00FF00" />
      </div>
    </label>
    <label class="field">Panel Başlığı
      <input id="designTitle" type="text" value="SADO PROTECT • Script Panel" />
    </label>
    <label class="field">Panel Açıqlaması
      <input id="designDesc" type="text" value="Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin." />
    </label>
    <label class="field">Redeem Key Düymə Mətni və Rəngi
      <div class="style-pair">
        <input id="designRedeemText" type="text" value="Redeem Key" />
        <select id="designRedeemStyle">
          <option value="Success" selected>🟢 Yaşıl</option>
          <option value="Primary">🔵 Mavi</option>
          <option value="Danger">🔴 Qırmızı</option>
          <option value="Secondary">⚪ Boz</option>
        </select>
      </div>
    </label>
    <label class="field">Get Script Düymə Mətni və Rəngi
      <div class="style-pair">
        <input id="designScriptText" type="text" value="Get Script" />
        <select id="designScriptStyle">
          <option value="Primary" selected>🔵 Mavi</option>
          <option value="Success">🟢 Yaşıl</option>
          <option value="Danger">🔴 Qırmızı</option>
          <option value="Secondary">⚪ Boz</option>
        </select>
      </div>
    </label>
    <label class="field">Reset HWID Düymə Mətni və Rəngi
      <div class="style-pair">
        <input id="designHwidText" type="text" value="Reset HWID" />
        <select id="designHwidStyle">
          <option value="Danger" selected>🔴 Qırmızı</option>
          <option value="Success">🟢 Yaşıl</option>
          <option value="Primary">🔵 Mavi</option>
          <option value="Secondary">⚪ Boz</option>
        </select>
      </div>
    </label>
    <label class="field">Stats Düymə Mətni və Rəngi
      <div class="style-pair">
        <input id="designStatsText" type="text" value="Get Stats" />
        <select id="designStatsStyle">
          <option value="Secondary" selected>⚪ Boz</option>
          <option value="Success">🟢 Yaşıl</option>
          <option value="Primary">🔵 Mavi</option>
          <option value="Danger">🔴 Qırmızı</option>
        </select>
      </div>
    </label>
    <button id="saveDesignBtn" class="btn btn-purple">💾 Panel Dizaynını Yadda Saxla</button>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
  const getDeviceWorkspace = () => {
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

  const DEVICE_WS = getDeviceWorkspace();

  const apiFetch = (url, opts = {}) => {
    const headers = Object.assign({ 'X-Client-Workspace': DEVICE_WS }, opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers }));
  };

  const showToast = (msg) => {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  };

  const jumpTo = (id) => {
    document.getElementById('navDrawer').classList.remove('open');
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  document.getElementById('drawerToggle').addEventListener('click', () => {
    document.getElementById('navDrawer').classList.toggle('open');
  });

  const obfuscateLuaSource = (src, level) => {
    const bytes = [];
    for (let i = 0; i < src.length; i++) {
      bytes.push((src.charCodeAt(i) + (level === 'level3' ? 7 : level === 'level2' ? 3 : 1)) % 256);
    }
    const shift = level === 'level3' ? 7 : level === 'level2' ? 3 : 1;
    return [
      `-- SADO PROTECT Obfuscated (${level})`,
      `local _b = {${bytes.join(',')}}`,
      `local _out = {}`,
      `for _i = 1, #_b do _out[_i] = string.char((_b[_i] - ${shift}) % 256) end`,
      `local _fn = loadstring(table.concat(_out))`,
      `if type(_fn) == "function" then return _fn() end`,
    ].join('\n');
  };

  document.getElementById('pickFileBtn').addEventListener('click', () => {
    document.getElementById('scriptFileInput').click();
  });

  document.getElementById('scriptFileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    document.getElementById('pickedFileName').textContent = f.name;
    const text = await f.text();
    document.getElementById('newScriptCode').value = text;
    if (!document.getElementById('newScriptName').value.trim()) {
      document.getElementById('newScriptName').value = f.name.replace(/\.(lua|txt)$/i, '');
    }
  });

  document.getElementById('runObfBtn').addEventListener('click', () => {
    const raw = document.getElementById('obfInput').value || "print('Hello SADO PROTECT')";
    const lvl = document.getElementById('obfLevel').value;
    document.getElementById('obfOutput').value = obfuscateLuaSource(raw, lvl);
    showToast('Lua kodu şifrələndi!');
  });

  document.getElementById('copyObfBtn').addEventListener('click', async () => {
    const val = document.getElementById('obfOutput').value;
    if (!val) return showToast('Əvvəl kodu şifrələyin.');
    try { await navigator.clipboard.writeText(val); } catch (_e) {}
    showToast('Şifrəli kod kopyalandı!');
  });

  document.getElementById('saveObfAsScriptBtn').addEventListener('click', async () => {
    const code = document.getElementById('obfOutput').value.trim();
    if (!code) return showToast('Şifrələnmiş nəticə boşdur.');
    const name = document.getElementById('obfSaveName').value.trim() || 'SADO Protected';
    const r = await apiFetch('/api/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    const j = await r.json();
    showToast(j.message || 'Skript kimi yadda saxlandı!');
    refreshAll();
  });

  const colorPicker = document.getElementById('designColorPicker');
  const colorHex = document.getElementById('designColorHex');
  colorPicker.addEventListener('input', () => {
    colorHex.value = colorPicker.value.toUpperCase();
  });
  colorHex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value.trim())) {
      colorPicker.value = colorHex.value.trim();
    }
  });

  let initializedForm = false;

  const refreshAll = async () => {
    const stRes = await apiFetch('/api/status');
    const st = await stRes.json();
    const badge = document.getElementById('botBadge');
    if (st.botReady) {
      badge.textContent = 'Bot: Online ✅';
      badge.className = 'bot-badge';
    } else {
      badge.textContent = 'Bot: Offline ⚠️';
      badge.className = 'bot-badge off';
    }

    const sRes = await apiFetch('/api/state');
    const data = await sRes.json();
    if (!data.ok) return;

    document.getElementById('kpiScripts').textContent = String((data.scripts || []).length);
    document.getElementById('kpiKeys').textContent = String((data.keys || []).length);
    document.getElementById('kpiWl').textContent = String((data.whitelists || []).length);
    document.getElementById('kpiGuild').textContent = data.guildId ? data.guildId : 'Seçilməyib';

    if (!initializedForm) {
      if (data.guildId) document.getElementById('serverGuildIdInput').value = data.guildId;
      if (data.discordUserId) document.getElementById('serverUserIdInput').value = data.discordUserId;
      const cfg = data.panelConfig || {};
      if (cfg.embedColor) {
        colorHex.value = cfg.embedColor;
        if (/^#[0-9a-fA-F]{6}$/.test(cfg.embedColor)) colorPicker.value = cfg.embedColor;
      }
      if (cfg.title) document.getElementById('designTitle').value = cfg.title;
      if (cfg.description) document.getElementById('designDesc').value = cfg.description;
      if (cfg.redeemLabel) document.getElementById('designRedeemText').value = cfg.redeemLabel;
      if (cfg.redeemStyle) document.getElementById('designRedeemStyle').value = cfg.redeemStyle;
      if (cfg.getScriptLabel) document.getElementById('designScriptText').value = cfg.getScriptLabel;
      if (cfg.getScriptStyle) document.getElementById('designScriptStyle').value = cfg.getScriptStyle;
      if (cfg.resetHwidLabel) document.getElementById('designHwidText').value = cfg.resetHwidLabel;
      if (cfg.resetHwidStyle) document.getElementById('designHwidStyle').value = cfg.resetHwidStyle;
      if (cfg.statsLabel) document.getElementById('designStatsText').value = cfg.statsLabel;
      if (cfg.statsStyle) document.getElementById('designStatsStyle').value = cfg.statsStyle;
      initializedForm = true;
    }

    const scripts = data.scripts || [];
    const optionsHtml = scripts.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
    for (const selId of ['panelScriptSelect', 'keyScriptSelect', 'wlScriptSelect']) {
      const el = document.getElementById(selId);
      const prev = el.value;
      el.innerHTML = optionsHtml;
      if (prev) el.value = prev;
    }

    const origin = window.location.origin;
    document.getElementById('existingScriptsBox').innerHTML = scripts
      .map((s) => {
        const loaderUrl = `${origin}/loader/${encodeURIComponent(s.loaderToken || s.id)}?ws=${encodeURIComponent(DEVICE_WS)}`;
        const snippet = `script_key = "YOUR_KEY"\nloadstring(game:HttpGet("${loaderUrl}"))()`;
        return `
          <div class="script-card">
            <div class="script-head">
              <div><strong>📜 ${s.name}</strong> <span class="hint">(${s.id}.lua)</span></div>
              <div class="script-actions">
                <button class="btn btn-blue btn-sm" onclick="copySnippet('${s.id}')">✏️ Kopyala</button>
                <button class="btn btn-red btn-sm" onclick="deleteScriptItem('${s.id}')">🗑️ Sil</button>
              </div>
            </div>
            <div class="loader-box" id="snip_${s.id}">${snippet}</div>
          </div>
        `;
      })
      .join('');

    const keys = data.keys || [];
    document.getElementById('recentKeysBox').innerHTML = keys.length
      ? keys.slice(0, 6).map((k) => `<div>• <code>${k.key}</code> — <b>${k.scriptName}</b> (${k.used ? 'İşlədilib: ' + k.usedByDiscordId : 'Aktiv'})</div>`).join('')
      : 'Hələ key yaradılmayıb.';

    document.getElementById('keyListBox').innerHTML = keys.length
      ? keys.slice(0, 15).map((k) => `<div class="row-item"><span><code>${k.key}</code> • ${k.scriptName}</span><button class="btn btn-red btn-sm" onclick="deleteKeyItem('${encodeURIComponent(k.key)}')">Sil</button></div>`).join('')
      : 'Hələ key yoxdur.';

    const wls = data.whitelists || [];
    document.getElementById('wlListBox').innerHTML = wls.length
      ? wls.map((w) => `<div class="row-item"><span><b>${w.discordUserId}</b> • <code>${w.scriptId}</code> • HWID: <code>${w.hwid || 'Sıfır'}</code></span><div style="display:flex;gap:6px;"><button class="btn btn-blue btn-sm" onclick="resetWlHwid('${w.id}')">Reset HWID</button><button class="btn btn-red btn-sm" onclick="deleteWlItem('${w.id}')">Sil</button></div></div>`).join('')
      : 'Aktiv whitelist yoxdur.';

    const bls = data.blacklist || [];
    document.getElementById('blListBox').innerHTML = bls.length
      ? bls.map((b) => `<div class="row-item"><span><b>${b.discordUserId}</b></span><button class="btn btn-red btn-sm" onclick="deleteBlItem('${b.id}')">Sil</button></div>`).join('')
      : 'Blacklist boşdur.';
  };

  window.copySnippet = async (id) => {
    const el = document.getElementById('snip_' + id);
    if (!el) return;
    try { await navigator.clipboard.writeText(el.textContent); } catch (_e) {}
    showToast('Loader kodu kopyalandı!');
  };
  window.deleteScriptItem = async (id) => {
    const r = await apiFetch('/api/scripts/' + id, { method: 'DELETE' });
    const j = await r.json();
    showToast(j.message || 'Silindi');
    refreshAll();
  };
  window.deleteKeyItem = async (encKey) => {
    const r = await apiFetch('/api/keys/' + encKey, { method: 'DELETE' });
    const j = await r.json();
    showToast(j.message || 'Silindi');
    refreshAll();
  };
  window.resetWlHwid = async (id) => {
    const r = await apiFetch('/api/whitelist/' + id + '/reset-hwid', { method: 'POST' });
    const j = await r.json();
    showToast(j.message || 'HWID sıfırlandı');
    refreshAll();
  };
  window.deleteWlItem = async (id) => {
    const r = await apiFetch('/api/whitelist/' + id, { method: 'DELETE' });
    const j = await r.json();
    showToast(j.message || 'Silindi');
    refreshAll();
  };
  window.deleteBlItem = async (id) => {
    const r = await apiFetch('/api/blacklist/' + id, { method: 'DELETE' });
    const j = await r.json();
    showToast(j.message || 'Silindi');
    refreshAll();
  };

  document.getElementById('saveScriptBtn').addEventListener('click', async () => {
    const name = document.getElementById('newScriptName').value.trim();
    let code = document.getElementById('newScriptCode').value;
    if (!name) return showToast('Skript adı yazın.');
    if (document.getElementById('obfuscateOnSave').checked) {
      code = obfuscateLuaSource(code, document.getElementById('obfLevel').value);
    }
    const r = await apiFetch('/api/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    const j = await r.json();
    if (j.ok) document.getElementById('newScriptName').value = '';
    showToast(j.message || 'Skript yadda saxlandı!');
    refreshAll();
  });

  document.getElementById('sendPanelBtn').addEventListener('click', async () => {
    const channelId = document.getElementById('panelChannelId').value.trim();
    const scriptId = document.getElementById('panelScriptSelect').value;
    const r = await apiFetch('/api/send-panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, scriptId }),
    });
    const j = await r.json();
    showToast(j.message || 'Panel göndərildi');
    refreshAll();
  });

  document.getElementById('createKeyBtn').addEventListener('click', async () => {
    const scriptId = document.getElementById('keyScriptSelect').value;
    const duration = document.getElementById('keyDuration').value.trim() || '0';
    const amount = Number(document.getElementById('keyAmount').value || 1);
    const r = await apiFetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptId, duration, amount }),
    });
    const j = await r.json();
    showToast(j.message || 'Key yaradıldı');
    refreshAll();
  });

  document.getElementById('addWlBtn').addEventListener('click', async () => {
    const discordUserId = document.getElementById('wlUserId').value.trim();
    const scriptId = document.getElementById('wlScriptSelect').value;
    const duration = document.getElementById('wlDuration').value.trim() || '0';
    const r = await apiFetch('/api/whitelist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordUserId, scriptId, duration }),
    });
    const j = await r.json();
    if (j.ok) document.getElementById('wlUserId').value = '';
    showToast(j.message || 'Whitelist yeniləndi');
    refreshAll();
  });

  document.getElementById('addBlBtn').addEventListener('click', async () => {
    const discordUserId = document.getElementById('blUserId').value.trim();
    const r = await apiFetch('/api/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordUserId }),
    });
    const j = await r.json();
    if (j.ok) document.getElementById('blUserId').value = '';
    showToast(j.message || 'Blacklist yeniləndi');
    refreshAll();
  });

  document.getElementById('inviteBotBtn').addEventListener('click', () => {
    const url = 'https://discord.com/api/oauth2/authorize?client_id=1562080654282199121&permissions=8&scope=bot%20applications.commands';
    window.open(url, '_blank');
  });

  document.getElementById('guildPickerSelect').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('serverGuildIdInput').value = e.target.value;
  });

  document.getElementById('linkServerBtn').addEventListener('click', async () => {
    const guildId = document.getElementById('serverGuildIdInput').value.trim();
    const discordUserId = document.getElementById('serverUserIdInput').value.trim();
    const r = await apiFetch('/api/workspace/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId, discordUserId }),
    });
    const j = await r.json();
    showToast(j.message || 'Sunucu bağlandı!');
    refreshAll();
  });

  document.getElementById('saveDesignBtn').addEventListener('click', async () => {
    const payload = {
      embedColor: document.getElementById('designColorHex').value.trim(),
      title: document.getElementById('designTitle').value.trim(),
      description: document.getElementById('designDesc').value.trim(),
      redeemLabel: document.getElementById('designRedeemText').value.trim(),
      redeemStyle: document.getElementById('designRedeemStyle').value,
      getScriptLabel: document.getElementById('designScriptText').value.trim(),
      getScriptStyle: document.getElementById('designScriptStyle').value,
      resetHwidLabel: document.getElementById('designHwidText').value.trim(),
      resetHwidStyle: document.getElementById('designHwidStyle').value,
      statsLabel: document.getElementById('designStatsText').value.trim(),
      statsStyle: document.getElementById('designStatsStyle').value,
    };
    const r = await apiFetch('/api/panel-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    showToast(j.message || 'Panel dizaynı yadda saxlandı və aktiv panellər yeniləndi!');
    refreshAll();
  });

  refreshAll();
  setInterval(refreshAll, 8000);
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
