/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "stackchan_display.h"
#include "hal_bridge.h"
#include <esp_log.h>
#include <esp_err.h>
#include <esp_lvgl_port.h>
#include <esp_psram.h>
#include <vector>
#include <cstring>
#include <src/misc/cache/lv_cache.h>
#include <settings.h>
#include <lvgl.h>
#include <lvgl_theme.h>
#include <stackchan/stackchan.h>
#include <assets/lang_config.h>
#include <hal/hal.h>

using namespace stackchan;
using namespace stackchan::avatar;

#define TAG "StackChanAvatarDisplay"

LV_FONT_DECLARE(BUILTIN_TEXT_FONT);
LV_FONT_DECLARE(BUILTIN_ICON_FONT);
LV_FONT_DECLARE(font_awesome_30_4);

// Have to register themes, so the asset apply can update the text font
void StackChanAvatarDisplay::InitializeLcdThemes()
{
    auto text_font       = std::make_shared<LvglBuiltInFont>(&BUILTIN_TEXT_FONT);
    auto icon_font       = std::make_shared<LvglBuiltInFont>(&BUILTIN_ICON_FONT);
    auto large_icon_font = std::make_shared<LvglBuiltInFont>(&font_awesome_30_4);

    // light theme
    auto light_theme = new LvglTheme("light");
    light_theme->set_background_color(lv_color_hex(0xFFFFFF));        // rgb(255, 255, 255)
    light_theme->set_text_color(lv_color_hex(0x000000));              // rgb(0, 0, 0)
    light_theme->set_chat_background_color(lv_color_hex(0xE0E0E0));   // rgb(224, 224, 224)
    light_theme->set_user_bubble_color(lv_color_hex(0x00FF00));       // rgb(0, 128, 0)
    light_theme->set_assistant_bubble_color(lv_color_hex(0xDDDDDD));  // rgb(221, 221, 221)
    light_theme->set_system_bubble_color(lv_color_hex(0xFFFFFF));     // rgb(255, 255, 255)
    light_theme->set_system_text_color(lv_color_hex(0x000000));       // rgb(0, 0, 0)
    light_theme->set_border_color(lv_color_hex(0x000000));            // rgb(0, 0, 0)
    light_theme->set_low_battery_color(lv_color_hex(0x000000));       // rgb(0, 0, 0)
    light_theme->set_text_font(text_font);
    light_theme->set_icon_font(icon_font);
    light_theme->set_large_icon_font(large_icon_font);

    // dark theme
    auto dark_theme = new LvglTheme("dark");
    dark_theme->set_background_color(lv_color_hex(0x000000));        // rgb(0, 0, 0)
    dark_theme->set_text_color(lv_color_hex(0xFFFFFF));              // rgb(255, 255, 255)
    dark_theme->set_chat_background_color(lv_color_hex(0x1F1F1F));   // rgb(31, 31, 31)
    dark_theme->set_user_bubble_color(lv_color_hex(0x00FF00));       // rgb(0, 128, 0)
    dark_theme->set_assistant_bubble_color(lv_color_hex(0x222222));  // rgb(34, 34, 34)
    dark_theme->set_system_bubble_color(lv_color_hex(0x000000));     // rgb(0, 0, 0)
    dark_theme->set_system_text_color(lv_color_hex(0xFFFFFF));       // rgb(255, 255, 255)
    dark_theme->set_border_color(lv_color_hex(0xFFFFFF));            // rgb(255, 255, 255)
    dark_theme->set_low_battery_color(lv_color_hex(0xFF0000));       // rgb(255, 0, 0)
    dark_theme->set_text_font(text_font);
    dark_theme->set_icon_font(icon_font);
    dark_theme->set_large_icon_font(large_icon_font);

    auto& theme_manager = LvglThemeManager::GetInstance();
    theme_manager.RegisterTheme("light", light_theme);
    theme_manager.RegisterTheme("dark", dark_theme);
}

