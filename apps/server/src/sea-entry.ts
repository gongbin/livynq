/**
 * Entry point of the single-executable build. The same binary also serves as the plugin host
 * process (relaunched with LIVYNQ_ROLE=plugin-host), so no separate Node install is needed.
 */
import './quiet-warnings.ts';
import { runPluginHost } from '@livynq/plugin-host';
import virtualPlugin from '@livynq/plugin-virtual';
import homeAssistantPlugin from '@livynq/plugin-homeassistant';
import { bundledPlugins } from './bundled.ts';

if (process.env.LIVYNQ_ROLE === 'plugin-host') {
  runPluginHost();
} else {
  bundledPlugins['@livynq/plugin-virtual'] = virtualPlugin;
  bundledPlugins['@livynq/plugin-homeassistant'] = homeAssistantPlugin;
  void import('./main.ts');
}
