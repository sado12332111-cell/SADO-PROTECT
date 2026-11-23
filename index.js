const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionFlagsBits,
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
    StringSelectMenuOptionBuilder
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(
    process.env.PUBLIC_BASE_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '');
const PANEL_TOKEN = String(process.env.PANEL_TOKEN || '').trim();
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 4 * 60 * 1000);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'state.backup.json');
const TMP_FILE = path.join(DATA_DIR, '.state.tmp.json');

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const JSONBIN_ID = String(process.env.JSONBIN_BIN_ID || '').trim();
const JSONBIN_KEY = String(process.env.JSONBIN_MASTER_KEY || '').trim();
const CLOUD_KEY = String(process.env.SADO_CLOUD_KEY || 'sado_protect_state_v2').trim();

let runtimeBotToken = String(
    process.env.DISCORD_BOT_TOKEN ||
        process.env.BOT_TOKEN ||
        process.env.SPEED_BOT_TOKEN ||
        ''
).trim();
let client = null;
let botBootPromise = null;
let cloudSaveTimer = null;

function createDefaultState() {
    return {
        savedBotToken: '',
        workspaces: {},
        scripts: [],
        keys: [],
        whitelists: [],
        panels: [],
        hwidCooldowns: {},
        lastHwidReset: {},
        guildSettings: {},
        userProfiles: {},
        panelButtonConfig: {
            embedColor: '#5865F2',
            redeemLabel: 'Redeem Key',
            redeemEmoji: '🔑',
            redeemStyle: 'Success',
            getScriptLabel: 'Get Script',
            getScriptEmoji: '📜',
            getScriptStyle: 'Primary',
            resetHwidLabel: 'Reset HWID',
            resetHwidEmoji: '🔄',
            resetHwidStyle: 'Secondary',
            getStatsLabel: 'Get Stats',
            getStatsEmoji: '📊',
            getStatsStyle: 'Secondary'
        }
    };
}

let state = createDefaultState();

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function writeStateToPath(targetPath, tmpPath, serialized) {
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, targetPath);
}

function tryReadStateJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
}

async function pushStateToCloud(serialized) {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
        try {
            await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(CLOUD_KEY)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${UPSTASH_TOKEN}`,
                    'Content-Type': 'text/plain; charset=utf-8'
                },
                body: serialized
            });
        } catch (err) {
            console.error('[SADO PROTECT] Upstash bulud yazma xətası:', err.message);
        }
    }
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}`, {
                method: 'PUT',
                headers: {
                    'X-Master-Key': JSONBIN_KEY,
                    'Content-Type': 'application/json'
                },
                body: serialized
            });
        } catch (err) {
            console.error('[SADO PROTECT] JSONBin bulud yazma xətası:', err.message);
        }
    }
}

async function pullStateFromCloud() {
    if (UPSTASH_URL && UPSTASH_TOKEN) {
        try {
            const resp = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CLOUD_KEY)}`, {
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && typeof data.result === 'string' && data.result.trim()) {
                    const parsed = JSON.parse(data.result);
                    if (parsed && typeof parsed === 'object') return parsed;
                }
            }
        } catch (err) {
            console.error('[SADO PROTECT] Upstash bulud oxuma xətası:', err.message);
        }
    }
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            const resp = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}/latest`, {
                headers: { 'X-Master-Key': JSONBIN_KEY }
            });
            if (resp.ok) {
                const data = await resp.json();
                const rec = data && data.record;
                if (rec && typeof rec === 'object') return rec;
            }
        } catch (err) {
            console.error('[SADO PROTECT] JSONBin bulud oxuma xətası:', err.message);
        }
    }
    return null;
}

function scheduleCloudPersist(serialized) {
    if ((!UPSTASH_URL || !UPSTASH_TOKEN) && (!JSONBIN_ID || !JSONBIN_KEY)) return;
    if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => {
        pushStateToCloud(serialized);
    }, 350);
}

function persistState() {
    ensureDataDir();
    try {
        const serialized = JSON.stringify(state, null, 2);
        writeStateToPath(DATA_FILE, TMP_FILE, serialized);
        try {
            writeStateToPath(BACKUP_FILE, `${TMP_FILE}.bak`, serialized);
        } catch (bakErr) {
            console.error('[SADO PROTECT] Backup yazılarkən xəta:', bakErr.message);
        }
        scheduleCloudPersist(serialized);
    } catch (err) {
        console.error('[SADO PROTECT] State yazılarkən xəta:', err.message);
    }
}

function applyLoadedObject(parsed) {
    state = {
        ...createDefaultState(),
        ...parsed
    };
    state.savedBotToken = String(state.savedBotToken || '').trim();
    if (!runtimeBotToken && state.savedBotToken) {
        runtimeBotToken = state.savedBotToken;
    }
    state.workspaces = state.workspaces && typeof state.workspaces === 'object' ? state.workspaces : {};
    state.scripts = Array.isArray(state.scripts) ? state.scripts : [];
    state.keys = Array.isArray(state.keys) ? state.keys : [];
    state.whitelists = Array.isArray(state.whitelists) ? state.whitelists : [];
    state.panels = Array.isArray(state.panels) ? state.panels : [];
    state.hwidCooldowns = state.hwidCooldowns && typeof state.hwidCooldowns === 'object' ? state.hwidCooldowns : {};
    state.lastHwidReset = state.lastHwidReset && typeof state.lastHwidReset === 'object' ? state.lastHwidReset : {};
    state.guildSettings = state.guildSettings && typeof state.guildSettings === 'object' ? state.guildSettings : {};
    state.userProfiles = state.userProfiles && typeof state.userProfiles === 'object' ? state.userProfiles : {};
    state.panelButtonConfig = {
        ...createDefaultState().panelButtonConfig,
        ...(parsed.panelButtonConfig && typeof parsed.panelButtonConfig === 'object'
            ? parsed.panelButtonConfig
            : {})
    };
}

function loadState() {
    ensureDataDir();
    try {
        let parsed = tryReadStateJson(DATA_FILE);
        if (!parsed) {
            parsed = tryReadStateJson(BACKUP_FILE);
            if (parsed) {
                console.log('[SADO PROTECT] Əsas fayl boş/yoxdur, ehtiyat nüsxədən bərpa edildi.');
            }
        }
        if (parsed) {
            applyLoadedObject(parsed);
            persistState();
        } else {
            persistState();
        }
    } catch (err) {
        console.error('[SADO PROTECT] State oxunarkən xəta:', err.message);
        state = createDefaultState();
    }
}

async function hydrateFromCloudIfAvailable() {
    const cloudParsed = await pullStateFromCloud();
    if (!cloudParsed) return;
    const localCount = state.scripts.length + state.keys.length + state.whitelists.length;
    const cloudCount =
        (Array.isArray(cloudParsed.scripts) ? cloudParsed.scripts.length : 0) +
        (Array.isArray(cloudParsed.keys) ? cloudParsed.keys.length : 0) +
        (Array.isArray(cloudParsed.whitelists) ? cloudParsed.whitelists.length : 0);

    if (cloudCount > 0 || localCount === 0) {
        applyLoadedObject(cloudParsed);
        const serialized = JSON.stringify(state, null, 2);
        writeStateToPath(DATA_FILE, TMP_FILE, serialized);
        writeStateToPath(BACKUP_FILE, `${TMP_FILE}.bak`, serialized);
        console.log('[SADO PROTECT] Bulud yaddaşından bütün whitelist, skript və key-lər bərpa edildi.');
    }
}

loadState();

function nowMs() {
    return Date.now();
}

function generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function generateKeyCode() {
    const a = crypto.randomBytes(3).toString('hex').toUpperCase();
    const b = crypto.randomBytes(3).toString('hex').toUpperCase();
    const c = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `SADO-${a}-${b}-${c}`;
}

function obfuscateLuaSource(source, level = 'standard') {
    const raw = String(source || '');
    if (!raw.trim()) return raw;

    const keyBytes = Array.from(crypto.randomBytes(16));
    const inputBuf = Buffer.from(raw, 'utf8');
    const encodedNums = new Array(inputBuf.length);
    for (let i = 0; i < inputBuf.length; i++) {
        const k = keyBytes[i % keyBytes.length];
        const mixed = ((inputBuf[i] ^ k) + (i % 251)) & 0xff;
        encodedNums[i] = mixed;
    }

    const rName = () => `_0x${crypto.randomBytes(4).toString('hex')}`;
    const vKey = rName();
    const vData = rName();
    const vOut = rName();
    const vIdx = rName();
    const vByte = rName();
    const vChar = rName();
    const vConcat = rName();
    const vLoader = rName();
    const vFn = rName();
    const vErr = rName();
    const vEnv = rName();

    const keyLiteral = `{${keyBytes.join(',')}}`;
    const dataLiteral = `{${encodedNums.join(',')}}`;

    const antiTamper =
        level === 'high'
            ? `local ${vEnv}=(getfenv and getfenv())or _ENV;if type(loadstring)~="function" and type(load)~="function" then return end;`
            : '';

    return [
        '-- Protected by SADO PROTECT Lua Obfuscator',
        '(function(...)',
        antiTamper,
        `local ${vKey}=${keyLiteral}`,
        `local ${vData}=${dataLiteral}`,
        `local ${vChar}=string.char`,
        `local ${vConcat}=table.concat`,
        `local ${vOut}={}`,
        `for ${vIdx}=1,#${vData} do`,
        `local ${vByte}=(${vData}[${vIdx}]-((${vIdx}-1)%251))%256`,
        `local _k=${vKey}[((${vIdx}-1)%#${vKey})+1]`,
        `local _r=0;local _b=1;for _j=0,7 do local _x=${vByte}%2;local _y=_k%2;if _x~=_y then _r=_r+_b end;${vByte}=math.floor(${vByte}/2);_k=math.floor(_k/2);_b=_b*2 end`,
        `${vOut}[${vIdx}]=${vChar}(_r)`,
        'end',
        `local ${vLoader}=loadstring or load`,
        `local ${vFn},${vErr}=${vLoader}(${vConcat}(${vOut}))`,
        `if not ${vFn} then error(${vErr} or "SADO Obfuscator runtime error") end`,
        `return ${vFn}(...)`,
        'end)(...)'
    ]
        .filter(Boolean)
        .join('\n');
}

function parseDurationToMs(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw || raw === '0' || raw === 'lifetime' || raw === 'perm' || raw === 'permanent') {
        return null;
    }
    const match = raw.match(/^(\d+)\s*(s|sec|m|min|h|hour|d|day|w|week|mo|month|y|year)$/);
    if (!match) {
        const plainDays = Number(raw);
        if (Number.isFinite(plainDays) && plainDays > 0) {
            return Math.round(plainDays * 24 * 60 * 60 * 1000);
        }
        return undefined;
    }
    const val = Number(match[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    const unit = match[2];
    const map = {
        s: 1000,
        sec: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        h: 3600 * 1000,
        hour: 3600 * 1000,
        d: 86400 * 1000,
        day: 86400 * 1000,
        w: 7 * 86400 * 1000,
        week: 7 * 86400 * 1000,
        mo: 30 * 86400 * 1000,
        month: 30 * 86400 * 1000,
        y: 365 * 86400 * 1000,
        year: 365 * 86400 * 1000
    };
    return val * (map[unit] || 86400 * 1000);
}

function formatExpiry(expiresAt) {
    if (!expiresAt) return 'Ömürlük (Lifetime)';
    const ts = Math.floor(Number(expiresAt) / 1000);
    return `<t:${ts}:F> (<t:${ts}:R>)`;
}

function isExpired(expiresAt) {
    return Boolean(expiresAt && Number(expiresAt) <= nowMs());
}

function getWorkspaceIdFromReq(req, reqUrl) {
    const headerWs = String(req.headers['x-workspace-id'] || '').trim();
    const queryWs = reqUrl ? String(reqUrl.searchParams.get('ws') || '').trim() : '';
    const cookieHeader = String(req.headers['cookie'] || '');
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)sado_ws_id=([a-zA-Z0-9_-]+)/);
    const cookieWs = cookieMatch ? cookieMatch[1] : '';
    const raw = headerWs || queryWs || cookieWs;
    if (raw && /^[a-zA-Z0-9_-]{8,64}$/.test(raw)) {
        return raw;
    }
    return null;
}

