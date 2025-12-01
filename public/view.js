let boxesData = [];
let labelsData = [];
let currentTileSize = 300;
let showLabels = true;
let filterLabel = '';

// Colors for labels (consistent with app.js)
const labelColors = [
    '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444',
    '#22c55e', '#3b82f6', '#ec4899', '#84cc16',
    '#06b6d4', '#f97316', '#a855f7', '#10b981'
];

function getLabelColor(labelId) {
    return labelColors[(labelId - 1) % labelColors.length];
}

async function loadData() {
    try {
        const [boxesRes, labelsRes] = await Promise.all([
            fetch('/api/boxes'),
            fetch('/api/labels')
        ]);
        
        boxesData = await boxesRes.json();
        labelsData = await labelsRes.json();
        
        // Filter only boxes with saved images
        boxesData = boxesData.filter(box => box.image);
        
        populateLabelFilter();
        renderGallery();
        updateStats();
    } catch (err) {
        console.error('Error loading:', err);
    }
}

function populateLabelFilter() {
    const select = document.getElementById('filter-label');
    select.innerHTML = '<option value="">All labels</option>';
    
    labelsData.forEach(label => {
        const opt = document.createElement('option');
        opt.value = label.name;
        opt.textContent = label.name;
        select.appendChild(opt);
    });
}

function updateStats() {
    const filteredBoxes = getFilteredBoxes();
    document.getElementById('tile-count').textContent = filteredBoxes.length;
    document.getElementById('box-count').textContent = filteredBoxes.length;
}

function getFilteredBoxes() {
    if (!filterLabel) return boxesData;
    return boxesData.filter(box => box.labelName === filterLabel);
}

function renderGallery() {
    const gallery = document.getElementById('gallery');
    const noData = document.getElementById('no-data');
    const filteredBoxes = getFilteredBoxes();
    
    if (filteredBoxes.length === 0) {
        gallery.style.display = 'none';
        noData.style.display = 'flex';
        return;
    }
    
    gallery.style.display = 'grid';
    noData.style.display = 'none';
    gallery.innerHTML = '';
    
    // CSS Grid with variable tile size
    gallery.style.gridTemplateColumns = `repeat(auto-fill, minmax(${currentTileSize}px, 1fr))`;
    
    filteredBoxes.forEach((box, index) => {
        const card = createBoxCard(box, index);
        gallery.appendChild(card);
    });
}

function createBoxCard(box, index) {
    const card = document.createElement('div');
    card.className = 'tile-gallery-card';
    
    // Container for canvas
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'tile-canvas-container';
    canvasContainer.style.aspectRatio = box.imageSize 
        ? `${box.imageSize.width} / ${box.imageSize.height}` 
        : '1';
    
    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'tile-canvas';
    
    // Load image and draw box
    const img = new Image();
    img.onload = () => {
        // Adjust canvas size to displayed image
        const displayWidth = canvasContainer.clientWidth || currentTileSize;
        const aspectRatio = img.height / img.width;
        const displayHeight = displayWidth * aspectRatio;
        
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        
        drawBoxOnImage(canvas, img, box);
    };
    img.onerror = () => {
        canvas.width = currentTileSize;
        canvas.height = currentTileSize;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1a1a25';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#606070';
        ctx.font = '14px Outfit';
        ctx.textAlign = 'center';
        ctx.fillText('Image not available', canvas.width / 2, canvas.height / 2);
    };
    img.src = box.image;
    
    canvasContainer.appendChild(canvas);
    
    // Info bar
    const info = document.createElement('div');
    info.className = 'tile-card-info';
    
    const color = getLabelColor(box.labelId);
    const gridSize = box.tileGrid ? `${box.tileGrid.width}×${box.tileGrid.height}` : '1×1';
    
    info.innerHTML = `
        <div class="tile-card-labels">
            <span class="mini-tag" style="background: ${color}">${box.labelName}</span>
        </div>
        <div class="tile-card-meta">
            <span class="box-badge">${box.tiles.length} Tile${box.tiles.length !== 1 ? 's' : ''} (${gridSize})</span>
            ${box.imageSize ? `<span class="size-badge">${box.imageSize.width}×${box.imageSize.height}px</span>` : ''}
        </div>
    `;
    
    card.appendChild(canvasContainer);
    card.appendChild(info);
    
    // Click for lightbox
    canvasContainer.addEventListener('click', () => openLightbox(box));
    
    return card;
}

