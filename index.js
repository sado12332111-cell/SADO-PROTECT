const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
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
    MessageFlags
} = require('discord.js');

// ================= SABİT YADDAŞ (PERSISTENT STORAGE + AUTO-SNAPSHOT) =================
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
const STORE_FILE = path.join(DATA_DIR, 'sado_protect_data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'sado_protect_data.bak.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'sado_protect_snapshot.json');

const DEFAULT_PANEL_CONFIG = {
    title: '{script} — Control Panel',
    description: "This control panel is for the project:\n**{script}**\nIf you're a buyer, click on the buttons below to redeem your key, get the script or reset HWID",
    color: '#00FF00',
    buttons: {
        redeem: { label: 'Redeem Key', emoji: '', style: 'Primary', order: 1 },
        getScript: { label: 'Get Script', emoji: '', style: 'Success', order: 2 },
        resetHwid: { label: 'Reset HWID', emoji: '', style: 'Danger', order: 3 },
        getStats: { label: 'Get Stats', emoji: '', style: 'Primary', order: 4 }
    }
};

function slugifyScriptId(name) {
    const s = String(name || 'script')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return s || 'sado-hub';
}

function defaultStore() {
    const envScriptCode = String(process.env.DEFAULT_SCRIPT_CODE || '').trim();
    const envScriptName = String(process.env.DEFAULT_SCRIPT_NAME || 'SADO HUB').trim();
    const initialScripts = {};

    if (envScriptCode) {
        const sid = slugifyScriptId(envScriptName);
        initialScripts[sid] = {
            id: sid,
            name: envScriptName,
            code: envScriptCode,
            roleId: String(process.env.DISCORD_ROLE_ID || '').trim(),
            fileName: `${sid}.lua`,
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
    }

    return {
        botToken: String(process.env.DISCORD_BOT_TOKEN || '').trim(),
        guildId: String(process.env.DISCORD_GUILD_ID || '').trim(),
        roleId: String(process.env.DISCORD_ROLE_ID || '').trim(),
        adminKey: String(process.env.ADMIN_KEY || 'sado123').trim(),
        scripts: initialScripts,
        keys: {},
        whitelist: {},
        panels: {},
        tickets: {},
        panelConfig: JSON.parse(JSON.stringify(DEFAULT_PANEL_CONFIG))
    };
}

function mergeObjectsPreserve(primaryObj, secondaryObj) {
    const out = {};
    if (secondaryObj && typeof secondaryObj === 'object') {
        for (const [k, v] of Object.entries(secondaryObj)) {
            if (v && typeof v === 'object') out[k] = { ...v };
        }
    }
    if (primaryObj && typeof primaryObj === 'object') {
        for (const [k, v] of Object.entries(primaryObj)) {
            if (v && typeof v === 'object') {
                out[k] = out[k] ? { ...out[k], ...v } : { ...v };
            }
        }
    }
    return out;
}

function normalizeStore(raw, fallbackRaw = null) {
    const base = defaultStore();
    const a = raw && typeof raw === 'object' ? raw : {};
    const b = fallbackRaw && typeof fallbackRaw === 'object' ? fallbackRaw : {};

    const savedToken = String(a.botToken || b.botToken || '').trim();
    const envToken = String(process.env.DISCORD_BOT_TOKEN || '').trim();
    base.botToken = savedToken || envToken;

    base.guildId = String(a.guildId || b.guildId || base.guildId || '').trim();
    base.roleId = String(a.roleId || b.roleId || base.roleId || '').trim();
    base.adminKey = String(a.adminKey || b.adminKey || base.adminKey || 'sado123').trim();

    const mergedScripts = mergeObjectsPreserve(a.scripts, b.scripts);
    base.scripts = Object.keys(mergedScripts).length > 0 ? mergedScripts : base.scripts;
    base.keys = mergeObjectsPreserve(a.keys, b.keys);
    base.whitelist = mergeObjectsPreserve(a.whitelist, b.whitelist);
    base.panels = mergeObjectsPreserve(a.panels, b.panels);
    base.tickets = mergeObjectsPreserve(a.tickets, b.tickets);

    if (Object.keys(base.scripts).length === 0 && store && store.scripts && Object.keys(store.scripts).length > 0) {
        base.scripts = mergeObjectsPreserve(base.scripts, store.scripts);
    }
    if (Object.keys(base.keys).length === 0 && store && store.keys && Object.keys(store.keys).length > 0) {
        base.keys = mergeObjectsPreserve(base.keys, store.keys);
    }
    if (Object.keys(base.whitelist).length === 0 && store && store.whitelist && Object.keys(store.whitelist).length > 0) {
        base.whitelist = mergeObjectsPreserve(base.whitelist, store.whitelist);
    }

    const cfgSource = (a.panelConfig && typeof a.panelConfig === 'object' && Object.keys(a.panelConfig).length > 0)
        ? a.panelConfig
        : (b.panelConfig && typeof b.panelConfig === 'object' ? b.panelConfig : {});

    base.panelConfig = {
        title: typeof cfgSource.title === 'string' && cfgSource.title.trim() ? cfgSource.title : DEFAULT_PANEL_CONFIG.title,
        description: typeof cfgSource.description === 'string' && cfgSource.description.trim() ? cfgSource.description : DEFAULT_PANEL_CONFIG.description,
        color: typeof cfgSource.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(cfgSource.color.trim()) ? cfgSource.color.trim() : DEFAULT_PANEL_CONFIG.color,
        buttons: {
            redeem: { ...DEFAULT_PANEL_CONFIG.buttons.redeem, ...(cfgSource.buttons && cfgSource.buttons.redeem ? cfgSource.buttons.redeem : {}) },
            getScript: { ...DEFAULT_PANEL_CONFIG.buttons.getScript, ...(cfgSource.buttons && cfgSource.buttons.getScript ? cfgSource.buttons.getScript : {}) },
            resetHwid: { ...DEFAULT_PANEL_CONFIG.buttons.resetHwid, ...(cfgSource.buttons && cfgSource.buttons.resetHwid ? cfgSource.buttons.resetHwid : {}) },
            getStats: { ...DEFAULT_PANEL_CONFIG.buttons.getStats, ...(cfgSource.buttons && cfgSource.buttons.getStats ? cfgSource.buttons.getStats : {}) }
        }
    };
    return base;
}

function readJsonSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const txt = fs.readFileSync(filePath, 'utf8');
            if (txt && txt.trim()) {
                return JSON.parse(txt);
            }
        }
    } catch (err) {
        console.error(`Fayl oxuma xətası (${filePath}):`, err.message);
    }
    return null;
}

function loadStoreFromDisk() {
    const primary = readJsonSafe(STORE_FILE);
    const backup = readJsonSafe(BACKUP_FILE);
    const snapshot = readJsonSafe(SNAPSHOT_FILE);

    const mainData = primary || backup || snapshot;
    const secondaryData = backup || snapshot || primary;

    if (!mainData && !secondaryData) {
        return defaultStore();
    }
    return normalizeStore(mainData, secondaryData);
}

let store = loadStoreFromDisk();

function saveStoreToDisk() {
    try {
        const existingPrimary = readJsonSafe(STORE_FILE) || {};
        const safeStore = {
            ...store,
            scripts: mergeObjectsPreserve(store.scripts, existingPrimary.scripts),
            keys: mergeObjectsPreserve(store.keys, existingPrimary.keys),
            whitelist: mergeObjectsPreserve(store.whitelist, existingPrimary.whitelist)
        };
        for (const k of Object.keys(existingPrimary.scripts || {})) {
            if (!(k in (store.scripts || {})) && store._explicitDeletedScripts && store._explicitDeletedScripts.includes(k)) {
                delete safeStore.scripts[k];
            }
        }
        for (const k of Object.keys(existingPrimary.keys || {})) {
            if (!(k in (store.keys || {})) && store._explicitDeletedKeys && store._explicitDeletedKeys.includes(k)) {
                delete safeStore.keys[k];
            }
        }
        for (const k of Object.keys(existingPrimary.whitelist || {})) {
            if (!(k in (store.whitelist || {})) && store._explicitDeletedWhitelist && store._explicitDeletedWhitelist.includes(k)) {
                delete safeStore.whitelist[k];
            }
        }

        const toWrite = { ...safeStore };
        delete toWrite._explicitDeletedScripts;
        delete toWrite._explicitDeletedKeys;
        delete toWrite._explicitDeletedWhitelist;

        const json = JSON.stringify(toWrite, null, 2);
        const tmpFile = `${STORE_FILE}.tmp`;
        fs.writeFileSync(tmpFile, json, 'utf8');
        fs.renameSync(tmpFile, STORE_FILE);
        fs.writeFileSync(BACKUP_FILE, json, 'utf8');
        fs.writeFileSync(SNAPSHOT_FILE, json, 'utf8');
    } catch (err) {
        console.error('Məlumat saxlama xətası:', err.message);
    }
}

