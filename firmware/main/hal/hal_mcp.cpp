/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <mooncake_log.h>
#include <mcp_server.h>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include "board/hal_bridge.h"
#include "board/stackchan_display.h"
#include "board/stackchan_camera.h"
#include "boards/common/board.h"

using namespace stackchan;

static const std::string_view _tag = "HAL-MCP";

void Hal::xiaozhi_mcp_init()
{
    mclog::tagInfo(_tag, "init");

    // https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-usage.md
    auto& mcp_server = McpServer::GetInstance();

    // System Prompt：
    // You can control the robot's head. Use get_yaw and get_pitch to sense current position. Use set_yaw for horizontal
    // movement and set_pitch for vertical movement. All angles are in degrees.

    mclog::tagInfo(_tag, "add robot.get_head_angles tool");
    mcp_server.AddTool("self.robot.get_head_angles",
                       "Returns current yaw/pitch in degrees. Neutral position is {yaw:0, pitch:0}.",
                       std::vector<Property>{}, [this](const PropertyList& properties) -> ReturnValue {
                           LvglLockGuard lock;  // StackChan motion update is under the lvgl lock

                           auto& motion      = GetStackChan().motion();
                           int current_yaw   = motion.yawServo().getCurrentAngle() / 10;
                           int current_pitch = motion.pitchServo().getCurrentAngle() / 10;

                           auto result = fmt::format(R"({{"yaw": {}, "pitch": {}}})", current_yaw, current_pitch);
                           mclog::tagInfo(_tag, "get_head_angles: {}", result);
                           return result;
                       });

    mclog::tagInfo(_tag, "add robot.set_head_angles tool");
    mcp_server.AddTool("self.robot.set_head_angles",
                       "Adjust head position. GUIDELINES: "
                       "1. For natural interaction, stay within +/- 45 degrees. "
                       "2. Only use values > 70 if the user explicitly asks to look far away/behind. "
                       "3. Max ranges: Yaw(-128 to 128, -128 as your left), Pitch(0 to 90, 90 as your up). "
                       "Speed(100-1000, 150 is natural).",
                       PropertyList({Property("yaw", kPropertyTypeInteger, -9999, -9999, 128),
                                     Property("pitch", kPropertyTypeInteger, -9999, -9999, 90),
                                     Property("speed", kPropertyTypeInteger, 150, 100, 1000)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int speed = properties["speed"].value<int>();
                           int yaw   = properties["yaw"].value<int>();
                           int pitch = properties["pitch"].value<int>();

                           mclog::tagInfo(_tag, "motion set_angles: yaw: {}, pitch: {}, speed: {}", yaw, pitch, speed);

                           LvglLockGuard lock;

                           auto& motion = GetStackChan().motion();
                           if (pitch != -9999) {
                               motion.pitchServo().moveWithSpeed(pitch * 10, speed);
                           }
                           if (yaw != -9999) {
                               motion.yawServo().moveWithSpeed(yaw * 10, speed);
                           }

                           return true;
                       });

    mclog::tagInfo(_tag, "add robot.set_led_color tool");
    mcp_server.AddTool(
        "self.robot.set_led_color",
        "Set the color of the robot's INTERNAL onboard LED. This is NOT for room lights. "
        "Values: 0-168 (safe range). Red=168,0,0; Green=0,168,0; Blue=0,0,168; White=100,100,100; Off=0,0,0. "
        "automatic=true means the server state (listening/speaking/thinking), both side LEDs lit. "
        "automatic=false (default, LLM manual request) lights both sides and persists after disconnect.",
        PropertyList({Property("red", kPropertyTypeInteger, 0, 0, 168),
                      Property("green", kPropertyTypeInteger, 0, 0, 168),
                      Property("blue", kPropertyTypeInteger, 0, 0, 168),
                      Property("automatic", kPropertyTypeBoolean, false)}),
        [this](const PropertyList& properties) -> ReturnValue {
            int r = properties["red"].value<int>();
            int g = properties["green"].value<int>();
            int b = properties["blue"].value<int>();
            bool automatic = properties["automatic"].value<bool>();

            mclog::tagInfo(_tag, "set_led_color: r={}, g={}, b={}, automatic={}", r, g, b, automatic);

            LvglLockGuard lock;

            if (automatic) {
                // StackChan v10.13 (26/08/2026): los DOS LEDs laterales con el
                // color de estado (verde/amarillo/azul), como pidió el usuario.
                // Sin persistencia (el estado lo manda el server).
                mclog::tagInfo(_tag, "auto led both sides: r={}, g={}, b={}", r, g, b);
                GetStackChan().leftNeonLight().setColor(r, g, b);
                GetStackChan().rightNeonLight().setColor(r, g, b);
                return true;
            }

            // Manual del LLM: ambos lados + persistir en NVS (sobrevive al desconectar)
            GetStackChan().leftNeonLight().setColor(r, g, b);
            GetStackChan().rightNeonLight().setColor(r, g, b);
            if (r == 0 && g == 0 && b == 0) {
                hal_bridge::clear_manual_led_color();
            } else {
                hal_bridge::save_manual_led_color(r, g, b);
            }
            return true;
        });

    mclog::tagInfo(_tag, "add display.set_avatar tool");
    mcp_server.AddTool(
        "self.display.set_avatar",
        "Set the avatar face shown on the LCD. Faces: idle, happy, thinking, sad, surprised, embarrassed, off. "
        "Use it to react emotionally; the robot also reacts automatically per sentence.",
        PropertyList({Property("face", kPropertyTypeString)}),
        [this](const PropertyList& properties) -> ReturnValue {
            auto face = properties["face"].value<std::string>();
            mclog::tagInfo(_tag, "set_avatar: face={}", face);
            LvglLockGuard lock;
            auto display = static_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
            display->SetAvatarFace(face.c_str());
            return true;
        });

    mclog::tagInfo(_tag, "add display.set_mouth tool");
    mcp_server.AddTool(
        "self.display.set_mouth",
        "Set the avatar mouth shape for lip-sync. Shapes: closed, half, open, e, u.",
        PropertyList({Property("mouth", kPropertyTypeString)}),
        [this](const PropertyList& properties) -> ReturnValue {
            auto mouth = properties["mouth"].value<std::string>();
            mclog::tagInfo(_tag, "set_mouth: mouth={}", mouth);
            LvglLockGuard lock;
            auto display = static_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
            display->SetMouthShape(mouth.c_str());
            return true;
        });

    mclog::tagInfo(_tag, "add display.set_blink tool");
    mcp_server.AddTool(
        "self.display.set_blink",
        "Enable or disable autonomous eye blinking. True to start blinking, false to stop.",
        PropertyList({Property("enabled", kPropertyTypeBoolean)}),
        [this](const PropertyList& properties) -> ReturnValue {
            bool enabled = properties["enabled"].value<bool>();
            mclog::tagInfo(_tag, "set_blink: enabled={}", enabled);
            LvglLockGuard lock;
            auto display = static_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
            display->SetBlinkEnabled(enabled);
            return true;
        });

    // StackChan v10.11 (26/08/2026): corazón invocable desde el tracker de
    // emociones del ai-server. La lógica de CUÁNDO sale vive fuera del
    // firmware (emoción happy fuerte: "te quiero", "te adoro"...); aquí
    // solo se pinta. El decorator se autodestruye solo a los duration_ms.
    mclog::tagInfo(_tag, "add display.show_heart tool");
    mcp_server.AddTool(
        "self.display.show_heart",
        "Show a heart decoration on the avatar face for a short moment. Use it on strong happy/loving moments "
        "(e.g. 'te quiero', 'te adoro'). Duration in milliseconds (default 2500).",
        PropertyList({Property("duration_ms", kPropertyTypeInteger, 2500, 500, 10000)}),
        [this](const PropertyList& properties) -> ReturnValue {
            int duration_ms = properties["duration_ms"].value<int>();
            mclog::tagInfo(_tag, "show_heart: duration_ms={}", duration_ms);
            LvglLockGuard lock;
            auto display = static_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
            display->ShowHeart(duration_ms);
            return true;
        });

    mclog::tagInfo(_tag, "add robot.create_reminder tool");
    mcp_server.AddTool("self.robot.create_reminder",
                       "Create a reminder. Duration is in seconds. Message is what to say when time is up. Set repeat "
                       "to true to repeat the reminder.",
                       PropertyList({Property("duration_seconds", kPropertyTypeInteger, 60, 1, 86400),
                                     Property("message", kPropertyTypeString, std::string("Time's up!")),
                                     Property("repeat", kPropertyTypeBoolean, false)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int duration_seconds = properties["duration_seconds"].value<int>();
                           std::string message  = properties["message"].value<std::string>();
                           bool repeat          = properties["repeat"].value<bool>();

                           // Default message
                           if (message.empty()) {
                               message = "Time's up!";
                           }

                           mclog::tagInfo(_tag, "create_reminder: duration={}s, message={}, repeat={}",
                                          duration_seconds, message, repeat);

                           int id = tools::create_reminder(duration_seconds * 1000, message, repeat);

                           return id;
                       });

    mclog::tagInfo(_tag, "add robot.get_reminders tool");
    mcp_server.AddTool("self.robot.get_reminders", "Get list of active reminders.", std::vector<Property>{},
                       [this](const PropertyList& properties) -> ReturnValue {
                           mclog::tagInfo(_tag, "get_reminders");
                           auto reminders          = tools::get_active_reminders();
                           std::string result_json = "[";
                           for (size_t i = 0; i < reminders.size(); ++i) {
                               const auto& r = reminders[i];
                               result_json +=
                                   fmt::format(R"({{"id": {}, "duration_ms": {}, "message": "{}", "repeat": {}}})",
                                               r.id, r.durationMs, r.message, r.repeat ? "true" : "false");
                               if (i < reminders.size() - 1) {
                                   result_json += ", ";
                               }
                           }
                           result_json += "]";
                           mclog::tagInfo(_tag, "get_reminders result: {}", result_json);
                           return result_json;
                       });

    mclog::tagInfo(_tag, "add robot.stop_reminder tool");
    mcp_server.AddTool("self.robot.stop_reminder", "Stop a reminder by ID.",
                       PropertyList({Property("id", kPropertyTypeInteger, -1)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int id = properties["id"].value<int>();
                           mclog::tagInfo(_tag, "stop_reminder: id={}", id);
                           tools::stop_reminder(id);
                           return true;
                       });

    // StackChan v10.10.3: tool de cámara. El core (mcp_server.cc) registraba
    // self.camera.take_photo pero NO llegaba a registrarse en esta build
    // (solo se registran las tools de hal_mcp.cpp) -> "Unknown tool:
    // self.camera.capture_photo" cuando el usuario pedía una foto. Esta tool
    // captura un frame, lo codifica a JPEG y lo devuelve como ImageContent
    // (el server lo espera como {type:'image', mimeType, data}).
    mclog::tagInfo(_tag, "add camera.capture_photo tool");
    mcp_server.AddTool(
        "self.camera.capture_photo",
        "Capture one still photo from the StackChan camera and return it as an image. "
        "Use this when the user asks you to look, see, inspect, identify something, "
        "read visible text, or asks 'what is this?'.",
        PropertyList({Property("quality", kPropertyTypeInteger, 80, 1, 100)}),
        [this](const PropertyList& properties) -> ReturnValue {
            auto camera = hal_bridge::board_get_camera();
            if (!camera) {
                throw std::runtime_error("Camera not available");
            }
            if (!camera->Capture()) {
                throw std::runtime_error("Failed to capture photo");
            }
            const uint8_t* frame_data = camera->GetFrameData();
            size_t frame_size         = camera->GetFrameSize();
            int width                 = camera->GetFrameWidth();
            int height                = camera->GetFrameHeight();
            v4l2_pix_fmt_t format     = static_cast<v4l2_pix_fmt_t>(camera->GetFrameFormat());
            if (!frame_data || frame_size == 0 || width <= 0 || height <= 0) {
                throw std::runtime_error("Invalid camera frame");
            }
            int quality = properties["quality"].value<int>();
            std::string jpeg;
            bool ok = image_to_jpeg_cb(
                const_cast<uint8_t*>(frame_data), frame_size, static_cast<uint16_t>(width),
                static_cast<uint16_t>(height), format, static_cast<uint8_t>(quality),
                [](void* arg, size_t index, const void* data, size_t len) -> size_t {
                    auto* out = static_cast<std::string*>(arg);
                    if (index == 0 && data != nullptr && len > 0) {
                        out->append(static_cast<const char*>(data), len);
                    }
                    return len;
                },
                &jpeg);
            if (!ok || jpeg.empty()) {
                throw std::runtime_error("JPEG encoding failed");
            }
            mclog::tagInfo(_tag, "capture_photo: {}x{} jpeg={} bytes", width, height, jpeg.size());
            return new ImageContent("image/jpeg", jpeg);
        });
}
