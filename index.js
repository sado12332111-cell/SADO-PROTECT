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
        const snapshot = {
            ...store
        };
        const json = JSON.stringify(snapshot, null, 2);
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
        .setDescription('Skript idarəetmə panelini bu kanala göndərir')
        .addStringOption(opt =>
            opt.setName('script')
                .setDescription('Skript seçin (boş buraxsanız ilk skript seçilir)')
                .setRequired(false)
                .setAutocomplete(true)
        );

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

function findScript(query) {
    const all = Object.values(store.scripts);
    if (all.length === 0) return null;
    if (!query) return all[0];
    const q = String(query).trim().toLowerCase();
    return store.scripts[q] || all.find(s => s.id.toLowerCase() === q || s.name.toLowerCase() === q) || all[0];
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
                    const allScripts = Object.values(store.scripts || {});
                    const matches = allScripts
                        .filter(s => !q || String(s.name || '').toLowerCase().includes(q) || String(s.id || '').toLowerCase().includes(q))
                        .slice(0, 25)
                        .map(s => ({
                            name: `${s.name || s.id} (v${s.version || 1}) — ${s.id}`.slice(0, 100),
                            value: String(s.id)
                        }));
                    if (matches.length === 0 && allScripts.length > 0) {
                        matches.push(...allScripts.slice(0, 25).map(s => ({
                            name: `${s.name || s.id} (v${s.version || 1}) — ${s.id}`.slice(0, 100),
                            value: String(s.id)
                        })));
                    }
                    await interaction.respond(matches).catch(() => {});
                }
                return;
            }

            if (interaction.isChatInputCommand()) {
                const cmd = interaction.commandName;

                if (cmd === 'panel') {
                    const query = interaction.options.getString('script');
                    let scriptObj = findScript(query);
                    if (!scriptObj && Object.keys(store.scripts || {}).length === 0) {
                        const fallbackId = 'sado-hub';
                        scriptObj = {
                            id: fallbackId,
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

                    await interaction.reply({
                        content: `**${scriptObj.name}** paneli kanala göndərildi (skript update olanda avtomatik yenilənəcək).`,
                        flags: MessageFlags.Ephemeral
                    });

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
                    return;
                }

                if (cmd === 'whitelist') {
                    const targetUser = interaction.options.getUser('user', true);
                    const timeLabel = interaction.options.getString('time', true);
                    const scriptQuery = interaction.options.getString('script');
                    const scriptObj = findScript(scriptQuery);

                    if (!scriptObj) {
                        await interaction.reply({ content: 'Skript tapılmadı!', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    const expiresAt = parseDurationLabelToExpiresAt(timeLabel);
                    const wlKey = `${scriptObj.id}:${targetUser.id}`;
                    const existing = store.whitelist[wlKey];

                    store.whitelist[wlKey] = {
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

                    const loaderCode =
                        `local hwid = game:GetService("RbxAnalyticsService"):GetClientId()\n` +
                        `loadstring(game:HttpGet("${host}/loader?ticket=${ticketId}&hwid=" .. hwid))()`;

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

                const expText = keyObj.expiresAt ? `<t:${Math.floor(keyObj.expiresAt / 1000)}:F>` : 'Lifetime';
                await interaction.reply({
                    content: `✅ Key uğurla aktivləşdirildi! **${scriptObj.name}** üçün girişiniz hazırdır (**${expText}**). İndi **Get Script** düyməsinə basa bilərsiniz.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (err) {
            console.error('Interaction xətası:', err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: `Xəta baş verdi: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    });

    try {
        await client.login(token);
        discordClient = client;
    } catch (err) {
        botStatus = { online: false, tag: '', error: err.message };
    }
    return botStatus;
}

// ================= VEB İNTERFEYS (HTML) =================
function renderDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="az">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SADO PROTECT — Control Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: #0b0f19; color: #e2e8f0; padding: 14px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.4rem; color: #38bdf8; margin-bottom: 4px; }
  .sub { font-size: 0.85rem; color: #94a3b8; margin-bottom: 16px; }
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 14px; margin-bottom: 14px; }
  .card h2 { font-size: 1.05rem; color: #f8fafc; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  label { display: block; font-size: 0.82rem; color: #cbd5e1; margin: 8px 0 4px; }
  input, textarea, select {
    width: 100%; background: #0b0f19; color: #f8fafc; border: 1px solid #334155;
    border-radius: 8px; padding: 9px 10px; font-size: 0.9rem; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: #38bdf8; }
  textarea { min-height: 110px; font-family: monospace; resize: vertical; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .row-3 { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 6px; align-items: end; }
  @media (max-width: 640px) {
    .row, .row-3 { grid-template-columns: 1fr; }
  }
  button {
    background: #10b981; color: #fff; border: none; border-radius: 8px; padding: 10px 14px;
    font-weight: 600; font-size: 0.9rem; cursor: pointer; margin-top: 10px; width: 100%;
  }
  button.blue { background: #3b82f6; }
  button.danger { background: #ef4444; width: auto; padding: 5px 10px; font-size: 0.78rem; margin-top: 0; }
  button.sm { width: auto; padding: 6px 10px; font-size: 0.8rem; margin-top: 0; }
  .badge { font-size: 0.75rem; padding: 3px 8px; border-radius: 999px; background: #1e293b; color: #38bdf8; }
  .badge.ok { background: #064e3b; color: #34d399; }
  .badge.err { background: #7f1d1d; color: #fca5a5; }
  .list-item {
    background: #0b0f19; border: 1px solid #1e293b; border-radius: 8px; padding: 10px;
    margin-top: 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .user-chip { display: flex; align-items: center; gap: 8px; }
  .user-chip img { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; background: #1e293b; }
  .user-chip a { color: #38bdf8; text-decoration: none; font-weight: 600; font-size: 0.88rem; }
  .muted { color: #94a3b8; font-size: 0.78rem; }
  .file-box {
    border: 1px dashed #38bdf8; border-radius: 8px; padding: 8px 10px; margin-top: 6px;
    background: #0f172a; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  }
  .file-box input[type="file"] { border: none; padding: 2px; background: transparent; width: auto; }
  .btn-box { border: 1px solid #1e293b; border-radius: 10px; padding: 10px; margin-top: 8px; background: #0d1322; }
  .toast {
    position: fixed; bottom: 16px; right: 16px; background: #10b981; color: #fff;
    padding: 10px 16px; border-radius: 8px; font-weight: 600; display: none; z-index: 999;
  }
</style>
</head>
<body>
  <h1>🛡️ SADO PROTECT</h1>
  <p class="sub">Skript qoruma, Key/Whitelist idarəetmə və Avto-Panel sinxronizasiyası</p>

  <div class="card">
    <h2>
      <span>🤖 Discord Bot Ayarları</span>
      <span id="botStatusBadge" class="badge">Yoxlanılır...</span>
    </h2>
    <label>Bot Token (Həmişə qorunur):</label>
    <input type="password" id="botToken" placeholder="Discord Bot Token daxil edin (saxlanılır)">
    <div class="row">
      <div>
        <label>Default Rol ID (Key/Whitelist alanda veriləcək):</label>
        <input type="text" id="roleId" placeholder="Məs: 123456789012345678">
      </div>
      <div>
        <label>Server (Guild) ID:</label>
        <input type="text" id="guildId" placeholder="Məs: 123456789012345678">
      </div>
    </div>
    <button class="blue" onclick="saveBotSettings()">Bot Ayarlarını Saxla & Qoşul</button>
  </div>

  <div class="card">
    <h2>
      <span>📜 Skript Əlavə Et / Update Et</span>
      <span class="badge ok">Update zamanı keylər silinmir & Panel auto-yenilənir</span>
    </h2>
    <div class="row">
      <div>
        <label>Mövcud Skripti Seç (Update üçün) və ya Yeni Yarat:</label>
        <select id="editScriptSelect" onchange="loadSelectedScriptForEdit()">
          <option value="">+ Yeni Skript Yarat</option>
        </select>
      </div>
      <div>
        <label>Skript Adı:</label>
        <input type="text" id="scriptName" placeholder="Məs: SADO HUB">
      </div>
    </div>
    <label>Skriptə Özəl Rol ID (istəyə bağlı):</label>
    <input type="text" id="scriptRoleId" placeholder="Boş buraxsanız ümumi Rol ID işlənəcək">

    <label>Lua Skript Kodu (Mətn yazın və ya aşağıdan fayl seçin):</label>
    <div class="file-box">
      <span class="muted">📁 Fayldan yüklə (<code>.lua</code>, <code>.txt</code>):</span>
      <input type="file" id="scriptFileInput" accept=".lua,.txt,text/plain" onchange="handleScriptFile(this)">
      <span id="fileNameLabel" class="muted"></span>
    </div>
    <textarea id="scriptCode" placeholder='print("SADO PROTECT Aktivdir!")'></textarea>

    <button onclick="saveOrUpdateScript()">Skripti Saxla / Update Et (Auto-Panel)</button>

    <div id="scriptsList" style="margin-top:12px;"></div>
  </div>

  <div class="card">
    <h2>🔑 Key Yarat & Whitelist</h2>
    <div class="row">
      <div>
        <label>Skript Seçin:</label>
        <select id="targetScriptId"></select>
      </div>
      <div>
        <label>Müddət:</label>
        <select id="durationSelect">
          <option value="lifetime">lifetime</option>
          <option value="7 day">7 day</option>
          <option value="5 day">5 day</option>
          <option value="3 day">3 day</option>
          <option value="24 hour">24 hour</option>
          <option value="5 hour">5 hour</option>
          <option value="1 hour">1 hour</option>
        </select>
      </div>
    </div>
    <div class="row">
      <div>
        <label>Key Sayı:</label>
        <input type="number" id="keyAmount" value="1" min="1" max="50">
      </div>
      <div style="display:flex;align-items:end;">
        <button onclick="generateKeys()">Key Yarat</button>
      </div>
    </div>
    <div id="generatedKeysBox" style="margin-top:8px;"></div>

    <hr style="border-color:#1f2937;margin:14px 0;">
    <label>Birbaşa Discord ID-yə Whitelist Ver:</label>
    <div class="row">
      <input type="text" id="wlUserId" placeholder="Discord User ID (məs: 1333482185423982733)">
      <button class="blue" style="margin-top:0;" onclick="addWhitelistManual()">Whitelist Ver</button>
    </div>
  </div>

  <div class="card">
    <h2>👥 Aktiv İstifadəçilər (Key & Whitelist)</h2>
    <div id="holdersList"></div>
  </div>

  <div class="card">
    <h2>🎨 Discord Panel Görünüşü & Butonları</h2>
    <label>Panel Başlığı (Title):</label>
    <input type="text" id="panelTitle">
    <label>Panel Açıqlaması (Description):</label>
    <textarea id="panelDesc" style="min-height:70px;"></textarea>
    <label>Embed Rəngi:</label>
    <input type="color" id="panelColor" style="height:40px;padding:3px;">

    <div id="buttonsConfigArea"></div>
    <button onclick="savePanelConfig()">Panel Ayarlarını Saxla & Discord-da Yenilə</button>
  </div>

  <div class="card">
    <h2>💾 Yedəkləmə (Backup / Restore)</h2>
    <p class="muted">Bütün skriptlərinizi, keylərinizi, whitelistləri və tokeni JSON kimi endirib istənilən vaxt geri yükləyə bilərsiniz.</p>
    <div class="row">
      <button class="blue" onclick="downloadBackup()">Backup Endir (.json)</button>
      <div class="file-box" style="margin-top:10px;">
        <span class="muted">Backup Yüklə:</span>
        <input type="file" accept=".json,application/json" onchange="restoreBackup(this)">
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

<script>
let stateData = null;

function showToast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = isErr ? '#ef4444' : '#10b981';
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3200);
}

async function api(path, method = 'GET', body = null) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

function handleScriptFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  document.getElementById('fileNameLabel').textContent = file.name;
  if (!document.getElementById('scriptName').value.trim()) {
    document.getElementById('scriptName').value = file.name.replace(/\\.(lua|txt)$/i, '');
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('scriptCode').value = String(e.target.result || '');
    showToast('Fayl oxundu: ' + file.name);
  };
  reader.readAsText(file);
}

function loadSelectedScriptForEdit() {
  const id = document.getElementById('editScriptSelect').value;
  if (!id || !stateData || !stateData.scripts[id]) {
    document.getElementById('scriptName').value = '';
    document.getElementById('scriptRoleId').value = '';
    document.getElementById('scriptCode').value = '';
    document.getElementById('fileNameLabel').textContent = '';
    return;
  }
  const s = stateData.scripts[id];
  document.getElementById('scriptName').value = s.name || '';
  document.getElementById('scriptRoleId').value = s.roleId || '';
  document.getElementById('scriptCode').value = s.code || '';
  document.getElementById('fileNameLabel').textContent = s.fileName || '';
}

async function loadState() {
  stateData = await api('/api/state');
  const badge = document.getElementById('botStatusBadge');
  if (stateData.botStatus && stateData.botStatus.online) {
    badge.textContent = 'Onlayn: ' + stateData.botStatus.tag;
    badge.className = 'badge ok';
  } else {
    badge.textContent = 'Oflayn' + (stateData.botStatus && stateData.botStatus.error ? ': ' + stateData.botStatus.error : '');
    badge.className = 'badge err';
  }

  if (stateData.hasToken && !document.getElementById('botToken').value) {
    document.getElementById('botToken').placeholder = 'Token saxlanılıb (dəyişmək üçün yenisini yazın)';
  }
  document.getElementById('roleId').value = stateData.roleId || '';
  document.getElementById('guildId').value = stateData.guildId || '';

  const scripts = Object.values(stateData.scripts || {});
  const editSel = document.getElementById('editScriptSelect');
  const targetSel = document.getElementById('targetScriptId');
  const prevEdit = editSel.value;
  const prevTarget = targetSel.value;

  editSel.innerHTML = '<option value="">+ Yeni Skript Yarat</option>';
  targetSel.innerHTML = '';

  const listDiv = document.getElementById('scriptsList');
  listDiv.innerHTML = '';

  scripts.forEach(s => {
    editSel.innerHTML += '<option value="' + s.id + '">Update: ' + s.name + ' (v' + (s.version || 1) + ')</option>';
    targetSel.innerHTML += '<option value="' + s.id + '">' + s.name + '</option>';

    listDiv.innerHTML +=
      '<div class="list-item">' +
        '<div><strong>' + s.name + '</strong> <span class="badge">v' + (s.version || 1) + '</span> ' +
        '<span class="muted">ID: ' + s.id + (s.fileName ? ' · Fayl: ' + s.fileName : '') + '</span></div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button class="blue sm" onclick="selectForUpdate(\\'' + s.id + '\\')">Update Et</button>' +
          '<button class="danger" onclick="deleteScript(\\'' + s.id + '\\')">Sil</button>' +
        '</div>' +
      '</div>';
  });

  if (prevEdit && stateData.scripts[prevEdit]) editSel.value = prevEdit;
  if (prevTarget && stateData.scripts[prevTarget]) targetSel.value = prevTarget;

  const cfg = stateData.panelConfig;
  document.getElementById('panelTitle').value = cfg.title || '';
  document.getElementById('panelDesc').value = cfg.description || '';
  document.getElementById('panelColor').value = cfg.color || '#00FF00';

  const btnMeta = [
    { key: 'redeem', title: 'Redeem Key Butonu' },
    { key: 'getScript', title: 'Get Script Butonu' },
    { key: 'resetHwid', title: 'Reset HWID Butonu' },
    { key: 'getStats', title: 'Get Stats Butonu' }
  ];
  const btnArea = document.getElementById('buttonsConfigArea');
  btnArea.innerHTML = '';
  btnMeta.forEach(m => {
    const b = cfg.buttons[m.key];
    btnArea.innerHTML +=
      '<div class="btn-box">' +
        '<label>' + m.title + '</label>' +
        '<div class="row-3">' +
          '<input type="text" id="btn_label_' + m.key + '" value="' + (b.label || '') + '" placeholder="Ad">' +
          '<input type="text" id="btn_emoji_' + m.key + '" value="' + (b.emoji || '') + '" placeholder="Emoji (boş ola bilər)">' +
          '<select id="btn_style_' + m.key + '">' +
            '<option value="Primary"' + (b.style === 'Primary' ? ' selected' : '') + '>Mavi</option>' +
            '<option value="Success"' + (b.style === 'Success' ? ' selected' : '') + '>Yaşıl</option>' +
            '<option value="Danger"' + (b.style === 'Danger' ? ' selected' : '') + '>Qırmızı</option>' +
            '<option value="Secondary"' + (b.style === 'Secondary' ? ' selected' : '') + '>Boz</option>' +
          '</select>' +
          '<select id="btn_order_' + m.key + '">' +
            '<option value="1"' + (Number(b.order) === 1 ? ' selected' : '') + '>Yer: 1</option>' +
            '<option value="2"' + (Number(b.order) === 2 ? ' selected' : '') + '>Yer: 2</option>' +
            '<option value="3"' + (Number(b.order) === 3 ? ' selected' : '') + '>Yer: 3</option>' +
            '<option value="4"' + (Number(b.order) === 4 ? ' selected' : '') + '>Yer: 4</option>' +
          '</select>' +
        '</div>' +
      '</div>';
  });

  const holdersDiv = document.getElementById('holdersList');
  holdersDiv.innerHTML = '';

  Object.entries(stateData.whitelist || {}).forEach(([wlKey, w]) => {
    const avatar = w.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
    const profileUrl = w.profileUrl || ('https://discord.com/users/' + w.userId);
    const name = w.displayName || w.username || w.userId;
    holdersDiv.innerHTML +=
      '<div class="list-item">' +
        '<div class="user-chip">' +
          '<img src="' + avatar + '" alt="">' +
          '<div>' +
            '<a href="' + profileUrl + '" target="_blank">' + name + '</a> ' +
            '<span class="badge ok">Whitelist · ' + (w.durationLabel || 'lifetime') + '</span>' +
            '<div class="muted">ID: ' + w.userId + ' · Skript: ' + w.scriptId + '</div>' +
          '</div>' +
        '</div>' +
        '<button class="danger" onclick="removeWhitelist(\\'' + wlKey + '\\')">Sil</button>' +
      '</div>';
  });

  Object.values(stateData.keys || {}).forEach(k => {
    const avatar = k.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
    const profileUrl = k.redeemedBy ? (k.profileUrl || 'https://discord.com/users/' + k.redeemedBy) : '#';
    const holderName = k.redeemedBy ? (k.displayName || k.username || k.redeemedBy) : 'İstifadə olunmayıb';
    holdersDiv.innerHTML +=
      '<div class="list-item">' +
        '<div class="user-chip">' +
          '<img src="' + avatar + '" alt="">' +
          '<div>' +
            (k.redeemedBy
              ? '<a href="' + profileUrl + '" target="_blank">' + holderName + '</a> '
              : '<strong>' + holderName + '</strong> ') +
            '<span class="badge">Key: ' + k.code + ' (' + (k.durationLabel || 'lifetime') + ')</span>' +
            '<div class="muted">Skript: ' + k.scriptId + (k.redeemedBy ? ' · ID: ' + k.redeemedBy : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<button class="danger" onclick="deleteKey(\\'' + k.code + '\\')">Key Sil</button>' +
      '</div>';
  });
}

function selectForUpdate(id) {
  document.getElementById('editScriptSelect').value = id;
  loadSelectedScriptForEdit();
  window.scrollTo({ top: 150, behavior: 'smooth' });
}

async function saveBotSettings() {
  const token = document.getElementById('botToken').value.trim();
  const roleId = document.getElementById('roleId').value.trim();
  const guildId = document.getElementById('guildId').value.trim();
  const res = await api('/api/bot-settings', 'POST', {
    botToken: token || undefined,
    roleId,
    guildId
  });
  showToast(res.ok ? 'Bot ayarları saxlanıldı!' : (res.error || 'Xəta'), !res.ok);
  loadState();
}

async function saveOrUpdateScript() {
  const existingId = document.getElementById('editScriptSelect').value;
  const name = document.getElementById('scriptName').value.trim();
  const roleId = document.getElementById('scriptRoleId').value.trim();
  const code = document.getElementById('scriptCode').value;
  const fileName = document.getElementById('fileNameLabel').textContent.trim();

  if (!name || !code.trim()) {
    showToast('Skript adı və ya kodu boş ola bilməz!', true);
    return;
  }

  const res = await api('/api/scripts', 'POST', {
    id: existingId || undefined,
    name,
    roleId,
    code,
    fileName
  });

  if (res.ok) {
    showToast(existingId
      ? 'Skript update edildi! Keylər qorundu, ' + (res.panelsUpdated || 0) + ' panel yeniləndi.'
      : 'Yeni skript yaradıldı!');
    loadState();
  } else {
    showToast(res.error || 'Xəta', true);
  }
}

async function deleteScript(id) {
  await api('/api/scripts/' + encodeURIComponent(id), 'DELETE');
  showToast('Skript silindi');
  loadState();
}

async function generateKeys() {
  const scriptId = document.getElementById('targetScriptId').value;
  const durationLabel = document.getElementById('durationSelect').value;
  const amount = Number(document.getElementById('keyAmount').value || 1);
  const res = await api('/api/keys', 'POST', { scriptId, durationLabel, amount });
  if (res.ok) {
    document.getElementById('generatedKeysBox').innerHTML =
      '<textarea readonly style="min-height:70px;">' + res.keys.join('\\n') + '</textarea>';
    showToast(res.keys.length + ' key yaradıldı!');
    loadState();
  } else {
    showToast(res.error || 'Xəta', true);
  }
}

async function addWhitelistManual() {
  const scriptId = document.getElementById('targetScriptId').value;
  const userId = document.getElementById('wlUserId').value.trim();
  const durationLabel = document.getElementById('durationSelect').value;
  if (!userId) return showToast('Discord User ID yazın!', true);

  const res = await api('/api/whitelist', 'POST', { scriptId, userId, durationLabel });
  if (res.ok) {
    document.getElementById('wlUserId').value = '';
    showToast('Whitelist verildi!');
    loadState();
  } else {
    showToast(res.error || 'Xəta', true);
  }
}

async function removeWhitelist(wlKey) {
  await api('/api/whitelist/' + encodeURIComponent(wlKey), 'DELETE');
  showToast('Whitelist silindi');
  loadState();
}

async function deleteKey(code) {
  await api('/api/keys/' + encodeURIComponent(code), 'DELETE');
  showToast('Key silindi');
  loadState();
}

async function savePanelConfig() {
  const keys = ['redeem', 'getScript', 'resetHwid', 'getStats'];
  const buttons = {};
  keys.forEach(k => {
    buttons[k] = {
      label: document.getElementById('btn_label_' + k).value.trim(),
      emoji: document.getElementById('btn_emoji_' + k).value.trim(),
      style: document.getElementById('btn_style_' + k).value,
      order: Number(document.getElementById('btn_order_' + k).value || 1)
    };
  });

  const res = await api('/api/panel-config', 'POST', {
    title: document.getElementById('panelTitle').value,
    description: document.getElementById('panelDesc').value,
    color: document.getElementById('panelColor').value,
    buttons
  });

  if (res.ok) {
    showToast('Panel ayarları saxlanıldı (' + (res.panelsUpdated || 0) + ' Discord panel yeniləndi)!');
    loadState();
  }
}

function downloadBackup() {
  window.location.href = '/api/backup';
}

async function restoreBackup(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const text = await file.text();
  const res = await api('/api/restore', 'POST', JSON.parse(text));
  showToast(res.ok ? 'Backup uğurla bərpa edildi!' : (res.error || 'Xəta'), !res.ok);
  loadState();
}

loadState();
</script>
</body>
</html>`;
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

            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(scriptObj.code);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/state') {
            sendJson(res, 200, {
                hasToken: Boolean(store.botToken),
                guildId: store.guildId,
                roleId: store.roleId,
                botStatus,
                scripts: store.scripts,
                keys: store.keys,
                whitelist: store.whitelist,
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
            const name = String(body.name || '').trim();
            const code = String(body.code || '');
            const roleId = String(body.roleId || '').trim();
            const fileName = String(body.fileName || '').trim();
            if (!name || !code.trim()) {
                sendJson(res, 400, { ok: false, error: 'Skript adı və kodu mütləqdir' });
                return;
            }

            const requestedId = body.id ? String(body.id).trim() : '';
            const existing = requestedId && store.scripts[requestedId]
                ? store.scripts[requestedId]
                : Object.values(store.scripts).find(s => s.name.toLowerCase() === name.toLowerCase());

            let scriptId;
            if (existing) {
                scriptId = existing.id;
                store.scripts[scriptId] = {
                    ...existing,
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
            delete store.scripts[id];
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/keys') {
            const body = await readJsonBody(req);
            const scriptId = String(body.scriptId || '').trim();
            if (!store.scripts[scriptId]) {
                sendJson(res, 400, { ok: false, error: 'Əvvəlcə skript seçin' });
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
            delete store.keys[code];
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/whitelist') {
            const body = await readJsonBody(req);
            const scriptId = String(body.scriptId || '').trim();
            const userId = String(body.userId || '').trim();
            const durationLabel = String(body.durationLabel || 'lifetime');
            if (!store.scripts[scriptId] || !userId) {
                sendJson(res, 400, { ok: false, error: 'Skript və ya User ID yanlışdır' });
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
