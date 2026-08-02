// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// 1. 全局第一層 CORS 牆 (解決所有 HTTP REST API 跨域)
app.use(cors({
  origin: true, // 自動跟隨請求來源
  credentials: true
}));

// 手動再補一層 Header 確保萬無一失
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.use(express.json());

const server = http.createServer(app);

// 2. Socket.io 專用 CORS 與 Transport 設定
const io = new Server(server, {
  cors: {
    origin: "*", // 放行所有來源 (包含 5173, 5174)
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true // 相容舊版 Engine.IO 握手
});

// 3. TimescaleDB 連線
const dbPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

dbPool.connect((err) => {
  if (err) console.error('❌ DB 連線失敗:', err.stack);
  else console.log('✅ TimescaleDB 連線成功！(Port: 5433)');
});

// 4. MQTT Broker 連線
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);

mqttClient.on('connect', () => {
  console.log('✅ 成功連接 EMQX MQTT Broker！');
  mqttClient.subscribe('tenants/+/devices/+/telemetry');
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const { device_id, timestamp, soil_moisture, temperature, humidity, light_lux, water_level } = payload;
    const recordTime = timestamp ? new Date(timestamp) : new Date();

    const query = `
      INSERT INTO sensor_telemetry (time, device_id, soil_moisture, temperature, humidity, light_lux, water_level)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (time, device_id) DO NOTHING;
    `;
    await dbPool.query(query, [recordTime, device_id, soil_moisture, temperature, humidity, light_lux, water_level]);

    // 即時推播給 React 前端
    io.emit('telemetry_update', {
      time: recordTime,
      device_id,
      soil_moisture,
      temperature,
      humidity,
      light_lux,
      water_level
    });

    console.log(`[MQTT Ingest & Broadcast] 📡 裝置 ${device_id} 數據已推播! Soil: ${soil_moisture}%`);
  } catch (err) {
    console.error('❌ 處理失敗:', err.message);
  }
});

// REST API: 撈取歷史數據
app.get('/api/telemetry/recent', async (req, res) => {
  try {
    const deviceId = req.query.device_id || 'esp32_plant_01';
    const query = `
      SELECT time, soil_moisture, temperature, humidity, light_lux, water_level
      FROM sensor_telemetry
      WHERE device_id = $1
      ORDER BY time DESC
      LIMIT 50;
    `;
    const result = await dbPool.query(query, [deviceId]);
    res.json(result.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log(`🔌 Web 儀表板已成功連線！Socket ID: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`❌ Web 儀表板已斷線: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動於 http://localhost:${PORT}`);
});
