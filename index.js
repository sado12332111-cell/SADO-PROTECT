const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelType
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const PANEL_TOKEN = String(process.env.PANEL_TOKEN || '').trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'sado-protect-data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'sado-protect-data.backup.json');
const TMP_FILE = path.join(DATA_DIR, 'sado-protect-data.tmp.json');

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const JSONBIN_ID = String(process.env.JSONBIN_BIN_ID || '').trim();
const JSONBIN_KEY = String(process.env.JSONBIN_API_KEY || '').trim();
const CLOUD_KEY = String(process.env.CLOUD_STATE_KEY || 'sado_protect_state_v1').trim();

let runtimeBotToken = String(process.env.DISCORD_BOT_TOKEN || '').trim();
let client = null;
let botBootPromise = null;
let cloudSaveTimer = null;

function createDefaultState() {
    return {
        savedBotToken: '',
        scripts: [],
        keys: [],
        whitelists: [],
        panels: [],
        hwidCooldowns: {},
        lastHwidReset: {},
        guildSettings: {},
        userProfiles: {},
        panelButtonConfig: {
            redeemLabel: 'Redeem Key',
            redeemEmoji: '🔑',
            getScriptLabel: 'Get Script',
            getScriptEmoji: '📜',
            resetHwidLabel: 'Reset HWID',
            resetHwidEmoji: '🔄',
            getStatsLabel: 'Get Stats',
            getStatsEmoji: '📊'
        }
    };
}

let state = createDefaultState();

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function writeStateToPath(targetPath, tmpPath, serialized) {
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, targetPath);
}

function tryReadStateJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
}

async function pushStateToCloud(serialized) {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
        try {
            await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(CLOUD_KEY)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${UPSTASH_TOKEN}`,
                    'Content-Type': 'text/plain; charset=utf-8'
                },
                body: serialized
            });
        } catch (err) {
            console.error('[SADO PROTECT] Upstash bulud yazma xətası:', err.message);
        }
    }
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}`, {
                method: 'PUT',
                headers: {
                    'X-Master-Key': JSONBIN_KEY,
                    'Content-Type': 'application/json'
                },
                body: serialized
            });
        } catch (err) {
            console.error('[SADO PROTECT] JSONBin bulud yazma xətası:', err.message);
        }
    }
}

async function pullStateFromCloud() {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
        try {
            const resp = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CLOUD_KEY)}`, {
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && typeof data.result === 'string' && data.result.trim()) {
                    const parsed = JSON.parse(data.result);
                    if (parsed && typeof parsed === 'object') return parsed;
                }
            }
        } catch (err) {
            console.error('[SADO PROTECT] Upstash bulud oxuma xətası:', err.message);
        }
    }
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            const resp = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}/latest`, {
                headers: { 'X-Master-Key': JSONBIN_KEY }
            });
            if (resp.ok) {
                const data = await resp.json();
                const rec = data && data.record;
                if (rec && typeof rec === 'object') return rec;
            }
        } catch (err) {
            console.error('[SADO PROTECT] JSONBin bulud oxuma xətası:', err.message);
        }
    }
    return null;
}

function scheduleCloudPersist(serialized) {
    if ((!UPSTASH_URL || !UPSTASH_TOKEN) && (!JSONBIN_ID || !JSONBIN_KEY)) return;
    if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => {
        pushStateToCloud(serialized);
    }, 350);
}

function persistState() {
    ensureDataDir();
    try {
        const serialized = JSON.stringify(state, null, 2);
        writeStateToPath(DATA_FILE, TMP_FILE, serialized);
        try {
            writeStateToPath(BACKUP_FILE, `${TMP_FILE}.bak`, serialized);
        } catch (bakErr) {
            console.error('[SADO PROTECT] Backup yazılarkən xəta:', bakErr.message);
        }
        scheduleCloudPersist(serialized);
    } catch (err) {
        console.error('[SADO PROTECT] State yazılarkən xəta:', err.message);
    }
}

function applyLoadedObject(parsed) {
    state = {
        ...createDefaultState(),
        ...parsed
    };
    state.savedBotToken = String(state.savedBotToken || '').trim();
    if (!runtimeBotToken && state.savedBotToken) {
        runtimeBotToken = state.savedBotToken;
    }
    state.scripts = Array.isArray(state.scripts) ? state.scripts : [];
    state.keys = Array.isArray(state.keys) ? state.keys : [];
    state.whitelists = Array.isArray(state.whitelists) ? state.whitelists : [];
    state.panels = Array.isArray(state.panels) ? state.panels : [];
    state.hwidCooldowns = state.hwidCooldowns && typeof state.hwidCooldowns === 'object' ? state.hwidCooldowns : {};
    state.lastHwidReset = state.lastHwidReset && typeof state.lastHwidReset === 'object' ? state.lastHwidReset : {};
    state.guildSettings = state.guildSettings && typeof state.guildSettings === 'object' ? state.guildSettings : {};
    state.userProfiles = state.userProfiles && typeof state.userProfiles === 'object' ? state.userProfiles : {};
    state.panelButtonConfig = {
        ...createDefaultState().panelButtonConfig,
        ...(parsed.panelButtonConfig && typeof parsed.panelButtonConfig === 'object'
            ? parsed.panelButtonConfig
            : {})
    };
}

function loadState() {
    ensureDataDir();
    try {
        let parsed = tryReadStateJson(DATA_FILE);
        if (!parsed) {
            parsed = tryReadStateJson(BACKUP_FILE);
            if (parsed) {
                console.log('[SADO PROTECT] Əsas fayl boş/yoxdur, ehtiyat nüsxədən bərpa edildi.');
            }
        }
        if (parsed) {
            applyLoadedObject(parsed);
            persistState();
        } else {
            persistState();
        }
    } catch (err) {
        console.error('[SADO PROTECT] State oxunarkən xəta:', err.message);
        state = createDefaultState();
    }
}

async function hydrateFromCloudIfAvailable() {
    const cloudParsed = await pullStateFromCloud();
    if (!cloudParsed) return;
    const localCount = state.scripts.length + state.keys.length + state.whitelists.length;
    const cloudCount =
        (Array.isArray(cloudParsed.scripts) ? cloudParsed.scripts.length : 0) +
        (Array.isArray(cloudParsed.keys) ? cloudParsed.keys.length : 0) +
        (Array.isArray(cloudParsed.whitelists) ? cloudParsed.whitelists.length : 0);

    if (cloudCount > 0 || localCount === 0) {
        applyLoadedObject(cloudParsed);
        const serialized = JSON.stringify(state, null, 2);
        writeStateToPath(DATA_FILE, TMP_FILE, serialized);
        writeStateToPath(BACKUP_FILE, `${TMP_FILE}.bak`, serialized);
        console.log('[SADO PROTECT] Bulud yaddaşından bütün whitelist, skript və key-lər bərpa edildi.');
    }
}

