let projectId = null;
let project = null;
let labels = [];
let images = [];
let annotations = [];

let currentImageId = null;
let currentLabelId = null;
let currentLabelName = null;
let splitFilter = 'all';
let drawEnabled = false;

let canvas, ctx, imgEl;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let isDrawing = false;
let startX = 0;
let startY = 0;
let currentBox = null;

let isMoving = false;
let movingAnnotationId = null;
let moveOffsetX = 0;
let moveOffsetY = 0;
let moveRect = null; // canvas-space rect while dragging
let hoverAnnotationId = null;

const LABEL_COLORS = [
    '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444',
    '#22c55e', '#3b82f6', '#ec4899', '#84cc16',
    '#06b6d4', '#f97316', '#a855f7', '#10b981'
];

function getLabelColor(labelId) {
    return LABEL_COLORS[(labelId - 1) % LABEL_COLORS.length];
}

async function api(url, options = {}) {
    const opts = { ...options };
    if (!(opts.body instanceof FormData)) {
        opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} show`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function filteredImages() {
    const annotatedIds = new Set(annotations.map((a) => a.imageId));
    return images.filter((img) => {
        if (splitFilter === 'all') return true;
        if (splitFilter === 'unlabeled') return !annotatedIds.has(img.id);
        return img.split === splitFilter;
    }).sort((a, b) => a.id - b.id);
}

function currentImage() {
    return images.find((img) => img.id === currentImageId) || null;
}

function annotationsForImage(imageId) {
    return annotations.filter((a) => a.imageId === imageId);
}

function updateStats() {
    const el = document.getElementById('project-stats');
    if (!el || !project) return;
    const s = project.stats || {};
    const splits = s.splits || {};
    el.innerHTML = `
        <div class="stat"><span class="stat-value">${s.imageCount || 0}</span><span class="stat-label">Images</span></div>
        <div class="stat"><span class="stat-value">${s.annotationCount || 0}</span><span class="stat-label">Boxes</span></div>
        <div class="stat"><span class="stat-value">${splits.train || 0}/${splits.valid || 0}/${splits.test || 0}</span><span class="stat-label">T/V/Te</span></div>
    `;
}

function updateLabelUI() {
    const select = document.getElementById('label-select');
    const prev = select.value;
    select.innerHTML = '<option value="">-- select --</option>';
    labels.forEach((l) => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        select.appendChild(opt);
    });
    if (prev && labels.some((l) => String(l.id) === prev)) {
        select.value = prev;
    } else if (currentLabelId) {
        select.value = currentLabelId;
    }

    const list = document.getElementById('label-list');
    list.innerHTML = '';
    labels.forEach((label) => {
        const item = document.createElement('div');
        item.className = 'label-item';
        item.innerHTML = `
            <span class="label-color-dot" style="background:${getLabelColor(label.id)}"></span>
            <span class="label-name" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>
            <button class="delete-btn" data-id="${label.id}" title="Delete class">×</button>
        `;
        list.appendChild(item);
    });

    list.querySelectorAll('.delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete class and its boxes in this project?')) return;
            try {
                await api(`/api/projects/${projectId}/labels/${btn.dataset.id}`, { method: 'DELETE' });
                await reloadProject();
                if (String(currentLabelId) === btn.dataset.id) {
                    currentLabelId = null;
                    currentLabelName = null;
                    updateActiveLabelDisplay();
                }
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

function updateActiveLabelDisplay() {
    const badge = document.getElementById('active-label-display');
    const text = document.getElementById('active-label-text');
    const dot = badge?.querySelector('.label-dot');
    if (!badge || !text) return;

    if (currentLabelName) {
        badge.classList.add('has-label');
        text.textContent = currentLabelName;
        if (dot) dot.style.background = getLabelColor(currentLabelId);
    } else {
        badge.classList.remove('has-label');
        text.textContent = 'No class selected';
        if (dot) dot.style.background = '';
    }
}

function updateDrawButton() {
    const btn = document.getElementById('toggle-draw');
    const wrap = document.getElementById('canvas-wrap');
    if (drawEnabled) {
        btn.textContent = '✏️ Draw ON';
        btn.classList.add('active');
        wrap?.classList.add('drawing-mode');
        wrap?.classList.remove('move-mode');
    } else {
        btn.textContent = '✏️ Draw OFF';
        btn.classList.remove('active');
        wrap?.classList.remove('drawing-mode');
        wrap?.classList.add('move-mode');
    }
    updateCanvasCursor();
}

function updateCanvasCursor(force) {
    if (!canvas) return;
    if (drawEnabled) {
        canvas.style.cursor = 'crosshair';
        return;
    }
    if (isMoving) {
        canvas.style.cursor = 'grabbing';
        return;
    }
    canvas.style.cursor = force || (hoverAnnotationId ? 'grab' : 'default');
}

function renderImageList() {
    const list = document.getElementById('image-list');
    const filtered = filteredImages();
    const annotatedIds = new Set(annotations.map((a) => a.imageId));

    if (!filtered.length) {
        list.innerHTML = '<p class="hint">No images in this filter.</p>';
        return;
    }

    list.innerHTML = filtered.map((img) => {
        const count = annotationsForImage(img.id).length;
        const labeled = annotatedIds.has(img.id);
        const filterBadge = img.filter
            ? `<span class="filter-badge"${img.tintColor ? ` style="--chip:${escapeHtml(img.tintColor)}"` : ''}>${escapeHtml(img.nightvisionVariant ? `nv-${img.nightvisionVariant}` : img.filter)}</span>`
            : '';
        return `
            <div class="image-list-item ${img.id === currentImageId ? 'active' : ''} ${labeled ? 'labeled' : ''}" data-id="${img.id}">
                <button type="button" class="image-list-select" data-id="${img.id}">
                    <img src="${img.path}" alt="" loading="lazy" />
                    <div class="image-list-meta">
                        <span class="image-list-name" title="${escapeHtml(img.originalName)}">${escapeHtml(img.originalName)}</span>
                        <span class="image-list-tags">
                            <span class="split-pill ${img.split}">${img.split}</span>
                            ${filterBadge}
                            <span class="box-count">${count} box${count === 1 ? '' : 'es'}</span>
                        </span>
                    </div>
                </button>
                <button type="button" class="icon-btn image-copy-btn" data-copy-id="${img.id}" title="Copy image">⧉</button>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.image-list-select').forEach((btn) => {
        btn.addEventListener('click', () => selectImage(Number(btn.dataset.id)));
    });
    list.querySelectorAll('.image-copy-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCopyModal(Number(btn.dataset.copyId));
        });
    });

    updateImageCounter();
}

