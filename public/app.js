let map;
let currentTileLayer;
let drawEnabled = false;
let currentLabelId = null;
let currentLabelName = null;

// For drawing
let startLatLng = null;
let tempRect = null;
let lastTouchLatLng = null; // Store last touch position for touchend

// Saved boxes with their Leaflet objects
const rectangles = new Map(); // boxId -> { rect, data }

// Other users' cursors
const otherCursors = new Map(); // userId -> cursor element

// Current user (to ignore own events)
let currentUser = null;

// Tile Presets
const TILE_PRESETS = {
    sentinel: {
        url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
        maxZoom: 14,
        attribution: '&copy; <a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX'
    },
    osm: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        maxZoom: 19,
        attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
    },
    esri: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maxZoom: 18,
        attribution: '&copy; Esri, Maxar, Earthstar Geographics'
    }
};

// Current tile URL (for server communication)
let currentTileUrl = TILE_PRESETS.sentinel.url;

async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
    }
    return res.json();
}

// --- Labels ---

async function loadLabels() {
    const labels = await fetchJSON('/api/labels');

    const select = document.getElementById('label-select');
    select.innerHTML = '<option value="">-- please select --</option>';

    labels.forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        select.appendChild(opt);
    });

    updateLabelList(labels);
}

function updateLabelList(labels) {
    const container = document.getElementById('label-list');
    if (!container) return;

    container.innerHTML = '';

    labels.forEach(label => {
        const item = document.createElement('div');
        item.className = 'label-item';
        const color = getLabelColor(label.id);
        item.innerHTML = `
            <span class="label-color-dot" style="background: ${color}"></span>
            <span class="label-name" title="${label.name}">${label.name}</span>
            <button class="delete-btn" data-id="${label.id}" title="Delete label">×</button>
        `;
        container.appendChild(item);
    });

    // Event listeners for delete
    container.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = e.target.dataset.id;
            if (confirm('Delete label and all associated boxes?')) {
                await deleteLabel(id);
            }
        });
    });
}

async function deleteLabel(id) {
    try {
        await fetchJSON(`/api/labels/${id}`, { method: 'DELETE' });
        await loadLabels();
        await loadExistingBoxes();

        // Reset selection if deleted label was selected
        if (currentLabelId === Number(id)) {
            currentLabelId = null;
            currentLabelName = null;
            document.getElementById('label-select').value = '';
        }
    } catch (err) {
        console.error(err);
        alert('Error deleting label');
    }
}