StackChanAvatarDisplay::StackChanAvatarDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                                               int width, int height, int offset_x, int offset_y, bool mirror_x,
                                               bool mirror_y, bool swap_xy)
    : LvglDisplay(), panel_io_(panel_io), panel_(panel)
{
    width_  = width;
    height_ = height;

    // Initialize LCD themes
    InitializeLcdThemes();

    // Load theme from settings
    Settings settings("display", false);
    std::string theme_name = settings.GetString("theme", "light");
    current_theme_         = LvglThemeManager::GetInstance().GetTheme(theme_name);

    // Draw white screen
    std::vector<uint16_t> buffer(width_, 0xFFFF);
    for (int y = 0; y < height_; y++) {
        esp_lcd_panel_draw_bitmap(panel_, 0, y, width_, y + 1, buffer.data());
    }

    // Set the display to on
    ESP_LOGI(TAG, "Turning display on");
    {
        esp_err_t __err = esp_lcd_panel_disp_on_off(panel_, true);
        if (__err == ESP_ERR_NOT_SUPPORTED) {
            ESP_LOGW(TAG, "Panel does not support disp_on_off; assuming ON");
        } else {
            ESP_ERROR_CHECK(__err);
        }
    }

    ESP_LOGI(TAG, "Initialize LVGL library");
    lv_init();

#if CONFIG_SPIRAM
    // lv image cache, currently only PNG is supported
    size_t psram_size_mb = esp_psram_get_size() / 1024 / 1024;
    if (psram_size_mb >= 8) {
        lv_image_cache_resize(2 * 1024 * 1024, true);
        ESP_LOGI(TAG, "Use 2MB of PSRAM for image cache");
    } else if (psram_size_mb >= 2) {
        lv_image_cache_resize(512 * 1024, true);
        ESP_LOGI(TAG, "Use 512KB of PSRAM for image cache");
    }
#endif

    ESP_LOGI(TAG, "Initialize LVGL port");
    lvgl_port_cfg_t port_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    // port_cfg.task_priority   = 20;
    port_cfg.task_priority = 3;
#if CONFIG_SOC_CPU_CORES_NUM > 1
    port_cfg.task_affinity = 1;
#endif
    lvgl_port_init(&port_cfg);

    ESP_LOGI(TAG, "Adding LCD display");
    const lvgl_port_display_cfg_t display_cfg = {
        .io_handle      = panel_io_,
        .panel_handle   = panel_,
        .control_handle = nullptr,
        .buffer_size    = static_cast<uint32_t>(width_ * 20),
        .double_buffer  = false,
        .trans_size     = 0,
        .hres           = static_cast<uint32_t>(width_),
        .vres           = static_cast<uint32_t>(height_),
        .monochrome     = false,
        .rotation =
            {
                .swap_xy  = swap_xy,
                .mirror_x = mirror_x,
                .mirror_y = mirror_y,
            },
        .color_format = LV_COLOR_FORMAT_RGB565,
        .flags =
            {
                .buff_dma     = 1,
                .buff_spiram  = 0,
                .sw_rotate    = 0,
                .swap_bytes   = 1,
                .full_refresh = 0,
                .direct_mode  = 0,
            },
    };

    display_ = lvgl_port_add_disp(&display_cfg);
    if (display_ == nullptr) {
        ESP_LOGE(TAG, "Failed to add display");
        return;
    }

    if (offset_x != 0 || offset_y != 0) {
        lv_display_set_offset(display_, offset_x, offset_y);
    }

    // Create a timer to hide the preview image
    esp_timer_create_args_t preview_timer_args = {
        .callback =
            [](void* arg) {
                StackChanAvatarDisplay* display = static_cast<StackChanAvatarDisplay*>(arg);
                display->SetPreviewImage(nullptr);
            },
        .arg                   = this,
        .dispatch_method       = ESP_TIMER_TASK,
        .name                  = "preview_timer",
        .skip_unhandled_events = false,
    };
    esp_timer_create(&preview_timer_args, &preview_timer_);

    // Create boot logo label if not warm boot
    if (GetHAL().getWarmRebootTarget() < 0) {
        ESP_LOGI(TAG, "Create boot logo label");
        Lock();
        {
            uitk::lvgl_cpp::ScreenActive screen;
            screen.setBgColor(lv_color_hex(0x000000));
        }
        GetHAL().bootLogo = std::make_unique<BootLogo>();
        Unlock();
    }

    // Robot will be created later in SetupXiaoZhiUI()
}

