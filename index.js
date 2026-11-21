const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const {
    Client,
    GatewayIntentBits,
    Partials,
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
    StringSelectMenuBuilder,
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
const CLIENT_ID = String(
    process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '1562080654282199121'
).trim();
const DISCORD_INVITE_URL =
    String(process.env.DISCORD_INVITE_URL || '').trim() ||
    `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=2147600384&integration_type=0&scope=bot+applications.commands`;
const PUBLIC_BASE_URL = String(
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'sado-protect-data.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function createDefaultState() {
    return {
        scripts: [],
        keys: [],
        whitelists: [],
        panels: [],
        hwidCooldowns: {},
        lastHwidReset: {},
        guildSettings: {},
        userProfiles: {},
        panelButtonConfig: {
            redeem: { label: 'Redeem Key', emoji: '🔑', style: 'Success', order: 1 },
            getScript: { label: 'Get Script', emoji: '📜', style: 'Primary', order: 2 },
            resetHwid: { label: 'Reset HWID', emoji: '🔄', style: 'Secondary', order: 3 },
            getStats: { label: 'Get Stats', emoji: '📊', style: 'Secondary', order: 4 }
        }
    };
}

let state = createDefaultState();

function persistState() {
    ensureDataDir();
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('[SADO PROTECT] State yazılarkən xəta:', err.message);
    }
}

function loadState() {
    ensureDataDir();
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            state = {
                ...createDefaultState(),
                ...(parsed && typeof parsed === 'object' ? parsed : {})
            };
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
                ...(parsed && parsed.panelButtonConfig && typeof parsed.panelButtonConfig === 'object'
                    ? parsed.panelButtonConfig
                    : {})
            };
        } else {
            persistState();
        }
    } catch (err) {
        console.error('[SADO PROTECT] State oxunarkən xəta:', err.message);
        state = createDefaultState();
    }
}

loadState();

function parseDurationToMs(input) {
    const str = String(input ?? '').trim();
    if (!str || str === '0' || /^life(time)?$/i.test(str)) {
        return 0;
    }
    const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day|w|wk|mo|y|yr)s?$/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const unit = match[2].toLowerCase();
    const mult = {
        s: 1000,
        sec: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        h: 60 * 60 * 1000,
        hr: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        wk: 7 * 24 * 60 * 60 * 1000,
        mo: 30 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000,
        yr: 365 * 24 * 60 * 60 * 1000
    };
    return amount * (mult[unit] || 0);
}

function formatDurationLabel(expiresAt) {
    if (!expiresAt) return 'Lifetime';
    const diff = Number(expiresAt) - Date.now();
    if (diff <= 0) return 'Expired';
    const sec = Math.floor(diff / 1000);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function generateKeyCode(prefix = 'SADO') {
    const rand = crypto.randomBytes(12).toString('hex').toUpperCase();
    return `${prefix}-${rand.slice(0, 6)}-${rand.slice(6, 12)}-${rand.slice(12, 18)}-${rand.slice(18, 24)}`;
}

function getButtonStyleFromName(styleName) {
    const map = {
        Primary: ButtonStyle.Primary,
        Secondary: ButtonStyle.Secondary,
        Success: ButtonStyle.Success,
        Danger: ButtonStyle.Danger
    };
    return map[String(styleName || '')] || ButtonStyle.Secondary;
}

function buildPanelComponents() {
    const cfg = state.panelButtonConfig || createDefaultState().panelButtonConfig;
    const defs = [
        { key: 'redeem', customId: 'sp_btn_redeem', fallbackLabel: 'Redeem Key', fallbackEmoji: '🔑', fallbackStyle: ButtonStyle.Success },
        { key: 'getScript', customId: 'sp_btn_get_script', fallbackLabel: 'Get Script', fallbackEmoji: '📜', fallbackStyle: ButtonStyle.Primary },
        { key: 'resetHwid', customId: 'sp_btn_reset_hwid', fallbackLabel: 'Reset HWID', fallbackEmoji: '🔄', fallbackStyle: ButtonStyle.Secondary },
        { key: 'getStats', customId: 'sp_btn_get_stats', fallbackLabel: 'Get Stats', fallbackEmoji: '📊', fallbackStyle: ButtonStyle.Secondary }
    ];

    const ordered = defs
        .map((d, idx) => {
            const c = cfg[d.key] || {};
            const ord = Number(c.order);
            return {
                ...d,
                label: String(c.label || d.fallbackLabel).trim().slice(0, 80) || d.fallbackLabel,
                emoji: String(c.emoji ?? d.fallbackEmoji).trim(),
                style: getButtonStyleFromName(c.style) || d.fallbackStyle,
                order: Number.isFinite(ord) && ord >= 1 && ord <= 4 ? ord : idx + 1
            };
        })
        .sort((a, b) => a.order - b.order);

    const buttons = ordered.map((item) => {
        const btn = new ButtonBuilder()
            .setCustomId(item.customId)
            .setLabel(item.label)
            .setStyle(item.style);
        if (item.emoji) {
            btn.setEmoji(item.emoji);
        }
        return btn;
    });

    const row1 = new ActionRowBuilder().addComponents(buttons.slice(0, 2));
    const rows = [row1];
    if (buttons.length > 2) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(2, 4)));
    }
    return rows;
}

async function recordDiscordUserProfile(user) {
    if (!user || !user.id) return;
    const uid = String(user.id);
    const displayName = user.globalName || user.username || `User_${uid}`;
    const avatarUrl =
        typeof user.displayAvatarURL === 'function'
            ? user.displayAvatarURL({ extension: 'png', size: 128 })
            : 'https://cdn.discordapp.com/embed/avatars/0.png';

    state.userProfiles[uid] = {
        userId: uid,
        username: user.username || displayName,
        displayName,
        avatarUrl,
        updatedAt: Date.now()
    };

    state.keys.forEach((k) => {
        if (String(k.redeemedBy || '') === uid || String(k.boundUserId || '') === uid) {
            k.userName = displayName;
            k.userAvatar = avatarUrl;
        }
    });
    state.whitelists.forEach((w) => {
        if (String(w.userId) === uid) {
            w.userName = displayName;
            w.userAvatar = avatarUrl;
        }
    });
    persistState();
}

function enrichMemberEntry(entry) {
    const uid = String(entry.userId || entry.redeemedBy || entry.boundUserId || '');
    const prof = (uid && state.userProfiles[uid]) || null;
    return {
        ...entry,
        userId: uid || null,
        userName: entry.userName || (prof && prof.displayName) || (uid ? `User ${uid}` : 'İstifadə edilməyib'),
        userAvatar: entry.userAvatar || (prof && prof.avatarUrl) || 'https://cdn.discordapp.com/embed/avatars/0.png'
    };
}

function findScriptById(scriptId) {
    return state.scripts.find((s) => String(s.id) === String(scriptId)) || null;
}

function findScriptByNameOrId(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    return (
        state.scripts.find((s) => String(s.id).toLowerCase() === q) ||
        state.scripts.find((s) => String(s.name || '').toLowerCase() === q) ||
        state.scripts.find((s) => String(s.name || '').toLowerCase().includes(q)) ||
        null
    );
}

function getPanelByMessageId(messageId) {
    return state.panels.find((p) => String(p.messageId) === String(messageId)) || null;
}

function getPanelByChannelId(channelId) {
    return state.panels.find((p) => String(p.channelId) === String(channelId)) || null;
}

function resolveScriptForContext({ scriptId, messageId, channelId }) {
    if (scriptId) {
        const direct = findScriptById(scriptId);
        if (direct) return direct;
    }
    if (messageId) {
        const panel = getPanelByMessageId(messageId);
        if (panel && panel.scriptId) {
            const byPanel = findScriptById(panel.scriptId);
            if (byPanel) return byPanel;
        }
    }
    if (channelId) {
        const panel = getPanelByChannelId(channelId);
        if (panel && panel.scriptId) {
            const byChan = findScriptById(panel.scriptId);
            if (byChan) return byChan;
        }
    }
    return state.scripts[0] || null;
}

function findExistingKeyForUserInScript(scriptId, userId) {
    const sid = String(scriptId);
    const uid = String(userId);
    return (
        state.keys.find(
            (k) =>
                String(k.scriptId) === sid &&
                (String(k.redeemedBy || '') === uid || String(k.boundUserId || '') === uid) &&
                !k.revoked &&
                !k.disabled
        ) || null
    );
}