async function addLabel() {
    const input = document.getElementById('new-label-input');
    const name = input.value.trim();
    if (!name) return;

    try {
        const label = await fetchJSON('/api/labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        input.value = '';

        // Reload list
        await loadLabels();

        // Select newly created label
        const select = document.getElementById('label-select');
        select.value = label.id;
        currentLabelId = label.id;
        currentLabelName = label.name;
    } catch (err) {
        console.error(err);
        alert('Error creating label');
    }
}

// --- Boxes ---

async function deleteBox(id) {
    try {
        await fetchJSON(`/api/boxes/${id}`, { method: 'DELETE' });

        // Remove rectangle from map
        const rectData = rectangles.get(id);
        if (rectData) {
            map.removeLayer(rectData.rect);
            rectangles.delete(id);
        }

        updateStats();
    } catch (err) {
        console.error(err);
        alert('Error deleting box');
    }
}

async function loadExistingBoxes() {
    try {
        // First remove all old rectangles
        rectangles.forEach(({ rect }) => map.removeLayer(rect));
        rectangles.clear();

        const boxes = await fetchJSON('/api/boxes');
        boxes.forEach((b) => {
            const sw = L.latLng(b.bounds.south, b.bounds.west);
            const ne = L.latLng(b.bounds.north, b.bounds.east);
            const rect = L.rectangle([sw, ne], {
                color: getLabelColor(b.labelId),
                weight: 2,
                fillOpacity: 0.2
            }).addTo(map);

            // Popup with delete button
            const popupContent = createPopupContent(b);
            rect.bindPopup(popupContent);

            rectangles.set(b.id, { rect, data: b });
        });

        updateStats();
    } catch (err) {
        console.error(err);
        alert('Error loading boxes');
    }
}

function createPopupContent(box) {
    const div = document.createElement('div');
    div.className = 'box-popup';
    div.innerHTML = `
        <strong>${box.labelName}</strong>
        <div class="popup-info">
            <small>Zoom: ${box.zoom || 'N/A'}</small><br>
            <small>Tiles: ${box.tiles ? box.tiles.length : 0}</small>
        </div>
        <button class="popup-delete-btn" onclick="deleteBox(${box.id})">Delete</button>
    `;
    return div;
}

function getLabelColor(labelId) {
    // Teal-based color palette
    const colors = [
        '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444',
        '#22c55e', '#3b82f6', '#ec4899', '#84cc16',
        '#06b6d4', '#f97316', '#a855f7', '#10b981'
    ];
    return colors[(labelId - 1) % colors.length];
}

function updateStats() {
    const statsEl = document.getElementById('stats');
    if (!statsEl) return;

    const boxCount = rectangles.size;
    const labelIds = new Set();
    rectangles.forEach(({ data }) => labelIds.add(data.labelId));

    statsEl.innerHTML = `
        <div class="stat">
            <span class="stat-value">${boxCount}</span>
            <span class="stat-label">Boxes</span>
        </div>
        <div class="stat">
            <span class="stat-value">${labelIds.size}</span>
            <span class="stat-label">Labels used</span>
        </div>
    `;
}

// --- Tile Layer ---

function setTileLayer(url, maxZoom = 18, attribution = '') {
    if (currentTileLayer) {
        map.removeLayer(currentTileLayer);
    }

    currentTileLayer = L.tileLayer(url, {
        maxZoom: maxZoom,
        attribution: attribution
    }).addTo(map);

    currentTileUrl = url;

    // Save to localStorage
    localStorage.setItem('tilePreset', document.getElementById('tile-preset').value);
    localStorage.setItem('customTileUrl', url);
}

function applyTilePreset(preset) {
    const customGroup = document.getElementById('custom-url-group');

    if (preset === 'custom') {
        customGroup.style.display = 'block';
        const customUrl = document.getElementById('custom-tile-url').value;
        if (customUrl) {
            setTileLayer(customUrl, 18, 'Custom Tiles');
        }
    } else {
        customGroup.style.display = 'none';
        const config = TILE_PRESETS[preset];
        if (config) {
            setTileLayer(config.url, config.maxZoom, config.attribution);
        }
    }
}

// --- Drawing ---

function updateDrawButtonText() {
    const btn = document.getElementById('toggle-draw');
    const mapEl = document.getElementById('map');

    if (drawEnabled) {
        btn.textContent = '✏️ Draw ON';
        btn.classList.add('active');
        mapEl.classList.add('drawing-mode');
        if (map) {
            map.dragging.disable();
            map.touchZoom.disable();
            map.doubleClickZoom.disable();
        }
        mapEl.style.cursor = 'crosshair';

        // Show hint on touch devices
        if ('ontouchstart' in window && typeof showToast === 'function') {
            showToast('Touch & drag to draw a box', 'info');
        }
    } else {
        btn.textContent = '✏️ Draw OFF';
        btn.classList.remove('active');
        mapEl.classList.remove('drawing-mode');
        if (map) {
            map.dragging.enable();
            map.touchZoom.enable();
            map.doubleClickZoom.enable();
        }
        mapEl.style.cursor = '';
    }
}

function updateActiveLabelDisplay() {
    const badge = document.getElementById('active-label-display');
    const text = document.getElementById('active-label-text');
    const dot = badge?.querySelector('.label-dot');

    if (!badge || !text) return;

    if (currentLabelName) {
        badge.classList.add('has-label');
        text.textContent = currentLabelName;
        if (dot) {
            dot.style.background = getLabelColor(currentLabelId);
        }
    } else {
        badge.classList.remove('has-label');
        text.textContent = 'No label selected';
        if (dot) {
            dot.style.background = '';
        }
    }
}

function initMap() {
    map = L.map('map', {
        center: [51.5, 10], // Germany
        zoom: 8
    });

    // Default Tile Layer (Sentinel-2)
    const savedPreset = localStorage.getItem('tilePreset') || 'sentinel';
    const presetSelect = document.getElementById('tile-preset');
    presetSelect.value = savedPreset;

    if (savedPreset === 'custom') {
        const customUrl = localStorage.getItem('customTileUrl');
        if (customUrl) {
            document.getElementById('custom-tile-url').value = customUrl;
            document.getElementById('custom-url-group').style.display = 'block';
            setTileLayer(customUrl, 18, 'Custom Tiles');
        } else {
            applyTilePreset('sentinel');
        }
    } else {
        applyTilePreset(savedPreset);
    }

    // Update zoom level display
    map.on('zoomend', updateZoomDisplay);
    updateZoomDisplay();

    // --- Mouse events for drawing boxes ---
    map.on('mousedown', (e) => {
        if (!drawEnabled || !currentLabelId) return;

        // Only left mouse button
        if (e.originalEvent.button !== 0) return;

        startLatLng = e.latlng;

        // Create temporary rectangle (visible while dragging)
        tempRect = L.rectangle([startLatLng, startLatLng], {
            color: getLabelColor(currentLabelId),
            weight: 2,
            dashArray: '5, 5',
            fillOpacity: 0.3
        }).addTo(map);
    });

    map.on('mousemove', (e) => {
        // Update temp rect if drawing
        if (startLatLng && tempRect) {
            const bounds = L.latLngBounds(startLatLng, e.latlng);
            tempRect.setBounds(bounds);
        }

        // Send cursor position to other users (throttled)
        if (typeof sendCursorPosition === 'function') {
            if (!map._lastCursorSend || Date.now() - map._lastCursorSend > 100) {
                sendCursorPosition(e.latlng.lat, e.latlng.lng);
                map._lastCursorSend = Date.now();
            }
        }
    });

    map.on('mouseup', async (e) => {
        if (!startLatLng || !tempRect) return;
        await finishDrawing(e.latlng);
    });

    // --- Touch events for mobile ---
    const mapContainer = document.getElementById('map');

    mapContainer.addEventListener('touchstart', (e) => {
        if (!drawEnabled || !currentLabelId) return;
        if (e.touches.length !== 1) return; // Only single touch

        e.preventDefault();
        e.stopPropagation();

        const touch = e.touches[0];
        const rect = mapContainer.getBoundingClientRect();
        const containerPoint = L.point(
            touch.clientX - rect.left,
            touch.clientY - rect.top
        );
        startLatLng = map.containerPointToLatLng(containerPoint);
        lastTouchLatLng = startLatLng; // Initialize last position

        tempRect = L.rectangle([startLatLng, startLatLng], {
            color: getLabelColor(currentLabelId),
            weight: 2,
            dashArray: '5, 5',
            fillOpacity: 0.3
        }).addTo(map);
    }, { passive: false });

    mapContainer.addEventListener('touchmove', (e) => {
        if (!startLatLng || !tempRect) return;
        if (e.touches.length !== 1) return;

        e.preventDefault();
        e.stopPropagation();

        const touch = e.touches[0];
        const rect = mapContainer.getBoundingClientRect();
        const containerPoint = L.point(
            touch.clientX - rect.left,
            touch.clientY - rect.top
        );
        const latlng = map.containerPointToLatLng(containerPoint);
        lastTouchLatLng = latlng; // Store last position

        const bounds = L.latLngBounds(startLatLng, latlng);
        tempRect.setBounds(bounds);
    }, { passive: false });

    mapContainer.addEventListener('touchend', async (e) => {
        if (!startLatLng || !tempRect) return;

        e.preventDefault();
        e.stopPropagation();

        // Use changedTouches for the final position, or fall back to last known position
        let endLatLng = lastTouchLatLng;

        if (e.changedTouches && e.changedTouches.length > 0) {
            const touch = e.changedTouches[0];
            const rect = mapContainer.getBoundingClientRect();
            const containerPoint = L.point(
                touch.clientX - rect.left,
                touch.clientY - rect.top
            );
            endLatLng = map.containerPointToLatLng(containerPoint);
        }

        if (endLatLng) {
            await finishDrawing(endLatLng);
        } else {
            // Cleanup if no valid end position
            if (tempRect) {
                map.removeLayer(tempRect);
                tempRect = null;
            }
            startLatLng = null;
        }

        lastTouchLatLng = null;
    }, { passive: false });

    // Also handle touchcancel
    mapContainer.addEventListener('touchcancel', (e) => {
        if (tempRect) {
            map.removeLayer(tempRect);
            tempRect = null;
        }
        startLatLng = null;
        lastTouchLatLng = null;
    }, { passive: false });

    // Load all existing boxes on startup
    loadExistingBoxes();
}

// Helper function to complete drawing (shared by mouse and touch)
async function finishDrawing(endLatLng) {
    if (!startLatLng || !endLatLng) {
        cleanup();
        return;
    }

    const finalBounds = L.latLngBounds(startLatLng, endLatLng);
    const sw = finalBounds.getSouthWest();
    const ne = finalBounds.getNorthEast();

    // Only if box has actual area (minimum size check)
    const minSize = 1e-5; // Slightly larger threshold for touch
    if (Math.abs(sw.lat - ne.lat) < minSize || Math.abs(sw.lng - ne.lng) < minSize) {
        console.log('Box too small, ignoring');
        cleanup();
        return;
    }

    const currentZoom = map.getZoom();

    const payload = {
        labelId: currentLabelId,
        labelName: currentLabelName,
        bounds: {
            south: sw.lat,
            west: sw.lng,
            north: ne.lat,
            east: ne.lng
        },
        zoom: currentZoom,
        tileUrl: currentTileUrl
    };

    try {
        const saved = await fetchJSON('/api/boxes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Convert temporary rectangle to permanent one
        if (tempRect) {
            map.removeLayer(tempRect);
        }

        const rect = L.rectangle([sw, ne], {
            color: getLabelColor(currentLabelId),
            weight: 2,
            fillOpacity: 0.2
        }).addTo(map);

        const popupContent = createPopupContent(saved);
        rect.bindPopup(popupContent);

        rectangles.set(saved.id, { rect, data: saved });
        updateStats();

        // Show success feedback on mobile
        if ('ontouchstart' in window && typeof showToast === 'function') {
            showToast('Box saved!', 'success');
        }

        // Reset for next drawing
        cleanup();
    } catch (err) {
        console.error('Error saving box:', err);
        if (typeof showToast === 'function') {
            showToast('Error saving box', 'error');
        } else {
            alert('Error saving box');
        }
        cleanup();
    }
}

// Cleanup drawing state
function cleanup() {
    if (tempRect && map) {
        map.removeLayer(tempRect);
    }
    tempRect = null;
    startLatLng = null;
    lastTouchLatLng = null;
}

function updateZoomDisplay() {
    const zoomEl = document.getElementById('current-zoom');
    if (zoomEl) {
        zoomEl.textContent = map.getZoom();
    }
}

// --- UI Initialization ---

function initUI() {
    document
        .getElementById('toggle-draw')
        .addEventListener('click', () => {
            if (!currentLabelId) {
                alert('Please select a label first!');
                return;
            }
            drawEnabled = !drawEnabled;
            updateDrawButtonText();
        });

    document
        .getElementById('add-label-btn')
        .addEventListener('click', addLabel);

    // Enter key for label input
    document
        .getElementById('new-label-input')
        .addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addLabel();
        });

    document
        .getElementById('label-select')
        .addEventListener('change', (e) => {
            const id = e.target.value;
            if (!id) {
                currentLabelId = null;
                currentLabelName = null;
                // Disable drawing when no label selected
                if (drawEnabled) {
                    drawEnabled = false;
                    updateDrawButtonText();
                }
            } else {
                currentLabelId = Number(id);
                const selectedOption =
                    e.target.options[e.target.selectedIndex];
                currentLabelName = selectedOption.textContent;
            }
            updateActiveLabelDisplay();
        });

    // Tile preset
    document
        .getElementById('tile-preset')
        .addEventListener('change', (e) => {
            applyTilePreset(e.target.value);
        });

    // Custom tile URL
    document
        .getElementById('apply-tile-url')
        .addEventListener('click', () => {
            const url = document.getElementById('custom-tile-url').value.trim();
            if (url) {
                setTileLayer(url, 18, 'Custom Tiles');
            }
        });

    document
        .getElementById('custom-tile-url')
        .addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const url = e.target.value.trim();
                if (url) {
                    setTileLayer(url, 18, 'Custom Tiles');
                }
            }
        });

    updateDrawButtonText();
}

