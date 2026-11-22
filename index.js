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
const PUBLIC_BASE_URL = String(
    process.env.PUBLIC_BASE_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        `http://localhost:${PORT}`
).replace(/\/+$/, '');
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 4 * 60 * 1000);

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
            redeemStyle: 'Success',
            getScriptLabel: 'Get Script',
            getScriptEmoji: '📜',
            getScriptStyle: 'Primary',
            resetHwidLabel: 'Reset HWID',
            resetHwidEmoji: '🔄',
            resetHwidStyle: 'Secondary',
            getStatsLabel: 'Get Stats',
            getStatsEmoji: '📊',
            getStatsStyle: 'Secondary',
            embedColor: '#5865F2'
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

function resolveUserDisplayName(userId) {
    if (!userId) return null;
    const uid = String(userId);
    const prof = state.userProfiles[uid];
    if (prof && prof.tag) return `${prof.tag} (${uid})`;
    if (client && client.users) {
        const cached = client.users.cache.get(uid);
        if (cached) {
            rememberUserProfile(cached);
            return `${cached.tag || cached.username} (${uid})`;
        }
    }
    return uid;
}

function enrichMemberEntry(entry) {
    const uid = String(entry.userId || entry.redeemedBy || '');
    const prof = uid ? state.userProfiles[uid] : null;
    const scr = entry.scriptId ? getScriptById(entry.scriptId) : null;
    return {
        ...entry,
        username: prof ? prof.tag : null,
        redeemedByName: entry.redeemedBy ? resolveUserDisplayName(entry.redeemedBy) : null,
        createdByName: entry.createdByName || (entry.createdBy ? resolveUserDisplayName(entry.createdBy) : 'Veb Panel'),
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

function parseButtonStyle(styleName, fallback) {
    const val = String(styleName || '').trim().toLowerCase();
    if (val === 'primary' || val === 'blue' || val === 'blurple') return ButtonStyle.Primary;
    if (val === 'success' || val === 'green') return ButtonStyle.Success;
    if (val === 'danger' || val === 'red') return ButtonStyle.Danger;
    if (val === 'secondary' || val === 'gray' || val === 'grey') return ButtonStyle.Secondary;
    return fallback;
}

function parseHexColor(hexStr, fallback = 0x5865f2) {
    const cleaned = String(hexStr || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        return parseInt(cleaned, 16);
    }
    return fallback;
}

function buildStyledButton(customId, label, emoji, style) {
    const btn = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(String(label || 'Button').slice(0, 80))
        .setStyle(style);
    const cleanEmoji = String(emoji || '').trim();
    if (cleanEmoji) {
        try {
            btn.setEmoji(cleanEmoji);
        } catch (_) {}
    }
    return btn;
}

function buildPanelComponents(scriptId) {
    const cfg = state.panelButtonConfig;
    const row = new ActionRowBuilder().addComponents(
        buildStyledButton(
            `sp_redeem:${scriptId}`,
            cfg.redeemLabel || 'Redeem Key',
            cfg.redeemEmoji,
            parseButtonStyle(cfg.redeemStyle, ButtonStyle.Success)
        ),
        buildStyledButton(
            `sp_getscript:${scriptId}`,
            cfg.getScriptLabel || 'Get Script',
            cfg.getScriptEmoji,
            parseButtonStyle(cfg.getScriptStyle, ButtonStyle.Primary)
        ),
        buildStyledButton(
            `sp_resethwid:${scriptId}`,
            cfg.resetHwidLabel || 'Reset HWID',
            cfg.resetHwidEmoji,
            parseButtonStyle(cfg.resetHwidStyle, ButtonStyle.Secondary)
        ),
        buildStyledButton(
            `sp_getstats:${scriptId}`,
            cfg.getStatsLabel || 'Get Stats',
            cfg.getStatsEmoji,
            parseButtonStyle(cfg.getStatsStyle, ButtonStyle.Secondary)
        )
    );
    return [row];
}

function buildPanelEmbed(panelTitle, script) {
    const cfg = state.panelButtonConfig;
    const rLabel = cfg.redeemLabel || 'Redeem Key';
    const gLabel = cfg.getScriptLabel || 'Get Script';
    const hLabel = cfg.resetHwidLabel || 'Reset HWID';
    const sLabel = cfg.getStatsLabel || 'Get Stats';
    return new EmbedBuilder()
        .setTitle(panelTitle || 'SADOHUB')
        .setDescription(
            `Skript: **${script.name}**\n` +
                `• Key aktivləşdirmək üçün **${rLabel}**\n` +
                `• Qısa skripti almaq üçün **${gLabel}**\n` +
                `• Cihazı sıfırlamaq üçün **${hLabel}**\n` +
                `• Key və HWID məlumatına baxmaq üçün **${sLabel}**`
        )
        .setColor(parseHexColor(cfg.embedColor, 0x5865f2))
        .setFooter({ text: 'SADO PROTECT • Hər skriptə ayrı whitelist və 1 nəfərlik key sistemi' })
        .setTimestamp();
}

function buildLoaderSnippet(baseUrl, scriptId, userId, token, licenseKey) {
    const cleanBase = String(baseUrl || PUBLIC_BASE_URL).replace(/\/+$/, '');
    const url = `${cleanBase}/raw/${encodeURIComponent(scriptId)}?uid=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
    const safeKey = String(licenseKey || 'WHITELIST').replace(/"/g, '\\"');
    return `script_key = "${safeKey}"\nloadstring(game:HttpGet("${url}"))()`;
}

function ensureUserLoaderToken(userId, scriptId) {
    const cleanUserId = String(userId || '').trim();
    const keyRecord = ensureAutoKeyForUser(cleanUserId, scriptId);
    let wl = getActiveWhitelist(cleanUserId, scriptId);
    if (!wl) {
        if (!keyRecord) return null;
        wl = {
            id: generateId('wl'),
            userId: cleanUserId,
            scriptId,
            expiresAt: keyRecord.expiresAt || null,
            hwid: keyRecord.hwid || null,
            hwidLockEpoch: Number(keyRecord.hwidLockEpoch || 1),
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
    if (typeof wl.hwidLockEpoch !== 'number') {
        wl.hwidLockEpoch = Number(keyRecord?.hwidLockEpoch || 1);
        persistState();
    }
    return wl;
}

function ensureAutoKeyForUser(userId, scriptId, durationMs = null, creatorId = null, creatorName = 'Auto Whitelist') {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return null;
    let existing = getUserKeyForScript(cleanUserId, scriptId);
    if (existing) return existing;

    const expiresAt = durationMs ? nowMs() + durationMs : null;
    existing = {
        id: generateId('key'),
        code: generateKeyCode(),
        scriptId,
        durationMs: durationMs || null,
        expiresAt,
        createdBy: creatorId || null,
        createdByName: creatorName || 'Auto Whitelist',
        redeemedBy: cleanUserId,
        redeemedByName: resolveUserDisplayName(cleanUserId),
        redeemedAt: nowMs(),
        hwid: null,
        hwidLockEpoch: 1,
        autoGenerated: true,
        disabled: false,
        createdAt: nowMs()
    };
    state.keys.push(existing);
    return existing;
}

function resetUserHwidBinding(userId, scriptId) {
    const cleanUserId = String(userId || '').trim();
    const wl = getActiveWhitelist(cleanUserId, scriptId);
    const keyRec = getUserKeyForScript(cleanUserId, scriptId);
    const nextEpoch =
        Math.max(
            Number(wl?.hwidLockEpoch || 1),
            Number(keyRec?.hwidLockEpoch || 1)
        ) + 1;

    if (wl) {
        wl.hwid = null;
        wl.hwidLockEpoch = nextEpoch;
    }
    if (keyRec) {
        keyRec.hwid = null;
        keyRec.hwidLockEpoch = nextEpoch;
    }
}

function buildHwidGuardedLuaPayload(scriptCode, boundHwid, lockEpoch, kickReason) {
    const safeHwid = String(boundHwid || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeReason = String(kickReason || 'HWID uyğun deyil! Cihaz başqa cihazla dəyişdirilib.')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    const safeEpoch = Number(lockEpoch || 1);

    const guardHeader = [
        '-- SADO PROTECT HWID GUARD',
        `local __SADO_EXPECTED_HWID = "${safeHwid}"`,
        `local __SADO_LOCK_EPOCH = ${safeEpoch}`,
        `local __SADO_KICK_MSG = "${safeReason}"`,
        'local function __sado_get_hwid()',
        '    local ok, val = pcall(function()',
        '        if typeof(gethwid) == "function" then return gethwid() end',
        '        if getgenv and type(getgenv().gethwid) == "function" then return getgenv().gethwid() end',
        '        if syn and syn.crypto and type(syn.crypto.customhash) == "function" then',
        '            local lp = game:GetService("Players").LocalPlayer',
        '            return syn.crypto.customhash(tostring(lp and lp.UserId or ""))',
        '        end',
        '        local rbxsid = game:GetService("RbxAnalyticsService"):GetClientId()',
        '        return tostring(rbxsid or "")',
        '    end)',
        '    if ok and val and tostring(val) ~= "" then return tostring(val) end',
        '    local lp = game:GetService("Players").LocalPlayer',
        '    return "UID_" .. tostring(lp and lp.UserId or "UNKNOWN")',
        'end',
        'local function __sado_kick_now(reason)',
        '    pcall(function()',
        '        local lp = game:GetService("Players").LocalPlayer',
        '        if lp then lp:Kick(reason) end',
        '    end)',
        '    task.spawn(function()',
        '        while task.wait(0.25) do',
        '            pcall(function()',
        '                local lp = game:GetService("Players").LocalPlayer',
        '                if lp then lp:Kick(reason) end',
        '            end)',
        '        end',
        '    end)',
        '    error(reason)',
        'end',
        'local __sado_current_hwid = __sado_get_hwid()',
        'if __SADO_EXPECTED_HWID ~= "" and __sado_current_hwid ~= __SADO_EXPECTED_HWID then',
        '    __sado_kick_now(__SADO_KICK_MSG)',
        'end'
    ].join('\n');

    return `${guardHeader}\n\n${scriptCode || ''}`;
}

const slashCommands = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Bu kanala skript paneli yerləşdir')
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Panelin bağlı olacağı skript')
                .setAutocomplete(true)
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('title').setDescription('Panel başlığı (məs: SADOHUB)').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('name').setDescription('Alternativ panel başlığı').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('setpanel')
        .setDescription('Bu kanala skript paneli yerləşdir')
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Panelin bağlı olacağı skript')
                .setAutocomplete(true)
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('title').setDescription('Panel başlığı (məs: SADOHUB)').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('name').setDescription('Alternativ panel başlığı').setRequired(false)
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
            opt
                .setName('script')
                .setDescription('Skript seçin (yaratdığınız skriptlər)')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('İstifadəçiyə və ya rola skript icazəsi ver')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Müddət: 1d, 7d, 30d və ya 0 (ömürlük)').setRequired(true)
        )
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(false))
        .addRoleOption((opt) => opt.setName('role').setDescription('Rol').setRequired(false))
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('İstifadəçinin və ya rolun whitelist icazəsini sil')
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(false))
        .addRoleOption((opt) => opt.setName('role').setDescription('Rol').setRequired(false))
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('Admin: istifadəçinin HWID kilidini sıfırla')
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(true))
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('cooldownhwid')
        .setDescription('Skript üçün istifadəçinin özünün HWID sıfırlama gözləmə müddəti')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Məs: 1h, 12h, 1d və ya 0 (gözləməsiz)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
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
const pendingCopySnippets = new Map();

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
        const uid = String(u && u.id ? u.id : u || '').trim();
        if (!uid) continue;
        rememberUserProfile(u);
        const autoKey = ensureAutoKeyForUser(
            uid,
            script.id,
            durationMs,
            null,
            'Whitelist Auto Key'
        );
        const existing = getActiveWhitelist(uid, script.id);
        if (existing) {
            existing.expiresAt = expiresAt;
            existing.revoked = false;
            if (!existing.loaderToken) {
                existing.loaderToken = crypto.randomBytes(16).toString('hex');
            }
            if (typeof existing.hwidLockEpoch !== 'number') {
                existing.hwidLockEpoch = Number(autoKey?.hwidLockEpoch || 1);
            }
        } else {
            state.whitelists.push({
                id: generateId('wl'),
                userId: uid,
                scriptId: script.id,
                expiresAt,
                hwid: autoKey?.hwid || null,
                hwidLockEpoch: Number(autoKey?.hwidLockEpoch || 1),
                loaderToken: crypto.randomBytes(16).toString('hex'),
                createdAt: nowMs(),
                revoked: false
            });
        }
    }
    persistState();
}

async function removeWhitelistForTargets(script, targetUsers) {
    const ids = new Set(
        targetUsers.map((u) => String(u && u.id ? u.id : u || '').trim()).filter(Boolean)
    );
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

function isRobloxExecutorRequest(req) {
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    const hasExecutorHeader = Boolean(
        req.headers['roblox-id'] ||
            req.headers['syn-fingerprint'] ||
            req.headers['krnl-hwid'] ||
            req.headers['flux-fingerprint'] ||
            req.headers['evon-hwid'] ||
            req.headers['x-executor'] ||
            req.headers['x-hwid']
    );
    if (hasExecutorHeader) return true;
    if (ua.includes('roblox')) return true;
    const secFetchSite = req.headers['sec-fetch-site'];
    const secFetchMode = req.headers['sec-fetch-mode'];
    if (secFetchSite || secFetchMode) return false;
    const accept = String(req.headers['accept'] || '').toLowerCase();
    if (accept.includes('text/html')) return false;
    return false;
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

            if (interaction.isAutocomplete()) {
                const focused = String(interaction.options.getFocused() || '').toLowerCase();
                const matches = state.scripts.filter(
                    (s) => !focused || s.name.toLowerCase().includes(focused) || s.id.toLowerCase().includes(focused)
                );
                const pool = matches.length > 0 ? matches : state.scripts;
                const choices = pool.slice(0, 25).map((s) => ({
                    name: s.name.slice(0, 100),
                    value: s.id
                }));
                await interaction.respond(choices);
                return;
            }

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

                if (cmd === 'setpanel' || cmd === 'panel') {
                    const panelName =
                        interaction.options.getString('title') ||
                        interaction.options.getString('name') ||
                        'SADOHUB';
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
                        amount,
                        creatorId: interaction.user.id,
                        creatorName: interaction.user.tag || interaction.user.username
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
                            createdBy: String(interaction.user.id),
                            createdByName: interaction.user.tag || interaction.user.username,
                            redeemedBy: null,
                            redeemedByName: null,
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
                        try {
                            await interaction.guild.members.fetch();
                        } catch (_) {}
                        for (const member of role.members.values()) {
                            if (member && member.user && !member.user.bot) {
                                targets.push(member.user);
                            }
                        }
                    }
                    targets = [...new Map(targets.filter((u) => u && u.id).map((u) => [String(u.id), u])).values()];

                    if (targets.length === 0) {
                        await interaction.reply({
                            content: '❌ Seçilən istifadəçi və ya rolda whitelist ediləcək üzv tapılmadı.',
                            ephemeral: true
                        });
                        return;
                    }

                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: cmd,
                        targetUserIds: targets.map((u) => String(u.id)),
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

                    resetUserHwidBinding(user.id, script.id);
                    persistState();

                    await interaction.reply({
                        content: `✅ <@${user.id}> üçün **${script.name}** HWID kilidi sıfırlandı. İndi skripti ilk açan cihaz həmin dövr üçün kilidlənəcək.`,
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
            } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sp_select_script:')) {
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
                            createdBy: pending.creatorId || String(interaction.user.id),
                            createdByName: pending.creatorName || interaction.user.tag || interaction.user.username,
                            redeemedBy: null,
                            redeemedByName: null,
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
                    resetUserHwidBinding(pending.targetUserId, script.id);
                    persistState();
                    await interaction.update({
                        content: `✅ <@${pending.targetUserId}> üçün **${script.name}** HWID kilidi sıfırlandı. İndi skripti ilk açan cihaz həmin dövr üçün kilidlənəcək.`,
                        components: []
                    });
                } else if (pending.type === 'cooldownhwid') {
                    state.hwidCooldowns[script.id] = pending.durationMs || 0;
                    persistState();
                    await interaction.update({
                        content: `✅ **${script.name}** üçün HWID sıfırlama gözləmə müddəti yeniləndi.`,
                        components: []
                    });
                }
                return;
            } else if (interaction.isButton() && interaction.customId.startsWith('sp_copyscript:')) {
                const copyId = interaction.customId.split(':')[1];
                const entry = pendingCopySnippets.get(copyId);
                if (!entry || entry.ownerId !== interaction.user.id || nowMs() > entry.expiresAt) {
                    await interaction.reply({
                        content: '❌ Kopyalama vaxtı bitib və ya bu buton sizə aid deyil. Yenidən **Get Script** basın.',
                        ephemeral: true
                    });
                    return;
                }
                await interaction.reply({
                    content: entry.snippet,
                    ephemeral: true
                });
                return;
            } else if (interaction.isButton() && interaction.customId.startsWith('sp_')) {
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
                    const keyRec = getUserKeyForScript(interaction.user.id, script.id);
                    const snippet = buildLoaderSnippet(
                        PUBLIC_BASE_URL,
                        script.id,
                        interaction.user.id,
                        wl.loaderToken,
                        keyRec ? keyRec.code : 'WHITELIST'
                    );
                    const copyId = generateId('cpy');
                    pendingCopySnippets.set(copyId, {
                        ownerId: interaction.user.id,
                        snippet,
                        expiresAt: nowMs() + 10 * 60 * 1000
                    });
                    const copyRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`sp_copyscript:${copyId}`)
                            .setLabel('Skripti Kopyala')
                            .setEmoji('📋')
                            .setStyle(ButtonStyle.Secondary)
                    );
                    await interaction.reply({
                        content:
                            `✅ **${script.name}** yükləyici kodu (yalnız sizin üçün):\n` +
                            `\`\`\`lua\n${snippet}\n\`\`\`\n` +
                            `⏳ Bitmə vaxtı: ${formatExpiry(wl.expiresAt)}`,
                        components: [copyRow],
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
                    resetUserHwidBinding(interaction.user.id, script.id);
                    state.lastHwidReset[resetKey] = nowMs();
                    persistState();
                    await interaction.reply({
                        content: `✅ **${script.name}** üçün HWID sıfırlandı. İndi skripti ilk işlədən cihaz bu key/whitelist-ə bağlanacaq.`,
                        ephemeral: true
                    });
                    return;
                }
// ... existing ...
        if (reqUrl.pathname.startsWith('/raw/') && req.method === 'GET') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/raw/'.length));
            const uid = String(reqUrl.searchParams.get('uid') || '').trim();
            const tok = String(reqUrl.searchParams.get('t') || '').trim();
            const hwid = String(
                req.headers['x-hwid'] ||
                    req.headers['syn-fingerprint'] ||
                    req.headers['krnl-hwid'] ||
                    req.headers['flux-fingerprint'] ||
                    req.headers['evon-hwid'] ||
                    req.headers['roblox-id'] ||
                    reqUrl.searchParams.get('hwid') ||
                    ''
            ).trim();

            if (!isRobloxExecutorRequest(req)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: Brauzerdən və ya icazəsiz sorğudan skript koduna baxmaq qadağandır.');
                return;
            }

            const script = getScriptById(scriptId);
            if (!script || script.disabled) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: Skript deaktivdir və ya tapılmadı.');
                return;
            }
            const wl = getActiveWhitelist(uid, script.id);
            const keyRec = getUserKeyForScript(uid, script.id);
            if (!wl || !tok || wl.loaderToken !== tok) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: İcazə yoxdur (Not Whitelisted).');
                return;
            }

            const currentBoundHwid = wl.hwid || (keyRec && keyRec.hwid) || null;
            const currentEpoch = Number(wl.hwidLockEpoch || (keyRec && keyRec.hwidLockEpoch) || 1);

            if (hwid) {
                if (currentBoundHwid && currentBoundHwid !== hwid) {
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(
                        'game:GetService("Players").LocalPlayer:Kick("SADO PROTECT: Bu key/whitelist başqa cihaza bağlıdır! Yeni cihaz üçün Reset HWID edin.")'
                    );
                    return;
                }
                if (!currentBoundHwid) {
                    wl.hwid = hwid;
                    wl.hwidLockEpoch = currentEpoch;
                    if (keyRec) {
                        keyRec.hwid = hwid;
                        keyRec.hwidLockEpoch = currentEpoch;
                    }
                    persistState();
                }
            }

            const effectiveBoundHwid = hwid || currentBoundHwid || '';
            const guardedScript = buildHwidGuardedLuaPayload(
                script.code || '',
                effectiveBoundHwid,
                currentEpoch,
                'SADO PROTECT: HWID uyğun gəlmir! Yenidən Reset HWID edilməyənə kimi bu cihazla giriş qadağandır.'
            );

            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(guardedScript);
            return;
        }

        if (reqUrl.pathname.startsWith('/raw/') && req.method === 'GET') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/raw/'.length));
            const uid = String(reqUrl.searchParams.get('uid') || '').trim();
            const tok = String(reqUrl.searchParams.get('t') || '').trim();
            const hwid = String(req.headers['x-hwid'] || reqUrl.searchParams.get('hwid') || '').trim();

            if (!isRobloxExecutorRequest(req)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: Brauzerdən və ya icazəsiz sorğudan skript koduna baxmaq qadağandır.');
                return;
            }

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

        if (reqUrl.pathname === '/api/bot/config' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    ok: true,
                    botToken: runtimeBotToken || state.savedBotToken || '',
                    discordBotToken: runtimeBotToken || state.savedBotToken || '',
                    apiToken: runtimeBotToken || state.savedBotToken || '',
                    panelButtonConfig: state.panelButtonConfig
                })
            );
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
                    recentKeys: state.keys.slice(-50).reverse().map(enrichMemberEntry),
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

        if (reqUrl.pathname === '/api/panel-config' && req.method === 'POST') {
            const body = await readJsonBody(req);
            state.panelButtonConfig = {
                ...state.panelButtonConfig,
                embedColor: String(body.embedColor || state.panelButtonConfig.embedColor || '#5865F2').trim(),
                redeemLabel: String(body.redeemLabel || 'Redeem Key').trim().slice(0, 80),
                redeemEmoji: String(body.redeemEmoji ?? '').trim().slice(0, 32),
                redeemStyle: String(body.redeemStyle || 'Success').trim(),
                getScriptLabel: String(body.getScriptLabel || 'Get Script').trim().slice(0, 80),
                getScriptEmoji: String(body.getScriptEmoji ?? '').trim().slice(0, 32),
                getScriptStyle: String(body.getScriptStyle || 'Primary').trim(),
                resetHwidLabel: String(body.resetHwidLabel || 'Reset HWID').trim().slice(0, 80),
                resetHwidEmoji: String(body.resetHwidEmoji ?? '').trim().slice(0, 32),
                resetHwidStyle: String(body.resetHwidStyle || 'Secondary').trim(),
                getStatsLabel: String(body.getStatsLabel || 'Get Stats').trim().slice(0, 80),
                getStatsEmoji: String(body.getStatsEmoji ?? '').trim().slice(0, 32),
                getStatsStyle: String(body.getStatsStyle || 'Secondary').trim()
            };
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, panelButtonConfig: state.panelButtonConfig }));
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

        if (reqUrl.pathname.startsWith('/api/scripts/') && req.method === 'PUT') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/api/scripts/'.length));
            const script = getScriptById(scriptId);
            if (!script) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                return;
            }
            const body = await readJsonBody(req);
            if (body.name && String(body.name).trim()) script.name = String(body.name).trim();
            if (typeof body.code === 'string' && body.code.trim()) script.code = body.code;
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
            const createdByName = String(body.createdByName || 'Veb Panel').trim() || 'Veb Panel';
            const keys = [];
            for (let i = 0; i < amount; i++) {
                const code = generateKeyCode();
                state.keys.push({
                    id: generateId('key'),
                    code,
                    scriptId: script.id,
                    durationMs: durationMs === undefined ? null : durationMs,
                    expiresAt: null,
                    createdBy: null,
                    createdByName,
                    redeemedBy: null,
                    redeemedByName: null,
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

        if (reqUrl.pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
            const keyId = decodeURIComponent(reqUrl.pathname.slice('/api/keys/'.length));
            state.keys = state.keys.filter((k) => k.id !== keyId);
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
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
            const createdKey = getUserKeyForScript(userId, script.id);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, key: createdKey ? createdKey.code : null }));
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

function startKeepAliveLoop() {
    if (KEEP_ALIVE_INTERVAL_MS <= 0) return;
    setInterval(async () => {
        try {
            const targetUrl = PUBLIC_BASE_URL.startsWith('http')
                ? `${PUBLIC_BASE_URL}/health`
                : `http://127.0.0.1:${PORT}/health`;
            await fetch(targetUrl, { signal: AbortSignal.timeout(8000) }).catch(() => {});
        } catch (_) {}
    }, KEEP_ALIVE_INTERVAL_MS);
}

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`[SADO PROTECT] HTTP server ${PORT} portunda işləyir (${PUBLIC_BASE_URL})`);
    await hydrateFromCloudIfAvailable();
    startKeepAliveLoop();
    if (!runtimeBotToken) {
        console.error('[SADO PROTECT] Qeyd: DISCORD_BOT_TOKEN hələ təyin edilməyib. Veb paneldən və ya Render Environment Variables bölməsindən daxil edə bilərsiniz.');
    } else {
        startOrRestartBot().catch((err) => {
            console.error('[SADO PROTECT] Discord login xətası:', err.message);
        });
    }
});