StackChanAvatarDisplay::~StackChanAvatarDisplay()
{
    ESP_LOGI(TAG, "Destroying StackChanAvatarDisplay");

    if (preview_timer_ != nullptr) {
        esp_timer_stop(preview_timer_);
        esp_timer_delete(preview_timer_);
    }

    if (preview_image_ != nullptr) {
        lv_obj_del(preview_image_);
    }

    auto& stackchan = GetStackChan();
    if (stackchan.hasAvatar()) {
        stackchan.resetAvatar();
    }
}

bool StackChanAvatarDisplay::Lock(int timeout_ms)
{
    return lvgl_port_lock(timeout_ms);
}

void StackChanAvatarDisplay::Unlock()
{
    lvgl_port_unlock();
}

lv_disp_t* StackChanAvatarDisplay::GetLvglDisplay()
{
    return display_;
}

#include <hal/board/hal_bridge.h>

void StackChanAvatarDisplay::SetupUI()
{
    // Prevent duplicate calls - if already called, return early
    if (setup_ui_called_) {
        ESP_LOGW(TAG, "SetupUI() called multiple times, skipping duplicate call");
        return;
    }

    Display::SetupUI();  // Mark SetupUI as called

    auto& stackchan = GetStackChan();

    if (stackchan.hasAvatar()) {
        ESP_LOGW(TAG, "Avatar already created");
        return;
    }

    DisplayLockGuard lock(this);

    ESP_LOGI(TAG, "Creating Stack-chan Avatar...");

    auto avatar = std::make_unique<DefaultAvatar>();
    avatar->init(lv_screen_active());
    avatar->getPanel()->onClick().connect([]() {
        static uint32_t last_toggle_tick = 0;
        const uint32_t now               = GetHAL().millis();
        if (last_toggle_tick != 0 && now - last_toggle_tick < 2000) {
            return;
        }

        if (hal_bridge::is_xiaozhi_ready()) {
            last_toggle_tick = now;
            hal_bridge::toggle_xiaozhi_chat_state();
        }
    });

    stackchan.attachAvatar(std::move(avatar));
    stackchan.addModifier(std::make_unique<BreathModifier>());
    blink_modifier_id_ = stackchan.addModifier(std::make_unique<BlinkModifier>());
    head_pet_modifier_id_ = stackchan.addModifier(std::make_unique<HeadPetModifier>());
    imu_modifier_id_ = stackchan.addModifier(std::make_unique<ImuEventModifier>());

    preview_image_ = lv_image_create(lv_screen_active());
    lv_obj_set_size(preview_image_, 320, 240);
    lv_obj_align(preview_image_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(preview_image_, LV_OBJ_FLAG_HIDDEN);

    // GetHAL().startStackChanAutoUpdate(24);

    auto config        = hal_bridge::get_xiaozhi_config();
    idle_motion_level_ = config.idleRandomMovementLevel;

    ESP_LOGI(TAG, "Avatar created and started");
}

void StackChanAvatarDisplay::LvglLock()
{
    if (!Lock(30000)) {
        ESP_LOGE("Display", "Failed to lock display");
    }
}

void StackChanAvatarDisplay::LvglUnlock()
{
    Unlock();
}

void StackChanAvatarDisplay::CreateIdleMotionModifier()
{
    auto& stackchan = GetStackChan();

    switch (idle_motion_level_) {
        case 0:
            idle_motion_modifier_id_ = -1;
            return;
        case 1:
            idle_motion_modifier_id_ = stackchan.addModifier(std::make_unique<IdleMotionModifier>(8000, 12000));
            return;
        case 3:
            idle_motion_modifier_id_ = stackchan.addModifier(std::make_unique<IdleMotionModifier>(2000, 4000));
            return;
        case 2:
        default:
            idle_motion_modifier_id_ = stackchan.addModifier(std::make_unique<IdleMotionModifier>());
            return;
    }
}

void StackChanAvatarDisplay::SetEmotion(const char* emotion)
{
    auto& stackchan = GetStackChan();

    if (!stackchan.hasAvatar() || !emotion) {
        return;
    }

    DisplayLockGuard lock(this);

    // ESP_LOGE(TAG, "SetEmotion: %s", emotion);

    auto& avatar = stackchan.avatar();

    // Map emotion string to stackchan::Emotion
    if (strcmp(emotion, "neutral") == 0) {
        avatar.setEmotion(Emotion::Neutral);
    } else if (strcmp(emotion, "happy") == 0) {
        avatar.setEmotion(Emotion::Happy);
    } else if (strcmp(emotion, "laughing") == 0) {
        avatar.setEmotion(Emotion::Happy);
    } else if (strcmp(emotion, "angry") == 0) {
        avatar.setEmotion(Emotion::Angry);
    } else if (strcmp(emotion, "sad") == 0) {
        avatar.setEmotion(Emotion::Sad);
    } else if (strcmp(emotion, "crying") == 0) {
        avatar.setEmotion(Emotion::Sad);
    } else if (strcmp(emotion, "sleepy") == 0) {
        avatar.setEmotion(Emotion::Sleepy);
        avatar.setSpeech("Zzz…");
        is_sleeping_ = true;
        // avatar.mouth().setWeight(10);

        // Stop idle motion
        ESP_LOGW(TAG, "Stop idle motion");
        if (idle_motion_modifier_id_ >= 0) {
            stackchan.removeModifier(idle_motion_modifier_id_);
            idle_motion_modifier_id_ = -1;
            stackchan.removeModifier(idle_expression_modifier_id_);
            idle_expression_modifier_id_ = -1;
        }

        // Return to default pose
        auto& motion = GetStackChan().motion();
        motion.pitchServo().moveWithSpeed(0, 80);

    } else if (strcmp(emotion, "doubtful") == 0) {
        avatar.setEmotion(Emotion::Doubt);
    } else {
        ESP_LOGW(TAG, "Unknown emotion: %s, using NEUTRAL", emotion);
        avatar.setEmotion(Emotion::Neutral);
    }

    // Resync blink modifier base eye weights
    auto blink_modifier = static_cast<BlinkModifier*>(stackchan.getModifier(blink_modifier_id_));
    if (blink_modifier) {
        blink_modifier->resyncEyeWeights();
    }
}

void StackChanAvatarDisplay::SetAvatarFace(const char* face)
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar() || !face) {
        return;
    }

    DisplayLockGuard lock(this);
    auto& avatar = stackchan.avatar();

    // "off": ocultar avatar (deja ver la UI subyacente de xiaozhi)
    if (strcmp(face, "off") == 0) {
        avatar.leftEye().setVisible(false);
        avatar.rightEye().setVisible(false);
        avatar.mouth().setVisible(false);
        return;
    }

    // Restaurar visibilidad si estaba oculto
    avatar.leftEye().setVisible(true);
    avatar.rightEye().setVisible(true);
    avatar.mouth().setVisible(true);

    // Mapear las faces del gateway a las emociones nativas
    if (strcmp(face, "idle") == 0 || strcmp(face, "neutral") == 0) {
        avatar.setEmotion(Emotion::Neutral);
    } else if (strcmp(face, "happy") == 0 || strcmp(face, "embarrassed") == 0) {
        avatar.setEmotion(Emotion::Happy);
    } else if (strcmp(face, "thinking") == 0 || strcmp(face, "surprised") == 0) {
        avatar.setEmotion(Emotion::Doubt);
    } else if (strcmp(face, "sad") == 0) {
        avatar.setEmotion(Emotion::Sad);
    } else if (strcmp(face, "angry") == 0) {
        avatar.setEmotion(Emotion::Angry);
    } else {
        avatar.setEmotion(Emotion::Neutral);
    }

    // Resync blink modifier base eye weights
    auto blink_modifier = static_cast<BlinkModifier*>(stackchan.getModifier(blink_modifier_id_));
    if (blink_modifier) {
        blink_modifier->resyncEyeWeights();
    }
}

