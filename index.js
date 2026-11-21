// ... existing code ...
function checkUserAccess(userId, scriptId) {
    const uid = String(userId || '').trim();
    const targetScriptId = String(scriptId || '').trim();
    if (!uid || !targetScriptId) return { allowed: false };

    const foundKey = Object.values(store.keys || {}).find(
        k =>
            k &&
            String(k.scriptId || '').trim() === targetScriptId &&
            (
                String(k.redeemedBy || '').trim() === uid ||
                String(k.assignedUserId || '').trim() === uid
            ) &&
            !k.revoked &&
            !isExpired(k.expiresAt)
    );

    const wlKey = `${targetScriptId}:${uid}`;
    const wl = store.whitelist[wlKey];
    const hasValidWl = Boolean(
        wl &&
        String(wl.scriptId || '').trim() === targetScriptId &&
        String(wl.userId || '').trim() === uid &&
        !isExpired(wl.expiresAt)
    );

    if (foundKey) {
        if (!foundKey.redeemedBy) {
            foundKey.redeemedBy = uid;
            foundKey.redeemedAt = foundKey.redeemedAt || Date.now();
            if (wl) {
                foundKey.username = foundKey.username || wl.username;
                foundKey.displayName = foundKey.displayName || wl.displayName;
                foundKey.avatarUrl = foundKey.avatarUrl || wl.avatarUrl;
                foundKey.profileUrl = foundKey.profileUrl || wl.profileUrl;
            }
            saveStoreToDisk();
        }
        return {
            allowed: true,
            source: hasValidWl || foundKey.isWhitelistKey ? 'whitelist' : 'key',
            record: foundKey,
            wlKey: hasValidWl ? wlKey : null
        };
    }

    if (hasValidWl) {
        const autoCode = wl.keyCode && store.keys[wl.keyCode]
            ? wl.keyCode
            : generateLicenseKey();
        const durationMs = wl.expiresAt ? Math.max(1000, Number(wl.expiresAt) - Date.now()) : 0;
        const createdKey = store.keys[autoCode] || {
            code: autoCode,
            guildId: normalizeGuildId(wl.guildId || ''),
            scriptId: targetScriptId,
            durationLabel: wl.durationLabel || 'lifetime',
            durationMs,
            expiresAt: wl.expiresAt || null,
            redeemedBy: uid,
            assignedUserId: uid,
            isWhitelistKey: true,
            redeemedAt: wl.addedAt || Date.now(),
            username: wl.username || uid,
            displayName: wl.displayName || wl.username || uid,
            avatarUrl: wl.avatarUrl || '',
            profileUrl: wl.profileUrl || `https://discord.com/users/${uid}`,
            hwid: wl.hwid || null,
            createdAt: wl.addedAt || Date.now()
        };
        createdKey.redeemedBy = uid;
        createdKey.assignedUserId = uid;
        createdKey.isWhitelistKey = true;
        if (wl.hwid && !createdKey.hwid) createdKey.hwid = wl.hwid;
        store.keys[autoCode] = createdKey;
        wl.keyCode = autoCode;
        saveStoreToDisk();

        return {
            allowed: true,
            source: 'whitelist',
            record: createdKey,
            wlKey
        };
    }

    return { allowed: false };
}

