const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
// 引入剛剛寫好的自動化規則引擎
const { processAutomationRules } = require('./automationEngine');

// 1. 初始化 Redis 連線
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
});

// 2. 建立感測器數據佇列 (Telemetry Queue)
const telemetryQueue = new Queue('telemetryQueue', { connection: redisConnection });

// 3. 建立 Worker 負責處理佇列中的數據並寫入 TimescaleDB
// 新增傳入 mqttClient 參數，供規則引擎發送控制指令
const initTelemetryWorker = (dbPool, io, mqttClient) => {
  const worker = new Worker(
    'telemetryQueue',
    async (job) => {
      const payload = job.data;
      const { device_id, timestamp, soil_moisture, temperature, humidity, light_lux, water_level } = payload;
      const recordTime = timestamp ? new Date(timestamp) : new Date();

      // 1. 寫入 TimescaleDB
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
        water_level,
      ]);

      // 2. 即時 WebSocket 廣播至前端 React
      if (io) {
        io.emit('telemetry_update', {
          time: recordTime,
          device_id,
          soil_moisture,
          temperature,
          humidity,
          light_lux,
          water_level,
        });
      }

      // 3. 執行背景自動化規則檢查 (檢查土壤濕度、水位防乾燒與觸發自動澆水)
      if (mqttClient) {
        await processAutomationRules(payload, dbPool, mqttClient);
      }

      return { status: 'processed', device_id, timestamp: recordTime };
    },
    {
      connection: redisConnection,
      concurrency: 5, // 限流：同時最多只允許 5 個寫入任務並行處理 (流量削峰關鍵!)
    }
  );

  worker.on('completed', (job) => {
    // 成功完成 Job 時的 Log (量大時可拿掉)
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} 處理失敗:`, err.message);
  });

  console.log('⚡ BullMQ Telemetry Worker 啟動完成 (Concurrency: 5, 含自動化規則引擎)');
};

module.exports = {
  telemetryQueue,
  initTelemetryWorker,
};