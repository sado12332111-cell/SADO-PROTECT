const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} = require('discord.js');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const BOT_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '1562080654282199121').trim();
const BOT_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').trim();
const TOKEN_PARTS = [
  'MTU2MjA4MDY1NDI4MjE5OTEyMQ',
  'G6ZjHR',
  'Mz_G-NEoHGQJsPlxmVPN_wAmDNUkS_gTDIKSmU'
];
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || process.env.SITE_BASE_URL || 'https://sadoprotect.onrender.com').replace(/\/+$/, '');
const BOT_INVITE_URL = `https://discord.com/oauth2/authorize?client_id=${BOT_CLIENT_ID}&permissions=2147600384&integration_type=0&scope=applications.commands+bot`;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getFallbackBotToken() {
  return TOKEN_PARTS.join('.');
}

function resolveBotToken(storedToken) {
  const envToken = (process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  const savedToken = String(storedToken || '').trim();
  return envToken || savedToken || getFallbackBotToken();
}

function defaultState() {
  return {
    botToken: resolveBotToken(''),
    activeGuildId: '',
    activeGuildName: '',
    activeDiscordUserId: '',
    oauthUsers: {},
    workspaces: {},
    scripts: [],
    keys: [],
    whitelist: [],
    blacklist: [],
    panels: [],
    panelConfig: {
      embedColor: '#5865F2',
      title: 'SADO PROTECT • Script Panel',
      description: 'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirə, skripti ala və HWID sıfırlaya bilərsiniz.',
      redeemLabel: '🔑 Redeem Key',
      getScriptLabel: '📜 Get Script',
      resetHwidLabel: '🔄 Reset HWID',
      statsLabel: '📊 Stats'
    }
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        botToken: resolveBotToken(parsed.botToken),
        oauthUsers: parsed.oauthUsers || {},
        workspaces: parsed.workspaces || {},
        scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
        blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [],
        panels: Array.isArray(parsed.panels) ? parsed.panels : [],
        panelConfig: { ...base.panelConfig, ...(parsed.panelConfig || {}) }
      };
    }
  } catch (err) {
    console.error('State load error:', err);
  }
  return defaultState();
}

let state = loadState();

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('State save error:', err);
  }
}

function randomId(prefix, bytes = 6) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

function generateLicenseKey() {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SADO-${part()}-${part()}-${part()}`;
}

function parseDurationMs(input) {
  if (!input || String(input).trim() === '0') return 0;
  const m = String(input).trim().match(/^(\d+)(s|m|h|d|y)$/i);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const val = Number(m[1]);
  const unit = m[2].toLowerCase();
  const map = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000
  };
  return val * (map[unit] || 86400000);
}

// ==================== LUA OBFUSCATOR ====================
function obfuscateLuaCode(source, level = 'high') {
  const clean = String(source || '');
  if (!clean.trim()) return '-- empty script';

  const key = crypto.randomInt(23, 211);
  const buf = Buffer.from(clean, 'utf8');
  const encoded = [];
  for (let i = 0; i < buf.length; i++) {
    encoded.push((buf[i] ^ ((key + (i % 97)) & 255)) + 17);
  }

  const vArr = '_0x' + crypto.randomBytes(3).toString('hex');
  const vOut = '_0x' + crypto.randomBytes(3).toString('hex');
  const vIdx = '_0x' + crypto.randomBytes(3).toString('hex');
  const vKey = '_0x' + crypto.randomBytes(3).toString('hex');
  const vFn = '_0x' + crypto.randomBytes(3).toString('hex');
  const vByte = '_0x' + crypto.randomBytes(3).toString('hex');
  const vChar = '_0x' + crypto.randomBytes(3).toString('hex');
  const vConcat = '_0x' + crypto.randomBytes(3).toString('hex');
  const vLoad = '_0x' + crypto.randomBytes(3).toString('hex');

  const header = '--[[ Protected by SADO PROTECT Obfuscator ]]\n';

  if (level === 'standard') {
    const simpleBytes = Array.from(buf).join(',');
    return (
      header +
      `local ${vArr}={${simpleBytes}}\n` +
      `local ${vOut}={}\n` +
      `for ${vIdx}=1,#${vArr} do ${vOut}[${vIdx}]=string.char(${vArr}[${vIdx}]) end\n` +
      `local ${vFn}=(loadstring or load)(table.concat(${vOut}))\n` +
      `if ${vFn} then return ${vFn}() end\n`
    );
  }

  const junk1 = '_0x' + crypto.randomBytes(3).toString('hex');
  const junk2 = '_0x' + crypto.randomBytes(3).toString('hex');

  return (
    header +
    `local ${junk1}=(function(a,b) return ((a*7)+(b*3))%19 end)(11,29)\n` +
    `local ${vChar}=string.char\n` +
    `local ${vConcat}=table.concat\n` +
    `local ${vLoad}=(loadstring or load)\n` +
    `local ${vKey}=${key}\n` +
    `local ${vArr}={${encoded.join(',')}}\n` +
    `local ${vOut}={}\n` +
    `for ${vIdx}=1,#${vArr} do\n` +
    `  local ${vByte}=(${vArr}[${vIdx}]-17)\n` +
    `  local ${junk2}=(${vKey}+((${vIdx}-1)%97))%256\n` +
    `  local _r,_p=0,1\n` +
    `  local _a,_b=${vByte},${junk2}\n` +
    `  while _a>0 or _b>0 do\n` +
    `    local _ra,_rb=_a%2,_b%2\n` +
    `    if _ra~=_rb then _r=_r+_p end\n` +
    `    _a=math.floor(_a/2)\n` +
    `    _b=math.floor(_b/2)\n` +
    `    _p=_p*2\n` +
    `  end\n` +
    `  ${vOut}[${vIdx}]=${vChar}(_r)\n` +
    `end\n` +
    `local ${vFn}=${vLoad}(${vConcat}(${vOut}))\n` +
    `if ${vFn} then return ${vFn}() end\n`
  );
}

// ==================== DISCORD BOT SETUP ====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let botStatus = {
  online: false,
  tag: '',
  guilds: []
};

function syncBotGuildsCache() {
  if (client && client.guilds && client.guilds.cache) {
    botStatus.guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  }
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('SADO PROTECT idarəetmə panelini kanala göndər')
      .addStringOption(opt =>
        opt
          .setName('script')
          .setDescription('Panelin bağlı olacağı skript')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('title').setDescription('Panel başlığı').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('genkey')
      .setDescription('Skript üçün yeni key yarat')
      .addStringOption(opt =>
        opt
          .setName('script')
          .setDescription('Skript seçin')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('duration').setDescription('Müddət (məs: 1d, 7d, 30d, 0=ömürlük)').setRequired(false)
      )
      .addIntegerOption(opt =>
        opt.setName('amount').setDescription('Key sayı (1-25)').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('İstifadəçiyə birbaşa whitelist ver')
      .addUserOption(opt =>
        opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
      )
      .addStringOption(opt =>
        opt
          .setName('script')
          .setDescription('Skript seçin')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('duration').setDescription('Müddət (0 = ömürlük)').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('unwhitelist')
      .setDescription('İstifadəçini whitelist-dən çıxar')
      .addUserOption(opt =>
        opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
      )
      .addStringOption(opt =>
        opt
          .setName('script')
          .setDescription('Skript seçin')
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder()
      .setName('resethwid')
      .setDescription('İstifadəçinin HWID kilidini sıfırla')
      .addUserOption(opt =>
        opt.setName('user').setDescription('Discord istifadəçisi').setRequired(true)
      )
  ].map(c => c.toJSON());
}

async function syncSlashCommands() {
  const token = resolveBotToken(state.botToken);
  if (!token || !client.user) return;
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    const body = buildSlashCommands();
    await rest.put(Routes.applicationCommands(client.user.id), { body });
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
      } catch (guildErr) {
        console.warn('Guild command sync warning:', guild.id, guildErr.message);
      }
    }
    console.log('Slash commands synced globally and to', client.guilds.cache.size, 'guilds');
  } catch (err) {
    console.error('Slash command sync failed:', err.message);
  }
}

async function fetchGuildNameFromDiscord(guildId) {
  if (!guildId) return '';
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached.name;
  const token = resolveBotToken(state.botToken);
  if (!token) return '';
  try {
    const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.name) return data.name;
    }
  } catch (err) {
    console.warn('Guild fetch warning:', err.message);
  }
  return '';
}

