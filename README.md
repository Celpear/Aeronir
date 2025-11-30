# 🛰️ Aeronir

**Map Tile Annotation Tool for YOLO Training**

Aeronir is a web-based tool for labeling satellite/aerial imagery tiles with bounding boxes. It exports annotations in YOLO format, ready for training object detection models like YOLOv5/v8.

![Aeronir Screenshot](https://img.shields.io/badge/status-active-success.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## ✨ Features

- 🗺️ **Interactive Map Labeling** - Draw bounding boxes directly on satellite imagery
- 🛰️ **Multiple Tile Sources** - Sentinel-2 Cloudless, OpenStreetMap, ESRI Satellite, or custom tile URLs
- 📦 **Automatic Tile Stitching** - Multi-tile boxes are automatically combined into single images
- 🎯 **YOLO Export** - Export in standard YOLO format with train/valid/test splits
- 🖼️ **Gallery View** - Preview all labeled images with annotations
- 🌙 **Dark Theme** - Modern dark UI with teal accents

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

## 📖 Usage

### 1. Create Labels
Add label names in the sidebar (e.g., "Building", "Road", "Field").

### 2. Draw Boxes
1. Select a label from the dropdown
2. Click the **Draw ON** button
3. Click and drag on the map to create bounding boxes

### 3. Export Dataset
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

## 🛠️ Tech Stack

- **Frontend**: Vanilla JS, Leaflet.js
- **Backend**: Node.js, Express
- **Database**: LowDB (JSON file)
- **Image Processing**: Sharp

## 📂 Project Structure

```
aeronir/
├── public/
│   ├── index.html      # Main labeling interface
│   ├── app.js          # Main application logic
│   ├── view.html       # Gallery view
│   ├── view.js
│   ├── export.html     # YOLO export page
│   ├── export.js
│   ├── db.html         # Database viewer
│   ├── db.js
│   ├── styles.css      # Styling
│   └── saved_tiles/    # Downloaded tile images
├── server.js           # Express server
├── db.json             # Database file
└── package.json
```

## 🔧 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/labels` | Get all labels |
| POST | `/api/labels` | Create a label |
| DELETE | `/api/labels/:id` | Delete a label |
| GET | `/api/boxes` | Get all boxes |
| POST | `/api/boxes` | Create a box |
| DELETE | `/api/boxes/:id` | Delete a box |
| GET | `/api/export/yolo` | Get YOLO export data |
| DELETE | `/api/db/reset` | Reset database |

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Made with ❤️ for the remote sensing community

