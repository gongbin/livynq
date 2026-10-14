import { sdkShims } from '@livynq/plugin-host';
import { PackageInstaller, type InstallerOptions } from '@livynq/installer';

/** Livynq plugins: the generic installer with the hub's @livynq/sdk / @livynq/model provided as shims. */
export class PluginInstaller extends PackageInstaller {
  constructor(options: Omit<InstallerOptions, 'host'> & { hubVersion: string }) {
    const { hubVersion, ...rest } = options;
    super({
      ...rest,
      host: {
        provided: sdkShims(hubVersion),
        compat: {
          name: '@livynq/sdk',
          version: hubVersion,
          missing: (root) => `${root.name} does not depend on @livynq/sdk; it may not be a Livynq plugin`,
          incompatible: (root, ranges, version) => `${root.name} was built for @livynq/sdk ${ranges.join(' / ')}; this hub provides ${version}`,
        },
      },
    });
  }
}

export { InstallError, extractPackage, parseSpec, pluginsDir, publicResolution } from '@livynq/installer';
export type { InstalledRecord, PackageInfo, PackageSource, Plan, ResolvedPlugin } from '@livynq/installer';
