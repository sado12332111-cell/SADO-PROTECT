const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= AYARLAR =================
const DATA_FILE = path.join(__dirname, 'sado_protect_data.json');
const DEFAULT_CLIENT_ID = "1562080654282199121";
const EMBEDDED_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || "").trim();
// Loader sorğularının kənar brauzer/scraper tərəfindən kopyalanmasının və key sızmasının qarşısını almaq üçün imzalama açarı
const SIGNING_SECRET = String(process.env.SADO_SIGNING_SECRET || crypto.randomBytes(24).toString('hex')).trim();
let panelBaseUrl = process.env.RENDER_EXTERNAL_URL || "";

// Qısa müddətli loader bilet (nonce/ticket) anbarı: key birbaşa URL-də açıq qalmır və biletlər tez bitir
const loaderTickets = new Map();
const TICKET_TTL_MS = 90 * 1000;

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
        token: "",
        clientId: DEFAULT_CLIENT_ID,
        autoRoleId: "",
        welcomeChannelId: "",
        panelEmbedTitle: "{script} — Control Panel",
        panelEmbedDesc: "This control panel is for the project:\n**{script}**\nIf you're a buyer, click on the buttons below to redeem your key, get the script or reset HWID",
        panelEmbedColor: "#7c3aed",
        btnRedeemLabel: "Redeem Key",
        btnRedeemStyle: "Primary",
        btnScriptLabel: "Get Script",
        btnScriptStyle: "Success",
        btnHwidLabel: "Reset HWID",
        btnHwidStyle: "Secondary",
        btnStatsLabel: "Key Info",
        btnStatsStyle: "Primary"
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

// Açarları tam şəkildə qaytarır (istifadəçi açarları tam görmək istəyir)
function formatFullKeyDisplay(rawKey) {
    return String(rawKey || "").trim();
}

// Key və script üçün qorunan qısa ömürlü loader bileti yaradır
function issueProtectedLoaderTicket({ mode, identifier, scriptId, discordUserId }) {
    const ticketId = crypto.randomBytes(18).toString('hex');
    const expiresAt = Date.now() + TICKET_TTL_MS;
    const signature = crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`${ticketId}:${mode}:${identifier}:${scriptId}:${expiresAt}`)
        .digest('hex');

    loaderTickets.set(ticketId, {
        mode,
        identifier,
        scriptId,
        discordUserId: discordUserId || null,
        expiresAt,
        signature,
        used: false
    });
    return ticketId;
}

function purgeExpiredTickets() {
    const now = Date.now();
    for (const [tid, tData] of loaderTickets.entries()) {
        if (!tData || tData.expiresAt <= now || tData.used) {
            loaderTickets.delete(tid);
        }
    }
}

function getRuntimeBotToken() {
    const cfgToken = String((store.discordConfig && store.discordConfig.token) || "").trim();
    const envToken = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || "").trim();
    return cfgToken || envToken || EMBEDDED_BOT_TOKEN;
}

function isBotCurrentlyOnline() {
    return Boolean(discordClient && discordClient.isReady && discordClient.isReady() && discordClient.user);
}

function isAdminAuthorized() {
    // Admin şifrəsi deaktivdir — birbaşa daxil olma aktivdir
    return true;
}

function saveStoreToDisk() {
    try {
        const safeStore = {
            discordConfig: {
                enabled: Boolean(store.discordConfig.enabled),
                token: String(store.discordConfig.token || "").trim(),
                clientId: String(store.discordConfig.clientId || DEFAULT_CLIENT_ID),
                autoRoleId: String(store.discordConfig.autoRoleId || ""),
                welcomeChannelId: String(store.discordConfig.welcomeChannelId || ""),
                panelEmbedTitle: String(store.discordConfig.panelEmbedTitle || "{script} — Control Panel"),
                panelEmbedDesc: String(store.discordConfig.panelEmbedDesc || ""),
                panelEmbedColor: String(store.discordConfig.panelEmbedColor || "#7c3aed"),
                btnRedeemLabel: String(store.discordConfig.btnRedeemLabel || "Redeem Key"),
                btnRedeemStyle: String(store.discordConfig.btnRedeemStyle || "Success"),
                btnScriptLabel: String(store.discordConfig.btnScriptLabel || "Get Script"),
                btnScriptStyle: String(store.discordConfig.btnScriptStyle || "Primary"),
                btnHwidLabel: String(store.discordConfig.btnHwidLabel || "Reset HWID"),
                btnHwidStyle: String(store.discordConfig.btnHwidStyle || "Secondary"),
                btnStatsLabel: String(store.discordConfig.btnStatsLabel || "Get Stats"),
                btnStatsStyle: String(store.discordConfig.btnStatsStyle || "Secondary")
            },
            scripts: Array.isArray(store.scripts) ? store.scripts : [],
            whitelist: Array.isArray(store.whitelist) ? store.whitelist : [],
            keys: store.keys && typeof store.keys === 'object' ? store.keys : {}
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(safeStore, null, 2), 'utf8');
    } catch (err) {
        console.error("Məlumat fayla yazıla bilmədi:", err.message);
    }
}
function buildLoaderSnippet(keyStr, scriptId = "", discordUserId = null) {
    const base = getBaseUrl();
    const cleanKey = String(keyStr || "").trim();
    const isWl = cleanKey.toUpperCase().startsWith("WHITELIST-");
    const identifier = isWl ? cleanKey.replace(/^WHITELIST-/i, "") : cleanKey;
    const mode = isWl ? "whitelist" : "key";
    const resolvedScriptId = scriptId || (store.keys[cleanKey] && store.keys[cleanKey].scriptId) || getScriptById("").id;

    const ticket = issueProtectedLoaderTicket({
        mode,
        identifier,
        scriptId: resolvedScriptId,
        discordUserId
    });

    return `local hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${base}/loader?ticket=${ticket}&hwid=" .. hwid))()`;
}

