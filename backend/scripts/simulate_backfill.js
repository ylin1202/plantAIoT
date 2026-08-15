const mqtt = require('mqtt');
require('dotenv').config();

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883');
const TOPIC = 'tenants/demo_tenant/devices/esp32_plant_01/telemetry';

mqttClient.on('connect', async () => {
  console.log('[ESP32 Backfill Simulator] Connected to MQTT Broker.');
  console.log('Simulation Scenario: ESP32 reconnected after a 10-minute network outage; flushing buffered SPIFFS flash telemetry data...');

  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;
  
  // Simulate generating telemetry records for the past 10 minutes (1 record every 10s, total 60 records) with historical timestamps
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

  console.log('[Backfill Complete] 60 offline historical records successfully dispatched to MQTT.');
  console.log('Check backend console: BullMQ Queue is actively rate-limiting and smoothing database ingestion (Concurrency: 5) into TimescaleDB.');
  setTimeout(() => process.exit(0), 1000);
});