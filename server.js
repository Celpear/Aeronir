import express from 'express';
import { JSONFilePreset } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ordner für gespeicherte Tiles
const TILES_DIR = path.join(__dirname, 'public', 'saved_tiles');

// Standard Tile-Server URL (kann per Request überschrieben werden)
const DEFAULT_TILE_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg';

// --- lowdb initialisieren mit Default-Daten ---
const defaultData = {
    labels: [],     // { id, name }
    boxes: [],      // { id, labelId, labelName, bounds, tiles[], image, yolo, createdAt }
    tileSize: 256   // Standard Tile-Größe
};

const db = await JSONFilePreset(path.join(__dirname, 'db.json'), defaultData);

// Stelle sicher, dass der Tiles-Ordner existiert
await fs.mkdir(TILES_DIR, { recursive: true });

const app = express();
app.use(express.json());

// Static Files aus /public
app.use(express.static(path.join(__dirname, 'public')));

// --- Hilfsfunktionen für Tile-Berechnungen ---

/**
 * Konvertiert Lat/Lng zu Tile-Koordinaten bei gegebenem Zoom-Level
 */
function latLngToTile(lat, lng, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor((lng + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
    return { x, y, z: zoom };
}

/**
 * Berechnet die globale Pixel-Position für Lat/Lng
 */
function latLngToGlobalPixel(lat, lng, zoom, tileSize = 256) {
    const n = Math.pow(2, zoom);
    const globalX = (lng + 180) / 360 * n * tileSize;
    const latRad = lat * Math.PI / 180;
    const globalY = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n * tileSize;
    return { globalX, globalY };
}

/**
 * Berechnet alle betroffenen Tiles für eine Bounding Box
 */
function getTilesForBounds(bounds, zoom) {
    const swTile = latLngToTile(bounds.south, bounds.west, zoom);
    const neTile = latLngToTile(bounds.north, bounds.east, zoom);
    
    const tiles = [];
    
    // Iteriere über alle Tiles in der Bounding Box
    // Beachte: Y-Achse ist invertiert (Nord = kleiner Y)
    const minX = Math.min(swTile.x, neTile.x);
    const maxX = Math.max(swTile.x, neTile.x);
    const minY = Math.min(swTile.y, neTile.y);
    const maxY = Math.max(swTile.y, neTile.y);
    
    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            tiles.push({ x, y, z: zoom });
        }
    }
    
    return {
        tiles,
        gridWidth: maxX - minX + 1,
        gridHeight: maxY - minY + 1,
        minX,
        minY,
        maxX,
        maxY
    };
}

/**
 * Lädt ein einzelnes Tile-Bild herunter
 */
async function downloadTile(z, x, y, tileUrlTemplate = DEFAULT_TILE_URL) {
    const url = tileUrlTemplate
        .replace('{z}', z)
        .replace('{x}', x)
        .replace('{y}', y)
        .replace('{s}', ['a', 'b', 'c'][Math.floor(Math.random() * 3)]);
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (err) {
        console.error(`Fehler beim Laden von Tile ${z}/${x}/${y}:`, err.message);
        // Erzeuge ein graues Platzhalter-Tile
        return await sharp({
            create: {
                width: 256,
                height: 256,
                channels: 3,
                background: { r: 50, g: 50, b: 60 }
            }
        }).jpeg().toBuffer();
    }
}

/**
 * Erstellt ein zusammengesetztes Bild aus mehreren Tiles
 */
async function createCompositeImage(tileGrid, tileSize = 256, tileUrl = DEFAULT_TILE_URL) {
    const { tiles, gridWidth, gridHeight, minX, minY } = tileGrid;
    
    const compositeWidth = gridWidth * tileSize;
    const compositeHeight = gridHeight * tileSize;
    
    // Lade alle Tiles parallel
    const tileBuffers = await Promise.all(
        tiles.map(async (tile) => {
            const buffer = await downloadTile(tile.z, tile.x, tile.y, tileUrl);
            return {
                ...tile,
                buffer
            };
        })
    );
    
    // Erstelle Composite-Anweisungen für sharp
    const compositeInputs = tileBuffers.map(tile => ({
        input: tile.buffer,
        left: (tile.x - minX) * tileSize,
        top: (tile.y - minY) * tileSize
    }));
    
    // Erstelle das zusammengesetzte Bild
    const compositeImage = await sharp({
        create: {
            width: compositeWidth,
            height: compositeHeight,
            channels: 3,
            background: { r: 0, g: 0, b: 0 }
        }
    })
    .composite(compositeInputs)
    .jpeg({ quality: 90 })
    .toBuffer();
    
    return {
        buffer: compositeImage,
        width: compositeWidth,
        height: compositeHeight
    };
}

