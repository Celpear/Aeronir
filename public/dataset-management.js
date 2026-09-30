const grid = document.getElementById('projects-grid');
const toolbar = document.createElement('div');
toolbar.className = 'dataset-toolbar';
toolbar.innerHTML = '<label>Find a dataset<input type="search" placeholder="Search name or description…" aria-label="Search datasets"></label><span role="status"></span>';
grid.before(toolbar);
function filterCards() {
    const query = toolbar.querySelector('input').value.trim().toLowerCase();
    const cards = [...grid.querySelectorAll('.project-card')];
    for (const card of cards) card.hidden = ![card.querySelector('h2')?.textContent, card.querySelector('.project-desc')?.textContent].join(' ').toLowerCase().includes(query);
    toolbar.querySelector('span').textContent = `${cards.filter(card => !card.hidden).length} of ${cards.length} datasets`;
}
toolbar.querySelector('input').oninput = filterCards;
document.addEventListener('datasets-rendered', filterCards); filterCards();
const dialog = document.createElement('dialog');
dialog.className = 'management-dialog'; dialog.setAttribute('aria-labelledby', 'edit-dataset-title');
dialog.innerHTML = '<form><header class="dialog-header"><h2 id="edit-dataset-title">Edit dataset</h2><button type="button" class="icon-action" aria-label="Close">✕</button></header><label>Name<input name="name" required maxlength="80"></label><label>Description<textarea name="description" maxlength="200" rows="3"></textarea></label><p role="status"></p><button class="export-btn primary" type="submit">Save changes</button></form>';
document.body.append(dialog);
let endpoint, busy = false;
const form = dialog.querySelector('form'), message = dialog.querySelector('[role=status]');
dialog.querySelector('[aria-label=Close]').onclick = () => { if (!busy) dialog.close(); };
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
document.addEventListener('click', event => {
    const button = event.target.closest('.dataset-edit'); if (!button) return;
    const card = button.closest('.project-card');
    endpoint = (location.pathname === '/audio-datasets' ? '/api/audio-projects/' : '/api/projects/') + encodeURIComponent(button.dataset.id);
    form.elements.name.value = card.querySelector('h2').textContent.trim();
    form.elements.description.value = card.querySelector('.project-desc')?.textContent.trim() || '';
    message.textContent = ''; dialog.showModal();
});
form.onsubmit = async event => {
    event.preventDefault(); if (busy) return; busy = true;
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
        const response = await fetch(endpoint, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:form.elements.name.value.trim(),description:form.elements.description.value.trim()})});
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save dataset.');
        location.reload();
    } catch(error) { message.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
};
