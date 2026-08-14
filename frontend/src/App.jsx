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
  
  // Actuation control and log state
  const [actuationLogs, setActuationLogs] = useState([]);
  const [isWatering, setIsWatering] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [controlMessage, setControlMessage] = useState(null);

  // Fetch recent actuation control logs
  const fetchControlLogs = async () => {
    try {
      const res = await axios.get(`${SOCKET_SERVER_URL}/api/control/logs`);
      setActuationLogs(res.data);
    } catch (err) {
      console.error("Failed to load control logs:", err);
    }
  };

  useEffect(() => {
    // Fetch initial telemetry history and actuation logs
    axios.get(`${SOCKET_SERVER_URL}/api/telemetry/recent?device_id=esp32_plant_01`)
      .then(res => {
        const formatted = res.data.map(d => ({
          ...d,
          formattedTime: new Date(d.time).toLocaleTimeString()
        }));
        setTelemetryHistory(formatted);
        if (formatted.length > 0) setLatestData(formatted[formatted.length - 1]);
      })
      .catch(err => console.error("Failed to fetch historical telemetry data:", err));

    fetchControlLogs();

    // Establish real-time Socket.IO connection
    const socket = io(SOCKET_SERVER_URL);

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    // Listen for real-time telemetry updates
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

    // Listen for incoming actuation logs
    socket.on('new_actuation_log', (log) => {
      setActuationLogs(prev => [log, ...prev.slice(0, 9)]);
    });

    return () => socket.disconnect();
  }, []);

  // Trigger remote watering command via MQTT downlink
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
      const errorMsg = err.response?.data?.message || 'Failed to dispatch watering command.';
      setControlMessage({ type: 'error', text: errorMsg });
    } finally {
      setIsWatering(false);
    }
  };

  // Trigger manual camera capture and AI diagnosis pipeline
  const handleCameraCapture = async () => {
    setIsCapturing(true);
    setControlMessage(null);
    try {
      const res = await axios.post(`${SOCKET_SERVER_URL}/api/camera/capture`);
      if (res.data.success) {
        setControlMessage({ type: 'success', text: 'Capture command sent! ESP32-CAM capturing & AI processing...' });
      }
    } catch (err) {
      console.error("Camera API execution failed:", err);
      const errorMsg = err.response?.data?.error || 'Failed to dispatch camera capture command.';
      setControlMessage({ type: 'error', text: errorMsg });
    } finally {
      setIsCapturing(false);
    }
  };

  return (
    <div style={{ padding: '24px', backgroundColor: '#0f172a', minHeight: '100vh', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px', borderBottom: '1px solid #334155', paddingBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 'bold', margin: '0 0 8px 0', color: '#38bdf8' }}>
            🌱 AIoT Smart Plant Monitoring Platform
          </h1>
          <p style={{ margin: 0, color: '#94a3b8', fontSize: '14px' }}>
            Device ID: <span style={{ color: '#f1f5f9', fontWeight: '600' }}>esp32_plant_01</span>
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#1e293b', padding: '8px 16px', borderRadius: '20px' }}>
          <Activity size={18} color={isConnected ? '#22c55e' : '#ef4444'} />
          <span style={{ fontSize: '14px', color: isConnected ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
            {isConnected ? 'Live Streaming' : 'Offline'}
          </span>
        </div>
      </header>

      {/* 4 Core Real-Time Metric Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#38bdf8', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>Soil Moisture</span>
            <Droplets size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.soil_moisture}%` : '--'}
          </div>
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f43f5e', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>Temperature</span>
            <Thermometer size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.temperature} °C` : '--'}
          </div>
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#eab308', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>Light Intensity</span>
            <Sun size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.light_lux} Lux` : '--'}
          </div>
        </div>

        <div style={{ backgroundColor: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a855f7', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', color: '#94a3b8' }}>Water Level</span>
            <Gauge size={20} />
          </div>
          <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#f8fafc' }}>
            {latestData ? `${latestData.water_level}%` : '--'}
          </div>
        </div>
      </div>

      {/* Remote Control & Actuation Logs Section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        {/* Actuation Control Card */}
        <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Droplets color="#38bdf8" size={20} /> Remote Actuation Control (MQTT Downlink)
          </h3>
          <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '20px' }}>
            Manually trigger irrigation commands or capture camera snapshots for AI diagnostics.
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
              <Play size={16} /> Water 3s
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
              <Play size={16} /> Water 5s
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
              <Camera size={16} /> Snapshot & AI
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

        {/* Actuation Logs Card */}
        <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: '#f8fafc' }}>
            📋 Actuation Logs
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
            {actuationLogs.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '14px' }}>No actuation logs recorded yet.</div>
            ) : (
              actuationLogs.map((log, idx) => (
                <div key={idx} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
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

      {/* Real-Time Telemetry Trend Chart */}
      <div style={{ backgroundColor: '#1e293b', padding: '24px', borderRadius: '12px', border: '1px solid #334155' }}>
        <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', color: '#f8fafc' }}>📈 Real-Time Soil & Temperature Telemetry (TimescaleDB Stream)</h3>
        <div style={{ width: '100%', height: '350px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={telemetryHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="formattedTime" stroke="#94a3b8" />
              <YAxis yAxisId="left" stroke="#38bdf8" domain={[0, 100]} label={{ value: 'Moisture (%)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
              <YAxis yAxisId="right" orientation="right" stroke="#f43f5e" domain={[0, 50]} label={{ value: 'Temperature (°C)', angle: 90, position: 'insideRight', fill: '#f43f5e' }} />
              <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f8fafc' }} />
              <Legend />
              <Line yAxisId="left" type="monotone" dataKey="soil_moisture" name="Soil Moisture (%)" stroke="#38bdf8" strokeWidth={3} dot={false} isAnimationActive={false} />
              <Line yAxisId="right" type="monotone" dataKey="temperature" name="Temperature (°C)" stroke="#f43f5e" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* AI Diagnostic Gallery */}
      <AiVisionGallery deviceId="esp32_plant_01" />
    </div>
  );
}