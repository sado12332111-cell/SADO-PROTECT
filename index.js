<<<<<<< SEARCH
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
document.getElementById('saveOneTimeTokenBtn').onclick = async () => {
=======
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
  const usePreObf = Boolean(alreadyObf.trim());
  const r = await api('/api/scripts', {
    method: 'POST',
    body: JSON.stringify({
      name,
      code: usePreObf ? alreadyObf : rawCode,
      obfuscate: !usePreObf,
      obfuscateLevel: level,
      preObfuscated: usePreObf
    })
  });
  if (r.ok) {
    document.getElementById('obfSaveScriptName').value = '';
    showToast('Obfuscated skript panelə əlavə olundu!');
    refreshAll();
  } else {
    showToast(r.message || 'Xəta baş verdi');
  }
};

document.getElementById('saveOneTimeTokenBtn').onclick = async () => {
>>>>>>> REPLACE