function issueUserWhitelistKey({ guildId, scriptId, userId, username, displayName, avatarUrl, profileUrl, durationLabel }) {
    const uid = String(userId || '').trim();
    const sid = String(scriptId || '').trim();
    const gid = normalizeGuildId(guildId || '');
    const expiresAt = parseDurationLabelToExpiresAt(durationLabel);
    const durationMs = DURATION_OPTIONS[String(durationLabel || 'lifetime').trim().toLowerCase()] || 0;
    const wlKey = `${sid}:${uid}`;
    const existingWl = store.whitelist[wlKey];

    let keyCode = existingWl && existingWl.keyCode && store.keys[existingWl.keyCode]
        ? existingWl.keyCode
        : null;

    if (!keyCode) {
        const existingUserKey = Object.values(store.keys || {}).find(
            k =>
                k &&
                String(k.scriptId || '') === sid &&
                (String(k.redeemedBy || '') === uid || String(k.assignedUserId || '') === uid) &&
                !k.revoked
        );
        if (existingUserKey) {
            keyCode = existingUserKey.code;
        }
    }

    if (!keyCode) {
        keyCode = generateLicenseKey();
    }

    const prevKey = store.keys[keyCode] || {};
    const preservedHwid = prevKey.hwid || (existingWl ? existingWl.hwid : null) || null;

    store.keys[keyCode] = {
        code: keyCode,
        guildId: gid || prevKey.guildId || '',
        scriptId: sid,
        durationLabel: durationLabel || 'lifetime',
        durationMs,
        expiresAt,
        redeemedBy: uid,
        assignedUserId: uid,
        isWhitelistKey: true,
        redeemedAt: prevKey.redeemedAt || Date.now(),
        username: username || prevKey.username || (existingWl && existingWl.username) || uid,
        displayName: displayName || prevKey.displayName || (existingWl && existingWl.displayName) || username || uid,
        avatarUrl: avatarUrl || prevKey.avatarUrl || (existingWl && existingWl.avatarUrl) || '',
        profileUrl: profileUrl || prevKey.profileUrl || `https://discord.com/users/${uid}`,
        hwid: preservedHwid,
        revoked: false,
        createdAt: prevKey.createdAt || Date.now()
    };

    store.whitelist[wlKey] = {
        guildId: gid || (existingWl && existingWl.guildId) || '',
        scriptId: sid,
        userId: uid,
        keyCode,
        username: username || (existingWl && existingWl.username) || uid,
        displayName: displayName || (existingWl && existingWl.displayName) || username || uid,
        avatarUrl: avatarUrl || (existingWl && existingWl.avatarUrl) || '',
        profileUrl: profileUrl || `https://discord.com/users/${uid}`,
        durationLabel: durationLabel || 'lifetime',
        expiresAt,
        hwid: preservedHwid,
        addedAt: existingWl ? existingWl.addedAt : Date.now()
    };

    saveStoreToDisk();
    return { wlKey, keyCode, expiresAt };
}

