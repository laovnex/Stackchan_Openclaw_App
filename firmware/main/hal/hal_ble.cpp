/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/bleprph/bleprph.h"
#include "utils/secret_logic/secret_logic.h"
#include <ArduinoJson.hpp>
#include <mooncake_log.h>
#include <mooncake.h>
#include <settings.h>
#include <esp_mac.h>
#include <algorithm>

static const std::string_view _tag = "HAL-BLE";

/* StackChan v10.9.3: protocolo de fragmentación BLE portado del firmware oficial.
 * La app M5Stack escribe en chunks de ~42 bytes y espera las respuestas del
 * firmware fragmentadas con esta cabecera mágica (AA 55 C3 + version + idx +
 * total + len). Sin esto, el token del handshake (394 bytes) se mandaba en
 * UNA notificación y la app lo descartaba -> el bind nunca se completaba
 * (el log de fábrica muestra: fragmented notify total=394 packets=13). */
static const uint8_t _ble_fragment_magic0       = 0xAA;
static const uint8_t _ble_fragment_magic1       = 0x55;
static const uint8_t _ble_fragment_magic2       = 0xC3;
static const uint8_t _ble_fragment_version      = 1;
static const uint16_t _ble_fragment_header_len  = 10;
static const uint16_t _ble_fallback_payload_len = 20;
static uint16_t _ble_dynamic_payload            = _ble_fallback_payload_len;

using BleNotifyCallback = int (*)(const char*, uint16_t);

static void _recordIncomingWritePayload(uint16_t len)
{
    if (len > _ble_dynamic_payload && len <= STACKCHAN_MAX_JSON_LEN) {
        _ble_dynamic_payload = len;
    }
}

static bool _sendFragmentedNotify(BleNotifyCallback notify, const char* json_data, uint16_t json_len, const char* tag)
{
    const uint16_t usable_payload = _ble_dynamic_payload;

    if (json_data == nullptr || json_len == 0) {
        return true;
    }

    if (json_len > STACKCHAN_MAX_JSON_LEN) {
        mclog::tagWarn(_tag, "{} payload exceed max len: {}", tag, json_len);
        return false;
    }

    if (json_len <= usable_payload) {
        return notify(json_data, json_len) == 0;
    }

    if (usable_payload <= _ble_fragment_header_len) {
        mclog::tagWarn(_tag, "{} mtu payload too small for fragmentation", tag);
        return false;
    }

    const uint16_t max_chunk_payload = usable_payload - _ble_fragment_header_len;
    const uint16_t total_packets     = (json_len + max_chunk_payload - 1) / max_chunk_payload;

    if (total_packets == 0) {
        mclog::tagWarn(_tag, "{} invalid packet count", tag);
        return false;
    }

    mclog::tagInfo(_tag, "{} fragmented notify: total={}, mtu_payload={}, chunk_payload={}, packets={}", tag, json_len,
                   usable_payload, max_chunk_payload, total_packets);

    for (uint16_t idx = 0; idx < total_packets; idx++) {
        const uint16_t start     = idx * max_chunk_payload;
        const uint16_t chunk_len = std::min<uint16_t>(max_chunk_payload, json_len - start);

        std::string packet;
        packet.reserve(_ble_fragment_header_len + chunk_len);
        packet.push_back(static_cast<char>(_ble_fragment_magic0));
        packet.push_back(static_cast<char>(_ble_fragment_magic1));
        packet.push_back(static_cast<char>(_ble_fragment_magic2));
        packet.push_back(static_cast<char>(_ble_fragment_version));

        packet.push_back(static_cast<char>((idx >> 8) & 0xFF));
        packet.push_back(static_cast<char>(idx & 0xFF));
        packet.push_back(static_cast<char>((total_packets >> 8) & 0xFF));
        packet.push_back(static_cast<char>(total_packets & 0xFF));
        packet.push_back(static_cast<char>((json_len >> 8) & 0xFF));
        packet.push_back(static_cast<char>(json_len & 0xFF));

        packet.append(json_data + start, json_data + start + chunk_len);

        if (notify(packet.data(), static_cast<uint16_t>(packet.size())) != 0) {
            mclog::tagWarn(_tag, "{} fragmented notify failed at packet={}", tag, idx);
            return false;
        }
    }

    return true;
}

static int _handle_ble_motion_write(const char* json_data, uint16_t len, uint16_t conn_handle)
{
    // mclog::tagInfo(_tag, "on motion:\n{}", json_data);
    GetHAL().onBleMotionData.emit(json_data);
    return 0;
}