saveStoreToDisk();

// ================= VAXT VƏ KÖMƏKÇİ FUNKSİYALAR =================
const DURATION_OPTIONS = {
    'lifetime': 0,
    '7 day': 7 * 24 * 60 * 60 * 1000,
    '5 day': 5 * 24 * 60 * 60 * 1000,
    '3 day': 3 * 24 * 60 * 60 * 1000,
    '24 hour': 24 * 60 * 60 * 1000,
    '5 hour': 5 * 60 * 60 * 1000,
    '1 hour': 60 * 60 * 1000
};

function parseDurationLabelToExpiresAt(label) {
    const clean = String(label || 'lifetime').trim().toLowerCase();
    if (clean === 'lifetime' || clean === '0') return null;
    const ms = DURATION_OPTIONS[clean];
    if (typeof ms === 'number' && ms > 0) {
        return Date.now() + ms;
    }
    return null;
}

function isExpired(expiresAt) {
    if (!expiresAt) return false;
    return Date.now() > Number(expiresAt);
}

function generateLicenseKey() {
    return 'SADO-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function parseHexColor(hex) {
    const clean = String(hex || '#00FF00').replace('#', '');
    const num = parseInt(clean, 16);
    return Number.isNaN(num) ? 0x00FF00 : num;
}

function mapButtonStyle(styleName) {
    switch (String(styleName || 'Primary')) {
        case 'Success': return ButtonStyle.Success;
        case 'Danger': return ButtonStyle.Danger;
        case 'Secondary': return ButtonStyle.Secondary;
        default: return ButtonStyle.Primary;
    }
}

function buildPanelEmbed(scriptObj) {
    const cfg = store.panelConfig || DEFAULT_PANEL_CONFIG;
    const title = String(cfg.title || '{script} — Control Panel').replace(/\{script\}/gi, scriptObj.name);
    const description = String(cfg.description || '').replace(/\{script\}/gi, scriptObj.name);

    return new EmbedBuilder()
        .setAuthor({ name: 'SADOPROTECT' })
        .setTitle(title)
        .setDescription(description)
        .setColor(parseHexColor(cfg.color))
        .setFooter({ text: `${scriptObj.name} • SADOPROTECT (${scriptObj.id}) • v${scriptObj.version || 1}` });
}

function buildPanelRows(scriptId) {
    const cfg = store.panelConfig || DEFAULT_PANEL_CONFIG;
    const btns = cfg.buttons || DEFAULT_PANEL_CONFIG.buttons;

    const items = [
        { key: 'redeem', customId: `sp:redeem:${scriptId}`, ...btns.redeem },
        { key: 'getScript', customId: `sp:getscript:${scriptId}`, ...btns.getScript },
        { key: 'resetHwid', customId: `sp:resethwid:${scriptId}`, ...btns.resetHwid },
        { key: 'getStats', customId: `sp:getstats:${scriptId}`, ...btns.getStats }
    ];

    items.sort((a, b) => (Number(a.order) || 99) - (Number(b.order) || 99));

    const discordButtons = items.map(item => {
        const btn = new ButtonBuilder()
            .setCustomId(item.customId)
            .setLabel(String(item.label || item.key).slice(0, 80))
            .setStyle(mapButtonStyle(item.style));
        const em = String(item.emoji || '').trim();
        if (em) {
            try { btn.setEmoji(em); } catch (_) {}
        }
        return btn;
    });

    const row1 = new ActionRowBuilder().addComponents(discordButtons.slice(0, 2));
    const row2 = new ActionRowBuilder().addComponents(discordButtons.slice(2, 4));
    return [row1, row2];
}

// ================= DISCORD BOT İDARƏETMƏSİ =================
let discordClient = null;
let botStatus = { online: false, tag: '', error: '' };

function getSlashCommands() {
    const timeChoices = [
        { name: 'lifetime', value: 'lifetime' },
        { name: '7 day', value: '7 day' },
        { name: '5 day', value: '5 day' },
        { name: '3 day', value: '3 day' },
        { name: '24 hour', value: '24 hour' },
        { name: '5 hour', value: '5 hour' },
        { name: '1 hour', value: '1 hour' }
    ];

    const panelCmd = new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Skript idarəetmə panelini bu kanala göndərir');

    const whitelistCmd = new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('İstifadəçiyə birbaşa whitelist verir')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Whitelist veriləcək Discord istifadəçisi')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('time')
                .setDescription('Whitelist müddəti')
                .setRequired(true)
                .addChoices(...timeChoices)
        )
        .addStringOption(opt =>
            opt.setName('script')
                .setDescription('Hansı skript üçün (boş buraxsanız ilk skript)')
                .setRequired(false)
                .setAutocomplete(true)
        );

    const unwhitelistCmd = new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('İstifadəçinin whitelist-ini silir')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Silinəcək istifadəçi')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('script')
                .setDescription('Hansı skriptdən (boş buraxsanız hamısından)')
                .setRequired(false)
                .setAutocomplete(true)
        );

    return [panelCmd.toJSON(), whitelistCmd.toJSON(), unwhitelistCmd.toJSON()];
}

async function assignRoleToUser(guild, userId, roleId) {
    if (!guild || !userId || !roleId) return;
    try {
        const member = await guild.members.fetch(String(userId));
        if (member && !member.roles.cache.has(String(roleId))) {
            await member.roles.add(String(roleId));
        }
    } catch (err) {
        console.error('Rol vermə xətası:', err.message);
    }
}

async function syncAllDiscordPanels(targetScriptId = null) {
    if (!discordClient || !botStatus.online) return { updated: 0 };
    let updated = 0;

    for (const [panelKey, panelInfo] of Object.entries(store.panels)) {
        if (targetScriptId && panelInfo.scriptId !== targetScriptId) continue;
        const scriptObj = store.scripts[panelInfo.scriptId];
        if (!scriptObj) continue;

        try {
            const channel = await discordClient.channels.fetch(String(panelInfo.channelId));
            if (!channel || !channel.isTextBased()) continue;
            const msg = await channel.messages.fetch(String(panelInfo.messageId));
            if (!msg) continue;

            await msg.edit({
                embeds: [buildPanelEmbed(scriptObj)],
                components: buildPanelRows(scriptObj.id)
            });
            panelInfo.updatedAt = Date.now();
            updated++;
        } catch (err) {
            console.warn(`Panel auto-sync xətası (${panelKey}):`, err.message);
        }
    }

    if (updated > 0) saveStoreToDisk();
    return { updated };
}

function findScript(query, guildId = '') {
    const gFilter = normalizeGuildId(guildId);
    const pool = Object.values(store.scripts).filter(s => !gFilter || normalizeGuildId(s.guildId) === gFilter);
    const all = pool.length > 0 ? pool : Object.values(store.scripts);
    if (all.length === 0) return null;
    if (!query || !String(query).trim()) return all[0];
    const q = String(query).trim().toLowerCase();
    return all.find(s =>
        String(s.id || '').toLowerCase() === q ||
        String(s.name || '').toLowerCase() === q ||
        String(s.name || '').toLowerCase().includes(q) ||
        String(s.id || '').toLowerCase().includes(q)
    ) || all[0];
}

function checkUserAccess(userId, scriptId) {
    const uid = String(userId);
    const wlKey = `${scriptId}:${uid}`;
    const wl = store.whitelist[wlKey];
    if (wl && !isExpired(wl.expiresAt)) {
        return { allowed: true, source: 'whitelist', record: wl, wlKey };
    }
    const foundKey = Object.values(store.keys).find(
        k => k.scriptId === scriptId && String(k.redeemedBy) === uid && !k.revoked && !isExpired(k.expiresAt)
    );
    if (foundKey) {
        return { allowed: true, source: 'key', record: foundKey };
    }
    return { allowed: false };
}