/**
 * Berechnet YOLO-Koordinaten für eine Box im zusammengesetzten Bild
 */
function calculateYoloForComposite(bounds, tileGrid, zoom, tileSize = 256) {
    const { minX, minY, gridWidth, gridHeight } = tileGrid;
    
    const compositeWidth = gridWidth * tileSize;
    const compositeHeight = gridHeight * tileSize;
    
    // Berechne globale Pixel-Positionen
    const swPixel = latLngToGlobalPixel(bounds.south, bounds.west, zoom, tileSize);
    const nePixel = latLngToGlobalPixel(bounds.north, bounds.east, zoom, tileSize);
    
    // Offset zum Composite-Bild (links oben ist minX, minY Tile)
    const offsetX = minX * tileSize;
    const offsetY = minY * tileSize;
    
    // Box-Koordinaten im Composite
    const x1 = swPixel.globalX - offsetX;
    const x2 = nePixel.globalX - offsetX;
    const y1 = nePixel.globalY - offsetY; // Nord = oben = kleinere Y
    const y2 = swPixel.globalY - offsetY; // Süd = unten = größere Y
    
    // YOLO-Format: x_center, y_center, width, height (normalisiert 0-1)
    const boxWidth = Math.abs(x2 - x1);
    const boxHeight = Math.abs(y2 - y1);
    const xCenter = (x1 + x2) / 2 / compositeWidth;
    const yCenter = (y1 + y2) / 2 / compositeHeight;
    
    return {
        x_center: Math.max(0, Math.min(1, xCenter)),
        y_center: Math.max(0, Math.min(1, yCenter)),
        width: Math.max(0, Math.min(1, boxWidth / compositeWidth)),
        height: Math.max(0, Math.min(1, boxHeight / compositeHeight)),
        // Pixel-Koordinaten für Visualisierung
        pixel: {
            x1: Math.round(x1),
            y1: Math.round(y1),
            x2: Math.round(x2),
            y2: Math.round(y2)
        }
    };
}

// --- API: Labels ---

app.get('/api/labels', async (req, res) => {
    await db.read();
    res.json(db.data.labels);
});

app.post('/api/labels', async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name ist erforderlich' });
    }

    await db.read();
    const labels = db.data.labels;

    // Falls Name schon existiert -> direkt zurückgeben
    const existing = labels.find((l) => l.name === name.trim());
    if (existing) return res.json(existing);

    const newLabel = {
        id: labels.length ? Math.max(...labels.map((l) => l.id)) + 1 : 1,
        name: name.trim()
    };
    labels.push(newLabel);
    await db.write();
    res.status(201).json(newLabel);
});

app.delete('/api/labels/:id', async (req, res) => {
    const id = Number(req.params.id);
    await db.read();
    
    const index = db.data.labels.findIndex(l => l.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Label nicht gefunden' });
    }
    
    // Lösche auch alle zugehörigen Bilder
    const boxesToDelete = db.data.boxes.filter(b => b.labelId === id);
    for (const box of boxesToDelete) {
        if (box.image) {
            const imagePath = path.join(__dirname, 'public', box.image);
            try {
                await fs.unlink(imagePath);
            } catch (e) { /* ignore */ }
        }
    }
    
    db.data.labels.splice(index, 1);
    db.data.boxes = db.data.boxes.filter(b => b.labelId !== id);
    await db.write();
    
    res.json({ success: true });
});

// --- API: Boxen ---

app.get('/api/boxes', async (req, res) => {
    await db.read();
    res.json(db.data.boxes);
});

