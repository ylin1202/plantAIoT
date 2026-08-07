const { checkAndTriggerAlert, sendTelegramMessage } = require('./telegram');

// 紀錄上次自動澆水時間（防洗版與防過度澆水冷卻，預設 5 分鐘）
let lastAutoWaterTime = 0;
const AUTO_WATER_COOLDOWN_MS = 5 * 60 * 1000; 

/**
 * 自動化規則檢查器
 * @param {Object} telemetry - 感測器上報數據
 * @param {Object} dbPool - PostgreSQL / TimescaleDB 連線池
 * @param {Object} mqttClient - MQTT 戶端
 */
async function processAutomationRules(telemetry, dbPool, mqttClient) {
  const { soil_moisture, water_level, device_id } = telemetry;
  const tenant_id = 'demo_tenant';
  const now = Date.now();

  // 先進行基礎告警推播檢查（傳送至 telegram.js）
  checkAndTriggerAlert(telemetry);

  // -------------------------------------------------------------
  // 規則 1: 土壤自動補水 (Auto-Watering Rule)
  // -------------------------------------------------------------
  if (soil_moisture < 20.0) {
    // 檢查冷卻時間
    if (now - lastAutoWaterTime < AUTO_WATER_COOLDOWN_MS) {
      console.log(`⏱️ [規則引擎] 土壤濕度 ${soil_moisture}% 低於門檻，但處於冷卻期內，暫不重複觸發。`);
      return;
    }

    // 檢查硬體級水箱防乾燒
    if (water_level <= 5.0) {
      console.warn(`⚠️ [規則引擎] 觸發自動澆水條件，但水箱水位僅 ${water_level}% (<=5%)，執行防乾燒鎖定！`);
      
      // 寫入拒絕 Log
      await dbPool.query(
        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
        [device_id, 'AUTO_RULE_WATER', 3, 'REJECTED_LOW_WATER']
      );

      sendTelegramMessage(`🚫 *【自動澆水被鎖定】*\n檢測到土壤過乾 (${soil_moisture}%)，但水箱水位僅 *${water_level}%*，系統已安全鎖定抽水泵防乾燒！請補充水箱。`);
      return;
    }

    // 觸發自動澆水
    lastAutoWaterTime = now;
    const duration_sec = 3;
    const controlTopic = `tenants/${tenant_id}/devices/${device_id}/control`;
    const payload = JSON.stringify({
      action: 'PUMP_ON',
      duration_sec: duration_sec,
      trigger_by: 'AUTO_RULE_ENGINE',
      timestamp: new Date().toISOString()
    });

    // 1. 發送 MQTT 下行控制指令
    mqttClient.publish(controlTopic, payload);
    console.log(`🤖 [自動化規則引擎] 檢測到土壤濕度 ${soil_moisture}% < 20%，已自動下發 PUMP_ON 指令 (${duration_sec}s)！`);

    // 2. 紀錄至資料庫 Actuation Logs
    try {
      await dbPool.query(
        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
        [device_id, 'AUTO_RULE_WATER', duration_sec, 'SUCCESS']
      );
    } catch (err) {
      console.error('❌ 寫入致動日誌失敗:', err.message);
    }

    // 3. 推送 Telegram 通報
    sendTelegramMessage(
      `🤖 *【自動化規則觸發：自動補水】*\n` +
      `───────────────────\n` +
      `📡 裝置: \`${device_id}\`\n` +
      `💧 當前土壤濕度: *${soil_moisture}%* (低於門檻 20%)\n` +
      `🚰 當前水箱水位: *${water_level}%*\n` +
      `⚡ 動作: 系統已自動啟動抽水泵運轉 *${duration_sec} 秒*！`
    );
  }
}

module.exports = {
  processAutomationRules
};