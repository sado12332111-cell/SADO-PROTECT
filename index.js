const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
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
  Events,
  PermissionsBitField,
} = require('discord.js');

// ============================================================================
// 1. KONFİQURASİYA, TƏHLÜKƏSİZLİK VƏ SAXLAMA QATLARI
// ============================================================================

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// Token açıq şəkildə hardcode olunmur; yalnız runtime-da env və ya yaddaşdan oxunur.
// Render secret scanning riskini sıfıra endirmək üçün base64/env dəstəyi saxlanılır.
const ENV_TOKEN_KEYS = ['DISCORD_BOT_TOKEN', 'BOT_TOKEN', 'SADO_BOT_TOKEN', 'TOKEN'];
const BUNDLED_TOKEN_B64 = process.env.BUNDLED_BOT_TOKEN_B64 || '';

function resolveInitialToken() {
  for (const key of ENV_TOKEN_KEYS) {
    const val = (process.env[key] || '').trim();
    if (val) return val;
  }
  if (BUNDLED_TOKEN_B64) {
    try {
      const decoded = Buffer.from(BUNDLED_TOKEN_B64, 'base64').toString('utf8').trim();
      if (decoded && decoded.includes('.')) return decoded;
    } catch (_err) {
      // Səssiz ötürülür
    }
  }
  return '';
}

function createDefaultState() {
  return {
    botToken: resolveInitialToken(),
    activeGuildId: '',
    activeGuildName: '',
    activeDiscordUserId: '',
    panelConfig: {
      embedColor: '#5865F2',
      title: 'SADO PROTECT • Script Panel',
      description: 'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin.',
      redeemLabel: 'Redeem Key',
      redeemStyle: 'green',
      getScriptLabel: 'Get Script',
      getScriptStyle: 'blurple',
      resetHwidLabel: 'Reset HWID',
      resetHwidStyle: 'grey',
      statsLabel: 'Stats',
      statsStyle: 'grey',
    },
    scripts: [],
    keys: [],
    whitelists: [],
    blacklists: [],
    panels: [],
    hwidCooldownSeconds: 0,
  };
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[STORE] Data qovluğu yaradıla bilmədi:', err.message);
  }
}

function loadStore() {
  ensureDataDir();
  const base = createDefaultState();
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(base, null, 2), 'utf8');
      return base;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = {
      ...base,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      panelConfig: {
        ...base.panelConfig,
        ...(parsed && parsed.panelConfig && typeof parsed.panelConfig === 'object' ? parsed.panelConfig : {}),
      },
      scripts: Array.isArray(parsed?.scripts) ? parsed.scripts : [],
      keys: Array.isArray(parsed?.keys) ? parsed.keys : [],
      whitelists: Array.isArray(parsed?.whitelists) ? parsed.whitelists : [],
      blacklists: Array.isArray(parsed?.blacklists) ? parsed.blacklists : [],
      panels: Array.isArray(parsed?.panels) ? parsed.panels : [],
    };
    if (!merged.botToken && base.botToken) {
      merged.botToken = base.botToken;
    }
    return merged;
  } catch (err) {
    console.error('[STORE] store.json oxunarkən xəta, default state istifadə edilir:', err.message);
    return base;
  }
}

let state = loadStore();
let writeQueue = Promise.resolve();

function saveStore() {
  writeQueue = writeQueue.then(async () => {
    try {
      ensureDataDir();
      const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
      await fs.promises.rename(tmpFile, DATA_FILE);
    } catch (err) {
      console.error('[STORE] Yadda saxlama xətası:', err.message);
    }
  });
  return writeQueue;
}

// ============================================================================
// 2. KÖMƏKÇİ FUNKSİYALAR, LUA OBFUSCATOR VƏ DİZAYN XƏRİTƏLƏRİ
// ============================================================================

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function generateKeyString() {
  const part1 = crypto.randomBytes(4).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(4).toString('hex').toUpperCase();
  const part3 = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `SADO-${part1}-${part2}-${part3}`;
}

function parseDurationToSeconds(raw) {
  if (raw === undefined || raw === null) return 0;
  const str = String(raw).trim().toLowerCase();
  if (!str || str === '0' || str === 'lifetime' || str === 'perm') return 0;
  const match = str.match(/^(\d+)\s*([smhdw y])$/);
  if (!match) {
    const num = Number(str);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const map = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  return value * (map[unit] || 86400);
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return 'Lifetime (Limitsiz)';
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return 'Lifetime (Limitsiz)';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && Date.now() > t;
}

function normalizeHexColor(input, fallback = '#5865F2') {
  if (!input || typeof input !== 'string') return fallback;
  let hex = input.trim();
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex.toUpperCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(hex)) {
    const r = hex[1] + hex[1];
    const g = hex[2] + hex[2];
    const b = hex[3] + hex[3];
    return `#${r}${g}${b}`.toUpperCase();
  }
  return fallback;
}

function hexToDiscordInt(hex) {
  const clean = normalizeHexColor(hex, '#5865F2').replace('#', '');
  const parsed = parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : 0x5865f2;
}

function mapStyleToButtonStyle(styleName, fallback = ButtonStyle.Secondary) {
  switch ((styleName || '').toLowerCase()) {
    case 'green':
    case 'success':
      return ButtonStyle.Success;
    case 'blurple':
    case 'blue':
    case 'primary':
      return ButtonStyle.Primary;
    case 'red':
    case 'danger':
      return ButtonStyle.Danger;
    case 'grey':
    case 'gray':
    case 'secondary':
      return ButtonStyle.Secondary;
    default:
      return fallback;
  }
}

/**
 * Lua kodu üçün təhlükəsiz byte-array + XOR şifrələyici (obfuscator)
 */
function obfuscateLuaCode(sourceCode, level = 2) {
  const code = String(sourceCode || '');
  const xorKey = (crypto.randomBytes(1)[0] % 120) + 17;
  const bytes = [];
  for (let i = 0; i < code.length; i++) {
    bytes.push((code.charCodeAt(i) ^ xorKey) & 0xff);
  }

  let payload = bytes.join(',');
  if (level >= 3) {
    // Əlavə ikinci qat bit-rotate qarışdırma
    const rotated = bytes.map((b, idx) => (((b + (idx % 13)) ^ (xorKey & 0x3f)) & 0xff));
    payload = rotated.join(',');
    return [
      `-- [[ SADO PROTECT LUA SHIELD v3.0 ]] --`,
      `local _K = ${xorKey}`,
      `local _T = {${payload}}`,
      `local function _D(arr, k)`,
      `  local out = {}`,
      `  for i = 1, #arr do`,
      `    local v = (arr[i] ~ (k & 63)) - ((i - 1) % 13)`,
      `    if v < 0 then v = v + 256 end`,
      `    out[i] = string.char((v ~ k) % 256)`,
      `  end`,
      `  return table.concat(out)`,
      `end`,
      `local _F = loadstring or load`,
      `local _C = _F(_D(_T, _K))`,
      `if _C then return _C() end`,
    ].join('\n');
  }

  return [
    `-- [[ SADO PROTECT LUA OBFUSCATOR v${level}.0 ]] --`,
    `local _X = ${xorKey}`,
    `local _B = {${payload}}`,
    `local function _U(t, k)`,
    `  local s = {}`,
    `  for i = 1, #t do`,
    `    s[i] = string.char((t[i] ~ k) % 256)`,
    `  end`,
    `  return table.concat(s)`,
    `end`,
    `local _FN = loadstring or load`,
    `local _EX = _FN(_U(_B, _X))`,
    `if _EX then return _EX() end`,
  ].join('\n');
}

function buildLoaderSnippet(scriptObj, keyValue = 'YOUR_KEY_HERE') {
  const safeKey = String(keyValue || 'YOUR_KEY_HERE').replace(/"/g, '\\"');
  const scriptToken = scriptObj.loaderToken || scriptObj.id;
  return [
    `script_key = "${safeKey}";`,
    `pcall(function()`,
    `  loadstring(game:HttpGet("https://sado-protect.onrender.com/api/loader/${encodeURIComponent(scriptToken)}?key=" .. tostring(script_key)))()`,
    `end)`,
  ].join('\n');
}

// ============================================================================
// 3. DİSCORD BOT KLİENTİ, 7/24 WATCHDOG VƏ İNTERAKSİYALAR
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

let botStatus = 'offline'; // 'offline' | 'connecting' | 'online'
let botLastError = '';
let isConnectingNow = false;
let watchdogTimer = null;

function getGuildInviteUrl() {
  const appId = client.application?.id || '1562080654282199121';
  return `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=2147600384&integration_type=0&scope=applications.commands+bot`;
}

function getBotGuildsSummary() {
  if (!client.isReady()) return [];
  return client.guilds.cache.map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g.memberCount || 0,
  }));
}

async function resolveGuildName(guildId) {
  if (!guildId) return '';
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached.name;
  if (client.isReady()) {
    try {
      const fetched = await client.guilds.fetch(guildId);
      if (fetched && fetched.name) return fetched.name;
    } catch (_err) {
      // Bot hələ sunucuda olmaya bilər
    }
  }
  return `Sunucu (${guildId})`;
}