function updateImageCounter() {
    const filtered = filteredImages();
    const idx = filtered.findIndex((img) => img.id === currentImageId);
    document.getElementById('image-counter').textContent =
        `${idx >= 0 ? idx + 1 : 0} / ${filtered.length}`;
}

function renderAnnotationChips() {
    const chips = document.getElementById('annotation-chips');
    const anns = annotationsForImage(currentImageId);
    if (!anns.length) {
        chips.innerHTML = '<span class="hint">No boxes yet</span>';
        return;
    }
    chips.innerHTML = anns.map((a) => `
        <span class="annotation-chip" style="--chip:${getLabelColor(a.labelId)}">
            ${escapeHtml(a.labelName)}
            <button type="button" data-id="${a.id}" title="Delete box">×</button>
        </span>
    `).join('');

    chips.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await api(`/api/projects/${projectId}/annotations/${btn.dataset.id}`, { method: 'DELETE' });
                annotations = annotations.filter((a) => a.id !== Number(btn.dataset.id));
                if (project?.stats) project.stats.annotationCount = Math.max(0, (project.stats.annotationCount || 1) - 1);
                updateStats();
                renderImageList();
                renderAnnotationChips();
                drawScene();
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

function fitCanvas() {
    const img = currentImage();
    if (!img || !imgEl || !imgEl.complete) return;

    const stage = document.getElementById('canvas-stage');
    const maxW = stage.clientWidth - 32;
    const maxH = stage.clientHeight - 32;
    scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const drawW = Math.round(img.width * scale);
    const drawH = Math.round(img.height * scale);

    canvas.width = drawW;
    canvas.height = drawH;
    canvas.style.width = `${drawW}px`;
    canvas.style.height = `${drawH}px`;
    offsetX = 0;
    offsetY = 0;
    drawScene();
}

function yoloToCanvasRect(yolo, imgW, imgH) {
    const bw = yolo.width * imgW * scale;
    const bh = yolo.height * imgH * scale;
    const cx = yolo.x_center * imgW * scale;
    const cy = yolo.y_center * imgH * scale;
    return {
        x: cx - bw / 2,
        y: cy - bh / 2,
        w: bw,
        h: bh
    };
}

function canvasToYolo(x1, y1, x2, y2, imgW, imgH) {
    const left = Math.min(x1, x2) / scale;
    const top = Math.min(y1, y2) / scale;
    const right = Math.max(x1, x2) / scale;
    const bottom = Math.max(y1, y2) / scale;
    const width = (right - left) / imgW;
    const height = (bottom - top) / imgH;
    return {
        x_center: (left + right) / 2 / imgW,
        y_center: (top + bottom) / 2 / imgH,
        width,
        height
    };
}

function drawScene() {
    const img = currentImage();
    if (!img || !ctx || !imgEl) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

    annotationsForImage(img.id).forEach((a) => {
        const r = (isMoving && movingAnnotationId === a.id && moveRect)
            ? moveRect
            : yoloToCanvasRect(a.yolo, img.width, img.height);
        const color = getLabelColor(a.labelId);
        const active = hoverAnnotationId === a.id || movingAnnotationId === a.id;
        ctx.strokeStyle = color;
        ctx.lineWidth = active ? 3 : 2;
        ctx.fillStyle = color + (active ? '55' : '33');
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = color;
        ctx.font = '12px Outfit, sans-serif';
        const label = a.labelName;
        const tw = ctx.measureText(label).width + 8;
        ctx.fillRect(r.x, Math.max(0, r.y - 18), tw, 18);
        ctx.fillStyle = '#0d1117';
        ctx.fillText(label, r.x + 4, Math.max(12, r.y - 5));
    });

    if (currentBox) {
        const color = currentLabelId ? getLabelColor(currentLabelId) : '#14b8a6';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(currentBox.x, currentBox.y, currentBox.w, currentBox.h);
        ctx.setLineDash([]);
    }
}

function hitTestAnnotation(x, y) {
    const img = currentImage();
    if (!img) return null;
    // Top-most box wins (last drawn / highest index)
    const anns = annotationsForImage(img.id);
    for (let i = anns.length - 1; i >= 0; i--) {
        const a = anns[i];
        const r = yoloToCanvasRect(a.yolo, img.width, img.height);
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
            return { annotation: a, rect: r };
        }
    }
    return null;
}

