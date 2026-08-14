const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');
const DEVICE_ID = 'esp32_plant_01';
const TOPIC = `tenants/demo_tenant/devices/${DEVICE_ID}/telemetry`;

client.on('connect', async () => {
  console.log('[Test Started] Simulating ESP32 reconnect: flushing 100 buffered offline records in 1 second...');

  const now = Date.now();
  for (let i = 100; i >= 1; i--) {
    // Generate historical timestamps over the past 100 minutes
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

  console.log('100 backfill records dispatched to MQTT. Watch BullMQ smooth and process the ingress load!');
  setTimeout(() => client.end(), 1000);
});