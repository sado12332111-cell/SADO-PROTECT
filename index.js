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

// Davamlı məlumat strukturu (sayt bağlanıb-açılanda silinməsin deyə faylda saxlanılır)
let store = {
    discordConfig: {
        enabled: false,
        token: "",
        autoRoleId: ""
    },
    scripts: [
        {
            id: "sado-hub",
            name: "SADO HUB",
            code: `-- SADO HUB Script\nprint("SADOPROTECT Aktivdir!")`
        }
    ],
    keys: {
        "SADO-FREE-KEY": {
            owner: "Test User",
            scriptId: "sado-hub",
            maxUsers: 1,
            users: [], // [{ hwid: "...", discordUserId: "..." }]
            autoRoleId: "",
            expiresAt: null,
            durationLabel: "lifetime"
        }
    }
};

let discordClient = null;
let botConnectionState = "Söndürülüb";
let cachedGuildRoles = []; // Server rollarının avtomatik siyahısı

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

function saveStoreToDisk() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
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
                store.discordConfig.enabled = Boolean(parsed.discordConfig.enabled);
                if (typeof parsed.discordConfig.token === 'string' && parsed.discordConfig.token.trim()) {
                    store.discordConfig.token = parsed.discordConfig.token.trim();
                }
                store.discordConfig.autoRoleId = String(parsed.discordConfig.autoRoleId || "").trim();
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

// Vaxtı bitmiş key-ləri avtomatik silir və faylı yeniləyir
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

function buildLoaderSnippet(keyStr) {
    const base = getBaseUrl();
    return `script_key = "${keyStr}"\nlocal hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${base}/loader?key=" .. script_key .. "&hwid=" .. hwid))()`;
}

// Discord serverindəki rolları avtomatik yeniləyir
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

// Key işlədiləndə bağlı rolu istifadəçiyə avtomatik verir
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

// /panel basanda açılan skript seçim menyusu
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

// Seçilmiş skriptə aid Control Panel mesajı
function buildScriptControlPanelMessage(scriptObj, guildName = "SADOPROTECT") {
    const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`${scriptObj.name} — Control Panel`)
        .setDescription(
            `This control panel is for the project:\n**${scriptObj.name}**\n` +
            `If you're a buyer, click on the buttons below to redeem your key, get the script or reset HWID`
        )
        .setFooter({ text: `${guildName} • SADOPROTECT (${scriptObj.id})` });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sado_btn_redeem:${scriptObj.id}`)
            .setLabel('Redeem Key')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`sado_btn_script:${scriptObj.id}`)
            .setLabel('Get Script')
            .setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sado_btn_hwid:${scriptObj.id}`)
            .setLabel('Reset HWID')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`sado_btn_stats:${scriptObj.id}`)
            .setLabel('Get Stats')
            .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2] };
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

