import os
import json
import time
import redis
import psycopg2
from ultralytics import YOLO
from dotenv import load_dotenv
from minio import Minio

load_dotenv()

# 1. 初始化 YOLOv8 AI 模型
print("🧠 正在載入 YOLOv8 AI 模型...")
model = YOLO('yolov8n.pt') 

# 2. 初始化 Redis 連線
redis_client = redis.Redis(
    host=os.getenv('REDIS_HOST', 'localhost'),
    port=int(os.getenv('REDIS_PORT', 6380)),
    db=0
)

# 3. 初始化 MinIO Client
minio_client = Minio(
    os.getenv('MINIO_ENDPOINT', 'localhost:9000'),
    access_key=os.getenv('MINIO_ACCESS_KEY', 'minio_admin'),
    secret_key=os.getenv('MINIO_SECRET_KEY', 'minio_password'),
    secure=False
)

# 4. 資料庫連線 function
def get_db_connection():
    return psycopg2.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=int(os.getenv('DB_PORT', 5433)),
        user=os.getenv('DB_USER', 'aiot_user'),
        password=os.getenv('DB_PASSWORD', 'aiot_password'),
        dbname=os.getenv('DB_NAME', 'aiot_db')
    )

def process_ai_task(job_data_str):
    try:
        payload = json.loads(job_data_str)
        data = payload.get('data', payload)
        
        device_id = data.get('device_id', 'esp32_cam_01')
        image_name = data.get('image_name')
        
        if not image_name:
            return

        print(f"📸 [AI Worker] 開始處理照片: {image_name} (Device: {device_id})")

        local_input = f"./temp_in_{image_name}"
        local_output = f"./temp_out_{image_name}"
        
        bucket_name = os.getenv('MINIO_BUCKET', 'plant-images')
        minio_client.fget_object(bucket_name, image_name, local_input)

        # 1. YOLOv8 推理
        results = model(local_input)
        results[0].save(filename=local_output)

        # 2. 統計標籤與信心度
        detections = []
        for box in results[0].boxes:
            cls_id = int(box.cls[0])
            label = model.names[cls_id]
            conf = float(box.conf[0])
            detections.append({"label": label, "confidence": round(conf, 2)})

        # 3. 上傳標註圖至 MinIO
        processed_image_name = f"processed_{image_name}"
        minio_client.fput_object(
            bucket_name,
            processed_image_name,
            local_output,
            content_type="image/jpeg"
        )

        # 4. 寫入 TimescaleDB AI 分析紀錄表
        conn = get_db_connection()
        cur = conn.cursor()
        
        insert_query = """
            INSERT INTO ai_image_analyses (time, device_id, raw_image_path, processed_image_path, detections)
            VALUES (NOW(), %s, %s, %s, %s);
        """
        cur.execute(insert_query, (
            device_id,
            image_name,
            processed_image_name,
            json.dumps(detections)
        ))
        conn.commit()
        cur.close()
        conn.close()

        # 清理暫存檔
        if os.path.exists(local_input): os.remove(local_input)
        if os.path.exists(local_output): os.remove(local_output)

        print(f"✅ [AI Worker] 分析完成且已存入 DB！")
        print(f"🔍 偵測結果: {detections}")

    except Exception as e:
        print(f"❌ [AI Worker] 處理失敗: {str(e)}")

if __name__ == '__main__':
    print("🚀 Python AI Vision Worker 已啟動，等待佇列任務中...")
    
    while True:
        try:
            task = redis_client.blpop('bull:aiVisionQueue:wait', timeout=2)
            if task and len(task) > 1 and task[1] is not None:
                job_raw = task[1].decode('utf-8')
                process_ai_task(job_raw)
        except Exception as e:
            print(f"⚠️ 佇列監聽例外: {str(e)}")
            
        time.sleep(0.1)