function clampMoveRect(rect, canvasW, canvasH) {
    const w = rect.w;
    const h = rect.h;
    return {
        x: Math.max(0, Math.min(canvasW - w, rect.x)),
        y: Math.max(0, Math.min(canvasH - h, rect.y)),
        w,
        h
    };
}

async function selectImage(id) {
    currentImageId = id;
    const img = currentImage();
    const empty = document.getElementById('empty-canvas');
    const wrap = document.getElementById('canvas-wrap');
    const splitSelect = document.getElementById('current-split');
    const deleteBtn = document.getElementById('delete-image-btn');
    const copyBtn = document.getElementById('copy-image-btn');

    renderImageList();

    if (!img) {
        empty.hidden = false;
        wrap.hidden = true;
        splitSelect.disabled = true;
        deleteBtn.disabled = true;
        copyBtn.disabled = true;
        document.getElementById('annotation-chips').innerHTML = '';
        return;
    }

    empty.hidden = true;
    wrap.hidden = false;
    splitSelect.disabled = false;
    splitSelect.value = img.split;
    deleteBtn.disabled = false;
    copyBtn.disabled = false;

    imgEl = new Image();
    imgEl.onload = () => fitCanvas();
    imgEl.src = img.path;
    renderAnnotationChips();
}

let copySourceImageId = null;
let copyPreviewImage = null;
let previewRaf = null;

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

function getSelectedCopyFilter() {
    return document.querySelector('input[name="copy-filter"]:checked')?.value || 'none';
}

const NIGHTVISION_VARIANTS = {
    green: { id: 'green', tint: { r: 32, g: 220, b: 64 }, contrast: 1.35, bias: 10 },
    white: { id: 'white', tint: { r: 220, g: 230, b: 240 }, contrast: 1.25, bias: 8 },
    amber: { id: 'amber', tint: { r: 255, g: 170, b: 40 }, contrast: 1.3, bias: 6 },
    cyan: { id: 'cyan', tint: { r: 40, g: 210, b: 230 }, contrast: 1.32, bias: 8 },
    red: { id: 'red', tint: { r: 230, g: 48, b: 48 }, contrast: 1.35, bias: 4 }
};

function getTintColor() {
    return document.getElementById('tint-color')?.value || '#14b8a6';
}

function getNightvisionVariant() {
    return document.querySelector('input[name="nv-variant"]:checked')?.value || 'green';
}

