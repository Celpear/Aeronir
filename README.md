# Aeronir

**Collaborative Map Tile Annotation Tool for YOLO Training**

Aeronir is a web-based tool for labeling satellite/aerial imagery tiles with bounding boxes. It supports real-time collaboration between multiple users and exports annotations in YOLO format, ready for training object detection models like YOLOv5/v8.

![Aeronir Screenshot](https://raw.githubusercontent.com/Celpear/Aeronir/main/images/aeronir_screenshot.png)

![Status](https://img.shields.io/badge/status-active-success.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## ✨ Features

- 🗺️ **Interactive Map Labeling** - Draw bounding boxes directly on satellite imagery
- 👥 **Real-time Collaboration** - Multiple users can work simultaneously with live sync
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
git clone https://github.com/yourusername/aeronir.git
cd aeronir

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
2. Click the **Draw ON** button
3. Click and drag on the map to create bounding boxes

### 3. Collaborate
- See online users in the top bar
- Changes sync in real-time across all connected users
- See other users' cursor positions on the map

### 4. Export Dataset
Go to the **YOLO Export** page and download your dataset as a ZIP file.

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

## 📂 Project Structure

```
aeronir/
├── public/
│   ├── index.html      # Main labeling interface
│   ├── app.js          # Map & drawing logic
│   ├── auth.js         # Authentication utilities
│   ├── socket.js       # Real-time sync client
│   ├── view.html       # Gallery view
│   ├── export.html     # YOLO export page
│   ├── login.html      # Login page
│   ├── register.html   # Registration page
│   ├── setup.html      # Admin setup page
│   ├── admin.html      # User management
│   ├── db.html         # Database viewer
│   ├── styles.css      # Styling
│   ├── icons/          # App icons (PWA)
│   ├── manifest.json   # PWA manifest
│   └── saved_tiles/    # Downloaded tile images
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
| GET | `/api/export/yolo` | Get YOLO export data |
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
