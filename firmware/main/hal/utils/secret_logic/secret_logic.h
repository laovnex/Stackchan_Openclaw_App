/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include <string>
#include <string_view>

namespace secret_logic {

std::string get_server_url();
std::string generate_auth_token();
std::string generate_handshake_token(std::string_view data);
std::string generate_mac_auth_token(const std::string& mac);

// StackChan v10.9.2: normaliza una MAC a 12 chars compacta sin separadores
// ("68:ee:8f:d7:4c:d0" -> "68ee8fd74cd0"). La app M5Stack busca al bicho
// por la MAC compacta; el server guarda la MAC exacta del token en el pool.
std::string mac_compact(const std::string& mac);

}  // namespace secret_logic
