// simulate_device.js
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');
const DEVICE_ID = 'esp32_plant_01';
const TENANT_ID = 'demo_tenant';
const TOPIC = `tenants/${TENANT_ID}/devices/${DEVICE_ID}/telemetry`;

client.on('connect', () => {
  console.log(`🤖 [ESP32 模擬器] 已連線至 Broker，開始發送數據到 ${TOPIC}...`);

  setInterval(() => {
    // 模擬真實環境數據的波動
    const payload = {
      device_id: DEVICE_ID,
      timestamp: new Date().toISOString(),
      soil_moisture: +(45 + (Math.random() * 4 - 2)).toFixed(1), // 43%~47% 波動
      temperature: +(26 + (Math.random() * 2 - 1)).toFixed(1),   // 25~27°C
      humidity: +(60 + (Math.random() * 6 - 3)).toFixed(1),      // 57%~63%
      light_lux: Math.floor(350 + Math.random() * 50),          // 350~400 Lux
      water_level: 85.0
    };

    client.publish(TOPIC, JSON.stringify(payload));
    console.log(`📡 [ESP32 上報數據]: 土壤 ${payload.soil_moisture}% | 溫度 ${payload.temperature}°C`);
  }, 3000); // 每 3 秒發送一次
});