function ensureWorkspaceRecord(wsId, discordUserId = null, guildId = null, guildName = null) {
    if (!wsId) return null;
    if (!state.workspaces[wsId]) {
        state.workspaces[wsId] = {
            id: wsId,
            discordUserIds: [],
            guildIds: [],
            guildName: '',
            createdAt: nowMs()
        };
    }
    if (!Array.isArray(state.workspaces[wsId].discordUserIds)) {
        state.workspaces[wsId].discordUserIds = [];
    }
    if (!Array.isArray(state.workspaces[wsId].guildIds)) {
        state.workspaces[wsId].guildIds = [];
    }
    if (discordUserId) {
        const uid = String(discordUserId).trim();
        if (uid && !state.workspaces[wsId].discordUserIds.includes(uid)) {
            state.workspaces[wsId].discordUserIds.push(uid);
        }
    }
    if (guildId) {
        const gid = String(guildId).trim();
        if (gid) {
            state.workspaces[wsId].guildIds = [gid];
            const liveGuild = client && client.guilds ? client.guilds.cache.get(gid) : null;
            if (guildName) {
                state.workspaces[wsId].guildName = String(guildName).trim();
            } else if (liveGuild && liveGuild.name) {
                state.workspaces[wsId].guildName = liveGuild.name;
            }
        }
    }
    return state.workspaces[wsId];
}

function resolveWorkspaceGuildDisplay(ws) {
    if (!ws) return null;
    const gid = Array.isArray(ws.guildIds) && ws.guildIds.length > 0 ? String(ws.guildIds[0]) : '';
    if (!gid) return null;
    const liveGuild = client && client.guilds ? client.guilds.cache.get(gid) : null;
    if (liveGuild && liveGuild.name) {
        if (ws.guildName !== liveGuild.name) {
            ws.guildName = liveGuild.name;
            persistState();
        }
        return { guildId: gid, guildName: liveGuild.name, botInGuild: true };
    }
    return {
        guildId: gid,
        guildName: ws.guildName || `Sunucu (${gid})`,
        botInGuild: false
    };
}

function getWorkspaceIdForDiscordUser(discordUserId, guildId = null) {
    const gid = String(guildId || '').trim();
    if (gid) {
        for (const [wsId, ws] of Object.entries(state.workspaces || {})) {
            if (ws && Array.isArray(ws.guildIds) && ws.guildIds.includes(gid)) {
                return wsId;
            }
        }
    }
    const uid = String(discordUserId || '').trim();
    if (!uid) return null;
    for (const [wsId, ws] of Object.entries(state.workspaces || {})) {
        if (ws && Array.isArray(ws.discordUserIds) && ws.discordUserIds.includes(uid)) {
            return wsId;
        }
    }
    return null;
}

function isScriptOwnedByWorkspace(script, wsId) {
    if (!script || !wsId) return false;
    return script.ownerWorkspaceId === wsId;
}

function getScriptsForWorkspace(wsId) {
    if (!wsId) return [];
    return state.scripts.filter((s) => isScriptOwnedByWorkspace(s, wsId));
}

function getScriptsForDiscordUser(discordUserId, guildId = null) {
    const gid = String(guildId || '').trim();
    const uid = String(discordUserId || '').trim();
    const linkedWsId = getWorkspaceIdForDiscordUser(uid, gid);
    if (linkedWsId) {
        return state.scripts.filter((s) => s.ownerWorkspaceId === linkedWsId);
    }
    if (gid) {
        const byGuild = state.scripts.filter((s) => s.ownerGuildId && String(s.ownerGuildId) === gid);
        if (byGuild.length > 0) return byGuild;
    }
    const ownedByDiscord = state.scripts.filter((s) => s.ownerDiscordId && String(s.ownerDiscordId) === uid);
    if (ownedByDiscord.length > 0) return ownedByDiscord;
    return [];
}

function getScriptById(scriptId) {
    return state.scripts.find((s) => s.id === scriptId) || null;
}

function getActiveWhitelist(userId, scriptId) {
    return (
        state.whitelists.find(
            (w) =>
                w.userId === String(userId) &&
                w.scriptId === scriptId &&
                !w.revoked &&
                !isExpired(w.expiresAt)
        ) || null
    );
}

function getUserKeyForScript(userId, scriptId) {
    return (
        state.keys.find(
            (k) =>
                k.redeemedBy === String(userId) &&
                k.scriptId === scriptId &&
                !k.disabled &&
                !isExpired(k.expiresAt)
        ) || null
    );
}

function rememberUserProfile(user) {
    if (!user || !user.id) return;
    state.userProfiles[String(user.id)] = {
        id: String(user.id),
        username: user.username || '',
        tag: user.tag || user.username || String(user.id),
        updatedAt: nowMs()
    };
}

function resolveUserDisplayName(userId) {
    if (!userId) return null;
    const uid = String(userId);
    const prof = state.userProfiles[uid];
    if (prof && prof.tag) return `${prof.tag} (${uid})`;
    if (client && client.users) {
        const cached = client.users.cache.get(uid);
        if (cached) {
            rememberUserProfile(cached);
            return `${cached.tag || cached.username} (${uid})`;
        }
    }
    return uid;
}

function enrichMemberEntry(entry) {
    const uid = String(entry.userId || entry.redeemedBy || '');
    const prof = uid ? state.userProfiles[uid] : null;
    const scr = entry.scriptId ? getScriptById(entry.scriptId) : null;
    return {
        ...entry,
        username: prof ? prof.tag : null,
        redeemedByName: entry.redeemedBy ? resolveUserDisplayName(entry.redeemedBy) : null,
        createdByName: entry.createdByName || (entry.createdBy ? resolveUserDisplayName(entry.createdBy) : 'Veb Panel'),
        scriptName: scr ? scr.name : entry.scriptId || 'Naməlum'
    };
}

function getGuildSettings(guildId) {
    if (!guildId) return { allowedRoleIds: [] };
    if (!state.guildSettings[guildId]) {
        state.guildSettings[guildId] = { allowedRoleIds: [] };
    }
    return state.guildSettings[guildId];
}

function hasCommandPermission(interaction) {
    if (!interaction.guild || !interaction.member) return false;
    if (interaction.guild.ownerId === interaction.user.id) return true;
    const perms = interaction.memberPermissions;
    if (perms && perms.has(PermissionFlagsBits.Administrator)) return true;

    const settings = getGuildSettings(interaction.guild.id);
    const memberRoles = interaction.member.roles;
    if (!memberRoles) return false;

    if (Array.isArray(settings.allowedRoleIds) && settings.allowedRoleIds.length > 0) {
        return settings.allowedRoleIds.some((rid) => memberRoles.cache.has(rid));
    }

    const sortedRoles = [...interaction.guild.roles.cache.values()]
        .filter((r) => r.id !== interaction.guild.id && !r.managed)
        .sort((a, b) => b.position - a.position);
    const topTwo = sortedRoles.slice(0, 2);
    return topTwo.some((r) => memberRoles.cache.has(r.id));
}

function parseButtonStyle(styleName, fallback) {
    const val = String(styleName || '').trim().toLowerCase();
    if (val === 'primary' || val === 'blue' || val === 'blurple') return ButtonStyle.Primary;
    if (val === 'success' || val === 'green') return ButtonStyle.Success;
    if (val === 'danger' || val === 'red') return ButtonStyle.Danger;
    if (val === 'secondary' || val === 'gray' || val === 'grey') return ButtonStyle.Secondary;
    return fallback;
}

function parseHexColor(hexStr, fallback = 0x5865f2) {
    const cleaned = String(hexStr || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        return parseInt(cleaned, 16);
    }
    return fallback;
}

function buildStyledButton(customId, label, emoji, style) {
    const btn = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(String(label || 'Button').slice(0, 80))
        .setStyle(style);
    const cleanEmoji = String(emoji || '').trim();
    if (cleanEmoji) {
        try {
            btn.setEmoji(cleanEmoji);
        } catch (_) {}
    }
    return btn;
}

function buildPanelComponents(scriptId) {
    const cfg = state.panelButtonConfig;
    const row = new ActionRowBuilder().addComponents(
        buildStyledButton(
            `sp_redeem:${scriptId}`,
            cfg.redeemLabel || 'Redeem Key',
            cfg.redeemEmoji,
            parseButtonStyle(cfg.redeemStyle, ButtonStyle.Success)
        ),
        buildStyledButton(
            `sp_getscript:${scriptId}`,
            cfg.getScriptLabel || 'Get Script',
            cfg.getScriptEmoji,
            parseButtonStyle(cfg.getScriptStyle, ButtonStyle.Primary)
        ),
        buildStyledButton(
            `sp_resethwid:${scriptId}`,
            cfg.resetHwidLabel || 'Reset HWID',
            cfg.resetHwidEmoji,
            parseButtonStyle(cfg.resetHwidStyle, ButtonStyle.Secondary)
        ),
        buildStyledButton(
            `sp_getstats:${scriptId}`,
            cfg.getStatsLabel || 'Get Stats',
            cfg.getStatsEmoji,
            parseButtonStyle(cfg.getStatsStyle, ButtonStyle.Secondary)
        )
    );
    return [row];
}

function buildPanelEmbed(panelTitle, script) {
    const cfg = state.panelButtonConfig;
    const rLabel = cfg.redeemLabel || 'Redeem Key';
    const gLabel = cfg.getScriptLabel || 'Get Script';
    const hLabel = cfg.resetHwidLabel || 'Reset HWID';
    const sLabel = cfg.getStatsLabel || 'Get Stats';
    const resolvedTitle = String(panelTitle || '').trim() || (script && script.name ? script.name : 'SCRIPT PANEL');
    return new EmbedBuilder()
        .setTitle(resolvedTitle)
        .setDescription(
            `Skript: **${script.name}**\n` +
                `• Key aktivləşdirmək üçün **${rLabel}**\n` +
                `• Qısa skripti almaq üçün **${gLabel}**\n` +
                `• Cihazı sıfırlamaq üçün **${hLabel}**\n` +
                `• Key və HWID məlumatına baxmaq üçün **${sLabel}**`
        )
        .setColor(parseHexColor(cfg.embedColor, 0x5865f2))
        .setFooter({ text: 'SADO PROTECT • Hər skriptə ayrı whitelist və 1 nəfərlik key sistemi' })
        .setTimestamp();
}

