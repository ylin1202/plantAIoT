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
    """Redis 異步佇列監聽與背景 AI 診斷處理器"""

    def __init__(self):
        self.ai_engine = PlantAIEngine(
            vision_model_path=os.getenv('VISION_MODEL_PATH', 'best.onnx'),
            tabular_model_path=os.getenv('TABULAR_MODEL_PATH', 'tabular_health_scorer.joblib')
        )
        self.redis_client = self._init_redis()
        self.minio_client = self._init_minio()
        self.bot_token = os.getenv('TELEGRAM_BOT_TOKEN')
        self.chat_id = os.getenv('TELEGRAM_CHAT_ID')

    def _init_redis(self):
        return redis.Redis(
            host=os.getenv('REDIS_HOST', 'localhost'),
            port=int(os.getenv('REDIS_PORT', 6380)),
            db=0
        )

    def _init_minio(self):
        return Minio(
            os.getenv('MINIO_ENDPOINT', 'localhost:9000'),
            access_key=os.getenv('MINIO_ACCESS_KEY', 'minio_admin'),
            secret_key=os.getenv('MINIO_SECRET_KEY', 'minio_password'),
            secure=False
        )

    def get_db_connection(self):
        return psycopg2.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            port=int(os.getenv('DB_PORT', 5433)),
            user=os.getenv('DB_USER', 'aiot_user'),
            password=os.getenv('DB_PASSWORD', 'aiot_password'),
            dbname=os.getenv('DB_NAME', 'aiot_db')
        )

    def send_telegram_photo(self, image_path, caption):
        if not self.bot_token or not self.chat_id:
            return
        url = f"https://api.telegram.org/bot{self.bot_token}/sendPhoto"
        try:
            with open(image_path, 'rb') as photo:
                payload = {'chat_id': self.chat_id, 'caption': caption, 'parse_mode': 'Markdown'}
                requests.post(url, data=payload, files={'photo': photo}, timeout=10)
            time.sleep(1.0)
        except Exception as e:
            print(f"❌ Telegram 發送失敗: {e}")

    def fetch_latest_telemetry(self, device_id):
        soil, temp, hum = 50.0, 25.0, 60.0
        try:
            conn = self.get_db_connection()
            cur = conn.cursor()
            # 撈取最新的一筆實體感測器數據
            cur.execute("""
                SELECT soil_moisture, temperature, humidity 
                FROM sensor_telemetry 
                ORDER BY time DESC LIMIT 1;
            """)
            latest_sensor = cur.fetchone()
            if latest_sensor:
                soil, temp, hum = float(latest_sensor[0]), float(latest_sensor[1]), float(latest_sensor[2])
                print(f"📊 [AI Worker] 成功撈取實時感測器數據 ➔ 土壤: {soil}%, 溫度: {temp}°C, 濕度: {hum}%")
            cur.close()
            conn.close()
        except Exception as e:
            print(f"⚠️ [AI Worker] 撈取感測器失敗，使用預設值: {e}")
        return soil, temp, hum

    def save_analysis_to_db(self, device_id, image_name, processed_image_name, res):
        try:
            conn = self.get_db_connection()
            cur = conn.cursor()
            detections = [{
                "diagnosis": res["diagnosis"],
                "confidence": round(res["confidence"] * 100, 1),
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
            print(f"✅ [AI Worker] 毫秒級推論完成並成功寫入 DB！(Device: {device_id})")
        except Exception as db_write_err:
            print(f"⚠️ 寫入 TimescaleDB 失敗: {db_write_err}")

    def process_task(self, job_data_str):
        local_input = None
        try:
            payload = json.loads(job_data_str)
            data = payload.get('data', payload)

            device_id = data.get('device_id', 'esp32_plant_01')
            image_name = data.get('image_name')

            if not image_name:
                return

            print(f"📸 [AI Worker] 開始處理任務: {image_name} (Device: {device_id})")

            local_input = f"./temp_{image_name}"
            bucket_name = os.getenv('MINIO_BUCKET', 'plant-images')

            # 下載 MinIO 圖片
            download_success = False
            for _ in range(3):
                try:
                    self.minio_client.fget_object(bucket_name, image_name, local_input)
                    download_success = True
                    break
                except Exception:
                    time.sleep(0.5)

            if not download_success or not os.path.exists(local_input):
                return

            # 撈取感測器資料與調用 AI 引擎推論
            soil, temp, hum = self.fetch_latest_telemetry(device_id)
            res = self.ai_engine.predict(local_input, soil, temp, hum)

            # 寫入資料庫 (processed_image_name 直接帶原檔名)
            self.save_analysis_to_db(device_id, image_name, image_name, res)

            # 發送 Telegram 通告 (直接發送原圖)
            status_emoji = "🟢" if res["diagnosis"] == "Healthy" else "⚠️"
            caption = (
                f"🌿 *【AIoT 雙引擎多模態診斷報告】*\n"
                f"───────────────────\n"
                f"📡 裝置名稱: `{device_id}`\n"
                f"{status_emoji} 視覺診斷: *{res['diagnosis']}*\n"
                f"📊 環境評分: *{res['health_score']} / 5.0*\n"
                f"💧 土壤濕度: `{soil}%` | 🌡️ 溫度: `{temp}°C`\n"
                f"🚨 建議動作: *{res['action_required']}*\n"
                f"⏰ 分析時間: `{time.strftime('%H:%M:%S')}`"
            )
            self.send_telegram_photo(local_input, caption)

        except Exception as e:
            print(f"❌ [AI Worker] 處理失敗: {str(e)}")
        finally:
            time.sleep(0.5)
            if local_input and os.path.exists(local_input):
                try:
                    os.remove(local_input)
                except Exception:
                    pass

    def start(self):
        """啟動 Redis 異步佇列監聽循環"""
        print("🚀 Python OOP ONNX + XGBoost AI Worker 已啟動，開啟異步佇列監聽...")
        while True:
            try:
                task = self.redis_client.blpop(['bull:aiVisionQueue:wait', 'bull:aiQueue:wait'], timeout=5)
                if task and len(task) > 1 and task[1] is not None:
                    job_raw = task[1].decode('utf-8')
                    self.process_task(job_raw)
            except redis.exceptions.TimeoutError:
                pass
            except Exception as e:
                if "Timeout reading from socket" not in str(e):
                    print(f"⚠️ 佇列監聽例外: {str(e)}")
            time.sleep(0.1)

if __name__ == '__main__':
    worker = PlantAIWorker()
    worker.start()