function findWhitelistForUserInScript(scriptId, userId) {
    const sid = String(scriptId);
    const uid = String(userId);
    return (
        state.whitelists.find(
            (w) => String(w.scriptId) === sid && String(w.userId) === uid && !w.revoked
        ) || null
    );
}

function generateKeysForScript(scriptObj, { durationMs = null, amount = 1, createdBy = 'system', assignedUserId = null }) {
    const sid = String(scriptObj.id);
    const now = Date.now();
    const expiresAt = durationMs && durationMs > 0 ? now + Number(durationMs) : null;
    const createdKeys = [];
    const count = Math.max(1, Math.min(100, Number(amount) || 1));

    for (let i = 0; i < count; i++) {
        const keyCode = generateKeyCode('SADO');
        const entry = {
            key: keyCode,
            scriptId: sid,
            scriptName: scriptObj.name,
            createdAt: now,
            createdBy: String(createdBy),
            expiresAt,
            redeemed: Boolean(assignedUserId),
            redeemedBy: assignedUserId ? String(assignedUserId) : null,
            redeemedAt: assignedUserId ? now : null,
            boundUserId: assignedUserId ? String(assignedUserId) : null,
            hwid: null,
            revoked: false,
            disabled: false
        };
        state.keys.push(entry);
        createdKeys.push(entry);
    }

    persistState();
    return createdKeys;
}

function ensureAutoWhitelistKey(scriptObj, userId, durationMs = null, createdBy = 'whitelist') {
    const sid = String(scriptObj.id);
    const uid = String(userId);
    const now = Date.now();
    const expiresAt = durationMs && durationMs > 0 ? now + Number(durationMs) : null;

    let wl = findWhitelistForUserInScript(sid, uid);
    if (!wl) {
        wl = {
            scriptId: sid,
            userId: uid,
            createdAt: now,
            createdBy: String(createdBy),
            expiresAt,
            revoked: false
        };
        state.whitelists.push(wl);
    } else if (expiresAt !== null) {
        wl.expiresAt = expiresAt;
    }

    let keyEntry = findExistingKeyForUserInScript(sid, uid);
    let alreadyHadKey = false;
    if (keyEntry) {
        alreadyHadKey = true;
        keyEntry.boundUserId = uid;
        keyEntry.redeemed = true;
        keyEntry.redeemedBy = uid;
        if (!keyEntry.redeemedAt) keyEntry.redeemedAt = now;
        if (expiresAt !== null) keyEntry.expiresAt = expiresAt;
    } else {
        const created = generateKeysForScript(scriptObj, {
            durationMs,
            amount: 1,
            createdBy,
            assignedUserId: uid
        });
        keyEntry = created[0];
    }

    persistState();
    return { keyEntry, whitelistEntry: wl, alreadyHadKey };
}

function checkUserAccessForScript(scriptObj, userId, hwid = null) {
    if (!scriptObj) {
        return { ok: false, code: 'no_script', reason: 'Skript tapılmadı.' };
    }
    if (scriptObj.disabled) {
        return { ok: false, code: 'script_disabled', reason: `**${scriptObj.name}** hazırda deaktivdir.` };
    }

    const sid = String(scriptObj.id);
    const uid = String(userId);
    const now = Date.now();

    const wl = findWhitelistForUserInScript(sid, uid);
    const keyEntry = findExistingKeyForUserInScript(sid, uid);

    if (!wl && !keyEntry) {
        return {
            ok: false,
            code: 'not_whitelisted',
            reason: `Sizin **${scriptObj.name}** skripti üçün whitelist və ya key-iniz yoxdur. Başqa skriptdəki whitelist bu skriptdə işləmir.`
        };
    }

    if (wl && wl.expiresAt && now > Number(wl.expiresAt)) {
        return {
            ok: false,
            code: 'expired',
            reason: `**${scriptObj.name}** üçün whitelist müddətiniz bitib.`
        };
    }

    if (!keyEntry) {
        ensureAutoWhitelistKey(scriptObj, uid, wl ? wl.expiresAt : null, 'auto-access');
        return checkUserAccessForScript(scriptObj, uid, hwid);
    }

    if (keyEntry.expiresAt && now > Number(keyEntry.expiresAt)) {
        return {
            ok: false,
            code: 'key_expired',
            reason: `**${scriptObj.name}** üçün key müddətiniz bitib.`
        };
    }

    if (keyEntry.boundUserId && String(keyEntry.boundUserId) !== uid) {
        return {
            ok: false,
            code: 'key_bound_other_user',
            reason: 'Bu key yalnız 1 istifadəçiyə aiddir və başqa istifadəçiyə bağlıdır.'
        };
    }

    keyEntry.boundUserId = uid;
    keyEntry.redeemed = true;
    keyEntry.redeemedBy = uid;
    if (!keyEntry.redeemedAt) keyEntry.redeemedAt = now;

    if (hwid) {
        const cleanHwid = String(hwid).trim();
        if (keyEntry.hwid && String(keyEntry.hwid) !== cleanHwid) {
            return {
                ok: false,
                code: 'hwid_mismatch',
                reason: 'Bu key başqa cihazın HWID-inə bağlıdır. Zəhmət olmasa Reset HWID düyməsindən istifadə edin.'
            };
        }
        keyEntry.hwid = cleanHwid;
    }

    persistState();
    return {
        ok: true,
        script: scriptObj,
        keyEntry,
        whitelistEntry: wl
    };
}

function redeemKeyForScript(scriptObj, userId, rawKey) {
    if (!scriptObj) {
        return { ok: false, reason: 'Bu panelə bağlı skript tapılmadı.' };
    }
    if (scriptObj.disabled) {
        return { ok: false, reason: `**${scriptObj.name}** hazırda deaktivdir.` };
    }

    const sid = String(scriptObj.id);
    const uid = String(userId);
    const code = String(rawKey || '').trim().toUpperCase();
    const now = Date.now();

    const keyEntry = state.keys.find((k) => String(k.key || '').trim().toUpperCase() === code);
    if (!keyEntry) {
        return { ok: false, reason: 'Daxil edilən key yanlışdır və ya mövcud deyil.' };
    }

    if (String(keyEntry.scriptId) !== sid) {
        return {
            ok: false,
            reason: `Bu key **${scriptObj.name}** skriptinə aid deyil (başqa skriptin key-idir).`
        };
    }

    if (keyEntry.revoked || keyEntry.disabled) {
        return { ok: false, reason: 'Bu key ləğv edilib.' };
    }

    if (keyEntry.expiresAt && now > Number(keyEntry.expiresAt)) {
        return { ok: false, reason: 'Bu key-in vaxtı bitib.' };
    }

    const ownerLock = keyEntry.boundUserId || keyEntry.redeemedBy;
    if (ownerLock && String(ownerLock) !== uid) {
        return { ok: false, reason: 'Bu key artıq başqa 1 istifadəçi tərəfindən aktivləşdirilib.' };
    }

    keyEntry.redeemed = true;
    keyEntry.redeemedBy = uid;
    keyEntry.boundUserId = uid;
    if (!keyEntry.redeemedAt) keyEntry.redeemedAt = now;

    const existingWl = findWhitelistForUserInScript(sid, uid);
    if (!existingWl) {
        state.whitelists.push({
            scriptId: sid,
            userId: uid,
            createdAt: now,
            createdBy: 'redeem',
            expiresAt: keyEntry.expiresAt || null,
            revoked: false
        });
    } else if (keyEntry.expiresAt) {
        existingWl.expiresAt = keyEntry.expiresAt;
    }

    persistState();
    return { ok: true, keyEntry };
}

function resetHwidForUserScript(scriptObj, userId) {
    if (!scriptObj) {
        return { ok: false, reason: 'Skript tapılmadı.' };
    }
    const sid = String(scriptObj.id);
    const uid = String(userId);
    const keyEntry = findExistingKeyForUserInScript(sid, uid);
    if (!keyEntry) {
        return {
            ok: false,
            reason: `**${scriptObj.name}** skripti üçün aktiv key-iniz tapılmadı.`
        };
    }

    const cooldownMs = Number(state.hwidCooldowns[sid] || 0);
    const lastKey = `${sid}:${uid}`;
    const lastResetAt = Number(state.lastHwidReset[lastKey] || 0);
    const now = Date.now();

    if (cooldownMs > 0 && lastResetAt > 0 && now - lastResetAt < cooldownMs) {
        const remainingMs = cooldownMs - (now - lastResetAt);
        const remMin = Math.max(1, Math.ceil(remainingMs / 60000));
        return {
            ok: false,
            reason: `HWID reset cooldown aktivdir. Yenidən cəhd etmək üçün təxminən **${remMin} dəqiqə** gözləyin.`
        };
    }

    keyEntry.hwid = null;
    state.lastHwidReset[lastKey] = now;
    persistState();
    return { ok: true, keyEntry };
}

