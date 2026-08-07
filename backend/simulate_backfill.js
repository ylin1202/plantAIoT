const mqtt = require('mqtt');
require('dotenv').config();

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883');
const TOPIC = 'tenants/demo_tenant/devices/esp32_plant_01/telemetry';

mqttClient.on('connect', async () => {
  console.log('📡 [ESP32 Backfill 模擬器] 已連線至 MQTT Broker');
  console.log('⚠️ 模擬情境：ESP32 斷網 10 分鐘後復網，開始倒灌 SPIFFS Flash 內積壓的歷史時序數據...');

  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;
  
  // 模擬產出過去 10 分鐘 (每 10 秒 1 筆，共 60 筆) 帶有歷史時間戳的數據
  for (let i = 0; i < 60; i++) {
    const pastTimestamp = new Date(tenMinutesAgo + i * 10000).toISOString();
    const backfillPayload = {
      device_id: 'esp32_plant_01',
      timestamp: pastTimestamp,
      soil_moisture: parseFloat((22.0 + Math.sin(i) * 2).toFixed(1)),
      temperature: 25.8,
      humidity: 62.0,
      light_lux: 420,
      water_level: 80.0,
      is_backfill: true
    };

    mqttClient.publish(TOPIC, JSON.stringify(backfillPayload));
  }

  console.log('✅ [Backfill 倒灌完成] 60 筆離線歷史數據已成功推入 MQTT！');
  console.log('💡 請觀察後端 Terminal: BullMQ Queue 正在流量削峰 (Concurrency: 5) 平穩地寫入 TimescaleDB！');
  setTimeout(() => process.exit(0), 1000);
});