async function init() {
    // Check authentication
    const auth = await requireAuth();
    if (!auth) return;

    currentUser = auth.user;

    // Update UI with user info
    updateUserUI(auth.user);

    // Show admin link if admin
    if (auth.user.role === 'admin') {
        document.getElementById('admin-link').style.display = '';
        document.getElementById('db-link').style.display = '';
    }

    initUI();
    initMap();
    await loadLabels();

    // Initialize real-time sync
    if (typeof initSocket === 'function' && auth.token) {
        initSocket(auth.token);
    }
}

// === Real-time Event Handlers ===

// Handle label created by other user
function handleLabelCreated(label) {
    // Check if this label was created by us (to avoid duplicates)
    if (currentUser && label.userId === currentUser.id) return;

    const select = document.getElementById('label-select');

    // Check if already exists
    if (select.querySelector(`option[value="${label.id}"]`)) return;

    const opt = document.createElement('option');
    opt.value = label.id;
    opt.textContent = label.name;
    select.appendChild(opt);

    // Also update label list
    const container = document.getElementById('label-list');
    if (container) {
        const item = document.createElement('div');
        item.className = 'label-item';
        const color = getLabelColor(label.id);
        item.innerHTML = `
            <span class="label-color-dot" style="background: ${color}"></span>
            <span class="label-name" title="${label.name}">${label.name}</span>
            <button class="delete-btn" data-id="${label.id}" title="Delete label">×</button>
        `;
        item.querySelector('.delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = e.target.dataset.id;
            if (confirm('Delete label and all associated boxes?')) {
                await deleteLabel(id);
            }
        });
        container.appendChild(item);
    }
}

