const express = require('express');
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    MessageFlags,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= AYARLAR =================
const ADMIN_PASS = "SADO2026";
const DATA_FILE = path.join(__dirname, 'sado_protect_data.json');
const DEFAULT_CLIENT_ID = "1562080654282199121";
const DEFAULT_PERMISSIONS = "139586488320";
const EMBEDDED_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || "").trim();
let panelBaseUrl = process.env.RENDER_EXTERNAL_URL || "";

const DURATION_MS_MAP = {
    "1h": 1 * 60 * 60 * 1000,
    "5h": 5 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "lifetime": null
};

const DURATION_LABEL_MAP = {
    "1h": "1 hour",
    "5h": "5 hours",
    "24h": "24 hours",
    "3d": "3 day",
    "7d": "7 day",
    "lifetime": "lifetime"
};

let store = {
    discordConfig: {
        enabled: true,
        clientId: DEFAULT_CLIENT_ID,
        permissions: DEFAULT_PERMISSIONS,
        autoRoleId: "",
        welcomeChannelId: "",
        panelEmbedTitle: "{script} — Control Panel",
        panelEmbedDesc: "This control panel is for the project:\n**{script}**\nIf you're a buyer, click on the buttons below to redeem your key, get the script or reset HWID",
        panelEmbedColor: "#7c3aed",
        btnRedeemLabel: "Redeem Key",
        btnRedeemStyle: "Success",
        btnScriptLabel: "Get Script",
        btnScriptStyle: "Primary",
        btnHwidLabel: "Reset HWID",
        btnHwidStyle: "Secondary",
        btnStatsLabel: "Get Stats",
        btnStatsStyle: "Secondary"
    },
    scripts: [
        {
            id: "sado-hub",
            name: "SADO HUB",
            code: `-- SADO HUB Script\nprint("SADOPROTECT Aktivdir!")`
        }
    ],
    whitelist: [],
    keys: {
        "SADO-FREE-KEY": {
            owner: "Test User",
            scriptId: "sado-hub",
            maxUsers: 1,
            users: [],
            autoRoleId: "",
            expiresAt: null,
            durationLabel: "lifetime"
        }
    }
};

let discordClient = null;
let botConnectionState = "Söndürülüb";
let cachedGuildRoles = [];

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function makeSlugId(name) {
    const clean = String(name || "script")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return (clean || "script") + "-" + Math.random().toString(36).substring(2, 6);
}

function getRuntimeBotToken() {
    const envToken = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || "").trim();
    return envToken || EMBEDDED_BOT_TOKEN;
}

function isBotCurrentlyOnline() {
    return Boolean(discordClient && discordClient.isReady && discordClient.isReady() && discordClient.user);
}

function buildJoinDiscordUrl() {
    const clientId = String(store.discordConfig.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID;
    const perms = String(store.discordConfig.permissions || DEFAULT_PERMISSIONS).trim() || DEFAULT_PERMISSIONS;
    return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${encodeURIComponent(perms)}&integration_type=0&scope=bot+applications.commands`;
}

function isAdminAuthorized(req) {
    const candidatePass = String((req.query && req.query.pass) || (req.body && req.body.pass) || "").trim();
    if (!ADMIN_PASS || !candidatePass) return true;
    return candidatePass === ADMIN_PASS;
}
        fs.writeFileSync(DATA_FILE, JSON.stringify(safeStore, null, 2), 'utf8');
    } catch (err) {
        console.error("Məlumat fayla yazıla bilmədi:", err.message);
    }
}

function loadStoreFromDisk() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            saveStoreToDisk();
            return;
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        if (parsed && typeof parsed === 'object') {
            if (parsed.discordConfig && typeof parsed.discordConfig === 'object') {
                store.discordConfig.enabled = parsed.discordConfig.enabled !== false;
                if (typeof parsed.discordConfig.clientId === 'string' && parsed.discordConfig.clientId.trim()) {
                    store.discordConfig.clientId = parsed.discordConfig.clientId.trim();
                }
                if (typeof parsed.discordConfig.permissions === 'string' && parsed.discordConfig.permissions.trim()) {
                    store.discordConfig.permissions = parsed.discordConfig.permissions.trim();
                }
                store.discordConfig.autoRoleId = String(parsed.discordConfig.autoRoleId || "").trim();
                store.discordConfig.welcomeChannelId = String(parsed.discordConfig.welcomeChannelId || "").trim();
                if (typeof parsed.discordConfig.panelEmbedTitle === 'string' && parsed.discordConfig.panelEmbedTitle.trim()) {
                    store.discordConfig.panelEmbedTitle = parsed.discordConfig.panelEmbedTitle.trim();
                }
                if (typeof parsed.discordConfig.panelEmbedDesc === 'string' && parsed.discordConfig.panelEmbedDesc.trim()) {
                    store.discordConfig.panelEmbedDesc = parsed.discordConfig.panelEmbedDesc;
                }
                if (typeof parsed.discordConfig.panelEmbedColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.discordConfig.panelEmbedColor.trim())) {
                    store.discordConfig.panelEmbedColor = parsed.discordConfig.panelEmbedColor.trim();
                }
                if (typeof parsed.discordConfig.btnRedeemLabel === 'string' && parsed.discordConfig.btnRedeemLabel.trim()) {
                    store.discordConfig.btnRedeemLabel = parsed.discordConfig.btnRedeemLabel.trim().slice(0, 80);
                }
                if (typeof parsed.discordConfig.btnRedeemStyle === 'string') {
                    store.discordConfig.btnRedeemStyle = parsed.discordConfig.btnRedeemStyle;
                }
                if (typeof parsed.discordConfig.btnScriptLabel === 'string' && parsed.discordConfig.btnScriptLabel.trim()) {
                    store.discordConfig.btnScriptLabel = parsed.discordConfig.btnScriptLabel.trim().slice(0, 80);
                }
                if (typeof parsed.discordConfig.btnScriptStyle === 'string') {
                    store.discordConfig.btnScriptStyle = parsed.discordConfig.btnScriptStyle;
                }
                if (typeof parsed.discordConfig.btnHwidLabel === 'string' && parsed.discordConfig.btnHwidLabel.trim()) {
                    store.discordConfig.btnHwidLabel = parsed.discordConfig.btnHwidLabel.trim().slice(0, 80);
                }
                if (typeof parsed.discordConfig.btnHwidStyle === 'string') {
                    store.discordConfig.btnHwidStyle = parsed.discordConfig.btnHwidStyle;
                }
                if (typeof parsed.discordConfig.btnStatsLabel === 'string' && parsed.discordConfig.btnStatsLabel.trim()) {
                    store.discordConfig.btnStatsLabel = parsed.discordConfig.btnStatsLabel.trim().slice(0, 80);
                }
                if (typeof parsed.discordConfig.btnStatsStyle === 'string') {
                    store.discordConfig.btnStatsStyle = parsed.discordConfig.btnStatsStyle;
                }
            }

            if (Array.isArray(parsed.scripts) && parsed.scripts.length > 0) {
                store.scripts = parsed.scripts
                    .filter(s => s && s.id && s.name)
                    .map(s => ({
                        id: String(s.id),
                        name: String(s.name),
                        code: typeof s.code === "string" ? s.code : ""
                    }));
            }

            if (Array.isArray(parsed.whitelist)) {
                store.whitelist = parsed.whitelist
                    .filter(w => w && w.id)
                    .map(w => ({
                        id: String(w.id).trim(),
                        label: String(w.label || w.id).trim(),
                        scriptId: String(w.scriptId || (store.scripts[0]?.id || "sado-hub")),
                        addedAt: typeof w.addedAt === "number" ? w.addedAt : Date.now()
                    }));
            }

            if (parsed.keys && typeof parsed.keys === 'object') {
                const normalizedKeys = {};
                const fallbackScriptId = store.scripts[0]?.id || "sado-hub";
                for (const [k, v] of Object.entries(parsed.keys)) {
                    if (!v || typeof v !== 'object') continue;
                    const usersList = Array.isArray(v.users) ? v.users : [];
                    if (usersList.length === 0 && v.hwid) {
                        usersList.push({
                            hwid: String(v.hwid),
                            discordUserId: v.discordUserId ? String(v.discordUserId) : null
                        });
                    }
                    normalizedKeys[k] = {
                        owner: String(v.owner || "User"),
                        scriptId: String(v.scriptId || fallbackScriptId),
                        maxUsers: Math.max(1, parseInt(v.maxUsers, 10) || 1),
                        users: usersList,
                        autoRoleId: String(v.autoRoleId || ""),
                        expiresAt: typeof v.expiresAt === "number" ? v.expiresAt : null,
                        durationLabel: String(v.durationLabel || "lifetime")
                    };
                }
                store.keys = normalizedKeys;
            }
        }
    } catch (err) {
        console.error("Məlumat faylı oxuna bilmədi:", err.message);
    }
}

function getBaseUrl(req) {
    if (req) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.get('host');
        if (host) {
            panelBaseUrl = `${protocol}://${host}`;
            return panelBaseUrl;
        }
    }
    return panelBaseUrl || "https://sado-protect.onrender.com";
}

function getScriptById(scriptId) {
    return store.scripts.find(s => s.id === scriptId) || store.scripts[0] || {
        id: "sado-hub",
        name: "SADO HUB",
        code: `print("SADOPROTECT")`
    };
}

function normalizeDuration(durationKey) {
    const key = String(durationKey || "lifetime").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(DURATION_MS_MAP, key) ? key : "lifetime";
}

function purgeExpiredKeys() {
    const now = Date.now();
    let changed = false;
    for (const k in store.keys) {
        const entry = store.keys[k];
        if (entry && typeof entry.expiresAt === "number" && entry.expiresAt <= now) {
            delete store.keys[k];
            changed = true;
        }
    }
    if (changed) {
        saveStoreToDisk();
    }
}