function buildLoaderSnippet(baseUrl, scriptId, userId, token, licenseKey) {
    const cleanBase = String(baseUrl || PUBLIC_BASE_URL).replace(/\/+$/, '');
    const url = `${cleanBase}/raw/${encodeURIComponent(scriptId)}?uid=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
    const safeKey = String(licenseKey || 'WHITELIST').replace(/"/g, '\\"');
    return `script_key = "${safeKey}"\nloadstring(game:HttpGet("${url}"))()`;
}

function ensureUserLoaderToken(userId, scriptId) {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return null;

    const wl = getActiveWhitelist(cleanUserId, scriptId);
    const keyRecord = getUserKeyForScript(cleanUserId, scriptId);

    if (!wl && !keyRecord) {
        return null;
    }

    if (wl) {
        if (!wl.loaderToken) {
            wl.loaderToken = crypto.randomBytes(16).toString('hex');
            persistState();
        }
        if (typeof wl.hwidLockEpoch !== 'number') {
            wl.hwidLockEpoch = Number(keyRecord?.hwidLockEpoch || 1);
            persistState();
        }
        return wl;
    }

    const createdWl = {
        id: generateId('wl'),
        userId: cleanUserId,
        scriptId,
        expiresAt: keyRecord.expiresAt || null,
        hwid: keyRecord.hwid || null,
        hwidLockEpoch: Number(keyRecord.hwidLockEpoch || 1),
        loaderToken: crypto.randomBytes(16).toString('hex'),
        createdAt: nowMs(),
        revoked: false
    };
    state.whitelists.push(createdWl);
    persistState();
    return createdWl;
}

function ensureAutoKeyForUser(userId, scriptId, durationMs = null, creatorId = null, creatorName = 'Auto Whitelist') {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return null;
    let existing = getUserKeyForScript(cleanUserId, scriptId);
    if (existing) return existing;

    const expiresAt = durationMs ? nowMs() + durationMs : null;
    existing = {
        id: generateId('key'),
        code: generateKeyCode(),
        scriptId,
        durationMs: durationMs || null,
        expiresAt,
        createdBy: creatorId || null,
        createdByName: creatorName || 'Auto Whitelist',
        redeemedBy: cleanUserId,
        redeemedByName: resolveUserDisplayName(cleanUserId),
        redeemedAt: nowMs(),
        hwid: null,
        hwidLockEpoch: 1,
        autoGenerated: true,
        disabled: false,
        createdAt: nowMs()
    };
    state.keys.push(existing);
    return existing;
}

function resetUserHwidBinding(userId, scriptId) {
    const cleanUserId = String(userId || '').trim();
    const wl = getActiveWhitelist(cleanUserId, scriptId);
    const keyRec = getUserKeyForScript(cleanUserId, scriptId);
    const nextEpoch =
        Math.max(
            Number(wl?.hwidLockEpoch || 1),
            Number(keyRec?.hwidLockEpoch || 1)
        ) + 1;

    if (wl) {
        wl.hwid = null;
        wl.hwidLockEpoch = nextEpoch;
    }
    if (keyRec) {
        keyRec.hwid = null;
        keyRec.hwidLockEpoch = nextEpoch;
    }
}

function buildHwidGuardedLuaPayload(scriptCode, boundHwid, lockEpoch, kickReason) {
    const safeHwid = String(boundHwid || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeReason = String(kickReason || 'HWID uyğun deyil! Bu key/whitelist başqa cihaza bağlıdır. Yenidən Reset HWID edin.')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    const safeEpoch = Number(lockEpoch || 1);

    const guardHeader = [
        '-- SADO PROTECT STRICT HWID GUARD',
        `local __SADO_EXPECTED_HWID = "${safeHwid}"`,
        `local __SADO_LOCK_EPOCH = ${safeEpoch}`,
        `local __SADO_KICK_MSG = "${safeReason}"`,
        'local function __sado_get_hwid()',
        '    local ok, val = pcall(function()',
        '        if typeof(gethwid) == "function" then return gethwid() end',
        '        if getgenv and type(getgenv().gethwid) == "function" then return getgenv().gethwid() end',
        '        if syn and syn.crypto and type(syn.crypto.customhash) == "function" then',
        '            local lp = game:GetService("Players").LocalPlayer',
        '            return syn.crypto.customhash(tostring(lp and lp.UserId or ""))',
        '        end',
        '        local rbxsid = game:GetService("RbxAnalyticsService"):GetClientId()',
        '        return tostring(rbxsid or "")',
        '    end)',
        '    if ok and val and tostring(val) ~= "" then return tostring(val) end',
        '    local lp = game:GetService("Players").LocalPlayer',
        '    return "UID_" .. tostring(lp and lp.UserId or "UNKNOWN")',
        'end',
        'local function __sado_kick_now(reason)',
        '    pcall(function()',
        '        local lp = game:GetService("Players").LocalPlayer',
        '        if lp then lp:Kick(reason) end',
        '    end)',
        '    task.spawn(function()',
        '        while task.wait(0.2) do',
        '            pcall(function()',
        '                local lp = game:GetService("Players").LocalPlayer',
        '                if lp then lp:Kick(reason) end',
        '            end)',
        '        end',
        '    end)',
        '    error(reason)',
        'end',
        'local __sado_current_hwid = __sado_get_hwid()',
        'if __SADO_EXPECTED_HWID ~= "" and __sado_current_hwid ~= __SADO_EXPECTED_HWID then',
        '    __sado_kick_now(__SADO_KICK_MSG)',
        'end'
    ].join('\n');

    return `${guardHeader}\n\n${scriptCode || ''}`;
}

function extractExecutorHwid(req, reqUrl) {
    const candidates = [
        req.headers['x-hwid'],
        req.headers['syn-fingerprint'],
        req.headers['krnl-hwid'],
        req.headers['flux-fingerprint'],
        req.headers['evon-hwid'],
        req.headers['roblox-id'],
        reqUrl.searchParams.get('hwid')
    ];
    for (const c of candidates) {
        const val = String(c || '').trim();
        if (val) return val;
    }
    return '';
}

function buildFirstRunHandshakePayload(baseUrl, scriptId, userId, token, lockEpoch) {
    const cleanBase = String(baseUrl || PUBLIC_BASE_URL).replace(/\/+$/, '');
    const bindBaseUrl = `${cleanBase}/raw/${encodeURIComponent(scriptId)}?uid=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}&ep=${encodeURIComponent(lockEpoch)}`;
    return [
        '-- SADO PROTECT HWID FIRST-DEVICE BIND HANDSHAKE',
        'local function __sado_collect_hwid()',
        '    local ok, val = pcall(function()',
        '        if typeof(gethwid) == "function" then return gethwid() end',
        '        if getgenv and type(getgenv().gethwid) == "function" then return getgenv().gethwid() end',
        '        if syn and syn.crypto and type(syn.crypto.customhash) == "function" then',
        '            local lp = game:GetService("Players").LocalPlayer',
        '            return syn.crypto.customhash(tostring(lp and lp.UserId or ""))',
        '        end',
        '        local rbxsid = game:GetService("RbxAnalyticsService"):GetClientId()',
        '        return tostring(rbxsid or "")',
        '    end)',
        '    if ok and val and tostring(val) ~= "" then return tostring(val) end',
        '    local lp = game:GetService("Players").LocalPlayer',
        '    return "UID_" .. tostring(lp and lp.UserId or "UNKNOWN")',
        'end',
        'local __sado_hw = __sado_collect_hwid()',
        'local __sado_hs = game:GetService("HttpService")',
        `local __sado_url = "${bindBaseUrl}&hwid=" .. __sado_hs:UrlEncode(__sado_hw)`,
        'local __sado_src = game:HttpGet(__sado_url)',
        'local __sado_fn, __sado_err = loadstring(__sado_src)',
        'if not __sado_fn then error(__sado_err or "Load error") end',
        'return __sado_fn()'
    ].join('\n');
}

const slashCommands = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Bu kanala skript paneli yerləşdir')
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Panelin bağlı olacağı skript')
                .setAutocomplete(true)
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('title').setDescription('Panel başlığı').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('name').setDescription('Alternativ panel başlığı').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('setpanel')
        .setDescription('Bu kanala skript paneli yerləşdir')
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Panelin bağlı olacağı skript')
                .setAutocomplete(true)
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('title').setDescription('Panel başlığı').setRequired(false)
        )
        .addStringOption((opt) =>
            opt.setName('name').setDescription('Alternativ panel başlığı').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('Seçilən skript üçün 1 nəfərlik key yarat')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Müddət: 1h, 1d, 7d, 30d və ya 0 (ömürlük)').setRequired(true)
        )
        .addIntegerOption((opt) =>
            opt.setName('amount').setDescription('Key sayı (1-50)').setMinValue(1).setMaxValue(50).setRequired(false)
        )
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin (yaratdığınız skriptlər)')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('İstifadəçiyə və ya rola skript icazəsi ver')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Müddət: 1d, 7d, 30d və ya 0 (ömürlük)').setRequired(true)
        )
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(false))
        .addRoleOption((opt) => opt.setName('role').setDescription('Rol').setRequired(false))
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('İstifadəçinin və ya rolun whitelist icazəsini sil')
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(false))
        .addRoleOption((opt) => opt.setName('role').setDescription('Rol').setRequired(false))
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('Admin: istifadəçinin HWID kilidini sıfırla')
        .addUserOption((opt) => opt.setName('user').setDescription('İstifadəçi').setRequired(true))
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('cooldownhwid')
        .setDescription('Skript üçün istifadəçinin özünün HWID sıfırlama gözləmə müddəti')
        .addStringOption((opt) =>
            opt.setName('time').setDescription('Məs: 1h, 12h, 1d və ya 0 (gözləməsiz)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt
                .setName('script')
                .setDescription('Skript seçin')
                .setAutocomplete(true)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('setpermrole')
        .setDescription('Bot əmrlərini işlədə biləcək rolları təyin et')
        .addRoleOption((opt) => opt.setName('role').setDescription('İcazə verilən rol').setRequired(true))
        .addStringOption((opt) =>
            opt
                .setName('action')
                .setDescription('Əlavə et və ya sil')
                .addChoices({ name: 'Əlavə et', value: 'add' }, { name: 'Sil', value: 'remove' })
                .setRequired(false)
        )
].map((c) => c.toJSON());

async function syncSlashCommands() {
    if (!runtimeBotToken || !client || !client.user) return;
    const rest = new REST({ version: '10' }).setToken(runtimeBotToken);
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('[SADO PROTECT] Slash əmrlər sinxronizasiya olundu.');
}

const pendingSelections = new Map();
const pendingCopySnippets = new Map();

async function resolveScriptOrAsk(interaction, explicitQuery, pendingAction) {
    const userScripts = getScriptsForDiscordUser(interaction.user.id, interaction.guildId);
    if (userScripts.length === 0) {
        const msg =
            '❌ Bu sunucu üçün saytda bağlı skript tapılmadı.\n' +
            `Saytda **Discord Bot & Panel** bölməsindən bu sunucunu (\`${interaction.guild?.name || interaction.guildId || ''}\`) seçib skript yaradın.`;
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: msg });
        } else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
        return null;
    }
    if (explicitQuery) {
        const q = String(explicitQuery || '').trim().toLowerCase();
        const found =
            userScripts.find((s) => s.id.toLowerCase() === q) ||
            userScripts.find((s) => s.name.toLowerCase() === q) ||
            userScripts.find((s) => s.name.toLowerCase().includes(q)) ||
            null;
        if (!found) {
            const msg = `❌ "${explicitQuery}" adlı skript tapılmadı.`;
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: msg });
            } else {
                await interaction.reply({ content: msg, ephemeral: true });
            }
            return null;
        }
        return found;
    }
    if (userScripts.length === 1) {
        return userScripts[0];
    }

    const token = generateId('sel');
    pendingSelections.set(token, {
        ownerId: interaction.user.id,
        createdAt: nowMs(),
        ...pendingAction
    });

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`sp_select_script:${token}`)
        .setPlaceholder('Skript seçin...')
        .addOptions(
            userScripts.slice(0, 25).map((s) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(s.name.slice(0, 100))
                    .setValue(s.id)
                    .setDescription(`ID: ${s.id}`.slice(0, 100))
            )
        );

    const payload = {
        content: 'Hansı skript üçün icra edilsin?',
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
    };
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.reply(payload);
    }
    return null;
}

async function executePanelPost(channel, panelName, script) {
    const finalTitle =
        String(panelName || '').trim() ||
        (channel && channel.guild ? channel.guild.name : null) ||
        (script && script.name ? script.name : 'SCRIPT PANEL');
    const embed = buildPanelEmbed(finalTitle, script);
    const components = buildPanelComponents(script.id);
    const msg = await channel.send({ embeds: [embed], components });
    state.panels = state.panels.filter((p) => !(p.channelId === channel.id && p.scriptId === script.id));
    state.panels.push({
        id: generateId('pnl'),
        guildId: channel.guildId,
        channelId: channel.id,
        messageId: msg.id,
        scriptId: script.id,
        panelName: finalTitle,
        createdAt: nowMs()
    });
    persistState();
    return msg;
}

async function applyWhitelistForTargets(script, targetUsers, durationMs) {
    const expiresAt = durationMs ? nowMs() + durationMs : null;
    for (const u of targetUsers) {
        const uid = String(u && u.id ? u.id : u || '').trim();
        if (!uid) continue;
        rememberUserProfile(u);
        const autoKey = ensureAutoKeyForUser(
            uid,
            script.id,
            durationMs,
            null,
            'Whitelist Auto Key'
        );
        const existing = getActiveWhitelist(uid, script.id);
        if (existing) {
            existing.expiresAt = expiresAt;
            existing.revoked = false;
            if (!existing.loaderToken) {
                existing.loaderToken = crypto.randomBytes(16).toString('hex');
            }
            if (typeof existing.hwidLockEpoch !== 'number') {
                existing.hwidLockEpoch = Number(autoKey?.hwidLockEpoch || 1);
            }
        } else {
            state.whitelists.push({
                id: generateId('wl'),
                userId: uid,
                scriptId: script.id,
                expiresAt,
                hwid: autoKey?.hwid || null,
                hwidLockEpoch: Number(autoKey?.hwidLockEpoch || 1),
                loaderToken: crypto.randomBytes(16).toString('hex'),
                createdAt: nowMs(),
                revoked: false
            });
        }
    }
    persistState();
}

async function removeWhitelistForTargets(script, targetUsers) {
    const ids = new Set(
        targetUsers.map((u) => String(u && u.id ? u.id : u || '').trim()).filter(Boolean)
    );
    let count = 0;
    for (const w of state.whitelists) {
        if (w.scriptId === script.id && ids.has(w.userId) && !w.revoked) {
            w.revoked = true;
            count++;
        }
    }
    for (const k of state.keys) {
        if (k.scriptId === script.id && k.redeemedBy && ids.has(k.redeemedBy) && !k.disabled) {
            k.disabled = true;
        }
    }
    persistState();
    return count;
}

function isRobloxExecutorRequest(req) {
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    const hasExecutorHeader = Boolean(
        req.headers['roblox-id'] ||
            req.headers['syn-fingerprint'] ||
            req.headers['krnl-hwid'] ||
            req.headers['flux-fingerprint'] ||
            req.headers['evon-hwid'] ||
            req.headers['x-executor'] ||
            req.headers['x-hwid']
    );
    if (hasExecutorHeader) return true;
    if (ua.includes('roblox')) return true;
    const secFetchSite = req.headers['sec-fetch-site'];
    const secFetchMode = req.headers['sec-fetch-mode'];
    if (secFetchSite || secFetchMode) return false;
    const accept = String(req.headers['accept'] || '').toLowerCase();
    if (accept.includes('text/html')) return false;
    return false;
}