async function restartDiscordBot(newToken) {
    const token = String(newToken !== undefined ? newToken : store.botToken || '').trim();
    if (newToken !== undefined) {
        store.botToken = token;
        saveStoreToDisk();
    }

    if (discordClient) {
        try { await discordClient.destroy(); } catch (_) {}
        discordClient = null;
    }

    botStatus = { online: false, tag: '', error: '' };
    if (!token) {
        botStatus.error = 'Token daxil edilməyib';
        return botStatus;
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });

    client.once('ready', async () => {
        botStatus = { online: true, tag: client.user.tag, error: '' };
        console.log(`SADO PROTECT Bot onlayndır: ${client.user.tag}`);
        try {
            const rest = new REST({ version: '10' }).setToken(token);
            const cmds = getSlashCommands();
            await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
            for (const g of client.guilds.cache.values()) {
                await rest.put(Routes.applicationGuildCommands(client.user.id, g.id), { body: cmds }).catch(() => {});
            }
        } catch (err) {
            console.error('Slash əmr sinxronizasiya xətası:', err.message);
        }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.isAutocomplete()) {
                const focused = interaction.options.getFocused(true);
                if (focused && focused.name === 'script') {
                    const q = String(focused.value || '').trim().toLowerCase();
                    const gFilter = normalizeGuildId(interaction.guildId || '');
                    const guildScripts = Object.values(store.scripts || {}).filter(
                        s => !gFilter || normalizeGuildId(s.guildId) === gFilter
                    );
                    const sourceList = guildScripts.length > 0 ? guildScripts : Object.values(store.scripts || {});
                    const filtered = sourceList.filter(s =>
                        !q ||
                        String(s.name || '').toLowerCase().includes(q) ||
                        String(s.id || '').toLowerCase().includes(q)
                    );
                    const finalList = (filtered.length > 0 ? filtered : sourceList).slice(0, 25).map(s => ({
                        name: `${s.name || s.id} (v${s.version || 1}) — ${s.id}`.slice(0, 100),
                        value: String(s.id)
                    }));
                    await interaction.respond(finalList).catch(() => {});
                }
                return;
            }

            if (interaction.isChatInputCommand()) {
                const cmd = interaction.commandName;

                if (cmd === 'panel') {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

                    let scriptObj = findScript('', interaction.guildId || '');
                    if (!scriptObj) {
                        const fallbackId = 'sado-hub';
                        scriptObj = {
                            id: fallbackId,
                            guildId: normalizeGuildId(interaction.guildId || ''),
                            name: 'SADO HUB',
                            code: 'print("SADO PROTECT Aktivdir!")',
                            roleId: store.roleId || '',
                            fileName: 'sado-hub.lua',
                            version: 1,
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        };
                        store.scripts[fallbackId] = scriptObj;
                        saveStoreToDisk();
                    }

                    const sent = await interaction.channel.send({
                        embeds: [buildPanelEmbed(scriptObj)],
                        components: buildPanelRows(scriptObj.id)
                    });

                    const pKey = `${interaction.guildId || 'dm'}:${interaction.channelId}:${scriptObj.id}`;
                    store.panels[pKey] = {
                        guildId: interaction.guildId || '',
                        channelId: interaction.channelId,
                        messageId: sent.id,
                        scriptId: scriptObj.id,
                        updatedAt: Date.now()
                    };
                    saveStoreToDisk();

                    await interaction.editReply({
                        content: `**${scriptObj.name}** paneli kanala göndərildi (skript update olanda avtomatik yenilənəcək).`
                    }).catch(() => {});
                    return;
                }

                if (cmd === 'whitelist') {
                    const targetUser = interaction.options.getUser('user', true);
                    const timeLabel = interaction.options.getString('time', true);
                    const scriptQuery = interaction.options.getString('script');
                    const scriptObj = findScript(scriptQuery, interaction.guildId || '');

                    if (!scriptObj) {
                        await interaction.reply({ content: 'Skript tapılmadı!', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    const expiresAt = parseDurationLabelToExpiresAt(timeLabel);
                    const wlKey = `${scriptObj.id}:${targetUser.id}`;
                    const existing = store.whitelist[wlKey];

                    store.whitelist[wlKey] = {
                        guildId: normalizeGuildId(interaction.guildId || scriptObj.guildId || ''),
                        scriptId: scriptObj.id,
                        userId: targetUser.id,
                        username: targetUser.username,
                        displayName: targetUser.globalName || targetUser.username,
                        avatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 128 }),
                        profileUrl: `https://discord.com/users/${targetUser.id}`,
                        durationLabel: timeLabel,
                        expiresAt,
                        hwid: existing ? existing.hwid : null,
                        addedAt: Date.now()
                    };
                    saveStoreToDisk();

                    const roleToGive = scriptObj.roleId || store.roleId;
                    if (interaction.guild && roleToGive) {
                        await assignRoleToUser(interaction.guild, targetUser.id, roleToGive);
                    }

                    await interaction.reply({
                        content: `✅ <@${targetUser.id}> istifadəçisinə **${scriptObj.name}** üçün **${timeLabel}** whitelist verildi!`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (cmd === 'unwhitelist') {
                    const targetUser = interaction.options.getUser('user', true);
                    const scriptQuery = interaction.options.getString('script');
                    let removed = 0;

                    for (const [k, v] of Object.entries(store.whitelist)) {
                        if (String(v.userId) === String(targetUser.id) && (!scriptQuery || v.scriptId === scriptQuery)) {
                            delete store.whitelist[k];
                            removed++;
                        }
                    }
                    saveStoreToDisk();

                    await interaction.reply({
                        content: removed > 0
                            ? `🗑️ <@${targetUser.id}> whitelist-dən çıxarıldı (${removed} qeyd silindi).`
                            : `Bu istifadəçi whitelist-də tapılmadı.`,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
            }

            if (interaction.isButton() && interaction.customId.startsWith('sp:')) {
                const [, action, param] = interaction.customId.split(':');

                if (action === 'copy') {
                    const ticket = store.tickets[param];
                    if (!ticket) {
                        await interaction.reply({
                            content: 'Bu loader tapılmadı. Yenidən **Get Script** düyməsinə basın.',
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    await interaction.reply({
                        content: ticket.loaderCode,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                const scriptId = param;
                const scriptObj = store.scripts[scriptId];
                if (!scriptObj) {
                    await interaction.reply({ content: 'Bu skript artıq mövcud deyil.', flags: MessageFlags.Ephemeral });
                    return;
                }

                if (action === 'redeem') {
                    const modal = new ModalBuilder()
                        .setCustomId(`spmodal:redeem:${scriptId}`)
                        .setTitle('Redeem Key');

                    const keyInput = new TextInputBuilder()
                        .setCustomId('license_key')
                        .setLabel('Key-inizi daxil edin')
                        .setPlaceholder('SADO-XXXXXXXXXXXXXXXX')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
                    await interaction.showModal(modal);
                    return;
                }

                if (action === 'getscript') {
                    const access = checkUserAccess(interaction.user.id, scriptId);
                    if (!access.allowed) {
                        await interaction.reply({
                            content: '❌ Key aktivləşməyib! Əvvəlcə **Redeem Key** düyməsinə basıb key-inizi aktivləşdirin.',
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }

                    const ticketId = crypto.randomBytes(16).toString('hex');
                    const host = process.env.RENDER_EXTERNAL_URL
                        ? String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '')
                        : 'https://sado-protect.onrender.com';
                    const safeHostExpr = host.includes('sado-protect.onrender.com')
                        ? `"https://sado-protect." .. "onrender.com"`
                        : `"${host}"`;

                    const loaderCode =
                        `local hwid = game:GetService("RbxAnalyticsService"):GetClientId()\n` +
                        `local base = ${safeHostExpr}\n` +
                        `loadstring(game:HttpGet(base .. "/loader?ticket=" .. "${ticketId}" .. "&hwid=" .. hwid))()`;

                    store.tickets[ticketId] = {
                        scriptId,
                        userId: interaction.user.id,
                        loaderCode,
                        expiresAt: null
                    };
                    saveStoreToDisk();

                    const expText = access.record.expiresAt
                        ? `<t:${Math.floor(access.record.expiresAt / 1000)}:F>`
                        : 'Lifetime';

                    const copyRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`sp:copy:${ticketId}`)
                            .setLabel('Scripti Kopyala (1 Bas)')
                            .setStyle(ButtonStyle.Secondary)
                    );

                    await interaction.reply({
                        content:
                            `**SADOPROTECT Qorunan Loader** (\`${scriptObj.id}\` · v${scriptObj.version || 1})\n` +
                            `Müddət: **${expText}** · *Loader ömürlük etibarlıdır.*\n` +
                            `\`\`\`lua\n${loaderCode}\n\`\`\``,
                        components: [copyRow],
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (action === 'resethwid') {
                    const access = checkUserAccess(interaction.user.id, scriptId);
                    if (!access.allowed) {
                        await interaction.reply({
                            content: '❌ Sizin aktiv key və ya whitelist-iniz yoxdur.',
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    access.record.hwid = null;
                    saveStoreToDisk();
                    await interaction.reply({
                        content: '✅ HWID sıfırlandı! Növbəti girişdə yeni cihazınız avtomatik bağlanacaq.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (action === 'getstats') {
                    const access = checkUserAccess(interaction.user.id, scriptId);
                    if (!access.allowed) {
                        await interaction.reply({
                            content: '❌ Sizin aktiv key və ya whitelist-iniz yoxdur.',
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    const expText = access.record.expiresAt
                        ? `<t:${Math.floor(access.record.expiresAt / 1000)}:F>`
                        : 'Lifetime';
                    const hwidText = access.record.hwid ? `Bağlı (\`${access.record.hwid.slice(0, 10)}...\`)` : 'Bağlanmayıb';

                    const statEmbed = new EmbedBuilder()
                        .setTitle('📊 SADO PROTECT — Status')
                        .setColor(0x2ECC71)
                        .setDescription(
                            `• **Skript:** ${scriptObj.name} (v${scriptObj.version || 1})\n` +
                            `• **Növ:** ${access.source === 'whitelist' ? 'Whitelist' : 'Key'}\n` +
                            `• **Müddət:** ${expText}\n` +
                            `• **HWID:** ${hwidText}`
                        );

                    await interaction.reply({ embeds: [statEmbed], flags: MessageFlags.Ephemeral });
                    return;
                }
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('spmodal:redeem:')) {
                const scriptId = interaction.customId.split(':')[2];
                const scriptObj = store.scripts[scriptId];
                const enteredKey = interaction.fields.getTextInputValue('license_key').trim().toUpperCase();

                if (!scriptObj) {
                    await interaction.reply({ content: 'Skript tapılmadı.', flags: MessageFlags.Ephemeral });
                    return;
                }

                const keyObj = store.keys[enteredKey];
                if (!keyObj || keyObj.scriptId !== scriptId || keyObj.revoked) {
                    await interaction.reply({
                        content: '❌ Bu key yanlışdır və ya başqa skriptə aiddir.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (keyObj.redeemedBy && String(keyObj.redeemedBy) !== String(interaction.user.id)) {
                    await interaction.reply({
                        content: '❌ Bu key artıq başqa istifadəçi tərəfindən aktivləşdirilib.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (!keyObj.redeemedBy) {
                    keyObj.redeemedBy = interaction.user.id;
                    keyObj.redeemedAt = Date.now();
                    keyObj.username = interaction.user.username;
                    keyObj.displayName = interaction.user.globalName || interaction.user.username;
                    keyObj.avatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 128 });
                    keyObj.profileUrl = `https://discord.com/users/${interaction.user.id}`;
                    if (keyObj.durationMs && keyObj.durationMs > 0) {
                        keyObj.expiresAt = Date.now() + keyObj.durationMs;
                    }
                    saveStoreToDisk();
                }

                const roleToGive = scriptObj.roleId || store.roleId;
                if (interaction.guild && roleToGive) {
                    await assignRoleToUser(interaction.guild, interaction.user.id, roleToGive);
                }

                const expText = keyObj.expiresAt
                    ? `<t:${Math.floor(keyObj.expiresAt / 1000)}:F>`
                    : 'Lifetime';

                await interaction.reply({
                    content: `✅ Key uğurla aktivləşdirildi! İndi **Get Script** basıb skripti götürə bilərsiniz.\n• **Skript:** ${scriptObj.name}\n• **Müddət:** ${expText}`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
        } catch (err) {
            console.error('Interaction xətası:', err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Əməliyyat zamanı xəta baş verdi.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    });

    try {
        await client.login(token);
    } catch (err) {
        botStatus = { online: false, tag: '', error: err.message };
        console.error('Discord bot giriş xətası:', err.message);
    }
    discordClient = client;
    return botStatus;
}

// ================= SERVER (GUILD) İZOLYASİYASI KÖMƏKÇİLƏRİ =================
function normalizeGuildId(raw) {
    const clean = String(raw || '').trim();
    return /^\d{5,25}$/.test(clean) ? clean : '';
}

function resolveGuildScope(req, body = null, parsedUrl = null) {
    const raw =
        (body && body.guildId) ||
        req.headers['x-guild-id'] ||
        (parsedUrl && parsedUrl.searchParams.get('guildId')) ||
        '';
    return normalizeGuildId(raw);
}

function belongsToGuild(record, activeGuildId) {
    if (!record || typeof record !== 'object') return false;
    const recGuild = normalizeGuildId(record.guildId || '');
    if (!activeGuildId) return false;
    return recGuild === activeGuildId;
}

const DASHBOARD_HTML = [
'<!DOCTYPE html>',
'<html lang="az">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>SADO PROTECT — Control Dashboard</title>',
'<style>',
'  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }',
'  body { background: #0b0f19; color: #e2e8f0; padding: 14px; max-width: 960px; margin: 0 auto; }',
'  h1 { font-size: 1.4rem; color: #38bdf8; margin-bottom: 4px; }',
'  .sub { font-size: 0.85rem; color: #94a3b8; margin-bottom: 16px; }',
'  .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 14px; margin-bottom: 14px; }',
'  .card h2 { font-size: 1.05rem; color: #f8fafc; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }',
'  label { display: block; font-size: 0.82rem; color: #cbd5e1; margin: 8px 0 4px; }',
'  input, textarea, select { width: 100%; background: #0b0f19; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 9px 10px; font-size: 0.9rem; outline: none; }',
'  input:focus, textarea:focus, select:focus { border-color: #38bdf8; }',
'  textarea { min-height: 110px; font-family: monospace; resize: vertical; }',
'  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }',
'  .row-3 { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 6px; align-items: end; }',
'  @media (max-width: 640px) { .row, .row-3 { grid-template-columns: 1fr; } }',
'  button { background: #10b981; color: #fff; border: none; border-radius: 8px; padding: 10px 14px; font-weight: 600; font-size: 0.9rem; cursor: pointer; margin-top: 10px; width: 100%; }',
'  button.blue { background: #3b82f6; }',
'  button.danger { background: #ef4444; width: auto; padding: 5px 10px; font-size: 0.78rem; margin-top: 0; }',
'  button.sm { width: auto; padding: 6px 10px; font-size: 0.8rem; margin-top: 0; }',
'  .badge { font-size: 0.75rem; padding: 3px 8px; border-radius: 999px; background: #1e293b; color: #38bdf8; }',
'  .badge.ok { background: #064e3b; color: #34d399; }',
'  .badge.err { background: #7f1d1d; color: #fca5a5; }',
'  .list-item { background: #0b0f19; border: 1px solid #1e293b; border-radius: 8px; padding: 10px; margin-top: 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }',
'  .user-chip { display: flex; align-items: center; gap: 8px; }',
'  .user-chip img { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; background: #1e293b; }',
'  .user-chip a { color: #38bdf8; text-decoration: none; font-weight: 600; font-size: 0.88rem; }',
'  .muted { color: #94a3b8; font-size: 0.78rem; }',
'  .file-box { border: 1px dashed #38bdf8; border-radius: 8px; padding: 8px 10px; margin-top: 6px; background: #0f172a; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }',
'  .file-box input[type="file"] { border: none; padding: 2px; background: transparent; width: auto; }',
'  .btn-box { border: 1px solid #1e293b; border-radius: 10px; padding: 10px; margin-top: 8px; background: #0d1322; }',
'  .toast { position: fixed; bottom: 16px; right: 16px; background: #10b981; color: #fff; padding: 10px 16px; border-radius: 8px; font-weight: 600; display: none; z-index: 999; }',
'  .guild-bar { background: #111827; border: 1px solid #38bdf8; border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
'  .guild-bar input { width: auto; flex: 1; min-width: 190px; margin-top: 0; }',
'  .guild-bar button { width: auto; margin-top: 0; padding: 9px 14px; }',
'</style>',
'</head>',
'<body>',
'  <h1>🛡️ SADO PROTECT</h1>',
'  <p class="sub">Serverə bağlı skript qoruma, Key/Whitelist idarəetmə və Avto-Panel sinxronizasiyası</p>',
'  <div class="guild-bar">',
'    <span id="guildBadge" class="badge err">🔒 Server seçilməyib (Server ID yazın)</span>',
'    <input type="text" id="activeGuildInput" placeholder="Öz Discord Server (Guild) ID-nizi yazın...">',
'    <button class="blue" onclick="connectGuild()">Serverə Qoşul / Dəyiş</button>',
'    <button class="sm" style="background:#334155;" onclick="clearGuild()">Çıx</button>',
'  </div>',
'  <div class="card">',
'    <h2><span>🤖 Discord Bot Ayarları</span><span id="botStatusBadge" class="badge">Yoxlanılır...</span></h2>',
'    <label>Bot Token (Həmişə qorunur):</label>',
'    <input type="password" id="botToken" placeholder="Discord Bot Token daxil edin (saxlanılır)">',
'    <div class="row">',
'      <div><label>Default Rol ID (Key/Whitelist alanda veriləcək):</label><input type="text" id="roleId" placeholder="Məs: 123456789012345678"></div>',
'      <div><label>Server (Guild) ID:</label><input type="text" id="guildId" placeholder="Məs: 123456789012345678"></div>',
'    </div>',
'    <button class="blue" onclick="saveBotSettings()">Bot Ayarlarını Saxla & Qoşul</button>',
'  </div>',
'  <div class="card">',
'    <h2><span>📜 Skript Əlavə Et / Update Et</span><span class="badge ok">Update zamanı keylər silinmir & Panel auto-yenilənir</span></h2>',
'    <div class="row">',
'      <div><label>Mövcud Skripti Seç (Update üçün) və ya Yeni Yarat:</label><select id="editScriptSelect" onchange="loadSelectedScriptForEdit()"><option value="">+ Yeni Skript Yarat</option></select></div>',
'      <div><label>Skript Adı:</label><input type="text" id="scriptName" placeholder="Məs: SADO HUB"></div>',
'    </div>',
'    <label>Skriptə Özəl Rol ID (istəyə bağlı):</label>',
'    <input type="text" id="scriptRoleId" placeholder="Boş buraxsanız ümumi Rol ID işlənəcək">',
'    <label>Lua Skript Kodu (Mətn yazın və ya aşağıdan fayl seçin):</label>',
'    <div class="file-box"><span class="muted">📁 Fayldan yüklə (<code>.lua</code>, <code>.txt</code>):</span><input type="file" id="scriptFileInput" accept=".lua,.txt,text/plain" onchange="handleScriptFile(this)"><span id="fileNameLabel" class="muted"></span></div>',
'    <textarea id="scriptCode" placeholder=\'print("SADO PROTECT Aktivdir!")\'></textarea>',
'    <button onclick="saveOrUpdateScript()">Skripti Saxla / Update Et (Auto-Panel)</button>',
'    <div id="scriptsList" style="margin-top:12px;"></div>',
'  </div>',
'  <div class="card">',
'    <h2>🔑 Key Yarat & Whitelist</h2>',
'    <div class="row">',
'      <div><label>Skript Seçin:</label><select id="targetScriptId"></select></div>',
'      <div><label>Müddət:</label><select id="durationSelect"><option value="lifetime">lifetime</option><option value="7 day">7 day</option><option value="5 day">5 day</option><option value="3 day">3 day</option><option value="24 hour">24 hour</option><option value="5 hour">5 hour</option><option value="1 hour">1 hour</option></select></div>',
'    </div>',
'    <div class="row">',
'      <div><label>Key Sayı:</label><input type="number" id="keyAmount" value="1" min="1" max="50"></div>',
'      <div style="display:flex;align-items:end;"><button onclick="generateKeys()">Key Yarat</button></div>',
'    </div>',
'    <div id="generatedKeysBox" style="margin-top:8px;"></div>',
'    <hr style="border-color:#1f2937;margin:14px 0;">',
'    <label>Birbaşa Discord ID-yə Whitelist Ver:</label>',
'    <div class="row"><input type="text" id="wlUserId" placeholder="Discord User ID (məs: 1333482185423982733)"><button class="blue" style="margin-top:0;" onclick="addWhitelistManual()">Whitelist Ver</button></div>',
'  </div>',
'  <div class="card"><h2>👥 Aktiv İstifadəçilər (Key & Whitelist)</h2><div id="holdersList"></div></div>',
'  <div class="card">',
'    <h2>🎨 Discord Panel Görünüşü & Butonları</h2>',
'    <label>Panel Başlığı (Title):</label><input type="text" id="panelTitle">',
'    <label>Panel Açıqlaması (Description):</label><textarea id="panelDesc" style="min-height:70px;"></textarea>',
'    <label>Embed Rəngi:</label><input type="color" id="panelColor" style="height:40px;padding:3px;">',
'    <div id="buttonsConfigArea"></div>',
'    <button onclick="savePanelConfig()">Panel Ayarlarını Saxla & Discord-da Yenilə</button>',
'  </div>',
'  <div class="card">',
'    <h2>💾 Yedəkləmə (Backup / Restore)</h2>',
'    <p class="muted">Bütün skriptlərinizi, keylərinizi, whitelistləri və tokeni JSON kimi endirib istənilən vaxt geri yükləyə bilərsiniz.</p>',
'    <div class="row"><button class="blue" onclick="downloadBackup()">Backup Endir (.json)</button><div class="file-box" style="margin-top:10px;"><span class="muted">Backup Yüklə:</span><input type="file" accept=".json,application/json" onchange="restoreBackup(this)"></div></div>',
'  </div>',
'  <div id="toast" class="toast"></div>',
'<script>',
'let stateData = null;',
'function getSelectedGuildId() { try { return (localStorage.getItem("sado_selected_guild") || "").trim(); } catch (_) { return ""; } }',
'function setSelectedGuildId(gid) { try { var clean = (gid || "").trim(); if (clean) localStorage.setItem("sado_selected_guild", clean); else localStorage.removeItem("sado_selected_guild"); } catch (_) {} }',
'function showToast(msg, isErr) { var t = document.getElementById("toast"); t.textContent = msg; t.style.background = isErr ? "#ef4444" : "#10b981"; t.style.display = "block"; setTimeout(function() { t.style.display = "none"; }, 3200); }',
'async function api(path, method, body) {',
'  method = method || "GET";',
'  var gid = getSelectedGuildId();',
'  var headers = {};',
'  if (gid) headers["X-Guild-Id"] = gid;',
'  if (body) headers["Content-Type"] = "application/json";',
'  var sep = path.indexOf("?") !== -1 ? "&" : "?";',
'  var fullPath = gid ? (path + sep + "guildId=" + encodeURIComponent(gid)) : path;',
'  var payload = body ? Object.assign({}, body, { guildId: body.guildId !== undefined ? body.guildId : gid }) : undefined;',
'  var res = await fetch(fullPath, { method: method, headers: headers, body: payload ? JSON.stringify(payload) : undefined });',
'  return res.json();',
'}',
'function connectGuild() {',
'  var val = document.getElementById("activeGuildInput").value.trim();',
'  if (!/^[0-9]{5,25}$/.test(val)) return showToast("Düzgün Discord Server (Guild) ID daxil edin!", true);',
'  setSelectedGuildId(val);',
'  document.getElementById("activeGuildInput").value = "";',
'  showToast("Server seçildi: " + val);',
'  loadState();',
'}',
'function clearGuild() { setSelectedGuildId(""); document.getElementById("activeGuildInput").value = ""; showToast("Server seçimi sıfırlandı"); loadState(); }',
'function handleScriptFile(input) {',
'  var file = input.files && input.files[0];',
'  if (!file) return;',
'  document.getElementById("fileNameLabel").textContent = file.name;',
'  if (!document.getElementById("scriptName").value.trim()) { document.getElementById("scriptName").value = file.name.replace(/\\.(lua|txt)$/i, ""); }',
'  var reader = new FileReader();',
'  reader.onload = function() { document.getElementById("scriptCode").value = String(reader.result || ""); showToast("Fayl yükləndi: " + file.name); };',
'  reader.readAsText(file);',
'}',
'function renderButtonsConfig(buttons) {',
'  var labels = { redeem: "1. Redeem Key Düyməsi", getScript: "2. Get Script Düyməsi", resetHwid: "3. Reset HWID Düyməsi", getStats: "4. Get Stats Düyməsi" };',
'  var area = document.getElementById("buttonsConfigArea");',
'  area.innerHTML = "";',
'  ["redeem", "getScript", "resetHwid", "getStats"].forEach(function(key) {',
'    var b = (buttons && buttons[key]) || {};',
'    var box = document.createElement("div");',
'    box.className = "btn-box";',
'    var opts = ["Primary", "Success", "Danger", "Secondary"].map(function(st) { return "<option value=\\"" + st + "\\" " + (b.style === st ? "selected" : "") + ">" + st + "</option>"; }).join("");',
'    box.innerHTML = "<div style=\\"font-weight:600;font-size:0.88rem;margin-bottom:6px;color:#38bdf8;\\">" + labels[key] + "</div>" +',
'      "<div class=\\"row-3\\">" +',
'      "<div><label>Mətn (Label):</label><input type=\\"text\\" id=\\"btn_label_" + key + "\\" value=\\"" + String(b.label || "").replace(/"/g, "&quot;") + "\\"></div>" +',
'      "<div><label>Emoji:</label><input type=\\"text\\" id=\\"btn_emoji_" + key + "\\" value=\\"" + String(b.emoji || "").replace(/"/g, "&quot;") + "\\"></div>" +',
'      "<div><label>Rəng (Style):</label><select id=\\"btn_style_" + key + "\\">" + opts + "</select></div>" +',
'      "<div><label>Sıra (1-4):</label><input type=\\"number\\" id=\\"btn_order_" + key + "\\" min=\\"1\\" max=\\"4\\" value=\\"" + (b.order || 1) + "\\"></div>" +',
'      "</div>";',
'    area.appendChild(box);',
'  });',
'}',
'function loadSelectedScriptForEdit() {',
'  var selId = document.getElementById("editScriptSelect").value;',
'  if (!selId || !stateData || !stateData.scripts[selId]) {',
'    document.getElementById("scriptName").value = "";',
'    document.getElementById("scriptRoleId").value = "";',
'    document.getElementById("scriptCode").value = "";',
'    document.getElementById("fileNameLabel").textContent = "";',
'    return;',
'  }',
'  var sc = stateData.scripts[selId];',
'  document.getElementById("scriptName").value = sc.name || "";',
'  document.getElementById("scriptRoleId").value = sc.roleId || "";',
'  document.getElementById("scriptCode").value = sc.code || "";',
'  document.getElementById("fileNameLabel").textContent = sc.fileName || "";',
'}',
'async function loadState() {',
'  stateData = await api("/api/state");',
'  var activeGid = getSelectedGuildId();',
'  var guildBadge = document.getElementById("guildBadge");',
'  if (guildBadge) {',
'    if (activeGid) { guildBadge.textContent = "🌐 Aktiv Server ID: " + activeGid; guildBadge.className = "badge ok"; }',
'    else { guildBadge.textContent = "🔒 Server seçilməyib (Server ID yazın)"; guildBadge.className = "badge err"; }',
'  }',
'  var badge = document.getElementById("botStatusBadge");',
'  if (stateData.botStatus && stateData.botStatus.online) { badge.textContent = "Onlayn: " + stateData.botStatus.tag; badge.className = "badge ok"; }',
'  else { badge.textContent = "Oflayn" + (stateData.botStatus && stateData.botStatus.error ? ": " + stateData.botStatus.error : ""); badge.className = "badge err"; }',
'  document.getElementById("roleId").value = stateData.roleId || "";',
'  document.getElementById("guildId").value = activeGid || "";',
'  var scripts = Object.values(stateData.scripts || {});',
'  var targetSel = document.getElementById("targetScriptId");',
'  var prevTarget = targetSel.value;',
'  targetSel.innerHTML = scripts.map(function(s) { return "<option value=\\"" + s.id + "\\">" + s.name + " (v" + (s.version || 1) + ")</option>"; }).join("");',
'  if (prevTarget && stateData.scripts[prevTarget]) targetSel.value = prevTarget;',
'  var editSel = document.getElementById("editScriptSelect");',
'  var prevEdit = editSel.value;',
'  editSel.innerHTML = "<option value=\\"\\">+ Yeni Skript Yarat</option>" + scripts.map(function(s) { return "<option value=\\"" + s.id + "\\">" + s.name + " (v" + (s.version || 1) + ")</option>"; }).join("");',
'  if (prevEdit && stateData.scripts[prevEdit]) editSel.value = prevEdit;',
'  var scriptsList = document.getElementById("scriptsList");',
'  if (!activeGid) { scriptsList.innerHTML = "<div class=\\"muted\\">Öz serverinizin skriptlərini görmək üçün yuxarıda Server (Guild) ID daxil edin.</div>"; }',
'  else if (scripts.length) {',
'    scriptsList.innerHTML = scripts.map(function(s) {',
'      return "<div class=\\"list-item\\"><div><strong>" + s.name + "</strong> <span class=\\"badge\\">ID: " + s.id + "</span> <span class=\\"badge ok\\">v" + (s.version || 1) + "</span>" +',
'        (s.guildId ? " <span class=\\"badge\\">Server: " + s.guildId + "</span>" : "") +',
'        "<div class=\\"muted\\">" + (s.fileName ? "Fayl: " + s.fileName + " • " : "") + "Kod uzunluğu: " + (s.code || "").length + " simvol</div></div>" +',
'        "<button class=\\"danger\\" onclick=\\"deleteScript(\'" + s.id + "\')\\">Sil</button></div>";',
'    }).join("");',
'  } else { scriptsList.innerHTML = "<div class=\\"muted\\">Bu serverdə hələ skript əlavə edilməyib.</div>"; }',
'  var holders = [];',
'  Object.values(stateData.whitelist || {}).forEach(function(w) {',
'    holders.push({ type: "Whitelist", userId: w.userId, username: w.username || w.userId, displayName: w.displayName || w.username || w.userId, avatarUrl: w.avatarUrl || "", profileUrl: w.profileUrl || ("https://discord.com/users/" + w.userId), scriptId: w.scriptId, expiresAt: w.expiresAt, hwid: w.hwid, removeAction: "removeWhitelist(\'" + w.scriptId + ":" + w.userId + "\')" });',
'  });',
'  Object.values(stateData.keys || {}).forEach(function(k) {',
'    if (k.redeemedBy) {',
'      holders.push({ type: "Key (" + k.code + ")", userId: k.redeemedBy, username: k.username || k.redeemedBy, displayName: k.displayName || k.username || k.redeemedBy, avatarUrl: k.avatarUrl || "", profileUrl: k.profileUrl || ("https://discord.com/users/" + k.redeemedBy), scriptId: k.scriptId, expiresAt: k.expiresAt, hwid: k.hwid, removeAction: "deleteKey(\'" + k.code + "\')" });',
'    }',
'  });',
'  var holdersList = document.getElementById("holdersList");',
'  if (!activeGid) { holdersList.innerHTML = "<div class=\\"muted\\">Server seçildikdən sonra yalnız həmin serverin istifadəçiləri görünəcək.</div>"; }',
'  else if (holders.length) {',
'    holdersList.innerHTML = holders.map(function(h) {',
'      var expText = h.expiresAt ? new Date(h.expiresAt).toLocaleString("az-AZ") : "Lifetime";',
'      return "<div class=\\"list-item\\"><div class=\\"user-chip\\"><img src=\\"" + (h.avatarUrl || "https://cdn.discordapp.com/embed/avatars/0.png") + "\\" alt=\\"\\">" +',
'        "<div><a href=\\"" + h.profileUrl + "\\" target=\\"_blank\\">" + h.displayName + "</a> <span class=\\"muted\\">(@" + h.username + ")</span>" +',
'        "<div class=\\"muted\\">ID: " + h.userId + " • Skript: <b>" + h.scriptId + "</b> • " + h.type + " • Müddət: " + expText + "</div>" +',
'        "<div class=\\"muted\\">HWID: " + (h.hwid ? h.hwid : "Bağlanmayıb") + "</div></div></div>" +',
'        "<button class=\\"danger\\" onclick=\\"" + h.removeAction + "\\">Sil</button></div>";',
'    }).join("");',
'  } else { holdersList.innerHTML = "<div class=\\"muted\\">Bu serverdə hələ aktiv key və ya whitelist istifadəçisi yoxdur.</div>"; }',
'  var cfg = stateData.panelConfig || {};',
'  document.getElementById("panelTitle").value = cfg.title || "";',
'  document.getElementById("panelDesc").value = cfg.description || "";',
'  document.getElementById("panelColor").value = cfg.color || "#00FF00";',
'  renderButtonsConfig(cfg.buttons || {});',
'}',
'async function saveBotSettings() {',
'  var botToken = document.getElementById("botToken").value.trim();',
'  var roleId = document.getElementById("roleId").value.trim();',
'  var guildId = document.getElementById("guildId").value.trim();',
'  if (guildId && /^[0-9]{5,25}$/.test(guildId)) setSelectedGuildId(guildId);',
'  var res = await api("/api/bot-settings", "POST", { botToken: botToken || undefined, roleId: roleId, guildId: guildId });',
'  if (res.ok) { document.getElementById("botToken").value = ""; showToast(res.botStatus && res.botStatus.online ? "Bot qoşuldu: " + res.botStatus.tag : "Ayarlar saxlanıldı"); }',
'  else { showToast(res.error || "Xəta", true); }',
'  loadState();',
'}',
'async function saveOrUpdateScript() {',
'  var existingId = document.getElementById("editScriptSelect").value.trim();',
'  var name = document.getElementById("scriptName").value.trim();',
'  var roleId = document.getElementById("scriptRoleId").value.trim();',
'  var code = document.getElementById("scriptCode").value;',
'  var fileName = document.getElementById("fileNameLabel").textContent.trim();',
'  var activeGid = getSelectedGuildId();',
'  if (!activeGid) return showToast("Əvvəlcə yuxarıda öz Server (Guild) ID-nizi daxil edib qoşulun!", true);',
'  if (!name || !code.trim()) return showToast("Skript adı və Lua kodu mütləqdir!", true);',
'  var res = await api("/api/scripts", "POST", { id: existingId || undefined, guildId: activeGid, name: name, roleId: roleId, code: code, fileName: fileName });',
'  if (res.ok) { showToast(existingId ? "Skript update edildi! Keylər qorundu, " + (res.panelsUpdated || 0) + " panel yeniləndi." : "Yeni skript yaradıldı!"); loadState(); }',
'  else { showToast(res.error || "Xəta", true); }',
'}',
'async function deleteScript(id) { await api("/api/scripts/" + encodeURIComponent(id), "DELETE"); showToast("Skript silindi"); loadState(); }',
'async function generateKeys() {',
'  var activeGid = getSelectedGuildId();',
'  if (!activeGid) return showToast("Əvvəlcə Server ID daxil edin!", true);',
'  var scriptId = document.getElementById("targetScriptId").value;',
'  var durationLabel = document.getElementById("durationSelect").value;',
'  var amount = Number(document.getElementById("keyAmount").value || 1);',
'  var res = await api("/api/keys", "POST", { scriptId: scriptId, durationLabel: durationLabel, amount: amount });',
'  if (res.ok) { document.getElementById("generatedKeysBox").innerHTML = "<textarea readonly style=\\"min-height:70px;\\">" + res.keys.join("\\n") + "</textarea>"; showToast(res.keys.length + " key yaradıldı!"); loadState(); }',
'  else { showToast(res.error || "Xəta", true); }',
'}',
'async function addWhitelistManual() {',
'  var activeGid = getSelectedGuildId();',
'  if (!activeGid) return showToast("Əvvəlcə Server ID daxil edin!", true);',
'  var scriptId = document.getElementById("targetScriptId").value;',
'  var userId = document.getElementById("wlUserId").value.trim();',
'  var durationLabel = document.getElementById("durationSelect").value;',
'  if (!userId) return showToast("Discord User ID yazın!", true);',
'  var res = await api("/api/whitelist", "POST", { scriptId: scriptId, userId: userId, durationLabel: durationLabel });',
'  if (res.ok) { document.getElementById("wlUserId").value = ""; showToast("Whitelist verildi!"); loadState(); }',
'  else { showToast(res.error || "Xəta", true); }',
'}',
'async function removeWhitelist(wlKey) { await api("/api/whitelist/" + encodeURIComponent(wlKey), "DELETE"); showToast("Whitelist silindi"); loadState(); }',
'async function deleteKey(code) { await api("/api/keys/" + encodeURIComponent(code), "DELETE"); showToast("Key silindi"); loadState(); }',
'async function savePanelConfig() {',
'  var keys = ["redeem", "getScript", "resetHwid", "getStats"];',
'  var buttons = {};',
'  keys.forEach(function(k) { buttons[k] = { label: document.getElementById("btn_label_" + k).value.trim(), emoji: document.getElementById("btn_emoji_" + k).value.trim(), style: document.getElementById("btn_style_" + k).value, order: Number(document.getElementById("btn_order_" + k).value || 1) }; });',
'  var res = await api("/api/panel-config", "POST", { title: document.getElementById("panelTitle").value, description: document.getElementById("panelDesc").value, color: document.getElementById("panelColor").value, buttons: buttons });',
'  if (res.ok) { showToast("Panel ayarları saxlanıldı (" + (res.panelsUpdated || 0) + " Discord panel yeniləndi)!"); loadState(); }',
'}',
'function downloadBackup() { window.location.href = "/api/backup"; }',
'async function restoreBackup(input) { var file = input.files && input.files[0]; if (!file) return; var text = await file.text(); var res = await api("/api/restore", "POST", JSON.parse(text)); showToast(res.ok ? "Backup uğurla bərpa edildi!" : (res.error || "Xəta"), !res.ok); loadState(); }',
'loadState();',
'</script>',
'</body>',
'</html>'
].join('\n');

function renderDashboardHtml() {
    return DASHBOARD_HTML;
}

// ================= HTTP SERVER & API =================
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > 5 * 1024 * 1024) {
                reject(new Error('Fayl ölçüsü çox böyükdür (maksimum 5MB)'));
            }
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (err) {
                reject(new Error('Yanlış JSON formatı'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
    try {
        const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsed.pathname;

        if (req.method === 'GET' && pathname === '/ping') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
            return;
        }

        if (req.method === 'GET' && pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderDashboardHtml());
            return;
        }

        if (req.method === 'GET' && pathname === '/loader') {
            const ticketId = parsed.searchParams.get('ticket') || '';
            const hwid = (parsed.searchParams.get('hwid') || '').trim();
            const ua = String(req.headers['user-agent'] || '').toLowerCase();
            const accept = String(req.headers['accept'] || '').toLowerCase();
            const secFetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();

            const isBrowser =
                secFetchMode === 'navigate' ||
                accept.includes('text/html') ||
                ua.includes('mozilla/') ||
                ua.includes('chrome/') ||
                ua.includes('safari/') ||
                ua.includes('firefox/') ||
                ua.includes('edge/') ||
                ua.includes('opera/');

            if (isBrowser || !hwid) {
                res.writeHead(403, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end('<html><body style="background:#0b0f19;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>403 Forbidden — SADO PROTECT: Brauzerdən giriş qadağandır!</h2></body></html>');
                return;
            }

            const ticket = store.tickets[ticketId];

            if (!ticket) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('warn("[SADO PROTECT] Bilet tapilmadi! Discord-da Get Script basin.")');
                return;
            }

            const access = checkUserAccess(ticket.userId, ticket.scriptId);
            const scriptObj = store.scripts[ticket.scriptId];

            if (!access.allowed || !scriptObj) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('warn("[SADO PROTECT] Icazeniz yoxdur ve ya key muddeti bitib.")');
                return;
            }

            if (hwid) {
                if (!access.record.hwid) {
                    access.record.hwid = hwid;
                    saveStoreToDisk();
                } else if (access.record.hwid !== hwid) {
                    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('warn("[SADO PROTECT] HWID uygun gelmir! Discord panelden Reset HWID edin.")');
                    return;
                }
            }

            const xorKey = crypto.randomBytes(16);
            const rawBytes = Buffer.from(String(scriptObj.code || ''), 'utf8');
            const encBytes = new Array(rawBytes.length);
            for (let i = 0; i < rawBytes.length; i++) {
                encBytes[i] = rawBytes[i] ^ xorKey[i % xorKey.length];
            }

            const protectedPayload =
                `-- SADO PROTECT PROTECTED CHUNK\n` +
                `local _k={${Array.from(xorKey).join(',')}}\n` +
                `local _d={${encBytes.join(',')}}\n` +
                `local _b=table.create(#_d)\n` +
                `for i=1,#_d do _b[i]=string.char(bit32.bxor(_d[i],_k[((i-1)%#_k)+1])) end\n` +
                `local _f,err=loadstring(table.concat(_b))\n` +
                `if _f then return _f() else warn("[SADO PROTECT] "..tostring(err)) end`;

            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(protectedPayload);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/state') {
            const activeGuildId = resolveGuildScope(req, null, parsed);
            const scopedScripts = {};
            if (activeGuildId) {
                for (const [k, v] of Object.entries(store.scripts || {})) {
                    if (belongsToGuild(v, activeGuildId)) {
                        scopedScripts[k] = v;
                    }
                }
            }
            const scopedKeys = {};
            if (activeGuildId) {
                for (const [k, v] of Object.entries(store.keys || {})) {
                    const sc = store.scripts[v.scriptId];
                    if (belongsToGuild(v, activeGuildId) || (sc && normalizeGuildId(sc.guildId) === activeGuildId)) {
                        scopedKeys[k] = v;
                    }
                }
            }
            const scopedWhitelist = {};
            if (activeGuildId) {
                for (const [k, v] of Object.entries(store.whitelist || {})) {
                    const sc = store.scripts[v.scriptId];
                    if (belongsToGuild(v, activeGuildId) || (sc && normalizeGuildId(sc.guildId) === activeGuildId)) {
                        scopedWhitelist[k] = v;
                    }
                }
            }

            sendJson(res, 200, {
                guildId: activeGuildId,
                roleId: activeGuildId ? store.roleId : '',
                botStatus,
                scripts: scopedScripts,
                keys: scopedKeys,
                whitelist: scopedWhitelist,
                panelConfig: store.panelConfig
            });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/bot-settings') {
            const body = await readJsonBody(req);
            if (body.roleId !== undefined) store.roleId = String(body.roleId).trim();
            if (body.guildId !== undefined) store.guildId = String(body.guildId).trim();
            saveStoreToDisk();

            if (body.botToken !== undefined && String(body.botToken).trim()) {
                await restartDiscordBot(String(body.botToken).trim());
            } else if (store.botToken && !botStatus.online) {
                await restartDiscordBot(store.botToken);
            }
            sendJson(res, 200, { ok: true, botStatus });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/scripts') {
            const body = await readJsonBody(req);
            const guildId = resolveGuildScope(req, body, parsed);
            const name = String(body.name || '').trim();
            const code = String(body.code || '');
            const roleId = String(body.roleId || '').trim();
            const fileName = String(body.fileName || '').trim();
            if (!guildId) {
                sendJson(res, 400, { ok: false, error: 'Əvvəlcə Server (Guild) ID daxil edin' });
                return;
            }
            if (!name || !code.trim()) {
                sendJson(res, 400, { ok: false, error: 'Skript adı və kodu mütləqdir' });
                return;
            }

            const requestedId = body.id ? String(body.id).trim() : '';
            const existing = requestedId && store.scripts[requestedId]
                ? store.scripts[requestedId]
                : Object.values(store.scripts).find(s =>
                    s.name.toLowerCase() === name.toLowerCase() &&
                    normalizeGuildId(s.guildId) === guildId
                );

            let scriptId;
            if (existing) {
                scriptId = existing.id;
                store.scripts[scriptId] = {
                    ...existing,
                    guildId,
                    name,
                    code,
                    roleId,
                    fileName: fileName || existing.fileName || '',
                    version: (Number(existing.version) || 1) + 1,
                    updatedAt: Date.now()
                };
            } else {
                scriptId = slugifyScriptId(name);
                if (store.scripts[scriptId]) {
                    scriptId = `${scriptId}-${crypto.randomBytes(2).toString('hex')}`;
                }
                store.scripts[scriptId] = {
                    id: scriptId,
                    guildId,
                    name,
                    code,
                    roleId,
                    fileName,
                    version: 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
            }

            saveStoreToDisk();
            const syncRes = await syncAllDiscordPanels(scriptId);
            sendJson(res, 200, { ok: true, script: store.scripts[scriptId], panelsUpdated: syncRes.updated });
            return;
        }

        if (req.method === 'DELETE' && pathname.startsWith('/api/scripts/')) {
            const id = decodeURIComponent(pathname.slice('/api/scripts/'.length));
            store._explicitDeletedScripts = Array.from(new Set([...(store._explicitDeletedScripts || []), id]));
            delete store.scripts[id];
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/keys') {
            const body = await readJsonBody(req);
            const guildId = resolveGuildScope(req, body, parsed);
            const scriptId = String(body.scriptId || '').trim();
            if (!guildId || !store.scripts[scriptId]) {
                sendJson(res, 400, { ok: false, error: 'Server ID və skript seçilməlidir' });
                return;
            }
            const durationLabel = String(body.durationLabel || 'lifetime');
            const durationMs = DURATION_OPTIONS[durationLabel] || 0;
            const amount = Math.max(1, Math.min(Number(body.amount) || 1, 50));

            const created = [];
            for (let i = 0; i < amount; i++) {
                const code = generateLicenseKey();
                store.keys[code] = {
                    code,
                    guildId,
                    scriptId,
                    durationLabel,
                    durationMs,
                    expiresAt: null,
                    redeemedBy: null,
                    hwid: null,
                    createdAt: Date.now()
                };
                created.push(code);
            }
            saveStoreToDisk();
            sendJson(res, 200, { ok: true, keys: created });
            return;
        }

        if (req.method === 'DELETE' && pathname.startsWith('/api/keys/')) {
            const code = decodeURIComponent(pathname.slice('/api/keys/'.length));
            store._explicitDeletedKeys = Array.from(new Set([...(store._explicitDeletedKeys || []), code]));
            delete store.keys[code];
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/whitelist') {
            const body = await readJsonBody(req);
            const guildId = resolveGuildScope(req, body, parsed);
            const scriptId = String(body.scriptId || '').trim();
            const userId = String(body.userId || '').trim();
            const durationLabel = String(body.durationLabel || 'lifetime');
            if (!guildId || !store.scripts[scriptId] || !userId) {
                sendJson(res, 400, { ok: false, error: 'Server ID, skript və ya User ID yanlışdır' });
                return;
            }

            let username = userId;
            let displayName = userId;
            let avatarUrl = '';
            if (discordClient && botStatus.online) {
                try {
                    const u = await discordClient.users.fetch(userId);
                    if (u) {
                        username = u.username;
                        displayName = u.globalName || u.username;
                        avatarUrl = u.displayAvatarURL({ extension: 'png', size: 128 });
                    }
                } catch (_) {}
            }

            const wlKey = `${scriptId}:${userId}`;
            store.whitelist[wlKey] = {
                guildId,
                scriptId,
                userId,
                username,
                displayName,
                avatarUrl,
                profileUrl: `https://discord.com/users/${userId}`,
                durationLabel,
                expiresAt: parseDurationLabelToExpiresAt(durationLabel),
                hwid: null,
                addedAt: Date.now()
            };
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'DELETE' && pathname.startsWith('/api/whitelist/')) {
            const wlKey = decodeURIComponent(pathname.slice('/api/whitelist/'.length));
            store._explicitDeletedWhitelist = Array.from(new Set([...(store._explicitDeletedWhitelist || []), wlKey]));
            delete store.whitelist[wlKey];
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/panel-config') {
            const body = await readJsonBody(req);
            store.panelConfig = normalizeStore({ ...store, panelConfig: body }, store).panelConfig;
            saveStoreToDisk();
            const syncRes = await syncAllDiscordPanels(null);
            sendJson(res, 200, { ok: true, panelsUpdated: syncRes.updated });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/backup') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': 'attachment; filename="sado-protect-backup.json"'
            });
            res.end(JSON.stringify({ ...store }, null, 2));
            return;
        }

        if (req.method === 'POST' && pathname === '/api/restore') {
            const body = await readJsonBody(req);
            store = normalizeStore(body, store);
            saveStoreToDisk();
            if (store.botToken) {
                await restartDiscordBot(store.botToken);
            }
            sendJson(res, 200, { ok: true });
            return;
        }

        sendJson(res, 404, { error: 'Tapılmadı' });
    } catch (err) {
        console.error('HTTP xətası:', err);
        sendJson(res, 500, { ok: false, error: err.message });
    }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`SADO PROTECT Server port ${PORT} üzərində işləyir`);
    if (store.botToken) {
        await restartDiscordBot(store.botToken);
    }
    const externalUrl = String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
    if (externalUrl) {
        setInterval(() => {
            fetch(`${externalUrl}/ping`).catch(() => {});
        }, 8 * 60 * 1000);
    }
});
