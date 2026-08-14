const { Client } = require('minio');
const Redis = require('ioredis');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

// 1. 初始化 MinIO Client (強制 fallback 到 localhost，並加上 3 秒連線保護)
const minioClient = new Client({
  endPoint: (process.env.MINIO_ENDPOINT && !process.env.MINIO_ENDPOINT.includes('minio')) ? process.env.MINIO_ENDPOINT : 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minio_admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minio_password',
});

// 2. 初始化 Redis Client
const redisHost = (process.env.REDIS_HOST && process.env.REDIS_HOST !== 'redis') ? process.env.REDIS_HOST : 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6380');

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 3) {
      console.error('[Redis] 連線多次失敗，請確認 Docker aiot-redis 容器正常運行且 6380 Port 已開！');
      return null;
    }
    return Math.min(times * 200, 1000);
  }
});

redis.on('error', (err) => {
  console.error('[Redis 連線錯誤]:', err.message);
});

// 3. 初始化 MQTT Client
const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const mqttClient = mqtt.connect(MQTT_BROKER);

const BUCKET_NAME = process.env.MINIO_BUCKET || 'plant-images';
const DEVICE_ID = process.env.DEVICE_ID || 'esp32_plant_01';
const CONTROL_TOPIC = `tenants/demo_tenant/devices/${DEVICE_ID}/control`;

const LOCAL_FOLDER = __dirname;

// 下載網路範例照片（備用機制）
function downloadFallbackImage(targetPath) {
  return new Promise((resolve, reject) => {
    console.log('未檢測到實拍照片，正在下載預設植物圖片以供模擬...');
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

// 動態獲取待傳輸的照片
async function getNextSampleImage() {
  const targetImage = path.join(LOCAL_FOLDER, 'plant1.jpg');
  
  if (fs.existsSync(targetImage)) {
    console.log(`[ESP32-CAM 模擬器] 使用實拍照片: plant1.jpg`);
    return targetImage;
  }

  const defaultSamplePath = path.join(LOCAL_FOLDER, 'sample_plant.jpg');
  if (fs.existsSync(defaultSamplePath)) {
    return defaultSamplePath;
  }

  return await downloadFallbackImage(defaultSamplePath);
}

// 執行拍照與上傳 MinIO / 推派 AI 佇列的核心函式
async function triggerCameraAndAI() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`🪣 自動建立 MinIO Bucket: ${BUCKET_NAME}`);
    }

    const imagePath = await getNextSampleImage();
    const timestamp = Date.now();
    const imageName = `capture_${timestamp}.jpg`;

    // 1. 上傳照片至 MinIO
    await minioClient.fPutObject(BUCKET_NAME, imageName, imagePath, {
      'Content-Type': 'image/jpeg',
    });
    console.log(`📸 [ESP32-CAM 模擬器] 成功拍照並上傳至 MinIO: ${imageName}`);

    // 2. 組成 AI 任務 Payload
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

    // 3. 推派任務至 Redis List
    await redis.rpush('bull:aiVisionQueue:wait', JSON.stringify(jobPayload));
    console.log(`[AI Pipeline] 已推派分析任務至 Redis Queue (aiVisionQueue)!`);

  } catch (err) {
    console.error('上傳或推派失敗:', err);
  }
}

// 必須手動監聽 MQTT 連線並訂閱 Topic，否則收不到網頁點擊事件
mqttClient.on('connect', () => {
  console.log(`[ESP32-CAM 模擬器] 已成功連線至 MQTT Broker (${MQTT_BROKER})`);
  mqttClient.subscribe(CONTROL_TOPIC, (err) => {
    if (!err) {
      console.log(`[ESP32-CAM 模擬器] 已成功訂閱控制頻道: ${CONTROL_TOPIC}`);
      console.log(`等待 Telegram 或後端發送拍照控制指令...`);
    } else {
      console.error(`訂閱 MQTT 頻道失敗:`, err);
    }
  });
});

// 接收控制指令
mqttClient.on('message', async (topic, message) => {
  if (topic === CONTROL_TOPIC) {
    try {
      const payload = JSON.parse(message.toString());
      console.log(`[ESP32-CAM 收到指令]:`, payload);

      const photoActions = ['CAPTURE_PHOTO', 'TAKE_PHOTO', 'PHOTO', 'CAPTURE', 'WEB_CAPTURE'];

      if (photoActions.includes(payload.action)) {
        console.log('觸發拍照動作！開始上傳圖片與驅動 AI Worker...');
        await triggerCameraAndAI();
      }
    } catch (err) {
      console.error('解析控制指令失敗:', err.message);
    }
  }
});