-- ============================================================
-- 0. Enable TimescaleDB Extension
-- ============================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================
-- 1. High-Frequency Sensor Telemetry (Hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS sensor_telemetry (
    time            TIMESTAMPTZ NOT NULL,
    device_id       VARCHAR(50) NOT NULL,
    soil_moisture   DOUBLE PRECISION,
    temperature     DOUBLE PRECISION,
    humidity        DOUBLE PRECISION,
    light_lux       DOUBLE PRECISION,
    water_level     DOUBLE PRECISION,
    PRIMARY KEY (time, device_id)
);

-- Convert standard table to TimescaleDB Hypertable partitioned by time
SELECT create_hypertable('sensor_telemetry', 'time', if_not_exists => TRUE);

-- Create compound index for fast device timeseries lookups
CREATE INDEX IF NOT EXISTS idx_sensor_telemetry_device_time 
    ON sensor_telemetry (device_id, time DESC);

-- ============================================================
-- 2. Actuator Execution Logs (Relational Table)
-- ============================================================
CREATE TABLE IF NOT EXISTS actuation_logs (
    id              SERIAL PRIMARY KEY,
    device_id       VARCHAR(50) NOT NULL,
    action_type     VARCHAR(50) NOT NULL, -- e.g., PUMP_WATER, AUTO_WATER, MANUAL_WATER
    duration_sec    INT NOT NULL,
    status          VARCHAR(50) NOT NULL, -- e.g., SUCCESS, REJECTED_NO_WATER, FAILED
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_actuation_logs_device_created 
    ON actuation_logs (device_id, created_at DESC);

-- ============================================================
-- 3. AI Visual Analysis Records (Hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_image_analyses (
    time                 TIMESTAMPTZ NOT NULL,
    device_id            VARCHAR(64) NOT NULL,
    raw_image_path       TEXT NOT NULL,
    processed_image_path TEXT NOT NULL,
    detections           JSONB DEFAULT '[]'::jsonb,
    PRIMARY KEY (time, device_id)
);

SELECT create_hypertable('ai_image_analyses', 'time', if_not_exists => TRUE);

-- ============================================================
-- 4. Continuous Aggregate View (Hourly Downsampling)
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_telemetry_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    device_id,
    AVG(soil_moisture) AS avg_soil_moisture,
    MIN(soil_moisture) AS min_soil_moisture,
    MAX(soil_moisture) AS max_soil_moisture,
    AVG(temperature)   AS avg_temperature,
    MIN(temperature)   AS min_temperature,
    MAX(temperature)   AS max_temperature,
    AVG(humidity)      AS avg_humidity,
    AVG(light_lux)     AS avg_light_lux,
    AVG(water_level)   AS avg_water_level,
    COUNT(*)           AS sample_count
FROM sensor_telemetry
GROUP BY bucket, device_id
WITH NO DATA;

-- Policy: Automatically refresh aggregated hourly view every 30 minutes
SELECT add_continuous_aggregate_policy('sensor_telemetry_hourly',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes'
);

-- ============================================================
-- 5. Data Retention Policies (Automated Cleanup)
-- ============================================================
-- A. Retain raw sensor telemetry for 30 days
SELECT add_retention_policy('sensor_telemetry', INTERVAL '30 days', if_not_exists => TRUE);

-- B. Retain AI diagnostic records for 90 days
SELECT add_retention_policy('ai_image_analyses', INTERVAL '90 days', if_not_exists => TRUE);

-- C. Retain downsampled hourly aggregates for 365 days
SELECT add_retention_policy('sensor_telemetry_hourly', INTERVAL '365 days', if_not_exists => TRUE);