const AUGMENTATION_PRESETS = {
    neutral: { exposure: 0, contrast: 1, gamma: 1, noise: 0, blur: 0, quality: 92, resolution: 100 },
    lowlight: { exposure: -1.2, contrast: 1.1, gamma: 1, noise: 15, blur: 0.4, quality: 85, resolution: 100 },
    soft: { exposure: 0, contrast: 1, gamma: 1, noise: 3, blur: 8, quality: 85, resolution: 65 },
    poor: { exposure: -0.2, contrast: 0.9, gamma: 1, noise: 8, blur: 0.5, quality: 30, resolution: 40 }
};
let augmentationTimer;
let augmentationAbort;
let augmentationGeneration = 0;
function getAugmentation() {
    return Object.fromEntries([...document.querySelectorAll('[data-augmentation]')].map(el => [el.dataset.augmentation, Number(el.value)]));
}
function setAugmentationPreset(name) {
    for (const [key, value] of Object.entries(AUGMENTATION_PRESETS[name])) document.getElementById(`aug-${key}`).value = value;
}
function cancelAugmentationPreview() {
    clearTimeout(augmentationTimer);
    augmentationAbort?.abort();
    augmentationGeneration++;
    document.getElementById('augmentation-status').textContent = '';
}
async function renderAugmentationPreview(generation) {
    const controller = new AbortController();
    augmentationAbort = controller;
    const status = document.getElementById('augmentation-status');
    status.textContent = 'Generating preview…';
    try {
        const response = await fetch(`/api/projects/${projectId}/images/${copySourceImageId}/augmentation-preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ augmentation: getAugmentation() }), signal: controller.signal
        });
        if (!response.ok) throw new Error('Could not load preview.');
        const bitmap = await createImageBitmap(await response.blob());
        if (generation !== augmentationGeneration) { bitmap.close(); return; }
        const canvas = document.getElementById('copy-preview-canvas');
        const ctx = canvas.getContext('2d');
        const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
        const w = bitmap.width * scale, h = bitmap.height * scale;
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        bitmap.close();
        status.textContent = 'Filtered preview — these settings will be applied to the saved copy.';
    } catch (err) {
        if (generation === augmentationGeneration && err.name !== 'AbortError') status.textContent = err.message;
    }
}

function syncFilterControls() {
    const filter = getSelectedCopyFilter();
    document.getElementById('tint-controls').hidden = filter !== 'tint';
    document.getElementById('nv-controls').hidden = filter !== 'nightvision';
    document.getElementById('augmentation-controls').hidden = filter !== 'augmentation';
    const source = images.find(img => img.id === copySourceImageId);
    const training = filter === 'augmentation';
    const splitSelect = document.getElementById('copy-split');
    splitSelect.disabled = training;
    if (training) splitSelect.value = 'train';
    document.getElementById('confirm-copy-btn').disabled = training && source?.split !== 'train';
    for (const el of document.querySelectorAll('[data-augmentation]')) document.getElementById(`aug-${el.dataset.augmentation}-value`).textContent = el.value;
    document.getElementById('tint-color-hex').textContent = getTintColor();
    document.querySelectorAll('.nv-variant').forEach((el) => {
        const input = el.querySelector('input');
        el.classList.toggle('active', !!input?.checked);
    });
}

function scheduleCopyPreview() {
    cancelAugmentationPreview();
    if (getSelectedCopyFilter() === 'augmentation' && !document.getElementById('preview-original').checked) {
        if (previewRaf) cancelAnimationFrame(previewRaf);
        const source = images.find(img => img.id === copySourceImageId);
        if (source?.split !== 'train') {
            document.getElementById('augmentation-status').textContent = 'Assign the original image to the train split first.';
            return;
        }
        document.getElementById('augmentation-status').textContent = 'Updating preview…';
        const generation = augmentationGeneration;
        augmentationTimer = setTimeout(() => renderAugmentationPreview(generation), 300);
        return;
    }
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = requestAnimationFrame(() => {
        previewRaf = null;
        renderCopyPreview();
    });
}

function applyNightvisionPreview(data, variantId) {
    const variant = NIGHTVISION_VARIANTS[variantId] || NIGHTVISION_VARIANTS.green;
    const { r: tr, g: tg, b: tb } = variant.tint;
    for (let i = 0; i < data.length; i += 4) {
        let g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        g = Math.min(255, Math.max(0, (g - 18) * variant.contrast + variant.bias));
        data[i] = Math.min(255, g * (tr / 255));
        data[i + 1] = Math.min(255, g * (tg / 255));
        data[i + 2] = Math.min(255, g * (tb / 255));
    }
}

function renderCopyPreview() {
    const canvas = document.getElementById('copy-preview-canvas');
    if (!canvas || !copyPreviewImage?.complete) return;
    const ctx = canvas.getContext('2d');
    const filter = getSelectedCopyFilter();
    const maxW = canvas.width;
    const maxH = canvas.height;
    const scale = Math.min(maxW / copyPreviewImage.naturalWidth, maxH / copyPreviewImage.naturalHeight);
    const w = Math.max(1, Math.round(copyPreviewImage.naturalWidth * scale));
    const h = Math.max(1, Math.round(copyPreviewImage.naturalHeight * scale));
    const x = Math.floor((maxW - w) / 2);
    const y = Math.floor((maxH - h) / 2);

    ctx.clearRect(0, 0, maxW, maxH);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, maxW, maxH);
    ctx.drawImage(copyPreviewImage, x, y, w, h);

    if (filter === 'none' || document.getElementById('preview-original').checked) return;

    const imageData = ctx.getImageData(x, y, w, h);
    const data = imageData.data;

    if (filter === 'grayscale') {
        for (let i = 0; i < data.length; i += 4) {
            const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = data[i + 1] = data[i + 2] = g;
        }
    } else if (filter === 'tint') {
        const { r: tr, g: tg, b: tb } = hexToRgb(getTintColor());
        for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = Math.min(255, lum * (tr / 255) * 1.15 + data[i] * 0.25);
            data[i + 1] = Math.min(255, lum * (tg / 255) * 1.15 + data[i + 1] * 0.25);
            data[i + 2] = Math.min(255, lum * (tb / 255) * 1.15 + data[i + 2] * 0.25);
        }
    } else if (filter === 'nightvision') {
        applyNightvisionPreview(data, getNightvisionVariant());
    }

    ctx.putImageData(imageData, x, y);
}

function openCopyModal(imageId) {
    const img = images.find((i) => i.id === imageId);
    if (!img) return;
    copySourceImageId = imageId;
    document.getElementById('copy-source-name').textContent = img.originalName;
    document.getElementById('copy-split').value = img.split === 'unassigned' ? 'train' : img.split;
    document.querySelector('input[name="copy-filter"][value="none"]').checked = true;
    document.getElementById('tint-color').value = '#14b8a6';
    document.querySelector('input[name="nv-variant"][value="green"]').checked = true;
    document.getElementById('augmentation-preset').value = 'neutral';
    document.getElementById('preview-original').checked = false;
    setAugmentationPreset('neutral');
    document.getElementById('copy-annotations').checked = true;
    syncFilterControls();
    document.getElementById('copy-modal').hidden = false;

    copyPreviewImage = new Image();
    copyPreviewImage.crossOrigin = 'anonymous';
    copyPreviewImage.onload = () => scheduleCopyPreview();
    copyPreviewImage.src = img.path;
}

function closeCopyModal() {
    cancelAugmentationPreview();
    if (previewRaf) cancelAnimationFrame(previewRaf);
    document.getElementById('copy-modal').hidden = true;
    copySourceImageId = null;
    copyPreviewImage = null;
}

async function confirmCopyImage() {
    if (!copySourceImageId) return;
    const split = document.getElementById('copy-split').value;
    const filter = getSelectedCopyFilter();
    const tintColor = getTintColor();
    const nightvisionVariant = getNightvisionVariant();
    const copyAnnotations = document.getElementById('copy-annotations').checked;
    const btn = document.getElementById('confirm-copy-btn');
    btn.disabled = true;
    showToast('Creating copy…');
    try {
        const result = await api(`/api/projects/${projectId}/images/${copySourceImageId}/copy`, {
            method: 'POST',
            body: JSON.stringify({
                split,
                filter,
                tintColor: filter === 'tint' ? tintColor : undefined,
                nightvisionVariant: filter === 'nightvision' ? nightvisionVariant : undefined,
                augmentation: filter === 'augmentation' ? getAugmentation() : undefined,
                copyAnnotations
            })
        });
        closeCopyModal();
        const filterNote = filter === 'tint'
            ? `tint ${tintColor}`
            : (filter === 'nightvision'
                ? `nv ${nightvisionVariant}`
                : (filter !== 'none' ? filter : ''));
        showToast(`Copy created in ${split}${filterNote ? ` (${filterNote})` : ''}`, 'success');
        await reloadProject();
        if (result.image?.id) selectImage(result.image.id);
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
    }
}

async function reloadProject() {
    const data = await api(`/api/projects/${projectId}`);
    project = data;
    labels = data.labels || [];
    images = data.images || [];
    annotations = data.annotations || [];

    document.getElementById('project-title').textContent = project.name;
    document.getElementById('project-description').textContent = project.description || '';
    document.title = `${project.name} · Aeronir`;

    updateStats();
    updateLabelUI();
    renderImageList();

    if (currentImageId && images.some((img) => img.id === currentImageId)) {
        await selectImage(currentImageId);
    } else if (filteredImages().length) {
        await selectImage(filteredImages()[0].id);
    } else {
        currentImageId = null;
        await selectImage(null);
    }
}

function getCanvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
        x: clientX - rect.left,
        y: clientY - rect.top
    };
}

async function finishBox(x1, y1, x2, y2) {
    const img = currentImage();
    if (!img || !currentLabelId) return;

    const yolo = canvasToYolo(x1, y1, x2, y2, img.width, img.height);
    if (yolo.width < 0.005 || yolo.height < 0.005) {
        showToast('Box too small', 'warning');
        return;
    }

    try {
        const annotation = await api(`/api/projects/${projectId}/annotations`, {
            method: 'POST',
            body: JSON.stringify({
                imageId: img.id,
                labelId: currentLabelId,
                yolo
            })
        });
        annotations.push(annotation);
        if (project?.stats) {
            project.stats.annotationCount = (project.stats.annotationCount || 0) + 1;
            project.stats.annotatedImages = new Set(annotations.map((a) => a.imageId)).size;
        }
        updateStats();
        renderImageList();
        renderAnnotationChips();
        drawScene();
    } catch (err) {
        alert(err.message);
    }
}

function setupCanvasEvents() {
    canvas = document.getElementById('label-canvas');
    ctx = canvas.getContext('2d');
    updateCanvasCursor();

    const onDown = (e) => {
        const img = currentImage();
        if (!img) return;
        const p = getCanvasPoint(e);

        // Move existing boxes when draw is OFF
        if (!drawEnabled) {
            const hit = hitTestAnnotation(p.x, p.y);
            if (!hit) return;
            e.preventDefault();
            isMoving = true;
            movingAnnotationId = hit.annotation.id;
            moveRect = { ...hit.rect };
            moveOffsetX = p.x - hit.rect.x;
            moveOffsetY = p.y - hit.rect.y;
            updateCanvasCursor('grabbing');
            drawScene();
            return;
        }

        if (!currentLabelId) return;
        e.preventDefault();
        isDrawing = true;
        startX = p.x;
        startY = p.y;
        currentBox = { x: startX, y: startY, w: 0, h: 0 };
    };

    const onMove = (e) => {
        const p = getCanvasPoint(e);

        if (isMoving && moveRect) {
            e.preventDefault();
            moveRect = clampMoveRect({
                x: p.x - moveOffsetX,
                y: p.y - moveOffsetY,
                w: moveRect.w,
                h: moveRect.h
            }, canvas.width, canvas.height);
            drawScene();
            return;
        }

        if (isDrawing) {
            e.preventDefault();
            currentBox = {
                x: Math.min(startX, p.x),
                y: Math.min(startY, p.y),
                w: Math.abs(p.x - startX),
                h: Math.abs(p.y - startY)
            };
            drawScene();
            return;
        }

        // Hover feedback for move mode
        if (!drawEnabled) {
            const hit = hitTestAnnotation(p.x, p.y);
            const nextId = hit ? hit.annotation.id : null;
            if (nextId !== hoverAnnotationId) {
                hoverAnnotationId = nextId;
                updateCanvasCursor();
                drawScene();
            }
        }
    };

    const onUp = async (e) => {
        if (isMoving && moveRect && movingAnnotationId) {
            e.preventDefault();
            const img = currentImage();
            const annotationId = movingAnnotationId;
            const rect = moveRect;
            isMoving = false;
            movingAnnotationId = null;
            moveRect = null;
            updateCanvasCursor();

            if (!img) {
                drawScene();
                return;
            }

            const yolo = canvasToYolo(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, img.width, img.height);
            try {
                const updated = await api(`/api/projects/${projectId}/annotations/${annotationId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ yolo })
                });
                const idx = annotations.findIndex((a) => a.id === annotationId);
                if (idx >= 0) annotations[idx] = updated;
            } catch (err) {
                alert(err.message);
                await reloadProject();
                return;
            }
            drawScene();
            return;
        }

        if (!isDrawing) return;
        e.preventDefault();
        isDrawing = false;
        const box = currentBox;
        currentBox = null;
        if (box && box.w > 3 && box.h > 3) {
            await finishBox(box.x, box.y, box.x + box.w, box.y + box.h);
        } else {
            drawScene();
        }
    };

    const onLeave = () => {
        if (hoverAnnotationId && !isMoving) {
            hoverAnnotationId = null;
            updateCanvasCursor();
            drawScene();
        }
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
}

