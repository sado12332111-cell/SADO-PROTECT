const express = require('express');
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
    TextInputStyle
} = require('discord.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= AYARLAR =================
const ADMIN_PASS = "SADO2026";
let scriptCode = `-- SADO HUB Script\nprint("SADO PROTECT Aktivdir!")`;
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

let discordConfig = {
    enabled: false,
    token: "",
    status: "idle",
    buyerRoleId: ""
};
// ===========================================

let keys = {
    "SADO-FREE-KEY": { hwid: null, owner: "Test User", expiresAt: null, durationLabel: "lifetime" }
};

let discordClient = null;
let botConnectionState = "Söndürülüb";

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
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

function normalizeDuration(durationKey) {
    const key = String(durationKey || "lifetime").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(DURATION_MS_MAP, key) ? key : "lifetime";
}

function purgeExpiredKeys() {
    const now = Date.now();
    for (const k in keys) {
        if (keys[k] && typeof keys[k].expiresAt === "number" && keys[k].expiresAt <= now) {
            delete keys[k];
        }
    }
}

function formatRemainingTime(keyEntry) {
    if (!keyEntry) return "Bitib";
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

function createKeyForUser(ownerName, durationKey = "lifetime") {
    purgeExpiredKeys();
    const normDuration = normalizeDuration(durationKey);
    const ms = DURATION_MS_MAP[normDuration];
    const newKey = "SADO-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    keys[newKey] = {
        hwid: null,
        owner: String(ownerName || "User").trim().slice(0, 40) || "User",
        expiresAt: typeof ms === "number" ? Date.now() + ms : null,
        durationLabel: DURATION_LABEL_MAP[normDuration]
    };
    return newKey;
}

function buildLoaderSnippet(keyStr) {
    const base = getBaseUrl();
    return `script_key = "${keyStr}"\nlocal hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${base}/loader?key=" .. script_key .. "&hwid=" .. hwid))()`;
}

function buildControlPanelMessage(guildName = "SADOPROTECT") {
    const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle('SADOPROTECT Control Panel')
        .setDescription(
            `This control panel is for the project:\n**SADOPROTECT**\n` +
            `If you're a buyer, click on the buttons below to redeem your key, get the script or get your role`
        )
        .setFooter({ text: `${guildName} • SADOPROTECT` });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('sado_redeem_key')
            .setLabel('Redeem Key')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('sado_get_script')
            .setLabel('Get Script')
            .setStyle(ButtonStyle.Primary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('sado_get_role')
            .setLabel('Get Role')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('sado_reset_hwid')
            .setLabel('Reset HWID')
            .setStyle(ButtonStyle.Secondary)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('sado_get_stats')
            .setLabel('Get Stats')
            .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
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

    const cleanToken = String(discordConfig.token || "").trim();
    if (!discordConfig.enabled) {
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
            intents: [GatewayIntentBits.Guilds]
        });

        const commands = [
            new SlashCommandBuilder()
                .setName('panel')
                .setDescription('SADOPROTECT düyməli Control Panelini göndərir')
        ].map(cmd => cmd.toJSON());

        client.once('ready', async () => {
            botConnectionState = `Aktivdir (${client.user.tag})`;
            try {
                const rest = new REST({ version: '10' }).setToken(cleanToken);
                await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            } catch (cmdErr) {
                console.error("Slash command qeydiyyat xətası:", cmdErr.message);
            }
        });

        client.on('interactionCreate', async (interaction) => {
            try {
                purgeExpiredKeys();

                if (interaction.isChatInputCommand()) {
                    if (interaction.commandName === 'panel') {
                        const panelPayload = buildControlPanelMessage(interaction.guild?.name || "SADOPROTECT");
                        await interaction.channel.send(panelPayload);
                        await interaction.reply({
                            content: 'SADOPROTECT Control Panel kanala göndərildi.',
                            ephemeral: true
                        });
                    }
                    return;
                }

                if (interaction.isButton()) {
                    if (interaction.customId === 'sado_redeem_key') {
                        const modal = new ModalBuilder()
                            .setCustomId('modal_redeem_key')
                            .setTitle('Redeem Key — SADOPROTECT');
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

                    if (interaction.customId === 'sado_get_script') {
                        const modal = new ModalBuilder()
                            .setCustomId('modal_get_script')
                            .setTitle('Get Script — SADOPROTECT');
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

                    if (interaction.customId === 'sado_reset_hwid') {
                        const modal = new ModalBuilder()
                            .setCustomId('modal_reset_hwid')
                            .setTitle('Reset HWID — SADOPROTECT');
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

                    if (interaction.customId === 'sado_get_role') {
                        const roleId = String(discordConfig.buyerRoleId || "").trim();
                        if (!roleId) {
                            await interaction.reply({
                                content: 'Buyer Role ID paneldə təyin edilməyib.',
                                ephemeral: true
                            });
                            return;
                        }
                        if (!interaction.guild || !interaction.member) {
                            await interaction.reply({
                                content: 'Bu düymə yalnız server daxilində işləyir.',
                                ephemeral: true
                            });
                            return;
                        }
                        try {
                            await interaction.member.roles.add(roleId);
                            await interaction.reply({
                                content: `<@&${roleId}> rolu sizə verildi.`,
                                ephemeral: true
                            });
                        } catch (roleErr) {
                            await interaction.reply({
                                content: `Rol verilə bilmədi (Botun rol icazəsini yoxlayın): ${roleErr.message}`,
                                ephemeral: true
                            });
                        }
                        return;
                    }

                    if (interaction.customId === 'sado_get_stats') {
                        const activeCount = Object.keys(keys).length;
                        const boundCount = Object.values(keys).filter(k => Boolean(k.hwid)).length;
                        const embed = new EmbedBuilder()
                            .setColor(0x38bdf8)
                            .setTitle('SADOPROTECT Stats')
                            .addFields(
                                { name: 'Project', value: 'SADOPROTECT', inline: true },
                                { name: 'Active Keys', value: String(activeCount), inline: true },
                                { name: 'Bound HWIDs', value: String(boundCount), inline: true }
                            );
                        await interaction.reply({ embeds: [embed], ephemeral: true });
                        return;
                    }
                }

                if (interaction.isModalSubmit()) {
                    const submittedKey = String(interaction.fields.getTextInputValue('key_input') || "").trim();

                    if (interaction.customId === 'modal_redeem_key') {
                        if (!keys[submittedKey]) {
                            await interaction.reply({
                                content: `Key tapılmadı və ya vaxtı bitib: \`${submittedKey}\``,
                                ephemeral: true
                            });
                            return;
                        }
                        keys[submittedKey].discordUserId = interaction.user.id;
                        await interaction.reply({
                            content: `Key təsdiqləndi (\`${submittedKey}\`). Müddət: **${keys[submittedKey].durationLabel || "lifetime"}** (${formatRemainingTime(keys[submittedKey])}). Skripti almaq üçün **Get Script** düyməsinə basın.`,
                            ephemeral: true
                        });
                        return;
                    }

                    if (interaction.customId === 'modal_get_script') {
                        if (!keys[submittedKey]) {
                            await interaction.reply({
                                content: `Key tapılmadı və ya vaxtı bitib: \`${submittedKey}\``,
                                ephemeral: true
                            });
                            return;
                        }
                        const snippet = buildLoaderSnippet(submittedKey);
                        await interaction.reply({
                            content: `SADOPROTECT Loader (\`${submittedKey}\` • ${keys[submittedKey].durationLabel || "lifetime"}):\n\`\`\`lua\n${snippet}\n\`\`\``,
                            ephemeral: true
                        });
                        return;
                    }

                    if (interaction.customId === 'modal_reset_hwid') {
                        if (!keys[submittedKey]) {
                            await interaction.reply({
                                content: `Key tapılmadı və ya vaxtı bitib: \`${submittedKey}\``,
                                ephemeral: true
                            });
                            return;
                        }
                        keys[submittedKey].hwid = null;
                        await interaction.reply({
                            content: `HWID uğurla sıfırlandı: \`${submittedKey}\``,
                            ephemeral: true
                        });
                        return;
                    }
                }
            } catch (interErr) {
                console.error("Interaction xətası:", interErr.message);
            }
        });

        discordClient = client;
        await client.login(cleanToken);
    } catch (err) {
        botConnectionState = `Xəta: ${err.message || "Token səhvdir"}`;
        discordClient = null;
    }
}

app.get('/', (req, res) => {
    try {
        purgeExpiredKeys();
        const pass = req.query.pass;
        if (pass !== ADMIN_PASS) {
            return res.send(`
                <body style="background:#0b0f19;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
                    <form method="GET" style="background:#131b2e;padding:30px;border-radius:12px;text-align:center;">
                        <h2 style="color:#38bdf8;">SADO PROTECT PANEL</h2>
                        <input type="password" name="pass" placeholder="Admin Sifresi" style="padding:10px;border-radius:6px;border:none;width:200px;margin-bottom:10px;"><br>
                        <button type="submit" style="background:#0284c7;color:white;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">Daxil Ol</button>
                    </form>
                </body>
            `);
        }

        getBaseUrl(req);
        const safePassEnc = encodeURIComponent(ADMIN_PASS);
        const msgType = String(req.query.msg || "");
        let bannerHtml = "";
        if (msgType === "script_saved") {
            bannerHtml = `<div style="background:#065f46;color:#d1fae5;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Skript uğurla yadda saxlanıldı!</div>`;
        } else if (msgType === "bot_saved") {
            bannerHtml = `<div style="background:#1e3a8a;color:#dbeafe;padding:10px 14px;border-radius:8px;margin-bottom:16px;">Discord bot ayarları yeniləndi. Status: <b>${escapeHtml(botConnectionState)}</b></div>`;
        }

        let rows = "";
        for (let k in keys) {
            const safeK = escapeHtml(k);
            const safeKEnc = encodeURIComponent(k);
            const safeOwner = escapeHtml(keys[k].owner);
            const safeDuration = escapeHtml(keys[k].durationLabel || "lifetime");
            const safeRemaining = escapeHtml(formatRemainingTime(keys[k]));
            const sampleLoader = escapeHtml(buildLoaderSnippet(k));

            rows += `<tr>
                <td style="padding:10px;border-bottom:1px solid #1e293b;"><b>${safeK}</b></td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeOwner}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeDuration} <span style="color:#94a3b8;font-size:12px;">(${safeRemaining})</span></td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${keys[k].hwid ? "Baglidir" : "Gozleyir"}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">
                    <a href="/reset?pass=${safePassEnc}&key=${safeKEnc}" style="color:#fbbf24;text-decoration:none;margin-right:10px;">[HWID Sifirla]</a>
                    <a href="/delete?pass=${safePassEnc}&key=${safeKEnc}" style="color:#f87171;text-decoration:none;">[Sil]</a>
                </td>
            </tr>
            <tr>
                <td colspan="5" style="padding:8px 10px 14px 10px;border-bottom:1px solid #1e293b;background:#0f172a;">
                    <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">Istifadeci Loader Kodu:</div>
                    <pre style="margin:0;padding:8px;background:#020617;color:#38bdf8;border-radius:6px;overflow-x:auto;font-size:12px;">${sampleLoader}</pre>
                </td>
            </tr>`;
        }

        res.send(`
            <body style="background:#0b0f19;color:white;font-family:sans-serif;padding:20px;max-width:980px;margin:0 auto;">
                <h1 style="color:#38bdf8;">SADOPROTECT — Idareetme Paneli</h1>
                ${bannerHtml}

                <form action="/save-bot" method="POST" style="margin-bottom:20px;background:#131b2e;padding:16px;border-radius:10px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <h3 style="margin-top:0;color:#818cf8;">Discord Bot Qoşma Paneli</h3>
                    <div style="margin-bottom:10px;font-size:14px;color:#cbd5e1;">
                        Bot Vəziyyəti: <b>${escapeHtml(botConnectionState)}</b>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;">
                        <input type="checkbox" name="enabled" value="1" ${discordConfig.enabled ? "checked" : ""}>
                        <span>Discord Botu Aktiv Et</span>
                    </label>
                    <input type="password" name="token" value="${escapeHtml(discordConfig.token)}" placeholder="Discord Bot Token-i bura yapışdırın" style="width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;margin-bottom:10px;">
                    <input type="text" name="buyerRoleId" value="${escapeHtml(discordConfig.buyerRoleId || "")}" placeholder="Buyer Role ID (Get Role düyməsi üçün, istəyə bağlı)" style="width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;margin-bottom:10px;">
                    <button type="submit" style="background:#6366f1;color:white;border:none;padding:9px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Botu Yadda Saxla / Bağla</button>
                </form>

                <form action="/save-script" method="POST" style="margin-bottom:20px;background:#131b2e;padding:16px;border-radius:10px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <h3 style="margin-top:0;color:#38bdf8;">Qorunan Skript (Lua Kodu)</h3>
                    <textarea name="script" rows="8" placeholder="Lua skriptinizi bura yapışdırın..." style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;font-family:monospace;margin-bottom:10px;">${escapeHtml(scriptCode)}</textarea>
                    <button type="submit" style="background:#0284c7;color:white;border:none;padding:9px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Skripti Yadda Saxla</button>
                </form>

                <form action="/create" method="GET" style="margin-bottom:20px;background:#131b2e;padding:15px;border-radius:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <input type="text" name="owner" placeholder="Istifadeci adi" required style="padding:8px;border-radius:6px;border:none;">
                    <select name="duration" style="padding:8px;border-radius:6px;border:none;background:#020617;color:white;">
                        <option value="1h">1 hour</option>
                        <option value="5h">5 hours</option>
                        <option value="24h">24 hours</option>
                        <option value="3d">3 day</option>
                        <option value="7d">7 day</option>
                        <option value="lifetime" selected>lifetime</option>
                    </select>
                    <button type="submit" style="background:#10b981;color:white;border:none;padding:8px 15px;border-radius:6px;font-weight:bold;cursor:pointer;">+ Yeni Key Yarat</button>
                </form>

                <table style="width:100%;background:#131b2e;border-radius:10px;border-collapse:collapse;text-align:left;overflow:hidden;">
                    <tr style="background:#1e293b;color:#38bdf8;">
                        <th style="padding:10px;">Acar (Key)</th>
                        <th style="padding:10px;">Sahibi</th>
                        <th style="padding:10px;">Muddet</th>
                        <th style="padding:10px;">Cihaz (HWID)</th>
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
        discordConfig.enabled = req.body.enabled === "1";
        if (typeof req.body.token === "string") {
            discordConfig.token = req.body.token.trim();
        }
        if (typeof req.body.buyerRoleId === "string") {
            discordConfig.buyerRoleId = req.body.buyerRoleId.trim();
        }
        await startDiscordBot();
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=bot_saved');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.post('/save-script', (req, res) => {
    try {
        if (req.body.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        if (typeof req.body.script === "string") {
            scriptCode = req.body.script;
        }
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS) + '&msg=script_saved');
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/create', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        createKeyForUser(req.query.owner, req.query.duration);
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/reset', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        if (keys[req.query.key]) keys[req.query.key].hwid = null;
        res.redirect('/?pass=' + encodeURIComponent(ADMIN_PASS));
    } catch (err) {
        res.status(500).send("Xeta bas verdi");
    }
});

app.get('/delete', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        delete keys[req.query.key];
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

        const keyEntry = userKey ? keys[userKey] : null;
        if (!keyEntry) {
            return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: Key vaxti bitib ve ya yanlisdir!")');
        }

        if (typeof keyEntry.expiresAt === "number" && keyEntry.expiresAt <= Date.now()) {
            delete keys[userKey];
            return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: Key vaxti bitib! Key silindi.")');
        }

        if (!keyEntry.hwid) {
            if (!userHwid) {
                return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: HWID tapilmadi!")');
            }
            keyEntry.hwid = userHwid;
        } else if (keyEntry.hwid !== userHwid) {
            return res.send('game.Players.LocalPlayer:Kick("SADOPROTECT: HWID uyğunsuzluğu!")');
        }

        res.type('text/plain').send(scriptCode);
    } catch (err) {
        res.status(500).send("-- SADOPROTECT: Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SADOPROTECT Aktivdir!"));
