import { audioDatasetsRouter } from './lib/audio-datasets.js';
import { augmentImage, parseAugmentation } from './lib/augmentation.js';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs/promises';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import { JSONFilePreset } from 'lowdb/node';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'aeronir-secret-key-change-in-production';
const JWT_EXPIRES = '7d';

// Folder for saved tiles
const TILES_DIR = path.join(__dirname, 'public', 'saved_tiles');
const DATASETS_DIR = path.join(__dirname, 'public', 'dataset_files');

const VALID_SPLITS = ['train', 'valid', 'test', 'unassigned'];
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);

// Default Tile-Server URL
const DEFAULT_TILE_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg';

// --- Initialize lowdb ---
const defaultData = {
    users: [],
    labels: [],
    boxes: [],
    projects: [],
    projectLabels: [],
    projectImages: [],
    projectAnnotations: [],
    tileSize: 256
};

const db = await JSONFilePreset(path.join(__dirname, 'db.json'), defaultData);

await db.read();
if (!db.data.users) {
    db.data.users = [];
}
if (!db.data.projects) db.data.projects = [];
if (!db.data.projectLabels) db.data.projectLabels = [];
if (!db.data.projectImages) db.data.projectImages = [];
if (!db.data.projectAnnotations) db.data.projectAnnotations = [];
await db.write();

await fs.mkdir(TILES_DIR, { recursive: true });
await fs.mkdir(DATASETS_DIR, { recursive: true });

function nextId(items) {
    return items.length ? Math.max(...items.map((i) => i.id)) + 1 : 1;
}

function slugifyProjectName(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'dataset';
}

function projectDir(projectId) {
    return path.join(DATASETS_DIR, String(projectId));
}

function projectStats(projectId) {
    const images = db.data.projectImages.filter((img) => img.projectId === projectId);
    const labels = db.data.projectLabels.filter((l) => l.projectId === projectId);
    const annotations = db.data.projectAnnotations.filter((a) => a.projectId === projectId);
    const annotatedImageIds = new Set(annotations.map((a) => a.imageId));

    const splits = { train: 0, valid: 0, test: 0, unassigned: 0 };
    for (const img of images) {
        splits[img.split] = (splits[img.split] || 0) + 1;
    }

    return {
        imageCount: images.length,
        labelCount: labels.length,
        annotationCount: annotations.length,
        annotatedImages: annotatedImageIds.size,
        unlabeledImages: images.length - annotatedImageIds.size,
        splits
    };
}

