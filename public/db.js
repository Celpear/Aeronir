async function loadDB() {
    try {
        const res = await fetch('/api/db', { credentials: 'include' });

        if (!res.ok) {
            throw new Error('Failed to load database');
        }

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
        const res = await fetch('/api/db/reset', {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || 'Reset failed');
        }

        await loadDB();
        showToastLocal('Database reset successfully!', 'success');
    } catch (err) {
        console.error(err);
        showToastLocal('Error: ' + err.message, 'error');
    }
}

function showToastLocal(message, type = 'info') {
    // Use global showToast if available (from socket.js)
    if (typeof window.showToast === 'function') {
        window.showToast(message, type);
        return;
    }

    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication
    const auth = await requireAuth();
    if (!auth) return;

    updateUserUI(auth.user);

    const resetBtn = document.getElementById('reset-btn');

    if (auth.user.role === 'admin') {
        document.getElementById('admin-link').style.display = '';
        resetBtn.style.display = '';
    } else {
        // Hide reset button for non-admins
        resetBtn.style.display = 'none';
    }

    loadDB();

    document.getElementById('refresh-btn').addEventListener('click', loadDB);
    resetBtn.addEventListener('click', resetDB);
});

