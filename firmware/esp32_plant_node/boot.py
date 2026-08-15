import network
import time
import config

def connect_wifi() -> bool:
    """Connect ESP32 to local Wi-Fi access point."""
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    
    if not wlan.isconnected():
        print(f"[Wi-Fi] Connecting to network: {config.WIFI_SSID}...")
        wlan.connect(config.WIFI_SSID, config.WIFI_PASS)
        
        timeout = 15
        while not wlan.isconnected() and timeout > 0:
            time.sleep(1)
            timeout -= 1

    if wlan.isconnected():
        print(f"[Wi-Fi] Connected successfully. Assigned IP: {wlan.ifconfig()[0]}")
        return True
    else:
        print("[Wi-Fi Error] Connection timed out or failed.")
        return False

connect_wifi()