function attachBotHandlers(botClient) {
    botClient.once('ready', async () => {
        console.log(`[SADO PROTECT] Discord bot aktivdir: ${botClient.user.tag}`);
        try {
            await syncSlashCommands();
        } catch (err) {
            console.error('[SADO PROTECT] Slash command sync xətası:', err.message);
        }
    });

    botClient.on('guildCreate', (guild) => {
        if (!guild) return;
        console.log(`[SADO PROTECT] Bot yeni sunucuya qoşuldu: ${guild.name} (${guild.id})`);
        for (const ws of Object.values(state.workspaces || {})) {
            if (ws && Array.isArray(ws.guildIds) && ws.guildIds.includes(String(guild.id))) {
                ws.guildName = guild.name;
            }
        }
        persistState();
    });

    botClient.on('error', (err) => {
        console.error('[SADO PROTECT] Discord client error:', err.message);
    });

    botClient.on('shardDisconnect', () => {
        console.warn('[SADO PROTECT] Gateway bağlantısı kəsildi, yenidən qoşulur...');
    });

    botClient.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.user) rememberUserProfile(interaction.user);

            if (interaction.isAutocomplete()) {
                const focused = String(interaction.options.getFocused() || '').toLowerCase();
                const userScripts = getScriptsForDiscordUser(interaction.user.id, interaction.guildId);
                const matches = userScripts.filter(
                    (s) => !focused || s.name.toLowerCase().includes(focused) || s.id.toLowerCase().includes(focused)
                );
                const pool = matches.length > 0 ? matches : userScripts;
                const choices = pool.slice(0, 25).map((s) => ({
                    name: s.name.slice(0, 100),
                    value: s.id
                }));
                await interaction.respond(choices).catch(() => {});
                return;
            }

            if (interaction.isChatInputCommand()) {
                await interaction.deferReply({ ephemeral: true });

                if (!hasCommandPermission(interaction)) {
                    await interaction.editReply({
                        content: '❌ Bu əmri işlətmək üçün icazəniz yoxdur (Top 2 rol və ya təyin edilmiş rol lazımdır).'
                    });
                    return;
                }

                const cmd = interaction.commandName;

                if (cmd === 'setpermrole') {
                    const role = interaction.options.getRole('role', true);
                    const action = interaction.options.getString('action') || 'add';
                    const settings = getGuildSettings(interaction.guild.id);
                    if (action === 'remove') {
                        settings.allowedRoleIds = settings.allowedRoleIds.filter((id) => id !== role.id);
                        persistState();
                        await interaction.editReply({ content: `✅ <@&${role.id}> icazəli rollardan silindi.` });
                    } else {
                        if (!settings.allowedRoleIds.includes(role.id)) {
                            settings.allowedRoleIds.push(role.id);
                        }
                        persistState();
                        await interaction.editReply({ content: `✅ <@&${role.id}> bot əmrləri üçün icazəli edildi.` });
                    }
                    return;
                }

                if (cmd === 'setpanel' || cmd === 'panel') {
                    const panelName =
                        interaction.options.getString('title') ||
                        interaction.options.getString('name') ||
                        '';
                    const scriptQuery = interaction.options.getString('script');
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'setpanel',
                        panelName,
                        channelId: interaction.channelId
                    });
                    if (!script) return;
                    const defaultTitle = panelName || (interaction.guild ? interaction.guild.name : script.name);
                    await executePanelPost(interaction.channel, defaultTitle, script);
                    await interaction.editReply({
                        content: `✅ **${script.name}** üçün panel bu kanala göndərildi!`
                    });
                    return;
                }

                if (cmd === 'genkey') {
                    const timeStr = interaction.options.getString('time', true);
                    const amount = interaction.options.getInteger('amount') || 1;
                    const scriptQuery = interaction.options.getString('script');
                    const durationMs = parseDurationToMs(timeStr);
                    if (durationMs === undefined) {
                        await interaction.editReply({
                            content: '❌ Yanlış müddət formatı. Məsələn: `1h`, `1d`, `7d`, `30d` və ya `0` (ömürlük).'
                        });
                        return;
                    }
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'genkey',
                        durationMs,
                        amount,
                        creatorId: interaction.user.id,
                        creatorName: interaction.user.tag || interaction.user.username
                    });
                    if (!script) return;
                    const created = [];
                    for (let i = 0; i < amount; i++) {
                        const code = generateKeyCode();
                        state.keys.push({
                            id: generateId('key'),
                            code,
                            scriptId: script.id,
                            durationMs,
                            expiresAt: null,
                            createdBy: String(interaction.user.id),
                            createdByName: interaction.user.tag || interaction.user.username,
                            redeemedBy: null,
                            redeemedByName: null,
                            redeemedAt: null,
                            hwid: null,
                            disabled: false,
                            createdAt: nowMs()
                        });
                        created.push(code);
                    }
                    persistState();
                    await interaction.editReply({
                        content:
                            `✅ **${script.name}** üçün **${created.length}** ədəd 1 nəfərlik key yaradıldı:\n` +
                            `\`\`\`\n${created.join('\n')}\n\`\`\``
                    });
                    return;
                }

                if (cmd === 'whitelist' || cmd === 'unwhitelist') {
                    const user = interaction.options.getUser('user');
                    const role = interaction.options.getRole('role');
                    const scriptQuery = interaction.options.getString('script');
                    const timeStr = cmd === 'whitelist' ? interaction.options.getString('time', true) : '0';
                    const durationMs = cmd === 'whitelist' ? parseDurationToMs(timeStr) : null;

                    if (cmd === 'whitelist' && durationMs === undefined) {
                        await interaction.editReply({
                            content: '❌ Yanlış müddət formatı. Məs: `1d`, `7d`, `30d` və ya `0` (ömürlük).'
                        });
                        return;
                    }
                    if (!user && !role) {
                        await interaction.editReply({ content: '❌ `user` və ya `role` seçməlisiniz.' });
                        return;
                    }

                    let targets = [];
                    if (user) targets.push(user);
                    if (role) {
                        try {
                            await interaction.guild.members.fetch();
                        } catch (_) {}
                        for (const member of role.members.values()) {
                            if (member && member.user && !member.user.bot) {
                                targets.push(member.user);
                            }
                        }
                    }
                    targets = [...new Map(targets.filter((u) => u && u.id).map((u) => [String(u.id), u])).values()];

                    if (targets.length === 0) {
                        await interaction.editReply({
                            content: '❌ Seçilən istifadəçi və ya rolda whitelist ediləcək üzv tapılmadı.'
                        });
                        return;
                    }

                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: cmd,
                        targetUserIds: targets.map((u) => String(u.id)),
                        durationMs
                    });
                    if (!script) return;

                    if (cmd === 'whitelist') {
                        await applyWhitelistForTargets(script, targets, durationMs);
                        await interaction.editReply({
                            content: `✅ **${targets.length}** istifadəçi **${script.name}** skriptinə whitelist edildi.`
                        });
                    } else {
                        const removed = await removeWhitelistForTargets(script, targets);
                        await interaction.editReply({
                            content: `✅ **${script.name}** skriptindən **${removed}** whitelist qeydi silindi.`
                        });
                    }
                    return;
                }

                if (cmd === 'resethwid') {
                    const user = interaction.options.getUser('user', true);
                    const scriptQuery = interaction.options.getString('script');
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'resethwid',
                        targetUserId: user.id
                    });
                    if (!script) return;

                    resetUserHwidBinding(user.id, script.id);
                    persistState();

                    await interaction.editReply({
                        content: `✅ <@${user.id}> üçün **${script.name}** HWID kilidi sıfırlandı. İndi skripti ilk açan cihaz həmin dövr üçün kilidlənəcək.`
                    });
                    return;
                }

                if (cmd === 'cooldownhwid') {
                    const timeStr = interaction.options.getString('time', true);
                    const scriptQuery = interaction.options.getString('script');
                    const durationMs = parseDurationToMs(timeStr);
                    if (durationMs === undefined) {
                        await interaction.editReply({
                            content: '❌ Yanlış müddət formatı. Məs: `1h`, `12h`, `1d` və ya `0`.'
                        });
                        return;
                    }
                    const script = await resolveScriptOrAsk(interaction, scriptQuery, {
                        type: 'cooldownhwid',
                        durationMs
                    });
                    if (!script) return;
                    state.hwidCooldowns[script.id] = durationMs || 0;
                    persistState();
                    await interaction.editReply({
                        content: `✅ **${script.name}** üçün HWID sıfırlama gözləmə müddəti yeniləndi.`
                    });
                    return;
                }
            } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sp_select_script:')) {
                const token = interaction.customId.split(':')[1];
                const pending = pendingSelections.get(token);
                if (!pending || pending.ownerId !== interaction.user.id) {
                    await interaction.reply({ content: '❌ Bu seçim menyusu artıq aktiv deyil.', ephemeral: true });
                    return;
                }
                pendingSelections.delete(token);
                const scriptId = interaction.values[0];
                const script = getScriptById(scriptId);
                if (!script) {
                    await interaction.update({ content: '❌ Seçilən skript tapılmadı.', components: [] });
                    return;
                }

                if (pending.type === 'setpanel') {
                    const ch = await interaction.guild.channels.fetch(pending.channelId);
                    const defaultTitle = pending.panelName || (interaction.guild ? interaction.guild.name : script.name);
                    await executePanelPost(ch, defaultTitle, script);
                    await interaction.update({
                        content: `✅ **${script.name}** üçün panel kanala göndərildi!`,
                        components: []
                    });
                } else if (pending.type === 'genkey') {
                    const created = [];
                    for (let i = 0; i < pending.amount; i++) {
                        const code = generateKeyCode();
                        state.keys.push({
                            id: generateId('key'),
                            code,
                            scriptId: script.id,
                            durationMs: pending.durationMs,
                            expiresAt: null,
                            createdBy: pending.creatorId || String(interaction.user.id),
                            createdByName: pending.creatorName || interaction.user.tag || interaction.user.username,
                            redeemedBy: null,
                            redeemedByName: null,
                            redeemedAt: null,
                            hwid: null,
                            disabled: false,
                            createdAt: nowMs()
                        });
                        created.push(code);
                    }
                    persistState();
                    await interaction.update({
                        content: `✅ **${script.name}** üçün **${created.length}** key yaradıldı:\n\`\`\`\n${created.join('\n')}\n\`\`\``,
                        components: []
                    });
                } else if (pending.type === 'whitelist') {
                    const targets = pending.targetUserIds.map((id) => ({ id }));
                    await applyWhitelistForTargets(script, targets, pending.durationMs);
                    await interaction.update({
                        content: `✅ **${targets.length}** istifadəçi **${script.name}** skriptinə whitelist edildi.`,
                        components: []
                    });
                } else if (pending.type === 'unwhitelist') {
                    const targets = pending.targetUserIds.map((id) => ({ id }));
                    const removed = await removeWhitelistForTargets(script, targets);
                    await interaction.update({
                        content: `✅ **${script.name}** skriptindən **${removed}** whitelist silindi.`,
                        components: []
                    });
                } else if (pending.type === 'resethwid') {
                    resetUserHwidBinding(pending.targetUserId, script.id);
                    persistState();
                    await interaction.update({
                        content: `✅ <@${pending.targetUserId}> üçün **${script.name}** HWID kilidi sıfırlandı. İndi skripti ilk açan cihaz həmin dövr üçün kilidlənəcək.`,
                        components: []
                    });
                } else if (pending.type === 'cooldownhwid') {
                    state.hwidCooldowns[script.id] = pending.durationMs || 0;
                    persistState();
                    await interaction.update({
                        content: `✅ **${script.name}** üçün HWID sıfırlama gözləmə müddəti yeniləndi.`,
                        components: []
                    });
                }
                return;
            } else if (interaction.isButton() && interaction.customId.startsWith('sp_copyscript:')) {
                await interaction.deferReply({ ephemeral: true });
                const copyId = interaction.customId.split(':')[1];
                const entry = pendingCopySnippets.get(copyId);
                if (!entry || entry.ownerId !== interaction.user.id || nowMs() > entry.expiresAt) {
                    await interaction.editReply({
                        content: '❌ Kopyalama vaxtı bitib və ya bu buton sizə aid deyil. Yenidən **Get Script** basın.'
                    });
                    return;
                }
                await interaction.editReply({
                    content: entry.snippet
                });
                return;
            } else if (interaction.isButton() && interaction.customId.startsWith('sp_')) {
                const [action, scriptId] = interaction.customId.split(':');
                const script = getScriptById(scriptId);
                if (!script) {
                    await interaction.reply({ content: '❌ Bu panelə bağlı skript tapılmadı.', ephemeral: true });
                    return;
                }

                if (action === 'sp_redeem') {
                    const modal = new ModalBuilder()
                        .setCustomId(`sp_redeem_modal:${script.id}`)
                        .setTitle(`${script.name} • Key Aktivləşdir`.slice(0, 45));
                    const keyInput = new TextInputBuilder()
                        .setCustomId('key_code')
                        .setLabel('Key kodunuzu daxil edin')
                        .setPlaceholder('SADO-XXXXXX-XXXXXX-XXXXXX')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
                    await interaction.showModal(modal);
                    return;
                }

                await interaction.deferReply({ ephemeral: true });

                if (action === 'sp_getscript') {
                    if (script.disabled) {
                        await interaction.editReply({
                            content: '⛔ Bu skript hazırda sahibi tərəfindən deaktiv edilib.'
                        });
                        return;
                    }
                    const wl = ensureUserLoaderToken(interaction.user.id, script.id);
                    if (!wl) {
                        await interaction.editReply({
                            content: `❌ Sizin **${script.name}** skripti üçün whitelist və ya key-iniz yoxdur.`
                        });
                        return;
                    }
                    const keyRec = getUserKeyForScript(interaction.user.id, script.id);
                    const snippet = buildLoaderSnippet(
                        PUBLIC_BASE_URL,
                        script.id,
                        interaction.user.id,
                        wl.loaderToken,
                        keyRec ? keyRec.code : 'WHITELIST'
                    );
                    const copyId = generateId('cpy');
                    pendingCopySnippets.set(copyId, {
                        ownerId: interaction.user.id,
                        snippet,
                        expiresAt: nowMs() + 10 * 60 * 1000
                    });
                    const copyRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`sp_copyscript:${copyId}`)
                            .setLabel('Skripti Kopyala')
                            .setEmoji('📋')
                            .setStyle(ButtonStyle.Secondary)
                    );
                    await interaction.editReply({
                        content:
                            `✅ **${script.name}** yükləyici kodu (yalnız sizin üçün):\n` +
                            `\`\`\`lua\n${snippet}\n\`\`\`\n` +
                            `⏳ Bitmə vaxtı: ${formatExpiry(wl.expiresAt)}`,
                        components: [copyRow]
                    });
                    return;
                }

                if (action === 'sp_resethwid') {
                    const wl = getActiveWhitelist(interaction.user.id, script.id);
                    const keyRec = getUserKeyForScript(interaction.user.id, script.id);
                    if (!wl && !keyRec) {
                        await interaction.editReply({
                            content: `❌ Sizin **${script.name}** skripti üçün aktiv icazəniz yoxdur.`
                        });
                        return;
                    }
                    const cooldownMs = Number(state.hwidCooldowns[script.id] || 0);
                    const resetKey = `${interaction.user.id}:${script.id}`;
                    const lastReset = Number(state.lastHwidReset[resetKey] || 0);
                    if (cooldownMs > 0 && lastReset && nowMs() - lastReset < cooldownMs) {
                        const nextTs = Math.floor((lastReset + cooldownMs) / 1000);
                        await interaction.editReply({
                            content: `⏳ HWID sıfırlama gözləmə müddətindəsiniz. Yenidən cəhd: <t:${nextTs}:R>.`
                        });
                        return;
                    }
                    resetUserHwidBinding(interaction.user.id, script.id);
                    state.lastHwidReset[resetKey] = nowMs();
                    persistState();
                    await interaction.editReply({
                        content: `✅ **${script.name}** üçün HWID sıfırlandı. İndi skripti ilk işlədən cihaz bu key/whitelist-ə bağlanacaq.`
                    });
                    return;
                }

                if (action === 'sp_getstats') {
                    const wl = getActiveWhitelist(interaction.user.id, script.id);
                    const keyRec = getUserKeyForScript(interaction.user.id, script.id);
                    if (!wl && !keyRec) {
                        await interaction.editReply({
                            content: `❌ Sizin **${script.name}** skripti üçün aktiv key və ya whitelist məlumatınız yoxdur.`
                        });
                        return;
                    }
                    const boundHwid = (wl && wl.hwid) || (keyRec && keyRec.hwid) || 'Hələ bağlanmayıb';
                    const exp = (wl && wl.expiresAt) || (keyRec && keyRec.expiresAt) || null;
                    await interaction.editReply({
                        content:
                            `📊 **${script.name}** Statistikası:\n` +
                            `• Key: \`${keyRec ? keyRec.code : 'Whitelist'}\`\n` +
                            `• HWID: \`${boundHwid}\`\n` +
                            `• Bitmə vaxtı: ${formatExpiry(exp)}`
                    });
                    return;
                }
            } else if (interaction.isModalSubmit() && interaction.customId.startsWith('sp_redeem_modal:')) {
                await interaction.deferReply({ ephemeral: true });
                const scriptId = interaction.customId.split(':')[1];
                const script = getScriptById(scriptId);
                if (!script) {
                    await interaction.editReply({ content: '❌ Skript tapılmadı.' });
                    return;
                }
                const code = String(interaction.fields.getTextInputValue('key_code') || '')
                    .trim()
                    .toUpperCase();
                const keyRecord = state.keys.find(
                    (k) => k.code.toUpperCase() === code && k.scriptId === script.id && !k.disabled
                );
                if (!keyRecord) {
                    await interaction.editReply({ content: '❌ Bu skript üçün etibarlı key tapılmadı.' });
                    return;
                }
                if (keyRecord.redeemedBy && keyRecord.redeemedBy !== String(interaction.user.id)) {
                    await interaction.editReply({
                        content: '❌ Bu 1 nəfərlik key artıq başqa istifadəçi tərəfindən aktivləşdirilib.'
                    });
                    return;
                }
                if (isExpired(keyRecord.expiresAt)) {
                    await interaction.editReply({ content: '❌ Bu key-in vaxtı bitib.' });
                    return;
                }

                const expiresAt =
                    keyRecord.expiresAt ||
                    (keyRecord.durationMs ? nowMs() + Number(keyRecord.durationMs) : null);
                keyRecord.expiresAt = expiresAt;
                keyRecord.redeemedBy = String(interaction.user.id);
                keyRecord.redeemedByName = resolveUserDisplayName(interaction.user.id);
                keyRecord.redeemedAt = keyRecord.redeemedAt || nowMs();
                if (typeof keyRecord.hwidLockEpoch !== 'number') {
                    keyRecord.hwidLockEpoch = 1;
                }

                const existingWl = getActiveWhitelist(interaction.user.id, script.id);
                if (existingWl) {
                    existingWl.expiresAt = expiresAt;
                    existingWl.revoked = false;
                    if (!existingWl.loaderToken) {
                        existingWl.loaderToken = crypto.randomBytes(16).toString('hex');
                    }
                    if (typeof existingWl.hwidLockEpoch !== 'number') {
                        existingWl.hwidLockEpoch = Number(keyRecord.hwidLockEpoch || 1);
                    }
                } else {
                    state.whitelists.push({
                        id: generateId('wl'),
                        userId: String(interaction.user.id),
                        scriptId: script.id,
                        expiresAt,
                        hwid: keyRecord.hwid || null,
                        hwidLockEpoch: Number(keyRecord.hwidLockEpoch || 1),
                        loaderToken: crypto.randomBytes(16).toString('hex'),
                        createdAt: nowMs(),
                        revoked: false
                    });
                }
                persistState();

                await interaction.editReply({
                    content:
                        `✅ Key uğurla aktivləşdirildi! **${script.name}** üçün icazəniz açıldı.\n` +
                        `⏳ Bitmə vaxtı: ${formatExpiry(expiresAt)}`
                });
                return;
            }
        } catch (err) {
            console.error('[SADO PROTECT] Interaction xətası:', err);
            if (interaction) {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: '❌ Əməliyyat zamanı xəta baş verdi.' }).catch(() => {});
                } else {
                    await interaction.reply({ content: '❌ Əməliyyat zamanı xəta baş verdi.', ephemeral: true }).catch(() => {});
                }
            }
        }
    });
}

