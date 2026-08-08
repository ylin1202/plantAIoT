const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// 引入 BullMQ 佇列模組
const { telemetryQueue, initTelemetryWorker } = require('./queue');

// Telegram
const { checkAndTriggerAlert, initBotPolling } = require('./telegram');

const app = express();

// CORS 設定
app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
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
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'aiot_user',
  password: process.env.DB_PASSWORD || 'aiot_password',
  database: process.env.DB_NAME || 'aiot_db',
});

// 初始化 DB 並自動建立 actuation_logs 表
dbPool.connect(async (err, client, release) => {
  if (err) {
    console.error('❌ DB 連線失敗:', err.stack);
  } else {
    console.log('✅ TimescaleDB 連線成功！');
    try {
      // 自動建表以防控制 API 報錯
      await client.query(`
        CREATE TABLE IF NOT EXISTS actuation_logs (
          id SERIAL PRIMARY KEY,
          device_id VARCHAR(50) NOT NULL,
          action_type VARCHAR(50) NOT NULL,
          duration_sec INT NOT NULL,
          status VARCHAR(50) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ 檢查/建立 actuation_logs 資料表完成！');
    } catch (tableErr) {
      console.error('❌ 自動建表失敗:', tableErr.message);
    } finally {
      release();
    }
  }
});

// MQTT Client 連線
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883');

mqttClient.on('connect', () => {
  console.log('✅ 成功連接 EMQX MQTT Broker！');
  mqttClient.subscribe('tenants/+/devices/+/telemetry');
});

// MQTT 收到 telemetry 訊息：Push 進 BullMQ 佇列
mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    // 1. 推入 BullMQ 佇列
    await telemetryQueue.add('process_telemetry', payload, {
      attempts: 3,
      backoff: 1000,
      removeOnComplete: true,
    });

    // 2. Telegram 缺水/低水位異常主動告警檢查
    checkAndTriggerAlert(payload);

  } catch (err) {
    console.error('❌ 處理 MQTT 訊息失敗:', err.message);
  }
});

// ==================== REST APIs ====================

// 1. GET /api/telemetry/recent
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

// 2. GET /api/telemetry/history (多時段降採樣歷史數據 API)
app.get('/api/telemetry/history', async (req, res) => {
  const { range = '24h', device_id = 'esp32_plant_01' } = req.query;
  
  try {
    let query = '';
    if (range === '24h') {
      // 24小時：撈取原始細粒度數據 (最新 100 筆)
      query = `SELECT time, soil_moisture, temperature, humidity, light_lux, water_level 
               FROM sensor_telemetry WHERE device_id = $1 ORDER BY time DESC LIMIT 100`;
    } else if (range === '7d') {
      // 7天：撈取 TimescaleDB Continuous Aggregation 每小時平均值
      query = `SELECT bucket AS time, avg_soil_moisture AS soil_moisture, avg_temperature AS temperature, 
                      avg_humidity AS humidity, avg_light_lux AS light_lux, avg_water_level AS water_level 
               FROM sensor_telemetry_hourly WHERE device_id = $1 AND bucket >= NOW() - INTERVAL '7 days' ORDER BY bucket ASC`;
    } else if (range === '30d') {
      // 30天：撈取 TimescaleDB Continuous Aggregation 每小時平均值
      query = `SELECT bucket AS time, avg_soil_moisture AS soil_moisture, avg_temperature AS temperature, 
                      avg_humidity AS humidity, avg_light_lux AS light_lux, avg_water_level AS water_level 
               FROM sensor_telemetry_hourly WHERE device_id = $1 AND bucket >= NOW() - INTERVAL '30 days' ORDER BY bucket ASC`;
    }

    const dbRes = await dbPool.query(query, [device_id]);
    res.json({ success: true, data: dbRes.rows });
  } catch (err) {
    console.error('❌ 撈取歷史數據失敗:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. GET /api/ai/recent (撈取最新 AI 診斷紀錄)
app.get('/api/ai/recent', async (req, res) => {
  try {
    const deviceId = req.query.device_id || 'esp32_cam_01';
    const limit = parseInt(req.query.limit || '10');

    const query = `
      SELECT time, device_id, raw_image_path, processed_image_path, detections
      FROM ai_image_analyses
      WHERE device_id = $1
      ORDER BY time DESC
      LIMIT $2;
    `;
    const result = await dbPool.query(query, [deviceId, limit]);

    const minioBaseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000/plant-images';

    const formattedRows = result.rows.map(row => ({
      time: row.time,
      device_id: row.device_id,
      raw_image_url: `${minioBaseUrl}/${row.raw_image_path}`,
      processed_image_url: `${minioBaseUrl}/${row.processed_image_url || row.processed_image_path}`,
      detections: row.detections
    }));

    res.json(formattedRows);
  } catch (err) {
    console.error('❌ 撈取 AI 紀錄失敗:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. POST /api/control/water - 手動遠端澆水 API
app.post('/api/control/water', async (req, res) => {
  const { device_id = 'esp32_plant_01', tenant_id = 'demo_tenant', duration_sec = 3 } = req.body;

  try {
    // 1. 後端防乾燒檢查：撈取該裝置最新一筆水位 (使用 dbPool)
    const checkRes = await dbPool.query(
      `SELECT water_level FROM sensor_telemetry WHERE device_id = $1 ORDER BY time DESC LIMIT 1`,
      [device_id]
    );

    const currentWaterLevel = checkRes.rows[0]?.water_level ?? 100;

    if (currentWaterLevel <= 5) {
      await dbPool.query(
        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
        [device_id, 'MANUAL_WATER', duration_sec, 'REJECTED_NO_WATER']
      );

      return res.status(400).json({
        success: false,
        message: '🚫 警告：水箱水位過低 (<=5%)，系統阻止啟動抽水泵以防乾燒！'
      });
    }

    // 2. 組成多租戶 Topic 並發送 MQTT 下行控制指令 (Downlink)
    const controlTopic = `tenants/${tenant_id}/devices/${device_id}/control`;
    const commandPayload = JSON.stringify({
      action: 'PUMP_ON',
      duration_sec: duration_sec,
      timestamp: new Date().toISOString()
    });

    mqttClient.publish(controlTopic, commandPayload);

    // 3. 寫入成功日誌至 TimescaleDB
    const logRes = await dbPool.query(
      `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [device_id, 'MANUAL_WATER', duration_sec, 'SUCCESS']
    );

    // 4. WebSocket 即時推播日誌給前端
    io.emit('new_actuation_log', logRes.rows[0]);

    console.log(`🌊 [控制中心] 已對 ${controlTopic} 發送澆水指令 (${duration_sec}s)`);
    res.json({ success: true, message: '澆水指令已下達！', log: logRes.rows[0] });

  } catch (err) {
    console.error('❌ 控制 API 異常:', err.message);
    res.status(500).json({ error: '內部伺服器錯誤', details: err.message });
  }
});

// 5. POST /api/camera/capture - Web 觸發手動拍照診斷 API
app.post('/api/camera/capture', async (req, res) => {
  try {
    const cameraTopic = `tenants/demo_tenant/devices/esp32_cam_01/control`;
    mqttClient.publish(cameraTopic, JSON.stringify({
      action: 'CAPTURE_PHOTO',
      timestamp: new Date().toISOString()
    }));

    await dbPool.query(
      `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
      ['esp32_cam_01', 'WEB_CAPTURE', 0, 'SUCCESS']
    );

    res.json({ success: true, message: 'Camera capture triggered successfully.' });
  } catch (err) {
    console.error('❌ 觸發拍照 API 失敗:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 6. GET /api/control/logs - 取得致動歷史日誌 API
app.get('/api/control/logs', async (req, res) => {
  try {
    const result = await dbPool.query(
      `SELECT * FROM actuation_logs ORDER BY created_at DESC LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ 讀取控制日誌失敗:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AI 診斷紀錄查詢 API (已修正欄位) ====================
app.get('/api/ai-analyses', async (req, res) => {
  try {
    const deviceId = req.query.device_id || 'esp32_plant_01';
    const limit = parseInt(req.query.limit) || 6;

    // 💡 修正：移除不存在的 id 欄位，改以 time 進行倒序排序 
    const query = `
      SELECT time, device_id, raw_image_path, processed_image_path, detections 
      FROM ai_image_analyses 
      WHERE device_id = $1 
      ORDER BY time DESC 
      LIMIT $2;
    `;
    const { rows } = await dbPool.query(query, [deviceId, limit]);
    res.json(rows);
  } catch (err) {
    console.error("❌ 抓取 AI 分析紀錄失敗:", err);
    res.status(500).json({ error: "無法讀取 AI 診斷紀錄" });
  }
});

// 相容舊版 API 路徑
app.get('/api/ai/recent', async (req, res) => {
  const deviceId = req.query.device_id || 'esp32_plant_01';
  const limit = req.query.limit || 6;
  res.redirect(`/api/ai-analyses?device_id=${deviceId}&limit=${limit}`);
});
// ==================== Socket.io 連線 ====================
io.on('connection', (socket) => {
  console.log(`🔌 Web 儀表板已連線: ${socket.id}`);
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動於 http://localhost:${PORT}`);

  // 啟動 Telegram Bot 互動監聽
  initBotPolling(dbPool, mqttClient);
  initTelemetryWorker(dbPool, io, mqttClient);
});