void StackChanAvatarDisplay::SetMouthShape(const char* shape)
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar() || !shape) {
        return;
    }

    DisplayLockGuard lock(this);
    auto& avatar = stackchan.avatar();

    if (strcmp(shape, "closed") == 0) {
        avatar.mouth().setWeight(0);
    } else if (strcmp(shape, "half") == 0) {
        avatar.mouth().setWeight(45);
    } else if (strcmp(shape, "open") == 0) {
        avatar.mouth().setWeight(100);
    } else if (strcmp(shape, "e") == 0) {
        avatar.mouth().setWeight(30);
    } else if (strcmp(shape, "u") == 0) {
        avatar.mouth().setWeight(20);
    } else {
        avatar.mouth().setWeight(0);
    }
}

void StackChanAvatarDisplay::SetBlinkEnabled(bool enabled)
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    DisplayLockGuard lock(this);

    if (enabled) {
        if (blink_modifier_id_ < 0) {
            blink_modifier_id_ = stackchan.addModifier(std::make_unique<BlinkModifier>());
        }
    } else {
        if (blink_modifier_id_ >= 0) {
            stackchan.removeModifier(blink_modifier_id_);
            blink_modifier_id_ = -1;
        }
    }
}

// StackChan v10.13 (26/08/2026): decoración de corazón + rubor (ShyDecorator)
// invocable desde el tracker de emociones del ai-server (self.display.show_heart).
// Muestra el HeartDecorator y el ShyDecorator (paréntesis rosas kawaii) durante
// duration_ms, igual que hace la caricia de cabeza (HeadPet). Si ya hay uno,
// lo reemplaza (sin acumular). Los decorators se autodestruyen solos.
void StackChanAvatarDisplay::ShowHeart(int duration_ms)
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    DisplayLockGuard lock(this);
    auto& avatar = stackchan.avatar();

    if (_heart_decorator_id >= 0) {
        avatar.removeDecorator(_heart_decorator_id);
        _heart_decorator_id = -1;
    }
    if (_shy_decorator_id >= 0) {
        avatar.removeDecorator(_shy_decorator_id);
        _shy_decorator_id = -1;
    }

    _heart_decorator_id =
        avatar.addDecorator(std::make_unique<HeartDecorator>(lv_screen_active(), duration_ms > 0 ? duration_ms : 2500, 500));
    _shy_decorator_id =
        avatar.addDecorator(std::make_unique<ShyDecorator>(lv_screen_active(), duration_ms > 0 ? duration_ms : 2500));

    ESP_LOGW(TAG, "ShowHeart: duration_ms=%d heart_id=%d shy_id=%d", duration_ms, _heart_decorator_id, _shy_decorator_id);
}