function getGuildsWithRolesSummary() {
    if (!client || !client.guilds) return [];
    return [...client.guilds.cache.values()].map((g) => {
        const settings = getGuildSettings(g.id);
        const roles = [...g.roles.cache.values()]
            .filter((r) => r.id !== g.id)
            .sort((a, b) => b.position - a.position)
            .map((r) => ({ id: r.id, name: r.name }));
        return {
            id: g.id,
            name: g.name,
            allowedRoleIds: settings.allowedRoleIds || [],
            roles
        };
    });
}

async function startOrRestartBot() {
    if (!runtimeBotToken) return null;
    if (botBootPromise) return botBootPromise;

    botBootPromise = (async () => {
        if (client) {
            try {
                client.destroy();
            } catch (_) {}
            client = null;
        }
        const nextClient = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers
            ],
            partials: [Partials.GuildMember, Partials.User]
        });
        attachBotHandlers(nextClient);
        client = nextClient;
        await nextClient.login(runtimeBotToken);
        return nextClient;
    })().finally(() => {
        botBootPromise = null;
    });

    return botBootPromise;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk.toString('utf8');
            if (raw.length > 25 * 1024 * 1024) {
                reject(new Error('Sorğu həcmi çox böyükdür.'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!raw.trim()) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error('Yanlış JSON formatı.'));
            }
        });
        req.on('error', reject);
    });
}

function checkPanelAuth(req, reqUrl) {
    if (!PANEL_TOKEN) return true;
    const headerTok = String(req.headers['x-panel-token'] || '').trim();
    const authHeader = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const queryTok = String(reqUrl.searchParams.get('panelToken') || '').trim();
    const cookieHeader = String(req.headers['cookie'] || '');
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)sado_panel_token=([^;]+)/);
    const cookieTok = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
    return [headerTok, authHeader, queryTok, cookieTok].includes(PANEL_TOKEN);
}

function renderDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="az">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>SADO PROTECT • Control Dashboard</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #121826;
    --panel-2: #172033;
    --text: #eef2ff;
    --muted: #94a3b8;
    --accent: #6366f1;
    --accent-2: #22c55e;
    --danger: #ef4444;
    --border: rgba(148, 163, 184, 0.16);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Inter, system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 20;
  }
  .brand-wrap { display: flex; align-items: center; gap: 12px; }
  .menu-btn {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 18px;
    cursor: pointer;
  }
  .brand-title { font-weight: 700; font-size: 16px; letter-spacing: 0.4px; }
  .status-pill {
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(99, 102, 241, 0.16);
    border: 1px solid rgba(99, 102, 241, 0.35);
  }
  .drawer {
    position: fixed;
    top: 0;
    left: -280px;
    width: 270px;
    height: 100%;
    background: var(--panel);
    border-right: 1px solid var(--border);
    z-index: 40;
    transition: left 0.22s ease;
    padding: 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .drawer.open { left: 0; }
  .backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 30;
  }
  .backdrop.show { display: block; }
  .nav-btn {
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
    cursor: pointer;
  }
  .nav-btn.active, .nav-btn:hover {
    background: var(--panel-2);
    border-color: var(--border);
  }
  .container { max-width: 1080px; margin: 22px auto; padding: 0 16px 48px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 18px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .card h3 { margin: 0 0 12px; font-size: 15px; }
  .stat-val { font-size: 24px; font-weight: 700; margin-top: 6px; }
  .muted { color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 5px; }
  input, select, textarea {
    width: 100%;
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
  }
  textarea { min-height: 150px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 10px;
    padding: 10px 15px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 12px;
  }
  .btn.green { background: var(--accent-2); color: #052e16; }
  .btn.red { background: var(--danger); }
  .btn.ghost { background: var(--panel-2); border: 1px solid var(--border); }
  .list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--panel-2);
    margin-top: 8px;
    font-size: 13px;
  }
  .section { display: none; }
  .section.active { display: block; }
  .toast {
    position: fixed;
    bottom: 18px;
    right: 18px;
    background: var(--panel-2);
    border: 1px solid var(--accent);
    color: var(--text);
    padding: 11px 16px;
    border-radius: 12px;
    font-size: 13px;
    z-index: 60;
    display: none;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    font-size: 13px;
    color: var(--text);
  }
  .check-row input { width: auto; }
  .badge-obf {
    display: inline-block;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(34, 197, 94, 0.16);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.35);
    margin-left: 6px;
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="brand-wrap">
    <button class="menu-btn" id="menuBtn" type="button">☰</button>
    <div class="brand-title" id="headerBrandTitle">SADO PROTECT</div>
  </div>
  <div class="status-pill" id="botStatusPill">Bot: Yüklənir...</div>
</div>

<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer">
  <div style="font-weight:700;padding:4px 10px 10px;border-bottom:1px solid var(--border);margin-bottom:6px;">Menyu</div>
  <button class="nav-btn active" data-sec="sec-overview">📊 İcmal</button>
  <button class="nav-btn" data-sec="sec-scripts">📜 Skriptlər &amp; Dosya</button>
  <button class="nav-btn" data-sec="sec-obf">🛡️ Lua Obfuscator</button>
  <button class="nav-btn" data-sec="sec-bot">🤖 Join Discord &amp; Panel</button>
  <button class="nav-btn" data-sec="sec-keys">🔑 Key &amp; Whitelist</button>
  <button class="nav-btn" data-sec="sec-backup">💾 Backup &amp; Yaddaş</button>
