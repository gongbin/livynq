/**
 * Entry point of the single-executable build. The same binary also serves as the plugin host
 * process (relaunched with LIVYNQ_ROLE=plugin-host), so no separate Node install is needed.
 */
import './quiet-warnings.ts';
import { runPluginHost } from '@livynq/plugin-host';
import virtualPlugin from '@livynq/plugin-virtual';
import homeAssistantPlugin from '@livynq/plugin-homeassistant';
import matterPlugin from '@livynq/plugin-matter';
import shellyPlugin from '@livynq/plugin-shelly';
import huePlugin from '@livynq/plugin-hue';
import xiaomiPlugin from '@livynq/plugin-xiaomi';
import { bundledPlugins } from './bundled.ts';

if (process.env.LIVYNQ_ROLE === 'plugin-host') {
  runPluginHost();
} else {
  // matter.js reads its log format while initialising; in the bundle that happens before its
  // formats register, so pin it explicitly.
  process.env.MATTER_LOG_FORMAT ??= 'plain';
  bundledPlugins['@livynq/plugin-virtual'] = virtualPlugin;
  bundledPlugins['@livynq/plugin-homeassistant'] = homeAssistantPlugin;
  bundledPlugins['@livynq/plugin-matter'] = matterPlugin;
  bundledPlugins['@livynq/plugin-shelly'] = shellyPlugin;
  bundledPlugins['@livynq/plugin-hue'] = huePlugin;
  bundledPlugins['@livynq/plugin-xiaomi'] = xiaomiPlugin;
  void import('./main.ts');
}