// Handle label deleted by other user
function handleLabelDeleted(labelId) {
    const select = document.getElementById('label-select');
    const opt = select.querySelector(`option[value="${labelId}"]`);
    if (opt) opt.remove();

    // Update label list
    const container = document.getElementById('label-list');
    if (container) {
        const items = container.querySelectorAll(`.delete-btn[data-id="${labelId}"]`);
        items.forEach(btn => btn.closest('.label-item')?.remove());
    }

    // Reset selection if this was the selected label
    if (currentLabelId === labelId) {
        currentLabelId = null;
        currentLabelName = null;
        select.value = '';
        if (drawEnabled) {
            drawEnabled = false;
            updateDrawButtonText();
        }
    }
}

// Handle box created by other user
function handleBoxCreated(box) {
    // Check if this box was created by us
    if (currentUser && box.userId === currentUser.id) return;

    // Check if already exists
    if (rectangles.has(box.id)) return;

    const sw = L.latLng(box.bounds.south, box.bounds.west);
    const ne = L.latLng(box.bounds.north, box.bounds.east);
    const rect = L.rectangle([sw, ne], {
        color: getLabelColor(box.labelId),
        weight: 2,
        fillOpacity: 0.2
    }).addTo(map);

    const popupContent = createPopupContent(box);
    rect.bindPopup(popupContent);

    rectangles.set(box.id, { rect, data: box });
    updateStats();
}

