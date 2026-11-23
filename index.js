      const headerTitle = document.getElementById('headerTitle');
      const headerSub = document.getElementById('headerSub');
      const gSelect = document.getElementById('guildSelectDropdown');
      const linkGuildInput = document.getElementById('linkGuildIdInput');
      const linkDiscordInput = document.getElementById('linkDiscordIdInput');

    <section class="section" id="tab-discord">
      <div class="card">
        <h3>🤖 SADO PROTECT Botunu Sunucuna Əlavə Et (Join Discord)</h3>
        <p class="muted">
          1. Aşağıdakı düymə ilə <b>SADO PROTECT</b> botunu öz Discord sunucunuza əlavə edin.<br/>
          2. Bot sunucuya girdikdən sonra aşağıdan öz sunucunuzu seçin (və ya Sunucu ID-ni yazın) — yuxarıda öz sunucunuzun adı görünəcək və bütün idarəetmə paneli tam sizə bağlanacaq.
        </p>
        <a class="btn btn-green" id="inviteBotLinkBtn" href="https://discord.com/oauth2/authorize?client_id=1562080654282199121&permissions=2147600384&integration_type=0&scope=applications.commands+bot" target="_blank" rel="noopener noreferrer">➕ SADO PROTECT Botunu Sunucuna Əlavə Et</a>

        <label>Botun Olduğu Sunuculardan Öz Sunucunu Seç</label>
        <select id="guildSelectDropdown">
          <option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>
        </select>

        <label>Və ya Discord Sunucu ID (Server ID)</label>
        <input type="text" id="linkGuildIdInput" placeholder="Məs: 1559499280732131348" />

        <label>Discord User ID (istəyə bağlı)</label>
        <input type="text" id="linkDiscordIdInput" placeholder="Məs: 123456789012345678" />

        <button class="btn btn-primary" id="linkWorkspaceBtn">✅ Sunucunu İdarəetmə Panelinə Bağla</button>
      </div>

      <div class="card">
        <h3>🎨 Panel Buton və Embed Dizaynı</h3>
        <label>Embed Rəngi (HEX & Rəng Seçici)</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="color" id="cfgColorPicker" value="#5865F2" style="width:54px; height:42px; padding:2px; cursor:pointer; flex-shrink:0;" />
          <input type="text" id="cfgEmbedColor" placeholder="#5865F2" style="flex:1;" />
        </div>

        <label>Panel Başlığı</label>
        <input type="text" id="cfgTitle" placeholder="SADO PROTECT • Script Panel" />

        <label>Panel Açıqlaması</label>
        <input type="text" id="cfgDescription" placeholder="Aşağıdakı düymələrdən istifadə edərək key aktivləşdirin." />

        <label>Redeem Key Düymə Mətni və Rəngi</label>

      const pill = document.getElementById('botStatusPill');
      const hasAnyGuild = Array.isArray(data.bot.guilds) && data.bot.guilds.length > 0;
      if (data.bot.online || data.bot.hasToken || hasAnyGuild) {
        pill.textContent = 'Bot: Online ✅';
        pill.classList.add('online');
      } else {
        pill.textContent = 'Bot: Qoşulur...';
        pill.classList.remove('online');
      }

      if (data.bot && data.bot.inviteUrl) {
        const invBtn = document.getElementById('inviteBotLinkBtn');
        if (invBtn) invBtn.href = data.bot.inviteUrl;
      }

      const headerTitle = document.getElementById('headerTitle');
      const headerSub = document.getElementById('headerSub');
      if (data.activeGuildName) {
        headerTitle.textContent = data.activeGuildName;
        headerSub.textContent = 'SADO PROTECT • Control Panel';
        document.getElementById('statGuild').textContent = data.activeGuildName;
      } else {
        headerTitle.textContent = 'SADO PROTECT';
        headerSub.textContent = 'Control Dashboard';
        document.getElementById('statGuild').textContent = 'Seçilməyib';
      }

      const gSelect = document.getElementById('guildSelectDropdown');
      if (gSelect) {
        const prevSel = gSelect.value || data.activeGuildId || '';
        gSelect.innerHTML = '<option value="">-- Sunucu seçin və ya aşağıya ID yazın --</option>';
        (data.bot.guilds || []).forEach(g => {
          const opt = document.createElement('option');
          opt.value = g.id;
          opt.textContent = g.name + ' (' + g.id + ')';
          if (g.id === prevSel) opt.selected = true;
          gSelect.appendChild(opt);
        });
      }

      if (!initialInputsLoaded) {
        initialInputsLoaded = true;
        const linkGuildEl = document.getElementById('linkGuildIdInput');
        const linkDiscordEl = document.getElementById('linkDiscordIdInput');
        if (linkGuildEl && data.activeGuildId) linkGuildEl.value = data.activeGuildId;
        if (linkDiscordEl && data.activeDiscordUserId) linkDiscordEl.value = data.activeDiscordUserId;
        if (data.panelConfig) {