function drawBoxOnImage(canvas, img, box) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Draw image (scaled)
    ctx.drawImage(img, 0, 0, width, height);
    
    if (!box.yolo) return;
    
    const color = getLabelColor(box.labelId);
    
    // Convert YOLO coordinates to pixels
    const x = box.yolo.x_center * width;
    const y = box.yolo.y_center * height;
    const w = box.yolo.width * width;
    const h = box.yolo.height * height;
    
    const x1 = x - w / 2;
    const y1 = y - h / 2;
    
    // Draw box
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x1, y1, w, h);
    
    // Semi-transparent fill
    ctx.fillStyle = color + '25';
    ctx.fillRect(x1, y1, w, h);
    
    // Draw label text
    if (showLabels) {
        const fontSize = Math.max(12, Math.min(16, width / 18));
        ctx.font = `bold ${fontSize}px Outfit`;
        
        const text = box.labelName;
        const textMetrics = ctx.measureText(text);
        const textWidth = textMetrics.width;
        const textHeight = fontSize;
        const padding = 6;
        
        // Label background
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - textHeight - padding * 2, textWidth + padding * 2, textHeight + padding * 2);
        
        // Label text
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x1 + padding, y1 - padding - 2);
    }
}

function openLightbox(box) {
    const lightbox = document.getElementById('lightbox');
    const canvas = document.getElementById('lightbox-canvas');
    const title = document.getElementById('lightbox-title');
    const labelsContainer = document.getElementById('lightbox-labels');
    const coords = document.getElementById('lightbox-coords');
    
    // Load image
    const img = new Image();
    img.onload = () => {
        // Adjust canvas to image size (max 800px)
        const maxSize = 800;
        let displayWidth = img.width;
        let displayHeight = img.height;
        
        if (displayWidth > maxSize || displayHeight > maxSize) {
            const scale = Math.min(maxSize / displayWidth, maxSize / displayHeight);
            displayWidth *= scale;
            displayHeight *= scale;
        }
        
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        
        drawBoxOnImage(canvas, img, box);
    };
    img.src = box.image;
    
    // Set info
    title.textContent = `Box #${box.id}`;
    
    const color = getLabelColor(box.labelId);
    labelsContainer.innerHTML = `<span class="lightbox-tag" style="background: ${color}">${box.labelName}</span>`;
    
    const gridSize = box.tileGrid ? `${box.tileGrid.width}×${box.tileGrid.height}` : '1×1';
    coords.innerHTML = `
        <div class="coord-item"><strong>Zoom:</strong> ${box.zoom}</div>
        <div class="coord-item"><strong>Tiles:</strong> ${box.tiles.length} (${gridSize})</div>
        <div class="coord-item"><strong>Size:</strong> ${box.imageSize ? `${box.imageSize.width}×${box.imageSize.height}px` : 'N/A'}</div>
        <div class="coord-item"><strong>YOLO:</strong> ${box.yolo.x_center.toFixed(3)}, ${box.yolo.y_center.toFixed(3)}, ${box.yolo.width.toFixed(3)}, ${box.yolo.height.toFixed(3)}</div>
    `;
    
    lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    lightbox.classList.remove('active');
    document.body.style.overflow = '';
}

// Event Listeners
document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication
    const auth = await requireAuth();
    if (!auth) return;
    
    updateUserUI(auth.user);
    if (auth.user.role === 'admin') {
        document.getElementById('admin-link').style.display = '';
    }
    
    loadData();
    
    // Filter
    document.getElementById('filter-label').addEventListener('change', (e) => {
        filterLabel = e.target.value;
        renderGallery();
        updateStats();
    });
    
    // Tile size
    const sizeSlider = document.getElementById('tile-size');
    const sizeValue = document.getElementById('tile-size-value');
    sizeSlider.addEventListener('input', (e) => {
        currentTileSize = parseInt(e.target.value);
        sizeValue.textContent = currentTileSize + 'px';
        renderGallery();
    });
    
    // Show labels
    document.getElementById('show-labels').addEventListener('change', (e) => {
        showLabels = e.target.checked;
        renderGallery();
    });
    
    // Close lightbox with Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLightbox();
    });
    
    // Close lightbox when clicking outside
    document.getElementById('lightbox').addEventListener('click', (e) => {
        if (e.target.id === 'lightbox') closeLightbox();
    });
});