loadState();

function nowMs() {
    return Date.now();
}

function generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function generateKeyCode() {
    const a = crypto.randomBytes(3).toString('hex').toUpperCase();
    const b = crypto.randomBytes(3).toString('hex').toUpperCase();
    const c = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `SADO-${a}-${b}-${c}`;
}

function parseDurationToMs(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw || raw === '0' || raw === 'lifetime' || raw === 'perm' || raw === 'permanent') {
        return null;
    }
    const match = raw.match(/^(\d+)\s*(s|sec|m|min|h|hour|d|day|w|week|mo|month|y|year)$/);
    if (!match) {
        const plainDays = Number(raw);
        if (Number.isFinite(plainDays) && plainDays > 0) {
            return Math.round(plainDays * 24 * 60 * 60 * 1000);
        }
        return undefined;
    }
    const val = Number(match[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    const unit = match[2];
    const map = {
        s: 1000,
        sec: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        h: 3600 * 1000,
        hour: 3600 * 1000,
        d: 86400 * 1000,
        day: 86400 * 1000,
        w: 7 * 86400 * 1000,
        week: 7 * 86400 * 1000,
        mo: 30 * 86400 * 1000,
        month: 30 * 86400 * 1000,
        y: 365 * 86400 * 1000,
        year: 365 * 86400 * 1000
    };
    return val * (map[unit] || 86400 * 1000);
}

function formatExpiry(expiresAt) {
    if (!expiresAt) return 'Ömürlük (Lifetime)';
    const ts = Math.floor(Number(expiresAt) / 1000);
    return `<t:${ts}:F> (<t:${ts}:R>)`;
}

function isExpired(expiresAt) {
    return Boolean(expiresAt && Number(expiresAt) <= nowMs());
}

function getScriptById(scriptId) {
    return state.scripts.find((s) => s.id === scriptId) || null;
}

function getScriptByNameOrId(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    return (
        state.scripts.find((s) => s.id.toLowerCase() === q) ||
        state.scripts.find((s) => s.name.toLowerCase() === q) ||
        state.scripts.find((s) => s.name.toLowerCase().includes(q)) ||
        null
    );
}

function getActiveWhitelist(userId, scriptId) {
    return (
        state.whitelists.find(
            (w) =>
                w.userId === String(userId) &&
                w.scriptId === scriptId &&
                !w.revoked &&
                !isExpired(w.expiresAt)
        ) || null
    );
}

function getUserKeyForScript(userId, scriptId) {
    return (
        state.keys.find(
            (k) =>
                k.redeemedBy === String(userId) &&
                k.scriptId === scriptId &&
                !k.disabled &&
                !isExpired(k.expiresAt)
        ) || null
    );
}

function rememberUserProfile(user) {
    if (!user || !user.id) return;
    state.userProfiles[String(user.id)] = {
        id: String(user.id),
        username: user.username || '',
        tag: user.tag || user.username || String(user.id),
        updatedAt: nowMs()
    };
}

function enrichMemberEntry(entry) {
    const uid = String(entry.userId || entry.redeemedBy || '');
    const prof = uid ? state.userProfiles[uid] : null;
    const scr = entry.scriptId ? getScriptById(entry.scriptId) : null;
    return {
        ...entry,
        username: prof ? prof.tag : null,
        scriptName: scr ? scr.name : entry.scriptId || 'Naməlum'
    };
}

function getGuildSettings(guildId) {
    if (!guildId) return { allowedRoleIds: [] };
    if (!state.guildSettings[guildId]) {
        state.guildSettings[guildId] = { allowedRoleIds: [] };
    }
    return state.guildSettings[guildId];
}

function hasCommandPermission(interaction) {
    if (!interaction.guild || !interaction.member) return false;
    if (interaction.guild.ownerId === interaction.user.id) return true;
    const perms = interaction.memberPermissions;
    if (perms && perms.has(PermissionFlagsBits.Administrator)) return true;

    const settings = getGuildSettings(interaction.guild.id);
    const memberRoles = interaction.member.roles;
    if (!memberRoles) return false;

    if (Array.isArray(settings.allowedRoleIds) && settings.allowedRoleIds.length > 0) {
        return settings.allowedRoleIds.some((rid) => memberRoles.cache.has(rid));
    }

    const sortedRoles = [...interaction.guild.roles.cache.values()]
        .filter((r) => r.id !== interaction.guild.id && !r.managed)
        .sort((a, b) => b.position - a.position);
    const topTwo = sortedRoles.slice(0, 2);
    return topTwo.some((r) => memberRoles.cache.has(r.id));
}

function buildPanelComponents(scriptId) {
    const cfg = state.panelButtonConfig;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sp_redeem:${scriptId}`)
            .setLabel(cfg.redeemLabel || 'Redeem Key')
            .setEmoji(cfg.redeemEmoji || '🔑')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`sp_getscript:${scriptId}`)
            .setLabel(cfg.getScriptLabel || 'Get Script')
            .setEmoji(cfg.getScriptEmoji || '📜')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`sp_resethwid:${scriptId}`)
            .setLabel(cfg.resetHwidLabel || 'Reset HWID')
            .setEmoji(cfg.resetHwidEmoji || '🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`sp_getstats:${scriptId}`)
            .setLabel(cfg.getStatsLabel || 'Get Stats')
            .setEmoji(cfg.getStatsEmoji || '📊')
            .setStyle(ButtonStyle.Secondary)
    );
    return [row];
}

function buildPanelEmbed(panelTitle, script) {
    return new EmbedBuilder()
        .setTitle(panelTitle || 'SADOHUB')
        .setDescription(
            `Skript: **${script.name}**\n` +
                `• Key aktivləşdirmək üçün **Redeem Key**\n` +
                `• Qısa skripti almaq üçün **Get Script**\n` +
                `• Cihazı sıfırlamaq üçün **Reset HWID**\n` +
                `• Key və HWID məlumatına baxmaq üçün **Get Stats**`
        )
        .setColor(0x5865f2)
        .setFooter({ text: 'SADO PROTECT • Hər skriptə ayrı whitelist və 1 nəfərlik key sistemi' })
        .setTimestamp();
}

function buildLoaderSnippet(baseUrl, scriptId, userId, token) {
    const cleanBase = String(baseUrl || PUBLIC_BASE_URL).replace(/\/+$/, '');
    const url = `${cleanBase}/raw/${encodeURIComponent(scriptId)}?uid=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
    return `loadstring(game:HttpGet("${url}"))()`;
}

function ensureUserLoaderToken(userId, scriptId) {
    let wl = getActiveWhitelist(userId, scriptId);
    if (!wl) {
        const keyRecord = getUserKeyForScript(userId, scriptId);
        if (!keyRecord) return null;
        wl = {
            id: generateId('wl'),
            userId: String(userId),
            scriptId,
            expiresAt: keyRecord.expiresAt || null,
            hwid: keyRecord.hwid || null,
            loaderToken: crypto.randomBytes(16).toString('hex'),
            createdAt: nowMs(),
            revoked: false
        };
        state.whitelists.push(wl);
        persistState();
    }
    if (!wl.loaderToken) {
        wl.loaderToken = crypto.randomBytes(16).toString('hex');
        persistState();
    }
    return wl;
}

const slashCommands = [
    new SlashCommandBuilder()
        .setName('setpanel')
        .setDescription('Bu kanala skript paneli yerləşdir')
        .addStringOption((opt) =>
            opt.setName('name').setDescription('Panel başlığı (məs: SADOHUB)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID (istəyə bağlı)').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('Seçilən skript üçün 1 nəfərlik key yarat')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Müddət: 1h, 1d, 7d, 30d və ya 0 (ömürlük)').setRequired(true)
        )
        .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('Key sayı (1-50)').setMinValue(1).setMaxValue(50).setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID (istəyə bağlı)').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('İstifadəçiyə və ya rola skript icazəsi ver')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Müddət: 1d, 7d, 30d və ya 0 (ömürlük)').setRequired(true)
        )
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(false))
        .addRoleOption((opt) => opt.setName('role').setDescription('Rol').setRequired(false))
        .addStringOption((opt) => opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)),
    new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('İstifadəçinin və ya rolun whitelist icazəsini sil')
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(false))
        .addRoleOption((opt) => opt.setName('role').setDescription('Rol').setRequired(false))
        .addStringOption((opt) => opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)),
    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('Admin: istifadəçinin HWID kilidini sıfırla')
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(true))
        .addStringOption((opt) => opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)),
    new SlashCommandBuilder()
        .setName('cooldownhwid')
        .setDescription('Skript üçün istifadəçinin özünün HWID sıfırlama gözləmə müddəti')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Məs: 1h, 12h, 1d və ya 0 (gözləməsiz)').setRequired(true)
        )
        .addStringOption((opt) => opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)),
    new SlashCommandBuilder()
        .setName('setpermrole')
        .setDescription('Bot əmrlərini işlədə biləcək rolları təyin et')
        .addRoleOption((opt) => opt.setName('role').setDescription('İcazə verilən rol').setRequired(true))
        .addStringOption((opt) =>
            opt
                .setName('action')
                .setDescription('Əlavə et və ya sil')
                .addChoices({ name: 'Əlavə et', value: 'add' }, { name: 'Sil', value: 'remove' })
                .setRequired(false)
        )
].map((c) => c.toJSON());

