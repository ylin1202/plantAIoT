const axios = require('axios');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('⚠️ 未設定 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，Telegram 功能將受限。');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 紀錄告警冷卻時間（避免重複發送訊息洗版）
let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 60000; // 冷卻時間：1 分鐘

// 1. 發送文字訊息
async function sendTelegramMessage(text) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error('❌ 發送 Telegram 訊息失敗:', err.response?.data?.description || err.message);
    }
}

// 2. 發送圖片訊息 (用於 AI 診斷圖文推播)
async function sendTelegramPhoto(photoUrl, caption) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`${TELEGRAM_API}/sendPhoto`, {
            chat_id: CHAT_ID,
            photo: photoUrl,
            caption: caption,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error('❌ 發送 Telegram 照片失敗:', err.response?.data?.description || err.message);
    }
}

// 3. 自動向 Telegram 註冊官方選單按鈕 (Set My Commands)
async function registerBotCommands() {
    if (!BOT_TOKEN) return;
    try {
        await axios.post(`${TELEGRAM_API}/setMyCommands`, {
            commands: [
                { command: 'status', description: 'Get real-time plant status report' },
                { command: 'water', description: 'Remotely trigger watering for 3 seconds' },
                { command: 'photo', description: 'Trigger ESP32-CAM to take a photo & AI analysis' }
            ]
        });
        console.log('✅ [Telegram Bot] 已成功註冊官方英文選單指令 (/status, /water, /photo)！');
    } catch (err) {
        console.error('❌ 註冊 Telegram 選單失敗:', err.message);
    }
}

// 4. 檢查數據並觸發異常告警
function checkAndTriggerAlert(telemetry) {
    const now = Date.now();
    if (now - lastAlertTime < ALERT_COOLDOWN_MS) return;

    const { soil_moisture, water_level, device_id } = telemetry;
    let alertMessages = [];

    if (soil_moisture < 20.0) {
        alertMessages.push(`🌵 *🚨 Low Soil Moisture Alert!*\nDevice: \`${device_id}\`\nCurrent moisture: *${soil_moisture}%* (Threshold: 20%)`);
    }

    if (water_level < 5.0) {
        alertMessages.push(`⚠️ *🚨 Low Water Tank Alert!*\nDevice: \`${device_id}\`\nWater level: *${water_level}%*. Refill to prevent dry running!`);
    }

    if (alertMessages.length > 0) {
        lastAlertTime = now;
        const fullText = alertMessages.join('\n\n') + '\n\n💡 Tip: Tap `/water` to trigger remote watering.';
        sendTelegramMessage(fullText);
        console.log(`📱 [Telegram Bot] 已發送異常告警至手機！`);
    }
}