function formatRemainingTime(keyEntry) {
    if (!keyEntry) return "Silinib";
    if (keyEntry.expiresAt === null || keyEntry.expiresAt === undefined) {
        return "Lifetime";
    }
    const diffMs = keyEntry.expiresAt - Date.now();
    if (diffMs <= 0) return "Vaxtı bitib";
    const totalMinutes = Math.ceil(diffMs / 60000);
    if (totalMinutes < 60) return `${totalMinutes} dəq qalıb`;
    const totalHours = Math.floor(totalMinutes / 60);
    const remMins = totalMinutes % 60;
    if (totalHours < 24) {
        return remMins > 0 ? `${totalHours} saat ${remMins} dəq qalıb` : `${totalHours} saat qalıb`;
    }
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return remHours > 0 ? `${days} gün ${remHours} saat qalıb` : `${days} gün qalıb`;
}

function createKeyForUser(ownerName, durationKey = "lifetime", scriptId = "", maxUsers = 1, autoRoleId = "") {
    purgeExpiredKeys();
    const normDuration = normalizeDuration(durationKey);
    const ms = DURATION_MS_MAP[normDuration];
    const targetScript = getScriptById(scriptId);
    const parsedLimit = Math.max(1, parseInt(maxUsers, 10) || 1);
    const roleToAssign = String(autoRoleId || store.discordConfig.autoRoleId || "").trim();

    const newKey = "SADO-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    store.keys[newKey] = {
        owner: String(ownerName || "User").trim().slice(0, 40) || "User",
        scriptId: targetScript.id,
        maxUsers: parsedLimit,
        users: [],
        autoRoleId: roleToAssign,
        expiresAt: typeof ms === "number" ? Date.now() + ms : null,
        durationLabel: DURATION_LABEL_MAP[normDuration]
    };
    saveStoreToDisk();
    return newKey;
}

function getRedeemedKeyForDiscordUser(discordUserId) {
    if (!discordUserId) return null;
    for (const [k, entry] of Object.entries(store.keys)) {
        if (entry && Array.isArray(entry.users) && entry.users.some(u => u.discordUserId === discordUserId)) {
            return { key: k, entry };
        }
    }
    return null;
}

function normalizeWhitelistIdentifier(rawValue) {
    const cleaned = String(rawValue || "").trim();
    const mentionMatch = cleaned.match(/^<@!?(\d+)>$/);
    if (mentionMatch) return mentionMatch[1];
    return cleaned;
}

function isWhitelistedIdentifier(identifier) {
    const clean = normalizeWhitelistIdentifier(identifier).toLowerCase();
    if (!clean) return null;
    return store.whitelist.find(item => String(item.id).toLowerCase() === clean) || null;
}

function addToWhitelist(rawIdentifier, scriptId = "") {
    const cleanId = normalizeWhitelistIdentifier(rawIdentifier);
    if (!cleanId) return { ok: false, reason: "Deyer bosdur" };
    const targetScript = getScriptById(scriptId);
    const existing = store.whitelist.find(item => String(item.id).toLowerCase() === cleanId.toLowerCase());
    if (existing) {
        existing.scriptId = targetScript.id;
        existing.label = cleanId;
        saveStoreToDisk();
        return { ok: true, entry: existing, updated: true };
    }
    const created = {
        id: cleanId,
        label: cleanId,
        scriptId: targetScript.id,
        addedAt: Date.now()
    };
    store.whitelist.push(created);
    saveStoreToDisk();
    return { ok: true, entry: created, updated: false };
}

function removeFromWhitelist(rawIdentifier) {
    const cleanId = normalizeWhitelistIdentifier(rawIdentifier);
    if (!cleanId) return false;
    const beforeLen = store.whitelist.length;
    store.whitelist = store.whitelist.filter(item => String(item.id).toLowerCase() !== cleanId.toLowerCase());
    const removed = store.whitelist.length !== beforeLen;
    if (removed) {
        saveStoreToDisk();
    }
    return removed;
}

function buildLoaderSnippet(keyStr) {
    const base = getBaseUrl();
    return `script_key = "${keyStr}"\nlocal hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${base}/loader?key=" .. script_key .. "&hwid=" .. hwid))()`;
}

function buildOneTapCopyUrl(textToCopy) {
    const base = getBaseUrl();
    const encoded = encodeURIComponent(textToCopy);
    return `${base}/copy?text=${encoded}`;
}

async function refreshGuildRoles(client) {
    try {
        const rolesMap = new Map();
        for (const [, guild] of client.guilds.cache) {
            await guild.roles.fetch();
            for (const [, role] of guild.roles.cache) {
                if (!role.managed && role.id !== guild.id) {
                    rolesMap.set(role.id, {
                        id: role.id,
                        name: role.name,
                        guildName: guild.name
                    });
                }
            }
        }
        cachedGuildRoles = Array.from(rolesMap.values());
    } catch (err) {
        console.error("Rol siyahısı yenilənmədi:", err.message);
    }
}

async function assignRoleToDiscordUser(discordUserId, roleId) {
    const targetRoleId = String(roleId || store.discordConfig.autoRoleId || "").trim();
    if (!discordClient || !discordUserId || !targetRoleId) return { ok: false, reason: "Rol təyin edilməyib" };

    for (const [, guild] of discordClient.guilds.cache) {
        try {
            const member = await guild.members.fetch(discordUserId).catch(() => null);
            if (member) {
                await member.roles.add(targetRoleId);
                return { ok: true, roleId: targetRoleId };
            }
        } catch (err) {
            return { ok: false, reason: err.message };
        }
    }
    return { ok: false, reason: "İstifadəçi serverdə tapılmadı" };
}

function buildScriptSelectorMessage(guildName = "SADOPROTECT") {
    const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle('SADOPROTECT — Skript Seçimi')
        .setDescription(
            `Aşağıdakı menyudan idarə etmək istədiyiniz skripti seçin.\n` +
            `Seçdiyiniz skriptə aid **Control Panel** açılacaq.`
        )
        .setFooter({ text: `${guildName} • SADOPROTECT` });

    const options = store.scripts.slice(0, 25).map(sc => ({
        label: sc.name.slice(0, 100),
        description: `Script ID: ${sc.id}`.slice(0, 100),
        value: sc.id
    }));

    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('sado_select_script_panel')
            .setPlaceholder('Skript seçin...')
            .addOptions(options)
    );

    return { embeds: [embed], components: [selectRow] };
}

function resolveButtonStyle(styleName, fallbackStyle) {
    switch (String(styleName || "").trim()) {
        case "Success": return ButtonStyle.Success;
        case "Primary": return ButtonStyle.Primary;
        case "Secondary": return ButtonStyle.Secondary;
        case "Danger": return ButtonStyle.Danger;
        default: return fallbackStyle;
    }
}

function parseHexColorInt(hexStr, fallbackInt = 0x7c3aed) {
    const clean = String(hexStr || "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
        return parseInt(clean, 16);
    }
    return fallbackInt;
}

function buildScriptControlPanelMessage(scriptObj, guildName = "SADOPROTECT") {
    const cfg = store.discordConfig;
    const rawTitle = String(cfg.panelEmbedTitle || "{script} — Control Panel");
    const rawDesc = String(
        cfg.panelEmbedDesc ||
        "This control panel is for the project:\n**{script}**\nIf you're a buyer, click on the buttons below to redeem your key, get the script or reset HWID"
    );

    const finalTitle = rawTitle.replace(/\{script\}/gi, scriptObj.name).slice(0, 256);
    const finalDesc = rawDesc.replace(/\{script\}/gi, scriptObj.name).slice(0, 4000);
    const embedColor = parseHexColorInt(cfg.panelEmbedColor, 0x7c3aed);

    const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle(finalTitle)
        .setDescription(finalDesc)
        .setFooter({ text: `${guildName} • SADOPROTECT (${scriptObj.id})` });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sado_btn_redeem:${scriptObj.id}`)
            .setLabel(String(cfg.btnRedeemLabel || "Redeem Key").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnRedeemStyle, ButtonStyle.Success)),
        new ButtonBuilder()
            .setCustomId(`sado_btn_script:${scriptObj.id}`)
            .setLabel(String(cfg.btnScriptLabel || "Get Script").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnScriptStyle, ButtonStyle.Primary))
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sado_btn_hwid:${scriptObj.id}`)
            .setLabel(String(cfg.btnHwidLabel || "Reset HWID").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnHwidStyle, ButtonStyle.Secondary)),
        new ButtonBuilder()
            .setCustomId(`sado_btn_stats:${scriptObj.id}`)
            .setLabel(String(cfg.btnStatsLabel || "Get Stats").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnStatsStyle, ButtonStyle.Secondary))
    );

    return { embeds: [embed], components: [row1, row2] };
}

function findAutoPanelChannel(guild) {
    if (!guild) return null;
    if (store.discordConfig.welcomeChannelId) {
        const configured = guild.channels.cache.get(store.discordConfig.welcomeChannelId);
        if (configured && typeof configured.send === 'function') {
            return configured;
        }
    }
    if (guild.systemChannel && typeof guild.systemChannel.send === 'function') {
        return guild.systemChannel;
    }
    return guild.channels.cache.find(
        ch => ch && ch.isTextBased && ch.isTextBased() && typeof ch.send === 'function'
    ) || null;
}

async function postOnboardingPanelToGuild(guild) {
    try {
        const targetChannel = findAutoPanelChannel(guild);
        if (!targetChannel) return;
        const primaryScript = getScriptById("");
        const panelPayload = buildScriptControlPanelMessage(primaryScript, guild.name || "SADOPROTECT");
        await targetChannel.send({
            content: `**SADOPROTECT** serverə qoşuldu! Paneli yenidən göndərmək üçün \`/panel\` əmrindən istifadə edə bilərsiniz.`,
            ...panelPayload
        });
    } catch (err) {
        console.error("Avtomatik panel göndərilə bilmədi:", err.message);
    }
}

setInterval(() => {
    purgeExpiredKeys();
}, 15000);

async function stopDiscordBot() {
    if (discordClient) {
        try {
            await discordClient.destroy();
        } catch (_) {}
        discordClient = null;
    }
    botConnectionState = "Söndürülüb";
}

