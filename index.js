const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= AYARLAR =================
const ADMIN_PASS = "SADO2026";
let scriptCode = `-- SADO HUB Script\nprint("SADO PROTECT Aktivdir!")`;

let discordConfig = {
    enabled: false,
    token: "",
    status: "idle"
};
// ===========================================

let keys = {
    "SADO-FREE-KEY": { hwid: null, owner: "Test User" }
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
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host');
    return `${protocol}://${host}`;
}

function createKeyForUser(ownerName) {
    const newKey = "SADO-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    keys[newKey] = {
        hwid: null,
        owner: String(ownerName || "User").trim().slice(0, 40) || "User"
    };
    return newKey;
}

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
                .setName('genkey')
                .setDescription('Yeni SADO PROTECT key yaradır')
                .addStringOption(opt =>
                    opt.setName('owner')
                        .setDescription('İstifadəçi adı')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('resethwid')
                .setDescription('Key-in HWID kilidini sıfırlayır')
                .addStringOption(opt =>
                    opt.setName('key')
                        .setDescription('Key kodu (məs: SADO-ABC123)')
                        .setRequired(true)
                )
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
            if (!interaction.isChatInputCommand()) return;

            if (interaction.commandName === 'genkey') {
                const owner = interaction.options.getString('owner', true);
                const createdKey = createKeyForUser(owner);
                await interaction.reply({
                    content: `Yeni Key yaradıldı!\n**Key:** \`${createdKey}\`\n**Sahibi:** ${owner}`,
                    ephemeral: true
                });
            } else if (interaction.commandName === 'resethwid') {
                const targetKey = interaction.options.getString('key', true).trim();
                if (!keys[targetKey]) {
                    await interaction.reply({
                        content: `Belə bir Key tapılmadı: \`${targetKey}\``,
                        ephemeral: true
                    });
                    return;
                }
                keys[targetKey].hwid = null;
                await interaction.reply({
                    content: `HWID sıfırlandı: \`${targetKey}\``,
                    ephemeral: true
                });
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

        const baseUrl = getBaseUrl(req);
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
            const sampleLoader = escapeHtml(`script_key = "${k}"\nlocal hwid = game:GetService("RbxAnalyticsService"):GetClientId()\nloadstring(game:HttpGet("${baseUrl}/loader?key=" .. script_key .. "&hwid=" .. hwid))()`);

            rows += `<tr>
                <td style="padding:10px;border-bottom:1px solid #1e293b;"><b>${safeK}</b></td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeOwner}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${keys[k].hwid ? "Baglidir" : "Gozleyir"}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">
                    <a href="/reset?pass=${safePassEnc}&key=${safeKEnc}" style="color:#fbbf24;text-decoration:none;margin-right:10px;">[HWID Sifirla]</a>
                    <a href="/delete?pass=${safePassEnc}&key=${safeKEnc}" style="color:#f87171;text-decoration:none;">[Sil]</a>
                </td>
            </tr>
            <tr>
                <td colspan="4" style="padding:8px 10px 14px 10px;border-bottom:1px solid #1e293b;background:#0f172a;">
                    <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">Istifadeci Loader Kodu:</div>
                    <pre style="margin:0;padding:8px;background:#020617;color:#38bdf8;border-radius:6px;overflow-x:auto;font-size:12px;">${sampleLoader}</pre>
                </td>
            </tr>`;
        }

        res.send(`
            <body style="background:#0b0f19;color:white;font-family:sans-serif;padding:20px;max-width:960px;margin:0 auto;">
                <h1 style="color:#38bdf8;">SADO PROTECT — Idareetme Paneli</h1>
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
                    <button type="submit" style="background:#6366f1;color:white;border:none;padding:9px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Botu Yadda Saxla / Bağla</button>
                </form>

                <form action="/save-script" method="POST" style="margin-bottom:20px;background:#131b2e;padding:16px;border-radius:10px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <h3 style="margin-top:0;color:#38bdf8;">Qorunan Skript (Lua Kodu)</h3>
                    <textarea name="script" rows="8" placeholder="Lua skriptinizi bura yapışdırın..." style="width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e2e8f0;font-family:monospace;margin-bottom:10px;">${escapeHtml(scriptCode)}</textarea>
                    <button type="submit" style="background:#0284c7;color:white;border:none;padding:9px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Skripti Yadda Saxla</button>
                </form>

                <form action="/create" method="GET" style="margin-bottom:20px;background:#131b2e;padding:15px;border-radius:10px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <input type="text" name="owner" placeholder="Istifadeci adi" required style="padding:8px;border-radius:6px;border:none;margin-right:8px;">
                    <button type="submit" style="background:#10b981;color:white;border:none;padding:8px 15px;border-radius:6px;font-weight:bold;cursor:pointer;">+ Yeni Key Yarat</button>
                </form>

                <table style="width:100%;background:#131b2e;border-radius:10px;border-collapse:collapse;text-align:left;overflow:hidden;">
                    <tr style="background:#1e293b;color:#38bdf8;">
                        <th style="padding:10px;">Acar (Key)</th>
                        <th style="padding:10px;">Sahibi</th>
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
        createKeyForUser(req.query.owner);
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
        const userKey = String(req.query.key || "").trim();
        const userHwid = String(req.query.hwid || "").trim();
        const userAgent = String(req.headers['user-agent'] || "");

        if (!userAgent.includes("Roblox")) {
            return res.status(403).send("-- SADO PROTECT: Access Denied!");
        }

        if (!userKey || !keys[userKey]) {
            return res.send('game.Players.LocalPlayer:Kick("SADO PROTECT: Yanlis Key!")');
        }

        if (!keys[userKey].hwid) {
            if (!userHwid) {
                return res.send('game.Players.LocalPlayer:Kick("SADO PROTECT: HWID tapilmadi!")');
            }
            keys[userKey].hwid = userHwid;
        } else if (keys[userKey].hwid !== userHwid) {
            return res.send('game.Players.LocalPlayer:Kick("SADO PROTECT: HWID uyğunsuzluğu!")');
        }

        res.type('text/plain').send(scriptCode);
    } catch (err) {
        res.status(500).send("-- SADO PROTECT: Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SADO PROTECT Aktivdir!"));