// 5. Telegram Bot Long Polling 指令對話監聽
let lastUpdateId = 0;
function initBotPolling(dbPool, mqttClient) {
    if (!BOT_TOKEN) return;

    // 啟動時自動幫你向 Telegram 註冊選單按鈕
    registerBotCommands();

    console.log('🤖 [Telegram Bot] 啟動指令對話監聽器 (/status, /water, /photo)...');

    setInterval(async () => {
        try {
            const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
                params: { offset: lastUpdateId + 1, timeout: 2 }
            });

            const updates = res.data.result;
            for (const update of updates) {
                lastUpdateId = update.update_id;
                const msg = update.message;
                if (!msg || !msg.text) continue;

                // 彈性解析指令：先拿第一個單詞，去除 @bot_name，再統一轉小寫
                const rawText = msg.text.trim();
                const firstWord = rawText.split(' ')[0]; // 避免後續參數干擾
                const command = firstWord.split('@')[0].toLowerCase();

                console.log(`📩 [Telegram 指令收到]: "${rawText}" -> 解析為: "${command}"`);

                // 指令 1: /status - 查詢最新狀態
                if (command === '/status') {
                    const dbRes = await dbPool.query(
                        `SELECT * FROM sensor_telemetry WHERE device_id = 'esp32_plant_01' ORDER BY time DESC LIMIT 1`
                    );
                    if (dbRes.rows.length > 0) {
                        const data = dbRes.rows[0];
                        const reply = `🌱 *【Plant Status Report】*\n` +
                            `───────────────────\n` +
                            `💧 Soil Moisture: *${data.soil_moisture}%*\n` +
                            `🌡️ Temperature: *${data.temperature} °C*\n` +
                            `☀️ Light Intensity: *${data.light_lux} Lux*\n` +
                            `🚰 Water Level: *${data.water_level}%*\n` +
                            `⏰ Updated at: \`${new Date(data.time).toLocaleTimeString()}\`\n\n` +
                            `💡 Type or tap \`/water\` to trigger remote watering, or \`/photo\` for AI diagnosis.`;
                        await sendTelegramMessage(reply);
                    } else {
                        await sendTelegramMessage('❌ No sensor telemetry data available.');
                    }
                }
                // 指令 2: /water - 發送遠端澆水
                else if (command === '/water') {
                    const dbRes = await dbPool.query(
                        `SELECT water_level FROM sensor_telemetry WHERE device_id = 'esp32_plant_01' ORDER BY time DESC LIMIT 1`
                    );
                    const waterLevel = dbRes.rows[0]?.water_level ?? 100;

                    if (waterLevel <= 5) {
                        await sendTelegramMessage('🚫 *Water Tank Low (<=5%)*! Action rejected to prevent dry running.');
                    } else {
                        const controlTopic = `tenants/demo_tenant/devices/esp32_plant_01/control`;
                        mqttClient.publish(controlTopic, JSON.stringify({ action: 'PUMP_ON', duration_sec: 3 }));

                        await dbPool.query(
                            `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
                            ['esp32_plant_01', 'TELEGRAM_WATER', 3, 'SUCCESS']
                        );

                        await sendTelegramMessage('💦 *Watering command sent!* (Pump active for 3 seconds)');
                    }
                }
                // 指令 3: /photo - 遠端觸發相機拍照與 AI 診斷
                else if (command === '/photo') {
                    await sendTelegramMessage('📸 *[Request Sent]* Triggering ESP32-CAM to capture image... Please wait for AI diagnosis.');

                    // 將 Device ID 改為 esp32_plant_01 對齊相機模擬器與全系統 Topic
                    const cameraTopic = `tenants/demo_tenant/devices/esp32_plant_01/control`;
                    mqttClient.publish(cameraTopic, JSON.stringify({
                        action: 'CAPTURE_PHOTO',
                        timestamp: new Date().toISOString()
                    }));

                    await dbPool.query(
                        `INSERT INTO actuation_logs (device_id, action_type, duration_sec, status) VALUES ($1, $2, $3, $4)`,
                        ['esp32_plant_01', 'TELEGRAM_CAPTURE', 0, 'SUCCESS']
                    );
                }
                // 指令 4: /start 或歡迎提示
                else if (command === '/start') {
                    await sendTelegramMessage('👋 Welcome to the AIoT Smart Plant Monitoring Bot!\n\nAvailable commands:\n`/status` - Get real-time status report\n`/water` - Trigger remote watering (3s)\n`/photo` - Trigger ESP32-CAM & AI analysis');
                } 
                // 指令 5: 未知指令
                else {
                    await sendTelegramMessage('🤖 Unrecognized command.\n\nPlease choose an option:\n`/status` - Get status report\n`/water` - Trigger watering\n`/photo` - Trigger AI diagnosis');
                }
            }
        } catch (err) {
            // 靜態捕捉輪詢逾時或網路波動
        }
    }, 2000);
}

module.exports = {
    checkAndTriggerAlert,
    initBotPolling,
    sendTelegramMessage,
    sendTelegramPhoto
};