function buildProtectedLuaPayload(rawCode, expectedKey = '') {
    const sourceText = String(rawCode || '');
    const cleanExpectedKey = String(expectedKey || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
    const xorKey = crypto.randomBytes(16);
    const rawBytes = Buffer.from(sourceText, 'utf8');
    const encBytes = Buffer.alloc(rawBytes.length);

    for (let i = 0; i < rawBytes.length; i++) {
        encBytes[i] = rawBytes[i] ^ xorKey[i % xorKey.length];
    }

    const encodedB64 = encBytes.toString('base64');
    const keyList = Array.from(xorKey).join(',');

    const luaLines = [
        '-- SADO PROTECT LOADER v4',
        'local _b64 = "' + encodedB64 + '"',
        'local _xor = {' + keyList + '}',
        'local _c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"',
        'local function _b64Decode(data)',
        '    local clean = string.gsub(data, "[^A-Za-z0-9+/=]", "")',
        '    local out = {}',
        '    for i = 1, #clean, 4 do',
        '        local c1 = string.sub(clean, i, i)',
        '        local c2 = string.sub(clean, i + 1, i + 1)',
        '        local c3 = string.sub(clean, i + 2, i + 2)',
        '        local c4 = string.sub(clean, i + 3, i + 3)',
        '        local v1 = (string.find(_c, c1, 1, true) or 1) - 1',
        '        local v2 = (string.find(_c, c2, 1, true) or 1) - 1',
        '        local v3 = (c3 == "=" or c3 == "") and 0 or ((string.find(_c, c3, 1, true) or 1) - 1)',
        '        local v4 = (c4 == "=" or c4 == "") and 0 or ((string.find(_c, c4, 1, true) or 1) - 1)',
        '        local b1 = v1 * 4 + math.floor(v2 / 16)',
        '        table.insert(out, string.char(b1 % 256))',
        '        if c3 ~= "=" and c3 ~= "" then',
        '            local b2 = (v2 % 16) * 16 + math.floor(v3 / 4)',
        '            table.insert(out, string.char(b2 % 256))',
        '        end',
        '        if c4 ~= "=" and c4 ~= "" then',
        '            local b3 = (v3 % 4) * 64 + v4',
        '            table.insert(out, string.char(b3 % 256))',
        '        end',
        '    end',
        '    return table.concat(out)',
        'end',
        'local function _bxorByte(a, b)',
        '    if bit32 and bit32.bxor then',
        '        return bit32.bxor(a, b)',
        '    end',
        '    local res = 0',
        '    local bitVal = 1',
        '    local x = a',
        '    local y = b',
        '    while x > 0 or y > 0 do',
        '        local bx = x % 2',
        '        local by = y % 2',
        '        if bx ~= by then',
        '            res = res + bitVal',
        '        end',
        '        x = math.floor(x / 2)',
        '        y = math.floor(y / 2)',
        '        bitVal = bitVal * 2',
        '    end',
        '    return res',
        'end'
    ];

    if (cleanExpectedKey) {
        luaLines.push(
            'local _rawKey = (getgenv and getgenv().script_key) or rawget(_G, "script_key") or script_key or ""',
            'if tostring(_rawKey) ~= "' + cleanExpectedKey + '" then',
            '    warn("[SADO PROTECT] Yanlis ve ya bos script_key!")',
            '    return',
            'end'
        );
    }

    luaLines.push(
        'local _decoded = _b64Decode(_b64)',
        'local _chars = {}',
        'local _keyLen = #_xor',
        'for idx = 1, #_decoded do',
        '    local byteVal = string.byte(_decoded, idx)',
        '    local xorVal = _xor[((idx - 1) % _keyLen) + 1]',
        '    table.insert(_chars, string.char(_bxorByte(byteVal, xorVal)))',
        'end',
        'local _scriptSource = table.concat(_chars)',
        'local _loaderFn = loadstring or load',
        'if type(_loaderFn) ~= "function" then',
        '    warn("[SADO PROTECT] Executor loadstring desteklemir!")',
        '    return',
        'end',
        'local _compiled, _compileErr = _loaderFn(_scriptSource)',
        'if type(_compiled) == "function" then',
        '    return _compiled()',
        'end',
        'warn("[SADO PROTECT] Script yuklenme xetasi: " .. tostring(_compileErr))'
    );

    return luaLines.join('\n');
}

    const encodedB64 = Buffer.from(encBytes).toString('base64');
    const keyList = Array.from(xorKey).join(',');
    const keyCheckSnippet = cleanExpectedKey
        ? [
            'local _k = tostring(getgenv and getgenv().script_key or rawget(_G, "script_key") or script_key or "")',
            'if _k ~= "' + cleanExpectedKey.replace(/"/g, '') + '" then',
            '    warn("[SADO PROTECT] Yanlis ve ya bos script_key!")',
            '    return',
            'end'
        ]
        : [];

    return [
        '-- SADO PROTECT LOADER v4',
        ...keyCheckSnippet,
        'local _b64 = "' + encodedB64 + '"',
        'local _xor = {' + keyList + '}',
        'local _c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"',
        'local function _decB64(data)',
        '    data = string.gsub(data, "[^" .. _c .. "=]", "")',
        '    return (data:gsub(".", function(x)',
        '        if x == "=" then return "" end',
        '        local r, f = "", (_c:find(x, 1, true) - 1)',
        '        for i = 6, 1, -1 do r = r .. (f % 2^i - f % 2^(i - 1) > 0 and "1" or "0") end',
        '        return r',
        '    end):gsub("%d%d%d?%d?%d?%d?%d?%d?", function(x)',
        '        if #x ~= 8 then return "" end',
        '        local n = 0',
        '        for i = 1, 8 do if x:sub(i, i) == "1" then n = n + 2^(8 - i) end end',
        '        return string.char(n)',
        '    end))',
        'end',
        'local _raw = _decB64(_b64)',
        'local _out = {}',
        'for i = 1, #_raw do',
        '    local b = string.byte(_raw, i)',
        '    local k = _xor[((i - 1) % #_xor) + 1]',
        '    if bit32 and bit32.bxor then',
        '        _out[i] = string.char(bit32.bxor(b, k))',
        '    else',
        '        local res, p = 0, 1',
        '        local x, y = b, k',
        '        while x > 0 or y > 0 do',
        '            if (x % 2) ~= (y % 2) then res = res + p end',
        '            x = math.floor(x / 2)',
        '            y = math.floor(y / 2)',
        '            p = p * 2',
        '        end',
        '        _out[i] = string.char(res)',
        '    end',
        'end',
        'local _src = table.concat(_out)',
        'local _fn, _err = loadstring(_src)',
        'if type(_fn) == "function" then',
        '    return _fn()',
        'end',
        'local _runner = (loadstring or load)',
        'if type(_runner) == "function" then',
        '    local _fn2, _err2 = _runner(_src)',
        '    if type(_fn2) == "function" then return _fn2() end',
        '    warn("[SADO PROTECT] Script xetasi: " .. tostring(_err2))',
        'else',
        '    warn("[SADO PROTECT] Executor loadstring desteklemir: " .. tostring(_err))',
        'end'
    ].join('\n');
}

function createLoaderTicket(scriptId, userId, guildId = '', licenseKey = '') {
    const ticketId = crypto.randomBytes(24).toString('base64url');
    const host = process.env.RENDER_EXTERNAL_URL
        ? String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '')
        : 'https://sado-protect.onrender.com';
    const loaderUrl = `${host}/files/v4/loaders/${ticketId}.lua`;
    const cleanKey = String(licenseKey || '').trim();
    const loaderCode = cleanKey
        ? `script_key = "${cleanKey}"\nloadstring(game:HttpGet("${loaderUrl}"))()`
        : `loadstring(game:HttpGet("${loaderUrl}"))()`;

    store.tickets[ticketId] = {
        ticketId,
        scriptId,
        userId: String(userId),
        guildId: normalizeGuildId(guildId),
        licenseKey: cleanKey,
        loaderCode,
        createdAt: Date.now(),
        expiresAt: null
    };
    saveStoreToDisk();

    return { ticketId, loaderUrl, loaderCode };
}
// ... existing code ...
                if (cmd === 'whitelist') {
                    const targetUser = interaction.options.getUser('user', true);
                    const timeLabel = interaction.options.getString('time', true);
                    const scriptQuery = interaction.options.getString('script');
                    const scriptObj = findScript(scriptQuery, interaction.guildId || '');

                    if (!scriptObj) {
                        await interaction.reply({ content: 'Skript tapılmadı!', flags: MessageFlags.Ephemeral });
                        return;
                    }

                    const issued = issueUserWhitelistKey({
                        guildId: interaction.guildId || scriptObj.guildId || '',
                        scriptId: scriptObj.id,
                        userId: targetUser.id,
                        username: targetUser.username,
                        displayName: targetUser.globalName || targetUser.username,
                        avatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 128 }),
                        profileUrl: `https://discord.com/users/${targetUser.id}`,
                        durationLabel: timeLabel
                    });

                    const roleToGive = scriptObj.roleId || store.roleId;
                    if (interaction.guild && roleToGive) {
                        await assignRoleToUser(interaction.guild, targetUser.id, roleToGive);
                    }

                    await interaction.reply({
                        content:
                            `✅ <@${targetUser.id}> istifadəçisinə **${scriptObj.name}** üçün **${timeLabel}** whitelist verildi!\n` +
                            `🔑 Avto Whitelist Key: \`${issued.keyCode}\``,
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
                            if (v.keyCode && store.keys[v.keyCode]) {
                                delete store.keys[v.keyCode];
                            }
                            delete store.whitelist[k];
                            removed++;
                        }
                    }
                    for (const [kCode, kObj] of Object.entries(store.keys || {})) {
                        if (
                            kObj &&
                            kObj.isWhitelistKey &&
                            (String(kObj.assignedUserId) === String(targetUser.id) || String(kObj.redeemedBy) === String(targetUser.id)) &&
                            (!scriptQuery || kObj.scriptId === scriptQuery)
                        ) {
                            delete store.keys[kCode];
                        }
                    }
                    saveStoreToDisk();

                    await interaction.reply({
                        content: removed > 0
                            ? `🗑️ <@${targetUser.id}> whitelist-dən və bağlı key-dən çıxarıldı (${removed} qeyd silindi).`
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

                    const { ticketId, loaderCode } = createLoaderTicket(
                        scriptId,
                        interaction.user.id,
                        interaction.guildId || scriptObj.guildId || '',
                        access.record && access.record.code ? access.record.code : ''
                    );

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
                    if (access.wlKey && store.whitelist[access.wlKey]) {
                        store.whitelist[access.wlKey].hwid = null;
                    }
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
                            `• **Key:** \`${access.record.code || '—'}\`\n` +
                            `• **Müddət:** ${expText}\n` +
                            `• **HWID:** ${hwidText}`
                        );

                    await interaction.reply({ embeds: [statEmbed], flags: MessageFlags.Ephemeral });
                    return;
                }
            }
