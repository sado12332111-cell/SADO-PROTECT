client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isAutocomplete()) {
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'script') {
                const guildId = interaction.guildId || '';
                const scripts = getGuildScripts(guildId);
                const query = String(focused.value || '').trim().toLowerCase();
                const filtered = scripts
                    .filter((s) => !query || String(s.name || '').toLowerCase().includes(query) || String(s.id || '').toLowerCase().includes(query))
                    .slice(0, 25)
                    .map((s) => ({
                        name: String(s.name || s.id).slice(0, 100),
                        value: String(s.id).slice(0, 100)
                    }));
                await interaction.respond(filtered);
            }
            return;
        }

        if (interaction.isChatInputCommand()) {
            const cmd = interaction.commandName;

            if (cmd === 'setrole') {
                const role = interaction.options.getRole('role', true);
                store.roleId = role.id;
                saveStoreToDisk();
                await interaction.reply({ content: `✅ Whitelist rol <@&${role.id}> olaraq təyin edildi!`, flags: MessageFlags.Ephemeral });
                return;
            }

            if (cmd === 'panel') {
                const scriptQuery = interaction.options.getString('script');
                const guildId = interaction.guildId || '';
                const guildScripts = getGuildScripts(guildId);
                const scriptObj = findScript(scriptQuery, guildId) || guildScripts[0] || null;
                if (!scriptObj) {
                    await interaction.reply({ content: 'Skript tapılmadı! Əvvəlcə saytdan skript əlavə edin.', flags: MessageFlags.Ephemeral });
                    return;
                }
                const panelMsg = await sendScriptPanel(interaction.channel, scriptObj, guildId);
                if (!panelMsg) {
                    await interaction.reply({ content: 'Panel bu kanala göndərilə bilmədi!', flags: MessageFlags.Ephemeral });
                    return;
                }
                await interaction.reply({ content: `✅ **${scriptObj.name}** paneli göndərildi!`, flags: MessageFlags.Ephemeral });
                return;
            }

            if (cmd === 'genkey') {
// ... existing code ...
