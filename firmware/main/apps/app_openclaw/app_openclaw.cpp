/*
 * SPDX-FileCopyrightText: 2026 StackChan (OpenClaw)
 *
 * SPDX-License-Identifier: MIT
 *
 * App OpenClaw: asistente conectado al gateway MCP local (Mac mini)
 * en lugar de la nube china. Al abrirla muestra un selector de agente
 * (agentes configurables en AGENT_TOKEN_MAP del servidor); al elegir, guarda el token
 * de ese agente en NVS y arranca el servicio xiaozhi (audio, avatar,
 * lip-sync) apuntando al WebSocket del gateway.
 */
#include "app_openclaw.h"
#include <hal/hal.h>
#include <mooncake.h>
#include <mooncake_log.h>
#include <assets/assets.h>
#include <smooth_lvgl.hpp>
#include <settings.h>
#include <string>
#include <memory>
#include "hal/board/hal_bridge.h"

using namespace mooncake;
using namespace smooth_ui_toolkit::lvgl_cpp;

namespace {

struct AgentInfo {
    const char* name;
    uint32_t themeColor;
    const char* token;
};

// Tokens por agente (el gateway mapea token -> sesión de agente en OpenClaw).
// El de StackChan coincide con STACKCHAN_TOKEN del gateway (funciona tal cual).
// URL del gateway MCP local (Mac mini). Si cambia la IP del mini, cambiar aquí.
constexpr const char* kGatewayUrl = "ws://<your-server-ip>:8765/";

constexpr AgentInfo kAgents[] = {
    {"AGENT-1", 0xCC0000, "00000000000000000000000000000001"},
    {"AGENT-2", 0x3355AA, "00000000000000000000000000000002"},
    {"AGENT-3", 0xAA33CC, "00000000000000000000000000000003"},
    {"AGENT-4", 0x33AA55, "00000000000000000000000000000004"},
    {"AGENT-5", 0xCC7733, "00000000000000000000000000000005"},
};

constexpr int kAgentCount = sizeof(kAgents) / sizeof(kAgents[0]);

std::vector<std::unique_ptr<Button>> g_agent_buttons;
std::vector<std::unique_ptr<Label>> g_agent_labels;

}  // namespace

AppOpenClaw::AppOpenClaw()
{
    // Nombre de la app en el launcher
    setAppInfo().name = "OPENCLAW";
    // Icono de la app (logo OpenClaw convertido a formato launcher)
    static auto icon  = assets::get_image("icon_openclaw.bin");
    setAppInfo().icon = (void*)&icon;
    // Color de tema de la app
    static uint32_t theme_color = 0xCC0000;
    setAppInfo().userData       = (void*)&theme_color;
}

void AppOpenClaw::onCreate()
{
    mclog::tagInfo(getAppInfo().name, "on create");
}

void AppOpenClaw::onOpen()
{
    mclog::tagInfo(getAppInfo().name, "on open");

    LvglLockGuard lock;

    // Fondo
    auto screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x1A1A2E), 0);

    // Título
    static auto title = std::make_unique<Label>(screen);
    title->setText("ELIGE TU AGENTE");
    title->setTextFont(&lv_font_montserrat_16);
    title->setTextColor(lv_color_hex(0xFFFFFF));
    title->align(LV_ALIGN_TOP_MID, 0, 14);

    // Botones de agente (2 filas: 3 arriba + 2 abajo, centrados en 320x240)
    const int btn_w = 92;
    const int btn_h = 64;
    const int gap_x = 10;
    const int gap_y = 14;
    // Fila 1: 3 botones centrados
    const int row1_y = 52;
    const int row2_y = 130;
    const int row1_start_x = (320 - (3 * btn_w + 2 * gap_x)) / 2;  // = 12
    const int row2_start_x = (320 - (2 * btn_w + gap_x)) / 2;      // = 54

    for (int i = 0; i < kAgentCount; i++) {
        int col = i % 3;
        int row = i / 3;
        int x   = (row == 0) ? row1_start_x + col * (btn_w + gap_x) : row2_start_x + col * (btn_w + gap_x);
        int y   = (row == 0) ? row1_y : row2_y;

        auto btn = std::make_unique<Button>(screen);
        btn->setSize(btn_w, btn_h);
        btn->setPos(x, y);
        btn->setBgColor(lv_color_hex(kAgents[i].themeColor));
        btn->setRadius(12);
        btn->setBorderWidth(0);

        auto label = std::make_unique<Label>(btn->get());
        label->setText(kAgents[i].name);
        label->setTextFont(&lv_font_montserrat_14);
        label->setTextColor(lv_color_hex(0xFFFFFF));
        label->align(LV_ALIGN_CENTER, 0, 0);

        int agent_index = i;
        btn->onClick().connect([this, agent_index]() { select_agent(agent_index); });

        g_agent_buttons.push_back(std::move(btn));
        g_agent_labels.push_back(std::move(label));
    }
}

void AppOpenClaw::select_agent(int index)
{
    if (index < 0 || index >= kAgentCount) {
        return;
    }

    mclog::tagInfo(getAppInfo().name, "agente seleccionado: {}", kAgents[index].name);

    // Guardar la URL del gateway local y el token del agente en NVS (namespace websocket)
    {
        Settings settings("websocket", true);
        settings.SetString("url", kGatewayUrl);
        settings.SetString("token", kAgents[index].token);
    }

    _agent_selected = true;

    // StackChan v10.10.5: guardar la posición del carrusel del launcher desde la
    // que se abre el chat (OpenClaw = 2: [IA china, Avatar, OpenClaw, ...]).
    // Al pulsar home, request_exit_chat() hace el warm reboot a ESTA posición
    // (no siempre a la primera app).
    hal_bridge::set_chat_exit_launcher_index(2);

    // Arrancar el servicio xiaozhi (audio + avatar + lip-sync + WebSocket)
    GetHAL().requestXiaozhiStart();
}

void AppOpenClaw::onRunning()
{
    // La app se cierra cuando mooncake se desinstala al arrancar xiaozhi
}

void AppOpenClaw::onClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");

    LvglLockGuard lock;
    g_agent_buttons.clear();
    g_agent_labels.clear();
}
