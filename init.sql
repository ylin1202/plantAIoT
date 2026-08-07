-- 啟用 TimescaleDB 擴充功能
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. 建立感測器原始數據表 (Sensor Telemetry Table)
CREATE TABLE sensor_telemetry (
    time        TIMESTAMPTZ NOT NULL,
    device_id   VARCHAR(50) NOT NULL,
    soil_moisture DOUBLE PRECISION,   -- 土壤濕度 (%)
    temperature   DOUBLE PRECISION,   -- 環境溫度 (°C)
    humidity      DOUBLE PRECISION,   -- 環境濕度 (%)
    light_lux     DOUBLE PRECISION,   -- 光照強度 (Lux)
    water_level   DOUBLE PRECISION,   -- 水位高度/狀態
    PRIMARY KEY (time, device_id)
);

-- 將一般資料表轉為 TimescaleDB 的 Hypertable (按時間自動分區)
SELECT create_hypertable('sensor_telemetry', 'time');

-- 建立索引以提升查詢速度
CREATE INDEX idx_device_id_time ON sensor_telemetry (device_id, time DESC);

-- 2. 建立自動降採樣視圖 (Continuous Aggregation): 每小時數據平均/極值
CREATE MATERIALIZED VIEW hourly_sensor_summary
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket_time,
    device_id,
    AVG(soil_moisture) AS avg_soil_moisture,
    MIN(soil_moisture) AS min_soil_moisture,
    MAX(soil_moisture) AS max_soil_moisture,
    AVG(temperature)   AS avg_temperature,
    AVG(humidity)      AS avg_humidity,
    AVG(light_lux)     AS avg_light
FROM sensor_telemetry
GROUP BY bucket_time, device_id;

-- 設定背景自動更新降採樣視圖 (每 30 分鐘更新一次過去 2 小時內的數據)
SELECT add_continuous_aggregate_policy('hourly_sensor_summary',
    start_offset => INTERVAL '2 hours',
    end_offset   => INTERVAL '10 minutes',
    schedule_interval => INTERVAL '30 minutes');

-- 3. 設定資料保留策略 (Retention Policy): 原始高頻數據超過 30 天自動刪除，釋放空間
SELECT add_retention_policy('sensor_telemetry', INTERVAL '30 days');


-- 4. 建立 AI 診斷日誌表 (AI Diagnostic Results)
CREATE TABLE ai_diagnostics (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    device_id   VARCHAR(50) NOT NULL,
    image_url   TEXT NOT NULL,
    disease_label VARCHAR(100) NOT NULL, -- 如: Healthy, Yellow_Leaf, Blight
    confidence  DOUBLE PRECISION NOT NULL,  -- 信心分數 (例: 0.95)
    description TEXT
);

-- 5. 建立致動器控制紀錄表 (Actuation Logs - 澆水紀錄)
CREATE TABLE actuation_logs (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    device_id   VARCHAR(50) NOT NULL,
    action_type VARCHAR(50) NOT NULL, -- 如: AUTO_WATER, MANUAL_WATER
    duration_sec INT NOT NULL,         -- 抽水持續時間 (秒)
    status      VARCHAR(20) NOT NULL  -- SUCCESS, REJECTED_NO_WATER, FAILED
);


-- 建立 AI 影像分析紀錄表
CREATE TABLE IF NOT EXISTS ai_image_analyses (
    time TIMESTAMPTZ NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    raw_image_path TEXT NOT NULL,
    processed_image_path TEXT NOT NULL,
    detections JSONB DEFAULT '[]'::jsonb
);

-- 轉為 TimescaleDB 超級表 (Hypertable)
SELECT create_hypertable('ai_image_analyses', 'time', if_not_exists => TRUE);

--

-- 1.1 建立每小時自動降採樣視圖 (加上 WITH NO DATA 避免 Transaction 限制)
CREATE MATERIALIZED VIEW sensor_telemetry_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    device_id,
    AVG(soil_moisture) AS avg_soil_moisture,
    AVG(temperature) AS avg_temperature,
    AVG(humidity) AS avg_humidity,
    AVG(light_lux) AS avg_light_lux,
    AVG(water_level) AS avg_water_level
FROM sensor_telemetry
GROUP BY bucket, device_id
WITH NO DATA;

-- 1.2 設定 Continuous Aggregation 自動更新 Policy (每 30 分鐘自動刷入新數據)
SELECT add_continuous_aggregate_policy('sensor_telemetry_hourly',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');

-- 1.3 手動刷入既有歷史數據一次 (非必要，但能立刻讓視圖有資料)
CALL refresh_continuous_aggregate('sensor_telemetry_hourly', NULL, NULL);

-- 1.4 設定過期數據自動清理 Policy (超過 90 天自動清理原始細粒度數據)
SELECT add_retention_policy('sensor_telemetry', INTERVAL '90 days');