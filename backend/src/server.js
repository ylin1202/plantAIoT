const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
const Redis = require('ioredis');
require('dotenv').config();

// Import BullMQ queue modules
const { telemetryQueue, initTelemetryWorker } = require('./queue');

// Import Telegram bot notifications
const { checkAndTriggerAlert, initBotPolling } = require('./telegram');

const app = express();

// CORS configuration
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

// Setup Redis Pub/Sub subscriber and resolve MinIO URLs for real-time frontend delivery
const redisSub = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

redisSub.subscribe('ai_diagnosis_channel', (err, count) => {
  if (err) {
    console.error('[Redis Sub] Failed to subscribe to ai_diagnosis_channel:', err.message);
  } else {
    console.log('[Redis Sub] Subscribed to ai_diagnosis_channel successfully. Ready to broadcast AI diagnosis events.');
  }
});

redisSub.on('message', (channel, message) => {
  if (channel === 'ai_diagnosis_channel') {
    try {
      const diagnosisData = JSON.parse(message);
      
      const minioBaseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000/plant-images';
      const imgName = diagnosisData.image_name || '';

      // Format payload and construct fully qualified image URLs for React dashboard consumption
      const formattedData = {
        time: diagnosisData.timestamp || new Date().toISOString(),
        device_id: diagnosisData.device_id || 'esp32_plant_01',
        raw_image_url: `${minioBaseUrl}/${imgName}`,
        processed_image_url: `${minioBaseUrl}/${imgName}`,
        image_url: `${minioBaseUrl}/${imgName}`,
        detections: [{
          diagnosis: diagnosisData.diagnosis,
          health_score: diagnosisData.health_score,
          action_required: diagnosisData.action_required
        }]
      };

      console.log('[Backend] AI diagnosis received, formatted and broadcasted to React client:', formattedData);

      // Real-time broadcast via Socket.IO
      io.emit('ai_diagnosis_result', formattedData);
    } catch (err) {
      console.error('[Redis Sub] Failed to parse AI diagnosis payload:', err.message);
    }
  }
});

// TimescaleDB Connection Pool
const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'aiot_user',
  password: process.env.DB_PASSWORD || 'aiot_password',
  database: process.env.DB_NAME || 'aiot_db',
});

// Initialize database connection and auto-migrate actuation_logs schema
dbPool.connect(async (err, client, release) => {
  if (err) {
    console.error('[DB] Connection failed:', err.stack);
  } else {
    console.log('[DB] Connected to TimescaleDB successfully.');
    try {
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
      console.log('[DB] Verified and initialized actuation_logs table schema.');
    } catch (tableErr) {
      console.error('[DB] Auto-migration failed:', tableErr.message);
    } finally {
      release();
    }
  }
});

// MQTT Client Connection
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883');

mqttClient.on('connect', () => {
  console.log('[MQTT] Connected to EMQX Broker successfully.');
  mqttClient.subscribe('tenants/+/devices/+/telemetry');
});

// Push incoming telemetry messages to BullMQ queue for async processing
mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    await telemetryQueue.add('process_telemetry', payload, {
      attempts: 3,
      backoff: 1000,
      removeOnComplete: true,
    });

    checkAndTriggerAlert(payload);

  } catch (err) {
    console.error('[MQTT] Failed to process telemetry message:', err.message);
  }
});

// ==================== REST APIs ====================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Backend Server is running.' });
});

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

