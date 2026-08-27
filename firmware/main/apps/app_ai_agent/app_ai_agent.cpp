/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "app_ai_agent.h"
#include <hal/hal.h>
#include <mooncake.h>
#include <mooncake_log.h>
#include <assets/assets.h>
#include <smooth_lvgl.hpp>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include <settings.h>
#include "hal/board/hal_bridge.h"

using namespace mooncake;
using namespace smooth_ui_toolkit::lvgl_cpp;

// StackChan v10.4: URL del servidor de IA chino (xiaozhi). Esta app es la CHINA,
// la app OpenClaw es la local. Cada app escribe SU URL en NVS al abrirse para
// que convivan sin pisarse.
static constexpr const char* kChinaWsUrl = "wss://api.tenclass.net/xiaozhi/v1/";

AppAiAgent::AppAiAgent()
{
    // Configure App name
    setAppInfo().name = "AI.AGENT";
    // Configure App icon
    static auto icon  = assets::get_image("icon_ai_agent.bin");
    setAppInfo().icon = (void*)&icon;
    // Configure App theme color
    static uint32_t theme_color = 0x33CC99;
    setAppInfo().userData       = (void*)&theme_color;
}

// Called when the App is installed
void AppAiAgent::onCreate()
{
    mclog::tagInfo(getAppInfo().name, "on create");
}

// Called when the App is opened
// You can construct UI, initialize operations, etc. here
void AppAiAgent::onOpen()
{
    mclog::tagInfo(getAppInfo().name, "on open");

    // StackChan v10.4: esta app es la IA CHINA. Al abrirse escribe SU URL en NVS
    // (namespace websocket) para convivir con OPENCLAW, que escribe la local
    // al elegir agente. Asi la China funciona siempre que abras esta app.
    {
        Settings settings("websocket", true);
        settings.SetString("url", kChinaWsUrl);
        settings.SetString("token", "");
    }

    // StackChan v10.10.5: guardar la posición del carrusel del launcher desde la
    // que se abre el chat (IA china = 0). Al pulsar home, request_exit_chat()
    // hace el warm reboot a ESTA posición (no siempre a la primera app).
    hal_bridge::set_chat_exit_launcher_index(0);

    // Request to start Xiaozhi service
    // All apps will be uninstall in next mooncake update
    GetHAL().requestXiaozhiStart();
}

// Called repeatedly while the App is running
void AppAiAgent::onRunning()
{
}

// Called when the App is closed
// You can destroy UI, release resources, etc. here
void AppAiAgent::onClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");
}