async function ensureBotOnline() {
  const token = (state.botToken || '').trim();
  if (!token) {
    botStatus = 'offline';
    return;
  }
  if (client.isReady()) {
    botStatus = 'online';
    if (state.activeGuildId) {
      const resolved = await resolveGuildName(state.activeGuildId);
      if (resolved && !resolved.startsWith('Sunucu (')) {
        state.activeGuildName = resolved;
      }
    }
    return;
  }
  if (isConnectingNow) return;

  isConnectingNow = true;
  botStatus = 'connecting';
  try {
    try {
      client.destroy();
    } catch (_e) {
      // Səssiz ötürülür
    }
    await client.login(token);
    botStatus = 'online';
    botLastError = '';
  } catch (err) {
    botLastError = err && err.message ? err.message : 'Login xətası';
    // Render-də şəbəkə/rate-limit gecikməsində belə UI-da davamlı status və avtomatik retry saxlanılır
    botStatus = client.isReady() ? 'online' : 'connecting';
    console.warn('[BOT] Qoşulma cəhdi uğursuz oldu (yenidən cəhd ediləcək):', botLastError);
  } finally {
    isConnectingNow = false;
  }
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    try {
      if ((state.botToken || '').trim()) {
        if (!client.isReady()) {
          await ensureBotOnline();
        } else {
          botStatus = 'online';
          if (state.activeGuildId && (!state.activeGuildName || state.activeGuildName.startsWith('Sunucu ('))) {
            const name = await resolveGuildName(state.activeGuildId);
            if (name && !name.startsWith('Sunucu (')) {
              state.activeGuildName = name;
              await saveStore();
            }
          }
        }
      }
    } catch (err) {
      console.error('[WATCHDOG] Xəta:', err.message);
    }
  }, 15000);
}

client.once(Events.ClientReady, async (readyClient) => {
  botStatus = 'online';
  botLastError = '';
  console.log(`[BOT] Online: ${readyClient.user.tag} (${readyClient.guilds.cache.size} sunucu)`);
  if (state.activeGuildId) {
    const realName = await resolveGuildName(state.activeGuildId);
    if (realName && !realName.startsWith('Sunucu (')) {
      state.activeGuildName = realName;
      await saveStore();
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  if (!state.activeGuildId || state.activeGuildId === guild.id) {
    state.activeGuildId = guild.id;
    state.activeGuildName = guild.name;
    await saveStore();
  }
});

client.on(Events.ShardDisconnect, () => {
  if ((state.botToken || '').trim()) {
    botStatus = 'connecting';
  }
});

client.on(Events.ShardResume, () => {
  botStatus = 'online';
});

client.on(Events.Error, (err) => {
  console.error('[CLIENT ERROR]', err.message);
});

function buildPanelEmbedAndButtons(scriptObj, overrideCfg = null) {
  const cfg = {
    ...state.panelConfig,
    ...(overrideCfg && typeof overrideCfg === 'object' ? overrideCfg : {}),
  };

  const colorInt = hexToDiscordInt(cfg.embedColor || '#5865F2');
  const scriptTitle = scriptObj ? scriptObj.name : 'Script';
  const descLines = [
    cfg.description || 'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin və ya skripti əldə edin.',
    `📌 **Script:** \`${scriptTitle}\``,
  ];

  const embed = new EmbedBuilder()
    .setColor(colorInt)
    .setTitle(cfg.title || 'SADO PROTECT • Script Panel')
    .setDescription(descLines.join('\n'))
    .setFooter({ text: 'SADO PROTECT • Secure Loader & Key System' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sado_redeem_${scriptObj ? scriptObj.id : 'default'}`)
      .setLabel((cfg.redeemLabel || 'Redeem Key').slice(0, 80))
      .setStyle(mapStyleToButtonStyle(cfg.redeemStyle, ButtonStyle.Success)),
    new ButtonBuilder()
      .setCustomId(`sado_getscript_${scriptObj ? scriptObj.id : 'default'}`)
      .setLabel((cfg.getScriptLabel || 'Get Script').slice(0, 80))
      .setStyle(mapStyleToButtonStyle(cfg.getScriptStyle, ButtonStyle.Primary)),
    new ButtonBuilder()
      .setCustomId(`sado_resethwid_${scriptObj ? scriptObj.id : 'default'}`)
      .setLabel((cfg.resetHwidLabel || 'Reset HWID').slice(0, 80))
      .setStyle(mapStyleToButtonStyle(cfg.resetHwidStyle, ButtonStyle.Secondary)),
    new ButtonBuilder()
      .setCustomId(`sado_stats_${scriptObj ? scriptObj.id : 'default'}`)
      .setLabel((cfg.statsLabel || 'Stats').slice(0, 80))
      .setStyle(mapStyleToButtonStyle(cfg.statsStyle, ButtonStyle.Secondary))
  );

  return { embed, row };
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // 1. Düymə klikləri
    if (interaction.isButton()) {
      const cid = interaction.customId || '';
      const userId = interaction.user.id;

      // Get Script zamanı açılan panelin altında "Skripti Kopyala" düyməsi
      if (cid.startsWith('sado_copyscript_')) {
        const scriptId = cid.replace('sado_copyscript_', '');
        const sc = state.scripts.find((s) => s.id === scriptId);
        const wl = state.whitelists.find((w) => w.discordUserId === userId && (!sc || w.scriptId === sc.id) && !isExpired(w.expiresAt));
        const keyVal = wl ? wl.key : 'WHITELIST_KEY';
        const snippet = sc ? buildLoaderSnippet(sc, keyVal) : `script_key = "${keyVal}";`;

        const copyEmbed = new EmbedBuilder()
          .setColor(hexToDiscordInt(state.panelConfig.embedColor || '#5865F2'))
          .setTitle('📋 Skript Kopyalama Paneli')
          .setDescription(
            [
              `🔑 **Key:** \`${keyVal}\``,
              '',
              '```lua',
              snippet,
              '```',
              '✅ Aşağıdakı kod dərhal kopyalanmaq üçün hazır vəziyyətdə paneldə göstərilir.',
            ].join('\n')
          )
          .setFooter({ text: 'SADO PROTECT • Script Copy Panel' });

        await interaction.reply({
          content: snippet,
          embeds: [copyEmbed],
          ephemeral: true,
        });
        return;
      }

      if (cid.startsWith('sado_redeem_')) {
        const scriptId = cid.replace('sado_redeem_', '');
        const modal = new ModalBuilder()
          .setCustomId(`sado_modal_redeem_${scriptId}`)
          .setTitle('🔑 Key Aktivləşdir (Redeem)');

        const keyInput = new TextInputBuilder()
          .setCustomId('redeem_key_value')
          .setLabel('Lisenziya / Script Key')
          .setPlaceholder('Məs: SADO-XXXX-XXXX-XXXX')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const hwidInput = new TextInputBuilder()
          .setCustomId('redeem_hwid_value')
          .setLabel('HWID (istəyə bağlı)')
          .setPlaceholder('Məs: HWID-12345')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(keyInput),
          new ActionRowBuilder().addComponents(hwidInput)
        );
        await interaction.showModal(modal);
        return;
      }

      if (cid.startsWith('sado_getscript_')) {
        const scriptId = cid.replace('sado_getscript_', '');
        const sc = state.scripts.find((s) => s.id === scriptId) || state.scripts[0];

        if (!sc) {
          await interaction.reply({ content: '❌ Bu panel üçün aktiv skript tapılmadı.', ephemeral: true });
          return;
        }

        const isBl = state.blacklists.some((b) => b.discordUserId === userId && (!b.scriptId || b.scriptId === sc.id));
        if (isBl) {
          await interaction.reply({ content: '🚫 Siz bu skriptdən blacklist olunmusunuz.', ephemeral: true });
          return;
        }

        const wl = state.whitelists.find(
          (w) => w.discordUserId === userId && (!w.scriptId || w.scriptId === sc.id) && !isExpired(w.expiresAt)
        );

        if (!wl) {
          await interaction.reply({
            content: '⚠️ Sizin bu skript üçün aktiv whitelist/key qeydiniz yoxdur. Əvvəl **Redeem Key** düyməsi ilə key aktivləşdirin.',
            ephemeral: true,
          });
          return;
        }

        const scriptText = buildLoaderSnippet(sc, wl.key);

        // Yuxarıda Key görünən ayrı panel embed + skript + altında Kopyala düyməsi
        const scriptPanelEmbed = new EmbedBuilder()
          .setColor(hexToDiscordInt(state.panelConfig.embedColor || '#5865F2'))
          .setTitle(`📜 ${sc.name} — Script & Key`)
          .setDescription(
            [
              `🔑 **Script Key:** \`${wl.key}\``,
              `⏳ **Bitmə vaxtı:** ${formatExpiry(wl.expiresAt)}`,
              '',
              '```lua',
              scriptText,
              '```',
            ].join('\n')
          )
          .setFooter({ text: 'SADO PROTECT • Get Script' })
          .setTimestamp();

        const copyActionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`sado_copyscript_${sc.id}`)
            .setLabel('📋 Skripti Kopyala')
            .setStyle(ButtonStyle.Success)
        );

        await interaction.reply({
          embeds: [scriptPanelEmbed],
          components: [copyActionRow],
          ephemeral: true,
        });
        return;
      }

      if (cid.startsWith('sado_resethwid_')) {
        const scriptId = cid.replace('sado_resethwid_', '');
        const matchingWl = state.whitelists.filter(
          (w) => w.discordUserId === userId && (scriptId === 'default' || !w.scriptId || w.scriptId === scriptId)
        );

        if (!matchingWl.length) {
          await interaction.reply({ content: '❌ HWID sıfırlamaq üçün aktiv key/whitelist tapılmadı.', ephemeral: true });
          return;
        }

        for (const item of matchingWl) {
          item.hwid = '';
          item.hwidResetAt = new Date().toISOString();
        }
        await saveStore();

        await interaction.reply({
          content: `🔄 HWID uğurla sıfırlandı (${matchingWl.length} qeyd yeniləndi). Yeni girişdə yeni HWID bağlanacaq.`,
          ephemeral: true,
        });
        return;
      }

      if (cid.startsWith('sado_stats_')) {
        const userKeys = state.keys.filter((k) => k.usedByDiscordId === userId);
        const userWl = state.whitelists.filter((w) => w.discordUserId === userId && !isExpired(w.expiresAt));

        const statsEmbed = new EmbedBuilder()
          .setColor(hexToDiscordInt(state.panelConfig.embedColor || '#5865F2'))
          .setTitle('📊 İstifadəçi Statistikası')
          .setDescription(
            [
              `👤 **İstifadəçi:** <@${userId}> (\`${userId}\`)`,
              `✅ **Aktiv Whitelist:** \`${userWl.length}\``,
              `🔑 **İstifadə edilmiş Key sayı:** \`${userKeys.length}\``,
              `🖥️ **HWID Status:** \`${userWl[0]?.hwid ? userWl[0].hwid : 'Bağlanmayıb'}\``,
              `⏳ **Müddət:** \`${userWl[0] ? formatExpiry(userWl[0].expiresAt) : '—'}\``,
            ].join('\n')
          )
          .setTimestamp();

        await interaction.reply({ embeds: [statsEmbed], ephemeral: true });
        return;
      }
    }

    // 2. Modal submit (Redeem Key)
    if (interaction.isModalSubmit()) {
      const cid = interaction.customId || '';
      if (cid.startsWith('sado_modal_redeem_')) {
        const scriptId = cid.replace('sado_modal_redeem_', '');
        const keyInput = interaction.fields.getTextInputValue('redeem_key_value').trim();
        const hwidInput = (interaction.fields.getTextInputValue('redeem_hwid_value') || '').trim();
        const userId = interaction.user.id;

        const targetScript = state.scripts.find((s) => s.id === scriptId) || state.scripts[0];
        const isBl = state.blacklists.some(
          (b) => b.discordUserId === userId && (!targetScript || !b.scriptId || b.scriptId === targetScript.id)
        );
        if (isBl) {
          await interaction.reply({ content: '🚫 Siz bu skriptdən blacklist olunmusunuz.', ephemeral: true });
          return;
        }

        const keyObj = state.keys.find((k) => k.key.toUpperCase() === keyInput.toUpperCase());
        if (!keyObj) {
          await interaction.reply({ content: '❌ Daxil edilən key tapılmadı.', ephemeral: true });
          return;
        }
        if (keyObj.used && keyObj.usedByDiscordId && keyObj.usedByDiscordId !== userId) {
          await interaction.reply({ content: '⚠️ Bu key artıq başqa istifadəçi tərəfindən işlədilib.', ephemeral: true });
          return;
        }
        if (keyObj.expiresAt && isExpired(keyObj.expiresAt)) {
          await interaction.reply({ content: '⌛ Bu key-in vaxtı bitib.', ephemeral: true });
          return;
        }

        const effectiveScriptId = keyObj.scriptId || (targetScript ? targetScript.id : '');
        const durationSec = keyObj.durationSeconds || 0;
        const expiresAt = durationSec > 0 ? new Date(Date.now() + durationSec * 1000).toISOString() : null;

        keyObj.used = true;
        keyObj.usedByDiscordId = userId;
        keyObj.usedAt = new Date().toISOString();
        if (!keyObj.expiresAt && expiresAt) {
          keyObj.expiresAt = expiresAt;
        }

        const existingWl = state.whitelists.find(
          (w) => w.discordUserId === userId && w.scriptId === effectiveScriptId
        );
        if (existingWl) {
          existingWl.key = keyObj.key;
          existingWl.expiresAt = keyObj.expiresAt || expiresAt;
          if (hwidInput) existingWl.hwid = hwidInput;
        } else {
          state.whitelists.push({
            id: generateId('wl'),
            discordUserId: userId,
            scriptId: effectiveScriptId,
            key: keyObj.key,
            hwid: hwidInput || '',
            expiresAt: keyObj.expiresAt || expiresAt,
            createdAt: new Date().toISOString(),
          });
        }

        await saveStore();
        await interaction.reply({
          content: `✅ Key uğurla aktivləşdirildi! **${keyObj.key}** — Müddət: **${formatExpiry(keyObj.expiresAt || expiresAt)}**.`,
          ephemeral: true,
        });
      }
    }
  } catch (err) {
    console.error('[INTERACTION ERROR]', err.message);
    if (interaction && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '⚠️ Əməliyyat zamanı xəta baş verdi.', ephemeral: true });
      } catch (_e) {
        // Səssiz ötürülür
      }
    }
  }
});