app.post('/api/boxes', async (req, res) => {
    const { labelId, labelName, bounds, zoom, tileUrl } = req.body;

    if (!labelId || !labelName || !bounds) {
        return res.status(400).json({ error: 'labelId, labelName und bounds sind erforderlich' });
    }

    await db.read();

    const zoomLevel = zoom || 14;
    const tileSize = 256;
    const useTileUrl = tileUrl || DEFAULT_TILE_URL;
    
    // Berechne betroffene Tiles
    const tileGrid = getTilesForBounds(bounds, zoomLevel);
    const { tiles, gridWidth, gridHeight } = tileGrid;
    
    const boxId = db.data.boxes.length ? Math.max(...db.data.boxes.map((b) => b.id)) + 1 : 1;
    
    // Erstelle zusammengesetztes Bild
    console.log(`Box ${boxId}: ${tiles.length} Tile(s) (${gridWidth}x${gridHeight})`);
    
    let imageInfo;
    try {
        const composite = await createCompositeImage(tileGrid, tileSize, useTileUrl);
        
        // Speichere das Bild
        const imageName = `box_${boxId}_${Date.now()}.jpg`;
        const imagePath = path.join(TILES_DIR, imageName);
        await fs.writeFile(imagePath, composite.buffer);
        
        imageInfo = {
            path: `/saved_tiles/${imageName}`,
            width: composite.width,
            height: composite.height,
            tileCount: tiles.length,
            gridSize: `${gridWidth}x${gridHeight}`
        };
    } catch (err) {
        console.error('Fehler beim Erstellen des Composite-Bildes:', err);
        imageInfo = null;
    }
    
    // Berechne YOLO-Koordinaten für das zusammengesetzte Bild
    const yoloCoords = calculateYoloForComposite(bounds, tileGrid, zoomLevel, tileSize);

    const newBox = {
        id: boxId,
        labelId,
        labelName,
        bounds,
        zoom: zoomLevel,
        tileUrl: useTileUrl,
        tiles: tiles.map(t => ({ x: t.x, y: t.y, z: t.z })),
        tileGrid: {
            width: gridWidth,
            height: gridHeight,
            minX: tileGrid.minX,
            minY: tileGrid.minY
        },
        image: imageInfo ? imageInfo.path : null,
        imageSize: imageInfo ? { width: imageInfo.width, height: imageInfo.height } : null,
        yolo: yoloCoords,
        createdAt: new Date().toISOString()
    };
    
    db.data.boxes.push(newBox);
    await db.write();
    res.status(201).json(newBox);
});

app.delete('/api/boxes/:id', async (req, res) => {
    const id = Number(req.params.id);
    await db.read();
    
    const index = db.data.boxes.findIndex(b => b.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Box nicht gefunden' });
    }
    
    // Lösche das zugehörige Bild
    const box = db.data.boxes[index];
    if (box.image) {
        const imagePath = path.join(__dirname, 'public', box.image);
        try {
            await fs.unlink(imagePath);
        } catch (e) { /* ignore */ }
    }
    
    db.data.boxes.splice(index, 1);
    await db.write();
    
    res.json({ success: true });
});

// --- API: YOLO Export ---

app.get('/api/export/yolo', async (req, res) => {
    await db.read();
    
    const { boxes, labels } = db.data;
    
    // Erstelle Label-Index-Map (YOLO nutzt numerische Klassen-IDs)
    const labelToClass = {};
    labels.forEach((label, index) => {
        labelToClass[label.id] = index;
    });
    
    // Gruppiere Annotationen nach gespeichertem Bild
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
    
    // Generiere classes.txt Inhalt
    const classesContent = labels.map(l => l.name).join('\n');
    
    res.json({
        classes: labels.map((l, i) => ({ id: i, name: l.name })),
        classesFile: classesContent,
        images: imageAnnotations,
        totalBoxes: boxes.length,
        totalImages: imageAnnotations.length
    });
});

// --- API: komplette DB-Ansicht (für /db.html) ---

app.get('/api/db', async (req, res) => {
    await db.read();
    res.json(db.data);
});

// --- API: DB zurücksetzen ---

app.delete('/api/db/reset', async (req, res) => {
    // Lösche alle gespeicherten Bilder
    try {
        const files = await fs.readdir(TILES_DIR);
        for (const file of files) {
            await fs.unlink(path.join(TILES_DIR, file));
        }
    } catch (e) { /* ignore */ }
    
    db.data = {
        labels: [],
        boxes: [],
        tileSize: 256
    };
    await db.write();
    res.json({ success: true, message: 'Datenbank zurückgesetzt' });
});

// --- Routen für HTML-Seiten ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/db', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'db.html'));
});

app.get('/export', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'export.html'));
});

app.get('/view', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🛰️  Aeronir running at http://localhost:${PORT}`);
    console.log(`📁 Tiles saved to ${TILES_DIR}`);
});
