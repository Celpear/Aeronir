let map;
let currentTileLayer;
let drawEnabled = false;
let currentLabelId = null;
let currentLabelName = null;

// For drawing
let startLatLng = null;
let tempRect = null;

// Saved boxes with their Leaflet objects
const rectangles = new Map(); // boxId -> { rect, data }

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
        item.innerHTML = `
            <span class="label-name">${label.name}</span>
            <button class="delete-btn" data-id="${label.id}" title="Delete label">×</button>
        `;
        container.appendChild(item);
    });

    // Event listeners for delete
    container.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
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
    if (drawEnabled) {
        btn.textContent = '✏️ Draw ON';
        btn.classList.add('active');
        if (map) {
            map.dragging.disable();
        }
        document.getElementById('map').style.cursor = 'crosshair';
    } else {
        btn.textContent = '✏️ Draw OFF';
        btn.classList.remove('active');
        if (map) {
            map.dragging.enable();
        }
        document.getElementById('map').style.cursor = '';
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
        if (!startLatLng || !tempRect) return;
        const bounds = L.latLngBounds(startLatLng, e.latlng);
        tempRect.setBounds(bounds);
    });

    map.on('mouseup', async (e) => {
        if (!startLatLng || !tempRect) return;

        const finalBounds = L.latLngBounds(startLatLng, e.latlng);
        const sw = finalBounds.getSouthWest();
        const ne = finalBounds.getNorthEast();

        // Only if box has actual area
        if (Math.abs(sw.lat - ne.lat) < 1e-6 || Math.abs(sw.lng - ne.lng) < 1e-6) {
            map.removeLayer(tempRect);
            tempRect = null;
            startLatLng = null;
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
            map.removeLayer(tempRect);

            const rect = L.rectangle([sw, ne], {
                color: getLabelColor(currentLabelId),
                weight: 2,
                fillOpacity: 0.2
            }).addTo(map);

            const popupContent = createPopupContent(saved);
            rect.bindPopup(popupContent);

            rectangles.set(saved.id, { rect, data: saved });
            updateStats();

            // Reset for next drawing
            tempRect = null;
            startLatLng = null;
        } catch (err) {
            console.error(err);
            alert('Error saving box');
            map.removeLayer(tempRect);
            tempRect = null;
            startLatLng = null;
        }
    });

    // Load all existing boxes on startup
    loadExistingBoxes();
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
    
    // Update UI with user info
    updateUserUI(auth.user);
    
    // Show admin link if admin
    if (auth.user.role === 'admin') {
        document.getElementById('admin-link').style.display = '';
    }
    
    initUI();
    initMap();
    await loadLabels();
}

// Global function for popup button
window.deleteBox = deleteBox;

document.addEventListener('DOMContentLoaded', init);
