// server.js
const express = require('express');
const mqtt = require('mqtt');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

// 1. 初始化 TimescaleDB (PostgreSQL) 連線池
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

// 2. 連接 MQTT Broker
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);

mqttClient.on('connect', () => {
  console.log('✅ 成功連接 EMQX MQTT Broker！');
  // 訂閱所有租戶與裝置的 Telemetry 主題
  // 通配符: + 代表單層層級
  mqttClient.subscribe('tenants/+/devices/+/telemetry', (err) => {
    if (!err) console.log('📡 已成功訂閱 MQTT 主題: tenants/+/devices/+/telemetry');
  });
});

// 3. 處理接收到的 MQTT 訊息並寫入 TimescaleDB
mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const { device_id, timestamp, soil_moisture, temperature, humidity, light_lux, water_level } = payload;

    const recordTime = timestamp ? new Date(timestamp) : new Date();

    // 寫入 TimescaleDB (帶有冪等性與時間戳記)
    const query = `
      INSERT INTO sensor_telemetry (time, device_id, soil_moisture, temperature, humidity, light_lux, water_level)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (time, device_id) DO NOTHING;
    `;

    await dbPool.query(query, [
      recordTime,
      device_id,
      soil_moisture,
      temperature,
      humidity,
      light_lux,
      water_level
    ]);

    console.log(`[MQTT Ingest] 📥 裝置 ${device_id} 數據已寫入 DB: 土壤濕度 ${soil_moisture}%`);
  } catch (err) {
    console.error('❌ 數據解析或寫入失敗:', err.message);
  }
});

// 4. 基礎 Health Check API
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動於 http://localhost:${PORT}`);
});