const { checkAndTriggerAlert, sendTelegramMessage } = require('./telegram');

// Track timestamp of last auto-watering event (prevents over-watering and alert spam; default: 5 minutes)
let lastAutoWaterTime = 0;
const AUTO_WATER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 *
 * @param {string} device_id
 * @param {number} water_level - most recent water reservoir level (%)
 * @param {Object} mqttClient
 * @param {Object} dbPool
 * @param {string} triggerSource - 'AUTO_RULE' | 'AI_VISION' (used in logs/labels)
 * @returns {Promise<{triggered: boolean, reason?: string}>}
 */
async function attemptWatering(device_id, water_level, mqttClient, dbPool, triggerSource) {
  const tenant_id = 'demo_tenant';
  const now = Date.now();

  // Cooldown debounce (shared across all trigger sources)
  if (now - lastAutoWaterTime < AUTO_WATER_COOLDOWN_MS) {
    console.log(`[Rule Engine] Cooldown active (source: ${triggerSource}). Skipping watering.`);
    return { triggered: false, reason: 'cooldown' };
  }

  // Hardware-level dry-run prevention interlock
  if (water_level == null || water_level <= 5.0) {
    console.warn(`[Rule Engine] Watering requested (source: ${triggerSource}), but water reservoir is low (${water_level}% <= 5%). Dry-run interlock engaged.`);

    try {
      await dbPool.query(
        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
        [device_id, `${triggerSource}_WATER`, 3, 'REJECTED_LOW_WATER']
      );
    } catch (err) {
      console.error('[Database Error] Failed to persist rejection log:', err.message);
    }

    sendTelegramMessage(
      `🚫 *【Watering Locked】*\nSource: *${triggerSource}*\nDevice: \`${device_id}\`\nWater reservoir level is critically low (*${water_level}%*). Pump locked to prevent dry-running damage.`
    );
    return { triggered: false, reason: 'low_water' };
  }

  // All checks passed — dispatch the MQTT pump command
  lastAutoWaterTime = now;
  const duration_sec = 3;
  const controlTopic = `tenants/${tenant_id}/devices/${device_id}/control`;
  const payload = JSON.stringify({
    action: 'PUMP_ON',
    duration_sec,
    trigger_by: triggerSource,
    timestamp: new Date().toISOString(),
  });

  mqttClient.publish(controlTopic, payload);
  console.log(`[Automation Engine] Watering triggered by ${triggerSource}. Dispatched PUMP_ON command (${duration_sec}s) to ${controlTopic}.`);

  try {
    await dbPool.query(
      `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
      [device_id, `${triggerSource}_WATER`, duration_sec, 'SUCCESS']
    );
  } catch (err) {
    console.error('[Database Error] Failed to persist actuation log:', err.message);
  }

  sendTelegramMessage(
    `🤖 *【Automation Triggered: ${triggerSource}】*\n` +
    `───────────────────\n` +
    `📡 Device: \`${device_id}\`\n` +
    `🚰 Water Reservoir Level: *${water_level}%*\n` +
    `⚡ Action: Water pump activated for *${duration_sec} seconds*.`
  );

  return { triggered: true };
}

/**
 * Automated rule engine evaluator, invoked on every incoming telemetry message.
 * @param {Object} telemetry - Sensor telemetry payload.
 * @param {Object} dbPool - PostgreSQL / TimescaleDB connection pool.
 * @param {Object} mqttClient - MQTT client instance.
 */
async function processAutomationRules(telemetry, dbPool, mqttClient) {
  const { soil_moisture, water_level, device_id } = telemetry;

  // Evaluate baseline anomaly alerts and dispatch via telegram.js
  checkAndTriggerAlert(telemetry);

  if (soil_moisture < 20.0) {
    console.log(`[Rule Engine] Soil moisture (${soil_moisture}%) below 20% threshold. Evaluating auto-watering.`);
    await attemptWatering(device_id, water_level, mqttClient, dbPool, 'AUTO_RULE');
  }
}

module.exports = {
  processAutomationRules,
  attemptWatering,
};