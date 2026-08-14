// simulate_device.js
const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://localhost:1883');
const DEVICE_ID = 'esp32_plant_01';
const TENANT_ID = 'demo_tenant';

// Aligned topic namespaces
const TELEMETRY_TOPIC = `tenants/${TENANT_ID}/devices/${DEVICE_ID}/telemetry`;
const CONTROL_TOPIC   = `tenants/${TENANT_ID}/devices/${DEVICE_ID}/control`;

// Simulated dynamic device state
let state = {
  soil_moisture: 28.5, // Initial dry state to trigger auto/manual watering workflows
  temperature: 26.0,
  humidity: 60.0,
  light_lux: 380,
  water_level: 85.0,  // Water reservoir level (%)
  pump_active: false
};

client.on('connect', () => {
  console.log(`[ESP32 Simulator] Connected to MQTT Broker successfully.`);
  console.log(`Telemetry Topic : ${TELEMETRY_TOPIC}`);
  console.log(`Control Topic   : ${CONTROL_TOPIC}`);

  // 1. Subscribe to downlink control commands
  client.subscribe(CONTROL_TOPIC, (err) => {
    if (!err) {
      console.log(`[ESP32 Simulator] Subscribed to control channel successfully.`);
    }
  });

  // 2. Publish real-time telemetry periodically every 3 seconds
  setInterval(() => {
    // Simulate natural sensor fluctuations
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
    console.log(`[ESP32 Telemetry Dispatched]: Soil ${payload.soil_moisture}% | Temp ${payload.temperature}°C | Water ${payload.water_level}%`);
  }, 3000);
});

// 3. Handle downlink control messages dispatched from the backend
client.on('message', (topic, message) => {
  try {
    const command = JSON.parse(message.toString());
    console.log(`⚡ [ESP32 Command Received] Topic: ${topic}`, command);

    const targetActions = ['PUMP_ON', 'WATER', 'PUMP_WATER'];

    if (targetActions.includes(command.action)) {
      const duration = command.duration_sec || command.duration || 3;

      // Hardware-level dry-run safety interlock
      if (state.water_level <= 5) {
        console.log(`[ESP32 Safety Interlock] Reservoir depleted (${state.water_level}%). Pump activation aborted!`);
        return;
      }

      console.log(`[ESP32 Relay] Actuating water pump for ${duration} seconds...`);
      state.pump_active = true;

      // Simulate watering actuation dynamics
      setTimeout(() => {
        state.pump_active = false;
        state.soil_moisture = Math.min(95, state.soil_moisture + 18.0); // Soil moisture increases significantly
        state.water_level = Math.max(0, state.water_level - 4.0);        // Reservoir water level decreases
        console.log(`[ESP32 Relay] Watering cycle complete. Soil moisture: ${state.soil_moisture.toFixed(1)}%, Remaining water: ${state.water_level.toFixed(1)}%`);
      }, duration * 1000);
    }
  } catch (err) {
    console.error('[ESP32 Error] Failed to parse control payload:', err.message);
  }
});