// Handle box deleted by other user
function handleBoxDeleted(boxId) {
    const rectData = rectangles.get(boxId);
    if (rectData) {
        map.removeLayer(rectData.rect);
        rectangles.delete(boxId);
        updateStats();
    }
}

// Handle cursor updates from other users
function handleCursorUpdate(data) {
    if (!map || !data.lat || !data.lng) return;

    let cursor = otherCursors.get(data.userId);

    if (!cursor) {
        // Create new cursor element
        cursor = document.createElement('div');
        cursor.className = 'other-cursor';
        cursor.innerHTML = `
            <div class="cursor-dot" style="background: ${stringToColor(data.email)}"></div>
            <div class="cursor-label" style="background: ${stringToColor(data.email)}">${data.email.split('@')[0]}</div>
        `;
        document.getElementById('map').appendChild(cursor);
        otherCursors.set(data.userId, cursor);
    }

    // Update position
    const point = map.latLngToContainerPoint([data.lat, data.lng]);
    cursor.style.left = point.x + 'px';
    cursor.style.top = point.y + 'px';

    // Clear timeout and set new one to hide cursor after inactivity
    if (cursor.hideTimeout) clearTimeout(cursor.hideTimeout);
    cursor.style.display = 'block';
    cursor.hideTimeout = setTimeout(() => {
        cursor.style.display = 'none';
    }, 5000);
}

// Helper function for color generation
function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = hash % 360;
    return `hsl(${hue}, 60%, 45%)`;
}

// Global function for popup button
window.deleteBox = deleteBox;

// Export handlers for socket.js
window.handleLabelCreated = handleLabelCreated;
window.handleLabelDeleted = handleLabelDeleted;
window.handleBoxCreated = handleBoxCreated;
window.handleBoxDeleted = handleBoxDeleted;
window.handleCursorUpdate = handleCursorUpdate;

document.addEventListener('DOMContentLoaded', init);