async function syncSlashCommands() {
    if (!runtimeBotToken || !client || !client.user) return;
    const rest = new REST({ version: '10' }).setToken(runtimeBotToken);
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('[SADO PROTECT] Slash əmrlər sinxronizasiya olundu.');
}

async function resolveScriptOrAsk(interaction, explicitQuery, pendingAction) {
    if (state.scripts.length === 0) {
        await interaction.reply({
            content: '❌ Heç bir skript əlavə edilməyib. Əvvəlcə veb paneldən skript yükləyin.',
            ephemeral: true
        });
        return null;
    }
    if (explicitQuery) {
        const found = getScriptByNameOrId(explicitQuery);
        if (!found) {
            await interaction.reply({ content: `❌ "${explicitQuery}" adlı skript tapılmadı.`, ephemeral: true });
            return null;
        }
        return found;
    }
    if (state.scripts.length === 1) {
        return state.scripts[0];
    }

    const token = generateId('sel');
    pendingSelections.set(token, {
        ownerId: interaction.user.id,
        createdAt: nowMs(),
        ...pendingAction
    });

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`sp_select_script:${token}`)
        .setPlaceholder('Skript seçin...')
        .addOptions(
            state.scripts.slice(0, 25).map((s) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(s.name.slice(0, 100))
                    .setValue(s.id)
                    .setDescription(`ID: ${s.id}`.slice(0, 100))
            )
        );

    await interaction.reply({
        content: 'Hansı skript üçün icra edilsin?',
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
    });
    return null;
}

const pendingSelections = new Map();

async function executePanelPost(channel, panelName, script) {
    const embed = buildPanelEmbed(panelName, script);
    const components = buildPanelComponents(script.id);
    const msg = await channel.send({ embeds: [embed], components });
    state.panels = state.panels.filter((p) => !(p.channelId === channel.id && p.scriptId === script.id));
    state.panels.push({
        id: generateId('pnl'),
        guildId: channel.guildId,
        channelId: channel.id,
        messageId: msg.id,
        scriptId: script.id,
        panelName: panelName || 'SADOHUB',
        createdAt: nowMs()
    });
    persistState();
    return msg;
}

async function applyWhitelistForTargets(script, targetUsers, durationMs) {
    const expiresAt = durationMs ? nowMs() + durationMs : null;
    for (const u of targetUsers) {
        rememberUserProfile(u);
        const existing = getActiveWhitelist(u.id, script.id);
        if (existing) {
            existing.expiresAt = expiresAt;
            existing.revoked = false;
        } else {
            state.whitelists.push({
                id: generateId('wl'),
                userId: String(u.id),
                scriptId: script.id,
                expiresAt,
                hwid: null,
                loaderToken: crypto.randomBytes(16).toString('hex'),
                createdAt: nowMs(),
                revoked: false
            });
        }
    }
    persistState();
}

async function removeWhitelistForTargets(script, targetUsers) {
    const ids = new Set(targetUsers.map((u) => String(u.id)));
    let count = 0;
    for (const w of state.whitelists) {
        if (w.scriptId === script.id && ids.has(w.userId) && !w.revoked) {
            w.revoked = true;
            count++;
        }
    }
    for (const k of state.keys) {
        if (k.scriptId === script.id && k.redeemedBy && ids.has(k.redeemedBy) && !k.disabled) {
            k.disabled = true;
        }
    }
    persistState();
    return count;
}

