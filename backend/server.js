// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// 引入 BullMQ 佇列模組
const { telemetryQueue, initTelemetryWorker } = require('./queue');

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  allowEIO3: true
});

// TimescaleDB 連線池
const dbPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

dbPool.connect((err) => {
  if (err) console.error('❌ DB 連線失敗:', err.stack);
  else console.log('✅ TimescaleDB 連线成功！(Port: 5433)');
});

// 啟動 BullMQ Worker 處理佇列資料
initTelemetryWorker(dbPool, io);

// MQTT Client
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);

mqttClient.on('connect', () => {
  console.log('✅ 成功連接 EMQX MQTT Broker！');
  mqttClient.subscribe('tenants/+/devices/+/telemetry');
});

// MQTT 收到訊息：不再直接寫 DB，而是 Push 進 BullMQ 佇列
mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    // 將數據推入 BullMQ 佇列 (Job)
    await telemetryQueue.add('process_telemetry', payload, {
      attempts: 3, // 若失敗自動重試 3 次
      backoff: 1000, // 每次重試間隔 1 秒
      removeOnComplete: true, // 處理完自動刪除 Log 節省記憶體
    });

    console.log(`[MQTT -> Queue] 📥 數據已推入 BullMQ 佇列 (Device: ${payload.device_id})`);
  } catch (err) {
    console.error('❌ 進入佇列失敗:', err.message);
  }
});

// REST API
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
  console.log(`🔌 Web 儀表板已連線: ${socket.id}`);
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動於 http://localhost:${PORT}`);
});