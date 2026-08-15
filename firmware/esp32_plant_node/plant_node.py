import time
import json
import dht
import neopixel
from machine import Pin, SoftI2C, ADC, PWM
from ssd1306 import SSD1306_I2C
from umqttsimple import MQTTClient
import config

class PlantNode:
    """ESP32 Intelligent Plant Monitoring Edge Node."""

    def __init__(self):
        self.device_id = config.DEVICE_ID
        self.last_water_time = 0
        self.water_cooldown_sec = 300  # 5 minutes cooldown to prevent over-watering
        self.last_reconnect_attempt = 0
        self.reconnect_interval_sec = 10
        self.mqtt_client = None

        self._init_hardware()
        self._init_mqtt()

    def _init_hardware(self):
        """Initialize GPIO actuators, status indicators, and sensors."""
        # Actuators & Indicators
        self.np = neopixel.NeoPixel(Pin(config.PIN_NEOPIXEL, Pin.OUT), config.NUM_LEDS)
        self.red_led = Pin(config.PIN_LED_RED, Pin.OUT)
        self.yellow_led = Pin(config.PIN_LED_YELLOW, Pin.OUT)
        self.green_led = Pin(config.PIN_LED_GREEN, Pin.OUT)
        
        self.pump_pin = Pin(config.PIN_PUMP, Pin.OUT)
        self.pump_pin.off()
        self.buzzer_pin = Pin(config.PIN_BUZZER, Pin.OUT)

        # Analog & Digital Sensors
        self.adc_water = ADC(Pin(config.PIN_WATER_ADC))
        self.adc_water.atten(ADC.ATTN_11DB)

        self.adc_soil = ADC(Pin(config.PIN_SOIL_ADC))
        self.adc_soil.atten(ADC.ATTN_11DB)

        self.light_sensor = Pin(config.PIN_LIGHT_SENSOR, Pin.IN)
        self.dht_sensor = dht.DHT11(Pin(config.PIN_DHT11))

        # SSD1306 OLED Display
        i2c = SoftI2C(sda=Pin(config.PIN_OLED_SDA), scl=Pin(config.PIN_OLED_SCL))
        self.oled = SSD1306_I2C(128, 64, i2c)

    def _init_mqtt(self):
        """Establish MQTT connection and subscribe to downlink control channel."""
        try:
            self.mqtt_client = MQTTClient(
                self.device_id,
                config.MQTT_BROKER,
                port=config.MQTT_PORT,
                keepalive=60
            )
            self.mqtt_client.set_callback(self._on_mqtt_message)
            self.mqtt_client.connect()
            self.mqtt_client.subscribe(config.MQTT_TOPIC_CONTROL)
            print(f"[PlantNode] Connected to MQTT broker and subscribed to: {config.MQTT_TOPIC_CONTROL.decode()}")
        except Exception as e:
            print("[PlantNode Warning] MQTT connection failed, running in standalone mode:", e)
            self.mqtt_client = None

    def _check_and_reconnect_mqtt(self):
        """Handle non-blocking auto-reconnect logic if broker disconnects."""
        now = time.time()
        if self.mqtt_client is None and (now - self.last_reconnect_attempt > self.reconnect_interval_sec):
            self.last_reconnect_attempt = now
            print("[PlantNode] Attempting to reconnect to MQTT broker...")
            self._init_mqtt()

    def _on_mqtt_message(self, topic, msg):
        """Handle downlink actuation commands from backend."""
        try:
            payload = json.loads(msg.decode())
            print(f"⚡ [ESP32 Command Received]: {payload}")
            
            if payload.get("action") in ["PUMP_ON", "WATER", "PUMP_WATER"]:
                duration = payload.get("duration_sec", 3)
                self.trigger_watering(duration_sec=duration)
        except Exception as e:
            print("[ESP32 Error] Failed to parse control payload:", e)

    # ------------------ Sensor Acquisition ------------------
    def read_soil_moisture_pct(self) -> float:
        """Calculate calibrated soil moisture percentage."""
        raw_val = self.adc_soil.read()
        span = config.SOIL_DRY_ADC - config.SOIL_WET_ADC
        if span <= 0:
            span = 1
        pct = 100.0 * (config.SOIL_DRY_ADC - raw_val) / span
        return max(0.0, min(100.0, pct))

    def read_telemetry(self) -> dict:
        """Capture sensor readings and format into standard telemetry schema."""
        try:
            self.dht_sensor.measure()
            temp = float(self.dht_sensor.temperature())
            humid = float(self.dht_sensor.humidity())
        except Exception:
            temp, humid = 25.0, 60.0

        soil_pct = round(self.read_soil_moisture_pct(), 1)
        
        # Reservoir level calculation
        water_raw = self.adc_water.read_u16()
        water_cm = (water_raw / 65535.0) * config.MAX_WATER_LEVEL_CM
        water_pct = round(max(0.0, min(100.0, (water_cm / config.MAX_WATER_LEVEL_CM) * 100.0)), 1)
        
        light_lux = 500 if self.light_sensor.value() == 0 else 0

        return {
            "device_id": self.device_id,
            "soil_moisture": soil_pct,
            "temperature": temp,
            "humidity": humid,
            "light_lux": light_lux,
            "water_level": water_pct,
            "water_level_cm": round(water_cm, 2),
            "timestamp": time.time()
        }

    # ------------------ Actuation & Hardware Protection ------------------
    def trigger_buzzer(self):
        """Sound the alarm buzzer for critical notifications."""
        try:
            buzzer_pwm = PWM(self.buzzer_pin)
            buzzer_pwm.freq(440)
            buzzer_pwm.duty(512)
            time.sleep(0.3)
            buzzer_pwm.duty(0)
            buzzer_pwm.deinit()
        except Exception:
            pass

    def update_led_indicators(self, soil_pct: float, water_pct: float):
        """Update discrete status LEDs and NeoPixel reservoir bar."""
        if soil_pct > 50:
            self.green_led.on(); self.yellow_led.off(); self.red_led.off()
        elif soil_pct > 25:
            self.yellow_led.on(); self.green_led.off(); self.red_led.off()
        else:
            self.red_led.on(); self.green_led.off(); self.yellow_led.off()

        active_count = min(int((water_pct / 100.0) * config.NUM_LEDS), config.NUM_LEDS)
        for i in range(config.NUM_LEDS):
            self.np[i] = (66, 66, 245) if i < active_count else (0, 0, 0)
        self.np.write()

    def trigger_watering(self, duration_sec: int = 3):
        """Actuate relay pump with hardware dry-run safety lock."""
        current_data = self.read_telemetry()
        if current_data["water_level"] <= 5.0:
            print("[Safety Interlock] Water reservoir depleted (<= 5%). Pump actuation aborted!")
            self.trigger_buzzer()
            return

        print(f"[Actuation] Running water pump for {duration_sec} seconds...")
        self.pump_pin.on()
        time.sleep(duration_sec)
        self.pump_pin.off()
        self.last_water_time = time.time()

    def render_oled(self, data: dict):
        """Render formatted metrics to SSD1306 OLED screen."""
        self.oled.fill(0)
        self.oled.text(f"Temp: {data['temperature']:.1f} C", 0, 0)
        self.oled.text(f"Humid: {data['humidity']:.1f} %", 0, 16)
        self.oled.text(f"Soil: {data['soil_moisture']:.1f} %", 0, 32)
        self.oled.text(f"Water: {data['water_level']:.1f} %", 0, 48)
        self.oled.show()

    # ------------------ Main Runtime Loop ------------------
    def run(self):
        print("[PlantNode] Edge node initialized and monitoring loop active...")
        
        while True:
            try:
                # 1. Manage MQTT connection & process incoming commands
                if self.mqtt_client:
                    self.mqtt_client.check_msg()
                else:
                    self._check_and_reconnect_mqtt()

                # 2. Acquire sensor telemetry & update UI
                data = self.read_telemetry()
                self.update_led_indicators(data['soil_moisture'], data['water_level'])
                self.render_oled(data)

                # 3. Critical low reservoir buzzer alert
                if data['water_level'] <= 5.0:
                    self.trigger_buzzer()

                # 4. Standalone fallback auto-watering (with cooldown hysteresis)
                now = time.time()
                is_cooldown_ready = (now - self.last_water_time) > self.water_cooldown_sec
                if data['soil_moisture'] < config.LOW_MOISTURE_THRESHOLD and data['water_level'] > 5.0 and is_cooldown_ready:
                    print("[Local Fallback] Low moisture threshold reached outside cloud control. Triggering emergency watering.")
                    self.trigger_watering(duration_sec=2)

                # 5. Dispatch telemetry to MQTT broker
                if self.mqtt_client:
                    try:
                        self.mqtt_client.publish(config.MQTT_TOPIC_TELEMETRY, json.dumps(data))
                        print(f"[Telemetry Published]: Soil {data['soil_moisture']}% | Water {data['water_level']}%")
                    except Exception as pub_err:
                        print("[MQTT Error] Failed to publish telemetry, resetting client:", pub_err)
                        self.mqtt_client = None

            except Exception as e:
                print("[PlantNode Exception]:", e)

            time.sleep(3)