function buildPanelSlashCommands() {
    const scriptChoices = store.scripts.slice(0, 25).map(sc => ({
        name: String(sc.name || sc.id).slice(0, 100),
        value: String(sc.id).slice(0, 100)
    }));

    const panelCmd = new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Secilen skripte aid SADOPROTECT Control Panelini gonderir veya whitelist idare edir')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('Emeliyyat: panel, whitelist veya unwhitelist')
                .setRequired(false)
                .addChoices(
                    { name: 'panel', value: 'panel' },
                    { name: 'whitelist', value: 'whitelist' },
                    { name: 'unwhitelist', value: 'unwhitelist' }
                )
        )
        .addStringOption(option => {
            option
                .setName('name')
                .setDescription('Saytda yaratdiginiz skriptin adi')
                .setRequired(false);
            if (scriptChoices.length > 0) {
                option.addChoices(...scriptChoices);
            }
            return option;
        })
        .addStringOption(option =>
            option
                .setName('user')
                .setDescription('Whitelist / Unwhitelist ucun Discord ID, @mention ve ya HWID')
                .setRequired(false)
        );

    const whitelistCmd = new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Istifadecini whitelist (ag siyahisina) elave edir')
        .addStringOption(option =>
            option
                .setName('user')
                .setDescription('Discord ID, @mention ve ya HWID')
                .setRequired(true)
        )
        .addStringOption(option => {
            option
                .setName('name')
                .setDescription('Skript secin')
                .setRequired(false);
            if (scriptChoices.length > 0) {
                option.addChoices(...scriptChoices);
            }
            return option;
        });

    const unwhitelistCmd = new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('Istifadecini whitelist siyahisindan cixarir')
        .addStringOption(option =>
            option
                .setName('user')
                .setDescription('Cixarilacaq Discord ID, @mention ve ya HWID')
                .setRequired(true)
        );

    return [panelCmd.toJSON(), whitelistCmd.toJSON(), unwhitelistCmd.toJSON()];
}

