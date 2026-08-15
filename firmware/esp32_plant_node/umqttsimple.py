import usocket as socket
import ustruct as struct

class MQTTException(Exception):
    pass

class MQTTClient:
    def __init__(self, client_id, server, port=0, user=None, password=None, keepalive=0, ssl=False, ssl_params={}):
        if port == 0:
            port = 8883 if ssl else 1883
        self.client_id = client_id
        self.sock = None
        self.server = server
        self.port = port
        self.ssl = ssl
        self.ssl_params = ssl_params
        self.user = user
        self.pswd = password
        self.keepalive = keepalive
        self.cb = None
        self.pid = 0  # 修正：補上 PID 初始化

    def _send_str(self, s):
        self.sock.write(struct.pack("!H", len(s)))
        self.sock.write(s)

    def _recv_len(self):
        n = 0
        sh = 0
        while True:
            b = self.sock.read(1)[0]
            n |= (b & 0x7f) << sh
            if not b & 0x80:
                return n
            sh += 7

    def set_callback(self, f):
        self.cb = f

    def connect(self, clean_session=True):
        self.sock = socket.socket()
        addr = socket.getaddrinfo(self.server, self.port)[0][-1]
        self.sock.connect(addr)
        if self.ssl:
            import ussl
            self.sock = ussl.wrap_socket(self.sock, **self.ssl_params)
        msg = bytearray(b"\x10\x00\x00\x04MQTT\x04\x02\x00\x00")
        msg[1] = 10 + 2 + len(self.client_id)
        msg[9] = clean_session << 1
        if self.user is not None:
            msg[1] += 2 + len(self.user) + 2 + len(self.pswd)
            msg[9] |= 0xC0
        if self.keepalive:
            msg[10] |= self.keepalive >> 8
            msg[11] |= self.keepalive & 0xFF
        self.sock.write(msg)
        self._send_str(self.client_id)
        if self.user is not None:
            self._send_str(self.user)
            self._send_str(self.pswd)
        resp = self.sock.read(4)
        assert resp[0] == 0x20 and resp[1] == 0x02
        if resp[3] != 0:
            raise MQTTException(resp[3])
        return resp[2] & 1

    def publish(self, topic, msg, retain=False, qos=0):
        pkt = bytearray(b"\x30\x00\x00")
        pkt[0] |= qos << 1 | retain
        sz = 2 + len(topic) + len(msg)
        if sz >= 2097152:
            raise MQTTException("Payload size too large")
        i = 1
        while sz > 0x7F:
            pkt[i] = (sz & 0x7F) | 0x80
            sz >>= 7
            i += 1
            pkt.append(0)
        pkt[i] = sz
        self.sock.write(pkt[:i+1])
        self._send_str(topic)
        self.sock.write(msg)

    def subscribe(self, topic, qos=0):
        pkt = bytearray(b"\x82\x00\x00\x00")
        self.pid += 1
        struct.pack_into("!BHH", pkt, 0, 0x82, 2 + 2 + len(topic) + 1, self.pid)
        self.sock.write(pkt)
        self._send_str(topic)
        self.sock.write(struct.pack("B", qos))

    def check_msg(self):
        if not self.sock:
            return
        self.sock.setblocking(False)
        try:
            res = self.sock.read(1)
            if not res or res == b"\xd0":
                return
            if res[0] & 0xF0 == 0x30:
                glen = self._recv_len()
                topic_len = struct.unpack("!H", self.sock.read(2))[0]
                topic = self.sock.read(topic_len)
                var_len = 2 + topic_len
                msg = self.sock.read(glen - var_len)
                if self.cb:
                    self.cb(topic, msg)
        except Exception:
            pass
        finally:
            self.sock.setblocking(True)

    def disconnect(self):
        if self.sock:
            try:
                self.sock.write(b"\xe0\x00")
                self.sock.close()
            except Exception:
                pass
            self.sock = None