async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const form = new FormData();
    files.forEach((f) => form.append('images', f));
    form.append('split', document.getElementById('upload-split').value);

    showToast(`Uploading ${files.length} image(s)…`);
    try {
        const result = await api(`/api/projects/${projectId}/images`, {
            method: 'POST',
            body: form
        });
        showToast(`${result.count} image(s) uploaded`, 'success');
        await reloadProject();
        if (result.images?.[0]) selectImage(result.images[0].id);
    } catch (err) {
        alert(err.message);
    }
}

async function downloadYoloZip() {
    showToast('Preparing YOLO export…');
    try {
        const data = await api(`/api/projects/${projectId}/export/yolo`);
        const total = (data.splits.train?.length || 0) + (data.splits.valid?.length || 0) + (data.splits.test?.length || 0);
        if (!total) {
            alert('No images in train/valid/test. Assign splits or run Auto-split first.');
            return;
        }
        if (!data.classes.length) {
            alert('Create at least one class before exporting.');
            return;
        }
        if (data.stats.unassignedExcluded > 0) {
            showToast(`${data.stats.unassignedExcluded} unassigned image(s) excluded`, 'warning');
        }

        if (typeof JSZip === 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        const zip = new JSZip();
        const slug = data.project.slug || 'dataset';

        async function addSplit(name, items) {
            const imagesFolder = zip.folder(`${name}/images`);
            const labelsFolder = zip.folder(`${name}/labels`);
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const base = item.filename.replace(/\.[^.]+$/, '');
                labelsFolder.file(`${base}.txt`, item.yoloContent || '');
                const response = await fetch(item.imagePath);
                imagesFolder.file(item.filename, await response.blob());
                showToast(`${name}: ${i + 1}/${items.length}`);
            }
        }

        await addSplit('train', data.splits.train || []);
        await addSplit('valid', data.splits.valid || []);
        await addSplit('test', data.splits.test || []);

        const yaml = `# YOLO Dataset Configuration
# Project: ${data.project.name}
# Generated by Aeronir on ${new Date().toISOString()}

path: .
train: train/images
val: valid/images
test: test/images

nc: ${data.classes.length}
names:
${data.classes.map((c, i) => `  ${i}: ${c.name}`).join('\n')}
`;
        zip.file('data.yaml', yaml);
        zip.file('classes.txt', data.classesFile || '');

        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${slug}_yolo_${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('YOLO dataset downloaded', 'success');
    } catch (err) {
        alert(err.message);
    }
}

function navigateImage(delta) {
    const filtered = filteredImages();
    if (!filtered.length) return;
    let idx = filtered.findIndex((img) => img.id === currentImageId);
    if (idx < 0) idx = 0;
    else idx = (idx + delta + filtered.length) % filtered.length;
    selectImage(filtered[idx].id);
}

document.addEventListener('DOMContentLoaded', async () => {
    const auth = await requireAuth();
    if (!auth) return;
    updateUserUI(auth.user);
    if (auth.user.role === 'admin') {
        document.getElementById('admin-link').style.display = '';
        document.getElementById('db-link').style.display = '';
    }

    const params = new URLSearchParams(window.location.search);
    projectId = Number(params.get('id'));
    document.getElementById('train-project-link').href = `/training?source=custom:${projectId}`;
    if (!projectId) {
        window.location.href = '/datasets';
        return;
    }

    setupCanvasEvents();
    updateDrawButton();
    window.addEventListener('resize', () => fitCanvas());

    document.getElementById('toggle-draw').addEventListener('click', () => {
        if (!currentLabelId) {
            showToast('Select a class first', 'warning');
            return;
        }
        drawEnabled = !drawEnabled;
        updateDrawButton();
    });

    document.getElementById('label-select').addEventListener('change', (e) => {
        const id = Number(e.target.value);
        const label = labels.find((l) => l.id === id);
        currentLabelId = label ? label.id : null;
        currentLabelName = label ? label.name : null;
        updateActiveLabelDisplay();
        if (currentLabelId && !drawEnabled) {
            drawEnabled = true;
            updateDrawButton();
        }
    });

    document.getElementById('add-label-btn').addEventListener('click', async () => {
        const input = document.getElementById('new-label-input');
        const name = input.value.trim();
        if (!name) return;
        try {
            const label = await api(`/api/projects/${projectId}/labels`, {
                method: 'POST',
                body: JSON.stringify({ name })
            });
            input.value = '';
            await reloadProject();
            currentLabelId = label.id;
            currentLabelName = label.name;
            document.getElementById('label-select').value = label.id;
            updateActiveLabelDisplay();
            drawEnabled = true;
            updateDrawButton();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('new-label-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('add-label-btn').click();
    });

    document.getElementById('split-filter').addEventListener('change', (e) => {
        splitFilter = e.target.value;
        renderImageList();
    });

    document.getElementById('prev-image-btn').addEventListener('click', () => navigateImage(-1));
    document.getElementById('next-image-btn').addEventListener('click', () => navigateImage(1));

    document.getElementById('current-split').addEventListener('change', async (e) => {
        const img = currentImage();
        if (!img) return;
        try {
            const updated = await api(`/api/projects/${projectId}/images/${img.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ split: e.target.value })
            });
            const idx = images.findIndex((i) => i.id === img.id);
            if (idx >= 0) images[idx] = updated;
            await reloadProject();
            selectImage(img.id);
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('delete-image-btn').addEventListener('click', async () => {
        const img = currentImage();
        if (!img || !confirm('Delete this image and its annotations?')) return;
        try {
            await api(`/api/projects/${projectId}/images/${img.id}`, { method: 'DELETE' });
            currentImageId = null;
            await reloadProject();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('copy-image-btn').addEventListener('click', () => {
        if (currentImageId) openCopyModal(currentImageId);
    });
    document.getElementById('confirm-copy-btn').addEventListener('click', confirmCopyImage);
    document.querySelectorAll('[data-close-copy]').forEach((el) => {
        el.addEventListener('click', closeCopyModal);
    });
    document.querySelectorAll('input[name="copy-filter"]').forEach((el) => {
        el.addEventListener('change', () => {
            syncFilterControls();
            scheduleCopyPreview();
        });
    });
    document.getElementById('preview-original').addEventListener('change', scheduleCopyPreview);
    document.getElementById('augmentation-preset').addEventListener('change', (event) => {
        setAugmentationPreset(event.target.value);
        syncFilterControls();
        scheduleCopyPreview();
    });
    document.querySelectorAll('[data-augmentation]').forEach(el => el.addEventListener('input', () => {
        document.getElementById('augmentation-preset').value = 'neutral';
        syncFilterControls();
        scheduleCopyPreview();
    }));
    document.getElementById('tint-color').addEventListener('input', () => {
        syncFilterControls();
        scheduleCopyPreview();
    });
    document.querySelectorAll('.tint-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.getElementById('tint-color').value = btn.dataset.color;
            document.querySelector('input[name="copy-filter"][value="tint"]').checked = true;
            syncFilterControls();
            scheduleCopyPreview();
        });
    });
    document.querySelectorAll('input[name="nv-variant"]').forEach((el) => {
        el.addEventListener('change', () => {
            document.querySelector('input[name="copy-filter"][value="nightvision"]').checked = true;
            syncFilterControls();
            scheduleCopyPreview();
        });
    });

    const dropzone = document.getElementById('dropzone');
    const input = document.getElementById('image-input');
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        uploadFiles(e.dataTransfer.files);
    });
    input.addEventListener('change', () => {
        uploadFiles(input.files);
        input.value = '';
    });

    document.getElementById('auto-split-btn').addEventListener('click', async () => {
        if (!confirm('Randomly assign all unassigned images to train/valid/test (80/15/5)?')) return;
        try {
            const result = await api(`/api/projects/${projectId}/auto-split`, {
                method: 'POST',
                body: JSON.stringify({ onlyUnassigned: true })
            });
            showToast(`Split ${result.updated} image(s)`, 'success');
            await reloadProject();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('export-project-btn').addEventListener('click', downloadYoloZip);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('copy-modal').hidden) {
            closeCopyModal();
            return;
        }
        if (e.target.matches('input, textarea, select')) return;
        if (!document.getElementById('copy-modal').hidden) return;
        if (e.key === 'ArrowLeft' || e.key === 'a') navigateImage(-1);
        if (e.key === 'ArrowRight' || e.key === 'd') navigateImage(1);
        if (e.key === ' ') {
            e.preventDefault();
            document.getElementById('toggle-draw').click();
        }
    });

    try {
        await reloadProject();
    } catch (err) {
        alert(err.message);
        window.location.href = '/datasets';
    }
});