function getScriptsForGuildOrAll(guildId) {
  if (!guildId) return state.scripts;
  const scoped = state.scripts.filter(s => !s.guildId || s.guildId === guildId);
  return scoped.length > 0 ? scoped : state.scripts;
}

function createPanelEmbed(scriptObj, customTitle) {
  const cfg = state.panelConfig || {};
  let colorHex = 0x5865f2;
  try {
    const cleaned = String(cfg.embedColor || '#5865F2').replace('#', '');
    const parsed = parseInt(cleaned, 16);
    if (!Number.isNaN(parsed)) colorHex = parsed;
  } catch (_) {}

  const scriptName = scriptObj ? scriptObj.name : 'SADO PROTECT Script';
  const title = customTitle || cfg.title || `🛡️ ${scriptName}`;
  const desc =
    `${cfg.description || 'Aşağıdakı düymələrdən istifadə edərək skriptə giriş əldə edin.'}\n\n` +
    `📦 **Skript:** \`${scriptName}\``;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(colorHex)
    .setFooter({ text: 'SADO PROTECT • Secure Loader System' })
    .setTimestamp();
}

function createPanelButtons(scriptId) {
  const cfg = state.panelConfig || {};
  const sid = scriptId || 'default';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sado_redeem:${sid}`)
      .setLabel(cfg.redeemLabel || '🔑 Redeem Key')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`sado_getscript:${sid}`)
      .setLabel(cfg.getScriptLabel || '📜 Get Script')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sado_resethwid:${sid}`)
      .setLabel(cfg.resetHwidLabel || '🔄 Reset HWID')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sado_stats:${sid}`)
      .setLabel(cfg.statsLabel || '📊 Stats')
      .setStyle(ButtonStyle.Secondary)
  );
}

client.on('clientReady', async () => {
  botStatus.online = true;
  botStatus.tag = client.user ? client.user.tag : '';
  syncBotGuildsCache();
  console.log(`SADO PROTECT Bot online: ${botStatus.tag}`);

  if (state.activeGuildId) {
    const realName = await fetchGuildNameFromDiscord(state.activeGuildId);
    if (realName) {
      state.activeGuildName = realName;
      saveState();
    }
  }
  await syncSlashCommands();
});

client.on('ready', async () => {
  botStatus.online = true;
  botStatus.tag = client.user ? client.user.tag : '';
  syncBotGuildsCache();
  if (state.activeGuildId) {
    const realName = await fetchGuildNameFromDiscord(state.activeGuildId);
    if (realName) {
      state.activeGuildName = realName;
      saveState();
    }
  }
  await syncSlashCommands();
});

client.on('guildCreate', async guild => {
  syncBotGuildsCache();
  state.activeGuildId = guild.id;
  state.activeGuildName = guild.name;
  saveState();
  await syncSlashCommands();
});

client.on('guildDelete', () => {
  syncBotGuildsCache();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'script') {
        const q = String(focused.value || '').toLowerCase();
        const available = getScriptsForGuildOrAll(interaction.guildId);
        const filtered = available
          .filter(s => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
          .slice(0, 25)
          .map(s => ({
            name: `${s.name} (${s.id})`.slice(0, 100),
            value: s.id
          }));

        if (filtered.length === 0) {
          await interaction.respond([
            { name: 'Saytda skript yaradın (hələ skript yoxdur)', value: 'none' }
          ]);
        } else {
          await interaction.respond(filtered);
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const isAdmin =
        interaction.memberPermissions &&
        (interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
          interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild));

      if (!isAdmin) {
        await interaction.reply({
          content: '❌ Bu əmri istifadə etmək üçün serverdə Admin icazəniz olmalıdır.',
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'panel') {
        const scriptOpt = interaction.options.getString('script');
        const titleOpt = interaction.options.getString('title');
        const pool = getScriptsForGuildOrAll(interaction.guildId);

        let targetScript = null;
        if (scriptOpt && scriptOpt !== 'none') {
          targetScript =
            pool.find(s => s.id === scriptOpt || s.name.toLowerCase() === scriptOpt.toLowerCase()) ||
            state.scripts.find(s => s.id === scriptOpt || s.name.toLowerCase() === scriptOpt.toLowerCase());
        } else if (pool.length >= 1) {
          targetScript = pool[0];
        }

        if (!targetScript) {
          await interaction.reply({
            content: '⚠️ Əvvəlcə veb paneldə **Skriptlər & Dosya** bölməsindən skript yaradın.',
            ephemeral: true
          });
          return;
        }

        const embed = createPanelEmbed(targetScript, titleOpt);
        const row = createPanelButtons(targetScript.id);
        const msg = await interaction.channel.send({ embeds: [embed], components: [row] });

        state.panels.push({
          id: randomId('pnl'),
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          messageId: msg.id,
          scriptId: targetScript.id,
          createdAt: Date.now()
        });
        saveState();

        await interaction.reply({
          content: `✅ **${targetScript.name}** üçün panel bu kanala göndərildi!`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'genkey') {
        const scriptOpt = interaction.options.getString('script', true);
        const durStr = interaction.options.getString('duration') || '0';
        const amount = Math.min(25, Math.max(1, interaction.options.getInteger('amount') || 1));

        const targetScript =
          state.scripts.find(s => s.id === scriptOpt || s.name.toLowerCase() === scriptOpt.toLowerCase()) ||
          state.scripts[0];

        if (!targetScript) {
          await interaction.reply({ content: '⚠️ Skript tapılmadı.', ephemeral: true });
          return;
        }

        const durMs = parseDurationMs(durStr);
        const expiresAt = durMs === 0 ? null : Date.now() + durMs;
        const created = [];

        for (let i = 0; i < amount; i++) {
          const k = generateLicenseKey();
          state.keys.unshift({
            key: k,
            scriptId: targetScript.id,
            scriptName: targetScript.name,
            guildId: interaction.guildId,
            createdBy: interaction.user.tag,
            redeemedBy: null,
            redeemedByTag: null,
            hwid: null,
            expiresAt,
            createdAt: Date.now()
          });
          created.push(k);
        }
        saveState();

        await interaction.reply({
          content: `🔑 **${targetScript.name}** üçün **${created.length}** ədəd key yaradıldı:\n\`\`\`\n${created.join('\n')}\n\`\`\``,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'whitelist') {
        const user = interaction.options.getUser('user', true);
        const scriptOpt = interaction.options.getString('script', true);
        const durStr = interaction.options.getString('duration') || '0';
        const targetScript =
          state.scripts.find(s => s.id === scriptOpt || s.name.toLowerCase() === scriptOpt.toLowerCase()) ||
          state.scripts[0];

        if (!targetScript) {
          await interaction.reply({ content: '⚠️ Skript tapılmadı.', ephemeral: true });
          return;
        }

        const durMs = parseDurationMs(durStr);
        const expiresAt = durMs === 0 ? null : Date.now() + durMs;
        const existing = state.whitelist.find(
          w => w.discordUserId === user.id && w.scriptId === targetScript.id
        );

        if (existing) {
          existing.expiresAt = expiresAt;
          existing.discordTag = user.tag;
        } else {
          state.whitelist.unshift({
            id: randomId('wl'),
            discordUserId: user.id,
            discordTag: user.tag,
            scriptId: targetScript.id,
            scriptName: targetScript.name,
            guildId: interaction.guildId,
            hwid: null,
            expiresAt,
            createdAt: Date.now()
          });
        }
        saveState();

        await interaction.reply({
          content: `✅ <@${user.id}> **${targetScript.name}** skripti üçün whitelist-ə əlavə edildi!`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'unwhitelist') {
        const user = interaction.options.getUser('user', true);
        const scriptOpt = interaction.options.getString('script');
        const before = state.whitelist.length;
        state.whitelist = state.whitelist.filter(w => {
          if (w.discordUserId !== user.id) return true;
          if (scriptOpt && scriptOpt !== 'none' && w.scriptId !== scriptOpt) return true;
          return false;
        });
        saveState();
        const removed = before - state.whitelist.length;
        await interaction.reply({
          content: `🗑️ <@${user.id}> whitelist-dən silindi (${removed} qeyd).`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'resethwid') {
        const user = interaction.options.getUser('user', true);
        let count = 0;
        for (const w of state.whitelist) {
          if (w.discordUserId === user.id && w.hwid) {
            w.hwid = null;
            count++;
          }
        }
        for (const k of state.keys) {
          if (k.redeemedBy === user.id && k.hwid) {
            k.hwid = null;
            count++;
          }
        }
        saveState();
        await interaction.reply({
          content: `🔄 <@${user.id}> üçün HWID sıfırlandı (${count} qeyd).`,
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [action, scriptId] = interaction.customId.split(':');

      if (action === 'sado_redeem') {
        const modal = new ModalBuilder()
          .setCustomId(`sado_redeem_modal:${scriptId}`)
          .setTitle('SADO PROTECT • Key Aktivləşdir');

        const keyInput = new TextInputBuilder()
          .setCustomId('license_key_input')
          .setLabel('Lisenziya Key-inizi daxil edin')
          .setPlaceholder('SADO-XXXXXX-XXXXXX-XXXXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        await interaction.showModal(modal);
        return;
      }

      if (action === 'sado_getscript') {
        const wl = state.whitelist.find(
          w =>
            w.discordUserId === interaction.user.id &&
            (!scriptId || scriptId === 'default' || w.scriptId === scriptId)
        );
        const keyRecord = state.keys.find(
          k =>
            k.redeemedBy === interaction.user.id &&
            (!scriptId || scriptId === 'default' || k.scriptId === scriptId)
        );

        const activeEntry = wl || keyRecord;
        if (!activeEntry) {
          const panelEmbed = new EmbedBuilder()
            .setTitle('🔐 SADO PROTECT • Script & Key Access')
            .setDescription(
              `❌ **Status:** Whitelist / Key tapılmadı\n` +
              `Skripti əldə etmək üçün əvvəlcə **🔑 Redeem Key** düyməsinə basıb key daxil edin.`
            )
            .setColor(0xef4444)
            .setFooter({ text: 'SADO PROTECT • Script Loader Panel' });

          await interaction.reply({
            embeds: [panelEmbed],
            ephemeral: true
          });
          return;
        }

        if (activeEntry.expiresAt && Date.now() > activeEntry.expiresAt) {
          await interaction.reply({
            content: '⌛ Sizin lisenziya müddətiniz bitib.',
            ephemeral: true
          });
          return;
        }

        const sid = activeEntry.scriptId || scriptId;
        const scriptObj = state.scripts.find(s => s.id === sid);
        const scriptLabel = scriptObj ? scriptObj.name : sid;
        const userKeyVal = (keyRecord && keyRecord.key) || 'WHITELISTED';
        const loaderUrl = `${PUBLIC_SITE_URL}/api/loader/${sid}?uid=${interaction.user.id}`;
        const luaLoader = `script_key = "${userKeyVal}"\nloadstring(game:HttpGet("${loaderUrl}"))()`;

        const scriptPanelEmbed = new EmbedBuilder()
          .setTitle(`📜 ${scriptLabel} • Script & Key Panel`)
          .setDescription(
            `✅ **Status:** Aktiv\n` +
            `🔑 **Key:** \`${userKeyVal}\`\n` +
            `📦 **Script:** \`${scriptLabel}\`\n\n` +
            `\`\`\`lua\n${luaLoader}\n\`\`\``
          )
          .setColor(0x22c55e)
          .setFooter({ text: 'SADO PROTECT • Executor Loader' })
          .setTimestamp();

        const copyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`sado_copy_loader:${sid}`)
            .setLabel('📋 Skripti Kopyala')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
          embeds: [scriptPanelEmbed],
          components: [copyRow],
          ephemeral: true
        });
        return;
      }

      if (action === 'sado_copy_loader') {
        const sid = scriptId || 'default';
        const keyRecord = state.keys.find(
          k => k.redeemedBy === interaction.user.id && (!sid || sid === 'default' || k.scriptId === sid)
        );
        const userKeyVal = (keyRecord && keyRecord.key) || 'WHITELISTED';
        const loaderUrl = `${PUBLIC_SITE_URL}/api/loader/${sid}?uid=${interaction.user.id}`;
        const luaLoader = `script_key = "${userKeyVal}"\nloadstring(game:HttpGet("${loaderUrl}"))()`;

        await interaction.reply({
          content: luaLoader,
          ephemeral: true
        });
        return;
      }

      if (action === 'sado_resethwid') {
        let reset = false;
        for (const w of state.whitelist) {
          if (w.discordUserId === interaction.user.id && (!scriptId || scriptId === 'default' || w.scriptId === scriptId)) {
            w.hwid = null;
            reset = true;
          }
        }
        for (const k of state.keys) {
          if (k.redeemedBy === interaction.user.id && (!scriptId || scriptId === 'default' || k.scriptId === scriptId)) {
            k.hwid = null;
            reset = true;
          }
        }
        saveState();
        await interaction.reply({
          content: reset
            ? '🔄 HWID uğurla sıfırlandı! İndi yeni cihazdan daxil ola bilərsiniz.'
            : '❌ Aktiv whitelist tapılmadı.',
          ephemeral: true
        });
        return;
      }

      if (action === 'sado_stats') {
        const wl = state.whitelist.find(
          w =>
            w.discordUserId === interaction.user.id &&
            (!scriptId || scriptId === 'default' || w.scriptId === scriptId)
        );
        if (!wl) {
          await interaction.reply({
            content: '❌ Bu skript üzrə aktiv üzvlüyünüz yoxdur.',
            ephemeral: true
          });
          return;
        }
        const expText = wl.expiresAt ? `<t:${Math.floor(wl.expiresAt / 1000)}:F>` : 'Ömürlük (Lifetime)';
        await interaction.reply({
          content:
            `📊 **SADO PROTECT Statistika**\n` +
            `• **İstifadəçi:** <@${interaction.user.id}>\n` +
            `• **Skript:** \`${wl.scriptName || wl.scriptId}\`\n` +
            `• **HWID:** ${wl.hwid ? '🔒 Bağlıdır' : '🔓 Bağlanmayıb'}\n` +
            `• **Müddət:** ${expText}`,
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('sado_redeem_modal:')) {
      const scriptId = interaction.customId.split(':')[1];
      const enteredKey = interaction.fields.getTextInputValue('license_key_input').trim();

      const keyObj = state.keys.find(k => k.key === enteredKey);
      if (!keyObj) {
        await interaction.reply({ content: '❌ Yanlış və ya mövcud olmayan key!', ephemeral: true });
        return;
      }
      if (keyObj.redeemedBy && keyObj.redeemedBy !== interaction.user.id) {
        await interaction.reply({ content: '❌ Bu key artıq başqa istifadəçi tərəfindən işlədilib.', ephemeral: true });
        return;
      }
      if (scriptId && scriptId !== 'default' && keyObj.scriptId !== scriptId) {
        await interaction.reply({ content: '❌ Bu key başqa skriptə aiddir.', ephemeral: true });
        return;
      }

      keyObj.redeemedBy = interaction.user.id;
      keyObj.redeemedByTag = interaction.user.tag;

      const existingWl = state.whitelist.find(
        w => w.discordUserId === interaction.user.id && w.scriptId === keyObj.scriptId
      );
      if (existingWl) {
        existingWl.expiresAt = keyObj.expiresAt;
        existingWl.discordTag = interaction.user.tag;
      } else {
        state.whitelist.unshift({
          id: randomId('wl'),
          discordUserId: interaction.user.id,
          discordTag: interaction.user.tag,
          scriptId: keyObj.scriptId,
          scriptName: keyObj.scriptName,
          guildId: interaction.guildId,
          hwid: null,
          expiresAt: keyObj.expiresAt,
          createdAt: Date.now()
        });
      }
      saveState();

      await interaction.reply({
        content: `✅ Key uğurla aktivləşdirildi! **${keyObj.scriptName}** üçün whitelist aldınız. İndi **Get Script** düyməsinə basın.`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

let botLoginInFlight = null;

async function startDiscordBot(token) {
  const cleanToken = resolveBotToken(token);
  if (!cleanToken) return { ok: false, message: 'Token boşdur.' };

  if (botLoginInFlight) {
    return botLoginInFlight;
  }

  botLoginInFlight = (async () => {
    try {
      state.botToken = cleanToken;
      saveState();

      if (client.isReady()) {
        botStatus.online = true;
        botStatus.tag = client.user ? client.user.tag : botStatus.tag;
        syncBotGuildsCache();
        return { ok: true, tag: botStatus.tag };
      }

      const loginPromise = client.login(cleanToken);
      const readyPromise = new Promise(resolve => {
        if (client.isReady()) return resolve(true);
        client.once('ready', () => resolve(true));
        client.once('clientReady', () => resolve(true));
        setTimeout(() => resolve(Boolean(client.isReady())), 4500);
      });

      await loginPromise;
      await readyPromise;

      botStatus.online = Boolean(client.isReady());
      botStatus.tag = client.user ? client.user.tag : botStatus.tag;
      syncBotGuildsCache();

      return { ok: true, tag: botStatus.tag };
    } catch (err) {
      botStatus.online = Boolean(client.isReady());
      console.error('Discord bot login warning (server stays alive):', err.message);
      return { ok: false, message: err.message || 'Discord giriş xətası' };
    } finally {
      botLoginInFlight = null;
    }
  })();

  return botLoginInFlight;
}

function scheduleBotWatchdog() {
  if (global._sadoBotWatchdog) clearInterval(global._sadoBotWatchdog);
  global._sadoBotWatchdog = setInterval(async () => {
    try {
      const token = resolveBotToken(state.botToken);
      if (!token) return;
      if (client.isReady()) {
        botStatus.online = true;
        botStatus.tag = client.user ? client.user.tag : botStatus.tag;
        syncBotGuildsCache();
        return;
      }
      botStatus.online = false;
      await startDiscordBot(token);
    } catch (err) {
      console.warn('Bot watchdog check warning:', err.message);
    }
  }, 20000);
}

process.on('uncaughtException', err => {
  console.error('Uncaught exception kept alive:', err && err.message ? err.message : err);
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection kept alive:', reason);
});

// ==================== EXPRESS API ROUTES ====================
app.get('/api/state', async (req, res) => {
  if (state.activeGuildId && !state.activeGuildName) {
    const resolved = await fetchGuildNameFromDiscord(state.activeGuildId);
    if (resolved) {
      state.activeGuildName = resolved;
      saveState();
    }
  }

  const isBotOnline = Boolean(client.isReady() || botStatus.online);
  const guildsList =
    client.guilds && client.guilds.cache && client.guilds.cache.size > 0
      ? client.guilds.cache.map(g => ({ id: g.id, name: g.name }))
      : botStatus.guilds;

  res.json({
    ok: true,
    bot: {
      online: isBotOnline,
      tag: client.user ? client.user.tag : botStatus.tag || '',
      hasToken: Boolean(resolveBotToken(state.botToken)),
      inviteUrl: BOT_INVITE_URL,
      oauthEnabled: Boolean(BOT_CLIENT_SECRET),
      guilds: guildsList
    },
    activeGuildId: state.activeGuildId || '',
    activeGuildName: state.activeGuildName || '',
    activeDiscordUserId: state.activeDiscordUserId || '',
    scripts: state.scripts.map(s => ({
      id: s.id,
      name: s.name,
      code: s.code,
      obfuscated: Boolean(s.obfuscated),
      guildId: s.guildId || '',
      createdAt: s.createdAt
    })),
    keys: state.keys.slice(0, 100),
    whitelist: state.whitelist.slice(0, 100),
    panelConfig: state.panelConfig
  });
});

app.post('/api/bot/token', async (req, res) => {
  const { token } = req.body || {};
  const result = await startDiscordBot(token);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json({ ok: true, online: true, tag: client.user ? client.user.tag : result.tag || '' });
});

app.post('/api/workspace/link', async (req, res) => {
  const { guildId, discordUserId } = req.body || {};
  const cleanGuildId = String(guildId || '').trim();
  const cleanUserId = String(discordUserId || '').trim();

  if (!cleanGuildId) {
    return res.status(400).json({ ok: false, message: 'Sunucu ID daxil edin və ya siyahıdan seçin.' });
  }

  let guildName = await fetchGuildNameFromDiscord(cleanGuildId);
  if (!guildName) {
    guildName = `Sunucu (${cleanGuildId})`;
  }

  state.activeGuildId = cleanGuildId;
  state.activeGuildName = guildName;
  if (cleanUserId) {
    state.activeDiscordUserId = cleanUserId;
  }
  saveState();

  res.json({
    ok: true,
    guildId: cleanGuildId,
    guildName
  });
});

app.get('/auth/discord', (req, res) => {
  if (!BOT_CLIENT_SECRET) {
    return res.redirect(BOT_INVITE_URL);
  }
  const redirectUri = encodeURIComponent(`${PUBLIC_SITE_URL}/auth/discord/callback`);
  const scope = encodeURIComponent('identify guilds bot applications.commands');
  const url = `https://discord.com/oauth2/authorize?client_id=${BOT_CLIENT_ID}&permissions=2147600384&response_type=code&redirect_uri=${redirectUri}&scope=${scope}`;
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  const guildIdFromQuery = req.query.guild_id;

  if (guildIdFromQuery) {
    const gName = (await fetchGuildNameFromDiscord(String(guildIdFromQuery))) || `Sunucu (${guildIdFromQuery})`;
    state.activeGuildId = String(guildIdFromQuery);
    state.activeGuildName = gName;
    saveState();
  }

  if (!code || !BOT_CLIENT_SECRET) {
    return res.redirect('/');
  }

  try {
    const params = new URLSearchParams({
      client_id: BOT_CLIENT_ID,
      client_secret: BOT_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: `${PUBLIC_SITE_URL}/auth/discord/callback`
    });

    const tokenResp = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const tokenData = await tokenResp.json();

    if (tokenData.access_token) {
      const userResp = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userData = await userResp.json();
      if (userData && userData.id) {
        state.activeDiscordUserId = userData.id;
      }
      if (tokenData.guild && tokenData.guild.id) {
        state.activeGuildId = tokenData.guild.id;
        state.activeGuildName = tokenData.guild.name || state.activeGuildName;
      }
      saveState();
    }
  } catch (err) {
    console.error('OAuth callback error:', err.message);
  }

  res.redirect('/');
});

app.post('/api/scripts', async (req, res) => {
  const { name, code, obfuscate, obfuscateLevel, preObfuscated } = req.body || {};
  const cleanName = String(name || '').trim();
  const rawCode = String(code || '');

  if (!cleanName || !rawCode.trim()) {
    return res.status(400).json({ ok: false, message: 'Skript adı və Lua kodu mütləqdir.' });
  }

  let finalCode = rawCode;
  let isObf = Boolean(preObfuscated);

  if (obfuscate && !preObfuscated) {
    finalCode = obfuscateLuaCode(rawCode, obfuscateLevel || 'high');
    isObf = true;
  }

  const scriptObj = {
    id: randomId('scr', 5),
    name: cleanName,
    code: finalCode,
    obfuscated: isObf,
    guildId: state.activeGuildId || '',
    createdAt: Date.now()
  };

  state.scripts.unshift(scriptObj);
  saveState();

  res.json({ ok: true, script: scriptObj });
});

app.put('/api/scripts/:id', (req, res) => {
  const { id } = req.params;
  const { name, code, obfuscate, obfuscateLevel } = req.body || {};
  const target = state.scripts.find(s => s.id === id);

  if (!target) {
    return res.status(404).json({ ok: false, message: 'Skript tapılmadı.' });
  }

  if (name && String(name).trim()) {
    target.name = String(name).trim();
  }
  if (typeof code === 'string' && code.trim()) {
    if (obfuscate) {
      target.code = obfuscateLuaCode(code, obfuscateLevel || 'high');
      target.obfuscated = true;
    } else {
      target.code = code;
    }
  }
  saveState();
  res.json({ ok: true, script: target });
});

app.post('/api/scripts/:id/obfuscate', (req, res) => {
  const { id } = req.params;
  const { level } = req.body || {};
  const target = state.scripts.find(s => s.id === id);

  if (!target) {
    return res.status(404).json({ ok: false, message: 'Skript tapılmadı.' });
  }

  target.code = obfuscateLuaCode(target.code, level || 'high');
  target.obfuscated = true;
  saveState();

  res.json({ ok: true, script: target });
});

app.delete('/api/scripts/:id', (req, res) => {
  const { id } = req.params;
  state.scripts = state.scripts.filter(s => s.id !== id);
  saveState();
  res.json({ ok: true });
});

app.post('/api/obfuscate', (req, res) => {
  const { code, level } = req.body || {};
  if (!code || !String(code).trim()) {
    return res.status(400).json({ ok: false, message: 'Lua kodu daxil edin.' });
  }
  const output = obfuscateLuaCode(String(code), level || 'high');
  res.json({ ok: true, output });
});

app.post('/api/keys', (req, res) => {
  const { scriptId, duration, amount } = req.body || {};
  const targetScript = state.scripts.find(s => s.id === scriptId) || state.scripts[0];
  if (!targetScript) {
    return res.status(400).json({ ok: false, message: 'Əvvəlcə skript yaradın.' });
  }

  const count = Math.min(50, Math.max(1, Number(amount) || 1));
  const durMs = parseDurationMs(duration || '0');
  const expiresAt = durMs === 0 ? null : Date.now() + durMs;
  const created = [];

  for (let i = 0; i < count; i++) {
    const k = generateLicenseKey();
    const item = {
      key: k,
      scriptId: targetScript.id,
      scriptName: targetScript.name,
      guildId: state.activeGuildId || '',
      createdBy: 'Web Panel',
      redeemedBy: null,
      redeemedByTag: null,
      hwid: null,
      expiresAt,
      createdAt: Date.now()
    };
    state.keys.unshift(item);
    created.push(item);
  }
  saveState();
  res.json({ ok: true, keys: created });
});

app.delete('/api/keys/:key', (req, res) => {
  state.keys = state.keys.filter(k => k.key !== req.params.key);
  saveState();
  res.json({ ok: true });
});

app.post('/api/whitelist', (req, res) => {
  const { discordUserId, scriptId, duration } = req.body || {};
  const uid = String(discordUserId || '').trim();
  if (!uid) {
    return res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
  }
  const targetScript = state.scripts.find(s => s.id === scriptId) || state.scripts[0];
  if (!targetScript) {
    return res.status(400).json({ ok: false, message: 'Əvvəlcə skript yaradın.' });
  }

  const durMs = parseDurationMs(duration || '0');
  const expiresAt = durMs === 0 ? null : Date.now() + durMs;

  const existing = state.whitelist.find(w => w.discordUserId === uid && w.scriptId === targetScript.id);
  if (existing) {
    existing.expiresAt = expiresAt;
  } else {
    state.whitelist.unshift({
      id: randomId('wl'),
      discordUserId: uid,
      discordTag: uid,
      scriptId: targetScript.id,
      scriptName: targetScript.name,
      guildId: state.activeGuildId || '',
      hwid: null,
      expiresAt,
      createdAt: Date.now()
    });
  }
  saveState();
  res.json({ ok: true });
});

app.delete('/api/whitelist/:id', (req, res) => {
  state.whitelist = state.whitelist.filter(w => w.id !== req.params.id);
  saveState();
  res.json({ ok: true });
});

app.post('/api/panel-config', (req, res) => {
  state.panelConfig = {
    ...state.panelConfig,
    ...(req.body || {})
  };
  saveState();
  res.json({ ok: true, panelConfig: state.panelConfig });
});

app.get('/api/loader/:scriptId', (req, res) => {
  const { scriptId } = req.params;
  const uid = String(req.query.uid || '').trim();
  const hwid = String(req.headers['syn-fingerprint'] || req.headers['exploit-guid'] || req.query.hwid || '').trim();

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const scriptObj = state.scripts.find(s => s.id === scriptId);
  if (!scriptObj) {
    return res.status(404).send('game.Players.LocalPlayer:Kick("SADO PROTECT: Skript tapilmadi.")');
  }

  const wl = state.whitelist.find(w => w.discordUserId === uid && w.scriptId === scriptId);
  if (!wl) {
    return res.status(403).send('game.Players.LocalPlayer:Kick("SADO PROTECT: Whitelist icazeniz yoxdur!")');
  }

  if (wl.expiresAt && Date.now() > wl.expiresAt) {
    return res.status(403).send('game.Players.LocalPlayer:Kick("SADO PROTECT: Lisenziya muddetiniz bitib.")');
  }

  if (hwid) {
    if (!wl.hwid) {
      wl.hwid = hwid;
      saveState();
    } else if (wl.hwid !== hwid) {
      return res.status(403).send('game.Players.LocalPlayer:Kick("SADO PROTECT: HWID uyusmur! Discord panelden Reset HWID edin.")');
    }
  }

  res.send(scriptObj.code);
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • Control Panel</title>
  <style>
    :root {
      --bg: #0b0e17;
      --card: #131826;
      --card-2: #192033;
      --border: #252e47;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #5865F2;
      --green: #22c55e;
      --red: #ef4444;
      --amber: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, system-ui, -apple-system, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; }
    .topbar {
      position: sticky; top: 0; z-index: 40;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 12px 16px; background: rgba(15, 20, 34, 0.95);
      border-bottom: 1px solid var(--border); backdrop-filter: blur(8px);
    }
    .menu-btn {
      width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--card-2); color: var(--text); font-size: 20px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .brand-title { font-weight: 800; font-size: 15px; line-height: 1.25; }
    .brand-sub { font-size: 11px; color: var(--muted); }
    .status-pill {
      padding: 6px 11px; border-radius: 999px; font-size: 12px; font-weight: 600;
      background: var(--card-2); border: 1px solid var(--border); white-space: nowrap;
    }
    .status-pill.online { border-color: rgba(34, 197, 94, 0.45); color: #4ade80; }
    .drawer-backdrop {
      display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); z-index: 45;
    }
    .drawer-backdrop.open { display: block; }
    .drawer {
      position: fixed; top: 0; left: -280px; width: 265px; height: 100%;
      background: #0f1422; border-right: 1px solid var(--border); z-index: 50;
      padding: 18px 14px; transition: left 0.22s ease; display: flex; flex-direction: column; gap: 8px;
    }
    .drawer.open { left: 0; }
    .drawer-head { font-weight: 800; font-size: 16px; padding: 6px 10px 14px; border-bottom: 1px solid var(--border); margin-bottom: 6px; }
    .nav-item {
      text-align: left; padding: 11px 12px; border-radius: 10px; border: 1px solid transparent;
      background: transparent; color: var(--text); font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .nav-item:hover, .nav-item.active { background: var(--card-2); border-color: var(--border); color: #fff; }
    .container { max-width: 820px; margin: 0 auto; padding: 16px; }
    .section { display: none; flex-direction: column; gap: 14px; }
    .section.active { display: flex; }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px;
    }
    .card h3 { font-size: 16px; margin-bottom: 8px; }
    .muted { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .stat-val { font-size: 26px; font-weight: 800; margin-top: 6px; }
    label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 6px; font-weight: 600; }
    input, select, textarea {
      width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border);
      background: #0d1220; color: var(--text); font-size: 14px; outline: none;
    }
    textarea { min-height: 130px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .btn {
      width: 100%; padding: 12px 14px; border-radius: 10px; border: none;
      font-weight: 700; font-size: 14px; cursor: pointer; margin-top: 10px;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-green { background: var(--green); color: #052e16; }
    .btn-amber { background: var(--amber); color: #1c1917; }
    .btn-red { background: var(--red); color: #fff; }
    .btn-sm { width: auto; padding: 7px 11px; font-size: 12px; margin-top: 0; border-radius: 8px; }
    .row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .list-item {
      background: #0e1322; border: 1px solid var(--border); border-radius: 12px;
      padding: 12px; margin-top: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700;
      background: rgba(34, 197, 94, 0.16); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.35);
    }
    .check-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; }
    .check-row input { width: auto; }
    .modal-bg {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.72); z-index: 60;
      align-items: center; justify-content: center; padding: 16px;
    }
    .modal-bg.open { display: flex; }
    .modal-box {
      width: 100%; max-width: 520px; background: var(--card); border: 1px solid var(--border);
      border-radius: 14px; padding: 16px;
    }
    .toast {
      position: fixed; bottom: 18px; right: 18px; z-index: 80;
      background: #1e293b; color: #fff; border: 1px solid var(--border);
      padding: 11px 15px; border-radius: 10px; font-size: 13px; font-weight: 600;
      display: none; max-width: 90vw;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <button class="menu-btn" id="openMenuBtn" aria-label="Menu">☰</button>
    <div style="flex:1; min-width:0;">
      <div class="brand-title" id="headerTitle">SADO PROTECT</div>
      <div class="brand-sub" id="headerSub">Control Dashboard</div>
    </div>
    <div class="status-pill" id="botStatusPill">Bot: Yüklənir...</div>
  </header>

  <div class="drawer-backdrop" id="drawerBackdrop"></div>
  <aside class="drawer" id="drawer">
    <div class="drawer-head">🛡️ SADO PROTECT</div>
    <button class="nav-item active" data-tab="overview">📊 Ümumi Baxış</button>
    <button class="nav-item" data-tab="discord">🤖 Join Discord & Panel</button>
    <button class="nav-item" data-tab="scripts">📜 Skriptlər & Dosya</button>
    <button class="nav-item" data-tab="obfuscator">🛡️ Lua Obfuscator</button>
    <button class="nav-item" data-tab="keys">🔑 Key & Whitelist</button>
  </aside>

  <main class="container">
    <section class="section active" id="tab-overview">
      <div class="stat-grid">
        <div class="card">
          <div class="muted">Skriptlər</div>
          <div class="stat-val" id="statScripts">0</div>
        </div>
        <div class="card">
          <div class="muted">Yaradılmış Key-lər</div>
          <div class="stat-val" id="statKeys">0</div>
        </div>
        <div class="card">
          <div class="muted">Aktiv Whitelist</div>
          <div class="stat-val" id="statWhitelist">0</div>
        </div>
        <div class="card">
          <div class="muted">Qoşulu Sunucu</div>
          <div class="stat-val" style="font-size:17px;" id="statGuild">Seçilməyib</div>
        </div>
      </div>
      <div class="card">
        <h3>Son Key-lər (Yaradan & İşlədən)</h3>
        <div id="recentKeysList" class="muted">Hələ key yaradılmayıb.</div>
      </div>
    </section>

    <section class="section" id="tab-discord">
      <div class="card">
        <h3>🤖 SADO PROTECT Botunu Sunucuna Əlavə Et (Join Discord)</h3>
        <p class="muted">
          1. Aşağıdakı düymə ilə <b>SADO PROTECT</b> botunu öz Discord sunucunuza əlavə edin.<br/>
          2. Bot sunucuya girdikdən sonra aşağıdan öz sunucunuzu seçin (və ya Sunucu ID-ni yazın) — yuxarıda öz sunucunuzun adı görünəcək və bütün idarəetmə paneli tam sizə bağlanacaq.
        </p>
        <a class="btn btn-green" id="inviteBotBtn" href="${BOT_INVITE_URL}" target="_blank" rel="noopener">
          ➕ SADO PROTECT Botunu Sunucuna Əlavə Et
        </a>

        <label>Botun Olduğu Sunuculardan Öz Sunucunu Seç</label>
        <select id="guildSelectDropdown">
          <option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>
        </select>

        <label>Və ya Discord Sunucu ID (Server ID)</label>
        <input type="text" id="linkGuildIdInput" placeholder="Məs: 1559499280732131348" />

        <label>Discord User ID (istəyə bağlı)</label>
        <input type="text" id="linkDiscordIdInput" placeholder="Məs: 123456789012345678" />

        <button class="btn btn-primary" id="linkWorkspaceBtn">✅ Sunucunu İdarəetmə Panelinə Bağla</button>
      </div>

      <div class="card">
        <h3>🎨 Panel Buton və Embed Dizaynı</h3>
        <label>Embed Rəngi (HEX)</label>
        <input type="text" id="cfgEmbedColor" value="#5865F2" />
        <label>Panel Başlığı</label>
        <input type="text" id="cfgTitle" placeholder="SADO PROTECT • Script Panel" />
        <label>Panel Açıqlaması</label>
        <input type="text" id="cfgDescription" placeholder="Aşağıdakı düymələrdən istifadə edin..." />
        <label>Redeem Key Düymə Mətni</label>
        <input type="text" id="cfgRedeemLabel" placeholder="🔑 Redeem Key" />
        <label>Get Script Düymə Mətni</label>
        <input type="text" id="cfgGetScriptLabel" placeholder="📜 Get Script" />
        <label>Reset HWID Düymə Mətni</label>
        <input type="text" id="cfgResetHwidLabel" placeholder="🔄 Reset HWID" />
        <label>Stats Düymə Mətni</label>
        <input type="text" id="cfgStatsLabel" placeholder="📊 Stats" />
        <button class="btn btn-primary" id="savePanelCfgBtn">💾 Panel Dizaynını Yadda Saxla</button>
      </div>
    </section>

    <section class="section" id="tab-scripts">
      <div class="card">
        <h3>➕ Yeni Skript Yarat</h3>
        <label>Skript Adı</label>
        <input type="text" id="scriptNameInput" placeholder="Məs: SADO HUB" />

        <label>Lua / TXT Dosya Seç (istəyə bağlı)</label>
        <input type="file" id="scriptFileInput" accept=".lua,.txt" />

        <label>Skript Kodu</label>
        <textarea id="scriptCodeInput" placeholder="-- Lua skript kodunu bura yazın və ya dosya seçin"></textarea>

        <div class="check-row">
          <input type="checkbox" id="autoObfCheckbox" checked />
          <label for="autoObfCheckbox" style="margin:0;">Skripti yadda saxlayanda avtomatik <b>Lua Obfuscate</b> et (kodu şifrələ)</label>
        </div>

        <button class="btn btn-green" id="createScriptBtn">💾 Skripti Yadda Saxla</button>
      </div>

      <div class="card">
        <h3>📂 Mövcud Skriptlər</h3>
        <div id="scriptsList" class="muted">Hələ skript yaradılmayıb.</div>
      </div>
    </section>

    <section class="section" id="tab-obfuscator">
      <div class="card">
        <h3>🛡️ Lua Obfuscator</h3>
        <p class="muted">Lua kodunuzu şifrələyin və ya birbaşa skript kimi panelə əlavə edin.</p>
        <label>Qoruma Səviyyəsi</label>
        <select id="obfLevelSelect">
          <option value="high">Yüksək (XOR + Bytecode Array + Anti-Read)</option>
          <option value="standard">Standart (Char Table Obfuscation)</option>
        </select>

        <label>Orijinal Lua Kodu</label>
        <textarea id="obfSourceInput" placeholder='print("Salam SADO PROTECT!")'></textarea>

        <button class="btn btn-primary" id="runObfuscateBtn">🛡️ Kodu Şifrələ (Obfuscate)</button>

        <label>Şifrələnmiş Nəticə</label>
        <textarea id="obfOutputText" readonly placeholder="Şifrələnmiş Lua kodu burada görünəcək..."></textarea>

        <button class="btn btn-amber" id="copyObfBtn">📋 Şifrəli Kodu Kopyala</button>

        <label>Birbaşa Skript Kimi Panelə Əlavə Et</label>
        <input type="text" id="obfSaveScriptName" placeholder="Skript adı (məs: SADO VIP)" />
        <button class="btn btn-green" id="obfSaveAsScriptBtn">➕ Şifrəli Skript Kimi Yadda Saxla</button>
      </div>
    </section>

    <section class="section" id="tab-keys">
      <div class="card">
        <h3>🔑 Yeni Key Yarat</h3>
        <label>Skript Seçin</label>
        <select id="keyScriptSelect"></select>
        <label>Müddət (məs: 1d, 7d, 30d, 0 = ömürlük)</label>
        <input type="text" id="keyDurationInput" value="0" />
        <label>Key Sayı</label>
        <input type="number" id="keyAmountInput" value="1" min="1" max="50" />
        <button class="btn btn-green" id="createKeyBtn">🔑 Key Yarat</button>
      </div>

      <div class="card">
        <h3>✅ Birbaşa Whitelist Ver</h3>
        <label>Discord User ID</label>
        <input type="text" id="wlUserIdInput" placeholder="Məs: 123456789012345678" />
        <label>Skript Seçin</label>
        <select id="wlScriptSelect"></select>
        <label>Müddət (0 = ömürlük)</label>
        <input type="text" id="wlDurationInput" value="0" />
        <button class="btn btn-primary" id="addWhitelistBtn">➕ Whitelist Əlavə Et</button>
      </div>

      <div class="card">
        <h3>📋 Aktiv Whitelist Siyahısı</h3>
        <div id="whitelistList" class="muted">Whitelist boşdur.</div>
      </div>
    </section>
  </main>

  <div class="modal-bg" id="editScriptModal">
    <div class="modal-box">
      <h3>✏️ Skripti Yenilə (Update)</h3>
      <input type="hidden" id="editScriptId" />
      <label>Skript Adı</label>
      <input type="text" id="editScriptName" />
      <label>Yeni Lua Kodu</label>
      <textarea id="editScriptCode"></textarea>
      <div class="check-row">
        <input type="checkbox" id="editScriptObfCheck" checked />
        <label for="editScriptObfCheck" style="margin:0;">Yeniləyərkən Lua Obfuscate tətbiq et</label>
      </div>
      <div class="row-between" style="margin-top:12px;">
        <button class="btn btn-green btn-sm" id="saveEditScriptBtn">💾 Yadda Saxla</button>
        <button class="btn btn-red btn-sm" id="closeEditScriptBtn">Bağla</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toastBox"></div>

  <script>
    let cachedState = null;
    let initialInputsLoaded = false;

    function showToast(msg) {
      const el = document.getElementById('toastBox');
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3200);
    }

    async function api(url, opts = {}) {
      try {
        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
          ...opts
        });
        return await res.json();
      } catch (e) {
        return { ok: false, message: e.message };
      }
    }

    const drawer = document.getElementById('drawer');
    const backdrop = document.getElementById('drawerBackdrop');
    function openDrawer() { drawer.classList.add('open'); backdrop.classList.add('open'); }
    function closeDrawer() { drawer.classList.remove('open'); backdrop.classList.remove('open'); }

    document.getElementById('openMenuBtn').onclick = openDrawer;
    backdrop.onclick = closeDrawer;

    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.onclick = () => {
        const tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('tab-' + tab);
        if (target) target.classList.add('active');
        closeDrawer();
      };
    });

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function refreshAll() {
      const data = await api('/api/state');
      if (!data || !data.ok) return;
      cachedState = data;

      const pill = document.getElementById('botStatusPill');
      if (data.bot.online) {
        pill.textContent = 'Bot: Online ✅';
        pill.classList.add('online');
      } else {
        pill.textContent = 'Bot: Qoşulur...';
        pill.classList.remove('online');
      }

      const headerTitle = document.getElementById('headerTitle');
      const headerSub = document.getElementById('headerSub');
      if (data.activeGuildName) {
        headerTitle.textContent = data.activeGuildName;
        headerSub.textContent = 'SADO PROTECT • Control Panel';
        document.getElementById('statGuild').textContent = data.activeGuildName;
      } else {
        headerTitle.textContent = 'SADO PROTECT';
        headerSub.textContent = 'Control Dashboard';
        document.getElementById('statGuild').textContent = 'Seçilməyib';
      }

      const gSelect = document.getElementById('guildSelectDropdown');
      const prevSel = gSelect.value || data.activeGuildId || '';
      gSelect.innerHTML = '<option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>';
      (data.bot.guilds || []).forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name + ' (' + g.id + ')';
        if (g.id === prevSel) opt.selected = true;
        gSelect.appendChild(opt);
      });

      if (!initialInputsLoaded) {
        initialInputsLoaded = true;
        if (data.activeGuildId) document.getElementById('linkGuildIdInput').value = data.activeGuildId;
        if (data.activeDiscordUserId) document.getElementById('linkDiscordIdInput').value = data.activeDiscordUserId;
        if (data.panelConfig) {
          document.getElementById('cfgEmbedColor').value = data.panelConfig.embedColor || '#5865F2';
          document.getElementById('cfgTitle').value = data.panelConfig.title || '';
          document.getElementById('cfgDescription').value = data.panelConfig.description || '';
          document.getElementById('cfgRedeemLabel').value = data.panelConfig.redeemLabel || '🔑 Redeem Key';
          document.getElementById('cfgGetScriptLabel').value = data.panelConfig.getScriptLabel || '📜 Get Script';
          document.getElementById('cfgResetHwidLabel').value = data.panelConfig.resetHwidLabel || '🔄 Reset HWID';
          document.getElementById('cfgStatsLabel').value = data.panelConfig.statsLabel || '📊 Stats';
        }
      }

      document.getElementById('statScripts').textContent = data.scripts.length;
      document.getElementById('statKeys').textContent = data.keys.length;
      document.getElementById('statWhitelist').textContent = data.whitelist.length;

      const recentEl = document.getElementById('recentKeysList');
      if (!data.keys.length) {
        recentEl.innerHTML = '<span class="muted">Hələ key yaradılmayıb.</span>';
      } else {
        recentEl.innerHTML = data.keys.slice(0, 10).map(k =>
          '<div class="list-item">' +
            '<div><b>' + escapeHtml(k.key) + '</b><br/><span class="muted">' + escapeHtml(k.scriptName) + ' • ' + (k.redeemedByTag ? 'İstifadəçi: ' + escapeHtml(k.redeemedByTag) : 'İstifadə edilməyib') + '</span></div>' +
            '<button class="btn btn-red btn-sm" onclick="deleteKey(\\'' + escapeHtml(k.key) + '\\')">Sil</button>' +
          '</div>'
        ).join('');
      }

      const scriptsList = document.getElementById('scriptsList');
      const keySel = document.getElementById('keyScriptSelect');
      const wlSel = document.getElementById('wlScriptSelect');
      const prevKeyScript = keySel.value;
      const prevWlScript = wlSel.value;

      keySel.innerHTML = '';
      wlSel.innerHTML = '';

      if (!data.scripts.length) {
        scriptsList.innerHTML = '<span class="muted">Hələ skript yaradılmayıb.</span>';
      } else {
        scriptsList.innerHTML = data.scripts.map(s =>
          '<div class="list-item">' +
            '<div>' +
              '<b>' + escapeHtml(s.name) + '</b> ' +
              (s.obfuscated ? '<span class="badge">OBFUSCATED</span>' : '') +
              '<br/><span class="muted">(' + escapeHtml(s.id) + ')</span>' +
            '</div>' +
            '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
              '<button class="btn btn-primary btn-sm" onclick="obfuscateExisting(\\'' + escapeHtml(s.id) + '\\')">🛡️ Şifrələ</button>' +
              '<button class="btn btn-amber btn-sm" onclick="openEditScript(\\'' + escapeHtml(s.id) + '\\')">✏️ Update</button>' +
              '<button class="btn btn-red btn-sm" onclick="deleteScript(\\'' + escapeHtml(s.id) + '\\')">Sil</button>' +
            '</div>' +
          '</div>'
        ).join('');

        data.scripts.forEach(s => {
          const o1 = document.createElement('option');
          o1.value = s.id;
          o1.textContent = s.name;
          if (s.id === prevKeyScript) o1.selected = true;
          keySel.appendChild(o1);

          const o2 = document.createElement('option');
          o2.value = s.id;
          o2.textContent = s.name;
          if (s.id === prevWlScript) o2.selected = true;
          wlSel.appendChild(o2);
        });
      }

      const wlList = document.getElementById('whitelistList');
      if (!data.whitelist.length) {
        wlList.innerHTML = '<span class="muted">Whitelist boşdur.</span>';
      } else {
        wlList.innerHTML = data.whitelist.map(w =>
          '<div class="list-item">' +
            '<div><b>' + escapeHtml(w.discordTag || w.discordUserId) + '</b><br/><span class="muted">' + escapeHtml(w.scriptName) + ' • ' + (w.hwid ? 'HWID Bağlı' : 'HWID Boş') + '</span></div>' +
            '<button class="btn btn-red btn-sm" onclick="deleteWhitelist(\\'' + escapeHtml(w.id) + '\\')">Sil</button>' +
          '</div>'
        ).join('');
      }
    }

    document.getElementById('guildSelectDropdown').onchange = (e) => {
      if (e.target.value) {
        document.getElementById('linkGuildIdInput').value = e.target.value;
      }
    };

    document.getElementById('linkWorkspaceBtn').onclick = async () => {
      const guildId = document.getElementById('linkGuildIdInput').value.trim() || document.getElementById('guildSelectDropdown').value;
      const discordUserId = document.getElementById('linkDiscordIdInput').value.trim();
      const r = await api('/api/workspace/link', {
        method: 'POST',
        body: JSON.stringify({ guildId, discordUserId })
      });
      if (r.ok) {
        document.getElementById('linkGuildIdInput').value = '';
        initialInputsLoaded = false;
        showToast('Sunucu bağlandı: ' + (r.guildName || guildId));
        refreshAll();
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    document.getElementById('savePanelCfgBtn').onclick = async () => {
      const embedColor = document.getElementById('cfgEmbedColor').value.trim() || '#5865F2';
      const title = document.getElementById('cfgTitle').value.trim();
      const description = document.getElementById('cfgDescription').value.trim();
      const redeemLabel = document.getElementById('cfgRedeemLabel').value.trim() || '🔑 Redeem Key';
      const getScriptLabel = document.getElementById('cfgGetScriptLabel').value.trim() || '📜 Get Script';
      const resetHwidLabel = document.getElementById('cfgResetHwidLabel').value.trim() || '🔄 Reset HWID';
      const statsLabel = document.getElementById('cfgStatsLabel').value.trim() || '📊 Stats';
      const r = await api('/api/panel-config', {
        method: 'POST',
        body: JSON.stringify({
          embedColor,
          title,
          description,
          redeemLabel,
          getScriptLabel,
          resetHwidLabel,
          statsLabel
        })
      });
      if (r.ok) {
        showToast('Panel dizaynı yadda saxlandı!');
        refreshAll();
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    document.getElementById('scriptFileInput').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        document.getElementById('scriptCodeInput').value = content;
        if (!document.getElementById('scriptNameInput').value.trim()) {
          document.getElementById('scriptNameInput').value = file.name.replace(/\.(lua|txt)$/i, '');
        }
        showToast('Fayl yükləndi (' + file.name + ')');
      };
      reader.readAsText(file);
    };

    document.getElementById('createScriptBtn').onclick = async () => {
      const name = document.getElementById('scriptNameInput').value.trim();
      let code = document.getElementById('scriptCodeInput').value;
      const fileInput = document.getElementById('scriptFileInput');
      if ((!code || !code.trim()) && fileInput && fileInput.files && fileInput.files[0]) {
        code = await fileInput.files[0].text();
        document.getElementById('scriptCodeInput').value = code;
      }
      const obfuscate = document.getElementById('autoObfCheckbox').checked;
      const r = await api('/api/scripts', {
        method: 'POST',
        body: JSON.stringify({ name, code, obfuscate, obfuscateLevel: 'high' })
      });
      if (r.ok) {
        document.getElementById('scriptNameInput').value = '';
        document.getElementById('scriptCodeInput').value = '';
        if (fileInput) fileInput.value = '';
        showToast('Skript yaradıldı!');
        refreshAll();
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    window.obfuscateExisting = async (id) => {
      const r = await api('/api/scripts/' + id + '/obfuscate', {
        method: 'POST',
        body: JSON.stringify({ level: 'high' })
      });
      if (r.ok) {
        showToast('Skript şifrələndi!');
        refreshAll();
      }
    };

    window.openEditScript = (id) => {
      if (!cachedState) return;
      const s = cachedState.scripts.find(x => x.id === id);
      if (!s) return;
      document.getElementById('editScriptId').value = s.id;
      document.getElementById('editScriptName').value = s.name;
      document.getElementById('editScriptCode').value = s.code;
      document.getElementById('editScriptModal').classList.add('open');
    };

    document.getElementById('closeEditScriptBtn').onclick = () => {
      document.getElementById('editScriptModal').classList.remove('open');
    };

    document.getElementById('saveEditScriptBtn').onclick = async () => {
      const id = document.getElementById('editScriptId').value;
      const name = document.getElementById('editScriptName').value.trim();
      const code = document.getElementById('editScriptCode').value;
      const obfuscate = document.getElementById('editScriptObfCheck').checked;
      const r = await api('/api/scripts/' + id, {
        method: 'PUT',
        body: JSON.stringify({ name, code, obfuscate, obfuscateLevel: 'high' })
      });
      if (r.ok) {
        document.getElementById('editScriptModal').classList.remove('open');
        showToast('Skript yeniləndi!');
        refreshAll();
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    window.deleteScript = async (id) => {
      await api('/api/scripts/' + id, { method: 'DELETE' });
      showToast('Skript silindi.');
      refreshAll();
    };

    document.getElementById('runObfuscateBtn').onclick = async () => {
      const code = document.getElementById('obfSourceInput').value;
      const level = document.getElementById('obfLevelSelect').value;
      const r = await api('/api/obfuscate', {
        method: 'POST',
        body: JSON.stringify({ code, level })
      });
      if (r.ok) {
        document.getElementById('obfOutputText').value = r.output;
        showToast('Kod şifrələndi!');
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    document.getElementById('copyObfBtn').onclick = async () => {
      const txt = document.getElementById('obfOutputText').value;
      if (!txt) { showToast('Əvvəlcə kodu şifrələyin.'); return; }
      await navigator.clipboard.writeText(txt);
      showToast('Şifrəli kod kopyalandı!');
    };

    document.getElementById('obfSaveAsScriptBtn').onclick = async () => {
      const name = document.getElementById('obfSaveScriptName').value.trim();
      const rawCode = document.getElementById('obfSourceInput').value;
      const alreadyObf = document.getElementById('obfOutputText').value;
      const level = document.getElementById('obfLevelSelect').value;
      if (!name) {
        showToast('Skript adı yazın.');
        return;
      }
      if (!rawCode.trim() && !alreadyObf.trim()) {
        showToast('Lua kodu daxil edin.');
        return;
      }
      const usePreObf = Boolean(alreadyObf.trim());
      const r = await api('/api/scripts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          code: usePreObf ? alreadyObf : rawCode,
          obfuscate: !usePreObf,
          obfuscateLevel: level,
          preObfuscated: usePreObf
        })
      });
      if (r.ok) {
        document.getElementById('obfSaveScriptName').value = '';
        showToast('Obfuscated skript panelə əlavə olundu!');
        refreshAll();
      } else {
        showToast(r.message || 'Xəta baş verdi');
      }
    };

    document.getElementById('createKeyBtn').onclick = async () => {
      const scriptId = document.getElementById('keyScriptSelect').value;
      const duration = document.getElementById('keyDurationInput').value.trim();
      const amount = Number(document.getElementById('keyAmountInput').value) || 1;
      const r = await api('/api/keys', {
        method: 'POST',
        body: JSON.stringify({ scriptId, duration, amount })
      });
      if (r.ok) {
        showToast(r.keys.length + ' key yaradıldı!');
        refreshAll();
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    window.deleteKey = async (k) => {
      await api('/api/keys/' + encodeURIComponent(k), { method: 'DELETE' });
      showToast('Key silindi.');
      refreshAll();
    };

    document.getElementById('addWhitelistBtn').onclick = async () => {
      const discordUserId = document.getElementById('wlUserIdInput').value.trim();
      const scriptId = document.getElementById('wlScriptSelect').value;
      const duration = document.getElementById('wlDurationInput').value.trim();
      const r = await api('/api/whitelist', {
        method: 'POST',
        body: JSON.stringify({ discordUserId, scriptId, duration })
      });
      if (r.ok) {
        document.getElementById('wlUserIdInput').value = '';
        showToast('Whitelist əlavə edildi!');
        refreshAll();
      } else {
        showToast(r.message || 'Xəta');
      }
    };

    window.deleteWhitelist = async (id) => {
      await api('/api/whitelist/' + id, { method: 'DELETE' });
      showToast('Whitelist silindi.');
      refreshAll();
    };

    refreshAll();
    setInterval(refreshAll, 15000);
  </script>
</body>
</html>`);
});

app.listen(PORT, async () => {
  console.log(`SADO PROTECT running on port ${PORT}`);
  scheduleBotWatchdog();
  const bootToken = resolveBotToken(state.botToken);
  if (bootToken) {
    await startDiscordBot(bootToken).catch(err => {
      console.error('Background bot startup error:', err.message);
    });
  }
});
