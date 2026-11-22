// ... existing code ...
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('[SADO PROTECT] Slash əmrləri qeydiyyata alındı.');
}

async function fetchAndCacheDiscordUser(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    if (client && client.isReady()) {
        try {
            const u = await client.users.fetch(uid, { force: false });
            if (u) {
                await recordDiscordUserProfile(u);
                return state.userProfiles[uid] || null;
            }
        } catch (_) {}
    }
    return state.userProfiles[uid] || null;
}

async function syncAllPanelsForScript(scriptObj) {
    if (!client || !client.isReady() || !scriptObj) return;
    const sid = String(scriptObj.id);
    const matchingPanels = state.panels.filter((p) => String(p.scriptId) === sid);
    for (const p of matchingPanels) {
        try {
            const ch = await client.channels.fetch(p.channelId);
            if (!ch || !ch.isTextBased()) continue;
            const msg = await ch.messages.fetch(p.messageId);
            if (!msg) continue;
            const embed = buildPanelEmbed(scriptObj, p.title || null);
            const components = buildPanelComponents();
            await msg.edit({ embeds: [embed], components });
        } catch (_) {}
    }
}

function createDiscordClient() {
    const c = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
        partials: [Partials.Channel, Partials.Message]
    });

    c.once('ready', async () => {
        console.log(`[SADO PROTECT] Bot aktivdir: ${c.user.tag}`);
        try {
            await registerSlashCommands(runtimeBotToken);
        } catch (err) {
            console.error('[SADO PROTECT] Slash command qeydiyyat xətası:', err.message);
        }
    });
