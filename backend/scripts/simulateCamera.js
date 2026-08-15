const { Client } = require('minio');
const Redis = require('ioredis');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

// Initialize MinIO Client (fallback to localhost when executed outside container network)
const minioClient = new Client({
  endPoint: (process.env.MINIO_ENDPOINT && !process.env.MINIO_ENDPOINT.includes('minio')) ? process.env.MINIO_ENDPOINT : 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minio_admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minio_password',
});

// Initialize Redis Client
const redisHost = (process.env.REDIS_HOST && process.env.REDIS_HOST !== 'redis') ? process.env.REDIS_HOST : 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6380');

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 3) {
      console.error('[Redis] Connection retries exceeded. Verify the aiot-redis container is active and port 6380 is mapped.');
      return null;
    }
    return Math.min(times * 200, 1000);
  }
});

redis.on('error', (err) => {
  console.error('[Redis Connection Error]:', err.message);
});

// Initialize MQTT Client
const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const mqttClient = mqtt.connect(MQTT_BROKER);

const BUCKET_NAME = process.env.MINIO_BUCKET || 'plant-images';
const DEVICE_ID = process.env.DEVICE_ID || 'esp32_plant_01';
const CONTROL_TOPIC = `tenants/demo_tenant/devices/${DEVICE_ID}/control`;

const ASSETS_FOLDER = path.join(__dirname, '../assets');

// Download a default sample plant image if no local snapshot is found
function downloadFallbackImage(targetPath) {
  return new Promise((resolve, reject) => {
    console.log('[ESP32-CAM Simulator] No local snapshot detected. Downloading fallback plant image for simulation...');
    const imageUrl = 'https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?w=640&q=80';

    https.get(imageUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (redirectRes) => {
          const fileStream = fs.createWriteStream(targetPath);
          redirectRes.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(targetPath);
          });
        });
      } else {
        const fileStream = fs.createWriteStream(targetPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(targetPath);
        });
      }
    }).on('error', (err) => reject(err));
  });
}

// Dynamically resolve snapshot source image from assets folder
async function getNextSampleImage() {
  const targetImage = path.join(ASSETS_FOLDER, 'plant1.jpg');
  
  if (fs.existsSync(targetImage)) {
    console.log(`[ESP32-CAM Simulator] Using local sample snapshot: ${targetImage}`);
    return targetImage;
  }

  const defaultSamplePath = path.join(ASSETS_FOLDER, 'sample_plant.jpg');
  if (fs.existsSync(defaultSamplePath)) {
    return defaultSamplePath;
  }

  return await downloadFallbackImage(defaultSamplePath);
}

// Core routine: capture image, upload to MinIO S3, and dispatch job to Redis queue
async function triggerCameraAndAI() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`[MinIO] Initialized S3 bucket: ${BUCKET_NAME}`);
    }

    const imagePath = await getNextSampleImage();
    const timestamp = Date.now();
    const imageName = `capture_${timestamp}.jpg`;

    // Upload captured image to MinIO S3 bucket
    await minioClient.fPutObject(BUCKET_NAME, imageName, imagePath, {
      'Content-Type': 'image/jpeg',
    });
    console.log(`[ESP32-CAM Simulator] Snapshot uploaded to MinIO: ${imageName}`);

    // Construct AI analysis job payload
    const jobPayload = {
      device_id: DEVICE_ID,
      image_name: imageName,
      timestamp: new Date().toISOString(),
      data: {
        device_id: DEVICE_ID,
        image_name: imageName,
        timestamp: new Date().toISOString(),
      }
    };

    // Push job to Redis Bull queue for background worker consumption
    await redis.rpush('bull:aiVisionQueue:wait', JSON.stringify(jobPayload));
    console.log(`[AI Pipeline] Dispatched analysis task to Redis Queue (aiVisionQueue).`);

  } catch (err) {
    console.error('[ESP32-CAM Simulator Error] Failed to upload image or push queue task:', err);
  }
}

// Subscribe to MQTT downlink control topic upon connection
mqttClient.on('connect', () => {
  console.log(`[ESP32-CAM Simulator] Connected to MQTT Broker (${MQTT_BROKER})`);
  mqttClient.subscribe(CONTROL_TOPIC, (err) => {
    if (!err) {
      console.log(`[ESP32-CAM Simulator] Subscribed to control topic: ${CONTROL_TOPIC}`);
      console.log(`[ESP32-CAM Simulator] Waiting for camera trigger commands via Web or Telegram...`);
    } else {
      console.error(`[ESP32-CAM Simulator Error] Failed to subscribe to MQTT topic:`, err);
    }
  });
});

// Handle incoming control messages
mqttClient.on('message', async (topic, message) => {
  if (topic === CONTROL_TOPIC) {
    try {
      const payload = JSON.parse(message.toString());
      console.log(`[ESP32-CAM Received Command]:`, payload);

      const photoActions = ['CAPTURE_PHOTO', 'TAKE_PHOTO', 'PHOTO', 'CAPTURE', 'WEB_CAPTURE'];

      if (photoActions.includes(payload.action)) {
        console.log('[ESP32-CAM] Triggering camera capture pipeline...');
        await triggerCameraAndAI();
      }
    } catch (err) {
      console.error('[ESP32-CAM Error] Failed to parse control payload:', err.message);
    }
  }
});