function loadStoreFromDisk() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return;
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            if (parsed.discordConfig && typeof parsed.discordConfig === 'object') {
                store.discordConfig.enabled = parsed.discordConfig.enabled !== false;
                if (typeof parsed.discordConfig.token === 'string') {
                    store.discordConfig.token = parsed.discordConfig.token.trim();
                }
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
        if (!client || !client.guilds || !client.guilds.cache) return;
        const rolesMap = new Map();
        for (const [, guild] of client.guilds.cache) {
            try {
                await guild.roles.fetch();
            } catch (_) {
                // Bəzi keşlənmiş rollar fetch olmadan da mövcud ola bilər
            }
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
        if (rolesMap.size > 0) {
            cachedGuildRoles = Array.from(rolesMap.values());
        }
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
    const rawTitle = String(cfg.panelEmbedTitle || "SADOPROTECT Panel");
    const rawDesc = String(
        cfg.panelEmbedDesc ||
        "Welcome to the management panel for **{script}**.\n\nClick the buttons below to redeem a key, reset your HWID, or get your loadscript."
    );

    const finalTitle = rawTitle.replace(/\{script\}/gi, scriptObj.name).slice(0, 256);
    const finalDesc = rawDesc.replace(/\{script\}/gi, scriptObj.name).slice(0, 4000);
    const embedColor = parseHexColorInt(cfg.panelEmbedColor, 0x3b82f6);

    const embed = new EmbedBuilder()
        .setAuthor({ name: "SADOPROTECT" })
        .setColor(embedColor)
        .setTitle(finalTitle)
        .setDescription(finalDesc)
        .setFooter({ text: `${guildName} • SADOPROTECT (${scriptObj.id})` });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sado_btn_redeem:${scriptObj.id}`)
            .setEmoji("🔑")
            .setLabel(String(cfg.btnRedeemLabel || "Redeem Key").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnRedeemStyle, ButtonStyle.Primary)),
        new ButtonBuilder()
            .setCustomId(`sado_btn_hwid:${scriptObj.id}`)
            .setEmoji("🔄")
            .setLabel(String(cfg.btnHwidLabel || "Reset HWID").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnHwidStyle, ButtonStyle.Secondary))
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sado_btn_script:${scriptObj.id}`)
            .setEmoji("📜")
            .setLabel(String(cfg.btnScriptLabel || "Get Script").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnScriptStyle, ButtonStyle.Success)),
        new ButtonBuilder()
            .setCustomId(`sado_btn_stats:${scriptObj.id}`)
            .setEmoji("ℹ️")
            .setLabel(String(cfg.btnStatsLabel || "Key Info").slice(0, 80))
            .setStyle(resolveButtonStyle(cfg.btnStatsStyle, ButtonStyle.Primary))
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
    purgeExpiredTickets();
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

        client.on('roleCreate', async () => {
            await refreshGuildRoles(client);
        });

        client.on('roleUpdate', async () => {
            await refreshGuildRoles(client);
        });

        client.on('roleDelete', async () => {
            await refreshGuildRoles(client);
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
                    return;
                }

                if (interaction.isChatInputCommand()) {
                    if (interaction.commandName === 'whitelist' || interaction.commandName === 'unwhitelist') {
                        await interaction.deferReply({ ephemeral: true }).catch(() => {});
                        const rawUserOption = interaction.options.getString('user');
                        const rawNameOption = interaction.options.getString('name');

                        if (interaction.commandName === 'whitelist') {
                            const chosenScript = rawNameOption
                                ? (store.scripts.find(s => s.id === rawNameOption || s.name.toLowerCase() === rawNameOption.toLowerCase()) || getScriptById(rawNameOption))
                                : getScriptById("");
                            const resAdd = addToWhitelist(rawUserOption, chosenScript.id);
                            if (!resAdd.ok) {
                                await interaction.editReply({ content: `Xeta: ${resAdd.reason}` }).catch(() => {});
                                return;
                            }
                            await interaction.editReply({
                                content: `**${escapeHtml(resAdd.entry.id)}** whitelist-e elave olundu (Skript: **${escapeHtml(chosenScript.name)}**).`
                            }).catch(() => {});
                            return;
                        }

                        if (interaction.commandName === 'unwhitelist') {
                            const removed = removeFromWhitelist(rawUserOption);
                            await interaction.editReply({
                                content: removed
                                    ? `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisindan cixarildi.`
                                    : `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisinda tapilmadi.`
                            }).catch(() => {});
                            return;
                        }
                    }

                    if (interaction.commandName === 'panel') {
                        await interaction.deferReply({ ephemeral: true }).catch(() => {});

                        const actionChoice = String(interaction.options.getString('action') || 'panel').toLowerCase();
                        const rawNameOption = interaction.options.getString('name');
                        const rawUserOption = interaction.options.getString('user');

                        if (actionChoice === 'whitelist') {
                            if (!rawUserOption || !rawUserOption.trim()) {
                                await interaction.editReply({
                                    content: 'Whitelist ucun `user` sahesine Discord ID, mention ve ya HWID daxil edin. Mes: `/panel action:whitelist user:123456789012345678`'
                                }).catch(() => {});
                                return;
                            }
                            const chosenScript = rawNameOption
                                ? (store.scripts.find(s => s.id === rawNameOption || s.name.toLowerCase() === rawNameOption.toLowerCase()) || getScriptById(rawNameOption))
                                : getScriptById("");
                            const resAdd = addToWhitelist(rawUserOption, chosenScript.id);
                            if (!resAdd.ok) {
                                await interaction.editReply({ content: `Xeta: ${resAdd.reason}` }).catch(() => {});
                                return;
                            }
                            await interaction.editReply({
                                content: `**${escapeHtml(resAdd.entry.id)}** whitelist-e elave olundu (Skript: **${escapeHtml(chosenScript.name)}**). Bu istifadeci key ve HWID limiti olmadan skripti islede biler.`
                            }).catch(() => {});
                            return;
                        }

                        if (actionChoice === 'unwhitelist') {
                            if (!rawUserOption || !rawUserOption.trim()) {
                                await interaction.editReply({
                                    content: 'Unwhitelist ucun `user` sahesine cixarilacaq ID/HWID yazin. Mes: `/panel action:unwhitelist user:123456789012345678`'
                                }).catch(() => {});
                                return;
                            }
                            const removed = removeFromWhitelist(rawUserOption);
                            await interaction.editReply({
                                content: removed
                                    ? `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisindan cixarildi.`
                                    : `**${escapeHtml(normalizeWhitelistIdentifier(rawUserOption))}** whitelist siyahisinda tapilmadi.`
                            }).catch(() => {});
                            return;
                        }

                        if (!store.scripts.length) {
                            store.scripts.push({
                                id: "sado-hub",
                                name: "SADO HUB",
                                code: `-- SADO HUB Script\nprint("SADOPROTECT Aktivdir!")`
                            });
                            saveStoreToDisk();
                        }

                        const channel = interaction.channel || (interaction.guild && interaction.channelId ? await interaction.guild.channels.fetch(interaction.channelId).catch(() => null) : null);

                        if (rawNameOption) {
                            const byId = store.scripts.find(s => s.id === rawNameOption);
                            const byName = store.scripts.find(s => s.name.toLowerCase() === rawNameOption.toLowerCase());
                            const partialName = store.scripts.find(s => s.name.toLowerCase().includes(rawNameOption.toLowerCase()));
                            const targetScript = byId || byName || partialName || getScriptById("");

                            if (!channel || typeof channel.send !== 'function') {
                                await interaction.editReply({
                                    content: 'Bu kanalda panel gonderile bilmedi (botun kanal icazelerini yoxlayin).'
                                }).catch(() => {});
                                return;
                            }

                            const panelMsg = buildScriptControlPanelMessage(targetScript, interaction.guild?.name || "SADOPROTECT");
                            await channel.send(panelMsg);
                            await interaction.editReply({
                                content: `**${targetScript.name}** skriptine aid panel kanala gonderildi.`
                            }).catch(() => {});
                            return;
                        }

                        const primaryScript = getScriptById("");
                        if (channel && typeof channel.send === 'function') {
                            await channel.send(buildScriptControlPanelMessage(primaryScript, interaction.guild?.name || "SADOPROTECT"));
                        }
                        const selectorPayload = buildScriptSelectorMessage(interaction.guild?.name || "SADOPROTECT");
                        await interaction.editReply(selectorPayload).catch(() => {});
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
                            ? buildLoaderSnippet(`WHITELIST-${wlEntry.id}`, wlEntry.scriptId || activeScript.id, interaction.user.id)
                            : buildLoaderSnippet(redeemed.key, redeemed.entry.scriptId || activeScript.id, interaction.user.id);
                        const copyLink = buildOneTapCopyUrl(snippet);
                        const copyRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setLabel('Scripti Kopyala (1 Bas)')
                                .setStyle(ButtonStyle.Link)
                                .setURL(copyLink)
                        );

                        const headerLabel = wlEntry
                            ? `SADOPROTECT Qorunan Loader (\`${formatFullKeyDisplay(wlEntry.id)}\`)`
                            : `SADOPROTECT Qorunan Loader (\`${formatFullKeyDisplay(redeemed.key)}\` • ${redeemed.entry.durationLabel || "lifetime"})`;

                        await interaction.editReply({
                            content: `${headerLabel}\n*Qeyd: Bilet 90 saniyə ərzində etibarlıdır.*\n\`\`\`lua\n${snippet}\n\`\`\``,
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
                            content: `HWID sıfırlandı (\`${formatFullKeyDisplay(redeemed.key)}\`)! İndi key-i verdiyiniz şəxs **Redeem Key** edib skripti işlədə bilər.`
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
                            content: `HWID sıfırlandı (\`${maskKeyValue(redeemed.key)}\`)! İndi key-i verdiyiniz şəxs **Redeem Key** edib skripti işlədə bilər.`
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
                            content: `Key ugurla tesdiqlendi (\`${formatFullKeyDisplay(submittedKey)}\`). Indi **Get Script** ve **Reset HWID** duymeleri aktivdir. Muddet: **${entry.durationLabel || "lifetime"}** (${formatRemainingTime(entry)}).${roleNote}`
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
        purgeExpiredTickets();
        if (isBotCurrentlyOnline()) {
            await refreshGuildRoles(discordClient);
        }

        getBaseUrl(req);
        const activeTab = req.query.tab === "discord" ? "discord" : "main";
        const msgType = String(req.query.msg || "");
        let bannerHtml = "";
        if (msgType === "script_created") {
            bannerHtml = `<div class="sp-toast sp-toast-ok">Yeni skript qorunan rejimdə yadda saxlanıldı!</div>`;
        } else if (msgType === "script_updated") {
            bannerHtml = `<div class="sp-toast sp-toast-info">Skript yeniləndi və yadda saxlanıldı!</div>`;
        } else if (msgType === "script_deleted") {
            bannerHtml = `<div class="sp-toast sp-toast-err">Skript silindi!</div>`;
        } else if (msgType === "bot_saved") {
            bannerHtml = `<div class="sp-toast sp-toast-info">Bot ayarları saxlanıldı. Status: <b>${escapeHtml(botConnectionState)}</b></div>`;
        } else if (msgType === "panel_style_saved") {
            bannerHtml = `<div class="sp-toast sp-toast-violet">Discord panel görünüşü və buton ayarları yadda saxlanıldı!</div>`;
        }

        const renderStyleSelect = (fieldName, currentVal) => {
            const opts = [
                { val: "Success", label: "Yaşıl (Success)" },
                { val: "Primary", label: "Mavi (Primary)" },
                { val: "Secondary", label: "Boz (Secondary)" },
                { val: "Danger", label: "Qırmızı (Danger)" }
            ];
            return `<select name="${fieldName}" class="sp-select-mini">
                ${opts.map(o => `<option value="${o.val}" ${currentVal === o.val ? "selected" : ""}>${o.label}</option>`).join("")}
            </select>`;
        };

        const roleOptionsHtml = cachedGuildRoles.map(r =>
            `<option value="${escapeHtml(r.id)}" ${store.discordConfig.autoRoleId === r.id ? "selected" : ""}>@${escapeHtml(r.name)} (${escapeHtml(r.guildName)})</option>`
        ).join("");

        const manualRoleNotInList = store.discordConfig.autoRoleId &&
            !cachedGuildRoles.some(r => r.id === store.discordConfig.autoRoleId);

        const keyRoleOptionsHtml = `<option value="">Default Auto Role</option>` +
            (manualRoleNotInList
                ? `<option value="${escapeHtml(store.discordConfig.autoRoleId)}" selected>Rol ID: ${escapeHtml(store.discordConfig.autoRoleId)}</option>`
                : "") +
            cachedGuildRoles.map(r =>
                `<option value="${escapeHtml(r.id)}">@${escapeHtml(r.name)}</option>`
            ).join("");

        const scriptOptionsHtml = store.scripts.map(sc =>
            `<option value="${escapeHtml(sc.id)}">${escapeHtml(sc.name)}</option>`
        ).join("");

        const savedScriptsHtml = store.scripts.map(sc => `
            <details class="sp-script-card">
                <summary class="sp-script-head">
                    <div class="sp-script-meta">
                        <span class="sp-dot"></span>
                        <b>${escapeHtml(sc.name)}</b>
                        <span class="sp-pill-muted">ID: ${escapeHtml(sc.id)}</span>
                    </div>
                    <a href="/delete-script?id=${encodeURIComponent(sc.id)}" class="sp-link-danger">[Sil]</a>
                </summary>
                <form action="/edit-script" method="POST" class="sp-mt-12">
                    <label class="sp-label">Skriptin adı:</label>
                    <input type="text" name="scriptName" value="${escapeHtml(sc.name)}" required class="sp-input sp-mb-8">
                    <label class="sp-label">Skriptin kodu (yalnız icazəli loader biletinə ötürülür):</label>
                    <textarea name="scriptCode" rows="6" required class="sp-textarea sp-mb-8">${escapeHtml(sc.code)}</textarea>
                    <button type="submit" class="sp-btn sp-btn-blue">Skripti Dəyişdir</button>
                </form>
            </details>
        `).join("");

        let rows = "";
        for (let k in store.keys) {
            const item = store.keys[k];
            const safeKEnc = encodeURIComponent(k);
            const safeOwner = escapeHtml(item.owner);
            const scObj = getScriptById(item.scriptId);
            const safeScriptName = escapeHtml(scObj.name);
            const safeDuration = escapeHtml(item.durationLabel || "lifetime");
            const safeRemaining = escapeHtml(formatRemainingTime(item));
            const maxU = Math.max(1, parseInt(item.maxUsers, 10) || 1);
            const usedU = Array.isArray(item.users) ? item.users.length : 0;
            const roleBadge = item.autoRoleId ? escapeHtml(item.autoRoleId) : "Yoxdur";
            // İstifadəçi açarları tam şəkildə görmək istədiyi üçün maskalanmadan göstərilir
            const fullKeyText = escapeHtml(formatFullKeyDisplay(k));
            const sampleLoader = escapeHtml(buildLoaderSnippet(k, item.scriptId));

            rows += `<tr>
                <td class="sp-td"><code class="sp-key-chip" title="Tam açar">${fullKeyText}</code></td>
                <td class="sp-td">${safeOwner}</td>
                <td class="sp-td">${safeScriptName}</td>
                <td class="sp-td"><span class="sp-badge-count">${usedU}/${maxU}</span></td>
                <td class="sp-td">${safeDuration} <span class="sp-sub-muted">(${safeRemaining})</span></td>
                <td class="sp-td">${roleBadge}</td>
                <td class="sp-td">
                    <a href="/reset?key=${safeKEnc}" class="sp-link-warn">[HWID Sıfırla]</a>
                    <a href="/delete?key=${safeKEnc}" class="sp-link-danger">[Sil]</a>
                </td>
            </tr>
            <tr>
                <td colspan="7" class="sp-loader-cell">
                    <div class="sp-loader-caption">Qorunan Loader (90s Bilet + HWID Lock):</div>
                    <pre class="sp-loader-code">${sampleLoader}</pre>
                </td>
            </tr>`;
        }

        const wlListHtml = store.whitelist.length
            ? store.whitelist.map(w => {
                const sc = getScriptById(w.scriptId);
                return `<div class="sp-wl-row">
                    <div><b>${escapeHtml(formatFullKeyDisplay(w.id))}</b> <span class="sp-sub-muted">(${escapeHtml(sc.name)})</span></div>
                    <a href="/unwhitelist?id=${encodeURIComponent(w.id)}" class="sp-link-danger">[Unwhitelist]</a>
                </div>`;
            }).join("")
            : `<div class="sp-sub-muted">Whitelist siyahısı boşdur.</div>`;

        const totalScripts = store.scripts.length;
        const totalKeys = Object.keys(store.keys).length;
        const totalWhitelist = store.whitelist.length;
        const botOnline = isBotCurrentlyOnline();

        res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SADOPROTECT — Control Dashboard</title>
  <style>
    :root {
      --bg-base: #060913;
      --bg-surface: #0d1324;
      --bg-elevated: #131c34;
      --border-subtle: rgba(148, 163, 184, 0.14);
      --border-accent: rgba(124, 58, 237, 0.42);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --violet: #7c3aed;
      --violet-bright: #a78bfa;
      --cyan: #22d3ee;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(ellipse 70% 45% at 12% 0%, rgba(124, 58, 237, 0.18), transparent 65%),
        radial-gradient(ellipse 60% 40% at 88% 8%, rgba(34, 211, 238, 0.13), transparent 65%),
        var(--bg-base);
      color: var(--text-primary);
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 20px;
    }
    .sp-container {
      max-width: 1060px;
      margin: 0 auto;
    }
    .sp-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      background: rgba(13, 19, 36, 0.88);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 14px 18px;
      margin-bottom: 18px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.4);
    }
    .sp-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
    }
    .sp-brand-mark {
      width: 38px;
      height: 38px;
      border-radius: 11px;
      background: linear-gradient(135deg, var(--violet), var(--cyan));
      display: grid;
      place-items: center;
      font-weight: 900;
      font-size: 16px;
      color: #ffffff;
      box-shadow: 0 8px 20px rgba(124, 58, 237, 0.35);
    }
    .sp-brand-title {
      font-size: 18px;
      font-weight: 900;
      letter-spacing: 0.04em;
      color: #ffffff;
    }
    .sp-brand-sub {
      font-size: 11.5px;
      color: var(--text-secondary);
    }
    .sp-nav {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .sp-nav-btn {
      text-decoration: none;
      padding: 9px 15px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-secondary);
      background: rgba(19, 28, 52, 0.85);
      border: 1px solid var(--border-subtle);
      transition: all 0.16s ease;
    }
    .sp-nav-btn:hover, .sp-nav-btn.active {
      color: #ffffff;
      border-color: var(--border-accent);
      background: linear-gradient(135deg, rgba(124, 58, 237, 0.25), rgba(34, 211, 238, 0.12));
    }
    .sp-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--border-subtle);
      background: rgba(6, 9, 19, 0.75);
    }
    .sp-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${botOnline ? "#10b981" : "#f59e0b"};
      box-shadow: 0 0 10px ${botOnline ? "#10b981" : "#f59e0b"};
    }

    .sp-stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    .sp-stat-card {
      background: rgba(13, 19, 36, 0.85);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      padding: 14px 16px;
    }
    .sp-stat-label {
      font-size: 11.5px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .sp-stat-value {
      font-size: 20px;
      font-weight: 800;
      color: #ffffff;
    }
    .sp-stat-hint {
      font-size: 11.5px;
      color: var(--cyan);
      margin-top: 4px;
    }

    .sp-panel {
      background: rgba(13, 19, 36, 0.88);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 18px 20px;
      margin-bottom: 18px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
    }
    .sp-panel-title {
      margin: 0 0 12px 0;
      font-size: 16px;
      font-weight: 800;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .sp-shield-tag {
      font-size: 11px;
      font-weight: 700;
      color: #6ee7b7;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.35);
      padding: 4px 10px;
      border-radius: 999px;
    }
    .sp-label {
      display: block;
      font-size: 12.5px;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 6px;
    }
    .sp-input, .sp-textarea, .sp-select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: #060913;
      color: #f8fafc;
      font-size: 13.5px;
      transition: border-color 0.15s ease;
    }
    .sp-input:focus, .sp-textarea:focus, .sp-select:focus {
      outline: none;
      border-color: var(--violet-bright);
    }
    .sp-inline-input, .sp-inline-select {
      padding: 9px 12px;
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: #060913;
      color: #f8fafc;
      font-size: 13px;
    }
    .sp-select-mini {
      padding: 9px 10px;
      border-radius: 9px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: #060913;
      color: #f8fafc;
      font-size: 12.5px;
    }
    .sp-textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.5;
    }
    .sp-btn {
      border: none;
      padding: 10px 16px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 13px;
      color: #ffffff;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .sp-btn:hover { transform: translateY(-1px); filter: brightness(1.08); }
    .sp-btn-emerald { background: linear-gradient(135deg, #10b981, #059669); }
    .sp-btn-blue { background: linear-gradient(135deg, #3b82f6, #2563eb); }
    .sp-btn-violet { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }

    .sp-script-card {
      background: rgba(6, 9, 19, 0.72);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    .sp-script-head {
      cursor: pointer;
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .sp-script-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .sp-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cyan);
    }
    .sp-pill-muted {
      font-size: 11.5px;
      color: var(--text-secondary);
      background: rgba(148, 163, 184, 0.1);
      padding: 2px 8px;
      border-radius: 999px;
    }
    .sp-wl-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      background: rgba(6, 9, 19, 0.72);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .sp-table {
      width: 100%;
      border-collapse: collapse;
      background: rgba(13, 19, 36, 0.9);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      overflow: hidden;
      text-align: left;
    }
    .sp-table-head {
      background: rgba(19, 28, 52, 0.96);
      color: var(--cyan);
      font-size: 12.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sp-th, .sp-td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
    }
    .sp-key-chip {
      background: rgba(124, 58, 237, 0.18);
      border: 1px solid rgba(167, 139, 250, 0.35);
      color: #ddd6fe;
      padding: 4px 8px;
      border-radius: 7px;
      font-size: 12px;
      font-weight: 700;
    }
    .sp-badge-count {
      background: rgba(34, 211, 238, 0.12);
      color: var(--cyan);
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }
    .sp-loader-cell {
      padding: 9px 12px 13px 12px;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(6, 9, 19, 0.78);
    }
    .sp-loader-caption {
      font-size: 11.5px;
      color: var(--text-secondary);
      margin-bottom: 5px;
    }
    .sp-loader-code {
      margin: 0;
      padding: 10px 12px;
      background: #03050b;
      border: 1px solid rgba(34, 211, 238, 0.18);
      border-radius: 9px;
      color: var(--cyan);
      font-size: 12px;
      overflow-x: auto;
    }
    .sp-sub-muted { color: var(--text-secondary); font-size: 12px; }
    .sp-link-warn { color: #fbbf24; text-decoration: none; margin-right: 10px; font-weight: 700; }
    .sp-link-danger { color: #fb7185; text-decoration: none; font-weight: 700; }
    .sp-mb-8 { margin-bottom: 8px; }
    .sp-mb-12 { margin-bottom: 12px; }
    .sp-mt-12 { margin-top: 12px; }

    .sp-toast {
      padding: 11px 15px;
      border-radius: 12px;
      margin-bottom: 16px;
      font-size: 13px;
      font-weight: 600;
    }
    .sp-toast-ok { background: rgba(16, 185, 129, 0.16); border: 1px solid rgba(16, 185, 129, 0.4); color: #a7f3d0; }
    .sp-toast-info { background: rgba(59, 130, 246, 0.16); border: 1px solid rgba(59, 130, 246, 0.4); color: #bfdbfe; }
    .sp-toast-err { background: rgba(244, 63, 94, 0.16); border: 1px solid rgba(244, 63, 94, 0.4); color: #fecdd3; }
    .sp-toast-violet { background: rgba(139, 92, 246, 0.18); border: 1px solid rgba(139, 92, 246, 0.45); color: #ddd6fe; }

    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 14px;
    }
    .sp-btn-box {
      background: rgba(6, 9, 19, 0.72);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 11px;
    }
    @media (max-width: 820px) {
      .sp-stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 640px) {
      .sp-stats-grid, .btn-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="sp-container">
    <header class="sp-header">
      <a href="/" class="sp-brand">
        <div class="sp-brand-mark">SP</div>
        <div>
          <div class="sp-brand-title">SADOPROTECT</div>
          <div class="sp-brand-sub">Şifrəsiz Birbaşa Panel • Key &amp; Script Shield</div>
        </div>
      </a>
      <nav class="sp-nav">
        <a href="/?tab=main" class="sp-nav-btn ${activeTab === "main" ? "active" : ""}">Skript &amp; Key Paneli</a>
        <a href="/?tab=discord" class="sp-nav-btn ${activeTab === "discord" ? "active" : ""}">Discord Bot Ayarları</a>
        <span class="sp-status-pill"><span class="sp-status-dot"></span>${escapeHtml(botConnectionState)}</span>
      </nav>
    </header>

    ${bannerHtml}

    <div class="sp-stats-grid">
      <div class="sp-stat-card">
        <div class="sp-stat-label">Qorunan Skriptlər</div>
        <div class="sp-stat-value">${totalScripts}</div>
        <div class="sp-stat-hint">90s Bilet Qoruması Aktiv</div>
      </div>
      <div class="sp-stat-card">
        <div class="sp-stat-label">Aktiv Açarlar (Keys)</div>
        <div class="sp-stat-value">${totalKeys}</div>
        <div class="sp-stat-hint">Tam Açar Görünüşü</div>
      </div>
      <div class="sp-stat-card">
        <div class="sp-stat-label">Whitelist</div>
        <div class="sp-stat-value">${totalWhitelist}</div>
        <div class="sp-stat-hint">HWID / Discord ID</div>
      </div>
      <div class="sp-stat-card">
        <div class="sp-stat-label">Giriş Rejimi</div>
        <div class="sp-stat-value">Birbaşa</div>
        <div class="sp-stat-hint">Admin Şifrəsi Yoxdur</div>
      </div>
    </div>

    ${activeTab === "discord" ? `
    <div class="sp-panel">
      <div class="sp-panel-title">
        <span>Discord Bot Ayarları</span>
        <span class="sp-shield-tag">Token Rejimi</span>
      </div>
      <form action="/save-bot" method="POST">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:13.5px;">
          <input type="checkbox" name="enabled" value="1" ${store.discordConfig.enabled ? "checked" : ""}>
          <span>Discord Botu Aktiv Et</span>
        </label>
        <label class="sp-label">Bot Token:</label>
        <input type="password" name="token" value="${escapeHtml(store.discordConfig.token || "")}" placeholder="Discord Bot Token daxil edin" class="sp-input sp-mb-8">
        <label class="sp-label">Bot Client ID:</label>
        <input type="text" name="clientId" value="${escapeHtml(store.discordConfig.clientId)}" required class="sp-input sp-mb-8">
        <label class="sp-label">Avtomatik Rol (Auto Role):</label>
        <select name="autoRoleId" class="sp-select sp-mb-8">
          <option value="">Rol seçilməyib</option>
          ${manualRoleNotInList ? `<option value="${escapeHtml(store.discordConfig.autoRoleId)}" selected>Seçilmiş Rol ID: ${escapeHtml(store.discordConfig.autoRoleId)}</option>` : ""}
          ${roleOptionsHtml}
        </select>
        <label class="sp-label">Rol ID (əllə daxil etmək üçün):</label>
        <input type="text" name="manualRoleId" value="${escapeHtml(store.discordConfig.autoRoleId)}" placeholder="Məs: 123456789012345678" class="sp-input sp-mb-12">
        <button type="submit" class="sp-btn sp-btn-violet">Bot Ayarlarını Saxla</button>
      </form>
    </div>

    <form action="/save-panel-style" method="POST" class="sp-panel">
      <div class="sp-panel-title">
        <span>Discord Panel Görünüşü &amp; Butonları</span>
        <span class="sp-shield-tag">Key Leak Guard Aktiv</span>
      </div>
      <p class="sp-sub-muted" style="margin-top:0;">Başlıq və açıqlamada <code>{script}</code> dəyişəni seçilən skriptin adı ilə əvəz olunur.</p>

      <label class="sp-label">Panel Başlığı (Title):</label>
      <input type="text" name="panelEmbedTitle" value="${escapeHtml(store.discordConfig.panelEmbedTitle)}" required class="sp-input sp-mb-8">

      <label class="sp-label">Panel Açıqlaması (Description):</label>
      <textarea name="panelEmbedDesc" rows="3" required class="sp-textarea sp-mb-8">${escapeHtml(store.discordConfig.panelEmbedDesc)}</textarea>

      <label class="sp-label">Embed Rəngi:</label>
      <input type="color" name="panelEmbedColor" value="${escapeHtml(store.discordConfig.panelEmbedColor || "#7c3aed")}" style="width:76px;height:38px;padding:2px;border-radius:8px;border:1px solid #334155;background:#060913;cursor:pointer;margin-bottom:14px;">

      <div class="btn-grid">
        <div class="sp-btn-box">
          <label class="sp-label">1-ci Buton (Redeem Key):</label>
          <div style="display:flex;gap:8px;">
            <input type="text" name="btnRedeemLabel" value="${escapeHtml(store.discordConfig.btnRedeemLabel)}" required class="sp-inline-input" style="flex:1;">
            ${renderStyleSelect("btnRedeemStyle", store.discordConfig.btnRedeemStyle)}
          </div>
        </div>
        <div class="sp-btn-box">
          <label class="sp-label">2-ci Buton (Get Script):</label>
          <div style="display:flex;gap:8px;">
            <input type="text" name="btnScriptLabel" value="${escapeHtml(store.discordConfig.btnScriptLabel)}" required class="sp-inline-input" style="flex:1;">
            ${renderStyleSelect("btnScriptStyle", store.discordConfig.btnScriptStyle)}
          </div>
        </div>
        <div class="sp-btn-box">
          <label class="sp-label">3-cü Buton (Reset HWID):</label>
          <div style="display:flex;gap:8px;">
            <input type="text" name="btnHwidLabel" value="${escapeHtml(store.discordConfig.btnHwidLabel)}" required class="sp-inline-input" style="flex:1;">
            ${renderStyleSelect("btnHwidStyle", store.discordConfig.btnHwidStyle)}
          </div>
        </div>
        <div class="sp-btn-box">
          <label class="sp-label">4-cü Buton (Get Stats):</label>
          <div style="display:flex;gap:8px;">
            <input type="text" name="btnStatsLabel" value="${escapeHtml(store.discordConfig.btnStatsLabel)}" required class="sp-inline-input" style="flex:1;">
            ${renderStyleSelect("btnStatsStyle", store.discordConfig.btnStatsStyle)}
          </div>
        </div>
      </div>

      <button type="submit" class="sp-btn sp-btn-emerald">Panel Ayarlarını Saxla</button>
    </form>
    ` : `
    <div class="sp-panel">
      <div class="sp-panel-title">
        <span>Skript İdarəetməsi</span>
        <span class="sp-shield-tag">Anti-Leak Loader</span>
      </div>
      <details open>
        <summary style="cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#0284c7,#0369a1);color:white;padding:9px 15px;border-radius:10px;font-weight:700;font-size:13px;">
          <span>+ NEW SCRIPTS</span>
        </summary>
        <form action="/new-script" method="POST" class="sp-mt-12">
          <label class="sp-label">Skriptin adı:</label>
          <input type="text" name="scriptName" placeholder="Məs: SADO DUEL" required class="sp-input sp-mb-8">
          <label class="sp-label">Skriptin kodu:</label>
          <textarea name="scriptCode" rows="6" placeholder="Lua skript kodunu yazın..." required class="sp-textarea sp-mb-8"></textarea>
          <button type="submit" class="sp-btn sp-btn-emerald">Yadda Saxla</button>
        </form>
      </details>
      <div class="sp-mt-12">${savedScriptsHtml}</div>
    </div>

    <form action="/create" method="GET" class="sp-panel" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
      <input type="text" name="owner" placeholder="İstifadəçi adı" required class="sp-inline-input">
      <select name="scriptId" class="sp-inline-select">
        ${scriptOptionsHtml}
      </select>
      <select name="maxUsers" class="sp-inline-select">
        <option value="1" selected>1 nəfər (Tek HWID)</option>
        <option value="2">2 nəfər</option>
        <option value="3">3 nəfər</option>
        <option value="5">5 nəfər</option>
        <option value="10">10 nəfər</option>
        <option value="50">50 nəfər</option>
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

    <div class="sp-panel">
      <div class="sp-panel-title">
        <span>Whitelist (Ağ Siyahı)</span>
        <span class="sp-shield-tag">HWID / Discord Guard</span>
      </div>
      <form action="/whitelist" method="POST" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
        <input type="text" name="target" placeholder="Discord ID, @mention və ya HWID" required class="sp-inline-input" style="min-width:220px;">
        <select name="scriptId" class="sp-inline-select">
          ${scriptOptionsHtml}
        </select>
        <button type="submit" class="sp-btn sp-btn-violet">Whitelist Et</button>
      </form>
      ${wlListHtml}
    </div>

    <table class="sp-table">
      <tr class="sp-table-head">
        <th class="sp-th">Açar (Tam)</th>
        <th class="sp-th">Sahibi</th>
        <th class="sp-th">Skript</th>
        <th class="sp-th">Limit</th>
        <th class="sp-th">Müddət</th>
        <th class="sp-th">Auto Role</th>
        <th class="sp-th">Əməliyyat</th>
      </tr>
      ${rows}
    </table>
    `}
  </div>
</body>
</html>`);
    } catch (err) {
        res.status(500).send("Server xətası");
    }
});

app.post('/save-bot', async (req, res) => {
    try {
        store.discordConfig.enabled = req.body.enabled === "1";
        if (typeof req.body.token === "string") {
            store.discordConfig.token = req.body.token.trim();
        }
        if (typeof req.body.clientId === "string" && req.body.clientId.trim()) {
            store.discordConfig.clientId = req.body.clientId.trim();
        }
        const manualRole = typeof req.body.manualRoleId === "string" ? req.body.manualRoleId.trim() : "";
        const selectedRole = typeof req.body.autoRoleId === "string" ? req.body.autoRoleId.trim() : "";
        const finalRole = manualRole || selectedRole;
        store.discordConfig.autoRoleId = /^\d+$/.test(finalRole) ? finalRole : "";
        saveStoreToDisk();
        await startDiscordBot();
        if (isBotCurrentlyOnline()) {
            await refreshGuildRoles(discordClient);
        }
        res.redirect('/?tab=discord&msg=bot_saved');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.post('/save-panel-style', (req, res) => {
    try {
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
        res.redirect('/?tab=discord&msg=panel_style_saved');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.post('/new-script', async (req, res) => {
    try {
        const sName = String(req.body.scriptName || "").trim();
        const sCode = typeof req.body.scriptCode === "string" ? req.body.scriptCode : "";
        if (!sName) {
            return res.redirect('/');
        }
        store.scripts.push({
            id: makeSlugId(sName),
            name: sName.slice(0, 60),
            code: sCode
        });
        saveStoreToDisk();
        await syncDiscordSlashCommands();
        res.redirect('/?msg=script_created');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.post('/edit-script', async (req, res) => {
    try {
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
        res.redirect('/?msg=script_updated');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.get('/delete-script', async (req, res) => {
    try {
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
        res.redirect('/?msg=script_deleted');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
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
        res.redirect('/?msg=script_updated');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
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
        res.redirect('/?msg=script_deleted');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
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
        createKeyForUser(
            req.query.owner,
            req.query.duration,
            req.query.scriptId,
            req.query.maxUsers,
            req.query.autoRoleId
        );
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.get('/reset', (req, res) => {
    try {
        const k = req.query.key;
        if (k && store.keys[k]) {
            store.keys[k].users = [];
            saveStoreToDisk();
        }
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.get('/delete', (req, res) => {
    try {
        const k = req.query.key;
        if (k && store.keys[k]) {
            delete store.keys[k];
            saveStoreToDisk();
        }
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.post('/whitelist', (req, res) => {
    try {
        addToWhitelist(req.body.target, req.body.scriptId);
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.get('/unwhitelist', (req, res) => {
    try {
        removeFromWhitelist(req.query.id);
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Xəta baş verdi");
    }
});

app.get('/loader', (req, res) => {
    try {
        purgeExpiredKeys();
        purgeExpiredTickets();

        const ticketId = String(req.query.ticket || "").trim();
        const userHwid = String(req.query.hwid || "").trim();
        const userAgent = String(req.headers['user-agent'] || "");

        // Yalnız Roblox sorğularına icazə verilir; brauzer/curl/scraper sorğularında heç bir key və ya kod sızdırılmır
        if (!userAgent.includes("Roblox")) {
            return res.status(403).type('text/plain').send('-- SADOPROTECT: Access Denied!');
        }

        if (!ticketId || !loaderTickets.has(ticketId)) {
            return res.status(401).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Etibarsiz veya vaxti bitmis loader bileti!")');
        }

        const ticketData = loaderTickets.get(ticketId);
        const expectedSig = crypto
            .createHmac('sha256', SIGNING_SECRET)
            .update(`${ticketId}:${ticketData.mode}:${ticketData.identifier}:${ticketData.scriptId}:${ticketData.expiresAt}`)
            .digest('hex');

        const sigBuf = Buffer.from(ticketData.signature || "", "utf8");
        const expBuf = Buffer.from(expectedSig, "utf8");
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            loaderTickets.delete(ticketId);
            return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Imza dogrulanmadi!")');
        }

        if (ticketData.used || ticketData.expiresAt <= Date.now()) {
            loaderTickets.delete(ticketId);
            return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Loader biletinin vaxti bitib! Yeniden Get Script basin.")');
        }

        // Bilet bir dəfə istifadə olunur ki, link başqasına ötürülsə belə təkrar kod sızdırmasın
        ticketData.used = true;
        loaderTickets.delete(ticketId);

        if (ticketData.mode === "whitelist") {
            const matchedWhitelist =
                isWhitelistedIdentifier(ticketData.identifier) ||
                (userHwid ? isWhitelistedIdentifier(userHwid) : null);

            if (!matchedWhitelist) {
                return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Whitelist tapilmadi!")');
            }
            const wlScript = getScriptById(matchedWhitelist.scriptId || ticketData.scriptId);
            return res.type('text/plain').send(wlScript.code || `print("SADOPROTECT Whitelist: ${wlScript.name}")`);
        }

        const userKey = String(ticketData.identifier || "").trim();
        const keyEntry = userKey ? store.keys[userKey] : null;
        if (!keyEntry) {
            return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Key vaxti bitib ve ya silinib!")');
        }

        if (typeof keyEntry.expiresAt === "number" && keyEntry.expiresAt <= Date.now()) {
            delete store.keys[userKey];
            saveStoreToDisk();
            return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Key vaxti bitib! Key silindi.")');
        }

        if (!userHwid || userHwid.length < 6) {
            return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: HWID tapilmadi!")');
        }

        const maxLimit = Math.max(1, parseInt(keyEntry.maxUsers, 10) || 1);
        const matchedUser = keyEntry.users.find(u => u.hwid === userHwid);

        if (!matchedUser) {
            const unboundDiscordSlot = keyEntry.users.find(u => !u.hwid);
            if (unboundDiscordSlot) {
                unboundDiscordSlot.hwid = userHwid;
                saveStoreToDisk();
            } else if (keyEntry.users.length < maxLimit) {
                keyEntry.users.push({
                    hwid: userHwid,
                    discordUserId: ticketData.discordUserId || null
                });
                saveStoreToDisk();
            } else {
                return res.status(403).type('text/plain').send('game.Players.LocalPlayer:Kick("SADOPROTECT: Bu key-i basqasi isledib! Limit dolub.")');
            }
        }

        const targetScript = getScriptById(keyEntry.scriptId || ticketData.scriptId);
        res.type('text/plain').send(targetScript.code);
    } catch (err) {
        res.status(500).type('text/plain').send('-- SADOPROTECT: Server Error');
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