async function startDiscordBot() {
    await stopDiscordBot();

    const cleanToken = String(store.discordConfig.token || "").trim();
    if (!store.discordConfig.enabled) {
        botConnectionState = "Söndürülüb";
        return;
    }
    if (!cleanToken) {
        botConnectionState = "Xəta: Bot Token daxil edilməyib";
        return;
    }

    botConnectionState = "Qoşulur...";

    try {
        const client = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
        });

        const commands = [
            new SlashCommandBuilder()
                .setName('panel')
                .setDescription('SADOPROTECT skript seçim və Control Panelini açır')
        ].map(cmd => cmd.toJSON());

        client.once('ready', async () => {
            botConnectionState = `Aktivdir (${client.user.tag})`;
            await refreshGuildRoles(client);
            try {
                const rest = new REST({ version: '10' }).setToken(cleanToken);
                await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            } catch (cmdErr) {
                console.error("Slash command qeydiyyat xətası:", cmdErr.message);
            }
        });

        client.on('guildCreate', async () => {
            await refreshGuildRoles(client);
        });

        client.on('interactionCreate', async (interaction) => {
            try {
                purgeExpiredKeys();

                if (interaction.isChatInputCommand()) {
                    if (interaction.commandName === 'panel') {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                        await refreshGuildRoles(client);

                        if (!store.scripts.length) {
                            await interaction.editReply({
                                content: 'Heç bir skript yaradılmayıb. Əvvəlcə saytdakı **New scripts** bölməsindən skript yaradın.'
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
                        const chosenScriptId = interaction.values[0];
                        const chosenScript = getScriptById(chosenScriptId);
                        const channel = interaction.channel;

                        if (channel && typeof channel.send === 'function') {
                            const panelMsg = buildScriptControlPanelMessage(chosenScript, interaction.guild?.name || "SADOPROTECT");
                            await channel.send(panelMsg);
                            await interaction.update({
                                content: `**${chosenScript.name}** paneli kanala göndərildi.`,
                                embeds: [],
                                components: []
                            });
                        } else {
                            await interaction.reply({
                                content: 'Bu kanalda mesaj göndərilə bilmədi.',
                                flags: MessageFlags.Ephemeral
                            });
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
                            .setTitle(`Redeem Key — ${activeScript.name.slice(0, 30)}`);
                        const input = new TextInputBuilder()
                            .setCustomId('key_input')
                            .setLabel('Açarınızı (Key) daxil edin')
                            .setPlaceholder('Məs: SADO-ABC123')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true);
                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        await interaction.showModal(modal);
                        return;
                    }

                    if (actionPart === 'sado_btn_script') {
                        const modal = new ModalBuilder()
                            .setCustomId(`modal_script:${activeScript.id}`)
                            .setTitle(`Get Script — ${activeScript.name.slice(0, 30)}`);
                        const input = new TextInputBuilder()
                            .setCustomId('key_input')
                            .setLabel('Aktiv Key kodunuzu yazın')
                            .setPlaceholder('Məs: SADO-ABC123')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true);
                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        await interaction.showModal(modal);
                        return;
                    }

                    if (actionPart === 'sado_btn_hwid') {
                        const modal = new ModalBuilder()
                            .setCustomId(`modal_hwid:${activeScript.id}`)
                            .setTitle(`Reset HWID — ${activeScript.name.slice(0, 30)}`);
                        const input = new TextInputBuilder()
                            .setCustomId('key_input')
                            .setLabel('HWID sıfırlanacaq Key kodunu yazın')
                            .setPlaceholder('Məs: SADO-ABC123')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true);
                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        await interaction.showModal(modal);
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
                        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                        return;
                    }
                }

                if (interaction.isModalSubmit()) {
                    const [modalType] = String(interaction.customId || "").split(":");
                    const submittedKey = String(interaction.fields.getTextInputValue('key_input') || "").trim();
                    const entry = submittedKey ? store.keys[submittedKey] : null;

                    if (!entry) {
                        await interaction.reply({
                            content: `Key tapılmadı və ya vaxtı bitib: \`${submittedKey}\``,
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }

                    if (modalType === 'modal_redeem') {
                        const maxLimit = Math.max(1, parseInt(entry.maxUsers, 10) || 1);
                        const existingUser = entry.users.find(u => u.discordUserId === interaction.user.id);

                        if (!existingUser && entry.users.length >= maxLimit) {
                            await interaction.reply({
                                content: `Bu key-i başqası işlətdi! (Limit: ${maxLimit} nəfər)`,
                                flags: MessageFlags.Ephemeral
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

                        await interaction.reply({
                            content: `Key aktivləşdirildi (\`${submittedKey}\`). Müddət: **${entry.durationLabel || "lifetime"}** (${formatRemainingTime(entry)}). İstifadəçi limiti: **${entry.users.length}/${maxLimit}**${roleNote}`,
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }

                    if (modalType === 'modal_script') {
                        const maxLimit = Math.max(1, parseInt(entry.maxUsers, 10) || 1);
                        const alreadyClaimedByOther =
                            entry.users.length >= maxLimit &&
                            !entry.users.some(u => u.discordUserId === interaction.user.id);

                        if (alreadyClaimedByOther) {
                            await interaction.reply({
                                content: `Bu key-i başqası işlətdi! (Limit: ${maxLimit} nəfər)`,
                                flags: MessageFlags.Ephemeral
                            });
                            return;
                        }

                        if (!entry.users.some(u => u.discordUserId === interaction.user.id)) {
                            entry.users.push({
                                hwid: null,
                                discordUserId: interaction.user.id
                            });
                            saveStoreToDisk();
                        }

                        await assignRoleToDiscordUser(interaction.user.id, entry.autoRoleId);

                        const snippet = buildLoaderSnippet(submittedKey);
                        await interaction.reply({
                            content: `SADOPROTECT Loader (\`${submittedKey}\` • ${entry.durationLabel || "lifetime"}):\n\`\`\`lua\n${snippet}\n\`\`\``,
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }

                    if (modalType === 'modal_hwid') {
                        entry.users = [];
                        saveStoreToDisk();
                        await interaction.reply({
                            content: `HWID uğurla sıfırlandı: \`${submittedKey}\``,
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                }
            } catch (interErr) {
                console.error("Interaction xətası:", interErr.message);
                if (interaction && (interaction.deferred || interaction.replied)) {
                    await interaction.editReply({ content: `Xəta baş verdi: ${interErr.message}` }).catch(() => {});
                } else if (interaction && typeof interaction.reply === 'function') {
                    await interaction.reply({ content: `Xəta baş verdi: ${interErr.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
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
        const pass = req.query.pass;
        if (pass !== ADMIN_PASS) {
            return res.send(`
                <body style="background:#0b0f19;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
                    <form method="GET" style="background:#131b2e;padding:30px;border-radius:12px;text-align:center;">
                        <h2 style="color:#38bdf8;">SADOPROTECT PANEL</h2>
                        <input type="password" name="pass" placeholder="Admin Sifresi" style="padding:10px;border-radius:6px;border:none;width:200px;margin-bottom:10px;"><br>
                        <button type="submit" style="background:#0284c7;color:white;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">Daxil Ol</button>
                    </form>
                </body>
            `);
        }

        if (discordClient) {
            await refreshGuildRoles(discordClient);
        }

        getBaseUrl(req);
        const safePassEnc = encodeURIComponent(ADMIN_PASS);
        const msgType = String(req.query.msg || "");
        let bannerHtml = "";
        if (msgType === "script_created") {
            bannerHtml = `<div style="background:#065f46;color:#d1fae5;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Yeni skript yadda saxlanıldı!</div>`;
        } else if (msgType === "script_deleted") {
            bannerHtml = `<div style="background:#7f1d1d;color:#fecaca;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Skript silindi!</div>`;
        } else if (msgType === "bot_saved") {
            bannerHtml = `<div style="background:#1e3a8a;color:#dbeafe;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Discord bot ayarları saxlanıldı. Status: <b>${escapeHtml(botConnectionState)}</b></div>`;
        }

        // Rol seçim siyahısı
        const roleOptionsHtml = cachedGuildRoles.length > 0
            ? cachedGuildRoles.map(r => {
                const selected = store.discordConfig.autoRoleId === r.id ? "selected" : "";
                return `<option value="${escapeHtml(r.id)}" ${selected}>${escapeHtml(r.name)} (${escapeHtml(r.guildName)})</option>`;
            }).join("")
            : `<option value="">Rol yoxdur (Botu serverə əlavə edin)</option>`;

        // Key yaradarkən rol seçimi
        const keyRoleOptionsHtml = cachedGuildRoles.length > 0
            ? `<option value="">Rol verilməsin</option>` + cachedGuildRoles.map(r => {
                const selected = store.discordConfig.autoRoleId === r.id ? "selected" : "";
                return `<option value="${escapeHtml(r.id)}" ${selected}>${escapeHtml(r.name)}</option>`;
            }).join("")
            : `<option value="">Rol seçilməyib</option>`;

        // Skript seçim siyahısı
        const scriptOptionsHtml = store.scripts.map(sc =>
            `<option value="${escapeHtml(sc.id)}">${escapeHtml(sc.name)}</option>`
        ).join("");

        // Yaradılmış skriptlərin siyahısı
        const savedScriptsHtml = store.scripts.map(sc => `
            <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <b>${escapeHtml(sc.name)}</b>
                    <a href="/delete-script?pass=${safePassEnc}&id=${encodeURIComponent(sc.id)}" style="color:#f87171;text-decoration:none;font-size:13px;">[Sil]</a>
                </div>
                <pre style="margin:0;padding:8px;background:#020617;color:#93c5fd;border-radius:6px;overflow-x:auto;font-size:12px;">${escapeHtml(sc.code)}</pre>
            </div>
        `).join("");

        // Key cədvəli
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
                <td style="padding:10px;border-bottom:1px solid #1e293b;"><b>${safeK}</b></td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeOwner}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeScriptName}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${usedU}/${maxU}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeDuration} <span style="color:#94a3b8;font-size:12px;">(${safeRemaining})</span></td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${roleBadge}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">
                    <a href="/reset?pass=${safePassEnc}&key=${safeKEnc}" style="color:#fbbf24;text-decoration:none;margin-right:8px;">[HWID Sifirla]</a>
                    <a href="/delete?pass=${safePassEnc}&key=${safeKEnc}" style="color:#f87171;text-decoration:none;">[Sil]</a>
                </td>
            </tr>
            <tr>
                <td colspan="7" style="padding:8px 10px 14px 10px;border-bottom:1px solid #1e293b;background:#0f172a;">
                    <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">Istifadeci Loader Kodu:</div>
                    <pre style="margin:0;padding:8px;background:#020617;color:#38bdf8;border-radius:6px;overflow-x:auto;font-size:12px;">${sampleLoader}</pre>
                </td>
            </tr>`;
        }

        res.send(`
            <body style="background:#0b0f19;color:white;font-family:sans-serif;padding:20px;max-width:1040px;margin:0 auto;">
                <h1 style="color:#38bdf8;">SADOPROTECT — Idareetme Paneli</h1>
                ${bannerHtml}

                <form action="/save-bot" method="POST" style="margin-bottom:20px;background:#131b2e;padding:16px;border-radius:10px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <h3 style="margin-top:0;color:#818cf8;">Discord Bot Qoşma Paneli</h3>
                    <div style="margin-bottom:10px;font-size:14px;color:#cbd5e1;">
                        Bot Vəziyyəti: <b>${escapeHtml(botConnectionState)}</b>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
                        <input type="checkbox" name="enabled" value="1" ${store.discordConfig.enabled ? "checked" : ""}>
                        <span>Discord Botu Aktiv Et</span>
                    </label>
                    <input type="password" name="token" value="${escapeHtml(store.discordConfig.token)}" placeholder="Discord Bot Token-i bura yapışdırın" style="width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;margin-bottom:10px;">
                    <label style="display:block;font-size:13px;color:#cbd5e1;margin-bottom:6px;">Server Rollari (Auto Role):</label>
                    <select name="autoRoleId" style="width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;margin-bottom:12px;">
                        <option value="">Rol seçilməyib</option>
                        ${roleOptionsHtml}
                    </select>
                    <button type="submit" style="background:#6366f1;color:white;border:none;padding:9px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Botu Yadda Saxla / Bağla</button>
                </form>

                <form action="/new-script" method="POST" style="margin-bottom:20px;background:#131b2e;padding:16px;border-radius:10px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <h3 style="margin-top:0;color:#38bdf8;">New scripts</h3>
                    <input type="text" name="scriptName" placeholder="Skriptin adı (məs: SADO DUEL)" required style="width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;margin-bottom:10px;">
                    <textarea name="scriptCode" rows="7" placeholder="Skriptin kodu..." required style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;font-family:monospace;margin-bottom:10px;"></textarea>
                    <button type="submit" style="background:#0284c7;color:white;border:none;padding:9px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Yadda saxla</button>
                    <div style="margin-top:16px;">${savedScriptsHtml}</div>
                </form>

                <form action="/create" method="GET" style="margin-bottom:20px;background:#131b2e;padding:15px;border-radius:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <input type="text" name="owner" placeholder="Istifadeci adi" required style="padding:8px;border-radius:6px;border:none;">
                    <select name="scriptId" style="padding:8px;border-radius:6px;border:none;background:#020617;color:white;">
                        ${scriptOptionsHtml}
                    </select>
                    <select name="maxUsers" style="padding:8px;border-radius:6px;border:none;background:#020617;color:white;">
                        <option value="1" selected>1 nəfər (Drop / Tek)</option>
                        <option value="2">2 nəfər</option>
                        <option value="3">3 nəfər</option>
                        <option value="5">5 nəfər</option>
                        <option value="10">10 nəfər</option>
                        <option value="50">50 nəfər</option>
                    </select>
                    <select name="duration" style="padding:8px;border-radius:6px;border:none;background:#020617;color:white;">
                        <option value="1h">1 hour</option>
                        <option value="5h">5 hours</option>
                        <option value="24h">24 hours</option>
                        <option value="3d">3 day</option>
                        <option value="7d">7 day</option>
                        <option value="lifetime" selected>lifetime</option>
                    </select>
                    <select name="autoRoleId" style="padding:8px;border-radius:6px;border:none;background:#020617;color:white;">
                        ${keyRoleOptionsHtml}
                    </select>
                    <button type="submit" style="background:#10b981;color:white;border:none;padding:8px 15px;border-radius:6px;font-weight:bold;cursor:pointer;">+ Yeni Key Yarat</button>
                </form>

                <table style="width:100%;background:#131b2e;border-radius:10px;border-collapse:collapse;text-align:left;overflow:hidden;">
                    <tr style="background:#1e293b;color:#38bdf8;">
                        <th style="padding:10px;">Acar (Key)</th>
                        <th style="padding:10px;">Sahibi</th>
                        <th style="padding:10px;">Skript</th>
                        <th style="padding:10px;">Limit</th>
                        <th style="padding:10px;">Muddet</th>
                        <th style="padding:10px;">Auto Role</th>
                        <th style="padding:10px;">Emeliyyat</th>
                    </tr>
                    ${rows}
                </table>
            </body>
        `);
    } catch (err) {
        res.status(500).send("Server xetasi");
    }
});

app.post('/save-bot', async (req, res) => {
    try {
        if (req.body.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        store.discordConfig.enabled = req.body.enabled === "1";
        if (typeof req.body.token === "string" && req.body.token.trim()) {
            store.discordConfig.token = req.body.token.trim();
        }
        if (typeof req.body.autoRoleId === "string") {
            store.discordConfig.autoRoleId = req.body.autoRoleId.trim();
        }
        saveStoreToDisk();
        await startDiscordBot();
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=bot_saved');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/new-script', (req, res) => {
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
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=script_created');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/delete-script', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const targetId = String(req.query.id || "");
        if (store.scripts.length > 1) {
            store.scripts = store.scripts.filter(s => s.id !== targetId);
            saveStoreToDisk();
        }
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=script_deleted');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/create', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        createKeyForUser(
            req.query.owner,
            req.query.duration,
            req.query.scriptId,
            req.query.maxUsers,
            req.query.autoRoleId
        );
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/reset', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        if (store.keys[req.query.key]) {
            store.keys[req.query.key].users = [];
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
        delete store.keys[req.query.key];
        saveStoreToDisk();
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
            if (keyEntry.users.length >= maxLimit) {
                return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: Bu key-i basqasi isledib! Limit dolub.")');
            }
            keyEntry.users.push({
                hwid: userHwid,
                discordUserId: null
            });
            saveStoreToDisk();
        }

        const targetScript = getScriptById(keyEntry.scriptId);
        res.type('text/plain').send(targetScript.code);
    } catch (err) {
        res.status(500).send("-- SADOPROTECT: Server Error");
    }
});

loadStoreFromDisk();
if (store.discordConfig.enabled && store.discordConfig.token) {
    startDiscordBot();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SADOPROTECT Aktivdir!"));
