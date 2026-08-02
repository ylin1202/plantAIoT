import React, { useState, useEffect } from 'react';
import { Camera, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';

const SOCKET_SERVER_URL = import.meta.env.VITE_SOCKET_SERVER_URL || 'http://localhost:5001';

export default function AiVisionGallery({ deviceId = 'esp32_cam_01' }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAiRecords = async () => {
    try {
      const res = await fetch(`${SOCKET_SERVER_URL}/api/ai/recent?device_id=${deviceId}&limit=6`);
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
    const interval = setInterval(fetchAiRecords, 10000); // 10秒自動刷新
    return () => clearInterval(interval);
  }, [deviceId]);

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
          🤖 AI 葉片病害與物件診斷紀錄 (YOLOv8 & MinIO)
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
          目前尚無 AI 分析影像紀錄
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {records.map((item, idx) => (
            <div key={idx} style={{ backgroundColor: '#0f172a', borderRadius: '10px', overflow: 'hidden', border: '1px solid #334155' }}>
              <div style={{ position: 'relative', width: '100%', height: '190px', backgroundColor: '#000' }}>
                <img 
                  src={item.processed_image_url} 
                  alt="AI Diagnostic"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => {
                    e.target.src = item.raw_image_url;
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
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>
                  裝置: <span style={{ color: '#94a3b8' }}>{item.device_id}</span>
                </div>

                <div style={{ fontSize: '14px', color: '#f8fafc' }}>
                  <span style={{ color: '#94a3b8', fontSize: '13px' }}>診斷結果：</span>
                  {item.detections && item.detections.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                      {item.detections.map((d, dIdx) => (
                        <span key={dIdx} style={{ 
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          backgroundColor: 'rgba(239, 68, 68, 0.15)', 
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          color: '#fca5a5', 
                          padding: '3px 8px', 
                          borderRadius: '6px', 
                          fontSize: '12px', 
                          fontWeight: '600' 
                        }}>
                          <AlertCircle size={12} /> {d.label} ({(d.confidence * 100).toFixed(0)}%)
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px', color: '#4ade80', fontSize: '13px', fontWeight: '600' }}>
                      <CheckCircle2 size={16} /> 正常 / 未發現異常
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}