static int _handle_ble_avatar_write(const char* json_data, uint16_t len, uint16_t conn_handle)
{
    // mclog::tagInfo(_tag, "on avatar:\n{}", json_data);
    GetHAL().onBleAvatarData.emit(json_data);
    return 0;
}

static int _handle_ble_config_write(const char* json_data, uint16_t len, uint16_t conn_handle)
{
    // StackChan v10.9.3: la app M5Stack escribe en chunks de ~42 bytes; con esto
    // el firmware aprende el tamaño real y fragmenta las respuestas igual que
    // la fábrica (mtu_payload=42, chunk_payload=32).
    _recordIncomingWritePayload(len);
    // mclog::tagInfo(_tag, "on config:\n{}", json_data);
    GetHAL().onBleConfigData.emit(json_data);
    return 0;
}

static int _handle_ble_rgb_write(const char* json_data, uint16_t len, uint16_t conn_handle)
{
    // mclog::tagInfo(_tag, "on rgb:\n{}", json_data);
    GetHAL().onBleRgbData.emit(json_data);
    return 0;
}

static uint8_t _handle_ble_battery_read(void)
{
    mclog::tagInfo(_tag, "on bat read");
    return 96;
}

void Hal::ble_init(bool useAltUuid)
{
    mclog::tagInfo(_tag, "init");

    static stackchan_ble_callbacks_t ble_callbacks = {
        .motion_cb       = _handle_ble_motion_write,
        .avatar_cb       = _handle_ble_avatar_write,
        .config_cb       = _handle_ble_config_write,
        .rgb_cb          = _handle_ble_rgb_write,
        .battery_read_cb = _handle_ble_battery_read,
    };
    stackchan_ble_register_callbacks(&ble_callbacks);

    ble_prph_init(useAltUuid);

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_EFUSE_FACTORY);
    mclog::tagInfo(_tag, "init done, factory mac: {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}", mac[0], mac[1], mac[2],
                   mac[3], mac[4], mac[5]);
}

void Hal::startBleServer()
{
    mclog::tagInfo(_tag, "start ble server");
    ble_init(false);
}

bool Hal::isBleConnected()
{
    return stackchan_ble_is_connected();
}

/* -------------------------------------------------------------------------- */
/*                              App config server                             */
/* -------------------------------------------------------------------------- */
#include "utils/wifi_connect/wifi_station.h"
#include <string_view>
#include <queue>
#include <mutex>
#include <atomic>

class WifiConfigServer {
public:
    void init()
    {
        GetHAL().onBleConfigData.connect([this](const char* data) { on_config_data(data); });
        _was_connected = stackchan_ble_is_connected();

        // Setup WifiStation callbacks
        _wifi_station = std::make_unique<StackChanWifiStation>();
        _wifi_station->OnConnect([this](const std::string& ssid) {
            mclog::tagInfo(_tag, "wifi Connecting to {}", ssid);
            _is_wifi_connecting = true;
            notify_state(0, "wifiConnecting");
        });
        _wifi_station->OnConnected([this](const std::string& ssid) {
            mclog::tagInfo(_tag, "wifi Connected to {}", ssid);
            _is_wifi_connecting = false;
            notify_state(1, "wifiConnected");
            GetHAL().onAppConfigEvent.emit(AppConfigEvent::WifiConnected);

            Settings settings("app_config", true);
            settings.SetBool("is_configed", true);
        });
        _wifi_station->OnConnectFailed([this](const std::string& ssid) {
            mclog::tagInfo(_tag, "wifi Connect Failed to {}", ssid);
            _is_wifi_connecting = false;
            notify_state(2, "wifiConnectFailed");
            GetHAL().onAppConfigEvent.emit(AppConfigEvent::WifiConnectFailed);
        });

        _wifi_station->Start();
    }

    void update()
    {
        bool is_connected = stackchan_ble_is_connected();
        if (is_connected != _was_connected) {
            _was_connected = is_connected;
            if (is_connected) {
                mclog::tagInfo("WifiConfigServer", "app Connected");
                GetHAL().onAppConfigEvent.emit(AppConfigEvent::AppConnected);
            } else {
                mclog::tagInfo("WifiConfigServer", "app Disconnected");
                GetHAL().onAppConfigEvent.emit(AppConfigEvent::AppDisconnected);
            }
        }

        std::string data;
        bool has_data = false;
        {
            std::lock_guard<std::mutex> lock(_mutex);
            if (!_msg_queue.empty()) {
                data = _msg_queue.front();
                _msg_queue.pop();
                has_data = true;
            }
        }

        if (has_data) {
            process_config_data(data.c_str());
        }
    }

private:
    static constexpr std::string_view _tag = "WifiConfigServer";
    std::queue<std::string> _msg_queue;
    std::mutex _mutex;
    bool _was_connected = false;
    std::atomic<bool> _is_wifi_connecting{false};
    std::unique_ptr<StackChanWifiStation> _wifi_station;

