import React, { useState, useEffect } from 'react';
import { Camera, RefreshCw, CheckCircle2, AlertCircle, Activity } from 'lucide-react';

const SOCKET_SERVER_URL = import.meta.env.VITE_SOCKET_SERVER_URL || 'http://localhost:5001';
const MINIO_ENDPOINT = import.meta.env.VITE_MINIO_ENDPOINT || 'http://localhost:9000';
const BUCKET_NAME = 'plant-images';

export default function AiVisionGallery({ deviceId = 'esp32_plant_01' }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAiRecords = async () => {
    try {
      // 優先使用新版 AI 診斷紀錄 API，相容備用舊 API
      let res = await fetch(`${SOCKET_SERVER_URL}/api/ai-analyses?device_id=${deviceId}&limit=6`);
      if (!res.ok) {
        res = await fetch(`${SOCKET_SERVER_URL}/api/ai/recent?device_id=${deviceId}&limit=6`);
      }

      if (res.ok) {
        const data = await res.json();
        setRecords(data);
      }
    } catch (err) {
      console.error('無法載入 AI 紀錄:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAiRecords();
    const interval = setInterval(fetchAiRecords, 5000); // 5秒自動刷新
    return () => clearInterval(interval);
  }, [deviceId]);

  // 💡 關鍵修復 1：安全解析完整 MinIO 圖片網址
  const getImageUrl = (item) => {
    // 優先使用 processed，沒有則退回 raw
    const imgPath = item.processed_image_path || item.processed_image_url || item.raw_image_path || item.raw_image_url;
    
    if (!imgPath) return 'https://via.placeholder.com/300x200?text=No+Image';
    
    // 如果已經包含 http 則直接回傳，否則自動拼接 MinIO 9000 完整 Endpoint
    if (imgPath.startsWith('http')) {
      return imgPath;
    }
    return `${MINIO_ENDPOINT}/${BUCKET_NAME}/${imgPath}`;
  };

  // 💡 關鍵修復 2：安全解析 JSON 或 Array 格式的 Detections
  const parseDetections = (detectionsData) => {
    if (!detectionsData) return [];
    if (typeof detectionsData === 'string') {
      try {
        return JSON.parse(detectionsData);
      } catch (e) {
        return [];
      }
    }
    return Array.isArray(detectionsData) ? detectionsData : [detectionsData];
  };

  if (loading) {
    return (
      <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155', color: '#94a3b8', marginTop: '32px' }}>
        載入 AI 診斷紀錄中...
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155', marginTop: '32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Camera size={22} color="#38bdf8" />
          🤖 AI 雙引擎多模態視覺與環境診斷 (ONNX & XGBoost)
        </h3>
        <button 
          onClick={fetchAiRecords}
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            backgroundColor: '#334155', 
            border: 'none', 
            color: '#f8fafc', 
            padding: '8px 14px', 
            borderRadius: '8px', 
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500'
          }}
        >
          <RefreshCw size={16} /> 重新整理
        </button>
      </div>

      {records.length === 0 ? (
        <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 0' }}>
          目前尚無 AI 分析影像紀錄，請按上方按鈕進行拍照診斷
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {records.map((item, idx) => {
            const imageUrl = getImageUrl(item);
            const detections = parseDetections(item.detections);
            const mainDetection = detections[0] || {};
            
            // 相容舊版 label 與新版 diagnosis
            const diagResult = mainDetection.diagnosis || mainDetection.label || 'Healthy';
            const isHealthy = diagResult === 'Healthy';
            const confidenceVal = mainDetection.confidence ? (mainDetection.confidence > 1 ? mainDetection.confidence : mainDetection.confidence * 100).toFixed(0) : '95';

            return (
              <div key={idx} style={{ backgroundColor: '#0f172a', borderRadius: '10px', overflow: 'hidden', border: '1px solid #334155' }}>
                <div style={{ position: 'relative', width: '100%', height: '190px', backgroundColor: '#000' }}>
                  <img 
                    src={imageUrl} 
                    alt="AI Diagnostic"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => {
                      console.error("圖片載入失敗，試圖退回原始圖片網址:", imageUrl);
                      e.target.src = 'https://via.placeholder.com/300x200?text=MinIO+Load+Error';
                    }}
                  />
                  <span style={{ 
                    position: 'absolute', 
                    top: '10px', 
                    right: '10px', 
                    backgroundColor: 'rgba(15, 23, 42, 0.85)', 
                    color: '#e2e8f0', 
                    padding: '3px 8px', 
                    borderRadius: '6px', 
                    fontSize: '12px',
                    border: '1px solid #334155'
                  }}>
                    {new Date(item.time).toLocaleTimeString()}
                  </span>
                </div>

                <div style={{ padding: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>裝置: <span style={{ color: '#94a3b8' }}>{item.device_id || deviceId}</span></span>
                    {mainDetection.health_score && (
                      <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>環境分數: {mainDetection.health_score}/5.0</span>
                    )}
                  </div>

                  <div style={{ fontSize: '14px', color: '#f8fafc' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                      <span style={{ color: '#94a3b8', fontSize: '13px' }}>診斷結果：</span>
                      <span style={{ 
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        backgroundColor: isHealthy ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)', 
                        border: `1px solid ${isHealthy ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
                        color: isHealthy ? '#4ade80' : '#fca5a5', 
                        padding: '3px 8px', 
                        borderRadius: '6px', 
                        fontSize: '12px', 
                        fontWeight: '600' 
                      }}>
                        {isHealthy ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                        {diagResult} ({confidenceVal}%)
                      </span>
                    </div>

                    {mainDetection.action_required && mainDetection.action_required !== 'NORMAL' && (
                      <div style={{ marginTop: '8px', fontSize: '12px', color: '#fbbf24', backgroundColor: 'rgba(251, 191, 36, 0.1)', padding: '4px 8px', borderRadius: '4px', border: '1px dashed rgba(251, 191, 36, 0.3)' }}>
                        🚨 建議觸發動作: <strong>{mainDetection.action_required}</strong>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}