// ... existing code ...
                if (keyObj.redeemedBy && String(keyObj.redeemedBy) !== String(interaction.user.id)) {
                    await interaction.reply({
                        content: '❌ Bu key artıq başqa istifadəçi tərəfindən aktivləşdirilib.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                if (keyObj.assignedUserId && String(keyObj.assignedUserId) !== String(interaction.user.id)) {
                    await interaction.reply({
                        content: '❌ Bu whitelist key yalnız ona təyin olunmuş istifadəçiyə aiddir.',
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
// ... existing code ...
  '  var holders = [];',
  '  var seenWlKeys = {};',
  '  Object.values(stateData.whitelist || {}).forEach(function(w) {',
  '    var kMap = w.scriptId + ":" + w.userId;',
  '    seenWlKeys[kMap] = true;',
  '    holders.push({ type: "Whitelist" + (w.keyCode ? " (" + w.keyCode + ")" : ""), userId: w.userId, username: w.username || w.userId, displayName: w.displayName || w.username || w.userId, avatarUrl: w.avatarUrl || "", profileUrl: w.profileUrl || ("https://discord.com/users/" + w.userId), scriptId: w.scriptId, expiresAt: w.expiresAt, hwid: w.hwid, removeAction: "removeWhitelist(\'" + w.scriptId + ":" + w.userId + "\')" });',
  '  });',
  '  Object.values(stateData.keys || {}).forEach(function(k) {',
  '    if (k.redeemedBy) {',
  '      var kMap = k.scriptId + ":" + k.redeemedBy;',
  '      if (k.isWhitelistKey && seenWlKeys[kMap]) return;',
  '      holders.push({ type: "Key (" + k.code + ")", userId: k.redeemedBy, username: k.username || k.redeemedBy, displayName: k.displayName || k.username || k.redeemedBy, avatarUrl: k.avatarUrl || "", profileUrl: k.profileUrl || ("https://discord.com/users/" + k.redeemedBy), scriptId: k.scriptId, expiresAt: k.expiresAt, hwid: k.hwid, removeAction: "deleteKey(\'" + k.code + "\')" });',
  '    }',
  '  });',
// ... existing code ...
            if (!access.allowed || !scriptObj || String(scriptObj.id) !== String(ticket.scriptId)) {
                res.writeHead(403, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end('warn("[SADO PROTECT] Access denied or license expired!")');
                return;
            }

            if (ticket.licenseKey && access.record && access.record.code && String(access.record.code) !== String(ticket.licenseKey)) {
                res.writeHead(403, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end('warn("[SADO PROTECT] Key mismatch!")');
                return;
            }

            const effectiveHwid = hwid || `rbx-user-${String(ticket.userId)}`;
            if (!access.record.hwid) {
                access.record.hwid = effectiveHwid;
                if (access.wlKey && store.whitelist[access.wlKey]) {
                    store.whitelist[access.wlKey].hwid = effectiveHwid;
                }
                saveStoreToDisk();
            } else if (hwid && access.record.hwid !== hwid && !String(access.record.hwid).startsWith('rbx-user-')) {
                res.writeHead(403, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end('warn("[SADO PROTECT] HWID mismatch! Use Reset HWID in panel.")');
                return;
            } else if (hwid && String(access.record.hwid).startsWith('rbx-user-')) {
                access.record.hwid = hwid;
                if (access.wlKey && store.whitelist[access.wlKey]) {
                    store.whitelist[access.wlKey].hwid = hwid;
                }
                saveStoreToDisk();
            }

            const protectedPayload = buildProtectedLuaPayload(
                scriptObj.code || '',
                ticket.licenseKey || (access.record && access.record.code) || ''
            );

            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(protectedPayload);
            return;
        }
// ... existing code ...
        if (req.method === 'DELETE' && pathname.startsWith('/api/whitelist/')) {
            const wlKey = decodeURIComponent(pathname.slice('/api/whitelist/'.length));
            store._explicitDeletedWhitelist = Array.from(new Set([...(store._explicitDeletedWhitelist || []), wlKey]));
            const wlEntry = store.whitelist[wlKey];
            if (wlEntry && wlEntry.keyCode && store.keys[wlEntry.keyCode]) {
                store._explicitDeletedKeys = Array.from(new Set([...(store._explicitDeletedKeys || []), wlEntry.keyCode]));
                delete store.keys[wlEntry.keyCode];
            }
            delete store.whitelist[wlKey];
            saveStoreToDisk();
            sendJson(res, 200, { ok: true });
            return;
        }
// ... existing code ...
