import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { Droplets, Thermometer, Sun, Gauge, Activity, Play, CheckCircle2, AlertTriangle, Camera } from 'lucide-react';

import AiVisionGallery from './components/AiVisionGallery';

const SOCKET_SERVER_URL = import.meta.env.VITE_SOCKET_SERVER_URL || 'http://localhost:5002';

export default function App() {
  const [telemetryHistory, setTelemetryHistory] = useState([]);
  const [latestData, setLatestData] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  
  // Day 6 控制與 Log 狀態
  const [actuationLogs, setActuationLogs] = useState([]);
  const [isWatering, setIsWatering] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [controlMessage, setControlMessage] = useState(null);

  // 載入致動日誌
  const fetchControlLogs = async () => {
    try {
      const res = await axios.get(`${SOCKET_SERVER_URL}/api/control/logs`);
      setActuationLogs(res.data);
    } catch (err) {
      console.error("無法載入控制日誌:", err);
    }
  };

  useEffect(() => {
    // 1. 抓取歷史數據與控制日誌
    axios.get(`${SOCKET_SERVER_URL}/api/telemetry/recent?device_id=esp32_plant_01`)
      .then(res => {
        const formatted = res.data.map(d => ({
          ...d,
          formattedTime: new Date(d.time).toLocaleTimeString()
        }));
        setTelemetryHistory(formatted);
        if (formatted.length > 0) setLatestData(formatted[formatted.length - 1]);
      })
      .catch(err => console.error("無法抓取歷史數據:", err));

    fetchControlLogs();

    // 2. 建立 Socket.io 即時連線
    const socket = io(SOCKET_SERVER_URL);

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    // 監聽即時 Telemetry 數據
    socket.on('telemetry_update', (data) => {
      const formattedItem = {
        ...data,
        formattedTime: new Date(data.time).toLocaleTimeString()
      };

      setLatestData(formattedItem);
      setTelemetryHistory(prev => {
        const updated = [...prev, formattedItem];
        if (updated.length > 30) updated.shift();
        return updated;
      });
    });

    // 監聽最新致動 Log
    socket.on('new_actuation_log', (log) => {
      setActuationLogs(prev => [log, ...prev.slice(0, 9)]);
    });

    return () => socket.disconnect();
  }, []);

  // 觸發遠端澆水
  const handleWatering = async (durationSec = 3) => {
    setIsWatering(true);
    setControlMessage(null);
    try {
      const res = await axios.post(`${SOCKET_SERVER_URL}/api/control/water`, {
        device_id: 'esp32_plant_01',
        tenant_id: 'demo_tenant',
        duration_sec: durationSec
      });
      setControlMessage({ type: 'success', text: res.data.message });
    } catch (err) {
      const errorMsg = err.response?.data?.message || '澆水指令發送失敗';
      setControlMessage({ type: 'error', text: errorMsg });
    } finally {
      setIsWatering(false);
    }
  };

  // 觸發手動拍照診斷
  const handleCameraCapture = async () => {
    setIsCapturing(true);
    setControlMessage(null);
    try {
      const res = await axios.post(`${SOCKET_SERVER_URL}/api/camera/capture`);
      if (res.data.success) {
        setControlMessage({ type: 'success', text: '📸 拍照指令已下達！ESP32-CAM 拍攝與 AI 分析中...' });
      }
    } catch (err) {
      console.error("❌ 拍照 API 呼叫失敗:", err);
      const errorMsg = err.response?.data?.error || '拍照指令發送失敗';
      setControlMessage({ type: 'error', text: errorMsg });
    } finally {
      setIsCapturing(false);
    }
  };

  return (
    <div style={{ padding: '24px', backgroundColor: '#0f172a', minHeight: '100vh', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      {/* 頁首 Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px', borderBottom: '1px solid #334155', paddingBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 'bold', margin: '0 0 8px 0', color: '#38bdf8' }}>
            🌱 AIoT 智慧植物時序監控平台
          </h1>
          <p style={{ margin: 0, color: '#94a3b8', fontSize: '14px' }}>
            Device ID: <span style={{ color: '#f1f5f9', fontWeight: '600' }}>esp32_plant_01</span>
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#1e293b', padding: '8px 16px', borderRadius: '20px' }}>
          <Activity size={18} color={isConnected ? '#22c55e' : '#ef4444'} />
          <span style={{ fontSize: '14px', color: isConnected ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
            {isConnected ? '即時串流中 (Live)' : '離線 (Offline)'}
          </span>
        </div>
      </header>

      {/* 4 大即時指標卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#38bdf8', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>土壤濕度</span>
            <Droplets size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.soil_moisture}%` : '--'}
          </div>
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f43f5e', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>環境溫度</span>
            <Thermometer size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.temperature} °C` : '--'}
          </div>
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#eab308', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>光照強度</span>
            <Sun size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.light_lux} Lux` : '--'}
          </div>
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a855f7', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>水箱水量</span>
            <Gauge size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.water_level}%` : '--'}
          </div>
        </div>
      </div>

      {/* 遠端致動控制與紀錄區域 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        {/* 控制卡片 */}
        <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Droplets color="#38bdf8" size={20} /> 遠端致動控制 (MQTT Downlink)
          </h3>
          <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '20px' }}>
            可手動下達澆水指令至 ESP32 裝置或驅動 ESP32-CAM 手動拍照 AI 診斷。
          </p>

          <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <button
              onClick={() => handleWatering(3)}
              disabled={isWatering}
              style={{
                flex: 1,
                minWidth: '110px',
                padding: '12px',
                backgroundColor: '#0284c7',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              <Play size={16} /> 澆水 3 秒
            </button>
            <button
              onClick={() => handleWatering(5)}
              disabled={isWatering}
              style={{
                flex: 1,
                minWidth: '110px',
                padding: '12px',
                backgroundColor: '#0369a1',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              <Play size={16} /> 澆水 5 秒
            </button>
            <button
              onClick={handleCameraCapture}
              disabled={isCapturing}
              style={{
                flex: 1,
                minWidth: '130px',
                padding: '12px',
                backgroundColor: '#6366f1',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              <Camera size={16} /> 拍照 AI 診斷
            </button>
          </div>

          {controlMessage && (
            <div style={{
              padding: '10px 14px',
              borderRadius: '8px',
              fontSize: '14px',
              backgroundColor: controlMessage.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: controlMessage.type === 'success' ? '#4ade80' : '#fca5a5',
              border: `1px solid ${controlMessage.type === 'success' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              {controlMessage.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              {controlMessage.text}
            </div>
          )}
        </div>

        {/* 控制日誌 Log 面板 */}
        <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: '#f8fafc' }}>
            📋 致動歷史紀錄 (Actuation Logs)
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
            {actuationLogs.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '14px' }}>目前尚無致動紀錄</div>
            ) : (
              actuationLogs.map((log, idx) => (
                <div key={idx} style={{
                  display: 'flex',
                  justify: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  backgroundColor: '#0f172a',
                  borderRadius: '6px',
                  border: '1px solid #334155',
                  fontSize: '13px'
                }}>
                  <div>
                    <span style={{ color: '#f8fafc', fontWeight: '500' }}>{log.action_type}</span>
                    <span style={{ color: '#64748b', marginLeft: '8px' }}>({log.duration_sec}s)</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      backgroundColor: log.status === 'SUCCESS' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: log.status === 'SUCCESS' ? '#4ade80' : '#fca5a5'
                    }}>
                      {log.status}
                    </span>
                    <span style={{ color: '#64748b', fontSize: '11px' }}>
                      {new Date(log.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 時序趨勢圖表 */}
      <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
        <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: '#f8fafc' }}>📈 即時土壤與溫度變化趨勢 (TimescaleDB Real-time Stream)</h3>
        <div style={{ width: '100%', height: '350px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={telemetryHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="formattedTime" stroke="#94a3b8" />
              <YAxis yAxisId="left" stroke="#38bdf8" domain={[0, 100]} label={{ value: '濕度 (%)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
              <YAxis yAxisId="right" orientation="right" stroke="#f43f5e" domain={[0, 50]} label={{ value: '溫度 (°C)', angle: 90, position: 'insideRight', fill: '#f43f5e' }} />
              <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f8fafc' }} />
              <Legend />
              <Line yAxisId="left" type="monotone" dataKey="soil_moisture" name="土壤濕度 (%)" stroke="#38bdf8" strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line yAxisId="right" type="monotone" dataKey="temperature" name="環境溫度 (°C)" stroke="#f43f5e" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* AI 診斷畫廊 */}
      <AiVisionGallery deviceId="esp32_plant_01" />
    </div>
  );
}