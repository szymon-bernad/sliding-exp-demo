// Page script: a modal form that saves through SessionUI.authFetch and keeps a
// sessionStorage draft as a safety net for full reloads.
(() => {
  const DRAFT_KEY = 'draft:note';
  const dlg = document.getElementById('note-dialog');
  const form = document.getElementById('note-form');
  const err = document.getElementById('note-error');
  const list = document.getElementById('notes');

  const saveDraft = () =>
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(new FormData(form))));
  const clearDraft = () => sessionStorage.removeItem(DRAFT_KEY);

  document.getElementById('new-note').addEventListener('click', () => {
    err.textContent = '';
    dlg.showModal();
  });

  document.getElementById('note-cancel').addEventListener('click', () => {
    clearDraft();
    form.reset();
    dlg.close();
  });

  form.addEventListener('input', saveDraft);
  document.addEventListener('session:before-redirect', () => { if (dlg.open) saveDraft(); });

  // Restore a draft left behind by a reload or a redirect sign-in.
  const saved = sessionStorage.getItem(DRAFT_KEY);
  if (saved) {
    for (const [k, v] of Object.entries(JSON.parse(saved))) {
      if (form.elements[k]) form.elements[k].value = v;
    }
    dlg.showModal();
    window.SessionUI?.log('restored unsaved draft from sessionStorage');
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    err.textContent = '';
    try {
      const r = await SessionUI.authFetch('?handler=Save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        err.textContent = body?.error ?? `Save failed (HTTP ${r.status}).`;
        return;
      }
      const note = await r.json();
      addNote(note);
      clearDraft();
      form.reset();
      dlg.close();
      SessionUI.log(`saved note #${note.id}`);
    } catch (ex) {
      err.textContent = `Save failed: ${ex.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });

  function addNote(n) {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = n.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ` #${n.id} · ${n.author} · ${new Date(n.created).toLocaleTimeString()}`;
    const body = document.createElement('div');
    body.textContent = n.body;
    li.append(title, meta, body);
    list.prepend(li);
  }
})();
