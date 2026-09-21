import os
import json
import time
import redis
import psycopg2
import requests
from dotenv import load_dotenv
from minio import Minio

from engine import PlantAIEngine

load_dotenv()

class PlantAIWorker:
    """Asynchronous Redis queue listener and background AI diagnostic worker."""

    def __init__(self):
        print("[AI Worker] Initializing PlantAIEngine...", flush=True)
        self.ai_engine = PlantAIEngine(
            vision_model_path=os.getenv('VISION_MODEL_PATH', 'best.onnx'),
            tabular_model_path=os.getenv('TABULAR_MODEL_PATH', 'tabular_health_scorer.joblib')
        )
        print("[AI Worker] PlantAIEngine initialized successfully.", flush=True)

        self.redis_client = self._init_redis()
        self.minio_client = self._init_minio()
        self.bot_token = os.getenv('TELEGRAM_BOT_TOKEN')
        self.chat_id = os.getenv('TELEGRAM_CHAT_ID')

    def _init_redis(self):
        """Initialize Redis connection with containerized host resolution and socket timeout protection."""
        host = os.getenv('REDIS_HOST', 'redis')
        port = int(os.getenv('REDIS_PORT', 6379))
        print(f"[AI Worker] Connecting to Redis -> {host}:{port}", flush=True)
        return redis.Redis(
            host=host,
            port=port,
            db=0,
            socket_timeout=5.0
        )

    def _init_minio(self):
        """Initialize MinIO client, normalizing localhost endpoints for container networks."""
        endpoint = os.getenv('MINIO_ENDPOINT', 'minio:9000')

        # Fallback guard: resolve localhost references to internal Docker service hostname
        if 'localhost' in endpoint or '127.0.0.1' in endpoint:
            endpoint = 'minio:9000'

        print(f"[AI Worker] Connecting to MinIO -> {endpoint}", flush=True)
        return Minio(
            endpoint,
            access_key=os.getenv('MINIO_ACCESS_KEY', 'minio_admin'),
            secret_key=os.getenv('MINIO_SECRET_KEY', 'minio_password'),
            secure=False
        )

    def get_db_connection(self):
        """Establish connection to TimescaleDB instance."""
        return psycopg2.connect(
            host=os.getenv('DB_HOST', 'timescaledb'),
            port=int(os.getenv('DB_PORT', 5432)),
            user=os.getenv('DB_USER', 'aiot_user'),
            password=os.getenv('DB_PASSWORD', 'aiot_password'),
            dbname=os.getenv('DB_NAME', 'aiot_db')
        )

    def send_telegram_photo(self, image_path, caption):
        """Dispatch visual diagnostic report and snapshot image to Telegram bot."""
        if not self.bot_token or not self.chat_id:
            return
        url = f"https://api.telegram.org/bot{self.bot_token}/sendPhoto"
        try:
            with open(image_path, 'rb') as photo:
                payload = {'chat_id': self.chat_id, 'caption': caption, 'parse_mode': 'Markdown'}
                requests.post(url, data=payload, files={'photo': photo}, timeout=10)
        except Exception as e:
            print(f"[Telegram Bot] Dispatch failed: {e}", flush=True)

    def notify_backend_socket(self, device_id, image_name, res, water_level=None):
        """Publish diagnostic inference results to Redis Pub/Sub channel for real-time frontend propagation."""
        try:
            payload = {
                "device_id": device_id,
                "image_name": image_name,
                "diagnosis": res["diagnosis"],
                "health_score": res["health_score"],
                "action_required": res["action_required"],
                "water_level": water_level,
                "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ')
            }
            self.redis_client.publish('ai_diagnosis_channel', json.dumps(payload))
            print(f"[AI Worker] Broadcasted diagnosis result to Redis Pub/Sub channel (ai_diagnosis_channel)", flush=True)
        except Exception as e:
            print(f"[AI Worker] Failed to broadcast diagnostic payload: {e}", flush=True)

    def fetch_latest_telemetry(self, device_id):
        """Query TimescaleDB for the latest telemetry metrics associated with the target device."""
        soil, temp, hum, water_level = 50.0, 25.0, 60.0, None
        try:
            conn = self.get_db_connection()
            cur = conn.cursor()
            cur.execute("""
                SELECT soil_moisture, temperature, humidity, water_level
                FROM sensor_telemetry
                WHERE device_id = %s
                ORDER BY time DESC LIMIT 1;
            """, (device_id,))
            latest_sensor = cur.fetchone()
            if latest_sensor:
                soil, temp, hum = float(latest_sensor[0]), float(latest_sensor[1]), float(latest_sensor[2])
                water_level = float(latest_sensor[3]) if latest_sensor[3] is not None else None
                print(f"[AI Worker] Telemetry fetched successfully -> Soil: {soil}%, Temp: {temp}°C, Humidity: {hum}%, Water: {water_level}%", flush=True)
            cur.close()
            conn.close()
        except Exception as e:
            print(f"[AI Worker] Failed to query telemetry, falling back to defaults: {e}", flush=True)
        return soil, temp, hum, water_level

    def save_analysis_to_db(self, device_id, image_name, processed_image_name, res):
        """Persist visual inference results and telemetry analysis into TimescaleDB."""
        try:
            conn = self.get_db_connection()
            cur = conn.cursor()

            detections = [{
                "diagnosis": res["diagnosis"],
                "health_score": res["health_score"],
                "action_required": res["action_required"]
            }]
            insert_query = """
                INSERT INTO ai_image_analyses (time, device_id, raw_image_path, processed_image_path, detections)
                VALUES (NOW(), %s, %s, %s, %s);
            """
            cur.execute(insert_query, (device_id, image_name, processed_image_name, json.dumps(detections)))
            conn.commit()
            cur.close()
            conn.close()
            print(f"[AI Worker] Analysis persisted to TimescaleDB successfully. (Device: {device_id})", flush=True)
        except Exception as db_write_err:
            print(f"[AI Worker] Failed to write analysis to TimescaleDB: {db_write_err}", flush=True)

    def process_task(self, job_data_str):
        """Execute complete inference pipeline: fetch image -> infer -> persist DB -> broadcast -> notify."""
        local_input = None
        try:
            payload = json.loads(job_data_str)
            data = payload.get('data', payload)

            device_id = data.get('device_id', 'esp32_plant_01')
            image_name = data.get('image_name')

            if not image_name:
                return

            print(f"[AI Worker] Processing task: {image_name} (Device: {device_id})", flush=True)

            local_input = f"./temp_{image_name}"
            bucket_name = os.getenv('MINIO_BUCKET', 'plant-images')

            # Fetch source image from MinIO S3 storage with retry logic
            download_success = False
            for _ in range(3):
                try:
                    self.minio_client.fget_object(bucket_name, image_name, local_input)
                    download_success = True
                    break
                except Exception:
                    time.sleep(0.5)

            if not download_success or not os.path.exists(local_input):
                print(f"[AI Worker] Failed to download image from MinIO: {image_name}", flush=True)
                return

            soil, temp, hum, water_level = self.fetch_latest_telemetry(device_id)
            res = self.ai_engine.predict(local_input, soil, temp, hum)

            # Persist results into TimescaleDB
            self.save_analysis_to_db(device_id, image_name, image_name, res)

            # Broadcast updates via Redis Pub/Sub for frontend real-time refresh.
            # Includes water_level so the backend can safety-check before acting
            # on an AI-flagged PUMP_WATER advisory (see server.js).
            self.notify_backend_socket(device_id, image_name, res, water_level=water_level)

            # Dispatch automated alert report via Telegram
            status_emoji = "🟢" if res["diagnosis"] == "Healthy" else "⚠️"
            caption = (
                f"🌿 *【AIoT Multimodal Dual-Engine Diagnostic Report】*\n"
                f"───────────────────\n"
                f"📡 Device ID: `{device_id}`\n"
                f"{status_emoji} Visual Diagnosis: *{res['diagnosis']}*\n"
                f"📊 Health Score: *{res['health_score']} / 5.0*\n"
                f"💧 Soil Moisture: `{soil}%` | 🌡️ Temp: `{temp}°C`\n"
                f"🚨 Action Required: *{res['action_required']}*\n"
                f"⏰ Timestamp: `{time.strftime('%H:%M:%S')}`"
            )
            self.send_telegram_photo(local_input, caption)

        except Exception as e:
            print(f"[AI Worker] Task execution failed: {str(e)}", flush=True)
        finally:
            if local_input and os.path.exists(local_input):
                try:
                    os.remove(local_input)
                except Exception:
                    pass

    def start(self):
        """Start blocking polling loop on Redis Bull queues."""
        print("[AI Worker] Background queue listener running. Waiting for tasks...", flush=True)
        while True:
            try:
                task = self.redis_client.blpop(['bull:aiVisionQueue:wait', 'aiVisionQueue', 'bull:aiQueue:wait'], timeout=2)
                if task and len(task) > 1 and task[1] is not None:
                    job_raw = task[1].decode('utf-8')
                    print(f"[AI Worker] Task received (Queue: {task[0].decode('utf-8')})", flush=True)
                    self.process_task(job_raw)
            except redis.exceptions.TimeoutError:
                pass
            except Exception as e:
                if "Timeout reading from socket" not in str(e) and "timed out" not in str(e):
                    print(f"[AI Worker Error] Queue polling exception: {str(e)}", flush=True)
            time.sleep(0.1)


if __name__ == '__main__':
    print("[AI Worker Engine] Launching main worker process...", flush=True)
    worker = PlantAIWorker()
    worker.start()