// ... existing code ...
    c.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.user) {
                await recordDiscordUserProfile(interaction.user);
            }

            if (interaction.isAutocomplete()) {
                const focused = String(interaction.options.getFocused() || '').toLowerCase();
                const choices = state.scripts
                    .filter((s) =>
                        String(s.name || '').toLowerCase().includes(focused) ||
                        String(s.id || '').toLowerCase().includes(focused)
                    )
                    .slice(0, 25)
                    .map((s) => ({
                        name: `${s.name} (${s.id})`.slice(0, 100),
                        value: String(s.id)
                    }));
                await interaction.respond(choices).catch(() => {});
                return;
            }

            if (interaction.isChatInputCommand()) {
                const { commandName } = interaction;
// ... existing code ...
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
            opt.setName('script').setDescription('Panelin bağlı olacağı skript').setAutocomplete(true).setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('title').setDescription('Panel başlığı').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('Seçilmiş skript üçün key yaradır')
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript seçin').setAutocomplete(true).setRequired(false)
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
            opt.setName('script').setDescription('Skript seçin').setAutocomplete(true).setRequired(false)
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
            opt.setName('script').setDescription('Skript seçin').setAutocomplete(true).setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('İstifadəçinin seçilmiş skript üzrə HWID-ini sıfırlayır')
        .addUserOption((opt) =>
            opt.setName('user').setDescription('HWID sıfırlanacaq istifadəçi').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript seçin').setAutocomplete(true).setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('cooldownhwid')
        .setDescription('Skript üçün HWID reset cooldown vaxtını təyin edir')
        .addStringOption((opt) =>
            opt.setName('duration').setDescription('Cooldown vaxtı (0 = yoxdur, 10m, 1h, 1d)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('script').setDescription('Skript seçin').setAutocomplete(true).setRequired(false)
        )
].map((cmd) => cmd.toJSON());
// ... existing code ...
async function startOrRestartBot(newToken = null) {
    if (newToken !== null) {
        runtimeBotToken = String(newToken || '').trim();
        state.savedBotToken = runtimeBotToken;
        persistState();
    }
    if (client) {
        try {
            await client.destroy();
        } catch (_) {}
        client = null;
    }
    if (!runtimeBotToken) {
        return { ok: false, message: 'DISCORD_BOT_TOKEN təyin edilməyib.' };
    }
    client = createDiscordClient();
    const readyPromise = new Promise((resolve) => {
        const timer = setTimeout(resolve, 6000);
        client.once('ready', () => {
            clearTimeout(timer);
            resolve();
        });
    });
    await client.login(runtimeBotToken);
    await readyPromise;
    return {
        ok: true,
        message: client && client.user ? `Discord bot aktivdir: ${client.user.tag}` : 'Discord bot qoşuldu!'
    };
}
// ... existing code ...
      <div class="card">
        <h3>Yeni Skript Əlavə Et</h3>
        <div><label>Skript Adı</label><input id="sName" placeholder="Məs: SADO HUB, SAE, Duel" /></div>
        <div><label>Lua Kodu</label><textarea id="sCode" placeholder="print('Salam Roblox!')"></textarea></div>
        <div><label>Və ya .lua / .txt Fayl Seçin</label><input id="sFile" type="file" accept=".lua,.txt" /></div>
        <button type="button" id="addScriptBtn" class="action">Skripti Saxla</button>
        <hr style="border:0;border-top:1px solid var(--border);margin:4px 0;" />
        <h4>Yaradılmış Skriptlər</h4>
        <div id="scriptList" style="display:grid;gap:8px;">Yüklənir...</div>
        <div id="editScriptBox" style="display:none;background:var(--surface-2);border:1px solid var(--primary);padding:12px;border-radius:12px;gap:8px;">
          <h4 style="color:#a5b4fc;">Skripti Yenilə (Update)</h4>
          <input type="hidden" id="editScriptId" />
          <div><label>Yeni Skript Adı</label><input id="editScriptName" /></div>
          <div><label>Yeni Lua Kodu</label><textarea id="editScriptCode"></textarea></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <button type="button" id="saveEditScriptBtn" class="action green">Dəyişikliyi Saxla</button>
            <button type="button" id="cancelEditScriptBtn" class="action">Ləğv Et</button>
          </div>
        </div>
      </div>
// ... existing code ...
      const opts = (d.scripts || []).map(s => '<option value="' + escHtml(s.id) + '">' + escHtml(s.name) + '</option>').join('') || '<option value="">Skript yoxdur</option>';
      document.getElementById('kScript').innerHTML = opts;
      document.getElementById('wScript').innerHTML = opts;

      window.__scriptsCache = d.scripts || [];
      document.getElementById('scriptList').innerHTML = (d.scripts || []).length
        ? d.scripts.map(s =>
            '<div class="user-row" style="justify-content:space-between;">' +
              '<div><div><b>' + escHtml(s.name) + '</b></div><div style="color:var(--muted);font-size:11px;">ID: ' + escHtml(s.id) + '</div></div>' +
              '<div style="display:flex;gap:6px;">' +
                '<button type="button" class="pill-btn" style="padding:6px 10px;" onclick="openEditScript(\'' + escHtml(s.id) + '\')">Update</button>' +
                '<button type="button" class="pill-btn" style="padding:6px 10px;border-color:rgba(239,68,68,.5);color:#fca5a5;" onclick="deleteScript(\'' + escHtml(s.id) + '\')">Sil</button>' +
              '</div>' +
            '</div>'
          ).join('')
        : '<div style="color:var(--muted);font-size:13px;">Hələ skript yaradılmayıb.</div>';

      guildsCache = d.guilds || [];
// ... existing code ...
      document.getElementById('sName').value = '';
      document.getElementById('sCode').value = '';
      refreshState();
    }
  });

  window.openEditScript = function(id) {
    const sc = (window.__scriptsCache || []).find(x => String(x.id) === String(id));
    if (!sc) return;
    document.getElementById('editScriptId').value = sc.id;
    document.getElementById('editScriptName').value = sc.name || '';
    document.getElementById('editScriptCode').value = sc.code || '';
    document.getElementById('editScriptBox').style.display = 'grid';
  };

  document.getElementById('cancelEditScriptBtn').addEventListener('click', () => {
    document.getElementById('editScriptBox').style.display = 'none';
  });

  document.getElementById('saveEditScriptBtn').addEventListener('click', async () => {
    const id = document.getElementById('editScriptId').value;
    const name = document.getElementById('editScriptName').value;
    const code = document.getElementById('editScriptCode').value;
    const r = await fetch('/api/scripts/update', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ id, name, code, token: panelToken })
    });
    const d = await r.json();
    out(d.ok ? 'Skript və Discord paneli yeniləndi: ' + d.script.name : (d.message || 'Yenilənmə xətası'));
    if (d.ok) {
      document.getElementById('editScriptBox').style.display = 'none';
      refreshState();
    }
  });

  window.deleteScript = async function(id) {
    const r = await fetch('/api/scripts/delete', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ id, token: panelToken })
    });
    const d = await r.json();
    out(d.ok ? 'Skript silindi.' : (d.message || 'Silmə xətası'));
    if (d.ok) refreshState();
  };

  document.querySelectorAll('#dropPills .pill-btn').forEach(btn => {
// ... existing code ...
                    scripts: state.scripts.map((s) => ({
                        id: s.id,
                        name: s.name,
                        code: s.code || '',
                        disabled: Boolean(s.disabled),
                        createdAt: s.createdAt
                    })),
                    keysCount: state.keys.length,
// ... existing code ...
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

        if (reqUrl.pathname === '/api/scripts/update' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    if (!checkPanelAuth(req, reqUrl, data)) {
                        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, authRequired: true, message: 'Token yanlışdır.' }));
                        return;
                    }
                    const sc = findScriptById(data.id);
                    if (!sc) {
                        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                        return;
                    }
                    const newName = String(data.name || '').trim();
                    if (newName) sc.name = newName;
                    if (data.code !== undefined) sc.code = String(data.code);
                    state.keys.forEach((k) => {
                        if (String(k.scriptId) === String(sc.id)) k.scriptName = sc.name;
                    });
                    persistState();
                    await syncAllPanelsForScript(sc);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, script: sc }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Skript yenilənərkən xəta baş verdi.' }));
                }
            });
            return;
        }

        if (reqUrl.pathname === '/api/scripts/delete' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    if (!checkPanelAuth(req, reqUrl, data)) {
                        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, authRequired: true, message: 'Token yanlışdır.' }));
                        return;
                    }
                    const sid = String(data.id || '');
                    state.scripts = state.scripts.filter((s) => String(s.id) !== sid);
                    persistState();
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Skript silinərkən xəta baş verdi.' }));
                }
            });
            return;
        }
// ... existing code ...
        if (reqUrl.pathname === '/api/whitelist' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    if (!checkPanelAuth(req, reqUrl, data)) {
                        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: false, authRequired: true, message: 'Token yanlışdır və ya daxil edilməyib.' }));
                        return;
                    }
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
                    await fetchAndCacheDiscordUser(userId);
                    const wlRes = ensureAutoWhitelistKey(scriptObj, userId, durationMs || null, 'web-panel');
                    await fetchAndCacheDiscordUser(userId);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, key: wlRes.keyEntry.key, alreadyHadKey: wlRes.alreadyHadKey }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, message: 'Whitelist xətası.' }));
                }
            });
            return;
        }
// ... existing code ...
