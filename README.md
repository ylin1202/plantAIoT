# PlantAIoT -- Multi-Modal AIoT Plant Platform

This project is a full-stack, Edge-to-Cloud AIoT plant monitoring platform. The system supports ESP32 edge hardware sensing and control (firmware provided; end-to-end validated via the headless simulation suite below), and ships with a complete headless simulation suite for testing without physical hardware. The architecture integrates EMQX MQTT for high-frequency telemetry transport, TimescaleDB as the time-series database, BullMQ for traffic-leveling queues, a dual-engine AI microservice (YOLOv8-cls / ONNX Runtime for visual pathology classification and XGBoost for physiological health regression), MinIO S3 object storage, a React real-time streaming dashboard, and a Telegram bot.

## Highlights

* Edge-to-Cloud AIoT Architecture
* Dual AI Engine (YOLOv8 + XGBoost)
* Real-time MQTT Streaming
* TimescaleDB Time-series Analytics
* Redis BullMQ Asynchronous Pipeline
* Tiered Closed-loop Irrigation (sensor rules + AI-vision advisory)
* Dockerized Microservices

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | React · Vite · Recharts | Real-time monitoring dashboard |
| **Backend** | Node.js · Express · Socket.IO | REST API, MQTT bridge, WebSocket server |
| **AI Service** | FastAPI · YOLOv8 · ONNX Runtime · XGBoost | Plant disease classification & health scoring |
| **Database** | TimescaleDB · Redis | Time-series storage, cache, BullMQ queue |
| **Object Storage** | MinIO | S3-compatible image storage |
| **Messaging** | MQTT · EMQX | Device telemetry and remote control |
| **Deployment** | Docker Compose | Multi-container orchestration |

## System Architecture

```
                                          +------------------------------+
                                         |      ESP32 Edge Hardware Node |
                                         |------------------------------|
                                         | • Soil Moisture / Water Level ADC |
                                         | • DHT11                      |
                                         | • NeoPixel                   |
                                         | • OLED                       |
                                         +---------------+--------------+
                                                         |
                                               MQTT (1883)
                                                         |
                                                         v
                                         +------------------------------+
                                         |         EMQX Broker          |
                                         |        MQTT Message Hub      |
                                         +------+-----------------+------+
                                                |                 |
                                     MQTT Telemetry|              | MQTT Control
                                                |                 |
                          +---------------------+                 +--------+
                          |                                                |
                          v                                                v
             +---------------------------+                  +----------------------------+
             | ESP32-CAM / Simulated Image Source |          | Node.js Backend            |
             | Snapshot Capture          |                  | Express + Socket.IO        |
             +------------+--------------+                  +-------------+--------------+
                          |                                               |
                     Upload Image                                        |
                          |                                               |
                          v                                               v
             +---------------------------+                  +----------------------------+
             | MinIO Object Storage      |                  | Redis + BullMQ             |
             | S3 Image Bucket           |                  | Telemetry Queue / Cache    |
             +------------+--------------+                  +-------------+--------------+
                          |                                               |
                     Enqueue task                                         |
                    (plain Redis list,                                    |
                     bull:aiVisionQueue:wait)                             |
                          v                                               v
             +---------------------------+                  +----------------------------+
             | FastAPI AI Microservice   |                  | TimescaleDB                |
             |---------------------------|                  | sensor_telemetry           |
             | • REST Prediction API     |                  | (30-day retention)         |
             | • Background Queue Worker |                  +-------------+--------------+
             | • YOLOv8-cls (ONNX)       |                                |
             | • XGBoost Health Scoring  |                                v
             | • Decision Engine         |                  +----------------------------+
             +------------+--------------+                  | React Dashboard             |
                          |                                 | (Socket.IO telemetry_update) |
                          v                                 +----------------------------+
             +---------------------------+
             | TimescaleDB                |
             | ai_image_analyses          |
             | (90-day retention)         |
             +------------+--------------+
                          |
                          v
             +---------------------------+      +----------------------+
             | React Dashboard (Redis    |      | Telegram Bot         |
             | Pub/Sub → ai_diagnosis_   |      | Diagnosis alerts &   |
             | result)                   |      | remote control       |
             +---------------------------+      +----------------------+
```

## Data Flow

Telemetry and images travel two **independent** paths that converge only at TimescaleDB — images are not routed through the telemetry queue or vice versa.

