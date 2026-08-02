const { Client } = require('minio');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// 1. 初始化 MinIO Client
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

// 2. 初始化 Redis Client
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'plant-images';

async function triggerCameraAndAI() {
  try {
    // 檢查 Bucket 是否存在
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`🪣 自動建立 MinIO Bucket: ${BUCKET_NAME}`);
    }

    // 模擬產出一張帶有時間戳記的照片檔名
    const timestamp = Date.now();
    const imageName = `capture_${timestamp}.jpg`;
    const deviceId = 'esp32_cam_01';

    // 隨機建立一個簡單的測試圖片 (或使用範例圖)
    // 這裡用 Node.js 寫入一個 Buffer 測試檔
    const dummyImagePath = path.join(__dirname, 'temp_test.jpg');
    
    // 如果沒有本地測試圖，建立一個簡版檔案
    if (!fs.existsSync(dummyImagePath)) {
      // 1x1 像素檔或任意佔位檔
      const dummyBuffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      fs.writeFileSync(dummyImagePath, dummyBuffer);
    }

    // 1. 上傳照片至 MinIO
    await minioClient.fPutObject(BUCKET_NAME, imageName, dummyImagePath);
    console.log(`📸 [ESP32-CAM] 照片已成功上傳至 MinIO: ${imageName}`);

    // 2. 組成 AI 任務 Payload
    const jobPayload = {
      device_id: deviceId,
      image_name: imageName,
      timestamp: new Date().toISOString()
    };

    // 3. 推派任務至 Redis List (Python Worker 監聽的 Queue)
    await redis.rpush('bull:aiVisionQueue:wait', JSON.stringify(jobPayload));
    console.log(`🚀 [AI Pipeline] 已推派分析任務至 Redis Queue (aiVisionQueue)!`);

    process.exit(0);
  } catch (err) {
    console.error('❌ 上傳或推派失敗:', err);
    process.exit(1);
  }
}

triggerCameraAndAI();