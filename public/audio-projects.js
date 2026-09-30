async function api(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

function renderProjects(projects) {
    const grid = document.getElementById('projects-grid');
    if (!projects.length) {
        grid.innerHTML = `
            <div class="empty-projects">
                <h2>No projects yet</h2>
                <p>Create a dataset, upload WAV or MP3 tracks, and label audio segments.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = projects.map((p) => {
        const s = p.stats || {};
        const splits = s.splits || {};
        return `
            <article class="project-card">
                <div class="project-card-top">
                    <h2><a href="/audio-dataset?id=${p.id}">${escapeHtml(p.name)}</a></h2>
                    <button class="delete-btn project-delete" data-id="${p.id}" title="Delete project">×</button>
                </div>
                ${p.description ? `<p class="project-desc">${escapeHtml(p.description)}</p>` : ''}
                <div class="project-meta">
                    <span>${s.trackCount || 0} tracks</span>
                    <span>${s.labelCount || 0} classes</span>
                    <span>${s.segmentCount || 0} segments</span>
                </div>
                <div class="project-splits">
                    <span class="split-pill train">train ${splits.train || 0}</span>
                    <span class="split-pill valid">valid ${splits.valid || 0}</span>
                    <span class="split-pill test">test ${splits.test || 0}</span>
                    <span class="split-pill unassigned">open ${splits.unassigned || 0}</span>
                </div>
                <div class="project-card-footer">
                    <small>Updated ${formatDate(p.updatedAt || p.createdAt)}</small>
                    <a class="export-btn primary small-link-btn" href="/audio-dataset?id=${p.id}">Open</a>
                </div>
            </article>
        `;
    }).join('');

    grid.querySelectorAll('.project-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!confirm('Delete this project and all of its tracks and labeled segments?')) return;
            try {
                await api(`/api/audio-projects/${id}`, { method: 'DELETE' });
                await loadProjects();
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function loadProjects() {
    const projects = await api('/api/audio-projects');
    renderProjects(projects);
}

document.addEventListener('DOMContentLoaded', async () => {
    const auth = await requireAuth();
    if (!auth) return;
    updateUserUI(auth.user);
    if (auth.user.role === 'admin') {
        document.getElementById('admin-link').style.display = '';
        document.getElementById('db-link').style.display = '';
    }

    const form = document.getElementById('create-project-form');
    const createBtn = document.getElementById('create-project-btn');
    const cancelBtn = document.getElementById('cancel-create-btn');

    createBtn.addEventListener('click', () => {
        form.hidden = false;
        document.getElementById('project-name').focus();
    });
    cancelBtn.addEventListener('click', () => {
        form.hidden = true;
        form.reset();
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('project-name').value.trim();
        const description = document.getElementById('project-description').value.trim();
        try {
            const project = await api('/api/audio-projects', {
                method: 'POST',
                body: JSON.stringify({ name, description })
            });
            window.location.href = `/audio-dataset?id=${project.id}`;
        } catch (err) {
            alert(err.message);
        }
    });

    try {
        await loadProjects();
    } catch (err) {
        document.getElementById('projects-grid').innerHTML =
            `<p class="no-data">Error loading projects: ${escapeHtml(err.message)}</p>`;
    }
});
