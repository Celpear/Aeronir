import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs/promises';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import { JSONFilePreset } from 'lowdb/node';
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

// Default Tile-Server URL
const DEFAULT_TILE_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg';

// --- Initialize lowdb ---
const defaultData = {
    users: [],
    labels: [],
    boxes: [],
    tileSize: 256
};

const db = await JSONFilePreset(path.join(__dirname, 'db.json'), defaultData);

await db.read();
if (!db.data.users) {
    db.data.users = [];
    await db.write();
}

await fs.mkdir(TILES_DIR, { recursive: true });

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

// --- YOLO Export API ---

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

    const users = db.data.users;
    db.data = {
        users,
        labels: [],
        boxes: [],
        tileSize: 256
    };
    await db.write();

    // 🔴 Emit real-time event
    emitToAll('db:reset', { resetBy: req.user.email });

    res.json({ success: true, message: 'Database reset' });
});

// --- Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- HTML Page Routes ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/db', (req, res) => res.sendFile(path.join(__dirname, 'public', 'db.html')));
app.get('/export', (req, res) => res.sendFile(path.join(__dirname, 'public', 'export.html')));
app.get('/view', (req, res) => res.sendFile(path.join(__dirname, 'public', 'view.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- Start Server ---
const PORT = 3000;
httpServer.listen(PORT, () => {
    console.log(`🛰️  Aeronir running at http://localhost:${PORT}`);
    console.log(`🔌 WebSocket ready for real-time sync`);
    console.log(`📁 Tiles saved to ${TILES_DIR}`);
});