function attachBotHandlers(botClient) {
    botClient.once('ready', async () => {
        console.log(`[SADO PROTECT] Discord bot aktivdir: ${botClient.user.tag}`);
        try {
            await syncSlashCommands();
        } catch (err) {
            console.error('[SADO PROTECT] Slash command sync xətası:', err.message);
        }
    });

    botClient.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.user) rememberUserProfile(interaction.user);

            if (interaction.isChatInputCommand()) {
                if (!hasCommandPermission(interaction)) {
                    await interaction.reply({
                        content: '❌ Bu əmri işlətmək üçün icazəniz yoxdur (Top 2 rol və ya təyin edilmiş rol lazımdır).',
                        ephemeral: true
                    });
                    return;
                }

                const cmd = interaction.commandName;

                if (cmd === 'setpermrole') {
                    const role = interaction.options.getRole('role', true);
                    const action = interaction.options.getString('action') || 'add';
                    const settings = getGuildSettings(interaction.guild.id);
                    if (action === 'remove') {
                        settings.allowedRoleIds = settings.allowedRoleIds.filter((id) => id !== role.id);
                        persistState();
                        await interaction.reply({ content: `✅ <@&${role.id}> icazəli rollardan silindi.`, ephemeral: true });
                    } else {
                        if (!settings.allowedRoleIds.includes(role.id)) {
                            settings.allowedRoleIds.push(role.id);
                        }
                        persistState();
                        await interaction.reply({ content: `✅ <@&${role.id}> bot əmrləri üçün icazəli edildi.`, ephemeral: true });
                    }
                    return;
                }

                if (cmd === 'setpanel') {
                    const panelName = interaction.options.getString('name', true);
                    const scriptQuery = interaction.options.getString('script');
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'setpanel',
                        panelName,
                        channelId: interaction.channelId
                    });
                    if (!script) return;
                    await executePanelPost(interaction.channel, panelName, script);
                    await interaction.reply({
                        content: `✅ **${script.name}** üçün panel bu kanala göndərildi!`,
                        ephemeral: true
                    });
                    return;
                }

                if (cmd === 'genkey') {
                    const timeStr = interaction.options.getString('time', true);
                    const amount = interaction.options.getInteger('amount') || 1;
                    const scriptQuery = interaction.options.getString('script');
                    const durationMs = parseDurationToMs(timeStr);
                    if (durationMs === undefined) {
                        await interaction.reply({
                            content: '❌ Yanlış müddət formatı. Məsələn: `1h`, `1d`, `7d`, `30d` və ya `0` (ömürlük).',
                            ephemeral: true
                        });
                        return;
                    }
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'genkey',
                        durationMs,
                        amount
                    });
                    if (!script) return;
                    const created = [];
                    for (let i = 0; i < amount; i++) {
                        const code = generateKeyCode();
                        state.keys.push({
                            id: generateId('key'),
                            code,
                            scriptId: script.id,
                            durationMs,
                            expiresAt: null,
                            redeemedBy: null,
                            redeemedAt: null,
                            hwid: null,
                            disabled: false,
                            createdAt: nowMs()
                        });
                        created.push(code);
                    }
                    persistState();
                    await interaction.reply({
                        content:
                            `✅ **${script.name}** üçün **${created.length}** ədəd 1 nəfərlik key yaradıldı:\n` +
                            `\`\`\`\n${created.join('\n')}\n\`\`\``,
                        ephemeral: true
                    });
                    return;
                }

                if (cmd === 'whitelist' || cmd === 'unwhitelist') {
                    const user = interaction.options.getUser('user');
                    const role = interaction.options.getRole('role');
                    const scriptQuery = interaction.options.getString('script');
                    const timeStr = cmd === 'whitelist' ? interaction.options.getString('time', true) : '0';
                    const durationMs = cmd === 'whitelist' ? parseDurationToMs(timeStr) : null;

                    if (cmd === 'whitelist' && durationMs === undefined) {
                        await interaction.reply({
                            content: '❌ Yanlış müddət formatı. Məs: `1d`, `7d`, `30d` və ya `0` (ömürlük).',
                            ephemeral: true
                        });
                        return;
                    }
                    if (!user && !role) {
                        await interaction.reply({ content: '❌ `user` və ya `role` seçməlisiniz.', ephemeral: true });
                        return;
                    }

                    let targets = [];
                    if (user) targets.push(user);
                    if (role) {
                        await interaction.guild.members.fetch();
                        for (const member of role.members.values()) {
                            if (!member.user.bot) targets.push(member.user);
                        }
                    }
                    targets = [...new Map(targets.map((u) => [u.id, u])).values()];

                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: cmd,
                        targetUserIds: targets.map((u) => u.id),
                        durationMs
                    });
                    if (!script) return;

                    if (cmd === 'whitelist') {
                        await applyWhitelistForTargets(script, targets, durationMs);
                        await interaction.reply({
                            content: `✅ **${targets.length}** istifadəçi **${script.name}** skriptinə whitelist edildi.`,
                            ephemeral: true
                        });
                    } else {
                        const removed = await removeWhitelistForTargets(script, targets);
                        await interaction.reply({
                            content: `✅ **${script.name}** skriptindən **${removed}** whitelist qeydi silindi.`,
                            ephemeral: true
                        });
                    }
                    return;
                }

                if (cmd === 'resethwid') {
                    const user = interaction.options.getUser('user', true);
                    const scriptQuery = interaction.options.getString('script');
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'resethwid',
                        targetUserId: user.id
                    });
                    if (!script) return;

                    const wl = getActiveWhitelist(user.id, script.id);
                    const keyRec = getUserKeyForScript(user.id, script.id);
                    if (wl) wl.hwid = null;
                    if (keyRec) keyRec.hwid = null;
                    persistState();

                    await interaction.reply({
                        content: `✅ <@${user.id}> üçün **${script.name}** HWID kilidi sıfırlandı.`,
                        ephemeral: true
                    });
                    return;
                }

                if (cmd === 'cooldownhwid') {
                    const timeStr = interaction.options.getString('time', true);
                    const scriptQuery = interaction.options.getString('script');
                    const durationMs = parseDurationToMs(timeStr);
                    if (durationMs === undefined) {
                        await interaction.reply({
                            content: '❌ Yanlış müddət formatı. Məs: `1h`, `12h`, `1d` və ya `0`.',
                            ephemeral: true
                        });
                        return;
                    }
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'cooldownhwid',
                        durationMs
                    });
                    if (!script) return;
                    state.hwidCooldowns[script.id] = durationMs || 0;
                    persistState();
                    await interaction.reply({
                        content: `✅ **${script.name}** üçün HWID sıfırlama gözləmə müddəti yeniləndi.`,
                        ephemeral: true
                    });
                    return;
                }
            }

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sp_select_script:')) {
                const token = interaction.customId.split(':')[1];
                const pending = pendingSelections.get(token);
                if (!pending || pending.ownerId !== interaction.user.id) {
                    await interaction.reply({ content: '❌ Bu seçim menyusu artıq aktiv deyil.', ephemeral: true });
                    return;
                }
                pendingSelections.delete(token);
                const scriptId = interaction.values[0];
                const script = getScriptById(scriptId);
                if (!script) {
                    await interaction.update({ content: '❌ Seçilən skript tapılmadı.', components: [] });
                    return;
                }

                if (pending.type === 'setpanel') {
                    const ch = await interaction.guild.channels.fetch(pending.channelId);
                    await executePanelPost(ch, pending.panelName, script);
                    await interaction.update({
                        content: `✅ **${script.name}** üçün panel kanala göndərildi!`,
                        components: []
                    });
                } else if (pending.type === 'genkey') {
                    const created = [];
                    for (let i = 0; i < pending.amount; i++) {
                        const code = generateKeyCode();
                        state.keys.push({
                            id: generateId('key'),
                            code,
                            scriptId: script.id,
                            durationMs: pending.durationMs,
                            expiresAt: null,
                            redeemedBy: null,
                            redeemedAt: null,
                            hwid: null,
                            disabled: false,
                            createdAt: nowMs()
                        });
                        created.push(code);
                    }
                    persistState();
                    await interaction.update({
                        content: `✅ **${script.name}** üçün **${created.length}** key yaradıldı:\n\`\`\`\n${created.join('\n')}\n\`\`\``,
                        components: []
                    });
                } else if (pending.type === 'whitelist') {
                    const targets = pending.targetUserIds.map((id) => ({ id }));
                    await applyWhitelistForTargets(script, targets, pending.durationMs);
                    await interaction.update({
                        content: `✅ **${targets.length}** istifadəçi **${script.name}** skriptinə whitelist edildi.`,
                        components: []
                    });
                } else if (pending.type === 'unwhitelist') {
                    const targets = pending.targetUserIds.map((id) => ({ id }));
                    const removed = await removeWhitelistForTargets(script, targets);
                    await interaction.update({
                        content: `✅ **${script.name}** skriptindən **${removed}** whitelist silindi.`,
                        components: []
                    });
                } else if (pending.type === 'resethwid') {
                    const wl = getActiveWhitelist(pending.targetUserId, script.id);
                    const keyRec = getUserKeyForScript(pending.targetUserId, script.id);
                    if (wl) wl.hwid = null;
                    if (keyRec) keyRec.hwid = null;
                    persistState();
                    await interaction.update({
                        content: `✅ <@${pending.targetUserId}> üçün **${script.name}** HWID sıfırlandı.`,
                        components: []
                    });
                } else if (pending.type === 'cooldownhwid') {
                    state.hwidCooldowns[script.id] = pending.durationMs || 0;
                    persistState();
                    await interaction.update({
                        content: `✅ **${script.name}** HWID gözləmə müddəti yeniləndi.`,
                        components: []
                    });
                }
                return;
            }

            if (interaction.isButton() && interaction.customId.startsWith('sp_')) {
                const [action, scriptId] = interaction.customId.split(':');
                const script = getScriptById(scriptId);
                if (!script) {
                    await interaction.reply({ content: '❌ Bu panelə bağlı skript tapılmadı.', ephemeral: true });
                    return;
                }

                if (action === 'sp_redeem') {
                    const modal = new ModalBuilder()
                        .setCustomId(`sp_redeem_modal:${script.id}`)
                        .setTitle(`${script.name} • Key Aktivləşdir`.slice(0, 45));
                    const keyInput = new TextInputBuilder()
                        .setCustomId('key_code')
                        .setLabel('Key kodunuzu daxil edin')
                        .setPlaceholder('SADO-XXXXXX-XXXXXX-XXXXXX')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
                    await interaction.showModal(modal);
                    return;
                }

                if (action === 'sp_getscript') {
                    if (script.disabled) {
                        await interaction.reply({
                            content: '⛔ Bu skript hazırda sahibi tərəfindən deaktiv edilib.',
                            ephemeral: true
                        });
                        return;
                    }
                    const wl = ensureUserLoaderToken(interaction.user.id, script.id);
                    if (!wl) {
                        await interaction.reply({
                            content: `❌ Sizin **${script.name}** skripti üçün whitelist və ya key-iniz yoxdur.`,
                            ephemeral: true
                        });
                        return;
                    }
                    const snippet = buildLoaderSnippet(PUBLIC_BASE_URL, script.id, interaction.user.id, wl.loaderToken);
                    await interaction.reply({
                        content:
                            `✅ **${script.name}** yükləyici kodu (yalnız sizin üçün):\n` +
                            `\`\`\`lua\n${snippet}\n\`\`\`\n` +
                            `⏳ Bitmə vaxtı: ${formatExpiry(wl.expiresAt)}`,
                        ephemeral: true
                    });
                    return;
                }

                if (action === 'sp_resethwid') {
                    const wl = getActiveWhitelist(interaction.user.id, script.id);
                    const keyRec = getUserKeyForScript(interaction.user.id, script.id);
                    if (!wl && !keyRec) {
                        await interaction.reply({
                            content: `❌ Sizin **${script.name}** skripti üçün aktiv icazəniz yoxdur.`,
                            ephemeral: true
                        });
                        return;
                    }
                    const cooldownMs = Number(state.hwidCooldowns[script.id] || 0);
                    const resetKey = `${interaction.user.id}:${script.id}`;
                    const lastReset = Number(state.lastHwidReset[resetKey] || 0);
                    if (cooldownMs > 0 && lastReset && nowMs() - lastReset < cooldownMs) {
                        const nextTs = Math.floor((lastReset + cooldownMs) / 1000);
                        await interaction.reply({
                            content: `⏳ HWID sıfırlama gözləmə müddətindəsiniz. Yenidən cəhd: <t:${nextTs}:R>.`,
                            ephemeral: true
                        });
                        return;
                    }
                    if (wl) wl.hwid = null;
                    if (keyRec) keyRec.hwid = null;
                    state.lastHwidReset[resetKey] = nowMs();
                    persistState();
                    await interaction.reply({
                        content: `✅ **${script.name}** üçün HWID kilidiniz sıfırlandı.`,
                        ephemeral: true
                    });
                    return;
                }

                if (action === 'sp_getstats') {
                    const wl = getActiveWhitelist(interaction.user.id, script.id);
                    const keyRec = getUserKeyForScript(interaction.user.id, script.id);
                    if (!wl && !keyRec) {
                        await interaction.reply({
                            content: `❌ Sizin **${script.name}** skripti üçün aktiv whitelist və ya key-iniz yoxdur.`,
                            ephemeral: true
                        });
                        return;
                    }
                    const hwidVal = (wl && wl.hwid) || (keyRec && keyRec.hwid) || 'Bağlanmayıb';
                    const expVal = (wl && wl.expiresAt) || (keyRec && keyRec.expiresAt) || null;
                    const maskedKey = keyRec ? `${keyRec.code.slice(0, 9)}********` : 'Birbaşa Whitelist';
                    const embed = new EmbedBuilder()
                        .setTitle(`📊 ${script.name} • Key Məlumatı`)
                        .setDescription(
                            `• **Status:** ✅ Aktiv\n` +
                                `• **Key:** \`${maskedKey}\`\n` +
                                `• **HWID:** \`${hwidVal}\`\n` +
                                `• **Müddət:** ${formatExpiry(expVal)}`
                        )
                        .setColor(0x2ecc71);
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    return;
                }
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('sp_redeem_modal:')) {
                const scriptId = interaction.customId.split(':')[1];
                const script = getScriptById(scriptId);
                if (!script) {
                    await interaction.reply({ content: '❌ Skript tapılmadı.', ephemeral: true });
                    return;
                }
                const entered = interaction.fields.getTextInputValue('key_code').trim().toUpperCase();
                const keyRec = state.keys.find((k) => k.code.toUpperCase() === entered);
                if (!keyRec) {
                    await interaction.reply({ content: '❌ Daxil edilən key yanlışdır.', ephemeral: true });
                    return;
                }
                if (keyRec.scriptId !== script.id) {
                    await interaction.reply({
                        content: '❌ Bu key başqa skriptə aiddir, bu paneldə istifadə edilə bilməz.',
                        ephemeral: true
                    });
                    return;
                }
                if (keyRec.disabled) {
                    await interaction.reply({ content: '❌ Bu key ləğv edilib.', ephemeral: true });
                    return;
                }
                if (keyRec.redeemedBy && keyRec.redeemedBy !== String(interaction.user.id)) {
                    await interaction.reply({
                        content: '❌ Bu key artıq başqa istifadəçi tərəfindən aktivləşdirilib (1 key = 1 nəfər).',
                        ephemeral: true
                    });
                    return;
                }
                if (keyRec.expiresAt && isExpired(keyRec.expiresAt)) {
                    await interaction.reply({ content: '❌ Bu key-in vaxtı bitib.', ephemeral: true });
                    return;
                }

                if (!keyRec.redeemedBy) {
                    keyRec.redeemedBy = String(interaction.user.id);
                    keyRec.redeemedAt = nowMs();
                    keyRec.expiresAt = keyRec.durationMs ? nowMs() + keyRec.durationMs : null;
                }

                const existingWl = getActiveWhitelist(interaction.user.id, script.id);
                if (existingWl) {
                    existingWl.expiresAt = keyRec.expiresAt;
                    existingWl.revoked = false;
                } else {
                    state.whitelists.push({
                        id: generateId('wl'),
                        userId: String(interaction.user.id),
                        scriptId: script.id,
                        expiresAt: keyRec.expiresAt,
                        hwid: keyRec.hwid || null,
                        loaderToken: crypto.randomBytes(16).toString('hex'),
                        createdAt: nowMs(),
                        revoked: false
                    });
                }
                persistState();

                await interaction.reply({
                    content:
                        `✅ Key uğurla aktivləşdirildi! **${script.name}** üçün icazəniz açıldı.\n` +
                        `⏳ Müddət: ${formatExpiry(keyRec.expiresAt)}\n` +
                        `İndi paneldə **Get Script** düyməsinə basıb skripti götürə bilərsiniz.`,
                    ephemeral: true
                });
            }
        } catch (err) {
            console.error('[SADO PROTECT] Interaction xətası:', err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Xəta baş verdi, yenidən cəhd edin.', ephemeral: true }).catch(() => {});
            }
        }
    });
}

