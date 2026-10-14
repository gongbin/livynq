# @livynq/installer

The package installer behind `livynq plugin add` and the Homebridge compatibility plugin. It installs npm packages without npm (so it works inside the single-file Livynq binary):

- resolves the dependency tree from an npm registry with semver, hoisting where possible and nesting on conflicts;
- verifies every tarball against the registry's integrity hash;
- refuses links and paths that escape the package;
- skips optional dependencies for other platforms;
- **never runs install scripts**;
- writes small shims for packages the host provides (e.g. `@livynq/sdk`, or `homebridge` / `hap-nodejs`).

Also exports the minimal tar reader / writer Livynq uses for packages and backups.

License: Apache-2.0