</aside>

<main class="container">
  <section class="section active" id="sec-overview">
    <div class="grid">
      <div class="card"><div class="muted">Skriptlər</div><div class="stat-val" id="statScripts">0</div></div>
      <div class="card"><div class="muted">Yaradılmış Key-lər</div><div class="stat-val" id="statKeys">0</div></div>
      <div class="card"><div class="muted">Aktiv Whitelist</div><div class="stat-val" id="statWl">0</div></div>
      <div class="card"><div class="muted">Qoşulu Sunucu</div><div class="stat-val" id="statGuild" style="font-size:16px;margin-top:10px;">Seçilməyib</div></div>
    </div>
    <div class="card">
      <h3>Son Key-lər (Yaradan &amp; İşlədən)</h3>
      <div id="recentKeysList"></div>
    </div>
  </section>

  <section class="section" id="sec-scripts">
    <div class="card">
      <h3>Yeni Skript Yarat / Dosya Yüklə (.lua / .txt)</h3>
      <label>Skript Adı</label>
      <input id="scriptNameInput" placeholder="Məs: SADO HUB" />
      <label>Lua / TXT Dosya Seç (istəyə bağlı)</label>
      <input type="file" id="scriptFileInput" accept=".lua,.txt,.luau" />
      <label>Skript Kodu</label>
      <textarea id="scriptCodeInput" placeholder="-- Lua skript kodunu bura yazın və ya dosya seçin"></textarea>
      <label class="check-row">
        <input type="checkbox" id="scriptObfuscateCheck" checked />
        <span>Skripti yadda saxlayanda avtomatik <b>Lua Obfuscate</b> et (kodu şifrələ)</span>
      </label>
      <button class="btn green" id="saveScriptBtn" type="button">Skripti Yadda Saxla</button>
    </div>
    <div class="card">
      <h3>Mövcud Skriptlər</h3>
      <div id="scriptsList"></div>
    </div>
  </section>

  <section class="section" id="sec-obf">
    <div class="card">
      <h3>🛡️ Lua Obfuscator (Kodu Şifrələ &amp; Gizlət)</h3>
      <div class="muted">Lua kodunuzu oxunmaz hala salın. İstəsəniz birbaşa burada şifrələyib kopyalaya, ya da bir kliklə yeni qorunan skript kimi panelə əlavə edə bilərsiniz.</div>
      <label>Qoruma Səviyyəsi</label>
      <select id="obfLevelSelect">
        <option value="standard">Standart (Sürətli Bytecode / XOR Şifrələmə)</option>
        <option value="high">Yüksək (Anti-Tamper + XOR Şifrələmə)</option>
      </select>
      <label>Orijinal Lua Kodu</label>
      <textarea id="obfSourceInput" placeholder="print('Salam SADO PROTECT')"></textarea>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn green" id="runObfBtn" type="button">🛡️ Obfuscate Et</button>
        <button class="btn" id="copyObfBtn" type="button">📋 Şifrələnmiş Kodu Kopyala</button>
      </div>
      <label>Şifrələnmiş (Obfuscated) Lua Çıxışı</label>
      <textarea id="obfOutputText" readonly placeholder="Şifrələnmiş kod burada görünəcək..."></textarea>
      <div class="row-2">
        <div>
          <label>Birbaşa Skript Kimi Yarat (Adı)</label>
          <input id="obfSaveScriptName" placeholder="Məs: SADO VIP OBF" />
        </div>
      </div>
      <button class="btn green" id="obfSaveAsScriptBtn" type="button">➕ Şifrələnmiş Kodu Skript Kimi Yadda Saxla</button>
    </div>
  </section>

  <section class="section" id="sec-bot">
    <div class="card">
      <h3>🤖 SADO PROTECT Botunu Sunucuna Əlavə Et (Join Discord)</h3>
      <div class="muted">1. Əvvəlcə aşağıdakı düymə ilə <b>SADO PROTECT</b> botunu öz Discord sunucunuza əlavə edin.<br>2. Bot sunucuya girdikdən sonra aşağıdan öz sunucunuzu seçin (və ya Sunucu ID-ni yazın) — yuxarıda öz sunucunuzun adı görünəcək və bütün idarəetmə paneli tam sizə bağlanacaq.</div>
      <div style="margin-top:12px;">
        <a class="btn green" id="botInviteLinkBtn" href="#" target="_blank" style="text-decoration:none;display:inline-block;">➕ SADO PROTECT Botunu Sunucuna Əlavə Et</a>
      </div>
      <label>Botun Olduğu Sunuculardan Öz Sunucunu Seç</label>
      <select id="guildSelectDropdown">
        <option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>
      </select>
      <label>Və ya Discord Sunucu ID (Server ID)</label>
      <input id="linkGuildIdInput" placeholder="Məs: 123456789012345678" />
      <label>Discord User ID (istəyə bağlı)</label>
      <input id="linkDiscordIdInput" placeholder="Məs: 123456789012345678" />
      <button class="btn" id="linkDiscordIdBtn" type="button">✅ Sunucunu İdarəetmə Panelinə Bağla</button>
    </div>
    <div class="card">
      <h3>Panel Buton və Embed Dizaynı</h3>
      <div class="row-2">
        <div>
          <label>Embed Rəngi (HEX)</label>
          <input id="cfgEmbedColor" placeholder="#5865F2" />
        </div>
        <div>
          <label>Redeem Key Adı / Emoji / Rəng</label>
          <div style="display:flex;gap:6px;">
            <input id="cfgRedeemLabel" placeholder="Redeem Key" />
            <input id="cfgRedeemEmoji" placeholder="🔑" style="max-width:70px;" />
            <select id="cfgRedeemStyle" style="max-width:110px;">
              <option value="Success">Yaşıl</option>
              <option value="Primary">Göy</option>
              <option value="Secondary">Boz</option>
              <option value="Danger">Qırmızı</option>
            </select>
          </div>
        </div>
      </div>
      <div class="row-2">
        <div>
          <label>Get Script Adı / Emoji / Rəng</label>
          <div style="display:flex;gap:6px;">
            <input id="cfgGetScriptLabel" placeholder="Get Script" />
            <input id="cfgGetScriptEmoji" placeholder="📜" style="max-width:70px;" />
            <select id="cfgGetScriptStyle" style="max-width:110px;">
              <option value="Primary">Göy</option>
              <option value="Success">Yaşıl</option>
              <option value="Secondary">Boz</option>
              <option value="Danger">Qırmızı</option>
            </select>
          </div>
        </div>
        <div>
          <label>Reset HWID Adı / Emoji / Rəng</label>
          <div style="display:flex;gap:6px;">
            <input id="cfgResetHwidLabel" placeholder="Reset HWID" />
            <input id="cfgResetHwidEmoji" placeholder="🔄" style="max-width:70px;" />
            <select id="cfgResetHwidStyle" style="max-width:110px;">
              <option value="Secondary">Boz</option>
              <option value="Danger">Qırmızı</option>
              <option value="Primary">Göy</option>
              <option value="Success">Yaşıl</option>
            </select>
          </div>
        </div>
      </div>
      <div class="row-2">
        <div>
          <label>Get Stats Adı / Emoji / Rəng</label>
          <div style="display:flex;gap:6px;">
            <input id="cfgGetStatsLabel" placeholder="Get Stats" />
            <input id="cfgGetStatsEmoji" placeholder="📊" style="max-width:70px;" />
            <select id="cfgGetStatsStyle" style="max-width:110px;">
              <option value="Secondary">Boz</option>
              <option value="Primary">Göy</option>
              <option value="Success">Yaşıl</option>
              <option value="Danger">Qırmızı</option>
            </select>
          </div>
        </div>
      </div>
      <button class="btn green" id="savePanelCfgBtn" type="button">Panel Dizaynını Yadda Saxla</button>
    </div>
  </section>

  <section class="section" id="sec-keys">
    <div class="card">
      <h3>1 Nəfərlik Key Yarat</h3>
      <div class="row-2">
        <div><label>Skript</label><select id="genKeyScriptSelect"></select></div>
        <div><label>Müddət (1h, 1d, 7d, 30d, 0)</label><input id="genKeyTime" value="7d" /></div>
        <div><label>Say (1-50)</label><input type="number" id="genKeyAmount" value="1" min="1" max="50" /></div>
      </div>
      <button class="btn green" id="genKeyBtn" type="button">Key Yarat</button>
      <div id="genKeyOutput" class="muted" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <h3>Whitelist Əlavə Et (Avtomatik Key Yaradır)</h3>
      <div class="row-2">
        <div><label>Skript</label><select id="wlScriptSelect"></select></div>
        <div><label>Discord User ID</label><input id="wlUserId" placeholder="123456789012345678" /></div>
        <div><label>Müddət (1d, 7d, 30d, 0)</label><input id="wlTime" value="0" /></div>
      </div>
      <button class="btn" id="addWlBtn" type="button">Whitelist Et</button>
      <div id="wlList" style="margin-top:10px;"></div>
    </div>
  </section>

  <section class="section" id="sec-backup">
    <div class="card">
      <h3>Backup Yüklə və Bərpa Et</h3>
      <div class="muted">Bütün skript, key, whitelist və ayarları JSON kimi yükləyin və ya geri bərpa edin.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
        <a class="btn ghost" href="/api/backup" download="sado-protect-backup.json" style="text-decoration:none;">⬇️ Backup Yüklə</a>
        <label class="btn ghost" style="margin-top:12px;cursor:pointer;">
          ⬆️ Backup Bərpa Et <input type="file" id="restoreFileInput" accept=".json" style="display:none;" />
        </label>
      </div>
    </div>
  </section>
</main>

<div class="toast" id="toast"></div>

<script>
const toastEl = document.getElementById('toast');
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3000);
}

const drawer = document.getElementById('drawer');
const backdrop = document.getElementById('backdrop');
document.getElementById('menuBtn').onclick = () => {
  drawer.classList.add('open');
  backdrop.classList.add('show');
};
backdrop.onclick = () => {
  drawer.classList.remove('open');
  backdrop.classList.remove('show');
};

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    document.getElementById(btn.dataset.sec).classList.add('active');
    drawer.classList.remove('open');
    backdrop.classList.remove('show');
  };
});

document.getElementById('scriptFileInput').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const txt = await file.text();
  document.getElementById('scriptCodeInput').value = txt;
  if (!document.getElementById('scriptNameInput').value.trim()) {
    document.getElementById('scriptNameInput').value = file.name.replace(/\.[^.]+$/, '');
  }
};

function getOrCreateLocalWsId() {
  let id = localStorage.getItem('sado_ws_id');
  if (!id || id.length < 8) {
    id = 'ws_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('sado_ws_id', id);
  }
  document.cookie = 'sado_ws_id=' + encodeURIComponent(id) + '; path=/; max-age=31536000; SameSite=Lax';
  return id;
}

const CURRENT_WS_ID = getOrCreateLocalWsId();

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Id': CURRENT_WS_ID,
      ...(opts.headers || {})
    }
  });
  return res.json();
}

function fillPanelCfgForm(cfg) {
  if (!cfg) return;
  document.getElementById('cfgEmbedColor').value = cfg.embedColor || '#5865F2';
  document.getElementById('cfgRedeemLabel').value = cfg.redeemLabel || 'Redeem Key';
  document.getElementById('cfgRedeemEmoji').value = cfg.redeemEmoji || '🔑';
  document.getElementById('cfgRedeemStyle').value = cfg.redeemStyle || 'Success';
  document.getElementById('cfgGetScriptLabel').value = cfg.getScriptLabel || 'Get Script';
  document.getElementById('cfgGetScriptEmoji').value = cfg.getScriptEmoji || '📜';
  document.getElementById('cfgGetScriptStyle').value = cfg.getScriptStyle || 'Primary';
  document.getElementById('cfgResetHwidLabel').value = cfg.resetHwidLabel || 'Reset HWID';
  document.getElementById('cfgResetHwidEmoji').value = cfg.resetHwidEmoji || '🔄';
  document.getElementById('cfgResetHwidStyle').value = cfg.resetHwidStyle || 'Secondary';
  document.getElementById('cfgGetStatsLabel').value = cfg.getStatsLabel || 'Get Stats';
  document.getElementById('cfgGetStatsEmoji').value = cfg.getStatsEmoji || '📊';
  document.getElementById('cfgGetStatsStyle').value = cfg.getStatsStyle || 'Secondary';
}

document.getElementById('guildSelectDropdown').onchange = (e) => {
  const val = e.target.value;
  if (val) {
    document.getElementById('linkGuildIdInput').value = val;
  }
};

