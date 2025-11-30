// Auth utility functions

// Get stored auth token
function getAuthToken() {
    return localStorage.getItem('authToken');
}

// Store auth token
function setAuthToken(token) {
    if (token) {
        localStorage.setItem('authToken', token);
    } else {
        localStorage.removeItem('authToken');
    }
}

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
            const data = await res.json();
            // Return user and token
            return { user: data.user, token: getAuthToken() };
        }
        return null;
    } catch {
        return null;
    }
}

async function checkNeedsSetup() {
    try {
        const res = await fetch('/api/auth/needs-setup');
        const data = await res.json();
        return data.needsSetup;
    } catch {
        return false;
    }
}

async function logout() {
    setAuthToken(null);
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
}

// Redirect to login if not authenticated
async function requireAuth() {
    // First check if setup is needed
    if (await checkNeedsSetup()) {
        window.location.href = '/setup';
        return null;
    }

    const auth = await checkAuth();
    if (!auth || !auth.user) {
        window.location.href = '/login';
        return null;
    }
    return auth; // { user, token }
}

// Redirect to home if already authenticated
async function redirectIfAuth() {
    const auth = await checkAuth();
    if (auth) {
        window.location.href = '/';
        return true;
    }
    return false;
}

// Update UI with user info
function updateUserUI(user) {
    const userInfo = document.getElementById('user-info');
    if (userInfo && user) {
        userInfo.innerHTML = `
            <span class="user-email">${user.email}</span>
            ${user.role === 'admin' ? '<span class="user-badge">Admin</span>' : ''}
            <button onclick="logout()" class="logout-btn">Logout</button>
        `;
    }
}

// Show toast notification
function showToast(message, isError = false) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