async function startOrRestartBot() {
    if (!runtimeBotToken) return false;
    if (botBootPromise) return botBootPromise;

    botBootPromise = (async () => {
        try {
            if (client) {
                try {
                    await client.destroy();
                } catch (_) {}
                client = null;
            }
            const nextClient = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMembers
                ],
                partials: [Partials.Channel]
            });
            attachBotHandlers(nextClient);
            await nextClient.login(runtimeBotToken);
            client = nextClient;
            return true;
        } finally {
            botBootPromise = null;
        }
    })();

    return botBootPromise;
}

function getGuildsWithRolesSummary() {
    if (!client || !client.guilds) return [];
    return client.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name,
        roles: g.roles.cache
            .filter((r) => r.id !== g.id && !r.managed)
            .sort((a, b) => b.position - a.position)
            .map((r) => ({ id: r.id, name: r.name })),
        channels: g.channels.cache
            .filter((c) => c.type === ChannelType.GuildText)
            .map((c) => ({ id: c.id, name: c.name }))
    }));
}

function checkPanelAuth(req, reqUrl) {
    if (!PANEL_TOKEN) return true;
    const headerTok = String(req.headers['x-panel-token'] || '').trim();
    const queryTok = String(reqUrl.searchParams.get('token') || '').trim();
    return headerTok === PANEL_TOKEN || queryTok === PANEL_TOKEN;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 5 * 1024 * 1024) {
                reject(new Error('Payload çox böyükdür'));
            }
        });
        req.on('end', () => {
            if (!raw.trim()) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(new Error('Yanlış JSON formatı'));
            }
        });
        req.on('error', reject);
    });
}

