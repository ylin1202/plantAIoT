const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
// Import automated rule engine
const { processAutomationRules } = require('./automationEngine');

// Initialize Redis connection
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
});

// Initialize Telemetry Queue
const telemetryQueue = new Queue('telemetryQueue', { connection: redisConnection });

// Initialize Worker to ingest queue tasks and persist to TimescaleDB
// Accepts mqttClient parameter to allow rule engine to dispatch control commands
const initTelemetryWorker = (dbPool, io, mqttClient) => {
  const worker = new Worker(
    'telemetryQueue',
    async (job) => {
      const payload = job.data;
      const { device_id, timestamp, soil_moisture, temperature, humidity, light_lux, water_level } = payload;
      const recordTime = timestamp ? new Date(timestamp) : new Date();

      // Persist record into TimescaleDB
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

      // Broadcast telemetry updates in real-time via Socket.IO to React dashboard
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

      // Evaluate background automation rules (soil moisture thresholds, dry-run protection, auto-watering)
      if (mqttClient) {
        await processAutomationRules(payload, dbPool, mqttClient);
      }

      return { status: 'processed', device_id, timestamp: recordTime };
    },
    {
      connection: redisConnection,
      concurrency: 5, // Traffic shaping: limit parallel writes to 5 workers to smooth peak loads
    }
  );

  worker.on('completed', (job) => {
    // Optional completion log (can be omitted in high-throughput environments)
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} execution failed:`, err.message);
  });

  console.log('BullMQ Telemetry Worker initialized successfully (Concurrency: 5, with Automation Engine).');
};

module.exports = {
  telemetryQueue,
  initTelemetryWorker,
};