async function deleteProjectFiles(projectId) {
    const dir = projectDir(projectId);
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 50 },
    fileFilter: (req, file, cb) => {
        if (IMAGE_MIME_TYPES.has(file.mimetype) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// --- Express + Socket.io Setup ---
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(cookieParser());

// --- Online Users Tracking ---
const onlineUsers = new Map(); // socketId -> { id, email, role }

// --- Socket.io Authentication & Connection ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication required'));
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.user.email}`);

    // Add to online users
    onlineUsers.set(socket.id, {
        id: socket.user.id,
        email: socket.user.email,
        role: socket.user.role
    });

    // Broadcast updated online users
    io.emit('users:online', Array.from(onlineUsers.values()));

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`🔌 User disconnected: ${socket.user.email}`);
        onlineUsers.delete(socket.id);
        io.emit('users:online', Array.from(onlineUsers.values()));
    });

    // Handle cursor position updates (for collaborative editing)
    socket.on('cursor:move', (data) => {
        socket.broadcast.emit('cursor:update', {
            userId: socket.user.id,
            email: socket.user.email,
            ...data
        });
    });
});

// --- Emit Helper ---
function emitToAll(event, data) {
    io.emit(event, data);
}

// --- Authentication Middleware ---
function authenticateToken(req, res, next) {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

async function needsSetup() {
    await db.read();
    return !db.data.users.some(u => u.role === 'admin');
}

// --- Auth API Routes ---

app.get('/api/auth/needs-setup', async (req, res) => {
    res.json({ needsSetup: await needsSetup() });
});

app.post('/api/auth/setup', async (req, res) => {
    const { email, password } = req.body;

    if (!await needsSetup()) {
        return res.status(400).json({ error: 'Setup already completed' });
    }

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await db.read();

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: 1,
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role: 'admin',
        createdAt: new Date().toISOString()
    };

    db.data.users.push(newUser);
    await db.write();

    const token = jwt.sign(
        { id: newUser.id, email: newUser.email, role: newUser.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
    );

    res.cookie('token', token, {
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    });

    res.status(201).json({
        message: 'Admin account created',
        user: { id: newUser.id, email: newUser.email, role: newUser.role },
        token
    });
});

app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await db.read();

    if (db.data.users.find(u => u.email === email.toLowerCase().trim())) {
        return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: db.data.users.length ? Math.max(...db.data.users.map(u => u.id)) + 1 : 1,
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        role: 'user',
        createdAt: new Date().toISOString()
    };

    db.data.users.push(newUser);
    await db.write();

    const token = jwt.sign(
        { id: newUser.id, email: newUser.email, role: newUser.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
    );

    res.cookie('token', token, {
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    });

    res.status(201).json({
        message: 'Account created',
        user: { id: newUser.id, email: newUser.email, role: newUser.role },
        token
    });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    await db.read();

    const user = db.data.users.find(u => u.email === email.toLowerCase().trim());
    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
    );

    res.cookie('token', token, {
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    });

    res.json({
        message: 'Login successful',
        user: { id: user.id, email: user.email, role: user.role },
        token
    });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json({ user: req.user });
});

// --- Admin User Management API ---

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    await db.read();
    const users = db.data.users.map(u => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt
    }));
    res.json(users);
});

app.put('/api/admin/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }

    await db.read();
    const user = db.data.users.find(u => u.id === userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'admin' && role === 'user') {
        const adminCount = db.data.users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) {
            return res.status(400).json({ error: 'Cannot remove the last admin' });
        }
    }

    user.role = role;
    await db.write();

    res.json({ message: 'Role updated', user: { id: user.id, email: user.email, role: user.role } });
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);

    if (req.user.id === userId) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    await db.read();

    const userIndex = db.data.users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
    }

    const user = db.data.users[userIndex];
    if (user.role === 'admin') {
        const adminCount = db.data.users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) {
            return res.status(400).json({ error: 'Cannot delete the last admin' });
        }
    }

    db.data.users.splice(userIndex, 1);
    await db.write();

    res.json({ message: 'User deleted' });
});

// --- Helper Functions for Tile Calculations ---

function latLngToTile(lat, lng, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor((lng + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
    return { x, y, z: zoom };
}

function latLngToGlobalPixel(lat, lng, zoom, tileSize = 256) {
    const n = Math.pow(2, zoom);
    const globalX = (lng + 180) / 360 * n * tileSize;
    const latRad = lat * Math.PI / 180;
    const globalY = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n * tileSize;
    return { globalX, globalY };
}

function getTilesForBounds(bounds, zoom) {
    const swTile = latLngToTile(bounds.south, bounds.west, zoom);
    const neTile = latLngToTile(bounds.north, bounds.east, zoom);

    const tiles = [];
    const minX = Math.min(swTile.x, neTile.x);
    const maxX = Math.max(swTile.x, neTile.x);
    const minY = Math.min(swTile.y, neTile.y);
    const maxY = Math.max(swTile.y, neTile.y);

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            tiles.push({ x, y, z: zoom });
        }
    }

    return { tiles, gridWidth: maxX - minX + 1, gridHeight: maxY - minY + 1, minX, minY, maxX, maxY };
}

async function downloadTile(z, x, y, tileUrlTemplate = DEFAULT_TILE_URL) {
    const url = tileUrlTemplate
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y)
        .replace('{s}', ['a', 'b', 'c'][Math.floor(Math.random() * 3)]);

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (err) {
        console.error(`Error loading tile ${z}/${x}/${y}:`, err.message);
        return await sharp({
            create: { width: 256, height: 256, channels: 3, background: { r: 50, g: 50, b: 60 } }
        }).jpeg().toBuffer();
    }
}

async function createCompositeImage(tileGrid, tileSize = 256, tileUrl = DEFAULT_TILE_URL) {
    const { tiles, gridWidth, gridHeight, minX, minY } = tileGrid;
    const compositeWidth = gridWidth * tileSize;
    const compositeHeight = gridHeight * tileSize;

    const tileBuffers = await Promise.all(
        tiles.map(async (tile) => ({
            ...tile,
            buffer: await downloadTile(tile.z, tile.x, tile.y, tileUrl)
        }))
    );

    const compositeInputs = tileBuffers.map(tile => ({
        input: tile.buffer,
        left: (tile.x - minX) * tileSize,
        top: (tile.y - minY) * tileSize
    }));

    const compositeImage = await sharp({
        create: { width: compositeWidth, height: compositeHeight, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).composite(compositeInputs).jpeg({ quality: 90 }).toBuffer();

    return { buffer: compositeImage, width: compositeWidth, height: compositeHeight };
}

function calculateYoloForComposite(bounds, tileGrid, zoom, tileSize = 256) {
    const { minX, minY, gridWidth, gridHeight } = tileGrid;
    const compositeWidth = gridWidth * tileSize;
    const compositeHeight = gridHeight * tileSize;

    const swPixel = latLngToGlobalPixel(bounds.south, bounds.west, zoom, tileSize);
    const nePixel = latLngToGlobalPixel(bounds.north, bounds.east, zoom, tileSize);

    const offsetX = minX * tileSize;
    const offsetY = minY * tileSize;

    const x1 = swPixel.globalX - offsetX;
    const x2 = nePixel.globalX - offsetX;
    const y1 = nePixel.globalY - offsetY;
    const y2 = swPixel.globalY - offsetY;

    const boxWidth = Math.abs(x2 - x1);
    const boxHeight = Math.abs(y2 - y1);
    const xCenter = (x1 + x2) / 2 / compositeWidth;
    const yCenter = (y1 + y2) / 2 / compositeHeight;

    return {
        x_center: Math.max(0, Math.min(1, xCenter)),
        y_center: Math.max(0, Math.min(1, yCenter)),
        width: Math.max(0, Math.min(1, boxWidth / compositeWidth)),
        height: Math.max(0, Math.min(1, boxHeight / compositeHeight)),
        pixel: { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) }
    };
}

// --- Labels API (with real-time sync) ---

app.get('/api/labels', authenticateToken, async (req, res) => {
    await db.read();
    res.json(db.data.labels);
});

app.post('/api/labels', authenticateToken, async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
    }

    await db.read();
    const labels = db.data.labels;

    const existing = labels.find((l) => l.name === name.trim());
    if (existing) return res.json(existing);

    const newLabel = {
        id: labels.length ? Math.max(...labels.map((l) => l.id)) + 1 : 1,
        name: name.trim(),
        userId: req.user.id,
        userEmail: req.user.email
    };
    labels.push(newLabel);
    await db.write();

    // 🔴 Emit real-time event
    emitToAll('label:created', newLabel);

    res.status(201).json(newLabel);
});

app.delete('/api/labels/:id', authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    await db.read();

    const index = db.data.labels.findIndex(l => l.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Label not found' });
    }

    const deletedLabel = db.data.labels[index];
    const boxesToDelete = db.data.boxes.filter(b => b.labelId === id);

    for (const box of boxesToDelete) {
        if (box.image) {
            const imagePath = path.join(__dirname, 'public', box.image);
            try { await fs.unlink(imagePath); } catch (e) { /* ignore */ }
        }
        // 🔴 Emit box deleted for each box
        emitToAll('box:deleted', { id: box.id });
    }

    db.data.labels.splice(index, 1);
    db.data.boxes = db.data.boxes.filter(b => b.labelId !== id);
    await db.write();

    // 🔴 Emit real-time event
    emitToAll('label:deleted', { id, deletedBy: req.user.email });

    res.json({ success: true });
});

// --- Boxes API (with real-time sync) ---

app.get('/api/boxes', authenticateToken, async (req, res) => {
    await db.read();
    res.json(db.data.boxes);
});

app.post('/api/boxes', authenticateToken, async (req, res) => {
    const { labelId, labelName, bounds, zoom, tileUrl } = req.body;

    if (!labelId || !labelName || !bounds) {
        return res.status(400).json({ error: 'labelId, labelName and bounds are required' });
    }

    await db.read();

    const zoomLevel = zoom || 14;
    const tileSize = 256;
    const useTileUrl = tileUrl || DEFAULT_TILE_URL;

    const tileGrid = getTilesForBounds(bounds, zoomLevel);
    const { tiles, gridWidth, gridHeight } = tileGrid;

    const boxId = db.data.boxes.length ? Math.max(...db.data.boxes.map((b) => b.id)) + 1 : 1;

    console.log(`📦 Box ${boxId} by ${req.user.email}: ${tiles.length} Tile(s)`);

    let imageInfo;
    try {
        const composite = await createCompositeImage(tileGrid, tileSize, useTileUrl);
        const imageName = `box_${boxId}_${Date.now()}.jpg`;
        const imagePath = path.join(TILES_DIR, imageName);
        await fs.writeFile(imagePath, composite.buffer);
        imageInfo = {
            path: `/saved_tiles/${imageName}`,
            width: composite.width,
            height: composite.height
        };
    } catch (err) {
        console.error('Error creating composite image:', err);
        imageInfo = null;
    }

    const yoloCoords = calculateYoloForComposite(bounds, tileGrid, zoomLevel, tileSize);

    const newBox = {
        id: boxId,
        labelId,
        labelName,
        bounds,
        zoom: zoomLevel,
        tileUrl: useTileUrl,
        tiles: tiles.map(t => ({ x: t.x, y: t.y, z: t.z })),
        tileGrid: { width: gridWidth, height: gridHeight, minX: tileGrid.minX, minY: tileGrid.minY },
        image: imageInfo ? imageInfo.path : null,
        imageSize: imageInfo ? { width: imageInfo.width, height: imageInfo.height } : null,
        yolo: yoloCoords,
        userId: req.user.id,
        userEmail: req.user.email,
        createdAt: new Date().toISOString()
    };

    db.data.boxes.push(newBox);
    await db.write();

    // 🔴 Emit real-time event
    emitToAll('box:created', newBox);

    res.status(201).json(newBox);
});

app.delete('/api/boxes/:id', authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    await db.read();

    const index = db.data.boxes.findIndex(b => b.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Box not found' });
    }

    const box = db.data.boxes[index];
    if (box.image) {
        const imagePath = path.join(__dirname, 'public', box.image);
        try { await fs.unlink(imagePath); } catch (e) { /* ignore */ }
    }

    db.data.boxes.splice(index, 1);
    await db.write();

    // 🔴 Emit real-time event
    emitToAll('box:deleted', { id, deletedBy: req.user.email });

    res.json({ success: true });
});

// --- YOLO Export API (satellite map boxes) ---

app.get('/api/export/yolo', authenticateToken, async (req, res) => {
    await db.read();

    const { boxes, labels } = db.data;

    const labelToClass = {};
    labels.forEach((label, index) => {
        labelToClass[label.id] = index;
    });

    const imageAnnotations = boxes
        .filter(box => box.image && box.yolo)
        .map(box => {
            const classId = labelToClass[box.labelId];
            if (classId === undefined) return null;

            return {
                boxId: box.id,
                imagePath: box.image,
                imageSize: box.imageSize,
                tileCount: box.tiles.length,
                gridSize: box.tileGrid ? `${box.tileGrid.width}x${box.tileGrid.height}` : '1x1',
                annotation: {
                    classId,
                    labelName: box.labelName,
                    x_center: box.yolo.x_center.toFixed(6),
                    y_center: box.yolo.y_center.toFixed(6),
                    width: box.yolo.width.toFixed(6),
                    height: box.yolo.height.toFixed(6),
                    pixel: box.yolo.pixel
                },
                yoloLine: `${classId} ${box.yolo.x_center.toFixed(6)} ${box.yolo.y_center.toFixed(6)} ${box.yolo.width.toFixed(6)} ${box.yolo.height.toFixed(6)}`
            };
        })
        .filter(Boolean);

    const classesContent = labels.map(l => l.name).join('\n');

    res.json({
        classes: labels.map((l, i) => ({ id: i, name: l.name })),
        classesFile: classesContent,
        images: imageAnnotations,
        totalBoxes: boxes.length,
        totalImages: imageAnnotations.length
    });
});

// --- Custom Dataset Projects API ---

app.get('/api/projects', authenticateToken, async (req, res) => {
    await db.read();
    const projects = db.data.projects
        .map((p) => ({ ...p, stats: projectStats(p.id) }))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    res.json(projects);
});

app.post('/api/projects', authenticateToken, async (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Project name is required' });
    }

    await db.read();
    const trimmed = name.trim();
    if (db.data.projects.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
        return res.status(400).json({ error: 'A project with this name already exists' });
    }

    const now = new Date().toISOString();
    const project = {
        id: nextId(db.data.projects),
        name: trimmed,
        slug: slugifyProjectName(trimmed),
        description: (description || '').trim(),
        userId: req.user.id,
        userEmail: req.user.email,
        createdAt: now,
        updatedAt: now
    };

    db.data.projects.push(project);
    await db.write();
    await fs.mkdir(projectDir(project.id), { recursive: true });

    res.status(201).json({ ...project, stats: projectStats(project.id) });
});

app.get('/api/projects/:id', authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    await db.read();
    const project = db.data.projects.find((p) => p.id === id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const labels = db.data.projectLabels.filter((l) => l.projectId === id);
    const images = db.data.projectImages.filter((img) => img.projectId === id);
    const annotations = db.data.projectAnnotations.filter((a) => a.projectId === id);

    res.json({
        ...project,
        stats: projectStats(id),
        labels,
        images,
        annotations
    });
});

app.patch('/api/projects/:id', authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    const { name, description } = req.body;
    await db.read();

    const project = db.data.projects.find((p) => p.id === id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (name && name.trim()) {
        const trimmed = name.trim();
        if (db.data.projects.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
            return res.status(400).json({ error: 'A project with this name already exists' });
        }
        project.name = trimmed;
        project.slug = slugifyProjectName(trimmed);
    }
    if (description !== undefined) project.description = String(description).trim();
    project.updatedAt = new Date().toISOString();
    await db.write();

    res.json({ ...project, stats: projectStats(id) });
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    await db.read();

    const index = db.data.projects.findIndex((p) => p.id === id);
    if (index === -1) return res.status(404).json({ error: 'Project not found' });

    db.data.projects.splice(index, 1);
    db.data.projectLabels = db.data.projectLabels.filter((l) => l.projectId !== id);
    db.data.projectImages = db.data.projectImages.filter((img) => img.projectId !== id);
    db.data.projectAnnotations = db.data.projectAnnotations.filter((a) => a.projectId !== id);
    await db.write();
    await deleteProjectFiles(id);

    res.json({ success: true });
});

app.post('/api/projects/:id/labels', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.id);
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    await db.read();
    if (!db.data.projects.find((p) => p.id === projectId)) {
        return res.status(404).json({ error: 'Project not found' });
    }

    const trimmed = name.trim();
    const existing = db.data.projectLabels.find(
        (l) => l.projectId === projectId && l.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) return res.json(existing);

    const label = {
        id: nextId(db.data.projectLabels),
        projectId,
        name: trimmed,
        userId: req.user.id,
        userEmail: req.user.email,
        createdAt: new Date().toISOString()
    };
    db.data.projectLabels.push(label);

    const project = db.data.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = new Date().toISOString();
    await db.write();

    res.status(201).json(label);
});

app.delete('/api/projects/:projectId/labels/:labelId', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.projectId);
    const labelId = Number(req.params.labelId);
    await db.read();

    const index = db.data.projectLabels.findIndex((l) => l.id === labelId && l.projectId === projectId);
    if (index === -1) return res.status(404).json({ error: 'Label not found' });

    db.data.projectLabels.splice(index, 1);
    db.data.projectAnnotations = db.data.projectAnnotations.filter(
        (a) => !(a.projectId === projectId && a.labelId === labelId)
    );

    const project = db.data.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = new Date().toISOString();
    await db.write();

    res.json({ success: true });
});

app.post('/api/projects/:id/images', authenticateToken, (req, res) => {
    upload.array('images', 50)(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Upload failed' });
        }

        const projectId = Number(req.params.id);
        let split = (req.body.split || 'unassigned').toLowerCase();
        if (!VALID_SPLITS.includes(split)) split = 'unassigned';

        await db.read();
        const project = db.data.projects.find((p) => p.id === projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No images uploaded' });
        }

        await fs.mkdir(projectDir(projectId), { recursive: true });

        const created = [];
        let nextImageId = nextId(db.data.projectImages);
        for (const file of req.files) {
            try {
                const meta = await sharp(file.buffer).metadata();
                const imageId = nextImageId++;

                // Normalize exotic formats to JPEG for YOLO compatibility
                let outBuffer = file.buffer;
                let outExt = (meta.format === 'jpeg' ? 'jpg' : meta.format) || 'jpg';
                let outWidth = meta.width;
                let outHeight = meta.height;

                if (!['jpeg', 'png', 'webp'].includes(meta.format)) {
                    outBuffer = await sharp(file.buffer).jpeg({ quality: 92 }).toBuffer();
                    outExt = 'jpg';
                    const converted = await sharp(outBuffer).metadata();
                    outWidth = converted.width;
                    outHeight = converted.height;
                }

                const finalName = `img_${imageId}_${Date.now()}.${outExt}`;
                await fs.writeFile(path.join(projectDir(projectId), finalName), outBuffer);

                const image = {
                    id: imageId,
                    projectId,
                    filename: finalName,
                    originalName: file.originalname,
                    path: `/dataset_files/${projectId}/${finalName}`,
                    width: outWidth,
                    height: outHeight,
                    split,
                    userId: req.user.id,
                    userEmail: req.user.email,
                    createdAt: new Date().toISOString()
                };
                created.push(image);
            } catch (e) {
                console.error('Image processing error:', e.message);
            }
        }

        if (created.length === 0) {
            return res.status(400).json({ error: 'No valid images could be processed' });
        }

        db.data.projectImages.push(...created);
        project.updatedAt = new Date().toISOString();
        await db.write();

        res.status(201).json({ images: created, count: created.length });
    });
});

app.patch('/api/projects/:projectId/images/:imageId', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.projectId);
    const imageId = Number(req.params.imageId);
    const { split } = req.body;

    if (!VALID_SPLITS.includes(split)) {
        return res.status(400).json({ error: 'Invalid split. Use train, valid, test, or unassigned' });
    }

    await db.read();
    const image = db.data.projectImages.find((img) => img.id === imageId && img.projectId === projectId);
    if (!image) return res.status(404).json({ error: 'Image not found' });

    image.split = split;
    const project = db.data.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = new Date().toISOString();
    await db.write();

    res.json(image);
});

app.post('/api/projects/:id/auto-split', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.id);
    const trainRatio = Math.min(1, Math.max(0, Number(req.body.trainRatio ?? 0.8)));
    const validRatio = Math.min(1, Math.max(0, Number(req.body.validRatio ?? 0.15)));
    const onlyUnassigned = req.body.onlyUnassigned !== false;

    await db.read();
    const project = db.data.projects.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let images = db.data.projectImages.filter((img) => img.projectId === projectId);
    if (onlyUnassigned) {
        images = images.filter((img) => img.split === 'unassigned');
    }

    // Fisher-Yates shuffle
    for (let i = images.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [images[i], images[j]] = [images[j], images[i]];
    }

    const trainEnd = Math.floor(images.length * trainRatio);
    const validEnd = trainEnd + Math.floor(images.length * validRatio);

    images.forEach((img, i) => {
        if (i < trainEnd) img.split = 'train';
        else if (i < validEnd) img.split = 'valid';
        else img.split = 'test';
    });

    project.updatedAt = new Date().toISOString();
    await db.write();

    res.json({ updated: images.length, stats: projectStats(projectId) });
});

app.delete('/api/projects/:projectId/images/:imageId', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.projectId);
    const imageId = Number(req.params.imageId);
    await db.read();

    const index = db.data.projectImages.findIndex((img) => img.id === imageId && img.projectId === projectId);
    if (index === -1) return res.status(404).json({ error: 'Image not found' });

    const image = db.data.projectImages[index];
    try {
        await fs.unlink(path.join(__dirname, 'public', image.path.replace(/^\//, '')));
    } catch (e) { /* ignore */ }

    db.data.projectImages.splice(index, 1);
    db.data.projectAnnotations = db.data.projectAnnotations.filter((a) => a.imageId !== imageId);

    const project = db.data.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = new Date().toISOString();
    await db.write();

    res.json({ success: true });
});

const IMAGE_FILTERS = new Set(['none', 'grayscale', 'tint', 'nightvision', 'augmentation']);

const NIGHTVISION_VARIANTS = {
    green: {
        id: 'green',
        label: 'Green Phosphor',
        tint: { r: 32, g: 220, b: 64 },
        brightness: 1.2,
        contrast: 1.25,
        bias: -8
    },
    white: {
        id: 'white',
        label: 'White Phosphor',
        tint: { r: 220, g: 230, b: 240 },
        brightness: 1.15,
        contrast: 1.2,
        bias: -6
    },
    amber: {
        id: 'amber',
        label: 'Amber',
        tint: { r: 255, g: 170, b: 40 },
        brightness: 1.18,
        contrast: 1.22,
        bias: -10
    },
    cyan: {
        id: 'cyan',
        label: 'Cyan',
        tint: { r: 40, g: 210, b: 230 },
        brightness: 1.16,
        contrast: 1.28,
        bias: -8
    },
    red: {
        id: 'red',
        label: 'Red',
        tint: { r: 230, g: 48, b: 48 },
        brightness: 1.1,
        contrast: 1.3,
        bias: -12
    }
};

function parseNightvisionVariant(input) {
    const key = String(input || 'green').toLowerCase();
    return NIGHTVISION_VARIANTS[key] || NIGHTVISION_VARIANTS.green;
}

function parseTintColor(input) {
    if (!input) return { r: 20, g: 184, b: 166 };
    if (typeof input === 'object' && input !== null) {
        const r = Math.max(0, Math.min(255, Number(input.r)));
        const g = Math.max(0, Math.min(255, Number(input.g)));
        const b = Math.max(0, Math.min(255, Number(input.b)));
        if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b };
    }
    if (typeof input === 'string') {
        const hex = input.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16)
            };
        }
    }
    return { r: 20, g: 184, b: 166 };
}

function tintColorToHex({ r, g, b }) {
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

async function applyImageFilter(inputBuffer, filter, options = {}) {
    const pipeline = sharp(inputBuffer);
    switch (filter) {
        case 'augmentation':
            return augmentImage(inputBuffer, options.augmentation);
        case 'grayscale':
            return pipeline.grayscale().jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
        case 'tint': {
            const color = parseTintColor(options.tintColor);
            return pipeline
                .modulate({ saturation: 1.35, brightness: 1.02 })
                .tint(color)
                .jpeg({ quality: 92 })
                .toBuffer({ resolveWithObject: true });
        }
        case 'nightvision': {
            const variant = parseNightvisionVariant(options.nightvisionVariant);
            return pipeline
                .grayscale()
                .normalize()
                .modulate({ brightness: variant.brightness, saturation: 0 })
                .tint(variant.tint)
                .linear(variant.contrast, variant.bias)
                .jpeg({ quality: 92 })
                .toBuffer({ resolveWithObject: true });
        }
        case 'none':
        default: {
            const meta = await sharp(inputBuffer).metadata();
            if (meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp') {
                const { data, info } = await sharp(inputBuffer).toBuffer({ resolveWithObject: true });
                return { data, info: { ...info, format: meta.format } };
            }
            return sharp(inputBuffer).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
        }
    }
}

function filterSuffix(filter, tintColor, nightvisionVariant) {
    if (filter === 'augmentation') return 'augmented';
    if (filter === 'none') return 'copy';
    if (filter === 'grayscale') return 'bw';
    if (filter === 'tint') return `tint_${tintColorToHex(parseTintColor(tintColor)).replace('#', '')}`;
    if (filter === 'nightvision') return `nv_${parseNightvisionVariant(nightvisionVariant).id}`;
    return 'copy';
}

app.post('/api/projects/:projectId/images/:imageId/augmentation-preview', authenticateToken, async (req, res) => {
    let settings;
    try { settings = parseAugmentation(req.body.augmentation); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    await db.read();
    const source = db.data.projectImages.find(img => img.id === Number(req.params.imageId) && img.projectId === Number(req.params.projectId));
    if (!source) return res.status(404).json({ error: 'Image not found' });
    try {
        const input = await fs.readFile(path.join(__dirname, 'public', source.path.replace(/^\//, '')));
        const result = await augmentImage(input, settings);
        const preview = await sharp(result.data).resize({ width: 560, height: 360, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        res.set('Cache-Control', 'no-store').type('png').send(preview);
    } catch (err) {
        res.status(500).json({ error: 'Could not generate preview' });
    }
});

app.post('/api/projects/:projectId/images/:imageId/copy', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.projectId);
    const imageId = Number(req.params.imageId);
    let split = (req.body.split || 'unassigned').toLowerCase();
    const filter = (req.body.filter || 'none').toLowerCase();
    const tintColor = parseTintColor(req.body.tintColor);
    const nightvisionVariant = parseNightvisionVariant(req.body.nightvisionVariant);
    let augmentation;
    try { if (filter === 'augmentation') augmentation = parseAugmentation(req.body.augmentation); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const copyAnnotations = req.body.copyAnnotations !== false;

    if (!VALID_SPLITS.includes(split)) {
        return res.status(400).json({ error: 'Invalid split. Use train, valid, test, or unassigned' });
    }
    if (!IMAGE_FILTERS.has(filter)) {
        return res.status(400).json({ error: 'Invalid filter. Use none, grayscale, tint, nightvision, or augmentation' });
    }

    await db.read();
    const project = db.data.projects.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const source = db.data.projectImages.find((img) => img.id === imageId && img.projectId === projectId);
    if (!source) return res.status(404).json({ error: 'Image not found' });

    if (filter === 'augmentation' && (source.split !== 'train' || split !== 'train')) {
        return res.status(400).json({ error: 'Training augmentation requires a training image and the train split. Assign the original to train first.' });
    }

    const sourceAbs = path.join(__dirname, 'public', source.path.replace(/^\//, ''));
    let inputBuffer;
    try {
        inputBuffer = await fs.readFile(sourceAbs);
    } catch (e) {
        return res.status(404).json({ error: 'Source image file missing' });
    }

    let processed;
    try {
        processed = await applyImageFilter(inputBuffer, filter, {
            tintColor,
            nightvisionVariant: nightvisionVariant.id,
            augmentation
        });
    } catch (e) {
        console.error('Filter error:', e);
        return res.status(500).json({ error: 'Failed to apply image filter' });
    }

    const newId = nextId(db.data.projectImages);
    const ext = processed.info.format === 'jpeg' ? 'jpg' : (processed.info.format || 'jpg');
    const finalName = `img_${newId}_${Date.now()}_${filterSuffix(filter, tintColor, nightvisionVariant.id)}.${ext}`;
    await fs.mkdir(projectDir(projectId), { recursive: true });
    await fs.writeFile(path.join(projectDir(projectId), finalName), processed.data);

    const baseName = source.originalName.replace(/\.[^.]+$/, '');
    const tintHex = tintColorToHex(tintColor);
    const filterLabel = filter === 'none'
        ? 'copy'
        : (filter === 'tint'
            ? `tint_${tintHex.replace('#', '')}`
            : (filter === 'nightvision' ? `nv_${nightvisionVariant.id}` : filter));
    const image = {
        id: newId,
        projectId,
        filename: finalName,
        originalName: `${baseName}_${filterLabel}.${ext}`,
        path: `/dataset_files/${projectId}/${finalName}`,
        width: processed.info.width || source.width,
        height: processed.info.height || source.height,
        split,
        filter: filter === 'none' ? null : filter,
        tintColor: filter === 'tint' ? tintHex : null,
        nightvisionVariant: filter === 'nightvision' ? nightvisionVariant.id : null,
        augmentation: augmentation || null,
        copiedFrom: source.id,
        userId: req.user.id,
        userEmail: req.user.email,
        createdAt: new Date().toISOString()
    };

    db.data.projectImages.push(image);

    const createdAnnotations = [];
    if (copyAnnotations) {
        const sourceAnns = db.data.projectAnnotations.filter(
            (a) => a.projectId === projectId && a.imageId === imageId
        );
        let nextAnnId = nextId(db.data.projectAnnotations);
        for (const a of sourceAnns) {
            const copy = {
                id: nextAnnId++,
                projectId,
                imageId: newId,
                labelId: a.labelId,
                labelName: a.labelName,
                yolo: { ...a.yolo },
                userId: req.user.id,
                userEmail: req.user.email,
                createdAt: new Date().toISOString()
            };
            db.data.projectAnnotations.push(copy);
            createdAnnotations.push(copy);
        }
    }

    project.updatedAt = new Date().toISOString();
    await db.write();

    res.status(201).json({
        image,
        annotations: createdAnnotations,
        stats: projectStats(projectId)
    });
});

app.post('/api/projects/:id/annotations', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.id);
    const { imageId, labelId, yolo } = req.body;

    if (!imageId || !labelId || !yolo) {
        return res.status(400).json({ error: 'imageId, labelId and yolo are required' });
    }

    await db.read();
    const project = db.data.projects.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const image = db.data.projectImages.find((img) => img.id === imageId && img.projectId === projectId);
    if (!image) return res.status(404).json({ error: 'Image not found' });

    const label = db.data.projectLabels.find((l) => l.id === labelId && l.projectId === projectId);
    if (!label) return res.status(404).json({ error: 'Label not found' });

    const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
    const x_center = clamp(yolo.x_center);
    const y_center = clamp(yolo.y_center);
    const width = clamp(yolo.width);
    const height = clamp(yolo.height);

    if (width < 0.001 || height < 0.001) {
        return res.status(400).json({ error: 'Box is too small' });
    }

    const annotation = {
        id: nextId(db.data.projectAnnotations),
        projectId,
        imageId,
        labelId,
        labelName: label.name,
        yolo: { x_center, y_center, width, height },
        userId: req.user.id,
        userEmail: req.user.email,
        createdAt: new Date().toISOString()
    };

    db.data.projectAnnotations.push(annotation);
    project.updatedAt = new Date().toISOString();
    await db.write();

    res.status(201).json(annotation);
});

app.patch('/api/projects/:projectId/annotations/:annotationId', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.projectId);
    const annotationId = Number(req.params.annotationId);
    const { yolo } = req.body;

    if (!yolo) {
        return res.status(400).json({ error: 'yolo is required' });
    }

    await db.read();
    const annotation = db.data.projectAnnotations.find(
        (a) => a.id === annotationId && a.projectId === projectId
    );
    if (!annotation) return res.status(404).json({ error: 'Annotation not found' });

    const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
    const x_center = clamp(yolo.x_center);
    const y_center = clamp(yolo.y_center);
    const width = clamp(yolo.width);
    const height = clamp(yolo.height);

    if (width < 0.001 || height < 0.001) {
        return res.status(400).json({ error: 'Box is too small' });
    }

    // Keep box fully inside image bounds
    const halfW = width / 2;
    const halfH = height / 2;
    annotation.yolo = {
        x_center: Math.max(halfW, Math.min(1 - halfW, x_center)),
        y_center: Math.max(halfH, Math.min(1 - halfH, y_center)),
        width,
        height
    };

    const project = db.data.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = new Date().toISOString();
    await db.write();

    res.json(annotation);
});

app.delete('/api/projects/:projectId/annotations/:annotationId', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.projectId);
    const annotationId = Number(req.params.annotationId);
    await db.read();

    const index = db.data.projectAnnotations.findIndex(
        (a) => a.id === annotationId && a.projectId === projectId
    );
    if (index === -1) return res.status(404).json({ error: 'Annotation not found' });

    db.data.projectAnnotations.splice(index, 1);
    const project = db.data.projects.find((p) => p.id === projectId);
    if (project) project.updatedAt = new Date().toISOString();
    await db.write();

    res.json({ success: true });
});

app.get('/api/projects/:id/export/yolo', authenticateToken, async (req, res) => {
    const projectId = Number(req.params.id);
    await db.read();

    const project = db.data.projects.find((p) => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const labels = db.data.projectLabels.filter((l) => l.projectId === projectId);
    const images = db.data.projectImages.filter(
        (img) => img.projectId === projectId && ['train', 'valid', 'test'].includes(img.split)
    );
    const annotations = db.data.projectAnnotations.filter((a) => a.projectId === projectId);
    const unassignedCount = db.data.projectImages.filter(
        (img) => img.projectId === projectId && img.split === 'unassigned'
    ).length;

    const labelToClass = {};
    labels.forEach((label, index) => {
        labelToClass[label.id] = index;
    });

    const bySplit = { train: [], valid: [], test: [] };

    for (const image of images) {
        const imageAnns = annotations
            .filter((a) => a.imageId === image.id)
            .map((a) => {
                const classId = labelToClass[a.labelId];
                if (classId === undefined) return null;
                return {
                    classId,
                    labelName: a.labelName,
                    yoloLine: `${classId} ${a.yolo.x_center.toFixed(6)} ${a.yolo.y_center.toFixed(6)} ${a.yolo.width.toFixed(6)} ${a.yolo.height.toFixed(6)}`
                };
            })
            .filter(Boolean);

        bySplit[image.split].push({
            imageId: image.id,
            imagePath: image.path,
            filename: image.filename,
            originalName: image.originalName,
            width: image.width,
            height: image.height,
            split: image.split,
            annotationCount: imageAnns.length,
            yoloContent: imageAnns.map((a) => a.yoloLine).join('\n'),
            annotations: imageAnns
        });
    }

    res.json({
        project: { id: project.id, name: project.name, slug: project.slug },
        classes: labels.map((l, i) => ({ id: i, name: l.name })),
        classesFile: labels.map((l) => l.name).join('\n'),
        splits: bySplit,
        stats: {
            ...projectStats(projectId),
            exportImages: images.length,
            unassignedExcluded: unassignedCount
        }
    });
});

// --- DB API ---

app.get('/api/db', authenticateToken, async (req, res) => {
    await db.read();
    const safeData = {
        ...db.data,
        users: db.data.users.map(u => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt }))
    };
    res.json(safeData);
});

app.delete('/api/db/reset', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const files = await fs.readdir(TILES_DIR);
        for (const file of files) {
            await fs.unlink(path.join(TILES_DIR, file));
        }
    } catch (e) { /* ignore */ }

    try {
        await fs.rm(DATASETS_DIR, { recursive: true, force: true });
        await fs.mkdir(DATASETS_DIR, { recursive: true });
    } catch (e) { /* ignore */ }

    const users = db.data.users;
    db.data = {
        users,
        labels: [],
        boxes: [],
        projects: [],
        projectLabels: [],
        projectImages: [],
        projectAnnotations: [],
        tileSize: 256
    };
    await db.write();

    // 🔴 Emit real-time event
    emitToAll('db:reset', { resetBy: req.user.email });

    res.json({ success: true, message: 'Database reset' });
});

// --- HTML Page Routes (before static so /datasets is not shadowed by upload dir) ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/db', (req, res) => res.sendFile(path.join(__dirname, 'public', 'db.html')));
app.get('/export', (req, res) => res.sendFile(path.join(__dirname, 'public', 'export.html')));
app.get('/view', (req, res) => res.sendFile(path.join(__dirname, 'public', 'view.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use('/api/audio-projects', authenticateToken, audioDatasetsRouter({ db, directory: path.join(__dirname, 'audio_files') }));
app.get('/audio-dataset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audio-dataset.html')));
app.get('/audio-datasets', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audio-datasets.html')));
app.get('/datasets', (req, res) => res.sendFile(path.join(__dirname, 'public', 'datasets.html')));
app.get('/dataset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dataset.html')));

// --- Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start Server ---
const PORT = 3000;
httpServer.listen(PORT, () => {
    console.log(`🛰️  Aeronir running at http://localhost:${PORT}`);
    console.log(`🔌 WebSocket ready for real-time sync`);
    console.log(`📁 Tiles saved to ${TILES_DIR}`);
    console.log(`📦 Dataset files in ${DATASETS_DIR}`);
});
