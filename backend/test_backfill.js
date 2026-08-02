// backend/test_backfill.js
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');
const DEVICE_ID = 'esp32_plant_01';
const TOPIC = `tenants/demo_tenant/devices/${DEVICE_ID}/telemetry`;

client.on('connect', async () => {
  console.log('🚨 [測試開始] 模擬 ESP32 斷線重連，一秒內倒灌 100 筆離線快取資料...');

  const now = Date.now();
  for (let i = 100; i >= 1; i--) {
    // 產生過去 100 分鐘內的歷史時間戳
    const pastTimestamp = new Date(now - i * 60 * 1000).toISOString();
    
    const payload = {
      device_id: DEVICE_ID,
      timestamp: pastTimestamp,
      soil_moisture: +(30 + Math.random() * 10).toFixed(1),
      temperature: 25.5,
      humidity: 60.0,
      light_lux: 300,
      water_level: 80.0
    };

    client.publish(TOPIC, JSON.stringify(payload));
  }

  console.log('✅ 100 筆離線倒灌資料已全數發射給 MQTT！看 BullMQ 如何平滑處理！');
  setTimeout(() => client.end(), 1000);
});