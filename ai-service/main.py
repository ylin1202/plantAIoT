import asyncio
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine import PlantAIEngine
from worker import PlantAIWorker

# 全域 Worker 實例與停止 Flag 控制
worker_instance = None
is_running = True

def run_worker_loop():
    """在獨立線程中運行的 Redis 佇列監聽迴圈"""
    global worker_instance, is_running
    worker_instance = PlantAIWorker()
    print("🚀 [FastAPI Lifespan] 背景 Redis Worker 佇列監聽已啟動...")
    
    while is_running:
        try:
            # 5 秒 timeout，確保服務關閉時能及時退出迴圈
            task = worker_instance.redis_client.blpop(['bull:aiVisionQueue:wait', 'bull:aiQueue:wait'], timeout=5)
            if task and len(task) > 1 and task[1] is not None:
                job_raw = task[1].decode('utf-8')
                worker_instance.process_task(job_raw)
        except Exception as e:
            if "Timeout reading from socket" not in str(e):
                print(f"⚠️ 背景 Worker 監聽例外: {str(e)}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI 生命週期管理：服務啟動時帶起 Worker，關閉時平順釋放資源"""
    global is_running
    is_running = True
    
    # 啟動背景 Worker Thread
    worker_thread = threading.Thread(target=run_worker_loop, daemon=True)
    worker_thread.start()
    print("✅ [FastAPI] 整合型微服務啟動完成（已含 REST API 與 Redis 佇列監聽器）")
    
    yield
    
    # 服務關閉時停止 Worker
    is_running = False
    print("🛑 [FastAPI] 正關閉背景 Redis Worker...")

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

# 在服務啟動時初始化單例 (Singleton) AI 引擎
ai_engine = PlantAIEngine()

class DiagnosisResponse(BaseModel):
    diagnosis: str
    confidence_percent: float
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
            confidence_percent=round(res["confidence"] * 100, 2),
            health_score=res["health_score"],
            action_required=res["action_required"]
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"推論失敗: {str(e)}")