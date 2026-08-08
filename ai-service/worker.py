import os
import json
import time
import cv2
import redis
import psycopg2
import requests
import joblib
import numpy as np
import onnxruntime as ort
from PIL import Image
from dotenv import load_dotenv
from minio import Minio

load_dotenv()

# ==================== 1. 初始化 AI 雙模型 (ONNX + XGBoost) ====================
print("🧠 正在載入生產級 AI 雙引擎...")

# A. 視覺 AI: YOLOv8 ONNX 輕量極速推論 Session
ONNX_MODEL_PATH = os.getenv('VISION_MODEL_PATH', 'best.onnx')
try:
    ort_session = ort.InferenceSession(ONNX_MODEL_PATH, providers=['CPUExecutionProvider'])
    print(f"✅ ONNX Runtime Session 載入成功: [{ONNX_MODEL_PATH}]")
except Exception as e:
    print(f"❌ ONNX 載入失敗: {e}")
    ort_session = None

CLASS_NAMES = ['Background', 'Diseased_or_Blight', 'Healthy', 'Yellowing_or_Drying']

# B. 數據 AI: XGBoost 環境健康度評估器
XGB_MODEL_PATH = os.getenv('TABULAR_MODEL_PATH', 'tabular_health_scorer.joblib')
try:
    xgb_model = joblib.load(XGB_MODEL_PATH)
    print(f"✅ XGBoost 數據 AI 載入成功: [{XGB_MODEL_PATH}]")
except Exception as e:
    print(f"⚠️ XGBoost 載入失敗: {e}")
    xgb_model = None

# ==================== 2. 初始化 Redis, MinIO & DB ====================
redis_client = redis.Redis(
    host=os.getenv('REDIS_HOST', 'localhost'),
    port=int(os.getenv('REDIS_PORT', 6380)),
    db=0
)

minio_client = Minio(
    os.getenv('MINIO_ENDPOINT', 'localhost:9000'),
    access_key=os.getenv('MINIO_ACCESS_KEY', 'minio_admin'),
    secret_key=os.getenv('MINIO_SECRET_KEY', 'minio_password'),
    secure=False
)

BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
CHAT_ID = os.getenv('TELEGRAM_CHAT_ID')

def get_db_connection():
    return psycopg2.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=int(os.getenv('DB_PORT', 5433)),  # 對齊 docker-compose 的 5433
        user=os.getenv('DB_USER', 'aiot_user'),
        password=os.getenv('DB_PASSWORD', 'aiot_password'),
        dbname=os.getenv('DB_NAME', 'aiot_db')
    )

# ==================== 3. ONNX 圖片預處理 ====================
def preprocess_image(image_path, target_size=(320, 320)):
    img = Image.open(image_path).convert('RGB')
    img = img.resize(target_size)
    img_data = np.array(img).astype(np.float32) / 255.0
    img_data = np.transpose(img_data, (2, 0, 1))
    img_data = np.expand_dims(img_data, axis=0)
    return img_data