void StackChanAvatarDisplay::SetChatMessage(const char* role, const char* content)
{
    if (!setup_ui_called_) {
        ESP_LOGW(TAG, "SetChatMessage('%s', '%s') called before SetupUI() - message will be lost!", role, content);
    }

    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    // ESP_LOGE(TAG, "SetChatMessage: role=%s, content=%s", role ? role : "null", content ? content : "null");

    DisplayLockGuard lock(this);

    if (strcmp(role, "system") == 0) {
        stackchan.avatar().setSpeech(content);
    } else if (strcmp(role, "assistant") == 0) {
        stackchan.avatar().setSpeech(content);
    }
}

void StackChanAvatarDisplay::ClearChatMessages()
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    DisplayLockGuard lock(this);

    stackchan.avatar().clearSpeech();

    ESP_LOGI(TAG, "Chat messages cleared");
}

void StackChanAvatarDisplay::SetPreviewImage(std::unique_ptr<LvglImage> image)
{
    DisplayLockGuard lock(this);
    if (preview_image_ == nullptr) {
        return;
    }

    if (image == nullptr) {
        esp_timer_stop(preview_timer_);
        lv_obj_add_flag(preview_image_, LV_OBJ_FLAG_HIDDEN);
        preview_image_cached_.reset();
        return;
    }

    preview_image_cached_ = std::move(image);
    auto img_dsc          = preview_image_cached_->image_dsc();
    // Set image source and show preview image
    lv_image_set_src(preview_image_, img_dsc);
    if (img_dsc->header.w > 0 && img_dsc->header.h > 0) {
        // Scale to fit width
        lv_image_set_scale(preview_image_, 256 * width_ / img_dsc->header.w);
    }

    lv_obj_remove_flag(preview_image_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(preview_image_);
    esp_timer_stop(preview_timer_);
    ESP_ERROR_CHECK(esp_timer_start_once(preview_timer_, 6000 * 1000));
}

void StackChanAvatarDisplay::UpdateStatusBar(bool update_all)
{
}

void StackChanAvatarDisplay::SetTheme(Theme* theme)
{
    ESP_LOGI(TAG, "SetTheme: %s", theme->name().c_str());

    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        ESP_LOGE(TAG, "Avatar is invalid");
        return;
    }

    DisplayLockGuard lock(this);

    auto lvgl_theme = static_cast<LvglTheme*>(theme);
    auto text_font  = lvgl_theme->text_font()->font();

    stackchan.avatar().setSpeechTextFont((void*)text_font);
}