async function refreshAll() {
  const data = await api('/api/state');
  if (!data || !data.ok) return;

  const headerTitleEl = document.getElementById('headerBrandTitle');
  const statGuildEl = document.getElementById('statGuild');
  if (data.connectedGuild && data.connectedGuild.guildName) {
    headerTitleEl.textContent = data.connectedGuild.guildName + ' • SADO PROTECT';
    statGuildEl.textContent = data.connectedGuild.guildName;
  } else {
    headerTitleEl.textContent = 'SADO PROTECT';
    statGuildEl.textContent = 'Sunucu seçilməyib';
  }

  const guildDropdown = document.getElementById('guildSelectDropdown');
  if (guildDropdown && Array.isArray(data.guilds)) {
    const prevVal = guildDropdown.value;
    guildDropdown.innerHTML =
      '<option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>' +
      data.guilds.map((g) => '<option value="' + g.id + '">' + g.name + ' (' + g.id + ')</option>').join('');
    if (prevVal) guildDropdown.value = prevVal;
    else if (data.connectedGuild && data.connectedGuild.guildId) {
      guildDropdown.value = data.connectedGuild.guildId;
    }
  }

  const linkedGuildInput = document.getElementById('linkGuildIdInput');
  if (linkedGuildInput && !linkedGuildInput.value && Array.isArray(data.linkedGuildIds) && data.linkedGuildIds.length > 0) {
    linkedGuildInput.value = data.linkedGuildIds[0];
  }
  const linkedInput = document.getElementById('linkDiscordIdInput');
  if (linkedInput && !linkedInput.value && Array.isArray(data.linkedDiscordIds) && data.linkedDiscordIds.length > 0) {
    linkedInput.value = data.linkedDiscordIds[0];
  }
  const inviteBtn = document.getElementById('botInviteLinkBtn');
  if (inviteBtn && data.botInviteUrl) {
    inviteBtn.href = data.botInviteUrl;
  }
  const pill = document.getElementById('botStatusPill');
  pill.textContent = data.botReady ? ('SADO PROTECT Aktiv') : 'Bot Qoşulur...';

  document.getElementById('statScripts').textContent = (data.scripts || []).length;
  document.getElementById('statKeys').textContent = data.keysCount || 0;
  document.getElementById('statWl').textContent = data.whitelistsCount || 0;

  fillPanelCfgForm(data.panelButtonConfig);

  const selects = [document.getElementById('genKeyScriptSelect'), document.getElementById('wlScriptSelect')];
  selects.forEach((sel) => {
    const prev = sel.value;
    sel.innerHTML = (data.scripts || []).map((s) => '<option value="' + s.id + '">' + s.name + '</option>').join('');
    if (prev) sel.value = prev;
  });

  const scriptsList = document.getElementById('scriptsList');
  scriptsList.innerHTML = (data.scripts || []).length
    ? data.scripts.map((s) =>
        '<div class="list-item"><div><b>' + s.name + '</b>' +
        (s.obfuscated ? '<span class="badge-obf">OBFUSCATED</span>' : '') +
        ' <span class="muted">(' + s.id + ')</span></div>' +
        '<div style="display:flex;gap:6px;">' +
        '<button class="btn ghost" style="margin-top:0;padding:6px 10px;" onclick="obfuscateExistingScript(\\'' + s.id + '\\')">🛡️ Şifrələ</button>' +
        '<button class="btn red" style="margin-top:0;padding:6px 10px;" onclick="deleteScript(\\'' + s.id + '\\')">Sil</button>' +
        '</div></div>'
      ).join('')
    : '<div class="muted">Hələ skript yoxdur.</div>';

  const recentKeysList = document.getElementById('recentKeysList');
  recentKeysList.innerHTML = (data.recentKeys || []).length
    ? data.recentKeys.slice(0, 15).map((k) =>
        '<div class="list-item"><div><code>' + k.code + '</code> • <b>' + (k.scriptName || '') + '</b><br>' +
        '<span class="muted">Yaradan: ' + (k.createdByName || 'Panel') + ' | İşlədən: ' + (k.redeemedByName || 'Hələ işlənməyib') + '</span></div></div>'
      ).join('')
    : '<div class="muted">Hələ key yaradılmayıb.</div>';

  const wlList = document.getElementById('wlList');
  wlList.innerHTML = (data.whitelists || []).length
    ? data.whitelists.map((w) =>
        '<div class="list-item"><div><b>' + (w.username || w.userId) + '</b> <span class="muted">(' + w.userId + ')</span> • ' + (w.scriptName || '') + '</div>' +
        '<button class="btn red" style="margin-top:0;padding:6px 10px;" onclick="removeWl(\\'' + w.id + '\\')">Sil</button></div>'
      ).join('')
    : '<div class="muted">Aktiv whitelist yoxdur.</div>';
}

window.obfuscateExistingScript = async (id) => {
  const r = await api('/api/scripts/' + encodeURIComponent(id) + '/obfuscate', { method: 'POST' });
  showToast(r.message || 'Skript obfuscate edildi!');
  refreshAll();
};

window.deleteScript = async (id) => {
  await api('/api/scripts/' + encodeURIComponent(id), { method: 'DELETE' });
  showToast('Skript silindi');
  refreshAll();
};

window.removeWl = async (id) => {
  await api('/api/whitelist/' + encodeURIComponent(id), { method: 'DELETE' });
  showToast('Whitelist silindi');
  refreshAll();
};

document.getElementById('saveScriptBtn').onclick = async () => {
  const name = document.getElementById('scriptNameInput').value.trim();
  const code = document.getElementById('scriptCodeInput').value;
  const obfuscate = document.getElementById('scriptObfuscateCheck').checked;
  const r = await api('/api/scripts', { method: 'POST', body: JSON.stringify({ name, code, obfuscate }) });
  if (r.ok) {
    document.getElementById('scriptNameInput').value = '';
    document.getElementById('scriptCodeInput').value = '';
    document.getElementById('scriptFileInput').value = '';
    showToast(obfuscate ? 'Skript obfuscate edilərək yadda saxlandı!' : 'Skript yadda saxlandı!');
    refreshAll();
  } else {
    showToast(r.message || 'Xəta baş verdi');
  }
};

document.getElementById('runObfBtn').onclick = async () => {
  const code = document.getElementById('obfSourceInput').value;
  const level = document.getElementById('obfLevelSelect').value;
  const r = await api('/api/obfuscate', { method: 'POST', body: JSON.stringify({ code, level }) });
  if (r.ok) {
    document.getElementById('obfOutputText').value = r.obfuscated || '';
    showToast('Lua kodu uğurla şifrələndi!');
  } else {
    showToast(r.message || 'Xəta baş verdi');
  }
};

document.getElementById('copyObfBtn').onclick = async () => {
  const out = document.getElementById('obfOutputText').value;
  if (!out.trim()) {
    showToast('Əvvəlcə kodu obfuscate edin.');
    return;
  }
  await navigator.clipboard.writeText(out).catch(() => {});
  showToast('Şifrələnmiş kod kopyalandı!');
};

document.getElementById('obfSaveAsScriptBtn').onclick = async () => {
  const name = document.getElementById('obfSaveScriptName').value.trim();
  const rawCode = document.getElementById('obfSourceInput').value;
  const alreadyObf = document.getElementById('obfOutputText').value;
  const level = document.getElementById('obfLevelSelect').value;
  if (!name) {
    showToast('Skript adı yazın.');
    return;
  }
  if (!rawCode.trim() && !alreadyObf.trim()) {
    showToast('Lua kodu daxil edin.');
    return;
  }
  const r = await api('/api/scripts', {
    method: 'POST',
    body: JSON.stringify({
      name,
      code: alreadyObf.trim() ? alreadyObf : rawCode,
      obfuscate: !alreadyObf.trim(),
      obfuscateLevel: level,
      preObfuscated: Boolean(alreadyObf.trim())
    })
  });
  if (r.ok) {
    document.getElementById('obfSaveScriptName').value = '';
    showToast('Şifrələnmiş skript panelə əlavə olundu!');
    refreshAll();
  } else {
    showToast(r.message || 'Xəta baş verdi');
  }
};

document.getElementById('linkDiscordIdBtn').onclick = async () => {
  const dropdownVal = document.getElementById('guildSelectDropdown').value.trim();
  const inputVal = document.getElementById('linkGuildIdInput').value.trim();
  const guildId = inputVal || dropdownVal;
  const discordUserId = document.getElementById('linkDiscordIdInput').value.trim();
  const r = await api('/api/workspace/link-discord', { method: 'POST', body: JSON.stringify({ guildId, discordUserId }) });
  showToast(r.message || 'Bağlandı');
  refreshAll();
};

document.getElementById('savePanelCfgBtn').onclick = async () => {
  const payload = {
    embedColor: document.getElementById('cfgEmbedColor').value.trim(),
    redeemLabel: document.getElementById('cfgRedeemLabel').value.trim(),
    redeemEmoji: document.getElementById('cfgRedeemEmoji').value.trim(),
    redeemStyle: document.getElementById('cfgRedeemStyle').value,
    getScriptLabel: document.getElementById('cfgGetScriptLabel').value.trim(),
    getScriptEmoji: document.getElementById('cfgGetScriptEmoji').value.trim(),
    getScriptStyle: document.getElementById('cfgGetScriptStyle').value,
    resetHwidLabel: document.getElementById('cfgResetHwidLabel').value.trim(),
    resetHwidEmoji: document.getElementById('cfgResetHwidEmoji').value.trim(),
    resetHwidStyle: document.getElementById('cfgResetHwidStyle').value,
    getStatsLabel: document.getElementById('cfgGetStatsLabel').value.trim(),
    getStatsEmoji: document.getElementById('cfgGetStatsEmoji').value.trim(),
    getStatsStyle: document.getElementById('cfgGetStatsStyle').value
  };
  const r = await api('/api/panel-config', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) {
    showToast('Panel dizaynı yadda saxlandı!');
    refreshAll();
  }
};

document.getElementById('genKeyBtn').onclick = async () => {
  const scriptId = document.getElementById('genKeyScriptSelect').value;
  const time = document.getElementById('genKeyTime').value;
  const amount = Number(document.getElementById('genKeyAmount').value || 1);
  const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ scriptId, time, amount }) });
  if (r.ok) {
    document.getElementById('genKeyOutput').textContent = 'Key-lər: ' + (r.keys || []).join(', ');
    showToast('Key yaradıldı!');
    refreshAll();
  }
};

document.getElementById('addWlBtn').onclick = async () => {
  const scriptId = document.getElementById('wlScriptSelect').value;
  const userId = document.getElementById('wlUserId').value.trim();
  const time = document.getElementById('wlTime').value.trim();
  const r = await api('/api/whitelist', { method: 'POST', body: JSON.stringify({ scriptId, userId, time }) });
  if (r.ok) {
    document.getElementById('wlUserId').value = '';
    showToast('Whitelist edildi! Auto Key: ' + (r.key || '—'));
    refreshAll();
  } else {
    showToast(r.message || 'Xəta');
  }
};

document.getElementById('restoreFileInput').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const txt = await file.text();
  const parsed = JSON.parse(txt);
  const r = await api('/api/restore', { method: 'POST', body: JSON.stringify(parsed) });
  if (r.ok) {
    showToast('Backup bərpa edildi!');
    refreshAll();
  }
};