```
Telemetry path
──────────────
ESP32
  │ MQTT
  ▼
Node.js
  │ enqueue
  ▼
BullMQ (concurrency 5, load leveling)
  │
  ▼
TimescaleDB (sensor_telemetry)
  │
  ▼
Socket.IO → React Dashboard


Image path
──────────
ESP32-CAM / simulateCamera.js
  │ upload
  ▼
MinIO
  │ enqueue task
  ▼
Redis list (bull:aiVisionQueue:wait)
  │
  ▼
FastAPI worker (YOLOv8-cls + XGBoost)
  │
  ▼
TimescaleDB (ai_image_analyses)
  │
  ▼
Redis Pub/Sub (ai_diagnosis_channel)
  │
  ├──▶ React Dashboard
  └──▶ Telegram Bot
```

## Docker Compose Architecture

```
Docker Compose
│
├── frontend
├── backend
├── ai-api
├── ai-worker
├── redis
├── emqx
├── minio
└── timescaledb
```

## Dual AI Model Training & Benchmark Metrics

This project uses two collaborative inference models — a visual pathology diagnosis model and an environmental physiology regression model, evaluated on Google Colab GPU (Tesla T4):

### Visual Pathology AI (YOLOv8-cls Lightweight Classification Model)

**Dataset source & preprocessing**: Based on the PlantVillage dataset (originally 39 classes, 55,448 images), classes suitable for potted-plant appearance observation were filtered and consolidated into 4 general health indicators (Healthy, Yellowing_or_Drying, Diseased_or_Blight, Background). The three pathology classes were balance-sampled to 2,500 images each, combined with 1,143 environmental background negative samples (8,643 images total, split 8:2 into a 6,914-image training set and a 1,729-image validation set).

**Model architecture & hyperparameters**: Based on yolov8n-cls, with a defined input resolution, batch size 64, and the AdamW optimizer, plus rotation, flip, and HSV wide-gamut augmentation. Fine-tuned on the dataset above.

**ONNX optimization**: After training, the model was exported as a static-graph ONNX model (`best.onnx`), achieving a single-inference latency of only ~1.7 ms on CPU.

**Validation set performance**:
* Top-1 Accuracy: 93.2%
* Macro F1-Score: 91.8%


### Physiological Data AI (XGBoost Regression Health Scoring Model)

Built a multivariate health-scoring regression model based on plant physiology domain knowledge and sensor environmental data.

**Physiological prior modeling & label generation**

* **Theoretical basis**: Referenced plant physiology (Taiz & Zeiger) for the optimal-temperature photosynthesis response curve, soil field capacity, and the suitable vapor pressure deficit (VPD) range.
* **Optimal constants**: Defined the golden growth range for indoor foliage plants — soil moisture 55%, ambient temperature 24°C, relative humidity 65%.
* **Heuristic scoring function**: Built 1,200 multivariate data points aligned with the ESP32 sensor range, mapped to a continuous 1.0–5.0 health score **using a hand-designed heuristic scoring function** (not measured plant outcomes), with injected Gaussian noise simulating sensor error (split 8:2 into a 960-sample training set and a 240-sample test set).
* **Model architecture**: XGBoost Regressor, trained (not fine-tuned) on the synthetic labels above.

**Test set performance** (on held-out synthetic data, same distribution as training):
* Coefficient of determination (R²): 0.968
* Root Mean Squared Error (RMSE): 0.109
* Mean Absolute Error (MAE): 0.086

> **Note on interpretation**: Because both the training and test labels come from the same heuristic scoring function, these metrics show how well XGBoost reproduces that function — not how accurately it predicts real plant health outcomes. No ground-truth plant health data was collected.

**Model persistence**: Exported both as a native JSON structure (`tabular_health_scorer.json`) and a serialized Joblib file (`tabular_health_scorer.joblib`), for fast loading and inference in microservices or edge nodes.

## Core Engineering Highlights

### Distributed Load-Leveling & Asynchronous Tasks

* **BullMQ traffic leveling (`queue.js`)**: High-frequency sensor telemetry reported via MQTT is enqueued into a Redis-backed BullMQ queue; by limiting worker concurrency (Concurrency: 5), traffic leveling smooths out batch writes into the TimescaleDB time-series database.
* **FastAPI dual-mode service architecture (`main.py`)**: Provides a synchronous `/api/v1/predict` low-latency inference endpoint for real-time diagnosis needs, while a background daemon thread listens to a plain Redis list (`bull:aiVisionQueue:wait`, not a BullMQ-managed queue) and asynchronously consumes MinIO S3 images to complete end-to-end batch inference.
* **Telegram bidirectional interaction gateway (`telegram.js`)**: Polls `getUpdates` every 2 seconds to receive `/status`, `/water`, `/photo` remote control commands, and automatically dispatches image/text alert notifications when sensor data is abnormal or an AI visual diagnosis completes.

