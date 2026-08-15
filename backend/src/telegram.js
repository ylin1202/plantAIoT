const axios = require('axios');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Telegram functionality will be disabled.');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Alert cooldown tracking to prevent notification spamming
let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 60000; // Cooldown duration: 1 minute

// 1. Dispatch text messages
async function sendTelegramMessage(text) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error('Failed to dispatch Telegram message:', err.response?.data?.description || err.message);
    }
}

// 2. Dispatch photo messages (for multimodal AI diagnosis notifications)
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
        console.error('Failed to dispatch Telegram photo:', err.response?.data?.description || err.message);
    }
}

// 3. Register official command shortcuts with Telegram (Set My Commands)
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
        console.log('[Telegram Bot] Bot command shortcuts registered successfully (/status, /water, /photo).');
    } catch (err) {
        console.error('Failed to register bot commands:', err.message);
    }
}

// 4. Evaluate telemetry thresholds and trigger automated anomaly alerts
function checkAndTriggerAlert(telemetry) {
    const now = Date.now();
    if (now - lastAlertTime < ALERT_COOLDOWN_MS) return;

    const { soil_moisture, water_level, device_id } = telemetry;
    let alertMessages = [];

    if (soil_moisture < 20.0) {
        alertMessages.push(`*Low Soil Moisture Alert!*\nDevice: \`${device_id}\`\nCurrent moisture: *${soil_moisture}%* (Threshold: 20%)`);
    }

    if (water_level < 5.0) {
        alertMessages.push(`*Low Water Tank Alert!*\nDevice: \`${device_id}\`\nWater level: *${water_level}%*. Refill to prevent dry running!`);
    }

    if (alertMessages.length > 0) {
        lastAlertTime = now;
        const fullText = alertMessages.join('\n\n') + '\n\n Tip: Tap `/water` to trigger remote watering.';
        sendTelegramMessage(fullText);
        console.log(`📱 [Telegram Bot] Anomaly alert dispatched to subscriber.`);
    }
}

// 5. Telegram Bot long-polling command listener
let lastUpdateId = 0;
function initBotPolling(dbPool, mqttClient) {
    if (!BOT_TOKEN) return;

    // Automatically register command menu on initialization
    registerBotCommands();

    console.log('[Telegram Bot] Initializing long-polling command listener (/status, /water, /photo)...');

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

                // Normalize incoming command: isolate first token, strip bot tag, convert to lowercase
                const rawText = msg.text.trim();
                const firstWord = rawText.split(' ')[0];
                const command = firstWord.split('@')[0].toLowerCase();

                console.log(`[Telegram Command Received]: "${rawText}" -> Parsed as: "${command}"`);

                // Command 1: /status - Fetch latest telemetry
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
                        await sendTelegramMessage('No sensor telemetry data available.');
                    }
                }
                // Command 2: /water - Trigger remote pump actuation
                else if (command === '/water') {
                    const dbRes = await dbPool.query(
                        `SELECT water_level FROM sensor_telemetry WHERE device_id = 'esp32_plant_01' ORDER BY time DESC LIMIT 1`
                    );
                    const waterLevel = dbRes.rows[0]?.water_level ?? 100;

                    if (waterLevel <= 5) {
                        await sendTelegramMessage('*Water Tank Low (<=5%)*! Action rejected to prevent dry running.');
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
                // Command 3: /photo - Trigger camera capture & AI analysis pipeline
                else if (command === '/photo') {
                    await sendTelegramMessage('📸 *[Request Sent]* Triggering ESP32-CAM to capture image... Please wait for AI diagnosis.');

                    // Align device identifier with system-wide topic schema
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
                // Command 4: /start or greeting message
                else if (command === '/start') {
                    await sendTelegramMessage('Welcome to the AIoT Smart Plant Monitoring Bot!\n\nAvailable commands:\n`/status` - Get real-time status report\n`/water` - Trigger remote watering (3s)\n`/photo` - Trigger ESP32-CAM & AI analysis');
                } 
                // Command 5: Fallback unknown command handler
                else {
                    await sendTelegramMessage('Unrecognized command.\n\nPlease choose an option:\n`/status` - Get status report\n`/water` - Trigger watering\n`/photo` - Trigger AI diagnosis');
                }
            }
        } catch (err) {
            // Silently handle polling timeouts or transient network blips
        }
    }, 2000);
}

module.exports = {
    checkAndTriggerAlert,
    initBotPolling,
    sendTelegramMessage,
    sendTelegramPhoto
};