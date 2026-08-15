# --- Wi-Fi & MQTT Configuration ---
WIFI_SSID = "YOUR_WIFI_SSID"
WIFI_PASS = "YOUR_WIFI_PASSWORD"
MQTT_BROKER = "192.168.88.102"    # Host machine LAN IP
MQTT_PORT = 1883
DEVICE_ID = "esp32_plant_01"
TENANT_ID = "demo_tenant"

MQTT_TOPIC_TELEMETRY = f"tenants/{TENANT_ID}/devices/{DEVICE_ID}/telemetry".encode()
MQTT_TOPIC_CONTROL   = f"tenants/{TENANT_ID}/devices/{DEVICE_ID}/control".encode()

# --- Hardware Pin Mapping (ESP32 GPIO) ---
PIN_NEOPIXEL = 15
NUM_LEDS = 8

PIN_RAIN_ADC = 4
PIN_WATER_ADC = 26
PIN_SOIL_ADC = 25
PIN_LIGHT_SENSOR = 13

PIN_PUMP = 5
PIN_BUZZER = 2

PIN_DHT11 = 16

PIN_OLED_SDA = 19
PIN_OLED_SCL = 22

PIN_LED_RED = 17
PIN_LED_YELLOW = 3
PIN_LED_GREEN = 21

# --- Calibration & Thresholds ---
SOIL_DRY_ADC = 3800             # Raw ADC reading in dry air
SOIL_WET_ADC = 1300             # Raw ADC reading in water
LOW_MOISTURE_THRESHOLD = 20.0   # Soil moisture trigger threshold (%)
MAX_WATER_LEVEL_CM = 3.5        # Max calibrated sensor water depth (cm)