const { checkAndTriggerAlert, sendTelegramMessage } = require('./telegram');

// Track timestamp of last auto-watering event (prevents over-watering and alert spam; default: 5 minutes)
let lastAutoWaterTime = 0;
const AUTO_WATER_COOLDOWN_MS = 5 * 60 * 1000; 

/**
 * Automated rule engine evaluator.
 * @param {Object} telemetry - Sensor telemetry payload.
 * @param {Object} dbPool - PostgreSQL / TimescaleDB connection pool.
 * @param {Object} mqttClient - MQTT client instance.
 */
async function processAutomationRules(telemetry, dbPool, mqttClient) {
  const { soil_moisture, water_level, device_id } = telemetry;
  const tenant_id = 'demo_tenant';
  const now = Date.now();

  // Evaluate baseline anomaly alerts and dispatch via telegram.js
  checkAndTriggerAlert(telemetry);

  // -------------------------------------------------------------
  // Rule 1: Automated Soil Rehydration (Auto-Watering Rule)
  // -------------------------------------------------------------
  if (soil_moisture < 20.0) {
    // Check cooldown window
    if (now - lastAutoWaterTime < AUTO_WATER_COOLDOWN_MS) {
      console.log(`[Rule Engine] Soil moisture (${soil_moisture}%) is below threshold, but rule is within cooldown window. Skipping.`);
      return;
    }

    // Evaluate hardware-level dry-run prevention interlock
    if (water_level <= 5.0) {
      console.warn(`[Rule Engine] Auto-watering conditions met, but water reservoir is low (${water_level}% <= 5%). Dry-run interlock engaged.`);
      
      // Persist rejection log into TimescaleDB
      await dbPool.query(
        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
        [device_id, 'AUTO_RULE_WATER', 3, 'REJECTED_LOW_WATER']
      );

      sendTelegramMessage(`🚫 *【Auto-Watering Locked】*\nLow soil moisture detected (*${soil_moisture}%*), but water reservoir level is critically low (*${water_level}%*). The pump has been locked to prevent dry-running damage. Please refill the reservoir.`);
      return;
    }

    // Trigger automated watering actuation
    lastAutoWaterTime = now;
    const duration_sec = 3;
    const controlTopic = `tenants/${tenant_id}/devices/${device_id}/control`;
    const payload = JSON.stringify({
      action: 'PUMP_ON',
      duration_sec: duration_sec,
      trigger_by: 'AUTO_RULE_ENGINE',
      timestamp: new Date().toISOString()
    });

    // 1. Publish MQTT downlink control command
    mqttClient.publish(controlTopic, payload);
    console.log(`[Automation Engine] Low soil moisture detected (${soil_moisture}% < 20%). Dispatched PUMP_ON command (${duration_sec}s).`);

    // 2. Persist execution record into actuation_logs
    try {
      await dbPool.query(
        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
        [device_id, 'AUTO_RULE_WATER', duration_sec, 'SUCCESS']
      );
    } catch (err) {
      console.error('[Database Error] Failed to persist actuation log:', err.message);
    }

    // 3. Dispatch alert notification via Telegram
    sendTelegramMessage(
      `🤖 *【Automation Triggered: Auto-Watering】*\n` +
      `───────────────────\n` +
      `📡 Device: \`${device_id}\`\n` +
      `💧 Current Soil Moisture: *${soil_moisture}%* (Threshold: < 20%)\n` +
      `🚰 Water Reservoir Level: *${water_level}%*\n` +
      `⚡ Action: Water pump activated for *${duration_sec} seconds*.`
    );
  }
}

module.exports = {
  processAutomationRules
};