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
                <p>Create a named project, upload images into train/valid/test, label objects, then download a YOLO ZIP.</p>
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
                    <h2><a href="/dataset?id=${p.id}">${escapeHtml(p.name)}</a></h2>
                    <div class="dataset-actions"><button class="dataset-edit icon-action" data-id="${p.id}" aria-label="Edit dataset">Edit</button><button class="danger-btn project-delete" data-id="${p.id}" title="Delete dataset">Delete</button></div>
                </div>
                ${p.description ? `<p class="project-desc">${escapeHtml(p.description)}</p>` : ''}
                <div class="project-meta">
                    <span>${s.imageCount || 0} images</span>
                    <span>${s.labelCount || 0} classes</span>
                    <span>${s.annotationCount || 0} boxes</span>
                </div>
                <div class="project-splits">
                    <span class="split-pill train">train ${splits.train || 0}</span>
                    <span class="split-pill valid">valid ${splits.valid || 0}</span>
                    <span class="split-pill test">test ${splits.test || 0}</span>
                    <span class="split-pill unassigned">open ${splits.unassigned || 0}</span>
                </div>
                <div class="project-card-footer">
                    <small>Updated ${formatDate(p.updatedAt || p.createdAt)}</small>
                    <div class="dataset-actions"><a class="export-btn small-link-btn" href="/dataset?id=${p.id}">Open</a><button class="export-btn primary small-link-btn" data-train-source="custom:${p.id}">Train model <span aria-hidden="true">→</span></button></div>
                </div>
            </article>
        `;
    }).join('');

    document.dispatchEvent(new CustomEvent('datasets-rendered'));

    grid.querySelectorAll('.project-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!await confirmAction('Delete this project and all of its images/labels?')) return;
            try {
                await api(`/api/projects/${id}`, { method: 'DELETE' });
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
    const projects = await api('/api/projects');
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
            const project = await api('/api/projects', {
                method: 'POST',
                body: JSON.stringify({ name, description })
            });
            window.location.href = `/dataset?id=${project.id}`;
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
