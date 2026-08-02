import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { Droplets, Thermometer, Sun, Gauge, Activity, AlertTriangle } from 'lucide-react';

const SOCKET_SERVER_URL = import.meta.env.VITE_SOCKET_SERVER_URL || 'http://localhost:5001';

export default function App() {
  const [telemetryHistory, setTelemetryHistory] = useState([]);
  const [latestData, setLatestData] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // 1. 先抓取最近歷史數據初始化圖表
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

    // 2. 建立 Socket.io 即時連線
    const socket = io(SOCKET_SERVER_URL);

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    // 3. 監聽即時數據推播
    socket.on('telemetry_update', (data) => {
      const formattedItem = {
        ...data,
        formattedTime: new Date(data.time).toLocaleTimeString()
      };

      setLatestData(formattedItem);
      setTelemetryHistory(prev => {
        const updated = [...prev, formattedItem];
        if (updated.length > 30) updated.shift(); // 維持最新 30 筆數據滑動
        return updated;
      });
    });

    return () => socket.disconnect();
  }, []);

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

        {/* 連線狀態標籤 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#1e293b', padding: '8px 16px', borderRadius: '20px' }}>
          <Activity size={18} color={isConnected ? '#22c55e' : '#ef4444'} />
          <span style={{ fontSize: '14px', color: isConnected ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
            {isConnected ? '即時串流中 (Live)' : '離線 (Offline)'}
          </span>
        </div>
      </header>

      {/* 4 大即時指標卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        
        {/* 土壤濕度 */}
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#38bdf8', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>土壤濕度</span>
            <Droplets size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.soil_moisture}%` : '--'}
          </div>
        </div>

        {/* 環境溫度 */}
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f43f5e', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>環境溫度</span>
            <Thermometer size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.temperature} °C` : '--'}
          </div>
        </div>

        {/* 光照強度 */}
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#eab308', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>光照強度</span>
            <Sun size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.light_lux} Lux` : '--'}
          </div>
        </div>

        {/* 水箱水位 */}
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
    </div>
  );
}