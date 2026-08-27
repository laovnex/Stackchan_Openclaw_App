/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal_bridge.h"
#include "stackchan_display.h"
#include <stackchan/stackchan.h>
#include <hal/hal.h>
#include <esp_log.h>
#include <esp_err.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <driver/gpio.h>
#include <esp_event.h>
#include <application.h>
#include <board.h>
#include <display.h>
#include <mutex>
#include <assets.h>
#include <settings.h>
#include <mooncake_log.h>
#include <esp_system.h>

static const char* _tag = "HAL_BRIDGE";

static constexpr std::string_view _xiaozhi_config_nvs_ns                           = "xiaozhi";
static constexpr std::string_view _xiaozhi_config_idle_shutdown_time_key           = "idle_sec";
static constexpr std::string_view _xiaozhi_config_allow_shutdown_when_charging_key = "ext_pwr";
static constexpr std::string_view _xiaozhi_config_idle_random_movement_key         = "idle_lv";
static constexpr std::string_view _xiaozhi_config_start_ai_agent_on_boot_key       = "boot_ai";

namespace hal_bridge {

/* -------------------------------------------------------------------------- */
/*                            State and touch point                           */
/* -------------------------------------------------------------------------- */

static std::mutex _mutex;
static Data_t _data;

void lock()
{
    _mutex.lock();
}

void unlock()
{
    _mutex.unlock();
}

Data_t& get_data()
{
    return _data;
}

void set_touch_point(int num, int x, int y)
{
    std::lock_guard<std::mutex> lock(_mutex);
    _data.touchPoint.num = num;
    _data.touchPoint.x   = x;
    _data.touchPoint.y   = y;
}

TouchPoint_t get_touch_point()
{
    std::lock_guard<std::mutex> lock(_mutex);
    return _data.touchPoint;
}

bool is_xiaozhi_mode()
{
    std::lock_guard<std::mutex> lock(_mutex);
    return _data.isXiaozhiMode;
}

void set_xiaozhi_mode(bool mode)
{
    std::lock_guard<std::mutex> lock(_mutex);
    _data.isXiaozhiMode = mode;
}

/* -------------------------------------------------------------------------- */
/*                                   Display                                  */
/* -------------------------------------------------------------------------- */
#define DISPLAY_TYPE StackChanAvatarDisplay

lv_disp_t* display_get_lvgl_display()
{
    auto display = static_cast<DISPLAY_TYPE*>(Board::GetInstance().GetDisplay());
    return display->GetLvglDisplay();
}

void disply_lvgl_lock()
{
    auto display = static_cast<DISPLAY_TYPE*>(Board::GetInstance().GetDisplay());
    display->LvglLock();
}

void disply_lvgl_unlock()
{
    auto display = static_cast<DISPLAY_TYPE*>(Board::GetInstance().GetDisplay());
    display->LvglUnlock();
}

/* -------------------------------------------------------------------------- */
/*                                 Application                                */
/* -------------------------------------------------------------------------- */

void xiaozhi_board_init()
{
    // Init board
    auto& board = Board::GetInstance();
}

void start_xiaozhi_app()
{
    set_xiaozhi_mode(true);

    // StackChan v10.10.1 (fix LED): limpiar color manual de sesiones ANTERIORES
    // al entrar en una app. Si no, un manual guardado en NVS (p.ej. verde de
    // una prueba previa) pisa SIEMPRE los colores de estado -> LEDs fijos en
    // verde al entrar. El manual puesto por el LLM DURANTE la sesión se sigue
    // guardando y persiste al desconectar, pero al re-entrar mandan los
    // colores de estado (verde escuchando / azul hablando / apagado standby).
    clear_manual_led_color();

    // Initialize and run the application
    auto& app = Application::GetInstance();
    app.Initialize();
    app.Run();  // Returns when user presses home (exit chat requested)

    // StackChan v10.5: al volver del chat (home), salimos del modo xiaozhi para
    // que main.cpp re-monte el launcher sin reiniciar el dispositivo.
    set_xiaozhi_mode(false);
    // StackChan v10.9.5: resetear flags de UI para que _stackchan_update_task no
    // toque LVGL ya destruido (evita el reboot al volver del chat a home).
    reset_xiaozhi_ui_flags();
}

static int _chat_exit_launcher_index = 0;  // StackChan v10.10.5: posición del carrusel desde la que se salió del chat

void set_chat_exit_launcher_index(int index)
{
    // StackChan v10.10.5: cada app de chat guarda su posición en el carrusel del
    // launcher al abrirse. request_exit_chat() la usa para que el warm reboot
    // vuelva a la app desde la que saliste (no siempre a la primera).
    _chat_exit_launcher_index = index;
    mclog::tagInfo("hal_bridge", "chat exit launcher index set to {}", index);
}

void request_exit_chat()
{
    // StackChan v10.10.5: home -> WARM REBOOT nativo a launcher, en la POSICIÓN
    // de la app desde la que se salió (set_chat_exit_launcher_index).
    // El mecanismo nativo de cerrar apps (app_avatar, app_dance, etc.) es
    // GetHAL().requestWarmReboot(indice): guarda el indice en NVS
    // (warm_boot/app_index), delay(100) y esp_restart(). Al arrancar, el
    // launcher lee el indice y restaura el cursor del carrusel en esa app.
    // Confirmado por el usuario 15:41: home sin reboot, sale limpio al launcher;
    // solo faltaba que NO volviera siempre a la primera app -> índice dinámico.
    mclog::tagInfo("hal_bridge", "home pressed -> warm reboot to launcher index {}", _chat_exit_launcher_index);
    // StackChan v10.10.7: apagar LEDs ANTES de salir. set_leds_off() ahora
    // cancela también la animación del NeonLight (turnOff -> teleport negro)
    // que repintaba azul por encima del showRgbColor(0,0,0) de la v10.10.6.
    set_leds_off();
    GetHAL().requestWarmReboot(_chat_exit_launcher_index);
}

void set_leds_off()
{
    // StackChan v10.9.7: si hay color manual persistido (tool del LLM),
    // mantenerlo aunque desconecte (estilo IA china). Si no, apagar.
    int mr, mg, mb;
    if (get_manual_led_color(&mr, &mg, &mb)) {
        mclog::tagInfo("hal_bridge", "manual LED color persists: r={}, g={}, b={}", mr, mg, mb);
        GetHAL().showRgbColor(mr, mg, mb);
        return;
    }
    // StackChan v10.10.7: apagar TAMBIÉN los NeonLight con turnOff() que
    // cancela la animación (teleport a negro). Sin esto, el fade del
    // NeonLight repintaba azul por encima del showRgbColor(0,0,0).
    GetStackChan().leftNeonLight().turnOff();
    GetStackChan().rightNeonLight().turnOff();
    GetHAL().showRgbColor(0, 0, 0);
}

void save_manual_led_color(int r, int g, int b)
{
    Settings settings("led", true);
    settings.SetInt("manual_r", r);
    settings.SetInt("manual_g", g);
    settings.SetInt("manual_b", b);
}

bool get_manual_led_color(int* r, int* g, int* b)
{
    if (!r || !g || !b) return false;
    Settings settings("led", false);
    *r = settings.GetInt("manual_r", -1);
    *g = settings.GetInt("manual_g", -1);
    *b = settings.GetInt("manual_b", -1);
    return *r >= 0 && *g >= 0 && *b >= 0;
}

void clear_manual_led_color()
{
    Settings settings("led", true);
    settings.EraseKey("manual_r");
    settings.EraseKey("manual_g");
    settings.EraseKey("manual_b");
}

XiaozhiConfig_t get_xiaozhi_config()
{
    XiaozhiConfig_t config;

    Settings settings(_xiaozhi_config_nvs_ns.data(), false);
    config.idleShutdownTimeSeconds = settings.GetInt(_xiaozhi_config_idle_shutdown_time_key.data(),
                                                     static_cast<int>(config.idleShutdownTimeSeconds));
    config.allowShutdownWhenCharging =
        settings.GetBool(_xiaozhi_config_allow_shutdown_when_charging_key.data(), config.allowShutdownWhenCharging);
    config.idleRandomMovementLevel =
        settings.GetInt(_xiaozhi_config_idle_random_movement_key.data(), config.idleRandomMovementLevel);
    config.startAiAgentOnBoot =
        settings.GetBool(_xiaozhi_config_start_ai_agent_on_boot_key.data(), config.startAiAgentOnBoot);

    return config;
}

void set_xiaozhi_config(const XiaozhiConfig_t& config)
{
    Settings settings(_xiaozhi_config_nvs_ns.data(), true);
    settings.SetInt(_xiaozhi_config_idle_shutdown_time_key.data(), config.idleShutdownTimeSeconds);
    settings.SetBool(_xiaozhi_config_allow_shutdown_when_charging_key.data(), config.allowShutdownWhenCharging);
    settings.SetInt(_xiaozhi_config_idle_random_movement_key.data(), config.idleRandomMovementLevel);
    settings.SetBool(_xiaozhi_config_start_ai_agent_on_boot_key.data(), config.startAiAgentOnBoot);
}

void app_play_sound(const std::string_view& sound)
{
    auto& app = Application::GetInstance();
    app.PlaySound(sound);
}

}  // namespace hal_bridge
