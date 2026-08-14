import asyncio
import threading
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine import PlantAIEngine
from worker import PlantAIWorker

worker_instance = None
is_running = True

def run_worker_loop():
    """在獨立線程中運行的 Redis 佇列監聽迴圈"""
    global worker_instance, is_running
    print("🚀 [FastAPI Startup] 正在背景啟動 Redis AI Worker...", flush=True)
    
    # 延遲 2 秒等待外部服務準備完畢並實例化
    time.sleep(2)
    try:
        worker_instance = PlantAIWorker()
        print("✅ [FastAPI Lifespan] 背景 Redis Worker 初始化完畢，開始監聽佇列...", flush=True)
    except Exception as init_err:
        print(f"❌ [FastAPI Lifespan] Worker 初始化失敗: {init_err}", flush=True)
        return

    while is_running:
        try:
            # 監聽 Redis 佇列
            task = worker_instance.redis_client.blpop(['bull:aiVisionQueue:wait', 'aiVisionQueue', 'bull:aiQueue:wait'], timeout=2)
            if task and len(task) > 1 and task[1] is not None:
                job_raw = task[1].decode('utf-8')
                print(f"📥 [FastAPI Worker] 收到背景佇列任務: {job_raw}", flush=True)
                worker_instance.process_task(job_raw)
        except Exception as e:
            if "Timeout reading from socket" not in str(e) and "timed out" not in str(e):
                print(f"⚠️ 背景 Worker 監聽例外: {str(e)}", flush=True)
        time.sleep(0.1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI 生命週期管理"""
    global is_running
    is_running = True
    
    # 啟動背景 Worker Thread
    worker_thread = threading.Thread(target=run_worker_loop, daemon=True)
    worker_thread.start()
    print("✅ [FastAPI] 整合型微服務啟動完成（含 REST API 與 Redis 佇列監聽器）", flush=True)
    
    yield
    
    is_running = False
    print("🛑 [FastAPI] 正關閉背景 Redis Worker...", flush=True)

app = FastAPI(
    title="AIoT Plant Diagnosis REST API & Worker", 
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 啟動單例 AI 引擎
ai_engine = PlantAIEngine()

class DiagnosisResponse(BaseModel):
    diagnosis: str
    health_score: float
    action_required: str

@app.get("/")
def health_check():
    return {
        "status": "online", 
        "service": "FastAPI Unified Diagnosis Engine & Redis Worker"
    }

@app.post("/api/v1/predict", response_model=DiagnosisResponse)
async def predict(
    file: UploadFile = File(...),
    soil_moisture: float = 50.0,
    temperature: float = 25.0,
    humidity: float = 60.0
):
    try:
        contents = await file.read()
        res = ai_engine.predict(contents, soil_moisture, temperature, humidity)
        return DiagnosisResponse(
            diagnosis=res["diagnosis"],
            health_score=res["health_score"],
            action_required=res["action_required"]
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"推論失敗: {str(e)}")