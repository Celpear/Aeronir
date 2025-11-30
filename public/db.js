async function loadDB() {
    try {
        const res = await fetch('/api/db');
        const data = await res.json();

        const container = document.getElementById('db-content');
        container.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        console.error(err);
        document.getElementById('db-content').textContent = 'Error loading database';
    }
}

async function resetDB() {
    if (!confirm('Really delete all data? This action cannot be undone!')) {
        return;
    }

    try {
        await fetch('/api/db/reset', { method: 'DELETE' });
        await loadDB();
        showToast('Database reset');
    } catch (err) {
        console.error(err);
        alert('Error resetting database');
    }
}

function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

document.addEventListener('DOMContentLoaded', () => {
    loadDB();

    document.getElementById('refresh-btn').addEventListener('click', loadDB);
    document.getElementById('reset-btn').addEventListener('click', resetDB);
});