async function syncDiscordSlashCommands(tokenOverride = null) {
    const cleanToken = String(tokenOverride || getRuntimeBotToken() || "").trim();
    if (!cleanToken) return;

    try {
        let appId = (discordClient && discordClient.user ? discordClient.user.id : null) || store.discordConfig.clientId;
        if (!appId) {
            const meRes = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bot ${cleanToken}` }
            });
            if (meRes.ok) {
                const meData = await meRes.json();
                appId = meData.id;
            }
        }
        if (!appId) return;

        const rest = new REST({ version: '10' }).setToken(cleanToken);
        const commands = buildPanelSlashCommands();
        await rest.put(Routes.applicationCommands(appId), { body: commands });

        if (discordClient && discordClient.guilds && discordClient.guilds.cache) {
            for (const [guildId] of discordClient.guilds.cache) {
                await rest.put(
                    Routes.applicationGuildCommands(appId, guildId),
                    { body: commands }
                ).catch(() => {});
            }
        }
    } catch (cmdErr) {
        console.error("Slash command yenilənmə xətası:", cmdErr.message);
    }
}

async function startDiscordBot() {
    if (isBotCurrentlyOnline()) {
        botConnectionState = `Aktivdir (${discordClient.user.tag})`;
        return;
    }

    await stopDiscordBot();

    if (!store.discordConfig.enabled) {
        botConnectionState = "Söndürülüb";
        return;
    }

    const cleanToken = getRuntimeBotToken();
    if (!cleanToken) {
        botConnectionState = "Join Discord Hazırdır (Bot Token mühitdə təyin edilməyib)";
        return;
    }

    botConnectionState = "Qoşulur...";

    try {
        const client = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
        });

        client.once('ready', async () => {
            botConnectionState = `Aktivdir (${client.user.tag})`;
            if (client.user && client.user.id) {
                store.discordConfig.clientId = client.user.id;
                saveStoreToDisk();
            }
            discordClient = client;
            await refreshGuildRoles(client);
            await syncDiscordSlashCommands(cleanToken);
        });

        client.on('guildCreate', async (guild) => {
            await refreshGuildRoles(client);
            await syncDiscordSlashCommands(cleanToken);
            await postOnboardingPanelToGuild(guild);
        });

        client.on('interactionCreate', async (interaction) => {
            try {
                purgeExpiredKeys();

                if (interaction.isAutocomplete()) {
                    if (interaction.commandName === 'panel') {
                        const focused = String(interaction.options.getFocused() || "").toLowerCase();
                        const matched = store.scripts
                            .filter(sc => !focused || sc.name.toLowerCase().includes(focused) || sc.id.toLowerCase().includes(focused))
                            .slice(0, 25)
                            .map(sc => ({
                                name: sc.name.slice(0, 100),
                                value: sc.id
                            }));
                        await interaction.respond(matched).catch(() => {});
                    }
                    return;
                }

                if (interaction.isChatInputCommand()) {
                    if (interaction.commandName === 'whitelist' || interaction.commandName === 'unwhitelist') {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                        const rawUserOption = interaction.options.getString('user');
                        const rawNameOption = interaction.options.getString('name');

                        if (interaction.commandName === 'whitelist') {
                            const chosenScript = rawNameOption
                                ? (store.scripts.find(s => s.id === rawNameOption || s.name.toLowerCase() === rawNameOption.toLowerCase()) || getScriptById(rawNameOption))
                                : getScriptById("");
                            const resAdd = addToWhitelist(rawUserOption, chosenScript.id);
                            if (!resAdd.ok) {
                                await interaction.editReply({ content: `Xeta: ${resAdd.reason}` });
                                return;
                            }
                            await interaction.editReply({
                                content: `**${escapeHtml(resAdd.entry.id)}** whitelist-e elave olundu (Skript: **${escapeHtml(chosenScript.name)}**).`
                            });
                            return;
                        }

                        if (interaction.commandName === 'unwhitelist') {
                            const removed = removeFromWhitelist(rawUserOption);
                            await interaction.editReply({
                                content: removed
                                    ? `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisindan cixarildi.`
                                    : `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisinda tapilmadi.`
                            });
                            return;
                        }
                    }

                    if (interaction.commandName === 'panel') {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                        const actionChoice = String(interaction.options.getString('action') || 'panel').toLowerCase();
                        const rawNameOption = interaction.options.getString('name');
                        const rawUserOption = interaction.options.getString('user');

                        if (actionChoice === 'whitelist') {
                            if (!rawUserOption || !rawUserOption.trim()) {
                                await interaction.editReply({
                                    content: 'Whitelist ucun `user` sahesine Discord ID, mention ve ya HWID daxil edin. Mes: `/panel action:whitelist user:123456789012345678`'
                                });
                                return;
                            }
                            const chosenScript = rawNameOption
                                ? (store.scripts.find(s => s.id === rawNameOption || s.name.toLowerCase() === rawNameOption.toLowerCase()) || getScriptById(rawNameOption))
                                : getScriptById("");
                            const resAdd = addToWhitelist(rawUserOption, chosenScript.id);
                            if (!resAdd.ok) {
                                await interaction.editReply({ content: `Xeta: ${resAdd.reason}` });
                                return;
                            }
                            await interaction.editReply({
                                content: `**${escapeHtml(resAdd.entry.id)}** whitelist-e elave olundu (Skript: **${escapeHtml(chosenScript.name)}**). Bu istifadeci key ve HWID limiti olmadan skripti islede biler.`
                            });
                            return;
                        }

                        if (actionChoice === 'unwhitelist') {
                            if (!rawUserOption || !rawUserOption.trim()) {
                                await interaction.editReply({
                                    content: 'Unwhitelist ucun `user` sahesine cixarilacaq ID/HWID yazin. Mes: `/panel action:unwhitelist user:123456789012345678`'
                                });
                                return;
                            }
                            const removed = removeFromWhitelist(rawUserOption);
                            await interaction.editReply({
                                content: removed
                                    ? `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisindan cixarildi.`
                                    : `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisinda tapilmadi.`
                            });
                            return;
                        }

                        if (!store.scripts.length) {
                            await interaction.editReply({
                                content: 'Hec bir skript yaradilmayib. Evvelce saytda **+ NEW SCRIPTS** ile skript yaradin.'
                            });
                            return;
                        }

                        const channel = interaction.channel;

                        if (rawNameOption) {
                            const byId = store.scripts.find(s => s.id === rawNameOption);
                            const byName = store.scripts.find(s => s.name.toLowerCase() === rawNameOption.toLowerCase());
                            const partialName = store.scripts.find(s => s.name.toLowerCase().includes(rawNameOption.toLowerCase()));
                            const targetScript = byId || byName || partialName;

                            if (!targetScript) {
                                const availableNames = store.scripts.map(s => `• ${s.name}`).join('\n');
                                await interaction.editReply({
                                    content: `\`${rawNameOption}\` adli skript tapilmadi.\nMovcud skriptler:\n${availableNames}`
                                });
                                return;
                            }

                            if (!channel || typeof channel.send !== 'function') {
                                await interaction.editReply({
                                    content: 'Bu kanalda panel gonderile bilmedi.'
                                });
                                return;
                            }

                            const panelMsg = buildScriptControlPanelMessage(targetScript, interaction.guild?.name || "SADOPROTECT");
                            await channel.send(panelMsg);
                            await interaction.editReply({
                                content: `**${targetScript.name}** skriptine aid panel kanala gonderildi.`
                            });
                            return;
                        }

                        const selectorPayload = buildScriptSelectorMessage(interaction.guild?.name || "SADOPROTECT");
                        await interaction.editReply(selectorPayload);
                    }
                    return;
                }

                if (interaction.isStringSelectMenu()) {
                    if (interaction.customId === 'sado_select_script_panel') {
                        await interaction.deferUpdate().catch(() => {});
                        const chosenScriptId = interaction.values[0];
                        const chosenScript = getScriptById(chosenScriptId);
                        const channel = interaction.channel;

                        if (channel && typeof channel.send === 'function') {
                            const panelMsg = buildScriptControlPanelMessage(chosenScript, interaction.guild?.name || "SADOPROTECT");
                            await channel.send(panelMsg);
                            await interaction.editReply({
                                content: `**${chosenScript.name}** paneli kanala gonderildi.`,
                                embeds: [],
                                components: []
                            }).catch(() => {});
                        } else {
                            await interaction.followUp({
                                content: 'Bu kanalda mesaj gonderile bilmedi.',
                                flags: MessageFlags.Ephemeral
                            }).catch(() => {});
                        }
                    }
                    return;
                }

                if (interaction.isButton()) {
                    const [actionPart, scriptIdPart] = String(interaction.customId || "").split(":");
                    const activeScript = getScriptById(scriptIdPart);

                    if (actionPart === 'sado_btn_redeem') {
                        const modal = new ModalBuilder()
                            .setCustomId(`modal_redeem:${activeScript.id}`)
                            .setTitle(`Redeem Key — ${activeScript.name.slice(0, 28)}`);
                        const input = new TextInputBuilder()
                            .setCustomId('key_input')
                            .setLabel('Acarinizi (Key) daxil edin')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true);
                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        await interaction.showModal(modal);
                        return;
                    }

                    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

                    if (actionPart === 'sado_btn_script') {
                        const wlEntry = isWhitelistedIdentifier(interaction.user.id);
                        const redeemed = getRedeemedKeyForDiscordUser(interaction.user.id);

                        if (!wlEntry && !redeemed) {
                            await interaction.editReply({
                                content: 'Key aktivləşməyib! Əvvəlcə **Redeem Key** düyməsinə basıb key-inizi aktivləşdirin.'
                            });
                            return;
                        }

                        const snippet = wlEntry
                            ? buildLoaderSnippet(`WHITELIST-${wlEntry.id}`)
                            : buildLoaderSnippet(redeemed.key);
                        const copyLink = buildOneTapCopyUrl(snippet);
                        const copyRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setLabel('Scripti Kopyala (1 Bas)')
                                .setStyle(ButtonStyle.Link)
                                .setURL(copyLink)
                        );

                        const headerLabel = wlEntry
                            ? `SADOPROTECT Whitelist Loader (\`${wlEntry.id}\`)`
                            : `SADOPROTECT Loader (\`${redeemed.key}\` • ${redeemed.entry.durationLabel || "lifetime"})`;

                        await interaction.editReply({
                            content: `${headerLabel}:\n\`\`\`lua\n${snippet}\n\`\`\``,
                            components: [copyRow]
                        });
                        return;
                    }

                    if (actionPart === 'sado_btn_hwid') {
                        const redeemed = getRedeemedKeyForDiscordUser(interaction.user.id);
                        if (!redeemed) {
                            await interaction.editReply({
                                content: 'Key aktivləşməyib! Əvvəlcə **Redeem Key** düyməsinə basıb key-inizi aktivləşdirin.'
                            });
                            return;
                        }

                        redeemed.entry.users = [];
                        saveStoreToDisk();

                        await interaction.editReply({
                            content: `HWID sıfırlandı (\`${redeemed.key}\`)! İndi key-i verdiyiniz şəxs **Redeem Key** edib skripti işlədə bilər (yenidən Reset atmadıqca sizin cihazda işləməyəcək).`
                        });
                        return;
                    }

                    if (actionPart === 'sado_btn_stats') {
                        const scriptKeys = Object.entries(store.keys).filter(([, v]) => v.scriptId === activeScript.id);
                        const activeCount = scriptKeys.length;
                        const boundCount = scriptKeys.filter(([, v]) => Array.isArray(v.users) && v.users.length > 0).length;

                        const embed = new EmbedBuilder()
                            .setColor(0x38bdf8)
                            .setTitle(`${activeScript.name} — Stats`)
                            .addFields(
                                { name: 'Script', value: activeScript.name, inline: true },
                                { name: 'Active Keys', value: String(activeCount), inline: true },
                                { name: 'Used Slots', value: String(boundCount), inline: true }
                            );
                        await interaction.editReply({ embeds: [embed] });
                        return;
                    }
                }

                if (interaction.isModalSubmit()) {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const [modalType] = String(interaction.customId || "").split(":");
                    const submittedKey = String(interaction.fields.getTextInputValue('key_input') || "").trim();
                    const entry = submittedKey ? store.keys[submittedKey] : null;

                    if (!entry) {
                        await interaction.editReply({
                            content: `Key tapilmadi ve ya vaxti bitib: \`${submittedKey}\``
                        });
                        return;
                    }

                    if (modalType === 'modal_redeem') {
                        const maxLimit = Math.max(1, parseInt(entry.maxUsers, 10) || 1);
                        const existingUser = entry.users.find(u => u.discordUserId === interaction.user.id);

                        if (!existingUser && entry.users.length >= maxLimit) {
                            await interaction.editReply({
                                content: `Bu key-i basqasi isledib! (Limit: ${maxLimit} nefer)`
                            });
                            return;
                        }

                        if (!existingUser) {
                            entry.users.push({
                                hwid: null,
                                discordUserId: interaction.user.id
                            });
                            saveStoreToDisk();
                        }

                        const roleResult = await assignRoleToDiscordUser(interaction.user.id, entry.autoRoleId);
                        const roleNote = roleResult.ok
                            ? `\nRol verildi: <@&${roleResult.roleId}>`
                            : "";

                        await interaction.editReply({
                            content: `Key ugurla tesdiqlendi (\`${submittedKey}\`). Indi **Get Script** ve **Reset HWID** duymeleri aktivdir. Muddet: **${entry.durationLabel || "lifetime"}** (${formatRemainingTime(entry)}).${roleNote}`
                        });
                        return;
                    }
                }
            } catch (interErr) {
                console.error("Interaction xətası:", interErr.message);
                if (interaction && (interaction.deferred || interaction.replied)) {
                    await interaction.editReply({ content: `Xeta bas verdi: ${interErr.message}` }).catch(() => {});
                } else if (interaction && typeof interaction.reply === 'function') {
                    await interaction.reply({ content: `Xeta bas verdi: ${interErr.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            }
        });

        discordClient = client;
        await client.login(cleanToken);
    } catch (err) {
        botConnectionState = `Xəta: ${err.message || "Token səhvdir"}`;
        discordClient = null;
    }
}

app.get('/', async (req, res) => {
    try {
        purgeExpiredKeys();
        if (discordClient) {
            await refreshGuildRoles(discordClient);
        }

        getBaseUrl(req);
        const viewMode = String(req.query.view || "hub").toLowerCase();
        const isPanelView = viewMode === "panel";
        const activeTab = req.query.tab === "discord" ? "discord" : "main";
        const msgType = String(req.query.msg || "");
        let bannerHtml = "";
        if (msgType === "script_created") {
            bannerHtml = `<div class="sp-banner sp-banner-success">Yeni skript yadda saxlanildi!</div>`;
        } else if (msgType === "script_updated") {
            bannerHtml = `<div class="sp-banner sp-banner-info">Skript deyisdirildi ve yadda saxlanildi!</div>`;
        } else if (msgType === "script_deleted") {
            bannerHtml = `<div class="sp-banner sp-banner-danger">Skript silindi!</div>`;
        } else if (msgType === "bot_saved") {
            bannerHtml = `<div class="sp-banner sp-banner-info">Join Discord ayarlari saxlanildi. Status: <b>${escapeHtml(botConnectionState)}</b></div>`;
        } else if (msgType === "panel_style_saved") {
            bannerHtml = `<div class="sp-banner sp-banner-violet">Discord panel buton adlari ve rengleri yadda saxlanildi!</div>`;
        }

        const joinDiscordUrl = buildJoinDiscordUrl();
        const panelHref = "/?view=panel";
        const hubHref = "/";
            bannerHtml = `<div style="background:#065f46;color:#d1fae5;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Yeni skript yadda saxlanildi!</div>`;
        } else if (msgType === "script_updated") {
            bannerHtml = `<div style="background:#1d4ed8;color:#dbeafe;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Skript deyisdirildi ve yadda saxlanildi!</div>`;
        } else if (msgType === "script_deleted") {
            bannerHtml = `<div style="background:#7f1d1d;color:#fecaca;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Skript silindi!</div>`;
        } else if (msgType === "bot_saved") {
            bannerHtml = `<div style="background:#1e3a8a;color:#dbeafe;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Join Discord ayarlari saxlanildi. Status: <b>${escapeHtml(botConnectionState)}</b></div>`;
        } else if (msgType === "panel_style_saved") {
            bannerHtml = `<div style="background:#5b21b6;color:#ede9fe;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Discord panel buton adlari ve rengleri yadda saxlanildi!</div>`;
        }

        const joinDiscordUrl = buildJoinDiscordUrl();

        const renderStyleSelect = (fieldName, currentVal) => {
            const opts = [
                { val: "Success", label: "Yasil (Success)" },
                { val: "Primary", label: "Mavi (Primary)" },
                { val: "Secondary", label: "Boz (Secondary)" },
                { val: "Danger", label: "Qirmizi (Danger)" }
            ];
            return `<select name="${fieldName}" style="padding:9px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;">
                ${opts.map(o => `<option value="${o.val}" ${currentVal === o.val ? "selected" : ""}>${o.label}</option>`).join("")}
            </select>`;
        };

        const roleOptionsHtml = cachedGuildRoles.map(r =>
            `<option value="${escapeHtml(r.id)}" ${store.discordConfig.autoRoleId === r.id ? "selected" : ""}>@${escapeHtml(r.name)} (${escapeHtml(r.guildName)})</option>`
        ).join("");

        const keyRoleOptionsHtml = `<option value="">Default Auto Role</option>` + cachedGuildRoles.map(r =>
            `<option value="${escapeHtml(r.id)}">@${escapeHtml(r.name)}</option>`
        ).join("");

        const scriptOptionsHtml = store.scripts.map(sc =>
            `<option value="${escapeHtml(sc.id)}">${escapeHtml(sc.name)}</option>`
        ).join("");

        const savedScriptsHtml = store.scripts.map(sc => `
            <details class="sp-script-item">
                <summary class="sp-script-summary">
                    <span><b>${escapeHtml(sc.name)}</b> <span class="sp-muted-tag">(Deyisdirmek ucun basin)</span></span>
                    <a href="/delete-script?id=${encodeURIComponent(sc.id)}" class="sp-danger-link">[Sil]</a>
                </summary>
                <form action="/edit-script" method="POST" class="sp-mt-3">
                    <input type="hidden" name="scriptId" value="${escapeHtml(sc.id)}">
                    <label class="sp-label">Skriptin adi:</label>
                    <input type="text" name="scriptName" value="${escapeHtml(sc.name)}" required class="sp-input sp-mb-2">
                    <label class="sp-label">Skriptin kodu:</label>
                    <textarea name="scriptCode" rows="6" required class="sp-textarea sp-mb-2">${escapeHtml(sc.code)}</textarea>
                    <button type="submit" class="sp-btn sp-btn-blue">Skripti Deyisdir</button>
                </form>
            </details>
        `).join("");

        let rows = "";
        for (let k in store.keys) {
            const item = store.keys[k];
            const safeK = escapeHtml(k);
            const safeKEnc = encodeURIComponent(k);
            const safeOwner = escapeHtml(item.owner);
            const scObj = getScriptById(item.scriptId);
            const safeScriptName = escapeHtml(scObj.name);
            const safeDuration = escapeHtml(item.durationLabel || "lifetime");
            const safeRemaining = escapeHtml(formatRemainingTime(item));
            const maxU = Math.max(1, parseInt(item.maxUsers, 10) || 1);
            const usedU = Array.isArray(item.users) ? item.users.length : 0;
            const roleBadge = item.autoRoleId ? escapeHtml(item.autoRoleId) : "Yoxdur";
            const sampleLoader = escapeHtml(buildLoaderSnippet(k));

            rows += `<tr>
                <td class="sp-td"><b>${safeK}</b></td>
                <td class="sp-td">${safeOwner}</td>
                <td class="sp-td">${safeScriptName}</td>
                <td class="sp-td">${usedU}/${maxU}</td>
                <td class="sp-td">${safeDuration} <span class="sp-muted-tag">(${safeRemaining})</span></td>
                <td class="sp-td">${roleBadge}</td>
                <td class="sp-td">
                    <a href="/reset?key=${safeKEnc}" class="sp-warn-link">[HWID Sifirla]</a>
                    <a href="/delete?key=${safeKEnc}" class="sp-danger-link">[Sil]</a>
                </td>
            </tr>
            <tr>
                <td colspan="7" class="sp-loader-row">
                    <div class="sp-loader-title">Loader Kodu:</div>
                    <pre class="sp-loader-pre">${sampleLoader}</pre>
                </td>
            </tr>`;
        }

        const wlListHtml = store.whitelist.length
            ? store.whitelist.map(w => {
                const sc = getScriptById(w.scriptId);
                return `<div class="sp-wl-item">
                    <span><b>${escapeHtml(w.id)}</b> <span class="sp-muted-tag">(${escapeHtml(sc.name)})</span></span>
                    <a href="/unwhitelist?id=${encodeURIComponent(w.id)}" class="sp-danger-link">[Unwhitelist]</a>
                </div>`;
            }).join("")
            : `<div class="sp-muted-text">Whitelist siyahisi bosdur.</div>`;

        res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADOPROTECT — LuaProtect &amp; Control Suite</title>
  <style>
    :root {
      --bg-0: #05070e;
      --bg-1: #0b1020;
      --bg-2: #11182e;
      --line: rgba(148, 163, 184, 0.16);
      --line-glow: rgba(124, 58, 237, 0.45);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-violet: #8b5cf6;
      --accent-cyan: #22d3ee;
      --accent-indigo: #5865F2;
      --accent-emerald: #10b981;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 15% 10%, rgba(139, 92, 246, 0.18), transparent 42%),
        radial-gradient(circle at 85% 18%, rgba(34, 211, 238, 0.14), transparent 40%),
        linear-gradient(180deg, var(--bg-0) 0%, var(--bg-1) 100%);
      color: var(--text-main);
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 20px;
      overflow-x: hidden;
    }
    .sp-intro-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      background:
        radial-gradient(circle at 50% 42%, rgba(139, 92, 246, 0.28), transparent 55%),
        radial-gradient(circle at 25% 75%, rgba(34, 211, 238, 0.16), transparent 45%),
        #05070e;
      transition: opacity 0.55s ease, visibility 0.55s ease, transform 0.55s ease;
    }
    .sp-intro-overlay.sp-intro-hide {
      opacity: 0;
      visibility: hidden;
      transform: scale(1.04);
      pointer-events: none;
    }
    .sp-intro-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid rgba(139, 92, 246, 0.45);
      background: rgba(139, 92, 246, 0.14);
      color: #c4b5fd;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 16px;
      animation: spFloatBadge 2.4s ease-in-out infinite;
    }
    .sp-intro-title {
      margin: 0;
      font-size: clamp(28px, 6.2vw, 56px);
      font-weight: 900;
      letter-spacing: 0.04em;
      background: linear-gradient(90deg, #ffffff 0%, #c4b5fd 42%, #22d3ee 100%);
      background-size: 200% auto;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      animation: spShineText 3s linear infinite, spPopIn 0.85s cubic-bezier(0.16, 1, 0.3, 1) both;
      text-shadow: 0 0 36px rgba(139, 92, 246, 0.35);
    }
    .sp-intro-sub {
      margin-top: 12px;
      color: var(--text-muted);
      font-size: clamp(13px, 2.5vw, 16px);
      max-width: 520px;
      line-height: 1.5;
      animation: spFadeUp 0.95s ease 0.18s both;
    }
    .sp-intro-bar {
      margin-top: 24px;
      width: min(280px, 75vw);
      height: 4px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.16);
      overflow: hidden;
    }
    .sp-intro-bar > span {
      display: block;
      height: 100%;
      width: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent-violet), var(--accent-cyan));
      transform-origin: left center;
      animation: spProgressSweep 1.55s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .sp-intro-skip {
      margin-top: 16px;
      background: transparent;
      border: 1px solid rgba(148, 163, 184, 0.25);
      color: var(--text-muted);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: color 0.2s ease, border-color 0.2s ease;
    }
    .sp-intro-skip:hover {
      color: #ffffff;
      border-color: rgba(139, 92, 246, 0.6);
    }
    @keyframes spShineText {
      0% { background-position: 0% center; }
      100% { background-position: 200% center; }
    }
    @keyframes spPopIn {
      0% { opacity: 0; transform: translateY(18px) scale(0.94); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes spFadeUp {
      0% { opacity: 0; transform: translateY(12px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    @keyframes spFloatBadge {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }
    @keyframes spProgressSweep {
      0% { transform: scaleX(0); }
      100% { transform: scaleX(1); }
    }

    .sp-shell {
      max-width: 1040px;
      margin: 0 auto;
      animation: spFadeUp 0.6s ease both;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: rgba(17, 24, 46, 0.85);
      backdrop-filter: blur(14px);
      padding: 12px 16px;
      border-radius: 14px;
      margin-bottom: 18px;
      border: 1px solid var(--line);
      position: relative;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }
    .hamburger-btn {
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.24);
      color: var(--accent-cyan);
      width: 42px;
      height: 40px;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 5px;
      padding: 0;
      transition: transform 0.18s ease, border-color 0.2s ease;
    }
    .hamburger-btn:hover {
      transform: translateY(-1px);
      border-color: var(--accent-violet);
    }
    .hamburger-btn span {
      display: block;
      width: 20px;
      height: 2px;
      background: var(--accent-cyan);
      border-radius: 2px;
    }
    .drawer-menu {
      display: none;
      position: absolute;
      top: 64px;
      left: 0;
      width: 260px;
      background: #0d1426;
      border: 1px solid rgba(139, 92, 246, 0.35);
      border-radius: 12px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.65);
      z-index: 120;
      overflow: hidden;
    }
    .drawer-menu.open {
      display: block;
      animation: spFadeUp 0.2s ease both;
    }
    .drawer-menu a {
      display: block;
      padding: 13px 16px;
      color: #e2e8f0;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
      transition: background 0.18s ease, color 0.18s ease;
    }
    .drawer-menu a:last-child { border-bottom: none; }
    .drawer-menu a:hover, .drawer-menu a.active {
      background: rgba(139, 92, 246, 0.16);
      color: var(--accent-cyan);
    }

    .sp-hero-card {
      position: relative;
      background: linear-gradient(145deg, rgba(17, 24, 46, 0.92), rgba(10, 15, 30, 0.95));
      border: 1px solid rgba(139, 92, 246, 0.34);
      border-radius: 18px;
      padding: 28px 24px;
      margin-bottom: 20px;
      box-shadow: 0 20px 45px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    .sp-hero-kicker {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent-cyan);
      background: rgba(34, 211, 238, 0.1);
      border: 1px solid rgba(34, 211, 238, 0.28);
      padding: 5px 12px;
      border-radius: 999px;
      margin-bottom: 12px;
    }
    .sp-hero-title {
      margin: 0 0 8px 0;
      font-size: clamp(24px, 4.5vw, 36px);
      font-weight: 900;
      letter-spacing: -0.01em;
      color: #ffffff;
    }
    .sp-hero-desc {
      margin: 0 0 22px 0;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.6;
      max-width: 660px;
    }
    .sp-stack-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      max-width: 340px;
    }
    .join-discord-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      background: linear-gradient(135deg, #5865F2 0%, #4752C4 100%);
      color: #ffffff;
      text-decoration: none;
      padding: 13px 20px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 10px 24px rgba(88, 101, 242, 0.35);
      transition: transform 0.18s ease, box-shadow 0.2s ease, filter 0.2s ease;
    }
    .join-discord-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 14px 28px rgba(88, 101, 242, 0.48);
      filter: brightness(1.06);
    }
    .sp-panel-launch-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.22) 0%, rgba(34, 211, 238, 0.16) 100%);
      color: #f8fafc;
      text-decoration: none;
      padding: 13px 20px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14px;
      border: 1px solid rgba(139, 92, 246, 0.5);
      box-shadow: 0 8px 22px rgba(124, 58, 237, 0.22);
      transition: transform 0.18s ease, border-color 0.2s ease, background 0.2s ease;
    }
    .sp-panel-launch-btn:hover {
      transform: translateY(-2px);
      border-color: var(--accent-cyan);
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.34) 0%, rgba(34, 211, 238, 0.24) 100%);
    }
    .sp-feature-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-top: 22px;
    }
    .sp-feature-box {
      background: rgba(11, 16, 32, 0.72);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
    }
    .sp-feature-box h4 {
      margin: 0 0 6px 0;
      font-size: 14px;
      color: #ffffff;
    }
    .sp-feature-box p {
      margin: 0;
      font-size: 12.5px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    .sp-card {
      margin-bottom: 20px;
      background: rgba(17, 24, 46, 0.86);
      border: 1px solid var(--line);
      padding: 18px;
      border-radius: 14px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
    }
    .sp-subbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 16px;
    }
    .sp-pill-nav {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .sp-pill-link {
      text-decoration: none;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-muted);
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--line);
      transition: all 0.18s ease;
    }
    .sp-pill-link.active, .sp-pill-link:hover {
      color: #ffffff;
      border-color: var(--accent-violet);
      background: rgba(139, 92, 246, 0.2);
    }

    .sp-label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 5px; }
    .sp-input, .sp-textarea, .sp-select {
      width: 100%;
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid #334155;
      background: #040814;
      color: #e2e8f0;
      font-size: 13.5px;
    }
    .sp-inline-input, .sp-inline-select {
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid #334155;
      background: #040814;
      color: #e2e8f0;
      font-size: 13px;
    }
    .sp-textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .sp-btn {
      border: none;
      padding: 9px 16px;
      border-radius: 9px;
      font-weight: 700;
      font-size: 13px;
      color: #ffffff;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.18s ease;
    }
    .sp-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
    .sp-btn-emerald { background: #10b981; }
    .sp-btn-blue { background: #2563eb; }
    .sp-btn-indigo { background: #6366f1; }
    .sp-btn-violet { background: #8b5cf6; }

    .sp-script-item {
      background: #0b1122;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .sp-script-summary {
      cursor: pointer;
      font-weight: 700;
      color: #e2e8f0;
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sp-wl-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 12px;
      background: #0b1122;
      border: 1px solid #1e293b;
      border-radius: 8px;
      margin-bottom: 6px;
    }
    .sp-table {
      width: 100%;
      background: rgba(17, 24, 46, 0.9);
      border-radius: 12px;
      border-collapse: collapse;
      text-align: left;
      overflow: hidden;
      border: 1px solid var(--line);
    }
    .sp-table-head { background: #172038; color: var(--accent-cyan); font-size: 13px; }
    .sp-th, .sp-td { padding: 10px; border-bottom: 1px solid #1e293b; font-size: 13px; }
    .sp-loader-row { padding: 8px 10px 12px 10px; border-bottom: 1px solid #1e293b; background: #0b1122; }
    .sp-loader-title { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
    .sp-loader-pre {
      margin: 0;
      padding: 8px 10px;
      background: #030712;
      border-radius: 8px;
      color: var(--accent-cyan);
      font-size: 12px;
      overflow-x: auto;
    }
    .sp-muted-tag { color: var(--text-muted); font-size: 12px; font-weight: 400; }
    .sp-muted-text { color: var(--text-muted); font-size: 13px; }
    .sp-warn-link { color: #fbbf24; text-decoration: none; margin-right: 8px; font-weight: 600; }
    .sp-danger-link { color: #f87171; text-decoration: none; font-weight: 600; }
    .sp-mb-2 { margin-bottom: 8px; }
    .sp-mb-3 { margin-bottom: 12px; }
    .sp-mt-3 { margin-top: 12px; }
    .sp-banner { padding: 11px 14px; border-radius: 10px; margin-bottom: 16px; font-size: 13.5px; font-weight: 600; }
    .sp-banner-success { background: rgba(6, 95, 70, 0.55); border: 1px solid #10b981; color: #d1fae5; }
    .sp-banner-info { background: rgba(30, 58, 138, 0.55); border: 1px solid #3b82f6; color: #dbeafe; }
    .sp-banner-danger { background: rgba(127, 29, 29, 0.55); border: 1px solid #ef4444; color: #fecaca; }
    .sp-banner-violet { background: rgba(91, 33, 182, 0.55); border: 1px solid #8b5cf6; color: #ede9fe; }

    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }
    .sp-btn-slot {
      background: #0b1122;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #1e293b;
    }
    @media (max-width: 720px) {
      .sp-feature-grid, .btn-grid {
        grid-template-columns: 1fr;
      }
      .sp-stack-actions {
        max-width: 100%;
      }
    }
  </style>
</head>
<body>
  <div id="spIntro" class="sp-intro-overlay" role="dialog" aria-label="Welcome to Sado Protect">
    <div class="sp-intro-badge">LuaProtect • Luarmor • Junkie Suite</div>
    <h1 class="sp-intro-title">WELCOME TO SADO PROTECT</h1>
    <p class="sp-intro-sub">Sürətli skript qorunması, Join Discord dəvəti və bir kliklə idarəetmə paneli.</p>
    <div class="sp-intro-bar"><span></span></div>
    <button type="button" class="sp-intro-skip" onclick="dismissIntro()">Daxil ol</button>
  </div>

  <div class="sp-shell">
    <div class="topbar">
        <div style="display:flex;align-items:center;gap:12px;">
            <button type="button" class="hamburger-btn" aria-label="Menyu" onclick="document.getElementById('navDrawer').classList.toggle('open')">
                <span></span>
                <span></span>
                <span></span>
            </button>
            <a href="${hubHref}" style="text-decoration:none;"><h1 style="color:var(--accent-cyan);margin:0;font-size:19px;font-weight:900;letter-spacing:0.03em;">SADOPROTECT</h1></a>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
            <a href="${panelHref}" class="sp-pill-link ${isPanelView ? "active" : ""}">İdarəetmə Paneli</a>
        </div>
        <div id="navDrawer" class="drawer-menu">
            <a href="${hubHref}" class="${!isPanelView ? "active" : ""}">Ana Ekran (Join Discord)</a>
            <a href="${panelHref}&tab=main" class="${isPanelView && activeTab === "main" ? "active" : ""}">İdarəetmə Paneli — Skript &amp; Key</a>
            <a href="${panelHref}&tab=discord" class="${isPanelView && activeTab === "discord" ? "active" : ""}">İdarəetmə Paneli — Discord Ayarları</a>
        </div>
    </div>
    ${bannerHtml}

    ${!isPanelView ? `
    <div class="sp-hero-card">
        <span class="sp-hero-kicker">Script Protection &amp; Discord Control</span>
        <h2 class="sp-hero-title">WELCOME TO SADO PROTECT</h2>
        <p class="sp-hero-desc">
            Əvvəlcə <b>Join Discord</b> ilə botu serverinizə əlavə edin, sonra aşağıdakı <b>İdarəetmə Paneli</b> düyməsinə basaraq skriptlərinizi, açarları (Key), whitelist siyahısını və panel görünüşünü idarə edin.
        </p>
        <div class="sp-stack-actions">
            <a href="${escapeHtml(joinDiscordUrl)}" target="_blank" rel="noopener noreferrer" class="join-discord-btn">Join Discord</a>
            <a href="${panelHref}" class="sp-panel-launch-btn">İdarəetmə Paneli</a>
        </div>
        <div class="sp-feature-grid">
            <div class="sp-feature-box">
                <h4>1. Join Discord</h4>
                <p>Botu serverinizə birbaşa dəvət edin və avtomatik Control Panel / slash əmrlərlə istifadəyə başlayın.</p>
            </div>
            <div class="sp-feature-box">
                <h4>2. İdarəetmə Paneli</h4>
                <p>Skript əlavə edin, vaxtlı və ya lifetime key yaradın, HWID sıfırlayın və whitelist idarə edin.</p>
            </div>
            <div class="sp-feature-box">
                <h4>3. Loader &amp; HWID Lock</h4>
                <p>Hər skript və key üçün avtomatik Roblox loader kodu və HWID qoruma sistemi hazırdır.</p>
            </div>
        </div>
    </div>
    ` : `
    <div class="sp-subbar">
        <div class="sp-pill-nav">
            <a href="${hubHref}" class="sp-pill-link">← Join Discord Ekranı</a>
            <a href="${panelHref}&tab=main" class="sp-pill-link ${activeTab === "main" ? "active" : ""}">Skriptlər &amp; Key Paneli</a>
            <a href="${panelHref}&tab=discord" class="sp-pill-link ${activeTab === "discord" ? "active" : ""}">Discord &amp; Buton Ayarları</a>
        </div>
        <a href="${escapeHtml(joinDiscordUrl)}" target="_blank" rel="noopener noreferrer" class="join-discord-btn" style="width:auto;padding:9px 16px;">Join Discord</a>
    </div>

    ${activeTab === "discord" ? `
    <div class="sp-card">
        <h3 style="margin-top:0;color:#a5b4fc;">Join Discord (LuaProtect Üslubu — Dəvət Et &amp; İdarə Et)</h3>
        <div class="sp-mb-3" style="font-size:14px;">Bot Veziyyeti: <b>${escapeHtml(botConnectionState)}</b></div>
        <div class="sp-mb-3">
            <a href="${escapeHtml(joinDiscordUrl)}" target="_blank" rel="noopener noreferrer" class="join-discord-btn" style="width:auto;padding:10px 18px;">Join Discord Server</a>
        </div>
        <form action="/save-bot" method="POST">
            <input type="hidden" name="returnTab" value="discord">
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
                <input type="checkbox" name="enabled" value="1" ${store.discordConfig.enabled ? "checked" : ""}>
                <span>Join Discord &amp; Avtomatik Panel Aktiv Et</span>
            </label>
            <label class="sp-label">Discord Bot Client ID:</label>
            <input type="text" name="clientId" value="${escapeHtml(store.discordConfig.clientId)}" required class="sp-input sp-mb-2">
            <label class="sp-label">Avtomatik Panel Kanal ID (istəyə bağlı):</label>
            <input type="text" name="welcomeChannelId" value="${escapeHtml(store.discordConfig.welcomeChannelId)}" placeholder="Boş buraxılsa bot girdiyi ilk uyğun kanala panel atar" class="sp-input sp-mb-2">
            <label class="sp-label">Server Rollari (Auto Role):</label>
            <select name="autoRoleId" class="sp-select sp-mb-3">
                <option value="">Rol secilmeyib</option>
                ${roleOptionsHtml}
            </select>
            <button type="submit" class="sp-btn sp-btn-indigo">Dəvət &amp; Panel Ayarını Saxla</button>
        </form>
    </div>

    <form action="/save-panel-style" method="POST" class="sp-card">
        <h3 style="margin-top:0;color:var(--accent-cyan);">Discord Panel Gorunusu &amp; Buton Ayarlari</h3>
        <p class="sp-muted-text" style="margin-top:0;">Basliq ve aciqlamada <code>{script}</code> yazsaniz avtomatik secilen skriptin adi ile evez olunacaq.</p>

        <label class="sp-label">Panel Basligi (Title):</label>
        <input type="text" name="panelEmbedTitle" value="${escapeHtml(store.discordConfig.panelEmbedTitle)}" required class="sp-input sp-mb-2">

        <label class="sp-label">Panel Aciqlamasi (Description):</label>
        <textarea name="panelEmbedDesc" rows="3" required class="sp-textarea sp-mb-2">${escapeHtml(store.discordConfig.panelEmbedDesc)}</textarea>

        <label class="sp-label">Panel Kenar Rengi (Embed Color):</label>
        <input type="color" name="panelEmbedColor" value="${escapeHtml(store.discordConfig.panelEmbedColor || "#7c3aed")}" style="width:80px;height:38px;padding:2px;border-radius:8px;border:1px solid #334155;background:#040814;cursor:pointer;margin-bottom:14px;">

        <h4 style="margin:6px 0 10px 0;color:#cbd5e1;">Buton Adlari ve Rengleri</h4>
        <div class="btn-grid">
            <div class="sp-btn-slot">
                <label class="sp-label">1-ci Buton (Redeem Key) Adi &amp; Rengi:</label>
                <div style="display:flex;gap:8px;">
                    <input type="text" name="btnRedeemLabel" value="${escapeHtml(store.discordConfig.btnRedeemLabel)}" required class="sp-inline-input" style="flex:1;">
                    ${renderStyleSelect("btnRedeemStyle", store.discordConfig.btnRedeemStyle)}
                </div>
            </div>
            <div class="sp-btn-slot">
                <label class="sp-label">2-ci Buton (Get Script) Adi &amp; Rengi:</label>
                <div style="display:flex;gap:8px;">
                    <input type="text" name="btnScriptLabel" value="${escapeHtml(store.discordConfig.btnScriptLabel)}" required class="sp-inline-input" style="flex:1;">
                    ${renderStyleSelect("btnScriptStyle", store.discordConfig.btnScriptStyle)}
                </div>
            </div>
            <div class="sp-btn-slot">
                <label class="sp-label">3-cu Buton (Reset HWID) Adi &amp; Rengi:</label>
                <div style="display:flex;gap:8px;">
                    <input type="text" name="btnHwidLabel" value="${escapeHtml(store.discordConfig.btnHwidLabel)}" required class="sp-inline-input" style="flex:1;">
                    ${renderStyleSelect("btnHwidStyle", store.discordConfig.btnHwidStyle)}
                </div>
            </div>
            <div class="sp-btn-slot">
                <label class="sp-label">4-cu Buton (Get Stats) Adi &amp; Rengi:</label>
                <div style="display:flex;gap:8px;">
                    <input type="text" name="btnStatsLabel" value="${escapeHtml(store.discordConfig.btnStatsLabel)}" required class="sp-inline-input" style="flex:1;">
                    ${renderStyleSelect("btnStatsStyle", store.discordConfig.btnStatsStyle)}
                </div>
            </div>
        </div>

        <button type="submit" class="sp-btn sp-btn-emerald">Butonlari ve Paneli Yadda Saxla</button>
    </form>
    ` : `
    <div class="sp-card">
        <details open>
            <summary style="cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:8px;background:#0284c7;color:white;padding:9px 16px;border-radius:9px;font-weight:700;">
                <span>+ NEW SCRIPTS</span>
            </summary>
            <form action="/new-script" method="POST" class="sp-mt-3">
                <label class="sp-label">Skriptin adi:</label>
                <input type="text" name="scriptName" placeholder="Skriptin adini yazin (mes: SADO DUEL)" required class="sp-input sp-mb-2">
                <label class="sp-label">Skriptin kodu:</label>
                <textarea name="scriptCode" rows="7" placeholder="Skriptin kodunu yazin..." required class="sp-textarea sp-mb-2"></textarea>
                <button type="submit" class="sp-btn sp-btn-emerald">Yadda saxla</button>
            </form>
        </details>
        <div style="margin-top:16px;">${savedScriptsHtml}</div>
    </div>

    <form action="/create" method="GET" class="sp-card" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <input type="text" name="owner" placeholder="Istifadeci adi" required class="sp-inline-input">
        <select name="scriptId" class="sp-inline-select">
            ${scriptOptionsHtml}
        </select>
        <select name="maxUsers" class="sp-inline-select">
            <option value="1" selected>1 nefer (Drop / Tek)</option>
            <option value="2">2 nefer</option>
            <option value="3">3 nefer</option>
            <option value="5">5 nefer</option>
            <option value="10">10 nefer</option>
            <option value="50">50 nefer</option>
        </select>
        <select name="duration" class="sp-inline-select">
            <option value="1h">1 hour</option>
            <option value="5h">5 hours</option>
            <option value="24h">24 hours</option>
            <option value="3d">3 day</option>
            <option value="7d">7 day</option>
            <option value="lifetime" selected>lifetime</option>
        </select>
        <select name="autoRoleId" class="sp-inline-select">
            ${keyRoleOptionsHtml}
        </select>
        <button type="submit" class="sp-btn sp-btn-emerald">+ Yeni Key Yarat</button>
    </form>

    <div class="sp-card">
        <h3 style="margin:0 0 10px 0;color:var(--accent-cyan);font-size:16px;">Whitelist (Ag Siyahi)</h3>
        <form action="/whitelist" method="POST" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
            <input type="text" name="target" placeholder="Discord ID, @mention ve ya HWID" required class="sp-inline-input" style="min-width:220px;">
            <select name="scriptId" class="sp-inline-select">
                ${scriptOptionsHtml}
            </select>
            <button type="submit" class="sp-btn sp-btn-violet">Whitelist Et</button>
        </form>
        ${wlListHtml}
    </div>

    <table class="sp-table">
        <tr class="sp-table-head">
            <th class="sp-th">Acar (Key)</th>
            <th class="sp-th">Sahibi</th>
            <th class="sp-th">Skript</th>
            <th class="sp-th">Limit</th>
            <th class="sp-th">Muddet</th>
            <th class="sp-th">Auto Role</th>
            <th class="sp-th">Emeliyyat</th>
        </tr>
        ${rows}
    </table>
    `}
    `}
  </div>

  <script>
    function dismissIntro() {
      const intro = document.getElementById('spIntro');
      if (!intro) return;
      intro.classList.add('sp-intro-hide');
      try { sessionStorage.setItem('sadoIntroSeen', '1'); } catch (_) {}
      setTimeout(() => {
        if (intro && intro.parentNode) intro.parentNode.removeChild(intro);
      }, 600);
    }
    window.addEventListener('DOMContentLoaded', () => {
      let alreadySeen = false;
      try { alreadySeen = sessionStorage.getItem('sadoIntroSeen') === '1'; } catch (_) {}
      const intro = document.getElementById('spIntro');
      if (alreadySeen && intro) {
        intro.remove();
        return;
      }
      setTimeout(() => {
        dismissIntro();
      }, 1750);
    });
  </script>
</body>
</html>`);
    } catch (err) {
        res.status(500).send("Server xetasi");
    }
});

app.post('/save-bot', async (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        store.discordConfig.enabled = req.body.enabled === "1";
        if (typeof req.body.clientId === "string" && req.body.clientId.trim()) {
            store.discordConfig.clientId = req.body.clientId.trim();
        }
        if (typeof req.body.welcomeChannelId === "string") {
            store.discordConfig.welcomeChannelId = req.body.welcomeChannelId.trim();
        }
        if (typeof req.body.autoRoleId === "string") {
            store.discordConfig.autoRoleId = req.body.autoRoleId.trim();
        }
        saveStoreToDisk();
        await startDiscordBot();
        res.redirect('/?view=panel&tab=discord&msg=bot_saved');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/save-panel-style', (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        const allowedStyles = new Set(["Success", "Primary", "Secondary", "Danger"]);
        const cleanStyle = (val, def) => allowedStyles.has(String(val || "")) ? String(val) : def;

        store.discordConfig.panelEmbedTitle = String(req.body.panelEmbedTitle || "{script} — Control Panel").trim().slice(0, 200);
        store.discordConfig.panelEmbedDesc = String(req.body.panelEmbedDesc || "").trim().slice(0, 2000) || store.discordConfig.panelEmbedDesc;
        const hex = String(req.body.panelEmbedColor || "#7c3aed").trim();
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
            store.discordConfig.panelEmbedColor = hex;
        }

        store.discordConfig.btnRedeemLabel = String(req.body.btnRedeemLabel || "Redeem Key").trim().slice(0, 80);
        store.discordConfig.btnRedeemStyle = cleanStyle(req.body.btnRedeemStyle, "Success");

        store.discordConfig.btnScriptLabel = String(req.body.btnScriptLabel || "Get Script").trim().slice(0, 80);
        store.discordConfig.btnScriptStyle = cleanStyle(req.body.btnScriptStyle, "Primary");

        store.discordConfig.btnHwidLabel = String(req.body.btnHwidLabel || "Reset HWID").trim().slice(0, 80);
        store.discordConfig.btnHwidStyle = cleanStyle(req.body.btnHwidStyle, "Secondary");

        store.discordConfig.btnStatsLabel = String(req.body.btnStatsLabel || "Get Stats").trim().slice(0, 80);
        store.discordConfig.btnStatsStyle = cleanStyle(req.body.btnStatsStyle, "Secondary");

        saveStoreToDisk();
        res.redirect('/?view=panel&tab=discord&msg=panel_style_saved');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/new-script', async (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        const sName = String(req.body.scriptName || "").trim();
        const sCode = typeof req.body.scriptCode === "string" ? req.body.scriptCode : "";
        if (!sName) {
            return res.redirect('/?view=panel');
        }
        store.scripts.push({
            id: makeSlugId(sName),
            name: sName.slice(0, 60),
            code: sCode
        });
        saveStoreToDisk();
        await syncDiscordSlashCommands();
        res.redirect('/?view=panel&msg=script_created');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/edit-script', async (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        const targetId = String(req.body.scriptId || "");
        const sName = String(req.body.scriptName || "").trim();
        const sCode = typeof req.body.scriptCode === "string" ? req.body.scriptCode : "";
        const found = store.scripts.find(s => s.id === targetId);
        if (found && sName) {
            found.name = sName.slice(0, 60);
            found.code = sCode;
            saveStoreToDisk();
            await syncDiscordSlashCommands();
        }
        res.redirect('/?view=panel&msg=script_updated');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/delete-script', async (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        const targetId = String(req.query.id || "").trim();
        if (targetId) {
            store.scripts = store.scripts.filter(s => s.id !== targetId);
            if (store.scripts.length === 0) {
                store.scripts.push({
                    id: "sado-hub",
                    name: "SADO HUB",
                    code: `-- SADO HUB Script\nprint("SADOPROTECT Aktivdir!")`
                });
            }
            const fallbackId = store.scripts[0].id;
            for (const k in store.keys) {
                if (store.keys[k].scriptId === targetId) {
                    store.keys[k].scriptId = fallbackId;
                }
            }
            saveStoreToDisk();
            await syncDiscordSlashCommands();
        }
        res.redirect('/?view=panel&msg=script_deleted');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/save-panel-style', (req, res) => {
    try {
        if (req.body.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const allowedStyles = new Set(["Success", "Primary", "Secondary", "Danger"]);
        const cleanStyle = (val, def) => allowedStyles.has(String(val || "")) ? String(val) : def;

        store.discordConfig.panelEmbedTitle = String(req.body.panelEmbedTitle || "{script} — Control Panel").trim().slice(0, 200);
        store.discordConfig.panelEmbedDesc = String(req.body.panelEmbedDesc || "").trim().slice(0, 2000) || store.discordConfig.panelEmbedDesc;
        const hex = String(req.body.panelEmbedColor || "#7c3aed").trim();
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
            store.discordConfig.panelEmbedColor = hex;
        }

        store.discordConfig.btnRedeemLabel = String(req.body.btnRedeemLabel || "Redeem Key").trim().slice(0, 80);
        store.discordConfig.btnRedeemStyle = cleanStyle(req.body.btnRedeemStyle, "Success");

        store.discordConfig.btnScriptLabel = String(req.body.btnScriptLabel || "Get Script").trim().slice(0, 80);
        store.discordConfig.btnScriptStyle = cleanStyle(req.body.btnScriptStyle, "Primary");

        store.discordConfig.btnHwidLabel = String(req.body.btnHwidLabel || "Reset HWID").trim().slice(0, 80);
        store.discordConfig.btnHwidStyle = cleanStyle(req.body.btnHwidStyle, "Secondary");

        store.discordConfig.btnStatsLabel = String(req.body.btnStatsLabel || "Get Stats").trim().slice(0, 80);
        store.discordConfig.btnStatsStyle = cleanStyle(req.body.btnStatsStyle, "Secondary");

        saveStoreToDisk();
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&tab=discord&msg=panel_style_saved');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/new-script', async (req, res) => {
    try {
        if (req.body.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const sName = String(req.body.scriptName || "").trim();
        const sCode = typeof req.body.scriptCode === "string" ? req.body.scriptCode : "";
        if (!sName) {
            return res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
        }
        store.scripts.push({
            id: makeSlugId(sName),
            name: sName.slice(0, 60),
            code: sCode
        });
        saveStoreToDisk();
        await syncDiscordSlashCommands();
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=script_created');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/edit-script', async (req, res) => {
    try {
        if (req.body.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const targetId = String(req.body.scriptId || "");
        const sName = String(req.body.scriptName || "").trim();
        const sCode = typeof req.body.scriptCode === "string" ? req.body.scriptCode : "";
        const found = store.scripts.find(s => s.id === targetId);
        if (found && sName) {
            found.name = sName.slice(0, 60);
            found.code = sCode;
            saveStoreToDisk();
            await syncDiscordSlashCommands();
        }
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=script_updated');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/delete-script', async (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const targetId = String(req.query.id || "").trim();
        if (targetId) {
            store.scripts = store.scripts.filter(s => s.id !== targetId);
            if (store.scripts.length === 0) {
                store.scripts.push({
                    id: "sado-hub",
                    name: "SADO HUB",
                    code: `-- SADO HUB Script\nprint("SADOPROTECT Aktivdir!")`
                });
            }
            const fallbackId = store.scripts[0].id;
            for (const k in store.keys) {
                if (store.keys[k].scriptId === targetId) {
                    store.keys[k].scriptId = fallbackId;
                }
            }
            saveStoreToDisk();
            await syncDiscordSlashCommands();
        }
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=script_deleted');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/copy', (req, res) => {
    const rawText = String(req.query.text || "");
    const safeJsLiteral = JSON.stringify(rawText);
    const safeHtmlText = escapeHtml(rawText);

    res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADOPROTECT — Kopyala</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      background: #090d16;
      color: #f8fafc;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      box-sizing: border-box;
    }
    .box {
      width: 100%;
      max-width: 560px;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 14px;
      padding: 18px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.45);
      cursor: pointer;
    }
    .status {
      font-size: 14px;
      font-weight: 700;
      color: #34d399;
      margin-bottom: 10px;
    }
    pre {
      margin: 0;
      padding: 14px;
      background: #030712;
      border-radius: 10px;
      color: #38bdf8;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .hint {
      margin-top: 10px;
      font-size: 12px;
      color: #94a3b8;
    }
  </style>
</head>
<body onclick="copyNow()">
  <div class="box" onclick="event.stopPropagation(); copyNow();">
    <div id="status" class="status">Kopyalanır...</div>
    <pre id="codeBlock">${safeHtmlText}</pre>
    <div class="hint">Kodun üstünə və ya ekrana 1 dəfə basmaqla kopyalaya bilərsiniz.</div>
  </div>
  <script>
    const payloadText = ${safeJsLiteral};
    async function copyNow() {
      const statusEl = document.getElementById('status');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(payloadText);
          statusEl.textContent = "Kopyalandı!";
          statusEl.style.color = "#34d399";
          return;
        }
      } catch (_) {}
      try {
        const ta = document.createElement('textarea');
        ta.value = payloadText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        statusEl.textContent = "Kopyalandı!";
        statusEl.style.color = "#34d399";
      } catch (_) {
        statusEl.textContent = "Kopyalamaq üçün kodun üstünə basıb saxlayın";
        statusEl.style.color = "#fbbf24";
      }
    }
    window.addEventListener('DOMContentLoaded', () => {
      copyNow();
    });
  </script>
</body>
</html>`);
});

app.get('/create', (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        createKeyForUser(
            req.query.owner,
            req.query.duration,
            req.query.scriptId,
            req.query.maxUsers,
            req.query.autoRoleId
        );
        res.redirect('/?view=panel');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/reset', (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        const k = req.query.key;
        if (k && store.keys[k]) {
            store.keys[k].users = [];
            saveStoreToDisk();
        }
        res.redirect('/?view=panel');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/delete', (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        const k = req.query.key;
        if (k && store.keys[k]) {
            delete store.keys[k];
            saveStoreToDisk();
        }
        res.redirect('/?view=panel');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/whitelist', (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        addToWhitelist(req.body.target, req.body.scriptId);
        res.redirect('/?view=panel');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/unwhitelist', (req, res) => {
    try {
        if (!isAdminAuthorized(req)) return res.status(403).send("Icase yoxdur!");
        removeFromWhitelist(req.query.id);
        res.redirect('/?view=panel');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/reset', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const k = req.query.key;
        if (k && store.keys[k]) {
            store.keys[k].users = [];
            saveStoreToDisk();
        }
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/delete', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const k = req.query.key;
        if (k && store.keys[k]) {
            delete store.keys[k];
            saveStoreToDisk();
        }
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/whitelist', (req, res) => {
    try {
        if (req.body.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        addToWhitelist(req.body.target, req.body.scriptId);
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/unwhitelist', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        removeFromWhitelist(req.query.id);
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/loader', (req, res) => {
    try {
        purgeExpiredKeys();
        const userKey = String(req.query.key || "").trim();
        const userHwid = String(req.query.hwid || "").trim();
        const userAgent = String(req.headers['user-agent'] || "");

        if (!userAgent.includes("Roblox")) {
            return res.status(403).send("-- SADOPROTECT: Access Denied!");
        }

        const isWlKey = userKey.startsWith("WHITELIST-");
        const wlCandidateId = isWlKey ? userKey.replace(/^WHITELIST-/i, "") : "";
        const matchedWhitelist =
            (isWlKey ? isWhitelistedIdentifier(wlCandidateId) : null) ||
            (userHwid ? isWhitelistedIdentifier(userHwid) : null);

        if (matchedWhitelist) {
            const wlScript = getScriptById(matchedWhitelist.scriptId);
            return res.type('text/plain').send(wlScript.code || `print("SADOPROTECT Whitelist: ${wlScript.name}")`);
        }

        const keyEntry = userKey ? store.keys[userKey] : null;
        if (!keyEntry) {
            return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: Key vaxti bitib ve ya silinib!")');
        }

        if (typeof keyEntry.expiresAt === "number" && keyEntry.expiresAt <= Date.now()) {
            delete store.keys[userKey];
            saveStoreToDisk();
            return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: Key vaxti bitib! Key silindi.")');
        }

        const maxLimit = Math.max(1, parseInt(keyEntry.maxUsers, 10) || 1);
        const matchedUser = userHwid ? keyEntry.users.find(u => u.hwid === userHwid) : null;

        if (!matchedUser) {
            if (!userHwid) {
                return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: HWID tapilmadi!")');
            }

            const unboundDiscordSlot = keyEntry.users.find(u => !u.hwid);
            if (unboundDiscordSlot) {
                unboundDiscordSlot.hwid = userHwid;
                saveStoreToDisk();
            } else if (keyEntry.users.length < maxLimit) {
                keyEntry.users.push({
                    hwid: userHwid,
                    discordUserId: null
                });
                saveStoreToDisk();
            } else {
                return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: Bu key-i basqasi isledib! Limit dolub.")');
            }
        }

        const targetScript = getScriptById(keyEntry.scriptId);
        res.type('text/plain').send(targetScript.code);
    } catch (err) {
        res.status(500).send("-- SADOPROTECT: Server Error");
    }
});

app.get('/ping', (req, res) => {
    res.status(200).send("OK");
});

loadStoreFromDisk();
if (store.discordConfig.enabled) {
    startDiscordBot();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("SADOPROTECT Aktivdir!");

    setInterval(() => {
        const targetUrl = (panelBaseUrl || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
        if (targetUrl) {
            fetch(`${targetUrl}/ping`).catch(() => {});
        }
    }, 9 * 60 * 1000);
});
