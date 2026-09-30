# Aeronir

**Collaborative Map Tile Annotation Tool for YOLO Training**

Aeronir is a web-based tool for labeling satellite/aerial imagery tiles with bounding boxes. It supports real-time collaboration between multiple users and exports annotations in YOLO format, ready for training object detection models like YOLOv5/v8.

![Aeronir Screenshot](https://raw.githubusercontent.com/Celpear/Aeronir/main/images/aeronir_screenshot.png)

![Status](https://img.shields.io/badge/status-active-success.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## ✨ Features

- 🗺️ **Interactive Map Labeling** - Draw bounding boxes directly on satellite imagery
- 📁 **Custom Dataset Projects** - Upload your own images, label per project, assign train/valid/test, export YOLO ZIP
- 📱 **Mobile Touch Support** - Full touch support for drawing boxes on smartphones/tablets
- 👥 **Real-time Collaboration** - Multiple users can work simultaneously with live sync
- 🔄 **Auto-Reconnect** - Automatic WebSocket reconnection on connection loss
- 🔐 **User Authentication** - Secure login, registration, and admin user management
- 🛰️ **Multiple Tile Sources** - Sentinel-2 Cloudless, OpenStreetMap, ESRI Satellite, or custom URLs
- 📦 **Automatic Tile Stitching** - Multi-tile boxes are automatically combined into single images
- 🎯 **YOLO Export** - Export in standard YOLO format with train/valid/test splits
- 🖼️ **Gallery View** - Preview all labeled images with annotations
- 📱 **Responsive Design** - Works on desktop, tablet, and mobile
- 🌙 **Dark Theme** - Modern dark UI with teal accents
- 📲 **PWA Support** - Install as an app on mobile devices

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/Celpear/Aeronir.git
cd Aeronir

# Install dependencies
npm install

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### First-time Setup

1. On first launch, you'll be prompted to create an **Admin account**
2. The admin can manage users at `/admin`
3. Additional users can register at `/register`

## 📖 Usage

### 1. Create Labels
Add label names in the sidebar (e.g., "Building", "Road", "Field").

### 2. Draw Boxes
1. Select a label from the dropdown
2. Click the **Draw ON** button (located on the map overlay)
3. Click and drag on the map to create bounding boxes

**On Mobile/Touch devices:**
- Tap **Draw ON** to enable drawing mode
- Touch and drag to draw boxes
- A teal border indicates active drawing mode
- Release to save the box

### 3. Collaborate
- See online users in the top bar
- Changes sync in real-time across all connected users
- See other users' cursor positions on the map

### 4. Export Dataset
Go to the **YOLO Export** page and download your dataset as a ZIP file.

### 5. Custom Image Datasets
1. Open **Datasets** and create a named project
2. Upload your own images (optionally directly into train/valid/test)
3. Create classes and draw multiple boxes per image
4. Use **Auto-split** for unassigned images (80/15/5) or set splits manually
5. Download a YOLO ZIP scoped to that project

## 📁 Export Structure

```
dataset/
├── train/
│   ├── images/     # 80% of images
│   └── labels/     # YOLO annotations (.txt)
├── valid/
│   ├── images/     # 15% of images
│   └── labels/
├── test/
│   ├── images/     # 5% of images
│   └── labels/
├── data.yaml       # YOLO configuration
└── classes.txt     # Class names
```

### YOLO Annotation Format

Each `.txt` file contains annotations in YOLO format:
```
class_id x_center y_center width height
```
All coordinates are normalized (0-1) relative to image dimensions.

## 🎯 Training with YOLOv8

```bash
# Install ultralytics
pip install ultralytics

# Start training
yolo detect train data=data.yaml model=yolov8n.pt epochs=100 imgsz=640

# Run inference
yolo detect predict model=runs/detect/train/weights/best.pt source=path/to/images
```

## 🗺️ Supported Tile Sources

| Source | Description | Max Zoom |
|--------|-------------|----------|
| Sentinel-2 Cloudless | EOX satellite imagery | 14 |
| OpenStreetMap | Street maps | 19 |
| ESRI Satellite | Esri World Imagery | 18 |
| Custom URL | Any XYZ tile server | - |

### Custom Tile URL Format

```
https://your-server.com/tiles/{z}/{x}/{y}.png
```

Supported variables: `{z}`, `{x}`, `{y}`, `{s}` (subdomain)

## 🔐 Authentication

Aeronir includes a complete authentication system:

- **Admin Setup** - First user becomes admin automatically
- **User Registration** - New users can self-register
- **User Management** - Admins can promote/demote users and delete accounts
- **Secure Passwords** - Passwords are hashed with bcrypt
- **JWT Sessions** - Secure token-based authentication (7-day expiry)

### User Roles

| Role | Permissions |
|------|-------------|
| Admin | Full access, user management, database reset |
| User | Create/delete labels and boxes, export data |

## 🛠️ Tech Stack

- **Frontend**: Vanilla JS, Leaflet.js, Socket.io Client
- **Backend**: Node.js, Express, Socket.io
- **Database**: LowDB (JSON file)
- **Image Processing**: Sharp
- **Authentication**: JWT, bcrypt

## 🎨 UI Components

### Map Overlay Controls
The drawing controls are positioned directly on the map for easy access:
- **Draw ON/OFF** button - Toggle drawing mode
- **Active Label Badge** - Shows currently selected label with color indicator

### Label Management
Labels are displayed as compact, color-coded chips that wrap horizontally. This keeps the sidebar compact even with many labels.

## 📂 Project Structure

```
aeronir/
├── public/
│   ├── index.html      # Main labeling interface
│   ├── app.js          # Map & drawing logic (mouse + touch)
│   ├── auth.js         # Authentication utilities
│   ├── socket.js       # Real-time sync + auto-reconnect
│   ├── view.html       # Gallery view
│   ├── export.html     # YOLO export page (map annotations)
│   ├── datasets.html   # Custom dataset project hub
│   ├── dataset.html    # Custom image labeling workspace
│   ├── login.html      # Login page
│   ├── register.html   # Registration page
│   ├── setup.html      # Admin setup page
│   ├── admin.html      # User management
│   ├── db.html         # Database viewer (admin reset)
│   ├── styles.css      # Styling (responsive)
│   ├── icons/          # App icons (PWA)
│   ├── manifest.json   # PWA manifest
│   ├── saved_tiles/    # Downloaded tile images
│   └── dataset_files/  # Custom project images
├── server.js           # Express + Socket.io server
├── db.json             # Database file (gitignored)
└── package.json
```

## 🔧 API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/setup` | Create first admin |
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user |

### Labels & Boxes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/labels` | Get all labels |
| POST | `/api/labels` | Create a label |
| DELETE | `/api/labels/:id` | Delete a label |
| GET | `/api/boxes` | Get all boxes |
| POST | `/api/boxes` | Create a box |
| DELETE | `/api/boxes/:id` | Delete a box |

### Export & Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/export/yolo` | Get YOLO export data (map annotations) |
| GET | `/api/projects` | List custom dataset projects |
| POST | `/api/projects` | Create named project |
| GET | `/api/projects/:id` | Project with images, labels, annotations |
| DELETE | `/api/projects/:id` | Delete project and files |
| POST | `/api/projects/:id/images` | Upload images (multipart, optional split) |
| POST | `/api/projects/:id/auto-split` | Assign unassigned → train/valid/test |
| POST | `/api/projects/:id/annotations` | Add bounding box |
| GET | `/api/projects/:id/export/yolo` | YOLO export data for a project |
| GET | `/api/admin/users` | Get all users (admin) |
| PUT | `/api/admin/users/:id/role` | Update user role (admin) |
| DELETE | `/api/admin/users/:id` | Delete user (admin) |
| DELETE | `/api/db/reset` | Reset database (admin) |

## 🔌 WebSocket Events

Real-time events for collaboration:

| Event | Direction | Description |
|-------|-----------|-------------|
| `users:online` | Server → Client | List of online users |
| `label:created` | Server → Client | New label created |
| `label:deleted` | Server → Client | Label deleted |
| `box:created` | Server → Client | New box created |
| `box:deleted` | Server → Client | Box deleted |
| `cursor:move` | Client → Server | Cursor position update |
| `cursor:update` | Server → Client | Other user's cursor |
| `db:reset` | Server → Client | Database was reset |

### Auto-Reconnect

The WebSocket client includes automatic reconnection:
- Up to **10 reconnection attempts**
- **3 second delay** between attempts (max 10s)
- Visual toast notifications for connection status
- Manual reconnect available via `forceReconnect()`

## 🌐 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `JWT_SECRET` | (auto-generated) | JWT signing secret |

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Made with ❤️ for the remote sensing community

### Training augmentation for custom datasets

Choose “Training augmentation” in a training image's copy dialog. Combine exposure,
contrast, gamma, sensor noise, blur, JPEG quality and detail resolution. Presets:
Low Light, Defocused camera and Poor image quality. Blur is measured in source-image
pixels (0–30); the defocused preset uses 8 pixels. Use “Show original for comparison”
to compare the preview before creating a copy. This switch only affects the preview.

Image dimensions stay unchanged, so bounding boxes can be copied unchanged.
Preview and saved images use the same server processing and fixed noise seed;
the preview is then resized. Settings are stored with each copy. Both source and
copy must be in the train split when creating an augmentation. Keep related images
in the same split afterwards; split management does not enforce permanent grouping.
These presets simulate image degradation, not physically accurate night vision or
thermal imaging. Existing copies keep their original settings and are not regenerated.

Run processing tests: `node --test test/augmentation.test.js`


### Audio datasets

Open **Custom → Audio Datasets**. The overview uses the same project cards as image
datasets, with descriptions, track/class/segment counts and train/valid/test totals.
Create a project and open its card to enter the audio editor.

- Upload WAV or MP3 files (100 MB and one hour maximum per track). Multiple selected
  files upload sequentially; invalid files are reported individually.
- Play tracks, zoom and drag across the waveform, or enter exact start/end seconds.
- Add classes, save overlapping labeled segments, edit boundaries, delete labels
  from a track, and play only the selected segment.
- Assign the whole track to a train/valid/test split. **Export dataset (ZIP)** includes
  labeled clips, unchanged originals, and JSON annotations linking clips to source times.
  Clips are mono 48 kHz PCM 16-bit WAV; their split always matches the source track.
  Saved class names appear inside waveform regions when enough space is visible.
- Each saved segment and the selection preview use a full-width analysis diagram.
  Switch independently between FFT, STFT (default), Mel, Log-Mel, MFCC, CQT,
  and Welch PSD. All previews analyze channel 1 within the selected interval.
  - FFT: mean power from up to 256 distributed 4096-point Hann windows, relative dB.
  - STFT: 1024-point periodic Hann windows, 192 distributed frames, 64 linear
    frequency rows, −80…0 dB relative to the selection peak.
  - Mel: 64 HTK triangular filters, linear power normalized to the selection peak.
  - Log-Mel: the same Mel power converted to relative dB (−80…0 dB).
  - MFCC: 13 signed coefficients (C0–C12) from an orthonormal DCT-II of 64
    log-Mel powers (reference 1, floor 1e-10). A blue/orange diverging palette
    shows negative/positive values. C0 and C1–C12 use separate symmetric color
    scales, stated in the caption; values are unchanged and C0 retains energy.
  - CQT: direct variable-length Hann kernels, 12 bins/octave from C2 (65.4 Hz)
    to below Nyquist, 128 distributed time frames, relative dB.
  - Welch PSD: one-sided power density with constant detrending, up to 4096
    samples/window, periodic Hann and 50% overlap. The unit is dB relative to
    1 digital-amplitude²/Hz, not calibrated sound pressure. For long selections,
    at most 512 regular windows are sampled uniformly; the caption reports this.
  Previews use bounded computation and are not exported training features. The
  worker calculates visible previews and caches them for the current track.

Definitions: [Welch density](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.welch.html),
[MFCC](https://librosa.org/doc/0.11.0/generated/librosa.feature.mfcc.html),
[CQT](https://librosa.org/doc/0.11.0/generated/librosa.cqt.html).
The browser implementations use the explicit parameters above; they do not claim
bit-for-bit compatibility with default library settings.

Audio originals live in `audio_files/` (gitignored), metadata and labels in `db.json`.
The browser must support decoding the uploaded WAV codec or MP3 for waveform and
spectrogram previews. Existing audio projects remain available in the card overview.

Tests: `node --test test/*.test.js` (audio API tests start a temporary local server).
The MP3 test fixture is a generated two-second 440 Hz tone.

#### Audio labeling workflow

- Classes appear above the track list. Selecting a range shows its STFT/Mel preview
  immediately, including before saving. **Play selection** plays only that range;
  each saved segment also has a **Play** button that stops at its end.
- **Delete track** removes the audio file and all its labeled segments after confirmation.
- Use **Prev / Next** (or Left / Right arrows outside form controls) to step through
  tracks within the active filter. **Save & next track** saves the current segment
  before opening the next track. **Save segment** supports multiple labels per track.
- Filter tracks by All, Unassigned, Train, Validation, Test or Unlabeled. Track and
  filter selection are remembered locally for the next visit.
- Choose a split before uploading or change **Track split** later. Split badges and
  totals update immediately. All segments inherit their track's split in the export.
- **Auto-split unassigned 80/15/5** shuffles only unassigned tracks and assigns whole
  tracks to train/valid/test. Existing assignments stay unchanged. Counts are rounded
  to whole tracks, so small datasets may not contain every split.

#### Audio ZIP export

The server needs `ffmpeg` and `zip` on PATH (`unzip` is also required by export tests).
No browser audio conversion is used for exports. ZIPs are assembled in a temporary
folder and removed after download or failure.

```text
annotations.json
README.md
manifests/
  train.json
  validation.json
  test.json
  unassigned.json
segments/
  train/<class-name>__<class-id>/<track-id>__<segment-id>.wav
  validation/...
  test/...
  unassigned/...
originals/
  train/<track-id>.wav or .mp3
  validation/...
  test/...
  unassigned/...
```

Use training clips for fitting, validation clips for tuning, and test clips for
held-out evaluation. For temporal verification, run the model on `originals/test`
and compare detections with `tracks[].segments` in `annotations.json`.
Each clip includes its original path, track ID, class, and source start/end times.
All paths are relative to the ZIP root. Original filenames are retained in JSON;
IDs in paths prevent collisions. Unassigned data stays outside the training splits.
Overlapping labels are included in clip-local annotations for multilabel training;
class folders indicate the primary label. Unlabeled time is not a confirmed negative.
The legacy metadata-only JSON is available at `/api/audio-projects/:id/export/annotations`.

### In-app YOLO training and webcam preview

Open **Satellite → Training**, **Custom → Training**, or **Train YOLO model** inside
an image dataset. This trains object detectors on satellite/custom image datasets.
Audio annotations use a different task and are not included in this training view.

Install a Python 3.11 environment once on the Aeronir server:

```sh
python3.11 -m venv .venv-yolo
.venv-yolo/bin/python -m pip install -r training/requirements.txt
```

Aeronir uses `.venv-yolo/bin/python` by default. Set `YOLO_PYTHON` to an absolute
Python executable path to use another environment (including Windows). The UI
checks Ultralytics and available CPU/MPS/CUDA devices before enabling training.
Model weights download on first use; the initial run therefore requires internet.
The installed Ultralytics version is pinned in `training/requirements.txt`.

- Choose YOLO12n/s/m, YOLO11n/s, or YOLOv8n/s, epochs, image size, batch size,
  device, early stopping patience, and seed. Auto prefers CUDA, then MPS, then CPU.
  Image size must be divisible by 32. Batch size 4 is a conservative starting point.
- Custom datasets keep their assigned train/valid/test splits. Unassigned images
  are excluded. Train and validation must each contain labeled objects. Copies
  of an original image must share a split, preventing obvious data leakage.
- Satellite crops sharing map tiles are grouped before a deterministic ~80/15/5
  split. At least two independent areas are needed; very small datasets have no
  test split. Nearby areas can still be visually correlated: collect geographically
  distinct validation/test examples for meaningful quality measurements.
- Each run snapshots images and annotations to `training_runs/<id>/dataset`.
  PNG conversion preserves image geometry. Existing labels are never rewritten.
- One run trains at a time. Live logs and per-epoch loss/precision/recall/mAP metrics
  are polled every two seconds. Training continues when the page is closed.
  **Stop training** cancels the process. Server restarts mark unfinished runs as
  interrupted; completed runs and their settings remain available.
- A completed run exposes `best.pt`, training plots and a metrics CSV. `best.pt`
  is selected using validation performance; the test split is reserved for later
  independent evaluation and is not used for fitting or model selection.
- **Start webcam** requests the browser camera and sends one JPEG at a time to
  the same authenticated Aeronir server. Frames are processed in memory and are
  not saved. Boxes and confidence scores are overlaid on the corresponding frame.
  The current implementation uses CPU inference; throughput depends on the model
  and hardware. Stop webcam releases the camera. Browser camera access requires
  localhost or HTTPS. Remote HTTP hosting cannot request a camera.

Runtime files and weights are gitignored. Python training/inference workers are
launched with fixed argument lists, and model choices and settings are validated.
For Ultralytics usage and license terms, see the
[Ultralytics training documentation](https://docs.ultralytics.com/modes/train/)
and [license information](https://www.ultralytics.com/license).

Tests: `node --test test/*.test.js`. For an explicit real training smoke test:
`node training/smoke.mjs`. This downloads YOLO12n weights, trains one epoch on four
synthetic images, checks live metrics and best.pt, runs checkpoint inference, and
removes its temporary dataset and outputs. It verifies integration, not accuracy.