### TimescaleDB Time-Series Architecture

* **Automatic hypertable partitioning**: Automatically partitions `sensor_telemetry` and `ai_image_analyses` by time dimension.
* **Continuous aggregates**: Automatically computes hourly average and extreme-value statistics views (`sensor_telemetry_hourly`) for the past time window every 30 minutes. (Currently a data-layer feature — the dashboard queries recent raw telemetry directly; the hourly view is not yet wired into a frontend chart.)
* **Data retention policies**: Raw telemetry retained for 30 days, AI analysis records retained for 90 days, downsampled aggregate data retained for 365 days. Note: retention policies apply to TimescaleDB rows only — corresponding images in MinIO are not automatically deleted.

### Full-Stack Real-Time Streaming Dashboard

* **Socket.IO event-driven updates**: Listens for `telemetry_update` and `ai_diagnosis_result` events pushed from the backend, avoiding frontend polling for live updates.
* **Multi-dimensional time-series visualization (Dynamic Timeseries Visualization)**: Built with React and Recharts as dual-Y-axis dynamic monitoring charts, decoupling the rendering of high-frequency soil moisture and ambient temperature time-series data.
* **Multi-modal diagnosis gallery (`AiVisionGallery.jsx`)**: Connects to MinIO S3 static images, displaying AI visual diagnosis labels and environmental health scores in real time.

### Closed-Loop Care Decision Architecture

* **Rule-based automated irrigation (`automationEngine.js`)**: The backend automation rule engine evaluates soil moisture against a 20% threshold upon receiving real-time sensor telemetry, then routes through a shared `attemptWatering()` executor (see below) before dispatching an MQTT `PUMP_ON` command.
* **AI-driven early intervention (`engine.py` → `server.js`)**: During scheduled or manual camera diagnosis, if leaf yellowing (Yellowing_or_Drying) is detected together with low soil moisture (< 35%), the system determines an early water-deficiency symptom and proactively intervenes with watering (`PUMP_WATER`) to prevent irreversible plant damage; if disease spots (Diseased_or_Blight) are detected, it automatically dispatches a pest alert (`PEST_ALERT`). The diagnosis result is relayed from the AI worker to the backend over Redis Pub/Sub (`ai_diagnosis_channel`), where it is routed through the same watering executor as the sensor-threshold rule above.
* **Shared cooldown & dry-run safety (`automationEngine.js: attemptWatering()`)**: Both trigger sources — the sensor-threshold rule and the AI-vision advisory — call one shared executor that enforces a single 5-minute cooldown debounce (in-memory) and validates the water tank level is above 5% before dispatching a pump command. This prevents the two independent trigger paths from double-actuating the pump or racing each other. Every attempt (success or rejection, tagged by trigger source) is logged to `actuation_logs`.

### Edge Hardware Protection & Micro-Firmware

* **Hardware-level dry-run protection interlock**: When the water level is below a safe threshold, the hardware forcibly refuses to activate the pump relay and triggers a buzzer alarm, preventing the motor from running dry and burning out.
* **Firmware communication & sensor integration**: Uses MicroPython to integrate analog sensors (ADC soil moisture, water tank level), DHT11 temperature/humidity, an SSD1306 OLED screen, and a NeoPixel status light, with automatic MQTT reconnection on network disconnection.

## Repository Structure

