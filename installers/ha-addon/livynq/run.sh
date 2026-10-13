#!/usr/bin/with-contenv bashio
# Livynq data lives in the add-on config folder, so Home Assistant backups include it
# (HomeKit pairings, Zigbee network keys, automations).
set -e

args=(start --data /config)
if bashio::config.true 'demo'; then args+=(--demo); fi
export LIVYNQ_LOG_LEVEL="$(bashio::config 'log_level')"

# SUPERVISOR_TOKEN is set by the Supervisor; Livynq then bridges Home Assistant automatically.
bashio::log.info "Starting Livynq $(/usr/local/bin/livynq --version)"
bashio::log.info "Login link: run 'livynq login-url --data /config' in the add-on terminal, or see the first-start log line below"
exec /usr/local/bin/livynq "${args[@]}"
