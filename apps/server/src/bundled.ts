import type { PluginDefinition } from '@livynq/sdk';

/** Plugins compiled into a single-executable build (empty when running from sources). */
export const bundledPlugins: Record<string, PluginDefinition> = {};
