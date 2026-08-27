/*
 * SPDX-FileCopyrightText: 2026 StackChan (OpenClaw)
 *
 * SPDX-License-Identifier: MIT
 *
 * App OpenClaw: lanza el asistente OpenClaw conectado al gateway MCP
 * local (Mac mini) en lugar de la nube china. Incluye selector de agente
 * (agentes configurables).
 */
#pragma once
#include <mooncake.h>
#include <memory>

class AppOpenClaw : public mooncake::AppAbility {
public:
    AppOpenClaw();

    // Override lifecycle callbacks
    void onCreate() override;
    void onOpen() override;
    void onRunning() override;
    void onClose() override;

private:
    void select_agent(int index);
    bool _agent_selected = false;
};
