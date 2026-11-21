// ... existing code ...
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
                    const scriptObj = findScript(scriptQuery, interaction.guildId || '');
                    if (!scriptObj) {
                        await interaction.reply({ content: 'Skript tapılmadı!', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    const panelMsg = await sendScriptPanel(interaction.channel, scriptObj, interaction.guildId || '');
                    if (!panelMsg) {
                        await interaction.reply({ content: 'Panel bu kanala göndərilə bilmədi!', flags: MessageFlags.Ephemeral });
                        return;
                    }
                    await interaction.reply({ content: `✅ **${scriptObj.name}** paneli göndərildi!`, flags: MessageFlags.Ephemeral });
                    return;
                }

                if (cmd === 'genkey') {
// ... existing code ...
