function buildLocalLuaPayload(scriptObj, keyEntry, userId) {
    const safeTitle = String(scriptObj.name || 'SADO_SCRIPT').replace(/"/g, '\\"');
    const safeKey = String(keyEntry.key || '').replace(/"/g, '\\"');
    const safeUserId = String(userId || '').replace(/"/g, '\\"');
    const rawLua = String(scriptObj.code || scriptObj.lua || '').trim();

    const bodyLines = [
        `local SCRIPT_NAME = "${safeTitle}"`,
        `local SCRIPT_KEY = "${safeKey}"`,
        `local BOUND_USER = "${safeUserId}"`,
        `local Players = game:GetService("Players")`,
        `local RbxAnalyticsService = game:GetService("RbxAnalyticsService")`,
        `local lp = Players.LocalPlayer`,
        `if not lp then return end`,
        `local hwid = tostring(RbxAnalyticsService:GetClientId())`,
        `if SCRIPT_KEY == "" or hwid == "" then`,
        `    lp:Kick("[SADO PROTECT] Key ve ya HWID tapilmadi.")`,
        `    return`,
        `end`,
        `print("[SADO PROTECT] Yuklendi: " .. SCRIPT_NAME .. " | User: " .. BOUND_USER)`
    ];

    if (rawLua.length > 0) {
        bodyLines.push('(function()');
        bodyLines.push(rawLua);
        bodyLines.push('end)()');
    }

    return bodyLines.join('\n');
}

function ensureAutoWhitelistKey(scriptObj, userId, durationRaw, createdBy) {
    const sid = String(scriptObj.id);
    const uid = String(userId);
    const existing = findExistingKeyForUserInScript(sid, uid);
    if (existing) {
        return { ...existing, alreadyHadKey: true };
    }
    const generated = generateKeysForScript(scriptObj, {
        durationRaw,
        amount: 1,
        createdBy,
        assignedUserId: uid
    });
    return { key: generated[0], alreadyHadKey: false };
}

function verifySingleUserScriptAccess(scriptObj, userId, hwid) {
    const sid = String(scriptObj.id);
    const uid = String(userId);
    const keyEntry = findKeyForUserInScript(sid, uid);

    if (!keyEntry || keyEntry.scriptId !== sid) {
        return { allowed: false, reason: `Bu skript (${scriptObj.name}) üçün whitelist və ya key-iniz yoxdur.` };
    }
    if (keyEntry.revoked || keyEntry.disabled) {
        return { allowed: false, reason: 'Bu key ləğv edilib.' };
    }
    if (keyEntry.expiresAt && Date.now() > Number(keyEntry.expiresAt)) {
        return { allowed: false, reason: 'Key-in vaxtı bitib.' };
    }
    if (keyEntry.boundUserId && String(keyEntry.boundUserId) !== uid) {
        return { allowed: false, reason: 'Bu key artıq başqa 1 istifadəçiyə bağlıdır.' };
    }

    keyEntry.boundUserId = uid;
    if (hwid) {
        if (keyEntry.hwid && String(keyEntry.hwid) !== String(hwid)) {
            return { allowed: false, reason: 'Bu key başqa cihazın HWID-inə bağlıdır (Reset HWID istifadə edin).' };
        }
        keyEntry.hwid = String(hwid);
    }

    persistState();
    return { allowed: true, keyEntry };
}

function resetUserHwidForScript(scriptObj, userId) {
    const sid = String(scriptObj.id);
    const uid = String(userId);
    const keyEntry = findKeyForUserInScript(sid, uid);
    if (!keyEntry || keyEntry.scriptId !== sid) {
        return { ok: false, reason: 'Bu skript üçün aktiv key tapılmadı.' };
    }
    keyEntry.hwid = null;
    persistState();
    return { ok: true };
}
