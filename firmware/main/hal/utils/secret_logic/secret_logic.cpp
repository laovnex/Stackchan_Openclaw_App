/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "secret_logic.h"
#include <sdkconfig.h>
#include <string.h>
#include <string>
#include <time.h>
#include "esp_random.h"
#include "esp_log.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/rsa.h"
#include "mbedtls/bignum.h"

namespace secret_logic {

static const char* TAG = "SecretLogic";

// Clave pública RSA-2048 extraída del firmware de fábrica (backup, slot OTA 2).
// El bind M5Stack cifra el token del handshake con esta clave (PKCS#1 v1.5).
static const char* _FACTORY_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\n"
                                             "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4i3fbH8pTiyL9ua2Vvv7\n"
                                             "LjKCRoZJKfSwurmbRxVFBTJZkHrwT+GtGxm5eqPxFXUtWkN0DaVRfgdXchPYdgD3\n"
                                             "leexHYpYJQHW/s7reFLgQ5OQ0aLE15f3rsx36PCOIxVRCmPW3wclgrTVRg1iMr3/\n"
                                             "WxxGeTzLDWKSnksiFqD68m3e+cdkbUpnDIrEFJhG/GTla2EfyJIYlYHXvtljAk7i\n"
                                             "R/vqF9Y2q1lAyhe/sUmuhzmxEXex767xVRvGNKLd+Pm7dnR39eqQNaEn9KnkJfFy\n"
                                             "bGFqB3ghGXS8NQd54rhGnX98SuFaq4bwBvyiGrViI87A6mp6j0uZjA/xJj72LMUT\n"
                                             "3QIDAQAB\n"
                                             "-----END PUBLIC KEY-----\n";

// Clave pública del server StackChan (nube china): módulo (N) y exponente (E)
// en hex. 2048 bits, E=65537. Es LA MISMA clave que el PEM de fábrica
// (verificado byte a byte: el base64 del PEM decodifica al N_HEX de abajo).
// Se definen AQUI para que generate_handshake_token() (bind BLE) y
// generate_mac_auth_token() (avatar) las usen con la API RSA directa.
static const char* _SERVER_KEY_N_HEX =
    "e22ddf6c7f294e2c8bf6e6b656fbfb2e328246864929f4b0bab99b471545053259907af04fe1ad1b19b97aa3f115752d5a43740da5517e07577213d87600f795e7b11d8a582501d6feceeb7852e0439390d1a2c4d797f7aecc77e8f08e2315510a63d6df072582b4d5460d6232bdff5b1c46793ccb0d62929e4b2216a0faf26ddef9c7646d4a670c8ac4149846fc64e56b611fc892189581d7bed963024ee247fbea17d636ab5940ca17bfb149ae8739b11177b1efaef1551bc634a2ddf8f9bb767477f5ea9035a127f4a9e425f1726c616a0778211974bc350779e2b8469d7f7c4ae15aab86f006fca21ab56223cec0ea6a7a8f4b998c0ff1263ef62cc513dd";
static const char* _SERVER_KEY_E_HEX = "10001";

// Charset usado por el firmware de fábrica para generar tokens (visto en el backup).
static const char _TOKEN_CHARSET[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
static const size_t _TOKEN_CHARSET_LEN = sizeof(_TOKEN_CHARSET) - 1;

// RNG para mbedtls: usa el RNG de hardware del ESP32-S3
static int _mbedtls_rng(void* ctx, unsigned char* out, size_t len)
{
    (void)ctx;
    esp_fill_random(out, len);
    return 0;
}

__attribute__((weak)) std::string get_server_url()
{
#ifdef CONFIG_STACKCHAN_SERVER_URL
    return CONFIG_STACKCHAN_SERVER_URL;
#else
    return "http://localhost:3000";
#endif
}

__attribute__((weak)) std::string generate_auth_token()
{
    return "hi-stack-chan";
}

__attribute__((weak)) std::string generate_handshake_token(std::string_view data)
{
    (void)data;

    // 1) Generar token aleatorio de 32 chars (mismo charset que la fábrica)
    std::string token;
    token.reserve(32);
    for (int i = 0; i < 32; ++i) {
        token += _TOKEN_CHARSET[esp_random() % _TOKEN_CHARSET_LEN];
    }

    // 2) Cifrar con RSA-OAEP-SHA256 (API directa, N/E hex embebidos)
    // StackChan v10.9.2: FIX BIND — el server chino SOLO descifra OAEP-SHA256
    // (server/utility/rsa.go usa rsa.DecryptOAEP). PKCS#1 v1.5
    // (mbedtls_pk_encrypt) fallaba -> el bind con la app no funcionaba con
    // nuestro firmware. Mismo patrón que generate_mac_auth_token() (v10.8).
    mbedtls_rsa_context rsa;
    mbedtls_rsa_init(&rsa);

    mbedtls_mpi N;
    mbedtls_mpi E;
    mbedtls_mpi_init(&N);
    mbedtls_mpi_init(&E);

    int ret = mbedtls_mpi_read_string(&N, 16, _SERVER_KEY_N_HEX);
    if (ret != 0) {
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return token;  // fallback: token en claro
    }
    ret = mbedtls_mpi_read_string(&E, 16, _SERVER_KEY_E_HEX);
    if (ret != 0) {
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return token;  // fallback: token en claro
    }
    ret = mbedtls_rsa_import(&rsa, &N, NULL, NULL, NULL, &E);
    if (ret != 0) {
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return token;  // fallback: token en claro
    }
    ret = mbedtls_rsa_complete(&rsa);
    if (ret != 0) {
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return token;  // fallback: token en claro
    }
    ret = mbedtls_rsa_set_padding(&rsa, MBEDTLS_RSA_PKCS_V21, MBEDTLS_MD_SHA256);
    if (ret != 0) {
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return token;  // fallback: token en claro
    }

    unsigned char output[512];
    ret = mbedtls_rsa_pkcs1_encrypt(&rsa, _mbedtls_rng, nullptr,
                                    token.size(), (const unsigned char*)token.data(), output);
    if (ret != 0) {
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return token;  // fallback: token en claro
    }

    // 3) Codificar en base64 (solo los bytes cifrados = len de la clave, 256)
    unsigned char b64[1024];
    size_t b64len = 0;
    mbedtls_base64_encode(b64, sizeof(b64), &b64len, output, mbedtls_rsa_get_len(&rsa));

    mbedtls_mpi_free(&N);
    mbedtls_mpi_free(&E);
    mbedtls_rsa_free(&rsa);
    return std::string((const char*)b64, b64len);
}

// StackChan v10.9.2: normaliza una MAC a 12 chars compacta sin separadores
// ("68:ee:8f:d7:4c:d0" -> "68ee8fd74cd0"). La app M5Stack registra/busca
// al bicho por la MAC compacta (payload[:12]); el server guarda la MAC
// exacta del token en el pool. Si mandamos la MAC con dos puntos, la app
// nunca encuentra al bicho ("offline" -> cámara/control no funcionan).
std::string mac_compact(const std::string& mac)
{
    std::string out;
    out.reserve(12);
    for (char c : mac) {
        if (c != ':' && c != '-' && c != ' ') {
            // v10.9.4: MAYÚSCULAS — la app M5Stack manda la MAC en upper
            // (binding_device.dart cleanedMac.toUpperCase(), blue_util.dart
            // .toUpperCase()) y el pool del server es case-sensitive.
            // Con minúsculas la app nunca encontraba al bicho -> offline.
            out += (char)toupper(c);
        }
    }
    return out;
}

std::string generate_mac_auth_token(const std::string& mac)
{
    // 0) MAC compacta (12 chars, sin separadores) — ver mac_compact()
    const std::string mac_eff = mac_compact(mac);

    // 1) Nonce aleatorio de 16 bytes -> hex (32 chars)
    char nonce_hex[33];
    uint8_t nonce[16];
    esp_fill_random(nonce, sizeof(nonce));
    for (int i = 0; i < 16; ++i) {
        snprintf(nonce_hex + i * 2, 3, "%02x", nonce[i]);
    }

    // 2) Timestamp unix actual (SNTP sincroniza al conectar WiFi)
    // StackChan v10.9.1: FIX CRITICO — el nano-printf de newlib
    // (CONFIG_LIBC_NEWLIB_NANO_FORMAT=y) NO soporta %%lld y el timestamp
    // salia como "ld" -> el server ParseInt("ld") fallaba -> 401 SIEMPRE.
    // time_t en ESP32 es 32 bits (hasta 2038), %%u es suficiente.
    char ts_str[16];
    snprintf(ts_str, sizeof(ts_str), "%u", (unsigned int)time(nullptr));

    // 3) plainText = MAC|nonce|timestamp
    std::string plain = mac_eff + "|" + std::string(nonce_hex) + "|" + ts_str;

    // 4) Cifrar con RSA-OAEP-SHA256 (API directa, garantizado)
    mbedtls_rsa_context rsa;
    mbedtls_rsa_init(&rsa);

    mbedtls_mpi N;
    mbedtls_mpi E;
    mbedtls_mpi_init(&N);
    mbedtls_mpi_init(&E);

    int ret = mbedtls_mpi_read_string(&N, 16, _SERVER_KEY_N_HEX);
    if (ret != 0) {
        ESP_LOGE(TAG, "mpi_read N ret=%d", ret);
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return std::string();
    }
    ret = mbedtls_mpi_read_string(&E, 16, _SERVER_KEY_E_HEX);
    if (ret != 0) {
        ESP_LOGE(TAG, "mpi_read E ret=%d", ret);
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return std::string();
    }

    ret = mbedtls_rsa_import(&rsa, &N, NULL, NULL, NULL, &E);
    if (ret != 0) {
        ESP_LOGE(TAG, "rsa_import ret=%d", ret);
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return std::string();
    }
    ret = mbedtls_rsa_complete(&rsa);
    if (ret != 0) {
        ESP_LOGE(TAG, "rsa_complete ret=%d", ret);
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return std::string();
    }
    ret = mbedtls_rsa_set_padding(&rsa, MBEDTLS_RSA_PKCS_V21, MBEDTLS_MD_SHA256);
    if (ret != 0) {
        ESP_LOGE(TAG, "set_padding ret=%d", ret);
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return std::string();
    }

    unsigned char output[512];
    ret = mbedtls_rsa_pkcs1_encrypt(&rsa, _mbedtls_rng, nullptr,
                                    plain.size(), (const unsigned char*)plain.data(), output);
    if (ret != 0) {
        ESP_LOGE(TAG, "pkcs1_encrypt ret=%d", ret);
        mbedtls_mpi_free(&N);
        mbedtls_mpi_free(&E);
        mbedtls_rsa_free(&rsa);
        return std::string();
    }

    // 5) Base64
    unsigned char b64[1024];
    size_t b64len = 0;
    mbedtls_base64_encode(b64, sizeof(b64), &b64len, output, mbedtls_rsa_get_len(&rsa));

    mbedtls_mpi_free(&N);
    mbedtls_mpi_free(&E);
    mbedtls_rsa_free(&rsa);

    // StackChan v10.9: diagnostico avatar — token COMPLETO en el log para
    // validarlo contra el server desde el Mac (caduca en 10s, solo debug).
    ESP_LOGI(TAG, "auth mac=%s ts=%s", mac.c_str(), ts_str);
    ESP_LOGI(TAG, "auth plain=%s", plain.c_str());
    ESP_LOGI(TAG, "auth token len=%d", (int)b64len);
    ESP_LOGI(TAG, "auth token b64=%s", std::string((const char*)b64, b64len).c_str());
    return std::string((const char*)b64, b64len);
}

}  // namespace secret_logic