refreshAll();
setInterval(refreshAll, 15000);
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
    try {
        const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (reqUrl.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, botReady: Boolean(client && client.user), uptime: process.uptime() }));
            return;
        }

        if (reqUrl.pathname.startsWith('/raw/') && req.method === 'GET') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/raw/'.length));
            const uid = String(reqUrl.searchParams.get('uid') || '').trim();
            const tok = String(reqUrl.searchParams.get('t') || '').trim();
            const hwid = extractExecutorHwid(req, reqUrl);

            if (!isRobloxExecutorRequest(req)) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: Brauzerdən və ya icazəsiz sorğudan skript koduna baxmaq qadağandır.');
                return;
            }

            const script = getScriptById(scriptId);
            if (!script || script.disabled) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: Skript deaktivdir və ya tapılmadı.');
                return;
            }
            const wl = getActiveWhitelist(uid, script.id);
            if (!wl || !tok || wl.loaderToken !== tok) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('-- SADO PROTECT: İcazə yoxdur (Not Whitelisted).');
                return;
            }

            const keyRec = getUserKeyForScript(uid, script.id);
            const currentEpoch = Math.max(Number(wl.hwidLockEpoch || 1), Number(keyRec?.hwidLockEpoch || 1));
            const boundHwid = String(wl.hwid || keyRec?.hwid || '').trim();

            if (!boundHwid) {
                if (!hwid) {
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(buildFirstRunHandshakePayload(PUBLIC_BASE_URL, script.id, uid, tok, currentEpoch));
                    return;
                }
                wl.hwid = hwid;
                wl.hwidLockEpoch = currentEpoch;
                if (keyRec) {
                    keyRec.hwid = hwid;
                    keyRec.hwidLockEpoch = currentEpoch;
                }
                persistState();
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(buildHwidGuardedLuaPayload(script.code || '', hwid, currentEpoch));
                return;
            }

            if (hwid && hwid !== boundHwid) {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(
                    buildHwidGuardedLuaPayload(
                        '',
                        boundHwid,
                        currentEpoch,
                        'HWID uyğun deyil! Bu key başqa cihaza bağlıdır. Yenidən Reset HWID edin.'
                    )
                );
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(buildHwidGuardedLuaPayload(script.code || '', boundHwid, currentEpoch));
            return;
        }

        if (reqUrl.pathname === '/' && req.method === 'GET') {
            let wsId = getWorkspaceIdFromReq(req, reqUrl);
            const headers = { 'Content-Type': 'text/html; charset=utf-8' };
            if (!wsId) {
                wsId = generateId('ws');
                headers['Set-Cookie'] = `sado_ws_id=${encodeURIComponent(wsId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
            }
            ensureWorkspaceRecord(wsId);
            res.writeHead(200, headers);
            res.end(renderDashboardHtml());
            return;
        }

        if (!checkPanelAuth(req, reqUrl)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, authRequired: true, message: 'Panel token tələb olunur.' }));
            return;
        }

        let activeWsId = getWorkspaceIdFromReq(req, reqUrl);
        if (!activeWsId) {
            activeWsId = generateId('ws');
        }
        const activeWorkspace = ensureWorkspaceRecord(activeWsId);

        if (reqUrl.pathname === '/api/obfuscate' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const code = String(body.code || '');
            const level = String(body.level || 'standard');
            if (!code.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Obfuscate etmək üçün Lua kodu yazın.' }));
                return;
            }
            const obfuscated = obfuscateLuaSource(code, level);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, obfuscated }));
            return;
        }

        if (reqUrl.pathname === '/api/workspace/link-discord' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const guildId = String(body.guildId || '').trim();
            const discordUserId = String(body.discordUserId || '').trim();
            if (!guildId && !discordUserId) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Ən azı Sunucu seçin və ya Sunucu ID daxil edin.' }));
                return;
            }
            if (guildId && !/^\d{15,22}$/.test(guildId)) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Düzgün Discord Sunucu ID (Server ID) daxil edin.' }));
                return;
            }
            if (discordUserId && !/^\d{15,22}$/.test(discordUserId)) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Düzgün Discord User ID daxil edin.' }));
                return;
            }
            ensureWorkspaceRecord(activeWsId, discordUserId || null, guildId || null);
            for (const s of getScriptsForWorkspace(activeWsId)) {
                if (guildId) s.ownerGuildId = guildId;
                if (discordUserId) s.ownerDiscordId = discordUserId;
            }
            persistState();
            const info = resolveWorkspaceGuildDisplay(activeWorkspace);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    ok: true,
                    message: info
                        ? `✅ "${info.guildName}" sunucusu bu panelə bağlandı!`
                        : '✅ Discord ID bu panelə bağlandı!'
                })
            );
            return;
        }

        if (reqUrl.pathname === '/api/state' && req.method === 'GET') {
            const wsScripts = getScriptsForWorkspace(activeWsId);
            const wsScriptIds = new Set(wsScripts.map((s) => s.id));
            const wsKeys = state.keys.filter((k) => wsScriptIds.has(k.scriptId));
            const wsWhitelists = state.whitelists.filter(
                (w) => wsScriptIds.has(w.scriptId) && !w.revoked && !isExpired(w.expiresAt)
            );
            const botInviteUrl =
                client && client.user
                    ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`
                    : null;
            const connectedGuild = resolveWorkspaceGuildDisplay(activeWorkspace);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
                JSON.stringify({
                    ok: true,
                    workspaceId: activeWsId,
                    connectedGuild,
                    linkedGuildIds: activeWorkspace ? activeWorkspace.guildIds || [] : [],
                    linkedDiscordIds: activeWorkspace ? activeWorkspace.discordUserIds || [] : [],
                    botInviteUrl,
                    authRequired: Boolean(PANEL_TOKEN),
                    cloudConnected: Boolean((UPSTASH_URL && UPSTASH_TOKEN) || (JSONBIN_ID && JSONBIN_KEY)),
                    botReady: Boolean(client && client.user),
                    botTag: client && client.user ? client.user.tag : null,
                    panelButtonConfig: state.panelButtonConfig,
                    guilds: getGuildsWithRolesSummary(),
                    scripts: wsScripts.map((s) => ({
                        id: s.id,
                        name: s.name,
                        obfuscated: Boolean(s.obfuscated),
                        disabled: Boolean(s.disabled),
                        createdAt: s.createdAt
                    })),
                    keysCount: wsKeys.length,
                    whitelistsCount: wsWhitelists.length,
                    recentKeys: wsKeys.slice(-50).reverse().map(enrichMemberEntry),
                    whitelists: wsWhitelists
                        .slice(-50)
                        .reverse()
                        .map(enrichMemberEntry)
                })
            );
            return;
        }

        if (reqUrl.pathname === '/api/panel-config' && req.method === 'POST') {
            const body = await readJsonBody(req);
            state.panelButtonConfig = {
                ...state.panelButtonConfig,
                embedColor: String(body.embedColor || state.panelButtonConfig.embedColor || '#5865F2').trim(),
                redeemLabel: String(body.redeemLabel || 'Redeem Key').trim().slice(0, 80),
                redeemEmoji: String(body.redeemEmoji ?? '').trim().slice(0, 32),
                redeemStyle: String(body.redeemStyle || 'Success').trim(),
                getScriptLabel: String(body.getScriptLabel || 'Get Script').trim().slice(0, 80),
                getScriptEmoji: String(body.getScriptEmoji ?? '').trim().slice(0, 32),
                getScriptStyle: String(body.getScriptStyle || 'Primary').trim(),
                resetHwidLabel: String(body.resetHwidLabel || 'Reset HWID').trim().slice(0, 80),
                resetHwidEmoji: String(body.resetHwidEmoji ?? '').trim().slice(0, 32),
                resetHwidStyle: String(body.resetHwidStyle || 'Secondary').trim(),
                getStatsLabel: String(body.getStatsLabel || 'Get Stats').trim().slice(0, 80),
                getStatsEmoji: String(body.getStatsEmoji ?? '').trim().slice(0, 32),
                getStatsStyle: String(body.getStatsStyle || 'Secondary').trim()
            };
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, panelButtonConfig: state.panelButtonConfig }));
            return;
        }

        if (reqUrl.pathname === '/api/scripts' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const name = String(body.name || '').trim();
            const rawCode = String(body.code || '');
            const shouldObf = Boolean(body.obfuscate);
            const preObf = Boolean(body.preObfuscated);
            const obfLevel = String(body.obfuscateLevel || 'standard');
            if (!name || !rawCode.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript adı və kodu tələb olunur.' }));
                return;
            }
            const finalCode = shouldObf ? obfuscateLuaSource(rawCode, obfLevel) : rawCode;
            const linkedGuild =
                activeWorkspace && Array.isArray(activeWorkspace.guildIds) && activeWorkspace.guildIds.length > 0
                    ? activeWorkspace.guildIds[0]
                    : null;
            const linkedDiscord =
                activeWorkspace && Array.isArray(activeWorkspace.discordUserIds) && activeWorkspace.discordUserIds.length > 0
                    ? activeWorkspace.discordUserIds[0]
                    : null;
            const script = {
                id: generateId('scr'),
                name,
                code: finalCode,
                obfuscated: shouldObf || preObf,
                ownerWorkspaceId: activeWsId,
                ownerGuildId: linkedGuild,
                ownerDiscordId: linkedDiscord,
                disabled: false,
                createdAt: nowMs()
            };
            state.scripts.push(script);
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, script: { id: script.id, name: script.name, obfuscated: script.obfuscated } }));
            return;
        }

        if (reqUrl.pathname.endsWith('/obfuscate') && reqUrl.pathname.startsWith('/api/scripts/') && req.method === 'POST') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/api/scripts/'.length, -'/obfuscate'.length));
            const script = getScriptById(scriptId);
            if (!script || !isScriptOwnedByWorkspace(script, activeWsId)) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                return;
            }
            script.code = obfuscateLuaSource(script.code || '', 'high');
            script.obfuscated = true;
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, message: `"${script.name}" uğurla obfuscate edildi!` }));
            return;
        }

        if (reqUrl.pathname.startsWith('/api/scripts/') && req.method === 'DELETE') {
            const scriptId = decodeURIComponent(reqUrl.pathname.slice('/api/scripts/'.length));
            const targetScript = getScriptById(scriptId);
            if (targetScript && isScriptOwnedByWorkspace(targetScript, activeWsId)) {
                state.scripts = state.scripts.filter((s) => s.id !== scriptId);
                persistState();
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (reqUrl.pathname === '/api/keys' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const script = getScriptById(String(body.scriptId || '').trim());
            if (!script || !isScriptOwnedByWorkspace(script, activeWsId)) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                return;
            }
            const durationMs = parseDurationToMs(body.time);
            if (durationMs === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Yanlış müddət formatı.' }));
                return;
            }
            const amount = Math.min(50, Math.max(1, Number(body.amount || 1)));
            const created = [];
            for (let i = 0; i < amount; i++) {
                const code = generateKeyCode();
                state.keys.push({
                    id: generateId('key'),
                    code,
                    scriptId: script.id,
                    durationMs,
                    expiresAt: null,
                    createdBy: null,
                    createdByName: 'Veb Panel',
                    redeemedBy: null,
                    redeemedByName: null,
                    redeemedAt: null,
                    hwid: null,
                    disabled: false,
                    createdAt: nowMs()
                });
                created.push(code);
            }
            persistState();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, keys: created }));
            return;
        }

        if (reqUrl.pathname === '/api/whitelist' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const script = getScriptById(String(body.scriptId || '').trim());
            const userId = String(body.userId || '').trim();
            if (!script || !isScriptOwnedByWorkspace(script, activeWsId)) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Skript tapılmadı.' }));
                return;
            }
            if (!userId) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Discord User ID daxil edin.' }));
                return;
            }
            const durationMs = parseDurationToMs(body.time);
            if (durationMs === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Yanlış müddət formatı.' }));
                return;
            }
            await applyWhitelistForTargets(script, [{ id: userId }], durationMs);
            const autoKey = getUserKeyForScript(userId, script.id);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, key: autoKey ? autoKey.code : null }));
            return;
        }

        if (reqUrl.pathname.startsWith('/api/whitelist/') && req.method === 'DELETE') {
            const wlId = decodeURIComponent(reqUrl.pathname.slice('/api/whitelist/'.length));
            const targetWl = state.whitelists.find((w) => w.id === wlId);
            if (targetWl) {
                const scr = getScriptById(targetWl.scriptId);
                if (scr && isScriptOwnedByWorkspace(scr, activeWsId)) {
                    targetWl.revoked = true;
                    persistState();
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (reqUrl.pathname === '/api/backup' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': 'attachment; filename="sado-protect-backup.json"'
            });
            res.end(JSON.stringify(state, null, 2));
            return;
        }

        if (reqUrl.pathname === '/api/restore' && req.method === 'POST') {
            const parsed = await readJsonBody(req);
            if (!parsed || typeof parsed !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, message: 'Yanlış backup faylı.' }));
                return;
            }
            applyLoadedObject(parsed);
            persistState();
            if (runtimeBotToken) {
                startOrRestartBot().catch(() => {});
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Endpoint tapılmadı.' }));
    } catch (err) {
        console.error('[SADO PROTECT] HTTP server xətası:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: err.message || 'Server xətası' }));
    }
});

function startKeepAliveLoop() {
    if (KEEP_ALIVE_INTERVAL_MS <= 0) return;
    setInterval(async () => {
        try {
            const targetUrl = PUBLIC_BASE_URL.startsWith('http')
                ? `${PUBLIC_BASE_URL}/health`
                : `http://127.0.0.1:${PORT}/health`;
            await fetch(targetUrl, { signal: AbortSignal.timeout(8000) }).catch(() => {});
            if (runtimeBotToken && (!client || !client.user)) {
                startOrRestartBot().catch(() => {});
            }
        } catch (_) {}
    }, KEEP_ALIVE_INTERVAL_MS);
}

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`[SADO PROTECT] HTTP server ${PORT} portunda işləyir (${PUBLIC_BASE_URL})`);
    await hydrateFromCloudIfAvailable();
    startKeepAliveLoop();
    if (!runtimeBotToken) {
        console.error('[SADO PROTECT] Qeyd: DISCORD_BOT_TOKEN hələ təyin edilməyib. Render Environment Variables bölməsindən daxil edin.');
    } else {
        startOrRestartBot().catch((err) => {
            console.error('[SADO PROTECT] Discord login xətası:', err.message);
        });
    }
});
