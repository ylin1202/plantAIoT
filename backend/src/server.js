const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { Pool } = require('pg');
const cors = require('cors');
const Redis = require('ioredis');
require('dotenv').config();

// Import BullMQ worker and queue modules
const { telemetryQueue, initTelemetryWorker } = require('./queue');

// Import Telegram bot polling service
const { initBotPolling } = require('./telegram');

const app = express();

// Standard CORS and JSON parsing
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true,
});

// Setup Redis Pub/Sub subscriber for real-time AI diagnosis events
const redisSub = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

redisSub.subscribe('ai_diagnosis_channel', (err) => {
  if (err) {
    console.error('[Redis Sub] Failed to subscribe to ai_diagnosis_channel:', err.message);
  } else {
    console.log('[Redis Sub] Subscribed to ai_diagnosis_channel successfully.');
  }
});

redisSub.on('message', (channel, message) => {
  if (channel === 'ai_diagnosis_channel') {
    try {
      const diagnosisData = JSON.parse(message);
      const minioBaseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000/plant-images';
      const imgName = diagnosisData.image_name || '';

      const formattedData = {
        time: diagnosisData.timestamp || new Date().toISOString(),
        device_id: diagnosisData.device_id || 'esp32_plant_01',
        raw_image_url: `${minioBaseUrl}/${imgName}`,
        processed_image_url: `${minioBaseUrl}/${imgName}`,
        image_url: `${minioBaseUrl}/${imgName}`,
        detections: [{
          diagnosis: diagnosisData.diagnosis,
          health_score: diagnosisData.health_score,
          action_required: diagnosisData.action_required,
        }],
      };

      console.log('[Backend] AI diagnosis broadcasted to React clients:', formattedData.device_id);
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

// Initialize database connection and verify table schema
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
      console.log('[DB] Verified actuation_logs table schema.');
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

// Ingest incoming telemetry into BullMQ (traffic shaping & async processing)
mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    await telemetryQueue.add('process_telemetry', payload, {
      attempts: 3,
      backoff: 1000,
      removeOnComplete: true,
    });
  } catch (err) {
    console.error('[MQTT] Failed to enqueue telemetry message:', err.message);
  }
});

// ==================== REST APIs ====================

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'AIoT Plant Monitor API Server is active.' });
});

// GET /api/telemetry/recent
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

// GET /api/ai/recent & /api/ai-analyses
const fetchAiAnalyses = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '10');
    const query = `
      SELECT time, device_id, raw_image_path, processed_image_path, detections
      FROM ai_image_analyses
      ORDER BY time DESC
      LIMIT $1;
    `;
    const { rows } = await dbPool.query(query, [limit]);
    const minioBaseUrl = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000/plant-images';

    const formattedRows = rows.map((row) => {
      const rawImg = row.raw_image_path || '';
      const procImg = row.processed_image_path || rawImg;

      return {
        ...row,
        raw_image_url: rawImg.startsWith('http') ? rawImg : `${minioBaseUrl}/${rawImg}`,
        processed_image_url: procImg.startsWith('http') ? procImg : `${minioBaseUrl}/${procImg}`,
        image_url: rawImg.startsWith('http') ? rawImg : `${minioBaseUrl}/${rawImg}`,
      };
    });

    res.json(formattedRows);
  } catch (err) {
    console.error('[API Error] Failed to fetch AI analyses:', err.message);
    res.status(500).json({ error: 'Failed to retrieve AI diagnostic records.' });
  }
};

app.get('/api/ai/recent', fetchAiAnalyses);
app.get('/api/ai-analyses', fetchAiAnalyses);

// POST /api/control/water - Manual remote watering control
app.post('/api/control/water', async (req, res) => {
  const { device_id = 'esp32_plant_01', tenant_id = 'demo_tenant', duration_sec = 3 } = req.body;

  try {
    // Dry-run safety interlock: verify water level before actuation
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
        message: 'Warning: Water reservoir level is critically low (<= 5%). Actuation aborted to prevent pump dry-run damage.',
      });
    }

    // Publish MQTT downlink command
    const controlTopic = `tenants/${tenant_id}/devices/${device_id}/control`;
    const commandPayload = JSON.stringify({
      action: 'PUMP_ON',
      duration_sec: duration_sec,
      timestamp: new Date().toISOString(),
    });

    mqttClient.publish(controlTopic, commandPayload);

    // Persist execution log into TimescaleDB
    const logRes = await dbPool.query(
      `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [device_id, 'MANUAL_WATER', duration_sec, 'SUCCESS']
    );

    // Broadcast updated actuation log via Socket.IO
    io.emit('new_actuation_log', logRes.rows[0]);

    console.log(`[Control Center] Dispatched watering command to ${controlTopic} (${duration_sec}s)`);
    res.json({ success: true, message: 'Watering command dispatched successfully.', log: logRes.rows[0] });
  } catch (err) {
    console.error('[API Error] Remote watering control failed:', err.message);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// POST /api/camera/capture - Web-triggered manual camera capture and AI diagnosis
app.post('/api/camera/capture', async (req, res) => {
  try {
    const cameraTopic = 'tenants/demo_tenant/devices/esp32_plant_01/control';

    mqttClient.publish(cameraTopic, JSON.stringify({
      action: 'CAPTURE_PHOTO',
      timestamp: new Date().toISOString(),
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

// GET /api/control/logs
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