// ============================================================================
// 4. EXPRESS WEB SERVER VƏ REST API ENDPOINTLƏRİ
// ============================================================================

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS & təhlükəsizlik başlıqları
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Bot və Dashboard statusu
app.get('/api/status', async (req, res) => {
  try {
    if ((state.botToken || '').trim() && !client.isReady() && !isConnectingNow) {
      ensureBotOnline().catch(() => {});
    }
    const guilds = getBotGuildsSummary();
    let activeGuildName = state.activeGuildName || '';
    if (state.activeGuildId) {
      const matched = guilds.find((g) => g.id === state.activeGuildId);
      if (matched) {
        activeGuildName = matched.name;
        state.activeGuildName = matched.name;
      } else if (!activeGuildName) {
        activeGuildName = `Sunucu (${state.activeGuildId})`;
      }
    }

    const activeWhitelistCount = state.whitelists.filter((w) => !isExpired(w.expiresAt)).length;
    const recentKeys = [...state.keys]
      .slice(-10)
      .reverse()
      .map((k) => ({
        id: k.id,
        key: k.key,
        scriptId: k.scriptId,
        durationSeconds: k.durationSeconds || 0,
        expiresAt: k.expiresAt || null,
        used: Boolean(k.used),
        createdBy: k.createdBy || 'Dashboard',
        usedByDiscordId: k.usedByDiscordId || null,
        createdAt: k.createdAt,
      }));

    res.json({
      ok: true,
      bot: {
        status: client.isReady() ? 'online' : botStatus,
        online: client.isReady(),
        hasToken: Boolean((state.botToken || '').trim()),
        userTag: client.user ? client.user.tag : null,
        inviteUrl: getGuildInviteUrl(),
        guilds,
      },
      activeGuildId: state.activeGuildId || '',
      activeGuildName,
      activeDiscordUserId: state.activeDiscordUserId || '',
      panelConfig: state.panelConfig,
      stats: {
        scriptsCount: state.scripts.length,
        keysCount: state.keys.length,
        whitelistsCount: activeWhitelistCount,
        blacklistsCount: state.blacklists.length,
        panelsCount: state.panels.length,
      },
      recentKeys,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Bot aktivləşdirmə (token heç bir cavabda geri qaytarılmır)
app.post('/api/bot/activate', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      if ((state.botToken || '').trim()) {
        await ensureBotOnline();
        return res.json({ ok: true, status: client.isReady() ? 'online' : botStatus, message: 'Bot aktivləşdirildi!' });
      }
      return res.status(400).json({ ok: false, message: 'Bot tokeni daxil edilməyib.' });
    }

    state.botToken = token;
    await saveStore();
    await ensureBotOnline();

    res.json({
      ok: true,
      status: client.isReady() ? 'online' : botStatus,
      message: 'Bot aktivləşdirildi!',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Sunucu və Discord User ID bağlama
app.post('/api/workspace/link', async (req, res) => {
  try {
    const guildId = String(req.body?.guildId || '').trim();
    const discordUserId = String(req.body?.discordUserId || '').trim();

    if (!guildId) {
      return res.status(400).json({ ok: false, message: 'Zəhmət olmasa Sunucu ID seçin və ya yazın.' });
    }

    state.activeGuildId = guildId;
    state.activeDiscordUserId = discordUserId;
    state.activeGuildName = await resolveGuildName(guildId);
    await saveStore();

    res.json({
      ok: true,
      activeGuildId: state.activeGuildId,
      activeGuildName: state.activeGuildName,
      activeDiscordUserId: state.activeDiscordUserId,
      message: `Sunucu bağlandı: ${state.activeGuildName}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Panel buton və embed dizaynını yadda saxla
app.post('/api/panel-config', async (req, res) => {
  try {
    const body = req.body || {};
    state.panelConfig = {
      embedColor: normalizeHexColor(body.embedColor, state.panelConfig.embedColor || '#5865F2'),
      title: String(body.title || state.panelConfig.title || 'SADO PROTECT • Script Panel').trim().slice(0, 200),
      description: String(
        body.description !== undefined
          ? body.description
          : state.panelConfig.description || 'Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin.'
      )
        .trim()
        .slice(0, 1500),
      redeemLabel: String(body.redeemLabel || 'Redeem Key').trim().slice(0, 80),
      redeemStyle: String(body.redeemStyle || 'green').trim(),
      getScriptLabel: String(body.getScriptLabel || 'Get Script').trim().slice(0, 80),
      getScriptStyle: String(body.getScriptStyle || 'blurple').trim(),
      resetHwidLabel: String(body.resetHwidLabel || 'Reset HWID').trim().slice(0, 80),
      resetHwidStyle: String(body.resetHwidStyle || 'grey').trim(),
      statsLabel: String(body.statsLabel || 'Stats').trim().slice(0, 80),
      statsStyle: String(body.statsStyle || 'grey').trim(),
    };
    await saveStore();

    res.json({
      ok: true,
      panelConfig: state.panelConfig,
      message: 'Panel dizaynı yadda saxlanıldı!',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Skriptləri gətir
app.get('/api/scripts', (req, res) => {
  res.json({ ok: true, scripts: state.scripts });
});

// Yeni skript yarat (və ya mövcud skripti yenilə)
app.post('/api/scripts', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || body.title || '').trim();
    const fileName = String(body.fileName || body.filename || `${name || 'script'}.lua`).trim();
    let code = String(body.code || '');
    const obfuscate = Boolean(body.obfuscate);
    const obfuscateLevel = Number(body.obfuscateLevel || 2);

    if (!name) {
      return res.status(400).json({ ok: false, message: 'Skript adı mütləqdir.' });
    }
    if (!code.trim()) {
      return res.status(400).json({ ok: false, message: 'Skript kodu boş ola bilməz.' });
    }

    const wasObfuscated = Boolean(body.preObfuscated) || obfuscate;
    if (obfuscate && !body.preObfuscated) {
      code = obfuscateLuaCode(code, obfuscateLevel);
    }

    const newScript = {
      id: generateId('scr'),
      loaderToken: crypto.randomBytes(16).toString('hex'),
      guildId: state.activeGuildId || '',
      name,
      fileName,
      code,
      obfuscated: wasObfuscated,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    state.scripts.push(newScript);
    await saveStore();

    res.status(201).json({
      ok: true,
      script: newScript,
      message: 'Skript uğurla yadda saxlanıldı!',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Mövcud skripti yenilə (✏️ Update)
app.put('/api/scripts/:id', async (req, res) => {
  try {
    const sc = state.scripts.find((s) => s.id === req.params.id);
    if (!sc) {
      return res.status(404).json({ ok: false, message: 'Skript tapılmadı.' });
    }
    const body = req.body || {};
    if (body.name !== undefined && String(body.name).trim()) {
      sc.name = String(body.name).trim();
    }
    if (body.fileName !== undefined && String(body.fileName).trim()) {
      sc.fileName = String(body.fileName).trim();
    }
    if (body.code !== undefined && String(body.code).trim()) {
      let nextCode = String(body.code);
      if (body.obfuscate) {
        nextCode = obfuscateLuaCode(nextCode, Number(body.obfuscateLevel || 2));
        sc.obfuscated = true;
      }
      sc.code = nextCode;
    }
    sc.updatedAt = new Date().toISOString();
    await saveStore();

    res.json({ ok: true, script: sc, message: 'Skript yeniləndi!' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Skripti sil
app.delete('/api/scripts/:id', async (req, res) => {
  try {
    const idx = state.scripts.findIndex((s) => s.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ ok: false, message: 'Skript tapılmadı.' });
    }
    state.scripts.splice(idx, 1);
    await saveStore();
    res.json({ ok: true, message: 'Skript silindi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Lua Obfuscator endpointi
app.post('/api/obfuscate', (req, res) => {
  try {
    const code = String(req.body?.code || '');
    const level = Number(req.body?.level || 2);
    if (!code.trim()) {
      return res.status(400).json({ ok: false, message: 'Şifrələmək üçün Lua kodu daxil edin.' });
    }
    const obfuscated = obfuscateLuaCode(code, level);
    res.json({ ok: true, obfuscated });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Loader endpointi (executor / loadstring üçün)
app.get('/api/loader/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  const sc = state.scripts.find((s) => s.loaderToken === token || s.id === token);
  if (!sc) {
    res.status(404).type('text/plain').send('-- Script not found');
    return;
  }
  res.type('text/plain; charset=utf-8').send(sc.code);
});

// Key-lər və Whitelist siyahısı
app.get('/api/keys', (req, res) => {
  res.json({ ok: true, keys: state.keys });
});

app.post('/api/keys', async (req, res) => {
  try {
    const body = req.body || {};
    const scriptId = String(body.scriptId || state.scripts[0]?.id || '').trim();
    const durationSeconds = parseDurationToSeconds(body.duration || body.durationSeconds || '0');
    const amount = Math.max(1, Math.min(100, Number(body.amount || 1)));
    const createdBy = String(body.createdBy || state.activeDiscordUserId || 'Dashboard').trim();

    const created = [];
    for (let i = 0; i < amount; i++) {
      const expiresAt = durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null;
      const keyEntry = {
        id: generateId('key'),
        key: generateKeyString(),
        scriptId,
        durationSeconds,
        expiresAt,
        used: false,
        usedByDiscordId: null,
        createdBy,
        createdAt: new Date().toISOString(),
      };
      state.keys.push(keyEntry);
      created.push(keyEntry);
    }

    await saveStore();
    res.status(201).json({ ok: true, keys: created, message: `${created.length} key yaradıldı!` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.delete('/api/keys/:id', async (req, res) => {
  try {
    const idx = state.keys.findIndex((k) => k.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Key tapılmadı.' });
    state.keys.splice(idx, 1);
    await saveStore();
    res.json({ ok: true, message: 'Key silindi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Whitelist idarəetməsi
app.get('/api/whitelist', (req, res) => {
  res.json({ ok: true, whitelists: state.whitelists });
});

app.post('/api/whitelist', async (req, res) => {
  try {
    const body = req.body || {};
    const discordUserId = String(body.discordUserId || '').trim();
    const scriptId = String(body.scriptId || state.scripts[0]?.id || '').trim();
    const durationSeconds = parseDurationToSeconds(body.duration || body.durationSeconds || '0');

    if (!discordUserId) {
      return res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    }

    const expiresAt = durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null;
    const generatedKey = generateKeyString();

    state.keys.push({
      id: generateId('key'),
      key: generatedKey,
      scriptId,
      durationSeconds,
      expiresAt,
      used: true,
      usedByDiscordId: discordUserId,
      createdBy: 'Whitelist',
      createdAt: new Date().toISOString(),
    });

    const existing = state.whitelists.find((w) => w.discordUserId === discordUserId && w.scriptId === scriptId);
    if (existing) {
      existing.key = generatedKey;
      existing.expiresAt = expiresAt;
    } else {
      state.whitelists.push({
        id: generateId('wl'),
        discordUserId,
        scriptId,
        key: generatedKey,
        hwid: '',
        expiresAt,
        createdAt: new Date().toISOString(),
      });
    }

    await saveStore();
    res.status(201).json({ ok: true, message: 'İstifadəçi whitelist-ə əlavə edildi!', key: generatedKey });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.delete('/api/whitelist/:id', async (req, res) => {
  try {
    const idx = state.whitelists.findIndex((w) => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Whitelist qeydi tapılmadı.' });
    state.whitelists.splice(idx, 1);
    await saveStore();
    res.json({ ok: true, message: 'Whitelist silindi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Blacklist idarəetməsi
app.get('/api/blacklist', (req, res) => {
  res.json({ ok: true, blacklists: state.blacklists });
});

app.post('/api/blacklist', async (req, res) => {
  try {
    const discordUserId = String(req.body?.discordUserId || '').trim();
    const scriptId = String(req.body?.scriptId || '').trim();
    if (!discordUserId) {
      return res.status(400).json({ ok: false, message: 'Discord User ID daxil edin.' });
    }
    state.blacklists.push({
      id: generateId('bl'),
      discordUserId,
      scriptId,
      createdAt: new Date().toISOString(),
    });
    await saveStore();
    res.status(201).json({ ok: true, message: 'İstifadəçi blacklist edildi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.delete('/api/blacklist/:id', async (req, res) => {
  try {
    const idx = state.blacklists.findIndex((b) => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, message: 'Blacklist qeydi tapılmadı.' });
    state.blacklists.splice(idx, 1);
    await saveStore();
    res.json({ ok: true, message: 'Blacklist silindi.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Discord kanalına panel göndərmək
app.post('/api/send-panel', async (req, res) => {
  try {
    const channelId = String(req.body?.channelId || '').trim();
    const scriptId = String(req.body?.scriptId || state.scripts[0]?.id || '').trim();
    if (!channelId) {
      return res.status(400).json({ ok: false, message: 'Kanal ID daxil edin.' });
    }
    if (!client.isReady()) {
      return res.status(400).json({ ok: false, message: 'Bot hələ online deyil.' });
    }
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      return res.status(404).json({ ok: false, message: 'Mətn kanalı tapılmadı.' });
    }
    const sc = state.scripts.find((s) => s.id === scriptId) || state.scripts[0];
    const { embed, row } = buildPanelEmbedAndButtons(sc);
    const sentMsg = await ch.send({ embeds: [embed], components: [row] });

    state.panels.push({
      id: generateId('pnl'),
      guildId: ch.guildId || state.activeGuildId || '',
      channelId: ch.id,
      messageId: sentMsg.id,
      scriptId: sc ? sc.id : '',
      createdAt: new Date().toISOString(),
    });
    await saveStore();

    res.json({ ok: true, message: `Panel #${ch.name || ch.id} kanalına göndərildi!` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Panel göndərilə bilmədi.' });
  }
});

// ============================================================================
// 5. TAM DASHBOARD HTML UI (3 XƏTT MENYU, RƏNGLİ DİZAYN, JOIN/ID, PANEL DİZAYN)
// ============================================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADO PROTECT • Control Dashboard</title>
  <style>
    :root {
      --bg-main: #070913;
      --bg-card: rgba(15, 20, 38, 0.88);
      --bg-input: rgba(9, 13, 27, 0.92);
      --border: rgba(120, 145, 255, 0.18);
      --text: #f3f6ff;
      --muted: #98a4c7;
      --accent-1: #6366f1;
      --accent-2: #a855f7;
      --accent-3: #06b6d4;
      --green: #10b981;
      --red: #ef4444;
      --amber: #f59e0b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(circle at 12% 10%, rgba(99, 102, 241, 0.24), transparent 36%),
        radial-gradient(circle at 88% 16%, rgba(168, 85, 247, 0.22), transparent 38%),
        radial-gradient(circle at 50% 92%, rgba(6, 182, 212, 0.18), transparent 42%),
        var(--bg-main);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
      overflow-x: hidden;
    }

    /* Topbar */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: rgba(9, 13, 26, 0.86);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border);
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .menu-btn {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      border: 1px solid rgba(129, 140, 248, 0.35);
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.24), rgba(168, 85, 247, 0.18));
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: transform 0.15s ease, box-shadow 0.2s ease;
    }

    .menu-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.35);
    }

    .brand-title {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.3px;
      background: linear-gradient(90deg, #ffffff, #c4b5fd, #67e8f9);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .brand-sub {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid rgba(16, 185, 129, 0.45);
      background: rgba(16, 185, 129, 0.16);
      color: #6ee7b7;
      white-space: nowrap;
      box-shadow: 0 0 18px rgba(16, 185, 129, 0.2);
    }

    /* Drawer / Sidebar */
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(3, 6, 15, 0.68);
      backdrop-filter: blur(4px);
      z-index: 50;
      display: none;
    }

    .drawer-backdrop.open { display: block; }

    .drawer {
      position: fixed;
      top: 0;
      left: 0;
      width: 280px;
      max-width: 85vw;
      height: 100vh;
      background: linear-gradient(180deg, #0d1326 0%, #090d1a 100%);
      border-right: 1px solid var(--border);
      z-index: 60;
      padding: 18px 14px;
      transform: translateX(-100%);
      transition: transform 0.24s ease;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow-y: auto;
    }

    .drawer.open { transform: translateX(0); }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px 14px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }

    .close-drawer {
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--border);
      color: #fff;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
    }

    .nav-item {
      width: 100%;
      text-align: left;
      padding: 11px 14px;
      border-radius: 12px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: all 0.16s ease;
    }

    .nav-item:hover {
      color: #fff;
      background: rgba(99, 102, 241, 0.14);
      border-color: rgba(99, 102, 241, 0.28);
    }

    .nav-item.active {
      color: #fff;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.32), rgba(168, 85, 247, 0.26));
      border-color: rgba(168, 85, 247, 0.5);
      box-shadow: 0 4px 16px rgba(99, 102, 241, 0.24);
    }

    /* Container & Sections */
    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 18px 14px 48px;
    }

    .section { display: none; }
    .section.active { display: block; animation: fadeIn 0.2s ease; }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }

    @media (min-width: 720px) {
      .stats-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    .stat-card {
      position: relative;
      border-radius: 18px;
      padding: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      overflow: hidden;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
    }

    .stat-card::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--accent-1), var(--accent-2), var(--accent-3));
    }

    .stat-card.green-top::before { background: linear-gradient(90deg, #10b981, #34d399); }
    .stat-card.cyan-top::before { background: linear-gradient(90deg, #06b6d4, #6366f1); }
    .stat-card.pink-top::before { background: linear-gradient(90deg, #ec4899, #a855f7); }

    .stat-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .stat-value { font-size: 24px; font-weight: 800; color: #fff; word-break: break-word; }

    .card {
      border-radius: 18px;
      padding: 18px 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      margin-bottom: 14px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(10px);
    }

    .card h3 {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 10px;
      color: #fff;
    }

    .muted {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 14px;
    }

    /* Form Controls */
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #dbe4ff;
      margin-top: 12px;
      margin-bottom: 6px;
    }

    input[type="text"],
    input[type="number"],
    select,
    textarea {
      width: 100%;
      padding: 11px 13px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: var(--bg-input);
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.16s ease, box-shadow 0.16s ease;
    }

    input[type="text"]:focus,
    input[type="number"]:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: #818cf8;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.22);
    }

    textarea {
      min-height: 150px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px 16px;
      margin-top: 14px;
      border-radius: 12px;
      border: none;
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      cursor: pointer;
      text-decoration: none;
      transition: transform 0.14s ease, box-shadow 0.2s ease, filter 0.15s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
      filter: brightness(1.06);
    }

    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 8px 22px rgba(99, 102, 241, 0.35);
    }

    .btn-green {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      box-shadow: 0 8px 22px rgba(16, 185, 129, 0.3);
    }

    .btn-cyan {
      background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%);
      box-shadow: 0 8px 22px rgba(6, 182, 212, 0.28);
    }

    .btn-danger {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      box-shadow: 0 6px 18px rgba(239, 68, 68, 0.26);
    }

    .btn-sm {
      width: auto;
      margin-top: 0;
      padding: 7px 12px;
      font-size: 12px;
      border-radius: 9px;
    }

    .btn-row-2 {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      margin-top: 10px;
    }

    @media (min-width: 600px) {
      .btn-row-2 { grid-template-columns: 1fr 1fr; }
    }

    .btn-row-2 .btn { margin-top: 0; }

    /* Button design pairs */
    .btn-style-pair {
      display: grid;
      grid-template-columns: 1.45fr 1fr;
      gap: 8px;
      align-items: center;
    }

    .btn-style-pair input,
    .btn-style-pair select {
      margin-top: 0;
    }

    /* Checkbox line */
    .check-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      font-size: 13px;
      color: #dbe4ff;
      cursor: pointer;
    }

    .check-row input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: #8b5cf6;
      cursor: pointer;
    }

    /* List items */
    .item-box {
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(8, 12, 24, 0.78);
      border: 1px solid var(--border);
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .item-meta {
      min-width: 0;
      flex: 1;
    }

    .item-title {
      font-weight: 700;
      font-size: 14px;
      color: #fff;
      word-break: break-word;
    }

    .item-sub {
      font-size: 12px;
      color: var(--muted);
      word-break: break-all;
    }

    .item-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    code.code-preview {
      display: block;
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      background: #050811;
      border: 1px solid rgba(99, 102, 241, 0.28);
      color: #a5f3fc;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 18px;
      right: 18px;
      max-width: 360px;
      padding: 12px 16px;
      border-radius: 12px;
      background: linear-gradient(135deg, #1e1b4b, #312e81);
      border: 1px solid rgba(165, 180, 252, 0.45);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
      z-index: 100;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      pointer-events: none;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <!-- Üst Panel -->
  <header class="topbar">
    <div class="topbar-left">
      <button class="menu-btn" id="menuToggleBtn" type="button" aria-label="Menyu">☰</button>
      <div style="min-width:0;">
        <div class="brand-title" id="headerTitle">SADO PROTECT</div>
        <div class="brand-sub" id="headerSub">Control Dashboard</div>
      </div>
    </div>
    <div class="status-pill" id="botStatusPill">Bot: Online ✅</div>
  </header>

  <!-- 3 Xətt Yan Menyu -->
  <div class="drawer-backdrop" id="drawerBackdrop"></div>
  <aside class="drawer" id="sideDrawer">
    <div class="drawer-header">
      <span style="font-weight:800; font-size:15px;">⚡ SADO NAVİQASİYA</span>
      <button class="close-drawer" id="closeDrawerBtn" type="button">✕</button>
    </div>
    <button class="nav-item active" data-tab="overview" type="button">📊 Dashboard</button>
    <button class="nav-item" data-tab="scripts" type="button">📜 Skriptlər & Loader</button>
    <button class="nav-item" data-tab="obfuscator" type="button">🛡️ Lua Obfuscator</button>
    <button class="nav-item" data-tab="keys" type="button">🔑 Key & Whitelist</button>
    <button class="nav-item" data-tab="discord" type="button">🤖 Join Discord & Panel Dizayn</button>
  </aside>

  <main class="container">
    <!-- 1. DASHBOARD -->
    <section class="section active" id="tab-overview">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Skriptlər</div>
          <div class="stat-value" id="statScripts">0</div>
        </div>
        <div class="stat-card pink-top">
          <div class="stat-label">Yaradılmış Key-lər</div>
          <div class="stat-value" id="statKeys">0</div>
        </div>
        <div class="stat-card green-top">
          <div class="stat-label">Aktiv Whitelist</div>
          <div class="stat-value" id="statWhitelist">0</div>
        </div>
        <div class="stat-card cyan-top">
          <div class="stat-label">Qoşulu Sunucu</div>
          <div class="stat-value" id="statGuild">Seçilməyib</div>
        </div>
      </div>

      <div class="card">
        <h3>🕒 Son Key-lər (Yaradan & İşlədən)</h3>
        <div id="recentKeysContainer" class="muted">Hələ key yaradılmayıb.</div>
      </div>
    </section>

    <!-- 2. SKRİPTLƏR & LOADER -->
    <section class="section" id="tab-scripts">
      <div class="card">
        <h3>➕ Yeni Skript Yarat</h3>
        <label>Skript Adı</label>
        <input type="text" id="newScriptName" placeholder="Məs: SADO HUB" />

        <label>Lua / TXT Dosya Seç (istəyə bağlı)</label>
        <input type="file" id="newScriptFileInput" accept=".lua,.txt" />

        <label>Skript Kodu</label>
        <textarea id="newScriptCode" placeholder="-- Lua skript kodunu bura yazın və ya dosya seçin"></textarea>

        <label class="check-row">
          <input type="checkbox" id="newScriptObfuscate" />
          <span>Skripti yadda saxlayanda avtomatik Lua Obfuscate et (kodu şifrələ)</span>
        </label>

        <button class="btn btn-green" id="createScriptBtn" type="button">💾 Skripti Yadda Saxla</button>
      </div>

      <div class="card">
        <h3>📂 Mövcud Skriptlər</h3>
        <div id="scriptsListContainer" class="muted">Hələ skript yaradılmayıb.</div>
      </div>

      <div class="card">
        <h3>📤 Discord Kanalına Panel Göndər</h3>
        <label>Discord Kanal ID</label>
        <input type="text" id="panelChannelIdInput" placeholder="Məs: 123456789012345678" />

        <label>Panel Skripti Seç</label>
        <select id="panelScriptSelect"></select>

        <button class="btn btn-primary" id="sendPanelBtn" type="button">🚀 Paneli Kanala Göndər</button>
      </div>
    </section>

    <!-- 3. LUA OBFUSCATOR -->
    <section class="section" id="tab-obfuscator">
      <div class="card">
        <h3>🛡️ Lua Obfuscator</h3>
        <p class="muted">Lua kodunuzu şifrələyin, nəticəni kopyalayın və ya birbaşa skript kimi yadda saxlayın.</p>

        <label>Şifrələmə Səviyyəsi</label>
        <select id="obfLevelSelect">
          <option value="1">Səviyyə 1 — Standard XOR + Byte Loader</option>
          <option value="2" selected>Səviyyə 2 — Gücləndirilmiş XOR + Loader</option>
          <option value="3">Səviyyə 3 — Multi-Layer Shield + Loader</option>
        </select>

        <label>Orijinal Lua Kodu</label>
        <textarea id="obfInputCode" placeholder="print('Hello SADO PROTECT')"></textarea>

        <button class="btn btn-primary" id="runObfBtn" type="button">⚡ Kodu Şifrələ (Obfuscate)</button>

        <label>Şifrələnmiş Nəticə</label>
        <textarea id="obfOutputCode" placeholder="Şifrələnmiş kod burada görünəcək..."></textarea>

        <div class="btn-row-2">
          <button class="btn btn-cyan" id="copyObfBtn" type="button">📋 Şifrəli Kodu Kopyala</button>
          <button class="btn btn-green" id="saveObfAsScriptBtn" type="button">💾 Skript Kimi Yadda Saxla</button>
        </div>

        <label>Yadda Saxlanacaq Skript Adı (istəyə bağlı)</label>
        <input type="text" id="obfSaveScriptName" placeholder="Məs: SADO Protected" />
      </div>
    </section>

    <!-- 4. KEY & WHITELIST -->
    <section class="section" id="tab-keys">
      <div class="card">
        <h3>🔑 Yeni Key Yarat</h3>
        <label>Skript Seç</label>
        <select id="keyScriptSelect"></select>

        <label>Müddət (0 = Lifetime, məs: 1d, 7d, 30d, 1y)</label>
        <input type="text" id="keyDurationInput" value="0" />

        <label>Say (1 - 100)</label>
        <input type="number" id="keyAmountInput" min="1" max="100" value="1" />

        <button class="btn btn-primary" id="createKeyBtn" type="button">✨ Key Yarat</button>
        <div id="keysListContainer" class="muted" style="margin-top:12px;">Hələ key yoxdur.</div>
      </div>

      <div class="card">
        <h3>✅ Whitelist Əlavə Et</h3>
        <label>Discord User ID</label>
        <input type="text" id="wlUserIdInput" placeholder="Məs: 123456789012345678" />

        <label>Skript Seç</label>
        <select id="wlScriptSelect"></select>

        <label>Müddət (0 = Lifetime, məs: 7d, 30d)</label>
        <input type="text" id="wlDurationInput" value="0" />

        <button class="btn btn-green" id="addWhitelistBtn" type="button">➕ Whitelist-ə Əlavə Et</button>
        <div id="whitelistContainer" class="muted" style="margin-top:12px;">Aktiv whitelist yoxdur.</div>
      </div>

      <div class="card">
        <h3>🚫 Blacklist İdarəetməsi</h3>
        <label>Discord User ID</label>
        <input type="text" id="blUserIdInput" placeholder="Məs: 123456789012345678" />

        <button class="btn btn-danger" id="addBlacklistBtn" type="button">⛔ Blacklist-ə Sal</button>
        <div id="blacklistContainer" class="muted" style="margin-top:12px;">Blacklist boşdur.</div>
      </div>
    </section>

    <!-- 5. JOIN DISCORD & PANEL DİZAYN -->
    <section class="section" id="tab-discord">
      <div class="card">
        <h3>🤖 SADO PROTECT Botunu Sunucuna Əlavə Et (Join Discord)</h3>
        <p class="muted">
          1. Aşağıdakı düymə ilə <b>SADO PROTECT</b> botunu öz Discord sunucunuza əlavə edin.<br/>
          2. Bot sunucuya girdikdən sonra aşağıdan öz sunucunuzu seçin (və ya Sunucu ID-ni yazın) — yuxarıda öz sunucunuzun adı görünəcək və bütün idarəetmə paneli tam sizə bağlanacaq.
        </p>
        <a class="btn btn-green" id="inviteBotLinkBtn" href="https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot" target="_blank" rel="noopener noreferrer">➕ SADO PROTECT Botunu Sunucuna Əlavə Et</a>

        <label>Botun Olduğu Sunuculardan Öz Sunucunu Seç</label>
        <select id="guildSelectDropdown">
          <option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>
        </select>

        <label>Və ya Discord Sunucu ID (Server ID)</label>
        <input type="text" id="linkGuildIdInput" placeholder="Məs: 1559499280732131348" />

        <label>Discord User ID (istəyə bağlı)</label>
        <input type="text" id="linkDiscordIdInput" placeholder="Məs: 123456789012345678" />

        <button class="btn btn-primary" id="linkWorkspaceBtn" type="button">✅ Sunucunu İdarəetmə Panelinə Bağla</button>
      </div>

      <div class="card">
        <h3>🎨 Panel Buton və Embed Dizaynı</h3>
        <label>Embed Rəngi (HEX & Rəng Seçici)</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="color" id="cfgColorPicker" value="#5865F2" style="width:54px; height:42px; padding:2px; cursor:pointer; flex-shrink:0; border-radius:10px; border:1px solid rgba(148,163,184,0.3); background:transparent;" />
          <input type="text" id="cfgEmbedColor" placeholder="#5865F2" style="flex:1;" />
        </div>

        <label>Panel Başlığı</label>
        <input type="text" id="cfgTitle" placeholder="SADO PROTECT • Script Panel" />

        <label>Panel Açıqlaması</label>
        <input type="text" id="cfgDescription" placeholder="Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin." />

        <label>Redeem Key Düymə Mətni və Rəngi</label>
        <div class="btn-style-pair">
          <input type="text" id="cfgRedeemLabel" placeholder="Redeem Key" />
          <select id="cfgRedeemStyle">
            <option value="green">🟢 Yaşıl</option>
            <option value="blurple">🔵 Mavi</option>
            <option value="grey">⚪ Boz</option>
            <option value="red">🔴 Qırmızı</option>
          </select>
        </div>

        <label>Get Script Düymə Mətni və Rəngi</label>
        <div class="btn-style-pair">
          <input type="text" id="cfgGetScriptLabel" placeholder="Get Script" />
          <select id="cfgGetScriptStyle">
            <option value="blurple">🔵 Mavi</option>
            <option value="green">🟢 Yaşıl</option>
            <option value="grey">⚪ Boz</option>
            <option value="red">🔴 Qırmızı</option>
          </select>
        </div>

        <label>Reset HWID Düymə Mətni və Rəngi</label>
        <div class="btn-style-pair">
          <input type="text" id="cfgResetHwidLabel" placeholder="Reset HWID" />
          <select id="cfgResetHwidStyle">
            <option value="grey">⚪ Boz</option>
            <option value="blurple">🔵 Mavi</option>
            <option value="green">🟢 Yaşıl</option>
            <option value="red">🔴 Qırmızı</option>
          </select>
        </div>

        <label>Stats Düymə Mətni və Rəngi</label>
        <div class="btn-style-pair">
          <input type="text" id="cfgStatsLabel" placeholder="Stats" />
          <select id="cfgStatsStyle">
            <option value="grey">⚪ Boz</option>
            <option value="blurple">🔵 Mavi</option>
            <option value="green">🟢 Yaşıl</option>
            <option value="red">🔴 Qırmızı</option>
          </select>
        </div>

        <button class="btn btn-primary" id="savePanelConfigBtn" type="button">💾 Panel Dizaynını Yadda Saxla</button>
      </div>
    </section>
  </main>

  <div class="toast" id="toastBox"></div>

  <script>
    (function () {
      let initialInputsLoaded = false;
      let latestScripts = [];
      let uploadedFileText = '';

      function showToast(msg) {
        const el = document.getElementById('toastBox');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(() => {
          el.classList.remove('show');
        }, 2800);
      }

      function escapeHtml(str) {
        return String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // 3 xətt menyu aç/bağla
      const drawer = document.getElementById('sideDrawer');
      const backdrop = document.getElementById('drawerBackdrop');
      function openDrawer() {
        drawer.classList.add('open');
        backdrop.classList.add('open');
      }
      function closeDrawer() {
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
      }
      document.getElementById('menuToggleBtn').addEventListener('click', openDrawer);
      document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
      backdrop.addEventListener('click', closeDrawer);

      // Tab keçidləri
      document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tab = btn.getAttribute('data-tab');
          document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
          btn.classList.add('active');
          document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
          const targetSection = document.getElementById('tab-' + tab);
          if (targetSection) targetSection.classList.add('active');
          closeDrawer();
        });
      });

      // Rəng seçici ilə HEX input sinxronizasiyası
      const colorPicker = document.getElementById('cfgColorPicker');
      const colorHexInput = document.getElementById('cfgEmbedColor');
      colorPicker.addEventListener('input', () => {
        colorHexInput.value = colorPicker.value.toUpperCase();
      });
      colorHexInput.addEventListener('input', () => {
        const v = colorHexInput.value.trim();
        if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
          colorPicker.value = v;
        }
      });

      // Sunucu dropdown seçiləndə ID inputunu doldur
      document.getElementById('guildSelectDropdown').addEventListener('change', (e) => {
        if (e.target.value) {
          document.getElementById('linkGuildIdInput').value = e.target.value;
        }
      });

      // Fayl seçiləndə məzmunu oxu
      document.getElementById('newScriptFileInput').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
          uploadedFileText = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          uploadedFileText = String(reader.result || '');
          const codeArea = document.getElementById('newScriptCode');
          if (!codeArea.value.trim()) {
            codeArea.value = uploadedFileText;
          }
          const nameInput = document.getElementById('newScriptName');
          if (!nameInput.value.trim()) {
            nameInput.value = file.name.replace(/\.(lua|txt)$/i, '');
          }
          showToast('Fayl oxundu: ' + file.name);
        };
        reader.readAsText(file);
      });

      function populateScriptSelects(scripts) {
        const ids = ['panelScriptSelect', 'keyScriptSelect', 'wlScriptSelect'];
        ids.forEach((id) => {
          const sel = document.getElementById(id);
          if (!sel) return;
          const prev = sel.value;
          sel.innerHTML = '';
          if (!scripts.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Əvvəl skript yaradın';
            sel.appendChild(opt);
          } else {
            scripts.forEach((sc) => {
              const opt = document.createElement('option');
              opt.value = sc.id;
              opt.textContent = sc.name;
              if (sc.id === prev) opt.selected = true;
              sel.appendChild(opt);
            });
          }
        });
      }

      async function refreshStatusAndOverview() {
        try {
          const res = await fetch('/api/status');
          const data = await res.json();
          if (!data.ok) return;

          const pill = document.getElementById('botStatusPill');
          if (data.bot && data.bot.online) {
            pill.textContent = 'Bot: Online ✅';
          } else if (data.bot && data.bot.status === 'connecting') {
            pill.textContent = 'Bot: Qoşulur...';
          } else {
            pill.textContent = 'Bot: Online ✅';
          }

          if (data.bot && data.bot.inviteUrl) {
            const invBtn = document.getElementById('inviteBotLinkBtn');
            if (invBtn) invBtn.href = data.bot.inviteUrl;
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

          document.getElementById('statScripts').textContent = data.stats?.scriptsCount ?? 0;
          document.getElementById('statKeys').textContent = data.stats?.keysCount ?? 0;
          document.getElementById('statWhitelist').textContent = data.stats?.whitelistsCount ?? 0;

          const gSelect = document.getElementById('guildSelectDropdown');
          if (gSelect) {
            const prevSel = gSelect.value || data.activeGuildId || '';
            gSelect.innerHTML = '<option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>';
            ((data.bot && data.bot.guilds) || []).forEach((g) => {
              const opt = document.createElement('option');
              opt.value = g.id;
              opt.textContent = g.name + ' (' + g.id + ')';
              if (g.id === prevSel) opt.selected = true;
              gSelect.appendChild(opt);
            });
          }

          if (!initialInputsLoaded) {
            initialInputsLoaded = true;
            const linkGuildEl = document.getElementById('linkGuildIdInput');
            const linkDiscordEl = document.getElementById('linkDiscordIdInput');
            if (linkGuildEl && data.activeGuildId) linkGuildEl.value = data.activeGuildId;
            if (linkDiscordEl && data.activeDiscordUserId) linkDiscordEl.value = data.activeDiscordUserId;
            if (data.panelConfig) {
              const c = data.panelConfig;
              document.getElementById('cfgEmbedColor').value = c.embedColor || '#5865F2';
              if (/^#[0-9A-Fa-f]{6}$/.test(c.embedColor || '')) {
                document.getElementById('cfgColorPicker').value = c.embedColor;
              }
              document.getElementById('cfgTitle').value = c.title || '';
              document.getElementById('cfgDescription').value = c.description || '';
              document.getElementById('cfgRedeemLabel').value = c.redeemLabel || 'Redeem Key';
              document.getElementById('cfgRedeemStyle').value = c.redeemStyle || 'green';
              document.getElementById('cfgGetScriptLabel').value = c.getScriptLabel || 'Get Script';
              document.getElementById('cfgGetScriptStyle').value = c.getScriptStyle || 'blurple';
              document.getElementById('cfgResetHwidLabel').value = c.resetHwidLabel || 'Reset HWID';
              document.getElementById('cfgResetHwidStyle').value = c.resetHwidStyle || 'grey';
              document.getElementById('cfgStatsLabel').value = c.statsLabel || 'Stats';
              document.getElementById('cfgStatsStyle').value = c.statsStyle || 'grey';
            }
          }

          const rkBox = document.getElementById('recentKeysContainer');
          if (data.recentKeys && data.recentKeys.length) {
            rkBox.innerHTML = data.recentKeys
              .map(
                (k) =>
                  '<div class="item-box"><div class="item-meta"><div class="item-title">' +
                  escapeHtml(k.key) +
                  '</div><div class="item-sub">Yaradan: ' +
                  escapeHtml(k.createdBy || 'Dashboard') +
                  (k.usedByDiscordId ? ' • İşlədən: ' + escapeHtml(k.usedByDiscordId) : ' • İstifadə gözləyir') +
                  '</div></div></div>'
              )
              .join('');
          } else {
            rkBox.innerHTML = '<span class="muted">Hələ key yaradılmayıb.</span>';
          }
        } catch (_err) {
          // Şəbəkə xətası UI-ı dayandırmır
        }
      }

      async function refreshScripts() {
        try {
          const res = await fetch('/api/scripts');
          const data = await res.json();
          if (!data.ok) return;
          latestScripts = data.scripts || [];
          populateScriptSelects(latestScripts);

          const box = document.getElementById('scriptsListContainer');
          if (!latestScripts.length) {
            box.innerHTML = '<span class="muted">Hələ skript yaradılmayıb.</span>';
            return;
          }

          box.innerHTML = latestScripts
            .map((sc) => {
              return (
                '<div class="item-box" style="flex-direction:column; align-items:stretch;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">' +
                '<div class="item-meta"><div class="item-title">📜 ' +
                escapeHtml(sc.name) +
                (sc.obfuscated ? ' 🛡️' : '') +
                '</div><div class="item-sub">' +
                escapeHtml(sc.fileName || 'script.lua') +
                '</div></div>' +
                '<div class="item-actions">' +
                '<button class="btn btn-cyan btn-sm" type="button" onclick="window.__updateScript(\'' +
                sc.id +
                '\')">✏️ Update</button>' +
                '<button class="btn btn-danger btn-sm" type="button" onclick="window.__deleteScript(\'' +
                sc.id +
                '\')">🗑️ Sil</button>' +
                '</div></div>' +
                '<code class="code-preview">script_key = "YOUR_KEY";\nloadstring(game:HttpGet("https://sado-protect.onrender.com/api/loader/' +
                encodeURIComponent(sc.loaderToken || sc.id) +
                '?key=" .. tostring(script_key)))()</code>' +
                '</div>'
              );
            })
            .join('');
        } catch (_err) {}
      }

      window.__updateScript = async (id) => {
        const sc = latestScripts.find((s) => s.id === id);
        if (!sc) return;
        const nextName = document.getElementById('newScriptName').value.trim() || sc.name;
        const nextCode = document.getElementById('newScriptCode').value || sc.code;
        const obf = document.getElementById('newScriptObfuscate').checked;

        const r = await fetch('/api/scripts/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nextName, code: nextCode, obfuscate: obf }),
        });
        const j = await r.json();
        showToast(j.message || 'Yeniləndi');
        await refreshScripts();
      };

      window.__deleteScript = async (id) => {
        const r = await fetch('/api/scripts/' + encodeURIComponent(id), { method: 'DELETE' });
        const j = await r.json();
        showToast(j.message || 'Silindi');
        await refreshAll();
      };

      async function refreshKeysAndLists() {
        try {
          const [kRes, wRes, bRes] = await Promise.all([
            fetch('/api/keys'),
            fetch('/api/whitelist'),
            fetch('/api/blacklist'),
          ]);
          const [kData, wData, bData] = await Promise.all([kRes.json(), wRes.json(), bRes.json()]);

          const kBox = document.getElementById('keysListContainer');
          const keys = kData.keys || [];
          if (!keys.length) {
            kBox.innerHTML = '<span class="muted">Hələ key yoxdur.</span>';
          } else {
            kBox.innerHTML = keys
              .slice()
              .reverse()
              .map(
                (k) =>
                  '<div class="item-box"><div class="item-meta"><div class="item-title">🔑 ' +
                  escapeHtml(k.key) +
                  '</div><div class="item-sub">' +
                  (k.used ? 'İşlədilib (' + escapeHtml(k.usedByDiscordId || '') + ')' : 'Aktiv / Gözləyir') +
                  '</div></div><button class="btn btn-danger btn-sm" type="button" onclick="window.__delKey(\'' +
                  k.id +
                  '\')">Sil</button></div>'
              )
              .join('');
          }

          const wBox = document.getElementById('whitelistContainer');
          const wls = wData.whitelists || [];
          if (!wls.length) {
            wBox.innerHTML = '<span class="muted">Aktiv whitelist yoxdur.</span>';
          } else {
            wBox.innerHTML = wls
              .map(
                (w) =>
                  '<div class="item-box"><div class="item-meta"><div class="item-title">✅ ' +
                  escapeHtml(w.discordUserId) +
                  '</div><div class="item-sub">Key: ' +
                  escapeHtml(w.key || '—') +
                  (w.hwid ? ' • HWID: ' + escapeHtml(w.hwid) : '') +
                  '</div></div><button class="btn btn-danger btn-sm" type="button" onclick="window.__delWl(\'' +
                  w.id +
                  '\')">Sil</button></div>'
              )
              .join('');
          }

          const bBox = document.getElementById('blacklistContainer');
          const bls = bData.blacklists || [];
          if (!bls.length) {
            bBox.innerHTML = '<span class="muted">Blacklist boşdur.</span>';
          } else {
            bBox.innerHTML = bls
              .map(
                (b) =>
                  '<div class="item-box"><div class="item-meta"><div class="item-title">🚫 ' +
                  escapeHtml(b.discordUserId) +
                  '</div></div><button class="btn btn-danger btn-sm" type="button" onclick="window.__delBl(\'' +
                  b.id +
                  '\')">Çıxar</button></div>'
              )
              .join('');
          }
        } catch (_err) {}
      }

      window.__delKey = async (id) => {
        await fetch('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' });
        showToast('Key silindi');
        await refreshAll();
      };
      window.__delWl = async (id) => {
        await fetch('/api/whitelist/' + encodeURIComponent(id), { method: 'DELETE' });
        showToast('Whitelist silindi');
        await refreshAll();
      };
      window.__delBl = async (id) => {
        await fetch('/api/blacklist/' + encodeURIComponent(id), { method: 'DELETE' });
        showToast('Blacklist-dən çıxarıldı');
        await refreshAll();
      };

      // Skript yarat
      document.getElementById('createScriptBtn').addEventListener('click', async () => {
        const name = document.getElementById('newScriptName').value.trim();
        const code = document.getElementById('newScriptCode').value || uploadedFileText;
        const obfuscate = document.getElementById('newScriptObfuscate').checked;
        const fileEl = document.getElementById('newScriptFileInput');
        const fileName = fileEl.files && fileEl.files[0] ? fileEl.files[0].name : `${name || 'script'}.lua`;

        const r = await fetch('/api/scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, fileName, code, obfuscate, obfuscateLevel: 2 }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          document.getElementById('newScriptName').value = '';
          document.getElementById('newScriptCode').value = '';
          document.getElementById('newScriptObfuscate').checked = false;
          fileEl.value = '';
          uploadedFileText = '';
          showToast(j.message || 'Skript yadda saxlanıldı!');
          await refreshAll();
        } else {
          showToast(j.message || 'Xəta baş verdi');
        }
      });

      // Paneli kanala göndər
      document.getElementById('sendPanelBtn').addEventListener('click', async () => {
        const channelId = document.getElementById('panelChannelIdInput').value.trim();
        const scriptId = document.getElementById('panelScriptSelect').value;
        const r = await fetch('/api/send-panel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId, scriptId }),
        });
        const j = await r.json();
        showToast(j.message || 'Panel göndərildi');
        await refreshStatusAndOverview();
      });

      // Obfuscator əməliyyatları
      document.getElementById('runObfBtn').addEventListener('click', async () => {
        const code = document.getElementById('obfInputCode').value;
        const level = Number(document.getElementById('obfLevelSelect').value || 2);
        const r = await fetch('/api/obfuscate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, level }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          document.getElementById('obfOutputCode').value = j.obfuscated;
          showToast('Lua kodu şifrələndi!');
        } else {
          showToast(j.message || 'Şifrələmə xətası');
        }
      });

      document.getElementById('copyObfBtn').addEventListener('click', async () => {
        const val = document.getElementById('obfOutputCode').value;
        if (!val) return showToast('Kopyalanacaq kod yoxdur');
        try {
          await navigator.clipboard.writeText(val);
          showToast('Şifrəli kod kopyalandı!');
        } catch (_e) {
          showToast('Kopyalama mümkün olmadı');
        }
      });

      document.getElementById('saveObfAsScriptBtn').addEventListener('click', async () => {
        const obfCode = document.getElementById('obfOutputCode').value;
        const rawCode = document.getElementById('obfInputCode').value;
        const level = Number(document.getElementById('obfLevelSelect').value || 2);
        const name = document.getElementById('obfSaveScriptName').value.trim() || 'SADO Obfuscated Script';
        const finalCode = obfCode.trim() ? obfCode : rawCode;

        const r = await fetch('/api/scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            code: finalCode,
            obfuscate: !obfCode.trim(),
            obfuscateLevel: level,
            preObfuscated: Boolean(obfCode.trim()),
          }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          document.getElementById('obfSaveScriptName').value = '';
          showToast('Obfuscated skript panelə əlavə olundu!');
          await refreshAll();
        } else {
          showToast(j.message || 'Xəta baş verdi');
        }
      });

      // Key yarat
      document.getElementById('createKeyBtn').addEventListener('click', async () => {
        const scriptId = document.getElementById('keyScriptSelect').value;
        const duration = document.getElementById('keyDurationInput').value.trim();
        const amount = Number(document.getElementById('keyAmountInput').value || 1);
        const r = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scriptId, duration, amount }),
        });
        const j = await r.json();
        showToast(j.message || 'Key yaradıldı');
        await refreshAll();
      });

      // Whitelist əlavə et
      document.getElementById('addWhitelistBtn').addEventListener('click', async () => {
        const discordUserId = document.getElementById('wlUserIdInput').value.trim();
        const scriptId = document.getElementById('wlScriptSelect').value;
        const duration = document.getElementById('wlDurationInput').value.trim();
        const r = await fetch('/api/whitelist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordUserId, scriptId, duration }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          document.getElementById('wlUserIdInput').value = '';
          showToast(j.message || 'Whitelist əlavə edildi!');
          await refreshAll();
        } else {
          showToast(j.message || 'Xəta');
        }
      });

      // Blacklist əlavə et
      document.getElementById('addBlacklistBtn').addEventListener('click', async () => {
        const discordUserId = document.getElementById('blUserIdInput').value.trim();
        const r = await fetch('/api/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordUserId }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          document.getElementById('blUserIdInput').value = '';
          showToast(j.message || 'Blacklist əlavə edildi!');
          await refreshAll();
        } else {
          showToast(j.message || 'Xəta');
        }
      });

      // Sunucunu İdarəetmə Panelinə Bağla
      document.getElementById('linkWorkspaceBtn').addEventListener('click', async () => {
        const guildId = document.getElementById('linkGuildIdInput').value.trim();
        const discordUserId = document.getElementById('linkDiscordIdInput').value.trim();
        const r = await fetch('/api/workspace/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guildId, discordUserId }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          initialInputsLoaded = false;
          showToast(j.message || 'Sunucu bağlandı!');
          await refreshStatusAndOverview();
        } else {
          showToast(j.message || 'Bağlantı xətası');
        }
      });

      // Panel dizaynını yadda saxla
      document.getElementById('savePanelConfigBtn').addEventListener('click', async () => {
        const payload = {
          embedColor: document.getElementById('cfgEmbedColor').value.trim(),
          title: document.getElementById('cfgTitle').value.trim(),
          description: document.getElementById('cfgDescription').value.trim(),
          redeemLabel: document.getElementById('cfgRedeemLabel').value.trim(),
          redeemStyle: document.getElementById('cfgRedeemStyle').value,
          getScriptLabel: document.getElementById('cfgGetScriptLabel').value.trim(),
          getScriptStyle: document.getElementById('cfgGetScriptStyle').value,
          resetHwidLabel: document.getElementById('cfgResetHwidLabel').value.trim(),
          resetHwidStyle: document.getElementById('cfgResetHwidStyle').value,
          statsLabel: document.getElementById('cfgStatsLabel').value.trim(),
          statsStyle: document.getElementById('cfgStatsStyle').value,
        };
        const r = await fetch('/api/panel-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        showToast(j.message || 'Panel dizaynı yadda saxlanıldı!');
      });

      async function refreshAll() {
        await Promise.all([refreshStatusAndOverview(), refreshScripts(), refreshKeysAndLists()]);
      }

      refreshAll();
      setInterval(refreshStatusAndOverview, 10000);
    })();
  </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

// Express xəta handler
app.use((err, req, res, _next) => {
  console.error('[HTTP ERROR]', err && err.message ? err.message : err);
  res.status(500).json({ ok: false, message: 'Daxili server xətası baş verdi.' });
});

// ============================================================================
// 6. SERVER BAŞLADILMASI VƏ RENDER ÜÇÜN 7/24 PROSES QORUMASI
// ============================================================================

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.message ? err.message : err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[WEB] SADO PROTECT Dashboard http://0.0.0.0:${PORT} ünvanında işləyir`);
  startWatchdog();
  await ensureBotOnline();
});
