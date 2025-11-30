// Socket.io Real-time Sync Client

let socket = null;
let onlineUsers = [];
let authToken = null;

// Get token from cookie
function getTokenFromCookie() {
    const match = document.cookie.match(/token=([^;]+)/);
    return match ? match[1] : null;
}

// Initialize socket connection
function initSocket(token) {
    if (socket && socket.connected) return socket;
    
    authToken = token || getTokenFromCookie();
    if (!authToken) {
        console.warn('No auth token found for socket connection');
        return null;
    }
    
    socket = io({
        auth: { token: authToken }
    });
    
    socket.on('connect', () => {
        console.log('🔌 Connected to server');
        showToast('Connected to server', 'success');
    });
    
    socket.on('disconnect', () => {
        console.log('🔌 Disconnected from server');
        showToast('Disconnected from server', 'warning');
    });
    
    socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err.message);
    });
    
    // Online users update
    socket.on('users:online', (users) => {
        onlineUsers = users;
        updateOnlineUsersUI();
    });
    
    // Real-time events
    socket.on('label:created', (label) => {
        console.log('🏷️ Label created:', label);
        if (typeof handleLabelCreated === 'function') {
            handleLabelCreated(label);
        }
        showToast(`${label.userEmail} created label "${label.name}"`, 'info');
    });
    
    socket.on('label:deleted', (data) => {
        console.log('🗑️ Label deleted:', data);
        if (typeof handleLabelDeleted === 'function') {
            handleLabelDeleted(data.id);
        }
        showToast(`${data.deletedBy} deleted a label`, 'info');
    });
    
    socket.on('box:created', (box) => {
        console.log('📦 Box created:', box);
        if (typeof handleBoxCreated === 'function') {
            handleBoxCreated(box);
        }
        showToast(`${box.userEmail} added a box`, 'info');
    });
    
    socket.on('box:deleted', (data) => {
        console.log('🗑️ Box deleted:', data);
        if (typeof handleBoxDeleted === 'function') {
            handleBoxDeleted(data.id);
        }
        if (data.deletedBy) {
            showToast(`${data.deletedBy} deleted a box`, 'info');
        }
    });
    
    socket.on('db:reset', (data) => {
        console.log('💥 Database reset by:', data.resetBy);
        showToast(`Database reset by ${data.resetBy}!`, 'warning');
        // Reload page after reset
        setTimeout(() => location.reload(), 2000);
    });
    
    // Cursor updates from other users
    socket.on('cursor:update', (data) => {
        if (typeof handleCursorUpdate === 'function') {
            handleCursorUpdate(data);
        }
    });
    
    return socket;
}

// Send cursor position
function sendCursorPosition(lat, lng) {
    if (socket && socket.connected) {
        socket.emit('cursor:move', { lat, lng });
    }
}

// Update online users display
function updateOnlineUsersUI() {
    const container = document.getElementById('online-users');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Count unique users
    const uniqueUsers = [...new Map(onlineUsers.map(u => [u.id, u])).values()];
    
    const countBadge = document.createElement('span');
    countBadge.className = 'online-count';
    countBadge.innerHTML = `<span class="pulse-dot"></span> ${uniqueUsers.length} online`;
    container.appendChild(countBadge);
    
    uniqueUsers.forEach(user => {
        const userBadge = document.createElement('span');
        userBadge.className = 'online-user';
        userBadge.title = user.email;
        userBadge.textContent = user.email.split('@')[0].slice(0, 2).toUpperCase();
        userBadge.style.backgroundColor = stringToColor(user.email);
        container.appendChild(userBadge);
    });
}

// Generate color from string (for user avatars)
function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = hash % 360;
    return `hsl(${hue}, 60%, 45%)`;
}

// Toast notification system
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remove after 4 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Export functions
window.initSocket = initSocket;
window.sendCursorPosition = sendCursorPosition;
window.showToast = showToast;
window.getOnlineUsers = () => onlineUsers;


