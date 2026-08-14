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
    """Background Redis queue polling loop executed in a dedicated daemon thread."""
    global worker_instance, is_running
    print("[FastAPI Startup] Initializing background Redis AI Worker...", flush=True)
    
    # Allow 2 seconds for external dependencies to stabilize before instantiation
    time.sleep(2)
    try:
        worker_instance = PlantAIWorker()
        print("[FastAPI Lifespan] Background Redis Worker initialized. Listening for queue events...", flush=True)
    except Exception as init_err:
        print(f"[FastAPI Lifespan] Worker initialization failed: {init_err}", flush=True)
        return

    while is_running:
        try:
            # Poll Redis task queues using blocking pop
            task = worker_instance.redis_client.blpop(['bull:aiVisionQueue:wait', 'aiVisionQueue', 'bull:aiQueue:wait'], timeout=2)
            if task and len(task) > 1 and task[1] is not None:
                job_raw = task[1].decode('utf-8')
                print(f"[FastAPI Worker] Processing background queue task: {job_raw}", flush=True)
                worker_instance.process_task(job_raw)
        except Exception as e:
            if "Timeout reading from socket" not in str(e) and "timed out" not in str(e):
                print(f"[FastAPI Worker Error] Queue polling exception: {str(e)}", flush=True)
        time.sleep(0.1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle events for background threads and service states."""
    global is_running
    is_running = True
    
    # Spawn background Redis worker thread
    worker_thread = threading.Thread(target=run_worker_loop, daemon=True)
    worker_thread.start()
    print("[FastAPI] Unified microservice started (REST API & Redis Queue Worker).", flush=True)
    
    yield
    
    is_running = False
    print("[FastAPI] Shutting down background Redis Worker...", flush=True)

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

# Instantiate singleton AI inference engine
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
        raise HTTPException(status_code=500, detail=f"Inference execution failed: {str(e)}")