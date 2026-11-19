const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_PASS = "SADO2026";
const REAL_SCRIPT_URL = "https://raw.githubusercontent.com/sabrainrot760-hue/SADO-HUB/main/SADO_HUB.lua";

let keys = {
    "SADO-FREE-KEY": { hwid: null, owner: "Test User" }
};

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeLuaString(str) {
    return String(str || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, " ")
        .replace(/\r/g, " ");
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

        let rows = "";
        for (let k in keys) {
            const safeK = escapeHtml(k);
            const safeKEnc = encodeURIComponent(k);
            const safePassEnc = encodeURIComponent(ADMIN_PASS);
            const safeOwner = escapeHtml(keys[k].owner);
            rows += `<tr>
                <td style="padding:10px;border-bottom:1px solid #1e293b;"><b>${safeK}</b></td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${safeOwner}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">${keys[k].hwid ? "Baglidir" : "Gozleyir"}</td>
                <td style="padding:10px;border-bottom:1px solid #1e293b;">
                    <a href="/reset?pass=${safePassEnc}&key=${safeKEnc}" style="color:#fbbf24;text-decoration:none;margin-right:10px;">[HWID Sifirla]</a>
                    <a href="/delete?pass=${safePassEnc}&key=${safeKEnc}" style="color:#f87171;text-decoration:none;">[Sil]</a>
                </td>
            </tr>`;
        }

        res.send(`
            <body style="background:#0b0f19;color:white;font-family:sans-serif;padding:20px;">
                <h1 style="color:#38bdf8;">SADO PROTECT — Idareetme Paneli</h1>
                <form action="/create" method="GET" style="margin-bottom:20px;background:#131b2e;padding:15px;border-radius:8px;">
                    <input type="hidden" name="pass" value="${escapeHtml(ADMIN_PASS)}">
                    <input type="text" name="owner" placeholder="Istifadeci adi" required style="padding:8px;border-radius:5px;border:none;">
                    <button type="submit" style="background:#10b981;color:white;border:none;padding:8px 15px;border-radius:5px;font-weight:bold;cursor:pointer;">+ Yeni Key Yarat</button>
                </form>
                <table style="width:100%;background:#131b2e;border-radius:8px;border-collapse:collapse;text-align:left;">
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

app.get('/create', (req, res) => {
    try {
        if (req.query.pass !== ADMIN_PASS) return res.status(403).send("Icase yoxdur!");
        const newKey = "SADO-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        keys[newKey] = { hwid: null, owner: String(req.query.owner || "User").slice(0, 40) };
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

        res.send(`loadstring(game:HttpGet("${escapeLuaString(REAL_SCRIPT_URL)}"))()`);
    } catch (err) {
        res.status(500).send("-- SADO PROTECT: Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SADO PROTECT Aktivdir!"));
