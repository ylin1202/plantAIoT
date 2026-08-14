import os
import io
import cv2
import joblib
import numpy as np
import onnxruntime as ort
from PIL import Image

class PlantAIEngine:
    """生產級 AI 雙引擎微服務類別 (Fine-tuned YOLOv8 Classification + XGBoost)"""

    CLASS_NAMES = ['Background', 'Diseased_or_Blight', 'Healthy', 'Yellowing_or_Drying']

    def __init__(self, vision_model_path='best.onnx', tabular_model_path='tabular_health_scorer.joblib', conf_threshold=0.5):
        self.vision_model_path = vision_model_path
        self.tabular_model_path = tabular_model_path
        self.conf_threshold = conf_threshold
        
        self.ort_session = self._load_onnx_model()
        self.xgb_model = self._load_xgb_model()

    def _load_onnx_model(self):
        """載入 ONNX Runtime Session"""
        try:
            if not os.path.exists(self.vision_model_path):
                print(f"[PlantAIEngine Error] ONNX 檔案不存在: [{self.vision_model_path}]")
                return None
            session = ort.InferenceSession(self.vision_model_path, providers=['CPUExecutionProvider'])
            print(f"[PlantAIEngine] ONNX Runtime Session 載入成功: [{self.vision_model_path}]")
            return session
        except Exception as e:
            print(f"[PlantAIEngine] ONNX 載入失敗: {e}")
            return None

    def _load_xgb_model(self):
        """載入 XGBoost 模型"""
        try:
            if not os.path.exists(self.tabular_model_path):
                print(f"[PlantAIEngine Error] XGBoost 檔案不存在: [{self.tabular_model_path}]")
                return None
            model = joblib.load(self.tabular_model_path)
            print(f"[PlantAIEngine] XGBoost 模型載入成功: [{self.tabular_model_path}]")
            return model
        except Exception as e:
            print(f"[PlantAIEngine] XGBoost 載入失敗: {e}")
            return None

    def preprocess_image(self, image_source, target_size=(320, 320), use_imagenet_norm=False):
        """
        YOLOv8 Classification 前處理：
        1. 格式相容性轉換與 Resize 至 320x320
        2. RGB 轉換與 [0, 1] 歸一化
        3. 擴展 Batch 維度 -> (1, C, H, W)
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

        # 1. Resize 至模型的 320x320 尺寸
        img = img.resize(target_size, Image.BILINEAR)
        img_data = np.array(img).astype(np.float32) / 255.0

        # 2. 標準化（若訓練時未特製 transform，YOLOv8 預設不需 ImageNet mean/std）
        if use_imagenet_norm:
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            img_data = (img_data - mean) / std

        # 3. Transpose (H, W, C) -> (C, H, W) 並擴展 Batch 維度 -> (1, C, H, W)
        img_data = np.transpose(img_data, (2, 0, 1))
        return np.expand_dims(img_data, axis=0).astype(np.float32)

    @staticmethod
    def _softmax(x):
        """計算 Softmax 機率分佈"""
        e_x = np.exp(x - np.max(x))
        return e_x / e_x.sum(axis=-1, keepdims=True)

    def predict(self, image_source, soil=50.0, temp=25.0, hum=60.0):
        """執行 AI 雙引擎多模態預估與交叉決策"""
        diagnosis_label = "Uncertain"
        confidence = 0.0

        # 1. ONNX 視覺推論 (YOLOv8 Fine-tuned Classification)
        if self.ort_session:
            try:
                input_data = self.preprocess_image(image_source, target_size=(320, 320), use_imagenet_norm=False)
                input_name = self.ort_session.get_inputs()[0].name
                raw_output = self.ort_session.run(None, {input_name: input_data})[0]

                # 計算機率分佈
                logits = raw_output.flatten()
                probs = self._softmax(logits)
                top1_idx = int(np.argmax(probs))
                confidence = float(probs[top1_idx])

                # 閾值過濾與標籤判定
                if confidence >= self.conf_threshold and top1_idx < len(self.CLASS_NAMES):
                    diagnosis_label = self.CLASS_NAMES[top1_idx]
                else:
                    diagnosis_label = "Uncertain"

                print(f"[ONNX 視覺診斷] 預測類別: {diagnosis_label} (置信度: {confidence:.2%})", flush=True)

            except Exception as e:
                print(f"[PlantAIEngine Exception] ONNX 推論失敗: {e}", flush=True)
                diagnosis_label = "Uncertain"
        else:
            print("[PlantAIEngine Warning] ort_session 為 None！", flush=True)
            
        # 2. XGBoost 環境數據評估
        health_score = 3.5
        if self.xgb_model:
            try:
                input_features = np.array([[float(soil), float(temp), float(hum)]], dtype=np.float32)
                raw_score = float(self.xgb_model.predict(input_features)[0])
                health_score = round(max(1.0, min(5.0, raw_score)), 1)
                print(f"[XGBoost 推論成功] 輸入: ({soil}%, {temp}°C, {hum}%) -> 評分: {health_score}")
            except Exception as e:
                print(f"[PlantAIEngine Exception] XGBoost 評估失敗: {e}")
                health_score = 3.5
        else:
            print("[PlantAIEngine Warning] xgb_model 為 None！")

        # 3. 交叉決策矩陣
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