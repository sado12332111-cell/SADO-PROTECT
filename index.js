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
const CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
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
        guildSettings: {}
    };
}

let state = createDefaultState();

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
        } else {
            persistState();
        }
    } catch (err) {
        console.error('[SADO PROTECT] State oxunarkən xəta:', err.message);
        state = createDefaultState();
    }
}

function persistState() {
    ensureDataDir();
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
}

loadState();

function parseDurationToMs(input) {
    if (input === undefined || input === null) return null;
    const str = String(input).trim().toLowerCase();
    if (!str || str === '0' || str === 'lifetime' || str === 'perm' || str === 'unlimited') {
        return null;
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
        const auto = ensureAutoWhitelistKey(scriptObj, uid, wl ? wl.expiresAt : null, 'auto-access');
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

function buildPanelComponents() {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('sp_btn_redeem')
            .setLabel('Redeem Key')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🔑'),
        new ButtonBuilder()
            .setCustomId('sp_btn_get_script')
            .setLabel('Get Script')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📜')
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('sp_btn_reset_hwid')
            .setLabel('Reset HWID')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄'),
        new ButtonBuilder()
            .setCustomId('sp_btn_get_stats')
            .setLabel('Get Stats')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📊')
    );

    return [row1, row2];
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

client.on('interactionCreate', async (interaction) => {
    try {
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
                    scripts: state.scripts.map((s) => ({
                        id: s.id,
                        name: s.name,
                        disabled: Boolean(s.disabled),
                        createdAt: s.createdAt
                    })),
                    keysCount: state.keys.length,
                    whitelistsCount: state.whitelists.length,
                    recentKeys: state.keys.slice(-15).reverse()
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
                    const entry = {
                        id,
                        name,
                        code,
                        disabled: false,
                        createdBy: 'web-panel',
                        createdAt: Date.now()
                    };
                    state.scripts.push(entry);
                    persistState();
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, script: entry }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Yanlış JSON sorğusu.' }));
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
    --bg: #0b0f19;
    --card: #121826;
    --border: #222c42;
    --text: #e5ecf8;
    --muted: #8fa0be;
    --accent: #3b82f6;
    --accent-2: #10b981;
  }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; background: var(--bg); color: var(--text); padding: 20px; }
  .wrap { max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
  .top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; background: var(--card); border: 1px solid var(--border); padding: 16px 20px; border-radius: 14px; }
  .badge { padding: 6px 12px; border-radius: 999px; font-size: 13px; background: rgba(16,185,129,.15); color: #34d399; border: 1px solid rgba(16,185,129,.35); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); padding: 18px; border-radius: 14px; display: grid; gap: 10px; }
  h1, h2, h3 { margin: 0; }
  label { font-size: 13px; color: var(--muted); }
  input, select, textarea, button { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: #0d1320; color: var(--text); font-size: 14px; }
  textarea { min-height: 90px; resize: vertical; font-family: monospace; }
  button { background: var(--accent); border: none; font-weight: 600; cursor: pointer; }
  button.green { background: var(--accent-2); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; }
  .stat-box { background: #0d1320; border: 1px solid var(--border); padding: 12px; border-radius: 10px; }
  .stat-num { font-size: 20px; font-weight: 700; }
  .out { background: #090d16; border: 1px dashed var(--border); padding: 12px; border-radius: 10px; font-size: 13px; white-space: pre-wrap; word-break: break-word; color: #cbd5e1; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>SADO PROTECT</h1>
      <div style="color:var(--muted);font-size:13px;">Hər skriptə ayrı whitelist • 1 nəfərlik key • Reset HWID • Local Lua</div>
    </div>
    <div id="botStatus" class="badge">Yoxlanılır...</div>
  </div>

  <div class="card">
    <div class="stats">
      <div class="stat-box"><div style="color:var(--muted);font-size:12px;">Skriptlər</div><div id="cScripts" class="stat-num">0</div></div>
      <div class="stat-box"><div style="color:var(--muted);font-size:12px;">Key-lər</div><div id="cKeys" class="stat-num">0</div></div>
      <div class="stat-box"><div style="color:var(--muted);font-size:12px;">Whitelist</div><div id="cWl" class="stat-num">0</div></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Yeni Skript Əlavə Et</h3>
      <div><label>Skript Adı</label><input id="sName" placeholder="Məs: SAE, Lagger, Duel" /></div>
      <div><label>Lua Kodu</label><textarea id="sCode" placeholder="print('Salam Roblox!')"></textarea></div>
      <button onclick="addScript()">Skripti Saxla</button>
    </div>

    <div class="card">
      <h3>Key Yarat</h3>
      <div><label>Skript</label><select id="kScript"></select></div>
      <div><label>Müddət (0 = lifetime, 1d, 7d, 30d)</label><input id="kDur" value="0" /></div>
      <div><label>Say</label><input id="kAmt" type="number" value="1" min="1" max="50" /></div>
      <button class="green" onclick="genKey()">Key Yarat</button>
    </div>

    <div class="card">
      <h3>Avto Whitelist + Reset HWID</h3>
      <div><label>Skript</label><select id="wScript"></select></div>
      <div><label>Discord User ID</label><input id="wUser" placeholder="123456789012345678" /></div>
      <div><label>Müddət (0 = lifetime, 1d, 7d)</label><input id="wDur" value="0" /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button class="green" onclick="doWhitelist()">Whitelist + Key</button>
        <button onclick="doResetHwid()">Reset HWID</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>Nəticə</h3>
    <div id="output" class="out">Hazırdır.</div>
  </div>
</div>

<script>
const out = (msg) => { document.getElementById('output').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2); };

async function refreshState() {
  try {
    const r = await fetch('/api/state');
    const d = await r.json();
    document.getElementById('botStatus').textContent = d.botReady ? 'Bot Aktivdir' : 'Bot Gözləmədə (Token yoxla)';
    document.getElementById('cScripts').textContent = d.scripts.length;
    document.getElementById('cKeys').textContent = d.keysCount;
    document.getElementById('cWl').textContent = d.whitelistsCount;

    const opts = d.scripts.map(s => '<option value="' + s.id + '">' + s.name + '</option>').join('') || '<option value="">Skript yoxdur</option>';
    document.getElementById('kScript').innerHTML = opts;
    document.getElementById('wScript').innerHTML = opts;
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
  const amount = Number(document.getElementById('kAmt').value || 1);
  const r = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scriptId, duration, amount }) });
  const d = await r.json();
  out(d.ok ? 'Yaradılan Key-lər:\n' + d.keys.map(x => x.key).join('\n') : d.message);
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
  out(d.ok ? d.message : d.message);
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