function renderDashboardHtml() {
    return `<!doctype html>
<html lang="az">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SADO PROTECT Studio</title>
<style>
  :root { --bg:#0b0f19; --card:#131a2a; --border:#24304a; --text:#eef2ff; --muted:#94a3b8; --accent:#6366f1; --ok:#10b981; --bad:#ef4444; }
  * { box-sizing:border-box; font-family:Inter,system-ui,sans-serif; }
  body { margin:0; background:var(--bg); color:var(--text); padding:20px; }
  .wrap { max-width:1100px; margin:0 auto; display:grid; gap:18px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; }
  h1,h2,h3 { margin:0 0 10px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  input,textarea,select { background:#0b1120; color:var(--text); border:1px solid var(--border); border-radius:10px; padding:10px 12px; width:100%; }
  textarea { min-height:140px; font-family:monospace; }
  button { background:var(--accent); color:#fff; border:none; border-radius:10px; padding:10px 16px; font-weight:600; cursor:pointer; }
  button.bad { background:var(--bad); }
  button.ok { background:var(--ok); }
  .badge { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; background:#1e293b; }
  .list { display:grid; gap:8px; margin-top:10px; }
  .item { background:#0b1120; border:1px solid var(--border); border-radius:10px; padding:10px 12px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
  code { background:#090d16; padding:2px 6px; border-radius:6px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🛡️ SADO PROTECT Studio</h1>
    <div class="row">
      <span id="botStatus" class="badge">Bot yoxlanılır...</span>
      <span id="cloudStatus" class="badge">Yaddaş yoxlanılır...</span>
      <span id="counts" class="badge">0 Skript • 0 Key • 0 Whitelist</span>
    </div>
  </div>

  <div class="card">
    <h2>1. Discord Bot Token</h2>
    <div class="row">
      <input id="botTokenInput" type="password" placeholder="Discord Bot Token daxil edin..." />
      <button onclick="saveBotToken()">Tokeni Yadda Saxla və Botu Başlat</button>
    </div>
  </div>

  <div class="card">
    <h2>2. Yeni Skript Əlavə Et</h2>
    <div class="list">
      <input id="scriptName" placeholder="Skript adı (məs: SADO HUB)" />
      <textarea id="scriptCode" placeholder="-- Lua skript kodunuzu bura yapışdırın..."></textarea>
      <button class="ok" onclick="createScript()">Skripti Yadda Saxla</button>
    </div>
    <div id="scriptsList" class="list"></div>
  </div>

  <div class="card">
    <h2>3. Key Yarat və Whitelist İdarəsi</h2>
    <div class="row">
      <select id="targetScript"></select>
      <input id="keyDuration" placeholder="Müddət (məs: 1d, 7d, 30d, 0)" value="0" />
      <input id="keyAmount" type="number" min="1" max="50" value="1" />
      <button onclick="generateKeys()">Key Yarat</button>
    </div>
    <pre id="generatedKeysBox" style="background:#090d16;padding:10px;border-radius:10px;display:none;"></pre>
    <div class="row" style="margin-top:10px;">
      <input id="wlUserId" placeholder="Discord User ID (məs: 123456789012345678)" />
      <button class="ok" onclick="addWhitelist()">Whitelist Et</button>
    </div>
    <div id="whitelistsBox" class="list"></div>
  </div>

  <div class="card">
    <h2>4. Ehtiyat Nüsxə (Backup / Bərpa)</h2>
    <div class="row">
      <button onclick="downloadBackup()">Backup JSON Yüklə</button>
      <input id="restoreFile" type="file" accept=".json" />
      <button class="ok" onclick="restoreBackup()">Backup-dan Bərpa Et</button>
    </div>
  </div>
</div>

<script>
const urlToken = new URLSearchParams(location.search).get('token') || '';
function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (urlToken) h['x-panel-token'] = urlToken;
  return h;
}

async function refreshState() {
  const res = await fetch('/api/state', { headers: apiHeaders() });
  const data = await res.json();
  if (!data.ok) return;
  document.getElementById('botStatus').textContent = data.botReady ? ('✅ Bot Aktiv: ' + data.botTag) : '⚠️ Bot Qoşulmayıb';
  document.getElementById('cloudStatus').textContent = data.cloudConnected ? '☁️ Bulud Yaddaş Aktiv' : '💾 Lokal Yaddaş (Backup tövsiyə olunur)';
  document.getElementById('counts').textContent = data.scripts.length + ' Skript • ' + data.keysCount + ' Key • ' + data.whitelistsCount + ' Whitelist';

  const sel = document.getElementById('targetScript');
  const prev = sel.value;
  sel.innerHTML = data.scripts.map(s => '<option value="' + s.id + '">' + s.name + '</option>').join('');
  if (prev) sel.value = prev;

  document.getElementById('scriptsList').innerHTML = data.scripts.map(s =>
    '<div class="item"><div><b>' + s.name + '</b> <code>' + s.id + '</code></div>' +
    '<button class="bad" onclick="deleteScript(\\'' + s.id + '\\')">Sil</button></div>'
  ).join('');

  document.getElementById('whitelistsBox').innerHTML = data.whitelists.map(w =>
    '<div class="item"><div>User: <code>' + w.userId + '</code> • Skript: <b>' + w.scriptName + '</b></div>' +
    '<button class="bad" onclick="removeWhitelist(\\'' + w.id + '\\')">Sil</button></div>'
  ).join('');
}

async function saveBotToken() {
  const token = document.getElementById('botTokenInput').value.trim();
  if (!token) return alert('Token daxil edin');
  const res = await fetch('/api/bot-token', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ token }) });
  const d = await res.json();
  alert(d.message || (d.ok ? 'Bot başladıldı!' : 'Xəta'));
  refreshState();
}

async function createScript() {
  const name = document.getElementById('scriptName').value.trim();
  const code = document.getElementById('scriptCode').value;
  if (!name || !code.trim()) return alert('Ad və kod daxil edin');
  await fetch('/api/scripts', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ name, code }) });
  document.getElementById('scriptName').value = '';
  document.getElementById('scriptCode').value = '';
  refreshState();
}

async function deleteScript(id) {
  await fetch('/api/scripts/' + encodeURIComponent(id), { method: 'DELETE', headers: apiHeaders() });
  refreshState();
}

async function generateKeys() {
  const scriptId = document.getElementById('targetScript').value;
  const time = document.getElementById('keyDuration').value;
  const amount = Number(document.getElementById('keyAmount').value || 1);
  const res = await fetch('/api/keys', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ scriptId, time, amount }) });
  const d = await res.json();
  if (d.keys) {
    const box = document.getElementById('generatedKeysBox');
    box.style.display = 'block';
    box.textContent = d.keys.join('\\n');
  }
  refreshState();
}

async function addWhitelist() {
  const scriptId = document.getElementById('targetScript').value;
  const userId = document.getElementById('wlUserId').value.trim();
  const time = document.getElementById('keyDuration').value;
  if (!scriptId || !userId) return alert('Skript və User ID seçin');
  await fetch('/api/whitelist', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ scriptId, userId, time }) });
  document.getElementById('wlUserId').value = '';
  refreshState();
}

async function removeWhitelist(id) {
  await fetch('/api/whitelist/' + encodeURIComponent(id), { method: 'DELETE', headers: apiHeaders() });
  refreshState();
}

async function downloadBackup() {
  const res = await fetch('/api/backup', { headers: apiHeaders() });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sado-protect-backup.json';
  a.click();
}

async function restoreBackup() {
  const file = document.getElementById('restoreFile').files[0];
  if (!file) return alert('JSON faylı seçin');
  const text = await file.text();
  const res = await fetch('/api/restore', { method: 'POST', headers: apiHeaders(), body: text });
  const d = await res.json();
  alert(d.ok ? 'Bərpa tamamlandı!' : ('Xəta: ' + d.message));
  refreshState();
}

refreshState();
setInterval(refreshState, 8000);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
    try {
        const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (reqUrl.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, botReady: Boolean(client && client.user), uptime: process.uptime() }));
            return;
        }

        if (reqUrl.pathname.startsWith('/raw/') && req.method === 'GET') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/raw/'.length));
            const uid = String(reqUrl.searchParams.get('uid') || '').trim();
            const tok = String(reqUrl.searchParams.get('t') || '').trim();
            const hwid = String(req.headers['x-hwid'] || reqUrl.searchParams.get('hwid') || '').trim();

            const script = getScriptById(scriptId);
            if (!script || script.disabled) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: Skript deaktivdir və ya tapılmadı.');
                return;
            }
            const wl = getActiveWhitelist(uid, script.id);
            if (!wl || !tok || wl.loaderToken !== tok) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: İcazə yoxdur (Not Whitelisted).');
                return;
            }
            if (hwid) {
                if (wl.hwid && wl.hwid !== hwid) {
                    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('-- SADO PROTECT: HWID uyğun gəlmir. Discord paneldən Reset HWID edin.');
                    return;
                }
                if (!wl.hwid) {
                    wl.hwid = hwid;
                    const keyRec = getUserKeyForScript(uid, script.id);
                    if (keyRec) keyRec.hwid = hwid;
                    persistState();
                }
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(script.code || '');
            return;
        }

        if (reqUrl.pathname === '/' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderDashboardHtml());
            return;
        }

        if (!checkPanelAuth(req, reqUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, authRequired: true, message: 'Panel token tələb olunur.' }));
            return;
        }

        if (reqUrl.pathname === '/api/state' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    ok: true,
                    authRequired: Boolean(PANEL_TOKEN),
                    cloudConnected: Boolean((UPSTASH_URL && UPSTASH_TOKEN) || (JSONBIN_ID && JSONBIN_KEY)),
                    botReady: Boolean(client && client.user),
                    botTag: client && client.user ? client.user.tag : null,
                    hasBotToken: Boolean(runtimeBotToken),
                    panelButtonConfig: state.panelButtonConfig,
                    guilds: getGuildsWithRolesSummary(),
                    scripts: state.scripts.map((s) => ({
                        id: s.id,
                        name: s.name,
                        code: s.code || '',
                        disabled: Boolean(s.disabled),
                        createdAt: s.createdAt
                    })),
                    keysCount: state.keys.length,
                    whitelistsCount: state.whitelists.filter((w) => !w.revoked && !isExpired(w.expiresAt)).length,
                    recentKeys: state.keys.slice(-20).reverse().map(enrichMemberEntry),
                    whitelists: state.whitelists
                        .filter((w) => !w.revoked && !isExpired(w.expiresAt))
                        .slice(-50)
                        .reverse()
                        .map(enrichMemberEntry)
                })
            );
            return;
        }

        if (reqUrl.pathname === '/api/bot-token' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const tok = String(body.token || '').trim();
            if (!tok) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Token boş ola bilməz.' }));
                return;
            }
            runtimeBotToken = tok;
            state.savedBotToken = tok;
            persistState();
            await startOrRestartBot();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, message: 'Token yadda saxlanıldı və bot işə salındı!' }));
            return;
        }

        if (reqUrl.pathname === '/api/scripts' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const name = String(body.name || '').trim();
            const code = String(body.code || '');
            if (!name || !code.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript adı və kodu tələb olunur.' }));
                return;
            }
            const script = {
                id: generateId('scr'),
                name,
                code,
                disabled: false,
                createdAt: nowMs()
            };
            state.scripts.push(script);
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, script }));
            return;
        }

        if (reqUrl.pathname.startsWith('/api/scripts/') && req.method === 'DELETE') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/api/scripts/'.length));
            state.scripts = state.scripts.filter((s) => s.id !== scriptId);
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (reqUrl.pathname === '/api/keys' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const script = getScriptById(String(body.scriptId || ''));
            if (!script) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                return;
            }
            const durationMs = parseDurationToMs(body.time);
            const amount = Math.max(1, Math.min(50, Number(body.amount || 1)));
            const keys = [];
            for (let i = 0; i < amount; i++) {
                const code = generateKeyCode();
                state.keys.push({
                    id: generateId('key'),
                    code,
                    scriptId: script.id,
                    durationMs: durationMs === undefined ? null : durationMs,
                    expiresAt: null,
                    redeemedBy: null,
                    redeemedAt: null,
                    hwid: null,
                    disabled: false,
                    createdAt: nowMs()
                });
                keys.push(code);
            }
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, keys }));
            return;
        }

        if (reqUrl.pathname === '/api/whitelist' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const script = getScriptById(String(body.scriptId || ''));
            const userId = String(body.userId || '').trim();
            if (!script || !userId) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript və User ID tələb olunur.' }));
                return;
            }
            const durationMs = parseDurationToMs(body.time);
            await applyWhitelistForTargets(script, [{ id: userId }], durationMs === undefined ? null : durationMs);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (reqUrl.pathname.startsWith('/api/whitelist/') && req.method === 'DELETE') {
            const wlId = decodeURIComponent(reqUrl.pathname.slice('/api/whitelist/'.length));
            const entry = state.whitelists.find((w) => w.id === wlId);
            if (entry) {
                entry.revoked = true;
                persistState();
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (reqUrl.pathname === '/api/backup' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': 'attachment; filename="sado-protect-backup.json"'
            });
            res.end(JSON.stringify(state, null, 2));
            return;
        }

        if (reqUrl.pathname === '/api/restore' && req.method === 'POST') {
            const parsed = await readJsonBody(req);
            if (!parsed || typeof parsed !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Yanlış backup faylı.' }));
                return;
            }
            applyLoadedObject(parsed);
            persistState();
            if (runtimeBotToken) {
                startOrRestartBot().catch(() => {});
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Endpoint tapılmadı.' }));
    } catch (err) {
        console.error('[SADO PROTECT] HTTP server xətası:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: err.message || 'Server xətası' }));
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`[SADO PROTECT] HTTP server ${PORT} portunda işləyir (${PUBLIC_BASE_URL})`);
    await hydrateFromCloudIfAvailable();
    if (!runtimeBotToken) {
        console.error('[SADO PROTECT] Qeyd: DISCORD_BOT_TOKEN hələ təyin edilməyib. Veb paneldən və ya Render Environment Variables bölməsindən daxil edə bilərsiniz.');
    } else {
        startOrRestartBot().catch((err) => {
            console.error('[SADO PROTECT] Discord login xətası:', err.message);
        });
    }
});
