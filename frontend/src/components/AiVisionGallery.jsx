import io from 'socket.io-client';
import React, { useState, useEffect } from 'react';
import { Camera, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';

const SOCKET_SERVER_URL = import.meta.env.VITE_SOCKET_SERVER_URL || 'http://localhost:5002';
const MINIO_ENDPOINT = import.meta.env.VITE_MINIO_ENDPOINT || 'http://localhost:9000';
const BUCKET_NAME = 'plant-images';

export default function AiVisionGallery({ deviceId = 'esp32_plant_01' }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAiRecords = async () => {
    try {
      let res = await fetch(`${SOCKET_SERVER_URL}/api/ai-analyses?device_id=${deviceId}&limit=3`);
      if (!res.ok) {
        res = await fetch(`${SOCKET_SERVER_URL}/api/ai/recent?device_id=${deviceId}&limit=3`);
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

    // 1. 建立 Socket 監聽
    const socket = io(SOCKET_SERVER_URL);

    // 2. 收到 AI Worker 即時推播時，刷新紀錄
    socket.on('ai_diagnosis_result', (data) => {
      console.log('[React Gallery] 收到 AI 即時推播，刷新紀錄...', data);
      fetchAiRecords();
    });

    const interval = setInterval(fetchAiRecords, 5000);

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, [deviceId]);

  // 補回遺漏的 getImageUrl 函式
  const getImageUrl = (item) => {
    if (!item) return 'https://via.placeholder.com/300x200?text=No+Data';

    // 1. 優先使用全域完整的 HTTP 網址 (來自 Backend / Socket 拼好的完整路徑)
    const fullUrl = item.processed_image_url || item.raw_image_url || item.image_url;
    if (fullUrl && fullUrl.startsWith('http')) {
      return fullUrl;
    }

    // 2. 次要使用純檔名自動拼湊 MinIO 網址
    const imgPath = item.processed_image_path || item.raw_image_path;
    if (imgPath) {
      if (imgPath.startsWith('http')) return imgPath;
      return `${MINIO_ENDPOINT}/${BUCKET_NAME}/${imgPath}`;
    }

    return 'https://via.placeholder.com/300x200?text=No+Image';
  };

  // 解析 Detections 陣列
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

  // 強制切割僅取最新的前 3 筆紀錄
  const displayRecords = records.slice(0, 3);

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

      {displayRecords.length === 0 ? (
        <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 0' }}>
          目前尚無 AI 分析影像紀錄，請按上方按鈕進行拍照診斷
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {displayRecords.map((item, idx) => {
            const imageUrl = getImageUrl(item);
            const detections = parseDetections(item.detections);
            const mainDetection = detections[0] || {};
            
            const diagResult = mainDetection.diagnosis || mainDetection.label || 'Healthy';
            const isHealthy = diagResult === 'Healthy';

            return (
              <div key={idx} style={{ backgroundColor: '#0f172a', borderRadius: '10px', overflow: 'hidden', border: '1px solid #334155' }}>
                <div style={{ position: 'relative', width: '100%', height: '190px', backgroundColor: '#000' }}>
                  <img 
                    src={imageUrl} 
                    alt="AI Diagnostic"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => {
                      console.error("圖片載入失敗:", imageUrl);
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
                        {diagResult}
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