```
├── ai-service/                   # Multi-modal AI microservice
│   ├── engine.py                 # PlantAIEngine (ONNX + XGBoost dual-engine inference)
│   ├── main.py                   # FastAPI REST server & background worker thread
│   ├── worker.py                 # Redis queue consumer & MinIO image processing
│   ├── best.onnx                 # YOLOv8-cls ONNX static-graph model file
│   ├── tabular_health_scorer.joblib # XGBoost regression scoring model
│   ├── Dockerfile                # AI microservice Docker build file
│   └── requirements.txt          # Python dependencies
├── backend/                      # Node.js core backend
│   ├── assets/                   # Test/simulation plant leaf images
│   ├── scripts/                  # Edge hardware simulation & E2E stress test suite
│   │   ├── simulateCamera.js     # ESP32-CAM image upload & Redis task dispatch simulation
│   │   ├── simulateDevice.js     # ESP32 telemetry & relay actuation simulation
│   │   ├── simulateBackfill.js   # Disconnection backfill time-series data generation script
│   │   └── testBackfill.js       # Traffic-leveling stress test script
│   ├── src/                      # Backend core modules
│   │   ├── automationEngine.js   # Automation decision matrix & dry-run protection rule engine
│   │   ├── queue.js              # BullMQ write queue & leveling worker
│   │   ├── server.js             # Express API, Socket.IO & MQTT coordinator
│   │   └── telegram.js           # Telegram bot command parsing & notification dispatch
│   ├── Dockerfile                # Backend Docker build file
│   └── package.json
├── firmware/
│   └── esp32_plant_node/         # ESP32 MicroPython edge firmware
│       ├── boot.py               # Network initialization & Wi-Fi connection lifecycle
│       ├── config.py             # Pin definitions, threshold constants & MQTT settings
│       ├── main.py               # Firmware main entry point
│       ├── plant_node.py         # Sensor read loop, OLED, and hardware dry-run protection
│       └── umqttsimple.py        # MicroPython lightweight MQTT client
├── frontend/                     # React 18 + Vite frontend dashboard
│   ├── src/
│   │   ├── components/
│   │   │   └── AiVisionGallery.jsx # MinIO image & AI diagnosis card gallery
│   │   ├── App.jsx               # Main monitoring UI, Recharts time-series charts & MQTT remote control
│   │   ├── main.jsx               # React DOM mount entry point
│   │   └── index.css             # Dark theme stylesheet
│   ├── Dockerfile                # Frontend Vite containerized build file
│   └── package.json
├── docker-compose.yml            # 8-container microservice orchestration file
└── init.sql                      # TimescaleDB initialization DDL, continuous aggregates & retention policies
```

## Services & Port Mappings

| Service | Container | Internal/External Port | Description |
|---------|-----------|-------------------------|--------------|
| timescaledb | aiot-timescaledb | 5433:5432 | TimescaleDB time-series database |
| redis | aiot-redis | 6380:6379 | Cache, BullMQ queue & Pub/Sub message relay |
| emqx | aiot-emqx | 1883:1883 / 18083:18083 | MQTT broker transport & EMQX dashboard |
| minio | aiot-minio | 9000:9000 / 9001:9001 | S3 object storage API & MinIO console |
| ai-api | aiot-ai-api | 8000:8000 | FastAPI image inference microservice |
| ai-worker | aiot-ai-worker | (internal network) | Persistent Redis queue consumer worker |
| backend | aiot-backend | 5002:5002 | Node.js backend API, Socket.IO & MQTT coordinator |
| frontend | aiot-frontend | 5173:5173 | React 18 + Vite frontend monitoring dashboard |

## Quickstart

**Configure environment variables**

```
cp ai-service/.env.example ai-service/.env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

**Start all microservice containers**

```
docker compose up -d --build
```

**Access service endpoints**

* Frontend monitoring dashboard: 5173
* Backend API server: 5002
* FastAPI docs interface: 8000/docs
* MinIO object storage console: 9001
* EMQX admin panel: 18083

## Running the End-to-End Simulation Suite

To ensure this project can complete full integration testing and acceptance without physical hardware, the project provides complete simulation scripts:

```
# Simulate sending real-time sensor telemetry data
node backend/scripts/simulateDevice.js

# Simulate ESP32-CAM photo upload and trigger AI diagnosis
node backend/scripts/simulateCamera.js

# Simulate backfilling 60 historical time-series records to validate continuous aggregates
node backend/scripts/simulateBackfill.js
```

## Protocols & API Reference

### Backend REST APIs (backend)

* `GET /api/telemetry/recent?device_id=...`: Get the latest 50 sensor data records.
* `GET /api/ai-analyses?limit=...`: Get the latest AI image diagnosis records and MinIO image links.
* `POST /api/control/water`: Perform dry-run protection validation and send an MQTT watering command.
* `POST /api/camera/capture`: Manually trigger a camera snapshot and enqueue it for AI analysis.
* `GET /api/control/logs`: Get the most recent 10 relay actuation records.

### AI Microservice REST API (ai-service)

* `POST /api/v1/predict`: Accepts an image and sensor features, returns `diagnosis`, `health_score`, and `action_required`.

### MQTT Topic Topology

* Telemetry reporting: `tenants/+/devices/+/telemetry` (Edge → Broker)
* Control command dispatch: `tenants/+/devices/+/control` (Broker → Edge)