// 2. GET /api/telemetry/history
app.get('/api/telemetry/history', async (req, res) => {
  const { range = '24h', device_id = 'esp32_plant_01' } = req.query;
  
  try {
    let query = '';
    if (range === '24h') {
      query = `SELECT time, soil_moisture, temperature, humidity, light_lux, water_level 
               FROM sensor_telemetry WHERE device_id = $1 ORDER BY time DESC LIMIT 100`;
    } else if (range === '7d') {
      query = `SELECT bucket AS time, avg_soil_moisture AS soil_moisture, avg_temperature AS temperature, 
                      avg_humidity AS humidity, avg_light_lux AS light_lux, avg_water_level AS water_level 
               FROM sensor_telemetry_hourly WHERE device_id = $1 AND bucket >= NOW() - INTERVAL '7 days' ORDER BY bucket ASC`;
    } else if (range === '30d') {
      query = `SELECT bucket AS time, avg_soil_moisture AS soil_moisture, avg_temperature AS temperature, 
                      avg_humidity AS humidity, avg_light_lux AS light_lux, avg_water_level AS water_level 
               FROM sensor_telemetry_hourly WHERE device_id = $1 AND bucket >= NOW() - INTERVAL '30 days' ORDER BY bucket ASC`;
    }

    const dbRes = await dbPool.query(query, [device_id]);
    res.json({ success: true, data: dbRes.rows });
  } catch (err) {
    console.error('[API] Failed to fetch historical telemetry data:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. GET /api/ai/recent
app.get('/api/ai/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '10');

    // Query latest records with cross-device compatibility
    const query = `
      SELECT time, device_id, raw_image_path, processed_image_path, detections
      FROM ai_image_analyses
      ORDER BY time DESC
      LIMIT $1;
    `;
    const result = await dbPool.query(query, [limit]);

    const minioBaseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000/plant-images';

    const formattedRows = result.rows.map(row => ({
      time: row.time,
      device_id: row.device_id,
      raw_image_url: row.raw_image_path?.startsWith('http') ? row.raw_image_path : `${minioBaseUrl}/${row.raw_image_path}`,
      processed_image_url: row.processed_image_path?.startsWith('http') ? row.processed_image_path : `${minioBaseUrl}/${row.processed_image_path || row.raw_image_path}`,
      detections: row.detections
    }));

    res.json(formattedRows);
  } catch (err) {
    console.error('[API] Failed to fetch recent AI records:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. POST /api/control/water - Manual remote watering control
app.post('/api/control/water', async (req, res) => {
  const { device_id = 'esp32_plant_01', tenant_id = 'demo_tenant', duration_sec = 3 } = req.body;

  try {
    // 1. Dry-run prevention: verify water level before actuation
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
        message: 'Warning: Water reservoir level is critically low (<= 5%). Actuation aborted to prevent pump dry-run damage.'
      });
    }

    // 2. Publish MQTT downlink command across multi-tenant topic
    const controlTopic = `tenants/${tenant_id}/devices/${device_id}/control`;
    const commandPayload = JSON.stringify({
      action: 'PUMP_ON',
      duration_sec: duration_sec,
      timestamp: new Date().toISOString()
    });

    mqttClient.publish(controlTopic, commandPayload);

    // 3. Persist execution log into TimescaleDB
    const logRes = await dbPool.query(
      `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [device_id, 'MANUAL_WATER', duration_sec, 'SUCCESS']
    );

    // 4. Broadcast updated actuation log via Socket.IO
    io.emit('new_actuation_log', logRes.rows[0]);

    console.log(`[Control Center] Dispatched watering command to ${controlTopic} (${duration_sec}s)`);
    res.json({ success: true, message: 'Watering command dispatched successfully.', log: logRes.rows[0] });

  } catch (err) {
    console.error('[API Error] Remote watering control failed:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// 5. POST /api/camera/capture - Web-triggered manual camera capture and AI diagnosis
app.post('/api/camera/capture', async (req, res) => {
  try {
    const cameraTopic = `tenants/demo_tenant/devices/esp32_plant_01/control`;

    mqttClient.publish(cameraTopic, JSON.stringify({
      action: 'CAPTURE_PHOTO',
      timestamp: new Date().toISOString()
    }));

    await dbPool.query(
      `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
      ['esp32_plant_01', 'WEB_CAPTURE', 0, 'SUCCESS']
    );

    console.log(`[Control Center] Dispatched snapshot capture command to ${cameraTopic}`);
    res.json({ success: true, message: 'Camera capture triggered successfully.' });
  } catch (err) {
    console.error('[API Error] Failed to trigger camera capture:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 6. GET /api/control/logs
app.get('/api/control/logs', async (req, res) => {
  try {
    const result = await dbPool.query(
      `SELECT * FROM actuation_logs ORDER BY created_at DESC LIMIT 10`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[API Error] Failed to fetch actuation logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AI Analysis Query API ====================
app.get('/api/ai-analyses', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 6;

    const query = `
      SELECT time, device_id, raw_image_path, processed_image_path, detections 
      FROM ai_image_analyses 
      ORDER BY time DESC 
      LIMIT $1;
    `;
    const { rows } = await dbPool.query(query, [limit]);

    const minioBaseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000/plant-images';

    const formattedRows = rows.map(row => {
      const rawImg = row.raw_image_path || '';
      const procImg = row.processed_image_path || row.raw_image_path || '';

      return {
        ...row,
        raw_image_url: rawImg.startsWith('http') ? rawImg : `${minioBaseUrl}/${rawImg}`,
        processed_image_url: procImg.startsWith('http') ? procImg : `${minioBaseUrl}/${procImg}`,
        image_url: rawImg.startsWith('http') ? rawImg : `${minioBaseUrl}/${rawImg}`
      };
    });

    res.json(formattedRows);
  } catch (err) {
    console.error("[API Error] Failed to query AI analyses:", err);
    res.status(500).json({ error: "Failed to retrieve AI diagnostic records." });
  }
});

// Backward compatible endpoint redirect
app.get('/api/ai/recent-redirect', async (req, res) => {
  const limit = req.query.limit || 6;
  res.redirect(`/api/ai-analyses?limit=${limit}`);
});

// ==================== Socket.IO Lifecycle ====================
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Web dashboard connected: ${socket.id}`);
});

const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`[Server] Node.js backend running on port ${PORT}`);

  initBotPolling(dbPool, mqttClient);
  initTelemetryWorker(dbPool, io, mqttClient);
});