function buildLocalLuaScript(scriptObj, keyEntry, userId) {
    const titleEsc = String(scriptObj.name || 'SADO_SCRIPT').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const keyEsc = String(keyEntry.key || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const userEsc = String(userId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const rawCode = String(scriptObj.code || '').trim();

    const lines = [
        `-- SADO PROTECT Local Loader (${scriptObj.name})`,
        `local SCRIPT_NAME = "${titleEsc}"`,
        `local SCRIPT_KEY = "${keyEsc}"`,
        `local BOUND_USER_ID = "${userEsc}"`,
        ``,
        `local Players = game:GetService("Players")`,
        `local RbxAnalyticsService = game:GetService("RbxAnalyticsService")`,
        `local LocalPlayer = Players.LocalPlayer`,
        ``,
        `if not LocalPlayer then return end`,
        ``,
        `local currentHwid = tostring(RbxAnalyticsService:GetClientId())`,
        `if SCRIPT_KEY == "" or currentHwid == "" then`,
        `    LocalPlayer:Kick("[SADO PROTECT] Key ve ya HWID dogrulanmadi.")`,
        `    return`,
        `end`,
        ``,
        `print("[SADO PROTECT] Aktivlesdi -> " .. SCRIPT_NAME .. " | User: " .. BOUND_USER_ID)`
    ];

    if (rawCode.length > 0) {
        lines.push('');
        lines.push('(function()');
        lines.push(rawCode);
        lines.push('end)()');
    }

    return lines.join('\n');
}

function buildPanelEmbed(scriptObj, customTitle = null) {
    const title = customTitle || `${scriptObj ? scriptObj.name : 'SADO PROTECT'} Control Panel`;
    return new EmbedBuilder()
        .setColor(0x2B6CB0)
        .setTitle(title)
        .setDescription(
            [
                `Skript: **${scriptObj ? scriptObj.name : 'Təyin olunmayıb'}**`,
                `• Key aktivləşdirmək üçün **Redeem Key**`,
                `• Local skripti almaq üçün **Get Script**`,
                `• Cihazı sıfırlamaq üçün **Reset HWID**`,
                `• Key və HWID məlumatına baxmaq üçün **Get Stats**`
            ].join('\n')
        )
        .setFooter({ text: 'SADO PROTECT • Hər skriptə ayrı whitelist və 1 nəfərlik key sistemi' })
        .setTimestamp();
}

function buildScriptSelectMenu(customId, placeholder = 'Skript seçin...') {
    const options = state.scripts.slice(0, 25).map((s) => ({
        label: String(s.name || s.id).slice(0, 100),
        description: `ID: ${String(s.id).slice(0, 50)} • ${s.disabled ? 'Deaktiv' : 'Aktiv'}`.slice(0, 100),
        value: String(s.id)
    }));
    const menu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(options);
    return new ActionRowBuilder().addComponents(menu);
}

const pendingActions = new Map();

const commands = [
    new SlashCommandBuilder()
        .setName('addscript')
        .setDescription('Yeni skript əlavə edir')
        .addStringOption((opt) =>
            opt.setName('name').setDescription('Skriptin adı (məs: SAE, Lagger, Duel)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('code').setDescription('Roblox Lua kodu').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Skript idarəetmə panelini bu kanala göndərir')
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Panelin bağlı olacağı skript (boş qalsa ilk skript seçilir)').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('title').setDescription('Panel başlığı').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('Seçilmiş skript üçün key yaradır')
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('duration').setDescription('Müddət (0 = lifetime, 1d, 7d, 30d, 1h)').setRequired(false)
        )
        .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('Key sayı (1-50)').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('İstifadəçini yalnız seçilmiş skriptə whitelist edir və avto key yaradır')
        .addUserOption((opt) =>
            opt.setName('user').setDescription('Whitelist ediləcək istifadəçi').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('duration').setDescription('Müddət (0 = lifetime, 1d, 7d, 30d)').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('İstifadəçini seçilmiş skriptin whitelist-indən çıxarır')
        .addUserOption((opt) =>
            opt.setName('user').setDescription('Çıxarılacaq istifadəçi').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('İstifadəçinin seçilmiş skript üzrə HWID-ini sıfırlayır')
        .addUserOption((opt) =>
            opt.setName('user').setDescription('HWID sıfırlanacaq istifadəçi').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('cooldownhwid')
        .setDescription('Skript üçün HWID reset cooldown vaxtını təyin edir')
        .addStringOption((opt) =>
            opt.setName('duration').setDescription('Cooldown vaxtı (0 = yoxdur, 10m, 1h, 1d)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript adı və ya ID').setRequired(false)
        )
].map((cmd) => cmd.toJSON());

async function registerSlashCommands() {
    if (!BOT_TOKEN) return;
    let appId = CLIENT_ID;
    if (!appId && client && client.user) {
        appId = client.user.id;
    }
    if (!appId) return;
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('[SADO PROTECT] Slash əmrləri qeydiyyata alındı.');
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel, Partials.Message]
});

function getGuildsWithRolesSummary() {
    if (!client || !client.isReady()) return [];
    const list = [];
    client.guilds.cache.forEach((guild) => {
        const roles = guild.roles.cache
            .filter((r) => !r.managed && r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map((r) => ({
                id: r.id,
                name: r.name,
                color: r.hexColor || '#99aab5',
                memberCount: r.members ? r.members.size : 0
            }));
        list.push({
            id: guild.id,
            name: guild.name,
            iconUrl: typeof guild.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 128 }) : null,
            memberCount: guild.memberCount || 0,
            roles
        });
    });
    return list;
}

async function publishPanelToChannel(channel, scriptObj, customTitle = null) {
    const embed = buildPanelEmbed(scriptObj, customTitle);
    const components = buildPanelComponents();
    const sentMsg = await channel.send({ embeds: [embed], components });

    state.panels = state.panels.filter((p) => String(p.channelId) !== String(channel.id));
    state.panels.push({
        guildId: channel.guild ? channel.guild.id : null,
        channelId: channel.id,
        messageId: sentMsg.id,
        scriptId: scriptObj ? String(scriptObj.id) : null,
        title: customTitle || null,
        updatedAt: Date.now()
    });
    persistState();
    return sentMsg;
}

client.once('ready', async () => {
    console.log(`[SADO PROTECT] Bot aktivdir: ${client.user.tag}`);
    try {
        await registerSlashCommands();
    } catch (err) {
        console.error('[SADO PROTECT] Slash command qeydiyyat xətası:', err.message);
    }
});

client.on('guildCreate', async (guild) => {
    try {
        state.guildSettings[String(guild.id)] = {
            guildId: guild.id,
            guildName: guild.name,
            joinedAt: Date.now()
        };
        persistState();

        const targetChannel =
            guild.systemChannel ||
            guild.channels.cache.find(
                (ch) =>
                    ch &&
                    ch.isTextBased &&
                    ch.isTextBased() &&
                    typeof ch.permissionsFor === 'function' &&
                    ch.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
            );

        if (targetChannel) {
            const embed = new EmbedBuilder()
                .setColor(0x3B82F6)
                .setTitle('🛡️ SADO PROTECT — İdarəetmə Paneli')
                .setDescription(
                    [
                        `Salam **${guild.name}**! SADO PROTECT botu serverinizə qoşuldu.`,
                        `• Skript əlavə etmək: \`/addscript\``,
                        `• Panel açmaq və skript seçmək: \`/panel\``,
                        `• Key yaratmaq: \`/genkey\``,
                        `• Whitelist / Unwhitelist: \`/whitelist\`, \`/unwhitelist\``,
                        `• HWID sıfırlama və cooldown: \`/resethwid\`, \`/cooldownhwid\``,
                        `• Veb Panel: ${PUBLIC_BASE_URL}`
                    ].join('\n')
                )
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Veb Paneli Aç')
                    .setStyle(ButtonStyle.Link)
                    .setURL(PUBLIC_BASE_URL)
            );
            await targetChannel.send({ embeds: [embed], components: [row] });
        }
    } catch (err) {
        console.error('[SADO PROTECT] guildCreate bildiriş xətası:', err.message);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.user) {
            await recordDiscordUserProfile(interaction.user);
        }
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            if (commandName === 'addscript') {
                const name = interaction.options.getString('name', true).trim();
                const code = interaction.options.getString('code', true);
                const id = `scr_${crypto.randomBytes(4).toString('hex')}`;
                const scriptEntry = {
                    id,
                    name,
                    code,
                    disabled: false,
                    createdBy: interaction.user.id,
                    createdAt: Date.now()
                };
                state.scripts.push(scriptEntry);
                persistState();

                await interaction.reply({
                    content: `✅ **${name}** skripti əlavə edildi! (ID: \`${id}\`)`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (commandName === 'panel') {
                if (state.scripts.length === 0) {
                    await interaction.reply({
                        content: '❌ Heç bir skript əlavə edilməyib. Əvvəlcə `/addscript` ilə skript əlavə edin.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const scriptQuery = interaction.options.getString('script');
                const customTitle = interaction.options.getString('title');

                if (scriptQuery) {
                    const matched = findScriptByNameOrId(scriptQuery);
                    if (!matched) {
                        await interaction.reply({
                            content: `❌ \`${scriptQuery}\` adlı skript tapılmadı.`,
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    await publishPanelToChannel(interaction.channel, matched, customTitle);
                    await interaction.reply({
                        content: `✅ **${matched.name}** üçün panel bu kanala göndərildi!`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (state.scripts.length === 1) {
                    const onlyScript = state.scripts[0];
                    await publishPanelToChannel(interaction.channel, onlyScript, customTitle);
                    await interaction.reply({
                        content: `✅ **${onlyScript.name}** üçün panel bu kanala göndərildi!`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const token = `act_${crypto.randomBytes(6).toString('hex')}`;
                pendingActions.set(token, {
                    type: 'panel',
                    userId: interaction.user.id,
                    channelId: interaction.channel.id,
                    customTitle: customTitle || null
                });

                await interaction.reply({
                    content: '📜 Panel üçün skript seçin:',
                    components: [buildScriptSelectMenu(`sp_sel_${token}`, 'Hansı skriptin paneli olsun?')],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (commandName === 'genkey') {
                if (state.scripts.length === 0) {
                    await interaction.reply({
                        content: '❌ Skript tapılmadı. Əvvəlcə `/addscript` istifadə edin.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const durationRaw = interaction.options.getString('duration') || '0';
                const durationMs = parseDurationToMs(durationRaw);
                if (durationMs === undefined) {
                    await interaction.reply({
                        content: '❌ Müddət formatı yanlışdır. Məsələn: `0` (lifetime), `1d`, `7d`, `30d`, `1h`.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                const amount = Math.max(1, Math.min(50, interaction.options.getInteger('amount') || 1));
                const scriptQuery = interaction.options.getString('script');

                const targetScript = scriptQuery ? findScriptByNameOrId(scriptQuery) : (state.scripts.length === 1 ? state.scripts[0] : null);
                if (!targetScript) {
                    const token = `act_${crypto.randomBytes(6).toString('hex')}`;
                    pendingActions.set(token, {
                        type: 'genkey',
                        userId: interaction.user.id,
                        durationMs: durationMs || null,
                        amount
                    });
                    await interaction.reply({
                        content: '🔑 Key yaratmaq üçün skript seçin:',
                        components: [buildScriptSelectMenu(`sp_sel_${token}`, 'Key hansı skript üçün yaradılsın?')],
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const created = generateKeysForScript(targetScript, {
                    durationMs: durationMs || null,
                    amount,
                    createdBy: interaction.user.id
                });

                const keyList = created.map((k) => `\`${k.key}\``).join('\n');
                await interaction.reply({
                    content: `✅ **${targetScript.name}** üçün **${created.length}** ədəd key yaradıldı (${formatDurationLabel(created[0].expiresAt)}):\n${keyList}`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (commandName === 'whitelist') {
                if (state.scripts.length === 0) {
                    await interaction.reply({
                        content: '❌ Skript tapılmadı. Əvvəlcə `/addscript` istifadə edin.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const targetUser = interaction.options.getUser('user', true);
                await recordDiscordUserProfile(targetUser);
                const durationRaw = interaction.options.getString('duration') || '0';
                const durationMs = parseDurationToMs(durationRaw);
                if (durationMs === undefined) {
                    await interaction.reply({
                        content: '❌ Müddət formatı yanlışdır. Məsələn: `0` (lifetime), `1d`, `7d`, `30d`.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const scriptQuery = interaction.options.getString('script');
                const targetScript = scriptQuery
                    ? findScriptByNameOrId(scriptQuery)
                    : (state.scripts.length === 1 ? state.scripts[0] : null);

                if (!targetScript) {
                    const token = `act_${crypto.randomBytes(6).toString('hex')}`;
                    pendingActions.set(token, {
                        type: 'whitelist',
                        userId: interaction.user.id,
                        targetUserId: targetUser.id,
                        durationMs: durationMs || null
                    });
                    await interaction.reply({
                        content: `🛡️ <@${targetUser.id}> istifadəçisini whitelist etmək üçün skript seçin:`,
                        components: [buildScriptSelectMenu(`sp_sel_${token}`, 'Yalnız bu skriptə whitelist verilir')],
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const res = ensureAutoWhitelistKey(targetScript, targetUser.id, durationMs || null, interaction.user.id);
                await interaction.reply({
                    content: [
                        `✅ <@${targetUser.id}> yalnız **${targetScript.name}** skriptinə whitelist edildi!`,
                        `🔑 Avto Key: \`${res.keyEntry.key}\` ${res.alreadyHadKey ? '(mövcud key saxlanıldı)' : '(yeni yaradıldı)'}`,
                        `⏳ Müddət: **${formatDurationLabel(res.keyEntry.expiresAt)}**`
                    ].join('\n'),
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (commandName === 'unwhitelist') {
                if (state.scripts.length === 0) {
                    await interaction.reply({
                        content: '❌ Skript tapılmadı.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                const targetUser = interaction.options.getUser('user', true);
                const scriptQuery = interaction.options.getString('script');
                const targetScript = scriptQuery
                    ? findScriptByNameOrId(scriptQuery)
                    : (state.scripts.length === 1 ? state.scripts[0] : null);

                if (!targetScript) {
                    const token = `act_${crypto.randomBytes(6).toString('hex')}`;
                    pendingActions.set(token, {
                        type: 'unwhitelist',
                        userId: interaction.user.id,
                        targetUserId: targetUser.id
                    });
                    await interaction.reply({
                        content: `🗑️ <@${targetUser.id}> istifadəçisini whitelist-dən çıxarmaq üçün skript seçin:`,
                        components: [buildScriptSelectMenu(`sp_sel_${token}`, 'Hansı skriptdən çıxarılsın?')],
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const sid = String(targetScript.id);
                const uid = String(targetUser.id);
                state.whitelists.forEach((w) => {
                    if (String(w.scriptId) === sid && String(w.userId) === uid) w.revoked = true;
                });
                state.keys.forEach((k) => {
                    if (
                        String(k.scriptId) === sid &&
                        (String(k.redeemedBy || '') === uid || String(k.boundUserId || '') === uid)
                    ) {
                        k.revoked = true;
                    }
                });
                persistState();

                await interaction.reply({
                    content: `✅ <@${targetUser.id}> **${targetScript.name}** skriptinin whitelist-indən çıxarıldı.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (commandName === 'resethwid') {
                if (state.scripts.length === 0) {
                    await interaction.reply({
                        content: '❌ Skript tapılmadı.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                const targetUser = interaction.options.getUser('user', true);
                const scriptQuery = interaction.options.getString('script');
                const targetScript = scriptQuery
                    ? findScriptByNameOrId(scriptQuery)
                    : (state.scripts.length === 1 ? state.scripts[0] : null);

                if (!targetScript) {
                    const token = `act_${crypto.randomBytes(6).toString('hex')}`;
                    pendingActions.set(token, {
                        type: 'resethwid',
                        userId: interaction.user.id,
                        targetUserId: targetUser.id
                    });
                    await interaction.reply({
                        content: `🔄 <@${targetUser.id}> HWID sıfırlamaq üçün skript seçin:`,
                        components: [buildScriptSelectMenu(`sp_sel_${token}`, 'Hansı skriptin HWID-i sıfırlansın?')],
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const keyEntry = findExistingKeyForUserInScript(targetScript.id, targetUser.id);
                if (!keyEntry) {
                    await interaction.reply({
                        content: `❌ <@${targetUser.id}> üçün **${targetScript.name}** skriptində key tapılmadı.`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                keyEntry.hwid = null;
                persistState();

                await interaction.reply({
                    content: `✅ <@${targetUser.id}> üçün **${targetScript.name}** HWID sıfırlandı.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (commandName === 'cooldownhwid') {
                if (state.scripts.length === 0) {
                    await interaction.reply({
                        content: '❌ Skript tapılmadı.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                const durationRaw = interaction.options.getString('duration', true);
                const durationMs = parseDurationToMs(durationRaw);
                if (durationMs === undefined) {
                    await interaction.reply({
                        content: '❌ Cooldown formatı yanlışdır. Məsələn: `0`, `10m`, `1h`, `1d`.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                const scriptQuery = interaction.options.getString('script');
                const targetScript = scriptQuery
                    ? findScriptByNameOrId(scriptQuery)
                    : (state.scripts.length === 1 ? state.scripts[0] : null);

                if (!targetScript) {
                    const token = `act_${crypto.randomBytes(6).toString('hex')}`;
                    pendingActions.set(token, {
                        type: 'cooldownhwid',
                        userId: interaction.user.id,
                        durationMs: durationMs || 0
                    });
                    await interaction.reply({
                        content: '⏱️ HWID cooldown təyin etmək üçün skript seçin:',
                        components: [buildScriptSelectMenu(`sp_sel_${token}`, 'Hansı skript üçün cooldown olsun?')],
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                state.hwidCooldowns[String(targetScript.id)] = durationMs || 0;
                persistState();
                await interaction.reply({
                    content: `✅ **${targetScript.name}** üçün HWID cooldown **${durationMs ? durationRaw : 'Yoxdur'}** olaraq təyin edildi.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sp_sel_')) {
            const token = interaction.customId.replace('sp_sel_', '');
            const actionData = pendingActions.get(token);
            if (!actionData) {
                await interaction.reply({
                    content: '❌ Bu seçim vaxtı bitib. Əmri yenidən yazın.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            if (String(actionData.userId) !== String(interaction.user.id)) {
                await interaction.reply({
                    content: '❌ Bu menyudan yalnız əmri yazan şəxs istifadə edə bilər.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const selectedScriptId = interaction.values[0];
            const targetScript = findScriptById(selectedScriptId);
            if (!targetScript) {
                await interaction.reply({
                    content: '❌ Seçilmiş skript tapılmadı.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            pendingActions.delete(token);

            if (actionData.type === 'panel') {
                const targetChannel = await client.channels.fetch(actionData.channelId);
                await publishPanelToChannel(targetChannel, targetScript, actionData.customTitle);
                await interaction.update({
                    content: `✅ **${targetScript.name}** üçün panel göndərildi!`,
                    components: []
                });
                return;
            }

            if (actionData.type === 'genkey') {
                const created = generateKeysForScript(targetScript, {
                    durationMs: actionData.durationMs,
                    amount: actionData.amount,
                    createdBy: interaction.user.id
                });
                const keyList = created.map((k) => `\`${k.key}\``).join('\n');
                await interaction.update({
                    content: `✅ **${targetScript.name}** üçün **${created.length}** key yaradıldı (${formatDurationLabel(created[0].expiresAt)}):\n${keyList}`,
                    components: []
                });
                return;
            }

            if (actionData.type === 'whitelist') {
                const res = ensureAutoWhitelistKey(targetScript, actionData.targetUserId, actionData.durationMs, interaction.user.id);
                await interaction.update({
                    content: [
                        `✅ <@${actionData.targetUserId}> yalnız **${targetScript.name}** skriptinə whitelist edildi!`,
                        `🔑 Avto Key: \`${res.keyEntry.key}\``,
                        `⏳ Müddət: **${formatDurationLabel(res.keyEntry.expiresAt)}**`
                    ].join('\n'),
                    components: []
                });
                return;
            }

            if (actionData.type === 'unwhitelist') {
                const sid = String(targetScript.id);
                const uid = String(actionData.targetUserId);
                state.whitelists.forEach((w) => {
                    if (String(w.scriptId) === sid && String(w.userId) === uid) w.revoked = true;
                });
                state.keys.forEach((k) => {
                    if (
                        String(k.scriptId) === sid &&
                        (String(k.redeemedBy || '') === uid || String(k.boundUserId || '') === uid)
                    ) {
                        k.revoked = true;
                    }
                });
                persistState();
                await interaction.update({
                    content: `✅ <@${uid}> **${targetScript.name}** skriptinin whitelist-indən çıxarıldı.`,
                    components: []
                });
                return;
            }

            if (actionData.type === 'resethwid') {
                const keyEntry = findExistingKeyForUserInScript(targetScript.id, actionData.targetUserId);
                if (!keyEntry) {
                    await interaction.update({
                        content: `❌ <@${actionData.targetUserId}> üçün **${targetScript.name}** skriptində key tapılmadı.`,
                        components: []
                    });
                    return;
                }
                keyEntry.hwid = null;
                persistState();
                await interaction.update({
                    content: `✅ <@${actionData.targetUserId}> üçün **${targetScript.name}** HWID sıfırlandı.`,
                    components: []
                });
                return;
            }

            if (actionData.type === 'cooldownhwid') {
                state.hwidCooldowns[String(targetScript.id)] = actionData.durationMs || 0;
                persistState();
                await interaction.update({
                    content: `✅ **${targetScript.name}** üçün HWID cooldown yeniləndi.`,
                    components: []
                });
                return;
            }
        }

        if (interaction.isButton()) {
            const scriptObj = resolveScriptForContext({
                messageId: interaction.message ? interaction.message.id : null,
                channelId: interaction.channel ? interaction.channel.id : null
            });

            if (interaction.customId === 'sp_btn_redeem') {
                const modal = new ModalBuilder()
                    .setCustomId(`sp_modal_redeem:${scriptObj ? scriptObj.id : 'default'}`)
                    .setTitle(`${scriptObj ? scriptObj.name : 'SADO PROTECT'} - Redeem Key`);

                const keyInput = new TextInputBuilder()
                    .setCustomId('sp_input_key')
                    .setLabel('Key daxil edin')
                    .setPlaceholder('SADO-XXXXXX-XXXXXX-XXXXXX-XXXXXX')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
                await interaction.showModal(modal);
                return;
            }

            if (interaction.customId === 'sp_btn_get_script') {
                const access = checkUserAccessForScript(scriptObj, interaction.user.id, null);
                if (!access.ok) {
                    await interaction.reply({
                        content: `❌ ${access.reason}`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const localLua = buildLocalLuaScript(access.script, access.keyEntry, interaction.user.id);
                const luaBuffer = Buffer.from(localLua, 'utf8');

                await interaction.reply({
                    content: [
                        `✅ **${access.script.name}** üçün **Local** skript hazırlandı (1 nəfərlik key: \`${access.keyEntry.key}\`).`,
                        `⏳ Müddət: **${formatDurationLabel(access.keyEntry.expiresAt)}**`,
                        `\`\`\`lua\n${localLua.slice(0, 1400)}\n\`\`\``
                    ].join('\n'),
                    files: [{ attachment: luaBuffer, name: `${access.script.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_local.lua` }],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (interaction.customId === 'sp_btn_reset_hwid') {
                const resetRes = resetHwidForUserScript(scriptObj, interaction.user.id);
                if (!resetRes.ok) {
                    await interaction.reply({
                        content: `❌ ${resetRes.reason}`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                await interaction.reply({
                    content: `✅ **${scriptObj.name}** üçün HWID sıfırlandı! Yeni cihazınız ilk girişdə bağlanacaq.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (interaction.customId === 'sp_btn_get_stats') {
                if (!scriptObj) {
                    await interaction.reply({
                        content: '❌ Bu panelə bağlı skript tapılmadı.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
                const keyEntry = findExistingKeyForUserInScript(scriptObj.id, interaction.user.id);
                const wl = findWhitelistForUserInScript(scriptObj.id, interaction.user.id);

                if (!keyEntry && !wl) {
                    await interaction.reply({
                        content: `❌ Sizin **${scriptObj.name}** skripti üçün aktiv key və ya whitelist-iniz yoxdur.`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(0x2F855A)
                    .setTitle(`📊 ${scriptObj.name} — Key & HWID Stats`)
                    .addFields(
                        { name: 'Skript', value: `**${scriptObj.name}**`, inline: true },
                        { name: 'Whitelist', value: wl && !wl.revoked ? '✅ Aktiv' : '❌ Yoxdur', inline: true },
                        { name: 'Müddət', value: `**${formatDurationLabel(keyEntry ? keyEntry.expiresAt : wl.expiresAt)}**`, inline: true },
                        { name: 'Key', value: keyEntry ? `\`${keyEntry.key}\`` : '`Avto yaradılacaq`', inline: false },
                        { name: 'HWID', value: keyEntry && keyEntry.hwid ? `\`${keyEntry.hwid}\`` : '`Bağlanmayıb`', inline: true },
                        { name: 'Bağlı İstifadəçi', value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp();

                await interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('sp_modal_redeem:')) {
            const scriptIdFromCustom = interaction.customId.split(':')[1];
            const scriptObj =
                findScriptById(scriptIdFromCustom) ||
                resolveScriptForContext({
                    messageId: interaction.message ? interaction.message.id : null,
                    channelId: interaction.channel ? interaction.channel.id : null
                });

            const rawKey = interaction.fields.getTextInputValue('sp_input_key');
            const res = redeemKeyForScript(scriptObj, interaction.user.id, rawKey);
            if (!res.ok) {
                await interaction.reply({
                    content: `❌ ${res.reason}`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            await interaction.reply({
                content: [
                    `✅ Key **${scriptObj.name}** skripti üçün aktivləşdirildi!`,
                    `🔑 Key yalnız <@${interaction.user.id}> hesabına bağlandı.`,
                    `⏳ Müddət: **${formatDurationLabel(res.keyEntry.expiresAt)}**`
                ].join('\n'),
                flags: MessageFlags.Ephemeral
            });
            return;
        }
    } catch (err) {
        console.error('[SADO PROTECT] Interaction xətası:', err);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Əməliyyat zamanı gözlənilməz xəta baş verdi.',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (_) {}
    }
});

const server = http.createServer((req, res) => {
    try {
        const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

        if (reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    ok: true,
                    botReady: Boolean(client && client.user),
                    scriptsCount: state.scripts.length,
                    keysCount: state.keys.length,
                    whitelistsCount: state.whitelists.length
                })
            );
            return;
        }

        if (reqUrl.pathname === '/api/state' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    ok: true,
                    botReady: Boolean(client && client.user),
                    inviteUrl: DISCORD_INVITE_URL,
                    panelButtonConfig: state.panelButtonConfig,
                    guilds: getGuildsWithRolesSummary(),
                    scripts: state.scripts.map((s) => ({
                        id: s.id,
                        name: s.name,
                        disabled: Boolean(s.disabled),
                        createdAt: s.createdAt
                    })),
                    keysCount: state.keys.length,
                    whitelistsCount: state.whitelists.length,
                    recentKeys: state.keys.slice(-20).reverse().map(enrichMemberEntry),
                    whitelists: state.whitelists.filter((w) => !w.revoked).slice(-25).reverse().map(enrichMemberEntry)
                })
            );
            return;
        }

        if (reqUrl.pathname === '/api/scripts' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const name = String(data.name || '').trim();
                    const code = String(data.code || '');
                    if (!name) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Skript adı mütləqdir.' }));
                        return;
                    }
                    const id = `scr_${crypto.randomBytes(4).toString('hex')}`;
                    const scriptEntry = {
                        id,
                        name,
                        code,
                        disabled: false,
                        createdBy: 'web-panel',
                        createdAt: Date.now()
                    };
                    state.scripts.push(scriptEntry);
                    persistState();
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, script: scriptEntry }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Skript yaradılarkən xəta baş verdi.' }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/bot-config' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const cfg = data.panelButtonConfig && typeof data.panelButtonConfig === 'object'
                        ? data.panelButtonConfig
                        : {};
                    const current = state.panelButtonConfig || createDefaultState().panelButtonConfig;
                    for (const k of ['redeem', 'getScript', 'resetHwid', 'getStats']) {
                        if (cfg[k] && typeof cfg[k] === 'object') {
                            current[k] = {
                                label: String(cfg[k].label ?? current[k].label).trim().slice(0, 80) || current[k].label,
                                emoji: String(cfg[k].emoji ?? current[k].emoji).trim().slice(0, 16),
                                style: ['Primary', 'Secondary', 'Success', 'Danger'].includes(cfg[k].style)
                                    ? cfg[k].style
                                    : current[k].style,
                                order: Math.max(1, Math.min(4, Number(cfg[k].order) || current[k].order))
                            };
                        }
                    }
                    state.panelButtonConfig = current;
                    persistState();
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, panelButtonConfig: state.panelButtonConfig }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Bot ayarları saxlanarkən xəta baş verdi.' }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/role-whitelist' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const scriptObj = findScriptById(data.scriptId) || state.scripts[0] || null;
                    const guildId = String(data.guildId || '').trim();
                    const roleId = String(data.roleId || '').trim();
                    const durationMs = parseDurationToMs(data.duration || '0');
                    if (!scriptObj || !guildId || !roleId) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Skript, server və rol seçilməlidir.' }));
                        return;
                    }
                    if (durationMs === undefined) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Müddət formatı yanlışdır.' }));
                        return;
                    }
                    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
                    const members = await guild.members.fetch();
                    const matched = members.filter((m) => !m.user.bot && m.roles.cache.has(roleId));
                    const createdList = [];
                    for (const [, member] of matched) {
                        await recordDiscordUserProfile(member.user);
                        const wlRes = ensureAutoWhitelistKey(scriptObj, member.id, durationMs || null, 'role-whitelist');
                        createdList.push({
                            userId: member.id,
                            userName: member.user.globalName || member.user.username,
                            key: wlRes.keyEntry.key
                        });
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, count: createdList.length, items: createdList }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: `Rol whitelist xətası: ${err.message}` }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/keys' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const scriptObj = findScriptById(data.scriptId) || state.scripts[0] || null;
                    if (!scriptObj) {
                        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                        return;
                    }
                    const durationMs = parseDurationToMs(data.duration || '0');
                    if (durationMs === undefined) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Müddət formatı yanlışdır.' }));
                        return;
                    }
                    const amount = Math.max(1, Math.min(50, Number(data.amount) || 1));
                    const created = generateKeysForScript(scriptObj, {
                        durationMs: durationMs || null,
                        amount,
                        createdBy: 'web-panel'
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, keys: created }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Key yaradılarkən xəta baş verdi.' }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/whitelist' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const scriptObj = findScriptById(data.scriptId) || state.scripts[0] || null;
                    const userId = String(data.userId || '').trim();
                    if (!scriptObj || !userId) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Skript və Discord User ID mütləqdir.' }));
                        return;
                    }
                    const durationMs = parseDurationToMs(data.duration || '0');
                    if (durationMs === undefined) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Müddət formatı yanlışdır.' }));
                        return;
                    }
                    const wlRes = ensureAutoWhitelistKey(scriptObj, userId, durationMs || null, 'web-panel');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, key: wlRes.keyEntry.key, alreadyHadKey: wlRes.alreadyHadKey }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Whitelist xətası.' }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/reset-hwid' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const scriptObj = findScriptById(data.scriptId) || state.scripts[0] || null;
                    const userId = String(data.userId || '').trim();
                    const resetRes = resetHwidForUserScript(scriptObj, userId);
                    if (!resetRes.ok) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: resetRes.reason }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, message: 'HWID sıfırlandı.' }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'HWID sıfırlanarkən xəta baş verdi.' }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/local-script') {
            const scriptId = reqUrl.searchParams.get('scriptId');
            const userId = reqUrl.searchParams.get('userId');
            const hwid = reqUrl.searchParams.get('hwid');
            const scriptObj = findScriptById(scriptId) || state.scripts[0] || null;
            const access = checkUserAccessForScript(scriptObj, userId, hwid);

            if (!access.ok) {
                res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: access.code, message: access.reason }));
                return;
            }

            const luaCode = buildLocalLuaScript(access.script, access.keyEntry, userId);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(luaCode);
            return;
        }

        if (reqUrl.pathname === '/') {
            const html = `<!DOCTYPE html>
<html lang="az">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>SADO PROTECT — Control Panel</title>
<style>
  :root {
    --bg: #080d18;
    --card: #10182b;
    --card-2: #0b1220;
    --border: #1e2d4a;
    --text: #eef4ff;
    --muted: #8fa3c7;
    --accent: #3b82f6;
    --accent-2: #10b981;
    --discord: #5865F2;
  }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; background: radial-gradient(circle at top right, #132242, var(--bg) 55%); color: var(--text); padding: 18px; }
  .wrap { max-width: 1060px; margin: 0 auto; display: grid; gap: 16px; }
  .top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; background: var(--card); border: 1px solid var(--border); padding: 16px 20px; border-radius: 16px; box-shadow: 0 12px 30px rgba(0,0,0,.35); }
  .left-head { display: flex; align-items: center; gap: 12px; }
  .menu-btn { width: 42px; height: 42px; border-radius: 12px; background: var(--card-2); border: 1px solid var(--border); color: var(--text); font-size: 20px; cursor: pointer; display: grid; place-items: center; }
  .discord-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 12px; background: var(--discord); color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; }
  .badge { padding: 7px 13px; border-radius: 999px; font-size: 12px; background: rgba(16,185,129,.15); color: #34d399; border: 1px solid rgba(16,185,129,.35); }
  .drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; z-index: 40; }
  .drawer-backdrop.open { display: block; }
  .drawer { position: fixed; top: 0; left: -310px; width: 300px; height: 100%; background: var(--card); border-right: 1px solid var(--border); padding: 20px; z-index: 50; transition: left .22s ease; display: flex; flex-direction: column; gap: 12px; }
  .drawer.open { left: 0; }
  .nav-item { padding: 11px 14px; border-radius: 12px; background: var(--card-2); border: 1px solid var(--border); color: var(--text); text-align: left; cursor: pointer; font-weight: 600; }
  .nav-item.active { border-color: var(--accent); background: rgba(59,130,246,.18); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); padding: 18px; border-radius: 16px; display: grid; gap: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
  h1, h2, h3, h4 { margin: 0; }
  label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 4px; }
  input, select, textarea, button.action { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--card-2); color: var(--text); font-size: 14px; }
  textarea { min-height: 92px; resize: vertical; font-family: monospace; }
  button.action { background: var(--accent); border: none; font-weight: 600; cursor: pointer; }
  button.action.green { background: var(--accent-2); }
  .drop-pills { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
  .pill-btn { padding: 8px 4px; border-radius: 9px; border: 1px solid var(--border); background: var(--card-2); color: var(--text); font-weight: 700; cursor: pointer; }
  .pill-btn.active { background: var(--accent-2); border-color: var(--accent-2); color: #052e16; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; }
  .stat-box { background: var(--card-2); border: 1px solid var(--border); padding: 12px; border-radius: 12px; }
  .stat-num { font-size: 21px; font-weight: 800; margin-top: 4px; }
  .user-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--card-2); border: 1px solid var(--border); font-size: 13px; }
  .user-row img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
  .out { background: #070b14; border: 1px dashed var(--border); padding: 12px; border-radius: 12px; font-size: 13px; white-space: pre-wrap; word-break: break-word; color: #cbd5e1; }
  .hidden-tab { display: none; }
</style>
</head>
<body>
<div id="backdrop" class="drawer-backdrop" onclick="toggleDrawer(false)"></div>
<aside id="drawer" class="drawer">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <h3>☰ Menyu</h3>
    <button onclick="toggleDrawer(false)" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;">✕</button>
  </div>
  <button id="tabBtnMain" class="nav-item active" onclick="switchTab('main')">🏠 İdarəetmə Paneli</button>
  <button id="tabBtnBot" class="nav-item" onclick="switchTab('bot')">🤖 Discord Bot</button>
  <a class="discord-btn" id="drawerInvite" href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener">➕ Discord Join</a>
</aside>

<div class="wrap">
  <div class="top">
    <div class="left-head">
      <button class="menu-btn" onclick="toggleDrawer(true)" aria-label="Menyu">☰</button>
      <div>
        <h1>SADO PROTECT</h1>
        <div style="color:var(--muted);font-size:12px;">1 nəfərlik key &amp; skript kilidi • HWID Kick &amp; Reset • Local Lua</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <a class="discord-btn" id="topInvite" href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener">Discord Join</a>
      <div id="botStatus" class="badge">Yoxlanılır...</div>
    </div>
  </div>

  <div class="card">
    <div class="stats">
      <div class="stat-box"><div style="color:var(--muted);font-size:12px;">Skriptlər</div><div id="cScripts" class="stat-num">0</div></div>
      <div class="stat-box"><div style="color:var(--muted);font-size:12px;">Key-lər</div><div id="cKeys" class="stat-num">0</div></div>
      <div class="stat-box"><div style="color:var(--muted);font-size:12px;">Whitelist</div><div id="cWl" class="stat-num">0</div></div>
    </div>
  </div>

  <div id="sectionMain">
    <div class="grid">
      <div class="card">
        <h3>Yeni Skript Əlavə Et (Mətn və ya Fayl)</h3>
        <div><label>Skript Adı</label><input id="sName" placeholder="Məs: SAE, Lagger, Duel" /></div>
        <div><label>Lua Kodu</label><textarea id="sCode" placeholder="print('Salam Roblox!')"></textarea></div>
        <div><label>Və ya .lua / .txt Fayl Seçin</label><input id="sFile" type="file" accept=".lua,.txt" onchange="loadScriptFile(event)" /></div>
        <button class="action" onclick="addScript()">Skripti Saxla</button>
      </div>

      <div class="card">
        <h3>Drop Key Yarat (1 - 10 Nəfərlik)</h3>
        <div><label>Skript</label><select id="kScript"></select></div>
        <div><label>Nəfər / Drop Sayı</label>
          <div class="drop-pills" id="dropPills">
            <button type="button" class="pill-btn active" onclick="setDropCount(1, this)">1</button>
            <button type="button" class="pill-btn" onclick="setDropCount(2, this)">2</button>
            <button type="button" class="pill-btn" onclick="setDropCount(3, this)">3</button>
            <button type="button" class="pill-btn" onclick="setDropCount(4, this)">4</button>
            <button type="button" class="pill-btn" onclick="setDropCount(5, this)">5</button>
            <button type="button" class="pill-btn" onclick="setDropCount(10, this)">10</button>
          </div>
        </div>
        <div><label>Müddət (0 = lifetime, 1d, 7d, 30d)</label><input id="kDur" value="0" /></div>
        <button class="action green" onclick="genKey()">Key Drop Yarat</button>
      </div>

      <div class="card">
        <h3>Whitelist / Rol Whitelist / Reset HWID</h3>
        <div><label>Skript</label><select id="wScript"></select></div>
        <div><label>Discord User ID</label><input id="wUser" placeholder="123456789012345678" /></div>
        <div><label>Müddət (0 = lifetime, 1d, 7d)</label><input id="wDur" value="0" /></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button class="action green" onclick="doWhitelist()">Whitelist + Key</button>
          <button class="action" onclick="doResetHwid()">Reset HWID</button>
        </div>
        <hr style="border:0;border-top:1px solid var(--border);margin:4px 0;" />
        <div><label>Discord Server</label><select id="rGuild" onchange="populateRoles()"></select></div>
        <div><label>Server Rolu</label><select id="rRole"></select></div>
        <button class="action green" onclick="doRoleWhitelist()">Rola Whitelist Ver</button>
      </div>
    </div>

    <div class="grid" style="margin-top:16px;">
      <div class="card">
        <h3>Aktiv Whitelist İstifadəçiləri</h3>
        <div id="wlList" style="display:grid;gap:8px;">Yüklənir...</div>
      </div>
      <div class="card">
        <h3>Son Key İstifadəçiləri</h3>
        <div id="keyList" style="display:grid;gap:8px;">Yüklənir...</div>
      </div>
    </div>
  </div>

  <div id="sectionBot" class="hidden-tab">
    <div class="card">
      <h3>🤖 Discord Bot — Panel Butonlarının Tənzimlənməsi</h3>
      <div style="color:var(--muted);font-size:13px;">Redeem Key, Get Script, Reset HWID və Get Stats butonlarının adını, emojisini, sırasını (1-4) və rəngini dəyişin.</div>
      <div class="grid" id="botBtnForms"></div>
      <button class="action green" onclick="saveBotConfig()">Bot Ayarlarını Saxla</button>
    </div>
  </div>

  <div class="card">
    <h3>Nəticə</h3>
    <div id="output" class="out">Hazırdır.</div>
  </div>
</div>

<script>
let selectedDropCount = 1;
let guildsCache = [];
let botBtnCfg = {};

const out = (msg) => {
  document.getElementById('output').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
};

function toggleDrawer(open) {
  document.getElementById('drawer').classList.toggle('open', open);
  document.getElementById('backdrop').classList.toggle('open', open);
}

function switchTab(tab) {
  toggleDrawer(false);
  const isMain = tab === 'main';
  document.getElementById('sectionMain').classList.toggle('hidden-tab', !isMain);
  document.getElementById('sectionBot').classList.toggle('hidden-tab', isMain);
  document.getElementById('tabBtnMain').classList.toggle('active', isMain);
  document.getElementById('tabBtnBot').classList.toggle('active', !isMain);
}

function setDropCount(n, btnEl) {
  selectedDropCount = n;
  document.querySelectorAll('#dropPills .pill-btn').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
}

function loadScriptFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!document.getElementById('sName').value.trim()) {
    document.getElementById('sName').value = file.name.replace(/\.(lua|txt)$/i, '');
  }
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('sCode').value = String(reader.result || '');
  };
  reader.readAsText(file);
}

function renderBotConfigForms(cfg) {
  botBtnCfg = cfg || {};
  const items = [
    { key: 'redeem', title: 'Redeem Key Butonu' },
    { key: 'getScript', title: 'Get Script Butonu' },
    { key: 'resetHwid', title: 'Reset HWID Butonu' },
    { key: 'getStats', title: 'Get Stats Butonu' }
  ];
  document.getElementById('botBtnForms').innerHTML = items.map(it => {
    const c = botBtnCfg[it.key] || {};
    return '<div class="card" style="background:var(--card-2);">' +
      '<h4>' + it.title + '</h4>' +
      '<div><label>Ad</label><input id="cfg_' + it.key + '_label" value="' + (c.label || '') + '" /></div>' +
      '<div><label>Emoji</label><input id="cfg_' + it.key + '_emoji" value="' + (c.emoji || '') + '" /></div>' +
      '<div><label>Yer / Sıra (1-4)</label><input id="cfg_' + it.key + '_order" type="number" min="1" max="4" value="' + (c.order || 1) + '" /></div>' +
      '<div><label>Rəng</label><select id="cfg_' + it.key + '_style">' +
      ['Success','Primary','Secondary','Danger'].map(st => '<option value="' + st + '"' + (c.style === st ? ' selected' : '') + '>' + st + '</option>').join('') +
      '</select></div></div>';
  }).join('');
}

async function saveBotConfig() {
  const payload = { panelButtonConfig: {} };
  for (const k of ['redeem', 'getScript', 'resetHwid', 'getStats']) {
    payload.panelButtonConfig[k] = {
      label: document.getElementById('cfg_' + k + '_label').value,
      emoji: document.getElementById('cfg_' + k + '_emoji').value,
      order: Number(document.getElementById('cfg_' + k + '_order').value || 1),
      style: document.getElementById('cfg_' + k + '_style').value
    };
  }
  const r = await fetch('/api/bot-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json();
  out(d.ok ? 'Discord bot panel buton ayarları saxlanıldı!' : d.message);
}

function populateRoles() {
  const gid = document.getElementById('rGuild').value;
  const g = guildsCache.find(x => String(x.id) === String(gid));
  const roleSel = document.getElementById('rRole');
  if (!g || !g.roles || !g.roles.length) {
    roleSel.innerHTML = '<option value="">Rol tapılmadı</option>';
    return;
  }
  roleSel.innerHTML = g.roles.map(r => '<option value="' + r.id + '">' + r.name + '</option>').join('');
}

async function refreshState() {
  try {
    const r = await fetch('/api/state');
    const d = await r.json();
    if (d.inviteUrl) {
      document.getElementById('topInvite').href = d.inviteUrl;
      document.getElementById('drawerInvite').href = d.inviteUrl;
    }
    document.getElementById('botStatus').textContent = d.botReady ? 'Bot Aktivdir' : 'Bot Gözləmədə';
    document.getElementById('cScripts').textContent = d.scripts.length;
    document.getElementById('cKeys').textContent = d.keysCount;
    document.getElementById('cWl').textContent = d.whitelistsCount;

    const opts = d.scripts.map(s => '<option value="' + s.id + '">' + s.name + '</option>').join('') || '<option value="">Skript yoxdur</option>';
    document.getElementById('kScript').innerHTML = opts;
    document.getElementById('wScript').innerHTML = opts;

    guildsCache = d.guilds || [];
    const gSel = document.getElementById('rGuild');
    gSel.innerHTML = guildsCache.length
      ? guildsCache.map(g => '<option value="' + g.id + '">' + g.name + '</option>').join('')
      : '<option value="">Server tapılmadı</option>';
    populateRoles();

    document.getElementById('wlList').innerHTML = (d.whitelists || []).length
      ? d.whitelists.map(w => '<div class="user-row"><img src="' + (w.userAvatar || '') + '" alt="" /><div><div><b>' + (w.userName || w.userId) + '</b></div><div style="color:var(--muted);font-size:11px;">ID: ' + (w.userId || '-') + ' • Script: ' + (w.scriptId || '-') + '</div></div></div>').join('')
      : '<div style="color:var(--muted);font-size:13px;">Hələ whitelist yoxdur.</div>';

    document.getElementById('keyList').innerHTML = (d.recentKeys || []).length
      ? d.recentKeys.map(k => '<div class="user-row"><img src="' + (k.userAvatar || '') + '" alt="" /><div><div><b>' + (k.userName || 'İstifadə edilməyib') + '</b> • <code>' + k.key + '</code></div><div style="color:var(--muted);font-size:11px;">Script: ' + (k.scriptName || k.scriptId) + ' • HWID: ' + (k.hwid ? 'Bağlıdır' : 'Boş') + '</div></div></div>').join('')
      : '<div style="color:var(--muted);font-size:13px;">Hələ key yoxdur.</div>';

    renderBotConfigForms(d.panelButtonConfig);
  } catch (e) {
    out('State yüklənmədi: ' + e.message);
  }
}

async function addScript() {
  const name = document.getElementById('sName').value;
  const code = document.getElementById('sCode').value;
  const r = await fetch('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }) });
  const d = await r.json();
  out(d.ok ? 'Skript əlavə edildi: ' + d.script.name + ' (' + d.script.id + ')' : d.message);
  refreshState();
}

async function genKey() {
  const scriptId = document.getElementById('kScript').value;
  const duration = document.getElementById('kDur').value;
  const amount = Number(selectedDropCount || 1);
  const r = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId, duration, amount }) });
  const d = await r.json();
  out(d.ok ? 'Yaradılan (' + amount + ' nəfərlik drop) Key-lər:\n' + d.keys.map(x => x.key).join('\n') : d.message);
  refreshState();
}

async function doWhitelist() {
  const scriptId = document.getElementById('wScript').value;
  const userId = document.getElementById('wUser').value;
  const duration = document.getElementById('wDur').value;
  const r = await fetch('/api/whitelist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId, userId, duration }) });
  const d = await r.json();
  out(d.ok ? 'Whitelist edildi! Avto Key: ' + d.key : d.message);
  refreshState();
}

async function doResetHwid() {
  const scriptId = document.getElementById('wScript').value;
  const userId = document.getElementById('wUser').value;
  const r = await fetch('/api/reset-hwid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId, userId }) });
  const d = await r.json();
  out(d.message || 'HWID sıfırlandı.');
  refreshState();
}

async function doRoleWhitelist() {
  const scriptId = document.getElementById('wScript').value;
  const guildId = document.getElementById('rGuild').value;
  const roleId = document.getElementById('rRole').value;
  const duration = document.getElementById('wDur').value;
  const r = await fetch('/api/role-whitelist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId, guildId, roleId, duration }) });
  const d = await r.json();
  out(d.ok ? 'Rol üzrə ' + d.count + ' nəfər whitelist edildi!' : d.message);
  refreshState();
}

refreshState();
</script>
</body>
</html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Not Found' }));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Server xətası' }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SADO PROTECT] HTTP server ${PORT} portunda işləyir (${PUBLIC_BASE_URL})`);
});

if (!BOT_TOKEN) {
    console.error('[SADO PROTECT] XƏTA: DISCORD_BOT_TOKEN təyin edilməyib! Render Environment Variables bölməsinə DISCORD_BOT_TOKEN əlavə edin.');
} else {
    client.login(BOT_TOKEN).catch((err) => {
        console.error('[SADO PROTECT] Discord login xətası:', err.message);
    });
}
