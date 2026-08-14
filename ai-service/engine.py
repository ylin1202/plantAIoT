import os
import io
import cv2
import joblib
import numpy as np
import onnxruntime as ort
from PIL import Image

class PlantAIEngine:
    """Multimodal dual-engine AI microservice.
    
    Combines fine-tuned YOLOv8 classification (ONNX Runtime) for visual diagnostics
    and a trained XGBoost regressor for environmental telemetry health scoring.
    """

    CLASS_NAMES = ['Background', 'Diseased_or_Blight', 'Healthy', 'Yellowing_or_Drying']

    def __init__(self, vision_model_path='best.onnx', tabular_model_path='tabular_health_scorer.joblib', conf_threshold=0.5):
        self.vision_model_path = vision_model_path
        self.tabular_model_path = tabular_model_path
        self.conf_threshold = conf_threshold
        
        self.ort_session = self._load_onnx_model()
        self.xgb_model = self._load_xgb_model()

    def _load_onnx_model(self):
        """Initialize the ONNX Runtime inference session."""
        try:
            if not os.path.exists(self.vision_model_path):
                print(f"[PlantAIEngine Error] ONNX model artifact not found: [{self.vision_model_path}]")
                return None
            session = ort.InferenceSession(self.vision_model_path, providers=['CPUExecutionProvider'])
            print(f"[PlantAIEngine] ONNX Runtime session initialized successfully: [{self.vision_model_path}]")
            return session
        except Exception as e:
            print(f"[PlantAIEngine] Failed to load ONNX model: {e}")
            return None

    def _load_xgb_model(self):
        """Load the trained XGBoost regression model artifact."""
        try:
            if not os.path.exists(self.tabular_model_path):
                print(f"[PlantAIEngine Error] XGBoost model artifact not found: [{self.tabular_model_path}]")
                return None
            model = joblib.load(self.tabular_model_path)
            print(f"[PlantAIEngine] XGBoost model loaded successfully: [{self.tabular_model_path}]")
            return model
        except Exception as e:
            print(f"[PlantAIEngine] Failed to load XGBoost model: {e}")
            return None

    def preprocess_image(self, image_source, target_size=(320, 320), use_imagenet_norm=False):
        """Preprocess input images for YOLOv8 classification inference.
        
        Steps:
        1. Parse input source (bytes, file path, ndarray) and convert to RGB.
        2. Resize to target dimension (320x320) matching the fine-tuned model export.
        3. Normalize pixel values to [0.0, 1.0].
        4. Transpose (H, W, C) -> (C, H, W) and expand batch dimension -> (1, C, H, W).
        """
        if isinstance(image_source, bytes):
            img = Image.open(io.BytesIO(image_source)).convert('RGB')
        elif isinstance(image_source, str):
            img = Image.open(image_source).convert('RGB')
        elif isinstance(image_source, np.ndarray):
            if len(image_source.shape) == 3 and image_source.shape[-1] == 3:
                image_source = cv2.cvtColor(image_source, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(image_source)
        else:
            img = Image.fromarray(np.uint8(image_source)).convert('RGB')

        # Resize to target input resolution (320x320)
        img = img.resize(target_size, Image.BILINEAR)
        img_data = np.array(img).astype(np.float32) / 255.0

        # Optional ImageNet standard normalization (mean/std)
        if use_imagenet_norm:
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            img_data = (img_data - mean) / std

        # Transpose (H, W, C) -> (C, H, W) and expand batch dimension -> (1, C, H, W)
        img_data = np.transpose(img_data, (2, 0, 1))
        return np.expand_dims(img_data, axis=0).astype(np.float32)

    @staticmethod
    def _softmax(x):
        """Compute numerically stable softmax probability distribution."""
        e_x = np.exp(x - np.max(x))
        return e_x / e_x.sum(axis=-1, keepdims=True)

    def predict(self, image_source, soil=50.0, temp=25.0, hum=60.0):
        """Execute multimodal inference and cross-domain decision matrix."""
        diagnosis_label = "Uncertain"
        confidence = 0.0

        # Visual inference via fine-tuned YOLOv8 classification (ONNX)
        if self.ort_session:
            try:
                input_data = self.preprocess_image(image_source, target_size=(320, 320), use_imagenet_norm=False)
                input_name = self.ort_session.get_inputs()[0].name
                raw_output = self.ort_session.run(None, {input_name: input_data})[0]

                # Compute class probabilities via Softmax
                logits = raw_output.flatten()
                probs = self._softmax(logits)
                top1_idx = int(np.argmax(probs))
                confidence = float(probs[top1_idx])

                # Confidence threshold filtering and label assignment
                if confidence >= self.conf_threshold and top1_idx < len(self.CLASS_NAMES):
                    diagnosis_label = self.CLASS_NAMES[top1_idx]
                else:
                    diagnosis_label = "Uncertain"

                print(f"[ONNX Vision Diagnosis] Predicted class: {diagnosis_label}", flush=True)

            except Exception as e:
                print(f"[PlantAIEngine Exception] ONNX inference execution failed: {e}", flush=True)
                diagnosis_label = "Uncertain"
        else:
            print("[PlantAIEngine Warning] ort_session is None. Ensure 'best.onnx' is present in the working directory.", flush=True)
            
        # Environmental telemetry evaluation via XGBoost
        health_score = 3.5
        if self.xgb_model:
            try:
                input_features = np.array([[float(soil), float(temp), float(hum)]], dtype=np.float32)
                raw_score = float(self.xgb_model.predict(input_features)[0])
                health_score = round(max(1.0, min(5.0, raw_score)), 1)
                print(f"[XGBoost Evaluation Success] Inputs: ({soil}%, {temp}°C, {hum}%) -> Health Score: {health_score}")
            except Exception as e:
                print(f"[PlantAIEngine Exception] XGBoost regression failed: {e}")
                health_score = 3.5
        else:
            print("[PlantAIEngine Warning] xgb_model is None. Ensure 'tabular_health_scorer.joblib' is present in the working directory.")

        # Cross-domain decision matrix
        action_required = "NORMAL"
        if diagnosis_label == "Yellowing_or_Drying" and soil < 35.0:
            action_required = "PUMP_WATER"
        elif diagnosis_label == "Diseased_or_Blight":
            action_required = "PEST_ALERT"

        return {
            "diagnosis": diagnosis_label,
            "health_score": health_score,
            "action_required": action_required
        }