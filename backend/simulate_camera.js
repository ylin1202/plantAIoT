const { Client } = require('minio');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

// 1. 初始化 MinIO Client
const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minio_admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minio_password',
});

// 2. 初始化 Redis Client
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6380'),
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'plant-images';
const SAMPLE_IMAGE_PATH = path.join(__dirname, 'sample_plant.jpg');

// 下載一張真實植物/水果的測試照片
function ensureSampleImage() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(SAMPLE_IMAGE_PATH)) {
      return resolve(SAMPLE_IMAGE_PATH);
    }
    console.log('⬇️ 正在下載真實植物範例圖片以供 ESP32-CAM 模擬...');
    // 使用標準公開的植物圖片 URL
    const imageUrl = 'https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?w=640&q=80';
    
    https.get(imageUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // 處理重定向
        https.get(res.headers.location, (redirectRes) => {
          const fileStream = fs.createWriteStream(SAMPLE_IMAGE_PATH);
          redirectRes.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(SAMPLE_IMAGE_PATH);
          });
        });
      } else {
        const fileStream = fs.createWriteStream(SAMPLE_IMAGE_PATH);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(SAMPLE_IMAGE_PATH);
        });
      }
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function triggerCameraAndAI() {
  try {
    // 檢查 Bucket 是否存在
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`🪣 自動建立 MinIO Bucket: ${BUCKET_NAME}`);
    }

    // 確保範例圖片存在
    const imagePath = await ensureSampleImage();

    const timestamp = Date.now();
    const imageName = `capture_${timestamp}.jpg`;
    const deviceId = 'esp32_cam_01';

    // 1. 上傳真實照片至 MinIO
    await minioClient.fPutObject(BUCKET_NAME, imageName, imagePath, {
      'Content-Type': 'image/jpeg'
    });
    console.log(`📸 [ESP32-CAM] 成功上傳真實植物照片至 MinIO: ${imageName}`);

    // 2. 組成 AI 任務 Payload
    const jobPayload = {
      device_id: deviceId,
      image_name: imageName,
      timestamp: new Date().toISOString()
    };

    // 3. 推派任務至 Redis List
    await redis.rpush('bull:aiVisionQueue:wait', JSON.stringify(jobPayload));
    console.log(`🚀 [AI Pipeline] 已推派分析任務至 Redis Queue (aiVisionQueue)!`);

    process.exit(0);
  } catch (err) {
    console.error('❌ 上傳或推派失敗:', err);
    process.exit(1);
  }
}

triggerCameraAndAI();