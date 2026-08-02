// simulate_device.js
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');
const DEVICE_ID = 'esp32_plant_01';
const TENANT_ID = 'demo_tenant';

// Topic 命名空間對齊
const TELEMETRY_TOPIC = `tenants/${TENANT_ID}/devices/${DEVICE_ID}/telemetry`;
const CONTROL_TOPIC   = `tenants/${TENANT_ID}/devices/${DEVICE_ID}/control`;

// 模擬動態狀態
let state = {
  soil_moisture: 28.5, // 模擬偏乾環境，方便測試自動/手動澆水效果
  temperature: 26.0,
  humidity: 60.0,
  light_lux: 380,
  water_level: 85.0,  // 水箱水量 (%)
  pump_active: false
};

client.on('connect', () => {
  console.log(`🤖 [ESP32 模擬器] 已連線至 Broker！`);
  console.log(`📡 上報 Topic: ${TELEMETRY_TOPIC}`);
  console.log(`📥 監聽 Topic: ${CONTROL_TOPIC}`);

  // 1. 訂閱下行控制指令 (Downlink Control)
  client.subscribe(CONTROL_TOPIC, (err) => {
    if (!err) {
      console.log(`✅ [ESP32 模擬器] 已成功訂閱控制頻道！`);
    }
  });

  // 2. 每 3 秒發送一次即時數據 (Telemetry)
  setInterval(() => {
    // 隨機微幅波動
    state.soil_moisture = Math.max(10, Math.min(95, state.soil_moisture + (Math.random() * 0.4 - 0.2)));
    state.temperature   = +(26 + (Math.random() * 2 - 1)).toFixed(1);
    state.humidity      = +(60 + (Math.random() * 6 - 3)).toFixed(1);
    state.light_lux     = Math.floor(350 + Math.random() * 50);

    const payload = {
      device_id: DEVICE_ID,
      timestamp: new Date().toISOString(),
      soil_moisture: +state.soil_moisture.toFixed(1),
      temperature: state.temperature,
      humidity: state.humidity,
      light_lux: state.light_lux,
      water_level: +state.water_level.toFixed(1)
    };

    client.publish(TELEMETRY_TOPIC, JSON.stringify(payload));
    console.log(`📡 [ESP32 上報數據]: 土壤 ${payload.soil_moisture}% | 溫度 ${payload.temperature}°C | 水位 ${payload.water_level}%`);
  }, 3000);
});

// 3. 監聽後端下發的控制指令 (Downlink Messages)
client.on('message', (topic, message) => {
  try {
    const command = JSON.parse(message.toString());
    console.log(`⚡ [ESP32 收到控制指令] Topic: ${topic}`, command);

    if (command.action === 'PUMP_ON') {
      const duration = command.duration_sec || 3;

      // 硬體級防乾燒機制
      if (state.water_level <= 5) {
        console.log(`⚠️ [ESP32 硬體防護] 水箱缺水 (水位: ${state.water_level}%)，拒絕啟動水泵！`);
        return;
      }

      console.log(`💦 [ESP32 繼電器] 啟動抽水泵，預計抽水 ${duration} 秒...`);
      state.pump_active = true;

      // 模擬抽水歷程
      setTimeout(() => {
        state.pump_active = false;
        state.soil_moisture = Math.min(95, state.soil_moisture + 18.0); // 濕度大幅上升
        state.water_level = Math.max(0, state.water_level - 4.0);        // 水位下降
        console.log(`✅ [ESP32 繼電器] 澆水完畢！目前土壤濕度升至 ${state.soil_moisture.toFixed(1)}%，剩餘水位 ${state.water_level.toFixed(1)}%`);
      }, duration * 1000);
    }
  } catch (err) {
    console.error('❌ 解析控制指令失敗:', err.message);
  }
});