# ==================== 4. OpenCV 動態繪製 AI 診斷標籤 ====================
def draw_ai_annotation(image_path, diagnosis, confidence, health_score, action):
    """使用 OpenCV 在照片上繪製 AI 診斷資訊卡片與外框"""
    img = cv2.imread(image_path)
    if img is None:
        return image_path

    h, w, _ = img.shape

    # 建立上方半透明黑色背景遮罩
    overlay = img.copy()
    cv2.rectangle(overlay, (0, 0), (w, 65), (0, 0, 0), -1)

    # 根據診斷結果設定框線顏色 (BGR)
    color = (0, 255, 0) if diagnosis == "Healthy" else (0, 165, 255)  # 綠色 / 橘色
    if diagnosis == "Diseased_or_Blight":
        color = (0, 0, 255)  # 紅色

    # 混合遮罩
    cv2.addWeighted(overlay, 0.6, img, 0.4, 0, img)

    # 繪製外框
    cv2.rectangle(img, (0, 0), (w, h), color, 3)

    # 寫入診斷與環境資訊
    text_diag = f"AI: {diagnosis} ({confidence*100:.1f}%)"
    text_env = f"Score: {health_score}/5.0 | Action: {action}"

    cv2.putText(img, text_diag, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(img, text_env, (12, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 255, 200), 1, cv2.LINE_AA)

    # 儲存繪製後的圖片
    annotated_path = image_path.replace(".jpg", "_annotated.jpg")
    cv2.imwrite(annotated_path, img)
    return annotated_path

# ==================== 5. Telegram 推播卡片 ====================
def send_telegram_photo(image_path, caption):
    if not BOT_TOKEN or not CHAT_ID:
        print("⚠️ 未設定 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，跳過 Telegram 推播")
        return
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto"
    try:
        with open(image_path, 'rb') as photo:
            payload = {'chat_id': CHAT_ID, 'caption': caption, 'parse_mode': 'Markdown'}
            res = requests.post(url, data=payload, files={'photo': photo}, timeout=10)
            if res.status_code == 200:
                print("📱 [Telegram Bot] 成功將 AI 標註診斷照片推播至手機！")
            else:
                print(f"❌ Telegram 推播失敗: {res.text}")
        
        # 💡 給予 1 秒緩衝，讓檔案串流順利完成傳送
        time.sleep(1.0)
    except Exception as e:
        print(f"❌ Telegram 發送失敗: {e}")

# ==================== 6. 核心異步任務處理 ====================
def process_ai_task(job_data_str):
    local_input = None
    annotated_output = None
    try:
        payload = json.loads(job_data_str)
        data = payload.get('data', payload)

        # 💡 關鍵修復：預設裝置 ID 統一為 esp32_plant_01，對齊前端與後端 API
        device_id = data.get('device_id', 'esp32_plant_01')
        image_name = data.get('image_name')

        if not image_name:
            print("⚠️ 收到任務但無 image_name，跳過處理")
            return

        print(f"📸 [AI Worker] 開始處理任務: {image_name} (Device: {device_id})")

        local_input = f"./temp_{image_name}"
        bucket_name = os.getenv('MINIO_BUCKET', 'plant-images')

        # 從 MinIO 下載圖片 (含 3 次重試)
        download_success = False
        for _ in range(3):
            try:
                minio_client.fget_object(bucket_name, image_name, local_input)
                download_success = True
                break
            except Exception:
                time.sleep(0.5)

        if not download_success or not os.path.exists(local_input):
            print(f"❌ 無法從 MinIO 取得圖片檔: {image_name}")
            return

        # ----------------- A. ONNX 視覺 AI 推論 -----------------
        diagnosis_label = "Healthy"
        confidence = 0.95
        if ort_session:
            input_data = preprocess_image(local_input)
            input_name = ort_session.get_inputs()[0].name
            raw_output = ort_session.run(None, {input_name: input_data})[0]

            probs = np.exp(raw_output) / np.sum(np.exp(raw_output), axis=1, keepdims=True)
            top1_idx = int(np.argmax(probs[0]))
            confidence = float(probs[0][top1_idx])
            diagnosis_label = CLASS_NAMES[top1_idx] if top1_idx < len(CLASS_NAMES) else "Unknown"

        # ----------------- B. 從 DB 讀取 Telemetry 與 XGBoost 計算 -----------------
        soil, temp, hum = 50.0, 25.0, 60.0
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("""
                SELECT soil_moisture, temperature, humidity 
                FROM sensor_telemetry 
                WHERE device_id = %s OR device_id = 'esp32_cam_01'
                ORDER BY time DESC LIMIT 1;
            """, (device_id,))
            latest_sensor = cur.fetchone()
            if latest_sensor:
                soil = float(latest_sensor[0])
                temp = float(latest_sensor[1])
                hum = float(latest_sensor[2])
            cur.close()
            conn.close()
        except Exception as db_err:
            print(f"⚠️ 讀取感測器 DB 紀錄跳過 (使用預設值): {db_err}")

        health_score = 3.5
        if xgb_model:
            input_df = np.array([[soil, temp, hum]])
            health_score = round(float(xgb_model.predict(input_df)[0]), 1)
            health_score = max(1.0, min(5.0, health_score))

        # ----------------- C. 多模態交叉決策 -----------------
        action_required = "NORMAL"
        if diagnosis_label == "Yellowing_or_Drying" and soil < 35.0:
            action_required = "PUMP_WATER"
        elif diagnosis_label == "Diseased_or_Blight":
            action_required = "PEST_ALERT"

        # ----------------- D. OpenCV 繪製標註圖與上傳 MinIO -----------------
        annotated_output = draw_ai_annotation(
            local_input,
            diagnosis_label,
            confidence,
            health_score,
            action_required
        )

        processed_image_name = f"processed_{image_name}"
        try:
            minio_client.fput_object(
                bucket_name,
                processed_image_name,
                annotated_output,
                content_type="image/jpeg"
            )
            print(f"☁️ [MinIO] 已成功上傳標註圖: {processed_image_name}")
        except Exception as minio_err:
            print(f"⚠️ MinIO 上傳標註圖失敗: {minio_err}")
            processed_image_name = image_name  # 退回原圖

        # ----------------- E. 寫入 TimescaleDB 分析紀錄 -----------------
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            detections = [{
                "diagnosis": diagnosis_label,
                "confidence": round(confidence * 100, 1),
                "health_score": health_score,
                "action_required": action_required
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

        # ----------------- F. 發送繪製後的標註圖給 Telegram -----------------
        status_emoji = "🟢" if diagnosis_label == "Healthy" else "⚠️"
        caption = (
            f"🌿 *【AIoT 雙引擎多模態診斷報告】*\n"
            f"───────────────────\n"
            f"📡 裝置名稱: `{device_id}`\n"
            f"{status_emoji} 視覺診斷: *{diagnosis_label}* ({confidence*100:.1f}%)\n"
            f"📊 環境評分: *{health_score} / 5.0*\n"
            f"💧 土壤濕度: `{soil}%` | 🌡️ 溫度: `{temp}°C`\n"
            f"🚨 建議動作: *{action_required}*\n"
            f"⏰ 分析時間: `{time.strftime('%H:%M:%S')}`"
        )
        send_telegram_photo(annotated_output, caption)

    except Exception as e:
        print(f"❌ [AI Worker] 處理失敗: {str(e)}")
    finally:
        time.sleep(0.5)
        if local_input and os.path.exists(local_input):
            try:
                os.remove(local_input)
            except Exception:
                pass
        if annotated_output and os.path.exists(annotated_output):
            try:
                os.remove(annotated_output)
            except Exception:
                pass

# ==================== 7. 輪詢 Redis Queue ====================
if __name__ == '__main__':
    print("🚀 Python ONNX + XGBoost AI Worker 已啟動，開啟異步佇列監聽...")
    while True:
        try:
            task = redis_client.blpop(['bull:aiVisionQueue:wait', 'bull:aiQueue:wait'], timeout=5)
            if task and len(task) > 1 and task[1] is not None:
                job_raw = task[1].decode('utf-8')
                process_ai_task(job_raw)
        except redis.exceptions.TimeoutError:
            pass
        except Exception as e:
            if "Timeout reading from socket" not in str(e):
                print(f"⚠️ 佇列監聽例外: {str(e)}")

        time.sleep(0.1)