    void on_config_data(const char* json_data)
    {
        std::lock_guard<std::mutex> lock(_mutex);
        _msg_queue.push(json_data);
    }

    void process_config_data(const char* json_data)
    {
        ArduinoJson::JsonDocument doc;
        auto error = ArduinoJson::deserializeJson(doc, json_data);

        if (error) {
            mclog::tagError(_tag, "deserializeJson() failed: {}", error.c_str());
            return;
        }

        if (doc["cmd"] == "setWifi") {
            handle_set_wifi(doc["data"]);
        } else if (doc["cmd"] == "getWifiStatus") {
            handle_get_wifi_status();
        } else if (doc["cmd"] == "handshake") {
            std::string data = doc["data"].as<std::string>();
            handle_handshake(data);
        }
    }

    void handle_get_wifi_status()
    {
        if (_wifi_station->IsConnected()) {
            notify_state(1, "wifiConnected");
        } else if (_is_wifi_connecting) {
            notify_state(0, "wifiConnecting");
        } else {
            notify_state(3, "wifiDisconnected");
        }
    }

    void handle_set_wifi(ArduinoJson::JsonObject data)
    {
        if (_is_wifi_connecting) {
            mclog::tagWarn(_tag, "busy connecting, ignoring setWifi");
            notify_state(2, "wifiConnectFailed: Busy");
            return;
        }

        const char* ssid     = data["ssid"];
        const char* password = data["password"];

        mclog::tagInfo(_tag, "get wifi config: {} / {}", ssid, password);

        // Notify state: connecting
        notify_state(0, "wifiConnecting");
        GetHAL().onAppConfigEvent.emit(AppConfigEvent::TryWifiConnect);

        connect_wifi(ssid, password);
    }

    void handle_handshake(std::string_view data)
    {
        auto token = secret_logic::generate_handshake_token(data);
        notify_state(4, token.c_str());
    }

    void connect_wifi(const char* ssid, const char* password)
    {
        // Save to NVS (compatible with Xiaozhi) and connect
        _wifi_station->AddAuth(ssid, password);
    }

    void notify_state(int type, const char* state)
    {
        ArduinoJson::JsonDocument doc;
        doc["cmd"]           = "notifyState";
        doc["data"]["type"]  = type;
        doc["data"]["state"] = state;

        std::string json_str;
        ArduinoJson::serializeJson(doc, json_str);
        if (json_str.length() > 0xFFFF) {
            mclog::tagWarn(_tag, "Config notify payload too large: {}", json_str.length());
            return;
        }

        // StackChan v10.9.3: enviar fragmentado (protocolo oficial AA 55 C3)
        // para que la app M5Stack pueda ensamblar el token del handshake.
        const auto notify_ok = _sendFragmentedNotify(stackchan_ble_notify_config, json_str.c_str(),
                                                     static_cast<uint16_t>(json_str.length()), "Config notify");
        if (!notify_ok) {
            mclog::tagWarn(_tag, "Config notify fragmented send failed");
        }
    }
};

class AppConfigServerWorker : public mooncake::BasicAbility {
public:
    void onCreate() override
    {
        _server = std::make_unique<WifiConfigServer>();
        _server->init();
    }

    void onRunning() override
    {
        if (GetHAL().millis() - _last_tick < 50) {
            return;
        }
        _last_tick = GetHAL().millis();
        _server->update();
    }

    void onDestroy() override
    {
        _server.reset();
    }

private:
    std::unique_ptr<WifiConfigServer> _server;
    uint32_t _last_tick = 0;
};

void Hal::startAppConfigServer()
{
    mclog::tagInfo(_tag, "start app config server");

    ble_init(true);

    mooncake::GetMooncake().extensionManager()->createAbility(std::make_unique<AppConfigServerWorker>());
}

bool Hal::isAppConfiged()
{
    Settings settings("app_config", false);
    return settings.GetBool("is_configed", false);
}

void Hal::resetAppConfiged()
{
    Settings settings("app_config", true);
    settings.SetBool("is_configed", false);
}