#include <hal/board/hal_bridge.h>
static bool _is_xiaozhi_ready = false;
static bool _is_xiaozhi_idle  = false;
bool hal_bridge::is_xiaozhi_ready()
{
    return _is_xiaozhi_ready;
}
bool hal_bridge::is_xiaozhi_idle()
{
    return _is_xiaozhi_idle;
}

// StackChan v10.9.5: al volver del chat (home) hay que resetear los flags para que
// la task de update no toque LVGL ya destruido (evita reboot por dangling pointer)
void hal_bridge::reset_xiaozhi_ui_flags()
{
    _is_xiaozhi_ready = false;
    _is_xiaozhi_idle  = false;
}

void StackChanAvatarDisplay::SetStatus(const char* status)
{
    // ESP_LOGE(TAG, "SetStatus: %s", status);

    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        ESP_LOGE(TAG, "Avatar is invalid");
        return;
    }

    auto& avatar = stackchan.avatar();
    auto& motion = stackchan.motion();

    DisplayLockGuard lock(this);

    bool is_idle      = false;
    bool is_listening = false;

    if (strcmp(status, Lang::Strings::LISTENING) == 0) {
        if (speaking_modifier_id_ >= 0) {
            // Start speaking
            stackchan.removeModifier(speaking_modifier_id_);
            avatar.mouth().setWeight(0);
            speaking_modifier_id_ = -1;
        }

        // StackChan v10.9.9: si hay color manual persistido, NO pisarlo con el
        // verde automático (el manual se mantiene siempre, estilo IA china).
        int mr, mg, mb;
        if (hal_bridge::get_manual_led_color(&mr, &mg, &mb)) {
            GetHAL().showRgbColor(mr, mg, mb);
        } else {
            GetHAL().setRgbColor(0, 0, 50, 0);
            GetHAL().refreshRgb();
        }

    } else if (strcmp(status, Lang::Strings::STANDBY) == 0) {
        _is_xiaozhi_ready = true;

        if (speaking_modifier_id_ >= 0) {
            // Stop speaking
            stackchan.removeModifier(speaking_modifier_id_);
            avatar.mouth().setWeight(0);
            speaking_modifier_id_ = -1;
        }

        is_idle = true;

        // StackChan v10.9.7: respetar color manual persistido (tool del LLM).
        // Si hay manual guardado -> mantenerlo (estilo IA china). Si no -> apagar.
        int mr, mg, mb;
        if (hal_bridge::get_manual_led_color(&mr, &mg, &mb)) {
            GetHAL().showRgbColor(mr, mg, mb);
        } else {
            // StackChan v10.10.9: apagar TAMBIÉN los NeonLight con turnOff() que
            // CANCELA la animación (teleport negro). El server pinta el azul
            // con setColor() (fade 0.3s) y si la animación sigue viva, el
            // update() del NeonLight repinta azul DESPUÉS del showRgbColor
            // -> LED azul colgado al desconectar. turnOff() lo mata de raíz.
            GetStackChan().leftNeonLight().turnOff();
            GetStackChan().rightNeonLight().turnOff();
            GetHAL().showRgbColor(0, 0, 0);
        }

    } else if (strcmp(status, Lang::Strings::SPEAKING) == 0) {
        if (speaking_modifier_id_ < 0) {
            speaking_modifier_id_ = stackchan.addModifier(std::make_unique<SpeakingModifier>(0, 180, false));
        }

        // StackChan v10.9.9: respetar color manual persistido también al hablar
        int mr, mg, mb;
        if (hal_bridge::get_manual_led_color(&mr, &mg, &mb)) {
            GetHAL().showRgbColor(mr, mg, mb);
        } else {
            GetHAL().setRgbColor(0, 0, 0, 50);
            GetHAL().refreshRgb();
        }
    } else {
        avatar.setSpeech(status);
        // StackChan v10.9.7: respetar color manual persistido también aquí
        int mr, mg, mb;
        if (hal_bridge::get_manual_led_color(&mr, &mg, &mb)) {
            GetHAL().showRgbColor(mr, mg, mb);
        } else {
            GetHAL().showRgbColor(0, 0, 0);
        }
    }

    if (is_idle) {
        // Start idle motion
        ESP_LOGW(TAG, "Start idle motion");
        if (idle_motion_modifier_id_ < 0) {
            if (idle_motion_level_ > 0) {
                CreateIdleMotionModifier();
            }
        }
        // StackChan v10.9.9: no duplicar el modifier de expresión si ya existe
        if (idle_expression_modifier_id_ < 0) {
            idle_expression_modifier_id_ = stackchan.addModifier(std::make_unique<IdleExpressionModifier>());
        }
        // StackChan v10.13 (26/08/2026): en standby real se recrean también los
        // modificadores de gesto (HeadPet + IMU) para que el robot tenga su
        // vida normal: caricias con corazón, reacción a sacudidas, etc.
        if (head_pet_modifier_id_ < 0) {
            head_pet_modifier_id_ = stackchan.addModifier(std::make_unique<HeadPetModifier>());
        }
        if (imu_modifier_id_ < 0) {
            imu_modifier_id_ = stackchan.addModifier(std::make_unique<ImuEventModifier>());
        }

        _is_xiaozhi_idle = true;
    } else {
        // StackChan v10.11 (26/08/2026): durante la conversación se quita TODO el idle:
        // servos (movimiento de cabeza) Y micro-expresiones (ojos/boca).
        // La expresividad la pone SOLO el sistema de emociones del ai-server
        // (comando emotion), no el modifier de idle. Antes se mantenía el
        // IdleExpressionModifier y se colaba en mitad de la charla sacando
        // al robot de la magia (ej: cara feliz + corazón en un tema serio).
        // Orden directa del usuario 26/08/2026.
        // StackChan v10.13 (26/08/2026): se quitan TAMBIÉN HeadPetModifier e
        // ImuEventModifier. Son los que "se colaban" moviendo la cabeza y
        // pisando la emoción del tracker sin que nadie tocara el robot
        // (vibración del altavoz -> shake del IMU; falsos positivos del
        // sensor táctil de la cabeza -> cara feliz + corazón). En la app
        // china no se notan porque no hay conversación continua; en la
        // nuestra peleaban con el tracker en plena charla.
        ESP_LOGW(TAG, "Stop idle motion (servos + micro-expresiones + gestos)");
        if (idle_motion_modifier_id_ >= 0) {
            stackchan.removeModifier(idle_motion_modifier_id_);
            idle_motion_modifier_id_ = -1;
        }
        if (idle_expression_modifier_id_ >= 0) {
            stackchan.removeModifier(idle_expression_modifier_id_);
            idle_expression_modifier_id_ = -1;
        }
        if (head_pet_modifier_id_ >= 0) {
            stackchan.removeModifier(head_pet_modifier_id_);
            head_pet_modifier_id_ = -1;
        }
        if (imu_modifier_id_ >= 0) {
            stackchan.removeModifier(imu_modifier_id_);
            imu_modifier_id_ = -1;
        }

        _is_xiaozhi_idle = false;
    }

    // Clear sleep state
    if (is_sleeping_) {
        avatar.setSpeech("");
    }
}

void StackChanAvatarDisplay::ShowNotification(const char* notification, int duration_ms)
{
}
